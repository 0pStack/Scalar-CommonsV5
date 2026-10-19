//! pallet-oracle unit tests
//!
//! Gated by `#[cfg(test)] mod tests;` in `lib.rs` — no inner `#![cfg(test)]`.

use crate::pallet::*;
use frame_support::pallet_prelude::Encode;
use frame_support::{
    assert_noop, assert_ok, parameter_types,
    traits::{ConstU16, ConstU32, ConstU64},
};
use sp_core::H256;
use sp_runtime::{
    traits::{BlakeTwo256, IdentityLookup},
    BuildStorage,
};

type Block = frame_system::mocking::MockBlock<Test>;

frame_support::construct_runtime!(
    pub enum Test {
        System:   frame_system,
        Balances: pallet_balances,
        Agents:   pallet_agents,
        Oracle:   crate,
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
    // Was `()`, whose `Get<RuntimeDbWeight>` impl yields zero for both read and
    // write. The `finalise_weight_` tests compare declared weights, and against a
    // zero DbWeight every such comparison is 0 >= 0 — true for any declaration,
    // including an under-priced one. RocksDbWeight is what the runtime itself uses
    // (runtime/src/lib.rs), so the mock now prices storage the same way.
    type DbWeight = frame_support::weights::constants::RocksDbWeight;
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
    pub const MinStakeA:         u64 = 1_000;
    pub const FullFloorStakeA:   u64 = 10_000;
    pub const MaxStakeA:         u64 = 1_000_000;
    pub const UnstakeCooldownA:  u64 = 100;
    pub const BaseFeeA:          u64 = 50;
    pub const MaxRegsA:          u32 = 10;
    pub const MaxAgentsA:        u32 = 100;
}

impl pallet_agents::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    type Currency = Balances;
    type MinStake = MinStakeA;
    type FullFloorStake = FullFloorStakeA;
    type MaxStakePerAgent = MaxStakeA;
    type UnstakeCooldown = UnstakeCooldownA;
    type BaseRegistrationFee = BaseFeeA;
    type MaxRegistrationsPerBlock = MaxRegsA;
    type MaxAgents = MaxAgentsA;
    type Rank3MinCompletions = ConstU32<50>;
    type MinRank3OracleScore = ConstU32<1000>;
    // BlockNumber-typed: ConstU64, not ConstU32. Values unchanged.
    type Rank3SpanGate = ConstU64<100>;
    type MaxVolToStakeRatio = ConstU32<10>;
    type HeartbeatGracePeriod = ConstU64<600>;
    type HeartbeatDecayPeriod = ConstU64<14400>;
    type OnAgentRegistered = ();
    type OnAgentSlashed = ();
    type OnStakeChanged = ();
    type AgentCollective = ();
    type OracleScoreGate = Oracle;
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
    pub const MinOracleBounty:       u64 = 100;
    pub const MaxOpenRequests:       u32 = 50;
    pub const MinChallengeWindow:    u64 = 5;
    pub const MinConsensusThreshold: u8  = 50;
    pub const MaxResponsesPerReq:    u32 = 100;
}

impl super::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    // No `Currency` here: oracle::Config does not declare one — bounties are
    // reserved through pallet_agents::Config::Currency, already set to Balances.
    type MinOracleBounty = MinOracleBounty;
    type MaxOpenRequests = MaxOpenRequests;
    type MinChallengeWindow = MinChallengeWindow;
    type MinConsensusThreshold = MinConsensusThreshold;
    type MaxResponsesPerRequest = MaxResponsesPerReq;
    type DisputeCallback = RecordingDisputeCallback;
    type CapabilityChecker = (); // permissive in tests
    type MaxBatchSubmissions = ConstU32<20>;
    // A second `MaxResponsesPerRequest = ConstU32<200>` stood here — a duplicate
    // definition (E0201) appended alongside MaxBatchSubmissions. Kept the
    // parameter_types! one above (100). No test drives response_count anywhere
    // near either bound (the mock endows 4 accounts), so behaviour is identical.
}

fn new_test_ext() -> sp_io::TestExternalities {
    let mut storage = frame_system::GenesisConfig::<Test>::default()
        .build_storage()
        .unwrap();
    pallet_balances::GenesisConfig::<Test> {
        balances: vec![(1, 200_000), (2, 200_000), (3, 200_000), (4, 200_000)],
        dev_accounts: None, // new field; None = generate none, as before
    }
    .assimilate_storage(&mut storage)
    .unwrap();
    storage.into()
}

const ALICE: u64 = 1;
const BOB: u64 = 2;
const CAROL: u64 = 3;
const DAVE: u64 = 4;

fn register(who: u64) {
    assert_ok!(Agents::register(RuntimeOrigin::signed(who), 1_000));
}

fn q_hash() -> [u8; 32] {
    [1u8; 32]
}

#[test]
fn create_request_works() {
    new_test_ext().execute_with(|| {
        register(ALICE);
        assert_ok!(Oracle::create_oracle_request(
            RuntimeOrigin::signed(ALICE),
            q_hash(),
            100,
            ConsensusMode::Factual,
            3,
            67,
            100,
            5,
            None,
        ));
        assert!(OracleRequests::<Test>::contains_key(q_hash()));
    });
}

#[test]
fn create_request_fails_bounty_too_low() {
    new_test_ext().execute_with(|| {
        register(ALICE);
        assert_noop!(
            Oracle::create_oracle_request(
                RuntimeOrigin::signed(ALICE),
                q_hash(),
                50,
                ConsensusMode::Factual,
                3,
                67,
                100,
                5,
                None,
            ),
            Error::<Test>::BountyTooLow
        );
    });
}

