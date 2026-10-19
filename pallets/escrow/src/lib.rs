//! # pallet-escrow v3.0
#![cfg_attr(not(feature = "std"), no_std)]
pub use pallet::*;

#[cfg(test)]
mod tests;

#[cfg(feature = "runtime-benchmarks")]
pub mod benchmarks;

pub trait DisputeOracle<AccountId, Balance, BlockNumber> {
    fn post_dispute_question(
        buyer: &AccountId,
        provider: &AccountId,
        seq: u32,
        bounty: Balance,
        deadline: BlockNumber,
        capability_id: Option<u32>,
    ) -> Result<[u8; 32], frame_support::pallet_prelude::DispatchError>;
}
impl<AccountId, Balance, BlockNumber> DisputeOracle<AccountId, Balance, BlockNumber> for () {
    fn post_dispute_question(
        _: &AccountId,
        _: &AccountId,
        _: u32,
        _: Balance,
        _: BlockNumber,
        _: Option<u32>,
    ) -> Result<[u8; 32], frame_support::pallet_prelude::DispatchError> {
        Ok([0u8; 32])
    }
}

pub trait DisputeCallback<AccountId, Balance> {
    fn on_dispute_resolved(
        buyer: &AccountId,
        provider: &AccountId,
        seq: u32,
        provider_wins: bool,
    ) -> frame_support::pallet_prelude::DispatchResult;
}
impl<AccountId, Balance> DisputeCallback<AccountId, Balance> for () {
    fn on_dispute_resolved(
        _: &AccountId,
        _: &AccountId,
        _: u32,
        _: bool,
    ) -> frame_support::pallet_prelude::DispatchResult {
        Ok(())
    }
}

pub mod dispute_hashes {
    pub const PROVIDER_WINS_PREIMAGE: &[u8] = b"scalar:dispute:provider_wins";
    pub const BUYER_WINS_PREIMAGE: &[u8] = b"scalar:dispute:buyer_wins";
}

#[frame_support::pallet]
pub mod pallet {
    use crate::DisputeOracle;
    use frame_support::{
        pallet_prelude::*,
        traits::{OnUnbalanced, ReservableCurrency},
    };
    use frame_system::pallet_prelude::*;
    use pallet_agents::pallet as agents_pallet;
    use sp_runtime::traits::{Saturating, Zero};

    /// Use agents' currency balance type to avoid cross-pallet type mismatches.
    pub type BalanceOf<T> = pallet_agents::pallet::BalanceOf<T>;

    pub trait WeightInfo {
        fn create_agreement() -> Weight;
        fn record_delivery() -> Weight;
        fn confirm_delivery() -> Weight;
        fn dispute_delivery() -> Weight;
        fn claim_refund() -> Weight;
        fn extend_deadline() -> Weight;
    }
    pub struct PlaceholderWeights;
    impl WeightInfo for PlaceholderWeights {
        fn create_agreement() -> Weight {
            Weight::from_parts(150000000, 0)
        }
        fn record_delivery() -> Weight {
            Weight::from_parts(100000000, 0)
        }
        fn confirm_delivery() -> Weight {
            Weight::from_parts(220000000, 0)
        }
        fn dispute_delivery() -> Weight {
            Weight::from_parts(300000000, 0)
        }
        fn claim_refund() -> Weight {
            Weight::from_parts(80000000, 0)
        }
        fn extend_deadline() -> Weight {
            Weight::from_parts(60000000, 0)
        }
    }

    #[derive(Clone, Copy, Encode, Decode, MaxEncodedLen, TypeInfo, Debug, PartialEq, Eq)]
    pub enum AgreementStatus {
        Created,
        Delivered,
        Disputed,
    }

    #[derive(Clone, Encode, Decode, MaxEncodedLen, TypeInfo, PartialEq, Eq)]
    #[scale_info(skip_type_params(T))]
    pub struct Agreement<T: Config> {
        pub amount: BalanceOf<T>,
        pub deliverable_hash: [u8; 32],
        pub deliver_by: BlockNumberFor<T>,
        pub created_at: BlockNumberFor<T>,
        pub status: AgreementStatus,
        pub delivery_proof: Option<[u8; 32]>,
        pub seq: u32,
        pub capability_id: Option<u32>,
        pub dispute_opened_at: Option<BlockNumberFor<T>>,
        pub dispute_request_id: Option<[u8; 32]>,
    }

    #[pallet::config]
    pub trait Config: frame_system::Config + agents_pallet::Config {
        type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
        #[pallet::constant]
        type MaxAgreementsPerPair: Get<u32>;
        #[pallet::constant]
        type MaxAgreementSpan: Get<BlockNumberFor<Self>>;
        #[pallet::constant]
        type MinAgreementAmount: Get<BalanceOf<Self>>;
        #[pallet::constant]
        type MinDeliveryBlocks: Get<BlockNumberFor<Self>>;
        #[pallet::constant]
        type BuyerResponseWindow: Get<BlockNumberFor<Self>>;
        #[pallet::constant]
        type DisputeTimeoutWindow: Get<BlockNumberFor<Self>>;
        #[pallet::constant]
        type DisputeResponseWindow: Get<BlockNumberFor<Self>>;
        #[pallet::constant]
        type DisputeBountyBps: Get<u32>;
        #[pallet::constant]
        type MinDisputeBounty: Get<BalanceOf<Self>>;
        #[pallet::constant]
        type DisputeBurnBps: Get<u32>;
        type DisputeOracle: crate::DisputeOracle<
            Self::AccountId,
            BalanceOf<Self>,
            BlockNumberFor<Self>,
        >;
        type DisputeCallback: crate::DisputeCallback<Self::AccountId, BalanceOf<Self>>;
        type CompletionFeeProvider: Get<u32>;
        /// V4: Receives the completion fee (25 bps of agreement value) each settlement.
        /// Set to Treasury in the runtime so fees fund governance proposals.
        /// () burns the fee (acceptable for tests, wrong for production).
        type FeeDestination: OnUnbalanced<
            <<Self as agents_pallet::Config>::Currency as frame_support::traits::Currency<
                Self::AccountId,
            >>::NegativeImbalance,
        >;
    }

