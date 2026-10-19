//! pallet-auto-params unit tests.
//!
//! `lib.rs` has always declared `#[cfg(test)] mod tests;`, but no backing file ever existed
//! in this repo's history — so `cargo test` failed to resolve the module (E0583) before the
//! workspace test build could even start.
//!
//! The three era-settlement rules (ring-farming fee, oracle participation, emission
//! concentration) and the governance `set_param` / `set_bounds` calls are covered directly
//! below, asserting on emitted events and storage rather than on return values alone (#185).
//! Also covered is spec 306's `EmissionVolumeAlphaBps` — the parameter that
//! bounds every era's emission — because D7 makes it sudo/governance-settable and an
//! unbounded or unseeded value there is the difference between "mint at most the work we
//! measured" and either "mint nothing, ever" or "mint anything at all".

use crate::*;
use frame_support::{
    assert_noop, assert_ok, parameter_types,
    traits::{ConstU16, ConstU32, ConstU64, Hooks, StorageVersion},
};
use sp_core::H256;
use sp_runtime::{
    traits::{BlakeTwo256, IdentityLookup},
    BuildStorage,
};

type Block = frame_system::mocking::MockBlock<Test>;

frame_support::construct_runtime!(
    pub enum Test {
        System:     frame_system,
        AutoParams: crate,
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
    type BlockHashCount = ConstU64<250>;
    type DbWeight = ();
    type Version = ();
    type PalletInfo = PalletInfo;
    type AccountData = ();
    type OnNewAccount = ();
    type OnKilledAccount = ();
    type SystemWeightInfo = ();
    type SS58Prefix = ConstU16<42>;
    type OnSetCode = ();
    type MaxConsumers = ConstU32<16>;
    type ExtensionsWeightInfo = ();
    type SingleBlockMigrations = ();
    type MultiBlockMigrator = ();
    type PreInherents = ();
    type PostInherents = ();
    type PostTransactions = ();
}

parameter_types! {
    // Mirrors runtime/src/lib.rs so the values under test are the shipped ones.
    pub const InitFeeBps:      u32 = 25;
    pub const InitAlpha:       u32 = 1_500;
    pub const InitBeta:        u32 = 5_000;
    pub const InitFloor:       u32 = 1_000;
    pub const InitMinScore:    u32 = 5;
    pub const InitVolAlphaBps: u32 = 10_000;
}

impl crate::pallet::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    type GovernanceOrigin = frame_system::EnsureRoot<u64>;
    type InitialCompletionFeeBps = InitFeeBps;
    type InitialAlpha = InitAlpha;
    type InitialBeta = InitBeta;
    type InitialFloorBps = InitFloor;
    type InitialMinScoreEligible = InitMinScore;
    type InitialEmissionVolumeAlphaBps = InitVolAlphaBps;
    type RingRatioThreshold = ConstU32<3_000>;
    type OracleParticipationLowThreshold = ConstU32<4_000>;
    type OracleParticipationHighThreshold = ConstU32<9_000>;
    type ConcentrationHighThreshold = ConstU32<7_000>;
    type ConcentrationLowThreshold = ConstU32<5_000>;
    type MinQuestionsForOracleRule = ConstU32<3>;
    type MinAgentsForConcentrationRule = ConstU32<5>;
}

fn new_test_ext() -> sp_io::TestExternalities {
    let mut storage = frame_system::GenesisConfig::<Test>::default()
        .build_storage()
        .unwrap();
    crate::GenesisConfig::<Test>::default()
        .assimilate_storage(&mut storage)
        .unwrap();
    let mut ext: sp_io::TestExternalities = storage.into();
    // A real chain genesis writes the pallet's STORAGE_VERSION through `on_genesis`, which
    // only runs when genesis is built through the runtime's own RuntimeGenesisConfig.
    // Calling `assimilate_storage` on the pallet's GenesisConfig directly — what a mock
    // does — skips it, leaving the version at 0. Set it here so `new_test_ext` models a
    // freshly launched spec-306 chain; the migration tests override it deliberately.
    ext.execute_with(|| {
        StorageVersion::new(2).put::<Pallet<Test>>();
        // Events are only recorded from block 1 onward.
        System::set_block_number(1);
    });
    ext.commit_all().unwrap();
    ext
}

