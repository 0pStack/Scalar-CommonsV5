//! pallet-agents unit tests
//! Run: cargo test -p pallet-agents -- --nocapture
//!
//! Gated by `#[cfg(test)] mod tests;` in `lib.rs` — no inner `#![cfg(test)]`.

use crate::*;
use core::cell::RefCell;
use frame_support::{
    assert_noop, assert_ok, parameter_types,
    traits::{ConstU32, ConstU64, Get, Hooks, StorageVersion},
};
use sp_core::H256;
use sp_runtime::{
    traits::{BlakeTwo256, IdentityLookup},
    BuildStorage,
};
use std::collections::BTreeSet;

// ── Mock runtime ─────────────────────────────────────────────────────────────
type Block = frame_system::mocking::MockBlock<Test>;

frame_support::construct_runtime!(
    pub enum Test {
        System:  frame_system,
        Balances: pallet_balances,
        Agents:   pallet,  // this pallet
    }
);

parameter_types! {
    pub const BlockHashCount: u64 = 250;
    pub const SS58Prefix: u8 = 42;
}

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
    type BlockHashCount = BlockHashCount;
    // Real Rocks numbers, not `()`. With a zero DbWeight every `reads_writes(..)`
    // collapses to zero and the declared-weight floors below (#217) would compare
    // zero against zero — present but unable to ever fail. Pricing the mock the way
    // the runtime prices it keeps those assertions load-bearing.
    type DbWeight = frame_support::weights::constants::RocksDbWeight;
    type Version = ();
    type PalletInfo = PalletInfo;
    type AccountData = pallet_balances::AccountData<u64>;
    type OnNewAccount = ();
    type OnKilledAccount = ();
    type SystemWeightInfo = ();
    type SS58Prefix = SS58Prefix;
    type OnSetCode = ();
    type MaxConsumers = ConstU32<16>;
    // Added to frame_system::Config since this mock was written. All six are `()`
    // in the SDK's own TestDefaultConfig (frame/system/src/lib.rs:335,354-358),
    // i.e. no migrations and no block-phase callbacks — which is what this mock
    // already did implicitly.
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
    type ExistentialDeposit = ConstU64<1>;
    type AccountStore = System;
    type WeightInfo = ();
    type FreezeIdentifier = ();
    type MaxFreezes = ConstU32<0>;
    type RuntimeHoldReason = ();
    type RuntimeFreezeReason = ();
    // Added to pallet_balances::Config since this mock was written; `()` is the
    // SDK's own default (frame/balances/src/lib.rs:247) — no slash bookkeeping
    // callback, matching this mock's prior behaviour.
    type DoneSlashHandler = ();
}

parameter_types! {
    pub const MinStake:                  u64 = 1_000;
    pub const FullFloorStake:            u64 = 10_000;
    pub const MaxStakePerAgent:          u64 = 1_000_000;
    pub const UnstakeCooldown:           u64 = 100;
    pub const BaseRegistrationFee:       u64 = 50;
    pub const MaxRegistrationsPerBlock:  u32 = 10;
    pub const MaxAgents:                 u32 = 100;
    pub const Rank3MinCompletions:       u32 = 50;
    pub const MinRank3OracleScore:       u32 = 1_000;
    pub const Rank3SpanGate:             u64 = 100;
    pub const MaxVolToStakeRatio:        u32 = 10;
    pub const HeartbeatGracePeriod:      u64 = 600;
    pub const HeartbeatDecayPeriod:      u64 = 14_400;
}

impl Config for Test {
    type RuntimeEvent = RuntimeEvent;
    type Currency = Balances;
    type MinStake = MinStake;
    type FullFloorStake = FullFloorStake;
    type MaxStakePerAgent = MaxStakePerAgent;
    type UnstakeCooldown = UnstakeCooldown;
    type BaseRegistrationFee = BaseRegistrationFee;
    type MaxRegistrationsPerBlock = MaxRegistrationsPerBlock;
    type MaxAgents = MaxAgents;
    type Rank3MinCompletions = Rank3MinCompletions;
    type MinRank3OracleScore = MinRank3OracleScore;
    type Rank3SpanGate = Rank3SpanGate;
    type MaxVolToStakeRatio = MaxVolToStakeRatio;
    type HeartbeatGracePeriod = HeartbeatGracePeriod;
    type HeartbeatDecayPeriod = HeartbeatDecayPeriod;
    type OnAgentRegistered = ();
    type OnAgentSlashed = (); // unit test: no emissions pallet
    type OnStakeChanged = (); // unit test: no emissions pallet
    type AgentCollective = ();
    type OracleScoreGate = ();
    type GovVoteVerifier = MockGovVoteVerifier;
    type IdentityHandler = ();
    type OrchestratorLookup = ();
    type MaxUriLen = ConstU32<256>;
    type MaxNameLen = ConstU32<64>;
    type MaxCapabilitiesPerAgent = ConstU32<20>;
    type MaxDelegationPeriod = ConstU64<90_000>; // BlockNumber = u64 in test runtime
    type SlashAppealWindow = ConstU64<10>; // BlockNumber = u64 in test runtime
                                           // V4: new Config types
    type MaxProposalsPerEra = ConstU32<20>;
    type SlashDestination = (); // test: slash burns fully (no treasury mock needed)
}

// ── Configurable governance-vote verifier mock ───────────────────────────────
//
// ROUND13 §2.5 found the shipped guard had zero behavioural coverage: all six mocks
// wired `GovVoteVerifier = ()`, whose impl returned `true` unconditionally, so no test
// could ever observe the verifier rejecting anything. This mock models the two facts the
// real `ConvictionVotingBridge` reads, kept as separate pieces of state precisely because
// upstream keeps them separate — and that separation IS the vector:
//
//   * `HELD_VOTES`   — (voter, poll) pairs in `pallet_conviction_voting::VotingFor`.
//                      Entries leave ONLY via the voter's own `remove_vote`.
//   * `ONGOING_POLLS`— polls for which `Polling::as_ongoing` returns `Some`.
//
// `conclude_poll` therefore drops the poll from `ONGOING_POLLS` while deliberately
// LEAVING the vote in `HELD_VOTES`, which is exactly what the real chain does when a
// referendum finishes. A verifier that only asks "does this account hold a vote?" cannot
// tell that state apart from a live one.

thread_local! {
    /// (voter, poll_index) pairs the account holds a `Casting` vote on.
    /// Mirrors `pallet_conviction_voting::VotingFor`.
    static HELD_VOTES: RefCell<BTreeSet<(u64, u32)>> = const { RefCell::new(BTreeSet::new()) };
    /// Poll indices still ongoing. Mirrors `Polling::as_ongoing(idx).is_some()`.
    static ONGOING_POLLS: RefCell<BTreeSet<u32>> = const { RefCell::new(BTreeSet::new()) };
}

pub struct MockGovVoteVerifier;
impl GovVoteVerifier<u64> for MockGovVoteVerifier {
    fn has_live_vote_on(who: &u64, poll_index: u32) -> bool {
        HELD_VOTES.with(|v| v.borrow().contains(&(*who, poll_index)))
            && ONGOING_POLLS.with(|p| p.borrow().contains(&poll_index))
    }
}

/// `who` votes on `poll`, and `poll` is ongoing. The normal, honest case.
fn cast_live_vote(who: u64, poll: u32) {
    HELD_VOTES.with(|v| {
        v.borrow_mut().insert((who, poll));
    });
    ONGOING_POLLS.with(|p| {
        p.borrow_mut().insert(poll);
    });
}

/// The referendum finishes. Upstream does NOT prune the vote — no hook exists that
/// could — so the `VotingFor` entry survives. Only liveness changes.
fn conclude_poll(poll: u32) {
    ONGOING_POLLS.with(|p| {
        p.borrow_mut().remove(&poll);
    });
}

/// The voter calls `remove_vote()` — the only path that clears a `VotingFor` entry.
fn remove_vote(who: u64, poll: u32) {
    HELD_VOTES.with(|v| {
        v.borrow_mut().remove(&(who, poll));
    });
}

fn reset_gov_state() {
    HELD_VOTES.with(|v| v.borrow_mut().clear());
    ONGOING_POLLS.with(|p| p.borrow_mut().clear());
}

// ── Test helpers ─────────────────────────────────────────────────────────────
fn new_test_ext() -> sp_io::TestExternalities {
    // Verifier state is thread-local, and the test harness reuses threads across tests.
    // Reset it here so each test starts from "nobody has voted on anything".
    reset_gov_state();
    let mut storage = frame_system::GenesisConfig::<Test>::default()
        .build_storage()
        .unwrap();
    pallet_balances::GenesisConfig::<Test> {
        balances: vec![
            (1, 100_000), // alice
            (2, 100_000), // bob
            (3, 100_000), // charlie
            (4, 10),      // poor_dave
        ],
        // New GenesisConfig field; `None` is the SDK's Default and generates no
        // extra accounts, so the endowed set above is unchanged.
        dev_accounts: None,
    }
    .assimilate_storage(&mut storage)
    .unwrap();
    storage.into()
}

const ALICE: u64 = 1;
const BOB: u64 = 2;

// ── Tests ─────────────────────────────────────────────────────────────────────

#[test]
fn register_basic_tier_works() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));

        assert!(AgentStake::<Test>::contains_key(ALICE));
        assert_eq!(AgentStake::<Test>::get(ALICE), Some(1_000));
        // Fee burned: alice started with 100_000, minus 1000 locked, minus 50 fee
        assert_eq!(Balances::free_balance(ALICE), 100_000 - 50); // stake is locked not spent
    });
}

#[test]
fn register_full_tier_stake() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 10_000));
        assert_eq!(AgentStake::<Test>::get(ALICE), Some(10_000));
    });
}

#[test]
fn register_fails_below_min_stake() {
    new_test_ext().execute_with(|| {
        assert_noop!(
            Agents::register(RuntimeOrigin::signed(ALICE), 999),
            Error::<Test>::StakeTooLow
        );
    });
}

#[test]
fn register_fails_if_already_registered() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_noop!(
            Agents::register(RuntimeOrigin::signed(ALICE), 1_000),
            Error::<Test>::AlreadyRegistered
        );
    });
}

#[test]
fn register_fails_if_insufficient_balance() {
    new_test_ext().execute_with(|| {
        // poor_dave has only 10 tokens — can't cover stake (1000) + fee (50) + existential (1)
        assert_noop!(
            Agents::register(RuntimeOrigin::signed(4), 1_000),
            Error::<Test>::StakeTooLow
        );
    });
}

#[test]
fn add_stake_increases_locked_amount() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::add_stake(RuntimeOrigin::signed(ALICE), 5_000));
        assert_eq!(AgentStake::<Test>::get(ALICE), Some(6_000));
    });
}

#[test]
fn request_unstake_and_complete_works() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));

        assert_ok!(Agents::request_unstake(RuntimeOrigin::signed(ALICE)));
        assert!(UnstakeAt::<Test>::contains_key(ALICE));

        // Try to complete before cooldown — should fail
        assert_noop!(
            Agents::complete_unstake(RuntimeOrigin::signed(ALICE)),
            Error::<Test>::UnstakeCooldownNotElapsed
        );

        // Advance past cooldown
        frame_system::Pallet::<Test>::set_block_number(101);

        assert_ok!(Agents::complete_unstake(RuntimeOrigin::signed(ALICE)));
        assert!(!AgentStake::<Test>::contains_key(ALICE));
    });
}

#[test]
fn era_volume_tracking_increments_correctly() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::register(RuntimeOrigin::signed(BOB), 1_000));

        // Alice delivers to Bob (alice = provider, bob = buyer)
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &BOB, 500));
        assert_eq!(EraEscrowVolume::<Test>::get(ALICE), 500);
        assert_eq!(EraUniqueBuyers::<Test>::get(ALICE), 1);
        assert_eq!(CompletedAgreements::<Test>::get(ALICE), 1);
    });
}

