//! # pallet-orchestrator v3.0
#![cfg_attr(not(feature = "std"), no_std)]
pub use pallet::*;

#[cfg(test)]
mod tests;

#[cfg(feature = "runtime-benchmarks")]
pub mod benchmarks;

#[frame_support::pallet]
pub mod pallet {
    use frame_support::{pallet_prelude::*, traits::Currency};
    use frame_system::pallet_prelude::*;
    use pallet_agents::pallet as agents_pallet;
    use pallet_agents::AgentCollective;
    use sp_runtime::traits::{Saturating, UniqueSaturatedInto, Zero};

    pub type BalanceOf<T> = <<T as agents_pallet::Config>::Currency as Currency<
        <T as frame_system::Config>::AccountId,
    >>::Balance;

    pub const ACC_SCALE: u128 = 1u128 << 64;

    pub trait WeightInfo {
        fn register_orchestrator() -> Weight;
        fn propose_sub_agent_link() -> Weight;
        fn accept_orchestrator_link() -> Weight;
        fn remove_sub_agent_link() -> Weight;
        fn deregister_orchestrator() -> Weight;
        fn claim_orchestrator() -> Weight;
        fn decline_link_proposal() -> Weight;
        fn cancel_link_proposal() -> Weight;
    }
    pub struct PlaceholderWeights;
    impl WeightInfo for PlaceholderWeights {
        fn register_orchestrator() -> Weight {
            Weight::from_parts(80000000, 0)
        }
        fn propose_sub_agent_link() -> Weight {
            Weight::from_parts(60000000, 0)
        }
        fn accept_orchestrator_link() -> Weight {
            Weight::from_parts(80000000, 0)
        }
        fn remove_sub_agent_link() -> Weight {
            Weight::from_parts(70000000, 0)
        }
        fn deregister_orchestrator() -> Weight {
            Weight::from_parts(150000000, 0)
        }
        fn claim_orchestrator() -> Weight {
            Weight::from_parts(80000000, 0)
        }
        fn decline_link_proposal() -> Weight {
            Weight::from_parts(40000000, 0)
        }
        fn cancel_link_proposal() -> Weight {
            Weight::from_parts(40000000, 0)
        }
    }

    #[derive(Clone, Encode, Decode, MaxEncodedLen, TypeInfo, PartialEq, Eq)]
    #[scale_info(skip_type_params(T))]
    pub struct OrchestratorRecord<T: Config> {
        pub max_sub_agents: u32,
        pub fee_bps: u32,
        pub registered_at: BlockNumberFor<T>,
        pub active_sub_count: u32,
    }

    #[derive(Clone, Encode, Decode, MaxEncodedLen, TypeInfo, PartialEq, Eq)]
    #[scale_info(skip_type_params(T))]
    pub struct SubLinkRecord<T: Config> {
        pub linked_at: BlockNumberFor<T>,
        pub lifetime_volume: BalanceOf<T>,
    }

    #[pallet::config]
    pub trait Config: frame_system::Config + agents_pallet::Config {
        type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
        /// Ceiling on the `max_sub_agents` an orchestrator may declare at
        /// registration (runtime: 50). Enforced in `register_orchestrator`;
        /// without it the self-declared bound made the
        /// `active_sub_count < max_sub_agents` gate in `propose_sub_agent_link`
        /// a no-op.
        #[pallet::constant]
        type MaxSubAgentsPerOrchestrator: Get<u32>;
        #[pallet::constant]
        type MaxOrchestratorFeeBps: Get<u32>;
        /// Blocks a proposal stays acceptable. Note that expiry is only checked
        /// at accept time — expired entries are never reaped from
        /// `PendingLinkProposals`, so this bounds a proposal's *usefulness*, not
        /// its storage lifetime.
        #[pallet::constant]
        type LinkApprovalWindow: Get<BlockNumberFor<Self>>;
        /// Maximum open offers a single sub-agent can be made to hold
        /// (runtime: 20), enforced in `propose_sub_agent_link` against
        /// [`PendingProposalCount`]. This is the bound that makes a permissive
        /// propose safe; it is paired with `decline_link_proposal` so that
        /// reaching the cap cannot lock a sub-agent out permanently.
        #[pallet::constant]
        type MaxPendingProposals: Get<u32>;
        /// V4: Supply cap — orchestrator claims must not push total_issuance over this.
        /// Matches pallet_emissions::Config::SupplyCap.
        #[pallet::constant]
        type SupplyCap: Get<BalanceOf<Self>>;
    }