#[test]
fn submit_response_updates_status() {
    new_test_ext().execute_with(|| {
        register(ALICE);
        register(BOB);
        assert_ok!(Oracle::create_oracle_request(
            RuntimeOrigin::signed(ALICE),
            q_hash(),
            100,
            ConsensusMode::Factual,
            2,
            67,
            100,
            5,
            None,
        ));
        assert_ok!(Oracle::submit_response(
            RuntimeOrigin::signed(BOB),
            q_hash(),
            [42u8; 32],
            0,
        ));
        let req = OracleRequests::<Test>::get(q_hash()).unwrap();
        assert_eq!(req.status, OracleRequestStatus::Collecting);
        assert_eq!(req.response_count, 1);
    });
}

#[test]
fn cannot_respond_twice() {
    new_test_ext().execute_with(|| {
        register(ALICE);
        register(BOB);
        assert_ok!(Oracle::create_oracle_request(
            RuntimeOrigin::signed(ALICE),
            q_hash(),
            100,
            ConsensusMode::Factual,
            2,
            67,
            100,
            5,
            None,
        ));
        assert_ok!(Oracle::submit_response(
            RuntimeOrigin::signed(BOB),
            q_hash(),
            [1u8; 32],
            0
        ));
        assert_noop!(
            Oracle::submit_response(RuntimeOrigin::signed(BOB), q_hash(), [1u8; 32], 0),
            Error::<Test>::AlreadyResponded
        );
    });
}

#[test]
fn factual_consensus_with_majority() {
    new_test_ext().execute_with(|| {
        register(ALICE);
        register(BOB);
        register(CAROL);
        register(DAVE);
        let winner_hash = [99u8; 32];
        let loser_hash = [77u8; 32];

        // ALICE creates, BOB/CAROL/DAVE respond (2 agree on winner_hash)
        assert_ok!(Oracle::create_oracle_request(
            RuntimeOrigin::signed(ALICE),
            q_hash(),
            300,
            ConsensusMode::Factual,
            3,
            67,
            10,
            5,
            None,
        ));
        assert_ok!(Oracle::submit_response(
            RuntimeOrigin::signed(BOB),
            q_hash(),
            winner_hash,
            0
        ));
        assert_ok!(Oracle::submit_response(
            RuntimeOrigin::signed(CAROL),
            q_hash(),
            winner_hash,
            0
        ));
        assert_ok!(Oracle::submit_response(
            RuntimeOrigin::signed(DAVE),
            q_hash(),
            loser_hash,
            0
        ));

        // Advance past deadline + challenge window
        frame_system::Pallet::<Test>::set_block_number(20);
        assert_ok!(Oracle::finalise_request(
            RuntimeOrigin::signed(ALICE),
            q_hash()
        ));

        // BOB and CAROL should have correct accuracy
        let (correct_b, total_b) = OracleAccuracy::<Test>::get(BOB, 0);
        assert_eq!((correct_b, total_b), (1, 1));
        let (correct_d, total_d) = OracleAccuracy::<Test>::get(DAVE, 0);
        assert_eq!((correct_d, total_d), (0, 1));
        // Scores updated
        assert_eq!(OracleScore::<Test>::get(BOB, 0), 10_000);
        assert_eq!(OracleScore::<Test>::get(DAVE, 0), 0);
    });
}

#[test]
fn expire_request_refunds_creator() {
    new_test_ext().execute_with(|| {
        register(ALICE);
        let balance_before = Balances::free_balance(ALICE);
        assert_ok!(Oracle::create_oracle_request(
            RuntimeOrigin::signed(ALICE),
            q_hash(),
            100,
            ConsensusMode::Factual,
            3,
            67,
            5,
            // challenge_window: was 3, below this mock's MinChallengeWindow = 5,
            // so the request was rejected before expiry could ever be exercised.
            // expire_request() reads only response_deadline (still 5) — the
            // dispute window is incidental here, so this restores the test's
            // subject rather than changing it.
            5,
            None,
        ));
        frame_system::Pallet::<Test>::set_block_number(10);
        assert_ok!(Oracle::expire_request(
            RuntimeOrigin::signed(ALICE),
            q_hash()
        ));
        // Bounty refunded (minus tx fees in real system, ignored in test)
        assert_eq!(Balances::free_balance(ALICE), balance_before);
    });
}

#[test]
fn no_consensus_refunds_creator() {
    new_test_ext().execute_with(|| {
        register(ALICE);
        register(BOB);
        register(CAROL);
        register(DAVE);
        let balance_before = Balances::free_balance(ALICE);

        assert_ok!(Oracle::create_oracle_request(
            RuntimeOrigin::signed(ALICE),
            q_hash(),
            300,
            ConsensusMode::Factual,
            3,
            67,
            10,
            5,
            None,
        ));

        // All 3 respondents give DIFFERENT answers — no 67% consensus possible
        assert_ok!(Oracle::submit_response(
            RuntimeOrigin::signed(BOB),
            q_hash(),
            [10u8; 32],
            0
        ));
        assert_ok!(Oracle::submit_response(
            RuntimeOrigin::signed(CAROL),
            q_hash(),
            [20u8; 32],
            0
        ));
        assert_ok!(Oracle::submit_response(
            RuntimeOrigin::signed(DAVE),
            q_hash(),
            [30u8; 32],
            0
        ));

        frame_system::Pallet::<Test>::set_block_number(20);
        assert_ok!(Oracle::finalise_request(
            RuntimeOrigin::signed(ALICE),
            q_hash()
        ));

        // No result stored (no consensus)
        assert!(OracleResults::<Test>::get(q_hash()).is_none());
        // Creator refunded
        assert_eq!(Balances::free_balance(ALICE), balance_before);
    });
}