#[test]
fn drain_era_maps_clears_per_era_storage() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::register(RuntimeOrigin::signed(BOB), 1_000));
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &BOB, 500));
        assert_eq!(EraNumber::<Test>::get(), 0);

        Agents::drain_era_maps(0);

        // Per-era maps cleared
        assert_eq!(EraEscrowVolume::<Test>::get(ALICE), 0);
        assert_eq!(EraUniqueBuyers::<Test>::get(ALICE), 0);
        // Era number incremented
        assert_eq!(EraNumber::<Test>::get(), 1);
        // Active snapshot set (alice had volume)
        assert_eq!(EraActiveSnapshot::<Test>::get(), 1);
    });
}

#[test]
fn ring_signal_excludes_first_era_agents() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::register(RuntimeOrigin::signed(BOB), 1_000));

        // Alice's first ever completion — should NOT be ring-flagged
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &BOB, 500));
        // unique_buyers = 1, completions = 1 (first era agent)

        Agents::drain_era_maps(0);

        // Ring snapshot should be 0 — Alice is first-era, excluded
        assert_eq!(EraRingSnapshot::<Test>::get(), 0);
    });
}

#[test]
fn ring_signal_fires_on_established_single_buyer_agent() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::register(RuntimeOrigin::signed(BOB), 1_000));
        assert_ok!(Agents::register(RuntimeOrigin::signed(3), 1_000)); // carol

        // Era 0: alice's first completion with bob — excluded from ring signal
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &BOB, 500));
        Agents::drain_era_maps(0);

        // Era 1: alice completes again, only with bob → established + unique_buyers=1 → ring suspect
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &BOB, 500));
        // 2 lifetime completions now — alice IS established

        Agents::drain_era_maps(1);
        assert_eq!(EraRingSnapshot::<Test>::get(), 1); // Alice flagged
    });
}

#[test]
fn integer_sqrt_correct() {
    assert_eq!(integer_sqrt(0), 0);
    assert_eq!(integer_sqrt(1), 1);
    assert_eq!(integer_sqrt(4), 2);
    assert_eq!(integer_sqrt(9), 3);
    assert_eq!(integer_sqrt(100), 10);
    assert_eq!(integer_sqrt(10_000), 100);
    assert_eq!(integer_sqrt(u128::MAX), 18_446_744_073_709_551_615u128);
}

/// Regression: the Newton seed `(n + 1) / 2` overflowed at the top of the
/// domain — panicking in debug and, worse, wrapping to a *wrong root* in the
/// release WASM that actually computes emission weight. Pins the boundary.
#[test]
fn integer_sqrt_no_overflow_at_domain_boundary() {
    // 1 CMN = 10^12 plancks; the anti-whale curve on realistic magnitudes.
    assert_eq!(integer_sqrt(1_000_000_000_000), 1_000_000);

    // (2^64 - 1)^2 = u128::MAX - 2^65 + 2: the largest exact square in u128.
    let max_root = u64::MAX as u128;
    assert_eq!(integer_sqrt(max_root * max_root), max_root);
    assert_eq!(integer_sqrt(max_root * max_root - 1), max_root - 1);

    // Everything above that square, up to and including u128::MAX, floors to
    // the same root. These are the inputs the old seed could not represent.
    assert_eq!(integer_sqrt(max_root * max_root + 1), max_root);
    assert_eq!(integer_sqrt(u128::MAX - 1), max_root);
    assert_eq!(integer_sqrt(u128::MAX), max_root);

    // Defining property across the whole domain: s² ≤ n < (s+1)².
    for n in [
        0u128,
        1,
        2,
        3,
        u64::MAX as u128,
        1u128 << 100,
        u128::MAX / 3,
        u128::MAX - 1,
        u128::MAX,
    ] {
        let s = integer_sqrt(n);
        assert!(s.checked_mul(s).is_some_and(|sq| sq <= n), "s² > n at {n}");
        assert!(
            s.checked_add(1)
                .and_then(|t| t.checked_mul(t))
                .is_none_or(|sq| sq > n),
            "(s+1)² ≤ n at {n}"
        );
    }
}

#[test]
fn heartbeat_multiplier_full_when_fresh() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        frame_system::Pallet::<Test>::set_block_number(1);
        assert_ok!(Agents::heartbeat(RuntimeOrigin::signed(ALICE)));
        // Just sent heartbeat — should be 100
        assert_eq!(Agents::heartbeat_multiplier(&ALICE), 100);
    });
}

#[test]
fn update_metadata_stores_uri_and_name() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));

        let uri = b"https://alice-agent.example.com/rpc"
            .to_vec()
            .try_into()
            .unwrap();
        let name = b"Alice AI Agent".to_vec().try_into().unwrap();

        assert_ok!(Agents::update_metadata(
            RuntimeOrigin::signed(ALICE),
            uri,
            name
        ));

        let meta = AgentMetadata::<Test>::get(ALICE).expect("metadata should exist");
        assert_eq!(meta.uri.as_slice(), b"https://alice-agent.example.com/rpc");
        assert_eq!(meta.name.as_slice(), b"Alice AI Agent");
        assert_eq!(meta.updated_at, 0u64);
    });
}

#[test]
fn update_metadata_fails_for_non_agent() {
    new_test_ext().execute_with(|| {
        let uri = b"https://example.com".to_vec().try_into().unwrap();
        let name = b"Nobody".to_vec().try_into().unwrap();
        assert_noop!(
            Agents::update_metadata(RuntimeOrigin::signed(ALICE), uri, name),
            Error::<Test>::NotRegistered
        );
    });
}

#[test]
fn set_capability_stores_and_removes() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));

        // Set capability 42 active
        assert_ok!(Agents::set_capability(
            RuntimeOrigin::signed(ALICE),
            42,
            true
        ));
        let caps = AgentCapabilities::<Test>::get(ALICE);
        assert!(caps.contains(&42u32));

        // Set capability 100 active
        assert_ok!(Agents::set_capability(
            RuntimeOrigin::signed(ALICE),
            100,
            true
        ));
        let caps = AgentCapabilities::<Test>::get(ALICE);
        assert!(caps.contains(&42u32));
        assert!(caps.contains(&100u32));

        // Deactivate capability 42
        assert_ok!(Agents::set_capability(
            RuntimeOrigin::signed(ALICE),
            42,
            false
        ));
        let caps = AgentCapabilities::<Test>::get(ALICE);
        assert!(!caps.contains(&42u32));
        assert!(caps.contains(&100u32));
    });
}

#[test]
fn complete_unstake_clears_metadata_and_capabilities() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        let uri = b"https://alice.ai".to_vec().try_into().unwrap();
        let name = b"Alice".to_vec().try_into().unwrap();
        assert_ok!(Agents::update_metadata(
            RuntimeOrigin::signed(ALICE),
            uri,
            name
        ));
        assert_ok!(Agents::set_capability(
            RuntimeOrigin::signed(ALICE),
            7,
            true
        ));

        assert_ok!(Agents::request_unstake(RuntimeOrigin::signed(ALICE)));
        frame_system::Pallet::<Test>::set_block_number(101);
        assert_ok!(Agents::complete_unstake(RuntimeOrigin::signed(ALICE)));

        // All storage cleared
        assert!(AgentMetadata::<Test>::get(ALICE).is_none());
        assert!(AgentCapabilities::<Test>::get(ALICE).is_empty());
    });
}

#[test]
fn delegate_voting_stores_record() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        // Delegate to BOB until block 500
        assert_ok!(Agents::delegate_voting(
            RuntimeOrigin::signed(ALICE),
            BOB,
            500
        ));
        let record = VotingDelegations::<Test>::get(ALICE).expect("delegation should exist");
        assert_eq!(record.delegate_to, BOB);
        assert_eq!(record.expires_at, 500u64);
    });
}

#[test]
fn delegate_voting_remove_with_zero_until() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::delegate_voting(
            RuntimeOrigin::signed(ALICE),
            BOB,
            500
        ));
        // Pass until=0 to remove
        assert_ok!(Agents::delegate_voting(
            RuntimeOrigin::signed(ALICE),
            BOB,
            0
        ));
        assert!(VotingDelegations::<Test>::get(ALICE).is_none());
    });
}

#[test]
fn delegate_voting_fails_with_past_block() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        frame_system::Pallet::<Test>::set_block_number(100);
        // until=50 is in the past (current block=100)
        assert_noop!(
            Agents::delegate_voting(RuntimeOrigin::signed(ALICE), BOB, 50),
            Error::<Test>::DelegationExpired
        );
    });
}

#[test]
fn delegate_voting_fails_period_too_long() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        // MaxDelegationPeriod = 90_000 blocks in test config
        // Try to delegate for 100_000 blocks — exceeds maximum
        assert_noop!(
            Agents::delegate_voting(RuntimeOrigin::signed(ALICE), BOB, 100_001),
            Error::<Test>::DelegationPeriodTooLong
        );
        // Exactly at limit should work
        assert_ok!(Agents::delegate_voting(
            RuntimeOrigin::signed(ALICE),
            BOB,
            90_000
        ));
    });
}

#[test]
fn slash_appeal_stores_record() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        SlashRecords::<Test>::insert(ALICE, 0, 100);
        let reason = [42u8; 32];
        // Submit appeal for era 0 while in early era
        assert_ok!(Agents::slash_appeal(
            RuntimeOrigin::signed(ALICE),
            0,
            reason
        ));
        let rec = PendingSlashAppeals::<Test>::get(ALICE).expect("appeal should exist");
        assert_eq!(rec.slash_era, 0);
        assert_eq!(rec.reason_hash, reason);
    });
}

#[test]
fn slash_appeal_cleared_on_unstake() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        SlashRecords::<Test>::insert(ALICE, 0, 100);
        assert_ok!(Agents::slash_appeal(
            RuntimeOrigin::signed(ALICE),
            0,
            [0u8; 32]
        ));
        assert!(PendingSlashAppeals::<Test>::contains_key(ALICE));
        assert_ok!(Agents::request_unstake(RuntimeOrigin::signed(ALICE)));
        // Advance past cooldown
        frame_system::Pallet::<Test>::set_block_number(200);
        assert_ok!(Agents::complete_unstake(RuntimeOrigin::signed(ALICE)));
        assert!(!PendingSlashAppeals::<Test>::contains_key(ALICE));
    });
}

#[test]
fn slash_appeal_duplicate_rejected() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        SlashRecords::<Test>::insert(ALICE, 0, 100);
        assert_ok!(Agents::slash_appeal(
            RuntimeOrigin::signed(ALICE),
            0,
            [0u8; 32]
        ));
        // Second appeal while first is pending
        assert_noop!(
            Agents::slash_appeal(RuntimeOrigin::signed(ALICE), 0, [1u8; 32]),
            Error::<Test>::AppealAlreadyPending
        );
    });
}

#[test]
fn slash_appeal_requires_slash_record() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        // Alice was never slashed: there is nothing to appeal.
        assert_noop!(
            Agents::slash_appeal(RuntimeOrigin::signed(ALICE), 0, [7u8; 32]),
            Error::<Test>::NoSuchSlash
        );
        assert!(!PendingSlashAppeals::<Test>::contains_key(ALICE));
        // A record for a different era does not cover this one.
        SlashRecords::<Test>::insert(ALICE, 1, 100);
        assert_noop!(
            Agents::slash_appeal(RuntimeOrigin::signed(ALICE), 0, [7u8; 32]),
            Error::<Test>::NoSuchSlash
        );
        assert_ok!(Agents::slash_appeal(
            RuntimeOrigin::signed(ALICE),
            1,
            [7u8; 32]
        ));
    });
}

#[test]
fn slash_appeal_capped_per_account() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        for era in 0..=MAX_OPEN_APPEALS {
            SlashRecords::<Test>::insert(ALICE, era, 100);
        }
        for era in 0..MAX_OPEN_APPEALS {
            assert_ok!(Agents::slash_appeal(
                RuntimeOrigin::signed(ALICE),
                era,
                [era as u8; 32]
            ));
        }
        assert_eq!(OpenAppealCount::<Test>::get(ALICE), MAX_OPEN_APPEALS);
        assert_noop!(
            Agents::slash_appeal(RuntimeOrigin::signed(ALICE), MAX_OPEN_APPEALS, [9u8; 32]),
            Error::<Test>::TooManyOpenAppeals
        );
        // The cap is per account: Bob is unaffected.
        assert_ok!(Agents::register(RuntimeOrigin::signed(BOB), 1_000));
        SlashRecords::<Test>::insert(BOB, 0, 100);
        assert_ok!(Agents::slash_appeal(
            RuntimeOrigin::signed(BOB),
            0,
            [1u8; 32]
        ));
    });
}

