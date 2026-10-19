//! pallet-orchestrator unit tests
//!
//! Gated by `#[cfg(test)] mod tests;` in `lib.rs` — no inner `#![cfg(test)]`.

use crate::pallet::*;
use frame_support::{
    assert_noop, assert_ok,
    traits::{ConstU16, ConstU32, ConstU64, Get},
};
use sp_core::H256;
use sp_runtime::{
    traits::{BlakeTwo256, IdentityLookup},
    BuildStorage,
};

type Block = frame_system::mocking::MockBlock<Test>;

frame_support::construct_runtime!(
    pub enum Test {
        System:       frame_system,
        Balances:     pallet_balances,
        Agents:       pallet_agents,
        Orchestrator: crate,
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

// pallet_agents::Config::OrchestratorLookup wants a type implementing
// OrchestratorLookup<AccountId, Balance>; the orchestrator Pallet itself does not
// implement that trait, so the mock cannot point straight at it. The runtime and
// tests/common.rs both solve this with a bridge struct — this mirrors
// runtime/src/lib.rs:960 exactly, so volume routing behaves as it does on-chain.
pub struct TestOrchestratorBridge;
impl pallet_agents::pallet::OrchestratorLookup<u64, u64> for TestOrchestratorBridge {
    fn get_orchestrator(sub_agent: &u64) -> Option<u64> {
        SubAgentToOrchestrator::<Test>::get(sub_agent)
    }
    fn add_orchestrator_volume(orchestrator: &u64, amount: u64) {
        crate::Pallet::<Test>::add_orchestrator_volume(orchestrator, amount);
    }
}
impl pallet_agents::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    type Currency = Balances;
    // Balance- and BlockNumber-typed constants: ConstU64, not ConstU32, since both
    // are u64 in this mock. Every value carried over unchanged.
    type MinStake = ConstU64<1_000>;
    type FullFloorStake = ConstU64<10_000>;
    type MaxStakePerAgent = ConstU64<1_000_000>;
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
    type AgentCollective = MockCollective;
    type OracleScoreGate = ();
    type GovVoteVerifier = MockGovVoteVerifier;
    type IdentityHandler = ();
    type OrchestratorLookup = TestOrchestratorBridge;
    type MaxUriLen = ConstU32<256>;
    type MaxNameLen = ConstU32<64>;
    type MaxCapabilitiesPerAgent = ConstU32<20>;
    type MaxDelegationPeriod = ConstU64<100_800>; // BlockNumber = u64 in test runtime
    type SlashAppealWindow = ConstU64<10>; // BlockNumber = u64 in test runtime
    type SlashDestination = ();
    type MaxProposalsPerEra = ConstU32<20>;
}

impl super::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    type MaxSubAgentsPerOrchestrator = ConstU32<50>;
    type MaxOrchestratorFeeBps = ConstU32<500>;
    // BlockNumber-typed (Get<BlockNumberFor<Self>>): ConstU64. Value unchanged: 100.
    type LinkApprovalWindow = ConstU64<100>;
    type MaxPendingProposals = ConstU32<20>;
    // `OrchestratorEmissionMultiplier` was set here but is not a member of
    // orchestrator::Config (E0437) — it belongs to pallet_emissions::Config, where
    // this mock's sibling in pallets/emissions/src/tests.rs already sets it to the
    // same ConstU32<5_000>. Removing it drops a line that never bound anything.
    // Was ConstU64<100_000_000_000_000_000_000> — 1e20, which does not fit u64
    // (max ~1.84e19), a deny-by-default overflowing_literals error. It had been
    // masked until now by the E0437 above aborting this impl block first.
    // u64::MAX is what the original comment ("u64 max-safe cap") intended: a
    // non-binding cap. Nothing here depends on the value — no orchestrator test
    // reaches the SupplyCap guard at lib.rs:291.
    type SupplyCap = ConstU64<{ u64::MAX }>;
}

