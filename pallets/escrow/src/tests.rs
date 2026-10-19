//! pallet-escrow unit tests
//!
//! Gated by `#[cfg(test)] mod tests;` in `lib.rs` — no inner `#![cfg(test)]`.

use crate::pallet::*;
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
        Escrow:   crate,
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
    pub const MinStakeX: u64 = 1_000;
    pub const FFStakeX:  u64 = 10_000;
    pub const MaxStakeX: u64 = 1_000_000;
}

impl pallet_agents::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    type Currency = Balances;
    type MinStake = MinStakeX;
    type FullFloorStake = FFStakeX;
    type MaxStakePerAgent = MaxStakeX;
    // BlockNumber- and Balance-typed constants: ConstU64, not ConstU32. Values unchanged.
    type UnstakeCooldown = ConstU64<100>;
    type BaseRegistrationFee = ConstU64<50>;
    type MaxRegistrationsPerBlock = ConstU32<10>;
    type MaxAgents = ConstU32<100>;
    type Rank3MinCompletions = ConstU32<50>;
    type MinRank3OracleScore = ConstU32<0>;
    type Rank3SpanGate = ConstU64<0>;
    type MaxVolToStakeRatio = ConstU32<0>;
    type HeartbeatGracePeriod = ConstU64<600>;
    type HeartbeatDecayPeriod = ConstU64<14400>;
    type OnAgentRegistered = ();
    type OnAgentSlashed = ();
    type OnStakeChanged = ();
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

// Completion-fee provider: 0 bps by default (existing tests are fee-free), settable per test.
thread_local! {
    static FEE_BPS: core::cell::Cell<u32> = const { core::cell::Cell::new(0) };
}
pub struct MockFeeBps;
impl frame_support::traits::Get<u32> for MockFeeBps {
    fn get() -> u32 {
        FEE_BPS.with(|f| f.get())
    }
}
fn set_fee_bps(bps: u32) {
    FEE_BPS.with(|f| f.set(bps));
}

/// Stand-in for the runtime's Treasury: `FeeDestination` credits this account, so a test
/// can assert on where the completion fee and dispute penalty actually land.
const TREASURY: u64 = 99;
pub struct MockTreasury;
impl frame_support::traits::OnUnbalanced<pallet_balances::NegativeImbalance<Test>>
    for MockTreasury
{
    fn on_nonzero_unbalanced(amount: pallet_balances::NegativeImbalance<Test>) {
        <Balances as frame_support::traits::Currency<u64>>::resolve_creating(&TREASURY, amount);
    }
}

parameter_types! {
    pub const MaxAgreements:     u32 = 5;
    pub const MaxAgreementSpan:  u64 = 1_000;
    pub const MinAmount:         u64 = 10;
    pub const MinDelivery:       u64 = 5;
    pub const BuyerRespWindow:   u64 = 50;
    pub const DisputeTimeout:    u64 = 200;
    pub const DisputeRespWindow: u64 = 100;
    pub const DisputeBountyBps:  u32 = 200; // 2%
    pub const MinBounty:         u64 = 10;
    pub const DisputeBurnBps:    u32 = 0;
}

impl super::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    // No `Currency` here: escrow::Config does not declare one — it spends through
    // pallet_agents::Config::Currency, which this mock already sets to Balances.
    type MaxAgreementsPerPair = MaxAgreements;
    type MaxAgreementSpan = MaxAgreementSpan;
    type MinAgreementAmount = MinAmount;
    type MinDeliveryBlocks = MinDelivery;
    type BuyerResponseWindow = BuyerRespWindow;
    type DisputeTimeoutWindow = DisputeTimeout;
    type DisputeResponseWindow = DisputeRespWindow;
    type DisputeBountyBps = DisputeBountyBps;
    type MinDisputeBounty = MinBounty;
    type DisputeBurnBps = DisputeBurnBps;
    type DisputeOracle = ();
    type DisputeCallback = ();
    type CompletionFeeProvider = MockFeeBps; // 0 unless a test sets it via `set_fee_bps`
    type FeeDestination = MockTreasury; // credits TREASURY so fee routing is observable
}

fn new_test_ext() -> sp_io::TestExternalities {
    set_fee_bps(0);
    let mut storage = frame_system::GenesisConfig::<Test>::default()
        .build_storage()
        .unwrap();
    pallet_balances::GenesisConfig::<Test> {
        balances: vec![(1, 200_000), (2, 200_000), (3, 200_000)],
        dev_accounts: None, // new field; None = generate none, as before
    }
    .assimilate_storage(&mut storage)
    .unwrap();
    storage.into()
}

const ALICE: u64 = 1; // buyer
const BOB: u64 = 2; // provider

fn register_both() {
    assert_ok!(Agents::register(RuntimeOrigin::signed(ALICE), 1_000));
    assert_ok!(Agents::register(RuntimeOrigin::signed(BOB), 1_000));
}

fn create(amount: u64) -> u32 {
    assert_ok!(Escrow::create_agreement(
        RuntimeOrigin::signed(ALICE),
        BOB,
        amount,
        [1u8; 32],
        500,
        None,
    ));
    0u32 // seq 0 for first agreement
}

/// The provider consents. Since #180 an agreement only binds the provider once it has
/// accepted, so every create→deliver flow needs this step; `record_delivery` refuses with
/// `NotAccepted` without it.
fn accept(buyer: u64, provider: u64, seq: u32) {
    assert_ok!(Escrow::accept_agreement(
        RuntimeOrigin::signed(provider),
        buyer,
        seq
    ));
}

#[test]
fn full_happy_path() {
    new_test_ext().execute_with(|| {
        register_both();
        create(1_000);
        accept(ALICE, BOB, 0);
        // Advance past min delivery blocks
        frame_system::Pallet::<Test>::set_block_number(10);
        assert_ok!(Escrow::record_delivery(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0,
            [2u8; 32]
        ));
        let bob_before = Balances::free_balance(BOB);
        assert_ok!(Escrow::confirm_delivery(
            RuntimeOrigin::signed(ALICE),
            BOB,
            0
        ));
        // Bob should have received the 1000 CMN
        assert_eq!(Balances::free_balance(BOB), bob_before + 1_000);
        // Agreement removed
        assert!(Agreements::<Test>::get(ALICE, BOB).is_empty());
        // ActiveEscrowCount decremented
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 0);
    });
}

#[test]
fn cannot_create_self_deal() {
    new_test_ext().execute_with(|| {
        register_both();
        assert_noop!(
            Escrow::create_agreement(
                RuntimeOrigin::signed(ALICE),
                ALICE,
                1_000,
                [1u8; 32],
                500,
                None,
            ),
            Error::<Test>::SelfDeal
        );
    });
}

#[test]
fn create_agreement_rejects_provider_without_capability() {
    new_test_ext().execute_with(|| {
        register_both();
        // BOB is registered but never called set_capability(7).
        assert_noop!(
            Escrow::create_agreement(
                RuntimeOrigin::signed(ALICE),
                BOB,
                1_000,
                [1u8; 32],
                500,
                Some(7),
            ),
            Error::<Test>::ProviderLacksCapability
        );
        // With the capability registered, the same call succeeds.
        assert_ok!(Agents::set_capability(RuntimeOrigin::signed(BOB), 7, true));
        assert_ok!(Escrow::create_agreement(
            RuntimeOrigin::signed(ALICE),
            BOB,
            1_000,
            [1u8; 32],
            500,
            Some(7),
        ));
    });
}

#[test]
fn record_delivery_rejects_provider_without_capability() {
    new_test_ext().execute_with(|| {
        register_both();
        assert_ok!(Agents::set_capability(RuntimeOrigin::signed(BOB), 7, true));
        assert_ok!(Escrow::create_agreement(
            RuntimeOrigin::signed(ALICE),
            BOB,
            1_000,
            [1u8; 32],
            500,
            Some(7),
        ));
        accept(ALICE, BOB, 0);
        // Provider drops the capability after the agreement is created.
        assert_ok!(Agents::set_capability(RuntimeOrigin::signed(BOB), 7, false));
        System::set_block_number(10); // past MinDeliveryBlocks(5)
        assert_noop!(
            Escrow::record_delivery(RuntimeOrigin::signed(BOB), ALICE, 0, [2u8; 32]),
            Error::<Test>::ProviderLacksCapability
        );
    });
}

