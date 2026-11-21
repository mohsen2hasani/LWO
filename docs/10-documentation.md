# Stage 10 — Documentation

Audience-oriented docs. Architecture and protocol details live in
[`01-research-mullvad-lwo.md`](01-research-mullvad-lwo.md) and
[`02-architecture.md`](02-architecture.md); this file is the practical reference.

---

## For users

**What it does.** Makes your existing WireGuard tunnel look unlike WireGuard on the wire, so
it keeps working on networks that block/fingerprint WireGuard — without changing which devices
use the VPN.

**Setup (short version).**
1. Install `lwo-proxy` and `luci-app-mullvad-lwo` ([INSTALL.md](INSTALL.md)).
2. In `/etc/config/network`, set your WireGuard peer `endpoint_host '127.0.0.1'` and
   `endpoint_port` to `lwo.listen_port`.
3. In LuCI → Services → **Mullvad LWO → Configuration**, set: interface, real server + port,
   server public key, client (interface) public key, fwmark. Enable and **Connect**.
4. Check **Status** for a recent handshake.

**Where to find the keys.**
- `server_pubkey` = the peer/server public key (the one already in your WG peer config).
- `client_pubkey` = your interface's own public key: `wg show <iface> public-key`.

**Day-to-day.** Use the LuCI **Status** (running/connected/handshake/bytes), **Logs**, and the
**Connect / Disconnect / Restart** buttons. Everything also works from the shell via
`service lwo {start,stop,restart}` and `wg show`.

---

## For developers

**Design.** Option B from [architecture](02-architecture.md): vendor Mullvad's LWO protocol
functions verbatim (`lwo-proxy/src/lwo_core.rs`) and wrap them in a minimal async UDP proxy.

**Modules.**
- `lwo_core.rs` — vendored `obfuscate`/`deobfuscate`/`header_mut`/`xor_bytes` (**do not edit**;
  re-sync via [UPSTREAM.md](UPSTREAM.md)).
- `config.rs` — CLI/UCI config + dependency-free base64 key decode.
- `proxy.rs` — `Proxy::bind` + `Proxy::serve`, the two forwarding tasks, fwmark socket.
- `main.rs` — runtime, signals, supervisor/reconnect.
- `logger.rs` — stderr logger.

**Build & test.**
```bash
cd lwo-proxy
cargo test           # unit + loopback e2e
cargo clippy --all-targets -- -D warnings
cargo fmt --all
```
Cross-compile and packaging: [03-prototype.md](03-prototype.md), [INSTALL.md](INSTALL.md).

**Key invariant (do not break).** Outbound (client→server) obfuscates with `server_pubkey`
(`tx_key`); inbound (server→client) deobfuscates with `client_pubkey` (`rx_key`). The loopback
test enforces this.

**Adding config options.** UCI (`files/lwo.config`) → validation + flag in `files/lwo.init` →
parse in `config.rs` → surface in LuCI `config.js`. Keep the four in sync.

---

## For maintainers

- **Re-syncing the protocol.** Follow [UPSTREAM.md](UPSTREAM.md); bump the commit hash in the
  `lwo_core.rs` header and `UPSTREAM.md`; run tests.
- **Versioning.** Bump `PKG_VERSION`/`PKG_RELEASE` in both package Makefiles and the crate
  version; update `Cargo.lock` (`cargo update -p lwo-proxy`… or `cargo build`).
- **Release checklist.** CI green (fmt/clippy/test + SDK build) → run [09-testing-checklist.md]
  (09-testing-checklist.md) on hardware → tag.
- **Upstreaming to openwrt/packages.** Switch the rust include back to the in-tree convention
  `include ../../lang/rust/rust-package.mk`, set real `PKG_SOURCE_URL`/`PKG_SOURCE_VERSION`/
  `PKG_MIRROR_HASH` and `PKG_MAINTAINER`, and ensure `Cargo.lock` is committed.

---

## Configuration reference (`/etc/config/lwo`)

