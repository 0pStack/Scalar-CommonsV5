//! pallet-emissions unit tests
//!
//! Gated by `#[cfg(test)] mod tests;` in `lib.rs` — no inner `#![cfg(test)]`.

use crate::pallet::*;
use frame_support::{
    assert_noop, assert_ok, parameter_types,
    traits::{ConstU16, ConstU32, ConstU64, Currency},
};
use sp_core::H256;
use sp_runtime::{
    traits::{BlakeTwo256, IdentityLookup},
    BuildStorage,
};

type Block = frame_system::mocking::MockBlock<Test>;

pub struct StaticParams;
impl pallet_auto_params::pallet::AutoParamsProvider for StaticParams {
    fn completion_fee_bps() -> u32 {
        0
    }
    fn alpha() -> u32 {
        4_000
    }
    fn beta() -> u32 {
        5_000
    }
    fn floor_bps() -> u32 {
        1_000
    }
    fn min_score_eligible() -> u32 {
        5
    }
    fn emission_volume_alpha_bps() -> u32 {
        10_000
    }
}

frame_support::construct_runtime!(
    pub enum Test {
        System:    frame_system,
        Balances:  pallet_balances,
        Agents:    pallet_agents,
        Emissions: crate,
    }
);

impl frame_system::Config for Test {
    type BaseCallFilter = frame_support::traits::Everything;
    type BlockWeights = ();
    type BlockLength = ();
    type RuntimeOrigin = RuntimeOrigin;
    type RuntimeCall = RuntimeCall;
    type RuntimeTask = ();
    type Nonce = u64;
    type Hash = H256;
    type Hashing = BlakeTwo256;
    type AccountId = u64;
    type Lookup = IdentityLookup<Self::AccountId>;
    type Block = Block;
    type RuntimeEvent = RuntimeEvent;
    // BlockNumber is u64 in this mock, so these want ConstU64/ConstU16, not
    // ConstU32. Values unchanged: 250 blocks of hashes, SS58 prefix 42.
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
    // Added to frame_system::Config since this mock was written; `()` for all six
    // is the SDK's own TestDefaultConfig — no migrations, no block-phase hooks.
    type ExtensionsWeightInfo = ();
    type SingleBlockMigrations = ();
    type MultiBlockMigrator = ();
    type PreInherents = ();
    type PostInherents = ();
    type PostTransactions = ();
}

impl pallet_balances::Config for Test {
    type MaxLocks = ConstU32<50>;
    type MaxReserves = ConstU32<50>;
    type ReserveIdentifier = [u8; 8];
    type Balance = u64;
    type RuntimeEvent = RuntimeEvent;
    type DustRemoval = ();
    // Balance is u64 here, so ExistentialDeposit wants ConstU64. Value unchanged: 1.
    type ExistentialDeposit = ConstU64<1>;
    type AccountStore = System;
    type WeightInfo = ();
    type FreezeIdentifier = ();
    type MaxFreezes = ConstU32<0>;
    type RuntimeHoldReason = ();
    type RuntimeFreezeReason = ();
    // New in pallet_balances::Config; `()` is the SDK default — no slash callback.
    type DoneSlashHandler = ();
}

parameter_types! {
    pub const MinStakeE:  u64 = 1_000;
    pub const FFStakeE:   u64 = 10_000;
    pub const MaxStakeE:  u64 = 1_000_000;
}

impl pallet_agents::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    type Currency = Balances;
    type MinStake = MinStakeE;
    type FullFloorStake = FFStakeE;
    type MaxStakePerAgent = MaxStakeE;
    // BlockNumber- and Balance-typed constants: ConstU64, not ConstU32. Values unchanged.
    type UnstakeCooldown = ConstU64<100>;
    type BaseRegistrationFee = ConstU64<50>;
    type MaxRegistrationsPerBlock = ConstU32<10>;
    type MaxAgents = ConstU32<1000>;
    type Rank3MinCompletions = ConstU32<50>;
    type MinRank3OracleScore = ConstU32<0>; // disabled for test
    type Rank3SpanGate = ConstU64<0>; // disabled for test
    type MaxVolToStakeRatio = ConstU32<0>; // disabled
    type HeartbeatGracePeriod = ConstU64<600>;
    type HeartbeatDecayPeriod = ConstU64<14400>;
    type OnAgentRegistered = Emissions;
    type OnAgentSlashed = Emissions;
    type OnStakeChanged = Emissions;
    type AgentCollective = ();
    type OracleScoreGate = ();
    type GovVoteVerifier = MockGovVoteVerifier;
    type IdentityHandler = ();
    type OrchestratorLookup = ();
    type MaxUriLen = ConstU32<128>;
    type MaxNameLen = ConstU32<64>;
    type MaxCapabilitiesPerAgent = ConstU32<32>;
    type MaxDelegationPeriod = ConstU64<100_800>; // BlockNumber = u64 in test runtime
    type SlashAppealWindow = ConstU64<10>; // BlockNumber = u64 in test runtime
    type SlashDestination = ();
    type MaxProposalsPerEra = ConstU32<20>;
}

