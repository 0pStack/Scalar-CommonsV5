/**
 * Messaging keys (D14) and `Sealed` bodies encrypted to them.
 *
 * Every agent may publish one X25519 public key with `agents.set_messaging_key`.
 * A `Sealed` body is a NaCl `box` from the sender's messaging key to the
 * recipient's, so negotiation terms travel over a public chain without being
 * readable by anyone but the two parties. The body carries the sender's key,
 * which the recipient checks against `agents.messagingKey(from)`.
 *
 * Derivation — one secret to back up, not two:
 *
 *   x25519_secret = blake2_256(b"ScalarMsg/x25519/v1|" ++ u32_le(rotation) ++ sr25519_secret_key)
 *
 * where `sr25519_secret_key` is the 64-byte expanded key the keyring derives
 * from the agent's mnemonic / URI (path and password applied). The hash is
 * one-way, so leaking the messaging key never leaks the account key; the
 * rotation index gives unrelated keys for rotation without a new mnemonic.
 *
 * Encryption — NaCl `crypto_box` (libsodium `crypto_box_easy`), exactly:
 *
 *   k          = HSalsa20(X25519(own_secret, their_public), 0^16)   // crypto_box_beforenm
 *   ciphertext = XSalsa20-Poly1305(k, nonce, plaintext)             // crypto_secretbox: MAC(16) ‖ ct
 *
 * X25519 is `@noble/curves`; XSalsa20-Poly1305 is `@polkadot/util-crypto`'s
 * `naclEncrypt` (tweetnacl's secretbox). util-crypto 13/14 dropped `naclSeal`
 * (the old tweetnacl `box`), so HSalsa20 is implemented here; the tests pin the
 * NaCl reference vector and a libsodium-generated box.
 */
import { x25519 } from '@noble/curves/ed25519';
import { DEV_PHRASE } from '@polkadot/keyring';
import { hexToU8a, isHex, stringToU8a, u8aConcat } from '@polkadot/util';
import {
  blake2AsU8a,
  keyExtractSuri,
  keyFromPath,
  mnemonicToMiniSecret,
  naclDecrypt,
  naclEncrypt,
  randomAsU8a,
  sr25519PairFromSeed,
} from '@polkadot/util-crypto';

import { MessageRejected, type Body } from './envelope.js';

const KEY_DOMAIN = 'ScalarMsg/x25519/v1|';

/** Poly1305 tag bytes a `Sealed` ciphertext adds to the plaintext. */
export const BOX_MAC_LENGTH = 16;

/** An agent's X25519 messaging keypair, plus the account it was derived from. */
export interface MessagingKeypair {
  /** Publish this with `agents.set_messaging_key`. */
  publicKey: Uint8Array;
  /** Never leaves the agent. */
  secretKey: Uint8Array;
  /** The sr25519 AccountId the key was derived from. */
  accountId: Uint8Array;
}

/**
 * The sr25519 pair the keyring would build for `suri`: mnemonic, 32-byte hex
 * seed, or dev `//URI`, with `//hard`, `/soft` and `///password` applied.
 * Raw short-string seeds, which the keyring pads and accepts, are refused.
 */
function sr25519FromSuri(suri: string): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const full = suri.startsWith('//') ? `${DEV_PHRASE}${suri}` : suri;
  const { password, path, phrase } = keyExtractSuri(full);
  let seed: Uint8Array;
  if (isHex(phrase, 256)) {
    seed = hexToU8a(phrase);
  } else if ([12, 15, 18, 21, 24].includes(phrase.split(' ').length)) {
    seed = mnemonicToMiniSecret(phrase, password);
  } else {
    throw new Error('secret must be a mnemonic, a 32-byte hex seed or a dev //URI');
  }
  return keyFromPath(sr25519PairFromSeed(seed), path, 'sr25519');
}

/** Derive the agent's X25519 messaging keypair from its account secret. Deterministic. */
export function deriveMessagingKey(suri: string, opts: { rotation?: number } = {}): MessagingKeypair {
  const rotation = opts.rotation ?? 0;
  if (!Number.isInteger(rotation) || rotation < 0 || rotation > 0xffff_ffff) {
    throw new Error(`rotation must be a u32, got ${rotation}`);
  }
  const account = sr25519FromSuri(suri);
  const index = new Uint8Array(4);
  new DataView(index.buffer).setUint32(0, rotation, true);
  const secretKey = blake2AsU8a(u8aConcat(stringToU8a(KEY_DOMAIN), index, account.secretKey), 256);
  return { publicKey: x25519.getPublicKey(secretKey), secretKey, accountId: account.publicKey };
}