    #[pallet::storage]
    pub type OrchestratorRegistration<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, OrchestratorRecord<T>, OptionQuery>;

    #[pallet::storage]
    pub type SubAgentLinks<T: Config> = StorageDoubleMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        Blake2_128Concat,
        T::AccountId,
        SubLinkRecord<T>,
        OptionQuery,
    >;

    /// The single orchestrator a sub-agent is currently linked to.
    ///
    /// # Link exclusivity rule
    ///
    /// **A sub-agent has at most one orchestrator at a time.** This invariant is
    /// authoritative and is enforced in [`Pallet::accept_orchestrator_link`]:
    /// the presence of a key here rejects any further accept with
    /// `AlreadyLinked`. A link is cleared by `remove_sub_agent_link` (callable
    /// by either party) or by the orchestrator deregistering.
    ///
    /// `propose_sub_agent_link` is **permissive**: an offer may be queued for a
    /// sub-agent who is already linked to someone else. That supports
    /// pre-negotiated succession — an orchestrator can line up a relationship
    /// that begins when the sub-agent's current link ends — and it is safe only
    /// because the offer confers nothing on its own. Accept is where the
    /// invariant is enforced, and it is the *only* place it is enforced.
    ///
    /// So the rule, in full:
    ///
    /// | Stage | Behaviour |
    /// |---|---|
    /// | `propose_sub_agent_link` | permissive — any registered orchestrator may offer, linked or not, capped at [`Config::MaxPendingProposals`] per sub-agent |
    /// | `accept_orchestrator_link` | **exclusive** — rejects with `AlreadyLinked` if this key is set |
    ///
    /// Permissive propose is only tenable alongside the bound and the drains
    /// ([`PendingProposalCount`], `decline_link_proposal`,
    /// `cancel_link_proposal`); without them a linked sub-agent's inbox would
    /// grow without limit and they would have no way to clear it. History:
    /// ROUND8 failure 6 (the rule was undocumented, so code and test disagreed
    /// silently), ROUND8B (why it could not ship unbounded), ROUND9 (this).
    #[pallet::storage]
    pub type SubAgentToOrchestrator<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, T::AccountId, OptionQuery>;

    /// Open link offers, keyed `(orchestrator, sub_agent) -> expires_at`.
    ///
    /// **Bounded per sub-agent** at [`Config::MaxPendingProposals`], tracked by
    /// [`PendingProposalCount`]. The four paths that touch this map are:
    ///
    /// | Path | Effect on count |
    /// |---|---|
    /// | `propose_sub_agent_link` | `+1`, and only for a new `(orchestrator, sub_agent)` pair |
    /// | `accept_orchestrator_link` | `-1` via `remove_proposal` |
    /// | `decline_link_proposal` / `cancel_link_proposal` | `-1` via `remove_proposal` |
    /// | `deregister_orchestrator` | `-1` per drained row, drained to completion |
    ///
    /// Still no `on_idle`/`on_initialize` reaper: expiry is consulted only at
    /// accept, so an expired row keeps its slot until someone declines or
    /// cancels it. That is why both drains deliberately accept expired entries —
    /// otherwise expiry alone could wedge a sub-agent's inbox.
    ///
    /// Not bounded per *orchestrator*: one orchestrator may hold a slot on every
    /// agent, which is what makes `deregister_orchestrator`'s drain O(open
    /// proposals). See ROUND9.md.
    #[pallet::storage]
    pub type PendingLinkProposals<T: Config> = StorageDoubleMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        Blake2_128Concat,
        T::AccountId,
        BlockNumberFor<T>,
        OptionQuery,
    >;