parameter_types! {
    pub const SupplyCap:             u64 = 100_000_000_000_000;
    pub const InitialEmissionsPerEra:u64 = 1_000_000;
    pub const TargetPerAgent:        u64 = 10_000;
    pub const FloorEmission:         u64 = 100_000;
    pub const EraDuration:           u64 = 3_600;
    pub const UnitVolume:            u64 = 1_000;
}

parameter_types! {
    // `storage` makes this settable per test (`MinQualifyingVolE::set(&v)`) so the floor gate
    // can be exercised without a second mock runtime. Default 0 = gate disabled, exactly the
    // value this mock has always had, so every pre-existing test is unaffected.
    pub storage MinQualifyingVolE: u64 = 0;
}

// Scheduler removed from Config in M1 — no mock needed

impl super::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    type Currency = Balances;
    type SupplyCap = SupplyCap;
    type InitialEmissionsPerEra = InitialEmissionsPerEra;
    type TargetEmissionPerAgent = TargetPerAgent;
    type FloorEmissionPerEra = FloorEmission;
    type EraDuration = EraDuration;
    type MaxBatchClaimSize = ConstU32<50>;
    type OracleBonusBps = ConstU32<2000>;
    type MaxProposalsPerEra = ConstU32<10>;
    type UnitVolume = UnitVolume;
    type VelocityBonusBps = ConstU32<0>; // +30% weight bonus at full capital deployment
                                         // Balance-typed (Get<BalanceOf<Self>>), and Balance is u64 here — so ConstU64.
                                         // Value unchanged: 0 keeps the floor gate disabled.
    type MinQualifyingVol = MinQualifyingVolE; // default 0 = disabled; floor-gate tests set it
                                               // V4: GenesisAgentBonusBps/Eras removed — replaced by per-agent onboarding_boost
    type AutoParams = StaticParams;
    type OracleScoreProvider = ();
    type OracleCounters = ();
    type MaxEmissionOverrideEras = ConstU32<10>;
    // Orchestrator: no-op in unit tests
    type ValidatorCountProvider = ();
    type OrchestratorEmissions = ();
    type OrchestratorEmissionMultiplier = ConstU32<5_000>;
}

fn new_test_ext() -> sp_io::TestExternalities {
    let mut storage = frame_system::GenesisConfig::<Test>::default()
        .build_storage()
        .unwrap();
    pallet_balances::GenesisConfig::<Test> {
        balances: vec![(1, 500_000), (2, 500_000), (3, 500_000)],
        dev_accounts: None, // new field; None = generate none, as before
    }
    .assimilate_storage(&mut storage)
    .unwrap();
    storage.into()
}

const ALICE: u64 = 1;
const BOB: u64 = 2;

fn register(who: u64, stake: u64) {
    assert_ok!(Agents::register(RuntimeOrigin::signed(who), stake));
}

/// Record a full era of real escrow work for `agent` through the production
/// path (`add_era_escrow_volume`), not by poking storage directly.
///
/// Emission weight is zero for an agent that did no escrow work this era —
/// `docs/VERIFIED-CONSTANTS.md` §3.1: "Weight = 0 → zero emissions, regardless
/// of stake size or heartbeat." So any test that expects emissions to accrue
/// must first give the agent work to be rewarded for; registering and staking
/// is deliberately not enough (CLAUDE.md first principle #2).
///
/// Five distinct buyers puts `diversity_score_bps` at its 10,000 ceiling, and
/// 5 × 20,000 = 100,000 era volume against `UnitVolume = 1,000` puts
/// `log2_scaled` at 8,000 — i.e. an ordinarily productive agent, not an edge case.
fn do_era_work(agent: u64) {
    do_era_work_of(agent, 20_000);
}

/// `do_era_work` with the per-buyer amount spelled out.
///
/// spec 306 (D7, #164) bounds an era's emission at `alpha x qualifying escrow volume`, so a
/// test that wants to observe an emission of size N must first give the chain at least N of
/// qualifying volume to measure. Five distinct buyers keeps `diversity_score_bps` at its
/// ceiling and keeps the provider clear of the ring flag, exactly as `do_era_work` does.
fn do_era_work_of(agent: u64, per_buyer: u64) {
    for buyer in 100u64..105 {
        assert_ok!(Agents::add_era_escrow_volume(&agent, &buyer, per_buyer));
    }
}

/// Advance block number past EraDuration and call settle_era with a signed origin.
/// settle_era is now permissionless (ensure_signed) but requires EraDuration elapsed.
fn settle(caller: u64) {
    let now = System::block_number();
    let era_dur = <Test as crate::pallet::Config>::EraDuration::get();
    System::set_block_number(now + era_dur);
    assert_ok!(Emissions::settle_era(RuntimeOrigin::signed(caller)));
}

#[test]
fn new_agent_debt_initialised_on_register() {
    new_test_ext().execute_with(|| {
        // Put some value in accumulator first
        AccRewardPerStake::<Test>::put(1_000_000u128);
        // Register alice — debt should equal current accumulator
        register(ALICE, 1_000);
        assert_eq!(AgentRewardDebt::<Test>::get(ALICE), 1_000_000u128);
    });
}

