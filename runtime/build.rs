//! Build script for the Scalar Commons runtime.
//!
//! Drives `substrate-wasm-builder`, which compiles this crate a second time for
//! the wasm target and writes `$OUT_DIR/wasm_binary.rs`. That generated file is
//! what `runtime/src/lib.rs` pulls in via `include!`, and it is the sole source
//! of the `WASM_BINARY` constant the node embeds as the genesis runtime blob.
//!
//! Without this, `WASM_BINARY` does not exist, no runtime blob is produced, and
//! the chain has nothing to execute — so this script is load-bearing, not
//! scaffolding.
//!
//! Follows the SDK's own convention at tag `polkadot-stable2503`
//! (`templates/solochain/runtime/build.rs`): the builder runs only for `std`
//! builds. When this crate is itself being compiled *for* wasm the script is a
//! no-op, which is what stops the builder from recursing into itself.

#[cfg(feature = "std")]
fn main() {
    substrate_wasm_builder::WasmBuilder::build_using_defaults();
}

/// The wasm builder is deactivated when compiling this crate for wasm, both to
/// avoid infinite recursion and to keep the inner build fast.
#[cfg(not(feature = "std"))]
fn main() {}
