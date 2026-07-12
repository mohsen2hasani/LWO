// SPDX-License-Identifier: GPL-3.0-or-later
//! A ~20-line stderr logger, so we don't pull in env_logger and its deps.
//! procd captures stderr and forwards it to the system log (logread).

use log::{LevelFilter, Metadata, Record};

struct StderrLogger {
    level: LevelFilter,
}

impl log::Log for StderrLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= self.level
    }

    fn log(&self, record: &Record) {
        if self.enabled(record.metadata()) {
            eprintln!("[{}] {}", record.level(), record.args());
        }
    }

    fn flush(&self) {}
}

pub fn init(level: LevelFilter) {
    let logger = Box::leak(Box::new(StderrLogger { level }));
    if log::set_logger(logger).is_ok() {
        log::set_max_level(level);
    }
}