#[test]
fn second_era_appeal_does_not_overwrite_first() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        SlashRecords::<Test>::insert(ALICE, 0, 100);
        SlashRecords::<Test>::insert(ALICE, 1, 100);
        assert_ok!(Agents::slash_appeal(
            RuntimeOrigin::signed(ALICE),
            0,
            [0xAA; 32]
        ));
        assert_ok!(Agents::slash_appeal(
            RuntimeOrigin::signed(ALICE),
            1,
            [0xBB; 32]
        ));
        assert_eq!(
            OpenAppeals::<Test>::get(ALICE, 0).unwrap().reason_hash,
            [0xAA; 32]
        );
        assert_eq!(
            OpenAppeals::<Test>::get(ALICE, 1).unwrap().reason_hash,
            [0xBB; 32]
        );
        let pending = PendingSlashAppeals::<Test>::get(ALICE).unwrap();
        assert_eq!(pending.slash_era, 0);
        assert_eq!(pending.reason_hash, [0xAA; 32]);
    });
}

#[test]
fn execute_slash_records_slash_and_clears_open_appeals() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        SlashRecords::<Test>::insert(ALICE, 0, 100);
        assert_ok!(Agents::slash_appeal(
            RuntimeOrigin::signed(ALICE),
            0,
            [1u8; 32]
        ));
        // Slash in a later era than the planted record: a same-era slash would accumulate
        // onto it (#216), which `same_era_slash_*` covers.
        EraNumber::<Test>::put(1u32);
        assert_ok!(Agents::execute_slash(RuntimeOrigin::root(), ALICE, 100));
        assert_eq!(
            SlashRecords::<Test>::get(ALICE, EraNumber::<Test>::get()),
            Some(100)
        );
        assert_eq!(SlashRecords::<Test>::get(ALICE, 0), Some(100));
        assert_eq!(OpenAppealCount::<Test>::get(ALICE), 0);
        assert!(!OpenAppeals::<Test>::contains_key(ALICE, 0));
    });
}

#[test]
fn register_sets_last_heartbeat() {
    // #161: spec 306 already starts the heartbeat clock in `register` (lib.rs, D8). This test
    // documents it at a block far past the grace period; no code change is needed.
    new_test_ext().execute_with(|| {
        System::set_block_number(534_527);
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_eq!(LastHeartbeat::<Test>::get(ALICE), 534_527);
    });
}

// ── ROUND14: governance credit is bound to a distinct LIVE referendum ─────────
//
// These four tests are the behavioural coverage the guard shipped without. Each one
// fails against the pre-ROUND14 code:
//   * `gov_credit_*_earns_nothing` — the old verifier never read poll status, so a
//     concluded referendum still paid.
//   * `one_live_vote_credits_exactly_once_per_era` — the old extrinsic took no poll
//     index and had no dedup set, so this loop banked the full 20 credits.
//   * `distinct_live_referenda_each_credit_once_up_to_cap` — passes vacuously today
//     (any 20 calls credited 20), and pins the intended semantics going forward.
//   * `gov_dedup_map_clears_each_era` — new map, so there is nothing to clear today.

const CAROL: u64 = 3;

#[test]
fn gov_credit_on_live_referendum_works() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        cast_live_vote(ALICE, 7);

        assert_ok!(Agents::record_gov_vote(
            RuntimeOrigin::signed(ALICE),
            ALICE,
            7
        ));

        assert_eq!(EraGovParticipation::<Test>::get(ALICE), 1);
        assert!(EraGovVotedPolls::<Test>::get(ALICE, 7));
    });
}

#[test]
fn gov_credit_on_concluded_referendum_earns_nothing() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        cast_live_vote(ALICE, 7);
        assert_ok!(Agents::record_gov_vote(
            RuntimeOrigin::signed(ALICE),
            ALICE,
            7
        ));
        assert_eq!(EraGovParticipation::<Test>::get(ALICE), 1);

        // New era, and referendum 7 has since concluded. The vote is STILL held —
        // upstream conviction-voting prunes nothing on poll completion — which is
        // precisely why "does this account hold a vote?" was not a sufficient question.
        Agents::drain_era_maps(0);
        conclude_poll(7);
        assert!(HELD_VOTES.with(|v| v.borrow().contains(&(ALICE, 7))));

        assert_noop!(
            Agents::record_gov_vote(RuntimeOrigin::signed(ALICE), ALICE, 7),
            Error::<Test>::NotActivelyVoting
        );
        assert_eq!(EraGovParticipation::<Test>::get(ALICE), 0);
    });
}

#[test]
fn gov_credit_on_removed_vote_earns_nothing() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        cast_live_vote(ALICE, 7);
        // Referendum stays live, but the agent withdrew its vote.
        remove_vote(ALICE, 7);

        assert_noop!(
            Agents::record_gov_vote(RuntimeOrigin::signed(ALICE), ALICE, 7),
            Error::<Test>::NotActivelyVoting
        );
        assert_eq!(EraGovParticipation::<Test>::get(ALICE), 0);
    });
}

#[test]
fn gov_credit_requires_a_vote_on_that_specific_poll() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        // Alice votes on 1; poll 2 is live but she has not voted on it.
        cast_live_vote(ALICE, 1);
        cast_live_vote(BOB, 2);

        assert_noop!(
            Agents::record_gov_vote(RuntimeOrigin::signed(ALICE), ALICE, 2),
            Error::<Test>::NotActivelyVoting
        );
        assert_eq!(EraGovParticipation::<Test>::get(ALICE), 0);
    });
}

#[test]
fn one_live_vote_credits_exactly_once_per_era() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        cast_live_vote(ALICE, 3);

        assert_ok!(Agents::record_gov_vote(
            RuntimeOrigin::signed(ALICE),
            ALICE,
            3
        ));

        // The whole of the rest of the per-era budget, spent on the same referendum.
        // Pre-ROUND14 every one of these succeeded and EraGovParticipation ended at 20,
        // worth the full +alpha bps of activity for a single historical click.
        for _ in 1..<Test as Config>::MaxProposalsPerEra::get() {
            assert_noop!(
                Agents::record_gov_vote(RuntimeOrigin::signed(ALICE), ALICE, 3),
                Error::<Test>::PollAlreadyCredited
            );
        }
        assert_eq!(EraGovParticipation::<Test>::get(ALICE), 1);
    });
}

#[test]
fn distinct_live_referenda_each_credit_once_up_to_cap() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));

        // Three distinct live referenda → exactly three credits.
        for poll in 0..3u32 {
            cast_live_vote(ALICE, poll);
            assert_ok!(Agents::record_gov_vote(
                RuntimeOrigin::signed(ALICE),
                ALICE,
                poll
            ));
        }
        assert_eq!(EraGovParticipation::<Test>::get(ALICE), 3);

        // A second sweep over the SAME three still-live referenda adds nothing. This is
        // the half that fails pre-ROUND14: with no poll index bound to the credit, every
        // one of these calls succeeded and the count reached 6.
        for poll in 0..3u32 {
            assert_noop!(
                Agents::record_gov_vote(RuntimeOrigin::signed(ALICE), ALICE, poll),
                Error::<Test>::PollAlreadyCredited
            );
        }
        assert_eq!(EraGovParticipation::<Test>::get(ALICE), 3);

        // Take it to the per-era ceiling, then one past it.
        let cap = <Test as Config>::MaxProposalsPerEra::get();
        for poll in 3..cap {
            cast_live_vote(ALICE, poll);
            assert_ok!(Agents::record_gov_vote(
                RuntimeOrigin::signed(ALICE),
                ALICE,
                poll
            ));
        }
        assert_eq!(EraGovParticipation::<Test>::get(ALICE), cap);

        cast_live_vote(ALICE, cap);
        assert_noop!(
            Agents::record_gov_vote(RuntimeOrigin::signed(ALICE), ALICE, cap),
            Error::<Test>::GovVoteCapReached
        );
        assert_eq!(EraGovParticipation::<Test>::get(ALICE), cap);
    });
}

#[test]
fn gov_dedup_map_clears_each_era() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        cast_live_vote(ALICE, 5);
        assert_ok!(Agents::record_gov_vote(
            RuntimeOrigin::signed(ALICE),
            ALICE,
            5
        ));
        assert!(EraGovVotedPolls::<Test>::get(ALICE, 5));

        Agents::drain_era_maps(0);

        // A long-running referendum is still live next era, and should pay again —
        // the dedup set is per-era, not permanent.
        assert!(!EraGovVotedPolls::<Test>::get(ALICE, 5));
        assert_eq!(EraGovParticipation::<Test>::get(ALICE), 0);
        assert_ok!(Agents::record_gov_vote(
            RuntimeOrigin::signed(ALICE),
            ALICE,
            5
        ));
        assert_eq!(EraGovParticipation::<Test>::get(ALICE), 1);
    });
}

// ── ROUND14: diversity credit is order-independent for honest buyers ──────────

#[test]
fn diversity_credits_buyer_whose_escrow_crosses_the_ratio_cap() {
    new_test_ext().execute_with(|| {
        // stake 1,000 × MaxVolToStakeRatio 10 → diversity cap = 10,000 era volume.
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::register(RuntimeOrigin::signed(BOB), 1_000));
        assert_ok!(Agents::register(RuntimeOrigin::signed(CAROL), 1_000));

        // Alice takes her whole cap's worth of volume from Bob.
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &BOB, 10_000));
        assert_eq!(EraUniqueBuyers::<Test>::get(ALICE), 1);

        // Carol is a genuine new counterparty arriving after the cap is reached. She
        // is judged on the volume Alice had BEFORE her deal (10,000, exactly at cap),
        // not on the total her own escrow creates. Pre-ROUND14 the post-escrow total
        // (10,500) was tested, so Carol was denied credit for the volume she herself
        // brought — and her bloom slot was burned in the same breath.
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &CAROL, 500));
        assert_eq!(EraUniqueBuyers::<Test>::get(ALICE), 2);
        assert_eq!(EraEscrowVolume::<Test>::get(ALICE), 10_500);
    });
}

#[test]
fn diversity_slot_not_burned_when_credit_is_denied() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::register(RuntimeOrigin::signed(BOB), 1_000));
        assert_ok!(Agents::register(RuntimeOrigin::signed(CAROL), 1_000));

        // Bob's first deal is comfortably under the 10,000 cap, so he is credited
        // identically before and after this fix — that keeps this test focused on
        // the slot-burn behaviour alone rather than on the pre/post-total change.
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &BOB, 5_000));
        assert_eq!(EraUniqueBuyers::<Test>::get(ALICE), 1);

        // Alice then runs well past her cap on Bob's volume. Repeat buyers reuse the
        // same bloom slot, so no diversity decision is taken here at all.
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &BOB, 15_000));
        assert_eq!(EraEscrowVolume::<Test>::get(ALICE), 20_000);

        // Carol arrives while Alice is over cap: correctly no credit yet.
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &CAROL, 100));
        assert_eq!(EraUniqueBuyers::<Test>::get(ALICE), 1);

        // Alice raises her stake, which raises her cap to 3,000 × 10 = 30,000.
        assert_ok!(Agents::add_stake(RuntimeOrigin::signed(ALICE), 2_000));

        // Carol's next deal now clears the cap and must earn credit. Pre-ROUND14 her
        // slot was marked "seen" on the denied deal above before the credit test ran,
        // so this short-circuited and she could never earn credit for the rest of the
        // era — an honest counterparty permanently written off for arriving late.
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &CAROL, 100));
        assert_eq!(EraUniqueBuyers::<Test>::get(ALICE), 2);
    });
}