#[test]
fn create_agreement_rejects_deliver_by_beyond_span() {
    new_test_ext().execute_with(|| {
        register_both();
        // now(0) + MaxAgreementSpan(1000) = 1000; 1001 is one block too far.
        assert_noop!(
            Escrow::create_agreement(
                RuntimeOrigin::signed(ALICE),
                BOB,
                1_000,
                [1u8; 32],
                1_001,
                None,
            ),
            Error::<Test>::SpanTooLong
        );
        // Exactly at the span is allowed and stored unclamped.
        assert_ok!(Escrow::create_agreement(
            RuntimeOrigin::signed(ALICE),
            BOB,
            1_000,
            [1u8; 32],
            1_000,
            None,
        ));
        assert_eq!(Agreements::<Test>::get(ALICE, BOB)[0].deliver_by, 1_000);
    });
}

#[test]
fn extend_deadline_rejects_beyond_span() {
    new_test_ext().execute_with(|| {
        register_both();
        create(1_000);
        assert_noop!(
            Escrow::extend_deadline(RuntimeOrigin::signed(ALICE), BOB, 0, 1_001),
            Error::<Test>::SpanTooLong
        );
    });
}

#[test]
fn cannot_deliver_before_min_blocks() {
    new_test_ext().execute_with(|| {
        register_both();
        create(1_000);
        accept(ALICE, BOB, 0);
        // Block 0 — min delivery is 5 blocks
        assert_noop!(
            Escrow::record_delivery(RuntimeOrigin::signed(BOB), ALICE, 0, [2u8; 32]),
            Error::<Test>::MinDeliveryBlocksNotElapsed
        );
    });
}

#[test]
fn dispute_sets_status_and_reserves_bounty() {
    new_test_ext().execute_with(|| {
        register_both();
        create(1_000);
        accept(ALICE, BOB, 0);
        frame_system::Pallet::<Test>::set_block_number(10);
        assert_ok!(Escrow::record_delivery(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0,
            [2u8; 32]
        ));
        assert_ok!(Escrow::dispute_delivery(
            RuntimeOrigin::signed(ALICE),
            BOB,
            0
        ));
        let agreements = Agreements::<Test>::get(ALICE, BOB);
        assert_eq!(agreements[0].status, AgreementStatus::Disputed);
        // Bounty (2% of 1000 = 20, clamped to min_bounty=10) deducted from amount
        assert!(agreements[0].amount < 1_000);
    });
}

#[test]
fn claim_refund_after_timeout() {
    new_test_ext().execute_with(|| {
        register_both();
        create(1_000);
        accept(ALICE, BOB, 0);
        frame_system::Pallet::<Test>::set_block_number(10);
        assert_ok!(Escrow::record_delivery(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0,
            [2u8; 32]
        ));
        assert_ok!(Escrow::dispute_delivery(
            RuntimeOrigin::signed(ALICE),
            BOB,
            0
        ));

        let alice_before = Balances::reserved_balance(ALICE);
        // Advance past dispute timeout (200 blocks)
        frame_system::Pallet::<Test>::set_block_number(220);
        assert_ok!(Escrow::claim_refund(RuntimeOrigin::signed(ALICE), BOB, 0));
        // Alice's reserve should decrease (funds released)
        assert!(Balances::reserved_balance(ALICE) < alice_before);
    });
}

#[test]
fn provider_wins_oracle_settles_correctly() {
    new_test_ext().execute_with(|| {
        register_both();
        create(1_000);
        accept(ALICE, BOB, 0);
        frame_system::Pallet::<Test>::set_block_number(10);
        assert_ok!(Escrow::record_delivery(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0,
            [2u8; 32]
        ));
        assert_ok!(Escrow::dispute_delivery(
            RuntimeOrigin::signed(ALICE),
            BOB,
            0
        ));
        let bob_before = Balances::free_balance(BOB);
        // Simulate oracle callback: provider wins
        assert_ok!(Escrow::settle_dispute_from_oracle(&ALICE, &BOB, 0, true));
        assert!(Balances::free_balance(BOB) > bob_before);
    });
}

#[test]
fn deadline_too_early_rejected() {
    new_test_ext().execute_with(|| {
        register_both();
        // deliver_by = block 0 (in the past at block 0) → should fail
        assert_noop!(
            Escrow::create_agreement(RuntimeOrigin::signed(ALICE), BOB, 1_000, [1u8; 32], 2, None,),
            Error::<Test>::DeadlineTooEarly
        );
    });
}

#[test]
fn bilateral_cap_prevents_too_many_agreements() {
    new_test_ext().execute_with(|| {
        register_both();
        for _ in 0..5 {
            assert_ok!(Escrow::create_agreement(
                RuntimeOrigin::signed(ALICE),
                BOB,
                10,
                [1u8; 32],
                500,
                None,
            ));
        }
        // 6th should fail
        assert_noop!(
            Escrow::create_agreement(RuntimeOrigin::signed(ALICE), BOB, 10, [1u8; 32], 500, None,),
            Error::<Test>::BilateralCapReached
        );
    });
}

#[test]
fn extend_deadline_works_for_buyer() {
    new_test_ext().execute_with(|| {
        register_both();
        // Create agreement with deliver_by = 500 (must be > now(0) + MinDelivery(5) = 5)
        assert_ok!(Escrow::create_agreement(
            RuntimeOrigin::signed(ALICE),
            BOB,
            1_000,
            [1u8; 32],
            500,
            None,
        ));
        // Extend deadline to 800 (must be > 500, <= created_at(0) + MaxAgreementSpan(1000))
        assert_ok!(Escrow::extend_deadline(
            RuntimeOrigin::signed(ALICE),
            BOB,
            0,
            800
        ));
        let agreements = Agreements::<Test>::get(ALICE, BOB);
        assert_eq!(agreements[0].deliver_by, 800);
    });
}

#[test]
fn extend_deadline_fails_if_new_not_later() {
    new_test_ext().execute_with(|| {
        register_both();
        assert_ok!(Escrow::create_agreement(
            RuntimeOrigin::signed(ALICE),
            BOB,
            1_000,
            [1u8; 32],
            500,
            None,
        ));
        // 300 < 500 — not later
        assert_noop!(
            Escrow::extend_deadline(RuntimeOrigin::signed(ALICE), BOB, 0, 300),
            Error::<Test>::NewDeadlineMustBeLater
        );
    });
}

#[test]
fn extend_deadline_fails_after_delivery_recorded() {
    new_test_ext().execute_with(|| {
        register_both();
        assert_ok!(Escrow::create_agreement(
            RuntimeOrigin::signed(ALICE),
            BOB,
            1_000,
            [1u8; 32],
            500,
            None,
        ));
        accept(ALICE, BOB, 0);
        frame_system::Pallet::<Test>::set_block_number(10);
        assert_ok!(Escrow::record_delivery(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0,
            [2u8; 32]
        ));
        // Cannot extend after delivery recorded (status = Delivered)
        assert_noop!(
            Escrow::extend_deadline(RuntimeOrigin::signed(ALICE), BOB, 0, 800),
            Error::<Test>::WrongStatus
        );
    });
}

// ── Ledger-level tests (#186) ────────────────────────────────────────────────
//
// Every test below asserts on events and storage/balances, never only on a call's
// return value ("trust the ledger"). Events are only recorded from block 1.

fn last_escrow_events() -> Vec<crate::pallet::Event<Test>> {
    System::events()
        .into_iter()
        .filter_map(|r| match r.event {
            RuntimeEvent::Escrow(e) => Some(e),
            _ => None,
        })
        .collect()
}

/// Register both agents at block 1 and open one agreement (`amount`, deliver_by 500).
fn setup_agreement(amount: u64) {
    System::set_block_number(1);
    register_both();
    assert_ok!(Escrow::create_agreement(
        RuntimeOrigin::signed(ALICE),
        BOB,
        amount,
        [1u8; 32],
        500,
        None,
    ));
}

