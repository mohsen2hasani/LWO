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
- Repo: https://github.com/mohsen2hasani/LWO (public, GPL-3.0-or-later). Latest release: **v1.1.0**.

## Repository layout
- `lwo-proxy/` — the Rust daemon. **`src/lwo_core.rs` is VENDORED VERBATIM** from Mullvad
  (`tunnel-obfuscation/src/lwo.rs`, GPL-3.0-or-later; exact commit pinned in
  `docs/UPSTREAM.md`) — don't edit it; re-sync per UPSTREAM.md. Everything else is original
  glue. Deps: `tokio` + `rand` (+ `nix` on Linux for fwmark and socket-buffer tuning).
  Multi-threaded tokio runtime (2 workers); UDP socket buffers enlarged for high-latency links.
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
- **LWO port:** any port in the WireGuard `port_ranges` of `api.mullvad.net/app/v1/relays`
  works (LWO reuses the WG endpoint — upstream relay selector; tested on the router 2026-11-21:
  4849, 51820, 33770 all passed traffic on one relay). Not per-relay. Relays that support LWO
  have `features.lwo` in that same API, which also gives each relay's IP + pubkey.
- **Relay list update:** `lwo-switch update [cc]` (LuCI "Update relay list") fetches the API,
  keeps active `features.lwo` relays of `lwo.main.country`, probes each over WAN via a temporary
  and rewrites `lwo.main.peer`. `probe_mode`: `switch` (default) moves the main tunnel to each
  relay (live swap, internet pauses, no leak) then returns to the old/first-good relay;
  `device` probes on a temporary `wg_probe` + second `lwo-proxy` + `/32` route using
  `probe_private_key` (a SECOND Mullvad device). The same key on two relays at once does
  handshake (tested), but is avoided so the account never looks like one device in two places.
  The active relay is never probed; its pre-test main handshake decides. `failover` is a
  no-op while an update runs (pid in `/var/run/lwo-update.pid`); switch-mode tests only *stage*
  uci (reverted at the end/on kill), so a reboot mid-test keeps the committed relay.
- **`apply()` must `ubus call network reload` after committing** (old code got it via `ifup`):
  else netifd re-adds the OLD relay's /32 on the next WAN reconnect -> proxy loops into the
  tunnel. Peer-only changes don't restart `wg_mullvad` (netifd diffs interface sections only).
  Relay /32 routes are built like netifd does: `gateway` + `ifstatus <iface>` l3_device (PPPoE).
  JSON parsing is `ucode` (always present: firewall4 depends on it).
- **Multi-relay + failover:** `lwo.main.peer` list of `"IP KEY [PORT]"`;
  `lwo-switch {list|use <ip>|next|check|failover}`; auto-failover via the `lwo-failover` service
  (`failover` / `failover_interval`, exposed as a LuCI toggle).
- A working handshake proves the ISP isn't blocking — remaining issues are local routing/DNS.
- **Throughput ceiling:** on a weak SoC (e.g. 717 MHz Cortex-A7) the limit is kernel per-packet
  work — WireGuard crypto + the userspace loopback hop + NAT — not the daemon (which stays well
  under one core). Multi-thread runtime + enlarged socket buffers help modestly; a slow router
  still caps well below its link speed. Inherent to a userspace obfuscation proxy, not a bug.

## Conventions
- License **GPL-3.0-or-later** everywhere (SPDX headers on all authored files; matches Mullvad).
- **Do NOT add AI/assistant attribution** to commit messages or PRs.
- **Only commit/push when explicitly asked.**
- History has been intentionally squashed to a clean root (force-push) more than once.

## Status / outstanding
- `v1.1.0`: adds multi-thread runtime + enlarged socket buffers (perf). Host tests + a
  `cargo check --target x86_64-unknown-linux-musl` (to compile-check the Linux-only `nix` code)
  both pass. Not yet rebuilt/redeployed to the router at time of writing.
- The signed apk feed is published to GitHub Pages; the feed repo line must point at the full
  `.../<arch>/packages.adb` URL (a bare dir URL makes apk fall back to legacy opkg and fail).
- `recvmmsg`/`sendmmsg` batching was intentionally NOT added: measured load showed the ceiling
  is kernel softirq (WG crypto + loopback hop), not syscalls, so batching wouldn't help and is
  Linux-only/untestable on the dev host.