    /// How many open proposals are currently held **against each sub-agent**.
    ///
    /// This is the quantity [`Config::MaxPendingProposals`] is enforced against,
    /// and it exists because the sub-agent is the party who cannot otherwise
    /// defend themselves: an orchestrator chooses who to propose to, but a
    /// sub-agent cannot stop offers arriving. Capping per sub-agent bounds the
    /// inbox; `decline_link_proposal` lets them drain it.
    ///
    /// Invariant: `PendingProposalCount[s]` equals the number of
    /// [`PendingLinkProposals`] entries whose second key is `s`. Every write to
    /// that map goes through exactly one of four paths, each of which maintains
    /// this counter — see the module's ROUND9 notes. Decrements use
    /// `saturating_sub` so that test fixtures which seed `PendingLinkProposals`
    /// directly (bypassing `propose_sub_agent_link`) cannot underflow it.
    #[pallet::storage]
    pub type PendingProposalCount<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, u32, ValueQuery>;

    #[pallet::storage]
    pub type EraOrchestratorVolume<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, BalanceOf<T>, ValueQuery>;

    #[pallet::storage]
    pub type OrchestratorRewardDebt<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, u128, ValueQuery>;

    #[pallet::storage]
    pub type OrchestratorWeightSnapshot<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, u128, ValueQuery>;

