//! Integration test: governance credit is bound to distinct LIVE referenda (ROUND14)
//!
//! The unit tests in `pallets/agents/src/tests.rs` pin the extrinsic's guards. These
//! tests carry the claim through to the thing that actually pays out: the emission
//! weight snapshot written by `settle_era`. Two agents doing byte-identical work are
//! compared, so any weight difference between them is governance credit and nothing else.
//!
//! Both fail against pre-ROUND14 code, where one held vote was redeemable
//! `MaxProposalsPerEra` times an era, for ever, at zero capital cost.

use super::common;
use common::*;
use frame_support::assert_ok;

fn record_gov_vote(who: u64, poll: u32) -> frame_support::pallet_prelude::DispatchResult {
    pallet_agents::Pallet::<TestRuntime>::record_gov_vote(RuntimeOrigin::signed(who), who, poll)
}

#[test]
fn farmed_vote_loses_to_genuine_participation_in_emission_weight() {
    new_test_ext().execute_with(|| {
        register(ALICE, FULL_STAKE);
        register(BOB, FULL_STAKE);
        register(DAVE, FULL_STAKE);

        // Identical work. Same buyer, same amount, same block — the only difference
        // between Alice and Bob from here on is how they came by governance credit.
        complete_escrow(DAVE, ALICE, 5_000 * CMN, 100);
        complete_escrow(DAVE, BOB, 5_000 * CMN, 100);

        // Alice farms: one vote on one referendum, redeemed as hard as she can. Before
        // ROUND14 this banked the full per-era cap — the whole of alpha for one click.
        cast_live_vote(ALICE, 1);
        assert_ok!(record_gov_vote(ALICE, 1));
        for _ in 1..20 {
            assert!(
                record_gov_vote(ALICE, 1).is_err(),
                "the same referendum must not pay twice in one era"
            );
        }

        // Bob participates: three distinct live referenda, one credit each.
        for poll in 10..13u32 {
            cast_live_vote(BOB, poll);
            assert_ok!(record_gov_vote(BOB, poll));
        }

        assert_eq!(
            pallet_agents::EraGovParticipation::<TestRuntime>::get(ALICE),
            1,
            "20 calls off one held vote must yield exactly one credit"
        );
        assert_eq!(
            pallet_agents::EraGovParticipation::<TestRuntime>::get(BOB),
            3
        );

        settle_era(ROOT);

        let alice_w = pallet_emissions::AgentWeightSnapshot::<TestRuntime>::get(ALICE);
        let bob_w = pallet_emissions::AgentWeightSnapshot::<TestRuntime>::get(BOB);
        assert!(alice_w > 0 && bob_w > 0, "both agents did real work");
        assert!(
            bob_w > alice_w,
            "three distinct live referenda must outweigh one vote redeemed 20 times \
             (bob {bob_w} vs alice {alice_w})"
        );
    });
}

#[test]
fn a_held_vote_stops_paying_once_its_referendum_concludes() {
    new_test_ext().execute_with(|| {
        register(ALICE, FULL_STAKE);
        register(BOB, FULL_STAKE);
        register(DAVE, FULL_STAKE);

        // Era 1: Alice votes on a live referendum and is credited for it.
        complete_escrow(DAVE, ALICE, 5_000 * CMN, 100);
        complete_escrow(DAVE, BOB, 5_000 * CMN, 100);
        cast_live_vote(ALICE, 1);
        assert_ok!(record_gov_vote(ALICE, 1));
        settle_era(ROOT);

        // Referendum 1 concludes. Nothing prunes Alice's vote — on chain it stays in
        // `pallet_conviction_voting::VotingFor` until she calls `remove_vote` herself,
        // and the mock reproduces that. Pre-ROUND14 it therefore kept paying for ever.
        conclude_poll(1);

        // Era 2: identical work again, no new governance act from either agent.
        complete_escrow(DAVE, ALICE, 5_000 * CMN, 100);
        complete_escrow(DAVE, BOB, 5_000 * CMN, 100);
        assert!(
            record_gov_vote(ALICE, 1).is_err(),
            "a concluded referendum must not pay again"
        );
        assert_eq!(
            pallet_agents::EraGovParticipation::<TestRuntime>::get(ALICE),
            0
        );

        settle_era(ROOT);

        let alice_w = pallet_emissions::AgentWeightSnapshot::<TestRuntime>::get(ALICE);
        let bob_w = pallet_emissions::AgentWeightSnapshot::<TestRuntime>::get(BOB);
        assert_eq!(
            alice_w, bob_w,
            "with the referendum concluded Alice's stale vote must buy her nothing \
             over an identical agent who never voted"
        );
    });
}
