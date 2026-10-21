//! Scalar Commons node.
//!
//! Sovereign Substrate chain for autonomous AI-agent coordination. This binary
//! executes `scalar-commons-runtime` under BABE authoring and GRANDPA finality.
//!
//! Ported from `substrate/bin/node/cli/bin/main.rs` at tag
//! `polkadot-stable2503`; all the wiring lives in the library next to it.

#![warn(missing_docs)]
// Same reason as the library root: `sc_cli::Error` is the SDK's type.
#![allow(clippy::result_large_err)]

fn main() -> sc_cli::Result<()> {
    scalar_node::run()
}
