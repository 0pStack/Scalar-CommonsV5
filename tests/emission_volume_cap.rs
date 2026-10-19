//! Integration test: the D7 emission-volume bound, through the real pallets.
//!
//! The unit tests in `pallets/emissions/src/tests_issue_164.rs` exercise the rule against a
//! hand-written `AutoParamsProvider`. That is exactly the gap this file exists to close:
//! the first version of `AutoParamsProvider::emission_volume_alpha_bps` carried a default
//! of 10 000, the runtime's own `AutoParamsImpl` silently inherited it, and every unit test
//! passed while the governance lever was wired to nothing. Governance could set alpha to
//! zero, see `ParamSetByGovernance` emitted, read the new value back out of storage — and
//! settlement would go on using 1.0.
//!
//! These tests go through `pallet_auto_params::set_param` and assert on what `settle_era`
//! actually minted, so the storage-to-emission path is covered end to end.

use super::common;
use common::*;
use frame_support::assert_ok;
use pallet_auto_params::pallet::ParamId;

/// Alpha is read from storage at settlement, not baked in: setting it to zero stops
/// emission without pausing `settleEra` or `claim`, so nothing economically essential comes
/// to depend on a privileged caller (CLAUDE.md first principle #3).
#[test]
fn setting_alpha_to_zero_stops_emission_without_pausing_anything() {
    new_test_ext().execute_with(|| {
        register(ALICE, FULL_STAKE);
        register(BOB, FULL_STAKE);
        // Escrow requires BOTH sides to be registered agents (`BuyerNotAgent`), so a buyer
        // is never a free throwaway account — it costs a burned fee and locked stake.
        register(CAROL, MIN_STAKE);
        register(DAVE, MIN_STAKE);

        // Baseline era: real work, real emission. Claim it, so what the next era pays is
        // the only thing the balance check below can be measuring.
        complete_escrow(BOB, ALICE, 20 * CMN, 50);
        complete_escrow(CAROL, ALICE, 20 * CMN, 50);
        crate::common::settle_era(1);
        let baseline = pallet_emissions::LastEraEmission::<TestRuntime>::get();
        assert!(baseline > 0, "precondition: an honest era mints something");
        assert_ok!(pallet_emissions::Pallet::<TestRuntime>::claim(
            RuntimeOrigin::signed(ALICE)
        ));

        assert_ok!(pallet_auto_params::Pallet::<TestRuntime>::set_param(
            RuntimeOrigin::root(),
            ParamId::EmissionVolumeAlphaBps,
            0,
        ));
        assert_eq!(
            pallet_auto_params::EmissionVolumeAlphaBps::<TestRuntime>::get(),
            0
        );

        complete_escrow(BOB, ALICE, 20 * CMN, 50);
        complete_escrow(CAROL, ALICE, 20 * CMN, 50);
        crate::common::settle_era(1);

        assert_eq!(
            pallet_emissions::LastEraEmission::<TestRuntime>::get(),
            0,
            "alpha = 0 must actually stop emission — if this reads non-zero the governance \
             lever is writing storage that settle_era does not read"
        );

        // Settlement itself stayed permissionless and claims stayed open; there is simply
        // nothing to claim.
        let before = pallet_balances::Pallet::<TestRuntime>::free_balance(ALICE);
        let _ = pallet_emissions::Pallet::<TestRuntime>::claim(RuntimeOrigin::signed(ALICE));
        assert_eq!(
            pallet_balances::Pallet::<TestRuntime>::free_balance(ALICE),
            before
        );
    });
}

/// The bound tracks alpha in both directions, so a raise is a real decision and not a
/// no-op either.
#[test]
fn raising_alpha_raises_the_bound() {
    new_test_ext().execute_with(|| {
        register(ALICE, FULL_STAKE);
        register(BOB, FULL_STAKE);
        // Escrow requires BOTH sides to be registered agents (`BuyerNotAgent`), so a buyer
        // is never a free throwaway account — it costs a burned fee and locked stake.
        register(CAROL, MIN_STAKE);
        register(DAVE, MIN_STAKE);

        // This mock's FloorEmissionPerEra is 100 CMN and its ceiling 1,000 CMN — the
        // runtime's numbers scaled down to fit u64 — so the volume bound only bites below
        // 100 CMN of qualifying volume. Deliberately small escrows put the test in the
        // regime it is about.
        complete_escrow(BOB, ALICE, 20 * CMN, 50);
        complete_escrow(CAROL, ALICE, 20 * CMN, 50);
        crate::common::settle_era(1);
        assert_eq!(
            pallet_emissions::LastEraEmission::<TestRuntime>::get(),
            40 * CMN,
            "at alpha 1.0 the era mints exactly the qualifying volume"
        );

        assert_ok!(pallet_auto_params::Pallet::<TestRuntime>::set_param(
            RuntimeOrigin::root(),
            ParamId::EmissionVolumeAlphaBps,
            20_000, // 2.0x
        ));

        complete_escrow(BOB, ALICE, 20 * CMN, 50);
        complete_escrow(CAROL, ALICE, 20 * CMN, 50);
        crate::common::settle_era(1);
        assert_eq!(
            pallet_emissions::LastEraEmission::<TestRuntime>::get(),
            80 * CMN,
            "at alpha 2.0 the same work sizes twice the pot"
        );
    });
}

/// An agent that goes dormant must not keep minting from a stale weight snapshot.
///
/// `do_claim` pays `(acc - debt) x weight_snapshot`, and a dormant agent is absent from
/// `total_weight` — so `AccRewardPerStake` advances as if it were not there, and a snapshot
/// left behind would pay it anyway. The per-era mint would then exceed the D7 bound at the
/// mint site rather than at the accumulator.
#[test]
fn a_dormant_agent_cannot_mint_from_a_stale_weight_snapshot() {
    new_test_ext().execute_with(|| {
        register(ALICE, FULL_STAKE);
        register(BOB, FULL_STAKE);
        // Escrow requires BOTH sides to be registered agents (`BuyerNotAgent`), so a buyer
        // is never a free throwaway account — it costs a burned fee and locked stake.
        register(CAROL, MIN_STAKE);
        register(DAVE, MIN_STAKE);

        // Era 1: both work, so both get a snapshot. Neither claims.
        complete_escrow(CAROL, ALICE, 4_000 * CMN, 50);
        complete_escrow(DAVE, ALICE, 4_000 * CMN, 50);
        complete_escrow(CAROL, BOB, 4_000 * CMN, 50);
        complete_escrow(DAVE, BOB, 4_000 * CMN, 50);
        crate::common::settle_era(1);
        assert!(pallet_emissions::AgentWeightSnapshot::<TestRuntime>::get(BOB) > 0);

        // Era 2: BOB does nothing at all. ALICE keeps working.
        complete_escrow(CAROL, ALICE, 4_000 * CMN, 50);
        complete_escrow(DAVE, ALICE, 4_000 * CMN, 50);
        crate::common::settle_era(1);

        assert_eq!(
            pallet_emissions::AgentWeightSnapshot::<TestRuntime>::get(BOB),
            0,
            "a zero-weight era must clear the snapshot, not leave last era's behind"
        );

        let before = pallet_balances::Pallet::<TestRuntime>::free_balance(BOB);
        let _ = pallet_emissions::Pallet::<TestRuntime>::claim(RuntimeOrigin::signed(BOB));
        assert_eq!(
            pallet_balances::Pallet::<TestRuntime>::free_balance(BOB),
            before,
            "an idle agent must not be paid out of an era it contributed no weight to"
        );
    });
}