const rotl = (v: number, c: number) => (v << c) | (v >>> (32 - c));

/** HSalsa20 core: 32-byte key, 16-byte input → 32-byte output (NaCl `crypto_core_hsalsa20`). */
export function hsalsa20(key: Uint8Array, input: Uint8Array): Uint8Array {
  if (key.length !== 32 || input.length !== 16) throw new Error('hsalsa20 needs a 32-byte key and a 16-byte input');
  const kv = new DataView(key.buffer, key.byteOffset, 32);
  const iv = new DataView(input.buffer, input.byteOffset, 16);
  const k = (i: number) => kv.getUint32(i * 4, true);
  const n = (i: number) => iv.getUint32(i * 4, true);
  // "expand 32-byte k"
  const x = [0x61707865, k(0), k(1), k(2), k(3), 0x3320646e, n(0), n(1), n(2), n(3), 0x79622d32, k(4), k(5), k(6), k(7), 0x6b206574];
  const qr = (a: number, b: number, c: number, d: number) => {
    x[b]! ^= rotl((x[a]! + x[d]!) | 0, 7);
    x[c]! ^= rotl((x[b]! + x[a]!) | 0, 9);
    x[d]! ^= rotl((x[c]! + x[b]!) | 0, 13);
    x[a]! ^= rotl((x[d]! + x[c]!) | 0, 18);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12); qr(5, 9, 13, 1); qr(10, 14, 2, 6); qr(15, 3, 7, 11); // columns
    qr(0, 1, 2, 3); qr(5, 6, 7, 4); qr(10, 11, 8, 9); qr(15, 12, 13, 14); // rows
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  [0, 5, 10, 15, 6, 7, 8, 9].forEach((w, i) => ov.setUint32(i * 4, x[w]! >>> 0, true));
  return out;
}

/** `crypto_box_beforenm`: the shared secretbox key for a keypair and a peer public key. */
export function boxBeforenm(peerPublicKey: Uint8Array, ownSecretKey: Uint8Array): Uint8Array {
  if (peerPublicKey.length !== 32) throw new Error('messaging key must be 32 bytes');
  const shared = x25519.getSharedSecret(ownSecretKey, peerPublicKey);
  // noble rejects low-order points; keep the check explicit so a future
  // library change cannot silently weaken it.
  if (shared.every((b) => b === 0)) throw new Error('low-order X25519 public key');
  return hsalsa20(shared, new Uint8Array(16));
}

/**
 * Build a `Sealed` body: NaCl `box` of `plaintext` from `sender`'s messaging
 * key to `recipientPublicKey`. `nonce` is random unless given (tests only).
 */
export function sealBody(
  plaintext: Uint8Array,
  sender: Pick<MessagingKeypair, 'publicKey' | 'secretKey'>,
  recipientPublicKey: Uint8Array,
  nonce: Uint8Array = randomAsU8a(24),
): Extract<Body, { type: 'Sealed' }> {
  if (nonce.length !== 24) throw new Error('box nonce must be 24 bytes');
  const { encrypted } = naclEncrypt(plaintext, boxBeforenm(recipientPublicKey, sender.secretKey), nonce);
  return { type: 'Sealed', senderKey: sender.publicKey, nonce, ciphertext: encrypted };
}

/** Open a `Sealed` body with the recipient's messaging keypair. Failure is `MessageRejected('decrypt-failed')`. */
export function openBody(
  body: Extract<Body, { type: 'Sealed' }>,
  recipient: Pick<MessagingKeypair, 'secretKey'>,
): Uint8Array {
  let plaintext: Uint8Array | null;
  try {
    plaintext = naclDecrypt(body.ciphertext, body.nonce, boxBeforenm(body.senderKey, recipient.secretKey));
  } catch (err) {
    throw new MessageRejected('decrypt-failed', err instanceof Error ? err.message : String(err));
  }
  if (plaintext === null) throw new MessageRejected('decrypt-failed', 'authentication tag mismatch');
  return plaintext;
}
