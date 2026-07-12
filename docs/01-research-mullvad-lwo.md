# Stage 1 — Research: How Mullvad LWO Works

> Goal of this stage: understand LWO from the **actual Mullvad source** (no guessing),
> determine whether it is independent of `mullvad-daemon`, list its real dependencies,
> and decide whether it can be extracted into a reusable library for OpenWrt.
>
> Every claim below cites the exact file and function it came from in
> [`mullvad/mullvadvpn-app`](https://github.com/mullvad/mullvadvpn-app) (branch `main`).

---

## 1. What LWO actually is

**LWO = Lightweight WireGuard Obfuscation.** It is *not* a new tunnel protocol. It is a
thin, zero-overhead disguise applied to WireGuard's own UDP packets so that the traffic
does not look like plain WireGuard on the wire.

The key architectural fact for us:

> **LWO is implemented as a local UDP proxy.** It binds a UDP socket on
> `127.0.0.1:<ephemeral>`, WireGuard is pointed at that local socket as its endpoint, and
> the proxy obfuscates each packet and forwards it to the real remote server; the return
> path deobfuscates. WireGuard itself is unmodified.

This is exactly the shape we want for OpenWrt: a small userspace daemon sitting between the
kernel WireGuard interface and the internet.

Source: `tunnel-obfuscation/src/lwo.rs`, `Lwo::new()` binds the local socket to
`127.0.0.1:0` and stores `local_endpoint`; `endpoint()` returns that address (this is the
address WireGuard must send to).

---

## 2. The reusable core is two free functions

The whole obfuscation primitive is two **pure functions** operating on a mutable buffer and
a 32-byte key. This is confirmed by the benchmark, which calls them directly:

```rust
// tunnel-obfuscation/src/lwo.rs
pub fn obfuscate(rng: &mut impl RngCore, packet: &mut [u8], key: &[u8; 32]);
pub fn deobfuscate(packet: &mut [u8], key: &[u8; 32]);
```

Source: `tunnel-obfuscation/benches/lwo.rs` calls
`tunnel_obfuscation::lwo::obfuscate(rng, &mut packet, pubkey.as_bytes())` and
`tunnel_obfuscation::lwo::deobfuscate(&mut packet, pubkey.as_bytes())`.

**Implication:** the protocol itself has almost no dependencies. Everything else in the
crate (`Lwo` struct, `Obfuscator` trait, socket handling) is just the async UDP plumbing
around these two functions — plumbing we can reproduce cheaply for OpenWrt while reusing the
two functions verbatim.

### 2.1 The algorithm (from `obfuscate` / `deobfuscate` / `header_mut`)

- WireGuard's first byte identifies the message type: `1` = handshake init, `2` = handshake
  response, `3` = cookie reply, `4` = data.
- LWO XORs only the **fixed-size header** of each message with the 32-byte key (cycling
  through the key `key[i % 32]`). The header lengths are constants:
  - `HANDSHAKE_INIT = 148`
  - `HANDSHAKE_RESP = 92`
  - `COOKIE_REPLY = 64`
  - `DATA = 32`
- The payload *after* the header is left untouched (that is why `packet_overhead()` is `0`
  and throughput stays high — only a small header is transformed).
- **Byte index 1** (a reserved/zero byte in real WireGuard) is filled with random bytes
  from `rand::rng()` and has the obfuscation bit `0x80` OR'd in. On deobfuscation byte 1 is
  zeroed again (debug builds assert the `0x80` bit was set).
- **Type recovery on receive:** because byte 0 is XORed, the receiver recovers the message
  type with `received_byte_0 ^ key[0]`, which tells it the correct header length *before*
  running the full XOR (`header_mut` / `deobfuscate` take a `key_byte` derived from
  `key[0]`). Unknown types are dropped.

Source: `tunnel-obfuscation/src/lwo.rs` — `obfuscate`, `deobfuscate`, `header_mut`, and the
header-length constants.

### 2.2 Key material and direction (critical for a correct implementation)

The XOR "key" is simply a **WireGuard public key** (32 bytes). No crypto is performed at
packet time — the public key bytes are used directly as an XOR mask. The direction matters:

| Direction | Function | Key used |
|---|---|---|
| Client → Server (outbound, local→remote) | `obfuscate` | **`server_public_key`** (`tx_key`) |
| Server → Client (inbound, remote→local) | `deobfuscate` | **`client_public_key`** (`rx_key`) |

In other words, **each side obfuscates using the remote peer's public key.** The client
sends with the server's public key; the server replies with the client's public key.

Source: `tunnel-obfuscation/src/lwo.rs` — the `Client` struct and the send/receive tasks:

```rust
struct Client {
    server_addr: SocketAddr,
    rx_key: PublicKey,       // = settings.client_public_key
    tx_key: PublicKey,       // = settings.server_public_key
    remote_socket: Arc<UdpSocket>,
    client_socket: Arc<UdpSocket>,
}
```

**Consequence for our UCI config:** the daemon must be given *both* WireGuard public keys
(the local interface's own public key **and** the peer/server public key), plus the server
endpoint. These are all values the user already has in their WireGuard config.

---

## 3. Is LWO independent of `mullvad-daemon`?

**Yes, the obfuscation logic is independent.** The dependency chain runs the other way:
`mullvad-daemon` depends on `tunnel-obfuscation`, not vice-versa.

- The public entry point is `tunnel_obfuscation::create_obfuscator(&Settings)` which returns
  a `Box<dyn Obfuscator>`. `mullvad-daemon` calls this; nothing in the obfuscator calls back
  into the daemon.
- Source: `tunnel-obfuscation/src/lib.rs` — `pub async fn create_obfuscator(settings: &Settings) -> Result<Box<dyn Obfuscator>>`
  and `pub trait Obfuscator`.

The `Obfuscator` trait is minimal:

```rust
// tunnel-obfuscation/src/lib.rs
#[async_trait]
pub trait Obfuscator: Send {
    async fn run(self: Box<Self>) -> Result<()>;
    fn endpoint(&self) -> SocketAddr;              // local addr WG sends to
    #[cfg(target_os = "android")]
    fn remote_socket_fd(&self) -> RawFd;
    fn packet_overhead(&self) -> u16;              // LWO returns 0
}
```

There is **no dependency on gRPC, the management interface, account handling, or the GUI**
to run an obfuscator. That entire stack lives above `tunnel-obfuscation`.

---

## 4. What `tunnel-obfuscation` depends on — and what LWO *actually* needs

The crate manifest (`tunnel-obfuscation/Cargo.toml`) lists dependencies for **all five**
obfuscators it ships (`udp2tcp`, `shadowsocks`, `quic`, `lwo`, `multiplexer`):

```toml
async-trait, futures, log, rand (small_rng), shadowsocks,
mullvad-masque-proxy (path), talpid-types (path), thiserror,
tokio (io-util, macros, net, rt-multi-thread), tokio-util (rt),
udp-over-tcp (git), nix (linux, socket)
```

Most of that weight belongs to the *other* obfuscators, **not** LWO:

| Dependency | Needed by LWO? | Notes |
|---|---|---|
| `tokio` (net, rt, io-util, macros) | ✅ yes | async UDP sockets + runtime |
| `rand` (`small_rng`) | ✅ yes | randomizes byte 1 in `obfuscate` |
| `async-trait` | ⚠️ only for the trait | droppable if we don't reuse the `Obfuscator` trait |
| `thiserror` | ✅ (nice) | error enum ergonomics |
| `log` | ✅ (nice) | logging |
| `nix` (`socket`) | ✅ Linux only | `setsockopt` fwmark on the remote socket (`socket.rs::create_remote_socket`) |
| `tokio-util` (`rt`) | ➖ maybe | `CancellationToken` used to stop `run_forwarding` |
| `talpid-types` | ⚠️ only for `PublicKey` | see §4.1 — avoidable |
| `shadowsocks` | ❌ no | shadowsocks obfuscator only |
| `mullvad-masque-proxy` | ❌ no | quic obfuscator only |
| `udp-over-tcp` (git) | ❌ no | udp2tcp obfuscator only |
| `futures` | ❌ (likely) | used by other obfuscators |

**Conclusion:** LWO's real dependency footprint is tiny — essentially `tokio` + `rand`
(+ `nix` on Linux for fwmark). The heavy git/path deps (`shadowsocks`,
`mullvad-masque-proxy`, `udp-over-tcp`) are irrelevant to LWO and are a strong argument
*against* vendoring the whole crate and *for* extracting just the LWO parts.

### 4.1 `talpid_types::net::wireguard::PublicKey` is avoidable

`Settings` uses `PublicKey` for the two keys. That type is a newtype wrapper around
`x25519_dalek::PublicKey` with `from_base64` / `as_bytes` and serde support.

But — from §2 — the obfuscate/deobfuscate functions only need `&[u8; 32]`
(`pubkey.as_bytes()`). No elliptic-curve math is ever performed on these keys; they are
pure XOR masks. So for a standalone daemon we can:

- Decode the base64 WireGuard keys ourselves into `[u8; 32]`, and
- **avoid pulling in `x25519-dalek` / `talpid-types` entirely.**

Source: `talpid-types/src/net/wireguard.rs` (`PublicKey` wraps `x25519_dalek::PublicKey`;
methods `as_bytes`, `from_base64`, `From<[u8;32]>`).

---

## 5. Socket / forwarding behavior (from `socket.rs` + `lwo.rs`)

- `socket.rs::create_remote_socket(ipv4, fwmark)` binds a UDP socket to `0.0.0.0:0` (or
  `[::]:0`), and on Linux optionally applies an fwmark via `nix::setsockopt`. On error it
  yields `Error::BindRemoteUdp` / `Error::SetFwmark`.
- `Lwo::new()` (in `lwo.rs`) creates that remote socket, binds the local socket to
  `127.0.0.1:0`, reads back the local address, and builds the `Client`.
- `run()` spawns `run_forwarding` under a `CancellationToken`; two concurrent tasks:
  - **local → remote:** read from the client socket, `obfuscate(rng, buf, tx_key)`, send to
    `server_addr` on the remote socket.
  - **remote → local:** read from the remote socket, `deobfuscate(buf, rx_key)`, send back
    to the WireGuard sender on the client socket (uses `peek_sender` to learn where WG is).
- `packet_overhead()` returns **0** → no MTU adjustment needed.

Error variants (`lwo::Error`): `BindUdp`, `ConnectRemoteUdp`, `GetUdpLocalAddress`,
`PeekUdpSender`.

The fwmark hook is important for OpenWrt: it lets the obfuscator's outbound socket bypass
the VPN routing table so its own packets don't loop back into the tunnel — the standard
WireGuard `fwmark` trick. We will map this to OpenWrt routing in Stage 7.

---

## 6. Can it be extracted into a reusable library? — Yes

Two viable reuse levels, in increasing order of independence:

1. **Reuse the two functions only.** Copy/vendor `lwo.rs`'s `obfuscate`, `deobfuscate`,
   `header_mut`, and the header-length constants (a few hundred lines, deps: `rand` only),
   and write our own ~150-line async UDP proxy + config loader around them. Zero Mullvad
   workspace path/git deps.

2. **Reuse the crate as a dependency.** Add `tunnel-obfuscation` via git and call
   `create_obfuscator(&Settings::Lwo(..))`. Simplest to track upstream, but drags in
   `shadowsocks`, `mullvad-masque-proxy`, `udp-over-tcp`, `talpid-types`, `x25519-dalek`,
   etc. — heavy for a 73 MB overlay and slow to cross-compile.

The protocol is small, stable, and self-contained, so **extraction is clearly feasible.**
The trade-off between (1) and (2) is the subject of Stage 2.

---

## 7. Answers to Stage 1's required questions

- **How LWO works internally:** local UDP proxy; XORs only the fixed WireGuard header
  (148/92/64/32 bytes by type) with a 32-byte public key, randomizes byte 1 + sets bit
  `0x80`; payload untouched; `packet_overhead = 0`.
- **Where it intercepts WireGuard traffic:** at the UDP transport layer. WireGuard's
  endpoint is set to the proxy's local `127.0.0.1:<port>`; the proxy relays to the real
  server. WireGuard is unmodified.
- **Independent from `mullvad-daemon`?** Yes. `mullvad-daemon` depends on
  `tunnel-obfuscation`; the obfuscator never calls back into the daemon.
- **Which crates it depends on (for LWO specifically):** `tokio`, `rand` (+ `nix` on Linux,
  optionally `async-trait`/`thiserror`/`log`/`tokio-util`). The crate's other deps
  (`shadowsocks`, `mullvad-masque-proxy`, `udp-over-tcp`, `talpid-types`/`x25519-dalek`)
  are for other obfuscators and are avoidable for LWO.
- **Can it be extracted into a reusable library?** Yes — the core is two pure functions on
  `(&mut [u8], &[u8; 32])`. See §6.

---

## 8. Discovery that shapes the architecture (flagged per spec)

The spec asked me to flag anything found in the source that should change the design. The
significant discovery is **not** a change of direction but a strong *confirmation and
sharpening* of one option:

> Because the entire LWO protocol reduces to two dependency-light pure functions plus ~150
> lines of async UDP plumbing, **Option B (extract `tunnel-obfuscation`'s LWO into a small
> standalone `lwo-proxy` daemon)** is decisively the cleanest fit for OpenWrt. Vendoring the
> whole crate (or porting the daemon) would drag in `shadowsocks`, QUIC/masque, and
> `udp-over-tcp` — none of which LWO uses — bloating the build and the 73 MB overlay.

The one genuinely important correctness detail to carry forward: **key direction** (§2.2) —
outbound uses `server_public_key`, inbound uses `client_public_key`. Getting this backwards
produces a silently non-working tunnel (no handshake). This will be enforced and tested in
the prototype (Stage 3).

Full option comparison and the final recommendation are Stage 2.