#[test]
fn batch_submit_response_accepts_valid_skips_invalid() {
    new_test_ext().execute_with(|| {
        register(ALICE);
        register(BOB);
        register(CAROL);
        register(DAVE);

        // ALICE creates two requests
        let q1 = [1u8; 32];
        let q2 = [2u8; 32];
        assert_ok!(Oracle::create_oracle_request(
            RuntimeOrigin::signed(ALICE),
            q1,
            150,
            ConsensusMode::Factual,
            2,
            67,
            100,
            5,
            None,
        ));
        assert_ok!(Oracle::create_oracle_request(
            RuntimeOrigin::signed(ALICE),
            q2,
            150,
            ConsensusMode::Factual,
            2,
            67,
            100,
            5,
            None,
        ));

        // BOB submits batch: q1 (valid) + q2 (valid) + bogus_id (will be skipped)
        let bogus_id = [99u8; 32];
        let submissions: Vec<([u8; 32], [u8; 32], u32)> = vec![
            (q1, [10u8; 32], 0),
            (q2, [20u8; 32], 0),
            (bogus_id, [30u8; 32], 0), // will be skipped — request not found
        ];
        // `pallet_oracle::` — a crate cannot name itself, and the pallet's own
        // re-export is private. Same type, named where it is public.
        let bounded: frame_support::BoundedVec<_, _> = submissions.try_into().unwrap();

        assert_ok!(Oracle::batch_submit_response(
            RuntimeOrigin::signed(BOB),
            bounded
        ));

        // BOB has responded to both valid requests
        assert!(OracleResponses::<Test>::get(q1, BOB).is_some());
        assert!(OracleResponses::<Test>::get(q2, BOB).is_some());
        // Bogus request still doesn't exist
        assert!(!OracleRequests::<Test>::contains_key(bogus_id));
    });
}

// ── Audit-finding tests (#182) ───────────────────────────────────────────────
//
// Every test below asserts on events and storage — the ledger — never only on a
// call's `Ok`/`Err`. `System::events()` is empty at block 0, so these run from
// block 1 via `ext_with_events()`.

thread_local! {
    static DISPUTE_CALLS: core::cell::RefCell<Vec<(u64, u64, u32, bool)>> =
        const { core::cell::RefCell::new(Vec::new()) };
}

/// Records every `on_dispute_resolved` the oracle fires, so the E28 bridge is
/// observable instead of vanishing into `()`.
pub struct RecordingDisputeCallback;
impl crate::escrow_bridge::DisputeCallback<u64, u64> for RecordingDisputeCallback {
    fn on_dispute_resolved(
        buyer: &u64,
        provider: &u64,
        seq: u32,
        provider_wins: bool,
    ) -> frame_support::pallet_prelude::DispatchResult {
        DISPUTE_CALLS.with(|c| c.borrow_mut().push((*buyer, *provider, seq, provider_wins)));
        Ok(())
    }
}

fn ext_with_events() -> sp_io::TestExternalities {
    let mut ext = new_test_ext();
    ext.execute_with(|| {
        System::set_block_number(1);
        DISPUTE_CALLS.with(|c| c.borrow_mut().clear());
    });
    ext
}

fn has_event(e: Event<Test>) -> bool {
    System::events()
        .iter()
        .any(|r| r.event == RuntimeEvent::Oracle(e.clone()))
}

fn create(creator: u64, id: [u8; 32], bounty: u64, min_responses: u32, deadline: u64) {
    assert_ok!(Oracle::create_oracle_request(
        RuntimeOrigin::signed(creator),
        id,
        bounty,
        ConsensusMode::Factual,
        min_responses,
        67,
        deadline,
        5,
        None,
    ));
}

/// E7 — consensus + payout: the bounty is split between the majority, the
/// dissenter is paid nothing and scored zero, and the request is cleaned up.
#[test]
fn oracle_consensus_pays_majority_and_scores_dissenter_zero() {
    ext_with_events().execute_with(|| {
        for a in [ALICE, BOB, CAROL, DAVE] {
            register(a);
        }
        let (win, lose) = ([99u8; 32], [77u8; 32]);
        let (bob0, carol0, dave0) = (
            Balances::free_balance(BOB),
            Balances::free_balance(CAROL),
            Balances::free_balance(DAVE),
        );
        let alice_reserved0 = Balances::reserved_balance(ALICE);
        create(ALICE, q_hash(), 300, 3, 10);
        assert_eq!(Balances::reserved_balance(ALICE), alice_reserved0 + 300);
        assert_ok!(Oracle::submit_response(
            RuntimeOrigin::signed(BOB),
            q_hash(),
            win,
            0
        ));
        assert_ok!(Oracle::submit_response(
            RuntimeOrigin::signed(CAROL),
            q_hash(),
            win,
            0
        ));
        assert_ok!(Oracle::submit_response(
            RuntimeOrigin::signed(DAVE),
            q_hash(),
            lose,
            0
        ));
        System::set_block_number(20);
        assert_ok!(Oracle::finalise_request(
            RuntimeOrigin::signed(ALICE),
            q_hash()
        ));

        // Payout: 300 / 2 winners = 150 each; dissenter gets nothing.
        assert_eq!(Balances::free_balance(BOB), bob0 + 150);
        assert_eq!(Balances::free_balance(CAROL), carol0 + 150);
        assert_eq!(Balances::free_balance(DAVE), dave0);
        assert_eq!(Balances::reserved_balance(ALICE), alice_reserved0);
        // Storage: result recorded, request and responses cleared, era counter bumped.
        assert_eq!(OracleResults::<Test>::get(q_hash()), Some(win));
        assert!(OracleRequests::<Test>::get(q_hash()).is_none());
        assert!(OracleResponses::<Test>::get(q_hash(), BOB).is_none());
        assert_eq!(EraFinalisedQuestions::<Test>::get(), 1);
        assert_eq!(OracleScore::<Test>::get(BOB, 0), 10_000);
        assert_eq!(OracleScore::<Test>::get(DAVE, 0), 0);
        assert_eq!(OracleAccuracy::<Test>::get(DAVE, 0), (0, 1));
        // Events.
        assert!(has_event(Event::OracleRequestFinalised {
            id: q_hash(),
            winning_hash: win,
            respondents_paid: 2
        }));
        assert!(has_event(Event::ScoreUpdated {
            agent: DAVE,
            capability: 0,
            new_score: 0
        }));
        assert!(has_event(Event::ScoreUpdated {
            agent: BOB,
            capability: 0,
            new_score: 10_000
        }));
    });
}

