//! Scalar Commons node library.
//!
//! Mirrors the reference layout (`substrate/bin/node/cli/src/lib.rs` at tag
//! `polkadot-stable2503`): the node is a library plus a thin binary, so that
//! `chain_spec` — including `mainnet_genesis_config`, which takes validator
//! keys and multisig accounts that cannot be defaulted and therefore has no
//! `--chain` id — stays a callable public API rather than dead code.

#![warn(missing_docs)]
// The service and command functions return `sc_service::Error`, the SDK's own
// error type (176 bytes at stable2606). Boxing it here would only diverge from the
// reference node for no gain on cold startup paths.
#![allow(clippy::result_large_err)]

pub mod chain_spec;
mod cli;
mod command;
pub mod rpc;
pub mod service;

pub use cli::*;
pub use command::*;
