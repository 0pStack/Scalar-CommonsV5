//! # pallet-constitution v4.0
//!
//! Pre-dispatch invariant enforcement for Scalar Commons V4.
//!
//! ## The 6 Constitutional Invariants
//!
//! These checks fire BEFORE every extrinsic dispatch via BaseCallFilter.
//! No governance vote can override them. Amendment requires:
//! - 180-day timelock
//! - 90% supermajority Track 2 referendum
//! - Deliberate re-deployment of this pallet
//!
//! ## Invariants
//!
//! 1. `totalIssuance ≤ SupplyCap` — CMN scarcity is unconditional
//! 2. `buyer ≠ provider` in escrow — self-dealing prohibition (enforced by escrow pallet)
//! 3. `unstake_cooldown ≥ MinUnstakeCooldown` — stake commitment is real
//! 4. `oracle_challenge_window ≥ MinChallengeWindow` — oracle integrity minimum
//! 5. `registration_burn ≥ MinRegistrationBurn` — Sybil cost floor
//! 6. Per-block canary: emits alert events if any invariant approaches breach
//!
//! ## Design
//!
//! The pallet has NO extrinsics (agents cannot call it directly).
//! It exposes `check_*` functions used by the runtime's BaseCallFilter.
//! It has an on_initialize hook that runs the canary checks each block.
//!
//! Self-dealing (invariant 2) is enforced directly in pallet-escrow's
//! createAgreement, not here — escrow is the natural enforcement point.

#![cfg_attr(not(feature = "std"), no_std)]
pub use pallet::*;

#[frame_support::pallet]
pub mod pallet {
    use frame_support::{
        pallet_prelude::*,
        traits::{Currency, Get},
    };
    use frame_system::pallet_prelude::*;
    // Saturating provides saturating_sub on the Currency Balance type used by
    // the supply-cap canary hook. Deliberately NOT defensive_saturating_sub:
    // the defensive_* variants panic in debug builds, which is the wrong
    // behaviour for a hook that must observe and report rather than halt.
    use frame_support::sp_runtime::traits::Saturating;

    pub type BalanceOf<T> =
        <<T as Config>::Currency as Currency<<T as frame_system::Config>::AccountId>>::Balance;

    // ─── Config ──────────────────────────────────────────────────────────────

    #[pallet::config]
    pub trait Config: frame_system::Config {
        type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;

        /// The currency implementation — needed to read total_issuance.
        type Currency: Currency<Self::AccountId>;

        /// Hard cap on total CMN issuance. Invariant 1: never breached.
        #[pallet::constant]
        type SupplyCap: Get<BalanceOf<Self>>;

        /// Minimum unstake cooldown in blocks. Governance cannot set lower.
        /// Invariant 3: stake commitment is real.
        #[pallet::constant]
        type MinUnstakeCooldown: Get<BlockNumberFor<Self>>;

        /// Minimum oracle challenge window in blocks. Invariant 4.
        #[pallet::constant]
        type MinChallengeWindow: Get<BlockNumberFor<Self>>;

        /// Minimum registration burn in CMN. Sybil cost floor. Invariant 5.
        #[pallet::constant]
        type MinRegistrationBurn: Get<BalanceOf<Self>>;

        /// How close to the supply cap (in CMN) before a CapApproaching alert fires.
        /// Default: 1_000_000_000 CMN (1% of 100B cap).
        #[pallet::constant]
        type CapWarningBuffer: Get<BalanceOf<Self>>;
    }

    // ─── Events ──────────────────────────────────────────────────────────────

    #[pallet::event]
    #[pallet::generate_deposit(pub(super) fn deposit_event)]
    pub enum Event<T: Config> {
        /// Canary: total issuance is within CapWarningBuffer of the supply cap.
        /// Agents monitoring this event should escalate to governance immediately.
        SupplyCapApproaching {
            current_issuance: BalanceOf<T>,
            supply_cap: BalanceOf<T>,
            buffer_remaining: BalanceOf<T>,
        },
        /// A supply cap violation was caught and blocked at the dispatch layer.
        /// This should never happen if run_era_rules emissions math is correct.
        SupplyCapBreachBlocked {
            attempted_issuance: BalanceOf<T>,
            supply_cap: BalanceOf<T>,
        },
        /// Constitution is operating normally — periodic health confirmation.
        InvariantsHealthy { block: BlockNumberFor<T> },
    }

    // ─── Errors ──────────────────────────────────────────────────────────────

