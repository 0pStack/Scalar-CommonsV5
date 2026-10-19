//! # pallet-agents v3.0
//!
//! ## Responsibilities (Milestone 1 scope)
//! - Agent registration: stake locking, fee burn, rate limiting
//! - Work volume tracking: per-era escrow volume + buyer diversity (anti-ring)
//! - Era snapshots: ring_count + active_count before drain (fed to auto-params)
//! - Rank promotion triggers: calls into pallet-ranked-collective
//! - Cross-pallet hooks: OnAgentRegistered, ActiveEscrowCount management
//!
//! ## NOT in this pallet (handled by standard pallets)
//! - Tiers/ranks   → pallet-ranked-collective
//! - Governance    → pallet-referenda + pallet-conviction-voting
//! - Floor pay     → pallet-salary (per rank)
//! - Heartbeat     → pallet-im-online + LastHeartbeat in this pallet
//! - Succession    → v3.1 feature (ink! contract)

#![cfg_attr(not(feature = "std"), no_std)]
pub use pallet::*;

#[cfg(test)]
mod tests;

#[cfg(feature = "runtime-benchmarks")]
pub mod benchmarks;

/// Weight functions needed by pallet-agents.
/// Replaced by benchmarked weights from pallets/agents/src/weights.rs before mainnet.
pub trait WeightInfo {
    fn register() -> Weight;
    fn add_stake() -> Weight;
    fn request_unstake() -> Weight;
    fn complete_unstake() -> Weight;
    fn heartbeat() -> Weight;
    fn record_gov_vote() -> Weight;
    fn update_metadata() -> Weight;
    fn set_capability() -> Weight;
    fn delegate_voting() -> Weight;
}
/// Placeholder weights returning zero — replaced by benchmark output before mainnet.
pub struct PlaceholderWeights;
impl WeightInfo for PlaceholderWeights {
    fn register() -> Weight {
        Weight::from_parts(200_000_000, 0)
    }
    fn add_stake() -> Weight {
        Weight::from_parts(80_000_000, 0)
    }
    fn request_unstake() -> Weight {
        Weight::from_parts(60_000_000, 0)
    }
    fn complete_unstake() -> Weight {
        Weight::from_parts(90_000_000, 0)
    }
    fn heartbeat() -> Weight {
        Weight::from_parts(40_000_000, 0)
    }
    fn record_gov_vote() -> Weight {
        Weight::from_parts(35_000_000, 0)
    }
    fn update_metadata() -> Weight {
        Weight::from_parts(50_000_000, 0)
    }
    fn set_capability() -> Weight {
        Weight::from_parts(60_000_000, 0)
    }
    fn delegate_voting() -> Weight {
        Weight::from_parts(40_000_000, 0)
    }
}

use frame_support::weights::Weight;
#[frame_support::pallet]
pub mod pallet {
    use frame_support::{
        pallet_prelude::*,
        traits::{
            Currency, ExistenceRequirement, Imbalance, LockIdentifier, LockableCurrency,
            OnUnbalanced, ReservableCurrency, WithdrawReasons,
        },
    };
    use frame_system::pallet_prelude::*;
    use sp_runtime::traits::{Saturating, Zero};
    use sp_std::vec::Vec;

    // ─── Lock identifier ─────────────────────────────────────────────────────
    /// Most appeals one account may hold open at once. A pallet constant, not a `Config` type,
    /// so raising it is a code change reviewed like any other economic parameter.
    pub const MAX_OPEN_APPEALS: u32 = 5;

    pub const AGENT_LOCK_ID: LockIdentifier = *b"agntlock";

    // ─── Balance type alias ──────────────────────────────────────────────────
    pub type BalanceOf<T> =
        <<T as Config>::Currency as Currency<<T as frame_system::Config>::AccountId>>::Balance;

    // ─── Cross-pallet hook traits ────────────────────────────────────────────

    /// Called by emissions pallet to initialise reward debt when a new agent registers.
    /// Without this, a new agent could claim all prior-era emissions immediately.
    pub trait OnAgentRegistered<AccountId> {
        fn on_registered(who: &AccountId);
    }
    impl<AccountId> OnAgentRegistered<AccountId> for () {
        fn on_registered(_: &AccountId) {}
    }

    /// Called by agents pallet execute_slash after funds are withdrawn.
    /// Emissions implements this to zero AgentWeightSnapshot, preventing one-era overclaim
    /// where the old (pre-slash) weight snapshot would be used in do_claim().
    pub trait OnAgentSlashed<AccountId> {
        fn on_slashed(who: &AccountId);
    }
    impl<AccountId> OnAgentSlashed<AccountId> for () {
        fn on_slashed(_: &AccountId) {}
    }

    /// Called by agents pallet BEFORE stake changes (add_stake).
    /// Emissions implements this to zero AgentWeightSnapshot so the agent
    /// cannot overclaim prior-era emissions using their new higher weight.
    ///
    /// The MasterChef accumulator pattern assumes weight is constant between
    /// settlements. When stake increases between eras, the pending amount
    /// would be multiplied by the new weight, overclaiming prior-era rewards.
    /// Zeroing the snapshot on stake change means the agent forfeits unclaimed
    /// rewards from the previous era — a conservative (under-pays) choice that
    /// closes the exploit.
    pub trait OnStakeChanged<AccountId> {
        fn on_stake_changed(who: &AccountId);
    }
    impl<AccountId> OnStakeChanged<AccountId> for () {
        fn on_stake_changed(_: &AccountId) {}
    }

    /// Called by agents pallet to promote/query agent rank in ranked-collective.
    pub trait AgentCollective<AccountId> {
        fn induct(who: &AccountId) -> DispatchResult;
        fn promote(who: &AccountId) -> DispatchResult;
        fn rank_of(who: &AccountId) -> Option<u32>;
        /// Remove agent from collective on deregistration. No-op if not a member.
        fn remove(who: &AccountId);
    }
    impl<AccountId> AgentCollective<AccountId> for () {
        fn induct(_: &AccountId) -> DispatchResult {
            Ok(())
        }
        fn promote(_: &AccountId) -> DispatchResult {
            Ok(())
        }
        fn rank_of(_: &AccountId) -> Option<u32> {
            Some(0)
        }
        fn remove(_: &AccountId) {}
    }

    /// Oracle score provider — lets emissions read oracle accuracy without circular dep.
    pub trait OracleScoreGate<AccountId> {
        /// Returns 0–10,000. 0 means no oracle history.
        fn best_score(who: &AccountId) -> u32;
    }
    impl<AccountId> OracleScoreGate<AccountId> for () {
        fn best_score(_: &AccountId) -> u32 {
            0
        }
    }

    /// Cross-pallet: verifies that an agent holds a vote on ONE SPECIFIC poll that
    /// is STILL ONGOING, before credit is given via record_gov_vote().
    ///
    /// ROUND14 (was `is_actively_voting(who) -> bool`): the previous shape asked only
    /// "does this account hold any non-empty vote anywhere?". Votes leave
    /// `pallet_conviction_voting::VotingFor` only via an explicit `remove_vote()` —
    /// poll conclusion never prunes them — so a single vote cast once satisfied the
    /// old predicate forever, and because the answer was a bare `bool` with no
    /// referendum attached, the same stale vote could be redeemed for the full
    /// `MaxProposalsPerEra` credits every era, in perpetuity, at zero capital cost
    /// (`try_vote` enforces no minimum vote balance or conviction).
    ///
    /// Binding the question to a `poll_index` is what makes governance credit
    /// *derived* rather than *self-attested*: the caller must name the referendum,
    /// the verifier confirms the vote exists on that poll AND that the poll is still
    /// ongoing, and `EraGovVotedPolls` ensures each referendum pays at most once per
    /// era. Credit therefore equals the number of distinct live referenda the agent
    /// actually voted on this era — which is what the emissions thesis
    /// ("reward verifiable work, not raw stake") assumed it already measured.
    ///
    /// The runtime implements this over `pallet_conviction_voting::VotingFor` plus
    /// `Polling::as_ongoing` on `pallet_referenda`, keeping pallet_agents free of
    /// both dependencies.
    ///
    /// Deliberately no blanket `()` impl: the old one returned `true` unconditionally
    /// and was wired into all six test mocks, which is why this guard shipped with
    /// zero behavioural coverage. Mocks must now state their own policy.
    pub trait GovVoteVerifier<AccountId> {
        /// True iff `who` holds a vote on `poll_index` AND that poll is still ongoing.
        fn has_live_vote_on(who: &AccountId, poll_index: u32) -> bool;
    }

    /// Cross-pallet: writes capability registration to pallet-identity additional fields.
    /// Called by agents::set_capability() to persist capability state.
    pub trait IdentityHandler<AccountId> {
        /// Returns true if agent has a registered identity record.
        fn has_identity(who: &AccountId) -> bool;
        /// Sets or clears a capability field in the agent's identity.
        /// capability_id maps to a deterministic field key (b"cap:NNNN").
        fn set_capability(
            who: &AccountId,
            capability_id: u32,
            active: bool,
        ) -> frame_support::pallet_prelude::DispatchResult;
        /// Returns true if agent has this capability active.
        fn agent_has_capability(who: &AccountId, capability_id: u32) -> bool;
    }
    /// No-op implementation for test environments (identity not required in mock).
    impl<AccountId> IdentityHandler<AccountId> for () {
        fn has_identity(_: &AccountId) -> bool {
            true
        } // permissive in tests
        fn set_capability(
            _: &AccountId,
            _: u32,
            _: bool,
        ) -> frame_support::pallet_prelude::DispatchResult {
            Ok(())
        }
        fn agent_has_capability(_: &AccountId, _: u32) -> bool {
            true
        }
    }

    /// Called by pallet-orchestrator to credit volume on the orchestrator side.
    pub trait OrchestratorLookup<AccountId, Balance> {
        /// Returns the orchestrator linked to this sub-agent, if any.
        fn get_orchestrator(sub_agent: &AccountId) -> Option<AccountId>;
        /// Credits volume to the orchestrator's era accumulator.
        fn add_orchestrator_volume(orchestrator: &AccountId, amount: Balance);
    }
    impl<AccountId, Balance> OrchestratorLookup<AccountId, Balance> for () {
        fn get_orchestrator(_: &AccountId) -> Option<AccountId> {
            None
        }
        fn add_orchestrator_volume(_: &AccountId, _: Balance) {}
    }

    // ─── Pure math ───────────────────────────────────────────────────────────

    /// Integer square root — `floor(sqrt(n))`, correct for every `u128`.
    /// weight ∝ √stake so 100× stake → 10× weight (not 100×) — anti-whale.
    ///
    /// Economic note: this is the anti-whale curve feeding emission weight, so a
    /// *silently wrong* answer is worse than a loud one. The previous Newton
    /// implementation seeded with `(n + 1) / 2`, which overflows at
    /// `n == u128::MAX`: a debug panic, but in the release WASM it wrapped to 0
    /// and the loop then returned a wrong root for the largest stake possible.
    /// `u128::isqrt` (core, stable since 1.84) is exact over the entire domain
    /// and uses no user-level arithmetic at all, so CLAUDE.md's "no bare
    /// `+ - *` on balance math" rule cannot be violated here by construction.
    ///
    /// The curve itself is unchanged: `isqrt` and the old Newton iteration agree
    /// on every input the old code did not overflow on (verified differentially
    /// over the small range exhaustively, all powers-of-two/perfect-square
    /// neighbourhoods, and a 2M-value pseudo-random sweep).
    pub fn integer_sqrt(n: u128) -> u128 {
        n.isqrt()
    }

