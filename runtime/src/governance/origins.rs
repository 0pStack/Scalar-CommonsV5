//! Custom governance origins for Scalar Commons v3.
//!
//! Track 0: AgentsCollective — Rank 2+ agents propose/vote on bounded params
//! Track 1: GeneralAdmin    — majority stake governs network policy  
//! Track 2: Root            — structural changes, runtime upgrades

use crate::Runtime;
use frame_support::traits::EitherOf;
use frame_system::{EnsureRoot, EnsureRootWithSuccess};

/// Origin for Track 0: Ranked-collective members (Rank 2+).
/// Bounded parameter changes only.
pub type AgentsCollectiveOrigin = pallet_ranked_collective::EnsureRanked<Runtime, (), 2>;

/// Origin for Track 1: Standard staking-based governance.
pub type GeneralAdminOrigin = EnsureRoot<crate::AccountId>;

/// Either ranked-collective OR root — used for Track 0 proposals
/// so that sudo (pre day-90) can also execute urgent changes.
///
/// The root arm must yield the same `Success` type as the ranked arm for
/// `EitherOf` to compose. `EnsureRanked<_, _, 2>` succeeds with the caller's
/// rank (`u16`), so plain `EnsureRoot` (`Success = ()`) cannot pair with it.
/// `EnsureRootWithSuccess<_, MaxRank>` gives root the maximum representable
/// rank, which is the correct reading of "root outranks every agent" and
/// matches how the SDK composes root with ranked origins.
pub type AgentsOrRoot =
    EitherOf<AgentsCollectiveOrigin, EnsureRootWithSuccess<crate::AccountId, MaxRank>>;

frame_support::parameter_types! {
    /// Rank attributed to the root origin when it stands in for the collective.
    pub const MaxRank: u16 = u16::MAX;
}