/// E5 — full lifecycle create → deliver → confirm leaves the ledger consistent.
/// NOTE: the issue brief does not define E5; it is encoded here as the settlement
/// lifecycle invariant (funds, counters, storage and events all agree).
#[test]
fn e5_lifecycle_events_storage_and_balances_agree() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        register_both();
        let alice_reserved0 = Balances::reserved_balance(ALICE);
        let alice_free0 = Balances::free_balance(ALICE);
        let bob_free0 = Balances::free_balance(BOB);
        let issuance0 = Balances::total_issuance();

        assert_ok!(Escrow::create_agreement(
            RuntimeOrigin::signed(ALICE),
            BOB,
            1_000,
            [1u8; 32],
            500,
            None,
        ));
        assert_eq!(Balances::reserved_balance(ALICE), alice_reserved0 + 1_000);
        assert_eq!(Balances::free_balance(ALICE), alice_free0 - 1_000);
        accept(ALICE, BOB, 0);
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 1);
        assert_eq!(ActiveAgreementCount::<Test>::get(), 1);
        assert_eq!(NextSeq::<Test>::get(ALICE, BOB), 1);
        let a = &Agreements::<Test>::get(ALICE, BOB)[0];
        assert_eq!(
            (a.status, a.amount, a.seq, a.created_at),
            (AgreementStatus::Created, 1_000, 0, 1)
        );

        System::set_block_number(10);
        assert_ok!(Escrow::record_delivery(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0,
            [2u8; 32]
        ));
        let a = &Agreements::<Test>::get(ALICE, BOB)[0];
        assert_eq!(
            (a.status, a.delivery_proof),
            (AgreementStatus::Delivered, Some([2u8; 32]))
        );

        assert_ok!(Escrow::confirm_delivery(
            RuntimeOrigin::signed(ALICE),
            BOB,
            0
        ));
        assert!(Agreements::<Test>::get(ALICE, BOB).is_empty());
        assert_eq!(Balances::reserved_balance(ALICE), alice_reserved0);
        assert_eq!(Balances::free_balance(ALICE), alice_free0 - 1_000);
        assert_eq!(Balances::free_balance(BOB), bob_free0 + 1_000);
        assert_eq!(Balances::total_issuance(), issuance0);
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 0);
        assert_eq!(ActiveAgreementCount::<Test>::get(), 0);

        assert_eq!(
            last_escrow_events(),
            vec![
                Event::AgreementCreated {
                    buyer: ALICE,
                    provider: BOB,
                    seq: 0,
                    amount: 1_000
                },
                // Since #180 consent is its own step in the lifecycle, between creation
                // and delivery.
                Event::AgreementAccepted {
                    buyer: ALICE,
                    provider: BOB,
                    seq: 0
                },
                Event::DeliveryRecorded {
                    provider: BOB,
                    buyer: ALICE,
                    seq: 0,
                    proof: [2u8; 32]
                },
                Event::DeliveryConfirmed {
                    buyer: ALICE,
                    provider: BOB,
                    seq: 0,
                    amount: 1_000
                },
            ]
        );
    });
}

/// E6 — the completion fee (25 bps of the agreement) reaches the Treasury via
/// `FeeDestination`, the provider gets the remainder, and issuance is unchanged
/// (the fee is re-credited, not burned).
#[test]
fn e6_completion_fee_is_routed_to_treasury() {
    new_test_ext().execute_with(|| {
        set_fee_bps(25); // 25 bps = 0.25%: 1_000_000 * 25 / 10_000 = 2_500
        System::set_block_number(1);
        register_both();
        assert_ok!(Escrow::create_agreement(
            RuntimeOrigin::signed(ALICE),
            BOB,
            100_000,
            [1u8; 32],
            500,
            None,
        ));
        accept(ALICE, BOB, 0);
        System::set_block_number(10);
        assert_ok!(Escrow::record_delivery(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0,
            [2u8; 32]
        ));
        let bob_free0 = Balances::free_balance(BOB);
        let reserved0 = Balances::reserved_balance(ALICE);
        let issuance0 = Balances::total_issuance();
        assert_eq!(Balances::free_balance(TREASURY), 0);

        assert_ok!(Escrow::confirm_delivery(
            RuntimeOrigin::signed(ALICE),
            BOB,
            0
        ));

        // 100_000 * 25 bps = 250 to Treasury; provider nets 99_750.
        assert_eq!(Balances::free_balance(TREASURY), 250);
        assert_eq!(Balances::free_balance(BOB), bob_free0 + 99_750);
        assert_eq!(Balances::reserved_balance(ALICE), reserved0 - 100_000);
        assert_eq!(Balances::total_issuance(), issuance0);
        // The event reports the gross agreement amount.
        assert_eq!(
            last_escrow_events().last(),
            Some(&Event::DeliveryConfirmed {
                buyer: ALICE,
                provider: BOB,
                seq: 0,
                amount: 100_000
            })
        );
    });
}

/// E6 — with a zero fee nothing reaches the Treasury and the provider is paid in full.
#[test]
fn e6_zero_fee_sends_nothing_to_treasury() {
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);
        accept(ALICE, BOB, 0);
        System::set_block_number(10);
        assert_ok!(Escrow::record_delivery(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0,
            [2u8; 32]
        ));
        let bob_free0 = Balances::free_balance(BOB);
        assert_ok!(Escrow::confirm_delivery(
            RuntimeOrigin::signed(ALICE),
            BOB,
            0
        ));
        assert_eq!(Balances::free_balance(TREASURY), 0);
        assert_eq!(Balances::free_balance(BOB), bob_free0 + 1_000);
    });
}

/// E19 — a self-deal is rejected with no funds reserved, no storage written, no event.
#[test]
fn e19_self_deal_leaves_no_trace() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        register_both();
        let reserved0 = Balances::reserved_balance(ALICE);
        let free0 = Balances::free_balance(ALICE);
        assert_noop!(
            Escrow::create_agreement(
                RuntimeOrigin::signed(ALICE),
                ALICE,
                1_000,
                [1u8; 32],
                500,
                None
            ),
            Error::<Test>::SelfDeal
        );
        assert!(Agreements::<Test>::get(ALICE, ALICE).is_empty());
        assert_eq!(NextSeq::<Test>::get(ALICE, ALICE), 0);
        assert_eq!(Balances::reserved_balance(ALICE), reserved0);
        assert_eq!(Balances::free_balance(ALICE), free0);
        assert_eq!(ActiveAgreementCount::<Test>::get(), 0);
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(ALICE), 0);
        assert!(last_escrow_events().is_empty());
    });
}

/// E24 — the bilateral cap (5 in the mock) holds: the 6th open agreement is refused
/// without moving funds, and a slot frees up once one settles.
#[test]
fn e24_pair_cap_enforced_and_slot_frees_on_settlement() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        register_both();
        let reserved0 = Balances::reserved_balance(ALICE);
        for _ in 0..5 {
            assert_ok!(Escrow::create_agreement(
                RuntimeOrigin::signed(ALICE),
                BOB,
                10,
                [1u8; 32],
                500,
                None,
            ));
        }
        for seq in 0..5 {
            accept(ALICE, BOB, seq);
        }
        assert_eq!(Agreements::<Test>::get(ALICE, BOB).len(), 5);
        assert_eq!(Balances::reserved_balance(ALICE), reserved0 + 50);
        let events_before = last_escrow_events().len();

        assert_noop!(
            Escrow::create_agreement(RuntimeOrigin::signed(ALICE), BOB, 10, [1u8; 32], 500, None),
            Error::<Test>::BilateralCapReached
        );
        assert_eq!(Agreements::<Test>::get(ALICE, BOB).len(), 5);
        assert_eq!(NextSeq::<Test>::get(ALICE, BOB), 5);
        assert_eq!(Balances::reserved_balance(ALICE), reserved0 + 50);
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 5);
        assert_eq!(last_escrow_events().len(), events_before);

        // The cap is per (buyer, provider): another buyer can still open one with BOB.
        assert_ok!(Agents::register(RuntimeOrigin::signed(3), 1_000));
        assert_ok!(Escrow::create_agreement(
            RuntimeOrigin::signed(3),
            BOB,
            10,
            [1u8; 32],
            500,
            None
        ));
        assert_eq!(Agreements::<Test>::get(3, BOB).len(), 1);

        // Settling one frees a slot for ALICE.
        System::set_block_number(10);
        assert_ok!(Escrow::record_delivery(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0,
            [2u8; 32]
        ));
        assert_ok!(Escrow::confirm_delivery(
            RuntimeOrigin::signed(ALICE),
            BOB,
            0
        ));
        assert_eq!(Agreements::<Test>::get(ALICE, BOB).len(), 4);
        assert_ok!(Escrow::create_agreement(
            RuntimeOrigin::signed(ALICE),
            BOB,
            10,
            [1u8; 32],
            500,
            None
        ));
        let a = Agreements::<Test>::get(ALICE, BOB);
        assert_eq!(a.len(), 5);
        // Sequence numbers are never reused.
        assert_eq!(a.iter().map(|x| x.seq).max(), Some(5));
    });
}