    // ─── Config ──────────────────────────────────────────────────────────────
    #[pallet::config]
    pub trait Config: frame_system::Config {
        type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;

        type Currency: LockableCurrency<Self::AccountId, Moment = BlockNumberFor<Self>>
            + ReservableCurrency<Self::AccountId>;

        /// Minimum stake to register (Basic tier).
        #[pallet::constant]
        type MinStake: Get<BalanceOf<Self>>;

        /// Stake threshold for Full agent rank (rank → 2).
        #[pallet::constant]
        type FullFloorStake: Get<BalanceOf<Self>>;

        /// Maximum stake per agent (anti-concentration).
        #[pallet::constant]
        type MaxStakePerAgent: Get<BalanceOf<Self>>;

        /// Cooldown blocks after request_unstake() before complete_unstake().
        #[pallet::constant]
        type UnstakeCooldown: Get<BlockNumberFor<Self>>;

        /// Base registration fee (burned on every registration).
        #[pallet::constant]
        type BaseRegistrationFee: Get<BalanceOf<Self>>;

        /// Max new registrations per block (flash-flood protection).
        #[pallet::constant]
        type MaxRegistrationsPerBlock: Get<u32>;

        /// Hard cap on total registered agents.
        #[pallet::constant]
        type MaxAgents: Get<u32>;

        /// Minimum completions required to reach Rank 3.
        #[pallet::constant]
        type Rank3MinCompletions: Get<u32>;

        /// Minimum oracle score to reach Rank 3 (0 = disabled).
        #[pallet::constant]
        type MinRank3OracleScore: Get<u32>;

        /// Blocks since first stake before Rank 3 is achievable.
        #[pallet::constant]
        type Rank3SpanGate: Get<BlockNumberFor<Self>>;

        /// Stake × this ratio = diversity credit cap (0 = disabled).
        #[pallet::constant]
        type MaxVolToStakeRatio: Get<u32>;

        /// Grace period (blocks) before heartbeat decay begins.
        #[pallet::constant]
        type HeartbeatGracePeriod: Get<BlockNumberFor<Self>>;

        /// Decay period (blocks): floor falls from 100% to 10% over this span.
        #[pallet::constant]
        type HeartbeatDecayPeriod: Get<BlockNumberFor<Self>>;

        /// Hook: called when agent registers. Initialises emission debt.
        type OnAgentRegistered: OnAgentRegistered<Self::AccountId>;

        /// Cross-pallet: ranked-collective for rank management.
        type AgentCollective: AgentCollective<Self::AccountId>;

        /// Cross-pallet: oracle score for Rank 3 gate.
        type OracleScoreGate: OracleScoreGate<Self::AccountId>;

        /// Cross-pallet: verifies the agent is actively casting a governance vote
        /// before record_gov_vote() awards participation credit.
        /// Wired to pallet_conviction_voting in the runtime; () in unit tests.
        type GovVoteVerifier: GovVoteVerifier<Self::AccountId>;

        /// Cross-pallet: pallet-identity integration for capability registration.
        type IdentityHandler: IdentityHandler<Self::AccountId>;

        /// Cross-pallet: orchestrator volume crediting.
        type OrchestratorLookup: OrchestratorLookup<Self::AccountId, BalanceOf<Self>>;

        /// Max byte length of agent service endpoint URI.
        #[pallet::constant]
        type MaxUriLen: Get<u32>;

        /// Max byte length of agent display name.
        #[pallet::constant]
        type MaxNameLen: Get<u32>;

        /// Maximum number of capabilities per agent.
        #[pallet::constant]
        type MaxCapabilitiesPerAgent: Get<u32>;

        /// Maximum delegation period in blocks.
        #[pallet::constant]
        type MaxDelegationPeriod: Get<BlockNumberFor<Self>>;

        /// Window after a slash within which an appeal can be filed.
        /// After this window, the slash is final.
        #[pallet::constant]
        type SlashAppealWindow: Get<BlockNumberFor<Self>>;

        /// V4: F-07 — receives the treasury share of executed slashes (50%).
        /// Set to pallet_treasury::Pallet<Runtime> in the runtime config.
        /// The burned share (50%) is handled by dropping the NegativeImbalance.
        type SlashDestination: OnUnbalanced<
            <<Self as Config>::Currency as Currency<Self::AccountId>>::NegativeImbalance,
        >;

        /// V4: F-05 — max governance votes per agent per era.
        /// Matches the emissions pallet's MaxProposalsPerEra so gov_score cap is enforced at call time.
        #[pallet::constant]
        type MaxProposalsPerEra: Get<u32>;

        /// V4: Hook called after execute_slash completes.
        /// pallet-emissions implements this to zero AgentWeightSnapshot,
        /// preventing one-era overclaim from the stale pre-slash weight.
        type OnAgentSlashed: OnAgentSlashed<Self::AccountId>;

        /// V4: Hook called BEFORE stake increases via add_stake().
        /// pallet-emissions implements this to zero AgentWeightSnapshot,
        /// preventing overclaim of prior-era rewards using the new higher weight.
        type OnStakeChanged: OnStakeChanged<Self::AccountId>;
    }

    // ─── Structs ─────────────────────────────────────────────────────────────

    /// On-chain metadata for agent discovery.
    #[derive(Clone, Encode, Decode, MaxEncodedLen, TypeInfo, PartialEq, Eq, Default)]
    #[scale_info(skip_type_params(T))]
    pub struct AgentMeta<T: Config> {
        /// Off-chain service endpoint URI (e.g. "https://agent.example.com/rpc").
        pub uri: BoundedVec<u8, T::MaxUriLen>,
        /// Human-readable display name for the agent.
        pub name: BoundedVec<u8, T::MaxNameLen>,
        /// Block at which metadata was last updated.
        pub updated_at: BlockNumberFor<T>,
    }

    // ─── Slash appeal struct ──────────────────────────────────────────────────

    /// Record of a pending slash appeal submitted by an agent.
    #[derive(Clone, Encode, Decode, MaxEncodedLen, TypeInfo, PartialEq, Eq)]
    #[scale_info(skip_type_params(T))]
    pub struct SlashAppealRecord<T: Config> {
        /// Era in which the slash occurred.
        pub slash_era: u32,
        /// Block at which this appeal was submitted.
        pub appealed_at: BlockNumberFor<T>,
        /// Hash of the off-chain justification document (IPFS CID).
        pub reason_hash: [u8; 32],
    }

    // ─── Delegation struct ────────────────────────────────────────────────────

    /// On-chain record of an agent's governance delegation.
    #[derive(Clone, Encode, Decode, MaxEncodedLen, TypeInfo, PartialEq, Eq)]
    #[scale_info(skip_type_params(T))]
    pub struct DelegationRecord<T: Config> {
        /// Account receiving the delegation.
        pub delegate_to: T::AccountId,
        /// Block at which this delegation expires (agent must renew or it lapses).
        pub expires_at: BlockNumberFor<T>,
        /// Block at which delegation was created.
        pub created_at: BlockNumberFor<T>,
    }

    // ─── Storage ─────────────────────────────────────────────────────────────

    /// Locked stake per registered agent.
    #[pallet::storage]
    pub type AgentStake<T: Config> =
        CountedStorageMap<_, Blake2_128Concat, T::AccountId, BalanceOf<T>>;

    /// Block at which this agent first locked stake (used for Rank 3 span gate).
    #[pallet::storage]
    pub type StakeRegisteredAt<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, BlockNumberFor<T>, ValueQuery>;

    /// Unstake request: block at which cooldown expires.
    #[pallet::storage]
    pub type UnstakeAt<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, BlockNumberFor<T>, OptionQuery>;

    /// Lifetime completed escrow agreements (drives rank promotion).
    #[pallet::storage]
    pub type CompletedAgreements<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, u32, ValueQuery>;

    /// Number of open escrow agreements this agent holds as provider.
    /// Must be 0 before request_unstake() is allowed.
    #[pallet::storage]
    pub type ActiveEscrowCount<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, u32, ValueQuery>;

    // ── Per-era storage (cleared by drain_era_maps each era) ─────────────────

    /// Total escrow volume this era per agent.
    #[pallet::storage]
    pub type EraEscrowVolume<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, BalanceOf<T>, ValueQuery>;

    /// Unique buyer count this era per agent (anti-ring diversity signal).
    #[pallet::storage]
    pub type EraUniqueBuyers<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, u32, ValueQuery>;

    /// Bloom filter: (agent, buyer_slot) → seen this era.
    /// buyer_slot = blake2_256(buyer_accountid)[0..4] as u32 % 65536
    /// Collision rate ~1/65536 per pair — negligible for anti-ring purposes.
    #[pallet::storage]
    pub type EraSeenBuyerSlots<T: Config> = StorageDoubleMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        Blake2_128Concat,
        u32,
        bool,
        ValueQuery,
    >;

    /// Escrow volume this era per directed counterparty pair, `(provider, buyer) -> volume`.
    ///
    /// `EraEscrowVolume` records only *how much* a provider sold; it cannot say *to whom*,
    /// and "to whom" is the whole question when deciding whether volume is real work or a
    /// ring paying itself. This map is what makes `qualifying_era_volume` able to drop one
    /// counterparty's volume while keeping another's.
    ///
    /// Cost, stated plainly (spec 306): one entry per distinct `(provider, buyer)` pair that
    /// completes at least one agreement in the era — the same cardinality as the
    /// `EraSeenBuyerSlots` bloom map that already ships, and cleared by the same
    /// `drain_era_maps` pass. An agent transacting with k distinct buyers costs k entries of
    /// (AccountId, AccountId) key + Balance value per era, all reclaimed at settlement.
    ///
    /// The value is `(era, volume)` and not just `volume`, which is a correctness
    /// requirement rather than bookkeeping. `drain_era_maps` clears era maps with a
    /// `clear(limit, None)` whose limit is sized off `AgentStake::count()` — but a *buyer*
    /// need not be a registered agent, so nothing ties this map's cardinality to the agent
    /// count. A provider with more distinct buyers than the limit would leave a residue
    /// behind, and an unstamped residue reads as fresh volume every subsequent era: a
    /// monotonic, self-compounding inflation of the emission ceiling with no new escrow
    /// behind it. Stamping the era makes any residue inert on sight, whether or not the
    /// clear ran to completion.
    #[pallet::storage]
    pub type EraPairVolume<T: Config> = StorageDoubleMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        Blake2_128Concat,
        T::AccountId,
        (u32, BalanceOf<T>),
        ValueQuery,
    >;

    /// Funding-lineage union-find parent pointer: `account -> parent`. Absent means the
    /// account is its own lineage root.
    ///
    /// Two accounts that share a funding root are treated as one economic actor, so escrow
    /// between them is not qualifying volume and cannot size the emission pot (D7, #164).
    ///
    /// WHY THIS IS DECLARED RATHER THAN OBSERVED. `pallet_balances::Config` in
    /// polkadot-stable2503 exposes no transfer hook — only `DustRemoval` and `AccountStore`
    /// — and `frame_system`'s `OnNewAccount` carries the new account but never the funder.
    /// So a pallet cannot see "these two addresses were paid by the same faucet drip"
    /// without either forking pallet-balances or adding a `TransactionExtension`, which
    /// changes the extrinsic format and every wallet with it. Neither belongs in a fix for
    /// #164. The lineage that IS observable from escrow flow — a payer<->worker cycle
    /// inside one era — is detected automatically and needs no storage at all (see
    /// `qualifying_volume_of`); the lineage that is not observable is declared here by
    /// root, which is how the operator records a known shared faucet drip.
    ///
    /// Cost: one `(AccountId -> AccountId)` entry per account that is ever linked, written
    /// only by `link_funding_lineage`. Nothing writes it implicitly, so an unused chain
    /// carries an empty map.
    #[pallet::storage]
    pub type LineageParent<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, T::AccountId, OptionQuery>;

