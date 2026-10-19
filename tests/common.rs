//! Common utilities for integration tests.

#![allow(dead_code)]

use frame_support::{
    parameter_types,
    traits::{ConstU16, ConstU32, ConstU64, ConstU8, Everything},
};
use sp_core::H256;
use sp_io::TestExternalities;
use sp_runtime::{
    traits::{BlakeTwo256, IdentityLookup},
    BuildStorage,
};

// ── Test accounts ────────────────────────────────────────────────────────────
pub const ALICE: u64 = 1;
pub const BOB: u64 = 2;
pub const CAROL: u64 = 3;
pub const DAVE: u64 = 4;
pub const EVE: u64 = 5;
pub const FRANK: u64 = 6;
pub const ROOT: u64 = 999;

// ── Token amounts ─────────────────────────────────────────────────────────────
pub const CMN: u64 = 1_000_000_000_000; // 1 CMN = 10^12 raw
pub const MIN_STAKE: u64 = 1_000 * CMN;
pub const FULL_STAKE: u64 = 10_000 * CMN;
#[allow(dead_code)]
pub const RICH_STAKE: u64 = 100_000 * CMN;

// ── Block helpers ─────────────────────────────────────────────────────────────
pub fn advance_blocks(n: u64) {
    for _ in 0..n {
        let current = frame_system::Pallet::<TestRuntime>::block_number();
        frame_system::Pallet::<TestRuntime>::set_block_number(current + 1);
    }
}

pub fn go_to_block(n: u64) {
    frame_system::Pallet::<TestRuntime>::set_block_number(n);
}

/// Advance past EraDuration (100 blocks in tests) and call permissionless settle_era.
/// settle_era is now ensure_signed with an era timing gate — must be called by a
/// signed account after EraDuration blocks have elapsed since the era started.
pub fn settle_era(caller: u64) {
    let current = frame_system::Pallet::<TestRuntime>::block_number();
    // EraDuration = 100 in test runtime (ConstU64<100>)
    frame_system::Pallet::<TestRuntime>::set_block_number(current + 100);
    frame_support::assert_ok!(pallet_emissions::Pallet::<TestRuntime>::settle_era(
        frame_system::RawOrigin::Signed(caller).into()
    ));
}

// ── Test runtime ─────────────────────────────────────────────────────────────

use frame_support::construct_runtime;

type Block = frame_system::mocking::MockBlock<TestRuntime>;

construct_runtime!(
    pub enum TestRuntime {
        System:       frame_system,
        Balances:     pallet_balances,
        Agents:       pallet_agents,
        Escrow:       pallet_escrow,
        Oracle:       pallet_oracle,
        Emissions:    pallet_emissions,
        AutoParams:   pallet_auto_params,
        Orchestrator: pallet_orchestrator,
        Messages:     pallet_messages,
    }
);

// ── Config impls ──────────────────────────────────────────────────────────────

impl frame_system::Config for TestRuntime {
    type BaseCallFilter = Everything;
    type BlockWeights = ();
    type BlockLength = ();
    type RuntimeOrigin = RuntimeOrigin;
    type RuntimeCall = RuntimeCall;
    type RuntimeTask = RuntimeTask;
    type Nonce = u64;
    type Hash = H256;
    type Hashing = BlakeTwo256;
    type AccountId = u64;
    type Lookup = IdentityLookup<Self::AccountId>;
    type Block = Block;
    type RuntimeEvent = RuntimeEvent;
    type BlockHashCount = ConstU64<250>;
    type DbWeight = ();
    type Version = ();
    type PalletInfo = PalletInfo;
    type AccountData = pallet_balances::AccountData<u64>;
    type OnNewAccount = ();
    type OnKilledAccount = ();
    type SystemWeightInfo = ();
    type SS58Prefix = ConstU16<42>;
    type OnSetCode = ();
    type MaxConsumers = ConstU32<16>;
    type SingleBlockMigrations = ();
    type MultiBlockMigrator = ();
    type PreInherents = ();
    type PostInherents = ();
    type PostTransactions = ();
    type ExtensionsWeightInfo = ();
}

