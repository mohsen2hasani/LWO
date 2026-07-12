# Publishing an apk feed (install from LuCI → System → Software)

This makes `lwo-proxy` / `luci-app-mullvad-lwo` installable and upgradable straight from the
OpenWrt Software panel, by publishing a **signed apk feed** to GitHub Pages
(`.github/workflows/publish.yml`).

How it works: the publish workflow runs `openwrt/gh-action-sdk` with `INDEX=1` and the
`APK_PRIVATE_KEY` secret. The SDK writes that key to `private-key.pem`, builds the packages
with `CONFIG_SIGNED_PACKAGES=y`, and `make package/index` produces a **signed** index. The
result is deployed to GitHub Pages; routers trust it via the matching public key.

> Hosting: this must be reachable by routers over plain HTTPS with no auth, so the repo must
> be **public** (it is). GitHub Pages on a private repo isn't publicly reachable on the free
> tier.

## One-time setup (maintainer)

### 1. Generate the signing keypair
Generate it **outside** the repo so the private key can't be committed:

```sh
openssl ecparam -name prime256v1 -genkey -noout -out ~/lwo-feed-private.pem
openssl ec -in ~/lwo-feed-private.pem -pubout -out feed/public-key.pem
```

### 2. Add the private key as an Actions secret
Repo → **Settings → Secrets and variables → Actions → New repository secret**
- Name: `APK_PRIVATE_KEY`
- Value: the contents of `~/lwo-feed-private.pem`

Keep `~/lwo-feed-private.pem` safe/offline; **never commit it**.

### 3. Commit the public key (safe — it's public)
```sh
git add feed/public-key.pem
git commit -m "feed: add apk signing public key"
git push
```

### 4. Enable Pages
Repo → **Settings → Pages → Source = GitHub Actions**.

### 5. Publish by tagging a release
```sh
git tag v1.0.0
git push origin v1.0.0
```
`publish.yml` builds the signed packages + index (~2h) and deploys to:
- feed:  `https://mohsen2hasani.github.io/LWO/arm_cortex-a7_neon-vfpv4/`
- key:   `https://mohsen2hasani.github.io/LWO/public-key.pem`

Publish a new version by bumping `PKG_VERSION`/`PKG_RELEASE` and pushing a new tag.

## One-time setup (each router)

```sh
# trust the feed's signing key
wget -O /etc/apk/keys/lwo-feed.pem https://mohsen2hasani.github.io/LWO/public-key.pem

# add the feed
echo 'https://mohsen2hasani.github.io/LWO/arm_cortex-a7_neon-vfpv4' > /etc/apk/repositories.d/lwo.list

apk update
apk add lwo-proxy luci-app-mullvad-lwo
```
After this the packages appear in **System → Software** — searchable, installable, and
auto-upgradable when you publish a newer tagged version.

## Notes / caveats

- Match the feed arch to the device (`arm_cortex-a7_neon-vfpv4`, OpenWrt 25.12). Add more arch
  builds to `publish.yml` if you target other devices.
- **apk-v3 feed signing is new.** If the first `apk update` rejects the signature/key, that's
  the one thing to iterate on — e.g. publishing the build-derived `public-key.pem` (from the
  SDK) instead of the openssl-derived one, or adjusting the key type. Everything else (build,
  index, Pages deploy) is standard.
- For upstreaming to the official OpenWrt feed instead of self-hosting, switch the package
  Makefile from build-from-checkout to `PKG_SOURCE` + a release tag + real `PKG_MIRROR_HASH`
  (see the note in `package/lwo-proxy/Makefile`).