// ── spec 306: EmissionVolumeAlphaBps ─────────────────────────────────────────

#[test]
fn genesis_seeds_alpha_at_one_times_volume() {
    new_test_ext().execute_with(|| {
        assert_eq!(EmissionVolumeAlphaBps::<Test>::get(), 10_000);
        assert_eq!(
            <Pallet<Test> as AutoParamsProvider>::emission_volume_alpha_bps(),
            10_000,
            "the provider the emissions pallet actually reads must agree with storage"
        );
        let b = EmissionVolumeAlphaBounds::<Test>::get().expect("bounds seeded at genesis");
        assert_eq!((b.min, b.max), (0, 100_000));
    });
}

#[test]
fn governance_can_lower_alpha_to_zero_and_raise_it_back() {
    new_test_ext().execute_with(|| {
        // Zero is a real emission stop that does not pause `settle_era` or `claim`, so no
        // economically essential function comes to depend on a privileged caller
        // (CLAUDE.md first principle #3). It is the lever spec 305 did not have.
        assert_ok!(AutoParams::set_param(
            RuntimeOrigin::root(),
            ParamId::EmissionVolumeAlphaBps,
            0
        ));
        assert_eq!(EmissionVolumeAlphaBps::<Test>::get(), 0);

        assert_ok!(AutoParams::set_param(
            RuntimeOrigin::root(),
            ParamId::EmissionVolumeAlphaBps,
            20_000
        ));
        assert_eq!(EmissionVolumeAlphaBps::<Test>::get(), 20_000);
    });
}

#[test]
fn alpha_cannot_be_set_outside_its_bounds() {
    new_test_ext().execute_with(|| {
        assert_noop!(
            AutoParams::set_param(
                RuntimeOrigin::root(),
                ParamId::EmissionVolumeAlphaBps,
                100_001
            ),
            Error::<Test>::ValueOutOfBounds
        );
        assert_eq!(
            EmissionVolumeAlphaBps::<Test>::get(),
            10_000,
            "a rejected write must leave the live value untouched"
        );
    });
}

#[test]
fn alpha_is_not_settable_by_an_unprivileged_account() {
    new_test_ext().execute_with(|| {
        assert_noop!(
            AutoParams::set_param(
                RuntimeOrigin::signed(1),
                ParamId::EmissionVolumeAlphaBps,
                100_000
            ),
            sp_runtime::DispatchError::BadOrigin
        );
    });
}

#[test]
fn param_id_discriminants_are_stable_wire_format() {
    // ParamId is a call argument, so its SCALE indices are wire format. If this ever fails,
    // a variant was inserted rather than appended and every already-encoded set_param call
    // now points at a different parameter.
    use parity_scale_codec::Encode;
    assert_eq!(ParamId::CompletionFeeBps.encode(), vec![0]);
    assert_eq!(ParamId::Alpha.encode(), vec![1]);
    assert_eq!(ParamId::Beta.encode(), vec![2]);
    assert_eq!(ParamId::FloorBps.encode(), vec![3]);
    assert_eq!(ParamId::MinScoreEligibleResponses.encode(), vec![4]);
    assert_eq!(ParamId::EmissionVolumeAlphaBps.encode(), vec![5]);
}

// ── spec 306: v1 -> v2 migration ─────────────────────────────────────────────

#[test]
fn v2_migration_seeds_alpha_on_a_chain_that_never_ran_genesis() {
    new_test_ext().execute_with(|| {
        // A forkless upgrade does not re-run genesis. Reconstruct the spec-305 shape:
        // storage version 1, and the new ValueQuery item reading its default of 0.
        EmissionVolumeAlphaBps::<Test>::kill();
        EmissionVolumeAlphaBounds::<Test>::kill();
        StorageVersion::new(1).put::<Pallet<Test>>();
        assert_eq!(
            EmissionVolumeAlphaBps::<Test>::get(),
            0,
            "precondition: unseeded alpha reads 0, which would bound every era at 0 x volume"
        );

        let _ = <Pallet<Test> as Hooks<u64>>::on_runtime_upgrade();

        assert_eq!(StorageVersion::get::<Pallet<Test>>(), 2);
        assert_eq!(EmissionVolumeAlphaBps::<Test>::get(), 10_000);
        assert!(EmissionVolumeAlphaBounds::<Test>::get().is_some());
    });
}

