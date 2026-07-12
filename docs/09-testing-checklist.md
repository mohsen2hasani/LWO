# Stage 9 — Testing Checklist

Run these on the target (Google Wifi AC-1304, OpenWrt 25.12) after installing. Record the
verification metrics at the bottom for each run.

## Automated (host / CI)

- [ ] `cargo test` passes (vendored unit tests + config tests + loopback e2e).
- [ ] `cargo clippy -- -D warnings` clean.
- [ ] CI builds `.ipk`/`.apk` for `arm_cortex-a7_neon-vfpv4`.

## Functional (on the router)

### Boot & daemon startup
- [ ] `service lwo enable` then reboot → after boot, `pgrep -x lwo-proxy` shows the daemon.
- [ ] `logread -e lwo` shows `started (listen 127.0.0.1:… -> …)` with no errors.
- [ ] `ip rule | grep <fwmark>` shows the bypass rule at pref 1000.

### Handshake / connectivity
- [ ] `wg show <iface>` shows a **latest handshake** within the last 2 minutes.
- [ ] Traffic flows for VPN-routed clients (e.g. `curl` from a VPN client / from the router
      through the tunnel).
- [ ] LuCI **Status**: Running = yes, Connected = yes, bytes counters increasing.

### Reconnect
- [ ] `service lwo restart` → handshake re-establishes within a few seconds.
- [ ] Kill the daemon (`kill $(pgrep -x lwo-proxy)`) → procd respawns it; tunnel recovers.

### Packet loss / instability
- [ ] Introduce loss to the server (e.g. `tc qdisc add dev <wan> root netem loss 20%`) →
      tunnel keeps working / recovers; remove netem afterwards.

### Reboot
- [ ] Full reboot → daemon auto-starts, handshake re-establishes, ip rule present.

### Interface restart
- [ ] `ifdown <iface>; ifup <iface>` (or restart WG) → hotplug/self-reconnect restores the
      tunnel; new WG source port is picked up (`peek_sender`).

### WAN reconnect
- [ ] `ifdown wan; ifup wan` → proxy restarts (hotplug + procd trigger), outbound socket
      re-binds, handshake re-establishes.

### Endpoint changes
- [ ] Change `lwo.server`/`server_port` (or `server_pubkey`), `uci commit lwo`,
      `service lwo restart` → connects to the new endpoint; old rule cleaned up.

### Firewall restart
- [ ] `service firewall restart` → tunnel continues (the bypass ip rule is independent of
      firewall; re-add if your setup flushes rules — verify `ip rule` still present).

### pbr coexistence
- [ ] With `pbr` policies set (one client → VPN, one → WAN), confirm the split still holds
      and the WAN-only client is unaffected by LWO.

### Disable path
- [ ] `uci set lwo.main.enabled=0; uci commit; service lwo restart` → daemon does not run,
      ip rule removed, WireGuard (if still pointed at loopback) shows no handshake.

## Verification metrics (record per run)

| Metric | How to measure | Target |
|---|---|---|
| Latest handshake | `wg show <iface> latest-handshakes` | < 180 s, updates |
| Latency | `ping` through the tunnel vs. without LWO | ≈ same (overhead 0) |
| CPU usage | `top` / `htop` while pushing traffic | low; a few % on A7 |
| Memory usage | `cat /proc/$(pgrep -x lwo-proxy)/status | grep VmRSS` | a few MB |
| Throughput | `iperf3` through the tunnel | close to plain WG |

## Notes

- LWO overhead is 0 bytes (`packet_overhead()==0`), so **no MTU change** should be needed. If
  you see fragmentation, it predates LWO — check your WireGuard MTU.
- If handshake never appears: verify **key direction** — `server_pubkey` must be the peer's
  key and `client_pubkey` the interface's own key (see research doc §2.2).