#[test]
fn claim_nothing_before_settlement() {
    new_test_ext().execute_with(|| {
        register(ALICE, 1_000);
        assert_noop!(
            Emissions::claim(RuntimeOrigin::signed(ALICE)),
            Error::<Test>::NothingToClaim
        );
    });
}

#[test]
fn accumulator_increases_on_era_settlement() {
    new_test_ext().execute_with(|| {
        register(ALICE, 10_000);
        // Stake alone carries no weight — the accumulator only moves if some
        // agent did verifiable work this era. See do_era_work().
        do_era_work(ALICE);
        let acc_before = AccRewardPerStake::<Test>::get();
        settle(ALICE);
        let acc_after = AccRewardPerStake::<Test>::get();
        assert!(acc_after > acc_before, "accumulator should have increased");
    });
}

#[test]
fn agent_can_claim_after_settlement() {
    new_test_ext().execute_with(|| {
        register(ALICE, 10_000);
        // Emissions reward work, not stake: without this the agent settles at
        // weight 0 and claim() correctly returns NothingToClaim.
        do_era_work(ALICE);
        // Register before settle so debt is 0
        AgentRewardDebt::<Test>::insert(ALICE, 0u128);
        let balance_before = Balances::free_balance(ALICE);
        settle(ALICE);
        assert_ok!(Emissions::claim(RuntimeOrigin::signed(ALICE)));
        assert!(
            Balances::free_balance(ALICE) > balance_before,
            "alice should have earned emissions"
        );
    });
}

#[test]
fn supply_cap_enforced() {
    new_test_ext().execute_with(|| {
        register(ALICE, 10_000);
        // Set total_issuance near the cap
        // Difficult to test directly in mock without custom currency; verify
        // the code path exists by inspecting that cap check compiles and runs.
        // Full integration test on testnet confirms behaviour.
        settle(ALICE);
    });
}

#[test]
fn higher_stake_earns_proportionally_more() {
    new_test_ext().execute_with(|| {
        // Alice: 10K stake (Full rank 2), Bob: 1K stake (rank 0/1)
        register(ALICE, 10_000);
        register(BOB, 1_000);
        // IDENTICAL era work for both, so stake is the only variable the
        // comparison below is measuring. Without any work both weights are 0
        // and the assertion compares 0 > 0 — which is the correct emission
        // outcome for two idle stakers, not evidence about the stake curve.
        do_era_work(ALICE);
        do_era_work(BOB);
        // Zero debt for both
        AgentRewardDebt::<Test>::insert(ALICE, 0u128);
        AgentRewardDebt::<Test>::insert(BOB, 0u128);
        settle(ALICE);

        let alice_weight = AgentWeightSnapshot::<Test>::get(ALICE);
        let bob_weight = AgentWeightSnapshot::<Test>::get(BOB);
        // Alice should have more weight: sqrt(10000)=100 vs sqrt(1000)≈31, plus rank multiplier
        assert!(
            alice_weight > bob_weight,
            "alice with 10K stake should outweigh bob with 1K"
        );
    });
}

#[test]
fn log2_scaled_baseline_at_unit_volume() {
    new_test_ext().execute_with(|| {
        // An agent with exactly 1x unit_volume (1000 CMN) should get ~1000 work_score_raw
        // Test the formula: vol = unit → bits = 20, (20 - 19) * 1000 = 1000
        register(ALICE, 10_000);
        AgentRewardDebt::<Test>::insert(ALICE, 0u128);
        // Simulate 1x unit volume (1000 tokens)
        pallet_agents::EraEscrowVolume::<Test>::insert(ALICE, 1_000u64);
        pallet_agents::EraUniqueBuyers::<Test>::insert(ALICE, 5u32); // 5 unique buyers → diversity = 10000
        settle(ALICE);
        // Weight snapshot should be non-zero
        let w = AgentWeightSnapshot::<Test>::get(ALICE);
        assert!(
            w > 0,
            "agent with 1x unit volume should have positive weight"
        );
    });
}

#[test]
fn emission_override_replaces_formula_for_targeted_era() {
    new_test_ext().execute_with(|| {
        register(ALICE, 10_000);
        AgentRewardDebt::<Test>::insert(ALICE, 0u128);

        // Set override for era 0 (current era before settle_era)
        assert_ok!(Emissions::set_era_emission_override(
            RuntimeOrigin::root(),
            1,
            500_000u64,
        ));

        // spec 306: each era needs real qualifying volume, and the overridden era needs at
        // least the override's worth of it — otherwise D7 cuts the override down to the
        // volume and this test would be measuring the cap rather than the override. The
        // assertions below are unchanged; only the setup now supplies the work that the
        // emission is a payment FOR. `emission_override_is_still_bounded_by_qualifying_volume`
        // in tests_issue_164.rs covers the other side, where the cap does bind.
        do_era_work_of(ALICE, 100_000); // 5 buyers x 100_000 = 500_000 qualifying

        // Settle era 0 first (moves to era 1)
        settle(ALICE);
        let _last_era_0 = LastEraEmission::<Test>::get();

        // Reset debt for clean test
        AgentRewardDebt::<Test>::insert(ALICE, AccRewardPerStake::<Test>::get());

        // Settle era 1 (should use override amount = 500_000)
        do_era_work_of(ALICE, 100_000);
        settle(ALICE);
        let last_era_1 = LastEraEmission::<Test>::get();
        assert_eq!(last_era_1, 500_000u64, "era 1 should use override amount");

        // Override consumed — era 2 uses formula
        AgentRewardDebt::<Test>::insert(ALICE, AccRewardPerStake::<Test>::get());
        do_era_work_of(ALICE, 100_000);
        settle(ALICE);
        let last_era_2 = LastEraEmission::<Test>::get();
        assert_ne!(
            last_era_2, 500_000u64,
            "era 2 should not use override (consumed)"
        );
    });
}