/// MinDeliveryBlocks — delivery is refused until `created_at + MinDeliveryBlocks` (5),
/// allowed exactly at that block, and the refusal leaves the agreement untouched.
#[test]
fn min_delivery_blocks_boundary() {
    new_test_ext().execute_with(|| {
        setup_agreement(1_000); // created_at = 1, so delivery opens at block 6
        accept(ALICE, BOB, 0);
        System::set_block_number(5);
        assert_noop!(
            Escrow::record_delivery(RuntimeOrigin::signed(BOB), ALICE, 0, [2u8; 32]),
            Error::<Test>::MinDeliveryBlocksNotElapsed
        );
        let a = &Agreements::<Test>::get(ALICE, BOB)[0];
        assert_eq!(
            (a.status, a.delivery_proof),
            (AgreementStatus::Created, None)
        );
        // AgreementCreated + AgreementAccepted, and crucially no DeliveryRecorded.
        assert_eq!(last_escrow_events().len(), 2);

        System::set_block_number(6);
        assert_ok!(Escrow::record_delivery(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0,
            [2u8; 32]
        ));
        let a = &Agreements::<Test>::get(ALICE, BOB)[0];
        assert_eq!(
            (a.status, a.delivery_proof),
            (AgreementStatus::Delivered, Some([2u8; 32]))
        );
        assert_eq!(
            last_escrow_events().last(),
            Some(&Event::DeliveryRecorded {
                provider: BOB,
                buyer: ALICE,
                seq: 0,
                proof: [2u8; 32]
            })
        );
    });
}

/// MinDeliveryBlocks — `deliver_by` must exceed `now + MinDeliveryBlocks`; a rejected
/// create reserves nothing.
#[test]
fn min_delivery_blocks_bounds_deliver_by_at_creation() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        register_both();
        let reserved0 = Balances::reserved_balance(ALICE);
        // now(1) + MinDelivery(5) = 6: deliver_by 6 is too early, 7 is the first allowed.
        assert_noop!(
            Escrow::create_agreement(RuntimeOrigin::signed(ALICE), BOB, 1_000, [1u8; 32], 6, None),
            Error::<Test>::DeadlineTooEarly
        );
        assert_eq!(Balances::reserved_balance(ALICE), reserved0);
        assert_ok!(Escrow::create_agreement(
            RuntimeOrigin::signed(ALICE),
            BOB,
            1_000,
            [1u8; 32],
            7,
            None
        ));
        assert_eq!(Agreements::<Test>::get(ALICE, BOB)[0].deliver_by, 7);
    });
}

/// Refund path — an undelivered agreement is refundable only strictly after
/// `deliver_by + BuyerResponseWindow` (500 + 50); the buyer gets the full amount back.
#[test]
fn refund_after_buyer_response_window_returns_funds_and_clears_state() {
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);
        accept(ALICE, BOB, 0);
        let free_after_create = Balances::free_balance(ALICE);
        let reserved_after_create = Balances::reserved_balance(ALICE);

        System::set_block_number(550); // == deliver_by + window: not yet
        assert_noop!(
            Escrow::claim_refund(RuntimeOrigin::signed(ALICE), BOB, 0),
            Error::<Test>::DisputeTimeoutNotElapsed
        );
        assert_eq!(Agreements::<Test>::get(ALICE, BOB).len(), 1);
        assert_eq!(Balances::reserved_balance(ALICE), reserved_after_create);

        System::set_block_number(551);
        assert_ok!(Escrow::claim_refund(RuntimeOrigin::signed(ALICE), BOB, 0));
        assert!(Agreements::<Test>::get(ALICE, BOB).is_empty());
        assert_eq!(Balances::free_balance(ALICE), free_after_create + 1_000);
        assert_eq!(
            Balances::reserved_balance(ALICE),
            reserved_after_create - 1_000
        );
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 0);
        assert_eq!(ActiveAgreementCount::<Test>::get(), 0);
        assert_eq!(
            last_escrow_events().last(),
            Some(&Event::RefundClaimed {
                buyer: ALICE,
                provider: BOB,
                seq: 0,
                amount: 1_000
            })
        );
    });
}

/// Refund path — only the buyer of record can refund; a stranger finds no agreement and
/// the ledger is untouched.
#[test]
fn refund_by_non_buyer_is_refused() {
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);
        System::set_block_number(1_000);
        let reserved0 = Balances::reserved_balance(ALICE);
        assert_noop!(
            Escrow::claim_refund(RuntimeOrigin::signed(3), BOB, 0),
            Error::<Test>::AgreementNotFound
        );
        // The provider signing as "buyer" is likewise not found (no BOB→BOB agreement).
        assert_noop!(
            Escrow::claim_refund(RuntimeOrigin::signed(BOB), BOB, 0),
            Error::<Test>::AgreementNotFound
        );
        assert_eq!(Agreements::<Test>::get(ALICE, BOB).len(), 1);
        assert_eq!(Balances::reserved_balance(ALICE), reserved0);
    });
}

/// Refund path — a disputed agreement refunds the buyer only once `DisputeTimeoutWindow`
/// (200) has passed since it opened, and only the post-bounty remainder is returned.
#[test]
fn refund_of_disputed_agreement_waits_for_dispute_timeout() {
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);
        accept(ALICE, BOB, 0);
        System::set_block_number(10);
        assert_ok!(Escrow::record_delivery(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0,
            [2u8; 32]
        ));
        assert_ok!(Escrow::dispute_delivery(
            RuntimeOrigin::signed(ALICE),
            BOB,
            0
        ));
        // Bounty = max(2% of 1_000 = 20, MinBounty 10) = 20 leaves the agreement amount.
        let a = &Agreements::<Test>::get(ALICE, BOB)[0];
        assert_eq!(
            (a.status, a.amount, a.dispute_opened_at),
            (AgreementStatus::Disputed, 980, Some(10))
        );
        let reserved0 = Balances::reserved_balance(ALICE);
        let free0 = Balances::free_balance(ALICE);

        System::set_block_number(209); // opened(10) + 200 = 210 is the first refundable block
        assert_noop!(
            Escrow::claim_refund(RuntimeOrigin::signed(ALICE), BOB, 0),
            Error::<Test>::DisputeTimeoutNotElapsed
        );
        System::set_block_number(210);
        assert_ok!(Escrow::claim_refund(RuntimeOrigin::signed(ALICE), BOB, 0));
        assert!(Agreements::<Test>::get(ALICE, BOB).is_empty());
        assert_eq!(Balances::free_balance(ALICE), free0 + 980);
        assert_eq!(Balances::reserved_balance(ALICE), reserved0 - 980);
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 0);
        assert_eq!(
            last_escrow_events().last(),
            Some(&Event::RefundClaimed {
                buyer: ALICE,
                provider: BOB,
                seq: 0,
                amount: 980
            })
        );
    });
}

// ── E18 / E2: provider consent and the permissionless exit (#180) ────────────
//
// Every test below asserts on emitted events and on reserved/free balances, never
// only on a call's return value: a refund path that returned Ok(()) while moving
// nothing would pass a return-value-only test.

/// A third party who is neither buyer nor provider — used to prove `expire_agreement`
/// is permissionless. Funded in `new_test_ext`, registered only where needed.
const CAROL: u64 = 3;

