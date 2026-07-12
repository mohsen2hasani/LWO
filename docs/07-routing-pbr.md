# Stage 7 — Routing & Policy Based Routing (pbr)

**LWO only replaces the transport under WireGuard. It does not touch routing.** You keep
using OpenWrt routing and `pbr` exactly as before (Laptop → VPN, Phone → WAN, NAS → WAN,
LAN → Local). This document explains how the pieces fit and the one rule LWO adds.

## The two layers

```
 INNER traffic  (what pbr decides): client packets -> routed into wg_mullvad or out WAN
 OUTER traffic  (what LWO changes):  wg_mullvad's own UDP -> obfuscated -> real server
```

`pbr` operates on the **inner** layer — which clients/subnets use the VPN. LWO operates on
the **outer** layer — how the encrypted WireGuard packets leave the box. They don't overlap,
so your pbr policies are unaffected.

## How WireGuard is pointed at the proxy

In `/etc/config/network`, set the peer's endpoint to the **local proxy** instead of the real
server:

```
config interface 'wg_mullvad'
	option proto 'wireguard'
	option private_key '<interface private key>'
	list addresses '10.x.x.x/32'

config wireguard_wg_mullvad
	option public_key '<SERVER public key>'      # same as lwo.server_pubkey
	option endpoint_host '127.0.0.1'             # <-- the LWO proxy
	option endpoint_port '51820'                 # <-- lwo.listen_port
	list allowed_ips '0.0.0.0/0'
	list allowed_ips '::/0'
	option route_allowed_ips '1'
```

And in `/etc/config/lwo` give LWO the real server plus both public keys:

```
config lwo 'main'
	option enabled '1'
	option interface 'wg_mullvad'
	option listen_port '51820'
	option server '198.51.100.10'                # the REAL server
	option server_port '51820'
	option server_pubkey '<SERVER public key>'   # obfuscates outbound
	option client_pubkey '<INTERFACE public key>'# deobfuscates inbound
	option fwmark '0x51820'
```

> Because the WireGuard endpoint is now `127.0.0.1`, WireGuard's own traffic never hits the
> routing table on the way to the proxy — it's pure loopback. This removes the usual
> "exclude the endpoint from the tunnel" problem for WireGuard itself.

## The one rule LWO adds: bypass for the outbound socket

The proxy's **outbound** socket sends obfuscated UDP to the real server's public IP over WAN.
If you route all traffic through the VPN (default route via `wg_mullvad`, or a pbr policy that
sends everything to VPN), those packets would try to go back *into* the tunnel — a loop.

To prevent that, the proxy sets an **fwmark** (`lwo.fwmark`) on its outbound socket, and the
init script adds an `ip rule` so marked packets use the **main** table (which has the WAN
default route):

```
ip rule add fwmark 0x51820 lookup main pref 1000
ip -6 rule add fwmark 0x51820 lookup main pref 1000
```

This is the standard WireGuard fwmark technique, applied to the proxy socket instead of the
kernel WG socket. The init script adds the rule on `start` and removes it on `stop`.

### Interaction with pbr

- `pbr`'s own ip rules typically live at high priority numbers (≈ 30000). LWO uses
  **pref 1000** (higher priority / lower number), so the bypass wins for marked packets
  regardless of pbr policy. If your setup uses custom priorities below 1000, adjust
  `LWO_RULE_PREF` in `/etc/init.d/lwo`.
- The bypass assumes the **main** table's default route goes out WAN. If you have replaced
  the main default route with the VPN, point the rule at a table that has a WAN default
  instead (e.g. `lookup wan`), or create a small dedicated table:
  ```
  ip route add default via <wan-gateway> dev <wan-dev> table 100
  ip rule add fwmark 0x51820 lookup 100 pref 1000
  ```
  (adjust `del_fwmark_rule`/`add_fwmark_rule` accordingly).
- Choose an `fwmark` that does not collide with marks used by `pbr`, `mwan3`, SQM, or the WG
  interface itself.

## Firewall

The proxy's outbound UDP is ordinary WAN-egress traffic and needs no special firewall rule
on a default OpenWrt config (the `wan` zone permits outbound). The local loopback hop needs
nothing. If you run a strict output policy, allow UDP egress to the server IP:port on WAN.

## Summary

- pbr / mwan3 / SQM: unchanged.
- WireGuard config: change the peer endpoint to `127.0.0.1:<listen_port>`.
- LWO config: real server + both public keys + a unique `fwmark`.
- LWO adds exactly one ip rule (per family) to keep its outbound socket off the tunnel.

---

## Validated full-tunnel recipe (real deployment)

The following was verified end-to-end on a Google Wifi AC-1304 (OpenWrt 25.12.2,
`ipq40xx/chromium`) against Mullvad `nl-ams-wg-008`, defeating an ISP that blocks plain
WireGuard. The exact command blocks are in the top-level `README.md`; the points below are the
non-obvious gotchas worth calling out here.

1. **Use split default routes, not `0.0.0.0/0`.** Put `0.0.0.0/1` + `128.0.0.0/1` in the
   peer's `allowed_ips` (with `route_allowed_ips=1`). A plain `0.0.0.0/0` default via wg is
   fragile — netifd can drop it on a `network restart`, after which everything silently exits
   via WAN with your real IP (`ip route get 8.8.8.8` shows `dev wan`). The two `/1` routes are
   more specific than the WAN default, so they always win and survive restarts.

2. **Disable IPv6** unless you also give the tunnel a working IPv6 address. With `::/0` routed
   into a v4-only tunnel, IPv6 sends fail with `Operation not permitted` and apps that prefer
   AAAA break (and it's a leak). Disable it: `network.wan6.disabled=1`, remove `::/0` from
   `allowed_ips`, drop `network.globals.ula_prefix`, and set LAN `dhcp.lan.ra=disabled` +
   `dhcp.lan.dhcpv6=disabled`.

3. **DNS through the tunnel.** Point dnsmasq at Mullvad's resolver so queries don't leak to the
   ISP: `dhcp.@dnsmasq[0].server=10.64.0.1` + `noresolv=1`. `10.64.0.1` is reachable only via
   the tunnel, so this is fail-closed (no DNS if the tunnel is down).

4. **The relay bypass is what prevents the loop.** A `/32` route for the relay IP via the WAN
   gateway (`network.lwo_bypass`) keeps `lwo-proxy`'s own packets on WAN while everything else
   goes through wg. With the split `/1` routes above, this `/32` is the most-specific match for
   the relay and always wins.

5. **Getting the LWO port.** The relay's LWO UDP port is not 51820 and isn't in the public API;
   read it from a device where LWO already works: `mullvad status -v` (e.g. `…:33770/UDP`). The
   relay's WireGuard public key comes from `https://api.mullvad.net/app/v1/relays`.

6. **Diagnosing "connected but no internet".** A working `wg` handshake proves the ISP is *not*
   blocking you (the obfuscated packets reached the relay and it replied) — so remaining issues
   are local routing/DNS, not the ISP. Check `ip route get 8.8.8.8` (want `dev wg_mullvad`) and
   the exit IP via `uclient-fetch -4 -qO- https://icanhazip.com`.