    /// Governance votes recorded this era per agent. Feeds `gov_score` in emissions.
    /// Bounded above by `MaxProposalsPerEra`; equals the number of DISTINCT live
    /// referenda credited this era (see `EraGovVotedPolls`).
    #[pallet::storage]
    pub type EraGovParticipation<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, u32, ValueQuery>;

    /// ROUND14 dedup set: (agent, poll_index) → already credited this era.
    ///
    /// Without this, `record_gov_vote` is a self-attestation — the verifier answers a
    /// yes/no question that one held vote satisfies indefinitely, so the same vote can
    /// be redeemed `MaxProposalsPerEra` times per era forever. Recording *which*
    /// referendum paid out makes each live referendum worth exactly one credit, so
    /// `EraGovParticipation` counts distinct governance acts rather than extrinsic calls.
    ///
    /// Ephemeral: cleared every era by `drain_era_maps` alongside the other era maps.
    #[pallet::storage]
    pub type EraGovVotedPolls<T: Config> = StorageDoubleMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        Blake2_128Concat,
        u32,
        bool,
        ValueQuery,
    >;

    // ── Era snapshot storage (written by drain_era_maps, read by auto-params) ─

    /// Count of ring-suspect agents before last drain.
    /// Ring-suspect = active this era AND unique_buyers <= 1 AND established (>1 lifetime completion).
    #[pallet::storage]
    pub type EraRingSnapshot<T: Config> = StorageValue<_, u32, ValueQuery>;

    /// Count of active agents before last drain (any volume > 0 this era).
    #[pallet::storage]
    pub type EraActiveSnapshot<T: Config> = StorageValue<_, u32, ValueQuery>;

    /// Current era number. Incremented by drain_era_maps().
    #[pallet::storage]
    pub type EraNumber<T: Config> = StorageValue<_, u32, ValueQuery>;

    /// Block count limiter: reset to 0 every block in on_initialize.
    #[pallet::storage]
    pub type RegistrationsThisBlock<T: Config> = StorageValue<_, u32, ValueQuery>;

    /// Last heartbeat block per agent. Updated by heartbeat() extrinsic.
    #[pallet::storage]
    pub type LastHeartbeat<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, BlockNumberFor<T>, ValueQuery>;

    /// Pending slash appeals: agent → (slash_era, appeal_block, reason_hash).
    /// Governance referendum [Track 0] can overturn the slash within AppealWindow.
    #[pallet::storage]
    pub type PendingSlashAppeals<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, SlashAppealRecord<T>, OptionQuery>;

    /// Executed slashes: (agent, era of the slash) → basis points slashed.
    ///
    /// Several slashes in one era sum into one entry, clamped at 10_000 bps (100%). Each bps
    /// is a share of the stake at that slash, so the sum is a record of what governance
    /// decided, not the exact fraction of the era-start stake that was lost.
    ///
    /// Written only by `execute_slash`. An appeal is a claim against a specific slash; without
    /// a record of the slash there is nothing to appeal, and an unchecked `slash_appeal` lets
    /// any registered account plant appeal records against slashes that never happened (E22).
    #[pallet::storage]
    pub type SlashRecords<T: Config> =
        StorageDoubleMap<_, Blake2_128Concat, T::AccountId, Twox64Concat, u32, u32, OptionQuery>;

    /// Open appeals: (agent, slash_era) → full appeal record.
    /// One open appeal per slash; the per-account total is `OpenAppealCount`. Unlike the
    /// single-entry `PendingSlashAppeals` pointer, a later-era appeal never overwrites an
    /// earlier one here, so every appeal up to `MAX_OPEN_APPEALS` stays reviewable.
    #[pallet::storage]
    pub type OpenAppeals<T: Config> = StorageDoubleMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        Twox64Concat,
        u32,
        SlashAppealRecord<T>,
        OptionQuery,
    >;

    /// Number of open appeals per agent, bounded by `MAX_OPEN_APPEALS`. Keeps the per-account
    /// appeal state (and the cleanup on unstake/slash) bounded no matter how often an agent files.
    #[pallet::storage]
    pub type OpenAppealCount<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, u32, ValueQuery>;

    /// Active voting delegations: agent → DelegationRecord.
    /// Governance tooling reads this to route votes.
    #[pallet::storage]
    pub type VotingDelegations<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, DelegationRecord<T>, OptionQuery>;

    /// Agent endpoint URI + display name for off-chain discovery.
    #[pallet::storage]
    pub type AgentMetadata<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, AgentMeta<T>, OptionQuery>;

    /// Active capability IDs per agent.
    /// BoundedBTreeSet ensures sorted dedup and bounded storage.
    #[pallet::storage]
    pub type AgentCapabilities<T: Config> = StorageMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        BoundedVec<u32, T::MaxCapabilitiesPerAgent>,
        ValueQuery,
    >;

    /// spec 308 (D14): an agent's X25519 public key for end-to-end encrypted messages.
    ///
    /// Agents coordinate through `pallet-messages`, whose payloads are public block data. A
    /// counterparty that wants confidential terms needs a key to encrypt to that it can trust is
    /// the agent's own; publishing it here, writable only by the registered agent itself, gives
    /// every counterparty the same answer without a separate key directory. Optional: an agent
    /// with no key can still send and receive plaintext and hash-only messages.
    ///
    /// No deposit: the entry is a fixed 32 bytes, at most one per registered agent, so it is
    /// bounded by `MaxAgents` and already paid for by the registration burn. Removed whenever
    /// the account stops being an agent — `complete_unstake`, or an `execute_slash` that takes
    /// stake below `MinStake` — so no key is ever published for a non-agent.
    ///
    /// Additive storage: existing agents simply have no entry, so no migration and no
    /// `STORAGE_VERSION` bump are needed.
    #[pallet::storage]
    pub type MessagingKey<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, [u8; 32], OptionQuery>;

    // ─── StorageVersion ──────────────────────────────────────────────────────
    /// Bumped 1 -> 2 for spec 306: `EraPairVolume` and `LineageParent` are new, and the
    /// v2 migration backfills `LastHeartbeat` for agents that registered before D8 (#161).
    const STORAGE_VERSION: StorageVersion = StorageVersion::new(2);

    #[pallet::pallet]
    #[pallet::storage_version(STORAGE_VERSION)]
    pub struct Pallet<T>(_);

    // ─── Genesis ─────────────────────────────────────────────────────────────
    #[pallet::genesis_config]
    #[derive(frame_support::DefaultNoBound)]
    pub struct GenesisConfig<T: Config> {
        /// (account, stake, is_genesis_agent)
        pub agents: Vec<(T::AccountId, BalanceOf<T>, bool)>,
    }

    #[pallet::genesis_build]
    impl<T: Config> BuildGenesisConfig for GenesisConfig<T> {
        fn build(&self) {
            for (account, stake, _is_genesis) in &self.agents {
                T::Currency::set_lock(AGENT_LOCK_ID, account, *stake, WithdrawReasons::all());
                AgentStake::<T>::insert(account, stake);
                StakeRegisteredAt::<T>::insert(account, BlockNumberFor::<T>::zero());
                // Induct into ranked-collective at Rank 0; emissions initialises debt separately
                let _ = T::AgentCollective::induct(account);
                // If stake >= FullFloorStake, immediately promote to Rank 2
                if *stake >= T::FullFloorStake::get() {
                    // Rank 0 → 1 → 2
                    let _ = T::AgentCollective::promote(account);
                    let _ = T::AgentCollective::promote(account);
                } else if *stake >= T::MinStake::get() {
                    // Rank 0 → 1 (has stake, qualifies as Basic)
                    let _ = T::AgentCollective::promote(account);
                }
            }
        }
    }

    // ─── Hooks ───────────────────────────────────────────────────────────────
    #[pallet::hooks]
    impl<T: Config> Hooks<BlockNumberFor<T>> for Pallet<T> {
        fn on_initialize(_n: BlockNumberFor<T>) -> Weight {
            RegistrationsThisBlock::<T>::put(0u32);
            T::DbWeight::get().writes(1)
        }

        fn on_runtime_upgrade() -> Weight {
            let on_chain = StorageVersion::get::<Pallet<T>>();
            if on_chain >= 2 {
                return T::DbWeight::get().reads(1);
            }

            // v1 -> v2 (spec 306). D8 makes `register` start the heartbeat clock, but every
            // agent that registered under spec <= 305 has no `LastHeartbeat` entry at all,
            // which `ValueQuery` reports as block 0. On a chain hundreds of thousands of
            // blocks old that reads as "silent since genesis": #161 measured an agent with
            // 171 lifetime completions and 10 000 CMN staked sitting at multiplier 63,
            // below the `hb >= 90` activity gate, purely because nothing ever wrote the key.
            //
            // Backfill exactly those agents — the ones with no entry — to the upgrade block.
            // That gives them the same grace window a newly registered agent gets and no
            // more: they must send a real heartbeat within `HeartbeatGracePeriod` or decay
            // from here like everyone else. An agent that HAS heartbeated is left untouched,
            // so the migration can never move a real timestamp forward.
            //
            // Hard-bounded, because `MaxAgents` is 10 000 000 and returning an honest
            // weight for ten million reads does not make the block executable — it bricks
            // the upgrade. `MAX_HEARTBEAT_BACKFILL` caps the pass; any agent past it is
            // simply not backfilled and reaches the same state by sending one heartbeat,
            // which is the thing agents do anyway. The event reports how many were touched
            // so a short backfill is visible rather than assumed complete.
            const MAX_HEARTBEAT_BACKFILL: u32 = 10_000;
            let now = frame_system::Pallet::<T>::block_number();
            let mut seen: u32 = 0;
            let mut writes: u64 = 0;
            for (agent, _stake) in AgentStake::<T>::iter() {
                seen = seen.saturating_add(1);
                if seen > MAX_HEARTBEAT_BACKFILL {
                    break;
                }
                if !LastHeartbeat::<T>::contains_key(&agent) {
                    LastHeartbeat::<T>::insert(&agent, now);
                    writes = writes.saturating_add(1);
                }
            }
            let registered = seen as u64;

            StorageVersion::new(2).put::<Pallet<T>>();
            Self::deposit_event(Event::HeartbeatBackfilled {
                agents: writes as u32,
                at_block: now,
            });

            // reads: version + count + one per agent (iter) + one contains_key per agent
            // writes: one per backfilled agent + the storage version
            T::DbWeight::get().reads_writes(
                2u64.saturating_add(registered.saturating_mul(2)),
                writes.saturating_add(1),
            )
        }
    }