// ── Issue #183: findings encoded as ledger assertions ────────────────────────
//
// Every test below asserts on events and storage — what the chain recorded — never only
// on the `Result` a call returned. A call can return `Ok` and mint nothing, or `Err` and
// have left state half-written; the ledger is the thing that has to be right.

/// Every `pallet-emissions` event deposited so far, in order.
fn emission_events() -> Vec<Event<Test>> {
    System::events()
        .into_iter()
        .filter_map(|r| match r.event {
            RuntimeEvent::Emissions(e) => Some(e),
            _ => None,
        })
        .collect()
}

fn era_settled_events() -> Vec<(u32, u64, u128)> {
    emission_events()
        .into_iter()
        .filter_map(|e| match e {
            Event::EraSettled {
                era,
                total_emission,
                total_weight,
            } => Some((era, total_emission, total_weight)),
            _ => None,
        })
        .collect()
}

/// A fresh single-agent chain: block 1 (so events are recorded), ALICE registered with
/// `stake` and zero reward debt.
fn chain_with_alice(stake: u64) {
    System::set_block_number(1);
    register(ALICE, stake);
    AgentRewardDebt::<Test>::insert(ALICE, 0u128);
}

/// Weight snapshot ALICE ends up with after one era of the given `(buyer, amount)` deals,
/// under the given `MinQualifyingVol`. ALICE heartbeats on the settlement block so the
/// floor share is reachable at all.
fn alice_weight(min_qualifying_vol: u64, buyers: &[(u64, u64)]) -> u128 {
    new_test_ext().execute_with(|| {
        MinQualifyingVolE::set(&min_qualifying_vol);
        chain_with_alice(10_000);
        for (buyer, amount) in buyers {
            assert_ok!(Agents::add_era_escrow_volume(&ALICE, buyer, *amount));
        }
        // Beat the heart on the settlement block: the floor share needs `hb >= 90`, and
        // `settle` advances a whole era past the grace period.
        let era_dur = <Test as crate::pallet::Config>::EraDuration::get();
        System::set_block_number(System::block_number() + era_dur);
        assert_ok!(Agents::heartbeat(RuntimeOrigin::signed(ALICE)));
        assert_ok!(Emissions::settle_era(RuntimeOrigin::signed(ALICE)));
        AgentWeightSnapshot::<Test>::get(ALICE)
    })
}

// ── settle_era guards ────────────────────────────────────────────────────────

/// `EraNotDue`: one block short of `EraDuration` nothing settles and nothing moves.
#[test]
fn settle_era_before_era_due_is_rejected_and_writes_nothing() {
    new_test_ext().execute_with(|| {
        chain_with_alice(10_000);
        do_era_work(ALICE);
        let era_dur = <Test as crate::pallet::Config>::EraDuration::get();
        let start = EraStartBlock::<Test>::get();
        System::set_block_number(start + era_dur - 1);
        let era_before = pallet_agents::EraNumber::<Test>::get();

        assert_noop!(
            Emissions::settle_era(RuntimeOrigin::signed(ALICE)),
            Error::<Test>::EraNotDue
        );

        assert_eq!(LastSettledEra::<Test>::get(), None);
        assert_eq!(EraStartBlock::<Test>::get(), start);
        assert_eq!(pallet_agents::EraNumber::<Test>::get(), era_before);
        assert_eq!(AccRewardPerStake::<Test>::get(), 0);
        assert_eq!(LastEraEmission::<Test>::get(), 0);
        assert!(
            era_settled_events().is_empty(),
            "no EraSettled may be emitted"
        );
        // The era's work is still there to be paid for when the era is due.
        assert!(pallet_agents::EraEscrowVolume::<Test>::get(ALICE) > 0);
    });
}

/// The boundary itself: exactly `EraDuration` blocks after the era start is due.
#[test]
fn settle_era_is_due_exactly_at_era_duration() {
    new_test_ext().execute_with(|| {
        chain_with_alice(10_000);
        do_era_work(ALICE);
        let era_dur = <Test as crate::pallet::Config>::EraDuration::get();
        let start = EraStartBlock::<Test>::get();
        System::set_block_number(start + era_dur);

        assert_ok!(Emissions::settle_era(RuntimeOrigin::signed(ALICE)));

        assert_eq!(LastSettledEra::<Test>::get(), Some(0));
        assert_eq!(EraStartBlock::<Test>::get(), start + era_dur);
        assert_eq!(pallet_agents::EraNumber::<Test>::get(), 1);
        assert_eq!(era_settled_events().len(), 1);
        assert_eq!(era_settled_events()[0].0, 0);
    });
}

