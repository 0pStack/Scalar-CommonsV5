//! # pallet-oracle v3.0
#![cfg_attr(not(feature = "std"), no_std)]
pub use pallet::*;

#[cfg(test)]
mod tests;

#[cfg(feature = "runtime-benchmarks")]
pub mod benchmarks;

#[frame_support::pallet]
pub mod pallet {
    // `create_oracle_request` takes the full request specification — mode,
    // quorum, threshold, both deadlines and the capability gate — and every one
    // is a per-request choice the caller must be able to make. The `#[pallet::call]`
    // macro re-emits that signature on the generated `Call` variant helper, which
    // no item-level `#[allow]` can reach, so the exemption has to sit at module
    // scope. Not restructured: an extrinsic's argument list is its encoding, and
    // changing it is a runtime-compatibility change, not lint hygiene.
    #![allow(clippy::too_many_arguments)]

    use crate::escrow_bridge::DisputeCallback;
    use crate::CapabilityChecker;
    use frame_support::{pallet_prelude::*, traits::ReservableCurrency};
    use frame_system::pallet_prelude::*;
    use pallet_agents::pallet as agents_pallet;
    use sp_runtime::traits::Saturating;
    use sp_std::vec::Vec;

    pub type BalanceOf<T> = pallet_agents::pallet::BalanceOf<T>;

    pub trait WeightInfo {
        fn create_oracle_request() -> Weight;
        fn submit_response() -> Weight;
        fn finalise_request() -> Weight;
        fn expire_request() -> Weight;
        fn batch_submit_response() -> Weight;
    }
    pub struct PlaceholderWeights;
    impl WeightInfo for PlaceholderWeights {
        fn create_oracle_request() -> Weight {
            Weight::from_parts(150000000, 0)
        }
        fn submit_response() -> Weight {
            Weight::from_parts(120000000, 0)
        }
        // Not the live declaration for `finalise_request`: `Config` has no
        // `WeightInfo`, and the extrinsic declares
        // `Pallet::finalise_request_worst_case_weight()`, which scales with
        // `MaxResponsesPerRequest`. This flat figure is ~60x below it. Wiring
        // `WeightInfo` into `Config` must not adopt this value as-is.
        fn finalise_request() -> Weight {
            Weight::from_parts(500000000, 0)
        }
        fn expire_request() -> Weight {
            Weight::from_parts(80000000, 0)
        }
        fn batch_submit_response() -> Weight {
            Weight::from_parts(70000000, 0)
        }
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
    pub enum ConsensusMode {
        Factual,
        Adversarial,
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
    pub enum OracleRequestStatus {
        Open,
        Collecting,
        Finalised,
    }

    #[derive(Clone, Encode, Decode, MaxEncodedLen, TypeInfo)]
    #[scale_info(skip_type_params(T))]
    pub struct OracleRequest<T: Config> {
        pub creator: T::AccountId,
        pub question_hash: [u8; 32],
        pub bounty: BalanceOf<T>,
        pub mode: ConsensusMode,
        pub min_responses: u32,
        pub consensus_threshold: u8,
        pub response_deadline: BlockNumberFor<T>,
        pub challenge_window: BlockNumberFor<T>,
        pub required_capability: Option<u32>,
        pub status: OracleRequestStatus,
        pub response_count: u32,
        pub dispute_context: Option<DisputeContext<T>>,
    }

    #[derive(Clone, Encode, Decode, MaxEncodedLen, TypeInfo, PartialEq, Eq)]
    #[scale_info(skip_type_params(T))]
    pub struct DisputeContext<T: Config> {
        pub buyer: T::AccountId,
        pub provider: T::AccountId,
        pub seq: u32,
    }

    #[pallet::config]
    pub trait Config: frame_system::Config + agents_pallet::Config {
        type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
        #[pallet::constant]
        type MinOracleBounty: Get<BalanceOf<Self>>;
        #[pallet::constant]
        type MaxOpenRequests: Get<u32>;
        #[pallet::constant]
        type MinChallengeWindow: Get<BlockNumberFor<Self>>;
        #[pallet::constant]
        type MinConsensusThreshold: Get<u8>;
        #[pallet::constant]
        type MaxResponsesPerRequest: Get<u32>;
        #[pallet::constant]
        type MaxBatchSubmissions: Get<u32>;
        type DisputeCallback: crate::escrow_bridge::DisputeCallback<
            Self::AccountId,
            BalanceOf<Self>,
        >;
        type CapabilityChecker: crate::CapabilityChecker<Self::AccountId>;
    }

