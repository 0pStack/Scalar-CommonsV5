// Regenerate tests/vectors/envelope.json from the built SDK (npm run vectors).
//
// Keys are the public Substrate dev accounts (//Alice, //Bob, //Charlie), so the
// file holds no secret. The genesis hash is 0x11…11, the stand-in the Rust
// reference (pallets/messages/src/envelope_tests.rs) uses, and the first vector
// is that file's pinned one. sr25519 signatures are randomised, so they are
// samples that must *verify*; everything else — including sealed ciphertexts,
// whose box nonces are fixed here — is deterministic and tests/vectors.test.ts
// recomputes it byte for byte.
import { writeFileSync } from 'node:fs';
import { Keyring } from '@polkadot/keyring';
import { stringToU8a, u8aToHex } from '@polkadot/util';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import {
  createMessage,
  deriveMessagingKey,
  encodeBody,
  encodeEnvelope,
  encodeSignedMessage,
  envelopeSigningHash,
  sealBody,
} from '../dist/index.js';

await cryptoWaitReady();
const kr = new Keyring({ type: 'sr25519', ss58Format: 42 });
const accounts = { '//Alice': kr.addFromUri('//Alice'), '//Bob': kr.addFromUri('//Bob'), '//Charlie': kr.addFromUri('//Charlie') };
const genesisHash = u8aToHex(new Uint8Array(32).fill(0x11));

const cases = [
  { name: 'rust-reference-offer', from: '//Alice', to: '//Bob', kind: 'Offer', agreement: { account: '//Bob', seq: 3 }, nonce: 1n, expiresAtBlock: 1_200_000, plaintext: 'offer: 25 CMN for report #7, deliver by block 1200000', body: 'Plain' },
  { name: 'accept-sealed', from: '//Bob', to: '//Alice', kind: 'Accept', agreement: { account: '//Alice', seq: 3 }, nonce: 1_700_000_000_000_000n, expiresAtBlock: 4_294_967_295, plaintext: '{"accept":true}', body: 'Sealed', boxNonce: 0x01 },
  { name: 'delivery-notice-hash-only', from: '//Alice', to: '//Bob', kind: 'DeliveryNotice', agreement: { account: '//Alice', seq: 0 }, nonce: 2n, expiresAtBlock: 1_200, plaintext: '{"report":"0x11"}', body: 'None' },
  { name: 'ping-empty', from: '//Charlie', to: '//Alice', kind: 'Ping', agreement: null, nonce: 18_446_744_073_709_551_615n, expiresAtBlock: 0, plaintext: '', body: 'Plain' },
];

const vectors = {
  description: 'Scalar Commons spec-308 signed message envelope v1 test vectors. See docs/reference/messaging.md.',
  generator: 'sdk/scripts/gen-envelope-vectors.mjs',
  signingDomain: 'ScalarMsg/v1|',
  genesisHash,
  ss58Format: 42,
  messages: cases.map((c) => {
    const signer = accounts[c.from];
    const plaintext = stringToU8a(c.plaintext);
    const body =
      c.body === 'Sealed'
        ? sealBody(plaintext, deriveMessagingKey(c.from), deriveMessagingKey(c.to).publicKey, new Uint8Array(24).fill(c.boxNonce))
        : c.body === 'None' ? { type: 'None' } : undefined;
    const agreement = c.agreement ? { account: accounts[c.agreement.account].address, seq: c.agreement.seq } : null;
    const m = createMessage(signer, { to: accounts[c.to].address, kind: c.kind, plaintext, body, nonce: c.nonce, expiresAtBlock: c.expiresAtBlock, genesisHash, agreement });
    return {
      name: c.name,
      input: {
        fromUri: c.from,
        from: signer.address,
        toUri: c.to,
        to: accounts[c.to].address,
        kind: c.kind,
        agreement,
        nonce: c.nonce.toString(),
        expiresAtBlock: c.expiresAtBlock,
        plaintext: u8aToHex(plaintext),
        body: c.body,
        ...(c.body === 'Sealed' ? { boxNonce: u8aToHex(body.nonce) } : {}),
      },
      expected: {
        payloadHash: u8aToHex(m.envelope.payloadHash),
        scaleEnvelope: u8aToHex(encodeEnvelope(m.envelope)),
        signingHash: u8aToHex(envelopeSigningHash(m.envelope, genesisHash)),
        scaleBody: u8aToHex(encodeBody(m.body)),
      },
      sample: { signature: u8aToHex(m.signature), signedMessage: u8aToHex(encodeSignedMessage(m)) },
    };
  }),
  messagingKeys: [
    { suri: '//Alice', rotation: 0 },
    { suri: '//Bob', rotation: 0 },
    { suri: '//Bob', rotation: 1 },
  ].map((k) => ({ ...k, publicKey: u8aToHex(deriveMessagingKey(k.suri, { rotation: k.rotation }).publicKey) })),
};

const path = new URL('../tests/vectors/envelope.json', import.meta.url);
writeFileSync(path, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`wrote ${vectors.messages.length} message vectors to ${path.pathname}`);
