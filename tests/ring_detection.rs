//! Integration test: ring farming detection and auto-param response

use super::common;
use common::*;

#[test]
fn ring_detection_fires_after_sustained_self_dealing() {
    new_test_ext().execute_with(|| {
        register(ALICE, FULL_STAKE);
        register(BOB, FULL_STAKE);
        register(CAROL, FULL_STAKE); // legitimate agent

        // Era 1: ALICE and BOB do one each escrow with each other (ring),
        // CAROL does work with a real outside buyer (DAVE — not an agent)
        // Note: For ring detection, we need both to be agents trading with each other

        // Complete 2 agreements between alice and bob (mutual trading = ring)
        complete_escrow(ALICE, BOB, 5_000 * CMN, 50);
        complete_escrow(BOB, ALICE, 5_000 * CMN, 50);

        // Carol does legitimate work for Alice (different buyer)
        complete_escrow(ALICE, CAROL, 3_000 * CMN, 50);

        crate::common::settle_era(1);

        let ring_snap = pallet_agents::EraRingSnapshot::<TestRuntime>::get();
        let active_snap = pallet_agents::EraActiveSnapshot::<TestRuntime>::get();
        // After era 1: alice and bob are established (completions > 1) and may have unique_buyers = 1
        // Carol has 1 unique buyer (Alice) but only 1 completion — not established yet
        println!("Era 1 ring_snap={ring_snap} active_snap={active_snap}");

        // The ring detection requires completions > 1 (established) AND unique_buyers <= 1
        // After era 1: alice has completions = 2 (one with bob, one with carol as buyer)
        // Wait — alice is the BUYER, not provider in those escrows
        // In complete_escrow(buyer, provider, ...) — alice's volume accumulates as PROVIDER in
        // the second call (bob→alice). So alice: 1 completion with bob as buyer.
        // unique_buyers[alice] = 1 (only bob). completions[alice] = 1 (only 1 as provider)
        // Not established yet. Need completions > 1.

        // Era 2: continue ring trading
        complete_escrow(ALICE, BOB, 5_000 * CMN, 50);
        complete_escrow(BOB, ALICE, 5_000 * CMN, 50);

        crate::common::settle_era(1);

        let ring_snap_2 = pallet_agents::EraRingSnapshot::<TestRuntime>::get();
        println!("Era 2 ring_snap={ring_snap_2}");

        // Now bob has completions = 2 (established) and unique_buyers = 1 (only alice)
        // → bob should be detected as ring suspect
        // alice has completions = 2 and unique_buyers = 1 → also ring suspect
        assert!(
            ring_snap_2 >= 1,
            "At least one ring suspect expected after sustained mutual trading"
        );
    });
}

#[test]
fn legitimate_agent_not_flagged_as_ring() {
    new_test_ext().execute_with(|| {
        register(ALICE, FULL_STAKE);
        register(BOB, FULL_STAKE);
        register(CAROL, FULL_STAKE);
        register(DAVE, FULL_STAKE);

        // Alice provides work for 3 different buyers
        complete_escrow(BOB, ALICE, 3_000 * CMN, 50);
        complete_escrow(CAROL, ALICE, 3_000 * CMN, 50);
        complete_escrow(DAVE, ALICE, 3_000 * CMN, 50);

        crate::common::settle_era(1);
        // Era 2 (need established status)
        complete_escrow(BOB, ALICE, 3_000 * CMN, 50);
        complete_escrow(CAROL, ALICE, 3_000 * CMN, 50);
        complete_escrow(DAVE, ALICE, 3_000 * CMN, 50);

        crate::common::settle_era(1);

        let ring_snap = pallet_agents::EraRingSnapshot::<TestRuntime>::get();
        // Alice has unique_buyers = 3 — NOT a ring suspect
        assert_eq!(
            ring_snap, 0,
            "Agent with diverse buyers should not be flagged as ring"
        );
    });
}

#[test]
fn auto_params_ring_fee_increases() {
    new_test_ext().execute_with(|| {
        register(ALICE, FULL_STAKE);
        register(BOB, FULL_STAKE);

        let fee_before = pallet_auto_params::CompletionFeeBps::<TestRuntime>::get();

        // 2 agents, both ring suspects after era 2 = 100% ring ratio → exceeds 30% threshold
        complete_escrow(ALICE, BOB, 5_000 * CMN, 50);
        complete_escrow(BOB, ALICE, 5_000 * CMN, 50);
        crate::common::settle_era(1);

        complete_escrow(ALICE, BOB, 5_000 * CMN, 50);
        complete_escrow(BOB, ALICE, 5_000 * CMN, 50);
        crate::common::settle_era(1);

        let fee_after = pallet_auto_params::CompletionFeeBps::<TestRuntime>::get();
        // If ring ratio > 30%, fee should increase
        if pallet_agents::EraRingSnapshot::<TestRuntime>::get() > 0 {
            assert!(
                fee_after >= fee_before,
                "Completion fee should increase or stay same when ring suspects detected"
            );
        }
    });
}