impl pallet_balances::Config for TestRuntime {
    type MaxLocks = ConstU32<50>;
    type MaxReserves = ConstU32<50>;
    type ReserveIdentifier = [u8; 8];
    type Balance = u64;
    type RuntimeEvent = RuntimeEvent;
    type DustRemoval = ();
    type ExistentialDeposit = ConstU64<1>;
    type AccountStore = System;
    type WeightInfo = ();
    type FreezeIdentifier = ();
    type MaxFreezes = ConstU32<0>;
    type RuntimeHoldReason = ();
    type RuntimeFreezeReason = ();
    type DoneSlashHandler = ();
}

// ── Agents Config ─────────────────────────────────────────────────────────────

impl pallet_agents::Config for TestRuntime {
    type RuntimeEvent = RuntimeEvent;
    type Currency = Balances;
    type MinStake = ConstU64<{ 1_000 * CMN }>;
    type FullFloorStake = ConstU64<{ 10_000 * CMN }>;
    type MaxStakePerAgent = ConstU64<{ 1_000_000 * CMN }>;
    type UnstakeCooldown = ConstU64<100>;
    type BaseRegistrationFee = ConstU64<{ 50 * CMN }>;
    type MaxRegistrationsPerBlock = ConstU32<10>;
    type MaxAgents = ConstU32<1000>;
    type Rank3MinCompletions = ConstU32<3>;
    type MinRank3OracleScore = ConstU32<0>;
    type Rank3SpanGate = ConstU64<0>;
    type MaxVolToStakeRatio = ConstU32<10>;
    type HeartbeatGracePeriod = ConstU64<100>;
    type HeartbeatDecayPeriod = ConstU64<1000>;
    type OnAgentRegistered = Emissions;
    type OnAgentSlashed = Emissions; // zeros weight snapshot on slash
    type OnStakeChanged = Emissions; // zeros snapshot before stake increase (MasterChef fix)
    type AgentCollective = ();
    type OracleScoreGate = ();
    type GovVoteVerifier = MockGovVoteVerifier;
    type IdentityHandler = ();
    type OrchestratorLookup = TestOrchestratorBridge;
    type MaxUriLen = ConstU32<256>;
    type MaxNameLen = ConstU32<64>;
    type MaxCapabilitiesPerAgent = ConstU32<20>;
    type MaxDelegationPeriod = ConstU64<100_000>;
    type SlashAppealWindow = ConstU64<10>;
    // V4: new Config types
    type MaxProposalsPerEra = ConstU32<20>;
    type SlashDestination = (); // test: slash is fully burned (no treasury in test runtime)
}

// ── Governance-vote verifier mock (ROUND14) ──────────────────────────────────
//
// Replaces the `()` impl, which returned `true` for every call and was wired into all
// six mocks — the reason the governance-participation guard reached master with no
// behavioural coverage at all.
//
// The two facts the real `ConvictionVotingBridge` reads are modelled as SEPARATE state,
// because upstream keeps them separate and that gap is the whole vector: a vote leaves
// `pallet_conviction_voting::VotingFor` only when the voter calls `remove_vote`, so it
// long outlives the referendum it was cast on. `conclude_poll` below reproduces that —
// it ends the poll and deliberately leaves the vote in place.
thread_local! {
    /// (voter, poll_index) pairs held as `Casting` votes — mirrors `VotingFor`.
    static HELD_VOTES: core::cell::RefCell<std::collections::BTreeSet<(u64, u32)>> =
        const { core::cell::RefCell::new(std::collections::BTreeSet::new()) };
    /// Polls for which `Polling::as_ongoing` would return `Some`.
    static ONGOING_POLLS: core::cell::RefCell<std::collections::BTreeSet<u32>> =
        const { core::cell::RefCell::new(std::collections::BTreeSet::new()) };
}

pub struct MockGovVoteVerifier;
impl pallet_agents::pallet::GovVoteVerifier<u64> for MockGovVoteVerifier {
    fn has_live_vote_on(who: &u64, poll_index: u32) -> bool {
        HELD_VOTES.with(|v| v.borrow().contains(&(*who, poll_index)))
            && ONGOING_POLLS.with(|p| p.borrow().contains(&poll_index))
    }
}

/// `who` votes on `poll`, and `poll` is ongoing — the honest case.
pub fn cast_live_vote(who: u64, poll: u32) {
    HELD_VOTES.with(|v| {
        v.borrow_mut().insert((who, poll));
    });
    ONGOING_POLLS.with(|p| {
        p.borrow_mut().insert(poll);
    });
}

