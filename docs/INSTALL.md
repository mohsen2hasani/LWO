# Installation Guide

Two ways to get the packages onto the router: build them with the OpenWrt SDK (recommended,
reproducible) or build the binary with rustup for quick testing.

## Prerequisites on the router

- OpenWrt 25.12.x on `arm_cortex-a7_neon-vfpv4` (Google Wifi AC-1304) or compatible.
- An existing, working WireGuard interface (`kmod-wireguard`, `wireguard-tools`).
- `ip` (`ip-full` or busybox ip) and `logread` (present by default).

## Option 1 — Build with the OpenWrt SDK (recommended)

1. Download the SDK matching your release/target, e.g.
   `openwrt-sdk-25.12.*-arm_cortex-a7_neon-vfpv4_*.tar.zst`, and extract it.
2. Add this repo as a custom feed. In `feeds.conf` (or `feeds.conf.default`):
   ```
   src-git lwo https://github.com/mohsen2hasani/LWO.git
   ```
3. Update/install feeds and the default feeds LWO relies on (`packages` for `rust`, `luci`):
   ```bash
   ./scripts/feeds update -a
   ./scripts/feeds install -a
   ./scripts/feeds install lwo-proxy luci-app-mullvad-lwo
   ```
4. Select the packages in `make menuconfig`:
   - `Network → VPN → lwo-proxy`
   - `LuCI → Applications → luci-app-mullvad-lwo`
5. Build:
   ```bash
   make package/lwo-proxy/compile V=s
   make package/luci-app-mullvad-lwo/compile V=s
   ```
6. Copy the resulting `.ipk`/`.apk` from `bin/packages/<arch>/lwo/` to the router and install:
   ```bash
   # apk (OpenWrt 25.12 default)
   apk add ./lwo-proxy-*.apk ./luci-app-mullvad-lwo-*.apk
   # or opkg on older images
   opkg install ./lwo-proxy_*.ipk ./luci-app-mullvad-lwo_*.ipk
   ```

CI (`.github/workflows/ci.yml`) performs exactly this build for `arm_cortex-a7_neon-vfpv4`
and uploads the packages as artifacts — you can grab them from a green run instead of
building locally.

## Option 2 — rustup cross build (quick test, binary only)

```bash
rustup target add armv7-unknown-linux-musleabihf
export CARGO_TARGET_ARMV7_UNKNOWN_LINUX_MUSLEABIHF_LINKER=arm-linux-musleabihf-gcc
export RUSTFLAGS="-C target-cpu=cortex-a7 -C target-feature=+neon,+vfpv4"
cargo build --release --manifest-path lwo-proxy/Cargo.toml \
  --target armv7-unknown-linux-musleabihf
scp target/armv7-unknown-linux-musleabihf/release/lwo-proxy root@router:/usr/sbin/
```
Then install the init/config/hotplug files from `package/lwo-proxy/files/` manually. (Use
Option 1 for anything beyond quick testing.)

## Configure

1. Point WireGuard at the proxy in `/etc/config/network` (peer `endpoint_host '127.0.0.1'`,
   `endpoint_port` = `lwo.listen_port`). See [`07-routing-pbr.md`](07-routing-pbr.md).
2. Fill in `/etc/config/lwo` (server, ports, both public keys, fwmark) — or use the LuCI
   **Configuration** page.
3. Enable and start:
   ```bash
   uci set lwo.main.enabled='1'; uci commit lwo
   service lwo enable
   service lwo start
   ```
4. Verify: `wg show <iface>` shows a recent handshake, or the LuCI **Status** page shows
   *Running: yes / Connected: yes*.

## Uninstall

```bash
service lwo stop; service lwo disable
apk del luci-app-mullvad-lwo lwo-proxy    # or: opkg remove ...
```
`/etc/config/lwo` is preserved as a conffile; remove it manually if desired.