/// E8 — expiry returns the full bounty, emits the event and clears storage;
/// it is refused before the deadline and once quorum has been reached.
#[test]
fn expire_request_returns_full_bounty() {
    ext_with_events().execute_with(|| {
        register(ALICE);
        register(BOB);
        let free0 = Balances::free_balance(ALICE);
        let reserved0 = Balances::reserved_balance(ALICE);
        create(ALICE, q_hash(), 100, 3, 5);
        assert_eq!(Balances::free_balance(ALICE), free0 - 100);
        assert_ok!(Oracle::submit_response(
            RuntimeOrigin::signed(BOB),
            q_hash(),
            [5u8; 32],
            0
        ));

        // Before the deadline: refused, nothing moves.
        assert_noop!(
            Oracle::expire_request(RuntimeOrigin::signed(CAROL), q_hash()),
            Error::<Test>::RequestExpired
        );
        assert!(OracleRequests::<Test>::contains_key(q_hash()));

        System::set_block_number(6);
        // Permissionless: a third party expires it; quorum (3) was never met.
        assert_ok!(Oracle::expire_request(
            RuntimeOrigin::signed(CAROL),
            q_hash()
        ));
        assert_eq!(Balances::free_balance(ALICE), free0);
        assert_eq!(Balances::reserved_balance(ALICE), reserved0);
        assert!(OracleRequests::<Test>::get(q_hash()).is_none());
        assert!(OracleResponses::<Test>::get(q_hash(), BOB).is_none());
        assert!(has_event(Event::OracleRequestExpired { id: q_hash() }));
        assert_noop!(
            Oracle::expire_request(RuntimeOrigin::signed(CAROL), q_hash()),
            Error::<Test>::RequestNotFound
        );
    });
}

/// E8 — a request that met quorum must be finalised, not expired (the bounty is
/// owed to the respondents).
#[test]
fn expire_request_refused_once_quorum_met() {
    ext_with_events().execute_with(|| {
        register(ALICE);
        register(BOB);
        create(ALICE, q_hash(), 100, 1, 5);
        assert_ok!(Oracle::submit_response(
            RuntimeOrigin::signed(BOB),
            q_hash(),
            [5u8; 32],
            0
        ));
        System::set_block_number(6);
        assert_noop!(
            Oracle::expire_request(RuntimeOrigin::signed(CAROL), q_hash()),
            Error::<Test>::RequestAlreadyFinalised
        );
        assert!(OracleRequests::<Test>::contains_key(q_hash()));
        assert!(!has_event(Event::OracleRequestExpired { id: q_hash() }));
    });
}

fn dispute_id(buyer: u64, provider: u64, seq: u32) -> [u8; 32] {
    let mut pre = buyer.encode();
    pre.extend_from_slice(&provider.encode());
    pre.extend_from_slice(&seq.to_le_bytes());
    sp_io::hashing::blake2_256(&pre)
}

/// E28 — the escrow→oracle bridge stores a request that carries the dispute
/// context, reserves the buyer's bounty, and counts toward the era total.
#[test]
fn dispute_request_carries_dispute_context() {
    use crate::escrow_bridge::DisputeOracle;
    ext_with_events().execute_with(|| {
        register(ALICE);
        let reserved0 = Balances::reserved_balance(ALICE);
        let id = <Oracle as DisputeOracle<u64, u64, u64>>::post_dispute_question(
            &ALICE, &BOB, 7, 200, 30, None,
        )
        .unwrap();
        assert_eq!(id, dispute_id(ALICE, BOB, 7));
        let req = OracleRequests::<Test>::get(id).unwrap();
        let ctx = req.dispute_context.clone().expect("dispute context stored");
        assert_eq!((ctx.buyer, ctx.provider, ctx.seq), (ALICE, BOB, 7));
        assert_eq!(req.creator, ALICE);
        assert_eq!(req.bounty, 200);
        assert_eq!(req.mode, ConsensusMode::Factual);
        assert_eq!((req.min_responses, req.consensus_threshold), (3, 67));
        assert_eq!(req.response_deadline, 30);
        assert_eq!(Balances::reserved_balance(ALICE), reserved0 + 200);
        assert_eq!(EraTotalQuestions::<Test>::get(), 1);
    });
}