    // ─── Events ──────────────────────────────────────────────────────────────
    #[pallet::event]
    #[pallet::generate_deposit(pub(super) fn deposit_event)]
    pub enum Event<T: Config> {
        AgentRegistered {
            who: T::AccountId,
            stake: BalanceOf<T>,
            fee: BalanceOf<T>,
        },
        StakeAdded {
            who: T::AccountId,
            added: BalanceOf<T>,
            total: BalanceOf<T>,
        },
        UnstakeRequested {
            who: T::AccountId,
            unstake_at: BlockNumberFor<T>,
        },
        UnstakeCompleted {
            who: T::AccountId,
            released: BalanceOf<T>,
        },
        HeartbeatSent {
            who: T::AccountId,
        },
        EraMapsCleared {
            era: u32,
            ring_snap: u32,
            active_snap: u32,
        },
        GovVoteRecorded {
            who: T::AccountId,
            /// ROUND14: the referendum this credit was bound to. Present so indexers can
            /// audit that credits map 1:1 onto distinct live referenda.
            poll_index: u32,
            total_era_votes: u32,
        },
        EraVolumeAdded {
            who: T::AccountId,
            amount: BalanceOf<T>,
            era_total: BalanceOf<T>,
        },
        /// spec 306 v2 migration: agents whose `LastHeartbeat` was never written had the
        /// key set to the upgrade block. Emitted once, at the upgrade. See #161.
        HeartbeatBackfilled {
            agents: u32,
            at_block: BlockNumberFor<T>,
        },
        /// Two accounts were declared to share a funding lineage, so escrow between them
        /// no longer counts as qualifying volume for emission sizing (#164, D7).
        FundingLineageLinked {
            a: T::AccountId,
            b: T::AccountId,
            root: T::AccountId,
        },
        /// An account was detached from its funding-lineage group.
        FundingLineageUnlinked {
            who: T::AccountId,
        },
        MetadataUpdated {
            who: T::AccountId,
        },
        CapabilitySet {
            who: T::AccountId,
            capability_id: u32,
            active: bool,
        },
        VotingDelegated {
            who: T::AccountId,
            to: T::AccountId,
            until: BlockNumberFor<T>,
        },
        VotingDelegationRemoved {
            who: T::AccountId,
        },
        SlashAppealed {
            who: T::AccountId,
            slash_era: u32,
            reason_hash: [u8; 32],
        },
        SlashAppealWithdrawn {
            who: T::AccountId,
        },
        /// V4: F-07 — emitted when a slash is executed and CMN actually removed.
        SlashExecuted {
            who: T::AccountId,
            amount: BalanceOf<T>,
            burn: BalanceOf<T>,
            treasury: BalanceOf<T>,
        },
        /// spec 308 (D14): an agent published or rotated its X25519 messaging key. Emitted on
        /// every set, including a rotation, so a counterparty watching events never encrypts
        /// to a stale key.
        MessagingKeySet {
            who: T::AccountId,
            key: [u8; 32],
        },
        /// spec 308 (D14): an agent withdrew its messaging key; counterparties must stop
        /// encrypting to the old one.
        MessagingKeyCleared {
            who: T::AccountId,
        },
    }

    // ─── Errors ──────────────────────────────────────────────────────────────
    #[pallet::error]
    pub enum Error<T> {
        AlreadyRegistered,
        NotRegistered,
        StakeTooLow,
        StakeTooHigh,
        MaxAgentsReached,
        RegistrationRateLimitExceeded,
        HasActiveAgreements,
        NoUnstakeRequest,
        UnstakeAlreadyPending,
        UnstakeCooldownNotElapsed,
        Unauthorized,
        /// Agent must have a pallet-identity record before registering capabilities.
        IdentityRequired,
        /// Capability list is full (MaxCapabilitiesPerAgent reached).
        TooManyCapabilities,
        DelegationExpired,
        DelegationPeriodTooLong,
        /// Appeal window has elapsed — slash is final.
        AppealWindowExpired,
        /// Agent already has a pending appeal.
        AppealAlreadyPending,
        /// V4: F-05 — agent has already voted MaxProposalsPerEra times this era.
        GovVoteCapReached,
        /// Agent called record_gov_vote() for a poll it holds no vote on, or whose
        /// referendum is no longer ongoing. Prevents governance score spoofing: agents
        /// must actually be voting on a LIVE referendum to earn participation credit.
        NotActivelyVoting,
        /// ROUND14 — this referendum has already paid governance credit to this agent
        /// this era. One live referendum is worth exactly one credit; redeeming the
        /// same held vote repeatedly was the governance-farming vector.
        PollAlreadyCredited,
        /// V4: F-07 — slash amount must be > 0 bps and ≤ 10000 bps.
        InvalidSlashBps,
        /// `link_funding_lineage` was called with the same account twice, or with two
        /// accounts that already resolve to the same lineage root. Nothing to do.
        LineageAlreadyLinked,
        /// `unlink_funding_lineage` was called on an account that is not linked to anything.
        LineageNotLinked,
        /// A lineage chain exceeded `MAX_LINEAGE_DEPTH`. Refused rather than guessed: the
        /// qualifying-volume path already treats an undecidable walk as linked, and linking
        /// on top of a structure it cannot resolve would compound the ambiguity.
        LineageTooDeep,
        /// `slash_appeal` named an era in which this agent was never slashed (E22).
        NoSuchSlash,
        /// The agent already has `MAX_OPEN_APPEALS` appeals open.
        TooManyOpenAppeals,
        /// `clear_messaging_key` was called by an agent that has no messaging key set.
        NoMessagingKey,
    }

