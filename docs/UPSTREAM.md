# Upstream vendoring

The obfuscation protocol in `lwo-proxy/src/lwo_core.rs` is **vendored verbatim** from
Mullvad. Only the pure protocol functions are copied; everything else in this repo is
original glue (see `docs/01-research-mullvad-lwo.md` for why).

| Field | Value |
|---|---|
| Upstream repo | https://github.com/mullvad/mullvadvpn-app |
| Upstream file | `tunnel-obfuscation/src/lwo.rs` |
| Pinned commit | `d0c9eb4cd7d1c35c35aa939b2470cde347ead4ce` |
| Upstream license | GPL-3.0-or-later |
| Vendored on | 2026-07-07 |

## Vendored symbols (unchanged bodies)

- `obfuscate`, `deobfuscate`, `obfuscate_thread_local`
- `header_mut`, `xor_bytes`, `is_obfuscated`
- constants: `HANDSHAKE_INIT/RESP`, `COOKIE_REPLY`, `DATA`, the `*_SZ` sizes, `OBFUSCATION_BIT`
- the two pure-function unit tests (`test_obfuscation`, `test_obfuscation_reserved_byte_uses_full_random_byte`)

## NOT vendored (reimplemented here, minimally)

- The async UDP proxy (`Lwo`, `Client`, `run_forwarding`) → `lwo-proxy/src/proxy.rs`
- `Settings` + `talpid_types::net::wireguard::PublicKey` → raw `[u8; 32]` + base64 in
  `lwo-proxy/src/config.rs` (LWO uses keys only as XOR masks, so no `x25519-dalek`)
- `create_remote_socket` (kept tiny) → `lwo-proxy/src/proxy.rs`

## Re-syncing

1. Diff upstream `tunnel-obfuscation/src/lwo.rs` at a newer commit against `lwo_core.rs`.
2. If the wire format changed (header sizes, the `0x80` bit, key direction), re-copy the
   affected functions verbatim.
3. Update the commit hash here and in the header of `lwo_core.rs`.
4. Run `cargo test` — the vendored unit tests + our loopback test guard the round-trip.