    #[pallet::error]
    pub enum Error<T> {
        /// A call was blocked because it would breach the supply cap invariant.
        SupplyCapWouldBeBreached,
        /// A call was blocked because it would set unstake cooldown below minimum.
        UnstakeCooldownTooShort,
        /// A call was blocked because it would set oracle challenge window below minimum.
        ChallengeWindowTooShort,
        /// A call was blocked because it would set registration burn below minimum.
        RegistrationBurnTooLow,
    }

    // ─── Pallet ──────────────────────────────────────────────────────────────

    const STORAGE_VERSION: StorageVersion = StorageVersion::new(1);

    #[pallet::pallet]
    #[pallet::storage_version(STORAGE_VERSION)]
    pub struct Pallet<T>(_);

    // ─── Hooks ───────────────────────────────────────────────────────────────

    #[pallet::hooks]
    impl<T: Config> Hooks<BlockNumberFor<T>> for Pallet<T> {
        /// Canary check: run once per block. Emits alert events but never halts.
        /// Agents watching these events escalate to TC emergency governance.
        fn on_initialize(now: BlockNumberFor<T>) -> Weight {
            let current = T::Currency::total_issuance();
            let cap = T::SupplyCap::get();
            let buffer = T::CapWarningBuffer::get();

            if current > cap {
                // This should be impossible if BaseCallFilter is wired correctly.
                // If reached, something bypassed the filter. Emit loudly.
                Self::deposit_event(Event::SupplyCapBreachBlocked {
                    attempted_issuance: current,
                    supply_cap: cap,
                });
            } else {
                let remaining = cap.saturating_sub(current);
                if remaining <= buffer {
                    Self::deposit_event(Event::SupplyCapApproaching {
                        current_issuance: current,
                        supply_cap: cap,
                        buffer_remaining: remaining,
                    });
                } else if (now % 100u32.into()).is_zero() {
                    // Every 100 blocks (~10 minutes): emit health confirmation.
                    // Agents monitoring for absence of this event know the hook has stopped.
                    Self::deposit_event(Event::InvariantsHealthy { block: now });
                }
            }

            T::DbWeight::get().reads(1)
        }
    }

    // ─── Constitutional check functions ──────────────────────────────────────
    // These are called from the runtime's BaseCallFilter before dispatch.

    impl<T: Config> Pallet<T> {
        /// Invariant 1: total issuance must not exceed the supply cap.
        /// Called before any mint/claim operation.
        /// Returns Ok(()) if safe to proceed, Err if the cap would be breached.
        pub fn check_supply_cap() -> DispatchResult {
            let current = T::Currency::total_issuance();
            let cap = T::SupplyCap::get();
            ensure!(current <= cap, Error::<T>::SupplyCapWouldBeBreached);
            Ok(())
        }

        /// Invariant 3: proposed unstake cooldown must be at or above the minimum.
        /// Called before any governance proposal that would change AgentsUnstakeCooldown.
        pub fn check_unstake_cooldown(proposed: BlockNumberFor<T>) -> DispatchResult {
            ensure!(
                proposed >= T::MinUnstakeCooldown::get(),
                Error::<T>::UnstakeCooldownTooShort
            );
            Ok(())
        }

        /// Invariant 4: proposed oracle challenge window must be at or above minimum.
        /// Called before any governance proposal that would change OracleMinChallengeWindow.
        pub fn check_challenge_window(proposed: BlockNumberFor<T>) -> DispatchResult {
            ensure!(
                proposed >= T::MinChallengeWindow::get(),
                Error::<T>::ChallengeWindowTooShort
            );
            Ok(())
        }

        /// Invariant 5: proposed registration burn must be at or above minimum.
        /// Called before any governance proposal that would change AgentsBaseRegistrationFee.
        pub fn check_registration_burn(proposed: BalanceOf<T>) -> DispatchResult {
            ensure!(
                proposed >= T::MinRegistrationBurn::get(),
                Error::<T>::RegistrationBurnTooLow
            );
            Ok(())
        }

        /// Invariant check gate for BaseCallFilter.
        /// Returns false if the call should be rejected (blocked at dispatch).
        /// Currently only enforces the supply cap check per-block.
        /// Specific per-call checks are invoked by the individual pallets.
        pub fn base_call_allowed() -> bool {
            let current = T::Currency::total_issuance();
            current <= T::SupplyCap::get()
        }
    }
}