    #[pallet::storage]
    pub type OracleRequests<T: Config> = CountedStorageMap<_, Identity, [u8; 32], OracleRequest<T>>;

    #[pallet::storage]
    pub type OracleResponses<T: Config> = StorageDoubleMap<
        _,
        Identity,
        [u8; 32],
        Blake2_128Concat,
        T::AccountId,
        [u8; 32],
        OptionQuery,
    >;

    #[pallet::storage]
    pub type OracleResults<T: Config> = StorageMap<_, Identity, [u8; 32], [u8; 32], OptionQuery>;

    #[pallet::storage]
    pub type OracleAccuracy<T: Config> = StorageDoubleMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        Twox64Concat,
        u32,
        (u32, u32),
        ValueQuery,
    >;

    #[pallet::storage]
    pub type OracleScore<T: Config> =
        StorageDoubleMap<_, Blake2_128Concat, T::AccountId, Twox64Concat, u32, u32, ValueQuery>;

    #[pallet::storage]
    pub type EraFinalisedQuestions<T: Config> = StorageValue<_, u32, ValueQuery>;

    #[pallet::storage]
    pub type EraTotalQuestions<T: Config> = StorageValue<_, u32, ValueQuery>;

    #[pallet::storage]
    pub type CapabilityQuestionCount<T: Config> = StorageMap<_, Twox64Concat, u32, u32, ValueQuery>;

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
        OracleRequestCreated {
            id: [u8; 32],
            creator: T::AccountId,
            bounty: BalanceOf<T>,
        },
        OracleResponseSubmitted {
            id: [u8; 32],
            agent: T::AccountId,
        },
        OracleRequestFinalised {
            id: [u8; 32],
            winning_hash: [u8; 32],
            respondents_paid: u32,
        },
        OracleRequestExpired {
            id: [u8; 32],
        },
        ScoreUpdated {
            agent: T::AccountId,
            capability: u32,
            new_score: u32,
        },
        BatchResponseSubmitted {
            agent: T::AccountId,
            accepted: u32,
            skipped: u32,
        },
    }

    #[pallet::error]
    pub enum Error<T> {
        NotRegistered,
        BountyTooLow,
        MaxOpenRequestsReached,
        InvalidConsensusThreshold,
        ChallengeTooShort,
        RequestNotFound,
        RequestAlreadyFinalised,
        AlreadyResponded,
        DeadlinePassed,
        RequestExpired,
        ChallengeWindowActive,
        InsufficientResponses,
        CapabilityNotRegistered,
        BatchEmpty,
        ResponseLimitReached,
        /// A request with this question_hash already exists.
        /// Prevents front-running attacks that overwrite existing requests
        /// and permanently lock the original creator's bounty reserve.
        DuplicateRequest,
    }

    // ── finalise_request worst-case weight (#223) ────────────────────────────
    //
    // `finalise_request` does work proportional to the number of responses under
    // the request, and `MaxResponsesPerRequest` bounds that number. The
    // declaration below is therefore built from the bound and from the
    // per-response storage operations the body actually performs, rather than
    // from one flat figure that happens to fit a typical request.
    //
    // The counts are audited from the other side by the `finalise_weight_`
    // tests in `tests.rs`, which run the extrinsic at the bound and compare the
    // storage this pallet actually changed against the same ledger.

    /// Storage reads `finalise_request` performs once per call in this pallet and
    /// in the currency, whatever the response count: the request entry and the
    /// `CountedStorageMap` counter it decrements, the block number the challenge
    /// window is checked against, the era-counter bump, and the creator's reserve
    /// the bounty is paid from.
    ///
    /// The dispute callback is counted separately, in
    /// `FINALISE_DISPUTE_CALLBACK_READS`, because it is another pallet's cost.
    pub const FINALISE_BASE_READS: u64 = 5;

