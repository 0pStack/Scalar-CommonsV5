//! Reference implementation of the signed message envelope (`docs/reference/messaging.md`).
//!
//! Nothing on chain decodes these types: the pallet carries the envelope as opaque payload
//! bytes. They live here so the canonical encoding has exactly one definition, compiled and
//! tested alongside the call it rides in, and so the test vectors in the spec are produced and
//! re-verified by CI rather than written by hand.
//!
//! The rule the envelope exists to enforce: **what an agent signs is what the chain carries.**
//! `kind`, `to`, `agreement` and `payload_hash` appear both in the signed envelope and in the
//! `send` call; a verifier rejects any message where they differ, so an envelope cannot be
//! replayed under a different kind, recipient or agreement.

use alloc::vec::Vec;
use parity_scale_codec::{Decode, Encode};
use scale_info::TypeInfo;
use sp_runtime::traits::{BlakeTwo256, Hash};

/// Current envelope version.
pub const ENVELOPE_VERSION: u8 = 1;

/// Domain separator. Prefixed, together with the genesis hash, to every signing payload so an
/// envelope signature can never be valid as a transaction, as another protocol's message, or on
/// another chain.
pub const DOMAIN_PREFIX: &[u8] = b"ScalarMsg/v1|";

/// The signed part of a message. Field order and widths are the canonical encoding: SCALE of
/// exactly this struct.
#[derive(Clone, Encode, Decode, TypeInfo, Debug, PartialEq, Eq)]
pub struct Envelope<AccountId> {
    /// `ENVELOPE_VERSION`.
    pub version: u8,
    /// Signer. Must equal the account that submitted the `send` (on-chain transport).
    pub from: AccountId,
    pub to: AccountId,
    /// SCALE index of `MessageKind` (Offer = 0 … Ping = 7).
    pub kind: u8,
    /// `(counterparty, escrow seq)` this message is about, if any.
    pub agreement: Option<(AccountId, u32)>,
    /// Strictly increasing per `(from, to)` pair, as seen by the verifier.
    pub nonce: u64,
    /// Last block at which the envelope is valid.
    pub expires_at_block: u32,
    /// `blake2_256` of the plaintext body.
    pub payload_hash: [u8; 32],
}

impl<AccountId: Encode> Envelope<AccountId> {
    /// The 32 bytes that are signed:
    /// `blake2_256(DOMAIN_PREFIX ‖ genesis_hash ‖ SCALE(envelope))`.
    pub fn signing_hash(&self, genesis_hash: &[u8; 32]) -> [u8; 32] {
        let mut buf = Vec::with_capacity(DOMAIN_PREFIX.len() + 32 + 160);
        buf.extend_from_slice(DOMAIN_PREFIX);
        buf.extend_from_slice(genesis_hash);
        self.encode_to(&mut buf);
        BlakeTwo256::hash(&buf).0
    }
}

/// The body that travels next to an envelope.
#[derive(Clone, Encode, Decode, TypeInfo, Debug, PartialEq, Eq)]
pub enum Body {
    /// Hash-only message: the content is delivered elsewhere and only its commitment is here.
    None,
    /// Plaintext bytes. `payload_hash == blake2_256(bytes)`.
    Plain(Vec<u8>),
    /// X25519-XSalsa20-Poly1305 box (NaCl `box`, `@polkadot/util-crypto` `naclSeal`) from the
    /// sender's messaging key to the recipient's. `payload_hash` is over the *plaintext*, so
    /// the recipient decrypts before checking it.
    Sealed {
        /// Sender's X25519 public key. Must equal the sender's `agents.messagingKey`.
        sender_key: [u8; 32],
        nonce: [u8; 24],
        ciphertext: Vec<u8>,
    },
}

/// What goes in `messages.send`'s `payload` for the on-chain transport, and in the HTTPS body
/// for the off-chain one: `SCALE((envelope, sr25519 signature, body))`.
#[derive(Clone, Encode, Decode, TypeInfo, Debug, PartialEq, Eq)]
pub struct SignedMessage<AccountId> {
    pub envelope: Envelope<AccountId>,
    pub signature: [u8; 64],
    pub body: Body,
}
