// SPDX-License-Identifier: GPL-3.0-or-later
//
// LWO (Lightweight WireGuard Obfuscation) — core protocol.
//
// This file is VENDORED VERBATIM from Mullvad's tunnel-obfuscation crate:
//
//   repo:   https://github.com/mullvad/mullvadvpn-app
//   path:   tunnel-obfuscation/src/lwo.rs
//   commit: d0c9eb4cd7d1c35c35aa939b2470cde347ead4ce
//   license: GPL-3.0-or-later
//   Copyright (C) 2026 Mullvad VPN AB
//
// Only the pure, dependency-light protocol functions are copied here
// (the obfuscate/deobfuscate primitives, the WireGuard header constants and
// the XOR helper). The async UDP-proxy plumbing, the `Obfuscator` trait impl,
// the `Lwo`/`Settings` types and the `talpid_types::PublicKey` dependency are
// intentionally NOT vendored — LWO uses keys only as raw 32-byte XOR masks, so
// this crate provides its own minimal proxy (src/proxy.rs) and key handling
// (src/config.rs). See docs/01-research-mullvad-lwo.md for the full analysis.
//
// To re-sync with upstream: re-copy the functions below from the path/commit
// above and update the commit hash in this header and in docs/UPSTREAM.md.
//
// The bodies below are reproduced unchanged from upstream so that this proxy
// stays wire-compatible with real Mullvad LWO servers.

use rand::RngCore;

// WG message types, copied from gotatun
type MessageType = u8;
const HANDSHAKE_INIT: MessageType = 1;
const HANDSHAKE_RESP: MessageType = 2;
const COOKIE_REPLY: MessageType = 3;
const DATA: MessageType = 4;

const HANDSHAKE_INIT_SZ: usize = 148;
const HANDSHAKE_RESP_SZ: usize = 92;
const COOKIE_REPLY_SZ: usize = 64;
const DATA_OVERHEAD_SZ: usize = 32;

/// Bit to set in the second byte of the WG header to enable LWO
const OBFUSCATION_BIT: u8 = 0b10000000;

pub fn obfuscate(rng: &mut impl RngCore, packet: &mut [u8], key: &[u8; 32]) {
    let Some(header_bytes) = header_mut(packet, 0) else {
        return;
    };

    xor_bytes(header_bytes, key);

    // randomize byte and set MSB
    rng.fill_bytes(&mut header_bytes[1..2]);
    header_bytes[1] |= OBFUSCATION_BIT;
}

pub fn deobfuscate(packet: &mut [u8], key: &[u8; 32]) {
    let Some(header_bytes) = header_mut(packet, key[0]) else {
        return;
    };
    #[cfg(debug_assertions)]
    if !is_obfuscated(header_bytes[1]) {
        log::error!("Received non-obfuscated packet from relay");
        return;
    }

    xor_bytes(header_bytes, key);

    header_bytes[1] = 0;
}

#[cfg(debug_assertions)]
const fn is_obfuscated(reserved_byte: u8) -> bool {
    reserved_byte & OBFUSCATION_BIT != 0
}

fn header_mut(packet: &mut [u8], key_byte: u8) -> Option<&mut [u8]> {
    let &header_type = packet.first()?;
    match header_type ^ key_byte {
        HANDSHAKE_INIT => packet.get_mut(..HANDSHAKE_INIT_SZ),
        HANDSHAKE_RESP => packet.get_mut(..HANDSHAKE_RESP_SZ),
        COOKIE_REPLY => packet.get_mut(..COOKIE_REPLY_SZ),
        DATA => packet.get_mut(..DATA_OVERHEAD_SZ),
        _ => None,
    }
}

fn xor_bytes(data: &mut [u8], key: &[u8; 32]) {
    for (i, byte) in data.iter_mut().enumerate() {
        *byte ^= key[i % key.len()];
    }
}

/// Obfuscate a packet using a thread-local RNG.
///
/// This is a convenience function for callers that do not want to manage their own RNG.
pub fn obfuscate_thread_local(packet: &mut [u8], key: &[u8; 32]) {
    obfuscate(&mut rand::rng(), packet, key);
}

// --- Upstream unit tests for the pure functions (also vendored verbatim) ---
#[cfg(test)]
mod test {
    use super::*;

    struct FixedByteRng(u8);

    impl RngCore for FixedByteRng {
        fn next_u32(&mut self) -> u32 {
            u32::from(self.0)
        }

        fn next_u64(&mut self) -> u64 {
            u64::from(self.0)
        }

        fn fill_bytes(&mut self, dst: &mut [u8]) {
            dst.fill(self.0);
        }
    }

    fn fake_packet() -> Vec<u8> {
        let mut packet = vec![0u8; DATA_OVERHEAD_SZ + 100];
        packet[0] = DATA;
        rand::rng().fill_bytes(&mut packet[DATA_OVERHEAD_SZ..]);
        packet
    }

    #[test]
    fn test_obfuscation() {
        let key = [0xefu8; 32];
        let mut packet = fake_packet();
        let original_packet = packet.clone();

        let mut rng = &mut rand::rng();

        obfuscate(&mut rng, &mut packet, &key);
        assert_ne!(packet, original_packet);
        assert_eq!(
            packet[DATA_OVERHEAD_SZ..],
            original_packet[DATA_OVERHEAD_SZ..],
            "payload should be unchanged"
        );

        deobfuscate(&mut packet, &key);
        assert_eq!(packet, original_packet);
    }

    #[test]
    fn test_obfuscation_reserved_byte_uses_full_random_byte() {
        let key = [0xefu8; 32];
        let mut packet = fake_packet();

        obfuscate(&mut FixedByteRng(u8::MAX), &mut packet, &key);

        assert_eq!(packet[1], u8::MAX);
    }
}