/// The pending-acceptance key for an agreement, spelled out once.
fn pending_at(buyer: u64, provider: u64, seq: u32) -> Option<u64> {
    PendingAcceptance::<Test>::get(buyer, (provider, seq))
}

/// Simulate an agreement that predates this change: created under the old rules, where
/// `create_agreement` incremented the provider's count and wrote no pending entry.
fn grandfather(buyer: u64, provider: u64, seq: u32) {
    PendingAcceptance::<Test>::remove(buyer, (provider, seq));
    pallet_agents::ActiveEscrowCount::<Test>::mutate(provider, |c| *c += 1);
}

/// E18 — an agreement does not bind the provider until the provider accepts. Until then
/// it holds the buyer's funds but does not touch the provider's `ActiveEscrowCount`, and
/// no delivery can be recorded against it.
#[test]
fn e18e2_agreement_requires_provider_consent() {
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);

        // Created, not yet accepted: funds held, provider untouched.
        assert_eq!(pending_at(ALICE, BOB, 0), Some(1));
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 0);
        assert_eq!(Balances::reserved_balance(ALICE), 1_000);
        assert_eq!(ActiveAgreementCount::<Test>::get(), 1);

        // No delivery without consent.
        System::set_block_number(10);
        assert_noop!(
            Escrow::record_delivery(RuntimeOrigin::signed(BOB), ALICE, 0, [2u8; 32]),
            Error::<Test>::NotAccepted
        );

        // Only the provider of record may accept.
        assert_noop!(
            Escrow::accept_agreement(RuntimeOrigin::signed(CAROL), ALICE, 0),
            Error::<Test>::AgreementNotFound
        );
        assert_noop!(
            Escrow::accept_agreement(RuntimeOrigin::signed(ALICE), ALICE, 0),
            Error::<Test>::AgreementNotFound
        );

        assert_ok!(Escrow::accept_agreement(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0
        ));
        assert_eq!(pending_at(ALICE, BOB, 0), None);
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 1);
        // Consent moves no funds: the reserve is unchanged by acceptance.
        assert_eq!(Balances::reserved_balance(ALICE), 1_000);
        assert_eq!(
            last_escrow_events().last(),
            Some(&Event::AgreementAccepted {
                buyer: ALICE,
                provider: BOB,
                seq: 0
            })
        );

        // Accepting twice must not double-count the provider.
        assert_noop!(
            Escrow::accept_agreement(RuntimeOrigin::signed(BOB), ALICE, 0),
            Error::<Test>::NotPending
        );
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 1);

        // With consent, delivery proceeds as before.
        assert_ok!(Escrow::record_delivery(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0,
            [2u8; 32]
        ));
    });
}

/// E18 — the attack this finding is about: pending agreements must not pin an agent's
/// stake. A buyer opening agreements the provider never agreed to cannot block its unstake.
#[test]
fn e18e2_victim_can_unstake_with_pending_agreements_open() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        register_both();
        // Three unconsented agreements against BOB, up to the bilateral cap of 5.
        for _ in 0..3 {
            assert_ok!(Escrow::create_agreement(
                RuntimeOrigin::signed(ALICE),
                BOB,
                1_000,
                [1u8; 32],
                500,
                None,
            ));
        }
        assert_eq!(Balances::reserved_balance(ALICE), 3_000);
        assert_eq!(ActiveAgreementCount::<Test>::get(), 3);
        // None of them counts against the provider.
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 0);

        // So the victim can still leave.
        assert_ok!(Agents::request_unstake(RuntimeOrigin::signed(BOB)));

        // Consent is what binds: an accepted agreement does block the unstake.
        assert_ok!(Escrow::accept_agreement(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0
        ));
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 1);
        System::set_block_number(200); // past the 100-block cooldown
        assert_noop!(
            Agents::complete_unstake(RuntimeOrigin::signed(BOB)),
            pallet_agents::Error::<Test>::HasActiveAgreements
        );
    });
}

/// E18 — a provider may decline an agreement it never accepted, and the buyer gets the
/// whole reserve back. Declining is only possible while pending, so it cannot be used to
/// walk away from a commitment already made.
#[test]
fn e18e2_provider_can_reject_pending_agreement_and_buyer_is_refunded() {
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);
        let free_before = Balances::free_balance(ALICE);

        // A stranger cannot reject on the provider's behalf.
        assert_noop!(
            Escrow::reject_agreement(RuntimeOrigin::signed(CAROL), ALICE, 0),
            Error::<Test>::AgreementNotFound
        );

        assert_ok!(Escrow::reject_agreement(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0
        ));
        assert_eq!(Balances::free_balance(ALICE), free_before + 1_000);
        assert_eq!(Balances::reserved_balance(ALICE), 0);
        assert!(Agreements::<Test>::get(ALICE, BOB).is_empty());
        assert_eq!(pending_at(ALICE, BOB, 0), None);
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 0);
        assert_eq!(ActiveAgreementCount::<Test>::get(), 0);
        assert_eq!(
            last_escrow_events().last(),
            Some(&Event::AgreementRejected {
                buyer: ALICE,
                provider: BOB,
                seq: 0,
                amount: 1_000
            })
        );

        // Once accepted, reject is closed off.
        assert_ok!(Escrow::create_agreement(
            RuntimeOrigin::signed(ALICE),
            BOB,
            1_000,
            [1u8; 32],
            500,
            None,
        ));
        assert_ok!(Escrow::accept_agreement(
            RuntimeOrigin::signed(BOB),
            ALICE,
            1
        ));
        assert_noop!(
            Escrow::reject_agreement(RuntimeOrigin::signed(BOB), ALICE, 1),
            Error::<Test>::NotPending
        );
        assert_eq!(Balances::reserved_balance(ALICE), 1_000);
    });
}

/// E18 — the buyer's own exit: funds are never held hostage by a silent provider, and the
/// buyer need not wait for any deadline while the agreement is still unconsented.
#[test]
fn e18e2_buyer_can_cancel_pending_agreement() {
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);
        let free_before = Balances::free_balance(ALICE);

        // Only the buyer of record; the provider cannot cancel through this door.
        assert_noop!(
            Escrow::cancel_pending(RuntimeOrigin::signed(CAROL), BOB, 0),
            Error::<Test>::AgreementNotFound
        );

        // Immediately, well before deliver_by (500).
        assert_ok!(Escrow::cancel_pending(RuntimeOrigin::signed(ALICE), BOB, 0));
        assert_eq!(Balances::free_balance(ALICE), free_before + 1_000);
        assert_eq!(Balances::reserved_balance(ALICE), 0);
        assert!(Agreements::<Test>::get(ALICE, BOB).is_empty());
        assert_eq!(pending_at(ALICE, BOB, 0), None);
        assert_eq!(ActiveAgreementCount::<Test>::get(), 0);
        assert_eq!(
            last_escrow_events().last(),
            Some(&Event::PendingCancelled {
                buyer: ALICE,
                provider: BOB,
                seq: 0,
                amount: 1_000
            })
        );

        // After acceptance the buyer is committed and must use the normal paths.
        assert_ok!(Escrow::create_agreement(
            RuntimeOrigin::signed(ALICE),
            BOB,
            1_000,
            [1u8; 32],
            500,
            None,
        ));
        assert_ok!(Escrow::accept_agreement(
            RuntimeOrigin::signed(BOB),
            ALICE,
            1
        ));
        assert_noop!(
            Escrow::cancel_pending(RuntimeOrigin::signed(ALICE), BOB, 1),
            Error::<Test>::NotPending
        );
        assert_eq!(Balances::reserved_balance(ALICE), 1_000);
    });
}

