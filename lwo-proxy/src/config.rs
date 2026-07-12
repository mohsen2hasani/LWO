// SPDX-License-Identifier: GPL-3.0-or-later
//! Runtime configuration for the LWO proxy.
//!
//! Config is passed on the command line by the OpenWrt init script, which
//! translates the UCI `lwo` section into flags (see package/lwo-proxy/files).
//! Keeping this dependency-free (no clap, no base64 crate) keeps the binary
//! small for the router overlay.

use std::net::SocketAddr;
use std::time::Duration;

use log::LevelFilter;

pub const USAGE: &str = "\
Usage: lwo-proxy [OPTIONS]

Required:
      --server <IP:PORT>          Real (remote) Mullvad WireGuard endpoint
      --server-pubkey <BASE64>    Server/peer WireGuard public key (used to obfuscate outbound)
      --client-pubkey <BASE64>    Local interface WireGuard public key (used to deobfuscate inbound)

Optional:
      --listen <IP:PORT>          Local address WireGuard sends to  [default: 127.0.0.1:51820]
      --fwmark <MARK>             fwmark for the outbound socket (decimal or 0x-hex, Linux only)
      --no-reconnect              Exit instead of retrying when the proxy stops
      --reconnect-delay <SECS>    Seconds to wait between reconnect attempts  [default: 3]
      --log-level <LEVEL>         error|warn|info|debug|trace  [default: info]
  -h, --help                      Print this help
";

#[derive(Debug, Clone)]
pub struct Config {
    /// Local address WireGuard points its peer endpoint at (loopback).
    pub listen_addr: SocketAddr,
    /// The real remote WireGuard/LWO server.
    pub server_addr: SocketAddr,
    /// Key used to `obfuscate` CLIENT -> SERVER traffic (Mullvad `tx_key`).
    pub server_pubkey: [u8; 32],
    /// Key used to `deobfuscate` SERVER -> CLIENT traffic (Mullvad `rx_key`).
    pub client_pubkey: [u8; 32],
    /// Optional fwmark on the outbound socket (Linux only).
    pub fwmark: Option<u32>,
    /// Restart the proxy automatically when it stops.
    pub auto_reconnect: bool,
    /// Delay between reconnect attempts.
    pub reconnect_delay: Duration,
    /// Log verbosity.
    pub log_level: LevelFilter,
}

impl Config {
    pub fn from_args(args: impl IntoIterator<Item = String>) -> Result<Config, String> {
        let mut args = args.into_iter();
        let _prog = args.next();

        let mut listen: Option<SocketAddr> = None;
        let mut server: Option<SocketAddr> = None;
        let mut server_pubkey: Option<[u8; 32]> = None;
        let mut client_pubkey: Option<[u8; 32]> = None;
        let mut fwmark: Option<u32> = None;
        let mut auto_reconnect = true;
        let mut reconnect_delay = Duration::from_secs(3);
        let mut log_level = LevelFilter::Info;

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--listen" => listen = Some(parse_addr("--listen", &next(&mut args, "--listen")?)?),
                "--server" => server = Some(parse_addr("--server", &next(&mut args, "--server")?)?),
                "--server-pubkey" => {
                    server_pubkey = Some(decode_key(&next(&mut args, "--server-pubkey")?)?)
                }
                "--client-pubkey" => {
                    client_pubkey = Some(decode_key(&next(&mut args, "--client-pubkey")?)?)
                }
                "--fwmark" => fwmark = Some(parse_fwmark(&next(&mut args, "--fwmark")?)?),
                "--no-reconnect" => auto_reconnect = false,
                "--reconnect-delay" => {
                    let secs: u64 = next(&mut args, "--reconnect-delay")?
                        .parse()
                        .map_err(|_| "invalid --reconnect-delay (expected seconds)".to_string())?;
                    reconnect_delay = Duration::from_secs(secs);
                }
                "--log-level" => log_level = parse_level(&next(&mut args, "--log-level")?)?,
                "-h" | "--help" => return Err("__help__".to_string()),
                other => return Err(format!("unknown argument: {other}")),
            }
        }

        Ok(Config {
            listen_addr: listen.unwrap_or_else(|| "127.0.0.1:51820".parse().unwrap()),
            server_addr: server.ok_or("missing required --server")?,
            server_pubkey: server_pubkey.ok_or("missing required --server-pubkey")?,
            client_pubkey: client_pubkey.ok_or("missing required --client-pubkey")?,
            fwmark,
            auto_reconnect,
            reconnect_delay,
            log_level,
        })
    }
}