#[test]
fn diversity_still_denied_to_a_buyer_arriving_above_the_cap() {
    new_test_ext().execute_with(|| {
        // Guard-rail, not a regression test: this passes both before and after the
        // reordering. It pins that the stake-weighted cap still binds, so a future
        // change cannot quietly turn the diversity gate into a no-op.
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::register(RuntimeOrigin::signed(BOB), 1_000));
        assert_ok!(Agents::register(RuntimeOrigin::signed(CAROL), 1_000));

        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &BOB, 5_000));
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &BOB, 5_100));
        assert_eq!(EraUniqueBuyers::<Test>::get(ALICE), 1);
        assert_eq!(EraEscrowVolume::<Test>::get(ALICE), 10_100);

        // prior_total 10,100 > cap 10,000 → no credit, and none available later this
        // era either unless Alice raises her stake.
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &CAROL, 1));
        assert_eq!(EraUniqueBuyers::<Test>::get(ALICE), 1);
    });
}

// ── spec 306: D8 heartbeat initialisation (#161) ─────────────────────────────

#[test]
fn register_initialises_last_heartbeat_to_the_current_block() {
    new_test_ext().execute_with(|| {
        // A live chain is not at block 0. #161 was measured at block ~534 500, far past
        // HeartbeatGracePeriod, and that is the only condition under which the bug bites:
        // at block 0 a missing LastHeartbeat and a correct one are indistinguishable.
        System::set_block_number(534_527);
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));

        assert_eq!(
            LastHeartbeat::<Test>::get(ALICE),
            534_527,
            "register must start the heartbeat clock at the current block"
        );
    });
}

#[test]
fn freshly_registered_agent_is_not_below_the_heartbeat_floor() {
    new_test_ext().execute_with(|| {
        System::set_block_number(534_527);
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));

        // pallets/emissions/src/lib.rs gates the floor share on `hb >= 90`. Before D8 the
        // multiplier computed from a gap of the whole chain history — #161 measured 63 —
        // so a brand-new agent was excluded on its first era for a liveness failure it had
        // no opportunity to avoid.
        assert_eq!(
            Agents::heartbeat_multiplier(&ALICE),
            100,
            "a freshly registered agent must sit at the full multiplier, not the decayed floor"
        );
    });
}

#[test]
fn heartbeat_still_decays_after_the_grace_period() {
    new_test_ext().execute_with(|| {
        // D8 must not turn the heartbeat into a formality: registering starts the clock,
        // it does not stop it. Grace is 600 and decay 14_400 in this mock.
        System::set_block_number(1_000);
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_eq!(Agents::heartbeat_multiplier(&ALICE), 100);

        System::set_block_number(1_000 + 600 + 7_200); // half a decay period past grace
        let hb = Agents::heartbeat_multiplier(&ALICE);
        assert!(
            hb < 90,
            "an agent silent for half a decay period must fall below the activity gate, got {hb}"
        );

        // And a real heartbeat restores it.
        assert_ok!(Agents::heartbeat(RuntimeOrigin::signed(ALICE)));
        assert_eq!(Agents::heartbeat_multiplier(&ALICE), 100);
    });
}

// ── spec 306: qualifying volume (D7, #164) ───────────────────────────────────

#[test]
fn era_pair_volume_records_who_paid_whom() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &50, 400));
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &51, 600));
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &50, 100));

        // Value is (era, volume) — the era stamp is what makes a residue from an
        // incomplete clear inert rather than inflationary. See EraPairVolume's docs.
        assert_eq!(EraPairVolume::<Test>::get(ALICE, 50), (0, 500));
        assert_eq!(EraPairVolume::<Test>::get(ALICE, 51), (0, 600));
        assert_eq!(EraEscrowVolume::<Test>::get(ALICE), 1_100);
    });
}

#[test]
fn honest_provider_with_diverse_buyers_qualifies_in_full() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        // Three outside buyers, none of them a provider to ALICE. Nothing to exclude.
        for buyer in 50u64..53 {
            assert_ok!(Agents::add_era_escrow_volume(&ALICE, &buyer, 300));
        }
        assert_eq!(Agents::qualifying_volume_of(&ALICE), 900);
        assert_eq!(Agents::qualifying_era_volume(), 900);
    });
}

#[test]
fn ring_flagged_provider_contributes_no_qualifying_volume() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        // This is #164's shape: every completion in the era from ONE buyer. Two
        // completions makes ALICE established (CompletedAgreements > 1), which together
        // with EraUniqueBuyers <= 1 is exactly the flag drain_era_maps already raises.
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &BOB, 10));
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &BOB, 50));

        assert_eq!(CompletedAgreements::<Test>::get(ALICE), 2);
        assert_eq!(EraUniqueBuyers::<Test>::get(ALICE), 1);
        assert_eq!(EraEscrowVolume::<Test>::get(ALICE), 60);
        assert_eq!(
            Agents::qualifying_volume_of(&ALICE),
            0,
            "a ring-flagged provider must contribute nothing to the emission pot"
        );
    });
}

#[test]
fn first_era_single_buyer_still_qualifies_but_only_for_its_own_volume() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        // One completion — not yet "established", so the ring flag deliberately holds
        // fire. That is the honest-onboarding case. The alpha rule still bounds it: 60
        // units of volume can size at most 60 units of emission at alpha = 1.0.
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &BOB, 60));
        assert_eq!(Agents::qualifying_volume_of(&ALICE), 60);
    });
}

#[test]
fn reciprocal_pair_volume_does_not_qualify() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::register(RuntimeOrigin::signed(BOB), 1_000));
        // A payer<->worker cycle inside one era: ALICE sells to BOB and BOB sells to
        // ALICE. Money in a circle is not demand, in either direction.
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &BOB, 500));
        assert_ok!(Agents::add_era_escrow_volume(&BOB, &ALICE, 500));
        // Give each a second, genuinely outside buyer so neither is ring-flagged and the
        // exclusion under test is the cycle itself, not the diversity gate.
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &60, 200));
        assert_ok!(Agents::add_era_escrow_volume(&BOB, &61, 300));

        assert_eq!(Agents::qualifying_volume_of(&ALICE), 200);
        assert_eq!(Agents::qualifying_volume_of(&BOB), 300);
        assert_eq!(Agents::qualifying_era_volume(), 500);
    });
}

#[test]
fn declared_funding_lineage_excludes_the_pair() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &BOB, 500));
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &60, 400));
        assert_eq!(Agents::qualifying_volume_of(&ALICE), 900);

        // The operator records what the chain cannot see: ALICE and BOB came out of the
        // same faucet drip. pallet_balances exposes no transfer hook, so this is declared.
        assert_ok!(Agents::link_funding_lineage(
            RuntimeOrigin::root(),
            ALICE,
            BOB
        ));
        assert!(Agents::same_funding_lineage(&ALICE, &BOB));
        assert_eq!(
            Agents::qualifying_volume_of(&ALICE),
            400,
            "only the independent buyer's volume may size the pot"
        );
    });
}

#[test]
fn funding_lineage_is_transitive_and_rejects_a_redundant_link() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::link_funding_lineage(RuntimeOrigin::root(), 1, 2));
        assert_ok!(Agents::link_funding_lineage(RuntimeOrigin::root(), 2, 3));
        // 1 and 3 were never linked directly.
        assert!(Agents::same_funding_lineage(&1, &3));
        assert!(!Agents::same_funding_lineage(&1, &99));
        assert_noop!(
            Agents::link_funding_lineage(RuntimeOrigin::root(), 1, 3),
            Error::<Test>::LineageAlreadyLinked
        );
    });
}

#[test]
fn link_funding_lineage_is_root_only() {
    new_test_ext().execute_with(|| {
        assert_noop!(
            Agents::link_funding_lineage(RuntimeOrigin::signed(ALICE), ALICE, BOB),
            sp_runtime::DispatchError::BadOrigin
        );
    });
}

#[test]
fn drain_era_maps_clears_pair_volume_but_not_lineage() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &BOB, 500));
        assert_ok!(Agents::link_funding_lineage(
            RuntimeOrigin::root(),
            ALICE,
            BOB
        ));

        Agents::drain_era_maps(0);

        assert_eq!(
            EraPairVolume::<Test>::get(ALICE, BOB),
            (0, 0),
            "pair volume is per-era"
        );
        assert!(
            Agents::same_funding_lineage(&ALICE, &BOB),
            "lineage is a persistent fact, not an era counter"
        );
    });
}

// ── spec 306: v1 -> v2 migration ─────────────────────────────────────────────

#[test]
fn v2_migration_backfills_last_heartbeat_for_pre_306_agents() {
    new_test_ext().execute_with(|| {
        // Reconstruct the spec-305 shape: agents exist, nothing ever wrote LastHeartbeat,
        // and the pallet is at storage version 1.
        System::set_block_number(1);
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::register(RuntimeOrigin::signed(BOB), 1_000));
        LastHeartbeat::<Test>::remove(ALICE);
        LastHeartbeat::<Test>::remove(BOB);
        StorageVersion::new(1).put::<Pallet<Test>>();

        // ...and let the chain age past the grace period, which is the only condition
        // under which the missing key does any damage.
        System::set_block_number(534_527);
        assert!(
            Agents::heartbeat_multiplier(&ALICE) < 90,
            "precondition: a pre-306 agent is under the activity gate"
        );

        // Asserting on the returned Weight would test the mock's DbWeight rather than the
        // migration. What the migration must be judged on is the state it leaves behind.
        let _ = <Pallet<Test> as Hooks<u64>>::on_runtime_upgrade();

        assert_eq!(StorageVersion::get::<Pallet<Test>>(), 2);
        assert_eq!(LastHeartbeat::<Test>::get(ALICE), 534_527);
        assert_eq!(LastHeartbeat::<Test>::get(BOB), 534_527);
        assert_eq!(Agents::heartbeat_multiplier(&ALICE), 100);
    });
}

#[test]
fn v2_migration_never_moves_a_real_heartbeat_forward() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        System::set_block_number(400_000);
        assert_ok!(Agents::heartbeat(RuntimeOrigin::signed(ALICE)));
        StorageVersion::new(1).put::<Pallet<Test>>();

        System::set_block_number(534_527);
        let _ = <Pallet<Test> as Hooks<u64>>::on_runtime_upgrade();

        assert_eq!(
            LastHeartbeat::<Test>::get(ALICE),
            400_000,
            "an agent that DID heartbeat keeps its own timestamp — the migration must not \
             launder a stale agent into a fresh one"
        );
    });
}

#[test]
fn v2_migration_is_idempotent() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        LastHeartbeat::<Test>::remove(ALICE);
        StorageVersion::new(1).put::<Pallet<Test>>();

        System::set_block_number(100);
        let _ = <Pallet<Test> as Hooks<u64>>::on_runtime_upgrade();
        assert_eq!(LastHeartbeat::<Test>::get(ALICE), 100);

        // A second pass (a re-run, or the next upgrade) must be a no-op, not a second
        // backfill that silently resets everyone's clock.
        System::set_block_number(200);
        let _ = <Pallet<Test> as Hooks<u64>>::on_runtime_upgrade();
        assert_eq!(LastHeartbeat::<Test>::get(ALICE), 100);
        assert_eq!(StorageVersion::get::<Pallet<Test>>(), 2);
    });
}

// ── spec 306: hardening from the tokenomics review ───────────────────────────

#[test]
fn stale_pair_volume_from_an_incomplete_clear_does_not_re_qualify() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &50, 400));
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &51, 400));
        assert_eq!(Agents::qualifying_volume_of(&ALICE), 800);

        // Simulate what an incomplete `clear(limit, None)` leaves behind: the era counters
        // are gone, the pair entries are not. Without the era stamp these would read as
        // fresh volume every era from here on, with no new escrow behind them —
        // a monotonic inflation of the emission ceiling.
        EraNumber::<Test>::put(1);
        EraUniqueBuyers::<Test>::remove(ALICE);
        EraEscrowVolume::<Test>::remove(ALICE);

        assert_eq!(
            Agents::qualifying_volume_of(&ALICE),
            0,
            "volume stamped with a past era is not this era's work"
        );
    });
}

