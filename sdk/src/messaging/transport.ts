/**
 * Transport bindings for `SignedMessage` bytes (docs/reference/messaging.md, "Transports").
 *
 * A transport only moves bytes. It never decides whether a message is valid:
 * every message, however it arrived, goes through `MessageInbox.receive`.
 *
 * (a) on-chain  — `pallet-messages::send`, `payload = SCALE(SignedMessage)` ≤ 2048 bytes,
 *                 the call's other arguments built *from* the envelope;
 * (b) HTTPS     — POST of the same bytes to the recipient's registered service URI;
 * (c) statement store — reserved, not part of envelope version 1.
 */
import type { KeyringPair } from '@polkadot/keyring/types';
import { hexToU8a, u8aEq, u8aToHex } from '@polkadot/util';
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';

import type { SubmitResult } from '../submit.js';
import { SS58_PREFIX } from '../constants.js';
import { consoleLogger } from '../logger.js';
import { isLoopbackHostname, isPrivateNetworkHostname } from '../net.js';
import {
  MAX_ONCHAIN_PAYLOAD,
  MESSAGE_KINDS,
  encodeSignedMessage,
  type MessageKind,
  type OnChainCall,
  type SignedMessage,
} from './envelope.js';

/** Anything that can carry a signed message to its recipient. */
export interface Transport {
  send(message: SignedMessage): Promise<unknown>;
}

/** The arguments of `messages.send`, as polkadot-js accepts them. */
export interface SendMessageArgs {
  to: string;
  kind: MessageKind;
  agreement: [string, number] | null;
  payloadHash: string;
  payload: string;
}

/** The client surface the on-chain transport needs (implemented by `ScalarCommonsClient`). */
export interface MessageSubmitter {
  sendMessage(signer: KeyringPair, args: SendMessageArgs): Promise<SubmitResult>;
}

/**
 * Binding (a): put the message on chain with `messages.send`.
 *
 * The call's `to`, `kind`, `agreement` and `payload_hash` are derived from the
 * envelope and never taken separately — that construction is what rules out a
 * sender signing one thing and submitting another.
 *
 * `hashOnly: true` replaces the body with `Body::None`: the chain carries the
 * signed commitment, and the content goes over another transport.
 *
 * Both guards run before signing: the chain rejects payloads above 2048 bytes,
 * and a message submitted by an account other than the envelope sender would
 * be refused by every recipient (`call-mismatch`). Either way the burnt fee
 * would buy nothing.
 */
export class OnChainTransport implements Transport {
  constructor(
    private readonly client: MessageSubmitter,
    private readonly signer: KeyringPair,
    private readonly ss58Format = SS58_PREFIX,
  ) {}

  async send(message: SignedMessage, opts: { hashOnly?: boolean } = {}): Promise<SubmitResult> {
    if (!u8aEq(this.signer.publicKey, message.envelope.from)) {
      throw new Error(
        'on-chain signer is not the envelope sender; recipients would reject it as call-mismatch',
      );
    }
    const frame = encodeSignedMessage(
      opts.hashOnly ? { ...message, body: { type: 'None' } } : message,
    );
    if (frame.length > MAX_ONCHAIN_PAYLOAD) {
      throw new Error(
        `SignedMessage is ${frame.length} bytes, pallet-messages accepts at most ${MAX_ONCHAIN_PAYLOAD}; send it hash-only ({ hashOnly: true })`,
      );
    }
    const e = message.envelope;
    return this.client.sendMessage(this.signer, {
      to: encodeAddress(e.to, this.ss58Format),
      kind: e.kind,
      agreement: e.agreement
        ? [encodeAddress(e.agreement.account, this.ss58Format), e.agreement.seq]
        : null,
      payloadHash: u8aToHex(e.payloadHash),
      payload: u8aToHex(frame),
    });
  }
}

/** Looks up where to deliver: normally the recipient's registered service URI. */
export type UriResolver = (to: string) => string | Promise<string>;

export interface HttpsTransportOptions {
  fetch?: typeof fetch;
  ss58Format?: number;
  /** Maximum duration of one POST. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Development-only escape hatch for loopback/private literal hosts. */
  allowPrivateHosts?: boolean;
}