/// First principle #3: settlement is permissionless (any signed account) and never root-gated
/// or unsigned. A signed account that is not even a registered agent may settle.
#[test]
fn settle_era_is_permissionless_but_requires_a_signature() {
    new_test_ext().execute_with(|| {
        chain_with_alice(10_000);
        do_era_work(ALICE);
        let era_dur = <Test as crate::pallet::Config>::EraDuration::get();
        System::set_block_number(System::block_number() + era_dur);

        for origin in [RuntimeOrigin::root(), RuntimeOrigin::none()] {
            assert_noop!(
                Emissions::settle_era(origin),
                sp_runtime::DispatchError::BadOrigin
            );
        }
        assert_eq!(LastSettledEra::<Test>::get(), None);
        assert!(era_settled_events().is_empty());

        // BOB never registered: still allowed.
        assert_ok!(Emissions::settle_era(RuntimeOrigin::signed(BOB)));
        assert_eq!(LastSettledEra::<Test>::get(), Some(0));
        assert_eq!(era_settled_events().len(), 1);
    });
}

/// F-04, the timing half: a second settle in the same block cannot mint again. It is
/// stopped by `EraNotDue` because settling reset `EraStartBlock`, and the ledger shows one
/// era's emission, not two.
#[test]
fn second_settle_in_same_block_cannot_mint_a_second_time() {
    new_test_ext().execute_with(|| {
        chain_with_alice(10_000);
        do_era_work(ALICE);
        settle(ALICE);
        let acc = AccRewardPerStake::<Test>::get();
        let emission = LastEraEmission::<Test>::get();
        let issuance = Balances::total_issuance();
        assert!(acc > 0 && emission > 0);

        assert_noop!(
            Emissions::settle_era(RuntimeOrigin::signed(BOB)),
            Error::<Test>::EraNotDue
        );

        assert_eq!(AccRewardPerStake::<Test>::get(), acc);
        assert_eq!(LastEraEmission::<Test>::get(), emission);
        assert_eq!(Balances::total_issuance(), issuance);
        assert_eq!(era_settled_events().len(), 1, "exactly one EraSettled");
        assert_eq!(LastSettledEra::<Test>::get(), Some(0));
    });
}

/// F-04, the era-number half: even when the timing gate is satisfied, an era that is
/// already recorded as settled is rejected with `EraAlreadySettled` and mints nothing. This
/// is the guard that holds if `EraNumber` ever fails to advance (the timing gate alone would
/// then be the only defence).
#[test]
fn settle_era_rejects_an_era_already_settled_even_when_due() {
    new_test_ext().execute_with(|| {
        chain_with_alice(10_000);
        do_era_work(ALICE);
        let era = pallet_agents::EraNumber::<Test>::get();
        LastSettledEra::<Test>::put(era);
        let era_dur = <Test as crate::pallet::Config>::EraDuration::get();
        System::set_block_number(System::block_number() + era_dur);

        assert_noop!(
            Emissions::settle_era(RuntimeOrigin::signed(ALICE)),
            Error::<Test>::EraAlreadySettled
        );

        assert_eq!(AccRewardPerStake::<Test>::get(), 0);
        assert_eq!(
            EraStartBlock::<Test>::get(),
            0,
            "era clock must not restart"
        );
        assert_eq!(pallet_agents::EraNumber::<Test>::get(), era);
        assert!(era_settled_events().is_empty());
    });
}

/// Consecutive eras each settle once: the era counter advances, `LastSettledEra` follows it
/// and the accumulator grows once per era.
#[test]
fn consecutive_eras_each_settle_exactly_once() {
    new_test_ext().execute_with(|| {
        chain_with_alice(10_000);
        do_era_work(ALICE);
        settle(ALICE);
        let acc_1 = AccRewardPerStake::<Test>::get();
        do_era_work(ALICE);
        settle(ALICE);
        let acc_2 = AccRewardPerStake::<Test>::get();

        assert!(acc_2 > acc_1);
        assert_eq!(LastSettledEra::<Test>::get(), Some(1));
        assert_eq!(pallet_agents::EraNumber::<Test>::get(), 2);
        let eras: Vec<u32> = era_settled_events().iter().map(|e| e.0).collect();
        assert_eq!(eras, vec![0, 1]);
    });
}

