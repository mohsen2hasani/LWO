<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
<!-- SPECKIT END -->

# Project guide — Mullvad LWO for OpenWrt

## What this is
Brings Mullvad's **Lightweight WireGuard Obfuscation (LWO)** to OpenWrt as a small,
router-friendly package (no Mullvad GUI/daemon). LWO is a **local UDP proxy**: the kernel
WireGuard peer `endpoint` points at `127.0.0.1:<listen_port>`; the `lwo-proxy` daemon
obfuscates each WireGuard packet (XORs the fixed WG header with a 32-byte WG public key and
sets an obfuscation bit) and forwards it to the real Mullvad relay; the return path
deobfuscates. Payload untouched → 0-byte overhead. WireGuard, routing, and `pbr` are left
alone — only the transport changes.

- Target: **Google Wifi AC-1304** (`arm_cortex-a7_neon-vfpv4`), OpenWrt 25.12
  (`ipq40xx/chromium`), kernel 6.12. Validated end-to-end on that hardware (works through an
  ISP that blocks plain WireGuard).
- Repo: https://github.com/mohsen2hasani/LWO (public, GPL-3.0-or-later). Latest release: **v1.0.0**.

## Repository layout
- `lwo-proxy/` — the Rust daemon. **`src/lwo_core.rs` is VENDORED VERBATIM** from Mullvad
  (`tunnel-obfuscation/src/lwo.rs`, GPL-3.0-or-later; exact commit pinned in
  `docs/UPSTREAM.md`) — don't edit it; re-sync per UPSTREAM.md. Everything else is original
  glue. Deps: `tokio` + `rand` (+ `nix` on Linux for fwmark).
  - `config.rs` (CLI/UCI config + dependency-free base64 key decode), `proxy.rs` (`bind`+`serve`
    UDP proxy, fwmark socket), `main.rs` (runtime, signals, supervisor/reconnect),
    `logger.rs`, `tests/loopback.rs` (e2e round-trip + key-direction check).
- `package/lwo-proxy/` — OpenWrt `Makefile` (builds from the checked-out crate — see the note in
  the Makefile) + `files/`: `lwo.init` (procd), `lwo.config` (UCI), `lwo.hotplug`,
  `lwo-switch` (relay switch/failover CLI), `lwo-failover.init` (auto-failover watcher).
  `postinst` auto-enables the services.
- `package/luci-app-mullvad-lwo/` — LuCI app: JS views (Status/Config/Logs + relay UI), rpcd
  backend `root/usr/libexec/rpcd/luci.lwo` (**must stay executable** — mode 0755), ACL, menu.
- `docs/` — 01 research, 02 architecture, 03 prototype, 07 routing/pbr, 09 testing, 10 docs,
  `INSTALL.md`, `FEED.md` (apk feed), `UPSTREAM.md` (vendoring), `STAGES.md`.
- `.github/workflows/` — `ci.yml` (fmt/clippy/test on every push; heavy SDK build only on PR /
  manual dispatch), `publish.yml` (on a `vX.Y.Z` tag → builds a **signed apk feed** and
  deploys to GitHub Pages).

## Build / test / release
- Host tests: `cd lwo-proxy && cargo test` (plus `cargo fmt --all -- --check`, `cargo clippy
  --all-targets -- -D warnings`). A Rust toolchain is installed via rustup on this machine.
- OpenWrt build: via the SDK / `openwrt/gh-action-sdk` (CI). Arch `arm_cortex-a7_neon-vfpv4`.
  The SDK build compiles `rust/host` from source (~2h) and needs the free-disk-space step.
- Release: bump `PKG_VERSION`/`PKG_RELEASE` in **both** package Makefiles + the crate version +
  `Cargo.lock`, then push a `vX.Y.Z` tag → `publish.yml` deploys the signed feed.
- Install (users): the apk feed at `https://mohsen2hasani.github.io/LWO/` (see `docs/FEED.md`),
  or build the `.apk`s (see `docs/INSTALL.md`).

## Key facts & gotchas (learned on real hardware)
- **Key direction:** `lwo.server_pubkey` = the relay's WG key; `lwo.client_pubkey` = the
  interface's own key. Swapping them = silent, handshake-less tunnel.
- **Full-tunnel routing:** use split routes `0.0.0.0/1` + `128.0.0.0/1` (NOT `0.0.0.0/0` —
  netifd drops the `/0` default on a network restart and traffic silently leaks via WAN).
- **Disable IPv6** (no Mullvad v6 address) or apps hit `Operation not permitted` / leak.
- **DNS:** `dhcp.@dnsmasq[0].server=10.64.0.1` + `noresolv=1` (Mullvad DNS through the tunnel).
- **Relay loop bypass:** a `/32` route for the relay IP via the WAN gateway keeps `lwo-proxy`'s
  own packets off the tunnel.
- **LWO relay port** is non-standard (e.g. `33770`) — read it from `mullvad status -v` on a
  device where LWO works; relay pubkey from `api.mullvad.net/app/v1/relays`.
- **Multi-relay + failover:** `lwo.main.peer` list of `"IP KEY [PORT]"`;
  `lwo-switch {list|use <ip>|next|check|failover}`; auto-failover via the `lwo-failover` service
  (`failover` / `failover_interval`, exposed as a LuCI toggle).
- A working handshake proves the ISP isn't blocking — remaining issues are local routing/DNS.

## Conventions
- License **GPL-3.0-or-later** everywhere (SPDX headers on all authored files; matches Mullvad).
- **Do NOT add AI/assistant attribution** to commit messages or PRs.
- **Only commit/push when explicitly asked.**
- History has been intentionally squashed to a clean root (force-push) more than once.

## Status / outstanding
- `v1.0.0` is tagged; the publish workflow (~2h) deploys the signed feed to GitHub Pages.
- **Not yet verified:** the first `apk update` on a live router accepting the apk-v3 signed
  feed. If the signature is rejected, that's the one thing to iterate on (key type / publishing
  the SDK-derived public key). Everything else is validated.
