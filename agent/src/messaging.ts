import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { hexToU8a, stringToU8a, u8aToHex } from '@polkadot/util';
import {
  MessageInbox,
  MessageRejected,
  NonceTracker,
  OutboundNonces,
  createMessage,
  deriveMessagingKey,
  openBody,
  sealBody,
  type MessageKind,
  type MessagingKeypair,
  type OnChainCall,
  type SignedMessage,
} from '@scalar-commons/sdk';

export interface MessengerOptions {
  /** Chain genesis hash (`0x…`): signatures are only valid on this chain. */
  genesisHash: string;
  /** Messaging key rotation index; bump it and republish to rotate. */
  rotation?: number;
  /** Persisted receive-side nonce state (see `NonceTracker.toJSON`). */
  nonces?: NonceTracker;
}

export interface ComposeOptions {
  /** Last block the message is valid at. Keep it short: stale offers should die. */
  expiresAtBlock: number;
  /**
   * Recipient's published messaging key (`0x…`). When set, the body is a
   * `Sealed` NaCl box from this agent's messaging key to it; otherwise `Plain`.
   */
  recipientKey?: string;
  agreement?: { account: string; seq: number } | null;
  /** Override the sender nonce (tests, or a caller that persists its own). */
  nonce?: bigint;
}

export interface ReadMessage {
  from: string;
  kind: MessageKind;
  /** Parsed JSON body. */
  body: unknown;
  /** How it arrived: `Plain`, `Sealed` or `None` (hash-only). */
  bodyType: 'None' | 'Plain' | 'Sealed';
  /** blake2_256 of the plaintext body: what an escrow `deliverableHash` commits to. */
  payloadHash: string;
  agreement: { account: Uint8Array; seq: number } | null;
}

/**
 * The reference agent's messaging surface: one agent secret yields both the
 * sr25519 account that signs envelopes and the X25519 key others encrypt to.
 *
 * Bodies are JSON. `compose` → a signed message any transport can carry;
 * `read` → every spec-308 verification rule (decryption included), then
 * parsing. Nothing in a body is trusted before `read` returns.
 */
export class AgentMessenger {
  readonly pair: KeyringPair;
  private readonly key: MessagingKeypair;
  private readonly outbound = new OutboundNonces();
  private readonly inbox: MessageInbox;

  constructor(
    secret: string,
    private readonly opts: MessengerOptions,
  ) {
    this.pair = new Keyring({ type: 'sr25519' }).addFromUri(secret);
    this.key = deriveMessagingKey(secret, { rotation: opts.rotation ?? 0 });
    this.inbox = new MessageInbox({
      self: this.pair.address,
      genesisHash: opts.genesisHash,
      nonces: opts.nonces,
      open: (body) => openBody(body, this.key),
    });
  }

  get address(): string {
    return this.pair.address;
  }

  /** The key to publish with `agents.setMessagingKey`. */
  get messagingPublicKey(): string {
    return u8aToHex(this.key.publicKey);
  }

  /** Receive-side nonce state, to persist across restarts. */
  get nonces(): NonceTracker {
    return this.inbox.nonces;
  }

  /** Build and sign a message with a JSON body. */
  compose(to: string, kind: MessageKind, body: unknown, opts: ComposeOptions): SignedMessage {
    return this.composeBytes(to, kind, stringToU8a(JSON.stringify(body)), opts);
  }

  /** Build and sign a message with a raw body. */
  composeBytes(to: string, kind: MessageKind, body: Uint8Array, opts: ComposeOptions): SignedMessage {
    return createMessage(this.pair, {
      to,
      kind,
      plaintext: body,
      body: opts.recipientKey ? sealBody(body, this.key, hexToU8a(opts.recipientKey)) : undefined,
      nonce: opts.nonce ?? this.outbound.next(to),
      expiresAtBlock: opts.expiresAtBlock,
      genesisHash: this.opts.genesisHash,
      agreement: opts.agreement ?? null,
    });
  }

  /**
   * Verify, decrypt and parse received `SignedMessage` bytes.
   *
   * - `senderMessagingKey`: the sender's `agents.messagingKey`, required for a
   *   `Sealed` body (its `sender_key` must match what the sender published).
   * - `call`: for messages read from blocks, the `send` call that carried them.
   * - `detachedPlaintext`: for hash-only messages, the content from elsewhere.
   */
  read(
    bytes: Uint8Array,
    bestBlock: number | bigint,
    opts: { senderMessagingKey?: string | null; call?: OnChainCall; detachedPlaintext?: Uint8Array } = {},
  ): ReadMessage {
    const m = this.inbox.receive(bytes, bestBlock, {
      call: opts.call,
      detachedPlaintext: opts.detachedPlaintext,
      senderMessagingKey: opts.senderMessagingKey ? hexToU8a(opts.senderMessagingKey) : null,
    });
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(m.plaintext));
    } catch (err) {
      throw new MessageRejected('malformed', `body is not UTF-8 JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      from: m.from,
      kind: m.kind,
      body,
      bodyType: m.bodyType,
      payloadHash: u8aToHex(m.envelope.payloadHash),
      agreement: m.envelope.agreement,
    };
  }
}