    /// Storage writes `finalise_request` performs once per call in this pallet and
    /// in the currency: the accepted answer, the era counter, the request entry
    /// and its counter, and the creator's drawn-down reserve.
    pub const FINALISE_BASE_WRITES: u64 = 5;

    /// Allowance for `T::DisputeCallback::on_dispute_resolved`, which runs when the
    /// finalised request carries a `DisputeContext`.
    ///
    /// An *allowance*, not a count: `DisputeCallback` is an associated type, so
    /// this pallet cannot see what it costs, and the runtime's implementation —
    /// `pallet_escrow::settle_dispute_from_oracle` — fans out across three more
    /// pallets. Counting the runtime wiring gives, worst case: escrow's own ops
    /// ~6r/7w (`Agreements`, the slashed dispute fee, the treasury credit, the
    /// repatriation, `ActiveEscrowCount`, `DisputeToAgreement`,
    /// `ActiveAgreementCount`); `pallet_agents::add_era_escrow_volume` ~7r/5w;
    /// `maybe_promote` up to ~37r/2w, dominated by `OracleScoreGate::best_score`
    /// iterating one agent's `OracleScore` prefix (`MaxCapabilitiesPerAgent`, 32);
    /// and the orchestrator volume credit ~2r/1w. That is ~52r/15w, rounded up
    /// here.
    ///
    /// Rounded *up* deliberately. A wrong allowance in this direction overprices
    /// the ordinary, dispute-free finalisation by ~1.5 ms of declared weight; the
    /// other direction under-declares the one path that also carries the full
    /// per-response cost, which is the defect this whole declaration exists to
    /// close. The durable fix is for `DisputeCallback` to declare its own weight
    /// so the number stops being a hand-count that can drift — that is a trait
    /// change, tracked separately.
    pub const FINALISE_DISPUTE_CALLBACK_READS: u64 = 60;

    /// Write allowance for `T::DisputeCallback::on_dispute_resolved`. See
    /// `FINALISE_DISPUTE_CALLBACK_READS` for the derivation and for why it is
    /// rounded up rather than counted exactly.
    pub const FINALISE_DISPUTE_CALLBACK_WRITES: u64 = 20;

    /// Storage reads `finalise_request` performs for *each* response under the
    /// request: the `OracleResponses` entry the prefix iterator yields, the
    /// winner's account the bounty share is credited to, the two
    /// `OracleAccuracy` reads `update_accuracy` makes — one to tally, one to
    /// derive the score from the new tally — and the entry `clear_prefix`
    /// removes on cleanup.
    ///
    /// Counted per response because the work *is* per response. A request filled
    /// to `MaxResponsesPerRequest` performs all of it that many times, and block
    /// production budgets by the declared weight, not by what a call turns out
    /// to cost: a declaration priced for a typical request lets whoever fills a
    /// request to the bound buy execution the block never reserved, and enough
    /// such calls in one block push real execution past the block limit.
    pub const FINALISE_READS_PER_RESPONSE: u64 = 5;

    /// Storage writes `finalise_request` performs for each response: the
    /// winner's account, the `OracleAccuracy` tally, the `OracleScore` derived
    /// from it, and the `OracleResponses` entry removed on cleanup.
    pub const FINALISE_WRITES_PER_RESPONSE: u64 = 4;

    /// Non-DB execution cost of `finalise_request`, carried over unchanged from
    /// the flat declaration this replaced.
    ///
    /// Deliberately still flat, though the compute it covers is not: the loop
    /// deposits one `ScoreUpdated` event per response, clones an `AccountId` per
    /// response, and tallies distinct answers in `compute_factual_consensus` at
    /// `O(distinct²)`. #223 is a finding about the storage count, and turning
    /// this into a per-response figure without a benchmark to measure it would be
    /// a guess wearing a measurement's clothes — `benchmarks.rs` is an empty
    /// scaffold and `Config` has no `WeightInfo`, so there is no measurement path
    /// yet. What keeps the declaration a ceiling in the meantime is the DB term:
    /// at the bound it prices ~105 ms of storage against well under a millisecond
    /// of real compute. That slack is load-bearing, so it is stated rather than
    /// assumed — raising `MaxResponsesPerRequest` or growing the loop body should
    /// revisit it.
    pub const FINALISE_COMPUTE_WEIGHT: Weight = Weight::from_parts(500_000_000, 0);