/// The referendum finishes. The vote itself survives, exactly as on chain.
pub fn conclude_poll(poll: u32) {
    ONGOING_POLLS.with(|p| {
        p.borrow_mut().remove(&poll);
    });
}

/// Clear verifier state. Called from `new_test_ext` — the harness reuses threads.
pub fn reset_gov_state() {
    HELD_VOTES.with(|v| v.borrow_mut().clear());
    ONGOING_POLLS.with(|p| p.borrow_mut().clear());
}

// Orchestrator bridge for agents pallet
pub struct TestOrchestratorBridge;
impl pallet_agents::pallet::OrchestratorLookup<u64, u64> for TestOrchestratorBridge {
    fn get_orchestrator(sub_agent: &u64) -> Option<u64> {
        pallet_orchestrator::SubAgentToOrchestrator::<TestRuntime>::get(sub_agent)
    }
    fn add_orchestrator_volume(orchestrator: &u64, amount: u64) {
        pallet_orchestrator::Pallet::<TestRuntime>::add_orchestrator_volume(orchestrator, amount);
    }
}

// ── Escrow Config ─────────────────────────────────────────────────────────────

impl pallet_escrow::Config for TestRuntime {
    type RuntimeEvent = RuntimeEvent;
    type MaxAgreementsPerPair = ConstU32<25>;
    type MaxAgreementSpan = ConstU64<10_000>;
    type MinAgreementAmount = ConstU64<CMN>;
    type MinDeliveryBlocks = ConstU64<5>;
    type BuyerResponseWindow = ConstU64<100>;
    type DisputeResponseWindow = ConstU64<100>;
    type DisputeTimeoutWindow = ConstU64<500>;
    type DisputeBountyBps = ConstU32<200>;
    type DisputeBurnBps = ConstU32<0>;
    type MinDisputeBounty = ConstU64<CMN>;
    type CompletionFeeProvider = ConstU32<0>;
    type DisputeOracle = Oracle;
    type DisputeCallback = Escrow;
    type FeeDestination = (); // integration test: fee burned (no treasury mock)
}

// ── Oracle Config ─────────────────────────────────────────────────────────────

impl pallet_oracle::Config for TestRuntime {
    type RuntimeEvent = RuntimeEvent;
    type MinOracleBounty = ConstU64<CMN>;
    type MaxOpenRequests = ConstU32<1000>;
    type MinConsensusThreshold = ConstU8<50>;
    type MinChallengeWindow = ConstU64<1>;
    type MaxResponsesPerRequest = ConstU32<100>;
    type DisputeCallback = Escrow;
    type CapabilityChecker = ();
    type MaxBatchSubmissions = ConstU32<20>;
}

// ── Emissions Config ──────────────────────────────────────────────────────────

pub struct TestAutoParams;
impl pallet_auto_params::pallet::AutoParamsProvider for TestAutoParams {
    fn completion_fee_bps() -> u32 {
        pallet_auto_params::Pallet::<TestRuntime>::live_completion_fee_bps()
    }
    fn alpha() -> u32 {
        pallet_auto_params::Pallet::<TestRuntime>::live_alpha()
    }
    fn beta() -> u32 {
        pallet_auto_params::Pallet::<TestRuntime>::live_beta()
    }
    fn floor_bps() -> u32 {
        pallet_auto_params::Pallet::<TestRuntime>::live_floor_bps()
    }
    fn min_score_eligible() -> u32 {
        pallet_auto_params::Pallet::<TestRuntime>::live_min_score_eligible()
    }
    /// Reads storage, exactly as the runtime's AutoParamsImpl does. If this mock hardcoded
    /// the value instead, an integration test could set alpha through `set_param` and see
    /// no effect — which is the shape of the defect that shipped in this method's first
    /// version and is why the trait method has no default.
    fn emission_volume_alpha_bps() -> u32 {
        pallet_auto_params::Pallet::<TestRuntime>::live_emission_volume_alpha_bps()
    }
}

pub struct TestOracleCounters;
impl pallet_emissions::pallet::OracleCounters for TestOracleCounters {
    fn drain_era_counters() -> (u32, u32) {
        pallet_oracle::Pallet::<TestRuntime>::drain_era_counters()
    }
}

