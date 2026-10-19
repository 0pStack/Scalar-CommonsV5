import { beforeAll, describe, expect, it } from 'vitest';
import { Keyring } from '@polkadot/keyring';
import { hexToU8a, stringToU8a, u8aToHex } from '@polkadot/util';
import { cryptoWaitReady } from '@polkadot/util-crypto';

import {
  BOX_MAC_LENGTH,
  MessageRejected,
  boxBeforenm,
  deriveMessagingKey,
  hsalsa20,
  openBody,
  sealBody,
} from '../src/index.js';

/**
 * Offline tests for the X25519 messaging key (D14) and `Sealed` bodies (NaCl `box`).
 * The mnemonic below is the public Substrate dev phrase — never a real key.
 */
const DEV_PHRASE = 'bottom drive obey lake curtain smoke basket hold race lonely fit walk';

beforeAll(async () => {
  await cryptoWaitReady();
});

describe('deriveMessagingKey', () => {
  it('derives from the same account secret the keyring signs with', () => {
    const kr = new Keyring({ type: 'sr25519' });
    for (const suri of ['//Alice', '//Bob//msg', `${DEV_PHRASE}//hard/soft`, `${DEV_PHRASE}///pw`, DEV_PHRASE]) {
      expect(u8aToHex(deriveMessagingKey(suri).accountId), suri).toBe(u8aToHex(kr.addFromUri(suri).publicKey));
    }
  });

  it('is deterministic, 32 bytes, and distinct per account', () => {
    const a1 = deriveMessagingKey('//Alice');
    const b = deriveMessagingKey('//Bob');
    expect(a1.publicKey.length).toBe(32);
    expect(a1.secretKey.length).toBe(32);
    expect(u8aToHex(a1.publicKey)).toBe(u8aToHex(deriveMessagingKey('//Alice').publicKey));
    expect(u8aToHex(a1.publicKey)).not.toBe(u8aToHex(b.publicKey));
  });

  it('never reuses the sr25519 key bytes as the X25519 key', () => {
    const k = deriveMessagingKey('//Alice');
    expect(u8aToHex(k.publicKey)).not.toBe(u8aToHex(k.accountId));
  });

  it('rotates to an unrelated key per rotation index', () => {
    const r0 = deriveMessagingKey('//Alice');
    expect(u8aToHex(r0.publicKey)).toBe(u8aToHex(deriveMessagingKey('//Alice', { rotation: 0 }).publicKey));
    expect(u8aToHex(deriveMessagingKey('//Alice', { rotation: 1 }).publicKey)).not.toBe(u8aToHex(r0.publicKey));
    expect(() => deriveMessagingKey('//Alice', { rotation: -1 })).toThrow(/rotation/);
  });

  it('refuses a secret that is neither a mnemonic, a 32-byte hex seed nor a dev URI', () => {
    expect(() => deriveMessagingKey('not a mnemonic')).toThrow(/mnemonic/);
  });
});

describe('NaCl box primitives', () => {
  it('HSalsa20 / crypto_box_beforenm match the NaCl reference vector', () => {
    // "Cryptography in NaCl" §§ 4–5: Alice's secret, Bob's public → firstkey.
    const aliceSk = hexToU8a('0x77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
    const bobPk = hexToU8a('0xde9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');
    expect(u8aToHex(boxBeforenm(bobPk, aliceSk))).toBe('0x1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389');
    const shared = hexToU8a('0x4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742');
    expect(u8aToHex(hsalsa20(shared, new Uint8Array(16)))).toBe(
      '0x1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389',
    );
  });

  it('matches libsodium crypto_box byte for byte (vector generated with PyNaCl 1.6.2)', () => {
    // Box from //Alice's derived messaging key to //Bob's, nonce 0x07 × 24.
    const sealed = sealBody(
      stringToU8a('hello libsodium'),
      deriveMessagingKey('//Alice'),
      deriveMessagingKey('//Bob').publicKey,
      new Uint8Array(24).fill(7),
    );
    expect(u8aToHex(sealed.ciphertext)).toBe('0xe16dfd8957df720c6e19ef90b4fb04c27edfbdac5f7c73ac37fe26a1e7df25');
  });
});

describe('sealBody / openBody', () => {
  const plaintext = stringToU8a('{"price":"10 CMN","deliverBy":1200}');
  const alice = () => deriveMessagingKey('//Alice');
  const bob = () => deriveMessagingKey('//Bob');

  it('round-trips, carrying the sender key and adding a 16-byte MAC', () => {
    const body = sealBody(plaintext, alice(), bob().publicKey);
    expect(u8aToHex(body.senderKey)).toBe(u8aToHex(alice().publicKey));
    expect(body.nonce.length).toBe(24);
    expect(body.ciphertext.length).toBe(plaintext.length + BOX_MAC_LENGTH);
    expect(u8aToHex(openBody(body, bob()))).toBe(u8aToHex(plaintext));
  });

  it('uses a fresh nonce every time', () => {
    expect(u8aToHex(sealBody(plaintext, alice(), bob().publicKey).nonce)).not.toBe(
      u8aToHex(sealBody(plaintext, alice(), bob().publicKey).nonce),
    );
  });

  it('cannot be opened by anyone else', () => {
    const body = sealBody(plaintext, alice(), bob().publicKey);
    expect(() => openBody(body, deriveMessagingKey('//Charlie'))).toThrow(MessageRejected);
    expect(() => openBody(body, deriveMessagingKey('//Bob', { rotation: 1 }))).toThrow(/decrypt/);
  });

  it('detects tampering with the ciphertext, the nonce or the sender key', () => {
    const body = sealBody(plaintext, alice(), bob().publicKey);
    const flip = (b: Uint8Array, i: number) => {
      const c = b.slice();
      c[i]! ^= 1;
      return c;
    };
    expect(() => openBody({ ...body, ciphertext: flip(body.ciphertext, 0) }, bob())).toThrow(MessageRejected);
    expect(() => openBody({ ...body, ciphertext: flip(body.ciphertext, body.ciphertext.length - 1) }, bob())).toThrow(
      MessageRejected,
    );
    expect(() => openBody({ ...body, nonce: flip(body.nonce, 3) }, bob())).toThrow(MessageRejected);
    expect(() => openBody({ ...body, senderKey: deriveMessagingKey('//Charlie').publicKey }, bob())).toThrow(
      MessageRejected,
    );
  });

  it('refuses a low-order recipient key', () => {
    expect(() => sealBody(plaintext, alice(), new Uint8Array(32))).toThrow();
  });

  it('seals an empty plaintext', () => {
    expect(openBody(sealBody(new Uint8Array(), alice(), bob().publicKey), bob()).length).toBe(0);
  });
});
