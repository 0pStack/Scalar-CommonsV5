import { beforeAll, describe, expect, it } from 'vitest';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { TypeRegistry } from '@polkadot/types';
import { stringToU8a, u8aConcat, u8aToHex } from '@polkadot/util';
import { blake2AsU8a, cryptoWaitReady, sr25519Verify } from '@polkadot/util-crypto';

import {
  ENVELOPE_VERSION,
  MESSAGE_KINDS,
  MessageInbox,
  MessageRejected,
  NonceTracker,
  OutboundNonces,
  SIGNING_DOMAIN,
  createMessage,
  decodeEnvelope,
  decodeSignedMessage,
  deriveMessagingKey,
  encodeBody,
  encodeEnvelope,
  encodeSignedMessage,
  envelopeSigningHash,
  openBody,
  sealBody,
  type Envelope,
  type MessageInput,
  type OnChainCall,
} from '../src/index.js';

/**
 * Offline tests for the spec-308 signed envelope, version 1
 * (docs/reference/messaging.md, reference impl pallets/messages/src/envelope.rs).
 * No node, no network: keys are the well-known dev derivations.
 */

const GENESIS = new Uint8Array(32).fill(0x42);
const OTHER_GENESIS = new Uint8Array(32).fill(0x43);

let alice: KeyringPair;
let bob: KeyringPair;
let carol: KeyringPair;

beforeAll(async () => {
  await cryptoWaitReady();
  const kr = new Keyring({ type: 'sr25519' });
  alice = kr.addFromUri('//Alice');
  bob = kr.addFromUri('//Bob');
  carol = kr.addFromUri('//Charlie');
});

const plaintext = stringToU8a('{"offer":"10 CMN for one ECB fix"}');

function envelope(over: Partial<Envelope> = {}): Envelope {
  return {
    version: ENVELOPE_VERSION,
    from: alice.publicKey,
    to: bob.publicKey,
    kind: 'Offer',
    agreement: null,
    nonce: 7n,
    expiresAtBlock: 1_000,
    payloadHash: blake2AsU8a(plaintext, 256),
    ...over,
  };
}

/** Build a message from Alice to Bob with sensible defaults. */
function msg(over: Partial<MessageInput> = {}, signer = alice) {
  return createMessage(signer, {
    to: bob.address,
    kind: 'Offer',
    plaintext,
    nonce: 1n,
    expiresAtBlock: 1_000,
    genesisHash: GENESIS,
    ...over,
  });
}

const bytes = (m: ReturnType<typeof msg>) => encodeSignedMessage(m);

function inbox(self = bob) {
  const key = deriveMessagingKey(self === bob ? '//Bob' : '//Charlie');
  return new MessageInbox({ self: self.address, genesisHash: GENESIS, open: (b) => openBody(b, key) });
}

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof MessageRejected) return err.reason;
    throw err;
  }
  throw new Error('expected MessageRejected, nothing was thrown');
}

describe('message kinds', () => {
  it('match the pallet-messages MessageKind variant order', () => {
    expect(MESSAGE_KINDS).toEqual([
      'Offer', 'Bid', 'Accept', 'Reject', 'DeliveryNotice', 'DisputeNote', 'Announce', 'Ping',
    ]);
  });
});

describe('pinned vector from pallets/messages/src/envelope_tests.rs (PR #242)', () => {
  // Alice → Bob, Offer, agreement Some((Bob, 3)), nonce 1, expires 1_200_000,
  // genesis 0x11…11. The Rust test pins these; this SDK must produce the same bytes.
  const body = stringToU8a('offer: 25 CMN for report #7, deliver by block 1200000');

  it('reproduces payload_hash, SCALE(envelope) and signing_hash byte for byte', () => {
    const e = envelope({
      kind: 'Offer',
      agreement: { account: bob.publicKey, seq: 3 },
      nonce: 1n,
      expiresAtBlock: 1_200_000,
      payloadHash: blake2AsU8a(body, 256),
    });
    expect(u8aToHex(e.payloadHash)).toBe('0xd9fa590db58b192d3e27054e3210b8e905fc0f1c043dfce81ec6bd3bbaad55ec');
    expect(u8aToHex(encodeEnvelope(e))).toBe(
      '0x01d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a4800018eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48030000000100000000000000804f1200d9fa590db58b192d3e27054e3210b8e905fc0f1c043dfce81ec6bd3bbaad55ec',
    );
    expect(u8aToHex(envelopeSigningHash(e, new Uint8Array(32).fill(0x11)))).toBe(
      '0xe5bba61ef4d05553662760a8ae8ff35576c165b88e4441ea5a96f9f9fd99d421',
    );
  });

  it('SignedMessage with Body::None and an agreement is 212 bytes (147 + 64 + 1)', () => {
    const m = msg({ agreement: { account: bob.address, seq: 3 }, body: { type: 'None' } });
    expect(bytes(m).length).toBe(212);
  });
});

