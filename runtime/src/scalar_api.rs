//! # Scalar Commons custom runtime API
//!
//! The chain is coordination infrastructure: an agent deciding whether to
//! contract with a counterparty needs that counterparty's *economic standing*,
//! and it needs it without replaying chain state itself. Everything an agent
//! would otherwise have to reconstruct — stake, rank, oracle accuracy, era
//! volume, unclaimed emissions — is scattered across five pallets and two
//! accumulator formulas. This API is the read path that assembles it in one
//! call, so off-chain agents and the indexer share one authoritative view
//! rather than each deriving their own and disagreeing.
//!
//! Read-only by construction. Nothing here mints, moves, or reserves; the
//! supply cap and every guard live on the extrinsic side and are untouched by
//! this module.
//!
//! ## Naming
//!
//! This module is `scalar_api`, not `api`, because `impl_runtime_apis!`
//! generates a module named `api` in the crate root and the two would collide.
//! See the note at `lib.rs:8`.
//!
//! ## Emissions figures are advisory
//!
//! `pending_emissions` (both on [`AgentInfo`] and via
//! [`ScalarCommonsApi::get_pending_emissions`]) is computed from the reward
//! accumulator at the instant of the call and clamped to headroom remaining
//! under the supply cap. It is what the agent *would* receive claiming now, not
//! a reservation. It moves with every era settlement and is not a promise.

#![allow(clippy::too_many_arguments)]

use parity_scale_codec::{Codec, Decode, Encode};
use scale_info::TypeInfo;
use sp_runtime::RuntimeDebug;
use sp_std::vec::Vec;

/// Everything about one agent's economic standing, assembled across pallets.
///
/// Field types mirror the storage they are read from, so this struct stays
/// honest about precision: counters are `u32`, token amounts are `Balance`, and
/// the heartbeat block is `BlockNumber`.
///
/// Generic over `AccountId`/`Balance`/`BlockNumber` rather than fixed to the
/// runtime's concrete types so the declared API is reusable by clients that
/// only know the opaque forms.
#[derive(Clone, Encode, Decode, Eq, PartialEq, RuntimeDebug, TypeInfo)]
#[cfg_attr(feature = "std", derive(serde::Serialize, serde::Deserialize))]
pub struct AgentInfo<AccountId, Balance, BlockNumber> {
    /// Locked stake. Stake alone earns nothing — it is one factor of the
    /// emissions weight, never the whole of it.
    pub stake: Balance,
    /// Ranked-collective rank (0–3). `0` also covers "not a member", which is
    /// the correct reading: an unranked agent and a Rank 0 agent have the same
    /// standing.
    pub rank: u32,
    /// Lifetime completed escrow agreements. Drives rank promotion.
    pub completions: u32,
    /// Escrow volume in the current era. Reset on era drain.
    pub era_volume: Balance,
    /// Distinct counterparties this era — the anti-ring diversity signal. A
    /// high `era_volume` with `unique_buyers <= 1` is the ring-farming shape.
    pub unique_buyers: u32,
    /// Block of the agent's last heartbeat.
    pub last_heartbeat: BlockNumber,
    /// Emissions claimable at this instant. Advisory — see the module note.
    pub pending_emissions: Balance,
    /// Liveness multiplier derived from heartbeat recency.
    ///
    /// Narrowed from the `u128` the pallet computes, matching the cast at the
    /// call site in `lib.rs`. The multiplier is a small bounded factor, so the
    /// narrowing is not lossy in practice.
    pub heartbeat_multiplier: u32,
    /// Declared capability IDs, unbounded for transport.
    pub capabilities: Vec<u32>,
    /// Off-chain service endpoint. Empty when no metadata is set.
    pub uri: Vec<u8>,
    /// Human-readable display name. Empty when no metadata is set.
    pub name: Vec<u8>,
    /// Orchestrator this agent is a sub-agent of, if any.
    pub orchestrator: Option<AccountId>,
}

/// Chain-wide economic state for the current era.
///
/// The counters here are what an agent needs to reason about its own share:
/// `total_weight` is the denominator its individual weight competes against,
/// and the auto-param fields expose the live values the chain has adjusted to
/// in response to observed behaviour.
#[derive(Clone, Encode, Decode, Eq, PartialEq, RuntimeDebug, TypeInfo)]
#[cfg_attr(feature = "std", derive(serde::Serialize, serde::Deserialize))]
pub struct EraSnapshot<Balance> {
    /// Current era number.
    pub era_number: u32,
    /// Agents with any volume in the era preceding the last drain.
    pub active_agents: u32,
    /// Ring-suspect agents at the last drain: active, established, and with
    /// one counterparty or fewer.
    pub ring_count: u32,
    /// Sum of all agent weight snapshots — the denominator of each agent's
    /// emissions share.
    ///
    /// Deliberately `u128` and not `Balance`: this is a sum of the pallet's
    /// `u128` weight values, which are a scaled score, not a token amount.
    /// Typing it as `Balance` would imply it is denominated in CMN. It is not.
    pub total_weight: u128,
    /// CMN emitted in the last settled era.
    pub last_era_emission: Balance,
    /// Live completion fee in basis points (`BPS = 10_000`).
    pub completion_fee_bps: u32,
    /// Live governance-score weight in the emissions formula.
    pub alpha: u32,
    /// Live work-score weight in the emissions formula.
    pub beta: u32,
    /// Live floor in basis points for Full-rank agents.
    pub floor_bps: u32,
    /// Registered orchestrators.
    pub active_orchestrators: u32,
}

sp_api::decl_runtime_apis! {
    /// Read-only view over agent standing and era economics.
    ///
    /// Declared with `AccountId`/`Balance`/`BlockNumber` as trait generics;
    /// `decl_runtime_apis!` prepends the `Block` parameter itself, which is why
    /// the implementation in `lib.rs` names four arguments to this trait's
    /// three.
    pub trait ScalarCommonsApi<AccountId, Balance, BlockNumber>
    where
        AccountId: Codec,
        Balance: Codec,
        BlockNumber: Codec,
    {
        /// Full standing for one agent.
        ///
        /// `None` means the account holds no stake — it is not a registered
        /// agent. An agent with stake but no metadata returns `Some` with empty
        /// `uri`/`name`, which is a different state and is reported as such.
        fn get_agent_info(who: AccountId) -> Option<AgentInfo<AccountId, Balance, BlockNumber>>;

        /// Chain-wide era economics.
        fn get_era_metrics() -> EraSnapshot<Balance>;

        /// Oracle accuracy score for one agent on one capability.
        ///
        /// Split from [`Self::get_agent_info`] because scores are per
        /// capability: an agent has as many as it has capabilities, and
        /// callers typically want one.
        fn get_oracle_score(who: AccountId, capability: u32) -> u32;

        /// Claimable emissions for one agent. Advisory — see the module note.
        ///
        /// Also present on [`AgentInfo`]; exposed separately so a caller
        /// polling one number does not pay to assemble the whole struct.
        fn get_pending_emissions(who: AccountId) -> Balance;
    }
}
