//! # pallet-emissions v3.0
#![cfg_attr(not(feature = "std"), no_std)]
pub use pallet::*;

#[cfg(test)]
mod tests;

/// Issue #164 reproduction, against a mock carrying the LIVE runtime's emissions
/// constants rather than `tests.rs`'s round numbers. Separate module because a mock
/// runtime is per-module and the two need different constants.
#[cfg(test)]
mod tests_issue_164;

#[cfg(feature = "runtime-benchmarks")]
pub mod benchmarks;

#[frame_support::pallet]
pub mod pallet {
    use frame_support::{pallet_prelude::*, traits::Currency};
    use frame_system::pallet_prelude::*;
    use pallet_agents::pallet::{self as agents_pallet, integer_sqrt};
    use pallet_agents::AgentCollective;
    use pallet_auto_params::pallet::AutoParamsProvider;
    use sp_runtime::traits::{Saturating, UniqueSaturatedInto, Zero};
    use sp_std::vec::Vec;

    pub trait WeightInfo {
        fn settle_era() -> Weight;
        fn claim() -> Weight;
        fn batch_claim() -> Weight;
        fn set_era_emission_override() -> Weight;
    }
    pub struct PlaceholderWeights;
    impl WeightInfo for PlaceholderWeights {
        fn settle_era() -> Weight {
            Weight::from_parts(1000000000, 0)
        }
        fn claim() -> Weight {
            Weight::from_parts(90000000, 0)
        }
        fn batch_claim() -> Weight {
            Weight::from_parts(90000000, 0)
        }
        fn set_era_emission_override() -> Weight {
            Weight::from_parts(30000000, 0)
        }
    }

    pub const ACC_SCALE: u128 = 1u128 << 64;
    pub const BPS_SCALE: u128 = 10_000;
    pub const SCORE_SCALE: u128 = 10_000;

    pub type BalanceOf<T> =
        <<T as Config>::Currency as Currency<<T as frame_system::Config>::AccountId>>::Balance;

    pub trait OracleScoreProvider<AccountId> {
        fn best_score(who: &AccountId) -> u32;
    }
    impl<AccountId> OracleScoreProvider<AccountId> for () {
        fn best_score(_: &AccountId) -> u32 {
            0
        }
    }

    pub trait ValidatorCountProvider {
        fn active_validator_count() -> u32;
    }
    impl ValidatorCountProvider for () {
        fn active_validator_count() -> u32 {
            0
        }
    }

    pub trait OracleCounters {
        fn drain_era_counters() -> (u32, u32);
    }
    impl OracleCounters for () {
        fn drain_era_counters() -> (u32, u32) {
            (0, 0)
        }
    }

    pub trait OrchestratorEmissions<Balance: Copy> {
        fn compute_weights(multiplier: u32) -> (u128, u32);
        fn settle(orch_emission: Balance, orch_weight: u128);
    }
    impl<Balance: Copy + Default> OrchestratorEmissions<Balance> for () {
        fn compute_weights(_: u32) -> (u128, u32) {
            (0, 0)
        }
        fn settle(_: Balance, _: u128) {}
    }

    #[pallet::config]
    pub trait Config: frame_system::Config + agents_pallet::Config {
        type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;

        type Currency: Currency<Self::AccountId>;

        #[pallet::constant]
        type SupplyCap: Get<BalanceOf<Self>>;
        #[pallet::constant]
        type InitialEmissionsPerEra: Get<BalanceOf<Self>>;
        #[pallet::constant]
        type TargetEmissionPerAgent: Get<BalanceOf<Self>>;
        #[pallet::constant]
        type FloorEmissionPerEra: Get<BalanceOf<Self>>;
        #[pallet::constant]
        type EraDuration: Get<BlockNumberFor<Self>>;
        #[pallet::constant]
        type MaxBatchClaimSize: Get<u32>;
        #[pallet::constant]
        type OracleBonusBps: Get<u32>;
        #[pallet::constant]
        type MaxProposalsPerEra: Get<u32>;
        #[pallet::constant]
        type UnitVolume: Get<BalanceOf<Self>>;
        /// Minimum era escrow volume required to qualify for the floor emission.
        /// Agents below this threshold earn zero — not even floor weight.
        /// Set >= UnitVolume to ensure any ring deal is also large enough to qualify.
        /// Governance can raise this to increase the cost of sybil floor farming.
        /// At launch: set to 5 × UnitVolume (5,000 CMN) to require meaningful work.
        #[pallet::constant]
        type MinQualifyingVol: Get<BalanceOf<Self>>;
        /// Maximum additional weight an agent earns by deploying their full staked
        /// capital in escrow. At VelocityBonusBps=3000 an agent cycling their entire
        /// stake through escrow each era earns +30% weight vs an idle agent with the
        /// same stake. Velocity = era_vol / stake, scaled against MaxVolToStakeRatio.
        /// Set to 0 to disable the velocity bonus entirely.
        #[pallet::constant]
        type VelocityBonusBps: Get<u32>;
        // V4: GenesisAgentBonusBps and GenesisAgentBonusEras removed.
        // Replaced by per-agent onboarding_boost (10,000 bps for first 10 completions).
        #[pallet::constant]
        type MaxEmissionOverrideEras: Get<u32>;
        #[pallet::constant]
        type OrchestratorEmissionMultiplier: Get<u32>;