#[test]
fn qualifying_volume_is_capped_at_stake_times_the_vol_to_stake_ratio() {
    new_test_ext().execute_with(|| {
        // MaxVolToStakeRatio is 10 in this mock, matching the runtime.
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        // Recycle the same money through two cooperative buyers, far past what 1,000 of
        // locked stake could plausibly service. Neither buyer is a provider, so no
        // reciprocal edge exists and the ring flag never fires — this is the wash-trading
        // shape that the ring and cycle rules cannot see.
        for _ in 0..20 {
            assert_ok!(Agents::add_era_escrow_volume(&ALICE, &50, 1_000));
            assert_ok!(Agents::add_era_escrow_volume(&ALICE, &51, 1_000));
        }
        assert_eq!(EraEscrowVolume::<Test>::get(ALICE), 40_000);

        assert_eq!(
            Agents::qualifying_volume_of(&ALICE),
            10_000,
            "sizing the pot must cost locked capital, not just a completion fee"
        );
    });
}

#[test]
fn unlink_restores_qualifying_volume_after_a_mistaken_link() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &BOB, 500));
        assert_ok!(Agents::add_era_escrow_volume(&ALICE, &60, 400));

        assert_ok!(Agents::link_funding_lineage(
            RuntimeOrigin::root(),
            ALICE,
            BOB
        ));
        assert_eq!(Agents::qualifying_volume_of(&ALICE), 400);

        // link_funding_lineage asserts an off-chain fact, and assertions can be wrong.
        assert_ok!(Agents::unlink_funding_lineage(RuntimeOrigin::root(), BOB));
        assert!(!Agents::same_funding_lineage(&ALICE, &BOB));
        assert_eq!(Agents::qualifying_volume_of(&ALICE), 900);

        assert_noop!(
            Agents::unlink_funding_lineage(RuntimeOrigin::root(), BOB),
            Error::<Test>::LineageNotLinked
        );
        assert_noop!(
            Agents::unlink_funding_lineage(RuntimeOrigin::signed(ALICE), BOB),
            sp_runtime::DispatchError::BadOrigin
        );
    });
}

#[test]
fn an_unresolvable_lineage_chain_fails_closed() {
    new_test_ext().execute_with(|| {
        // Hand-build a parent chain longer than MAX_LINEAGE_DEPTH. Only root can create
        // links, so this is not attacker-reachable — but a guard that degrades must
        // degrade in the direction that pays out LESS, and under D7 "these two are
        // unlinked" is the pay-more answer.
        for i in 200u64..220 {
            LineageParent::<Test>::insert(i, i + 1);
        }
        assert!(Agents::lineage_root(&200).is_none());
        assert!(
            Agents::same_funding_lineage(&200, &ALICE),
            "an undecidable lineage walk must report linked, not unlinked"
        );

        assert_noop!(
            Agents::link_funding_lineage(RuntimeOrigin::root(), 200, ALICE),
            Error::<Test>::LineageTooDeep
        );
    });
}

#[test]
fn linking_keeps_the_common_case_at_depth_one() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::link_funding_lineage(RuntimeOrigin::root(), 1, 2));
        assert_eq!(LineageParent::<Test>::get(2), Some(1));
        assert_eq!(Agents::lineage_root(&2), Some(1));
        assert_eq!(Agents::lineage_root(&1), Some(1));
    });
}

// ── #187: findings encoded as ledger-level tests ─────────────────────────────
//
// Every test below asserts on storage and on deposited events, never on a call's return
// value alone ("trust the ledger"). Failure paths use `assert_noop!` so a rejected call is
// proven to leave storage untouched, and additionally check that no pallet event leaked.
//
// Finding labels (E20, minStake freeze, heartbeat gate, unstake cooldown, E33, E22) follow
// the sprint runbook §1.4 table.

/// Blocks start at 0 in the mock, and `frame_system` drops events deposited at block 0.
/// Start at block 1 with an empty event log.
fn start() {
    System::set_block_number(1);
    System::reset_events();
}

/// Every `pallet-agents` event deposited since the last `start()`/`clear_events()`, in order.
fn agent_events() -> Vec<Event<Test>> {
    System::events()
        .into_iter()
        .filter_map(|r| match r.event {
            RuntimeEvent::Agents(e) => Some(e),
            _ => None,
        })
        .collect()
}

fn clear_events() {
    System::reset_events();
}

/// Full storage footprint of an agent for the lifecycle keys `complete_unstake` must wipe.
fn assert_no_agent_state(who: u64) {
    assert!(!AgentStake::<Test>::contains_key(who));
    assert!(!UnstakeAt::<Test>::contains_key(who));
    assert!(!StakeRegisteredAt::<Test>::contains_key(who));
    assert!(!LastHeartbeat::<Test>::contains_key(who));
    assert!(!CompletedAgreements::<Test>::contains_key(who));
    assert!(!AgentMetadata::<Test>::contains_key(who));
    assert!(AgentCapabilities::<Test>::get(who).is_empty());
    assert!(!VotingDelegations::<Test>::contains_key(who));
    assert!(!PendingSlashAppeals::<Test>::contains_key(who));
    assert_eq!(OpenAppealCount::<Test>::get(who), 0);
    assert!(
        Balances::locks(&who).is_empty(),
        "stake lock must be released"
    );
}

// ── E20: re-registration ─────────────────────────────────────────────────────

#[test]
fn e20_register_writes_state_and_emits_event() {
    new_test_ext().execute_with(|| {
        start();
        System::set_block_number(42);
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 2_500));

        assert_eq!(AgentStake::<Test>::get(ALICE), Some(2_500));
        assert_eq!(StakeRegisteredAt::<Test>::get(ALICE), 42);
        assert_eq!(LastHeartbeat::<Test>::get(ALICE), 42);
        assert_eq!(
            Balances::free_balance(ALICE),
            100_000 - 50,
            "only the fee leaves"
        );
        let locks = Balances::locks(&ALICE);
        assert_eq!(locks.len(), 1);
        assert_eq!(locks[0].amount, 2_500);
        assert_eq!(
            agent_events(),
            vec![Event::AgentRegistered {
                who: ALICE,
                stake: 2_500,
                fee: 50
            }]
        );
    });
}

#[test]
fn e20_duplicate_register_is_a_noop_on_the_ledger() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        clear_events();
        System::set_block_number(50);
        let free = Balances::free_balance(ALICE);

        assert_noop!(
            Agents::register(RuntimeOrigin::signed(ALICE), 5_000),
            Error::<Test>::AlreadyRegistered
        );
        // Stake, clock and balance are exactly as they were; no second fee was burned.
        assert_eq!(AgentStake::<Test>::get(ALICE), Some(1_000));
        assert_eq!(StakeRegisteredAt::<Test>::get(ALICE), 1);
        assert_eq!(LastHeartbeat::<Test>::get(ALICE), 1);
        assert_eq!(Balances::free_balance(ALICE), free);
        assert_eq!(Balances::locks(&ALICE)[0].amount, 1_000);
        assert!(agent_events().is_empty());
    });
}

#[test]
fn e20_register_while_unstake_pending_is_rejected_and_keeps_the_request() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::request_unstake(RuntimeOrigin::signed(ALICE)));
        clear_events();

        assert_noop!(
            Agents::register(RuntimeOrigin::signed(ALICE), 1_000),
            Error::<Test>::AlreadyRegistered
        );
        assert_eq!(UnstakeAt::<Test>::get(ALICE), Some(1 + 100));
        assert!(agent_events().is_empty());
    });
}

#[test]
fn e20_reregistration_after_unstake_starts_from_a_clean_slate() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));

        // Accumulate every piece of per-agent state the first life can leave behind.
        assert_ok!(Agents::update_metadata(
            RuntimeOrigin::signed(ALICE),
            b"ipfs://old".to_vec().try_into().unwrap(),
            b"old-name".to_vec().try_into().unwrap(),
        ));
        assert_ok!(Agents::delegate_voting(
            RuntimeOrigin::signed(ALICE),
            BOB,
            500
        ));
        CompletedAgreements::<Test>::insert(ALICE, 7);
        assert_ok!(Agents::heartbeat(RuntimeOrigin::signed(ALICE)));

        assert_ok!(Agents::request_unstake(RuntimeOrigin::signed(ALICE)));
        System::set_block_number(101);
        assert_ok!(Agents::complete_unstake(RuntimeOrigin::signed(ALICE)));
        assert_no_agent_state(ALICE);
        assert_eq!(
            agent_events().last(),
            Some(&Event::UnstakeCompleted {
                who: ALICE,
                released: 1_000
            })
        );

        // Second life, much later, at a different stake.
        System::set_block_number(9_000);
        clear_events();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 3_000));

        assert_eq!(AgentStake::<Test>::get(ALICE), Some(3_000));
        assert_eq!(StakeRegisteredAt::<Test>::get(ALICE), 9_000);
        assert_eq!(LastHeartbeat::<Test>::get(ALICE), 9_000);
        assert_eq!(Agents::heartbeat_multiplier(&ALICE), 100);
        assert_eq!(
            CompletedAgreements::<Test>::get(ALICE),
            0,
            "old track record must not carry over"
        );
        assert!(AgentMetadata::<Test>::get(ALICE).is_none());
        assert!(VotingDelegations::<Test>::get(ALICE).is_none());
        assert!(UnstakeAt::<Test>::get(ALICE).is_none());
        assert_eq!(Balances::locks(&ALICE)[0].amount, 3_000);
        assert_eq!(
            agent_events(),
            vec![Event::AgentRegistered {
                who: ALICE,
                stake: 3_000,
                fee: 50
            }]
        );
    });
}

#[test]
fn e20_reregistration_after_full_slash_eviction_works() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        // A 100% slash takes stake below MinStake: the AgentStake entry is removed.
        assert_ok!(Agents::execute_slash(RuntimeOrigin::root(), ALICE, 10_000));
        assert!(!AgentStake::<Test>::contains_key(ALICE));
        assert!(Balances::locks(&ALICE).is_empty());
        assert_eq!(
            agent_events().last(),
            Some(&Event::SlashExecuted {
                who: ALICE,
                amount: 1_000,
                burn: 500,
                treasury: 500
            })
        );

        System::set_block_number(20);
        clear_events();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_eq!(AgentStake::<Test>::get(ALICE), Some(1_000));
        assert_eq!(LastHeartbeat::<Test>::get(ALICE), 20);
        assert_eq!(Balances::locks(&ALICE)[0].amount, 1_000);
        assert_eq!(agent_events().len(), 1);
    });
}

// ── minStake freeze ──────────────────────────────────────────────────────────

#[test]
fn min_stake_boundary_exact_min_registers_one_below_does_not() {
    new_test_ext().execute_with(|| {
        start();
        assert_noop!(
            Agents::register(RuntimeOrigin::signed(ALICE), 999),
            Error::<Test>::StakeTooLow
        );
        assert!(!AgentStake::<Test>::contains_key(ALICE));
        assert!(Balances::locks(&ALICE).is_empty());
        assert_eq!(
            Balances::free_balance(ALICE),
            100_000,
            "no fee burned on a rejected register"
        );
        assert!(agent_events().is_empty());

        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_eq!(AgentStake::<Test>::get(ALICE), Some(1_000));
        assert_eq!(agent_events().len(), 1);
    });
}

#[test]
fn min_stake_ceiling_is_enforced() {
    new_test_ext().execute_with(|| {
        start();
        assert_noop!(
            Agents::register(RuntimeOrigin::signed(ALICE), 1_000_001),
            Error::<Test>::StakeTooHigh
        );
        assert!(!AgentStake::<Test>::contains_key(ALICE));
        assert!(agent_events().is_empty());

        // The ceiling is a hard bound, not a clamp: nothing was locked or burned.
        assert!(Balances::locks(&ALICE).is_empty());
        assert_eq!(Balances::free_balance(ALICE), 100_000);
    });
}

#[test]
fn min_stake_locked_stake_cannot_be_transferred_away() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 60_000));
        let free = Balances::free_balance(ALICE); // 100_000 - 50
                                                  // Only free - stake is spendable; one plank more is frozen by the lock.
        assert_noop!(
            Balances::transfer_allow_death(RuntimeOrigin::signed(ALICE), BOB, free - 60_000 + 1),
            sp_runtime::TokenError::Frozen
        );
        assert_eq!(Balances::free_balance(ALICE), free);
        assert_ok!(Balances::transfer_allow_death(
            RuntimeOrigin::signed(ALICE),
            BOB,
            free - 60_000
        ));
        assert_eq!(Balances::free_balance(ALICE), 60_000);
        assert_eq!(AgentStake::<Test>::get(ALICE), Some(60_000));
    });
}

