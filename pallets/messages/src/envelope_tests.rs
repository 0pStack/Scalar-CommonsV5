//! Envelope reference vectors (`docs/reference/messaging.md` § Test vectors).
//!
//! The pinned hex strings below are the vectors the spec quotes. They were cross-checked against
//! an independent implementation (Python `hashlib.blake2b(digest_size=32)` over hand-assembled
//! bytes) when pinned. If this test fails, the canonical encoding changed: that is a new
//! envelope version, not a test to update.

use crate::envelope::*;
use crate::pallet::MessageKind;
use crate::MAX_PAYLOAD_LEN;
use parity_scale_codec::{Decode, Encode};
use sp_core::{sr25519, Pair};
use sp_runtime::{
    traits::{BlakeTwo256, Hash},
    AccountId32,
};

/// Fixed stand-in genesis hash for the vectors. Real messages use the chain's genesis hash.
const TEST_GENESIS: [u8; 32] = [0x11; 32];
/// Plaintext body used by the vector.
const BODY: &[u8] = b"offer: 25 CMN for report #7, deliver by block 1200000";

fn alice() -> sr25519::Pair {
    // Well-known public development key; never holds value. Not a secret.
    sr25519::Pair::from_string("//Alice", None).unwrap()
}
fn bob() -> sr25519::Pair {
    sr25519::Pair::from_string("//Bob", None).unwrap()
}
fn account(p: &sr25519::Pair) -> AccountId32 {
    AccountId32::from(p.public().0)
}

fn vector_envelope() -> Envelope<AccountId32> {
    Envelope {
        version: ENVELOPE_VERSION,
        from: account(&alice()),
        to: account(&bob()),
        kind: MessageKind::Offer.encode()[0],
        agreement: Some((account(&bob()), 3)),
        nonce: 1,
        expires_at_block: 1_200_000,
        payload_hash: BlakeTwo256::hash(BODY).0,
    }
}

const VECTOR_PAYLOAD_HASH_HEX: &str =
    "d9fa590db58b192d3e27054e3210b8e905fc0f1c043dfce81ec6bd3bbaad55ec";
const VECTOR_SCALE_HEX: &str = concat!(
    "01d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d",
    "8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48",
    "00",
    "018eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a4803000000",
    "0100000000000000",
    "804f1200",
    "d9fa590db58b192d3e27054e3210b8e905fc0f1c043dfce81ec6bd3bbaad55ec",
);
const VECTOR_SIGNING_HASH_HEX: &str =
    "e5bba61ef4d05553662760a8ae8ff35576c165b88e4441ea5a96f9f9fd99d421";

#[test]
fn vector_canonical_encoding_and_signing_hash_are_pinned() {
    let env = vector_envelope();
    let scale = hex(&env.encode());
    let signing = hex(&env.signing_hash(&TEST_GENESIS));
    assert_eq!(hex(&env.payload_hash), VECTOR_PAYLOAD_HASH_HEX);
    assert_eq!(scale, VECTOR_SCALE_HEX);
    assert_eq!(signing, VECTOR_SIGNING_HASH_HEX);
}

#[test]
fn canonical_encoding_is_the_field_order_in_the_spec() {
    let env = vector_envelope();
    let mut expected = vec![1u8];
    expected.extend_from_slice(env.from.as_ref());
    expected.extend_from_slice(env.to.as_ref());
    expected.push(0); // kind = Offer
    expected.push(1); // Some
    expected.extend_from_slice(env.to.as_ref());
    expected.extend_from_slice(&3u32.to_le_bytes());
    expected.extend_from_slice(&1u64.to_le_bytes());
    expected.extend_from_slice(&1_200_000u32.to_le_bytes());
    expected.extend_from_slice(&env.payload_hash);
    assert_eq!(env.encode(), expected);
    assert_eq!(expected.len(), 147);
}

#[test]
fn signing_hash_is_blake2_of_prefix_genesis_and_scale() {
    let env = vector_envelope();
    let mut pre = b"ScalarMsg/v1|".to_vec();
    pre.extend_from_slice(&TEST_GENESIS);
    pre.extend(env.encode());
    assert_eq!(env.signing_hash(&TEST_GENESIS), BlakeTwo256::hash(&pre).0);
}

#[test]
fn signature_verifies_for_the_signer_only() {
    let env = vector_envelope();
    let msg = env.signing_hash(&TEST_GENESIS);
    let sig = alice().sign(&msg);
    assert!(sr25519::Pair::verify(&sig, msg, &alice().public()));
    // Wrong signer: `from` is Alice, a Bob key must not verify.
    assert!(!sr25519::Pair::verify(&sig, msg, &bob().public()));
    // Another chain: the genesis hash is inside the signed bytes.
    assert!(!sr25519::Pair::verify(
        &sig,
        env.signing_hash(&[0x22; 32]),
        &alice().public()
    ));
    // Replayed under another kind.
    let mut tampered = env.clone();
    tampered.kind = MessageKind::Accept.encode()[0];
    assert!(!sr25519::Pair::verify(
        &sig,
        tampered.signing_hash(&TEST_GENESIS),
        &alice().public()
    ));
}

#[test]
fn kind_byte_is_the_message_kind_scale_index() {
    let kinds = [
        MessageKind::Offer,
        MessageKind::Bid,
        MessageKind::Accept,
        MessageKind::Reject,
        MessageKind::DeliveryNotice,
        MessageKind::DisputeNote,
        MessageKind::Announce,
        MessageKind::Ping,
    ];
    for (i, k) in kinds.iter().enumerate() {
        assert_eq!(k.encode(), vec![i as u8]);
    }
}

#[test]
fn signed_message_round_trips_and_leaves_room_for_a_body_on_chain() {
    let env = vector_envelope();
    let sig = alice().sign(&env.signing_hash(&TEST_GENESIS)).0;
    let hash_only = SignedMessage {
        envelope: env.clone(),
        signature: sig,
        body: Body::None,
    };
    let bytes = hash_only.encode();
    assert_eq!(bytes.len(), 147 + 64 + 1);
    assert_eq!(SignedMessage::decode(&mut &bytes[..]).unwrap(), hash_only);

    let plain = SignedMessage {
        envelope: env.clone(),
        signature: sig,
        body: Body::Plain(BODY.to_vec()),
    };
    assert_eq!(
        SignedMessage::<AccountId32>::decode(&mut &plain.encode()[..]).unwrap(),
        plain
    );

    let sealed = SignedMessage {
        envelope: env,
        signature: sig,
        body: Body::Sealed {
            sender_key: [0xA1; 32],
            nonce: [0x07; 24],
            ciphertext: vec![0xEE; 64],
        },
    };
    assert_eq!(
        SignedMessage::<AccountId32>::decode(&mut &sealed.encode()[..]).unwrap(),
        sealed
    );

    // Envelope + signature + body tag = 212 bytes, leaving 1_836 bytes of the 2 KiB inline
    // payload for a plaintext body (less its 2-byte compact length prefix).
    let overhead = 147 + 64 + 1;
    assert_eq!(MAX_PAYLOAD_LEN as usize - overhead, 1_836);
}

fn hex(b: &[u8]) -> String {
    use core::fmt::Write;
    b.iter()
        .fold(String::with_capacity(b.len() * 2), |mut s, x| {
            let _ = write!(s, "{x:02x}");
            s
        })
}