pub struct TestOrchestratorEmissions;
impl pallet_emissions::pallet::OrchestratorEmissions<u64> for TestOrchestratorEmissions {
    fn compute_weights(multiplier: u32) -> (u128, u32) {
        pallet_orchestrator::Pallet::<TestRuntime>::compute_era_orchestrator_weights(multiplier)
    }
    fn settle(orch_emission: u64, orch_weight: u128) {
        if orch_weight > 0 {
            pallet_orchestrator::Pallet::<TestRuntime>::settle_orchestrator_era(
                orch_emission,
                orch_weight,
            );
        }
    }
}

// Supply cap must fit in u64. Use 10B CMN (10^13 * 10^4 = 10^16) — fits in u64.
// Real cap is 100B CMN but that overflows u64. Tests use scaled-down cap.
parameter_types! {
    pub const SupplyCapIntTest: u64 = 10_000_000_000_000_000_000; // ~10B CMN, fits in u64
    pub const UnitVolumeInt:    u64 = 1_000 * CMN;
}

impl pallet_emissions::Config for TestRuntime {
    type RuntimeEvent = RuntimeEvent;
    type Currency = Balances;
    type SupplyCap = SupplyCapIntTest;
    type EraDuration = ConstU64<100>;
    type InitialEmissionsPerEra = ConstU64<1_000_000_000_000_000>;
    type TargetEmissionPerAgent = ConstU64<10_000_000_000_000>;
    type FloorEmissionPerEra = ConstU64<100_000_000_000_000>;
    type OracleBonusBps = ConstU32<2_000>;
    type MaxProposalsPerEra = ConstU32<10>;
    type UnitVolume = UnitVolumeInt;
    type VelocityBonusBps = ConstU32<0>; // +30% weight bonus at full capital deployment
                                         // Balance-typed (Get<BalanceOf<Self>>), and Balance is u64 here — so ConstU64,
                                         // not ConstU32. Value unchanged: 0 keeps the floor gate disabled in integration tests.
    type MinQualifyingVol = ConstU64<0>; // disabled in integration tests
                                         // V4: GenesisAgentBonusBps/Eras removed — replaced by per-agent onboarding_boost
    type MaxBatchClaimSize = ConstU32<100>;
    type AutoParams = TestAutoParams;
    type OracleScoreProvider = ();
    type OracleCounters = TestOracleCounters;
    type ValidatorCountProvider = ();
    type MaxEmissionOverrideEras = ConstU32<10>;
    type OrchestratorEmissions = TestOrchestratorEmissions;
    type OrchestratorEmissionMultiplier = ConstU32<5_000>;
}

// ── AutoParams Config ─────────────────────────────────────────────────────────

parameter_types! {
    pub const InitFeeBps:   u32 = 0;
    // ROUND14: mirrors the runtime's AutoInitialAlpha, 4_000 -> 1_500 bps. Kept in step
    // with runtime/src/lib.rs deliberately — this mock exists to model the shipped chain.
    pub const InitAlpha:    u32 = 1_500;
    pub const InitBeta:     u32 = 5_000;
    pub const InitFloor:    u32 = 1_000;
    pub const InitMinScore: u32 = 3;
    /// spec 306, D7. Mirrors the runtime's AutoInitialEmissionVolumeAlphaBps deliberately —
    /// this mock exists to model the shipped chain, so 1.0x here means the integration
    /// tests exercise the same bound the live chain enforces.
    pub const InitEmissionVolumeAlphaBps: u32 = 10_000;
}

impl pallet_auto_params::Config for TestRuntime {
    type RuntimeEvent = RuntimeEvent;
    type GovernanceOrigin = frame_system::EnsureRoot<u64>;
    type InitialCompletionFeeBps = InitFeeBps;
    type InitialAlpha = InitAlpha;
    type InitialBeta = InitBeta;
    type InitialFloorBps = InitFloor;
    type InitialMinScoreEligible = InitMinScore;
    type InitialEmissionVolumeAlphaBps = InitEmissionVolumeAlphaBps;
    type RingRatioThreshold = ConstU32<3_000>;
    type OracleParticipationLowThreshold = ConstU32<4_000>;
    type OracleParticipationHighThreshold = ConstU32<9_000>;
    type ConcentrationHighThreshold = ConstU32<7_000>;
    type ConcentrationLowThreshold = ConstU32<5_000>;
    type MinQuestionsForOracleRule = ConstU32<3>;
    type MinAgentsForConcentrationRule = ConstU32<5>;
}

