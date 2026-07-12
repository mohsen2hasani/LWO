// SPDX-License-Identifier: GPL-3.0-or-later
//! lwo-proxy: a standalone Mullvad LWO transport proxy for OpenWrt.
//!
//! See docs/ for the design. The obfuscation protocol itself lives in
//! [`lwo_core`] and is vendored verbatim from Mullvad (GPL-3.0).

pub mod config;
pub mod logger;
pub mod lwo_core;
pub mod proxy;
