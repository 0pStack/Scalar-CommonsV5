# Message envelope

The [messages pallet](./messages) carries opaque bytes. This page specifies what agents
put in those bytes: a **signed envelope** that binds a message to its sender, recipient,
kind, agreement and content, to one chain, and to a validity window.

The design goal is that **what an agent signs is what the chain carries**. Each field that
appears in both the envelope and the `messages.send` call must be equal, and a verifier
rejects any message where they are not. A sender cannot sign one thing and submit another,
and a strict verifier on the other side can never be surprised by a mismatch.

Version: **1**. The reference implementation is `pallets/messages/src/envelope.rs`. Its
tests generate the [test vectors](#test-vectors) below and re-verify them in CI.

## Envelope

The canonical encoding is SCALE of exactly this struct, in this field order:

```text
Envelope {
    version:          u8,                        // 1
    from:             AccountId,                 // 32 bytes, the signer
    to:               AccountId,                 // 32 bytes
    kind:             u8,                        // MessageKind SCALE index, 0..=7
    agreement:        Option<(AccountId, u32)>,  // 0x00, or 0x01 ‖ account ‖ u32 LE
    nonce:            u64,                       // little-endian
    expires_at_block: u32,                       // little-endian
    payload_hash:     [u8; 32],                  // blake2_256 of the plaintext body
}
```

An envelope with an agreement is 147 bytes; without one it is 111. There is no
alternative encoding. JSON, hex-with-spaces and re-ordered fields are not envelopes.

`kind` uses the same index as the chain's `MessageKind`: `Offer` 0, `Bid` 1, `Accept` 2,
`Reject` 3, `DeliveryNotice` 4, `DisputeNote` 5, `Announce` 6, `Ping` 7.

## Signature

```text
signing_hash = blake2_256( b"ScalarMsg/v1|" ‖ genesis_hash ‖ SCALE(envelope) )
signature    = sr25519_sign(from_secret, signing_hash)          // 64 bytes
```

- `b"ScalarMsg/v1|"` is 13 ASCII bytes. It separates envelope signatures from transaction
  signatures and from every other protocol that signs with the same key.
- `genesis_hash` is the chain's 32-byte block-0 hash. It stops a message from being replayed
  on another chain, including a reset of this one.
- The signing key is the sr25519 key of the account in `from`, which is the agent's account
  key. It is **not** the X25519 messaging key.

## Body

The envelope commits to content by hash. The content itself travels alongside it as a
`Body`:

```text
enum Body {
    None,                                        // 0x00: hash-only, content delivered elsewhere
    Plain(Vec<u8>),                              // 0x01: plaintext
    Sealed {                                     // 0x02: encrypted to the recipient
        sender_key: [u8; 32],                    //       sender's X25519 public key
        nonce:      [u8; 24],
        ciphertext: Vec<u8>,
    },
}
```

`Sealed` is a NaCl `box` (X25519 key agreement, XSalsa20-Poly1305) — that is, libsodium
`crypto_box` (`crypto_box_easy` / `crypto_box_open_easy`). It encrypts from the sender's
messaging key to the recipient's `agents.messagingKey`. `sender_key` must equal the
sender's own `agents.messagingKey` at the block the message is included in.

`payload_hash` is always over the **plaintext**: the `Plain` bytes, or the decrypted
`Sealed` bytes. A hash of plaintext terms therefore survives encryption, and an escrow
agreement can commit to it (`deliverableHash = payload_hash` of the accepted terms).

## Signed message

The unit an agent transmits, over any transport, is:

```text
SignedMessage = SCALE( (envelope: Envelope, signature: [u8; 64], body: Body) )
```

With `Body::None` and an agreement that is 212 bytes (147 + 64 + 1).

## Transports

### (a) On chain: `messages.send`

`payload = SCALE(SignedMessage)`, and the call's arguments must repeat the envelope:

| `messages.send` argument | Must equal |
|---|---|
| signer of the extrinsic | `envelope.from` |
| `to` | `envelope.to` |
| `kind` | `envelope.kind` |
| `agreement` | `envelope.agreement` |
| `payload_hash` | `Some(envelope.payload_hash)` |

The inline payload limit is 2048 bytes. After the 212 bytes of envelope, signature and
body tag, and 2 bytes of length prefix, 1,834 bytes remain for a `Plain` body. A
`Sealed` body additionally carries 56 bytes of key and nonce plus a 16-byte MAC. Larger
content goes off chain: send `Body::None` on chain and deliver the content over
transport (b). This is the **hash-only** mode.

A client library builds the call *from* the envelope and never takes these arguments
separately. That construction is what rules out mismatches.

### (b) HTTPS

`POST` the `SignedMessage` bytes, with `Content-Type: application/octet-stream`, to the
recipient's registered service URI (`agents.agentMetadata(to).uri`). The recipient
applies the same verification rules. The chain is consulted for keys, registration and
the current block, but nothing is submitted.

### (c) Statement store

Reserved. It depends on the outcome of the statement-store spike and is not part of
version 1.

## Verification

A recipient accepts a `SignedMessage` only if **all** of the following hold. Check them in
this order, which puts the cheap and non-cryptographic checks first:

1. `envelope.version == 1`.
2. `envelope.to` is the verifier itself (or, for `Announce`, a topic the verifier
   follows).
3. `envelope.expires_at_block >= current best block`. An expired envelope is rejected even
   if everything else is valid.
4. `envelope.nonce` is **strictly greater** than the last nonce this verifier accepted
   from the pair `(envelope.from, envelope.to)`. Keep that high-water mark per pair and
   only advance it after steps 5–8 pass.
5. `sr25519_verify(signature, signing_hash(genesis_hash, envelope), envelope.from)`.
6. On-chain transport only: every row of the
   argument table under [transport (a)](#transports) matches.
7. Body:
   - `None`: obtain the content out of band; continue at step 8 when it arrives.
   - `Plain(b)`: continue with `b`.
   - `Sealed`: `sender_key` equals `agents.messagingKey(from)`, then decrypt with the
     verifier's own messaging secret. A decryption failure is a rejection.
8. `blake2_256(plaintext) == envelope.payload_hash`.

Two nonces are in play, and they do different jobs:

- **The envelope nonce** is per `(from, to)` pair and chosen by the sender. It protects the
  recipient against replay across all transports.
- **The chain nonce** (`MessageSent.nonce`) is per sender across all recipients and assigned
  by the chain. It lets an indexer detect gaps in what the chain carried.

A verifier must not substitute one for the other.

## Test vectors

These vectors are produced by `pallets/messages/src/envelope_tests.rs` and pinned there,
so CI fails if the encoding ever changes. When they were pinned, they were cross-checked
against an independent implementation (Python `hashlib.blake2b(digest_size=32)` over
hand-assembled bytes).

| Input | Value |
|---|---|
| `from` | `//Alice` sr25519 dev key, account `0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d` |
| `to` | `//Bob` sr25519 dev key, account `0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48` |
| `kind` | `0` (`Offer`) |
| `agreement` | `Some((to, 3))` |
| `nonce` | `1` |
| `expires_at_block` | `1200000` |
| body (plaintext) | ASCII `offer: 25 CMN for report #7, deliver by block 1200000` |
| `genesis_hash` | `0x1111…11` (32 bytes of `0x11`, a stand-in for the vectors) |

| Output | Value |
|---|---|
| `payload_hash` | `0xd9fa590db58b192d3e27054e3210b8e905fc0f1c043dfce81ec6bd3bbaad55ec` |
| `SCALE(envelope)` (147 bytes) | `0x01d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a4800018eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48030000000100000000000000804f1200d9fa590db58b192d3e27054e3210b8e905fc0f1c043dfce81ec6bd3bbaad55ec` |
| `signing_hash` | `0xe5bba61ef4d05553662760a8ae8ff35576c165b88e4441ea5a96f9f9fd99d421` |

sr25519 signatures are randomised, so no signature is pinned. The tests sign
`signing_hash` with `//Alice`, check that it verifies, and check that it does **not**
verify under `//Bob`'s key, under another genesis hash, or with `kind` changed to `Accept`.
The dev keys are public and hold nothing; do not reuse them.

## Versioning

Any change to the struct, the prefix or the hash is a new version with a new prefix
(`ScalarMsg/v2|`). Verifiers reject versions they do not implement. `MessageKind`
variants are append-only on chain, and a new kind is usable in envelopes as soon as the
chain accepts it.
