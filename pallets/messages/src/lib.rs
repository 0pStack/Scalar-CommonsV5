//! # pallet-messages (spec 309)
//!
//! On-chain coordination messages between registered agents: typed, bounded, fee-priced and
//! **event-only**.
//!
//! ## Why this exists
//!
//! Agents already agree on work through escrow, but everything *before* the agreement (the
//! offer, the counter-bid, the acceptance, the delivery notice) has so far travelled as JSON
//! pasted between chats and HTTP endpoints nobody else can audit. That breaks the coordination
//! guarantee this chain exists to provide: when a dispute opens there is no shared record of what
//! was offered and accepted. This pallet puts that negotiation on chain without turning the chain
//! into a mailbox.
//!
//! ## What is and is not stored
//!
//! The payload travels in the block body (it is an argument of `send`) and is repeated in the
//! `MessageSent` event's `payload_len` / `payload_hash` for indexers. It is **never written to
//! state**. The pallet writes exactly two small per-sender values:
//!
//! - `NextNonce` — a per-sender sequence number, so a recipient can detect gaps and replays
//!   without trusting an indexer.
//! - `SentInBlock` — `(block, count)` for the per-block rate limit. It holds no message content
//!   and is overwritten in place the first time the sender sends in a later block.
//!
//! State growth is therefore bounded by the number of distinct senders, not by message volume;
//! message volume is paid for by the fee and pruned by ordinary block pruning.
//!
//! ## Fee
//!
//! On top of the normal weight/length fee, every message burns
//! `BaseFee + PerByteFee × payload_len` from the sender's free balance. The burn is the spam
//! price: messages earn nothing and feed no emission weight, so the only thing a flood can buy is
//! block space, and it has to pay for that at a rate proportional to what it uses. Burning (not
//! routing to Treasury) keeps the price from becoming anyone's revenue and so from becoming
//! anyone's incentive. Burning only ever lowers total issuance, so it cannot touch the supply cap.
//!
//! ## What the chain does NOT check
//!
//! - `payload_hash` is the sender's claim. It is not compared with `payload` because the payload
//!   is commonly ciphertext (encrypted to the recipient's messaging key, see
//!   `pallet_agents::MessagingKey`) while the hash commits to the plaintext terms. Recipients
//!   verify it off chain (see `docs/reference/messaging.md`).
//! - `agreement` is a free-form tag `(counterparty, seq)`; it is not resolved against escrow.
//! - An `Announce`'s `to` is not required to be an agent: announcements are broadcasts and the
//!   field is a topic hint.

#![cfg_attr(not(feature = "std"), no_std)]
extern crate alloc;
pub use pallet::*;

pub mod envelope;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod envelope_tests;

use frame_support::weights::Weight;

/// Hard upper bound on an inline payload, in bytes (2 KiB). Part of the call's type
/// (`BoundedVec<u8, ConstU32<MAX_PAYLOAD_LEN>>`), so an oversized payload cannot even be
/// decoded into a call — it fails at construction, before any fee or weight is computed.
/// Larger content goes off chain with only its `payload_hash` sent here.
pub const MAX_PAYLOAD_LEN: u32 = 2048;

/// Weight functions for pallet-messages.
pub trait WeightInfo {
    /// `len` is the payload length in bytes: the only input whose cost scales.
    fn send(len: u32) -> Weight;
}

/// Hand-estimated weights, in the same style as the other Scalar pallets, until the benchmark
/// harness (#134) produces measured values.
///
/// This is the execution part only. The storage part is declared on the call:
/// `DbWeight × (6 reads, 4 writes)`, pinned as a floor by
/// `declared_weight_send_covers_its_storage_path`.
///
/// The fixed part mirrors the other small agent extrinsics (40–60 M ref-time). The per-byte
/// part is a conservative placeholder for the work that does scale with the payload: decoding
/// the up-to-2 KiB `BoundedVec` argument and moving it through dispatch. The payload is not
/// copied into the event (the event carries only `payload_len`) and is not hashed on chain.
/// Block space itself is priced by the transaction length fee, not by this term.
/// 1 000 ref-time/byte is ≈ 2 M at 2 KiB.
pub struct PlaceholderWeights;
impl WeightInfo for PlaceholderWeights {
    fn send(len: u32) -> Weight {
        Weight::from_parts(50_000_000, 0)
            .saturating_add(Weight::from_parts(1_000u64.saturating_mul(len as u64), 0))
    }
}