describe('canonical SCALE encoding', () => {
  // An independent codec: polkadot-js's own SCALE implementation of the same types.
  const registry = new TypeRegistry();
  registry.register({
    ScalarEnvelope: {
      version: 'u8',
      from: 'AccountId32',
      to: 'AccountId32',
      kind: 'u8',
      agreement: 'Option<(AccountId32, u32)>',
      nonce: 'u64',
      expires_at_block: 'u32',
      payload_hash: '[u8; 32]',
    },
    ScalarBody: {
      _enum: {
        None: 'Null',
        Plain: 'Bytes',
        Sealed: { sender_key: '[u8; 32]', nonce: '[u8; 24]', ciphertext: 'Bytes' },
      },
    },
  });

  const reference = (e: Envelope) =>
    registry
      .createType('ScalarEnvelope', {
        version: e.version,
        from: e.from,
        to: e.to,
        kind: MESSAGE_KINDS.indexOf(e.kind),
        agreement: e.agreement ? [e.agreement.account, e.agreement.seq] : null,
        nonce: e.nonce,
        expires_at_block: e.expiresAtBlock,
        payload_hash: e.payloadHash,
      })
      .toU8a();

  it('equals polkadot-js SCALE without an agreement (111 bytes)', () => {
    const e = envelope({ kind: 'Ping', nonce: 2n ** 64n - 1n, expiresAtBlock: 0xffff_ffff });
    const b = encodeEnvelope(e);
    expect(b.length).toBe(111);
    expect(u8aToHex(b)).toBe(u8aToHex(reference(e)));
  });

  it('equals polkadot-js SCALE with an agreement (147 bytes)', () => {
    const e = envelope({ kind: 'Accept', agreement: { account: carol.publicKey, seq: 513 } });
    const b = encodeEnvelope(e);
    expect(b.length).toBe(147);
    expect(u8aToHex(b)).toBe(u8aToHex(reference(e)));
  });

  it('encodes every Body variant exactly as polkadot-js SCALE does', () => {
    const long = new Uint8Array(300).fill(9); // 2-byte compact length prefix
    const cases = [
      [{ type: 'None' } as const, { None: null }],
      // Hex, not Uint8Array: polkadot-js reads a raw Uint8Array given to
      // `Bytes` as already length-prefixed.
      [{ type: 'Plain', bytes: plaintext } as const, { Plain: u8aToHex(plaintext) }],
      [{ type: 'Plain', bytes: long } as const, { Plain: u8aToHex(long) }],
      [
        { type: 'Sealed', senderKey: new Uint8Array(32).fill(0xa1), nonce: new Uint8Array(24).fill(7), ciphertext: long } as const,
        { Sealed: { sender_key: new Uint8Array(32).fill(0xa1), nonce: new Uint8Array(24).fill(7), ciphertext: u8aToHex(long) } },
      ],
    ] as const;
    for (const [ours, theirs] of cases) {
      expect(u8aToHex(encodeBody(ours))).toBe(u8aToHex(registry.createType('ScalarBody', theirs).toU8a()));
    }
  });

  it('round-trips SignedMessage for every body type', () => {
    const bobKey = deriveMessagingKey('//Bob');
    const aliceKey = deriveMessagingKey('//Alice');
    for (const body of [undefined, { type: 'None' } as const, sealBody(plaintext, aliceKey, bobKey.publicKey)]) {
      const m = msg({ body, agreement: { account: bob.address, seq: 9 } });
      expect(decodeSignedMessage(bytes(m))).toEqual(m);
    }
  });

  it('round-trips through decodeEnvelope', () => {
    const e = envelope({ kind: 'DisputeNote', agreement: { account: bob.publicKey, seq: 9 } });
    expect(decodeEnvelope(encodeEnvelope(e))).toEqual({ envelope: e, length: 147 });
  });

  it('rejects out-of-range fields before encoding', () => {
    expect(() => encodeEnvelope(envelope({ nonce: -1n }))).toThrow(/nonce/);
    expect(() => encodeEnvelope(envelope({ nonce: 2n ** 64n }))).toThrow(/nonce/);
    expect(() => encodeEnvelope(envelope({ expiresAtBlock: 2 ** 32 }))).toThrow(/expiresAtBlock/);
    expect(() => encodeEnvelope(envelope({ payloadHash: new Uint8Array(31) }))).toThrow(/payloadHash/);
    expect(() => encodeEnvelope(envelope({ kind: 'Nope' as never }))).toThrow(/kind/);
  });

  it('rejects malformed bytes on decode, including trailing bytes', () => {
    const b = bytes(msg());
    expect(() => decodeSignedMessage(b.slice(0, 100))).toThrow(/short/);
    expect(() => decodeSignedMessage(u8aConcat(b, [0]))).toThrow(/trailing/);
    const badKind = b.slice();
    badKind[65] = 8;
    expect(() => decodeSignedMessage(badKind)).toThrow(/kind/);
    const badOption = b.slice();
    badOption[66] = 2;
    expect(() => decodeSignedMessage(badOption)).toThrow(/agreement/);
    const badBody = b.slice();
    badBody[111 + 64] = 3;
    expect(() => decodeSignedMessage(badBody)).toThrow(/Body/);
  });
});