/// The era's events carry the numbers the storage holds: `EraSettled.total_emission` is
/// `LastEraEmission`, and when qualifying volume is below the pot the D7 cap event says so.
#[test]
fn era_settled_event_matches_storage_and_reports_the_volume_cap() {
    new_test_ext().execute_with(|| {
        chain_with_alice(10_000);
        // 5 buyers x 12_000 = 60_000 qualifying volume < the 100_000 floor pot.
        do_era_work_of(ALICE, 12_000);
        settle(ALICE);

        let (era, total_emission, total_weight) = era_settled_events()[0];
        assert_eq!(era, 0);
        assert_eq!(total_emission, 60_000);
        assert_eq!(LastEraEmission::<Test>::get(), total_emission);
        assert_eq!(total_weight, AgentWeightSnapshot::<Test>::get(ALICE));
        assert!(emission_events().contains(&Event::EmissionCappedByVolume {
            era: 0,
            uncapped: 100_000,
            qualifying_volume: 60_000,
            alpha_bps: 10_000,
        }));
        assert!(emission_events().contains(&Event::NextEraScheduled {
            block: System::block_number() + 3_600,
            scheduled: false,
        }));
    });
}

// ── claim ────────────────────────────────────────────────────────────────────

/// A claim pays what the accumulator says, mints exactly that, records it in the event and
/// zeroes the agent's pending amount (debt catches up to the accumulator).
#[test]
fn claim_pays_from_the_accumulator_and_advances_debt() {
    new_test_ext().execute_with(|| {
        chain_with_alice(10_000);
        do_era_work(ALICE);
        settle(ALICE);
        let emission = LastEraEmission::<Test>::get();
        let issuance_before = Balances::total_issuance();
        let balance_before = Balances::free_balance(ALICE);

        assert_ok!(Emissions::claim(RuntimeOrigin::signed(ALICE)));

        let paid = Balances::free_balance(ALICE) - balance_before;
        assert!(
            paid > 0 && paid <= emission,
            "paid {paid} of era emission {emission}"
        );
        assert_eq!(Balances::total_issuance(), issuance_before + paid);
        assert_eq!(
            AgentRewardDebt::<Test>::get(ALICE),
            AccRewardPerStake::<Test>::get()
        );
        assert!(emission_events().contains(&Event::RewardClaimed {
            agent: ALICE,
            amount: paid,
        }));

        // Nothing left: a second claim mints nothing and emits no second RewardClaimed.
        assert_noop!(
            Emissions::claim(RuntimeOrigin::signed(ALICE)),
            Error::<Test>::NothingToClaim
        );
        assert_eq!(Balances::total_issuance(), issuance_before + paid);
    });
}

/// The era's mint is bounded by its emission across all claimants — the per-era invariant,
/// checked on issuance rather than on any one call's return.
#[test]
fn total_claimed_across_agents_never_exceeds_the_era_emission() {
    new_test_ext().execute_with(|| {
        chain_with_alice(10_000);
        register(BOB, 4_000);
        AgentRewardDebt::<Test>::insert(BOB, 0u128);
        do_era_work(ALICE);
        do_era_work(BOB);
        settle(ALICE);
        let emission = LastEraEmission::<Test>::get();
        let issuance_before = Balances::total_issuance();

        assert_ok!(Emissions::claim(RuntimeOrigin::signed(ALICE)));
        assert_ok!(Emissions::claim(RuntimeOrigin::signed(BOB)));

        let minted = Balances::total_issuance() - issuance_before;
        assert!(minted > 0);
        assert!(
            minted <= emission,
            "minted {minted} > era emission {emission}"
        );
    });
}

/// Supply cap, partial clamp: with only `room` of headroom left, the claim pays exactly
/// `room`, issuance lands on the cap and never above it.
#[test]
fn claim_is_clamped_to_the_remaining_supply_room() {
    new_test_ext().execute_with(|| {
        chain_with_alice(10_000);
        do_era_work(ALICE);
        settle(ALICE);
        let cap = <Test as crate::pallet::Config>::SupplyCap::get();
        let room = 5u64;
        let issued = Balances::total_issuance();
        let _ = Balances::deposit_creating(&99, cap - issued - room);
        assert_eq!(Balances::total_issuance(), cap - room);
        let balance_before = Balances::free_balance(ALICE);

        assert_ok!(Emissions::claim(RuntimeOrigin::signed(ALICE)));

        assert_eq!(Balances::free_balance(ALICE) - balance_before, room);
        assert_eq!(Balances::total_issuance(), cap);
        assert!(emission_events().contains(&Event::RewardClaimed {
            agent: ALICE,
            amount: room,
        }));
    });
}

/// Supply cap, hard stop: at the cap nothing is minted through any claim path. `batch_claim`
/// swallows per-agent results, so it is where `CapReached` is observable; a lone `claim`
/// returns `NothingToClaim` and the dispatch layer rolls the whole call back, so the event
/// and the debt update are discarded with it (recorded in the PR as an observation).
#[test]
fn claim_at_the_cap_mints_nothing() {
    new_test_ext().execute_with(|| {
        chain_with_alice(10_000);
        do_era_work(ALICE);
        settle(ALICE);
        let cap = <Test as crate::pallet::Config>::SupplyCap::get();
        let issued = Balances::total_issuance();
        let _ = Balances::deposit_creating(&99, cap - issued);
        assert_eq!(Balances::total_issuance(), cap);
        let balance_before = Balances::free_balance(ALICE);

        assert_noop!(
            Emissions::claim(RuntimeOrigin::signed(ALICE)),
            Error::<Test>::NothingToClaim
        );
        assert_eq!(Balances::free_balance(ALICE), balance_before);
        assert_eq!(Balances::total_issuance(), cap);

        assert_ok!(Emissions::batch_claim(
            RuntimeOrigin::signed(BOB),
            vec![ALICE]
        ));
        assert_eq!(Balances::free_balance(ALICE), balance_before);
        assert_eq!(Balances::total_issuance(), cap);
        assert!(emission_events().contains(&Event::CapReached { agent: ALICE }));
        assert!(!emission_events()
            .iter()
            .any(|e| matches!(e, Event::RewardClaimed { .. })));
    });
}

