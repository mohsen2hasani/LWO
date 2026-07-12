# Stage 2 — OpenWrt Architecture Design

> Goal: compare realistic ways to bring LWO to OpenWrt, then recommend the cleanest one.
> Grounded in the Stage 1 findings (see `01-research-mullvad-lwo.md`).

---

## 0. Constraints that drive the decision

- **Target:** Google Wifi AC-1304, `arm_cortex-a7_neon-vfpv4`, musl, OpenWrt 25.12 /
  kernel 6.12, ~500 MB RAM, **~73 MB writable overlay** → binary size and build weight
  matter a lot.
- **License:** the Mullvad app is **GPL-3.0**. Any code we reuse from `lwo.rs` makes our
  package a GPL-3.0 derivative. That is fine for OpenWrt and for a standalone repo, and it
  is *required* if we want to upstream to Mullvad. We will license the whole package
  GPL-3.0 and preserve Mullvad's copyright headers on any reused file.
- **Kernel WireGuard stays.** OpenWrt uses in-kernel WireGuard via netifd/`wireguard`
  proto. We do **not** touch it; LWO only replaces the *transport* under it (Stage 7).
- **Reuse over rewrite** (per spec): the protocol lives in two pure functions
  (`obfuscate`/`deobfuscate`) — cheap to reuse, expensive to reimplement correctly (header
  lengths, byte-1 randomization + `0x80`, key direction). We reuse those verbatim.

---

## 1. Option comparison

### Option A — Port `mullvad-daemon` + `mullvad-cli`

Bring up the real Mullvad daemon on OpenWrt and drive it via CLI.

**Pros**
- Zero protocol re-implementation; tracks upstream exactly.
- Get every obfuscator (udp2tcp, shadowsocks, QUIC, LWO) for free.

**Cons**
- `mullvad-daemon` is a large product: gRPC management interface, account/device
  management, relay selection, settings store, firewall/DNS integration, split tunneling,
  problem-report uploader, etc. Almost none of it is needed to run LWO.
- Pulls the **entire Cargo workspace** (dozens of crates incl. `talpid-*`, `shadowsocks`,
  `mullvad-masque-proxy`, `udp-over-tcp`, gRPC/prost, x25519-dalek…). Cross-compiling that
  for `armv7-musl` is slow and the resulting binaries are large for a 73 MB overlay.
- Duplicates OpenWrt's own firewall/DNS/routing with Mullvad's assumptions → conflicts with
  netifd, pbr, and UCI. Fights the platform.
- Would need Mullvad account/relay plumbing stubbed out or bypassed — high maintenance.

**Verdict:** wrong tool. Massive surface area to get one small transport shim.

---

### Option B — Extract LWO into a small standalone `lwo-proxy` daemon ✅ recommended

Reuse `lwo.rs`'s `obfuscate`/`deobfuscate` (the actual protocol) and write a minimal,
purpose-built async UDP proxy + UCI/procd integration around them.

**Pros**
- **Tiny dependency footprint:** `tokio` (net/rt/io/macros) + `rand` (+ `nix` for fwmark on
  Linux). No shadowsocks/QUIC/udp-over-tcp/gRPC. Fast cross-compile, small binary — fits
  73 MB overlay comfortably.
- **Reuses the protocol verbatim**, so we inherit correctness and future fixes by re-vendoring
  a single file. The parts that are hard to get right (header sizes, byte-1 handling, key
  direction) are copied, not re-derived.
- **Native OpenWrt citizen:** procd service, UCI config, LuCI app, hotplug hooks. Plays
  nicely with netifd WireGuard and `pbr` (Stage 7) instead of replacing them.
- Clear scope → easy to review, easy to upstream to `openwrt/packages` or ship standalone.

**Cons**
- We maintain ~150 lines of glue (the async proxy loop, config parsing, key decoding,
  fwmark, signal handling). Small and testable.