describe('signing hash', () => {
  it('is blake2_256 of the domain prefix, the genesis hash and the SCALE bytes', () => {
    const e = envelope();
    const expected = blake2AsU8a(u8aConcat(stringToU8a('ScalarMsg/v1|'), GENESIS, encodeEnvelope(e)), 256);
    expect(SIGNING_DOMAIN).toBe('ScalarMsg/v1|');
    expect(u8aToHex(envelopeSigningHash(e, GENESIS))).toBe(u8aToHex(expected));
  });

  it('refuses a genesis hash that is not 32 bytes', () => {
    expect(() => envelopeSigningHash(envelope(), new Uint8Array(31))).toThrow(/genesis/);
  });
});

describe('createMessage', () => {
  it('commits to blake2_256 of the plaintext and signs the signing hash as the sender', () => {
    const m = msg();
    expect(u8aToHex(m.envelope.payloadHash)).toBe(u8aToHex(blake2AsU8a(plaintext, 256)));
    expect(u8aToHex(m.envelope.from)).toBe(u8aToHex(alice.publicKey));
    expect(sr25519Verify(envelopeSigningHash(m.envelope, GENESIS), m.signature, alice.publicKey)).toBe(true);
    expect(m.body).toEqual({ type: 'Plain', bytes: plaintext });
  });

  it('keeps payload_hash over the plaintext when the body is sealed', () => {
    const sealed = sealBody(plaintext, deriveMessagingKey('//Alice'), deriveMessagingKey('//Bob').publicKey);
    const m = msg({ body: sealed });
    expect(u8aToHex(m.envelope.payloadHash)).toBe(u8aToHex(blake2AsU8a(plaintext, 256)));
  });

  it('refuses a non-sr25519 signer', () => {
    const ed = new Keyring({ type: 'ed25519' }).addFromUri('//Alice');
    expect(() => msg({}, ed)).toThrow(/sr25519/);
  });
});