/// E18 — `record_delivery` is gated on consent. Stated on its own because it is the guard
/// that stops a provider from unilaterally converting a pending agreement into a claim.
#[test]
fn e18e2_record_delivery_requires_acceptance() {
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);
        System::set_block_number(10);
        assert_noop!(
            Escrow::record_delivery(RuntimeOrigin::signed(BOB), ALICE, 0, [2u8; 32]),
            Error::<Test>::NotAccepted
        );
        // The refusal is not a side effect of status: the agreement is still Created.
        assert_eq!(
            Agreements::<Test>::get(ALICE, BOB)[0].status,
            AgreementStatus::Created
        );
        assert_ok!(Escrow::accept_agreement(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0
        ));
        assert_ok!(Escrow::record_delivery(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0,
            [2u8; 32]
        ));
        assert_eq!(
            Agreements::<Test>::get(ALICE, BOB)[0].status,
            AgreementStatus::Delivered
        );
    });
}

/// E18 — a never-accepted agreement returns the buyer's reserve in full, through every
/// door that closes it: provider reject, buyer cancel, and permissionless expiry. Full
/// means full — no completion fee, no bounty, no dust left reserved.
#[test]
fn e18e2_unaccepted_agreement_refunds_the_buyer_in_full() {
    // Door 1 — the provider rejects.
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);
        let (free0, reserved0) = (
            Balances::free_balance(ALICE),
            Balances::reserved_balance(ALICE),
        );
        assert_eq!(reserved0, 1_000);
        assert_ok!(Escrow::reject_agreement(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0
        ));
        assert_eq!(Balances::free_balance(ALICE), free0 + 1_000);
        assert_eq!(Balances::reserved_balance(ALICE), 0);
        // The EVENT, not only the balances. #180 asks for both ("assert on emitted
        // events and on reserved balances") and these doors asserted only the
        // second half. Each door must name ITS OWN event, or the assertion would
        // pass on any refund from any path.
        assert!(
            last_escrow_events()
                .iter()
                .any(|e| matches!(e, crate::pallet::Event::AgreementRejected { amount, .. } if *amount == 1_000)),
            "door 1 is reject_agreement and must emit AgreementRejected"
        );
        assert_eq!(Balances::free_balance(TREASURY), 0);
    });
    // Door 2 — the buyer cancels.
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);
        let (free0, reserved0) = (
            Balances::free_balance(ALICE),
            Balances::reserved_balance(ALICE),
        );
        assert_eq!(reserved0, 1_000);
        assert_ok!(Escrow::cancel_pending(RuntimeOrigin::signed(ALICE), BOB, 0));
        assert_eq!(Balances::free_balance(ALICE), free0 + 1_000);
        assert_eq!(Balances::reserved_balance(ALICE), 0);
        assert!(
            last_escrow_events()
                .iter()
                .any(|e| matches!(e, crate::pallet::Event::PendingCancelled { amount, .. } if *amount == 1_000)),
            "door 2 is cancel_pending and must emit PendingCancelled"
        );
        assert_eq!(Balances::free_balance(TREASURY), 0);
    });
    // Door 3 — anyone expires it after deliver_by + EXPIRY_GRACE.
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);
        let (free0, reserved0) = (
            Balances::free_balance(ALICE),
            Balances::reserved_balance(ALICE),
        );
        assert_eq!(reserved0, 1_000);
        System::set_block_number(511); // deliver_by(500) + GRACE(10) + 1
        assert_ok!(Escrow::expire_agreement(
            RuntimeOrigin::signed(CAROL),
            ALICE,
            BOB,
            0
        ));
        assert_eq!(Balances::free_balance(ALICE), free0 + 1_000);
        assert_eq!(Balances::reserved_balance(ALICE), 0);
        assert_eq!(Balances::free_balance(TREASURY), 0);
        assert_eq!(
            last_escrow_events().last(),
            Some(&Event::AgreementExpired {
                buyer: ALICE,
                provider: BOB,
                seq: 0,
                amount: 1_000
            })
        );
    });
}

/// E2 — liveness does not depend on a privileged or interested caller. A third party who
/// is neither buyer nor provider closes a stuck agreement and the buyer is made whole.
#[test]
fn e18e2_expire_agreement_is_permissionless_after_deadline() {
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);
        assert_ok!(Escrow::accept_agreement(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0
        ));
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 1);
        let free0 = Balances::free_balance(ALICE);
        let issuance0 = Balances::total_issuance();

        // CAROL is not registered as an agent and is party to nothing here.
        System::set_block_number(511); // deliver_by(500) + GRACE(10) + 1
        assert_ok!(Escrow::expire_agreement(
            RuntimeOrigin::signed(CAROL),
            ALICE,
            BOB,
            0
        ));

        assert_eq!(Balances::free_balance(ALICE), free0 + 1_000);
        assert_eq!(Balances::reserved_balance(ALICE), 0);
        assert!(Agreements::<Test>::get(ALICE, BOB).is_empty());
        // The accepted agreement released the provider's slot.
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 0);
        assert_eq!(ActiveAgreementCount::<Test>::get(), 0);
        assert_eq!(
            last_escrow_events().last(),
            Some(&Event::AgreementExpired {
                buyer: ALICE,
                provider: BOB,
                seq: 0,
                amount: 1_000
            })
        );
        // Expiry earns the provider no escrow volume, so it cannot be farmed for emissions.
        assert_eq!(pallet_agents::EraEscrowVolume::<Test>::get(BOB), 0);
        // First principle 1: a refund is a reserve release, never a mint or a burn.
        assert_eq!(Balances::total_issuance(), issuance0);
    });
}

/// E2 — the deadline is the whole guard, so its boundary is exact: expiry opens strictly
/// after `deliver_by + EXPIRY_GRACE`, never at or before it.
#[test]
fn e18e2_expire_before_deadline_is_rejected() {
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);
        assert_ok!(Escrow::accept_agreement(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0
        ));
        let reserved0 = Balances::reserved_balance(ALICE);

        for block in [1u64, 250, 500, 510] {
            System::set_block_number(block);
            assert_noop!(
                Escrow::expire_agreement(RuntimeOrigin::signed(CAROL), ALICE, BOB, 0),
                Error::<Test>::AgreementNotExpired
            );
            // Nothing moved and nobody's books changed.
            assert_eq!(Balances::reserved_balance(ALICE), reserved0);
            assert_eq!(Agreements::<Test>::get(ALICE, BOB).len(), 1);
            assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 1);
        }

        System::set_block_number(511);
        assert_ok!(Escrow::expire_agreement(
            RuntimeOrigin::signed(CAROL),
            ALICE,
            BOB,
            0
        ));
        assert_eq!(Balances::reserved_balance(ALICE), reserved0 - 1_000);
        // The EVENT too, not only the balances. The conformance lens noted this test
        // asserted movement without asserting what the chain told the world about it, and
        // the event is the only part an indexer or SDK can see.
        assert!(
            last_escrow_events().iter().any(|e| matches!(
                e,
                crate::pallet::Event::AgreementExpired { buyer, provider, seq, amount }
                    if *buyer == ALICE && *provider == BOB && *seq == 0 && *amount == 1_000
            )),
            "expiry must emit AgreementExpired with the buyer, provider, seq and amount"
        );
    });
}