/// Returns the request id and ALICE's reserved balance after registration, before the bounty.
fn resolve_dispute(answers: [[u8; 32]; 3]) -> ([u8; 32], u64) {
    use crate::escrow_bridge::DisputeOracle;
    for a in [ALICE, BOB, CAROL, DAVE] {
        register(a);
    }
    let reserved_after_registration = Balances::reserved_balance(ALICE);
    // ALICE = buyer, BOB = provider; CAROL, DAVE and a fifth juror vote.
    let id = <Oracle as DisputeOracle<u64, u64, u64>>::post_dispute_question(
        &ALICE, &BOB, 1, 300, 10, None,
    )
    .unwrap();
    let juror = 5u64;
    assert_ok!(Balances::force_set_balance(
        RuntimeOrigin::root(),
        juror,
        200_000
    ));
    register(juror);
    for (who, ans) in [CAROL, DAVE, juror].into_iter().zip(answers) {
        assert_ok!(Oracle::submit_response(
            RuntimeOrigin::signed(who),
            id,
            ans,
            0
        ));
    }
    System::set_block_number(20);
    assert_ok!(Oracle::finalise_request(RuntimeOrigin::signed(DAVE), id));
    (id, reserved_after_registration)
}

/// E28 — a provider-wins verdict reaches the callback as `provider_wins = true`.
#[test]
fn dispute_verdict_provider_wins_reaches_callback() {
    ext_with_events().execute_with(|| {
        let pw = sp_io::hashing::blake2_256(pallet_escrow::dispute_hashes::PROVIDER_WINS_PREIMAGE);
        let (id, _) = resolve_dispute([pw, pw, [1u8; 32]]);
        assert_eq!(
            DISPUTE_CALLS.with(|c| c.borrow().clone()),
            vec![(ALICE, BOB, 1, true)]
        );
        assert_eq!(OracleResults::<Test>::get(id), Some(pw));
        assert!(OracleRequests::<Test>::get(id).is_none());
        assert!(has_event(Event::OracleRequestFinalised {
            id,
            winning_hash: pw,
            respondents_paid: 2
        }));
    });
}

/// E28 — a buyer-wins verdict reaches the callback as `provider_wins = false`.
#[test]
fn dispute_verdict_buyer_wins_reaches_callback() {
    ext_with_events().execute_with(|| {
        let bw = sp_io::hashing::blake2_256(pallet_escrow::dispute_hashes::BUYER_WINS_PREIMAGE);
        let (id, _) = resolve_dispute([bw, bw, bw]);
        assert_eq!(
            DISPUTE_CALLS.with(|c| c.borrow().clone()),
            vec![(ALICE, BOB, 1, false)]
        );
        assert_eq!(OracleResults::<Test>::get(id), Some(bw));
    });
}

/// E28 — with no consensus the callback still fires (provider_wins = false), the
/// buyer's bounty is unreserved, and no result is stored.
#[test]
fn dispute_without_consensus_defaults_to_buyer() {
    ext_with_events().execute_with(|| {
        let (id, reserved_before) = resolve_dispute([[1u8; 32], [2u8; 32], [3u8; 32]]);
        assert_eq!(
            DISPUTE_CALLS.with(|c| c.borrow().clone()),
            vec![(ALICE, BOB, 1, false)]
        );
        assert!(OracleResults::<Test>::get(id).is_none());
        // Only ALICE's own registration stake remains reserved; the 300 bounty is back.
        assert_eq!(Balances::reserved_balance(ALICE), reserved_before);
        assert!(has_event(Event::OracleRequestFinalised {
            id,
            winning_hash: [0u8; 32],
            respondents_paid: 0
        }));
    });
}

type Sub = ([u8; 32], [u8; 32], u32);

/// E25 — a batch at exactly the cap is processed in full and reported in the
/// event; an empty batch is rejected with `BatchEmpty` and leaves no event.
#[test]
fn batch_submit_response_at_cap_accepts_all_and_empty_rejected() {
    ext_with_events().execute_with(|| {
        register(ALICE);
        register(BOB);
        let mut subs: Vec<Sub> = vec![];
        for i in 0..20u8 {
            let id = [i + 1; 32];
            create(ALICE, id, 100, 2, 100);
            subs.push((id, [9u8; 32], 0));
        }
        let bounded: frame_support::BoundedVec<Sub, ConstU32<20>> = subs.try_into().unwrap();
        assert_ok!(Oracle::batch_submit_response(
            RuntimeOrigin::signed(BOB),
            bounded
        ));
        for i in 0..20u8 {
            assert_eq!(
                OracleResponses::<Test>::get([i + 1; 32], BOB),
                Some([9u8; 32])
            );
            assert_eq!(
                OracleRequests::<Test>::get([i + 1; 32])
                    .unwrap()
                    .response_count,
                1
            );
        }
        assert!(has_event(Event::BatchResponseSubmitted {
            agent: BOB,
            accepted: 20,
            skipped: 0
        }));

        let empty: frame_support::BoundedVec<Sub, ConstU32<20>> = Default::default();
        assert_noop!(
            Oracle::batch_submit_response(RuntimeOrigin::signed(CAROL), empty.clone()),
            Error::<Test>::NotRegistered
        );
        register(CAROL);
        assert_noop!(
            Oracle::batch_submit_response(RuntimeOrigin::signed(CAROL), empty),
            Error::<Test>::BatchEmpty
        );
    });
}