        type AutoParams: AutoParamsProvider;
        type OracleScoreProvider: OracleScoreProvider<Self::AccountId>;
        type OracleCounters: OracleCounters;
        type ValidatorCountProvider: ValidatorCountProvider;
        type OrchestratorEmissions: OrchestratorEmissions<BalanceOf<Self>>;
    }

    #[pallet::storage]
    pub type AccRewardPerStake<T: Config> = StorageValue<_, u128, ValueQuery>;

    #[pallet::storage]
    pub type AgentRewardDebt<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, u128, ValueQuery>;

    #[pallet::storage]
    pub type AgentWeightSnapshot<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, u128, ValueQuery>;

    #[pallet::storage]
    pub type LastEraEmission<T: Config> = StorageValue<_, BalanceOf<T>, ValueQuery>;

    #[pallet::storage]
    pub type EmissionOverrides<T: Config> =
        StorageMap<_, Twox64Concat, u32, BalanceOf<T>, OptionQuery>;

    /// V4: F-04 — tracks the last settled era to prevent double-mint.
    /// settle_era guards against being called twice in the same era.
    #[pallet::storage]
    pub type LastSettledEra<T: Config> = StorageValue<_, u32, OptionQuery>;

    /// Block number at which the current era started.
    /// Initialized at genesis (block 0) and updated each time drain_era_maps fires.
    /// Used by settle_era to prevent premature settlement: callers must wait
    /// at least EraDuration blocks after the era started before settling.
    #[pallet::storage]
    pub type EraStartBlock<T: Config> = StorageValue<_, BlockNumberFor<T>, ValueQuery>;

    const STORAGE_VERSION: StorageVersion = StorageVersion::new(1);
    #[pallet::pallet]
    #[pallet::storage_version(STORAGE_VERSION)]
    pub struct Pallet<T>(_);

    #[pallet::hooks]
    impl<T: Config> Hooks<BlockNumberFor<T>> for Pallet<T> {
        fn on_runtime_upgrade() -> Weight {
            Weight::zero()
        }
    }

    #[pallet::event]
    #[pallet::generate_deposit(pub(super) fn deposit_event)]
    pub enum Event<T: Config> {
        EraSettled {
            era: u32,
            total_emission: BalanceOf<T>,
            total_weight: u128,
        },
        NextEraScheduled {
            block: BlockNumberFor<T>,
            scheduled: bool,
        },
        EmissionOverrideSet {
            era: u32,
            amount: BalanceOf<T>,
        },
        RewardClaimed {
            agent: T::AccountId,
            amount: BalanceOf<T>,
        },
        CapReached {
            agent: T::AccountId,
        },
        /// spec 306, D7 (#164): the era's scheduled emission exceeded
        /// `alpha x qualifying_escrow_volume` and was reduced to it. `uncapped` is what the
        /// old agent-count schedule would have minted; the difference is what the ring
        /// would have taken. Appended LAST — event discriminants are indexer wire format.
        EmissionCappedByVolume {
            era: u32,
            uncapped: BalanceOf<T>,
            qualifying_volume: BalanceOf<T>,
            alpha_bps: u32,
        },
    }