fn next(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("{flag} requires a value"))
}

fn parse_addr(flag: &str, value: &str) -> Result<SocketAddr, String> {
    value
        .parse()
        .map_err(|_| format!("invalid {flag} value {value:?} (expected IP:PORT)"))
}

fn parse_level(value: &str) -> Result<LevelFilter, String> {
    match value.to_ascii_lowercase().as_str() {
        "off" => Ok(LevelFilter::Off),
        "error" => Ok(LevelFilter::Error),
        "warn" => Ok(LevelFilter::Warn),
        "info" => Ok(LevelFilter::Info),
        "debug" => Ok(LevelFilter::Debug),
        "trace" => Ok(LevelFilter::Trace),
        other => Err(format!("invalid --log-level {other:?}")),
    }
}

fn parse_fwmark(value: &str) -> Result<u32, String> {
    let parsed = if let Some(hex) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        u32::from_str_radix(hex, 16)
    } else {
        value.parse::<u32>()
    };
    parsed.map_err(|_| format!("invalid --fwmark {value:?} (expected decimal or 0x-hex)"))
}

/// Decode a standard base64 WireGuard public key into 32 raw bytes.
///
/// WireGuard keys use the standard base64 alphabet with `=` padding (44 chars).
/// The 32 raw bytes are what `lwo_core::{obfuscate,deobfuscate}` use as XOR
/// masks — no elliptic-curve math is ever performed on them.
pub fn decode_key(s: &str) -> Result<[u8; 32], String> {
    let bytes = base64_decode(s.trim())?;
    if bytes.len() != 32 {
        return Err(format!(
            "invalid WireGuard key: decoded to {} bytes, expected 32",
            bytes.len()
        ));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

/// Minimal standard-alphabet base64 decoder (dependency-free).
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;

    for &c in input.as_bytes() {
        let val: u8 = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break, // padding: nothing meaningful follows
            b'\r' | b'\n' | b' ' | b'\t' => continue,
            _ => return Err(format!("invalid base64 character: {:?}", c as char)),
        };
        buf = (buf << 6) | u32::from(val);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn base64_known_vectors() {
        assert_eq!(base64_decode("TWFu").unwrap(), b"Man");
        assert_eq!(base64_decode("TWE=").unwrap(), b"Ma");
        assert_eq!(base64_decode("TQ==").unwrap(), b"M");
        assert_eq!(base64_decode("").unwrap(), b"");
    }

    #[test]
    fn decode_wireguard_keys() {
        // Test vectors taken from Mullvad's tunnel-obfuscation lwo.rs e2e test.
        let client = decode_key("8Ka2l4T0tVrSR5pkcsvRG++mBlxfuf8XOxpqBkOCikU=").unwrap();
        let server = decode_key("4EkA4c160oQgN/YaNR9GN3gLMevXEfx5hnlc9jYmw14=").unwrap();
        assert_eq!(client.len(), 32);
        assert_eq!(server.len(), 32);
        assert_ne!(client, server);
    }

    #[test]
    fn rejects_wrong_length_key() {
        assert!(decode_key("TWFu").is_err());
    }

    #[test]
    fn parse_fwmark_forms() {
        assert_eq!(parse_fwmark("0x51820").unwrap(), 0x51820);
        assert_eq!(parse_fwmark("51820").unwrap(), 51820);
        assert!(parse_fwmark("nope").is_err());
    }
}