/**
 * Binding (b): POST the full frame (`application/octet-stream`) to the
 * recipient's service URI. Plain `http` is refused except on loopback, so a
 * frame is never sent in clear across a network by accident. A non-2xx answer
 * throws; the caller decides whether to retry (nonces make re-sending the same
 * frame harmless: the recipient rejects the duplicate as `replay`).
 */
export class HttpsTransport implements Transport {
  private readonly fetchImpl: typeof fetch;
  private readonly ss58: number;
  private readonly timeoutMs: number;
  private readonly allowPrivateHosts: boolean;

  constructor(
    private readonly resolve: UriResolver,
    opts: HttpsTransportOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.ss58 = opts.ss58Format ?? SS58_PREFIX;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError(`timeoutMs must be a positive finite number, got ${this.timeoutMs}`);
    }
    this.allowPrivateHosts = opts.allowPrivateHosts ?? false;
  }

  async send(message: SignedMessage): Promise<void> {
    const uri = await this.resolve(encodeAddress(message.envelope.to, this.ss58));
    const url = new URL(uri);
    const privateHost = isPrivateNetworkHostname(url.hostname);
    if (privateHost && !this.allowPrivateHosts) {
      throw new Error(`refusing to deliver to private or local host ${url.hostname}`);
    }
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && this.allowPrivateHosts && isLoopbackHostname(url.hostname))
    ) {
      throw new Error(
        `refusing to deliver over ${url.protocol} to ${url.hostname}: https is required`,
      );
    }
    const res = await this.fetchImpl(uri, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: encodeSignedMessage(message),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`delivery to ${uri} failed: HTTP ${res.status}`);
  }
}

/** One message addressed to the subscriber, as found in a finalized block. */
export interface InboundFrame {
  /** `SCALE(SignedMessage)` from the call's `payload`. */
  frame: Uint8Array;
  /** Extrinsic signer (`MessageSent.from`). */
  origin: string;
  /** The `send` call's arguments; pass as `call` to `MessageInbox.receive` (rule 6). */
  call: OnChainCall;
  blockNumber: number;
  blockHash: string;
  extrinsicIndex: number;
}

export interface SubscribeOptions {
  /** First block to scan; defaults to the first finalized head seen. */
  fromBlock?: number;
  /** Called for per-block failures and handler exceptions; the subscription carries on. */
  onError?: (err: Error) => void;
  /** Retries after the first failed read before the block is skipped. Defaults to 3. */
  maxBlockRetries?: number;
  ss58Format?: number;
}

interface Codecish {
  toString(): string;
  toJSON?(): unknown;
}
interface ChainApi {
  rpc: {
    chain: {
      subscribeFinalizedHeads(
        cb: (h: { number: { toNumber(): number }; hash: unknown }) => void,
      ): Promise<() => void>;
      getBlockHash(n: number): Promise<{ toHex(): string }>;
      getBlock(hash: unknown): Promise<{
        block: {
          extrinsics: {
            method: {
              section: string;
              method: string;
              args: (Codecish & { toU8a(bare?: boolean): Uint8Array })[];
            };
            signer: Codecish;
          }[];
        };
      }>;
    };
  };
  at(hash: unknown): Promise<{
    query: {
      system: {
        events(): Promise<
          {
            phase: { isApplyExtrinsic: boolean; asApplyExtrinsic: { toNumber(): number } };
            event: { section: string; method: string; data: Codecish[] };
          }[]
        >;
      };
    };
  }>;
}

/**
 * Read `send(to, kind, agreement, payload_hash, payload)` arguments. Uses the
 * codecs' JSON forms: `AccountId` → SS58, basic enum → variant name,
 * `Option<(AccountId, u32)>` → `null | [ss58, n]`, `Option<[u8; 32]>` → `null | 0x…`.
 */
function decodeSendCall(
  args: (Codecish & { toU8a(bare?: boolean): Uint8Array })[],
  origin: string,
): { call: OnChainCall; frame: Uint8Array } {
  const [to, kind, agreement, payloadHash, payload] = args;
  if (!to || !kind || !agreement || !payloadHash || !payload)
    throw new Error('expected 5 arguments');
  const kindName = kind.toString();
  if (!(MESSAGE_KINDS as readonly string[]).includes(kindName))
    throw new Error(`unknown kind ${kindName}`);
  const agr = (agreement.toJSON?.() ?? null) as [string, number] | null;
  const hash = (payloadHash.toJSON?.() ?? null) as string | null;
  return {
    call: {
      origin,
      to: to.toString(),
      kind: kindName as MessageKind,
      agreement: agr === null ? null : { account: agr[0], seq: Number(agr[1]) },
      payloadHash: hash === null ? null : hexToU8a(hash),
    },
    frame: payload.toU8a(true),
  };
}