- Must manually re-sync the vendored `lwo.rs` core if Mullvad changes the wire format. The
  format is stable and versioned by the `0x80` bit; a `docs/UPSTREAM.md` will pin the exact
  upstream commit we vendored from.

**Verdict:** best fit. Minimal, correct, OpenWrt-idiomatic.

> **Note on "just add `tunnel-obfuscation` as a git dependency" (a sub-variant of B):**
> `tunnel-obfuscation/Cargo.toml` uses **path deps** (`talpid-types = { path = "../.." }`,
> `mullvad-masque-proxy = { path = ... }`). A `cargo` git dependency on that crate therefore
> fetches the whole `mullvadvpn-app` repo and resolves those siblings, pulling in
> shadowsocks / masque / udp-over-tcp / x25519-dalek even though LWO never uses them. That
> reintroduces Option A's bloat. So within Option B we choose **vendor the LWO core file**,
> not depend on the crate.

---

### Option C — Modify WireGuard userspace (e.g. patch `wireguard-go`/boringtun)

Bake obfuscation into a userspace WireGuard implementation.

**Pros**
- Single process; no extra local hop.

**Cons**
- OpenWrt uses **kernel** WireGuard for performance. Switching to userspace WG on a Cortex-A7
  is a large throughput/CPU regression — the opposite of "router-friendly."
- We'd fork and maintain a WireGuard implementation — far more code and risk than a proxy.
- Doesn't reuse Mullvad's `lwo.rs`; we'd re-implement the protocol inside WG's I/O path.
- Ties LWO to one WG implementation; harder to reason about and to upstream.

**Verdict:** heaviest and least aligned with "reuse Mullvad code" and "router-friendly."

---

## 2. Recommendation: **Option B**

Build a small Rust daemon, **`lwo-proxy`**, that:

1. reads config from **UCI**,
2. reuses Mullvad's `obfuscate`/`deobfuscate` **verbatim** (vendored `lwo.rs` core),
3. runs a minimal async UDP proxy (local `127.0.0.1:<port>` ⇄ remote server),
4. is supervised by **procd**, configured via **UCI**, and managed via a **LuCI app**,
5. leaves netifd WireGuard and `pbr` untouched — it only swaps the transport.

---

## 3. Data flow

```
                    ┌───────────────────────── OpenWrt box ─────────────────────────┐
                    │                                                                │
  LAN clients ──▶ kernel WireGuard (wg_mullvad)                                      │
                    │   Peer endpoint = 127.0.0.1:<lwo_port>   (loopback, no routing)│
                    │            │  plain WG/UDP                                      │
                    │            ▼                                                    │
                    │      ┌───────────────┐  obfuscate(pkt, server_pubkey)          │
                    │      │  lwo-proxy    │───────────────────┐                      │
                    │      │  (this daemon)│                    │ remote socket       │
                    │      │  local sock   │◀───────────────┐  │ (fwmark set →        │
                    │      └───────────────┘  deobfuscate(  │  │  bypass tunnel)      │
                    │            ▲            pkt,client_pk)│  │                      │
                    │            │                          │  ▼                      │
                    └────────────┼──────────────────────────┼──── WAN ──────────────┘
                                 │                           │
                                 └────── obfuscated WG/UDP ──┴──▶  Mullvad server:port
```

- WireGuard → proxy hop is pure **loopback**, so it never hits the routing table (no loop
  risk on that leg).
- The proxy's **remote socket** is the packet that must bypass the VPN routing table so the
  server traffic doesn't get routed back into the tunnel. We use the **fwmark** that
  `socket.rs::create_remote_socket` already supports (`nix::setsockopt`) plus an `ip rule`
  (Stage 7). This is the standard WireGuard `fwmark` technique and integrates with `pbr`.

---

## 4. Design decision that deviates from Mullvad (flagged per spec)

**Mullvad uses an *ephemeral* local port** (`127.0.0.1:0`) because the desktop daemon reads
`endpoint()` back at runtime and programmatically writes it into the WireGuard config.

