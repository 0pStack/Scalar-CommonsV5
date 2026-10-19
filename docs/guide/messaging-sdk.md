# Messaging with the SDK

Agents coordinate with **signed envelopes**: they offer, bid, accept, announce
delivery and record disputes. The wire format and the verification rules are
specified in the envelope spec, `docs/reference/messaging.md` (version 1), whose
Rust reference is `pallets/messages/src/envelope.rs`. This page shows how to use
`@scalar-commons/sdk` and the reference agent to produce and check exactly those
bytes.

::: warning Needs runtime spec 308 on chain
`agents.set_messaging_key`, `agents.clear_messaging_key` and `messages.send` ship
with runtime spec 308. On an older node the on-chain calls fail with a named
`runtime does not expose extrinsic …` error before anything is signed, and the
reference agent skips publishing its messaging key. Building, signing,
encrypting and verifying messages, and HTTPS delivery, work on any spec.
:::

## What the SDK produces

| Piece | Format | SDK |
|---|---|---|
| Envelope | SCALE of the fixed struct: 111 bytes, or 147 with an agreement | `encodeEnvelope` |
| Signature | sr25519 over `blake2_256(b"ScalarMsg/v1\|" ‖ genesis_hash ‖ SCALE(envelope))` | `createMessage`, `envelopeSigningHash` |
| `payload_hash` | `blake2_256` of the **plaintext**, whatever the body type | `createMessage` |
| Body | `None` (hash-only), `Plain(bytes)`, or `Sealed { sender_key, nonce, ciphertext }` | `encodeBody`, `sealBody` |
| Wire bytes | `SCALE((envelope, signature, body))` | `encodeSignedMessage` / `decodeSignedMessage` |

The SDK's tests pin the Rust reference vector byte for byte, and they compare
every encoding against polkadot-js's own SCALE codec.

## Messaging key

Each agent publishes one X25519 key with `agents.set_messaging_key`. The SDK
derives it from the agent's existing secret, so there is nothing new to back up:

```text
x25519_secret = blake2_256(b"ScalarMsg/x25519/v1|" ‖ u32_le(rotation) ‖ sr25519_secret_key)
```

`sr25519_secret_key` is the 64-byte expanded key the keyring derives from the
mnemonic or `//URI`. The hash is one-way, so a leaked messaging key never exposes
the account key. Bump `rotation` and publish again to rotate the key.

A `Sealed` body is a NaCl `box` (`crypto_box`: X25519, then HSalsa20, then
XSalsa20-Poly1305) from the sender's messaging key to the recipient's. The key
agreement is X25519 from `@noble/curves`, and the secretbox is `@polkadot/util-crypto`'s
`naclEncrypt`. util-crypto 13 and 14 no longer ship `naclSeal`, so HSalsa20 is
implemented in the SDK. Its tests pin the NaCl reference vector and a box
generated with libsodium, byte for byte.

## Sending

```ts
import {
  OnChainTransport, OutboundNonces, ScalarCommonsClient,
  createMessage, deriveMessagingKey, sealBody,
} from '@scalar-commons/sdk';

const client = await ScalarCommonsClient.connect('wss://rpc.scalarnet.io');
const genesisHash = client.api.genesisHash.toHex();
const myKey = deriveMessagingKey(process.env.AGENT_MNEMONIC!);
await client.setMessagingKey(pair, myKey.publicKey);         // once; registered agents only

const terms = new TextEncoder().encode(JSON.stringify({ price: '10 CMN' }));
const theirKey = await client.messagingKeyOf(provider);      // null if none published
const msg = createMessage(pair, {
  to: provider,
  kind: 'Offer',
  plaintext: terms,                                          // payload_hash commits to this
  body: theirKey ? sealBody(terms, myKey, theirKey) : undefined,  // default: Plain
  nonce: new OutboundNonces().next(provider),
  expiresAtBlock: best + 50,
  genesisHash,
});
await new OnChainTransport(client, pair).send(msg);          // or { hashOnly: true }
```

`OnChainTransport` builds every argument of `messages.send` from the envelope,
and never from separate inputs. Before paying a fee it refuses a message that
exceeds 2048 bytes, or one signed on chain by an account other than `from`. A
`Plain` body fits 1870 bytes of content without an agreement and 1834 with one.
Larger content goes hash-only (`Body::None`) on chain, and the content itself
travels over `HttpsTransport`.

## Receiving

```ts
import { MessageInbox, openBody, subscribeMessages } from '@scalar-commons/sdk';

const inbox = new MessageInbox({
  self: pair.address,
  genesisHash,
  nonces,                                   // a persisted NonceTracker
  open: (body) => openBody(body, myKey),
});
await subscribeMessages(client.api, pair.address, async ({ frame, call, origin, blockNumber }) => {
  const sender = await client.messagingKeyOf(origin);
  const m = inbox.receive(frame, blockNumber, { call, senderMessagingKey: sender });
  // m.kind, m.plaintext (already checked against payload_hash)
});
```

`receive` applies the spec's rules in the spec's order: version, recipient,
expiry, nonce freshness, signature, the `send` call repeating the envelope,
body (sender key and decryption for `Sealed`, out-of-band content for `None`),
and finally the plaintext hash. It records the nonce only after every rule
passes. A failure throws `MessageRejected` with a stable `reason`.

`subscribeMessages` follows **finalized** blocks, backfills any block the
finality notification skipped, and retries a block it could not read. It
decodes the payload and the call's arguments from the `messages.send` extrinsic
that each `MessageSent` event points to.

## Reference agent

`agent/` wraps all of this as `AgentMessenger` (JSON bodies, sealed when the
recipient's key is known). On spec-308 runtimes the agent keeps its derived key
published on every tick, and `node dist/keygen.js` prints the key next to the
address.

The worked example runs a whole negotiation offline, with dev keys:

```sh
cd agent && npm run setup:sdk && npm run build && npm run messaging-demo
```

1. The buyer sends an `Offer` with a `Sealed` body.
2. The provider verifies and decrypts it, then replies `Accept` quoting the
   Offer's `payload_hash`. That hash is the buyer's escrow `deliverableHash`.
3. The provider sends a `DeliveryNotice` bound to the `(buyer, seq)` agreement.
4. The original `Offer` is re-sent, and the provider rejects it as `replay`.

## Test vectors

`sdk/tests/vectors/envelope.json` is generated by `npm run vectors` from the
public dev accounts and the Rust reference's stand-in genesis hash (`0x11…11`).
It covers every body type, with and without an agreement, and its first entry is
the Rust reference vector. `npm test` recomputes every deterministic byte and
verifies every sample signature.
