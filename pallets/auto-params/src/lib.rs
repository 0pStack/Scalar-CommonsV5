//! # pallet-auto-params v3.0
//!
//! Three bounded autonomous rules that fire at each era settlement.
//! Zero deliberation. Zero oracle. Zero vote. Executes in the settle_era block.
//!
//! Rules:
//!   1. Ring farming fee  — ring_ratio > 30% → CompletionFeeBps += max_step
//!   2. Oracle participation — quorum_rate < 40% (≥5 questions) → MinScoreEligible -= 1
//!   3. Emission concentration — top10% > 70% (≥50 agents) → Alpha -= max_step
//!
//! All parameters are stored on-chain (not compiled constants) so governance can
//! adjust bounds and thresholds without a runtime upgrade.

#![cfg_attr(not(feature = "std"), no_std)]
pub use pallet::*;

#[cfg(test)]
mod tests;

#[cfg(feature = "runtime-benchmarks")]
pub mod benchmarks;

pub trait WeightInfo {
    fn set_param() -> Weight;
    fn set_bounds() -> Weight;
}
pub struct PlaceholderWeights;
impl WeightInfo for PlaceholderWeights {
    fn set_param() -> Weight {
        Weight::from_parts(30000000, 0)
    }
    fn set_bounds() -> Weight {
        Weight::from_parts(30000000, 0)
    }
}

use frame_support::weights::Weight;
#[frame_support::pallet]
pub mod pallet {
    use frame_support::pallet_prelude::*;
    use frame_system::pallet_prelude::*;

    // ─── Era metrics struct ────────────────────────────────────────────────────
    /// Comprehensive era metrics passed from pallet-emissions after each era drain.
    #[derive(Clone, Copy, Default, Encode, Decode, TypeInfo, MaxEncodedLen)]
    pub struct EraMetrics {
        pub active_agents: u32,
        pub ring_count: u32,
        pub era_finalized_questions: u32,
        pub era_total_questions: u32,
        pub total_weight: u128,
        pub top_ten_pct_weight: u128,
        pub active_validators: u32,
    }