    // ─── Calls ───────────────────────────────────────────────────────────────
    #[pallet::call]
    impl<T: Config> Pallet<T>
    where
        BalanceOf<T>: From<u32>,
    {
        /// Register as an agent. Burns a fee; locks stake; inducts into ranked-collective.
        #[pallet::call_index(0)]
        #[pallet::weight(T::DbWeight::get().reads_writes(7, 7)
            .saturating_add(Weight::from_parts(120_000_000, 0)))]
        pub fn register(
            origin: OriginFor<T>,
            #[pallet::compact] stake: BalanceOf<T>,
        ) -> DispatchResult {
            let who = ensure_signed(origin)?;

            ensure!(
                !AgentStake::<T>::contains_key(&who),
                Error::<T>::AlreadyRegistered
            );
            ensure!(stake >= T::MinStake::get(), Error::<T>::StakeTooLow);
            ensure!(
                stake <= T::MaxStakePerAgent::get(),
                Error::<T>::StakeTooHigh
            );
            ensure!(
                AgentStake::<T>::count() < T::MaxAgents::get(),
                Error::<T>::MaxAgentsReached
            );

            // Rate limit: checked before any state mutations
            let this_block = RegistrationsThisBlock::<T>::get();
            ensure!(
                this_block < T::MaxRegistrationsPerBlock::get(),
                Error::<T>::RegistrationRateLimitExceeded
            );

            let fee = T::BaseRegistrationFee::get();
            let min_balance = T::Currency::minimum_balance();
            ensure!(
                T::Currency::free_balance(&who)
                    >= stake.saturating_add(fee).saturating_add(min_balance),
                Error::<T>::StakeTooLow
            );

            // Increment rate limiter only after all preconditions pass
            RegistrationsThisBlock::<T>::put(this_block + 1);

            // Burn fee
            let _ = T::Currency::withdraw(
                &who,
                fee,
                WithdrawReasons::FEE,
                ExistenceRequirement::KeepAlive,
            )?;

            // Lock stake
            T::Currency::set_lock(AGENT_LOCK_ID, &who, stake, WithdrawReasons::all());
            AgentStake::<T>::insert(&who, stake);
            let now = frame_system::Pallet::<T>::block_number();
            StakeRegisteredAt::<T>::insert(&who, now);
            // D8 (#161) — start the heartbeat clock at registration.
            //
            // `LastHeartbeat` is ValueQuery, so an agent that has never sent one reads 0.
            // On a chain past its grace period that makes `heartbeat_multiplier` compute
            // from a gap of the entire chain history: at block ~534 500 the multiplier is
            // 63, `has_heartbeat` (hb >= 90) is false, and a brand-new agent is barred from
            // the floor share on its first era for a liveness failure it had no opportunity
            // to avoid. Registering IS a liveness signal — the account is on chain, staked,
            // and signing this block — so the clock starts here and decays from here.
            LastHeartbeat::<T>::insert(&who, now);

            // Induct into ranked-collective at Rank 0
            T::AgentCollective::induct(&who)?;
            // First completion will trigger Rank 0 → 1; stake threshold triggers 1 → 2

            // Initialise emission debt (prevents back-claiming)
            T::OnAgentRegistered::on_registered(&who);

            Self::deposit_event(Event::AgentRegistered { who, stake, fee });
            Ok(())
        }

        /// Add stake to existing registration. Does not reset the Rank 3 span gate.
        #[pallet::call_index(1)]
        #[pallet::weight(T::DbWeight::get().reads_writes(3, 3)
            .saturating_add(Weight::from_parts(70_000_000, 0)))]
        pub fn add_stake(
            origin: OriginFor<T>,
            #[pallet::compact] amount: BalanceOf<T>,
        ) -> DispatchResult {
            let who = ensure_signed(origin)?;
            ensure!(!amount.is_zero(), Error::<T>::StakeTooLow);
            let current_stake = AgentStake::<T>::get(&who).ok_or(Error::<T>::NotRegistered)?;
            ensure!(
                UnstakeAt::<T>::get(&who).is_none(),
                Error::<T>::UnstakeAlreadyPending
            );
            ensure!(
                T::Currency::free_balance(&who) >= amount,
                Error::<T>::StakeTooLow
            );
            let new_stake = current_stake.saturating_add(amount);
            ensure!(
                new_stake <= T::MaxStakePerAgent::get(),
                Error::<T>::StakeTooHigh
            );

            // Zero AgentWeightSnapshot before changing stake.
            // The MasterChef accumulator uses the LATEST snapshot weight to compute
            // all pending rewards including prior eras. If stake increases between
            // eras, using the new higher weight for old deltas would overclaim.
            // Zeroing the snapshot means unclaimed prior-era rewards are forfeited
            // — a conservative trade-off that closes the exploit.
            // The next settle_era will write the correct new-stake snapshot.
            T::OnStakeChanged::on_stake_changed(&who);

            T::Currency::set_lock(AGENT_LOCK_ID, &who, new_stake, WithdrawReasons::all());
            AgentStake::<T>::insert(&who, new_stake);

            // Check if stake crossed Full-tier threshold → promote to Rank 2
            let current_rank = T::AgentCollective::rank_of(&who).unwrap_or(0);
            if current_rank == 1 && new_stake >= T::FullFloorStake::get() {
                let _ = T::AgentCollective::promote(&who);
            }

            Self::deposit_event(Event::StakeAdded {
                who,
                added: amount,
                total: new_stake,
            });
            Ok(())
        }

        /// Begin unstake cooldown. Blocked if any escrow agreements are open.
        #[pallet::call_index(2)]
        #[pallet::weight(T::DbWeight::get().reads_writes(3, 2)
            .saturating_add(Weight::from_parts(60_000_000, 0)))]
        pub fn request_unstake(origin: OriginFor<T>) -> DispatchResult {
            let who = ensure_signed(origin)?;
            ensure!(
                AgentStake::<T>::contains_key(&who),
                Error::<T>::NotRegistered
            );
            ensure!(
                UnstakeAt::<T>::get(&who).is_none(),
                Error::<T>::UnstakeAlreadyPending
            );
            ensure!(
                ActiveEscrowCount::<T>::get(&who) == 0,
                Error::<T>::HasActiveAgreements
            );
            let now = frame_system::Pallet::<T>::block_number();
            let unstake_at = now.saturating_add(T::UnstakeCooldown::get());
            UnstakeAt::<T>::insert(&who, unstake_at);
            Self::deposit_event(Event::UnstakeRequested { who, unstake_at });
            Ok(())
        }

        /// Complete unstake after cooldown. Re-checks for active escrows.
        ///
        /// # Weight (#217)
        /// This is a teardown: it removes every key it holds for the exiting agent, plus the
        /// bounded appeal cleanup #195 added. Declaring 4 writes for that priced the exit
        /// below what it costs the chain, which is backwards — a permissionless call should
        /// never be cheaper than the storage it touches.
        ///
        /// First term, this pallet's own storage. 12 reads: `AgentStake`, `UnstakeAt`, block
        /// number, `ActiveEscrowCount`, the `AgentStake` counter, `MAX_OPEN_APPEALS` (5) for
        /// the `OpenAppeals` prefix walk, and one apiece for `Currency::remove_lock`
        /// (`Locks`) and its account read. 18 writes: `AgentStake` value and counter,
        /// `UnstakeAt`, `StakeRegisteredAt`, `CompletedAgreements`, `LastHeartbeat`,
        /// `AgentMetadata`, `AgentCapabilities`, `VotingDelegations`, `PendingSlashAppeals`,
        /// `OpenAppealCount`, `MAX_OPEN_APPEALS` (5) for the `OpenAppeals` `clear_prefix`,
        /// and `Locks` + account for the lock release. The `sp_io::offchain_index::clear`
        /// is not a state-trie write and rides the flat execution component.
        ///
        /// Second term, `AgentCollective::remove`, kept separate because it is the one cost
        /// here that is *rank-linear* rather than flat, and a flat allowance would understate
        /// it. The runtime wires this to `RankedCollective::do_remove_member_from_rank(who,
        /// u16::MAX)`, which unwinds the member one rank at a time: per rank `MemberCount`
        /// (read + write), `IdToIndex` and `IndexToId` (read, swap-insert and remove each),
        /// i.e. 3 reads / 5 writes. `maybe_promote` caps agents at rank 3, so 4 levels =
        /// 12 reads / 20 writes, plus the 2 reads of the iteration that ends the walk and
        /// the final `Members` removal. A runtime wiring a collective with more ranks than
        /// this one must revisit this term.
        ///
        /// spec 308 adds one write to the first term: the `MessagingKey` removal.
        ///
        /// Pinned as a floor by `declared_weight_complete_unstake_covers_appeal_cleanup`.
        #[pallet::call_index(3)]
        #[pallet::weight(T::DbWeight::get().reads_writes(12, 19)
            .saturating_add(T::DbWeight::get().reads_writes(14, 21))
            .saturating_add(Weight::from_parts(80_000_000, 0)))]
        pub fn complete_unstake(origin: OriginFor<T>) -> DispatchResult {
            let who = ensure_signed(origin)?;
            let stake = AgentStake::<T>::get(&who).ok_or(Error::<T>::NotRegistered)?;
            let unstake_at = UnstakeAt::<T>::get(&who).ok_or(Error::<T>::NoUnstakeRequest)?;
            let now = frame_system::Pallet::<T>::block_number();
            ensure!(now >= unstake_at, Error::<T>::UnstakeCooldownNotElapsed);
            // Re-check: new escrow could have been created during cooldown
            ensure!(
                ActiveEscrowCount::<T>::get(&who) == 0,
                Error::<T>::HasActiveAgreements
            );

            T::Currency::remove_lock(AGENT_LOCK_ID, &who);
            T::AgentCollective::remove(&who); // remove from ranked-collective
            AgentStake::<T>::remove(&who);
            UnstakeAt::<T>::remove(&who);
            StakeRegisteredAt::<T>::remove(&who);
            CompletedAgreements::<T>::remove(&who);
            LastHeartbeat::<T>::remove(&who);
            AgentMetadata::<T>::remove(&who);
            AgentCapabilities::<T>::remove(&who);
            MessagingKey::<T>::remove(&who);
            VotingDelegations::<T>::remove(&who);
            PendingSlashAppeals::<T>::remove(&who);
            let _ = OpenAppeals::<T>::clear_prefix(&who, MAX_OPEN_APPEALS, None);
            OpenAppealCount::<T>::remove(&who);

            // Clear offchain discovery index
            {
                let key = [b"sc:agent:", &who.encode()[..]].concat();
                sp_io::offchain_index::clear(&key);
            }

            Self::deposit_event(Event::UnstakeCompleted {
                who,
                released: stake,
            });
            Ok(())
        }

        /// Send heartbeat. Updates LastHeartbeat for floor emission multiplier.
        /// Agents should send once per era. Missing heartbeats decay floor over time.
        #[pallet::call_index(4)]
        #[pallet::weight(T::DbWeight::get().reads_writes(2, 2)
            .saturating_add(Weight::from_parts(30_000_000, 0)))]
        pub fn heartbeat(origin: OriginFor<T>) -> DispatchResult {
            let who = ensure_signed(origin)?;
            // Single read: get() returns Option, serving both the existence check
            // and the value for the offchain discovery index update.
            let stake = AgentStake::<T>::get(&who).ok_or(Error::<T>::NotRegistered)?;
            let now = frame_system::Pallet::<T>::block_number();
            LastHeartbeat::<T>::insert(&who, now);
            // Update offchain discovery index
            {
                let rank = T::AgentCollective::rank_of(&who).unwrap_or(0);
                let key = [b"sc:agent:", &who.encode()[..]].concat();
                let value = (stake, rank, now).encode();
                sp_io::offchain_index::set(&key, &value);
            }
            Self::deposit_event(Event::HeartbeatSent { who });
            Ok(())
        }

        /// Record governance participation for ONE referendum. Called by the agent after
        /// voting on `poll_index`. Self-only: signer must equal agent.
        ///
        /// Economic why: `gov_score` is meant to price *participation in governing the
        /// commons*, which is a per-referendum act. Before ROUND14 the extrinsic named no
        /// referendum, so credit was self-attested — one vote, cast once and never removed,
        /// satisfied the verifier forever and could be redeemed `MaxProposalsPerEra` times
        /// an era, for ever, at zero capital cost. That paid +4,000 bps (40% of the activity
        /// budget) for a single historical click, and it paid *most* to the agents doing
        /// least real work, since high-volume agents are already near the `BPS_SCALE` clamp.
        ///
        /// Three guards now make credit derived rather than claimed:
        ///   1. `PollAlreadyCredited` — each referendum pays this agent at most once per era.
        ///   2. `NotActivelyVoting` — the agent must hold a vote on THIS poll and that poll
        ///      must still be ongoing, so concluded referenda earn nothing.
        ///   3. `GovVoteCapReached` — the pre-existing per-era ceiling (F-05).
        /// Net effect: credit = distinct LIVE referenda actually voted on this era, capped.
        #[pallet::call_index(5)]
        #[pallet::weight(T::DbWeight::get().reads_writes(3, 2)
            .saturating_add(Weight::from_parts(35_000_000, 0)))]
        pub fn record_gov_vote(
            origin: OriginFor<T>,
            agent: T::AccountId,
            poll_index: u32,
        ) -> DispatchResult {
            let signer = ensure_signed(origin)?;
            ensure!(signer == agent, Error::<T>::Unauthorized);
            ensure!(
                AgentStake::<T>::contains_key(&agent),
                Error::<T>::NotRegistered
            );
            // Cheapest guard first: a referendum already redeemed this era pays nothing,
            // regardless of whether the vote is still held.
            ensure!(
                !EraGovVotedPolls::<T>::get(&agent, poll_index),
                Error::<T>::PollAlreadyCredited
            );
            // Verify the agent holds a vote on THIS poll and that the poll is still ongoing.
            // The runtime implements this over pallet_conviction_voting::VotingFor plus
            // Polling::as_ongoing; test mocks supply their own policy (there is deliberately
            // no permissive default impl any more).
            ensure!(
                T::GovVoteVerifier::has_live_vote_on(&agent, poll_index),
                Error::<T>::NotActivelyVoting
            );
            // V4: F-05 — cap at MaxProposalsPerEra to prevent gov_score farming by block producers
            ensure!(
                EraGovParticipation::<T>::get(&agent) < T::MaxProposalsPerEra::get(),
                Error::<T>::GovVoteCapReached
            );
            EraGovVotedPolls::<T>::insert(&agent, poll_index, true);
            let total = EraGovParticipation::<T>::mutate(&agent, |v| {
                *v = v.saturating_add(1);
                *v
            });
            Self::deposit_event(Event::GovVoteRecorded {
                who: agent,
                poll_index,
                total_era_votes: total,
            });
            Ok(())
        }

        /// Update agent service endpoint URI and display name.
        /// Both fields are optional (pass empty to clear). Metadata is not validated on-chain —
        /// it is a discovery hint for buyers, not a security primitive.
        #[pallet::call_index(6)]
        #[pallet::weight(T::DbWeight::get().reads_writes(2, 1)
            .saturating_add(Weight::from_parts(50_000_000, 0)))]
        pub fn update_metadata(
            origin: OriginFor<T>,
            uri: BoundedVec<u8, T::MaxUriLen>,
            name: BoundedVec<u8, T::MaxNameLen>,
        ) -> DispatchResult {
            let who = ensure_signed(origin)?;
            ensure!(
                AgentStake::<T>::contains_key(&who),
                Error::<T>::NotRegistered
            );

            let now = frame_system::Pallet::<T>::block_number();
            let meta = AgentMeta::<T> {
                uri,
                name,
                updated_at: now,
            };
            AgentMetadata::<T>::insert(&who, meta);

            Self::deposit_event(Event::MetadataUpdated { who });
            Ok(())
        }

        /// Register or deregister an AI capability.
        /// Writes to pallet-identity additional fields so oracle can gate responses.
        /// Agent must have a pallet-identity record (created via identity::set_identity()).
        /// Setting active=false removes the capability from oracle gating.
        #[pallet::call_index(7)]
        #[pallet::weight(T::DbWeight::get().reads_writes(3, 2)
            .saturating_add(Weight::from_parts(60_000_000, 0)))]
        pub fn set_capability(
            origin: OriginFor<T>,
            capability_id: u32,
            active: bool,
        ) -> DispatchResult {
            let who = ensure_signed(origin)?;
            ensure!(
                AgentStake::<T>::contains_key(&who),
                Error::<T>::NotRegistered
            );
            ensure!(
                T::IdentityHandler::has_identity(&who),
                Error::<T>::IdentityRequired
            );

            // Write to pallet-identity so oracle capability gate can read it
            T::IdentityHandler::set_capability(&who, capability_id, active)?;

            // Maintain sorted local capability list for efficient query
            AgentCapabilities::<T>::try_mutate(&who, |caps| -> DispatchResult {
                if active {
                    // Insert if not present
                    if !caps.contains(&capability_id) {
                        caps.try_push(capability_id)
                            .map_err(|_| Error::<T>::TooManyCapabilities)?;
                        let mut v = caps.to_vec();
                        v.sort_unstable();
                        *caps = v.try_into().unwrap_or_default();
                    }
                } else {
                    // Remove if present
                    caps.retain(|&c| c != capability_id);
                }
                Ok(())
            })?;

            Self::deposit_event(Event::CapabilitySet {
                who,
                capability_id,
                active,
            });
            Ok(())
        }

        /// Delegate conviction-voting weight to another account.
        ///
        /// An AI agent running autonomously can delegate its governance vote to a
        /// human operator account until a specified block. This allows governance
        /// participation without requiring the agent software to sign governance txs.
        ///
        /// The delegation is recorded locally and is read by governance integrations.
        /// Actual conviction-voting delegation uses pallet-conviction-voting::delegate()
        /// externally — this records the agent's *intent* for discovery and analytics.
        ///
        /// Self-only (signer == agent). Expires at `until` block.
        /// Pass until = 0 to remove delegation.
        #[pallet::call_index(8)]
        #[pallet::weight(T::DbWeight::get().reads_writes(2, 2)
            .saturating_add(Weight::from_parts(40_000_000, 0)))]
        pub fn delegate_voting(
            origin: OriginFor<T>,
            to: T::AccountId,
            until: BlockNumberFor<T>,
        ) -> DispatchResult {
            let who = ensure_signed(origin)?;
            ensure!(
                AgentStake::<T>::contains_key(&who),
                Error::<T>::NotRegistered
            );
            let now = frame_system::Pallet::<T>::block_number();
            // Validate: if non-zero, must be future and within max period
            if until != BlockNumberFor::<T>::zero() {
                ensure!(until > now, Error::<T>::DelegationExpired);
                let max_until = now.saturating_add(T::MaxDelegationPeriod::get());
                ensure!(until <= max_until, Error::<T>::DelegationPeriodTooLong);
            }
            if until == BlockNumberFor::<T>::zero() {
                // Remove delegation only — do NOT touch PendingSlashAppeals here.
                // Slash appeals are independent of voting delegation.
                // Clearing appeals here would let slashed agents erase governance records.
                VotingDelegations::<T>::remove(&who);
                Self::deposit_event(Event::VotingDelegationRemoved { who });
            } else {
                let record = DelegationRecord::<T> {
                    delegate_to: to.clone(),
                    expires_at: until,
                    created_at: now,
                };
                VotingDelegations::<T>::insert(&who, record);
                Self::deposit_event(Event::VotingDelegated { who, to, until });
            }
            Ok(())
        }

        /// File a slash appeal with an off-chain justification document.
        ///
        /// The agent submits the IPFS CID (as [u8;32]) of a justification document
        /// explaining why the slash was unwarranted. A Track 0 governance referendum
        /// can then vote to reverse the slash within SlashAppealWindow blocks.
        ///
        /// One appeal per slash, at most `MAX_OPEN_APPEALS` open per account. Appeal fails if:
        /// - No slash record exists for this agent in `slash_era` (`NoSuchSlash`)
        /// - The appeal window has already passed
        /// - An appeal against this slash is still pending
        /// - The account already holds `MAX_OPEN_APPEALS` open appeals
        ///
        /// # Note
        /// This extrinsic records intent — actual slash reversal requires a
        /// governance referendum that calls a privileged reversal extrinsic.
        ///
        /// # Weight (#217)
        /// 7 reads: `AgentStake`, `SlashRecords`, `OpenAppeals`, `OpenAppealCount`, block
        /// number, `EraNumber`, `PendingSlashAppeals`. Every one of them is a guard or a
        /// value the record needs, so all seven are on the success path.
        ///
        /// 3 writes: `PendingSlashAppeals` (first appeal only), `OpenAppeals`,
        /// `OpenAppealCount` — the write count already matched, so only the reads moved.
        /// Pinned as a floor by `declared_weight_slash_appeal_covers_its_reads`.
        #[pallet::call_index(9)]
        #[pallet::weight(T::DbWeight::get().reads_writes(7, 3)
            .saturating_add(Weight::from_parts(50_000_000, 0)))]
        pub fn slash_appeal(
            origin: OriginFor<T>,
            slash_era: u32,
            reason_hash: [u8; 32],
        ) -> DispatchResult {
            let who = ensure_signed(origin)?;
            ensure!(
                AgentStake::<T>::contains_key(&who),
                Error::<T>::NotRegistered
            );
            // E22: an appeal must name a slash that actually happened.
            ensure!(
                SlashRecords::<T>::contains_key(&who, slash_era),
                Error::<T>::NoSuchSlash
            );
            ensure!(
                !OpenAppeals::<T>::contains_key(&who, slash_era),
                Error::<T>::AppealAlreadyPending
            );
            let open = OpenAppealCount::<T>::get(&who);
            ensure!(open < MAX_OPEN_APPEALS, Error::<T>::TooManyOpenAppeals);

            let now = frame_system::Pallet::<T>::block_number();
            let era_now = EraNumber::<T>::get();
            // Appeal must be filed within SlashAppealWindow eras of the slash
            // Using blocks here: approximate 1 era = EraDuration blocks
            ensure!(
                era_now
                    < slash_era.saturating_add(
                        T::SlashAppealWindow::get()
                            .min(BlockNumberFor::<T>::from(255u32))
                            .try_into()
                            .unwrap_or(0u32)
                    ),
                Error::<T>::AppealWindowExpired
            );

            let record = SlashAppealRecord::<T> {
                slash_era,
                appealed_at: now,
                reason_hash,
            };
            // Legacy pointer holds the first pending appeal only; later eras never overwrite it.
            if !PendingSlashAppeals::<T>::contains_key(&who) {
                PendingSlashAppeals::<T>::insert(&who, record.clone());
            }
            OpenAppeals::<T>::insert(&who, slash_era, record);
            OpenAppealCount::<T>::insert(&who, open.saturating_add(1));

            Self::deposit_event(Event::SlashAppealed {
                who,
                slash_era,
                reason_hash,
            });
            Ok(())
        }

        /// V4: F-07 — Execute a governance-reviewed slash against an agent's locked stake.
        ///
        /// Agent stake is held via Currency::set_lock (LockableCurrency), NOT reserve.
        /// slash_reserved would return zero — wrong approach. Correct sequence:
        ///   1. Compute slash_amount = stake × bps / 10_000
        ///   2. Reduce the lock to (stake - slash_amount) so slash_amount becomes spendable
        ///   3. Withdraw slash_amount from the now-unlocked free balance → NegativeImbalance
        ///   4. Split 50/50: treasury half via SlashDestination::on_unbalanced, burn half by drop
        ///   5. Update AgentStake to the reduced amount
        ///
        /// Origin: Must be Root (governance Track 0 enactment).
        ///
        /// # Weight (#217)
        /// 16 reads: `AgentStake`, the `AgentStake` counter, `EraNumber`,
        /// `MAX_OPEN_APPEALS` (5) for the `OpenAppeals` prefix walk, `Locks` + account for
        /// `set_lock`/`remove_lock`, account + `TotalIssuance` for `Currency::withdraw`,
        /// `TotalIssuance` again for the burn half dropped below, the treasury account +
        /// `TotalIssuance` for `SlashDestination::on_unbalanced`, and
        /// `OnAgentSlashed::on_slashed`.
        ///
        /// 18 writes: `AgentStake` value and counter (the `remove` branch is the worst case —
        /// it writes the counter, the `insert` branch does not), `PendingSlashAppeals`,
        /// `OpenAppealCount`, `SlashRecords`, `MAX_OPEN_APPEALS` (5) for the `OpenAppeals`
        /// `clear_prefix`, then the balance side: `Locks` + account for the lock change,
        /// account + `TotalIssuance` for the withdraw, `TotalIssuance` for the burn-half
        /// imbalance drop, treasury account + `TotalIssuance` for the treasury half, and
        /// `AgentWeightSnapshot` for `on_slashed`.
        ///
        /// Root-gated, so this is not a fee surface — but it is still scheduled against a
        /// block's weight budget, and #195's cleanup made the old 5/5 an understatement of
        /// what a block must fit. spec 308 adds one read and one write: the
        /// `MessagingKey::take` on the eviction branch. Pinned as a floor by
        /// `declared_weight_execute_slash_covers_appeal_cleanup`.
        #[pallet::call_index(10)]
        #[pallet::weight(T::DbWeight::get().reads_writes(17, 19)
            .saturating_add(Weight::from_parts(100_000_000, 0)))]
        pub fn execute_slash(
            origin: OriginFor<T>,
            who: T::AccountId,
            bps: u32, // basis points of stake to slash, 1–10000 (100 bps = 1%)
        ) -> DispatchResult {
            ensure_root(origin)?;
            ensure!(bps > 0 && bps <= 10_000, Error::<T>::InvalidSlashBps);

            let stake = AgentStake::<T>::get(&who).ok_or(Error::<T>::NotRegistered)?;

            // slash_amount bounded: stake ≤ MaxStakePerAgent (1M CMN) × 10_000 / 10_000 = stake.
            // saturating_mul safe — no overflow at these magnitudes.
            let slash_amount: BalanceOf<T> = stake.saturating_mul(bps.into()) / 10_000u32.into();

            ensure!(
                slash_amount > BalanceOf::<T>::zero(),
                Error::<T>::InvalidSlashBps
            );

            let new_stake = stake.saturating_sub(slash_amount);

            // Step 1: Reduce or remove the lock, freeing slash_amount in the free balance.
            // Reducing set_lock immediately frees the delta in the account's free balance.
            // We do NOT update AgentStake yet — only do so after withdraw succeeds.
            if new_stake >= T::MinStake::get() {
                T::Currency::set_lock(AGENT_LOCK_ID, &who, new_stake, WithdrawReasons::all());
            } else {
                T::Currency::remove_lock(AGENT_LOCK_ID, &who);
            }

            // Step 2: Withdraw the now-free slash_amount.
            // AllowDeath: if slash leaves dust below ExistentialDeposit, let account die.
            // The ? here: if withdraw errors (theoretically impossible after lock-reduce),
            // the function returns Err and the lock change is the only committed state.
            // The agent's lock is reduced but AgentStake not yet updated — acceptable
            // since governance can re-run if needed, and the lock IS reduced correctly.
            let imbalance = T::Currency::withdraw(
                &who,
                slash_amount,
                WithdrawReasons::TRANSFER,
                ExistenceRequirement::AllowDeath,
            )?;
            let actually_slashed = imbalance.peek();

            // Step 3: Commit the new stake only after successful withdraw.
            // If slash drops below MinStake, remove the entry entirely rather than
            // inserting 0 — a zero-stake record would pollute AgentStake::iter()
            // in settle_era, wasting one storage read per era for a dead agent.
            if new_stake >= T::MinStake::get() {
                AgentStake::<T>::insert(&who, new_stake);
            } else {
                AgentStake::<T>::remove(&who);
                // spec 308: an evicted account is no longer an agent, so it must not keep a
                // published messaging key. It could not clear it itself (clearing requires
                // registration), and the key would silently reappear on re-registration
                // without a fresh MessagingKeySet for counterparties to notice.
                if MessagingKey::<T>::take(&who).is_some() {
                    Self::deposit_event(Event::MessagingKeyCleared { who: who.clone() });
                }
            }

            // Step 4: 50/50 split — treasury receives half, half burned on drop.
            let (treasury_imbalance, burn_imbalance) = imbalance.ration(50, 50);
            T::SlashDestination::on_unbalanced(treasury_imbalance);
            let burn = burn_imbalance.peek();
            let treasury = actually_slashed.saturating_sub(burn);
            drop(burn_imbalance); // NegativeImbalance drop → total_issuance -= burn

            // Clear any pending appeal — slash executed, appeal moot.
            PendingSlashAppeals::<T>::remove(&who);
            let _ = OpenAppeals::<T>::clear_prefix(&who, MAX_OPEN_APPEALS, None);
            OpenAppealCount::<T>::remove(&who);

            // Record the slash so it can be appealed (E22). Written after the clear above:
            // appeals filed against earlier slashes are moot, this one is fresh.
            // A second slash in the same era accumulates rather than overwrites (#216), so the
            // record shows everything governance took that era. Clamped to 10_000 bps (100%,
            // the BPS denominator): a raw sum above it is not a percentage anyone can read.
            SlashRecords::<T>::mutate(&who, EraNumber::<T>::get(), |rec| {
                *rec = Some(rec.unwrap_or(0).saturating_add(bps).min(10_000));
            });

            // Notify emissions pallet to zero the weight snapshot.
            // This prevents the slashed agent from overclaiming using the stale
            // pre-slash weight in do_claim() before the next settle_era runs.
            T::OnAgentSlashed::on_slashed(&who);

            Self::deposit_event(Event::SlashExecuted {
                who,
                amount: actually_slashed,
                burn,
                treasury,
            });
            Ok(())
        }

        /// Declare that two accounts share a funding lineage, merging them into one
        /// lineage group. Escrow between any two members of a group is not qualifying
        /// volume and therefore cannot size the emission pot (#164, D7).
        ///
        /// Root-gated because it is an assertion about facts the chain cannot see. The
        /// faucet knows which addresses it dripped to in one session; `pallet_balances`
        /// exposes no transfer hook, so the chain does not. This is how that knowledge is
        /// written down. The lineage that IS visible on chain — a payer<->worker cycle
        /// inside one era — needs no declaration and is detected automatically.
        ///
        /// Note this is a *sizing* control, not a punishment: linking two accounts does not
        /// slash them, block their escrow, or zero their individual weight. It only stops
        /// their mutual trade from being counted as evidence that the chain did real work.
        #[pallet::call_index(11)]
        #[pallet::weight(T::DbWeight::get().reads_writes(8, 1)
            .saturating_add(Weight::from_parts(30_000_000, 0)))]
        pub fn link_funding_lineage(
            origin: OriginFor<T>,
            a: T::AccountId,
            b: T::AccountId,
        ) -> DispatchResult {
            ensure_root(origin)?;
            // Both guards fire before any write.
            let root_a = Self::lineage_root(&a).ok_or(Error::<T>::LineageTooDeep)?;
            let root_b = Self::lineage_root(&b).ok_or(Error::<T>::LineageTooDeep)?;
            ensure!(root_a != root_b, Error::<T>::LineageAlreadyLinked);

            LineageParent::<T>::insert(&root_b, &root_a);
            // Flatten the two arguments onto the new root. This does not make the
            // structure depth-1 in general — merging a chain of groups still deepens it —
            // but it keeps the common "link these two accounts" case at depth 1, and the
            // walk fails closed if depth is ever exceeded anyway.
            if a != root_a {
                LineageParent::<T>::insert(&a, &root_a);
            }
            if b != root_a {
                LineageParent::<T>::insert(&b, &root_a);
            }
            Self::deposit_event(Event::FundingLineageLinked { a, b, root: root_a });
            Ok(())
        }

        /// Detach an account from its funding-lineage group, making it a lineage root
        /// again. Anything linked *under* it stays with it.
        ///
        /// Exists because `link_funding_lineage` is an assertion about off-chain facts and
        /// assertions can be wrong. Without an inverse, one mistyped address would
        /// permanently disqualify two honest agents' mutual trade from ever sizing the pot,
        /// with no way back short of a runtime upgrade. Linking is not a punishment and
        /// neither is unlinking a pardon — both only change what counts as evidence that
        /// the chain did independent work.
        #[pallet::call_index(12)]
        #[pallet::weight(T::DbWeight::get().reads_writes(1, 1)
            .saturating_add(Weight::from_parts(20_000_000, 0)))]
        pub fn unlink_funding_lineage(origin: OriginFor<T>, who: T::AccountId) -> DispatchResult {
            ensure_root(origin)?;
            ensure!(
                LineageParent::<T>::contains_key(&who),
                Error::<T>::LineageNotLinked
            );
            LineageParent::<T>::remove(&who);
            Self::deposit_event(Event::FundingLineageUnlinked { who });
            Ok(())
        }

        /// spec 308 (D14): publish or rotate this agent's 32-byte X25519 messaging public key.
        ///
        /// Only a registered agent may call it, so every key on chain belongs to an account
        /// that has burned a registration fee and locked stake — a key directory that is as
        /// sybil-resistant as the agent set itself. Calling it again replaces the key
        /// (rotation); there is no cooldown because a compromised key must be replaceable
        /// immediately. No deposit and no fee beyond the transaction fee: see `MessagingKey`.
        #[pallet::call_index(13)]
        #[pallet::weight(T::DbWeight::get().reads_writes(1, 1)
            .saturating_add(Weight::from_parts(30_000_000, 0)))]
        pub fn set_messaging_key(origin: OriginFor<T>, key: [u8; 32]) -> DispatchResult {
            let who = ensure_signed(origin)?;
            // `is_agent` is the same predicate pallet-messages uses for "registered".
            ensure!(Self::is_agent(&who), Error::<T>::NotRegistered);
            MessagingKey::<T>::insert(&who, key);
            Self::deposit_event(Event::MessagingKeySet { who, key });
            Ok(())
        }

        /// spec 308 (D14): remove this agent's messaging key. After this, counterparties
        /// have nothing to encrypt to and fall back to plaintext or hash-only messages.
        #[pallet::call_index(14)]
        #[pallet::weight(T::DbWeight::get().reads_writes(2, 1)
            .saturating_add(Weight::from_parts(20_000_000, 0)))]
        pub fn clear_messaging_key(origin: OriginFor<T>) -> DispatchResult {
            let who = ensure_signed(origin)?;
            ensure!(Self::is_agent(&who), Error::<T>::NotRegistered);
            ensure!(
                MessagingKey::<T>::contains_key(&who),
                Error::<T>::NoMessagingKey
            );
            MessagingKey::<T>::remove(&who);
            Self::deposit_event(Event::MessagingKeyCleared { who });
            Ok(())
        }
    } // end #[pallet::call]

    // ─── Public cross-pallet helpers ─────────────────────────────────────────
    impl<T: Config> Pallet<T>
    where
        BalanceOf<T>: From<u32>,
    {
        /// Called by pallet-escrow when a new agreement is created.
        pub fn increment_active_escrow(provider: &T::AccountId) -> DispatchResult {
            ensure!(
                AgentStake::<T>::contains_key(provider),
                Error::<T>::NotRegistered
            );
            ActiveEscrowCount::<T>::mutate(provider, |c| *c = c.saturating_add(1));
            Ok(())
        }

        /// Called by pallet-escrow on every agreement settlement path.
        pub fn decrement_active_escrow(provider: &T::AccountId) {
            ActiveEscrowCount::<T>::mutate(provider, |c| *c = c.saturating_sub(1));
        }

        /// Returns true if the account is a registered agent.
        pub fn is_agent(who: &T::AccountId) -> bool {
            AgentStake::<T>::contains_key(who)
        }

        /// Called by pallet-escrow confirm_delivery.
        /// Accumulates era volume, tracks buyer diversity, increments completions,
        /// and triggers rank promotions if thresholds are met.
        pub fn add_era_escrow_volume(
            agent: &T::AccountId,
            buyer: &T::AccountId,
            amount: BalanceOf<T>,
        ) -> DispatchResult {
            let stake = AgentStake::<T>::get(agent).ok_or(Error::<T>::NotRegistered)?;

            // Accumulate era volume. The PRE-escrow total is kept: the diversity cap below
            // must judge the agent by the volume it had *before* this deal, not after.
            let prior_total = EraEscrowVolume::<T>::get(agent);
            let era_total = prior_total.saturating_add(amount);
            EraEscrowVolume::<T>::insert(agent, era_total);

            // Record WHO the volume came from, not just how much (spec 306, D7).
            // `qualifying_era_volume` needs the per-counterparty split to drop a ring's
            // volume from the emission pot while keeping an honest customer's.
            //
            // An entry stamped with an older era is overwritten rather than added to: that
            // is what makes a clear that did not finish harmless instead of inflationary.
            let this_era = EraNumber::<T>::get();
            EraPairVolume::<T>::mutate(agent, buyer, |v| {
                if v.0 == this_era {
                    v.1 = v.1.saturating_add(amount);
                } else {
                    *v = (this_era, amount);
                }
            });

            // Buyer diversity via bloom filter
            let buyer_bytes = buyer.encode();
            let hash = sp_io::hashing::blake2_256(&buyer_bytes);
            let slot = u32::from_le_bytes([hash[0], hash[1], hash[2], hash[3]]) % 65_536;
            if !EraSeenBuyerSlots::<T>::get(agent, slot) {
                // Stake-weighted diversity cap: diversity credit stops above stake × ratio.
                //
                // ROUND14 ordering fix (two changes, both honest-agent-protecting):
                //  1. Test `prior_total`, not the post-escrow total. Charging a buyer for the
                //     volume its own escrow just added denied credit to the counterparty that
                //     happens to straddle the cap — the boundary buyer paid for crossing it.
                //  2. Mark the bloom slot only when credit is actually granted. Marking first
                //     burned the slot permanently for the era, so an honest buyer whose first
                //     escrow landed while the agent was over the cap could never earn credit
                //     later in that era even after the agent raised its stake (which raises
                //     the cap). The slot is an "already credited" record, not a "seen" record.
                //
                // Known limitation, deliberately NOT closed here (ROUND13 §5, B1): an attacker
                // can still front-load k minimum-size escrows from k sybil buyers while volume
                // is low, bank full diversity credit, then push unbounded volume. Closing that
                // requires redefining diversity as economic rather than AccountId distinctness
                // — a design decision, not a reordering.
                let ratio = T::MaxVolToStakeRatio::get() as u128;
                let diversity_ok = ratio == 0 || {
                    let prior_vol_u128: u128 =
                        sp_runtime::traits::UniqueSaturatedInto::<u128>::unique_saturated_into(
                            prior_total,
                        );
                    let stake_u128: u128 =
                        sp_runtime::traits::UniqueSaturatedInto::<u128>::unique_saturated_into(
                            stake,
                        );
                    prior_vol_u128 <= stake_u128.saturating_mul(ratio)
                };
                if diversity_ok {
                    EraSeenBuyerSlots::<T>::insert(agent, slot, true);
                    EraUniqueBuyers::<T>::mutate(agent, |c| *c = c.saturating_add(1));
                }
            }

            // Increment lifetime completions
            let completions = CompletedAgreements::<T>::mutate(agent, |c| {
                *c = c.saturating_add(1);
                *c
            });

            // Check rank promotions
            Self::maybe_promote(agent, completions, stake)?;

            // Credit orchestrator (if any) with this volume
            if let Some(orch) = T::OrchestratorLookup::get_orchestrator(agent) {
                T::OrchestratorLookup::add_orchestrator_volume(&orch, amount);
            }

            Self::deposit_event(Event::EraVolumeAdded {
                who: agent.clone(),
                amount,
                era_total,
            });
            Ok(())
        }

        // ── Funding lineage & qualifying volume (spec 306, D7 / #164) ────────

        /// Maximum links walked when resolving a lineage root.
        ///
        /// `link_funding_lineage` attaches one root under another, and repeated merges do
        /// build depth — `link(b,c)` then `link(x,b)` then `link(y,x)` is already a chain
        /// of three — so the bound is reachable in principle and the walk needs a defined
        /// behaviour at it, not an assumption that it never happens.
        ///
        /// **Truncation fails CLOSED.** Under D7 the unsafe direction is to decide two
        /// accounts are *unlinked*: that lets their mutual volume size the emission pot.
        /// So a walk that runs out of budget without reaching a root reports the pair as
        /// linked and drops the volume. Being over-cautious costs a smaller pot; being
        /// under-cautious mints against a ring.
        const MAX_LINEAGE_DEPTH: u32 = 16;

        /// Maximum (provider, buyer) pairs examined per provider when sizing qualifying
        /// volume. Bounds the cost of a permissionless `settle_era`; overshooting the
        /// bound under-counts volume, which lowers the emission ceiling.
        const MAX_QUALIFYING_PAIRS: u32 = 512;

        /// Resolve an account's funding-lineage root, or `None` if the walk ran past
        /// `MAX_LINEAGE_DEPTH` without finding one. An account with no parent is its own
        /// root, so an unlinked chain answers in a single read.
        pub fn lineage_root(who: &T::AccountId) -> Option<T::AccountId> {
            let mut cur = who.clone();
            for _ in 0..Self::MAX_LINEAGE_DEPTH {
                match LineageParent::<T>::get(&cur) {
                    Some(parent) => cur = parent,
                    None => return Some(cur),
                }
            }
            None
        }

        /// True when two accounts have been declared to share a funding lineage — or when
        /// the lineage walk could not prove that they do not. See `MAX_LINEAGE_DEPTH`.
        pub fn same_funding_lineage(a: &T::AccountId, b: &T::AccountId) -> bool {
            if a == b {
                return true;
            }
            // Fast path: neither account is in any lineage group. This is the whole chain
            // until root declares one, so the common case costs two reads and no walk.
            if !LineageParent::<T>::contains_key(a) && !LineageParent::<T>::contains_key(b) {
                return false;
            }
            match (Self::lineage_root(a), Self::lineage_root(b)) {
                (Some(ra), Some(rb)) => ra == rb,
                // Undecidable, so assume linked. Fail closed.
                _ => true,
            }
        }

        /// Qualifying escrow volume for ONE provider this era.
        ///
        /// This is the volume that is allowed to size the era's emission pot. It is NOT the
        /// agent's weight input — `EraEscrowVolume` still feeds `work_score` unchanged, so
        /// an agent's *share* of the pot is computed exactly as before. What changes is how
        /// big the pot is allowed to be.
        ///
        /// Volume is dropped when:
        ///
        /// 1. **The provider is ring-flagged.** Same test `drain_era_maps` already applies
        ///    to build `EraRingSnapshot`: active this era, `EraUniqueBuyers <= 1`, and
        ///    established (`CompletedAgreements > 1`). Until spec 306 that flag did nothing
        ///    to payouts — it nudged `CompletionFeeBps` by 25 bps and stopped there, which
        ///    is why #164's ring was flagged and paid anyway. It is load-bearing now.
        ///
        ///    The `established` clause is kept deliberately rather than tightened. Dropping
        ///    it would zero the qualifying volume of every genuinely new agent in its first
        ///    era, which is the honest-onboarding case, not the attack. A first-era ring is
        ///    already bounded by the alpha rule itself: its volume qualifies at most 1:1, so
        ///    it can never mint more than the escrow it actually settled — which is exactly
        ///    the bound #164 asks for.
        ///
        /// 2. **The counterparty traded in both directions this era** — a payer<->worker
        ///    cycle. A pays B and B pays A inside one era is money going in a circle, and
        ///    neither leg is evidence of demand.
        ///
        /// 3. **The counterparty shares a declared funding lineage** with the provider
        ///    (see `LineageParent`).
        pub fn qualifying_volume_of(agent: &T::AccountId) -> BalanceOf<T> {
            let Some(stake) = AgentStake::<T>::get(agent) else {
                return Zero::zero();
            };
            let completions = CompletedAgreements::<T>::get(agent);
            let is_established = completions > 1;
            if is_established && EraUniqueBuyers::<T>::get(agent) <= 1 {
                return Zero::zero();
            }

            let this_era = EraNumber::<T>::get();
            let mut total: BalanceOf<T> = Zero::zero();
            let mut examined: u32 = 0;
            for (buyer, (era, vol)) in EraPairVolume::<T>::iter_prefix(agent) {
                // Bound the walk. `settle_era` is permissionless and economically
                // essential, and the number of (provider, buyer) pairs is set by how many
                // throwaway buyer accounts somebody funded, not by any Config constant —
                // so an unbounded walk here is a liveness attack on settlement itself.
                // Stopping early UNDER-counts volume, which lowers the emission ceiling.
                // That is the safe direction to fail in.
                examined = examined.saturating_add(1);
                if examined > Self::MAX_QUALIFYING_PAIRS {
                    break;
                }
                // A stale entry from an earlier era is not this era's work. See the note
                // on `EraPairVolume` for why residue is possible at all.
                if era != this_era {
                    continue;
                }
                // Reciprocal edge this era → circular, drop both legs (this call drops
                // one leg; the counterparty's own call drops the other).
                let (rev_era, rev_vol) = EraPairVolume::<T>::get(&buyer, agent);
                if rev_era == this_era && rev_vol > Zero::zero() {
                    continue;
                }
                if Self::same_funding_lineage(agent, &buyer) {
                    continue;
                }
                total = total.saturating_add(vol);
            }

            // Cap qualifying volume at the agent's own staked capital times
            // `MaxVolToStakeRatio` — the same ratio that already bounds diversity credit.
            //
            // WHY. Without this the bound is on *flow*, and flow is free to recycle. A
            // provider and one unregistered buyer can settle escrow, transfer the funds
            // straight back (the chain has no transfer hook to see it), and settle again,
            // as many times as the era has blocks for. The only cost is the completion fee
            // — 25 bps at launch — so 250 CMN of fees would unlock a 100 000 CMN pot. That
            // is a large improvement on #164, where the pot was free, but it is nowhere
            // near "an era cannot mint more than the work it measured".
            //
            // Tying the ceiling to locked stake converts the cost from a fee into capital:
            // sizing a 100 000 CMN pot needs 10 000 CMN staked, locked, and subject to the
            // 7-day unstake cooldown and to slashing. It does not make wash trading
            // impossible — nothing in a pallet can, while plain transfers are invisible —
            // and the residual gap is tracked rather than papered over.
            let ratio = T::MaxVolToStakeRatio::get();
            if ratio == 0 {
                return total;
            }
            let stake_ceiling = stake.saturating_mul(ratio.into());
            total.min(stake_ceiling)
        }

        /// Total qualifying escrow volume settled this era, across all providers.
        ///
        /// Read by `pallet-emissions::settle_era` to bound the era emission at
        /// `alpha x qualifying_volume` (D7). Must be called BEFORE `drain_era_maps`, which
        /// clears the maps it reads.
        ///
        /// Cost: one pass over `EraPairVolume`, whose cardinality is the number of distinct
        /// (provider, buyer) pairs that settled an agreement this era. `settle_era` already
        /// walks every registered agent and `drain_era_maps` already walks every era map, so
        /// this adds a pass of the same order rather than a new class of cost.
        pub fn qualifying_era_volume() -> BalanceOf<T> {
            let mut total: BalanceOf<T> = Zero::zero();
            for (agent, _stake) in AgentStake::<T>::iter() {
                total = total.saturating_add(Self::qualifying_volume_of(&agent));
            }
            total
        }

        /// Heartbeat floor multiplier for the emission formula.
        /// Returns 10–100 (percentage of floor to apply).
        pub fn heartbeat_multiplier(who: &T::AccountId) -> u128 {
            let last = LastHeartbeat::<T>::get(who);
            let now = frame_system::Pallet::<T>::block_number();
            let since = now.saturating_sub(last);
            let grace = T::HeartbeatGracePeriod::get();
            let decay = T::HeartbeatDecayPeriod::get();

            if since <= grace {
                return 100;
            }
            let over: u128 = since
                .saturating_sub(grace)
                .min(decay)
                .try_into()
                .unwrap_or(0);
            let decay_u128: u128 = decay.try_into().unwrap_or(1).max(1);
            let pct = 100u128.saturating_sub(90u128 * over / decay_u128);
            pct.max(10)
        }

        /// Called by emissions settle_era. Snapshots ring/active counts then clears
        /// all per-era storage and increments EraNumber.
        pub fn drain_era_maps(era: u32) {
            let mut ring_snap: u32 = 0;
            let mut active_snap: u32 = 0;

            for (agent, vol) in EraEscrowVolume::<T>::iter() {
                if vol > Zero::zero() {
                    active_snap = active_snap.saturating_add(1);
                    // Ring signal: only flag established agents (> 1 lifetime completion).
                    // New agents naturally have unique_buyers=1 in their first era —
                    // excluding them prevents false positives at launch.
                    let completions = CompletedAgreements::<T>::get(&agent);
                    let is_established = completions > 1;
                    if is_established && EraUniqueBuyers::<T>::get(&agent) <= 1 {
                        ring_snap = ring_snap.saturating_add(1);
                    }
                }
            }

            EraRingSnapshot::<T>::put(ring_snap);
            EraActiveSnapshot::<T>::put(active_snap);

            // Clear all per-era maps with headroom for churn
            let registered = AgentStake::<T>::count();
            let bound = registered.saturating_add(registered / 5).max(100);
            let _ = EraEscrowVolume::<T>::clear(bound, None);
            let _ = EraUniqueBuyers::<T>::clear(bound, None);
            // Same headroom as EraSeenBuyerSlots: a provider can hold one pair entry per
            // distinct buyer it served this era, so the per-agent factor matches.
            let _ = EraPairVolume::<T>::clear(bound.saturating_mul(128), None);
            let _ = EraGovParticipation::<T>::clear(bound, None);
            let _ = EraSeenBuyerSlots::<T>::clear(bound.saturating_mul(128), None);
            // ROUND14: the dedup set is exactly bounded — record_gov_vote refuses to add a
            // (agent, poll) entry once EraGovParticipation hits MaxProposalsPerEra, so an
            // agent can hold at most that many keys. Clearing the same headroom multiple
            // keeps the guard honest across eras: a leftover entry would silently deny an
            // agent credit for a referendum that is still live in the next era.
            let per_agent = T::MaxProposalsPerEra::get().max(1);
            let _ = EraGovVotedPolls::<T>::clear(bound.saturating_mul(per_agent), None);

            EraNumber::<T>::mutate(|n| *n = n.saturating_add(1));
            Self::deposit_event(Event::EraMapsCleared {
                era,
                ring_snap,
                active_snap,
            });
        }

        // ── Internal ─────────────────────────────────────────────────────────
        fn maybe_promote(
            who: &T::AccountId,
            completions: u32,
            stake: BalanceOf<T>,
        ) -> DispatchResult {
            let rank = T::AgentCollective::rank_of(who).unwrap_or(0);

            // Rank 0 → 1: first escrow completion proves agent is operational
            if rank == 0 && completions >= 1 {
                T::AgentCollective::promote(who)?;
                // rank_bps unchanged (0 and 1 both = 10000). No snapshot clear needed.
            }
            // Rank 1 → 2: crossed Full-tier stake threshold (+20% rank_bps)
            else if rank == 1 && stake >= T::FullFloorStake::get() {
                T::AgentCollective::promote(who)?;
                // rank_bps increases 10000 → 12000. Zero snapshot to prevent
                // MasterChef overclaim: prior-era deltas would be multiplied
                // by the new higher weight if snapshot is not zeroed here.
                T::OnStakeChanged::on_stake_changed(who);
            }
            // Rank 2 → 3: completions + span gate + oracle score (+25% rank_bps)
            else if rank == 2
                && completions >= T::Rank3MinCompletions::get()
                && Self::span_gate_passed(who)
                && Self::oracle_gate_passed(who)
            {
                T::AgentCollective::promote(who)?;
                // rank_bps increases 12000 → 15000. Same MasterChef protection.
                T::OnStakeChanged::on_stake_changed(who);
            }
            Ok(())
        }

        fn span_gate_passed(who: &T::AccountId) -> bool {
            let registered_at = StakeRegisteredAt::<T>::get(who);
            let now = frame_system::Pallet::<T>::block_number();
            now.saturating_sub(registered_at) >= T::Rank3SpanGate::get()
        }

        fn oracle_gate_passed(who: &T::AccountId) -> bool {
            let min_score = T::MinRank3OracleScore::get();
            min_score == 0 || T::OracleScoreGate::best_score(who) >= min_score
        }
    }
}
