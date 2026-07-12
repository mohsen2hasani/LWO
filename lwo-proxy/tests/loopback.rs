// SPDX-License-Identifier: GPL-3.0-or-later
//! End-to-end loopback test for the LWO proxy.
//!
//! Mirrors Mullvad's tunnel-obfuscation lwo.rs `test_e2e_obfuscation`, but drives
//! *our* `Proxy` and uses raw `[u8; 32]` keys via `config::decode_key`. It proves:
//!   * client -> server packets are obfuscated with the SERVER key, and
//!   * server -> client packets are deobfuscated with the CLIENT key,
//!
//! i.e. the key-direction invariant from docs/01-research-mullvad-lwo.md §2.2.

use std::time::Duration;

use log::LevelFilter;
use lwo_proxy::config::{decode_key, Config};
use lwo_proxy::lwo_core::{deobfuscate, obfuscate};
use lwo_proxy::proxy::Proxy;
use tokio::net::UdpSocket;

fn data_packet() -> Vec<u8> {
    // WG DATA message type in byte 0, then 32-byte header + payload.
    let mut packet = vec![0u8; 32 + 100];
    packet[0] = 4; // DATA
    for (i, b) in packet[32..].iter_mut().enumerate() {
        *b = (i as u8).wrapping_mul(37).wrapping_add(3);
    }
    packet
}

#[tokio::test]
async fn loopback_roundtrip_respects_key_direction() {
    // Test-vector keys from Mullvad's lwo.rs e2e test.
    let client_pubkey = decode_key("8Ka2l4T0tVrSR5pkcsvRG++mBlxfuf8XOxpqBkOCikU=").unwrap();
    let server_pubkey = decode_key("4EkA4c160oQgN/YaNR9GN3gLMevXEfx5hnlc9jYmw14=").unwrap();

    // Fake remote "server".
    let server = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let server_addr = server.local_addr().unwrap();

    let cfg = Config {
        listen_addr: "127.0.0.1:0".parse().unwrap(), // ephemeral for the test
        server_addr,
        server_pubkey,
        client_pubkey,
        fwmark: None,
        auto_reconnect: false,
        reconnect_delay: Duration::from_secs(1),
        log_level: LevelFilter::Off,
    };

    let proxy = Proxy::bind(&cfg).await.unwrap();
    let proxy_addr = proxy.local_addr();
    tokio::spawn(proxy.serve());

    // Fake kernel WireGuard.
    let wg = UdpSocket::bind("127.0.0.1:0").await.unwrap();

    // --- client -> server ---
    let sent = data_packet();
    wg.send_to(&sent, proxy_addr).await.unwrap();

    let mut buf = vec![0u8; 1500];
    let (n, from) = server.recv_from(&mut buf).await.unwrap();
    assert_ne!(&buf[..n], &sent[..], "packet must arrive obfuscated");

    // The server side deobfuscates outbound traffic with the SERVER key.
    deobfuscate(&mut buf[..n], &server_pubkey);
    assert_eq!(
        &buf[..n],
        &sent[..],
        "deobfuscated packet must match original"
    );

    // --- server -> client ---
    let reply = {
        let mut p = data_packet();
        p[40] = 0xAA; // make it distinct
        p
    };
    let mut obfuscated = reply.clone();
    // The server side obfuscates inbound traffic with the CLIENT key.
    obfuscate(&mut rand::rng(), &mut obfuscated, &client_pubkey);
    server.send_to(&obfuscated, from).await.unwrap();

    let (n2, _) = wg.recv_from(&mut buf).await.unwrap();
    assert_eq!(
        &buf[..n2],
        &reply[..],
        "client must receive deobfuscated reply"
    );
}