#[test]
fn min_stake_add_stake_grows_the_lock_and_emits_total() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        clear_events();
        assert_ok!(Agents::add_stake(RuntimeOrigin::signed(ALICE), 4_000));

        assert_eq!(AgentStake::<Test>::get(ALICE), Some(5_000));
        assert_eq!(Balances::locks(&ALICE)[0].amount, 5_000);
        assert_eq!(
            agent_events(),
            vec![Event::StakeAdded {
                who: ALICE,
                added: 4_000,
                total: 5_000
            }]
        );
    });
}

#[test]
fn min_stake_zero_add_and_non_agent_add_are_rejected() {
    new_test_ext().execute_with(|| {
        start();
        assert_noop!(
            Agents::add_stake(RuntimeOrigin::signed(ALICE), 100),
            Error::<Test>::NotRegistered
        );
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        clear_events();
        assert_noop!(
            Agents::add_stake(RuntimeOrigin::signed(ALICE), 0),
            Error::<Test>::StakeTooLow
        );
        assert_eq!(AgentStake::<Test>::get(ALICE), Some(1_000));
        assert!(agent_events().is_empty());
    });
}

#[test]
fn min_stake_frozen_while_unstake_is_pending() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::request_unstake(RuntimeOrigin::signed(ALICE)));
        clear_events();

        // Stake may not change once the cooldown started, and the lock stays in force.
        assert_noop!(
            Agents::add_stake(RuntimeOrigin::signed(ALICE), 500),
            Error::<Test>::UnstakeAlreadyPending
        );
        assert_eq!(AgentStake::<Test>::get(ALICE), Some(1_000));
        assert_eq!(Balances::locks(&ALICE)[0].amount, 1_000);
        assert!(agent_events().is_empty());
    });
}

#[test]
fn min_stake_slash_below_min_drops_the_agent_but_partial_slash_keeps_it() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 10_000));
        clear_events();
        // 10% of 10_000 = 1_000 → remaining 9_000 ≥ MinStake: still an agent.
        assert_ok!(Agents::execute_slash(RuntimeOrigin::root(), ALICE, 1_000));
        assert_eq!(AgentStake::<Test>::get(ALICE), Some(9_000));
        assert_eq!(Balances::locks(&ALICE)[0].amount, 9_000);
        assert_eq!(
            agent_events(),
            vec![Event::SlashExecuted {
                who: ALICE,
                amount: 1_000,
                burn: 500,
                treasury: 500
            }]
        );
        // 95% of 9_000 leaves 450 < MinStake: the entry is removed, not left at 450.
        assert_ok!(Agents::execute_slash(RuntimeOrigin::root(), ALICE, 9_500));
        assert!(!AgentStake::<Test>::contains_key(ALICE));
        assert!(Balances::locks(&ALICE).is_empty());
    });
}

#[test]
fn min_stake_slash_requires_root_and_valid_bps() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        clear_events();
        assert_noop!(
            Agents::execute_slash(RuntimeOrigin::signed(BOB), ALICE, 100),
            sp_runtime::DispatchError::BadOrigin
        );
        assert_noop!(
            Agents::execute_slash(RuntimeOrigin::root(), ALICE, 0),
            Error::<Test>::InvalidSlashBps
        );
        assert_noop!(
            Agents::execute_slash(RuntimeOrigin::root(), ALICE, 10_001),
            Error::<Test>::InvalidSlashBps
        );
        assert_eq!(AgentStake::<Test>::get(ALICE), Some(1_000));
        assert!(agent_events().is_empty());
    });
}

// ── heartbeat gate ───────────────────────────────────────────────────────────

#[test]
fn heartbeat_updates_clock_and_emits_event() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        clear_events();
        System::set_block_number(777);
        assert_ok!(Agents::heartbeat(RuntimeOrigin::signed(ALICE)));

        assert_eq!(LastHeartbeat::<Test>::get(ALICE), 777);
        assert_eq!(agent_events(), vec![Event::HeartbeatSent { who: ALICE }]);
    });
}

#[test]
fn heartbeat_from_non_agent_is_rejected_and_writes_nothing() {
    new_test_ext().execute_with(|| {
        start();
        assert_noop!(
            Agents::heartbeat(RuntimeOrigin::signed(BOB)),
            Error::<Test>::NotRegistered
        );
        assert!(!LastHeartbeat::<Test>::contains_key(BOB));
        assert!(agent_events().is_empty());
    });
}

#[test]
fn heartbeat_only_touches_the_callers_clock() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::register(RuntimeOrigin::signed(BOB), 1_000));
        System::set_block_number(500);
        assert_ok!(Agents::heartbeat(RuntimeOrigin::signed(ALICE)));
        assert_eq!(LastHeartbeat::<Test>::get(ALICE), 500);
        assert_eq!(LastHeartbeat::<Test>::get(BOB), 1);
    });
}

#[test]
fn heartbeat_multiplier_holds_at_100_through_the_grace_period() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        // Grace = 600: silent for exactly 600 blocks is still full.
        System::set_block_number(1 + 600);
        assert_eq!(Agents::heartbeat_multiplier(&ALICE), 100);
    });
}

#[test]
fn heartbeat_gate_boundary_at_the_ninety_percent_activity_threshold() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        // Emissions gates the floor share on `hb >= 90`. Multiplier is
        // 100 - floor(90 * over / 14_400): 90 holds through over = 1_759 and drops to 89
        // at over = 1_760 (90 * 1_760 / 14_400 = 11).
        System::set_block_number(1 + 600 + 1_759);
        assert_eq!(Agents::heartbeat_multiplier(&ALICE), 90);
        System::set_block_number(1 + 600 + 1_760);
        assert_eq!(Agents::heartbeat_multiplier(&ALICE), 89);
    });
}

#[test]
fn heartbeat_multiplier_floors_at_ten_and_recovers_on_a_heartbeat() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        System::set_block_number(1 + 600 + 14_400);
        assert_eq!(Agents::heartbeat_multiplier(&ALICE), 10);
        System::set_block_number(1_000_000);
        assert_eq!(
            Agents::heartbeat_multiplier(&ALICE),
            10,
            "never below the 10% floor"
        );

        assert_ok!(Agents::heartbeat(RuntimeOrigin::signed(ALICE)));
        assert_eq!(LastHeartbeat::<Test>::get(ALICE), 1_000_000);
        assert_eq!(Agents::heartbeat_multiplier(&ALICE), 100);
    });
}

#[test]
fn heartbeat_is_rejected_after_the_agent_has_left() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::request_unstake(RuntimeOrigin::signed(ALICE)));
        System::set_block_number(101);
        assert_ok!(Agents::complete_unstake(RuntimeOrigin::signed(ALICE)));
        clear_events();
        assert_noop!(
            Agents::heartbeat(RuntimeOrigin::signed(ALICE)),
            Error::<Test>::NotRegistered
        );
        assert!(!LastHeartbeat::<Test>::contains_key(ALICE));
        assert!(agent_events().is_empty());
    });
}

// ── unstake cooldown ─────────────────────────────────────────────────────────

#[test]
fn cooldown_request_records_deadline_and_emits_it() {
    new_test_ext().execute_with(|| {
        start();
        System::set_block_number(30);
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        clear_events();
        System::set_block_number(40);
        assert_ok!(Agents::request_unstake(RuntimeOrigin::signed(ALICE)));

        assert_eq!(UnstakeAt::<Test>::get(ALICE), Some(140));
        assert_eq!(
            agent_events(),
            vec![Event::UnstakeRequested {
                who: ALICE,
                unstake_at: 140
            }]
        );
        // Requesting does not release anything yet.
        assert_eq!(AgentStake::<Test>::get(ALICE), Some(1_000));
        assert_eq!(Balances::locks(&ALICE)[0].amount, 1_000);
    });
}

#[test]
fn cooldown_blocks_completion_until_the_exact_deadline_block() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::request_unstake(RuntimeOrigin::signed(ALICE))); // deadline 101
        clear_events();

        System::set_block_number(100);
        assert_noop!(
            Agents::complete_unstake(RuntimeOrigin::signed(ALICE)),
            Error::<Test>::UnstakeCooldownNotElapsed
        );
        assert_eq!(AgentStake::<Test>::get(ALICE), Some(1_000));
        assert_eq!(Balances::locks(&ALICE)[0].amount, 1_000);
        assert!(agent_events().is_empty());

        System::set_block_number(101);
        assert_ok!(Agents::complete_unstake(RuntimeOrigin::signed(ALICE)));
        assert_no_agent_state(ALICE);
        assert_eq!(
            agent_events(),
            vec![Event::UnstakeCompleted {
                who: ALICE,
                released: 1_000
            }]
        );
    });
}

#[test]
fn cooldown_release_makes_the_full_stake_spendable() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 60_000));
        assert_ok!(Agents::request_unstake(RuntimeOrigin::signed(ALICE)));
        System::set_block_number(101);
        assert_ok!(Agents::complete_unstake(RuntimeOrigin::signed(ALICE)));
        // Everything except the burned fee is now transferable.
        assert_ok!(Balances::transfer_allow_death(
            RuntimeOrigin::signed(ALICE),
            BOB,
            100_000 - 50 - 1
        ));
        assert_eq!(Balances::free_balance(ALICE), 1);
    });
}

#[test]
fn cooldown_second_request_is_rejected_and_does_not_extend_the_deadline() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::request_unstake(RuntimeOrigin::signed(ALICE)));
        clear_events();
        System::set_block_number(60);
        assert_noop!(
            Agents::request_unstake(RuntimeOrigin::signed(ALICE)),
            Error::<Test>::UnstakeAlreadyPending
        );
        assert_eq!(UnstakeAt::<Test>::get(ALICE), Some(101));
        assert!(agent_events().is_empty());
    });
}

#[test]
fn cooldown_complete_without_request_or_registration_is_rejected() {
    new_test_ext().execute_with(|| {
        start();
        assert_noop!(
            Agents::complete_unstake(RuntimeOrigin::signed(ALICE)),
            Error::<Test>::NotRegistered
        );
        assert_noop!(
            Agents::request_unstake(RuntimeOrigin::signed(ALICE)),
            Error::<Test>::NotRegistered
        );
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_noop!(
            Agents::complete_unstake(RuntimeOrigin::signed(ALICE)),
            Error::<Test>::NoUnstakeRequest
        );
        assert_eq!(AgentStake::<Test>::get(ALICE), Some(1_000));
    });
}

#[test]
fn cooldown_active_escrow_blocks_request_and_completion() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::increment_active_escrow(&ALICE));
        clear_events();
        assert_noop!(
            Agents::request_unstake(RuntimeOrigin::signed(ALICE)),
            Error::<Test>::HasActiveAgreements
        );
        assert!(!UnstakeAt::<Test>::contains_key(ALICE));
        assert!(agent_events().is_empty());

        // An escrow opened *during* the cooldown is re-checked at completion.
        Agents::decrement_active_escrow(&ALICE);
        assert_ok!(Agents::request_unstake(RuntimeOrigin::signed(ALICE)));
        assert_ok!(Agents::increment_active_escrow(&ALICE));
        System::set_block_number(500);
        assert_noop!(
            Agents::complete_unstake(RuntimeOrigin::signed(ALICE)),
            Error::<Test>::HasActiveAgreements
        );
        assert_eq!(AgentStake::<Test>::get(ALICE), Some(1_000));
        assert!(UnstakeAt::<Test>::contains_key(ALICE));

        Agents::decrement_active_escrow(&ALICE);
        assert_ok!(Agents::complete_unstake(RuntimeOrigin::signed(ALICE)));
        assert!(!AgentStake::<Test>::contains_key(ALICE));
    });
}

// ── E33: delegation ──────────────────────────────────────────────────────────