// ── Orchestrator Config ───────────────────────────────────────────────────────

impl pallet_orchestrator::Config for TestRuntime {
    type RuntimeEvent = RuntimeEvent;
    type MaxSubAgentsPerOrchestrator = ConstU32<10>;
    type MaxOrchestratorFeeBps = ConstU32<500>;
    type LinkApprovalWindow = ConstU64<100>;
    type MaxPendingProposals = ConstU32<20>;
    type SupplyCap = SupplyCapIntTest;
}

// ── Messages Config (spec 308) ────────────────────────────────────────────────

/// Runtime values scaled to this harness's u64 balances: 0.02 CMN and 0.0001 CMN.
pub const MESSAGE_BASE_FEE: u64 = CMN / 50;
pub const MESSAGE_PER_BYTE_FEE: u64 = CMN / 10_000;

impl pallet_messages::Config for TestRuntime {
    type RuntimeEvent = RuntimeEvent;
    type BaseFee = ConstU64<MESSAGE_BASE_FEE>;
    type PerByteFee = ConstU64<MESSAGE_PER_BYTE_FEE>;
    type MaxPerBlock = ConstU32<4>;
    type WeightInfo = pallet_messages::PlaceholderWeights;
}

// ── Test genesis ──────────────────────────────────────────────────────────────

pub fn new_test_ext_with_balances(balances: Vec<(u64, u64)>) -> TestExternalities {
    reset_gov_state();
    let mut storage = frame_system::GenesisConfig::<TestRuntime>::default()
        .build_storage()
        .unwrap();
    pallet_balances::GenesisConfig::<TestRuntime> {
        balances,
        dev_accounts: None,
    }
    .assimilate_storage(&mut storage)
    .unwrap();
    pallet_auto_params::GenesisConfig::<TestRuntime>::default()
        .assimilate_storage(&mut storage)
        .unwrap();
    storage.into()
}

pub fn new_test_ext() -> TestExternalities {
    new_test_ext_with_balances(vec![
        (ALICE, 1_000_000 * CMN),
        (BOB, 1_000_000 * CMN),
        (CAROL, 1_000_000 * CMN),
        (DAVE, 1_000_000 * CMN),
        (EVE, 1_000_000 * CMN),
        (FRANK, 1_000_000 * CMN),
        (ROOT, 1_000_000 * CMN),
    ])
}

/// Register an agent with the given stake.
pub fn register(who: u64, stake: u64) {
    pallet_agents::Pallet::<TestRuntime>::register(RuntimeOrigin::signed(who), stake)
        .unwrap_or_else(|_| panic!("register({who}) failed"));
}

/// Complete a full escrow cycle: create → deliver → confirm.
pub fn complete_escrow(buyer: u64, provider: u64, amount: u64, deliver_block: u64) -> u32 {
    let seq = pallet_escrow::NextSeq::<TestRuntime>::get(buyer, provider);
    advance_blocks(1);
    pallet_escrow::Pallet::<TestRuntime>::create_agreement(
        RuntimeOrigin::signed(buyer),
        provider,
        amount,
        [1u8; 32],
        frame_system::Pallet::<TestRuntime>::block_number() + deliver_block,
        None,
    )
    .expect("create_agreement failed");
    // Since #180 an agreement only binds the provider once it accepts; record_delivery
    // refuses with NotAccepted until then.
    pallet_escrow::Pallet::<TestRuntime>::accept_agreement(
        RuntimeOrigin::signed(provider),
        buyer,
        seq,
    )
    .expect("accept_agreement failed");
    go_to_block(frame_system::Pallet::<TestRuntime>::block_number() + 10);
    pallet_escrow::Pallet::<TestRuntime>::record_delivery(
        RuntimeOrigin::signed(provider),
        buyer,
        seq,
        [2u8; 32],
    )
    .expect("record_delivery failed");
    pallet_escrow::Pallet::<TestRuntime>::confirm_delivery(
        RuntimeOrigin::signed(buyer),
        provider,
        seq,
    )
    .expect("confirm_delivery failed");
    seq
}