describe('MessageInbox.receive — verification rules', () => {
  it('accepts a valid Plain message and returns the sender and plaintext', () => {
    const got = inbox().receive(bytes(msg()), 999);
    expect(got.from).toBe(alice.address);
    expect(got.kind).toBe('Offer');
    expect(got.bodyType).toBe('Plain');
    expect(u8aToHex(got.plaintext)).toBe(u8aToHex(plaintext));
  });

  it('rejects a signature by anyone other than `from` (wrong signer)', () => {
    const forged = { ...msg(), signature: msg({}, carol).signature };
    expect(reason(() => inbox().receive(encodeSignedMessage(forged), 1))).toBe('bad-signature');
  });

  it('rejects a `from` that is not a valid public key as bad-signature, not a crash', () => {
    const m = msg();
    const bogus = { ...m, envelope: { ...m.envelope, from: new Uint8Array(32).fill(0xff) } };
    expect(reason(() => inbox().receive(encodeSignedMessage(bogus), 1))).toBe('bad-signature');
  });

  it('rejects any field changed after signing', () => {
    const m = msg();
    const tampered = { ...m, envelope: { ...m.envelope, kind: 'Accept' as const } };
    expect(reason(() => inbox().receive(encodeSignedMessage(tampered), 1))).toBe('bad-signature');
  });

  it('rejects a message signed for another chain (genesis binding)', () => {
    expect(reason(() => inbox().receive(bytes(msg({ genesisHash: OTHER_GENESIS })), 1))).toBe('bad-signature');
  });

  it('rejects a message addressed to someone else', () => {
    expect(reason(() => inbox(carol).receive(bytes(msg()), 1))).toBe('wrong-recipient');
  });

  it('rejects expires_at_block < best block, accepts equality', () => {
    expect(reason(() => inbox().receive(bytes(msg()), 1_001))).toBe('expired');
    expect(() => inbox().receive(bytes(msg()), 1_000)).not.toThrow();
  });

  it('rejects a body whose blake2_256 differs from payload_hash', () => {
    const m = msg();
    const swapped = { ...m, body: { type: 'Plain' as const, bytes: stringToU8a('{"offer":"1 CMN"}') } };
    expect(reason(() => inbox().receive(encodeSignedMessage(swapped), 1))).toBe('payload-hash-mismatch');
  });

  it('rejects replays and non-increasing nonces per (from, to)', () => {
    const box = inbox();
    box.receive(bytes(msg({ nonce: 5n })), 1);
    expect(reason(() => box.receive(bytes(msg({ nonce: 5n })), 1))).toBe('replay');
    expect(reason(() => box.receive(bytes(msg({ nonce: 4n })), 1))).toBe('replay');
    expect(() => box.receive(bytes(msg({ nonce: 6n })), 1)).not.toThrow();
  });

  it('tracks nonces independently per sender', () => {
    const box = inbox();
    box.receive(bytes(msg({ nonce: 5n })), 1);
    expect(() => box.receive(bytes(msg({ nonce: 1n }, carol)), 1)).not.toThrow();
  });

  it('does not consume a nonce when a later check fails', () => {
    const box = inbox();
    const m = msg({ nonce: 9n });
    const bad = { ...m, body: { type: 'Plain' as const, bytes: new Uint8Array([1]) } };
    expect(reason(() => box.receive(encodeSignedMessage(bad), 1))).toBe('payload-hash-mismatch');
    expect(() => box.receive(bytes(m), 1)).not.toThrow();
  });

  it('rejects an unknown envelope version', () => {
    const m = msg();
    const v2 = { ...m, envelope: { ...m.envelope, version: 2 } };
    expect(reason(() => inbox().receive(encodeSignedMessage(v2), 1))).toBe('unsupported-version');
  });

  it('hash-only (Body::None) needs the content out of band, then checks it', () => {
    const m = msg({ body: { type: 'None' } });
    const box = inbox();
    expect(reason(() => box.receive(bytes(m), 1))).toBe('content-missing');
    expect(reason(() => box.receive(bytes(m), 1, { detachedPlaintext: new Uint8Array([1]) }))).toBe(
      'payload-hash-mismatch',
    );
    const got = box.receive(bytes(m), 1, { detachedPlaintext: plaintext });
    expect(got.bodyType).toBe('None');
    expect(u8aToHex(got.plaintext)).toBe(u8aToHex(plaintext));
  });

  it('shares state through an injected NonceTracker (restart safety)', () => {
    const tracker = new NonceTracker();
    new MessageInbox({ self: bob.address, genesisHash: GENESIS, nonces: tracker }).receive(bytes(msg({ nonce: 3n })), 1);
    const box = new MessageInbox({ self: bob.address, genesisHash: GENESIS, nonces: new NonceTracker(tracker.toJSON()) });
    expect(reason(() => box.receive(bytes(msg({ nonce: 3n })), 1))).toBe('replay');
  });
});

