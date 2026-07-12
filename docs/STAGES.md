# Stage index — deliverables map

Every stage from the spec and where it lives in this repo.

| Stage | Deliverable(s) |
|---|---|
| 1 — Study Mullvad source | [`docs/01-research-mullvad-lwo.md`](01-research-mullvad-lwo.md) |
| 2 — Design architecture (A/B/C) | [`docs/02-architecture.md`](02-architecture.md) — recommends Option B |
| 3 — Minimal prototype | [`lwo-proxy/`](../lwo-proxy) crate + [`docs/03-prototype.md`](03-prototype.md); protocol vendored in `src/lwo_core.rs` ([`docs/UPSTREAM.md`](UPSTREAM.md)) |
| 4 — OpenWrt packages | [`package/lwo-proxy/Makefile`](../package/lwo-proxy/Makefile) |
| 5 — procd + UCI integration | [`package/lwo-proxy/files/lwo.init`](../package/lwo-proxy/files/lwo.init), [`lwo.config`](../package/lwo-proxy/files/lwo.config), [`lwo.hotplug`](../package/lwo-proxy/files/lwo.hotplug) |
| 6 — LuCI app | [`package/luci-app-mullvad-lwo/`](../package/luci-app-mullvad-lwo) (Status/Config/Logs views, rpcd backend, ACL, menu) |
| 7 — Routing / pbr | [`docs/07-routing-pbr.md`](07-routing-pbr.md) |
| 8 — Packaging & CI | Makefiles above, [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), [`README.md`](../README.md), [`docs/INSTALL.md`](INSTALL.md) |
| 9 — Testing | [`docs/09-testing-checklist.md`](09-testing-checklist.md) + `lwo-proxy/tests/loopback.rs` |
| 10 — Documentation | [`docs/10-documentation.md`](10-documentation.md) (users/devs/maintainers/troubleshooting) |

## Verified locally
- `cargo test` — 7 passing (vendored unit tests + config + loopback e2e)
- `cargo clippy --all-targets -- -D warnings` — clean
- `cargo fmt --all -- --check` — clean
- release build + CLI (`--help`, arg validation) — working

## Not verifiable in this environment
- The OpenWrt SDK cross-build for `arm_cortex-a7_neon-vfpv4` (needs the SDK toolchain) —
  wired into CI (`.github/workflows/ci.yml`), to be confirmed on a green run / on hardware.
- On-router functional tests — see [`09-testing-checklist.md`](09-testing-checklist.md).