#[test]
fn v2_migration_does_not_overwrite_a_governance_choice_on_re_run() {
    new_test_ext().execute_with(|| {
        assert_ok!(AutoParams::set_param(
            RuntimeOrigin::root(),
            ParamId::EmissionVolumeAlphaBps,
            2_500
        ));
        // Already at v2 from genesis, so the hook must be a no-op.
        let _ = <Pallet<Test> as Hooks<u64>>::on_runtime_upgrade();
        assert_eq!(
            EmissionVolumeAlphaBps::<Test>::get(),
            2_500,
            "an upgrade must not silently undo a governance decision"
        );
    });
}

// ── #185: helpers ────────────────────────────────────────────────────────────

fn events() -> Vec<Event<Test>> {
    System::events()
        .into_iter()
        .filter_map(|r| match r.event {
            RuntimeEvent::AutoParams(e) => Some(e),
            _ => None,
        })
        .collect()
}

fn clear_events() {
    System::reset_events();
}

/// Era metrics that trip no rule: no ring, too few questions, too few agents.
fn quiet() -> EraMetrics {
    EraMetrics {
        active_agents: 10,
        ring_count: 2, // 20% ring ratio: above threshold/2 (15%), at or below 30%: dead band
        era_finalized_questions: 0,
        era_total_questions: 0,
        total_weight: 0,
        top_ten_pct_weight: 0,
        active_validators: 4,
    }
}

fn ringy() -> EraMetrics {
    // 5 of 10 agents in rings = 50% > the 30% threshold.
    EraMetrics {
        ring_count: 5,
        ..quiet()
    }
}

fn oracle(finalized: u32, total: u32) -> EraMetrics {
    EraMetrics {
        active_agents: 0, // disables the ring and concentration rules
        ring_count: 0,
        era_finalized_questions: finalized,
        era_total_questions: total,
        ..quiet()
    }
}

fn concentrated(top: u128, total: u128) -> EraMetrics {
    EraMetrics {
        active_agents: 10,
        ring_count: 0,
        total_weight: total,
        top_ten_pct_weight: top,
        ..quiet()
    }
}

// ── #185 / E13: origin gating on set_param and set_bounds ────────────────────

#[test]
fn set_param_signed_is_bad_origin_for_every_param_with_no_event_or_write() {
    new_test_ext().execute_with(|| {
        let all = [
            (ParamId::CompletionFeeBps, 100u32),
            (ParamId::Alpha, 2_000),
            (ParamId::Beta, 2_000),
            (ParamId::FloorBps, 200),
            (ParamId::MinScoreEligibleResponses, 6),
            (ParamId::EmissionVolumeAlphaBps, 5_000),
        ];
        for (param, v) in all {
            assert_noop!(
                AutoParams::set_param(RuntimeOrigin::signed(1), param, v),
                sp_runtime::DispatchError::BadOrigin
            );
        }
        assert_eq!(CompletionFeeBps::<Test>::get(), 25);
        assert_eq!(Alpha::<Test>::get(), 1_500);
        assert_eq!(Beta::<Test>::get(), 5_000);
        assert_eq!(FloorBps::<Test>::get(), 1_000);
        assert_eq!(MinScoreEligibleResponses::<Test>::get(), 5);
        assert_eq!(EmissionVolumeAlphaBps::<Test>::get(), 10_000);
        assert!(events().is_empty(), "a rejected call must not emit");
    });
}

#[test]
fn set_param_unsigned_is_bad_origin() {
    new_test_ext().execute_with(|| {
        assert_noop!(
            AutoParams::set_param(RuntimeOrigin::none(), ParamId::Alpha, 2_000),
            sp_runtime::DispatchError::BadOrigin
        );
        assert_eq!(Alpha::<Test>::get(), 1_500);
        assert!(events().is_empty());
    });
}