describe('MessageInbox.receive — Sealed bodies', () => {
  const aliceKey = () => deriveMessagingKey('//Alice');
  const bobKey = () => deriveMessagingKey('//Bob');
  const sealed = () => msg({ body: sealBody(plaintext, aliceKey(), bobKey().publicKey) });

  it("decrypts when sender_key is the sender's published key", () => {
    const got = inbox().receive(bytes(sealed()), 1, { senderMessagingKey: aliceKey().publicKey });
    expect(got.bodyType).toBe('Sealed');
    expect(u8aToHex(got.plaintext)).toBe(u8aToHex(plaintext));
  });

  it('rejects when the sender has no published key, or a different one', () => {
    expect(reason(() => inbox().receive(bytes(sealed()), 1))).toBe('sender-key-mismatch');
    expect(reason(() => inbox().receive(bytes(sealed()), 1, { senderMessagingKey: null }))).toBe('sender-key-mismatch');
    const rotated = deriveMessagingKey('//Alice', { rotation: 1 }).publicKey;
    expect(reason(() => inbox().receive(bytes(sealed()), 1, { senderMessagingKey: rotated }))).toBe(
      'sender-key-mismatch',
    );
  });

  it('rejects a box it cannot open (sealed to someone else)', () => {
    const toCarol = msg({ body: sealBody(plaintext, aliceKey(), deriveMessagingKey('//Charlie').publicKey) });
    expect(reason(() => inbox().receive(bytes(toCarol), 1, { senderMessagingKey: aliceKey().publicKey }))).toBe(
      'decrypt-failed',
    );
  });

  it('rejects a sealed message when the inbox has no messaging key', () => {
    const box = new MessageInbox({ self: bob.address, genesisHash: GENESIS });
    expect(reason(() => box.receive(bytes(sealed()), 1, { senderMessagingKey: aliceKey().publicKey }))).toBe(
      'decrypt-failed',
    );
  });
});

describe('MessageInbox.receive — on-chain call must repeat the envelope (rule 6)', () => {
  const agreement = () => ({ account: bob.address, seq: 3 });
  const m = () => msg({ agreement: agreement() });
  const call = (over: Partial<OnChainCall> = {}): OnChainCall => ({
    origin: alice.address,
    to: bob.address,
    kind: 'Offer',
    agreement: agreement(),
    payloadHash: m().envelope.payloadHash,
    ...over,
  });

  it('accepts a call whose every argument matches', () => {
    expect(() => inbox().receive(bytes(m()), 1, { call: call() })).not.toThrow();
  });

  it.each([
    ['signer', { origin: '' }],
    ['to', { to: '' }],
    ['kind', { kind: 'Accept' as const }],
    ['agreement', { agreement: null }],
    ['agreement seq', { agreement: { account: '', seq: 4 } }],
    ['payload_hash', { payloadHash: new Uint8Array(32) }],
    ['payload_hash None', { payloadHash: null }],
  ])('rejects a mismatched %s', (_name, over) => {
    const patch = { ...over } as Partial<OnChainCall>;
    if (patch.origin === '') patch.origin = carol.address;
    if (patch.to === '') patch.to = carol.address;
    if (patch.agreement && (patch.agreement as { account: string }).account === '') {
      patch.agreement = { account: bob.address, seq: 4 };
    }
    expect(reason(() => inbox().receive(bytes(m()), 1, { call: call(patch) }))).toBe('call-mismatch');
  });
});

describe('OutboundNonces', () => {
  it('is strictly increasing per recipient, and survives a restart without reuse', () => {
    let now = 1_700_000_000_000;
    const a = new OutboundNonces(() => now);
    const n1 = a.next(bob.address);
    const n2 = a.next(bob.address);
    expect(n2).toBeGreaterThan(n1);
    // Restart one millisecond later with no persisted state: the clock
    // component alone moves the nonce past everything issued before.
    now += 1;
    const b = new OutboundNonces(() => now);
    expect(b.next(bob.address)).toBeGreaterThan(n2);
  });

  it('never goes backwards when the clock does', () => {
    let now = 1_700_000_000_000;
    const a = new OutboundNonces(() => now);
    const n1 = a.next(bob.address);
    now -= 60_000;
    expect(a.next(bob.address)).toBeGreaterThan(n1);
  });
});