/**
 * Binding (a), receive side: watch finalized blocks for `messages.MessageSent`
 * addressed to `self` and hand each frame to `handler`.
 *
 * Why finalized and not best: a frame from a block that is later reorged out
 * would be acted on and then vanish. Finality notifications can skip blocks,
 * so every block between the last one scanned and the new head is fetched —
 * none is missed. The event carries only `payload_len`; the payload itself is
 * read from the `messages.send` extrinsic the event's phase points at, and that
 * extrinsic must be signed by the event's `from`.
 *
 * Messages are delivered unverified: run them through `MessageInbox.receive`
 * with `call` set, so the call's arguments are checked against the envelope.
 */
export async function subscribeMessages(
  apiLike: unknown,
  self: string,
  handler: (f: InboundFrame) => void | Promise<void>,
  opts: SubscribeOptions = {},
): Promise<() => void> {
  const api = apiLike as ChainApi;
  const me = decodeAddress(self);
  const ss58 = opts.ss58Format ?? SS58_PREFIX;
  const maxBlockRetries = opts.maxBlockRetries ?? 3;
  if (!Number.isSafeInteger(maxBlockRetries) || maxBlockRetries < 0) {
    throw new RangeError(
      `maxBlockRetries must be a non-negative safe integer, got ${maxBlockRetries}`,
    );
  }
  const report = (err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    try {
      if (opts.onError) opts.onError(error);
      else consoleLogger.warn('message subscriber error', { error: error.message });
    } catch {
      // Error reporting must never poison the ordered scan queue.
    }
  };
  let next = opts.fromBlock;
  let queue = Promise.resolve();
  const failedReads = new Map<number, number>();

  const scan = async (n: number) => {
    const hash = await api.rpc.chain.getBlockHash(n);
    const [block, at] = await Promise.all([api.rpc.chain.getBlock(hash), api.at(hash)]);
    const events = await at.query.system.events();
    for (const { phase, event } of events) {
      if (event.section !== 'messages' || event.method !== 'MessageSent' || !phase.isApplyExtrinsic)
        continue;
      const [from, to] = event.data;
      if (from === undefined || to === undefined || !u8aEq(decodeAddress(to.toString()), me))
        continue;
      const index = phase.asApplyExtrinsic.toNumber();
      const ext = block.block.extrinsics[index];
      const origin = encodeAddress(decodeAddress(from.toString()), ss58);
      if (
        ext === undefined ||
        ext.method.section !== 'messages' ||
        ext.method.method !== 'send' ||
        !u8aEq(decodeAddress(ext.signer.toString()), decodeAddress(origin))
      ) {
        report(
          new Error(`block ${n}: MessageSent at extrinsic ${index} has no matching messages.send`),
        );
        continue;
      }
      let call: OnChainCall;
      let frame: Uint8Array;
      try {
        ({ call, frame } = decodeSendCall(ext.method.args, origin));
      } catch (err) {
        report(
          new Error(
            `block ${n}: messages.send at extrinsic ${index}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        continue;
      }
      try {
        await handler({
          frame,
          origin,
          call,
          blockNumber: n,
          blockHash: hash.toHex(),
          extrinsicIndex: index,
        });
      } catch (err) {
        report(err);
      }
    }
  };

  return api.rpc.chain.subscribeFinalizedHeads((header) => {
    const head = header.number.toNumber();
    queue = queue
      .then(async () => {
        next ??= head;
        for (let n = next; n <= head; n++) {
          try {
            await scan(n);
            failedReads.delete(n);
          } catch (err) {
            const attempts = (failedReads.get(n) ?? 0) + 1;
            if (attempts <= maxBlockRetries) {
              failedReads.set(n, attempts);
              report(
                new Error(
                  `block ${n}: read failed; retry ${attempts}/${maxBlockRetries}: ${err instanceof Error ? err.message : String(err)}`,
                ),
              );
              return;
            }
            failedReads.delete(n);
            report(
              new Error(
                `block ${n}: skipped after ${attempts} failed reads: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          }
          next = n + 1;
        }
      })
      .catch(report);
  });
}
