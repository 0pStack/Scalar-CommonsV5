//! Custom governance origins for Scalar Commons v3.
//!
//! Track 0: AgentsCollective — Rank 2+ agents propose/vote on bounded params
//!          (via the RankedPolls instance; see the note on `AgentsCollectiveOrigin`)
//! Track 1: GeneralAdmin    — majority stake governs network policy
//! Track 2: Root            — structural changes, runtime upgrades

use crate::Runtime;
use frame_system::EnsureRoot;

/// Membership check: the caller is ONE signed ranked-collective member at rank 2+.
///
/// This is not a collective decision. `EnsureRanked` passes for a single signer, and
/// rank 2 is granted automatically for one escrow completion plus 10 000 CMN of
/// stake. Never wire it to anything that dispatches as Root, cancels or kills a
/// referendum, or otherwise overrides a vote (#18 N2: it once gated
/// `pallet_whitelist` and `Referenda::CancelOrigin`, which made any rank-2 agent
/// Root). Collective powers need an origin produced by a RankedPolls outcome.
pub type AgentsCollectiveOrigin = pallet_ranked_collective::EnsureRanked<Runtime, (), 2>;

/// Origin for Track 1: Standard staking-based governance.
pub type GeneralAdminOrigin = EnsureRoot<crate::AccountId>;