#[test]
fn set_bounds_signed_is_bad_origin_and_bounds_unchanged() {
    new_test_ext().execute_with(|| {
        let before = AlphaBounds::<Test>::get();
        let wide = ParamBounds {
            min: 0,
            max: u32::MAX,
            max_step: u32::MAX,
        };
        assert_noop!(
            AutoParams::set_bounds(RuntimeOrigin::signed(1), ParamId::Alpha, wide),
            sp_runtime::DispatchError::BadOrigin
        );
        assert_eq!(AlphaBounds::<Test>::get(), before);
        assert!(events().is_empty());
    });
}

// ── #185: set_param writes storage and emits ParamSetByGovernance ────────────

#[test]
fn set_param_root_writes_each_param_and_emits_event() {
    new_test_ext().execute_with(|| {
        let cases: [(ParamId, u32); 6] = [
            (ParamId::CompletionFeeBps, 100),
            (ParamId::Alpha, 2_000),
            (ParamId::Beta, 3_000),
            (ParamId::FloorBps, 200),
            (ParamId::MinScoreEligibleResponses, 6),
            (ParamId::EmissionVolumeAlphaBps, 5_000),
        ];
        for (param, value) in cases {
            clear_events();
            assert_ok!(AutoParams::set_param(RuntimeOrigin::root(), param, value));
            assert_eq!(events(), vec![Event::ParamSetByGovernance { param, value }]);
        }
        assert_eq!(CompletionFeeBps::<Test>::get(), 100);
        assert_eq!(Alpha::<Test>::get(), 2_000);
        assert_eq!(Beta::<Test>::get(), 3_000);
        assert_eq!(FloorBps::<Test>::get(), 200);
        assert_eq!(MinScoreEligibleResponses::<Test>::get(), 6);
        assert_eq!(EmissionVolumeAlphaBps::<Test>::get(), 5_000);
        // The provider the emissions pallet reads sees the same values.
        assert_eq!(
            <Pallet<Test> as AutoParamsProvider>::completion_fee_bps(),
            100
        );
        assert_eq!(<Pallet<Test> as AutoParamsProvider>::alpha(), 2_000);
        assert_eq!(<Pallet<Test> as AutoParamsProvider>::beta(), 3_000);
        assert_eq!(<Pallet<Test> as AutoParamsProvider>::floor_bps(), 200);
        assert_eq!(
            <Pallet<Test> as AutoParamsProvider>::min_score_eligible(),
            6
        );
    });
}

#[test]
fn set_param_accepts_exact_bounds_and_rejects_one_past_each_edge() {
    new_test_ext().execute_with(|| {
        // (param, min, max) from genesis bounds.
        let edges = [
            (ParamId::CompletionFeeBps, 0u32, 2_500u32),
            (ParamId::Alpha, 1_000, 8_000),
            (ParamId::Beta, 1_000, 8_000),
            (ParamId::FloorBps, 100, 3_000),
            (ParamId::MinScoreEligibleResponses, 3, 20),
            (ParamId::EmissionVolumeAlphaBps, 0, 100_000),
        ];
        for (param, min, max) in edges {
            assert_ok!(AutoParams::set_param(RuntimeOrigin::root(), param, min));
            assert_ok!(AutoParams::set_param(RuntimeOrigin::root(), param, max));
            clear_events();
            assert_noop!(
                AutoParams::set_param(RuntimeOrigin::root(), param, max + 1),
                Error::<Test>::ValueOutOfBounds
            );
            if min > 0 {
                assert_noop!(
                    AutoParams::set_param(RuntimeOrigin::root(), param, min - 1),
                    Error::<Test>::ValueOutOfBounds
                );
            }
            assert!(
                events().is_empty(),
                "{param:?}: rejected write must not emit"
            );
        }
        // The last accepted write for each param was `max`.
        assert_eq!(CompletionFeeBps::<Test>::get(), 2_500);
        assert_eq!(Alpha::<Test>::get(), 8_000);
        assert_eq!(Beta::<Test>::get(), 8_000);
        assert_eq!(FloorBps::<Test>::get(), 3_000);
        assert_eq!(MinScoreEligibleResponses::<Test>::get(), 20);
        assert_eq!(EmissionVolumeAlphaBps::<Test>::get(), 100_000);
    });
}