/// E2 — every status has a permissionless exit, and the buyer's own door always opens first.
///
/// REPLACES `e18e2_expire_agreement_rejects_when_delivered`, which asserted that a recorded
/// delivery "closes the expiry door permanently". That was the defect, not the feature: it
/// left the exact stake-pinning attack E18 exists to kill, moved one step later. Buyer
/// creates the minimum agreement, provider accepts, provider delivers, buyer goes silent —
/// `confirm_delivery`, `dispute_delivery` and `claim_refund` are all buyer-signed, so nothing
/// could ever close it and the provider's whole stake stayed frozen behind
/// `ActiveEscrowCount > 0`. Found by the tokenomics-security-reviewer on PR #233.
///
/// The property that replaces it is stronger, not weaker: expiry is reachable from every
/// status, but only AFTER the window belonging to that status plus EXPIRY_GRACE — so a slow
/// buyer always outranks a stranger, and the payee is the buyer of record either way.
///
/// Fixture: deliver_by 500, BuyerResponseWindow 50, DisputeTimeout 200, EXPIRY_GRACE 10.
#[test]
fn e18e2_expire_agreement_reaches_every_status_but_never_before_the_buyer() {
    // Delivered, buyer silent. Expiry opens at 500 + 50 + 10 = 560.
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);
        assert_ok!(Escrow::accept_agreement(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0
        ));
        System::set_block_number(10);
        assert_ok!(Escrow::record_delivery(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0,
            [2u8; 32]
        ));
        let reserved0 = Balances::reserved_balance(ALICE);
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 1);

        // The buyer's window has not elapsed: nobody may expire it.
        System::set_block_number(540);
        assert_noop!(
            Escrow::expire_agreement(RuntimeOrigin::signed(CAROL), ALICE, BOB, 0),
            Error::<Test>::AgreementNotExpired
        );

        // The buyer's own door is open (550) while expiry is still shut (560). This gap is
        // the priority guarantee, and it is the reason EXPIRY_GRACE is added on top.
        System::set_block_number(555);
        assert_noop!(
            Escrow::expire_agreement(RuntimeOrigin::signed(CAROL), ALICE, BOB, 0),
            Error::<Test>::AgreementNotExpired
        );

        // Past the window plus grace: a stranger can close it, and the provider's stake is
        // released. Without this the agreement was unclosable and the stake frozen forever.
        System::set_block_number(561);
        assert_ok!(Escrow::expire_agreement(
            RuntimeOrigin::signed(CAROL),
            ALICE,
            BOB,
            0
        ));
        assert_eq!(Balances::reserved_balance(ALICE), reserved0 - 1_000);
        assert_eq!(Agreements::<Test>::get(ALICE, BOB).len(), 0);
        assert_eq!(
            pallet_agents::ActiveEscrowCount::<Test>::get(BOB),
            0,
            "the provider's slot must be released or its stake is pinned forever"
        );
    });

    // Disputed and abandoned. Dispute opened at block 10, so expiry opens at 10 + 200 + 10.
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);
        assert_ok!(Escrow::accept_agreement(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0
        ));
        System::set_block_number(10);
        assert_ok!(Escrow::record_delivery(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0,
            [2u8; 32]
        ));
        assert_ok!(Escrow::dispute_delivery(
            RuntimeOrigin::signed(ALICE),
            BOB,
            0
        ));
        let reserved0 = Balances::reserved_balance(ALICE);

        System::set_block_number(200);
        assert_noop!(
            Escrow::expire_agreement(RuntimeOrigin::signed(CAROL), ALICE, BOB, 0),
            Error::<Test>::AgreementNotExpired
        );

        System::set_block_number(221);
        assert_ok!(Escrow::expire_agreement(
            RuntimeOrigin::signed(CAROL),
            ALICE,
            BOB,
            0
        ));
        // 980, not 1 000: `dispute_delivery` carves the bounty OUT of the agreement
        // amount (`a.amount = a.amount.saturating_sub(bounty)`, bounty = max(2%, MinBounty)
        // = 20). Expiry releases the agreement and deliberately does NOT touch the bounty —
        // that is the oracle's to release through its own `expire_request`. So exactly the
        // bounty stays reserved here, and this assertion is the one that says so.
        assert_eq!(Balances::reserved_balance(ALICE), reserved0 - 980);
        assert_eq!(
            Balances::reserved_balance(ALICE),
            20,
            "the oracle's bounty, untouched"
        );
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 0);
    });
}

/// E2 — the stake-pinning attack, run end to end, as the thing that must not work.
///
/// This is the HIGH finding from PR #233's tokenomics review stated as a test: a buyer
/// spending the minimum reserve must not be able to freeze a provider's entire stake by
/// accepting delivery and then going silent. The leverage was better than 100:1 (a 10 CMN
/// reserve against a 1 000 CMN stake), and it made DELIVERING the provider's risky move,
/// which inverts the emissions thesis.
#[test]
fn e18e2_a_silent_buyer_cannot_pin_a_providers_stake_forever() {
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);
        assert_ok!(Escrow::accept_agreement(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0
        ));
        System::set_block_number(10);
        assert_ok!(Escrow::record_delivery(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0,
            [2u8; 32]
        ));

        // The provider has done the work and is blocked from unstaking, correctly, while
        // the agreement is live.
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 1);

        // The buyer never returns. Anyone at all can now end it.
        System::set_block_number(1_000);
        assert_ok!(Escrow::expire_agreement(
            RuntimeOrigin::signed(CAROL),
            ALICE,
            BOB,
            0
        ));

        // The count is what gates request_unstake; at 0 the provider is free again.
        assert_eq!(
            pallet_agents::ActiveEscrowCount::<Test>::get(BOB),
            0,
            "a silent buyer must not be able to freeze a provider's stake"
        );
    });
}

/// The reserve is released exactly once, whichever refund door fires first. Asserted on
/// reserved balances in both orders, because a second `unreserve` on an already-released
/// reserve returns success while moving nothing and would pass a return-value-only test.
#[test]
fn e18e2_refund_cannot_be_claimed_twice_across_paths() {
    // Order 1 — expiry (deliver_by + 10) closes the agreement before claim_refund
    // (deliver_by + 50) is even available.
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);
        assert_ok!(Escrow::accept_agreement(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0
        ));
        let free0 = Balances::free_balance(ALICE);

        System::set_block_number(511);
        assert_ok!(Escrow::expire_agreement(
            RuntimeOrigin::signed(CAROL),
            ALICE,
            BOB,
            0
        ));
        assert_eq!(Balances::free_balance(ALICE), free0 + 1_000);
        assert_eq!(Balances::reserved_balance(ALICE), 0);
        // The refund that FIRED must say so on chain. #180 asks for events and
        // balances; this test asserted balances only, which is how a refund that
        // moved money without announcing it would pass.
        assert!(
            last_escrow_events()
                .iter()
                .any(|e| matches!(e, crate::pallet::Event::AgreementExpired { amount, .. } if *amount == 1_000)),
            "the winning door must emit its own event"
        );

        System::set_block_number(551); // claim_refund's window has now opened
        assert_noop!(
            Escrow::claim_refund(RuntimeOrigin::signed(ALICE), BOB, 0),
            Error::<Test>::AgreementNotFound
        );
        // The second attempt paid nothing out.
        assert_eq!(Balances::free_balance(ALICE), free0 + 1_000);
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 0);
        assert_eq!(ActiveAgreementCount::<Test>::get(), 0);
    });
    // Order 2 — the buyer claims first; expiry then finds nothing.
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);
        assert_ok!(Escrow::accept_agreement(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0
        ));
        let free0 = Balances::free_balance(ALICE);

        System::set_block_number(551);
        assert_ok!(Escrow::claim_refund(RuntimeOrigin::signed(ALICE), BOB, 0));
        assert_eq!(Balances::free_balance(ALICE), free0 + 1_000);
        assert_eq!(Balances::reserved_balance(ALICE), 0);

        assert_noop!(
            Escrow::expire_agreement(RuntimeOrigin::signed(CAROL), ALICE, BOB, 0),
            Error::<Test>::AgreementNotFound
        );
        assert_eq!(Balances::free_balance(ALICE), free0 + 1_000);
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 0);
        assert_eq!(ActiveAgreementCount::<Test>::get(), 0);
    });
    // Order 3 — a pending agreement cancelled by the buyer cannot then be expired.
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);
        let free0 = Balances::free_balance(ALICE);
        assert_ok!(Escrow::cancel_pending(RuntimeOrigin::signed(ALICE), BOB, 0));
        assert_eq!(Balances::free_balance(ALICE), free0 + 1_000);

        System::set_block_number(511);
        assert_noop!(
            Escrow::expire_agreement(RuntimeOrigin::signed(CAROL), ALICE, BOB, 0),
            Error::<Test>::AgreementNotFound
        );
        assert_noop!(
            Escrow::reject_agreement(RuntimeOrigin::signed(BOB), ALICE, 0),
            Error::<Test>::AgreementNotFound
        );
        assert_eq!(Balances::free_balance(ALICE), free0 + 1_000);
        assert_eq!(Balances::reserved_balance(ALICE), 0);
    });
}