#[frame_support::pallet]
pub mod pallet {
    use super::{WeightInfo, MAX_PAYLOAD_LEN};
    use frame_support::{
        pallet_prelude::*,
        traits::{Currency, ExistenceRequirement, WithdrawReasons},
    };
    use frame_system::pallet_prelude::*;
    use sp_runtime::traits::Saturating;

    /// Spend through the agents' Currency so the fee is charged in exactly the balance type the
    /// registration stake is locked in.
    pub type BalanceOf<T> = pallet_agents::pallet::BalanceOf<T>;

    /// The call-level payload type. The bound is in the type, not in a runtime check.
    pub type Payload = BoundedVec<u8, ConstU32<MAX_PAYLOAD_LEN>>;

    /// What a message is for. The variant is a coordination verb, not free text, so indexers and
    /// agents can filter a negotiation without parsing payloads. Append-only: the SCALE index of
    /// each variant is part of the call encoding and the event shape.
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
    pub enum MessageKind {
        /// A provider offers terms.
        Offer,
        /// A buyer proposes or counters terms.
        Bid,
        /// Terms are accepted; the payload hash is what an escrow agreement should commit to.
        Accept,
        /// Terms are rejected.
        Reject,
        /// Work was delivered; the payload hash is the report hash.
        DeliveryNotice,
        /// Context for an open or impending dispute.
        DisputeNote,
        /// Broadcast. The only kind whose recipient need not be a registered agent.
        Announce,
        /// Liveness probe.
        Ping,
    }

    #[pallet::config]
    pub trait Config: frame_system::Config + pallet_agents::Config {
        type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;

        /// Burned once per message regardless of size: the floor price of occupying an
        /// extrinsic slot and an event. Runtime: 0.02 CMN.
        #[pallet::constant]
        type BaseFee: Get<BalanceOf<Self>>;

        /// Burned per payload byte, so a full 2 KiB message costs ~11x an empty one and
        /// block-space consumption is priced linearly. Runtime: 0.0001 CMN/byte.
        #[pallet::constant]
        type PerByteFee: Get<BalanceOf<Self>>;

        /// Most messages one account may send in one block. Caps how much of a block a single
        /// sender can occupy no matter how much it is willing to burn. Runtime: 4.
        #[pallet::constant]
        type MaxPerBlock: Get<u32>;

        type WeightInfo: WeightInfo;
    }

    #[pallet::pallet]
    pub struct Pallet<T>(_);

    #[pallet::extra_constants]
    impl<T: Config> Pallet<T> {
        /// Largest inline payload in bytes. Exposed in metadata so clients size payloads from
        /// the chain rather than from a copy of this number.
        #[pallet::constant_name(MaxPayloadLen)]
        fn max_payload_len() -> u32 {
            MAX_PAYLOAD_LEN
        }
    }

    /// Next nonce each sender will stamp on a message; starts at 0 and increments by one per
    /// successful `send`. Recipients use it to detect gaps and replays.
    #[pallet::storage]
    pub type NextNonce<T: Config> = StorageMap<_, Blake2_128Concat, T::AccountId, u64, ValueQuery>;

    /// `(block, messages sent in that block)` per sender, for `MaxPerBlock`. Holds no message
    /// content. Reset lazily: a send in a later block overwrites it with `(now, 1)`.
    #[pallet::storage]
    pub type SentInBlock<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, (BlockNumberFor<T>, u32), OptionQuery>;

    #[pallet::event]
    #[pallet::generate_deposit(pub(super) fn deposit_event)]
    pub enum Event<T: Config> {
        /// A message was sent and its fee burned. The payload itself is in the extrinsic;
        /// `payload_len` lets an indexer check it fetched the right bytes and recompute the fee.
        MessageSent {
            from: T::AccountId,
            to: T::AccountId,
            kind: MessageKind,
            agreement: Option<(T::AccountId, u32)>,
            payload_hash: Option<[u8; 32]>,
            payload_len: u32,
            nonce: u64,
        },
    }

