/**
 * The spec-308 signed message envelope, version 1.
 *
 * Normative spec: `docs/reference/messaging.md` and its Rust reference,
 * `pallets/messages/src/envelope.rs`. This module is the TypeScript mirror of
 * that reference; `tests/envelope.test.ts` pins the Rust vectors byte for byte.
 *
 * Why an envelope at all, when `pallet-messages` already authenticates the
 * extrinsic signer: the same message must be verifiable when it arrives over
 * HTTPS, where there is no extrinsic. The envelope is the transport-independent
 * commitment — who, to whom, what kind, about which agreement, which nonce,
 * valid until when, and the hash of the plaintext — signed by the sender's
 * account key. And because every field the `send` call repeats must equal the
 * envelope, *what an agent signs is what the chain carries*: mismatches between
 * a sender and a strict verifier are impossible by construction.
 */
import type { KeyringPair } from '@polkadot/keyring/types';
import { compactFromU8a, compactToU8a, hexToU8a, isHex, stringToU8a, u8aConcat, u8aEq, u8aToHex } from '@polkadot/util';
import { blake2AsU8a, decodeAddress, encodeAddress, sr25519Verify } from '@polkadot/util-crypto';

/** Envelope format version this SDK produces and accepts. */
export const ENVELOPE_VERSION = 1;

/** Domain separator (`b"ScalarMsg/v1|"`, 13 ASCII bytes) at the start of every signing preimage. */
export const SIGNING_DOMAIN = 'ScalarMsg/v1|';

/** Maximum `payload` bytes `pallet-messages::send` accepts (`BoundedVec<u8, ConstU32<2048>>`). */
export const MAX_ONCHAIN_PAYLOAD = 2048;

/** Length of an sr25519 signature. */
export const SIGNATURE_LENGTH = 64;

/**
 * Message kinds, in `pallet-messages::MessageKind` variant order: the index in
 * this array is the `kind: u8` in the envelope and the SCALE enum index on chain.
 */
export const MESSAGE_KINDS = [
  'Offer',
  'Bid',
  'Accept',
  'Reject',
  'DeliveryNotice',
  'DisputeNote',
  'Announce',
  'Ping',
] as const;

export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** An account given as SS58 / hex string, or as the raw 32-byte AccountId. */
export type AccountLike = string | Uint8Array;

/** `(counterparty, escrow seq)` the message is about: `Option<(AccountId, u32)>`. */
export interface AgreementRef {
  account: Uint8Array;
  seq: number;
}

/** The signed struct. Account and hash fields are raw 32-byte values. */
export interface Envelope {
  version: number;
  from: Uint8Array;
  to: Uint8Array;
  kind: MessageKind;
  agreement: AgreementRef | null;
  /** Strictly increasing per (from, to) pair; u64. */
  nonce: bigint;
  /** Last block at which the message is still valid; u32. */
  expiresAtBlock: number;
  /** blake2_256 of the **plaintext** body. */
  payloadHash: Uint8Array;
}

/**
 * The content that travels next to the envelope (`enum Body`):
 * `None` = hash-only (content delivered elsewhere), `Plain` = plaintext,
 * `Sealed` = NaCl `box` from the sender's messaging key to the recipient's.
 */
export type Body =
  | { type: 'None' }
  | { type: 'Plain'; bytes: Uint8Array }
  | { type: 'Sealed'; senderKey: Uint8Array; nonce: Uint8Array; ciphertext: Uint8Array };

/** `SignedMessage = SCALE((envelope, signature: [u8; 64], body: Body))`. */
export interface SignedMessage {
  envelope: Envelope;
  signature: Uint8Array;
  body: Body;
}

/** Why a message was refused. Stable strings: log them, branch on them. */
export type RejectReason =
  | 'malformed'
  | 'unsupported-version'
  | 'wrong-recipient'
  | 'expired'
  | 'replay'
  | 'bad-signature'
  | 'call-mismatch'
  | 'content-missing'
  | 'sender-key-mismatch'
  | 'decrypt-failed'
  | 'payload-hash-mismatch';

/** A message that failed a verification rule. Nothing about it may be acted on. */
export class MessageRejected extends Error {
  constructor(
    readonly reason: RejectReason,
    detail: string,
  ) {
    super(`message rejected (${reason}): ${detail}`);
    this.name = 'MessageRejected';
  }
}

const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = 0xffff_ffff;
const BODY_TAGS = { None: 0, Plain: 1, Sealed: 2 } as const;

