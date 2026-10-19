// Ported from `substrate/bin/node/cli/build.rs` at tag polkadot-stable2503.
//
// `generate_cargo_keys` is what makes `--version` report a real build: it emits
// the `SUBSTRATE_CLI_IMPL_VERSION` env var (package version + git commit hash)
// that `command.rs::impl_version` reads. Without it that `env!` fails to
// compile, so this build script is load-bearing, not decoration.
//
// The reference also generates clap shell-completion scripts here. That needs
// `clap_complete` and writes into the target dir; it is omitted because it is
// packaging convenience, not node function.
use substrate_build_script_utils::{generate_cargo_keys, rerun_if_git_head_changed};

fn main() {
    generate_cargo_keys();
    rerun_if_git_head_changed();
}
