//! Command-line surface of the Scalar Commons node.
//!
//! Ported from `substrate/bin/node/cli/src/cli.rs` at tag `polkadot-stable2503`.
//!
//! Two things the reference carries are deliberately absent here:
//!
//! * `mixnet_params` — this runtime has no mixnet pallet, so there is nothing
//!   for the flag to configure.
//! * the `Inspect` subcommand — it pulls in `node-inspect` and only decodes
//!   blocks and extrinsics.
//!
//! `Benchmark` was also absent in Round 4, for a reason that no longer holds:
//! the runtime's `runtime-benchmarks` feature graph was incoherent. Round 5
//! completed it and Round 6 cleared the last error, so the subcommand is wired.
//!
//! Everything else is the reference's set, verbatim in shape.

/// An overarching CLI command definition.
#[derive(Debug, clap::Parser)]
pub struct Cli {
    /// Possible subcommand with parameters.
    #[command(subcommand)]
    pub subcommand: Option<Subcommand>,

    #[allow(missing_docs)]
    #[clap(flatten)]
    pub run: sc_cli::RunCmd,

    /// Disable automatic hardware benchmarks.
    ///
    /// By default these benchmarks are automatically ran at startup and measure
    /// the CPU speed, the memory bandwidth and the disk speed.
    ///
    /// The results are then printed out in the logs, and also sent as part of
    /// telemetry, if telemetry is enabled.
    #[arg(long)]
    pub no_hardware_benchmarks: bool,

    #[allow(missing_docs)]
    #[clap(flatten)]
    pub storage_monitor: sc_storage_monitor::StorageMonitorParams,
}

/// Possible subcommands of the main binary.
// The variants wrap upstream `sc_cli`/`frame_benchmarking_cli` command structs
// whose sizes we do not control, and `BenchmarkCmd` is much the largest. Boxing
// it would mean changing the clap-derived shape and every dispatch arm in
// `command.rs` — real code, for an enum that is constructed exactly once per
// process invocation. Not worth it here.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, clap::Subcommand)]
pub enum Subcommand {
    /// Sub-commands concerned with benchmarking.
    ///
    /// The pallet benchmarking moved to the `pallet` sub-command.
    #[command(subcommand)]
    Benchmark(frame_benchmarking_cli::BenchmarkCmd),

    /// Key management cli utilities
    #[command(subcommand)]
    Key(sc_cli::KeySubcommand),

    /// Verify a signature for a message, provided on STDIN, with a given (public or secret) key.
    Verify(sc_cli::VerifyCmd),

    /// Generate a seed that provides a vanity address.
    Vanity(sc_cli::VanityCmd),

    /// Sign a message, with a given (secret) key.
    Sign(sc_cli::SignCmd),

    /// Build a chain specification.
    BuildSpec(sc_cli::BuildSpecCmd),

    /// Validate blocks.
    CheckBlock(sc_cli::CheckBlockCmd),

    /// Export blocks.
    ExportBlocks(sc_cli::ExportBlocksCmd),

    /// Export the state of a given block into a chain spec.
    ExportState(sc_cli::ExportStateCmd),

    /// Import blocks.
    ImportBlocks(sc_cli::ImportBlocksCmd),

    /// Remove the whole chain.
    PurgeChain(sc_cli::PurgeChainCmd),

    /// Revert the chain to a previous state.
    Revert(sc_cli::RevertCmd),

    /// Db meta columns information.
    ChainInfo(sc_cli::ChainInfoCmd),
}