    #[pallet::error]
    pub enum Error<T> {
        NotRegistered,
        NothingToClaim,
        ArithmeticOverflow,
        OverrideTooFarInFuture,
        OverrideAmountExceedsCap,
        /// V4: F-04 — settle_era already called for this era. Prevents double-mint.
        EraAlreadySettled,
        /// Era duration has not yet elapsed since the last settlement.
        /// Any signed account can call settle_era, but only after EraDuration blocks.
        EraNotDue,
    }

    #[pallet::call]
    impl<T: Config> Pallet<T>
    where
        BalanceOf<T>: From<u32>,
        u128: TryInto<BalanceOf<T>>,
    {
        #[pallet::call_index(0)]
        #[pallet::weight(T::DbWeight::get().reads_writes(5, 5)
            .saturating_add(Weight::from_parts(1_000_000_000, 0)))]
        pub fn settle_era(origin: OriginFor<T>) -> DispatchResult {
            // Permissionless: any registered agent (or anyone) can trigger settlement.
            // Economic incentive: all agents benefit from settlement — they are motivated
            // to call this. The double-settlement guard prevents abuse.
            ensure_signed(origin)?;

            let era = agents_pallet::EraNumber::<T>::get();
            let now = frame_system::Pallet::<T>::block_number();

            // Era timing gate: must wait at least EraDuration blocks since era started.
            // This prevents premature settlement within the same era.
            let era_start = EraStartBlock::<T>::get();
            ensure!(
                now >= era_start.saturating_add(T::EraDuration::get()),
                Error::<T>::EraNotDue
            );

            // V4: F-04 — double-settlement guard. Prevents double-mint in same era.
            ensure!(
                LastSettledEra::<T>::get().is_none_or(|last| era > last),
                Error::<T>::EraAlreadySettled
            );
            LastSettledEra::<T>::put(era);
            // Record the block this era settled as the start of the NEXT era.
            EraStartBlock::<T>::put(now);

            let agent_count = agents_pallet::AgentStake::<T>::count() as u128;
            // The pot BEFORE the D7 volume rule. Note what this is a function of:
            // agent COUNT and nothing else. That is the shape #164 exploited — 110 000 CMN
            // minted against ~120 CMN of gross escrow because 11 agents were registered,
            // whether or not any of them did anything. It is kept as the ceiling on the
            // schedule and then bounded by measured work below.
            let base_emission: BalanceOf<T> =
                if let Some(override_amount) = EmissionOverrides::<T>::take(era) {
                    override_amount
                } else {
                    let target: u128 = UniqueSaturatedInto::<u128>::unique_saturated_into(
                        T::TargetEmissionPerAgent::get(),
                    );
                    let floor: u128 = UniqueSaturatedInto::<u128>::unique_saturated_into(
                        T::FloorEmissionPerEra::get(),
                    );
                    let ceiling: u128 = UniqueSaturatedInto::<u128>::unique_saturated_into(
                        T::InitialEmissionsPerEra::get(),
                    );
                    let scaled = target.saturating_mul(agent_count).max(floor).min(ceiling);
                    scaled.try_into().unwrap_or(T::FloorEmissionPerEra::get())
                };

            let (era_finalized_q, era_total_q) = T::OracleCounters::drain_era_counters();

            let cached_alpha = T::AutoParams::alpha() as u128;
            let cached_beta = T::AutoParams::beta() as u128;
            let cached_floor = T::AutoParams::floor_bps() as u128;
            let cached_oracle_bonus_bps = T::OracleBonusBps::get() as u128;
            let cached_unit_vol: u128 =
                UniqueSaturatedInto::<u128>::unique_saturated_into(T::UnitVolume::get());
            // Fully qualified: pallet_agents::Config (a supertrait of this
            // pallet's Config) also declares MaxProposalsPerEra, so a bare
            // `T::MaxProposalsPerEra` is ambiguous (E0221). This pallet's own
            // constant is the intended one — the governance-participation
            // denominator for the emissions weight.
            let cached_max_props =
                (<T as crate::pallet::Config>::MaxProposalsPerEra::get() as u128).max(1);
            let cached_velocity_bps = T::VelocityBonusBps::get() as u128;
            // V4: Remove genesis cliff. Replace with per-agent onboarding_boost read inside loop.
            // Each agent gets 10,000 bps bonus for their first 10 completions, regardless of era.
            let current_era = agents_pallet::EraNumber::<T>::get();
            let _ = current_era; // retained for potential future era-aware logic

            let mut total_weight: u128 = 0;
            let mut top_weight_sum: u128 = 0;
            let mut all_weights: Vec<u128> = sp_std::vec![];
            // D7 (#164): the qualifying escrow volume this era, accumulated in the same
            // pass that computes weights so the rule costs no extra walk of AgentStake.
            // Must be summed BEFORE drain_era_maps, which clears the maps it reads.
            let mut qualifying_vol: u128 = 0;

            for (agent, stake) in agents_pallet::AgentStake::<T>::iter() {
                qualifying_vol = qualifying_vol.saturating_add(
                    UniqueSaturatedInto::<u128>::unique_saturated_into(
                        agents_pallet::Pallet::<T>::qualifying_volume_of(&agent),
                    ),
                );
                let stake_u128 = UniqueSaturatedInto::<u128>::unique_saturated_into(stake);
                // V4: onboarding_boost — 10,000 bps bonus for first 10 completions (any era).
                // Linearly decays: completion 1 = 10,000 bps, completion 10 = 1,000 bps, after = 0.
                // Completions read once here and passed into compute_weight_cached to avoid
                // a second storage read for the activity-gate check inside the function.
                let completions = agents_pallet::CompletedAgreements::<T>::get(&agent);
                let onboarding_boost: u128 = if completions < 10 {
                    10_000u128.saturating_sub(completions as u128 * 1_000u128)
                } else {
                    0u128
                };
                let w = Self::compute_weight_cached(
                    &agent,
                    stake_u128,
                    cached_alpha,
                    cached_beta,
                    cached_floor,
                    cached_oracle_bonus_bps,
                    cached_unit_vol,
                    cached_max_props,
                    onboarding_boost,
                    cached_velocity_bps,
                );
                if w > 0 {
                    AgentWeightSnapshot::<T>::insert(&agent, w);
                    total_weight = total_weight.saturating_add(w);
                    all_weights.push(w);
                } else {
                    // Zero weight this era means the snapshot must go, not linger.
                    //
                    // `do_claim` pays `(acc - debt) x weight_snapshot`. An agent that goes
                    // dormant keeps its last non-zero snapshot while being absent from
                    // `total_weight`, so `AccRewardPerStake` advances as if it were not
                    // there and then pays it anyway on its next claim. Total minted for an
                    // era becomes `emission x (1 + sum of dormant stale weights /
                    // total_weight)` — precisely the D7 invariant this round exists to
                    // establish, broken at the mint site rather than the accumulator. The
                    // supply cap always held; the per-era bound did not.
                    //
                    // Removing it forfeits any unclaimed prior-era reward for an agent that
                    // did nothing this era. That is the same conservative trade-off already
                    // made on slash (`on_slashed`) and on stake increase
                    // (`on_stake_changed`), and for the same reason: a snapshot that no
                    // longer describes the agent must not be used to pay it.
                    AgentWeightSnapshot::<T>::remove(&agent);
                }
            }

            // ── D7: emission <= alpha x qualifying escrow volume ─────────────────
            //
            // CLAUDE.md first principle #2 is "emissions reward verifiable work, not raw
            // stake". Until spec 306 the *split* honoured that and the *size* did not: the
            // pot was `TargetEmissionPerAgent x agent_count`, a number that never once
            // looks at whether anything was delivered. #164 turned that into 90 068 CMN for
            // 60 CMN of self-directed escrow — not by breaking any arithmetic, but because
            // an unbounded pot divided among the few accounts that cleared the gates hands
            // whoever shows up ~917 CMN per CMN of real work.
            //
            // The bound: an era may mint at most `alpha` times the QUALIFYING escrow volume
            // that era settled — what is left after the ring flag, the reciprocal-pair
            // test, declared funding lineage and each provider's stake ceiling have taken
            // their exclusions. At the launch alpha of 1.0 an era cannot mint more than
            // that number, and #164's exact shape now qualifies for nothing at all.
            //
            // What this is NOT, so nobody reads it as more than it is: a solution to wash
            // trading. The rule bounds *flow*, and flow can be recycled — a provider and an
            // unregistered buyer can settle escrow, transfer the funds straight back where
            // no pallet can see it, and settle again. The stake ceiling in
            // `qualifying_volume_of` is what stops that being free: sizing the pot costs
            // locked, slashable capital rather than a completion fee. That raises the price
            // of the attack by orders of magnitude; it does not reduce it to zero. The
            // residual is issue #167, written down rather than described away.
            //
            // (The completion fee is not a fixed number to price against, either: the
            // auto-params ring rule has been raising it on the live chain, 25 -> 50 -> 75
            // bps over successive era settlements, because it keeps detecting the very ring
            // it could not otherwise do anything about. That rule is now one input to
            // qualifying volume rather than the only response to a ring.)
            //
            // Applied to the override path too, deliberately. `set_era_emission_override`
            // is root, and the temptation is to let root out of the rule; but then the
            // invariant is not an invariant, and the lever for a deliberate bootstrap
            // subsidy already exists and is the honest one — governance raises alpha, on
            // chain, where it is visible, instead of quietly minting past the measurement.
            let emission: BalanceOf<T> = {
                let alpha_bps = T::AutoParams::emission_volume_alpha_bps() as u128;
                let base_u128: u128 =
                    UniqueSaturatedInto::<u128>::unique_saturated_into(base_emission);
                // Basis-point math: alpha_bps / 10 000 is the multiple of qualifying volume
                // an era may mint. 10 000 bps = 1.0x = "never more than the work measured".
                let vol_cap = qualifying_vol
                    .saturating_mul(alpha_bps)
                    .checked_div(BPS_SCALE)
                    .unwrap_or(0);
                if vol_cap < base_u128 {
                    Self::deposit_event(Event::EmissionCappedByVolume {
                        era,
                        uncapped: base_emission,
                        // Zero on a conversion failure, never the supply cap: "qualifying
                        // volume = 100B CMN" is the most misleading value this field could
                        // carry for an indexer auditing the bound.
                        qualifying_volume: qualifying_vol
                            .try_into()
                            .unwrap_or_else(|_| Zero::zero()),
                        alpha_bps: alpha_bps as u32,
                    });
                    // Falling back to `base_emission` would mean "failed to represent the
                    // cap, so mint the UNCAPPED amount" — the wrong default for a bound.
                    // Unreachable today (vol_cap < base_u128, and base_u128 came from a
                    // BalanceOf<T>), but a cap that cannot be computed must mint nothing.
                    vol_cap.try_into().unwrap_or_else(|_| Zero::zero())
                } else {
                    base_emission
                }
            };

            if !all_weights.is_empty() {
                all_weights.sort_unstable_by(|a, b| b.cmp(a));
                let top_n = (all_weights.len() / 10).max(1);
                top_weight_sum = all_weights.iter().take(top_n).sum();
            }

            // Drain era maps AFTER weight computation but before next era
            agents_pallet::Pallet::<T>::drain_era_maps(era);

            let orch_multiplier = T::OrchestratorEmissionMultiplier::get();
            let (orch_total_weight, _orch_count) =
                T::OrchestratorEmissions::compute_weights(orch_multiplier);
            total_weight = total_weight.saturating_add(orch_total_weight);

            if total_weight > 0 {
                let emu128: u128 = UniqueSaturatedInto::<u128>::unique_saturated_into(emission);
                if let Some(delta) = emu128
                    .checked_mul(ACC_SCALE)
                    .and_then(|x| x.checked_div(total_weight))
                {
                    AccRewardPerStake::<T>::mutate(|acc| *acc = acc.saturating_add(delta));
                }
            }

            if total_weight > 0 && orch_total_weight > 0 {
                let emu128: u128 = UniqueSaturatedInto::<u128>::unique_saturated_into(emission);
                let orch_share_u128 = emu128
                    .saturating_mul(orch_total_weight)
                    .checked_div(total_weight)
                    .unwrap_or(0);
                if let Ok(orch_share) = orch_share_u128.try_into() {
                    T::OrchestratorEmissions::settle(orch_share, orch_total_weight);
                }
            }

            LastEraEmission::<T>::put(emission);

            // V4: F-02 — run_era_rules is now called every era. Auto-params governs from era 1.
            // Previously: let _ = (era_finalized_q, era_total_q, top_weight_sum); // suppress
            T::AutoParams::run_era_rules(pallet_auto_params::pallet::EraMetrics {
                active_agents: agents_pallet::EraActiveSnapshot::<T>::get(),
                ring_count: agents_pallet::EraRingSnapshot::<T>::get(),
                era_finalized_questions: era_finalized_q,
                era_total_questions: era_total_q,
                total_weight,
                top_ten_pct_weight: top_weight_sum,
                active_validators: T::ValidatorCountProvider::active_validator_count(),
            });

            let next_era_block = now.saturating_add(T::EraDuration::get());
            Self::deposit_event(Event::NextEraScheduled {
                block: next_era_block,
                scheduled: false,
            });
            Self::deposit_event(Event::EraSettled {
                era,
                total_emission: emission,
                total_weight,
            });
            Ok(())
        }

        #[pallet::call_index(1)]
        #[pallet::weight(T::DbWeight::get().reads_writes(5, 3)
            .saturating_add(Weight::from_parts(80_000_000, 0)))]
        pub fn claim(origin: OriginFor<T>) -> DispatchResult {
            let who = ensure_signed(origin)?;
            let amount = Self::do_claim(&who)?;
            ensure!(!amount.is_zero(), Error::<T>::NothingToClaim);
            Ok(())
        }

        #[pallet::call_index(2)]
        #[pallet::weight({
            let k = agents.len().min(T::MaxBatchClaimSize::get() as usize) as u64;
            T::DbWeight::get().reads_writes(2 + k * 4, k * 2)
                .saturating_add(Weight::from_parts(200_000_000 + 80_000_000 * k, 0))
        })]
        pub fn batch_claim(origin: OriginFor<T>, agents: Vec<T::AccountId>) -> DispatchResult {
            ensure_signed(origin)?;
            for agent in agents.iter().take(T::MaxBatchClaimSize::get() as usize) {
                let _ = Self::do_claim(agent);
            }
            Ok(())
        }

        #[pallet::call_index(3)]
        #[pallet::weight(T::DbWeight::get().reads_writes(2, 1)
            .saturating_add(Weight::from_parts(30_000_000, 0)))]
        pub fn set_era_emission_override(
            origin: OriginFor<T>,
            target_era: u32,
            amount: BalanceOf<T>,
        ) -> DispatchResult {
            ensure_root(origin)?;
            let current_era = agents_pallet::EraNumber::<T>::get();
            let max_forward = T::MaxEmissionOverrideEras::get();
            ensure!(
                target_era > current_era && target_era <= current_era.saturating_add(max_forward),
                Error::<T>::OverrideTooFarInFuture
            );
            let supply_cap: u128 =
                UniqueSaturatedInto::<u128>::unique_saturated_into(T::SupplyCap::get());
            let amount_u128: u128 = UniqueSaturatedInto::<u128>::unique_saturated_into(amount);
            ensure!(
                amount_u128 <= supply_cap,
                Error::<T>::OverrideAmountExceedsCap
            );
            EmissionOverrides::<T>::insert(target_era, amount);
            Self::deposit_event(Event::EmissionOverrideSet {
                era: target_era,
                amount,
            });
            Ok(())
        }
    }

    impl<T: Config> agents_pallet::OnAgentRegistered<T::AccountId> for Pallet<T>
    where
        BalanceOf<T>: From<u32>,
        u128: TryInto<BalanceOf<T>>,
    {
        fn on_registered(who: &T::AccountId) {
            AgentRewardDebt::<T>::insert(who, AccRewardPerStake::<T>::get());
        }
    }

    impl<T: Config> agents_pallet::OnAgentSlashed<T::AccountId> for Pallet<T>
    where
        BalanceOf<T>: From<u32>,
        u128: TryInto<BalanceOf<T>>,
    {
        /// Zero the weight snapshot so do_claim() cannot overclaim using
        /// a pre-slash weight. The snapshot will be recalculated correctly
        /// in the next settle_era with the reduced stake.
        fn on_slashed(who: &T::AccountId) {
            AgentWeightSnapshot::<T>::remove(who);
        }
    }

    impl<T: Config> agents_pallet::OnStakeChanged<T::AccountId> for Pallet<T>
    where
        BalanceOf<T>: From<u32>,
        u128: TryInto<BalanceOf<T>>,
    {
        /// Zero the weight snapshot before stake increases.
        /// Prevents MasterChef overclaim: pending = delta × latest_weight applies the
        /// new (higher) weight retroactively to prior-era deltas.
        /// After zeroing, do_claim returns 0 until the next settle_era writes a
        /// fresh snapshot reflecting the new stake. The agent forfeits unclaimed
        /// rewards from the last era — a conservative trade-off for correctness.
        fn on_stake_changed(who: &T::AccountId) {
            AgentWeightSnapshot::<T>::remove(who);
        }
    }

    impl<T: Config> Pallet<T>
    where
        BalanceOf<T>: From<u32>,
        u128: TryInto<BalanceOf<T>>,
    {
        fn do_claim(who: &T::AccountId) -> Result<BalanceOf<T>, DispatchError> {
            ensure!(
                agents_pallet::AgentStake::<T>::contains_key(who),
                Error::<T>::NotRegistered
            );
            let acc = AccRewardPerStake::<T>::get();
            let debt = AgentRewardDebt::<T>::get(who);
            if acc <= debt {
                return Ok(Zero::zero());
            }
            let weight = AgentWeightSnapshot::<T>::get(who);
            if weight == 0 {
                return Ok(Zero::zero());
            }
            let delta = acc.saturating_sub(debt);
            let pending_u128 = delta
                .saturating_mul(weight)
                .checked_div(ACC_SCALE)
                .unwrap_or(0);
            AgentRewardDebt::<T>::insert(who, acc);
            if pending_u128 == 0 {
                return Ok(Zero::zero());
            }
            let supply_cap: u128 =
                UniqueSaturatedInto::<u128>::unique_saturated_into(T::SupplyCap::get());
            let total_issued: u128 = UniqueSaturatedInto::<u128>::unique_saturated_into(
                <T as Config>::Currency::total_issuance(),
            );
            let mintable = supply_cap.saturating_sub(total_issued).min(pending_u128);
            if mintable == 0 {
                Self::deposit_event(Event::CapReached { agent: who.clone() });
                return Ok(Zero::zero());
            }
            let amount: BalanceOf<T> = mintable
                .try_into()
                .map_err(|_| Error::<T>::ArithmeticOverflow)?;
            let _ = <T as Config>::Currency::deposit_creating(who, amount);
            Self::deposit_event(Event::RewardClaimed {
                agent: who.clone(),
                amount,
            });
            Ok(amount)
        }

        /// stake_u128: pre-converted stake value (avoids cross-pallet Balance type mismatch)
        //
        // The ten arguments are the emission weighting inputs themselves — stake,
        // rank, oracle accuracy, governance participation and the velocity bonus,
        // plus the era totals they are normalised against. Bundling them into a
        // params struct would hide which factors feed the weight, and the factor
        // list is exactly the thing first-principle #2 requires stay legible.
        // Silenced rather than restructured: a signature change here is an
        // economic-code change and belongs in its own reviewed round.
        #[allow(clippy::too_many_arguments)]
        fn compute_weight_cached(
            who: &T::AccountId,
            stake_u128: u128,
            alpha: u128,
            beta: u128,
            floor_bps: u128,
            oracle_bonus_bps: u128,
            unit_u128: u128,
            max_props: u128,
            onboarding_boost_bps: u128,
            velocity_bonus_bps: u128,
        ) -> u128 {
            let sqrt_stake = integer_sqrt(stake_u128);

            let rank = <T as agents_pallet::Config>::AgentCollective::rank_of(who).unwrap_or(0);
            let rank_bps: u128 = match rank {
                0 | 1 => 10_000,
                2 => 12_000,
                _ => 15_000,
            };

            let hb = agents_pallet::Pallet::<T>::heartbeat_multiplier(who);
            let has_heartbeat = hb >= 90;

            let vol_u128: u128 = UniqueSaturatedInto::<u128>::unique_saturated_into(
                agents_pallet::EraEscrowVolume::<T>::get(who),
            );
            let raw_vol = log2_scaled(vol_u128, unit_u128);
            let unique_buyers = agents_pallet::EraUniqueBuyers::<T>::get(who) as u128;
            let diversity_bps = diversity_score_bps(unique_buyers);
            let work_score = if raw_vol == 0 || diversity_bps == 0 {
                0
            } else {
                raw_vol.saturating_mul(diversity_bps) / SCORE_SCALE
            };

            // ERA-BASED activity gate (V4 fix: was lifetime completions >= 1).
            // Floor now requires actual escrow work THIS ERA, not just any past completion.
            // This closes the dilution attack: minimal agents doing 1 lifetime completion
            // to permanently farm the floor baseline weight while doing no ongoing work.
            // An agent must deliver real value each era to claim the floor share.
            let did_work_this_era = vol_u128 > 0;
            let is_active = did_work_this_era && has_heartbeat;
            // MinQualifyingVol gate: floor emission requires meaningful work, not just
            // the presence of any volume. This raises the cost of sybil ring farming —
            // agents must do at least 5× UnitVolume (5,000 CMN) in real escrow per era
            // to earn the floor share. Pure micro-ring deals below this threshold earn
            // nothing from floor, though they may still earn small work_score rewards.
            let min_qual: u128 =
                UniqueSaturatedInto::<u128>::unique_saturated_into(T::MinQualifyingVol::get());
            let qualifies_for_floor = is_active && (min_qual == 0 || vol_u128 >= min_qual);
            let effective_floor = if qualifies_for_floor { floor_bps } else { 0 };

            let gov_votes = agents_pallet::EraGovParticipation::<T>::get(who) as u128;
            let gov_score = gov_votes.min(max_props).saturating_mul(SCORE_SCALE) / max_props;

            // GOV SCORE GATING (V4 fix: was always additive).
            // Gov participation amplifies work-based weight but cannot substitute for it.
            // An agent with zero work_score earns zero from governance votes this era.
            // This closes the gov farming attack: spamming record_gov_vote without doing
            // any actual work no longer inflates weight by 4x.
            // Legitimate governance participants who also do work still get full benefit.
            let gov_contribution = if work_score > 0 {
                alpha.saturating_mul(gov_score) / SCORE_SCALE
            } else {
                0
            };

            let activity = (effective_floor
                .saturating_add(gov_contribution)
                .saturating_add(beta.saturating_mul(work_score) / SCORE_SCALE))
            .min(BPS_SCALE);

            let base_weight = sqrt_stake
                .saturating_mul(rank_bps)
                .checked_div(BPS_SCALE)
                .unwrap_or(0)
                .saturating_mul(activity)
                .checked_div(BPS_SCALE)
                .unwrap_or(0)
                .saturating_mul(hb)
                .checked_div(100)
                .unwrap_or(0);

            let weight_after_oracle = if oracle_bonus_bps > 0 {
                let oracle_score = T::OracleScoreProvider::best_score(who) as u128;
                let bonus = base_weight
                    .saturating_mul(oracle_score)
                    .checked_div(BPS_SCALE)
                    .unwrap_or(0)
                    .saturating_mul(oracle_bonus_bps)
                    .checked_div(BPS_SCALE)
                    .unwrap_or(0);
                base_weight.saturating_add(bonus)
            } else {
                base_weight
            };

            // Onboarding boost (first 10 completions get +100% weight).
            let after_onboarding = weight_after_oracle
                .saturating_mul(10_000u128.saturating_add(onboarding_boost_bps))
                .saturating_div(10_000);

            // Capital velocity bonus: agents that actively deploy their stake in escrow
            // earn up to VelocityBonusBps extra weight on top of their base weight.
            // velocity_ratio = era_vol / stake, capped at 1.0 (10000 bps).
            // Encourages productive use of locked capital rather than passive staking.
            if velocity_bonus_bps == 0 || stake_u128 == 0 {
                after_onboarding
            } else {
                let velocity_ratio = vol_u128
                    .saturating_mul(BPS_SCALE)
                    .checked_div(stake_u128)
                    .unwrap_or(0)
                    .min(BPS_SCALE);
                let bonus = after_onboarding
                    .saturating_mul(velocity_ratio)
                    .checked_div(BPS_SCALE)
                    .unwrap_or(0)
                    .saturating_mul(velocity_bonus_bps)
                    .checked_div(BPS_SCALE)
                    .unwrap_or(0);
                after_onboarding.saturating_add(bonus)
            }
        }
    }

    fn log2_scaled(vol: u128, unit: u128) -> u128 {
        if vol == 0 || unit == 0 {
            return 0;
        }
        let ratio = vol.saturating_mul(1_000_000).checked_div(unit).unwrap_or(0);
        if ratio == 0 {
            return 0;
        }
        let bits = (128u32 - ratio.leading_zeros()) as u128;
        bits.saturating_sub(19)
            .saturating_mul(SCORE_SCALE / 10)
            .min(SCORE_SCALE)
    }

    fn diversity_score_bps(unique_buyers: u128) -> u128 {
        match unique_buyers {
            0 => 0,
            1 => 1_000,
            2 => 3_000,
            3 => 6_000,
            4 => 8_000,
            _ => 10_000,
        }
    }
}