#[test]
fn e33_delegate_stores_record_and_emits_event() {
    new_test_ext().execute_with(|| {
        start();
        System::set_block_number(10);
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        clear_events();
        assert_ok!(Agents::delegate_voting(
            RuntimeOrigin::signed(ALICE),
            BOB,
            500
        ));

        let rec = VotingDelegations::<Test>::get(ALICE).expect("delegation stored");
        assert_eq!(rec.delegate_to, BOB);
        assert_eq!(rec.expires_at, 500);
        assert_eq!(rec.created_at, 10);
        assert_eq!(
            agent_events(),
            vec![Event::VotingDelegated {
                who: ALICE,
                to: BOB,
                until: 500
            }]
        );
    });
}

#[test]
fn e33_delegation_requires_registration() {
    new_test_ext().execute_with(|| {
        start();
        assert_noop!(
            Agents::delegate_voting(RuntimeOrigin::signed(ALICE), BOB, 500),
            Error::<Test>::NotRegistered
        );
        assert!(!VotingDelegations::<Test>::contains_key(ALICE));
        assert!(agent_events().is_empty());
    });
}

#[test]
fn e33_delegation_expiry_bounds_are_exact() {
    new_test_ext().execute_with(|| {
        start();
        System::set_block_number(100);
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        clear_events();
        // until must be strictly in the future.
        assert_noop!(
            Agents::delegate_voting(RuntimeOrigin::signed(ALICE), BOB, 100),
            Error::<Test>::DelegationExpired
        );
        // now + MaxDelegationPeriod (90_000) is the last accepted block; +1 is not.
        assert_noop!(
            Agents::delegate_voting(RuntimeOrigin::signed(ALICE), BOB, 100 + 90_000 + 1),
            Error::<Test>::DelegationPeriodTooLong
        );
        assert!(!VotingDelegations::<Test>::contains_key(ALICE));
        assert!(agent_events().is_empty());

        assert_ok!(Agents::delegate_voting(
            RuntimeOrigin::signed(ALICE),
            BOB,
            101
        ));
        assert_ok!(Agents::delegate_voting(
            RuntimeOrigin::signed(ALICE),
            BOB,
            100 + 90_000
        ));
        assert_eq!(
            VotingDelegations::<Test>::get(ALICE).unwrap().expires_at,
            90_100
        );
    });
}

#[test]
fn e33_redelegation_replaces_the_previous_record() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::delegate_voting(
            RuntimeOrigin::signed(ALICE),
            BOB,
            500
        ));
        System::set_block_number(20);
        clear_events();
        assert_ok!(Agents::delegate_voting(
            RuntimeOrigin::signed(ALICE),
            3,
            900
        ));

        let rec = VotingDelegations::<Test>::get(ALICE).unwrap();
        assert_eq!(
            (rec.delegate_to, rec.expires_at, rec.created_at),
            (3, 900, 20)
        );
        assert_eq!(
            agent_events(),
            vec![Event::VotingDelegated {
                who: ALICE,
                to: 3,
                until: 900
            }]
        );
    });
}

#[test]
fn e33_revoking_delegation_emits_removal_and_leaves_slash_appeals_alone() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        SlashRecords::<Test>::insert(ALICE, 0, 100);
        assert_ok!(Agents::slash_appeal(
            RuntimeOrigin::signed(ALICE),
            0,
            [5u8; 32]
        ));
        assert_ok!(Agents::delegate_voting(
            RuntimeOrigin::signed(ALICE),
            BOB,
            500
        ));
        clear_events();

        assert_ok!(Agents::delegate_voting(
            RuntimeOrigin::signed(ALICE),
            BOB,
            0
        ));
        assert!(VotingDelegations::<Test>::get(ALICE).is_none());
        assert_eq!(
            agent_events(),
            vec![Event::VotingDelegationRemoved { who: ALICE }]
        );
        // A slashed agent cannot erase its appeal record by toggling delegation.
        assert!(PendingSlashAppeals::<Test>::contains_key(ALICE));
        assert!(OpenAppeals::<Test>::contains_key(ALICE, 0));
        assert_eq!(OpenAppealCount::<Test>::get(ALICE), 1);
    });
}

#[test]
fn e33_delegation_does_not_move_stake_or_weight() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        let free = Balances::free_balance(ALICE);
        assert_ok!(Agents::delegate_voting(
            RuntimeOrigin::signed(ALICE),
            BOB,
            500
        ));
        assert_eq!(AgentStake::<Test>::get(ALICE), Some(1_000));
        assert_eq!(Balances::free_balance(ALICE), free);
        assert_eq!(Balances::locks(&ALICE)[0].amount, 1_000);
        assert!(
            !AgentStake::<Test>::contains_key(BOB),
            "delegating does not register the delegate"
        );
    });
}

// ── E22: slash appeals ───────────────────────────────────────────────────────

#[test]
fn e22_appeal_writes_full_record_and_emits_event() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        SlashRecords::<Test>::insert(ALICE, 2, 500);
        System::set_block_number(33);
        clear_events();
        assert_ok!(Agents::slash_appeal(
            RuntimeOrigin::signed(ALICE),
            2,
            [0xCD; 32]
        ));

        let open = OpenAppeals::<Test>::get(ALICE, 2).expect("open appeal");
        assert_eq!(open.slash_era, 2);
        assert_eq!(open.appealed_at, 33);
        assert_eq!(open.reason_hash, [0xCD; 32]);
        let pending = PendingSlashAppeals::<Test>::get(ALICE).expect("pending pointer");
        assert_eq!(pending.slash_era, open.slash_era);
        assert_eq!(pending.appealed_at, open.appealed_at);
        assert_eq!(pending.reason_hash, open.reason_hash);
        assert_eq!(OpenAppealCount::<Test>::get(ALICE), 1);
        assert_eq!(
            agent_events(),
            vec![Event::SlashAppealed {
                who: ALICE,
                slash_era: 2,
                reason_hash: [0xCD; 32]
            }]
        );
    });
}

#[test]
fn e22_appeal_without_a_slash_record_leaves_no_trace() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        clear_events();
        assert_noop!(
            Agents::slash_appeal(RuntimeOrigin::signed(ALICE), 0, [1u8; 32]),
            Error::<Test>::NoSuchSlash
        );
        assert!(!PendingSlashAppeals::<Test>::contains_key(ALICE));
        assert!(!OpenAppeals::<Test>::contains_key(ALICE, 0));
        assert_eq!(OpenAppealCount::<Test>::get(ALICE), 0);
        assert!(agent_events().is_empty());
    });
}

#[test]
fn e22_appeal_by_non_agent_is_rejected() {
    new_test_ext().execute_with(|| {
        start();
        SlashRecords::<Test>::insert(BOB, 0, 100);
        assert_noop!(
            Agents::slash_appeal(RuntimeOrigin::signed(BOB), 0, [1u8; 32]),
            Error::<Test>::NotRegistered
        );
        assert_eq!(OpenAppealCount::<Test>::get(BOB), 0);
    });
}

#[test]
fn e22_duplicate_appeal_for_the_same_era_is_rejected() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        SlashRecords::<Test>::insert(ALICE, 0, 100);
        assert_ok!(Agents::slash_appeal(
            RuntimeOrigin::signed(ALICE),
            0,
            [1u8; 32]
        ));
        clear_events();
        assert_noop!(
            Agents::slash_appeal(RuntimeOrigin::signed(ALICE), 0, [2u8; 32]),
            Error::<Test>::AppealAlreadyPending
        );
        assert_eq!(
            OpenAppeals::<Test>::get(ALICE, 0).unwrap().reason_hash,
            [1u8; 32]
        );
        assert_eq!(OpenAppealCount::<Test>::get(ALICE), 1);
        assert!(agent_events().is_empty());
    });
}

#[test]
fn e22_appeal_window_closes_after_slash_appeal_window_eras() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        SlashRecords::<Test>::insert(ALICE, 0, 100);
        // SlashAppealWindow = 10: era 9 is the last era an era-0 slash can be appealed in.
        EraNumber::<Test>::put(10u32);
        clear_events();
        assert_noop!(
            Agents::slash_appeal(RuntimeOrigin::signed(ALICE), 0, [1u8; 32]),
            Error::<Test>::AppealWindowExpired
        );
        assert!(!OpenAppeals::<Test>::contains_key(ALICE, 0));
        assert!(agent_events().is_empty());

        EraNumber::<Test>::put(9u32);
        assert_ok!(Agents::slash_appeal(
            RuntimeOrigin::signed(ALICE),
            0,
            [1u8; 32]
        ));
        assert!(OpenAppeals::<Test>::contains_key(ALICE, 0));
    });
}

#[test]
fn same_era_slash_accumulates_bps() {
    // #216: a second slash in the same era adds to the record instead of replacing it, so the
    // on-chain history shows the full 15% governance took, not just the last 5%.
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 10_000));
        EraNumber::<Test>::put(3u32);
        assert_ok!(Agents::execute_slash(RuntimeOrigin::root(), ALICE, 1_000));
        assert_ok!(Agents::execute_slash(RuntimeOrigin::root(), ALICE, 500));
        assert_eq!(SlashRecords::<Test>::get(ALICE, 3), Some(1_500));
    });
}

#[test]
fn same_era_slash_accumulation_is_capped_at_full() {
    // #216: 60% + 60% + 60% sums to 18_000 bps, which is not a readable percentage. The record
    // is clamped to exactly 10_000 (100%), not left at the raw sum or saturated at an int max.
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 50_000));
        EraNumber::<Test>::put(3u32);
        assert_ok!(Agents::execute_slash(RuntimeOrigin::root(), ALICE, 6_000));
        assert_ok!(Agents::execute_slash(RuntimeOrigin::root(), ALICE, 6_000));
        assert_eq!(SlashRecords::<Test>::get(ALICE, 3), Some(10_000));
        assert_ok!(Agents::execute_slash(RuntimeOrigin::root(), ALICE, 6_000));
        assert_eq!(SlashRecords::<Test>::get(ALICE, 3), Some(10_000));
        // A later era starts its own record.
        EraNumber::<Test>::put(4u32);
        assert_ok!(Agents::execute_slash(RuntimeOrigin::root(), ALICE, 100));
        assert_eq!(SlashRecords::<Test>::get(ALICE, 4), Some(100));
    });
}

#[test]
fn e22_slash_then_appeal_round_trip_through_execute_slash() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 10_000));
        EraNumber::<Test>::put(4u32);
        // A real slash creates the record the appeal needs.
        assert_ok!(Agents::execute_slash(RuntimeOrigin::root(), ALICE, 1_000));
        assert_eq!(SlashRecords::<Test>::get(ALICE, 4), Some(1_000));
        clear_events();

        assert_ok!(Agents::slash_appeal(
            RuntimeOrigin::signed(ALICE),
            4,
            [9u8; 32]
        ));
        assert_eq!(OpenAppealCount::<Test>::get(ALICE), 1);
        assert_eq!(
            agent_events(),
            vec![Event::SlashAppealed {
                who: ALICE,
                slash_era: 4,
                reason_hash: [9u8; 32]
            }]
        );
        // A later slash makes earlier appeals moot and clears them all.
        EraNumber::<Test>::put(5u32);
        assert_ok!(Agents::execute_slash(RuntimeOrigin::root(), ALICE, 500));
        assert_eq!(OpenAppealCount::<Test>::get(ALICE), 0);
        assert!(!OpenAppeals::<Test>::contains_key(ALICE, 4));
        assert!(!PendingSlashAppeals::<Test>::contains_key(ALICE));
        assert_eq!(SlashRecords::<Test>::get(ALICE, 5), Some(500));
        // The earlier slash record itself is history and stays.
        assert_eq!(SlashRecords::<Test>::get(ALICE, 4), Some(1_000));
    });
}

#[test]
fn e22_unstake_clears_every_open_appeal() {
    new_test_ext().execute_with(|| {
        start();
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        for era in 0..3u32 {
            SlashRecords::<Test>::insert(ALICE, era, 100);
            assert_ok!(Agents::slash_appeal(
                RuntimeOrigin::signed(ALICE),
                era,
                [era as u8; 32]
            ));
        }
        assert_eq!(OpenAppealCount::<Test>::get(ALICE), 3);
        assert_ok!(Agents::request_unstake(RuntimeOrigin::signed(ALICE)));
        System::set_block_number(101);
        assert_ok!(Agents::complete_unstake(RuntimeOrigin::signed(ALICE)));
        for era in 0..3u32 {
            assert!(!OpenAppeals::<Test>::contains_key(ALICE, era));
        }
        assert_no_agent_state(ALICE);
    });
}