    #[pallet::call]
    impl<T: Config> Pallet<T>
    where
        BalanceOf<T>: From<u32>,
    {
        #[pallet::call_index(0)]
        #[pallet::weight(T::DbWeight::get().reads_writes(3, 3)
            .saturating_add(Weight::from_parts(150_000_000, 0)))]
        pub fn create_oracle_request(
            origin: OriginFor<T>,
            question_hash: [u8; 32],
            bounty: BalanceOf<T>,
            mode: ConsensusMode,
            min_responses: u32,
            consensus_threshold: u8,
            response_deadline: BlockNumberFor<T>,
            challenge_window: BlockNumberFor<T>,
            required_capability: Option<u32>,
        ) -> DispatchResult {
            let creator = ensure_signed(origin)?;
            ensure!(
                agents_pallet::Pallet::<T>::is_agent(&creator),
                Error::<T>::NotRegistered
            );
            ensure!(
                bounty >= T::MinOracleBounty::get(),
                Error::<T>::BountyTooLow
            );
            ensure!(
                OracleRequests::<T>::count() < T::MaxOpenRequests::get(),
                Error::<T>::MaxOpenRequestsReached
            );
            ensure!(
                consensus_threshold <= 100,
                Error::<T>::InvalidConsensusThreshold
            );
            ensure!(
                consensus_threshold >= T::MinConsensusThreshold::get(),
                Error::<T>::InvalidConsensusThreshold
            );
            ensure!(
                challenge_window >= T::MinChallengeWindow::get(),
                Error::<T>::ChallengeTooShort
            );

            ensure!(
                !OracleRequests::<T>::contains_key(question_hash),
                Error::<T>::DuplicateRequest
            );
            <T as agents_pallet::Config>::Currency::reserve(&creator, bounty)?;
            OracleRequests::<T>::insert(
                question_hash,
                OracleRequest::<T> {
                    creator: creator.clone(),
                    question_hash,
                    bounty,
                    mode,
                    min_responses,
                    consensus_threshold,
                    response_deadline,
                    challenge_window,
                    required_capability,
                    status: OracleRequestStatus::Open,
                    response_count: 0,
                    dispute_context: None,
                },
            );
            EraTotalQuestions::<T>::mutate(|c| *c = c.saturating_add(1));
            Self::deposit_event(Event::OracleRequestCreated {
                id: question_hash,
                creator,
                bounty,
            });
            Ok(())
        }