/// The #204 blocker, as a test. `claim_refund` decrements the provider's
/// `ActiveEscrowCount` unconditionally, which is only sound for an agreement the provider
/// accepted. A sybil buyer must not be able to spend a refundable reserve to walk a
/// victim's count down and unstake it out from under its real obligations.
#[test]
fn e18e2_claim_refund_rejects_pending_agreement() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        register_both();
        assert_ok!(Agents::register(RuntimeOrigin::signed(CAROL), 1_000));

        // BOB has one real, accepted obligation, to CAROL.
        assert_ok!(Escrow::create_agreement(
            RuntimeOrigin::signed(CAROL),
            BOB,
            1_000,
            [1u8; 32],
            500,
            None,
        ));
        assert_ok!(Escrow::accept_agreement(
            RuntimeOrigin::signed(BOB),
            CAROL,
            0
        ));
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 1);

        // ALICE, the attacker, opens an agreement BOB never accepted and waits out
        // deliver_by + BuyerResponseWindow.
        assert_ok!(Escrow::create_agreement(
            RuntimeOrigin::signed(ALICE),
            BOB,
            1_000,
            [1u8; 32],
            500,
            None,
        ));
        System::set_block_number(551);

        // Consent is classified before eligibility: the answer is NotAccepted, not
        // DisputeTimeoutNotElapsed. Waiting longer would never help, and cancel_pending
        // is available to ALICE right now for the same full amount.
        assert_noop!(
            Escrow::claim_refund(RuntimeOrigin::signed(ALICE), BOB, 0),
            Error::<Test>::NotAccepted
        );

        // The victim's count is intact, so its unstake is still correctly blocked.
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 1);
        assert_noop!(
            Agents::request_unstake(RuntimeOrigin::signed(BOB)),
            pallet_agents::Error::<Test>::HasActiveAgreements
        );
        // And no pending entry was orphaned.
        assert_eq!(pending_at(ALICE, BOB, 0), Some(1));
        assert_eq!(Balances::reserved_balance(ALICE), 1_000);

        // ALICE's own exit still works and takes nothing from BOB's books.
        let free0 = Balances::free_balance(ALICE);
        assert_ok!(Escrow::cancel_pending(RuntimeOrigin::signed(ALICE), BOB, 0));
        assert_eq!(Balances::free_balance(ALICE), free0 + 1_000);
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 1);
    });
}

/// The same count-integrity concern on the expiry path: expiring a pending agreement must
/// not consume a slot that belongs to one the provider did accept.
#[test]
fn e18e2_expire_pending_agreement_leaves_provider_count_alone() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        register_both();
        assert_ok!(Agents::register(RuntimeOrigin::signed(CAROL), 1_000));

        // One accepted agreement (CAROL→BOB) and one pending (ALICE→BOB).
        assert_ok!(Escrow::create_agreement(
            RuntimeOrigin::signed(CAROL),
            BOB,
            1_000,
            [1u8; 32],
            500,
            None,
        ));
        assert_ok!(Escrow::accept_agreement(
            RuntimeOrigin::signed(BOB),
            CAROL,
            0
        ));
        assert_ok!(Escrow::create_agreement(
            RuntimeOrigin::signed(ALICE),
            BOB,
            1_000,
            [1u8; 32],
            500,
            None,
        ));
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 1);
        assert_eq!(ActiveAgreementCount::<Test>::get(), 2);

        System::set_block_number(511);
        let free0 = Balances::free_balance(ALICE);
        assert_ok!(Escrow::expire_agreement(
            RuntimeOrigin::signed(CAROL),
            ALICE,
            BOB,
            0
        ));

        assert_eq!(Balances::free_balance(ALICE), free0 + 1_000);
        assert_eq!(Balances::reserved_balance(ALICE), 0);
        // The accepted agreement's slot survives the pending one's expiry.
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 1);
        assert_eq!(ActiveAgreementCount::<Test>::get(), 1);
        assert_eq!(pending_at(ALICE, BOB, 0), None);
        // BOB still owes CAROL, so it cannot leave.
        assert_noop!(
            Agents::request_unstake(RuntimeOrigin::signed(BOB)),
            pallet_agents::Error::<Test>::HasActiveAgreements
        );
    });
}

/// No migration: an agreement that predates `PendingAcceptance` has no entry, so absence
/// of an entry must read as "accepted". This is what lets the change ship without touching
/// storage layout or bumping `spec_version`.
#[test]
fn e18e2_grandfathered_agreement_without_entry_is_treated_as_accepted() {
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);
        // Rewrite the agreement into its pre-upgrade shape: no pending entry, and the
        // provider's count already incremented, as the old `create_agreement` did.
        grandfather(ALICE, BOB, 0);
        assert_eq!(pending_at(ALICE, BOB, 0), None);
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 1);

        // It needs no consent, and none can be given.
        assert_noop!(
            Escrow::accept_agreement(RuntimeOrigin::signed(BOB), ALICE, 0),
            Error::<Test>::NotPending
        );
        // Nor can it be rejected or cancelled as if it were pending.
        assert_noop!(
            Escrow::reject_agreement(RuntimeOrigin::signed(BOB), ALICE, 0),
            Error::<Test>::NotPending
        );
        assert_noop!(
            Escrow::cancel_pending(RuntimeOrigin::signed(ALICE), BOB, 0),
            Error::<Test>::NotPending
        );
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 1);

        // It delivers and settles on the pre-upgrade path, untouched.
        System::set_block_number(10);
        assert_ok!(Escrow::record_delivery(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0,
            [2u8; 32]
        ));
        let bob_free0 = Balances::free_balance(BOB);
        assert_ok!(Escrow::confirm_delivery(
            RuntimeOrigin::signed(ALICE),
            BOB,
            0
        ));
        assert_eq!(Balances::free_balance(BOB), bob_free0 + 1_000);
        assert_eq!(Balances::reserved_balance(ALICE), 0);
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 0);
    });
}

/// A grandfathered agreement also refunds through `claim_refund`, since absence of a
/// pending entry means the consent check passes.
#[test]
fn e18e2_grandfathered_agreement_can_still_claim_refund() {
    new_test_ext().execute_with(|| {
        setup_agreement(1_000);
        grandfather(ALICE, BOB, 0);
        let free0 = Balances::free_balance(ALICE);

        System::set_block_number(551); // deliver_by(500) + BuyerResponseWindow(50) + 1
        assert_ok!(Escrow::claim_refund(RuntimeOrigin::signed(ALICE), BOB, 0));
        assert_eq!(Balances::free_balance(ALICE), free0 + 1_000);
        assert_eq!(Balances::reserved_balance(ALICE), 0);
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 0);
        assert_eq!(
            last_escrow_events().last(),
            Some(&Event::RefundClaimed {
                buyer: ALICE,
                provider: BOB,
                seq: 0,
                amount: 1_000
            })
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

/// `accept_agreement` refuses once `deliver_by` has passed.
///
/// This rule is not in issue #180 — the spec-conformance lens flagged it as an
/// unrequested addition that no required test covered. It is sound (consenting to an
/// offer whose deadline has already gone commits a provider to work it cannot be paid
/// for, since `record_delivery` would then be late), so it stays — but untested
/// behaviour in a T1 pallet is a gap whether or not anyone asked for the behaviour.
///
/// The buyer is not stranded by the refusal: the agreement is still `Pending`, so
/// `cancel_pending` refunds it in full immediately, and `expire_agreement` reaches it
/// once the grace has passed.
#[test]
fn e18e2_accept_agreement_refuses_after_the_deadline() {
    new_test_ext().execute_with(|| {
        setup_agreement(1_000); // deliver_by = 500
        System::set_block_number(501);
        assert_noop!(
            Escrow::accept_agreement(RuntimeOrigin::signed(BOB), ALICE, 0),
            Error::<Test>::DeadlinePassed
        );
        // Refused, and nothing moved: no slot taken, still pending, funds still reserved.
        assert_eq!(pallet_agents::ActiveEscrowCount::<Test>::get(BOB), 0);
        assert!(PendingAcceptance::<Test>::contains_key(ALICE, (BOB, 0)));
        assert_eq!(Balances::reserved_balance(ALICE), 1_000);

        // And the buyer still has a door out, which is why the refusal is safe.
        assert_ok!(Escrow::cancel_pending(RuntimeOrigin::signed(ALICE), BOB, 0));
        assert_eq!(Balances::reserved_balance(ALICE), 0);
    });
}