/// C1 — a request creator answering their own question must not be counted as a
/// respondent (they would vote on, and be paid from, their own bounty).
/// KNOWN BUG: `submit_response` has no creator guard, so today the self-vote is
/// stored and counted. Un-ignore when the guard lands.
#[test]
#[ignore = "bug: creator can answer own request and is counted as a respondent, see #200"]
fn self_vote_attempt_is_recorded_not_counted() {
    ext_with_events().execute_with(|| {
        register(ALICE);
        create(ALICE, q_hash(), 100, 1, 50);
        let _ = Oracle::submit_response(RuntimeOrigin::signed(ALICE), q_hash(), [1u8; 32], 0);
        assert!(OracleResponses::<Test>::get(q_hash(), ALICE).is_none());
        assert_eq!(
            OracleRequests::<Test>::get(q_hash())
                .unwrap()
                .response_count,
            0
        );
    });
}

/// C1 (characterisation) — documents today's behaviour so a fix flips this test
/// deliberately: the self-vote IS stored and counted.
#[test]
fn self_vote_today_is_counted_characterisation() {
    ext_with_events().execute_with(|| {
        register(ALICE);
        create(ALICE, q_hash(), 100, 1, 50);
        assert_ok!(Oracle::submit_response(
            RuntimeOrigin::signed(ALICE),
            q_hash(),
            [1u8; 32],
            0
        ));
        assert_eq!(
            OracleResponses::<Test>::get(q_hash(), ALICE),
            Some([1u8; 32])
        );
        assert_eq!(
            OracleRequests::<Test>::get(q_hash())
                .unwrap()
                .response_count,
            1
        );
        assert!(has_event(Event::OracleResponseSubmitted {
            id: q_hash(),
            agent: ALICE
        }));
    });
}

#[test]
fn batch_submit_response_over_cap_rejected_before_dispatch() {
    use frame_support::traits::Get;
    use parity_scale_codec::{Decode, Encode};
    // The batch parameter is `BoundedVec<_, MaxBatchSubmissions>` (20 in the mock), so an
    // over-cap batch cannot be built in-runtime, and SCALE decoding of an over-cap extrinsic
    // fails before dispatch: the extrinsic is rejected as undecodable, not a runtime panic.
    let cap = <<Test as crate::Config>::MaxBatchSubmissions as Get<u32>>::get() as usize;
    let over: Vec<([u8; 32], [u8; 32], u32)> = vec![([1u8; 32], [2u8; 32], 0); cap + 1];
    assert!(
        frame_support::BoundedVec::<_, <Test as crate::Config>::MaxBatchSubmissions>::try_from(
            over.clone()
        )
        .is_err()
    );
    let encoded = over.encode();
    assert!(frame_support::BoundedVec::<
        ([u8; 32], [u8; 32], u32),
        <Test as crate::Config>::MaxBatchSubmissions,
    >::decode(&mut &encoded[..])
    .is_err());
}