        #[pallet::call_index(1)]
        #[pallet::weight(T::DbWeight::get().reads_writes(4, 3)
            .saturating_add(Weight::from_parts(80_000_000, 0)))]
        pub fn submit_response(
            origin: OriginFor<T>,
            request_id: [u8; 32],
            answer_hash: [u8; 32],
            capability: u32,
        ) -> DispatchResult {
            let agent = ensure_signed(origin)?;
            ensure!(
                agents_pallet::Pallet::<T>::is_agent(&agent),
                Error::<T>::NotRegistered
            );
            ensure!(
                OracleResponses::<T>::get(request_id, &agent).is_none(),
                Error::<T>::AlreadyResponded
            );

            OracleRequests::<T>::try_mutate(request_id, |maybe_req| -> DispatchResult {
                let req = maybe_req.as_mut().ok_or(Error::<T>::RequestNotFound)?;
                ensure!(
                    req.status == OracleRequestStatus::Open
                        || req.status == OracleRequestStatus::Collecting,
                    Error::<T>::RequestAlreadyFinalised
                );
                let now = frame_system::Pallet::<T>::block_number();
                ensure!(now <= req.response_deadline, Error::<T>::DeadlinePassed);
                ensure!(
                    req.response_count < T::MaxResponsesPerRequest::get(),
                    Error::<T>::ResponseLimitReached
                );
                if let Some(cap_id) = req.required_capability {
                    ensure!(
                        T::CapabilityChecker::agent_has_capability(&agent, cap_id),
                        Error::<T>::CapabilityNotRegistered
                    );
                    CapabilityQuestionCount::<T>::mutate(cap_id, |c| *c = c.saturating_add(1));
                }
                let _ = capability;
                OracleResponses::<T>::insert(request_id, &agent, answer_hash);
                req.response_count = req.response_count.saturating_add(1);
                req.status = OracleRequestStatus::Collecting;
                Ok(())
            })?;
            Self::deposit_event(Event::OracleResponseSubmitted {
                id: request_id,
                agent,
            });
            Ok(())
        }

        #[pallet::call_index(2)]
        #[pallet::weight(Pallet::<T>::finalise_request_worst_case_weight())]
        pub fn finalise_request(origin: OriginFor<T>, request_id: [u8; 32]) -> DispatchResult {
            ensure_signed(origin)?;
            let req = OracleRequests::<T>::get(request_id).ok_or(Error::<T>::RequestNotFound)?;
            ensure!(
                req.status == OracleRequestStatus::Collecting,
                Error::<T>::InsufficientResponses
            );
            let now = frame_system::Pallet::<T>::block_number();
            ensure!(
                now > req.response_deadline.saturating_add(req.challenge_window),
                Error::<T>::ChallengeWindowActive
            );
            ensure!(
                req.response_count >= req.min_responses,
                Error::<T>::InsufficientResponses
            );

            let responses: Vec<(T::AccountId, [u8; 32])> =
                OracleResponses::<T>::iter_prefix(request_id).collect();

            let (maybe_hash, winners, losers) = match req.mode {
                ConsensusMode::Factual => {
                    Self::compute_factual_consensus(&responses, req.consensus_threshold)
                }
                ConsensusMode::Adversarial => {
                    let all: Vec<_> = responses.iter().map(|(a, _)| a.clone()).collect();
                    let hash = Self::adversarial_result_hash(&responses);
                    (Some(hash), all, sp_std::vec![])
                }
            };
            let winning_hash = maybe_hash.unwrap_or([0u8; 32]);
            let consensus_reached = maybe_hash.is_some();
            let capability = req.required_capability.unwrap_or(0);
            let winner_count = winners.len() as u32;

            if winner_count > 0 && consensus_reached {
                let share = req
                    .bounty
                    .checked_div(&winner_count.into())
                    .unwrap_or_default();
                for winner in &winners {
                    let _ = <T as agents_pallet::Config>::Currency::repatriate_reserved(
                        &req.creator,
                        winner,
                        share,
                        frame_support::traits::tokens::BalanceStatus::Free,
                    );
                    Self::update_accuracy(winner, capability, true);
                }
            }
            for loser in &losers {
                Self::update_accuracy(loser, capability, false);
            }

            if consensus_reached {
                OracleResults::<T>::insert(request_id, winning_hash);
                EraFinalisedQuestions::<T>::mutate(|c| *c = c.saturating_add(1));
            } else {
                <T as agents_pallet::Config>::Currency::unreserve(&req.creator, req.bounty);
            }

            if let Some(ctx) = &req.dispute_context {
                let provider_wins_hash =
                    sp_io::hashing::blake2_256(crate::escrow_bridge::PROVIDER_WINS_PREIMAGE);
                let provider_wins = winning_hash == provider_wins_hash;
                let _ = T::DisputeCallback::on_dispute_resolved(
                    &ctx.buyer,
                    &ctx.provider,
                    ctx.seq,
                    provider_wins,
                );
            }

            OracleRequests::<T>::remove(request_id);
            let _ = OracleResponses::<T>::clear_prefix(request_id, 10_000, None);
            Self::deposit_event(Event::OracleRequestFinalised {
                id: request_id,
                winning_hash,
                respondents_paid: winner_count,
            });
            Ok(())
        }

        #[pallet::call_index(3)]
        #[pallet::weight(T::DbWeight::get().reads_writes(3, 2)
            .saturating_add(Weight::from_parts(80_000_000, 0)))]
        pub fn expire_request(origin: OriginFor<T>, request_id: [u8; 32]) -> DispatchResult {
            ensure_signed(origin)?;
            let req = OracleRequests::<T>::get(request_id).ok_or(Error::<T>::RequestNotFound)?;
            ensure!(
                req.status == OracleRequestStatus::Open
                    || (req.status == OracleRequestStatus::Collecting
                        && req.response_count < req.min_responses),
                Error::<T>::RequestAlreadyFinalised
            );
            let now = frame_system::Pallet::<T>::block_number();
            ensure!(now > req.response_deadline, Error::<T>::RequestExpired);
            <T as agents_pallet::Config>::Currency::unreserve(&req.creator, req.bounty);
            OracleRequests::<T>::remove(request_id);
            let _ = OracleResponses::<T>::clear_prefix(request_id, 10_000, None);
            Self::deposit_event(Event::OracleRequestExpired { id: request_id });
            Ok(())
        }

        #[pallet::call_index(4)]
        #[pallet::weight({
            let n = submissions.len().min(T::MaxBatchSubmissions::get() as usize) as u64;
            T::DbWeight::get().reads_writes(2 + n * 3, n * 2)
                .saturating_add(Weight::from_parts(50_000_000 + 70_000_000 * n, 0))
        })]
        pub fn batch_submit_response(
            origin: OriginFor<T>,
            submissions: BoundedVec<([u8; 32], [u8; 32], u32), T::MaxBatchSubmissions>,
        ) -> DispatchResult {
            let agent = ensure_signed(origin)?;
            ensure!(
                agents_pallet::Pallet::<T>::is_agent(&agent),
                Error::<T>::NotRegistered
            );
            ensure!(!submissions.is_empty(), Error::<T>::BatchEmpty);

            let mut accepted: u32 = 0;
            let mut skipped: u32 = 0;

            for (request_id, answer_hash, _capability) in submissions.iter() {
                let result: Result<(), DispatchError> =
                    OracleRequests::<T>::try_mutate(*request_id, |maybe_req| -> DispatchResult {
                        let req = maybe_req.as_mut().ok_or(Error::<T>::RequestNotFound)?;
                        ensure!(
                            req.status == OracleRequestStatus::Open
                                || req.status == OracleRequestStatus::Collecting,
                            Error::<T>::RequestAlreadyFinalised
                        );
                        let now = frame_system::Pallet::<T>::block_number();
                        ensure!(now <= req.response_deadline, Error::<T>::DeadlinePassed);
                        // Same per-request cap as `submit_response`: `finalise` walks every
                        // stored response, so an uncapped batch path would let work exceed the
                        // weight priced for a request.
                        ensure!(
                            req.response_count < T::MaxResponsesPerRequest::get(),
                            Error::<T>::ResponseLimitReached
                        );
                        ensure!(
                            OracleResponses::<T>::get(request_id, &agent).is_none(),
                            Error::<T>::AlreadyResponded
                        );
                        if let Some(cap_id) = req.required_capability {
                            ensure!(
                                T::CapabilityChecker::agent_has_capability(&agent, cap_id),
                                Error::<T>::CapabilityNotRegistered
                            );
                        }
                        OracleResponses::<T>::insert(request_id, &agent, answer_hash);
                        req.response_count = req.response_count.saturating_add(1);
                        req.status = OracleRequestStatus::Collecting;
                        Ok(())
                    });
                match result {
                    Ok(()) => accepted = accepted.saturating_add(1),
                    Err(_) => skipped = skipped.saturating_add(1),
                }
            }
            Self::deposit_event(Event::BatchResponseSubmitted {
                agent,
                accepted,
                skipped,
            });
            Ok(())
        }
    }

    impl<T: Config> Pallet<T> {
        /// Worst-case `(reads, writes)` `finalise_request` performs for a request
        /// that collected `responses` responses.
        ///
        /// The worst case is consensus reached with every respondent in the
        /// winning set *and* a `DisputeContext` present: each response is then
        /// both paid out of the bounty and rescored — strictly more storage work
        /// than a split where some respondents only get rescored — and the
        /// dispute callback runs on top. Both worst cases are priced
        /// unconditionally, so the figure holds for every input.
        pub fn finalise_request_db_ops(responses: u32) -> (u64, u64) {
            let n = responses as u64;
            (
                FINALISE_BASE_READS
                    .saturating_add(FINALISE_DISPUTE_CALLBACK_READS)
                    .saturating_add(FINALISE_READS_PER_RESPONSE.saturating_mul(n)),
                FINALISE_BASE_WRITES
                    .saturating_add(FINALISE_DISPUTE_CALLBACK_WRITES)
                    .saturating_add(FINALISE_WRITES_PER_RESPONSE.saturating_mul(n)),
            )
        }

        /// Declared weight for `finalise_request`, derived from
        /// `MaxResponsesPerRequest` instead of from a typical response count.
        ///
        /// Finalising a small request overpays, and that is the correct direction
        /// to err: the opposite error is a caller filling a request to the bound
        /// and being charged as if they had not.
        ///
        /// The invariant this rests on: every response `finalise_request` iterates
        /// arrived through `submit_response`, which refuses past
        /// `MaxResponsesPerRequest` with `ResponseLimitReached`, so the
        /// `OracleResponses` prefix for a live request holds at most that many
        /// entries. That is an invariant of the request lifecycle, not something
        /// storage enforces, and it is currently *not* airtight:
        /// `post_dispute_question_internal` inserts over its derived
        /// `question_hash` with no `DuplicateRequest` guard and without clearing
        /// the response prefix, so a request pre-created at a predicted dispute id
        /// can be overwritten with `response_count` reset to zero while its
        /// responses survive underneath. Closing that needs a guard in the dispute
        /// path rather than a bigger number here — tracked separately; noted so
        /// the declaration is not read as stronger than it is.
        pub fn finalise_request_worst_case_weight() -> Weight {
            let (reads, writes) = Self::finalise_request_db_ops(T::MaxResponsesPerRequest::get());
            T::DbWeight::get()
                .reads_writes(reads, writes)
                .saturating_add(FINALISE_COMPUTE_WEIGHT)
        }
    }

    impl<T: Config> Pallet<T>
    where
        BalanceOf<T>: From<u32>,
    {
        pub fn best_score(who: &T::AccountId) -> u32 {
            OracleScore::<T>::iter_prefix(who)
                .map(|(_, score)| score)
                .max()
                .unwrap_or(0)
        }

        pub fn post_dispute_question_internal(
            buyer: &T::AccountId,
            provider: &T::AccountId,
            seq: u32,
            bounty: BalanceOf<T>,
            deadline: BlockNumberFor<T>,
            capability: Option<u32>,
        ) -> Result<[u8; 32], DispatchError> {
            ensure!(
                OracleRequests::<T>::count() < T::MaxOpenRequests::get(),
                Error::<T>::MaxOpenRequestsReached
            );
            let mut preimage = buyer.encode();
            preimage.extend_from_slice(&provider.encode());
            preimage.extend_from_slice(&seq.to_le_bytes());
            let question_hash = sp_io::hashing::blake2_256(&preimage);
            <T as agents_pallet::Config>::Currency::reserve(buyer, bounty)?;
            OracleRequests::<T>::insert(
                question_hash,
                OracleRequest::<T> {
                    creator: buyer.clone(),
                    question_hash,
                    bounty,
                    mode: ConsensusMode::Factual,
                    min_responses: 3,
                    consensus_threshold: 67,
                    response_deadline: deadline,
                    challenge_window: T::MinChallengeWindow::get(),
                    required_capability: capability,
                    status: OracleRequestStatus::Open,
                    response_count: 0,
                    dispute_context: Some(DisputeContext {
                        buyer: buyer.clone(),
                        provider: provider.clone(),
                        seq,
                    }),
                },
            );
            EraTotalQuestions::<T>::mutate(|c| *c = c.saturating_add(1));
            Ok(question_hash)
        }

        pub fn drain_era_counters() -> (u32, u32) {
            (
                EraFinalisedQuestions::<T>::take(),
                EraTotalQuestions::<T>::take(),
            )
        }

        // Returns (consensus hash, agreeing agents, dissenting agents). Naming the
        // tuple would mean a public type for a private helper's return value; the
        // three components are already documented at both call sites.
        #[allow(clippy::type_complexity)]
        fn compute_factual_consensus(
            responses: &[(T::AccountId, [u8; 32])],
            threshold: u8,
        ) -> (Option<[u8; 32]>, Vec<T::AccountId>, Vec<T::AccountId>) {
            if responses.is_empty() {
                return (None, sp_std::vec![], sp_std::vec![]);
            }
            let mut counts: Vec<([u8; 32], u32)> = sp_std::vec![];
            for (_, hash) in responses {
                if let Some(entry) = counts.iter_mut().find(|(h, _)| h == hash) {
                    entry.1 = entry.1.saturating_add(1);
                } else {
                    counts.push((*hash, 1));
                }
            }
            let total = responses.len() as u32;
            let required = ((total as u64 * threshold as u64) / 100) as u32;
            let maybe_winning = counts
                .iter()
                .find(|(_, count)| *count >= required.max(1))
                .map(|(h, _)| *h);
            let mut winners = sp_std::vec![];
            let mut losers = sp_std::vec![];
            if let Some(winning_hash) = maybe_winning {
                for (agent, hash) in responses {
                    if *hash == winning_hash {
                        winners.push(agent.clone());
                    } else {
                        losers.push(agent.clone());
                    }
                }
                (Some(winning_hash), winners, losers)
            } else {
                for (agent, _) in responses {
                    losers.push(agent.clone());
                }
                (None, sp_std::vec![], losers)
            }
        }

        fn adversarial_result_hash(responses: &[(T::AccountId, [u8; 32])]) -> [u8; 32] {
            let mut hashes: Vec<[u8; 32]> = responses.iter().map(|(_, h)| *h).collect();
            hashes.sort();
            hashes.dedup();
            sp_io::hashing::blake2_256(&hashes.concat())
        }

        fn update_accuracy(who: &T::AccountId, capability: u32, correct: bool) {
            OracleAccuracy::<T>::mutate(who, capability, |(c, t)| {
                if correct {
                    *c = c.saturating_add(1);
                }
                *t = t.saturating_add(1);
            });
            let (correct_count, total) = OracleAccuracy::<T>::get(who, capability);
            let score = (correct_count as u64)
                .saturating_mul(10_000)
                .checked_div(total.max(1) as u64)
                .unwrap_or(0) as u32;
            OracleScore::<T>::insert(who, capability, score);
            Self::deposit_event(Event::ScoreUpdated {
                agent: who.clone(),
                capability,
                new_score: score,
            });
        }
    }

    impl<T: Config> pallet_agents::pallet::OracleScoreGate<T::AccountId> for Pallet<T>
    where
        BalanceOf<T>: From<u32>,
    {
        fn best_score(who: &T::AccountId) -> u32 {
            Pallet::<T>::best_score(who)
        }
    }

    impl<T: Config>
        crate::escrow_bridge::DisputeOracle<T::AccountId, BalanceOf<T>, BlockNumberFor<T>>
        for Pallet<T>
    where
        BalanceOf<T>: From<u32>,
    {
        fn post_dispute_question(
            buyer: &T::AccountId,
            provider: &T::AccountId,
            seq: u32,
            bounty: BalanceOf<T>,
            deadline: BlockNumberFor<T>,
            capability: Option<u32>,
        ) -> Result<[u8; 32], DispatchError> {
            Pallet::<T>::post_dispute_question_internal(
                buyer, provider, seq, bounty, deadline, capability,
            )
        }
    }
}

pub mod escrow_bridge {
    pub use pallet_escrow::dispute_hashes::PROVIDER_WINS_PREIMAGE;
    pub use pallet_escrow::DisputeCallback;
    pub use pallet_escrow::DisputeOracle;
}

pub trait CapabilityChecker<AccountId> {
    fn agent_has_capability(who: &AccountId, capability_id: u32) -> bool;
}
impl<AccountId> CapabilityChecker<AccountId> for () {
    fn agent_has_capability(_: &AccountId, _: u32) -> bool {
        true
    }
}