    #[pallet::error]
    pub enum Error<T> {
        /// The sender is not a registered agent.
        NotRegistered,
        /// The recipient is not a registered agent (required for every kind but `Announce`).
        RecipientNotRegistered,
        /// The sender already sent `MaxPerBlock` messages in this block.
        RateLimited,
        /// The sender's nonce is at `u64::MAX`. Unreachable in practice; refused rather than
        /// wrapped so a nonce is never reused.
        NonceOverflow,
    }

    #[pallet::call]
    impl<T: Config> Pallet<T> {
        /// Send a typed coordination message to another agent.
        ///
        /// Every guard runs before the fee moves: registration of both parties, the per-block
        /// rate limit and the nonce. Only then is `BaseFee + PerByteFee × payload_len`
        /// withdrawn from the sender's free balance (`KeepAlive`, so a message can never reap
        /// the account that sent it) and burned, the nonce advanced, and `MessageSent` emitted.
        #[pallet::call_index(0)]
        #[pallet::weight(
            <T as Config>::WeightInfo::send(payload.len() as u32)
                // 6 reads: both parties' AgentStake, SentInBlock, NextNonce, the sender's
                // System::Account, TotalIssuance. 4 writes: SentInBlock, NextNonce, the
                // sender's System::Account, TotalIssuance (the burn lowers issuance).
                .saturating_add(T::DbWeight::get().reads_writes(6, 4))
        )]
        pub fn send(
            origin: OriginFor<T>,
            to: T::AccountId,
            kind: MessageKind,
            agreement: Option<(T::AccountId, u32)>,
            payload_hash: Option<[u8; 32]>,
            payload: Payload,
        ) -> DispatchResult {
            let from = ensure_signed(origin)?;

            // ── Guards: all of them before any funds move. ──
            ensure!(
                pallet_agents::Pallet::<T>::is_agent(&from),
                Error::<T>::NotRegistered
            );
            ensure!(
                kind == MessageKind::Announce || pallet_agents::Pallet::<T>::is_agent(&to),
                Error::<T>::RecipientNotRegistered
            );
            let now = frame_system::Pallet::<T>::block_number();
            let sent_this_block = match SentInBlock::<T>::get(&from) {
                Some((block, count)) if block == now => count,
                _ => 0,
            };
            ensure!(
                sent_this_block < T::MaxPerBlock::get(),
                Error::<T>::RateLimited
            );
            let nonce = NextNonce::<T>::get(&from);
            let next_nonce = nonce.checked_add(1).ok_or(Error::<T>::NonceOverflow)?;

            // ── Fee: withdraw from free balance and burn. ──
            // `payload.len()` is at most MAX_PAYLOAD_LEN (2048) by type, so the cast is lossless.
            let payload_len = payload.len() as u32;
            let fee = Self::message_fee(payload_len);
            let imbalance = <T as pallet_agents::Config>::Currency::withdraw(
                &from,
                fee,
                WithdrawReasons::FEE,
                ExistenceRequirement::KeepAlive,
            )?;
            // Dropping a NegativeImbalance reduces total issuance: this is the burn.
            drop(imbalance);

            // ── State: the nonce and the rate-limit counter. Never the payload. ──
            SentInBlock::<T>::insert(&from, (now, sent_this_block.saturating_add(1)));
            NextNonce::<T>::insert(&from, next_nonce);

            Self::deposit_event(Event::MessageSent {
                from,
                to,
                kind,
                agreement,
                payload_hash,
                payload_len,
                nonce,
            });
            Ok(())
        }
    }

    impl<T: Config> Pallet<T> {
        /// The protocol fee for a payload of `len` bytes: `BaseFee + PerByteFee × len`.
        /// Saturating throughout — at the configured values the maximum is ~0.22 CMN, many
        /// orders of magnitude from overflow, but the arithmetic must not depend on that.
        pub fn message_fee(len: u32) -> BalanceOf<T> {
            T::BaseFee::get().saturating_add(T::PerByteFee::get().saturating_mul(len.into()))
        }
    }
}
