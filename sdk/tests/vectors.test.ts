import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { cryptoWaitReady, decodeAddress } from '@polkadot/util-crypto';

import {
  MessageInbox,
  createMessage,
  decodeSignedMessage,
  deriveMessagingKey,
  encodeBody,
  encodeEnvelope,
  envelopeSigningHash,
  openBody,
  sealBody,
  type Body,
  type MessageKind,
} from '../src/index.js';

/**
 * Re-verifies the committed vectors (tests/vectors/envelope.json) on every CI
 * run. Deterministic fields are recomputed byte for byte; the randomised sr25519
 * signatures must verify. A change to the encoding, the signing hash, the key
 * derivation or the box turns this red — which is the point: other
 * implementations (the Rust reference in pallets/messages) are held to these bytes.
 */
interface Vector {
  name: string;
  input: {
    fromUri: string;
    from: string;
    toUri: string;
    to: string;
    kind: MessageKind;
    agreement: { account: string; seq: number } | null;
    nonce: string;
    expiresAtBlock: number;
    plaintext: string;
    body: Body['type'];
    boxNonce?: string;
  };
  expected: { payloadHash: string; scaleEnvelope: string; signingHash: string; scaleBody: string };
  sample: { signature: string; signedMessage: string };
}
const file = JSON.parse(readFileSync(new URL('./vectors/envelope.json', import.meta.url), 'utf8')) as {
  genesisHash: string;
  signingDomain: string;
  messages: Vector[];
  messagingKeys: { suri: string; rotation: number; publicKey: string }[];
};

beforeAll(async () => {
  await cryptoWaitReady();
});

/** Rebuild the message from the vector's inputs with a throwaway signature. */
function rebuild(v: Vector) {
  const plaintext = hexToU8a(v.input.plaintext);
  const body: Body | undefined =
    v.input.body === 'Sealed'
      ? sealBody(plaintext, deriveMessagingKey(v.input.fromUri), deriveMessagingKey(v.input.toUri).publicKey, hexToU8a(v.input.boxNonce!))
      : v.input.body === 'None'
        ? { type: 'None' }
        : undefined;
  const signer = { type: 'sr25519' as const, publicKey: decodeAddress(v.input.from), sign: () => new Uint8Array(64) };
  return createMessage(signer, {
    to: v.input.to,
    kind: v.input.kind,
    plaintext,
    body,
    nonce: BigInt(v.input.nonce),
    expiresAtBlock: v.input.expiresAtBlock,
    genesisHash: file.genesisHash,
    agreement: v.input.agreement,
  });
}

describe('envelope vectors', () => {
  it('cover every body type, with and without an agreement, and the Rust reference vector', () => {
    expect(file.signingDomain).toBe('ScalarMsg/v1|');
    expect(new Set(file.messages.map((v) => v.input.body))).toEqual(new Set(['Plain', 'Sealed', 'None']));
    expect(file.messages.some((v) => v.input.agreement === null)).toBe(true);
    const rust = file.messages.find((v) => v.name === 'rust-reference-offer')!;
    expect(rust.expected.signingHash).toBe('0xe5bba61ef4d05553662760a8ae8ff35576c165b88e4441ea5a96f9f9fd99d421');
  });

  for (const v of file.messages) {
    describe(v.name, () => {
      it('recomputes payload hash, SCALE envelope, signing hash and SCALE body exactly', () => {
        const m = rebuild(v);
        expect(u8aToHex(m.envelope.payloadHash)).toBe(v.expected.payloadHash);
        expect(u8aToHex(encodeEnvelope(m.envelope))).toBe(v.expected.scaleEnvelope);
        expect(u8aToHex(envelopeSigningHash(m.envelope, file.genesisHash))).toBe(v.expected.signingHash);
        expect(u8aToHex(encodeBody(m.body))).toBe(v.expected.scaleBody);
      });

      it('sample SignedMessage decodes to the same parts and passes every verification rule', () => {
        const bytes = hexToU8a(v.sample.signedMessage);
        const decoded = decodeSignedMessage(bytes);
        const m = rebuild(v);
        expect(decoded.envelope).toEqual(m.envelope);
        expect(decoded.body).toEqual(m.body);
        expect(u8aToHex(decoded.signature)).toBe(v.sample.signature);

        const recipientKey = deriveMessagingKey(v.input.toUri);
        const inbox = new MessageInbox({
          self: v.input.to,
          genesisHash: file.genesisHash,
          open: (b) => openBody(b, recipientKey),
        });
        const got = inbox.receive(bytes, v.input.expiresAtBlock, {
          senderMessagingKey: deriveMessagingKey(v.input.fromUri).publicKey,
          detachedPlaintext: hexToU8a(v.input.plaintext),
          call: {
            origin: v.input.from,
            to: v.input.to,
            kind: v.input.kind,
            agreement: v.input.agreement,
            payloadHash: hexToU8a(v.expected.payloadHash),
          },
        });
        expect(got.from).toBe(v.input.from);
        expect(u8aToHex(got.plaintext)).toBe(v.input.plaintext);
      });
    });
  }

  it('messaging keys derive exactly', () => {
    for (const k of file.messagingKeys) {
      expect(u8aToHex(deriveMessagingKey(k.suri, { rotation: k.rotation }).publicKey), `${k.suri}#${k.rotation}`).toBe(
        k.publicKey,
      );
    }
  });
});
