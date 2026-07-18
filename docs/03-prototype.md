# Stage 3 — Minimal working prototype (`lwo-proxy`)

A small Rust daemon that reuses Mullvad's LWO protocol verbatim and wraps it in a minimal
async UDP proxy suitable for OpenWrt. Deps: `tokio` + `rand` (+ `nix` on Linux for fwmark).

## Layout

```
lwo-proxy/
├── Cargo.toml
├── src/
│   ├── lib.rs          # module root (so tests can import)
│   ├── main.rs         # CLI parse, runtime, signal handling, supervisor/reconnect
│   ├── config.rs       # CLI/UCI config + dependency-free base64 key decode
│   ├── proxy.rs        # async UDP proxy (bind + serve), fwmark socket
│   ├── logger.rs       # ~20-line stderr logger (procd captures it)
│   └── lwo_core.rs     # VENDORED verbatim from Mullvad (obfuscate/deobfuscate)
└── tests/
    └── loopback.rs     # e2e round-trip + key-direction invariant
```

## What it does

1. Parses config from CLI flags (the init script builds them from UCI):
   `--server IP:PORT --server-pubkey B64 --client-pubkey B64 [--listen 127.0.0.1:51820]
   [--fwmark 0x51820] [--reconnect-delay 3] [--no-reconnect] [--log-level info]`
2. Binds a **fixed** local loopback socket (`--listen`, default `127.0.0.1:51820`) — this is
   the address the kernel WireGuard peer `endpoint` points at.
3. Binds an outbound socket (wildcard) and, on Linux, sets its **fwmark** so its packets
   bypass the VPN routing table (Stage 7). Connects it to the real server.
4. `peek_sender()` to learn which port kernel WireGuard is sending from, connects back to it.
5. Runs two tasks: `client→server` obfuscated with the **server** key, `server→client`
   deobfuscated with the **client** key (the key-direction invariant from Stage 1 §2.2).
6. On failure (e.g. WG restart) the supervisor reconnects after `--reconnect-delay`. On
   SIGTERM/SIGINT (procd) it shuts down cleanly.

`packet_overhead` is 0 — no MTU changes needed.

## Correctness testing (host)

```bash
cd lwo-proxy
cargo test            # runs vendored unit tests + config tests + loopback e2e
```

`tests/loopback.rs` stands up a fake WireGuard socket, the proxy, and a fake server, then
asserts that outbound packets arrive obfuscated-with-the-server-key and inbound replies are
deobfuscated-with-the-client-key. This is the same shape as Mullvad's `test_e2e_obfuscation`
but drives our proxy with raw `[u8;32]` keys. (Runs in CI — see Stage 8 — since no Rust
toolchain is assumed on the dev host.)

## Cross-compilation for the target (`arm_cortex-a7_neon-vfpv4`, musl)

Target triple: **`armv7-unknown-linux-musleabihf`**.

There are two supported paths; the OpenWrt SDK path (Stage 4/8) is authoritative for release
packages, the rustup path is handy for quick local iteration.

### A) OpenWrt SDK (authoritative, used by CI)

OpenWrt's `rust` feed / build infra sets the correct target, musl sysroot, linker and
`RUSTFLAGS` for the selected `.config`. The package `Makefile` (Stage 4) just declares the
Rust package and the SDK does the rest:

```bash
# inside the OpenWrt SDK for the target
./scripts/feeds update -a && ./scripts/feeds install -a
make package/lwo-proxy/compile V=s
```

### B) rustup cross build (quick local check)

Requires a musl cross toolchain (e.g. `arm-linux-musleabihf-gcc`):

```bash
rustup target add armv7-unknown-linux-musleabihf

# point cargo at the cross linker (adjust to your toolchain)
export CARGO_TARGET_ARMV7_UNKNOWN_LINUX_MUSLEABIHF_LINKER=arm-linux-musleabihf-gcc
# tune codegen for the Cortex-A7 + NEON/VFPv4 (optional)
export RUSTFLAGS="-C target-cpu=cortex-a7 -C target-feature=+neon,+vfpv4"

cargo build --release --target armv7-unknown-linux-musleabihf
# binary: target/armv7-unknown-linux-musleabihf/release/lwo-proxy
```

The `[profile.release]` in `Cargo.toml` is tuned for the router overlay:
`opt-level = "s"`, `lto = true`, `codegen-units = 1`, `strip = true`, `panic = "abort"`.

## Notes / deliberate choices

- **No `talpid-types` / `x25519-dalek`.** Keys are decoded from base64 into `[u8;32]` and used
  only as XOR masks. Confirmed safe by Stage 1 §4.1.
- **Fixed local port** instead of Mullvad's ephemeral port — see Stage 2 §4. This is the only
  behavioural deviation; the protocol bytes are identical.
- **Multi-threaded runtime (2 workers)** so the two forwarding directions can run on separate
  cores. The socket send/receive buffers are also enlarged (`SO_*BUF`, Linux) to avoid dropping
  bursts on high-latency links.
- **Throughput note:** on a weak SoC the ceiling is dominated by kernel per-packet work
  (WireGuard crypto + the userspace loopback hop + NAT), not the daemon itself, so the above
  are modest gains — a slow router will still cap well below its raw link speed. This is
  inherent to a userspace obfuscation proxy, not a misconfiguration.