    #[pallet::storage]
    pub type OrchestratorGlobalAcc<T: Config> = StorageValue<_, u128, ValueQuery>;

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
        OrchestratorRegistered {
            who: T::AccountId,
            max_sub_agents: u32,
            fee_bps: u32,
        },
        LinkProposed {
            orchestrator: T::AccountId,
            sub_agent: T::AccountId,
            expires_at: BlockNumberFor<T>,
        },
        LinkAccepted {
            orchestrator: T::AccountId,
            sub_agent: T::AccountId,
        },
        LinkRemoved {
            orchestrator: T::AccountId,
            sub_agent: T::AccountId,
            by: T::AccountId,
        },
        /// A sub-agent refused an open offer, freeing one inbox slot.
        LinkProposalDeclined {
            orchestrator: T::AccountId,
            sub_agent: T::AccountId,
        },
        /// An orchestrator withdrew an offer they had made.
        LinkProposalCancelled {
            orchestrator: T::AccountId,
            sub_agent: T::AccountId,
        },
        OrchestratorDeregistered {
            who: T::AccountId,
            links_cleared: u32,
            /// Open proposals drained. Reported so the complete-drain fix is
            /// observable on chain rather than silent.
            proposals_cleared: u32,
        },
        OrchestratorRewardClaimed {
            orchestrator: T::AccountId,
            amount: BalanceOf<T>,
        },
    }

    #[pallet::error]
    pub enum Error<T> {
        NotRegistered,
        AlreadyRegistered,
        FeeTooHigh,
        AgentMustBeRank2,
        NotAnAgent,
        AlreadyLinked,
        NotLinked,
        SubAgentCapFull,
        ProposalExpired,
        ProposalNotFound,
        NotOrchestratorOrSubAgent,
        NothingToClaim,
        /// An orchestrator cannot link itself as its own sub-agent.
        SelfLink,
        /// This sub-agent already holds `MaxPendingProposals` open offers.
        /// They must decline one (or an orchestrator must cancel one) before a
        /// new offer can be queued. Bounds the storage a sub-agent can be made
        /// to carry now that `propose_sub_agent_link` is permissive.
        TooManyPendingProposals,
        /// `max_sub_agents` exceeds `MaxSubAgentsPerOrchestrator`.
        MaxSubAgentsTooHigh,
    }

    #[pallet::call]
    impl<T: Config> Pallet<T>
    where
        BalanceOf<T>: From<u32>,
        u128: TryInto<BalanceOf<T>>,
    {
        #[pallet::call_index(0)]
        #[pallet::weight(T::DbWeight::get().reads_writes(3, 2)
            .saturating_add(Weight::from_parts(80_000_000, 0)))]
        pub fn register_orchestrator(
            origin: OriginFor<T>,
            max_sub_agents: u32,
            fee_bps: u32,
        ) -> DispatchResult {
            let who = ensure_signed(origin)?;
            ensure!(
                agents_pallet::Pallet::<T>::is_agent(&who),
                Error::<T>::NotAnAgent
            );
            ensure!(
                !OrchestratorRegistration::<T>::contains_key(&who),
                Error::<T>::AlreadyRegistered
            );
            ensure!(
                fee_bps <= T::MaxOrchestratorFeeBps::get(),
                Error::<T>::FeeTooHigh
            );
            // max_sub_agents is caller-supplied and, until ROUND9, was validated
            // against nothing — an orchestrator could register with u32::MAX and
            // the `active_sub_count < max_sub_agents` gate below became a no-op.
            ensure!(
                max_sub_agents <= T::MaxSubAgentsPerOrchestrator::get(),
                Error::<T>::MaxSubAgentsTooHigh
            );

            let rank = <T as agents_pallet::Config>::AgentCollective::rank_of(&who).unwrap_or(0);
            ensure!(rank >= 2u32, Error::<T>::AgentMustBeRank2);

            let now = frame_system::Pallet::<T>::block_number();
            OrchestratorRegistration::<T>::insert(
                &who,
                OrchestratorRecord {
                    max_sub_agents,
                    fee_bps,
                    registered_at: now,
                    active_sub_count: 0,
                },
            );
            let acc = OrchestratorGlobalAcc::<T>::get();
            OrchestratorRewardDebt::<T>::insert(&who, acc);

            Self::deposit_event(Event::OrchestratorRegistered {
                who,
                max_sub_agents,
                fee_bps,
            });
            Ok(())
        }

        /// Offer a link to `sub_agent`. The offer must be accepted by the
        /// sub-agent to take effect — proposing alone links nothing.
        ///
        /// **Permissive**, per the link exclusivity rule (see
        /// [`SubAgentToOrchestrator`]): the sub-agent may already be linked to
        /// another orchestrator. The offer simply waits, and can be taken up if
        /// and when that link ends. Exclusivity is enforced solely at accept.
        ///
        /// Bounded by [`Config::MaxPendingProposals`] per sub-agent, so a
        /// permissive propose cannot be used to bloat someone's inbox; the
        /// sub-agent reclaims slots with `decline_link_proposal` and the
        /// orchestrator with `cancel_link_proposal`. Re-proposing an existing
        /// pair refreshes its expiry without consuming a second slot.
        #[pallet::call_index(1)]
        #[pallet::weight(T::DbWeight::get().reads_writes(4, 2)
            .saturating_add(Weight::from_parts(60_000_000, 0)))]
        pub fn propose_sub_agent_link(
            origin: OriginFor<T>,
            sub_agent: T::AccountId,
        ) -> DispatchResult {
            let orchestrator = ensure_signed(origin)?;
            ensure!(
                OrchestratorRegistration::<T>::contains_key(&orchestrator),
                Error::<T>::NotRegistered
            );
            // An orchestrator cannot link itself as its own sub-agent.
            // Self-linking would let a single account earn both agent emissions
            // and orchestrator emissions from the same escrow volume.
            ensure!(orchestrator != sub_agent, Error::<T>::SelfLink);
            ensure!(
                agents_pallet::Pallet::<T>::is_agent(&sub_agent),
                Error::<T>::NotAnAgent
            );
            // NOTE: there is deliberately no AlreadyLinked check here. Propose is
            // permissive — see SubAgentToOrchestrator. An offer to an already-
            // linked sub-agent is legitimate (pre-negotiated succession) and
            // confers nothing; accept_orchestrator_link is the sole enforcement
            // point for exclusivity, and the cap below is what keeps a permissive
            // propose from becoming a storage-exhaustion vector.

            let record = OrchestratorRegistration::<T>::get(&orchestrator)
                .ok_or(Error::<T>::NotRegistered)?;
            ensure!(
                record.active_sub_count < record.max_sub_agents,
                Error::<T>::SubAgentCapFull
            );

            // Re-proposing an existing (orchestrator, sub_agent) pair overwrites a
            // single key: it adds no entry, so it must neither be refused by the
            // cap nor double-count. Only a genuinely new pair does either. This
            // keeps "refresh my expiring offer" working even at a full inbox.
            let is_new_pair = !PendingLinkProposals::<T>::contains_key(&orchestrator, &sub_agent);
            if is_new_pair {
                ensure!(
                    PendingProposalCount::<T>::get(&sub_agent) < T::MaxPendingProposals::get(),
                    Error::<T>::TooManyPendingProposals
                );
            }

            let now = frame_system::Pallet::<T>::block_number();
            let expires_at = now.saturating_add(T::LinkApprovalWindow::get());
            PendingLinkProposals::<T>::insert(&orchestrator, &sub_agent, expires_at);
            if is_new_pair {
                PendingProposalCount::<T>::mutate(&sub_agent, |c| *c = c.saturating_add(1));
            }

            Self::deposit_event(Event::LinkProposed {
                orchestrator,
                sub_agent,
                expires_at,
            });
            Ok(())
        }

        /// Accept a pending offer from `orchestrator`, forming the link.
        ///
        /// **This is the authoritative enforcement point for link exclusivity**
        /// (see [`SubAgentToOrchestrator`]): a sub-agent already linked to
        /// anyone is rejected with `AlreadyLinked`, and that check runs *before*
        /// the proposal lookup, so it fires whether or not an offer exists. To
        /// switch orchestrators a sub-agent must first clear the existing link
        /// via `remove_sub_agent_link`. This guard must survive any future
        /// relaxation of `propose_sub_agent_link`.
        #[pallet::call_index(2)]
        #[pallet::weight(T::DbWeight::get().reads_writes(4, 4)
            .saturating_add(Weight::from_parts(80_000_000, 0)))]
        pub fn accept_orchestrator_link(
            origin: OriginFor<T>,
            orchestrator: T::AccountId,
        ) -> DispatchResult {
            let sub_agent = ensure_signed(origin)?;
            ensure!(
                !SubAgentToOrchestrator::<T>::contains_key(&sub_agent),
                Error::<T>::AlreadyLinked
            );

            let expires_at = PendingLinkProposals::<T>::get(&orchestrator, &sub_agent)
                .ok_or(Error::<T>::ProposalNotFound)?;
            let now = frame_system::Pallet::<T>::block_number();
            ensure!(now <= expires_at, Error::<T>::ProposalExpired);

            Self::remove_proposal(&orchestrator, &sub_agent);
            let now2 = frame_system::Pallet::<T>::block_number();
            SubAgentLinks::<T>::insert(
                &orchestrator,
                &sub_agent,
                SubLinkRecord {
                    linked_at: now2,
                    lifetime_volume: Zero::zero(),
                },
            );
            SubAgentToOrchestrator::<T>::insert(&sub_agent, orchestrator.clone());
            OrchestratorRegistration::<T>::mutate(&orchestrator, |maybe_rec| {
                if let Some(rec) = maybe_rec {
                    rec.active_sub_count = rec.active_sub_count.saturating_add(1);
                }
            });

            Self::deposit_event(Event::LinkAccepted {
                orchestrator,
                sub_agent,
            });
            Ok(())
        }

        #[pallet::call_index(3)]
        #[pallet::weight(T::DbWeight::get().reads_writes(3, 3)
            .saturating_add(Weight::from_parts(70_000_000, 0)))]
        pub fn remove_sub_agent_link(origin: OriginFor<T>, other: T::AccountId) -> DispatchResult {
            let caller = ensure_signed(origin)?;
            let (orchestrator, sub_agent) = if OrchestratorRegistration::<T>::contains_key(&caller)
            {
                ensure!(
                    SubAgentToOrchestrator::<T>::get(&other) == Some(caller.clone()),
                    Error::<T>::NotLinked
                );
                (caller.clone(), other.clone())
            } else if let Some(orch) = SubAgentToOrchestrator::<T>::get(&caller) {
                ensure!(orch == other, Error::<T>::NotLinked);
                (other.clone(), caller.clone())
            } else {
                return Err(Error::<T>::NotOrchestratorOrSubAgent.into());
            };

            SubAgentLinks::<T>::remove(&orchestrator, &sub_agent);
            SubAgentToOrchestrator::<T>::remove(&sub_agent);
            OrchestratorRegistration::<T>::mutate(&orchestrator, |maybe_rec| {
                if let Some(rec) = maybe_rec {
                    rec.active_sub_count = rec.active_sub_count.saturating_sub(1);
                }
            });
            Self::deposit_event(Event::LinkRemoved {
                orchestrator,
                sub_agent,
                by: caller,
            });
            Ok(())
        }

        #[pallet::call_index(4)]
        #[pallet::weight(T::DbWeight::get().reads_writes(5, 5)
            .saturating_add(Weight::from_parts(150_000_000, 0)))]
        pub fn deregister_orchestrator(origin: OriginFor<T>) -> DispatchResult {
            let who = ensure_signed(origin)?;
            ensure!(
                OrchestratorRegistration::<T>::contains_key(&who),
                Error::<T>::NotRegistered
            );

            let links_cleared = SubAgentLinks::<T>::drain_prefix(&who)
                .map(|(sub_agent, _)| {
                    SubAgentToOrchestrator::<T>::remove(&sub_agent);
                    1u32
                })
                .sum::<u32>();
            // ROUND8B: this was `clear_prefix(&who, 1000, None)` with the result
            // discarded, while the registration below was removed regardless. An
            // orchestrator holding more than 1,000 open proposals therefore left
            // the remainder in storage permanently, with no record left to
            // attribute them to and every affected sub-agent's counter still
            // charged for a slot they could never reclaim.
            //
            // drain_prefix removes as it iterates and runs to completion, so no
            // remainder survives — and it hands back each sub-agent key, which is
            // what lets the counters be decremented correctly. This mirrors the
            // SubAgentLinks drain directly above it.
            let mut proposals_cleared: u32 = 0;
            for (sub_agent, _expires_at) in PendingLinkProposals::<T>::drain_prefix(&who) {
                PendingProposalCount::<T>::mutate(&sub_agent, |c| *c = c.saturating_sub(1));
                proposals_cleared = proposals_cleared.saturating_add(1);
            }
            OrchestratorRegistration::<T>::remove(&who);

            Self::deposit_event(Event::OrchestratorDeregistered {
                who,
                links_cleared,
                proposals_cleared,
            });
            Ok(())
        }

        /// Sub-agent side drain: refuse a specific orchestrator's open offer.
        ///
        /// This is what makes the permissive `propose_sub_agent_link` safe. A
        /// sub-agent's inbox is capped at `MaxPendingProposals`, and this is how
        /// they reclaim a slot — without it a cap would merely convert storage
        /// exhaustion into denial of service, since filling the slots would lock
        /// out every legitimate orchestrator permanently.
        ///
        /// Deliberately accepts **expired** entries too. Expiry is only checked
        /// at accept time and nothing reaps expired rows, so if this refused to
        /// touch them an expired proposal would wedge a slot forever — exactly
        /// the failure the cap is meant to prevent.
        #[pallet::call_index(6)]
        #[pallet::weight(T::DbWeight::get().reads_writes(1, 2)
            .saturating_add(Weight::from_parts(40_000_000, 0)))]
        pub fn decline_link_proposal(
            origin: OriginFor<T>,
            orchestrator: T::AccountId,
        ) -> DispatchResult {
            let sub_agent = ensure_signed(origin)?;
            ensure!(
                Self::remove_proposal(&orchestrator, &sub_agent),
                Error::<T>::ProposalNotFound
            );
            Self::deposit_event(Event::LinkProposalDeclined {
                orchestrator,
                sub_agent,
            });
            Ok(())
        }

        /// Orchestrator side drain: withdraw an offer you made.
        ///
        /// The mirror of `decline_link_proposal`. Lets an orchestrator free a
        /// slot in a sub-agent's inbox voluntarily — relevant because an
        /// orchestrator who has changed their mind would otherwise leave a row
        /// occupying the sub-agent's cap until it is declined or the
        /// orchestrator deregisters entirely.
        ///
        /// Accepts expired entries too, for the same reason as declining.
        #[pallet::call_index(7)]
        #[pallet::weight(T::DbWeight::get().reads_writes(1, 2)
            .saturating_add(Weight::from_parts(40_000_000, 0)))]
        pub fn cancel_link_proposal(
            origin: OriginFor<T>,
            sub_agent: T::AccountId,
        ) -> DispatchResult {
            let orchestrator = ensure_signed(origin)?;
            ensure!(
                Self::remove_proposal(&orchestrator, &sub_agent),
                Error::<T>::ProposalNotFound
            );
            Self::deposit_event(Event::LinkProposalCancelled {
                orchestrator,
                sub_agent,
            });
            Ok(())
        }

        #[pallet::call_index(5)]
        #[pallet::weight(T::DbWeight::get().reads_writes(5, 3)
            .saturating_add(Weight::from_parts(80_000_000, 0)))]
        pub fn claim_orchestrator(origin: OriginFor<T>) -> DispatchResult {
            let who = ensure_signed(origin)?;
            let acc = OrchestratorGlobalAcc::<T>::get();
            let debt = OrchestratorRewardDebt::<T>::get(&who);
            let weight = OrchestratorWeightSnapshot::<T>::get(&who);
            ensure!(acc > debt && weight > 0, Error::<T>::NothingToClaim);

            let delta = acc.saturating_sub(debt);
            let pending = delta
                .saturating_mul(weight)
                .checked_div(ACC_SCALE)
                .unwrap_or(0);
            OrchestratorRewardDebt::<T>::insert(&who, acc);
            ensure!(pending > 0, Error::<T>::NothingToClaim);

            // V4: Supply cap gate — orchestrator emissions share the 100B CMN cap.
            let supply_cap: u128 =
                sp_runtime::traits::UniqueSaturatedInto::<u128>::unique_saturated_into(
                    T::SupplyCap::get(),
                );
            let total_issued: u128 =
                sp_runtime::traits::UniqueSaturatedInto::<u128>::unique_saturated_into(
                    <T as agents_pallet::Config>::Currency::total_issuance(),
                );
            let mintable = supply_cap.saturating_sub(total_issued).min(pending);
            ensure!(mintable > 0, Error::<T>::NothingToClaim);

            let amount: BalanceOf<T> = mintable.try_into().unwrap_or_else(|_| Zero::zero());
            if amount.is_zero() {
                return Err(Error::<T>::NothingToClaim.into());
            }

            let _ = <T as agents_pallet::Config>::Currency::deposit_creating(&who, amount);
            Self::deposit_event(Event::OrchestratorRewardClaimed {
                orchestrator: who,
                amount,
            });
            Ok(())
        }
    }

    impl<T: Config> Pallet<T>
    where
        BalanceOf<T>: From<u32>,
        u128: TryInto<BalanceOf<T>>,
    {
        pub fn get_orchestrator(sub_agent: &T::AccountId) -> Option<T::AccountId> {
            SubAgentToOrchestrator::<T>::get(sub_agent)
        }

        /// Remove one pending proposal and keep [`PendingProposalCount`] in step.
        /// Returns `true` if an entry was actually there to remove.
        ///
        /// **Every single-entry removal path routes through here** — accept,
        /// decline and cancel — so the counter cannot drift by one path being
        /// updated and another forgotten. The bulk path in
        /// `deregister_orchestrator` is the sole exception, because
        /// `drain_prefix` removes as it iterates; it decrements inline instead.
        ///
        /// `take()` makes the read-and-remove a single operation, so a decrement
        /// can never happen for an entry that was not present. `saturating_sub`
        /// then guarantees the counter cannot underflow even if a fixture seeded
        /// `PendingLinkProposals` directly without incrementing.
        fn remove_proposal(orchestrator: &T::AccountId, sub_agent: &T::AccountId) -> bool {
            if PendingLinkProposals::<T>::take(orchestrator, sub_agent).is_some() {
                PendingProposalCount::<T>::mutate(sub_agent, |c| *c = c.saturating_sub(1));
                true
            } else {
                false
            }
        }

        pub fn add_orchestrator_volume(orchestrator: &T::AccountId, amount: BalanceOf<T>) {
            if OrchestratorRegistration::<T>::contains_key(orchestrator) {
                EraOrchestratorVolume::<T>::mutate(orchestrator, |v| *v = v.saturating_add(amount));
            }
        }

        pub fn compute_era_orchestrator_weights(emission_multiplier: u32) -> (u128, u32) {
            let mut total_weight: u128 = 0;
            let mut count: u32 = 0;

            // Zero ALL orchestrator snapshots before computing new values.
            // The MasterChef pattern: pending = (acc_delta) × latest_snapshot.
            // If an orchestrator had high volume last era and zero this era,
            // their snapshot from last era persists. When OrchestratorGlobalAcc
            // grows this era (from other orchestrators), claim_orchestrator
            // multiplies that delta by the stale high snapshot = overclaim.
            // Zeroing before rewriting ensures only active eras contribute weight.
            let reg_count = OrchestratorRegistration::<T>::iter().count() as u32;
            let clear_bound = reg_count.saturating_add(reg_count / 5).max(10);
            let _ = OrchestratorWeightSnapshot::<T>::clear(clear_bound, None);

            for (orch, vol) in EraOrchestratorVolume::<T>::iter() {
                if vol.is_zero() {
                    continue;
                }
                let vol_u128: u128 = UniqueSaturatedInto::<u128>::unique_saturated_into(vol);
                let sqrt_vol = pallet_agents::integer_sqrt(vol_u128);
                let orch_weight = sqrt_vol
                    .saturating_mul(emission_multiplier as u128)
                    .checked_div(10_000)
                    .unwrap_or(0);
                if orch_weight > 0 {
                    OrchestratorWeightSnapshot::<T>::insert(&orch, orch_weight);
                    total_weight = total_weight.saturating_add(orch_weight);
                    count = count.saturating_add(1);
                }
            }
            (total_weight, count)
        }

        pub fn settle_orchestrator_era(emission: BalanceOf<T>, total_weight: u128) {
            if total_weight > 0 {
                let em_u128: u128 = UniqueSaturatedInto::<u128>::unique_saturated_into(emission);
                if let Some(delta) = em_u128
                    .checked_mul(ACC_SCALE)
                    .and_then(|x| x.checked_div(total_weight))
                {
                    OrchestratorGlobalAcc::<T>::mutate(|acc| *acc = acc.saturating_add(delta));
                }
            }
            let count = OrchestratorRegistration::<T>::iter().count() as u32;
            let bound = count.saturating_add(count / 5).max(10);
            let _ = EraOrchestratorVolume::<T>::clear(bound, None);
        }
    }
}