/** Resolve an {@link AccountLike} to its 32-byte AccountId. */
export function toAccountId(who: AccountLike, what = 'account'): Uint8Array {
  const bytes = typeof who === 'string' ? decodeAddress(who) : who;
  if (bytes.length !== 32) throw new Error(`${what} must be a 32-byte AccountId, got ${bytes.length} bytes`);
  return bytes;
}

function needLen(bytes: Uint8Array, n: number, what: string): Uint8Array {
  if (bytes.length !== n) throw new Error(`${what} must be ${n} bytes, got ${bytes.length}`);
  return bytes;
}

function u32le(n: number, what: string): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > U32_MAX) throw new Error(`${what} must be a u32, got ${n}`);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

function u64le(n: bigint, what: string): Uint8Array {
  if (n < 0n || n > U64_MAX) throw new Error(`${what} must be a u64, got ${n}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
}

/** SCALE `Vec<u8>`: compact length prefix, then the bytes. */
function vecU8(bytes: Uint8Array): Uint8Array {
  return u8aConcat(compactToU8a(bytes.length), bytes);
}

/**
 * Canonical SCALE encoding of the envelope struct, field by field:
 * `u8 | [u8;32] | [u8;32] | u8 | Option<([u8;32], u32)> | u64 | u32 | [u8;32]`.
 * 111 bytes without an agreement, 147 with one.
 */
export function encodeEnvelope(e: Envelope): Uint8Array {
  const kind = MESSAGE_KINDS.indexOf(e.kind);
  if (kind < 0) throw new Error(`unknown message kind ${String(e.kind)}`);
  if (!Number.isInteger(e.version) || e.version < 0 || e.version > 0xff) {
    throw new Error(`version must be a u8, got ${e.version}`);
  }
  const agreement = e.agreement
    ? u8aConcat([1], needLen(e.agreement.account, 32, 'agreement.account'), u32le(e.agreement.seq, 'agreement.seq'))
    : new Uint8Array([0]);
  return u8aConcat(
    [e.version],
    needLen(e.from, 32, 'from'),
    needLen(e.to, 32, 'to'),
    [kind],
    agreement,
    u64le(e.nonce, 'nonce'),
    u32le(e.expiresAtBlock, 'expiresAtBlock'),
    needLen(e.payloadHash, 32, 'payloadHash'),
  );
}

/** A cursor over SCALE bytes that fails loudly on truncation. */
class Reader {
  at = 0;
  constructor(private readonly bytes: Uint8Array) {}
  take(n: number): Uint8Array {
    if (this.at + n > this.bytes.length) {
      throw new Error(`too short: need ${this.at + n} bytes, have ${this.bytes.length}`);
    }
    const out = this.bytes.slice(this.at, this.at + n);
    this.at += n;
    return out;
  }
  u8(): number {
    return this.take(1)[0]!;
  }
  u32(): number {
    const b = this.take(4);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
  }
  u64(): bigint {
    const b = this.take(8);
    return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
  }
  vec(): Uint8Array {
    const [offset, len] = compactFromU8a(this.bytes.subarray(this.at));
    if (len.bitLength() > 32) throw new Error('Vec length out of range');
    this.at += offset;
    return this.take(len.toNumber());
  }
  get rest(): number {
    return this.bytes.length - this.at;
  }
}

function readEnvelope(r: Reader): Envelope {
  const version = r.u8();
  const from = r.take(32);
  const to = r.take(32);
  const kindIndex = r.u8();
  const kind = MESSAGE_KINDS[kindIndex];
  if (kind === undefined) throw new Error(`unknown message kind index ${kindIndex}`);
  const tag = r.u8();
  let agreement: AgreementRef | null;
  if (tag === 0) agreement = null;
  else if (tag === 1) agreement = { account: r.take(32), seq: r.u32() };
  else throw new Error(`invalid agreement Option tag ${tag}`);
  const nonce = r.u64();
  const expiresAtBlock = r.u32();
  const payloadHash = r.take(32);
  return { version, from, to, kind, agreement, nonce, expiresAtBlock, payloadHash };
}

/** Decode an envelope from the start of `bytes`; `length` is how many bytes it used. */
export function decodeEnvelope(bytes: Uint8Array): { envelope: Envelope; length: number } {
  const r = new Reader(bytes);
  const envelope = readEnvelope(r);
  return { envelope, length: r.at };
}

/** SCALE of the `Body` enum. */
export function encodeBody(body: Body): Uint8Array {
  switch (body.type) {
    case 'None':
      return new Uint8Array([BODY_TAGS.None]);
    case 'Plain':
      return u8aConcat([BODY_TAGS.Plain], vecU8(body.bytes));
    case 'Sealed':
      return u8aConcat(
        [BODY_TAGS.Sealed],
        needLen(body.senderKey, 32, 'senderKey'),
        needLen(body.nonce, 24, 'nonce'),
        vecU8(body.ciphertext),
      );
  }
}

function readBody(r: Reader): Body {
  const tag = r.u8();
  if (tag === BODY_TAGS.None) return { type: 'None' };
  if (tag === BODY_TAGS.Plain) return { type: 'Plain', bytes: r.vec() };
  if (tag === BODY_TAGS.Sealed) return { type: 'Sealed', senderKey: r.take(32), nonce: r.take(24), ciphertext: r.vec() };
  throw new Error(`invalid Body tag ${tag}`);
}

/** `SCALE((envelope, signature, body))` — the bytes every transport carries. */
export function encodeSignedMessage(m: SignedMessage): Uint8Array {
  return u8aConcat(encodeEnvelope(m.envelope), needLen(m.signature, SIGNATURE_LENGTH, 'signature'), encodeBody(m.body));
}

/** Decode a `SignedMessage`. Trailing bytes are an error: there is one encoding, not a prefix of one. */
export function decodeSignedMessage(bytes: Uint8Array): SignedMessage {
  const r = new Reader(bytes);
  const envelope = readEnvelope(r);
  const signature = r.take(SIGNATURE_LENGTH);
  const body = readBody(r);
  if (r.rest !== 0) throw new Error(`${r.rest} trailing bytes after SignedMessage`);
  return { envelope, signature, body };
}

function genesisBytes(genesisHash: AccountLike): Uint8Array {
  if (typeof genesisHash === 'string' && !isHex(genesisHash)) throw new Error('genesis hash must be 0x-prefixed hex');
  const genesis = typeof genesisHash === 'string' ? hexToU8a(genesisHash) : genesisHash;
  if (genesis.length !== 32) throw new Error(`genesis hash must be 32 bytes, got ${genesis.length}`);
  return genesis;
}

/**
 * The 32 bytes the sender signs:
 * `blake2_256(b"ScalarMsg/v1|" ‖ genesis_hash ‖ SCALE(envelope))`.
 *
 * The genesis hash binds a signature to one chain (including against a reset
 * of this one); the domain prefix keeps it disjoint from transaction payloads
 * and from every other protocol that signs with the same key.
 */
export function envelopeSigningHash(e: Envelope, genesisHash: AccountLike): Uint8Array {
  return blake2AsU8a(u8aConcat(stringToU8a(SIGNING_DOMAIN), genesisBytes(genesisHash), encodeEnvelope(e)), 256);
}

/** What a sender supplies; `from` comes from the signing key. */
export interface MessageInput {
  to: AccountLike;
  kind: MessageKind;
  /** The plaintext content; `payload_hash = blake2_256(plaintext)` whatever the body type. */
  plaintext: Uint8Array;
  /**
   * How the content travels: `Plain` (default), `Sealed` (pass a body built
   * with `sealBody`), or `None` for hash-only delivery.
   */
  body?: Body;
  nonce: bigint;
  expiresAtBlock: number;
  genesisHash: AccountLike;
  agreement?: { account: AccountLike; seq: number } | null;
}

/** The part of a keyring pair the signer needs. */
export type MessageSigner = Pick<KeyringPair, 'publicKey' | 'sign' | 'type'>;

/**
 * Build and sign a message. The sender is the signing account: there is no way
 * to produce an envelope whose `from` differs from the key that signed it.
 */
export function createMessage(signer: MessageSigner, input: MessageInput): SignedMessage {
  // The envelope signature is defined as sr25519; an ed25519/ecdsa pair would
  // produce a signature no verifier accepts, so fail before anything is sent.
  if (signer.type !== 'sr25519') throw new Error(`envelope signer must be sr25519, got ${signer.type}`);
  const envelope: Envelope = {
    version: ENVELOPE_VERSION,
    from: signer.publicKey,
    to: toAccountId(input.to, 'to'),
    kind: input.kind,
    agreement: input.agreement
      ? { account: toAccountId(input.agreement.account, 'agreement.account'), seq: input.agreement.seq }
      : null,
    nonce: input.nonce,
    expiresAtBlock: input.expiresAtBlock,
    payloadHash: blake2AsU8a(input.plaintext, 256),
  };
  const signature = signer.sign(envelopeSigningHash(envelope, input.genesisHash));
  return { envelope, signature, body: input.body ?? { type: 'Plain', bytes: input.plaintext } };
}

/**
 * Highest nonce accepted per (from, to) pair, as seen by one verifier.
 *
 * Persist it (`toJSON()` / constructor) across restarts: an in-memory-only
 * tracker forgets what it has seen and would accept a replay after a restart.
 */
export class NonceTracker {
  private readonly seen: Map<string, bigint>;

  constructor(saved: Record<string, string> = {}) {
    this.seen = new Map(Object.entries(saved).map(([k, v]) => [k, BigInt(v)]));
  }

  private static key(from: Uint8Array, to: Uint8Array): string {
    return `${u8aToHex(from)}:${u8aToHex(to)}`;
  }

  /** Whether `nonce` is strictly above everything accepted for this pair. */
  isFresh(from: Uint8Array, to: Uint8Array, nonce: bigint): boolean {
    const last = this.seen.get(NonceTracker.key(from, to));
    return last === undefined || nonce > last;
  }

  /** Record `nonce` as accepted. Call only after every other check passed. */
  commit(from: Uint8Array, to: Uint8Array, nonce: bigint): void {
    this.seen.set(NonceTracker.key(from, to), nonce);
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries([...this.seen].map(([k, v]) => [k, v.toString()]));
  }
}

/**
 * Sender-side nonces that stay strictly increasing per recipient across restarts
 * without persisted state: `max(last + 1, now_ms * 1000)`. A restarted sender
 * starts above anything it issued in an earlier millisecond, and a clock that
 * steps backwards never makes the sequence go down within one process.
 * Up to 1000 messages per millisecond per recipient stay collision-free.
 */
export class OutboundNonces {
  private readonly last = new Map<string, bigint>();

  constructor(private readonly nowMs: () => number = Date.now) {}

  next(to: AccountLike): bigint {
    const key = u8aToHex(toAccountId(to, 'to'));
    const floor = BigInt(Math.floor(this.nowMs())) * 1000n;
    const prev = this.last.get(key);
    const n = prev !== undefined && prev + 1n > floor ? prev + 1n : floor;
    this.last.set(key, n);
    return n;
  }
}

/** The `messages.send` call a message arrived in (on-chain transport only). */
export interface OnChainCall {
  /** Extrinsic signer (`MessageSent.from`). */
  origin: AccountLike;
  to: AccountLike;
  kind: MessageKind;
  agreement: { account: AccountLike; seq: number } | null;
  /** The call's `payload_hash` argument; `null` for `None`. */
  payloadHash: Uint8Array | null;
}

/** A message that passed every verification rule. */
export interface ReceivedMessage {
  /** Sender SS58 address (the verified signer). */
  from: string;
  kind: MessageKind;
  envelope: Envelope;
  /** How the content arrived. */
  bodyType: Body['type'];
  /** The plaintext, already checked against `payload_hash`. */
  plaintext: Uint8Array;
  signature: Uint8Array;
}

/** Decrypts a `Sealed` body with the verifier's own messaging secret (see `openBody`). */
export type BodyOpener = (body: Extract<Body, { type: 'Sealed' }>) => Uint8Array;

export interface InboxOptions {
  /** The recipient: this inbox only accepts messages whose `to` is this account. */
  self: AccountLike;
  genesisHash: AccountLike;
  /** Shared/persisted nonce state; a fresh tracker is used if omitted. */
  nonces?: NonceTracker;
  /** Required to accept `Sealed` bodies. */
  open?: BodyOpener;
  /** SS58 prefix used for `from` in results (Scalar Commons: 42). */
  ss58Format?: number;
}

export interface ReceiveOptions {
  /** For on-chain delivery: the `messages.send` call that carried the message. */
  call?: OnChainCall;
  /**
   * The sender's published messaging key (`agents.messagingKey(from)`), looked
   * up by the caller. Required for a `Sealed` body; `null` = none published.
   */
  senderMessagingKey?: Uint8Array | null;
  /** For a `None` (hash-only) body: the content, delivered out of band. */
  detachedPlaintext?: Uint8Array;
}

function sameAgreement(a: AgreementRef | null, b: OnChainCall['agreement']): boolean {
  if (a === null || b === null) return a === null && b === null;
  return a.seq === b.seq && u8aEq(a.account, toAccountId(b.account, 'call.agreement'));
}

/**
 * The receive side: decode `SignedMessage` bytes and apply every verification
 * rule of the spec, in its order (cheap, non-cryptographic checks first):
 *
 * 1. `version == 1`;
 * 2. `to` is this inbox's account;
 * 3. `expires_at_block >= bestBlock`;
 * 4. `nonce` is strictly above the last accepted nonce for (from, to);
 * 5. the sr25519 signature over the signing hash verifies against `from`
 *    (so the signer must be `from`, and the genesis hash must match);
 * 6. on-chain only: signer, `to`, `kind`, `agreement` and `payload_hash` of the
 *    `send` call all equal the envelope;
 * 7. the body yields the plaintext: `Plain` directly, `Sealed` only if its
 *    `sender_key` is the sender's published messaging key and it decrypts,
 *    `None` only with the content supplied out of band;
 * 8. `blake2_256(plaintext) == payload_hash`.
 *
 * The nonce is committed only after all eight pass, so a rejected message
 * never burns a nonce the genuine sender still needs.
 */
export class MessageInbox {
  private readonly self: Uint8Array;
  private readonly genesis: AccountLike;
  readonly nonces: NonceTracker;
  private readonly opener?: BodyOpener;
  private readonly ss58: number;

  constructor(opts: InboxOptions) {
    this.self = toAccountId(opts.self, 'self');
    this.genesis = opts.genesisHash;
    this.nonces = opts.nonces ?? new NonceTracker();
    this.opener = opts.open;
    this.ss58 = opts.ss58Format ?? 42;
  }

  receive(bytes: Uint8Array, bestBlock: number | bigint, opts: ReceiveOptions = {}): ReceivedMessage {
    let m: SignedMessage;
    try {
      m = decodeSignedMessage(bytes);
    } catch (err) {
      throw new MessageRejected('malformed', err instanceof Error ? err.message : String(err));
    }
    const e = m.envelope;

    if (e.version !== ENVELOPE_VERSION) {
      throw new MessageRejected('unsupported-version', `version ${e.version}, this SDK speaks ${ENVELOPE_VERSION}`);
    }
    if (!u8aEq(e.to, this.self)) throw new MessageRejected('wrong-recipient', 'envelope is addressed to another account');
    if (BigInt(e.expiresAtBlock) < BigInt(bestBlock)) {
      throw new MessageRejected('expired', `expired at block ${e.expiresAtBlock}, best is ${bestBlock}`);
    }
    if (!this.nonces.isFresh(e.from, e.to, e.nonce)) {
      throw new MessageRejected('replay', `nonce ${e.nonce} is not above the last accepted nonce`);
    }

    let signed: boolean;
    try {
      signed = sr25519Verify(envelopeSigningHash(e, this.genesis), m.signature, e.from);
    } catch {
      // A `from` that is not a valid sr25519 point throws instead of returning false.
      signed = false;
    }
    if (!signed) throw new MessageRejected('bad-signature', 'signature does not verify against `from` on this chain');

    const call = opts.call;
    if (call !== undefined) {
      const mismatch =
        (!u8aEq(toAccountId(call.origin, 'call.origin'), e.from) && 'signer') ||
        (!u8aEq(toAccountId(call.to, 'call.to'), e.to) && 'to') ||
        (call.kind !== e.kind && 'kind') ||
        (!sameAgreement(e.agreement, call.agreement) && 'agreement') ||
        ((call.payloadHash === null || !u8aEq(call.payloadHash, e.payloadHash)) && 'payload_hash');
      if (mismatch) throw new MessageRejected('call-mismatch', `send call ${mismatch} differs from the envelope`);
    }

    let plaintext: Uint8Array;
    const body = m.body;
    if (body.type === 'Plain') {
      plaintext = body.bytes;
    } else if (body.type === 'None') {
      if (opts.detachedPlaintext === undefined) {
        throw new MessageRejected('content-missing', 'hash-only message: supply the content as detachedPlaintext');
      }
      plaintext = opts.detachedPlaintext;
    } else {
      if (!opts.senderMessagingKey || !u8aEq(opts.senderMessagingKey, body.senderKey)) {
        throw new MessageRejected('sender-key-mismatch', "sender_key is not the sender's published messaging key");
      }
      if (this.opener === undefined) throw new MessageRejected('decrypt-failed', 'inbox has no messaging key');
      plaintext = this.opener(body);
    }

    if (!u8aEq(blake2AsU8a(plaintext, 256), e.payloadHash)) {
      throw new MessageRejected('payload-hash-mismatch', 'blake2_256(plaintext) != payload_hash');
    }
    this.nonces.commit(e.from, e.to, e.nonce);
    return {
      from: encodeAddress(e.from, this.ss58),
      kind: e.kind,
      envelope: e,
      bodyType: body.type,
      plaintext,
      signature: m.signature,
    };
  }
}