// ── spec 308 (D14): messaging key ─────────────────────────────────────────────

const KEY_A: [u8; 32] = [0xA1; 32];
const KEY_B: [u8; 32] = [0xB2; 32];

#[test]
fn set_messaging_key_stores_key_and_emits_event() {
    new_test_ext().execute_with(|| {
        frame_system::Pallet::<Test>::set_block_number(1);
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_eq!(MessagingKey::<Test>::get(ALICE), None);
        assert_ok!(Agents::set_messaging_key(
            RuntimeOrigin::signed(ALICE),
            KEY_A
        ));
        assert_eq!(MessagingKey::<Test>::get(ALICE), Some(KEY_A));
        frame_system::Pallet::<Test>::assert_last_event(
            Event::MessagingKeySet {
                who: ALICE,
                key: KEY_A,
            }
            .into(),
        );
    });
}

#[test]
fn set_messaging_key_again_rotates_it() {
    new_test_ext().execute_with(|| {
        frame_system::Pallet::<Test>::set_block_number(1);
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::set_messaging_key(
            RuntimeOrigin::signed(ALICE),
            KEY_A
        ));
        assert_ok!(Agents::set_messaging_key(
            RuntimeOrigin::signed(ALICE),
            KEY_B
        ));
        assert_eq!(MessagingKey::<Test>::get(ALICE), Some(KEY_B));
        frame_system::Pallet::<Test>::assert_last_event(
            Event::MessagingKeySet {
                who: ALICE,
                key: KEY_B,
            }
            .into(),
        );
    });
}

#[test]
fn set_messaging_key_takes_no_deposit() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        let free = Balances::free_balance(ALICE);
        let reserved = Balances::reserved_balance(ALICE);
        assert_ok!(Agents::set_messaging_key(
            RuntimeOrigin::signed(ALICE),
            KEY_A
        ));
        assert_eq!(Balances::free_balance(ALICE), free);
        assert_eq!(Balances::reserved_balance(ALICE), reserved);
    });
}

#[test]
fn set_messaging_key_rejected_for_unregistered_account() {
    new_test_ext().execute_with(|| {
        assert_noop!(
            Agents::set_messaging_key(RuntimeOrigin::signed(BOB), KEY_A),
            Error::<Test>::NotRegistered
        );
        assert_eq!(MessagingKey::<Test>::get(BOB), None);
    });
}

#[test]
fn clear_messaging_key_removes_key_and_emits_event() {
    new_test_ext().execute_with(|| {
        frame_system::Pallet::<Test>::set_block_number(1);
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::set_messaging_key(
            RuntimeOrigin::signed(ALICE),
            KEY_A
        ));
        assert_ok!(Agents::clear_messaging_key(RuntimeOrigin::signed(ALICE)));
        assert_eq!(MessagingKey::<Test>::get(ALICE), None);
        frame_system::Pallet::<Test>::assert_last_event(
            Event::MessagingKeyCleared { who: ALICE }.into(),
        );
    });
}

#[test]
fn clear_messaging_key_rejected_for_unregistered_account() {
    new_test_ext().execute_with(|| {
        assert_noop!(
            Agents::clear_messaging_key(RuntimeOrigin::signed(BOB)),
            Error::<Test>::NotRegistered
        );
    });
}

#[test]
fn clear_messaging_key_without_a_key_is_an_error_not_a_silent_event() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_noop!(
            Agents::clear_messaging_key(RuntimeOrigin::signed(ALICE)),
            Error::<Test>::NoMessagingKey
        );
    });
}

#[test]
fn one_agent_cannot_touch_another_agents_key() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::register(RuntimeOrigin::signed(BOB), 1_000));
        assert_ok!(Agents::set_messaging_key(
            RuntimeOrigin::signed(ALICE),
            KEY_A
        ));
        assert_ok!(Agents::set_messaging_key(RuntimeOrigin::signed(BOB), KEY_B));
        assert_ok!(Agents::clear_messaging_key(RuntimeOrigin::signed(BOB)));
        assert_eq!(MessagingKey::<Test>::get(ALICE), Some(KEY_A));
        assert_eq!(MessagingKey::<Test>::get(BOB), None);
    });
}

#[test]
fn complete_unstake_clears_messaging_key() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::set_messaging_key(
            RuntimeOrigin::signed(ALICE),
            KEY_A
        ));
        assert_ok!(Agents::request_unstake(RuntimeOrigin::signed(ALICE)));
        frame_system::Pallet::<Test>::set_block_number(101);
        assert_ok!(Agents::complete_unstake(RuntimeOrigin::signed(ALICE)));
        assert_eq!(
            MessagingKey::<Test>::get(ALICE),
            None,
            "a departed agent must not leave a key counterparties would still encrypt to"
        );
    });
}

#[test]
fn slash_eviction_clears_messaging_key_and_says_so() {
    new_test_ext().execute_with(|| {
        frame_system::Pallet::<Test>::set_block_number(1);
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_ok!(Agents::set_messaging_key(
            RuntimeOrigin::signed(ALICE),
            KEY_A
        ));
        // 100% slash takes stake below MinStake: ALICE stops being an agent...
        assert_ok!(Agents::execute_slash(RuntimeOrigin::root(), ALICE, 10_000));
        assert!(!AgentStake::<Test>::contains_key(ALICE));
        // ...so her key must not outlive the registration. Otherwise it stays published for
        // a non-agent she can no longer clear (clear requires registration), and silently
        // reappears if she registers again.
        assert_eq!(MessagingKey::<Test>::get(ALICE), None);
        assert!(frame_system::Pallet::<Test>::events()
            .iter()
            .any(|r| r.event == RuntimeEvent::Agents(Event::MessagingKeyCleared { who: ALICE })));
        // Re-registering does not resurrect it.
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
        assert_eq!(MessagingKey::<Test>::get(ALICE), None);
    });
}

#[test]
fn partial_slash_keeps_messaging_key() {
    new_test_ext().execute_with(|| {
        assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 10_000));
        assert_ok!(Agents::set_messaging_key(
            RuntimeOrigin::signed(ALICE),
            KEY_A
        ));
        assert_ok!(Agents::execute_slash(RuntimeOrigin::root(), ALICE, 1_000)); // 10%
        assert!(AgentStake::<Test>::contains_key(ALICE));
        assert_eq!(MessagingKey::<Test>::get(ALICE), Some(KEY_A));
    });
}

// ── #217: declared weights are floors over the worst-case storage path ────────
//
// An under-declared extrinsic is underpriced: the caller's fee buys less storage
// work than the chain actually performs, which makes the under-declared call the
// profitable one to spam and lets a block overrun its real weight budget. #195
// added bounded appeal cleanup to `complete_unstake` and `execute_slash` without
// raising their declarations, so both were paying for fewer writes than they do.
//
// These tests pin the count as a *floor*, not an equality: declaring more than the
// path needs is safe and stays legal here, while a declaration that no longer
// covers the path fails — so a future edit that adds a write without touching the
// weight is caught at this level rather than at a benchmark run that does not
// exist yet.
//
// Counting convention, mirrored in the comment above each declaration in lib.rs:
//   - one read / write per direct access to this pallet's own storage;
//   - a `CountedStorageMap` mutation adds one counter read and one counter write;
//   - `clear_prefix(.., MAX_OPEN_APPEALS, ..)` is MAX_OPEN_APPEALS reads plus
//     MAX_OPEN_APPEALS writes, its bound being the whole point of the bound;
//   - one read plus one write per call out through a `Config` associated type
//     (`Currency`, `AgentCollective`, the `on_*` hooks) — the same coarse
//     allowance the rest of this pallet's hand-declared weights already use.
//     except where that allowance is demonstrably not a bound: the ranked-collective
//     teardown in `complete_unstake` is rank-linear, so it is counted per rank from
//     the runtime's `RankedCollectiveBridge` rather than flattened.
//
// Two things these floors deliberately do not pin, both because a hand-declared
// weight has no honest value for them: `proof_size`, which stays 0 on both sides
// until real benchmarks (#134 / #192 / #210) measure PoV, and the read/write
// *structure* — `all_gte` compares total `ref_time`, so it catches a declaration
// that got cheaper but not one that reshuffles reads into the flat component.

/// The weight the runtime will actually charge for `call`, as declared by
/// `#[pallet::weight(..)]`.
fn declared_weight(call: crate::Call<Test>) -> frame_support::weights::Weight {
    use frame_support::dispatch::GetDispatchInfo;
    call.get_dispatch_info().call_weight
}

/// The counted worst-case storage cost, priced with the same `DbWeight` the
/// declaration itself is priced with.
fn worst_case_floor(reads: u64, writes: u64) -> frame_support::weights::Weight {
    <Test as frame_system::Config>::DbWeight::get().reads_writes(reads, writes)
}

#[test]
fn declared_weight_complete_unstake_covers_appeal_cleanup() {
    // 26 reads: this pallet's 12 — AgentStake, UnstakeAt, block_number,
    //   ActiveEscrowCount, the AgentStake counter, 5 × OpenAppeals `clear_prefix`,
    //   Locks + account for remove_lock — plus 14 for AgentCollective::remove
    //   (3 per rank × 4 ranks, plus the 2 that end the rank walk).
    // 40 writes: this pallet's 19 — AgentStake value + counter, UnstakeAt,
    //   StakeRegisteredAt, CompletedAgreements, LastHeartbeat, AgentMetadata,
    //   AgentCapabilities, MessagingKey (spec 308), VotingDelegations, PendingSlashAppeals,
    //   OpenAppealCount, 5 × OpenAppeals `clear_prefix`, Locks + account for
    //   remove_lock — plus 21 for AgentCollective::remove (5 per rank × 4 ranks,
    //   plus the final Members removal).
    let floor = worst_case_floor(26, 40);
    let declared = declared_weight(crate::Call::<Test>::complete_unstake {});
    assert!(
        declared.all_gte(floor),
        "complete_unstake declares {declared:?} but its worst-case path needs at \
         least {floor:?} — every branch it takes must be paid for"
    );
}

#[test]
fn declared_weight_execute_slash_covers_appeal_cleanup() {
    // 17 reads: AgentStake, the AgentStake counter, EraNumber, MessagingKey (spec 308),
    //   5 × OpenAppeals `clear_prefix`, Locks + account for set_lock/remove_lock,
    //   account + TotalIssuance for withdraw, TotalIssuance for the burn-half
    //   drop, treasury account + TotalIssuance for on_unbalanced, on_slashed.
    // 19 writes: AgentStake value + counter, MessagingKey (spec 308), PendingSlashAppeals,
    //   OpenAppealCount,
    //   SlashRecords, 5 × OpenAppeals `clear_prefix`, and the balance side —
    //   Locks + account, account + TotalIssuance, TotalIssuance for the burn,
    //   treasury account + TotalIssuance, AgentWeightSnapshot for on_slashed.
    let floor = worst_case_floor(17, 19);
    let declared = declared_weight(crate::Call::<Test>::execute_slash {
        who: ALICE,
        bps: 10_000,
    });
    assert!(
        declared.all_gte(floor),
        "execute_slash declares {declared:?} but its worst-case path needs at \
         least {floor:?} — the bounded appeal cleanup is part of the call"
    );
}

#[test]
fn declared_weight_slash_appeal_covers_its_reads() {
    // 7 reads: AgentStake, SlashRecords, OpenAppeals, OpenAppealCount,
    //   block_number, EraNumber, PendingSlashAppeals.
    // 3 writes: PendingSlashAppeals, OpenAppeals, OpenAppealCount. The write count
    //   already matched the declaration, so only the read count moved.
    let floor = worst_case_floor(7, 3);
    let declared = declared_weight(crate::Call::<Test>::slash_appeal {
        slash_era: 0,
        reason_hash: [0u8; 32],
    });
    assert!(
        declared.all_gte(floor),
        "slash_appeal declares {declared:?} but reads more than that: it needs at \
         least {floor:?}"
    );
}