| Option | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | bool | `0` | Master switch |
| `interface` | string | `wg_mullvad` | WG interface to obfuscate (for status) |
| `listen_port` | port | `51820` | Loopback port WG points at |
| `server` | host | — | Real server address (**required**) |
| `server_port` | port | `51820` | Real server port |
| `server_pubkey` | base64 | — | Peer/server key; obfuscates outbound (**required**) |
| `client_pubkey` | base64 | — | Interface key; deobfuscates inbound (**required**) |
| `fwmark` | dec/0x-hex | `0x51820` | Mark on outbound socket for the bypass rule |
| `auto_reconnect` | bool | `1` | Restart proxy on drop |
| `reconnect_delay` | uint | `3` | Seconds between reconnect attempts |
| `log_level` | enum | `info` | error/warn/info/debug/trace |

Relay switching / failover (used by `lwo-switch`, not the daemon):

| Option | Type | Default | Meaning |
|---|---|---|---|
| `peer` | list | — | Candidate relays, each `IP KEY [PORT]` (PORT optional → `server_port`) |
| `active` | host | — | Endpoint IP of the current relay (set by `lwo-switch`) |
| `wg_interface` | string | `wg_mullvad` | WG interface `lwo-switch` reconfigures |
| `wg_peer` | string | `wgpeer_mullvad` | WG peer section `lwo-switch` reconfigures |
| `bypass_route` | string | `lwo_bypass` | `/32` relay-bypass route section |
| `handshake_max` | uint | `180` | Tunnel considered down if handshake older than this (s) |
| `failover` | bool | `0` | Enable the `lwo-failover` watcher (auto-switch on a dead tunnel) |
| `failover_interval` | uint | `120` | How often the watcher checks the tunnel (s) |

## Switching relays / failover

Across Mullvad relays only the endpoint IP and peer public key differ (any WireGuard
port works for LWO), so a relay is an `(IP, key)` pair. `lwo-switch` swaps the active relay by updating
the proxy config **and** the kernel WG peer key + bypass route together, then restarting and
checking the handshake:

```sh
lwo-switch list | use <ip> | next | check | failover
```

`failover` is a no-op while the tunnel is healthy and otherwise rotates through `peer` until
one handshakes — wire it to cron (`*/2 * * * * /usr/sbin/lwo-switch failover`) for automatic
recovery. In LuCI the relays are a multi-row **Relays** field with Switch / Next / Failover
buttons. Get relay `IP`+`key` from `https://api.mullvad.net/app/v1/relays`.

---

## Troubleshooting

**No handshake.**
- Wrong key direction — most common. `server_pubkey` = peer key, `client_pubkey` =
  `wg show <iface> public-key`. Swapping them yields a silently dead tunnel.
- WireGuard endpoint not pointed at the proxy (`endpoint_host` must be `127.0.0.1`,
  `endpoint_port` == `listen_port`).
- Daemon not running: `logread -e lwo`; check for "missing required …" or bind errors.

**Handshake works but no traffic / loops.**
- The bypass rule is missing or outranked. `ip rule` should list `fwmark <mark> lookup main
  pref 1000`. If pbr/mwan3 uses a lower pref, lower `LWO_RULE_PREF`.
- `main` table's default isn't WAN — use a dedicated table (see [07-routing-pbr.md]
  (07-routing-pbr.md)).

**`Address already in use` on start.**
- Another service holds `listen_port`, or a previous instance is lingering — `service lwo
  restart`, or change `listen_port`.

**`Received non-obfuscated packet from relay` (debug logs).**
- The server isn't speaking LWO (wrong server/port), or `server_pubkey` is wrong. This log
  line only appears in debug builds.

**High CPU / low throughput.**
- Confirm the binary is the release build (size-optimized, `panic=abort`). LWO XORs only a
  small header, so CPU should be minimal; investigate WG MTU / CPU governor otherwise.

**fwmark collides with pbr/mwan3.**
- Pick a unique `fwmark` not used elsewhere; restart the service so the rule is re-added.

**Logs empty in LuCI.**
- The rpcd backend filters `logread -e lwo`. Ensure the daemon logs reach syslog
  (procd `stderr 1`/`stdout 1` are set) and `rpcd` is running; `ubus call luci.lwo status`
  should return JSON.