    // ─── Parameter bounds ─────────────────────────────────────────────────────
    #[derive(
        Clone, Encode, Decode, DecodeWithMemTracking, MaxEncodedLen, TypeInfo, Debug, PartialEq, Eq,
    )]
    pub struct ParamBounds {
        pub min: u32,
        pub max: u32,
        pub max_step: u32,
    }

    // ─── Provider trait (used by pallet-emissions to read live params) ────────
    pub trait AutoParamsProvider {
        fn completion_fee_bps() -> u32;
        fn alpha() -> u32;
        fn beta() -> u32;
        fn floor_bps() -> u32;
        fn min_score_eligible() -> u32;
        /// Alpha for the D7 emission-volume rule, in basis points. 10 000 = 1.0, meaning an
        /// era may not mint more than the qualifying escrow volume it settled.
        ///
        /// REQUIRED, with no default, and that is deliberate. The first version of this
        /// trait method carried `fn emission_volume_alpha_bps() -> u32 { 10_000 }` so the
        /// mocks would keep compiling — and the runtime's own `AutoParamsImpl` then
        /// silently inherited it. `EmissionVolumeAlphaBps`, its genesis seeding, its
        /// migration, its bounds and `set_param(EmissionVolumeAlphaBps, ..)` were all live
        /// and all dead: governance could set alpha to 0, watch `ParamSetByGovernance` fire,
        /// read the new value back out of storage, and `settle_era` would go on using 1.0.
        /// The emergency stop would have reported success and done nothing. A default on a
        /// provider trait hides exactly this class of wiring omission, so this one has none
        /// — a missing impl is now a compile error, which is what caught it.
        fn emission_volume_alpha_bps() -> u32;
        /// V4: F-02 — called by pallet-emissions at the end of every settle_era.
        /// Default is a no-op so mock impls in tests don't need to implement it.
        fn run_era_rules(_metrics: EraMetrics) {}
    }

    // ─── Config ───────────────────────────────────────────────────────────────
    #[pallet::config]
    pub trait Config: frame_system::Config {
        type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;

        /// Origin that can call set_param directly (bypasses auto-rules).
        /// Should be Root (sudo) or Track 2 governance.
        type GovernanceOrigin: EnsureOrigin<Self::RuntimeOrigin>;

        /// Initial CompletionFeeBps at genesis.
        #[pallet::constant]
        type InitialCompletionFeeBps: Get<u32>;
        /// Initial Alpha (governance weight in emission formula).
        #[pallet::constant]
        type InitialAlpha: Get<u32>;
        /// Initial Beta (work weight in emission formula).
        #[pallet::constant]
        type InitialBeta: Get<u32>;
        /// Initial FloorBps (floor emissions for Full-rank agents).
        #[pallet::constant]
        type InitialFloorBps: Get<u32>;
        /// Initial MinScoreEligibleResponses.
        #[pallet::constant]
        type InitialMinScoreEligible: Get<u32>;
        /// Initial alpha for the D7 emission-volume rule, in basis points.
        /// 10 000 = 1.0 = an era may mint at most the qualifying volume it settled.
        #[pallet::constant]
        type InitialEmissionVolumeAlphaBps: Get<u32>;

        // ── Rule thresholds ───────────────────────────────────────────────────
        /// Ring ratio (BPS) above which fee is raised. Default 3000 = 30%.
        #[pallet::constant]
        type RingRatioThreshold: Get<u32>;
        /// Oracle success rate (BPS) below which MinScore is lowered. Default 4000 = 40%.
        #[pallet::constant]
        type OracleParticipationLowThreshold: Get<u32>;
        /// Oracle success rate (BPS) above which MinScore is raised. Default 9000 = 90%.
        #[pallet::constant]
        type OracleParticipationHighThreshold: Get<u32>;
        /// Top-10% weight share (BPS) above which Alpha is reduced. Default 7000 = 70%.
        #[pallet::constant]
        type ConcentrationHighThreshold: Get<u32>;
        /// Top-10% weight share (BPS) below which Alpha is restored. Default 5000 = 50%.
        #[pallet::constant]
        type ConcentrationLowThreshold: Get<u32>;
        /// Minimum oracle questions in era before participation rule fires.
        #[pallet::constant]
        type MinQuestionsForOracleRule: Get<u32>;
        /// Minimum active agents before concentration rule fires.
        #[pallet::constant]
        type MinAgentsForConcentrationRule: Get<u32>;
    }

    // ─── Storage ──────────────────────────────────────────────────────────────

    /// Live completion fee in BPS (taken from escrow on confirm_delivery).
    #[pallet::storage]
    pub type CompletionFeeBps<T: Config> = StorageValue<_, u32, ValueQuery>;

    /// Live alpha (governance score weight). Governance-adjustable.
    #[pallet::storage]
    pub type Alpha<T: Config> = StorageValue<_, u32, ValueQuery>;

    /// Live beta (work score weight). Governance-adjustable.
    #[pallet::storage]
    pub type Beta<T: Config> = StorageValue<_, u32, ValueQuery>;

    /// Live floor BPS for Full-rank agents.
    #[pallet::storage]
    pub type FloorBps<T: Config> = StorageValue<_, u32, ValueQuery>;

    /// Minimum distinct agent responses for oracle consensus.
    #[pallet::storage]
    pub type MinScoreEligibleResponses<T: Config> = StorageValue<_, u32, ValueQuery>;

    /// Alpha for the D7 emission-volume rule, in basis points (10 000 = 1.0).
    ///
    /// `pallet-emissions::settle_era` bounds the era emission at
    /// `alpha x qualifying_escrow_volume`. At 10 000 the chain cannot mint more CMN in an
    /// era than the qualifying escrow volume that era settled — the direct answer to #164,
    /// where 110 000 CMN was minted against ~120 CMN of gross escrow because the pot was
    /// sized by agent COUNT and never looked at work at all.
    ///
    /// Stored rather than compiled in, so sudo or Track 2 governance can move it with
    /// `set_param` and no runtime upgrade, within `EmissionVolumeAlphaBounds`.
    #[pallet::storage]
    pub type EmissionVolumeAlphaBps<T: Config> = StorageValue<_, u32, ValueQuery>;

    // ── Parameter bounds (set by governance, enforced on every write) ─────────
    #[pallet::storage]
    pub type CompletionFeeBounds<T: Config> = StorageValue<_, ParamBounds, OptionQuery>;
    #[pallet::storage]
    pub type AlphaBounds<T: Config> = StorageValue<_, ParamBounds, OptionQuery>;
    #[pallet::storage]
    pub type BetaBounds<T: Config> = StorageValue<_, ParamBounds, OptionQuery>;
    #[pallet::storage]
    pub type FloorBpsBounds<T: Config> = StorageValue<_, ParamBounds, OptionQuery>;
    #[pallet::storage]
    pub type MinScoreBounds<T: Config> = StorageValue<_, ParamBounds, OptionQuery>;
    #[pallet::storage]
    pub type EmissionVolumeAlphaBounds<T: Config> = StorageValue<_, ParamBounds, OptionQuery>;

    /// Bumped 1 -> 2 for spec 306: `EmissionVolumeAlphaBps` and its bounds are new, and
    /// genesis does not re-run on a forkless upgrade — so the v2 migration seeds them.
    const STORAGE_VERSION: StorageVersion = StorageVersion::new(2);

    #[pallet::pallet]
    #[pallet::storage_version(STORAGE_VERSION)]
    pub struct Pallet<T>(_);

    // ─── Hooks ───────────────────────────────────────────────────────────────
    #[pallet::hooks]
    impl<T: Config> Hooks<BlockNumberFor<T>> for Pallet<T> {
        fn on_runtime_upgrade() -> Weight {
            let on_chain = StorageVersion::get::<Pallet<T>>();
            if on_chain >= 2 {
                return T::DbWeight::get().reads(1);
            }
            // v1 -> v2 (spec 306). `EmissionVolumeAlphaBps` is ValueQuery, so without this
            // it would read 0 on the upgraded chain and bound every era's emission at
            // 0 x volume = 0. Seeding it is not cosmetic: it is the difference between the
            // D7 rule being "at most the work you did" and "nothing, ever".
            EmissionVolumeAlphaBps::<T>::put(T::InitialEmissionVolumeAlphaBps::get());
            EmissionVolumeAlphaBounds::<T>::put(ParamBounds {
                min: 0,
                max: 100_000,
                max_step: 1_000,
            });
            StorageVersion::new(2).put::<Pallet<T>>();
            T::DbWeight::get().reads_writes(1, 3)
        }
    }

    // ─── Genesis ──────────────────────────────────────────────────────────────
    #[pallet::genesis_config]
    #[derive(frame_support::DefaultNoBound)]
    pub struct GenesisConfig<T: Config> {
        _phantom: sp_std::marker::PhantomData<T>,
    }

    #[pallet::genesis_build]
    impl<T: Config> BuildGenesisConfig for GenesisConfig<T> {
        fn build(&self) {
            CompletionFeeBps::<T>::put(T::InitialCompletionFeeBps::get());
            Alpha::<T>::put(T::InitialAlpha::get());
            Beta::<T>::put(T::InitialBeta::get());
            FloorBps::<T>::put(T::InitialFloorBps::get());
            MinScoreEligibleResponses::<T>::put(T::InitialMinScoreEligible::get());
            EmissionVolumeAlphaBps::<T>::put(T::InitialEmissionVolumeAlphaBps::get());

            // Default bounds — governance can tighten or widen these
            // CompletionFeeBps max=2500 (25%): strong ring deterrent while allowing
            // legitimate high-frequency work. At 25% fee, ring profit margin collapses.
            CompletionFeeBounds::<T>::put(ParamBounds {
                min: 0,
                max: 2500,
                max_step: 25,
            });
            AlphaBounds::<T>::put(ParamBounds {
                min: 1000,
                max: 8000,
                max_step: 500,
            });
            BetaBounds::<T>::put(ParamBounds {
                min: 1000,
                max: 8000,
                max_step: 500,
            });
            FloorBpsBounds::<T>::put(ParamBounds {
                min: 100,
                max: 3000,
                max_step: 100,
            });
            MinScoreBounds::<T>::put(ParamBounds {
                min: 3,
                max: 20,
                max_step: 1,
            });
            // Emission-volume alpha. min 0 lets governance stop emission entirely without
            // a runtime upgrade — the lever whose absence forced spec 305's stopgap to
            // walk `set_era_emission_override` ten eras at a time. max 100 000 = 10x caps
            // how far a bootstrap subsidy can outrun measured work; max_step 1 000 (0.1x)
            // keeps any future auto-rule from moving it in one jump.
            EmissionVolumeAlphaBounds::<T>::put(ParamBounds {
                min: 0,
                max: 100_000,
                max_step: 1_000,
            });
        }
    }

    // ─── Events ───────────────────────────────────────────────────────────────
    #[pallet::event]
    #[pallet::generate_deposit(pub(super) fn deposit_event)]
    pub enum Event<T: Config> {
        ParamAutoAdjusted {
            param: ParamId,
            old_value: u32,
            new_value: u32,
            reason: AdjustReason,
        },
        ParamSetByGovernance {
            param: ParamId,
            value: u32,
        },
        BoundsUpdated {
            param: ParamId,
            bounds: ParamBounds,
        },
    }

    #[derive(
        Clone,
        Copy,
        Encode,
        Decode,
        DecodeWithMemTracking,
        MaxEncodedLen,
        TypeInfo,
        Debug,
        PartialEq,
        Eq,
    )]
    pub enum ParamId {
        CompletionFeeBps,
        Alpha,
        Beta,
        FloorBps,
        MinScoreEligibleResponses,
        /// spec 306. APPENDED LAST on purpose: `ParamId` is a call argument, so its SCALE
        /// discriminants are wire format. Inserting anywhere but the end would silently
        /// repoint every already-encoded `set_param` call.
        EmissionVolumeAlphaBps,
    }

    #[derive(
        Clone,
        Copy,
        Encode,
        Decode,
        DecodeWithMemTracking,
        MaxEncodedLen,
        TypeInfo,
        Debug,
        PartialEq,
        Eq,
    )]
    pub enum AdjustReason {
        RingFarmingDetected,
        RingFarmingSubsided,
        OracleParticipationLow,
        OracleParticipationHigh,
        ConcentrationHigh,
        ConcentrationLow,
    }

    // ─── Errors ───────────────────────────────────────────────────────────────
    #[pallet::error]
    pub enum Error<T> {
        ValueOutOfBounds,
    }

    // ─── Calls ────────────────────────────────────────────────────────────────
    #[pallet::call]
    impl<T: Config> Pallet<T> {
        /// Governance directly sets a live parameter (skips auto-rule for one era).
        #[pallet::call_index(0)]
        #[pallet::weight(T::DbWeight::get().reads_writes(2, 1)
            .saturating_add(Weight::from_parts(40_000_000, 0)))]
        pub fn set_param(origin: OriginFor<T>, param: ParamId, value: u32) -> DispatchResult {
            T::GovernanceOrigin::ensure_origin(origin)?;
            Self::apply_param_checked(param, value)?;
            Self::deposit_event(Event::ParamSetByGovernance { param, value });
            Ok(())
        }

        /// Governance updates the bounds for a parameter.
        #[pallet::call_index(1)]
        #[pallet::weight(T::DbWeight::get().writes(1)
            .saturating_add(Weight::from_parts(20_000_000, 0)))]
        pub fn set_bounds(
            origin: OriginFor<T>,
            param: ParamId,
            bounds: ParamBounds,
        ) -> DispatchResult {
            T::GovernanceOrigin::ensure_origin(origin)?;
            match param {
                ParamId::CompletionFeeBps => CompletionFeeBounds::<T>::put(bounds.clone()),
                ParamId::Alpha => AlphaBounds::<T>::put(bounds.clone()),
                ParamId::Beta => BetaBounds::<T>::put(bounds.clone()),
                ParamId::FloorBps => FloorBpsBounds::<T>::put(bounds.clone()),
                ParamId::MinScoreEligibleResponses => MinScoreBounds::<T>::put(bounds.clone()),
                ParamId::EmissionVolumeAlphaBps => {
                    EmissionVolumeAlphaBounds::<T>::put(bounds.clone())
                }
            }
            Self::deposit_event(Event::BoundsUpdated { param, bounds });
            Ok(())
        }
    }

    // ─── Public helpers ───────────────────────────────────────────────────────
    impl<T: Config> Pallet<T> {
        /// Called by pallet-emissions settle_era after drain_era_maps.
        /// Fires all 3 autonomous rules within governance-set bounds.
        pub fn run_era_rules(metrics: EraMetrics) {
            Self::rule_ring_farming(&metrics);
            Self::rule_oracle_participation(&metrics);
            Self::rule_emission_concentration(&metrics);
        }

        /// AutoParamsProvider implementation helpers
        pub fn live_completion_fee_bps() -> u32 {
            CompletionFeeBps::<T>::get()
        }
        pub fn live_alpha() -> u32 {
            Alpha::<T>::get()
        }
        pub fn live_beta() -> u32 {
            Beta::<T>::get()
        }
        pub fn live_floor_bps() -> u32 {
            FloorBps::<T>::get()
        }
        pub fn live_min_score_eligible() -> u32 {
            MinScoreEligibleResponses::<T>::get()
        }
        pub fn live_emission_volume_alpha_bps() -> u32 {
            EmissionVolumeAlphaBps::<T>::get()
        }

        // ── Private rules ────────────────────────────────────────────────────

        fn rule_ring_farming(m: &EraMetrics) {
            if m.active_agents == 0 {
                return;
            }
            let ring_ratio = (m.ring_count as u64)
                .saturating_mul(10_000)
                .checked_div(m.active_agents as u64)
                .unwrap_or(0) as u32;
            let threshold = T::RingRatioThreshold::get();
            let current = CompletionFeeBps::<T>::get();
            if ring_ratio > threshold {
                if let Some(b) = CompletionFeeBounds::<T>::get() {
                    let new_val = current.saturating_add(b.max_step).min(b.max);
                    if new_val != current {
                        CompletionFeeBps::<T>::put(new_val);
                        Self::deposit_event(Event::ParamAutoAdjusted {
                            param: ParamId::CompletionFeeBps,
                            old_value: current,
                            new_value: new_val,
                            reason: AdjustReason::RingFarmingDetected,
                        });
                    }
                }
            } else if ring_ratio < threshold / 2 && current > 0 {
                if let Some(b) = CompletionFeeBounds::<T>::get() {
                    let initial = T::InitialCompletionFeeBps::get();
                    if current > initial {
                        let new_val = current.saturating_sub(b.max_step).max(initial).max(b.min);
                        if new_val != current {
                            CompletionFeeBps::<T>::put(new_val);
                            Self::deposit_event(Event::ParamAutoAdjusted {
                                param: ParamId::CompletionFeeBps,
                                old_value: current,
                                new_value: new_val,
                                reason: AdjustReason::RingFarmingSubsided,
                            });
                        }
                    }
                }
            }
        }

        fn rule_oracle_participation(m: &EraMetrics) {
            if m.era_total_questions < T::MinQuestionsForOracleRule::get() {
                return;
            }
            let success_rate = (m.era_finalized_questions as u64)
                .saturating_mul(10_000)
                .checked_div(m.era_total_questions as u64)
                .unwrap_or(0) as u32;
            let current = MinScoreEligibleResponses::<T>::get();
            if success_rate < T::OracleParticipationLowThreshold::get() {
                if let Some(b) = MinScoreBounds::<T>::get() {
                    let new_val = current.saturating_sub(b.max_step).max(b.min);
                    if new_val != current {
                        MinScoreEligibleResponses::<T>::put(new_val);
                        Self::deposit_event(Event::ParamAutoAdjusted {
                            param: ParamId::MinScoreEligibleResponses,
                            old_value: current,
                            new_value: new_val,
                            reason: AdjustReason::OracleParticipationLow,
                        });
                    }
                }
            } else if success_rate > T::OracleParticipationHighThreshold::get() {
                if let Some(b) = MinScoreBounds::<T>::get() {
                    let new_val = current.saturating_add(b.max_step).min(b.max);
                    if new_val != current {
                        MinScoreEligibleResponses::<T>::put(new_val);
                        Self::deposit_event(Event::ParamAutoAdjusted {
                            param: ParamId::MinScoreEligibleResponses,
                            old_value: current,
                            new_value: new_val,
                            reason: AdjustReason::OracleParticipationHigh,
                        });
                    }
                }
            }
        }

        fn rule_emission_concentration(m: &EraMetrics) {
            if m.active_agents < T::MinAgentsForConcentrationRule::get() {
                return;
            }
            if m.total_weight == 0 {
                return;
            }
            let concentration = (m.top_ten_pct_weight as u64)
                .saturating_mul(10_000)
                .checked_div(m.total_weight as u64)
                .unwrap_or(0) as u32;
            let current = Alpha::<T>::get();
            if concentration > T::ConcentrationHighThreshold::get() {
                if let Some(b) = AlphaBounds::<T>::get() {
                    let new_val = current.saturating_sub(b.max_step).max(b.min);
                    if new_val != current {
                        Alpha::<T>::put(new_val);
                        Self::deposit_event(Event::ParamAutoAdjusted {
                            param: ParamId::Alpha,
                            old_value: current,
                            new_value: new_val,
                            reason: AdjustReason::ConcentrationHigh,
                        });
                    }
                }
            } else if concentration < T::ConcentrationLowThreshold::get() {
                if let Some(b) = AlphaBounds::<T>::get() {
                    let new_val = current.saturating_add(b.max_step).min(b.max);
                    if new_val != current {
                        Alpha::<T>::put(new_val);
                        Self::deposit_event(Event::ParamAutoAdjusted {
                            param: ParamId::Alpha,
                            old_value: current,
                            new_value: new_val,
                            reason: AdjustReason::ConcentrationLow,
                        });
                    }
                }
            }
        }

        fn apply_param_checked(param: ParamId, value: u32) -> DispatchResult {
            let in_bounds = match param {
                ParamId::CompletionFeeBps => CompletionFeeBounds::<T>::get()
                    .map(|b| value >= b.min && value <= b.max)
                    .unwrap_or(true),
                ParamId::Alpha => AlphaBounds::<T>::get()
                    .map(|b| value >= b.min && value <= b.max)
                    .unwrap_or(true),
                ParamId::Beta => BetaBounds::<T>::get()
                    .map(|b| value >= b.min && value <= b.max)
                    .unwrap_or(true),
                ParamId::FloorBps => FloorBpsBounds::<T>::get()
                    .map(|b| value >= b.min && value <= b.max)
                    .unwrap_or(true),
                ParamId::MinScoreEligibleResponses => MinScoreBounds::<T>::get()
                    .map(|b| value >= b.min && value <= b.max)
                    .unwrap_or(true),
                ParamId::EmissionVolumeAlphaBps => EmissionVolumeAlphaBounds::<T>::get()
                    .map(|b| value >= b.min && value <= b.max)
                    .unwrap_or(true),
            };
            ensure!(in_bounds, Error::<T>::ValueOutOfBounds);
            match param {
                ParamId::CompletionFeeBps => CompletionFeeBps::<T>::put(value),
                ParamId::Alpha => Alpha::<T>::put(value),
                ParamId::Beta => Beta::<T>::put(value),
                ParamId::FloorBps => FloorBps::<T>::put(value),
                ParamId::MinScoreEligibleResponses => MinScoreEligibleResponses::<T>::put(value),
                ParamId::EmissionVolumeAlphaBps => EmissionVolumeAlphaBps::<T>::put(value),
            }
            Ok(())
        }
    }

    impl<T: Config> AutoParamsProvider for Pallet<T> {
        fn completion_fee_bps() -> u32 {
            CompletionFeeBps::<T>::get()
        }
        fn alpha() -> u32 {
            Alpha::<T>::get()
        }
        fn beta() -> u32 {
            Beta::<T>::get()
        }
        fn floor_bps() -> u32 {
            FloorBps::<T>::get()
        }
        fn min_score_eligible() -> u32 {
            MinScoreEligibleResponses::<T>::get()
        }
        fn emission_volume_alpha_bps() -> u32 {
            EmissionVolumeAlphaBps::<T>::get()
        }
        /// V4: F-02 — concrete dispatch to the era rules engine.
        fn run_era_rules(metrics: EraMetrics) {
            Self::run_era_rules(metrics);
        }
    }
}