**On OpenWrt we will bind a *fixed* local port** taken from UCI (`option listen_port`, e.g.
`51820`). Reason: OpenWrt's WireGuard config is **static** (UCI/netifd). A fixed local port
lets the WG peer `endpoint` be a stable `127.0.0.1:<listen_port>` in `/etc/config/network`,
with no runtime rewriting of WG config, no race between "proxy started" and "WG configured,"
and clean procd restart semantics.

Everything else (the two core functions, header handling, key direction) is reused exactly.
This is a config/plumbing deviation, not a protocol change.

---

## 5. Component / repository layout (proposed)

```
lwo-openwrt/                     (this repo, GPL-3.0)
├── docs/                        # research, architecture, guides (Stages 1,2,10)
├── lwo-proxy/                   # the Rust daemon (Stages 3)
│   ├── Cargo.toml               # deps: tokio, rand, nix(linux), log, anyhow/thiserror
│   └── src/
│       ├── main.rs              # arg/env, logging, signal handling, runtime
│       ├── config.rs            # load config (UCI-provided via env/args), key base64 decode
│       ├── proxy.rs             # async UDP proxy loop (our ~150 lines of glue)
│       └── lwo_core.rs          # VENDORED verbatim from Mullvad lwo.rs (obfuscate/…)
├── package/                     # OpenWrt packaging (Stages 4,5)
│   ├── lwo-proxy/               # Makefile + files/ (init.d, config, hotplug)
│   └── luci-app-mullvad-lwo/    # LuCI app (Stage 6)
├── .github/workflows/           # CI: cross-compile via OpenWrt SDK (Stage 8)
├── LICENSE.md                   # GPL-3.0-or-later
└── README.md
```

- `lwo_core.rs` is the **only** file copied from Mullvad; it keeps their copyright header and
  a comment recording the source path + commit. Re-syncing upstream = re-copying one file.
- The daemon does **not** depend on `talpid-types`; keys arrive as base64 strings and are
  decoded to `[u8; 32]` locally (Stage 1 §4.1).

---

## 6. Config surface (preview of Stage 5)

UCI `/etc/config/lwo`:

```
config lwo 'main'
    option enabled       '1'
    option interface     'wg_mullvad'    # WG netifd interface this fronts
    option listen_port   '51820'         # local loopback port WG points at
    option server        'x.x.x.x'       # real Mullvad endpoint IP
    option server_port   '51820'         # real Mullvad endpoint port
    option server_pubkey '<base64>'      # peer/server WG public key (tx / obfuscate)
    option client_pubkey '<base64>'      # our interface WG public key (rx / deobfuscate)
    option fwmark        '0x51820'       # bypass-tunnel mark for remote socket
    option auto_reconnect '1'
    option log_level     'info'
```

`interface`/`client_pubkey` can be auto-derived from the existing WG UCI section in a later
convenience pass, but explicit config is the baseline.

---

## 7. Answers to Stage 2's required questions

- **Cleanest solution for OpenWrt:** **Option B** — vendor Mullvad's LWO core functions into
  a minimal `lwo-proxy` daemon; integrate via procd/UCI/LuCI; leave kernel WG + pbr intact.
- **Why not A:** whole-daemon surface + full-workspace build is disproportionate and fights
  the platform.
- **Why not C:** kernel-WG performance loss on Cortex-A7 and a WG fork to maintain; doesn't
  reuse Mullvad's protocol code.
- **Reuse strategy:** copy one file (`lwo_core.rs`) verbatim under GPL-3.0; write ~150 lines
  of OpenWrt-idiomatic glue around it.

---

Next: **Stage 3** — a minimal working prototype of `lwo-proxy` (Rust, tokio + rand),
cross-compiled for `armv7 musl` via the OpenWrt SDK, with a local loopback round-trip test
proving obfuscate→deobfuscate correctness and the key-direction invariant.