    #[pallet::storage]
    pub type Agreements<T: Config> = StorageDoubleMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        Blake2_128Concat,
        T::AccountId,
        BoundedVec<Agreement<T>, T::MaxAgreementsPerPair>,
        ValueQuery,
    >;

    #[pallet::storage]
    pub type NextSeq<T: Config> = StorageDoubleMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        Blake2_128Concat,
        T::AccountId,
        u32,
        ValueQuery,
    >;

    #[pallet::storage]
    pub type DisputeToAgreement<T: Config> =
        StorageMap<_, Identity, [u8; 32], (T::AccountId, T::AccountId, u32), OptionQuery>;

    #[pallet::storage]
    pub type ActiveAgreementCount<T: Config> = StorageValue<_, u32, ValueQuery>;

    /// Agreements created but not yet accepted by their provider (E18).
    ///
    /// Presence of an entry means "created, not yet consented to": the buyer's funds are
    /// reserved, but the agreement does *not* occupy a slot in the provider's
    /// `ActiveEscrowCount` and so cannot pin its stake. Before this, any buyer could freeze
    /// any agent's entire stake indefinitely for the price of a refundable reserve, because
    /// `agents.request_unstake` refuses while that count is non-zero. An agreement must not
    /// bind a provider who never agreed to it.
    ///
    /// The polarity — absence means *accepted* — is what lets this ship with no migration:
    /// every agreement that predates this map has no entry and is grandfathered as accepted.
    /// A flag on `Agreement` would have been the obvious encoding and is exactly what we
    /// cannot do, because it changes an existing storage layout.
    ///
    /// Key: buyer → (provider, seq). Value: the block the agreement was created at.
    #[pallet::storage]
    pub type PendingAcceptance<T: Config> = StorageDoubleMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        Blake2_128Concat,
        (T::AccountId, u32),
        BlockNumberFor<T>,
        OptionQuery,
    >;

    /// Blocks added ON TOP of each status's own window before anyone may expire an
    /// agreement (E2). See `expire_agreement` for the per-status table.
    ///
    /// The grace period exists so a provider that delivers in the same block the deadline
    /// lands is not raced out of its payment by an expiry transaction. A pallet-level
    /// `const` rather than a `Config` type deliberately: this change does not touch
    /// `runtime/src/lib.rs`, so there is no runtime constant to add.
    pub const EXPIRY_GRACE: u32 = 10;

