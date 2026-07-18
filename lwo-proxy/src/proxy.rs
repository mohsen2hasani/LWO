// SPDX-License-Identifier: GPL-3.0-or-later
//! Minimal async UDP proxy that applies Mullvad LWO to WireGuard traffic.
//!
//! Data flow (see docs/02-architecture.md):
//!
//!   kernel WireGuard --(plain WG/UDP, loopback)--> client_socket
//!        client_socket --obfuscate(server_pubkey)--> remote_socket --> server
//!        server --> remote_socket --deobfuscate(client_pubkey)--> client_socket
//!   client_socket --(plain WG/UDP, loopback)--> kernel WireGuard
//!
//! The design mirrors Mullvad's tunnel-obfuscation/src/lwo.rs `Client`, with two
//! deliberate differences for OpenWrt (see docs/02-architecture.md §4):
//!   * a FIXED local listen port (from UCI) instead of an ephemeral one, and
//!   * an explicit split into `bind()` + `serve()` so the supervisor can retry.

use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;

use tokio::net::UdpSocket;

use crate::config::Config;
use crate::lwo_core::{deobfuscate, obfuscate_thread_local};

/// Largest possible UDP datagram; matches Mullvad's MAX_UDP_SIZE.
const MAX_UDP_SIZE: usize = u16::MAX as usize;

/// A bound-but-not-yet-serving proxy. Split out so the supervisor can learn the
/// local address (useful for tests/logging) before entering the forwarding loop.
pub struct Proxy {
    client_socket: Arc<UdpSocket>,
    remote_socket: Arc<UdpSocket>,
    local_addr: SocketAddr,
    /// obfuscate key for client -> server (Mullvad `tx_key` = server public key).
    tx_key: [u8; 32],
    /// deobfuscate key for server -> client (Mullvad `rx_key` = client public key).
    rx_key: [u8; 32],
}

impl Proxy {
    /// Bind the local (loopback) and remote sockets and connect the remote to
    /// the server. Does not yet forward traffic.
    pub async fn bind(cfg: &Config) -> io::Result<Proxy> {
        let client_socket = Arc::new(UdpSocket::bind(cfg.listen_addr).await?);
        let local_addr = client_socket.local_addr()?;

        let remote_socket =
            Arc::new(create_remote_socket(cfg.server_addr.is_ipv4(), cfg.fwmark).await?);
        remote_socket.connect(cfg.server_addr).await?;

        // Enlarge socket buffers so bursts on high-latency links aren't dropped.
        tune_buffers(&client_socket);
        tune_buffers(&remote_socket);

        Ok(Proxy {
            client_socket,
            remote_socket,
            local_addr,
            tx_key: cfg.server_pubkey,
            rx_key: cfg.client_pubkey,
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Run the forwarding loop until one direction fails (e.g. the WireGuard
    /// peer restarts). Returns the error that stopped it so the supervisor can
    /// reconnect. Like Mullvad, we `peek_sender()` to discover which local port
    /// the kernel WireGuard interface is sending from, then `connect()` to it.
    pub async fn serve(self) -> io::Result<()> {
        let wg_addr = self.client_socket.peek_sender().await?;
        self.client_socket.connect(wg_addr).await?;
        log::info!(
            "LWO active: WireGuard {} <-> {} <-> server (obfuscated)",
            wg_addr,
            self.local_addr,
        );

        let tx_key = self.tx_key;
        let outbound = {
            let read = self.client_socket.clone();
            let write = self.remote_socket.clone();
            tokio::spawn(async move {
                forward(read, write, move |pkt| obfuscate_thread_local(pkt, &tx_key)).await
            })
        };

        let rx_key = self.rx_key;
        let inbound = {
            let read = self.remote_socket.clone();
            let write = self.client_socket.clone();
            tokio::spawn(
                async move { forward(read, write, move |pkt| deobfuscate(pkt, &rx_key)).await },
            )
        };

        // Whichever direction dies first ends the session; abort the other so we
        // don't leak a detached task across reconnects.
        let mut outbound = outbound;
        let mut inbound = inbound;
        let result = tokio::select! {
            r = &mut outbound => r,
            r = &mut inbound => r,
        };
        outbound.abort();
        inbound.abort();

        Err(match result {
            Ok(err) => err,
            Err(join_err) => io::Error::other(format!("forwarding task failed: {join_err}")),
        })
    }
}

/// Read datagrams from `read`, transform them in place, and send on `write`.
/// Returns the first I/O error encountered (the loop never ends otherwise).
async fn forward(
    read: Arc<UdpSocket>,
    write: Arc<UdpSocket>,
    mut transform: impl FnMut(&mut [u8]),
) -> io::Error {
    let mut buf = vec![0u8; MAX_UDP_SIZE];
    loop {
        let n = match read.recv(&mut buf).await {
            Ok(n) => n,
            Err(err) => return err,
        };
        transform(&mut buf[..n]);
        if let Err(err) = write.send(&buf[..n]).await {
            return err;
        }
    }
}

/// Bind the outbound socket to a wildcard address and, on Linux, set its fwmark
/// so its packets bypass the VPN routing table. Mirrors Mullvad's
/// tunnel-obfuscation/src/socket.rs `create_remote_socket`.
async fn create_remote_socket(ipv4: bool, fwmark: Option<u32>) -> io::Result<UdpSocket> {
    let bind_addr: SocketAddr = if ipv4 {
        (Ipv4Addr::UNSPECIFIED, 0).into()
    } else {
        (Ipv6Addr::UNSPECIFIED, 0).into()
    };
    let socket = UdpSocket::bind(bind_addr).await?;

    #[cfg(target_os = "linux")]
    if let Some(mark) = fwmark {
        use nix::sys::socket::{setsockopt, sockopt};
        setsockopt(&socket, sockopt::Mark, &mark)
            .map_err(|e| io::Error::other(format!("failed to set fwmark: {e}")))?;
        log::debug!("set fwmark {mark:#x} on outbound socket");
    }
    #[cfg(not(target_os = "linux"))]
    if fwmark.is_some() {
        log::warn!("fwmark is only supported on Linux; ignoring");
    }

    Ok(socket)
}

/// Enlarge a UDP socket's send/receive buffers (best-effort). Default buffers can
/// drop bursts on high-latency links, which makes TCP back off and caps throughput.
/// `SO_*BUFFORCE` bypasses the net.core.rmem_max/wmem_max ceilings (the daemon runs
/// as root under procd); if that isn't permitted we fall back to the capped `SO_*BUF`.
#[cfg(target_os = "linux")]
fn tune_buffers(sock: &UdpSocket) {
    use nix::sys::socket::{setsockopt, sockopt};
    const SZ: usize = 4 * 1024 * 1024;
    if setsockopt(sock, sockopt::RcvBufForce, &SZ).is_err() {
        let _ = setsockopt(sock, sockopt::RcvBuf, &SZ);
    }
    if setsockopt(sock, sockopt::SndBufForce, &SZ).is_err() {
        let _ = setsockopt(sock, sockopt::SndBuf, &SZ);
    }
}

#[cfg(not(target_os = "linux"))]
fn tune_buffers(_sock: &UdpSocket) {}
