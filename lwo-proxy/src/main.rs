// SPDX-License-Identifier: GPL-3.0-or-later
//! Entry point for the LWO proxy daemon.
//!
//! Reads config from the command line (the OpenWrt init script builds the flags
//! from UCI), then supervises the proxy: it keeps WireGuard's transport
//! obfuscated and reconnects if a direction drops, until it receives SIGTERM or
//! SIGINT from procd.

use std::process::ExitCode;

use lwo_proxy::config::{Config, USAGE};
use lwo_proxy::logger;
use lwo_proxy::proxy::Proxy;

fn main() -> ExitCode {
    let cfg = match Config::from_args(std::env::args()) {
        Ok(cfg) => cfg,
        Err(msg) if msg == "__help__" => {
            print!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(msg) => {
            eprintln!("lwo-proxy: {msg}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };

    logger::init(cfg.log_level);

    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            log::error!("failed to build async runtime: {err}");
            return ExitCode::FAILURE;
        }
    };

    runtime.block_on(run(cfg))
}

async fn run(cfg: Config) -> ExitCode {
    use tokio::signal::unix::{signal, SignalKind};

    let mut sigterm = match signal(SignalKind::terminate()) {
        Ok(s) => s,
        Err(err) => {
            log::error!("failed to install SIGTERM handler: {err}");
            return ExitCode::FAILURE;
        }
    };
    let mut sigint = match signal(SignalKind::interrupt()) {
        Ok(s) => s,
        Err(err) => {
            log::error!("failed to install SIGINT handler: {err}");
            return ExitCode::FAILURE;
        }
    };

    log::info!(
        "lwo-proxy starting: listen {} -> server {}",
        cfg.listen_addr,
        cfg.server_addr
    );

    tokio::select! {
        _ = supervise(&cfg) => ExitCode::SUCCESS,
        _ = sigterm.recv() => {
            log::info!("received SIGTERM, shutting down");
            ExitCode::SUCCESS
        }
        _ = sigint.recv() => {
            log::info!("received SIGINT, shutting down");
            ExitCode::SUCCESS
        }
    }
}

/// Bind + serve the proxy, retrying on failure when auto_reconnect is set.
async fn supervise(cfg: &Config) {
    loop {
        match Proxy::bind(cfg).await {
            Ok(proxy) => {
                log::info!(
                    "bound; waiting for WireGuard traffic on {}",
                    proxy.local_addr()
                );
                match proxy.serve().await {
                    Ok(()) => log::info!("proxy stopped"),
                    Err(err) => log::warn!("proxy stopped: {err}"),
                }
            }
            Err(err) => log::warn!("failed to start proxy: {err}"),
        }

        if !cfg.auto_reconnect {
            log::info!("auto_reconnect disabled; exiting");
            return;
        }
        log::info!("reconnecting in {:?}", cfg.reconnect_delay);
        tokio::time::sleep(cfg.reconnect_delay).await;
    }
}