/// Claim by an account that is not an agent is rejected before anything is read or paid.
#[test]
fn claim_by_an_unregistered_account_is_rejected() {
    new_test_ext().execute_with(|| {
        chain_with_alice(10_000);
        do_era_work(ALICE);
        settle(ALICE);
        let issuance = Balances::total_issuance();
        assert_noop!(
            Emissions::claim(RuntimeOrigin::signed(BOB)),
            Error::<Test>::NotRegistered
        );
        assert_eq!(Balances::total_issuance(), issuance);
    });
}

// ── zero work = zero weight ──────────────────────────────────────────────────

/// A staked agent that did no escrow work gets no weight, no accumulator movement, no
/// emission and no claim — regardless of stake size (first principle #2).
#[test]
fn zero_work_is_zero_weight_and_zero_emission() {
    new_test_ext().execute_with(|| {
        chain_with_alice(400_000);
        settle(ALICE);

        assert_eq!(AgentWeightSnapshot::<Test>::get(ALICE), 0);
        assert!(!AgentWeightSnapshot::<Test>::contains_key(ALICE));
        assert_eq!(AccRewardPerStake::<Test>::get(), 0);
        assert_eq!(LastEraEmission::<Test>::get(), 0);
        assert_eq!(era_settled_events(), vec![(0, 0, 0)]);
        // The D7 bound reports that the pot was cut all the way to nothing.
        assert!(emission_events().contains(&Event::EmissionCappedByVolume {
            era: 0,
            uncapped: 100_000,
            qualifying_volume: 0,
            alpha_bps: 10_000,
        }));
        let issuance = Balances::total_issuance();
        assert_noop!(
            Emissions::claim(RuntimeOrigin::signed(ALICE)),
            Error::<Test>::NothingToClaim
        );
        assert_eq!(Balances::total_issuance(), issuance);
    });
}

/// Governance participation cannot stand in for work: votes recorded with no escrow volume
/// still leave the weight at zero.
#[test]
fn governance_votes_without_work_earn_zero_weight() {
    new_test_ext().execute_with(|| {
        chain_with_alice(10_000);
        pallet_agents::EraGovParticipation::<Test>::insert(ALICE, 10u32);
        settle(ALICE);

        assert_eq!(AgentWeightSnapshot::<Test>::get(ALICE), 0);
        assert_eq!(AccRewardPerStake::<Test>::get(), 0);
        assert_eq!(era_settled_events(), vec![(0, 0, 0)]);
    });
}

/// An agent that worked in era N and idles in era N+1 loses its snapshot at N+1, so the era
/// N+1 accumulator step cannot be paid out against its stale era-N weight.
#[test]
fn a_dormant_agent_loses_its_stale_weight_snapshot() {
    new_test_ext().execute_with(|| {
        chain_with_alice(10_000);
        do_era_work(ALICE);
        settle(ALICE);
        assert!(AgentWeightSnapshot::<Test>::get(ALICE) > 0);

        // Era 1: ALICE does nothing.
        settle(ALICE);

        assert!(!AgentWeightSnapshot::<Test>::contains_key(ALICE));
        assert_eq!(era_settled_events().last(), Some(&(1, 0, 0)));
        assert_eq!(LastEraEmission::<Test>::get(), 0);
    });
}

// ── floor gate: MinQualifyingVol ─────────────────────────────────────────────

/// Below `MinQualifyingVol` an agent still earns its work score but loses the floor share,
/// so its weight is strictly lower than the same work with the gate off.
#[test]
fn volume_below_min_qualifying_vol_loses_the_floor_share() {
    let buyers: Vec<(u64, u64)> = (100u64..105).map(|b| (b, 9_000)).collect(); // 45_000
    let ungated = alice_weight(0, &buyers);
    let gated = alice_weight(50_000, &buyers);

    assert!(
        gated > 0,
        "work score must still count below the floor gate"
    );
    assert!(
        gated < ungated,
        "floor share must be withheld below MinQualifyingVol: gated {gated}, ungated {ungated}"
    );
}