#[test]
fn set_param_is_a_direct_write_not_limited_by_max_step() {
    new_test_ext().execute_with(|| {
        // max_step (500 for Alpha) throttles the AUTO rules only; governance may jump the
        // whole permitted range in one call. Pinned so a change in that semantic is loud.
        assert_ok!(AutoParams::set_param(
            RuntimeOrigin::root(),
            ParamId::Alpha,
            8_000
        ));
        assert_eq!(Alpha::<Test>::get(), 8_000);
    });
}

// ── #185: set_bounds writes storage, emits BoundsUpdated, and is then enforced ──

#[test]
fn set_bounds_root_updates_storage_emits_event_and_is_enforced() {
    new_test_ext().execute_with(|| {
        let nb = ParamBounds {
            min: 2_000,
            max: 3_000,
            max_step: 250,
        };
        assert_ok!(AutoParams::set_bounds(
            RuntimeOrigin::root(),
            ParamId::Alpha,
            nb.clone()
        ));
        assert_eq!(AlphaBounds::<Test>::get(), Some(nb.clone()));
        assert_eq!(
            events(),
            vec![Event::BoundsUpdated {
                param: ParamId::Alpha,
                bounds: nb
            }]
        );
        assert_noop!(
            AutoParams::set_param(RuntimeOrigin::root(), ParamId::Alpha, 1_500),
            Error::<Test>::ValueOutOfBounds
        );
        assert_ok!(AutoParams::set_param(
            RuntimeOrigin::root(),
            ParamId::Alpha,
            2_500
        ));
        assert_eq!(Alpha::<Test>::get(), 2_500);
    });
}

#[test]
fn set_bounds_writes_the_matching_storage_item_for_every_param() {
    new_test_ext().execute_with(|| {
        let b = |n: u32| ParamBounds {
            min: n,
            max: n + 10,
            max_step: 1,
        };
        assert_ok!(AutoParams::set_bounds(
            RuntimeOrigin::root(),
            ParamId::CompletionFeeBps,
            b(1)
        ));
        assert_ok!(AutoParams::set_bounds(
            RuntimeOrigin::root(),
            ParamId::Alpha,
            b(2)
        ));
        assert_ok!(AutoParams::set_bounds(
            RuntimeOrigin::root(),
            ParamId::Beta,
            b(3)
        ));
        assert_ok!(AutoParams::set_bounds(
            RuntimeOrigin::root(),
            ParamId::FloorBps,
            b(4)
        ));
        assert_ok!(AutoParams::set_bounds(
            RuntimeOrigin::root(),
            ParamId::MinScoreEligibleResponses,
            b(5)
        ));
        assert_ok!(AutoParams::set_bounds(
            RuntimeOrigin::root(),
            ParamId::EmissionVolumeAlphaBps,
            b(6)
        ));
        assert_eq!(CompletionFeeBounds::<Test>::get(), Some(b(1)));
        assert_eq!(AlphaBounds::<Test>::get(), Some(b(2)));
        assert_eq!(BetaBounds::<Test>::get(), Some(b(3)));
        assert_eq!(FloorBpsBounds::<Test>::get(), Some(b(4)));
        assert_eq!(MinScoreBounds::<Test>::get(), Some(b(5)));
        assert_eq!(EmissionVolumeAlphaBounds::<Test>::get(), Some(b(6)));
        assert_eq!(events().len(), 6);
    });
}

#[test]
fn genesis_seeds_all_params_and_bounds() {
    new_test_ext().execute_with(|| {
        assert_eq!(CompletionFeeBps::<Test>::get(), 25);
        assert_eq!(Alpha::<Test>::get(), 1_500);
        assert_eq!(Beta::<Test>::get(), 5_000);
        assert_eq!(FloorBps::<Test>::get(), 1_000);
        assert_eq!(MinScoreEligibleResponses::<Test>::get(), 5);
        let pb = |min, max, max_step| Some(ParamBounds { min, max, max_step });
        assert_eq!(CompletionFeeBounds::<Test>::get(), pb(0, 2_500, 25));
        assert_eq!(AlphaBounds::<Test>::get(), pb(1_000, 8_000, 500));
        assert_eq!(BetaBounds::<Test>::get(), pb(1_000, 8_000, 500));
        assert_eq!(FloorBpsBounds::<Test>::get(), pb(100, 3_000, 100));
        assert_eq!(MinScoreBounds::<Test>::get(), pb(3, 20, 1));
        assert!(events().is_empty(), "genesis emits nothing");
    });
}

