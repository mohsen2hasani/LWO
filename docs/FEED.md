# The apk package feed

The packages are published as a small **signed apk feed** on GitHub Pages, so you can install
and upgrade them from OpenWrt's **System → Software** panel (or `apk`) instead of copying
`.apk` files by hand.

- Feed: `https://mohsen2hasani.github.io/LWO/arm_cortex-a7_neon-vfpv4/`
- Signing key: `https://mohsen2hasani.github.io/LWO/public-key.pem`

---

## For users — install from the feed

**Requirements**
- OpenWrt 25.12 on **`arm_cortex-a7_neon-vfpv4`** (Google Wifi AC-1304). Other targets aren't
  published — build them yourself (see [`INSTALL.md`](INSTALL.md)).
- A working WireGuard/Mullvad interface first — LWO obfuscates an existing tunnel. See the
  [full setup](../README.md#full-setup-mullvad-on-openwrt-with-lwo).

**Add the feed (one-time, on the router)**
```sh
# 1. trust the feed's signing key
wget -O /etc/apk/keys/lwo-feed.pem https://mohsen2hasani.github.io/LWO/public-key.pem

# 2. add the feed
echo 'https://mohsen2hasani.github.io/LWO/arm_cortex-a7_neon-vfpv4' > /etc/apk/repositories.d/lwo.list

# 3. refresh and install
apk update
apk add lwo-proxy luci-app-mullvad-lwo
```

That's it — the services auto-enable, and both packages now show up in **System → Software**
(and in the LuCI menu under **Services → Mullvad LWO**).

**Upgrading** — when a new release is published, just:
```sh
apk update && apk upgrade lwo-proxy luci-app-mullvad-lwo
```
(or use the **Upgrade** buttons in System → Software). Your `/etc/config/lwo` is preserved.

**Uninstalling**
```sh
apk del luci-app-mullvad-lwo lwo-proxy
```

**If `apk update` complains about the signature**
- Make sure the key downloaded to `/etc/apk/keys/lwo-feed.pem` is the real key (not an HTML
  404 page): `head -1 /etc/apk/keys/lwo-feed.pem` should show `-----BEGIN PUBLIC KEY-----`.
- A `404` on the feed URL means it isn't published yet (the release build takes a while) or
  your device isn't `arm_cortex-a7_neon-vfpv4`.
- apk-v3 feed signing is new; if a valid key still gets rejected, open an issue with the exact
  `apk update` error.

---

## For maintainers — publishing the feed

The `.github/workflows/publish.yml` workflow builds a **signed** feed and deploys it to
GitHub Pages. Under the hood it runs `openwrt/gh-action-sdk` with `INDEX=1` and the
`APK_PRIVATE_KEY` secret (the SDK writes it to `private-key.pem`, builds with
`CONFIG_SIGNED_PACKAGES=y`, and `make package/index` produces a signed index).

> Hosting must be public (routers fetch it with no auth), so the repo is public. GitHub Pages
> on a private repo isn't publicly reachable on the free tier.

**One-time setup**

1. Generate the signing keypair (private key **outside** the repo so it can't be committed):
   ```sh
   openssl ecparam -name prime256v1 -genkey -noout -out ~/lwo-feed-private.pem
   openssl ec -in ~/lwo-feed-private.pem -pubout -out feed/public-key.pem
   ```
2. Add the **private** key as an Actions secret: **Settings → Secrets and variables → Actions**
   → new secret `APK_PRIVATE_KEY` = contents of `~/lwo-feed-private.pem`. Never commit it.
3. Commit the **public** key: `git add feed/public-key.pem && git commit && git push`.
4. Enable Pages: **Settings → Pages → Source = GitHub Actions**.

**Publish a release**
```sh
# bump PKG_VERSION / PKG_RELEASE (and the crate version) first, then:
git tag v1.0.0
git push origin v1.0.0
```
The workflow builds and deploys; `public-key.pem` lands at the site root and the packages
under `/<arch>/`. Bump the version and push a new `vX.Y.Z` tag for each release.

**Other architectures** — add more `ARCH` values in `publish.yml`; each is served under its
own `/<arch>/` path, and users point their feed line at the matching one.

For submitting to the **official** OpenWrt feed instead of self-hosting, switch the package
Makefile from build-from-checkout to `PKG_SOURCE` + a release tag + real `PKG_MIRROR_HASH`
(see the note in `package/lwo-proxy/Makefile`).