    /// Whether an agreement's provider has consented to it (E18).
    ///
    /// Every refund path classifies this *first*, before any timing arithmetic, because the
    /// two arms differ in one economically load-bearing way: only an accepted agreement ever
    /// entered the provider's `ActiveEscrowCount`, so only an accepted agreement may
    /// decrement it on the way out. Decrementing for a never-accepted agreement would take a
    /// slot belonging to the provider's real obligations and let it unstake while still owing
    /// delivery — the E18 hole reopened from the other side.
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub enum ConsentState {
        /// A `PendingAcceptance` entry exists: created, never accepted, provider's count
        /// never incremented. Exits via `cancel_pending`, `reject_agreement` or
        /// `expire_agreement` — never via `claim_refund`.
        Pending,
        /// No entry: the provider accepted, or the agreement predates `PendingAcceptance`
        /// and is grandfathered. The provider's count holds a slot that must be released.
        Accepted,
    }

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
        AgreementCreated {
            buyer: T::AccountId,
            provider: T::AccountId,
            seq: u32,
            amount: BalanceOf<T>,
        },
        DeliveryRecorded {
            provider: T::AccountId,
            buyer: T::AccountId,
            seq: u32,
            proof: [u8; 32],
        },
        DeliveryConfirmed {
            buyer: T::AccountId,
            provider: T::AccountId,
            seq: u32,
            amount: BalanceOf<T>,
        },
        DisputeOpened {
            buyer: T::AccountId,
            provider: T::AccountId,
            seq: u32,
            request_id: [u8; 32],
        },
        DisputeResolved {
            buyer: T::AccountId,
            provider: T::AccountId,
            seq: u32,
            provider_wins: bool,
        },
        RefundClaimed {
            buyer: T::AccountId,
            provider: T::AccountId,
            seq: u32,
            amount: BalanceOf<T>,
        },
        DeadlineExtended {
            buyer: T::AccountId,
            provider: T::AccountId,
            seq: u32,
            old_deadline: BlockNumberFor<T>,
            new_deadline: BlockNumberFor<T>,
        },
        /// The provider consented to a pending agreement, which is the moment it starts
        /// counting against the provider's `ActiveEscrowCount` (E18).
        AgreementAccepted {
            buyer: T::AccountId,
            provider: T::AccountId,
            seq: u32,
        },
        /// The provider declined an agreement it had not accepted; the buyer was refunded
        /// in full.
        AgreementRejected {
            buyer: T::AccountId,
            provider: T::AccountId,
            seq: u32,
            amount: BalanceOf<T>,
        },
        /// The buyer withdrew an agreement before the provider accepted it, so funds are
        /// never held hostage by a silent provider.
        PendingCancelled {
            buyer: T::AccountId,
            provider: T::AccountId,
            seq: u32,
            amount: BalanceOf<T>,
        },
        /// An agreement outlived its status's window plus `EXPIRY_GRACE` and was closed by
        /// any caller; the buyer was refunded in full (E2).
        AgreementExpired {
            buyer: T::AccountId,
            provider: T::AccountId,
            seq: u32,
            amount: BalanceOf<T>,
        },
    }

    #[pallet::error]
    pub enum Error<T> {
        SelfDeal,
        BuyerNotAgent,
        ProviderNotAgent,
        AmountTooLow,
        BilateralCapReached,
        SeqOverflow,
        AgreementNotFound,
        WrongStatus,
        DeadlinePassed,
        DeadlineTooEarly,
        DisputeTimeoutNotElapsed,
        MinDeliveryBlocksNotElapsed,
        NewDeadlineMustBeLater,
        DeadlineWouldExceedMaxSpan,
        /// The provider does not hold the capability the agreement requires (E1).
        ProviderLacksCapability,
        /// The requested deadline is further out than `MaxAgreementSpan` allows (E21).
        SpanTooLong,
        /// The provider has not consented to this agreement yet, so this path is closed to
        /// it (E18). A buyer holding a pending agreement should use `cancel_pending`, which
        /// is available immediately and refunds the same full amount.
        NotAccepted,
        /// The agreement is not awaiting acceptance — it was already accepted, or it
        /// predates `PendingAcceptance` and is grandfathered as accepted.
        NotPending,
        /// This status's own window plus `EXPIRY_GRACE` has not passed, so the agreement is
        /// not expirable yet. The window depends on the status — see `expire_agreement`.
        AgreementNotExpired,
    }

    #[pallet::call]
    impl<T: Config> Pallet<T>
    where
        BalanceOf<T>: From<u32>,
        <T as agents_pallet::Config>::Currency: ReservableCurrency<T::AccountId>,
    {
        #[pallet::call_index(0)]
        #[pallet::weight(T::DbWeight::get().reads_writes(6, 5)
            .saturating_add(Weight::from_parts(150_000_000, 0)))]
        pub fn create_agreement(
            origin: OriginFor<T>,
            provider: T::AccountId,
            #[pallet::compact] amount: BalanceOf<T>,
            deliverable_hash: [u8; 32],
            deliver_by: BlockNumberFor<T>,
            capability_id: Option<u32>,
        ) -> DispatchResult {
            let buyer = ensure_signed(origin)?;
            ensure!(buyer != provider, Error::<T>::SelfDeal);
            ensure!(
                agents_pallet::Pallet::<T>::is_agent(&buyer),
                Error::<T>::BuyerNotAgent
            );
            ensure!(
                agents_pallet::Pallet::<T>::is_agent(&provider),
                Error::<T>::ProviderNotAgent
            );
            ensure!(
                amount >= T::MinAgreementAmount::get(),
                Error::<T>::AmountTooLow
            );
            // E1: a buyer who names a required capability is paying for that skill, so the
            // provider must actually hold it. Checked before any reserve() below.
            ensure!(
                Self::provider_has_capability(&provider, capability_id),
                Error::<T>::ProviderLacksCapability
            );

            let now = frame_system::Pallet::<T>::block_number();
            ensure!(
                deliver_by > now.saturating_add(T::MinDeliveryBlocks::get()),
                Error::<T>::DeadlineTooEarly
            );
            // E21: reject, rather than silently clamp, a deadline beyond MaxAgreementSpan so
            // the buyer never locks funds against a deadline different from the one they signed.
            ensure!(
                deliver_by <= now.saturating_add(T::MaxAgreementSpan::get()),
                Error::<T>::SpanTooLong
            );

            let seq =
                NextSeq::<T>::try_mutate(&buyer, &provider, |s| -> Result<u32, DispatchError> {
                    let cur = *s;
                    *s = s.checked_add(1).ok_or(Error::<T>::SeqOverflow)?;
                    Ok(cur)
                })?;

            let agreement = Agreement::<T> {
                amount,
                deliverable_hash,
                deliver_by,
                created_at: now,
                status: AgreementStatus::Created,
                delivery_proof: None,
                seq,
                capability_id,
                dispute_opened_at: None,
                dispute_request_id: None,
            };
            Agreements::<T>::try_mutate(&buyer, &provider, |vec| {
                vec.try_push(agreement)
                    .map_err(|_| Error::<T>::BilateralCapReached)
            })?;

            <T as agents_pallet::Config>::Currency::reserve(&buyer, amount)?;
            // E18: the provider has not consented yet, so this agreement does not enter its
            // ActiveEscrowCount and cannot block its unstake. `accept_agreement` is what
            // increments the count. The agreement still occupies a bilateral slot, so
            // MaxAgreementsPerPair continues to bound how much a buyer can force open.
            PendingAcceptance::<T>::insert(&buyer, (provider.clone(), seq), now);
            ActiveAgreementCount::<T>::mutate(|c| *c = c.saturating_add(1));
            Self::deposit_event(Event::AgreementCreated {
                buyer,
                provider,
                seq,
                amount,
            });
            Ok(())
        }

        #[pallet::call_index(1)]
        #[pallet::weight(T::DbWeight::get().reads_writes(2, 1)
            .saturating_add(Weight::from_parts(80_000_000, 0)))]
        pub fn record_delivery(
            origin: OriginFor<T>,
            buyer: T::AccountId,
            seq: u32,
            delivery_hash: [u8; 32],
        ) -> DispatchResult {
            let provider = ensure_signed(origin)?;
            // E18: no delivery against an agreement the provider never consented to —
            // otherwise a provider could unilaterally turn an unwanted agreement into a
            // claim on the buyer's funds. Checked before any status write below.
            ensure!(
                Self::consent_state(&buyer, &provider, seq) == ConsentState::Accepted,
                Error::<T>::NotAccepted
            );
            Agreements::<T>::try_mutate(&buyer, &provider, |vec| {
                let a = vec
                    .iter_mut()
                    .find(|a| a.seq == seq)
                    .ok_or(Error::<T>::AgreementNotFound)?;
                ensure!(
                    a.status == AgreementStatus::Created,
                    Error::<T>::WrongStatus
                );
                // E1: the capability must still be held at delivery, not just at creation.
                ensure!(
                    Self::provider_has_capability(&provider, a.capability_id),
                    Error::<T>::ProviderLacksCapability
                );
                let now = frame_system::Pallet::<T>::block_number();
                ensure!(now <= a.deliver_by, Error::<T>::DeadlinePassed);
                ensure!(
                    now >= a.created_at.saturating_add(T::MinDeliveryBlocks::get()),
                    Error::<T>::MinDeliveryBlocksNotElapsed
                );
                a.status = AgreementStatus::Delivered;
                a.delivery_proof = Some(delivery_hash);
                Self::deposit_event(Event::DeliveryRecorded {
                    provider: provider.clone(),
                    buyer: buyer.clone(),
                    seq,
                    proof: delivery_hash,
                });
                Ok(())
            })
        }

        #[pallet::call_index(2)]
        #[pallet::weight(T::DbWeight::get().reads_writes(4, 4)
            .saturating_add(Weight::from_parts(120_000_000, 0)))]
        pub fn confirm_delivery(
            origin: OriginFor<T>,
            provider: T::AccountId,
            seq: u32,
        ) -> DispatchResult {
            let buyer = ensure_signed(origin)?;
            let mut settled_amount = BalanceOf::<T>::zero();
            Agreements::<T>::try_mutate(&buyer, &provider, |vec| {
                let idx = vec
                    .iter()
                    .position(|a| a.seq == seq)
                    .ok_or(Error::<T>::AgreementNotFound)?;
                ensure!(
                    vec[idx].status == AgreementStatus::Delivered,
                    Error::<T>::WrongStatus
                );
                let amount = vec[idx].amount;
                settled_amount = amount;
                let fee_bps = T::CompletionFeeProvider::get();
                let fee: BalanceOf<T> = if fee_bps > 0 {
                    amount
                        .saturating_mul(fee_bps.into())
                        .checked_div(&10_000u32.into())
                        .unwrap_or_default()
                } else {
                    Zero::zero()
                };
                let net = amount.saturating_sub(fee);
                <T as agents_pallet::Config>::Currency::repatriate_reserved(
                    &buyer,
                    &provider,
                    net,
                    frame_support::traits::tokens::BalanceStatus::Free,
                )?;
                if fee > Zero::zero() {
                    // V4: Route fee to Treasury via FeeDestination.
                    // Escrow funds are reserved (not locked), so slash_reserved is correct here.
                    // Note: use <T as ...>, not <Self as ...> — Self = Pallet<T> in function scope.
                    let (fee_imbalance, _) =
                        <T as agents_pallet::Config>::Currency::slash_reserved(&buyer, fee);
                    T::FeeDestination::on_unbalanced(fee_imbalance);
                }
                agents_pallet::Pallet::<T>::decrement_active_escrow(&provider);
                agents_pallet::Pallet::<T>::add_era_escrow_volume(&provider, &buyer, amount)?;
                ActiveAgreementCount::<T>::mutate(|c| *c = c.saturating_sub(1));
                vec.swap_remove(idx);
                Ok::<(), DispatchError>(())
            })?;
            Self::deposit_event(Event::DeliveryConfirmed {
                buyer,
                provider,
                seq,
                amount: settled_amount,
            });
            Ok(())
        }

        #[pallet::call_index(3)]
        #[pallet::weight(T::DbWeight::get().reads_writes(4, 3)
            .saturating_add(Weight::from_parts(200_000_000, 0)))]
        pub fn dispute_delivery(
            origin: OriginFor<T>,
            provider: T::AccountId,
            seq: u32,
        ) -> DispatchResult {
            let buyer = ensure_signed(origin)?;
            Agreements::<T>::try_mutate(&buyer, &provider, |vec| {
                let a = vec
                    .iter_mut()
                    .find(|a| a.seq == seq)
                    .ok_or(Error::<T>::AgreementNotFound)?;
                ensure!(
                    a.status == AgreementStatus::Delivered,
                    Error::<T>::WrongStatus
                );
                let now = frame_system::Pallet::<T>::block_number();
                let bounty_raw = a
                    .amount
                    .saturating_mul(T::DisputeBountyBps::get().into())
                    .checked_div(&10_000u32.into())
                    .unwrap_or_default();
                let bounty = bounty_raw.max(T::MinDisputeBounty::get());
                a.amount = a.amount.saturating_sub(bounty);
                a.status = AgreementStatus::Disputed;
                a.dispute_opened_at = Some(now);
                let deadline = now.saturating_add(T::DisputeResponseWindow::get());
                let request_id = T::DisputeOracle::post_dispute_question(
                    &buyer,
                    &provider,
                    seq,
                    bounty,
                    deadline,
                    a.capability_id,
                )?;
                a.dispute_request_id = Some(request_id);
                DisputeToAgreement::<T>::insert(request_id, (buyer.clone(), provider.clone(), seq));
                Self::deposit_event(Event::DisputeOpened {
                    buyer: buyer.clone(),
                    provider: provider.clone(),
                    seq,
                    request_id,
                });
                Ok(())
            })
        }

        #[pallet::call_index(4)]
        #[pallet::weight(T::DbWeight::get().reads_writes(3, 3)
            .saturating_add(Weight::from_parts(80_000_000, 0)))]
        pub fn claim_refund(
            origin: OriginFor<T>,
            provider: T::AccountId,
            seq: u32,
        ) -> DispatchResult {
            let buyer = ensure_signed(origin)?;
            let mut refund_amount = BalanceOf::<T>::zero();
            Agreements::<T>::try_mutate(&buyer, &provider, |vec| {
                let idx = vec
                    .iter()
                    .position(|a| a.seq == seq)
                    .ok_or(Error::<T>::AgreementNotFound)?;
                let a = &vec[idx];
                // E18, guard order is load-bearing: consent is classified before
                // eligibility. Past this point `claim_refund` is reachable only for an
                // accepted agreement, which is what makes the unconditional
                // `decrement_active_escrow` below sound — a never-accepted agreement never
                // held a slot in the provider's count, and releasing one would take it from
                // a real obligation and let the provider unstake while still owing delivery.
                //
                // Refusing rather than branching also gives the buyer an honest error:
                // `DisputeTimeoutNotElapsed` would say "wait longer", but waiting never makes
                // this path work for a pending agreement. `cancel_pending` is open to that
                // buyer right now for the same full amount, so this costs it nothing.
                ensure!(
                    Self::consent_state(&buyer, &provider, seq) == ConsentState::Accepted,
                    Error::<T>::NotAccepted
                );
                let now = frame_system::Pallet::<T>::block_number();
                let refundable = match a.status {
                    AgreementStatus::Created | AgreementStatus::Delivered => {
                        now > a.deliver_by.saturating_add(T::BuyerResponseWindow::get())
                    }
                    AgreementStatus::Disputed => {
                        let opened = a.dispute_opened_at.unwrap_or(a.created_at);
                        now >= opened.saturating_add(T::DisputeTimeoutWindow::get())
                    }
                };
                ensure!(refundable, Error::<T>::DisputeTimeoutNotElapsed);
                refund_amount = a.amount;
                <T as agents_pallet::Config>::Currency::unreserve(&buyer, refund_amount);
                agents_pallet::Pallet::<T>::decrement_active_escrow(&provider);
                if let Some(rid) = a.dispute_request_id {
                    DisputeToAgreement::<T>::remove(rid);
                }
                ActiveAgreementCount::<T>::mutate(|c| *c = c.saturating_sub(1));
                vec.swap_remove(idx);
                Ok::<(), DispatchError>(())
            })?;
            Self::deposit_event(Event::RefundClaimed {
                buyer,
                provider,
                seq,
                amount: refund_amount,
            });
            Ok(())
        }

        #[pallet::call_index(5)]
        #[pallet::weight(T::DbWeight::get().reads_writes(2, 1)
            .saturating_add(Weight::from_parts(60_000_000, 0)))]
        pub fn extend_deadline(
            origin: OriginFor<T>,
            provider: T::AccountId,
            seq: u32,
            new_deadline: BlockNumberFor<T>,
        ) -> DispatchResult {
            let buyer = ensure_signed(origin)?;
            Agreements::<T>::try_mutate(&buyer, &provider, |vec| {
                let a = vec
                    .iter_mut()
                    .find(|a| a.seq == seq)
                    .ok_or(Error::<T>::AgreementNotFound)?;
                ensure!(
                    a.status == AgreementStatus::Created,
                    Error::<T>::WrongStatus
                );
                ensure!(
                    new_deadline > a.deliver_by,
                    Error::<T>::NewDeadlineMustBeLater
                );
                // E21: the new deadline may never lie beyond MaxAgreementSpan from now.
                let now = frame_system::Pallet::<T>::block_number();
                ensure!(
                    new_deadline <= now.saturating_add(T::MaxAgreementSpan::get()),
                    Error::<T>::SpanTooLong
                );
                let absolute_max = a.created_at.saturating_add(T::MaxAgreementSpan::get());
                ensure!(
                    new_deadline <= absolute_max,
                    Error::<T>::DeadlineWouldExceedMaxSpan
                );
                let old_deadline = a.deliver_by;
                a.deliver_by = new_deadline;
                Self::deposit_event(Event::DeadlineExtended {
                    buyer: buyer.clone(),
                    provider: provider.clone(),
                    seq,
                    old_deadline,
                    new_deadline,
                });
                Ok(())
            })
        }

        /// Provider consents to a pending agreement (E18).
        ///
        /// Consent is what makes an agreement bind: only from here does it occupy a slot in
        /// the provider's `ActiveEscrowCount` and block its unstake. A buyer therefore can no
        /// longer pin an agent's stake by opening agreements the agent never agreed to.
        ///
        /// The E1 capability check runs again here because acceptance, not creation, is the
        /// provider's commitment to the skill: it must hold the capability at the moment it
        /// takes the job on. Accepting after `deliver_by` is refused — it would pin the
        /// provider's count for work that can no longer be delivered, and the agreement is
        /// already headed for expiry.
        #[pallet::call_index(6)]
        #[pallet::weight(T::DbWeight::get().reads_writes(4, 2)
            .saturating_add(Weight::from_parts(60_000_000, 0)))]
        pub fn accept_agreement(
            origin: OriginFor<T>,
            buyer: T::AccountId,
            seq: u32,
        ) -> DispatchResult {
            let provider = ensure_signed(origin)?;
            // Looked up under the signer's own key, so a stranger finds nothing.
            let agreement = Agreements::<T>::get(&buyer, &provider)
                .into_iter()
                .find(|a| a.seq == seq)
                .ok_or(Error::<T>::AgreementNotFound)?;
            // Guards first, all of them, before the count moves below.
            ensure!(
                Self::consent_state(&buyer, &provider, seq) == ConsentState::Pending,
                Error::<T>::NotPending
            );
            ensure!(
                Self::provider_has_capability(&provider, agreement.capability_id),
                Error::<T>::ProviderLacksCapability
            );
            let now = frame_system::Pallet::<T>::block_number();
            ensure!(now <= agreement.deliver_by, Error::<T>::DeadlinePassed);

            agents_pallet::Pallet::<T>::increment_active_escrow(&provider)?;
            PendingAcceptance::<T>::remove(&buyer, (provider.clone(), seq));
            Self::deposit_event(Event::AgreementAccepted {
                buyer,
                provider,
                seq,
            });
            Ok(())
        }

        /// Provider declines an agreement it never accepted; the buyer's reserve is released
        /// in full (E18).
        ///
        /// Valid only while pending, so it can never be used to walk away from a commitment
        /// already made — once accepted, the provider is bound and must deliver, be disputed,
        /// or let the agreement expire.
        #[pallet::call_index(7)]
        #[pallet::weight(T::DbWeight::get().reads_writes(3, 4)
            .saturating_add(Weight::from_parts(60_000_000, 0)))]
        pub fn reject_agreement(
            origin: OriginFor<T>,
            buyer: T::AccountId,
            seq: u32,
        ) -> DispatchResult {
            let provider = ensure_signed(origin)?;
            let amount = Self::close_pending(&buyer, &provider, seq)?;
            Self::deposit_event(Event::AgreementRejected {
                buyer,
                provider,
                seq,
                amount,
            });
            Ok(())
        }

        /// Buyer withdraws an agreement the provider has not accepted (E18).
        ///
        /// The buyer's counterpart to `reject_agreement`, and the reason refusing pending
        /// agreements from `claim_refund` costs a buyer nothing: this door is open
        /// immediately, with no deadline to wait out, and refunds the same full amount.
        #[pallet::call_index(8)]
        #[pallet::weight(T::DbWeight::get().reads_writes(3, 4)
            .saturating_add(Weight::from_parts(60_000_000, 0)))]
        pub fn cancel_pending(
            origin: OriginFor<T>,
            provider: T::AccountId,
            seq: u32,
        ) -> DispatchResult {
            let buyer = ensure_signed(origin)?;
            let amount = Self::close_pending(&buyer, &provider, seq)?;
            Self::deposit_event(Event::PendingCancelled {
                buyer,
                provider,
                seq,
                amount,
            });
            Ok(())
        }

        /// Closes an agreement nobody delivered on and refunds the buyer (E2).
        ///
        /// Permissionless by design, modelled on `oracle.expire_request`: an agreement whose
        /// provider goes silent previously had no exit that did not depend on the buyer, so a
        /// buyer that lost its key left funds reserved and the provider's count pinned
        /// forever. Per first principle 3, no economically essential path may depend on a
        /// privileged — or merely interested — caller, so any signed account may close a
        /// visibly dead agreement. There is nothing to extract by doing so: the refund always
        /// goes to the buyer of record, and expiry earns the provider no escrow volume, so it
        /// cannot be farmed for emissions weight.
        ///
        /// Reachable from EVERY status, but only past the window belonging to that status
        /// plus `EXPIRY_GRACE`:
        ///
        /// | status | opens at |
        /// |---|---|
        /// | `Created` | `deliver_by + EXPIRY_GRACE` |
        /// | `Delivered` | `deliver_by + BuyerResponseWindow + EXPIRY_GRACE` |
        /// | `Disputed` | `dispute_opened_at + DisputeTimeoutWindow + EXPIRY_GRACE` |
        ///
        /// The grace is added ON TOP of the buyer's own window in every case, so a buyer
        /// that is merely slow always has priority over a stranger closing its agreement,
        /// and a provider that did the work is never raced out of a payment it could still
        /// have received. Restricting this to `Created` is what let a silent buyer pin a
        /// provider's whole stake behind `ActiveEscrowCount > 0` forever — see
        /// `DESIGN-E18-E2.md` §8.1.
        #[pallet::call_index(9)]
        #[pallet::weight(T::DbWeight::get().reads_writes(4, 5)
            .saturating_add(Weight::from_parts(80_000_000, 0)))]
        pub fn expire_agreement(
            origin: OriginFor<T>,
            buyer: T::AccountId,
            provider: T::AccountId,
            seq: u32,
        ) -> DispatchResult {
            // Permissionless: the caller is authenticated but otherwise unprivileged, and
            // gains nothing from the call. Do not add an origin restriction here.
            ensure_signed(origin)?;
            let mut refund_amount = BalanceOf::<T>::zero();
            Agreements::<T>::try_mutate(&buyer, &provider, |vec| {
                let idx = vec
                    .iter()
                    .position(|a| a.seq == seq)
                    .ok_or(Error::<T>::AgreementNotFound)?;
                let agreement = &vec[idx];
                let now = frame_system::Pallet::<T>::block_number();
                // EVERY status gets a permissionless exit, each behind the window that
                // belongs to it, plus the grace.
                //
                // This was `status == Created` only, and that left the exact attack E18
                // exists to kill, relocated one step later: buyer creates the minimum
                // agreement, provider accepts (count = 1), provider records delivery, buyer
                // goes silent forever. `confirm_delivery`, `dispute_delivery` and
                // `claim_refund` are all buyer-signed, so nothing could close it — the
                // provider's ActiveEscrowCount never returned to 0 and `request_unstake`
                // refused permanently. A sacrificed 10 CMN reserve froze a >= 1 000 CMN
                // stake: better than 100:1 leverage for the attacker.
                //
                // It also inverted the thesis. With no exit from `Delivered`, a provider's
                // *risky* move was doing the work, because refusing to deliver let the
                // agreement expire and freed the slot. Emissions are supposed to reward
                // verifiable work; nothing should make delivering the dangerous option.
                //
                // WHAT THE WINDOWS BELOW DO AND DO NOT GUARANTEE.
                //
                // An earlier version of this comment claimed "each window is the buyer's
                // window PLUS EXPIRY_GRACE, so a buyer who is merely slow always has
                // priority". That is true for `Delivered` and `Disputed` and FALSE for
                // `Created`: there expiry opens at `deliver_by + GRACE` while the buyer's
                // `claim_refund` opens at `deliver_by + BuyerResponseWindow`, which is
                // later. So on an accepted-but-undelivered agreement a stranger can close
                // it before the buyer could have. Caught by the spec-conformance lens; the
                // code matches issue #180's amended table, so this was an overstated
                // comment rather than a wrong rule.
                //
                // That ordering is harmless, and the reason is the part worth keeping: the
                // refund goes to the BUYER OF RECORD whoever calls, and expiry earns the
                // caller nothing. A stranger who wins the race hands the buyer its own
                // money back and pays the fee for doing so. The buyer also keeps
                // `cancel_pending` (while pending) and `claim_refund` (once its window
                // opens) right up until the agreement is closed.
                //
                // So the honest statement is: expiry never moves value to anyone but the
                // buyer, and for the two statuses where a provider has done work it waits
                // for the buyer's own window first.
                let expiry_due = match agreement.status {
                    // Never delivered: the deadline plus grace is the whole story.
                    AgreementStatus::Created => {
                        agreement.deliver_by.saturating_add(EXPIRY_GRACE.into())
                    }
                    // Delivered and unanswered: the buyer had BuyerResponseWindow to
                    // confirm or dispute, and `claim_refund` opens at that point.
                    AgreementStatus::Delivered => agreement
                        .deliver_by
                        .saturating_add(T::BuyerResponseWindow::get())
                        .saturating_add(EXPIRY_GRACE.into()),
                    // Disputed and abandoned: the oracle's window, from when the dispute
                    // was opened. `expire_request` can unreserve the bounty and drop the
                    // request without ever calling back, which is how an agreement gets
                    // stranded in `Disputed` with only a buyer-signed door.
                    AgreementStatus::Disputed => agreement
                        .dispute_opened_at
                        .unwrap_or(agreement.created_at)
                        .saturating_add(T::DisputeTimeoutWindow::get())
                        .saturating_add(EXPIRY_GRACE.into()),
                };
                ensure!(now > expiry_due, Error::<T>::AgreementNotExpired);
                // Classified before any funds move, and stated as a match so the two cases
                // are named rather than left implicit in the order of the guards above.
                let consent = Self::consent_state(&buyer, &provider, seq);

                refund_amount = agreement.amount;
                <T as agents_pallet::Config>::Currency::unreserve(&buyer, refund_amount);
                match consent {
                    // Never accepted: the provider's count never held a slot for this
                    // agreement, so releasing one would steal it from a real obligation.
                    ConsentState::Pending => {
                        PendingAcceptance::<T>::remove(&buyer, (provider.clone(), seq));
                    }
                    // Accepted (or grandfathered): release the slot it occupied.
                    ConsentState::Accepted => {
                        agents_pallet::Pallet::<T>::decrement_active_escrow(&provider);
                    }
                }
                // A disputed agreement owns an oracle request mapping. Left behind it would
                // point at an agreement that no longer exists, so a later callback would
                // resolve nothing — `claim_refund` clears it for the same reason.
                if let Some(rid) = agreement.dispute_request_id {
                    DisputeToAgreement::<T>::remove(rid);
                }
                ActiveAgreementCount::<T>::mutate(|c| *c = c.saturating_sub(1));
                // Removal from `Agreements` is the once-only token: every refund door starts
                // by looking the agreement up here, so no second door can pay out again.
                vec.swap_remove(idx);
                Ok::<(), DispatchError>(())
            })?;
            Self::deposit_event(Event::AgreementExpired {
                buyer,
                provider,
                seq,
                amount: refund_amount,
            });
            Ok(())
        }
    }

    impl<T: Config> Pallet<T>
    where
        BalanceOf<T>: From<u32>,
        <T as agents_pallet::Config>::Currency: ReservableCurrency<T::AccountId>,
    {
        /// True when no capability is required, or the provider has it registered.
        /// Reads the agents pallet's `AgentCapabilities` list (the source `set_capability` maintains).
        fn provider_has_capability(provider: &T::AccountId, required: Option<u32>) -> bool {
            match required {
                None => true,
                Some(cap) => agents_pallet::AgentCapabilities::<T>::get(provider).contains(&cap),
            }
        }

        /// Single point of truth for "has the provider consented to this agreement?" (E18).
        ///
        /// Both refund paths that can meet an unconsented agreement — `claim_refund` and
        /// `expire_agreement` — classify through here, so the decision about the provider's
        /// `ActiveEscrowCount` is stated once, in one place, instead of emerging from the
        /// order the `ensure!`s happen to sit in. Absence of an entry reads as accepted,
        /// which is what grandfathers pre-upgrade agreements without a migration.
        fn consent_state(buyer: &T::AccountId, provider: &T::AccountId, seq: u32) -> ConsentState {
            if PendingAcceptance::<T>::contains_key(buyer, (provider.clone(), seq)) {
                ConsentState::Pending
            } else {
                ConsentState::Accepted
            }
        }

        /// Shared exit for `reject_agreement` and `cancel_pending`: release the buyer's
        /// reserve and close an agreement that is still pending.
        ///
        /// Valid only in the `ConsentState::Pending` arm, so the provider's count is
        /// deliberately left alone — it never held a slot for this agreement. Every `ensure!`
        /// runs before the `unreserve`.
        fn close_pending(
            buyer: &T::AccountId,
            provider: &T::AccountId,
            seq: u32,
        ) -> Result<BalanceOf<T>, DispatchError> {
            Agreements::<T>::try_mutate(buyer, provider, |vec| {
                let idx = vec
                    .iter()
                    .position(|a| a.seq == seq)
                    .ok_or(Error::<T>::AgreementNotFound)?;
                ensure!(
                    Self::consent_state(buyer, provider, seq) == ConsentState::Pending,
                    Error::<T>::NotPending
                );
                let amount = vec[idx].amount;
                <T as agents_pallet::Config>::Currency::unreserve(buyer, amount);
                PendingAcceptance::<T>::remove(buyer, (provider.clone(), seq));
                ActiveAgreementCount::<T>::mutate(|c| *c = c.saturating_sub(1));
                vec.swap_remove(idx);
                Ok(amount)
            })
        }

        pub fn settle_dispute_from_oracle(
            buyer: &T::AccountId,
            provider: &T::AccountId,
            seq: u32,
            provider_wins: bool,
        ) -> DispatchResult {
            Agreements::<T>::try_mutate(buyer, provider, |vec| {
                let idx = vec
                    .iter()
                    .position(|a| a.seq == seq)
                    .ok_or(Error::<T>::AgreementNotFound)?;
                let amount = vec[idx].amount;
                if provider_wins {
                    // DisputeBurnBps is a historical name — the amount is routed to
                    // Treasury (via FeeDestination), not actually burned. Kept as a
                    // public Config constant for backwards compatibility with governance
                    // tooling that references the name.
                    let dispute_fee_bps = T::DisputeBurnBps::get();
                    let dispute_fee: BalanceOf<T> = if dispute_fee_bps > 0 {
                        amount
                            .saturating_mul(dispute_fee_bps.into())
                            .checked_div(&10_000u32.into())
                            .unwrap_or_default()
                    } else {
                        Zero::zero()
                    };
                    let net = amount.saturating_sub(dispute_fee);
                    // Route dispute penalty to FeeDestination (Treasury), not burned.
                    // slash_reserved → NegativeImbalance → on_unbalanced keeps total_issuance neutral.
                    // Governance can direct collected dispute penalties via Track 1 spend proposals.
                    if dispute_fee > Zero::zero() {
                        let (fee_imbalance, _) =
                            <T as agents_pallet::Config>::Currency::slash_reserved(
                                buyer,
                                dispute_fee,
                            );
                        T::FeeDestination::on_unbalanced(fee_imbalance);
                    }
                    <T as agents_pallet::Config>::Currency::repatriate_reserved(
                        buyer,
                        provider,
                        net,
                        frame_support::traits::tokens::BalanceStatus::Free,
                    )?;
                    agents_pallet::Pallet::<T>::add_era_escrow_volume(provider, buyer, net)?;
                } else {
                    <T as agents_pallet::Config>::Currency::unreserve(buyer, amount);
                }
                agents_pallet::Pallet::<T>::decrement_active_escrow(provider);
                if let Some(rid) = vec[idx].dispute_request_id {
                    DisputeToAgreement::<T>::remove(rid);
                }
                ActiveAgreementCount::<T>::mutate(|c| *c = c.saturating_sub(1));
                vec.swap_remove(idx);
                Ok::<(), DispatchError>(())
            })?;
            Self::deposit_event(Event::DisputeResolved {
                buyer: buyer.clone(),
                provider: provider.clone(),
                seq,
                provider_wins,
            });
            Ok(())
        }
    }
}

impl<T: Config> crate::DisputeCallback<T::AccountId, pallet::BalanceOf<T>> for pallet::Pallet<T>
where
    pallet::BalanceOf<T>: From<u32>,
{
    fn on_dispute_resolved(
        buyer: &T::AccountId,
        provider: &T::AccountId,
        seq: u32,
        provider_wins: bool,
    ) -> frame_support::pallet_prelude::DispatchResult {
        pallet::Pallet::<T>::settle_dispute_from_oracle(buyer, provider, seq, provider_wins)
    }
}