// ── #185: rule 1, ring farming → CompletionFeeBps ────────────────────────────

#[test]
fn ring_farming_raises_fee_by_exactly_max_step_and_emits() {
    new_test_ext().execute_with(|| {
        Pallet::<Test>::run_era_rules(ringy());
        assert_eq!(
            CompletionFeeBps::<Test>::get(),
            25 + 25,
            "one max_step (25 bps)"
        );
        assert_eq!(
            events(),
            vec![Event::ParamAutoAdjusted {
                param: ParamId::CompletionFeeBps,
                old_value: 25,
                new_value: 50,
                reason: AdjustReason::RingFarmingDetected,
            }]
        );
    });
}

#[test]
fn ring_farming_never_exceeds_upper_bound_and_stops_emitting_at_it() {
    new_test_ext().execute_with(|| {
        // Park just under the cap so the next step would overshoot it.
        assert_ok!(AutoParams::set_param(
            RuntimeOrigin::root(),
            ParamId::CompletionFeeBps,
            2_490
        ));
        clear_events();
        Pallet::<Test>::run_era_rules(ringy());
        assert_eq!(
            CompletionFeeBps::<Test>::get(),
            2_500,
            "clamped to max, not 2_515"
        );
        assert_eq!(
            events(),
            vec![Event::ParamAutoAdjusted {
                param: ParamId::CompletionFeeBps,
                old_value: 2_490,
                new_value: 2_500,
                reason: AdjustReason::RingFarmingDetected,
            }]
        );
        clear_events();
        Pallet::<Test>::run_era_rules(ringy());
        assert_eq!(CompletionFeeBps::<Test>::get(), 2_500);
        assert!(events().is_empty(), "no-op at the bound emits nothing");
    });
}

#[test]
fn ring_ratio_exactly_at_threshold_does_not_raise_fee() {
    new_test_ext().execute_with(|| {
        // 3 of 10 = 3000 bps == threshold; the rule is strictly greater-than.
        Pallet::<Test>::run_era_rules(EraMetrics {
            ring_count: 3,
            ..quiet()
        });
        assert_eq!(CompletionFeeBps::<Test>::get(), 25);
        assert!(events().is_empty());
    });
}

#[test]
fn ring_subsiding_steps_fee_back_down_but_never_below_initial() {
    new_test_ext().execute_with(|| {
        assert_ok!(AutoParams::set_param(
            RuntimeOrigin::root(),
            ParamId::CompletionFeeBps,
            60
        ));
        clear_events();
        let calm = EraMetrics {
            ring_count: 0,
            ..quiet()
        };
        Pallet::<Test>::run_era_rules(calm);
        assert_eq!(CompletionFeeBps::<Test>::get(), 35);
        assert_eq!(
            events(),
            vec![Event::ParamAutoAdjusted {
                param: ParamId::CompletionFeeBps,
                old_value: 60,
                new_value: 35,
                reason: AdjustReason::RingFarmingSubsided,
            }]
        );
        clear_events();
        Pallet::<Test>::run_era_rules(calm); // 35 - 25 = 10 < initial 25 → clamp to 25
        assert_eq!(CompletionFeeBps::<Test>::get(), 25);
        clear_events();
        Pallet::<Test>::run_era_rules(calm);
        assert_eq!(
            CompletionFeeBps::<Test>::get(),
            25,
            "never decays below the genesis fee"
        );
        assert!(events().is_empty());
    });
}

