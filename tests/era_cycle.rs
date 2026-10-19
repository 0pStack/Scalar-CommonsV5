//! Integration test: full era cycle
//!
//! Flow: register agents → do escrow work → settle_era → claim emissions
//! Verifies the complete cross-pallet pipeline from work to reward.

use super::common;
use common::*;
use frame_support::{assert_noop, assert_ok};

#[test]
fn era_cycle_full() {
    new_test_ext().execute_with(|| {
        // ── Setup: 3 agents with distinct stakes ──────────────────────────────
        register(ALICE, FULL_STAKE);
        register(BOB, FULL_STAKE);
        register(CAROL, MIN_STAKE);

        // ── Work: Alice and Bob each complete 2 escrows with different buyers ─
        complete_escrow(BOB, ALICE, 5_000 * CMN, 100);
        complete_escrow(CAROL, ALICE, 3_000 * CMN, 100);
        complete_escrow(ALICE, BOB, 4_000 * CMN, 100);
        complete_escrow(CAROL, BOB, 2_000 * CMN, 100);

        // Pre-settlement state
        let alice_vol = pallet_agents::EraEscrowVolume::<TestRuntime>::get(ALICE);
        let bob_vol = pallet_agents::EraEscrowVolume::<TestRuntime>::get(BOB);
        assert!(alice_vol > 0, "Alice should have era volume");
        assert!(bob_vol > 0, "Bob should have era volume");

        // Debt should be initialized from registration (no back-claiming)
        let alice_debt = pallet_emissions::AgentRewardDebt::<TestRuntime>::get(ALICE);
        let acc_before = pallet_emissions::AccRewardPerStake::<TestRuntime>::get();
        assert_eq!(
            alice_debt, acc_before,
            "Debt should equal acc at registration time"
        );

        // ── Settle era ────────────────────────────────────────────────────────
        let era_before = pallet_agents::EraNumber::<TestRuntime>::get();
        crate::common::settle_era(1);

        let era_after = pallet_agents::EraNumber::<TestRuntime>::get();
        assert_eq!(era_after, era_before + 1, "Era number should increment");

        let last_emission = pallet_emissions::LastEraEmission::<TestRuntime>::get();
        assert!(last_emission > 0, "Era emission should be non-zero");

        let acc_after = pallet_emissions::AccRewardPerStake::<TestRuntime>::get();
        assert!(acc_after > acc_before, "AccRewardPerStake must increase");

        // ── Per-era storage drained ───────────────────────────────────────────
        let alice_vol_post = pallet_agents::EraEscrowVolume::<TestRuntime>::get(ALICE);
        assert_eq!(
            alice_vol_post, 0,
            "EraEscrowVolume should be cleared after drain"
        );

        // ── Claim emissions ───────────────────────────────────────────────────
        let alice_bal_before = pallet_balances::Pallet::<TestRuntime>::free_balance(ALICE);
        assert_ok!(pallet_emissions::Pallet::<TestRuntime>::claim(
            RuntimeOrigin::signed(ALICE)
        ));
        let alice_bal_after = pallet_balances::Pallet::<TestRuntime>::free_balance(ALICE);
        assert!(
            alice_bal_after > alice_bal_before,
            "Alice should receive emissions"
        );

        // Carol only acted as buyer (not provider), so she has 0 volume/weight.
        // She may earn 0 or NothingToClaim. Alice (who provided) should earn > 0.
        let alice_earned = alice_bal_after - alice_bal_before;
        assert!(alice_earned > 0, "Alice (provider) should earn emissions");

        // Carol (buyer only, no provider volume) earns nothing
        let carol_claim =
            pallet_emissions::Pallet::<TestRuntime>::claim(RuntimeOrigin::signed(CAROL));
        assert!(
            carol_claim.is_err(),
            "Carol (no provider volume) should have nothing to claim"
        );

        // Debt updated — second claim in same era yields 0
        assert_noop!(
            pallet_emissions::Pallet::<TestRuntime>::claim(RuntimeOrigin::signed(ALICE)),
            pallet_emissions::Error::<TestRuntime>::NothingToClaim
        );
    });
}

#[test]
fn multiple_era_accumulation() {
    new_test_ext().execute_with(|| {
        register(ALICE, FULL_STAKE);
        register(BOB, FULL_STAKE);

        // Era 1: Alice works
        complete_escrow(BOB, ALICE, 5_000 * CMN, 50);
        crate::common::settle_era(1);

        // Don't claim yet — let emissions accumulate across eras

        // Era 2: Alice works more
        complete_escrow(BOB, ALICE, 5_000 * CMN, 50);
        crate::common::settle_era(1);

        // Era 3: Alice works again
        complete_escrow(BOB, ALICE, 5_000 * CMN, 50);
        crate::common::settle_era(1);

        // Claim once after 3 eras — should get aggregate of all 3
        let bal_before = pallet_balances::Pallet::<TestRuntime>::free_balance(ALICE);
        assert_ok!(pallet_emissions::Pallet::<TestRuntime>::claim(
            RuntimeOrigin::signed(ALICE)
        ));
        let earned = pallet_balances::Pallet::<TestRuntime>::free_balance(ALICE) - bal_before;
        assert!(earned > 0, "Should earn across 3 eras");
    });
}