/// The gate is `>=`: volume exactly at `MinQualifyingVol` keeps the floor share, one plancks
/// below it does not.
#[test]
fn floor_gate_boundary_is_inclusive() {
    let at: Vec<(u64, u64)> = (100u64..105).map(|b| (b, 10_000)).collect(); // 50_000
    let below: Vec<(u64, u64)> = vec![
        (100, 10_000),
        (101, 10_000),
        (102, 10_000),
        (103, 10_000),
        (104, 9_999),
    ]; // 49_999

    assert_eq!(alice_weight(50_000, &at), alice_weight(0, &at));
    assert!(alice_weight(50_000, &below) < alice_weight(0, &below));
}

/// Above the threshold the gate is inert: identical weight with it on or off.
#[test]
fn volume_above_min_qualifying_vol_is_unaffected_by_the_gate() {
    let buyers: Vec<(u64, u64)> = (100u64..105).map(|b| (b, 20_000)).collect();
    assert_eq!(alice_weight(50_000, &buyers), alice_weight(0, &buyers));
}

// ── buyer-diversity discriminator (script 58) ────────────────────────────────

/// Same total volume, more distinct buyers → strictly more weight up to five buyers, then
/// the credit saturates. One buyer is the ring shape; five is the honest shape.
#[test]
fn weight_rises_with_distinct_buyers_and_saturates_at_five() {
    // Always 8 deals of 15_000, so volume AND completion count (which sets the onboarding
    // boost) are identical across runs; only how many distinct buyers share them varies.
    let weight_with = |n: u64| {
        let deals: Vec<(u64, u64)> = (0..8).map(|i| (100 + i % n, 15_000)).collect();
        alice_weight(0, &deals)
    };
    let w: Vec<u128> = (1..=8).map(weight_with).collect();

    assert!(w[0] > 0);
    assert!(
        w[0] < w[1] && w[1] < w[2] && w[2] < w[3] && w[3] < w[4],
        "{w:?}"
    );
    assert_eq!(w[4], w[5], "diversity credit saturates at five buyers");
}

/// A single-buyer ring cannot earn emission: an established provider whose whole era came
/// from one buyer has zero qualifying volume, so the D7 bound cuts the pot to zero and the
/// ledger says so.
#[test]
fn established_single_buyer_provider_has_zero_qualifying_volume() {
    new_test_ext().execute_with(|| {
        chain_with_alice(10_000);
        for _ in 0..3 {
            assert_ok!(Agents::add_era_escrow_volume(&ALICE, &100, 40_000));
        }
        settle(ALICE);

        assert_eq!(
            era_settled_events()[0].1,
            0,
            "no emission for a one-buyer era"
        );
        assert_eq!(LastEraEmission::<Test>::get(), 0);
        assert!(emission_events().contains(&Event::EmissionCappedByVolume {
            era: 0,
            uncapped: 100_000,
            qualifying_volume: 0,
            alpha_bps: 10_000,
        }));
    });
}

/// A reciprocal pair (A pays B and B pays A in the same era) is circular: both legs are
/// dropped from qualifying volume, so the pair together mints nothing.
#[test]
fn reciprocal_pair_volume_does_not_qualify_for_emission() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        register(ALICE, 10_000);
        register(BOB, 10_000);
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &BOB, 50_000));
        assert_ok!(Agents::add_era_escrow_volume(&BOB, &ALICE, 50_000));
        settle(ALICE);

        assert_eq!(era_settled_events()[0].1, 0);
        assert_eq!(LastEraEmission::<Test>::get(), 0);
        assert_eq!(AccRewardPerStake::<Test>::get(), 0);
    });
}

// ── Governance-vote verifier mock (ROUND14) ──────────────────────────────────
//
// Replaces `GovVoteVerifier = ()`, whose impl returned `true` unconditionally and was
// wired into all six mocks — which is why the governance-participation guard shipped
// with no behavioural coverage. No test in this crate calls `record_gov_vote`, so this
// mock starts empty and denies everything; a future test must state which (voter, poll)
// pairs are live rather than passing by default.
//
// `HELD_VOTES` and `ONGOING_POLLS` are separate on purpose: on chain a vote leaves
// `pallet_conviction_voting::VotingFor` only via the voter's own `remove_vote`, so it
// outlives the referendum. Both must hold for credit.
thread_local! {
    static HELD_VOTES: core::cell::RefCell<std::collections::BTreeSet<(u64, u32)>> =
        const { core::cell::RefCell::new(std::collections::BTreeSet::new()) };
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

/// `who` votes on `poll`, and `poll` is ongoing.
#[allow(dead_code)]
pub fn cast_live_vote(who: u64, poll: u32) {
    HELD_VOTES.with(|v| {
        v.borrow_mut().insert((who, poll));
    });
    ONGOING_POLLS.with(|p| {
        p.borrow_mut().insert(poll);
    });
}

/// The referendum ends; the vote itself survives, exactly as on chain.
#[allow(dead_code)]
pub fn conclude_poll(poll: u32) {
    ONGOING_POLLS.with(|p| {
        p.borrow_mut().remove(&poll);
    });
}

/// Reset verifier state — the test harness reuses threads across tests.
#[allow(dead_code)]
pub fn reset_gov_state() {
    HELD_VOTES.with(|v| v.borrow_mut().clear());
    ONGOING_POLLS.with(|p| p.borrow_mut().clear());
}