#[test]
fn ring_rule_is_inert_with_no_agents_or_no_bounds() {
    new_test_ext().execute_with(|| {
        Pallet::<Test>::run_era_rules(EraMetrics {
            active_agents: 0,
            ring_count: 5,
            ..quiet()
        });
        assert_eq!(CompletionFeeBps::<Test>::get(), 25);
        CompletionFeeBounds::<Test>::kill();
        Pallet::<Test>::run_era_rules(ringy());
        assert_eq!(
            CompletionFeeBps::<Test>::get(),
            25,
            "no bounds → no autonomous move"
        );
        assert!(events().is_empty());
    });
}

#[test]
fn ring_fee_climb_never_moves_more_than_max_step_per_era() {
    new_test_ext().execute_with(|| {
        let mut prev = CompletionFeeBps::<Test>::get();
        for _ in 0..200 {
            Pallet::<Test>::run_era_rules(ringy());
            let now = CompletionFeeBps::<Test>::get();
            assert!(now - prev <= 25, "step {prev}->{now} exceeds max_step");
            assert!(now <= 2_500);
            prev = now;
        }
        assert_eq!(prev, 2_500);
    });
}

// ── #185: rule 2, oracle participation → MinScoreEligibleResponses ───────────

#[test]
fn low_oracle_participation_lowers_min_score_by_one_and_emits() {
    new_test_ext().execute_with(|| {
        Pallet::<Test>::run_era_rules(oracle(1, 5)); // 20% < 40%
        assert_eq!(MinScoreEligibleResponses::<Test>::get(), 4);
        assert_eq!(
            events(),
            vec![Event::ParamAutoAdjusted {
                param: ParamId::MinScoreEligibleResponses,
                old_value: 5,
                new_value: 4,
                reason: AdjustReason::OracleParticipationLow,
            }]
        );
    });
}

#[test]
fn low_oracle_participation_floors_at_min_bound() {
    new_test_ext().execute_with(|| {
        for _ in 0..10 {
            Pallet::<Test>::run_era_rules(oracle(0, 5));
        }
        assert_eq!(
            MinScoreEligibleResponses::<Test>::get(),
            3,
            "bound min is 3"
        );
        clear_events();
        Pallet::<Test>::run_era_rules(oracle(0, 5));
        assert!(events().is_empty(), "no event once pinned at the floor");
    });
}

#[test]
fn high_oracle_participation_raises_min_score_and_caps_at_max_bound() {
    new_test_ext().execute_with(|| {
        Pallet::<Test>::run_era_rules(oracle(5, 5)); // 100% > 90%
        assert_eq!(MinScoreEligibleResponses::<Test>::get(), 6);
        assert_eq!(
            events(),
            vec![Event::ParamAutoAdjusted {
                param: ParamId::MinScoreEligibleResponses,
                old_value: 5,
                new_value: 6,
                reason: AdjustReason::OracleParticipationHigh,
            }]
        );
        for _ in 0..50 {
            Pallet::<Test>::run_era_rules(oracle(5, 5));
        }
        assert_eq!(
            MinScoreEligibleResponses::<Test>::get(),
            20,
            "bound max is 20"
        );
    });
}

#[test]
fn oracle_rule_gated_by_min_questions_and_dead_band() {
    new_test_ext().execute_with(|| {
        // Below MinQuestionsForOracleRule (3): even 0% success is ignored.
        Pallet::<Test>::run_era_rules(oracle(0, 2));
        // 40% and 90% exactly sit inside the dead band (strict comparisons).
        Pallet::<Test>::run_era_rules(oracle(4, 10));
        Pallet::<Test>::run_era_rules(oracle(9, 10));
        // 65% mid-band.
        Pallet::<Test>::run_era_rules(oracle(13, 20));
        assert_eq!(MinScoreEligibleResponses::<Test>::get(), 5);
        assert!(events().is_empty());
    });
}

// ── #185: rule 3, emission concentration → Alpha ─────────────────────────────