fn new_test_ext() -> sp_io::TestExternalities {
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

const ALICE: u64 = 1; // orchestrator candidate
const BOB: u64 = 2; // sub-agent candidate
const CAROL: u64 = 3; // another agent

fn register(who: u64, stake: u64) {
    assert_ok!(Agents::register(RuntimeOrigin::signed(who), stake));
}

#[test]
fn register_orchestrator_requires_rank2() {
    new_test_ext().execute_with(|| {
        register(ALICE, 1_000); // Rank 0/1 only — below FullFloorStake
                                // () mock returns rank=0 always, so should fail rank gate
                                // Actually () returns Some(0) so rank < 2 → AgentMustBeRank2
        assert_noop!(
            Orchestrator::register_orchestrator(RuntimeOrigin::signed(ALICE), 10, 200),
            Error::<Test>::AgentMustBeRank2
        );
    });
}

#[test]
fn register_orchestrator_with_full_stake_succeeds() {
    new_test_ext().execute_with(|| {
        // With () AgentCollective, rank_of always returns 0.
        // For this test, we check that fee_bps > max fails correctly.
        register(ALICE, 10_000);
        assert_noop!(
            Orchestrator::register_orchestrator(RuntimeOrigin::signed(ALICE), 10, 600),
            Error::<Test>::FeeTooHigh // 600 > MaxOrchestratorFeeBps(500)
        );
    });
}

#[test]
fn propose_and_accept_link_works() {
    new_test_ext().execute_with(|| {
        // Manually insert orchestrator registration (bypassing rank check for test)
        OrchestratorRegistration::<Test>::insert(
            ALICE,
            OrchestratorRecord {
                max_sub_agents: 10,
                fee_bps: 200,
                registered_at: 0,
                active_sub_count: 0,
            },
        );
        register(BOB, 1_000);

        // Propose link
        assert_ok!(Orchestrator::propose_sub_agent_link(
            RuntimeOrigin::signed(ALICE),
            BOB
        ));
        assert!(PendingLinkProposals::<Test>::contains_key(ALICE, BOB));

        // Accept link
        assert_ok!(Orchestrator::accept_orchestrator_link(
            RuntimeOrigin::signed(BOB),
            ALICE
        ));
        assert!(SubAgentLinks::<Test>::contains_key(ALICE, BOB));
        assert_eq!(SubAgentToOrchestrator::<Test>::get(BOB), Some(ALICE));
        // Sub count incremented
        assert_eq!(
            OrchestratorRegistration::<Test>::get(ALICE)
                .unwrap()
                .active_sub_count,
            1
        );
    });
}

#[test]
fn accept_link_fails_after_expiry() {
    new_test_ext().execute_with(|| {
        OrchestratorRegistration::<Test>::insert(
            ALICE,
            OrchestratorRecord {
                max_sub_agents: 10,
                fee_bps: 200,
                registered_at: 0,
                active_sub_count: 0,
            },
        );
        register(BOB, 1_000);
        assert_ok!(Orchestrator::propose_sub_agent_link(
            RuntimeOrigin::signed(ALICE),
            BOB
        ));

        // Advance past LinkApprovalWindow (100 blocks)
        frame_system::Pallet::<Test>::set_block_number(150);
        assert_noop!(
            Orchestrator::accept_orchestrator_link(RuntimeOrigin::signed(BOB), ALICE),
            Error::<Test>::ProposalExpired
        );
    });
}

#[test]
fn sub_agent_cannot_link_to_two_orchestrators() {
    new_test_ext().execute_with(|| {
        OrchestratorRegistration::<Test>::insert(
            ALICE,
            OrchestratorRecord {
                max_sub_agents: 10,
                fee_bps: 200,
                registered_at: 0,
                active_sub_count: 0,
            },
        );
        OrchestratorRegistration::<Test>::insert(
            CAROL,
            OrchestratorRecord {
                max_sub_agents: 10,
                fee_bps: 100,
                registered_at: 0,
                active_sub_count: 0,
            },
        );
        register(BOB, 1_000);

        // Link to ALICE
        assert_ok!(Orchestrator::propose_sub_agent_link(
            RuntimeOrigin::signed(ALICE),
            BOB
        ));
        assert_ok!(Orchestrator::accept_orchestrator_link(
            RuntimeOrigin::signed(BOB),
            ALICE
        ));

        // Propose from CAROL
        assert_ok!(Orchestrator::propose_sub_agent_link(
            RuntimeOrigin::signed(CAROL),
            BOB
        ));
        // BOB tries to accept CAROL — but already linked to ALICE
        assert_noop!(
            Orchestrator::accept_orchestrator_link(RuntimeOrigin::signed(BOB), CAROL),
            Error::<Test>::AlreadyLinked
        );
    });
}

#[test]
fn remove_link_by_sub_agent_works() {
    new_test_ext().execute_with(|| {
        OrchestratorRegistration::<Test>::insert(
            ALICE,
            OrchestratorRecord {
                max_sub_agents: 10,
                fee_bps: 200,
                registered_at: 0,
                active_sub_count: 1,
            },
        );
        register(BOB, 1_000);
        SubAgentLinks::<Test>::insert(
            ALICE,
            BOB,
            SubLinkRecord {
                linked_at: 0,
                lifetime_volume: 0,
            },
        );
        SubAgentToOrchestrator::<Test>::insert(BOB, ALICE);

        // BOB removes the link (passing orchestrator as the 'other' party)
        assert_ok!(Orchestrator::remove_sub_agent_link(
            RuntimeOrigin::signed(BOB),
            ALICE
        ));
        assert!(!SubAgentLinks::<Test>::contains_key(ALICE, BOB));
        assert!(SubAgentToOrchestrator::<Test>::get(BOB).is_none());
        assert_eq!(
            OrchestratorRegistration::<Test>::get(ALICE)
                .unwrap()
                .active_sub_count,
            0
        );
    });
}

#[test]
fn deregister_clears_all_links() {
    new_test_ext().execute_with(|| {
        OrchestratorRegistration::<Test>::insert(
            ALICE,
            OrchestratorRecord {
                max_sub_agents: 10,
                fee_bps: 200,
                registered_at: 0,
                active_sub_count: 2,
            },
        );
        register(BOB, 1_000);
        register(CAROL, 1_000);
        SubAgentLinks::<Test>::insert(
            ALICE,
            BOB,
            SubLinkRecord {
                linked_at: 0,
                lifetime_volume: 0,
            },
        );
        SubAgentLinks::<Test>::insert(
            ALICE,
            CAROL,
            SubLinkRecord {
                linked_at: 0,
                lifetime_volume: 0,
            },
        );
        SubAgentToOrchestrator::<Test>::insert(BOB, ALICE);
        SubAgentToOrchestrator::<Test>::insert(CAROL, ALICE);

        assert_ok!(Orchestrator::deregister_orchestrator(
            RuntimeOrigin::signed(ALICE)
        ));
        assert!(!OrchestratorRegistration::<Test>::contains_key(ALICE));
        assert!(!SubAgentLinks::<Test>::contains_key(ALICE, BOB));
        assert!(!SubAgentLinks::<Test>::contains_key(ALICE, CAROL));
        assert!(SubAgentToOrchestrator::<Test>::get(BOB).is_none());
        assert!(SubAgentToOrchestrator::<Test>::get(CAROL).is_none());
    });
}

#[test]
fn volume_accumulation_works() {
    new_test_ext().execute_with(|| {
        OrchestratorRegistration::<Test>::insert(
            ALICE,
            OrchestratorRecord {
                max_sub_agents: 10,
                fee_bps: 200,
                registered_at: 0,
                active_sub_count: 1,
            },
        );
        Orchestrator::add_orchestrator_volume(&ALICE, 5_000u64);
        assert_eq!(EraOrchestratorVolume::<Test>::get(ALICE), 5_000u64);

        Orchestrator::add_orchestrator_volume(&ALICE, 3_000u64);
        assert_eq!(EraOrchestratorVolume::<Test>::get(ALICE), 8_000u64);
    });
}

// ─── ROUND9: permissive propose + the safety kit ──────────────────────────────

/// Register `who` as an orchestrator by writing the record directly, matching
/// the pattern the tests above use to bypass the rank-2 gate (the `()`
/// AgentCollective mock always reports rank 0, so register_orchestrator can
/// never succeed here).
fn orchestrator(who: u64) {
    OrchestratorRegistration::<Test>::insert(
        who,
        OrchestratorRecord {
            max_sub_agents: 50,
            fee_bps: 100,
            registered_at: 0,
            active_sub_count: 0,
        },
    );
}

/// Make `who` pass `is_agent` without going through `register`, which would
/// need an endowed balance. `is_agent` reads exactly this map.
fn seed_agent(who: u64) {
    pallet_agents::AgentStake::<Test>::insert(who, 1_000u64);
}

#[test]
fn pending_proposal_cap_is_enforced_per_sub_agent() {
    new_test_ext().execute_with(|| {
        register(BOB, 1_000);
        let cap: u32 = <Test as Config>::MaxPendingProposals::get();
        assert_eq!(cap, 20);

        // 20 distinct orchestrators each queue one offer against BOB.
        for (i, orch) in (100..100 + cap as u64).enumerate() {
            orchestrator(orch);
            assert_ok!(Orchestrator::propose_sub_agent_link(
                RuntimeOrigin::signed(orch),
                BOB
            ));
            assert_eq!(PendingProposalCount::<Test>::get(BOB), i as u32 + 1);
        }
        assert_eq!(PendingProposalCount::<Test>::get(BOB), cap);

        // The 21st is refused — this is the bound that makes permissive propose safe.
        let extra = 100 + cap as u64;
        orchestrator(extra);
        assert_noop!(
            Orchestrator::propose_sub_agent_link(RuntimeOrigin::signed(extra), BOB),
            Error::<Test>::TooManyPendingProposals
        );
        assert_eq!(PendingProposalCount::<Test>::get(BOB), cap);

        // BOB reclaims a slot, and the 21st now fits. A cap without this is a
        // permanent lockout, not a fix.
        assert_ok!(Orchestrator::decline_link_proposal(
            RuntimeOrigin::signed(BOB),
            100
        ));
        assert_eq!(PendingProposalCount::<Test>::get(BOB), cap - 1);
        assert!(!PendingLinkProposals::<Test>::contains_key(100, BOB));

        assert_ok!(Orchestrator::propose_sub_agent_link(
            RuntimeOrigin::signed(extra),
            BOB
        ));
        assert_eq!(PendingProposalCount::<Test>::get(BOB), cap);
    });
}

#[test]
fn reproposing_same_pair_refreshes_without_consuming_a_second_slot() {
    new_test_ext().execute_with(|| {
        register(BOB, 1_000);
        orchestrator(ALICE);

        assert_ok!(Orchestrator::propose_sub_agent_link(
            RuntimeOrigin::signed(ALICE),
            BOB
        ));
        assert_eq!(PendingProposalCount::<Test>::get(BOB), 1);
        let first_expiry = PendingLinkProposals::<Test>::get(ALICE, BOB).unwrap();

        // Same pair again: overwrites one key, so the count must not move.
        frame_system::Pallet::<Test>::set_block_number(10);
        assert_ok!(Orchestrator::propose_sub_agent_link(
            RuntimeOrigin::signed(ALICE),
            BOB
        ));
        assert_eq!(PendingProposalCount::<Test>::get(BOB), 1);
        assert!(PendingLinkProposals::<Test>::get(ALICE, BOB).unwrap() > first_expiry);
    });
}

#[test]
fn decline_and_cancel_drain_expired_entries_and_decrement() {
    new_test_ext().execute_with(|| {
        register(BOB, 1_000);
        orchestrator(ALICE);
        orchestrator(CAROL);

        assert_ok!(Orchestrator::propose_sub_agent_link(
            RuntimeOrigin::signed(ALICE),
            BOB
        ));
        assert_ok!(Orchestrator::propose_sub_agent_link(
            RuntimeOrigin::signed(CAROL),
            BOB
        ));
        assert_eq!(PendingProposalCount::<Test>::get(BOB), 2);

        // Past LinkApprovalWindow (100): both entries are now expired. Nothing
        // reaps them, so if the drains refused expired rows these slots would be
        // wedged forever — which is exactly what the cap must not allow.
        frame_system::Pallet::<Test>::set_block_number(500);

        // Sub-agent declines an EXPIRED offer.
        assert_ok!(Orchestrator::decline_link_proposal(
            RuntimeOrigin::signed(BOB),
            ALICE
        ));
        assert_eq!(PendingProposalCount::<Test>::get(BOB), 1);
        assert!(!PendingLinkProposals::<Test>::contains_key(ALICE, BOB));

        // Orchestrator cancels its own EXPIRED offer.
        assert_ok!(Orchestrator::cancel_link_proposal(
            RuntimeOrigin::signed(CAROL),
            BOB
        ));
        assert_eq!(PendingProposalCount::<Test>::get(BOB), 0);
        assert!(!PendingLinkProposals::<Test>::contains_key(CAROL, BOB));

        // Neither drain invents work when there is nothing to remove.
        assert_noop!(
            Orchestrator::decline_link_proposal(RuntimeOrigin::signed(BOB), ALICE),
            Error::<Test>::ProposalNotFound
        );
        assert_noop!(
            Orchestrator::cancel_link_proposal(RuntimeOrigin::signed(CAROL), BOB),
            Error::<Test>::ProposalNotFound
        );
        assert_eq!(PendingProposalCount::<Test>::get(BOB), 0);
    });
}

#[test]
fn succession_flow_queued_offer_taken_up_after_link_ends() {
    new_test_ext().execute_with(|| {
        register(BOB, 1_000);
        orchestrator(ALICE);
        orchestrator(CAROL);

        // BOB links to ALICE.
        assert_ok!(Orchestrator::propose_sub_agent_link(
            RuntimeOrigin::signed(ALICE),
            BOB
        ));
        assert_ok!(Orchestrator::accept_orchestrator_link(
            RuntimeOrigin::signed(BOB),
            ALICE
        ));
        assert_eq!(SubAgentToOrchestrator::<Test>::get(BOB), Some(ALICE));
        // Accepting consumed the slot.
        assert_eq!(PendingProposalCount::<Test>::get(BOB), 0);

        // CAROL queues an offer against an ALREADY-LINKED sub-agent. This is the
        // permissive behaviour ROUND9 shipped; before it, this call failed.
        assert_ok!(Orchestrator::propose_sub_agent_link(
            RuntimeOrigin::signed(CAROL),
            BOB
        ));
        assert_eq!(PendingProposalCount::<Test>::get(BOB), 1);

        // The offer confers nothing while the existing link stands.
        assert_noop!(
            Orchestrator::accept_orchestrator_link(RuntimeOrigin::signed(BOB), CAROL),
            Error::<Test>::AlreadyLinked
        );
        assert_eq!(SubAgentToOrchestrator::<Test>::get(BOB), Some(ALICE));

        // The link ends...
        assert_ok!(Orchestrator::remove_sub_agent_link(
            RuntimeOrigin::signed(BOB),
            ALICE
        ));
        assert_eq!(SubAgentToOrchestrator::<Test>::get(BOB), None);

        // ...and the queued offer can now be taken up. This is the whole point
        // of permissive propose.
        assert_ok!(Orchestrator::accept_orchestrator_link(
            RuntimeOrigin::signed(BOB),
            CAROL
        ));
        assert_eq!(SubAgentToOrchestrator::<Test>::get(BOB), Some(CAROL));
        assert_eq!(PendingProposalCount::<Test>::get(BOB), 0);
    });
}

#[test]
fn deregister_drains_every_proposal_past_the_old_1000_cap() {
    new_test_ext().execute_with(|| {
        // 1,001 targets: one more than the old clear_prefix(.., 1000, ..) limit,
        // which used to leave the remainder orphaned in storage forever.
        const N: u64 = 1_001;
        orchestrator(ALICE);
        for sub in 10_000..10_000 + N {
            seed_agent(sub);
            assert_ok!(Orchestrator::propose_sub_agent_link(
                RuntimeOrigin::signed(ALICE),
                sub
            ));
        }

        assert_eq!(
            PendingLinkProposals::<Test>::iter_prefix(ALICE).count() as u64,
            N
        );
        for sub in 10_000..10_000 + N {
            assert_eq!(PendingProposalCount::<Test>::get(sub), 1);
        }

        assert_ok!(Orchestrator::deregister_orchestrator(
            RuntimeOrigin::signed(ALICE)
        ));

        // ZERO entries left — not 1, not the 1 that used to survive.
        assert_eq!(PendingLinkProposals::<Test>::iter_prefix(ALICE).count(), 0);
        assert_eq!(PendingLinkProposals::<Test>::iter().count(), 0);
        // ...and every sub-agent got their slot back.
        for sub in 10_000..10_000 + N {
            assert_eq!(PendingProposalCount::<Test>::get(sub), 0);
        }
    });
}

#[test]
fn register_orchestrator_rejects_max_sub_agents_above_the_constant() {
    new_test_ext().execute_with(|| {
        register(ALICE, 10_000);
        let cap: u32 = <Test as Config>::MaxSubAgentsPerOrchestrator::get();
        assert_eq!(cap, 50);

        assert_noop!(
            Orchestrator::register_orchestrator(RuntimeOrigin::signed(ALICE), cap + 1, 100),
            Error::<Test>::MaxSubAgentsTooHigh
        );

        // Exactly at the cap passes this gate — it gets as far as the rank check,
        // which the () AgentCollective mock (rank 0) is what stops it. That the
        // error changes proves the cap accepted `cap` and rejected `cap + 1`.
        assert_noop!(
            Orchestrator::register_orchestrator(RuntimeOrigin::signed(ALICE), cap, 100),
            Error::<Test>::AgentMustBeRank2
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

// ---------------------------------------------------------------------------
// #184 — finding-encoding suite. These assert on the ledger (events + storage),
// never on a dispatch's return value alone.
// ---------------------------------------------------------------------------

std::thread_local! {
    static RANKS: core::cell::RefCell<std::collections::BTreeMap<u64, u32>> =
        const { core::cell::RefCell::new(std::collections::BTreeMap::new()) };
}

/// Rank-aware stand-in for `pallet_ranked_collective`: unlisted accounts are
/// Rank 0, exactly as the `()` collective reported before, so every earlier
/// test is unaffected. Lets the Rank-2 gate (E11) be tested on both sides.
pub struct MockCollective;
impl pallet_agents::pallet::AgentCollective<u64> for MockCollective {
    fn induct(_: &u64) -> frame_support::dispatch::DispatchResult {
        Ok(())
    }
    fn promote(_: &u64) -> frame_support::dispatch::DispatchResult {
        Ok(())
    }
    fn rank_of(who: &u64) -> Option<u32> {
        Some(RANKS.with(|r| r.borrow().get(who).copied().unwrap_or(0)))
    }
    fn remove(_: &u64) {}
}

fn set_rank(who: u64, rank: u32) {
    RANKS.with(|r| {
        r.borrow_mut().insert(who, rank);
    });
}

/// Events are only recorded from block 1.
fn start_block() {
    System::set_block_number(1);
    System::reset_events();
}

fn orch_events() -> Vec<Event<Test>> {
    System::events()
        .into_iter()
        .filter_map(|r| match r.event {
            RuntimeEvent::Orchestrator(e) => Some(e),
            _ => None,
        })
        .collect()
}

/// Propose then accept, asserting nothing — callers assert on the ledger.
fn link(orch: u64, sub: u64) {
    assert_ok!(Orchestrator::propose_sub_agent_link(
        RuntimeOrigin::signed(orch),
        sub
    ));
    assert_ok!(Orchestrator::accept_orchestrator_link(
        RuntimeOrigin::signed(sub),
        orch
    ));
}

#[test]
fn self_link_is_rejected_and_leaves_no_trace() {
    new_test_ext().execute_with(|| {
        start_block();
        seed_agent(ALICE);
        orchestrator(ALICE);

        assert_noop!(
            Orchestrator::propose_sub_agent_link(RuntimeOrigin::signed(ALICE), ALICE),
            Error::<Test>::SelfLink
        );

        assert!(!PendingLinkProposals::<Test>::contains_key(ALICE, ALICE));
        assert_eq!(PendingProposalCount::<Test>::get(ALICE), 0);
        assert!(!SubAgentLinks::<Test>::contains_key(ALICE, ALICE));
        assert!(SubAgentToOrchestrator::<Test>::get(ALICE).is_none());
        assert!(orch_events().is_empty());
    });
}

#[test]
fn rank_below_two_cannot_register_orchestrator() {
    new_test_ext().execute_with(|| {
        start_block();
        seed_agent(ALICE);
        for rank in [0, 1] {
            set_rank(ALICE, rank);
            assert_noop!(
                Orchestrator::register_orchestrator(RuntimeOrigin::signed(ALICE), 10, 200),
                Error::<Test>::AgentMustBeRank2
            );
            assert!(OrchestratorRegistration::<Test>::get(ALICE).is_none());
        }
        assert!(orch_events().is_empty());
    });
}

#[test]
fn rank_two_and_above_register_orchestrator_with_event_and_record() {
    new_test_ext().execute_with(|| {
        start_block();
        seed_agent(ALICE);
        seed_agent(CAROL);
        set_rank(ALICE, 2);
        set_rank(CAROL, 3);

        assert_ok!(Orchestrator::register_orchestrator(
            RuntimeOrigin::signed(ALICE),
            10,
            200
        ));
        assert_ok!(Orchestrator::register_orchestrator(
            RuntimeOrigin::signed(CAROL),
            50,
            500
        ));

        let rec = OrchestratorRegistration::<Test>::get(ALICE).expect("record written");
        assert_eq!(rec.max_sub_agents, 10);
        assert_eq!(rec.fee_bps, 200);
        assert_eq!(rec.registered_at, 1);
        assert_eq!(rec.active_sub_count, 0);
        // Boundary values of both caps are accepted.
        let rec = OrchestratorRegistration::<Test>::get(CAROL).expect("record written");
        assert_eq!((rec.max_sub_agents, rec.fee_bps), (50, 500));

        assert_eq!(
            orch_events(),
            vec![
                Event::OrchestratorRegistered {
                    who: ALICE,
                    max_sub_agents: 10,
                    fee_bps: 200
                },
                Event::OrchestratorRegistered {
                    who: CAROL,
                    max_sub_agents: 50,
                    fee_bps: 500
                },
            ]
        );
    });
}

#[test]
fn registration_is_rejected_twice_and_for_non_agents() {
    new_test_ext().execute_with(|| {
        start_block();
        // Rank alone is not enough: BOB never registered as an agent.
        set_rank(BOB, 2);
        assert_noop!(
            Orchestrator::register_orchestrator(RuntimeOrigin::signed(BOB), 10, 100),
            Error::<Test>::NotAnAgent
        );
        assert!(OrchestratorRegistration::<Test>::get(BOB).is_none());

        seed_agent(ALICE);
        set_rank(ALICE, 2);
        assert_ok!(Orchestrator::register_orchestrator(
            RuntimeOrigin::signed(ALICE),
            10,
            100
        ));
        System::reset_events();
        assert_noop!(
            Orchestrator::register_orchestrator(RuntimeOrigin::signed(ALICE), 20, 300),
            Error::<Test>::AlreadyRegistered
        );
        // The original record is untouched by the rejected second attempt.
        let rec = OrchestratorRegistration::<Test>::get(ALICE).unwrap();
        assert_eq!((rec.max_sub_agents, rec.fee_bps), (10, 100));
        assert!(orch_events().is_empty());
    });
}

#[test]
fn propose_accept_emits_events_and_writes_both_link_maps() {
    new_test_ext().execute_with(|| {
        start_block();
        seed_agent(ALICE);
        seed_agent(BOB);
        set_rank(ALICE, 2);
        assert_ok!(Orchestrator::register_orchestrator(
            RuntimeOrigin::signed(ALICE),
            10,
            200
        ));
        System::reset_events();

        assert_ok!(Orchestrator::propose_sub_agent_link(
            RuntimeOrigin::signed(ALICE),
            BOB
        ));
        // start_block = 1, LinkApprovalWindow = 100.
        assert_eq!(PendingLinkProposals::<Test>::get(ALICE, BOB), Some(101));
        assert_eq!(PendingProposalCount::<Test>::get(BOB), 1);
        assert!(SubAgentToOrchestrator::<Test>::get(BOB).is_none());

        System::set_block_number(5);
        assert_ok!(Orchestrator::accept_orchestrator_link(
            RuntimeOrigin::signed(BOB),
            ALICE
        ));

        assert!(PendingLinkProposals::<Test>::get(ALICE, BOB).is_none());
        assert_eq!(PendingProposalCount::<Test>::get(BOB), 0);
        assert_eq!(SubAgentToOrchestrator::<Test>::get(BOB), Some(ALICE));
        let link = SubAgentLinks::<Test>::get(ALICE, BOB).expect("link written");
        assert_eq!(link.linked_at, 5);
        assert_eq!(link.lifetime_volume, 0);
        assert_eq!(
            OrchestratorRegistration::<Test>::get(ALICE)
                .unwrap()
                .active_sub_count,
            1
        );
        assert_eq!(
            orch_events(),
            vec![
                Event::LinkProposed {
                    orchestrator: ALICE,
                    sub_agent: BOB,
                    expires_at: 101
                },
                Event::LinkAccepted {
                    orchestrator: ALICE,
                    sub_agent: BOB
                },
            ]
        );
    });
}

#[test]
fn accept_without_proposal_is_rejected_and_writes_nothing() {
    new_test_ext().execute_with(|| {
        start_block();
        seed_agent(BOB);
        orchestrator(ALICE);
        assert_noop!(
            Orchestrator::accept_orchestrator_link(RuntimeOrigin::signed(BOB), ALICE),
            Error::<Test>::ProposalNotFound
        );
        assert!(SubAgentToOrchestrator::<Test>::get(BOB).is_none());
        assert_eq!(
            OrchestratorRegistration::<Test>::get(ALICE)
                .unwrap()
                .active_sub_count,
            0
        );
        assert!(orch_events().is_empty());
    });
}

#[test]
fn propose_requires_registered_orchestrator_and_agent_target() {
    new_test_ext().execute_with(|| {
        start_block();
        seed_agent(BOB);
        // ALICE is not an orchestrator.
        assert_noop!(
            Orchestrator::propose_sub_agent_link(RuntimeOrigin::signed(ALICE), BOB),
            Error::<Test>::NotRegistered
        );
        orchestrator(ALICE);
        // CAROL is not a registered agent.
        assert_noop!(
            Orchestrator::propose_sub_agent_link(RuntimeOrigin::signed(ALICE), CAROL),
            Error::<Test>::NotAnAgent
        );
        assert!(!PendingLinkProposals::<Test>::contains_key(ALICE, CAROL));
        assert_eq!(PendingProposalCount::<Test>::get(CAROL), 0);
        assert!(orch_events().is_empty());
    });
}

#[test]
fn orchestrator_removes_link_and_event_names_the_caller() {
    new_test_ext().execute_with(|| {
        start_block();
        seed_agent(BOB);
        orchestrator(ALICE);
        link(ALICE, BOB);
        System::reset_events();

        assert_ok!(Orchestrator::remove_sub_agent_link(
            RuntimeOrigin::signed(ALICE),
            BOB
        ));

        assert!(!SubAgentLinks::<Test>::contains_key(ALICE, BOB));
        assert!(SubAgentToOrchestrator::<Test>::get(BOB).is_none());
        assert_eq!(
            OrchestratorRegistration::<Test>::get(ALICE)
                .unwrap()
                .active_sub_count,
            0
        );
        assert_eq!(
            orch_events(),
            vec![Event::LinkRemoved {
                orchestrator: ALICE,
                sub_agent: BOB,
                by: ALICE
            }]
        );
    });
}

#[test]
fn sub_agent_removal_event_names_the_sub_agent_as_caller() {
    new_test_ext().execute_with(|| {
        start_block();
        seed_agent(BOB);
        orchestrator(ALICE);
        link(ALICE, BOB);
        System::reset_events();

        assert_ok!(Orchestrator::remove_sub_agent_link(
            RuntimeOrigin::signed(BOB),
            ALICE
        ));
        assert!(SubAgentToOrchestrator::<Test>::get(BOB).is_none());
        assert_eq!(
            orch_events(),
            vec![Event::LinkRemoved {
                orchestrator: ALICE,
                sub_agent: BOB,
                by: BOB
            }]
        );
    });
}

#[test]
fn third_party_cannot_remove_a_link() {
    new_test_ext().execute_with(|| {
        start_block();
        seed_agent(BOB);
        orchestrator(ALICE);
        link(ALICE, BOB);
        System::reset_events();

        // CAROL is neither an orchestrator nor a linked sub-agent.
        assert_noop!(
            Orchestrator::remove_sub_agent_link(RuntimeOrigin::signed(CAROL), BOB),
            Error::<Test>::NotOrchestratorOrSubAgent
        );
        // A sub-agent naming the wrong orchestrator is refused too.
        assert_noop!(
            Orchestrator::remove_sub_agent_link(RuntimeOrigin::signed(BOB), CAROL),
            Error::<Test>::NotLinked
        );
        // Another orchestrator cannot cut ALICE's link.
        orchestrator(CAROL);
        assert_noop!(
            Orchestrator::remove_sub_agent_link(RuntimeOrigin::signed(CAROL), BOB),
            Error::<Test>::NotLinked
        );

        assert_eq!(SubAgentToOrchestrator::<Test>::get(BOB), Some(ALICE));
        assert!(SubAgentLinks::<Test>::contains_key(ALICE, BOB));
        assert_eq!(
            OrchestratorRegistration::<Test>::get(ALICE)
                .unwrap()
                .active_sub_count,
            1
        );
        assert!(orch_events().is_empty());
    });
}

/// Sub-agent accounts for the cap tests, clear of ALICE/BOB/CAROL.
const SUB_BASE: u64 = 100;

#[test]
fn registering_above_the_50_sub_agent_cap_is_rejected() {
    new_test_ext().execute_with(|| {
        start_block();
        seed_agent(ALICE);
        set_rank(ALICE, 2);
        assert_noop!(
            Orchestrator::register_orchestrator(RuntimeOrigin::signed(ALICE), 51, 100),
            Error::<Test>::MaxSubAgentsTooHigh
        );
        assert!(OrchestratorRegistration::<Test>::get(ALICE).is_none());
        assert!(orch_events().is_empty());
    });
}

#[test]
fn fifty_sub_agents_link_and_the_fifty_first_offer_is_refused() {
    new_test_ext().execute_with(|| {
        start_block();
        seed_agent(ALICE);
        set_rank(ALICE, 2);
        assert_ok!(Orchestrator::register_orchestrator(
            RuntimeOrigin::signed(ALICE),
            50,
            100
        ));
        for i in 0..50 {
            seed_agent(SUB_BASE + i);
            link(ALICE, SUB_BASE + i);
        }
        let rec = OrchestratorRegistration::<Test>::get(ALICE).unwrap();
        assert_eq!(rec.active_sub_count, 50);
        assert_eq!(
            SubAgentLinks::<Test>::iter_prefix(ALICE).count(),
            50,
            "one link row per sub-agent"
        );
        System::reset_events();

        let extra = SUB_BASE + 50;
        seed_agent(extra);
        assert_noop!(
            Orchestrator::propose_sub_agent_link(RuntimeOrigin::signed(ALICE), extra),
            Error::<Test>::SubAgentCapFull
        );
        assert!(!PendingLinkProposals::<Test>::contains_key(ALICE, extra));
        assert_eq!(PendingProposalCount::<Test>::get(extra), 0);
        assert!(orch_events().is_empty());

        // Removing one link frees exactly one slot.
        assert_ok!(Orchestrator::remove_sub_agent_link(
            RuntimeOrigin::signed(ALICE),
            SUB_BASE
        ));
        assert_eq!(
            OrchestratorRegistration::<Test>::get(ALICE)
                .unwrap()
                .active_sub_count,
            49
        );
        link(ALICE, extra);
        assert_eq!(
            OrchestratorRegistration::<Test>::get(ALICE)
                .unwrap()
                .active_sub_count,
            50
        );
    });
}

/// The cap is only checked in `propose_sub_agent_link`, against the count at
/// *proposal* time. Offers are permissive and queue up while `active_sub_count`
/// is still low, so an orchestrator with `max_sub_agents = 2` can propose to
/// three agents while empty and have all three accept. `accept_orchestrator_link`
/// increments `active_sub_count` without re-checking it.
#[test]
#[ignore = "bug: accept_orchestrator_link does not re-check max_sub_agents, so queued offers overshoot the cap, see #203"]
fn queued_offers_cannot_overshoot_max_sub_agents_on_accept() {
    new_test_ext().execute_with(|| {
        start_block();
        orchestrator(ALICE);
        OrchestratorRegistration::<Test>::mutate(ALICE, |r| r.as_mut().unwrap().max_sub_agents = 2);
        for i in 0..3 {
            seed_agent(SUB_BASE + i);
            assert_ok!(Orchestrator::propose_sub_agent_link(
                RuntimeOrigin::signed(ALICE),
                SUB_BASE + i
            ));
        }
        let mut accepted = 0;
        for i in 0..3 {
            if Orchestrator::accept_orchestrator_link(RuntimeOrigin::signed(SUB_BASE + i), ALICE)
                .is_ok()
            {
                accepted += 1;
            }
        }
        let rec = OrchestratorRegistration::<Test>::get(ALICE).unwrap();
        assert!(
            rec.active_sub_count <= rec.max_sub_agents,
            "active_sub_count {} exceeds max_sub_agents {} ({} accepted)",
            rec.active_sub_count,
            rec.max_sub_agents,
            accepted
        );
        assert_eq!(
            SubAgentLinks::<Test>::iter_prefix(ALICE).count() as u32,
            rec.active_sub_count
        );
    });
}