#[test]
fn batch_submit_response_over_cap_returns_error() {
    use frame_support::traits::Get;
    new_test_ext().execute_with(|| {
        frame_system::Pallet::<Test>::set_block_number(1); // events are not recorded at block 0
        register(ALICE);
        register(BOB);
        assert_ok!(Oracle::create_oracle_request(
            RuntimeOrigin::signed(ALICE),
            q_hash(),
            150,
            ConsensusMode::Factual,
            2,
            67,
            100,
            5,
            None,
        ));

        // Fill the request to exactly the cap. The mock cannot register that many agents
        // (MaxAgents = MaxResponsesPerRequest = 100, 10 registrations per block), so the
        // prior responses are written straight to storage under synthetic accounts.
        let cap = <<Test as crate::Config>::MaxResponsesPerRequest as Get<u32>>::get();
        for i in 0..cap {
            OracleResponses::<Test>::insert(q_hash(), 1_000 + i as u64, [7u8; 32]);
        }
        OracleRequests::<Test>::mutate(q_hash(), |r| {
            let r = r.as_mut().unwrap();
            r.response_count = cap;
            r.status = OracleRequestStatus::Collecting;
        });

        let batch: frame_support::BoundedVec<_, _> =
            vec![(q_hash(), [10u8; 32], 0u32)].try_into().unwrap();
        assert_ok!(Oracle::batch_submit_response(
            RuntimeOrigin::signed(BOB),
            batch
        ));

        assert!(OracleResponses::<Test>::get(q_hash(), BOB).is_none());
        assert_eq!(
            OracleRequests::<Test>::get(q_hash())
                .unwrap()
                .response_count,
            cap
        );
        assert_eq!(
            OracleResponses::<Test>::iter_prefix(q_hash()).count() as u32,
            cap
        );
        frame_system::Pallet::<Test>::assert_last_event(
            Event::<Test>::BatchResponseSubmitted {
                agent: BOB,
                accepted: 0,
                skipped: 1,
            }
            .into(),
        );
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

// ── finalise_request declared weight (#223) ──────────────────────────────────
//
// `finalise_request` is priced per call but works per response: it iterates
// every response under the request, pays every winner out of the bounty and
// rescores every respondent. `MaxResponsesPerRequest` bounds that at 200 on
// chain (100 in this mock), so one flat declaration is roughly right at a
// typical response count and badly wrong at the bound. Block production budgets
// by the declaration, so an under-declared call sells execution the block never
// reserved — the reason the declaration has to cover the worst case.
//
// The ledger below is counted independently of `lib.rs`: one row per storage
// operation the body performs, attributed to the storage it touches. Two checks
// tie it to reality in both directions:
//
//   * `finalise_weight_covers_the_worst_case_response_count` runs the real
//     extrinsic at the bound and compares the rows owned by this pallet's
//     storage against the keys the call actually changed. A per-response write
//     added to the body without a matching row here fails there.
//   * both tests assert the declared weight is a floor over the ledger sum, so
//     a row added here that `lib.rs` does not price fails too.
//
// What the dynamic check cannot reach, stated rather than glossed:
//
//   * Reads, all of them. `TestExternalities` has no read counter, and the
//     benchmarking host functions that do are `unimplemented!` on its trie
//     backend, so every read row is source-derived.
//   * `Owner::Foreign` writes. The currency rows could in principle be observed,
//     but the `DisputeCallback` row cannot: this mock wires a recording double,
//     not `pallet_escrow`, so escrow's real settle cost is unobservable from
//     here at any response count. That row is a counted allowance (see the row
//     itself), deliberately rounded up.
//
// The `Owner::Oracle` write rows carry the dynamic check, and they are the rows
// that scale with the response count — which is the part #223 is about.

/// Which storage a ledger row touches. Only `Oracle`-owned writes can be
/// observed by diffing this pallet's storage prefix across the call.
#[derive(PartialEq)]
enum Owner {
    Oracle,
    Foreign,
}

/// One storage operation `finalise_request` performs: owner, what, reads, writes.
type LedgerRow = (Owner, &'static str, u64, u64);

/// Operations performed once per call, whatever the response count.
const BASE_LEDGER: &[LedgerRow] = &[
    (Owner::Oracle, "OracleRequests::get — the request", 1, 0),
    (Owner::Foreign, "frame_system::block_number", 1, 0),
    (
        Owner::Oracle,
        "OracleResults::insert — accepted answer",
        0,
        1,
    ),
    (
        Owner::Oracle,
        "EraFinalisedQuestions::mutate — era counter",
        1,
        1,
    ),
    (
        Owner::Oracle,
        "OracleRequests::remove — the request entry",
        0,
        1,
    ),
    (
        Owner::Oracle,
        "OracleRequests counter — CountedStorageMap decrement on remove",
        1,
        1,
    ),
    (
        Owner::Foreign,
        "repatriate_reserved — the creator's reserve, drawn down once",
        1,
        1,
    ),
    (
        Owner::Foreign,
        "DisputeCallback::on_dispute_resolved — escrow's settle path, counted \
         allowance: ~6r/7w in escrow, ~7r/5w in add_era_escrow_volume, ~37r/2w \
         in maybe_promote (best_score iterates MaxCapabilitiesPerAgent), ~2r/1w \
         orchestrator credit, rounded up",
        60,
        20,
    ),
];

/// Operations performed once per response under the request. The worst case is
/// consensus reached with every respondent a winner: every response is then
/// both paid and rescored.
const PER_RESPONSE_LEDGER: &[LedgerRow] = &[
    (
        Owner::Oracle,
        "OracleResponses::iter_prefix — yields this response",
        1,
        0,
    ),
    (
        Owner::Foreign,
        "repatriate_reserved — this winner's account",
        1,
        1,
    ),
    (
        Owner::Oracle,
        "OracleAccuracy::mutate — update_accuracy tally",
        1,
        1,
    ),
    (
        Owner::Oracle,
        "OracleAccuracy::get — update_accuracy re-reads the tally",
        1,
        0,
    ),
    (
        Owner::Oracle,
        "OracleScore::insert — update_accuracy derived score",
        0,
        1,
    ),
    (
        Owner::Oracle,
        "OracleResponses::clear_prefix — removes this response",
        1,
        1,
    ),
];

fn ledger_sum(rows: &[LedgerRow], only: Option<Owner>) -> (u64, u64) {
    rows.iter()
        .filter(|(owner, ..)| only.as_ref().map(|o| o == owner).unwrap_or(true))
        .fold((0, 0), |(r, w), (_, _, lr, lw)| (r + lr, w + lw))
}

/// Worst-case (reads, writes) the test counts for `responses` responses.
fn counted_ops(responses: u64) -> (u64, u64) {
    let (br, bw) = ledger_sum(BASE_LEDGER, None);
    let (pr, pw) = ledger_sum(PER_RESPONSE_LEDGER, None);
    (br + pr * responses, bw + pw * responses)
}

/// Writes the test counts against this pallet's own storage — the subset the
/// dynamic check can observe.
fn counted_oracle_writes(responses: u64) -> u64 {
    let (_, bw) = ledger_sum(BASE_LEDGER, Some(Owner::Oracle));
    let (_, pw) = ledger_sum(PER_RESPONSE_LEDGER, Some(Owner::Oracle));
    bw + pw * responses
}

fn db_weight() -> frame_support::weights::RuntimeDbWeight {
    use frame_support::traits::Get;
    <<Test as frame_system::Config>::DbWeight as Get<frame_support::weights::RuntimeDbWeight>>::get(
    )
}

fn max_responses() -> u64 {
    use frame_support::traits::Get;
    <<Test as crate::Config>::MaxResponsesPerRequest as Get<u32>>::get() as u64
}

/// Every storage key in the externality, with its value, so two snapshots can
/// be diffed into "keys this call changed".
fn storage_snapshot() -> std::collections::BTreeMap<Vec<u8>, Vec<u8>> {
    let mut out = std::collections::BTreeMap::new();
    let mut next = sp_io::storage::next_key(&[]);
    while let Some(key) = next {
        if let Some(value) = sp_io::storage::get(&key) {
            out.insert(key.clone(), value.to_vec());
        }
        next = sp_io::storage::next_key(&key);
    }
    out
}

/// Count keys under the `Oracle` pallet prefix whose value differs between the
/// two snapshots, including keys added and keys removed.
fn changed_oracle_keys(
    before: &std::collections::BTreeMap<Vec<u8>, Vec<u8>>,
    after: &std::collections::BTreeMap<Vec<u8>, Vec<u8>>,
) -> usize {
    let prefix = sp_core::twox_128(b"Oracle");
    let is_oracle = |k: &Vec<u8>| k.starts_with(&prefix);
    let mut keys: std::collections::BTreeSet<&Vec<u8>> = std::collections::BTreeSet::new();
    keys.extend(before.keys().filter(|k| is_oracle(k)));
    keys.extend(after.keys().filter(|k| is_oracle(k)));
    keys.into_iter()
        .filter(|k| before.get(*k) != after.get(*k))
        .count()
}

/// Fill `q_hash()` to exactly `MaxResponsesPerRequest` responses, all agreeing,
/// and wind the clock past the challenge window so `finalise_request` is due.
///
/// The mock cannot register that many agents (`MaxAgents` = 100, ten
/// registrations per block), so the responses are written straight to storage
/// under synthetic accounts — the same device
/// `batch_submit_response_over_cap_returns_error` uses.
fn fill_request_to_bound(bounty: u64) -> u64 {
    let n = max_responses();
    register(ALICE);
    assert_ok!(Oracle::create_oracle_request(
        RuntimeOrigin::signed(ALICE),
        q_hash(),
        bounty,
        ConsensusMode::Factual,
        3,
        67,
        10,
        5,
        None,
    ));
    for i in 0..n {
        OracleResponses::<Test>::insert(q_hash(), 1_000 + i, [7u8; 32]);
    }
    OracleRequests::<Test>::mutate(q_hash(), |r| {
        let r = r.as_mut().unwrap();
        r.response_count = n as u32;
        r.status = OracleRequestStatus::Collecting;
    });
    frame_system::Pallet::<Test>::set_block_number(100);
    n
}

#[test]
fn finalise_weight_scales_with_max_responses() {
    new_test_ext().execute_with(|| {
        let bound = max_responses();
        assert!(
            bound > 1,
            "the bound must exceed one for scaling to mean anything"
        );
        assert!(
            db_weight().read > 0 && db_weight().write > 0,
            "the mock's DbWeight must be non-zero or every weight comparison below is vacuous"
        );

        // The declaration prices exactly the operations the ledger counts, at
        // the bound rather than at a typical response count.
        let at_bound = Oracle::finalise_request_db_ops(bound as u32);
        assert_eq!(
            at_bound,
            counted_ops(bound),
            "declared (reads, writes) must equal the independently counted worst case"
        );

        // It has to move with the bound: pricing one fewer response must be
        // strictly cheaper in both components, which no constant satisfies.
        let one_less = Oracle::finalise_request_db_ops(bound as u32 - 1);
        assert!(
            at_bound.0 > one_less.0 && at_bound.1 > one_less.1,
            "weight does not scale with the response count: {at_bound:?} vs {one_less:?}"
        );

        // Raising a weight is safe, lowering one is not (issue #223 §2). The
        // count comes out far above the flat 10/10 this replaced, so it rises.
        assert!(
            at_bound.0 > 10 && at_bound.1 > 10,
            "counted worst case {at_bound:?} is below the flat 10/10 it replaces — \
             the declaration must not be lowered"
        );

        // And the declared Weight is a floor over the counted worst case.
        let declared = Oracle::finalise_request_worst_case_weight();
        let counted = db_weight().reads_writes(at_bound.0, at_bound.1);
        assert!(
            declared.all_gte(counted),
            "declared {declared:?} does not cover counted worst case {counted:?}"
        );
    });
}

#[test]
fn finalise_weight_covers_the_worst_case_response_count() {
    new_test_ext().execute_with(|| {
        frame_system::Pallet::<Test>::set_block_number(1); // events are not recorded at block 0
        let n = fill_request_to_bound(100_000);

        let before = storage_snapshot();
        assert_ok!(Oracle::finalise_request(
            RuntimeOrigin::signed(BOB),
            q_hash()
        ));
        let after = storage_snapshot();

        // The per-response work really did run once per response at the bound:
        // every respondent was paid and rescored, so every response is a winner.
        frame_system::Pallet::<Test>::assert_has_event(
            Event::<Test>::OracleRequestFinalised {
                id: q_hash(),
                winning_hash: [7u8; 32],
                respondents_paid: n as u32,
            }
            .into(),
        );
        let rescored = frame_system::Pallet::<Test>::events()
            .into_iter()
            .filter(|r| matches!(r.event, RuntimeEvent::Oracle(Event::ScoreUpdated { .. })))
            .count();
        assert_eq!(
            rescored as u64, n,
            "update_accuracy must run once per response"
        );

        // Dynamic check: the keys this pallet's storage actually changed must be
        // exactly what the ledger's Oracle-owned write rows predict. A
        // per-response write added to `finalise_request` without a row here
        // lands as a mismatch, and the ledger feeds the declaration below.
        assert_eq!(
            changed_oracle_keys(&before, &after) as u64,
            counted_oracle_writes(n),
            "oracle storage keys changed by finalise_request do not match the counted ledger"
        );

        // The declaration is a floor over that counted worst case.
        let (reads, writes) = counted_ops(n);
        let declared = Oracle::finalise_request_worst_case_weight();
        assert!(
            declared.all_gte(db_weight().reads_writes(reads, writes)),
            "declared {declared:?} does not cover {reads} reads / {writes} writes at the bound"
        );
    });
}