#[test]
fn high_concentration_lowers_alpha_by_max_step_and_emits() {
    new_test_ext().execute_with(|| {
        assert_ok!(AutoParams::set_param(
            RuntimeOrigin::root(),
            ParamId::Alpha,
            3_000
        ));
        clear_events();
        Pallet::<Test>::run_era_rules(concentrated(8_000, 10_000)); // 80% > 70%
        assert_eq!(Alpha::<Test>::get(), 2_500);
        assert_eq!(
            events(),
            vec![Event::ParamAutoAdjusted {
                param: ParamId::Alpha,
                old_value: 3_000,
                new_value: 2_500,
                reason: AdjustReason::ConcentrationHigh,
            }]
        );
    });
}

#[test]
fn high_concentration_clamps_alpha_at_min_bound() {
    new_test_ext().execute_with(|| {
        // Genesis alpha 1_500, step 500, min 1_000: 1_500 → 1_000, then pinned.
        Pallet::<Test>::run_era_rules(concentrated(9_000, 10_000));
        assert_eq!(Alpha::<Test>::get(), 1_000);
        clear_events();
        Pallet::<Test>::run_era_rules(concentrated(9_000, 10_000));
        assert_eq!(Alpha::<Test>::get(), 1_000);
        assert!(events().is_empty());
    });
}

#[test]
fn low_concentration_restores_alpha_and_caps_at_max_bound() {
    new_test_ext().execute_with(|| {
        Pallet::<Test>::run_era_rules(concentrated(4_000, 10_000)); // 40% < 50%
        assert_eq!(Alpha::<Test>::get(), 2_000);
        assert_eq!(
            events(),
            vec![Event::ParamAutoAdjusted {
                param: ParamId::Alpha,
                old_value: 1_500,
                new_value: 2_000,
                reason: AdjustReason::ConcentrationLow,
            }]
        );
        for _ in 0..50 {
            Pallet::<Test>::run_era_rules(concentrated(4_000, 10_000));
        }
        assert_eq!(Alpha::<Test>::get(), 8_000);
    });
}

#[test]
fn concentration_rule_gated_by_agent_count_zero_weight_and_dead_band() {
    new_test_ext().execute_with(|| {
        // Fewer than MinAgentsForConcentrationRule (5) agents.
        Pallet::<Test>::run_era_rules(EraMetrics {
            active_agents: 4,
            ..concentrated(9_000, 10_000)
        });
        // Zero total weight must not divide by zero or move alpha.
        Pallet::<Test>::run_era_rules(concentrated(0, 0));
        // 5_000..=7_000 inclusive is the dead band.
        Pallet::<Test>::run_era_rules(concentrated(5_000, 10_000));
        Pallet::<Test>::run_era_rules(concentrated(7_000, 10_000));
        assert_eq!(Alpha::<Test>::get(), 1_500);
        assert!(events().is_empty());
    });
}

// ── #185: run_era_rules wiring ───────────────────────────────────────────────

#[test]
fn provider_run_era_rules_dispatches_to_the_rules_engine() {
    new_test_ext().execute_with(|| {
        // pallet-emissions calls through the trait; the default no-op must not be in play.
        <Pallet<Test> as AutoParamsProvider>::run_era_rules(ringy());
        assert_eq!(CompletionFeeBps::<Test>::get(), 50);
        assert_eq!(events().len(), 1);
    });
}

#[test]
fn several_rules_in_one_era_each_emit_their_own_event() {
    new_test_ext().execute_with(|| {
        Pallet::<Test>::run_era_rules(EraMetrics {
            active_agents: 10,
            ring_count: 5,
            era_finalized_questions: 0,
            era_total_questions: 10,
            total_weight: 10_000,
            top_ten_pct_weight: 9_000,
            active_validators: 4,
        });
        let reasons: Vec<_> = events()
            .into_iter()
            .map(|e| match e {
                Event::ParamAutoAdjusted { reason, .. } => reason,
                other => panic!("unexpected event {other:?}"),
            })
            .collect();
        assert_eq!(
            reasons,
            vec![
                AdjustReason::RingFarmingDetected,
                AdjustReason::OracleParticipationLow,
                AdjustReason::ConcentrationHigh
            ]
        );
        assert_eq!(CompletionFeeBps::<Test>::get(), 50);
        assert_eq!(MinScoreEligibleResponses::<Test>::get(), 4);
        assert_eq!(Alpha::<Test>::get(), 1_000);
    });
}
