/**
 * @scalar-commons/sdk — TypeScript agent SDK for the Scalar Commons chain.
 *
 * Protocol §8.3: archetypes cannot exist without hands. This package is the
 * agent-facing surface of the chain — the "hands" that let an autonomous agent
 * register, stake, do escrow work, answer oracle requests, vote, and claim
 * emissions.
 *
 * Design rules:
 *  - polkadot-js (`@polkadot/api`) is the only transport.
 *  - No silent retries. Every retry is logged with its attempt number and the
 *    error that caused it (see {@link ./retry}).
 *  - Balances are plancks (1 CMN = 10^12 plancks) and are handled as `bigint`.
 */
import { ApiPromise, WsProvider } from '@polkadot/api';
import type { SubmittableExtrinsic, AddressOrPair } from '@polkadot/api/types';
import type { Codec } from '@polkadot/types/types';
import { u8aToHex } from '@polkadot/util';

import { submitAndWatch, type SubmitResult } from './submit.js';
import { consoleLogger, type Logger } from './logger.js';
import type { RetryOptions } from './retry.js';
import type { SendMessageArgs } from './messaging/transport.js';

export { consoleLogger, errorMessage, type Logger } from './logger.js';
export { DispatchFailure, isDeterministicFailure } from './errors.js';
export { withRetry, type RetryOptions } from './retry.js';
export { submitAndWatch, type SubmitResult } from './submit.js';
export * from './messaging/index.js';

/** 1 CMN = 10^12 plancks. */
export const PLANCKS_PER_CMN = 1_000_000_000_000n;

/** Accumulator fixed-point scale used by pallet-emissions (`ACC_SCALE = 1 << 64`). */
export const ACC_SCALE = 1n << 64n;

/** A 32-byte hash accepted as a hex string (`0x…`) or a raw `Uint8Array`. */
export type Hash32 = string | Uint8Array;

/** Aggregate view of an era's timing and last settlement. */
export interface EraInfo {
  /** Current era number (`agents.eraNumber`). */
  era: number;
  /** Era length in blocks (`EraDuration` runtime constant). */
  eraDuration: bigint;
  /** Block at which the current era started (`emissions.eraStartBlock`). */
  eraStartBlock: bigint;
  /**
   * Last era that was settled, or `null` if none has settled yet.
   *
   * `emissions.lastSettledEra` is an `Option<u32>` on chain and a fresh chain
   * genuinely holds `None`. `null` and era `0` are different facts — the F-04
   * double-settlement guard treats them differently — so they stay distinct
   * here rather than collapsing `None` to `0`.
   */
  lastSettledEra: number | null;
  /** Amount minted at the last settlement, in plancks. */
  lastEraEmission: bigint;
  /** Whether the era is due for settlement at the current head block. */
  settleable: boolean;
}

/** Net economic position of an account. */
export interface NetPosition {
  /**
   * Free balance from `system.account`, in plancks.
   *
   * This is *not* the transferable amount: pallet-agents locks stake with
   * `Currency::set_lock`, and a lock restricts `free` rather than moving tokens
   * out of it. Compare {@link NetPosition.frozen} to see how much of `free` is
   * pinned; what a transfer can actually move also depends on the existential
   * deposit, so the SDK does not put a number on it.
   */
  free: bigint;
  /** Reserved balance, in plancks (moved out of `free` by the balances pallet). */
  reserved: bigint;
  /** Frozen (locked) balance, in plancks — includes the agent stake lock. */
  frozen: bigint;
  /** Locked agent stake, in plancks (0 if not a registered agent). */
  stake: bigint;
  /** Escrow volume transacted this era, in plancks. */
  eraEscrowVolume: bigint;
  /** Unclaimed emissions the account could `claim()` right now, in plancks. */
  pendingEmissions: bigint;
  /**
   * `free + pendingEmissions`. A convenience roll-up.
   *
   * `stake` is deliberately **not** added: it is a lock held inside `free`, so
   * adding it would report tokens that were never issued — the sum over all
   * accounts would exceed `balances.totalIssuance` and break the supply story.
   */
  total: bigint;
}

/** Options for constructing a {@link ScalarCommonsClient}. */
export interface ClientOptions extends RetryOptions {
  logger?: Logger;
}

/** Convert an optional/plain numeric codec into a `bigint` (missing → 0). */
function toBig(value: Codec | null | undefined): bigint {
  if (value == null) return 0n;
  const anyVal = value as unknown as { isSome?: boolean; unwrap?: () => Codec };
  if (typeof anyVal.isSome === 'boolean') {
    return anyVal.isSome && anyVal.unwrap ? BigInt(anyVal.unwrap().toString()) : 0n;
  }
  const s = value.toString();
  return s.length === 0 ? 0n : BigInt(s);
}

/**
 * Decode a codec that may be an `Option<u32>` into `number | null`.
 *
 * `None` must survive as `null` rather than collapsing to `0`: era 0 having
 * settled and no era having settled are different states of the chain.
 */
function toOptionalNumber(value: Codec | null | undefined): number | null {
  if (value == null) return null;
  const opt = value as unknown as { isSome?: boolean; unwrap?: () => Codec };
  if (typeof opt.isSome === 'boolean') {
    return opt.isSome && opt.unwrap ? Number(opt.unwrap().toString()) : null;
  }
  const s = value.toString();
  return s.length === 0 ? null : Number(s);
}

/** Any callable storage entry, narrowed away from polkadot-js's index signatures. */
type QueryFn = (...args: unknown[]) => Promise<Codec>;
/** Any callable extrinsic factory, narrowed away from polkadot-js's index signatures. */
type TxFn = (...args: unknown[]) => SubmittableExtrinsic<'promise'>;

/**
 * Resolve `api.tx.<section>.<method>` against the connected runtime's metadata.
 *
 * Throws a named error when the call is absent, so pointing the SDK at a node
 * running an older spec reports the missing extrinsic instead of crashing deep
 * inside the submit path. Every call site goes through this (and through
 * {@link queryEntry}/{@link constEntry}) because polkadot-js types `api.tx`,
 * `api.query` and `api.consts` as index signatures: under the package's
 * `noUncheckedIndexedAccess` a direct `api.tx.agents.register` does not
 * typecheck, and `npm run typecheck` is part of the gate.
 */
function txEntry(api: ApiPromise, section: string, method: string): TxFn {
  const call = api.tx[section]?.[method];
  if (typeof call !== 'function') {
    throw new Error(`runtime does not expose extrinsic ${section}.${method}`);
  }
  return call as unknown as TxFn;
}

/** Resolve `api.query.<section>.<item>`, failing with a named error if absent. */
function queryEntry(api: ApiPromise, section: string, item: string): QueryFn {
  const entry = api.query[section]?.[item];
  if (typeof entry !== 'function') {
    throw new Error(`runtime does not expose storage item ${section}.${item}`);
  }
  return entry as unknown as QueryFn;
}

/** Resolve `api.consts.<section>.<name>`, failing with a named error if absent. */
function constEntry(api: ApiPromise, section: string, name: string): Codec {
  const value = api.consts[section]?.[name];
  if (value == null) {
    throw new Error(`runtime does not expose constant ${section}.${name}`);
  }
  return value;
}

/**
 * The SS58 address behind an {@link AddressOrPair}.
 *
 * Needed by self-only extrinsics such as `agents.record_gov_vote`, which take
 * the agent as an explicit argument and reject anything other than the signer
 * with `Unauthorized`.
 */
function signerAddress(signer: AddressOrPair): string {
  if (typeof signer === 'string') return signer;
  const pair = signer as unknown as { address?: string };
  if (typeof pair.address === 'string') return pair.address;
  return (signer as unknown as { toString(): string }).toString();
}

/**
 * High-level, typed wrapper over the Scalar Commons runtime.
 *
 * Every write method signs with the supplied {@link AddressOrPair}, waits for
 * in-block inclusion, and returns the block/tx hashes plus the attempt count.
 */
export class ScalarCommonsClient {
  readonly api: ApiPromise;
  private readonly options: ClientOptions;

  constructor(api: ApiPromise, options: ClientOptions = {}) {
    this.api = api;
    this.options = { logger: consoleLogger, ...options };
  }

  /** Connect to a node over WebSocket and build a ready client. */
  static async connect(endpoint: string, options: ClientOptions = {}): Promise<ScalarCommonsClient> {
    const provider = new WsProvider(endpoint);
    const api = await ApiPromise.create({ provider });
    await api.isReady;
    return new ScalarCommonsClient(api, options);
  }

  /** Disconnect the underlying provider. */
  async disconnect(): Promise<void> {
    await this.api.disconnect();
  }

  private submit(
    tx: SubmittableExtrinsic<'promise'>,
    signer: AddressOrPair,
    label: string,
  ): Promise<SubmitResult> {
    return submitAndWatch(this.api, tx, signer, label, this.options);
  }

  // ─── Write methods ─────────────────────────────────────────────────────────

  /** Register as an agent, locking `stake` plancks. → `agents.register`. */
  register(signer: AddressOrPair, stake: bigint): Promise<SubmitResult> {
    return this.submit(txEntry(this.api, 'agents', 'register')(stake), signer, 'register');
  }

  /** Add `amount` plancks to the caller's existing stake. → `agents.addStake`. */
  stake(signer: AddressOrPair, amount: bigint): Promise<SubmitResult> {
    return this.submit(txEntry(this.api, 'agents', 'addStake')(amount), signer, 'stake');
  }

  /** Prove liveness for the emissions heartbeat multiplier. → `agents.heartbeat`. */
  heartbeat(signer: AddressOrPair): Promise<SubmitResult> {
    return this.submit(txEntry(this.api, 'agents', 'heartbeat')(), signer, 'heartbeat');
  }

  /**
   * Open an escrow agreement as buyer against `provider`. → `escrow.createAgreement`.
   * `capabilityId` is optional; pass `null`/omit for a generic agreement.
   */
  createEscrow(
    signer: AddressOrPair,
    provider: string,
    amount: bigint,
    deliverableHash: Hash32,
    deliverBy: bigint | number,
    capabilityId: number | null = null,
  ): Promise<SubmitResult> {
    return this.submit(
      txEntry(this.api, 'escrow', 'createAgreement')(
        provider,
        amount,
        deliverableHash,
        deliverBy,
        capabilityId,
      ),
      signer,
      'createEscrow',
    );
  }

  /** Record delivery as the provider on a buyer's agreement. → `escrow.recordDelivery`. */
  acceptEscrow(
    signer: AddressOrPair,
    buyer: string,
    seq: number,
    deliveryHash: Hash32,
  ): Promise<SubmitResult> {
    return this.submit(
      txEntry(this.api, 'escrow', 'recordDelivery')(buyer, seq, deliveryHash),
      signer,
      'acceptEscrow',
    );
  }

  /** Confirm a delivered agreement as the buyer, releasing funds. → `escrow.confirmDelivery`. */
  completeEscrow(signer: AddressOrPair, provider: string, seq: number): Promise<SubmitResult> {
    return this.submit(
      txEntry(this.api, 'escrow', 'confirmDelivery')(provider, seq),
      signer,
      'completeEscrow',
    );
  }

  /** Submit an oracle answer for a request. → `oracle.submitResponse`. */
  submitOracle(
    signer: AddressOrPair,
    requestId: Hash32,
    answerHash: Hash32,
    capability: number,
  ): Promise<SubmitResult> {
    return this.submit(
      txEntry(this.api, 'oracle', 'submitResponse')(requestId, answerHash, capability),
      signer,
      'submitOracle',
    );
  }

  /**
   * Cast a conviction vote on an OpenGov poll. → `convictionVoting.vote`.
   * `vote` is the polkadot-js `AccountVote` shape, e.g.
   * `{ Standard: { vote: { aye: true, conviction: 'Locked1x' }, balance } }`.
   */
  vote(signer: AddressOrPair, pollIndex: number, vote: unknown): Promise<SubmitResult> {
    return this.submit(
      txEntry(this.api, 'convictionVoting', 'vote')(pollIndex, vote),
      signer,
      'vote',
    );
  }

  /**
   * Claim governance-participation credit for ONE referendum the signer is
   * actively voting on. → `agents.recordGovVote(agent, pollIndex)`.
   *
   * Economic why: since ROUND14 the extrinsic names the referendum, because
   * `gov_score` prices participation *per referendum*. Credit is derived, not
   * claimed — the runtime checks the signer still holds a live vote on this poll
   * (`NotActivelyVoting`), that the poll has not already paid this era
   * (`PollAlreadyCredited`), and that the per-era ceiling is not reached
   * (`GovVoteCapReached`). Call it once per poll per era, after
   * {@link ScalarCommonsClient.vote}.
   *
   * The `agent` argument is derived from `signer`: the extrinsic is self-only
   * and rejects any other account with `Unauthorized`.
   */
  recordGovVote(signer: AddressOrPair, pollIndex: number): Promise<SubmitResult> {
    return this.submit(
      txEntry(this.api, 'agents', 'recordGovVote')(signerAddress(signer), pollIndex),
      signer,
      'recordGovVote',
    );
  }

  /** Permissionlessly settle the current era once it is due. → `emissions.settleEra`. */
  settleEra(signer: AddressOrPair): Promise<SubmitResult> {
    return this.submit(txEntry(this.api, 'emissions', 'settleEra')(), signer, 'settleEra');
  }

  /** Claim accrued emissions for the caller. → `emissions.claim`. */
  claim(signer: AddressOrPair): Promise<SubmitResult> {
    return this.submit(txEntry(this.api, 'emissions', 'claim')(), signer, 'claim');
  }

  // ─── Messaging (spec 308) ────────────────────────────────────────────────

  /**
   * Publish the caller's X25519 messaging key. → `agents.setMessagingKey`.
   *
   * Registered agents only; calling again rotates the key. Derive the key with
   * `deriveMessagingKey` so it is recoverable from the account mnemonic alone.
   */
  setMessagingKey(signer: AddressOrPair, publicKey: Uint8Array): Promise<SubmitResult> {
    if (publicKey.length !== 32) {
      return Promise.reject(new Error(`messaging key must be 32 bytes, got ${publicKey.length}`));
    }
    return this.submit(
      txEntry(this.api, 'agents', 'setMessagingKey')(u8aToHex(publicKey)),
      signer,
      'setMessagingKey',
    );
  }

  /** Remove the caller's messaging key. → `agents.clearMessagingKey`. */
  clearMessagingKey(signer: AddressOrPair): Promise<SubmitResult> {
    return this.submit(txEntry(this.api, 'agents', 'clearMessagingKey')(), signer, 'clearMessagingKey');
  }

  /**
   * Send a coordination message. → `messages.send`.
   *
   * Prefer `OnChainTransport`, which builds these arguments from a signed
   * envelope and checks the 2 KiB bound and the signer before paying a fee.
   * The runtime burns `BaseFee + PerByteFee × payload_len` on top of the
   * weight fee (docs/reference/messages.md).
   */
  sendMessage(signer: AddressOrPair, args: SendMessageArgs): Promise<SubmitResult> {
    return this.submit(
      txEntry(this.api, 'messages', 'send')(args.to, args.kind, args.agreement, args.payloadHash, args.payload),
      signer,
      'sendMessage',
    );
  }

  /** The X25519 messaging key `address` published, or `null` if it has none. */
  async messagingKeyOf(address: string): Promise<Uint8Array | null> {
    const opt = (await queryEntry(this.api, 'agents', 'messagingKey')(address)) as unknown as {
      isSome: boolean;
      unwrap(): { toU8a(): Uint8Array };
    };
    return opt.isSome ? opt.unwrap().toU8a() : null;
  }

  // ─── Read methods ────────────────────────────────────────────────────────

  /** Aggregate era timing/settlement info. */
  async eraInfo(): Promise<EraInfo> {
    const [eraCodec, startCodec, lastSettledCodec, lastEmissionCodec, headerNow] = await Promise.all([
      queryEntry(this.api, 'agents', 'eraNumber')(),
      queryEntry(this.api, 'emissions', 'eraStartBlock')(),
      queryEntry(this.api, 'emissions', 'lastSettledEra')(),
      queryEntry(this.api, 'emissions', 'lastEraEmission')(),
      queryEntry(this.api, 'system', 'number')(),
    ]);

    const eraDuration = toBig(constEntry(this.api, 'emissions', 'eraDuration'));
    const eraStartBlock = toBig(startCodec);
    const now = toBig(headerNow);

    return {
      era: Number(eraCodec.toString()),
      eraDuration,
      eraStartBlock,
      lastSettledEra: toOptionalNumber(lastSettledCodec),
      lastEraEmission: toBig(lastEmissionCodec),
      settleable: now >= eraStartBlock + eraDuration,
    };
  }

  /** The agent's emission weight snapshot (`emissions.agentWeightSnapshot`). */
  async weightOf(address: string): Promise<bigint> {
    const weight = await queryEntry(this.api, 'emissions', 'agentWeightSnapshot')(address);
    return toBig(weight);
  }

  /**
   * Total CMN in existence, in plancks (`balances.totalIssuance`).
   *
   * The supply cap is absolute, so this is the number every emissions claim is
   * ultimately measured against: `totalIssuance` may approach
   * `emissions.supplyCap` but can never exceed it.
   */
  async totalIssuance(): Promise<bigint> {
    const issuance = await queryEntry(this.api, 'balances', 'totalIssuance')();
    return toBig(issuance);
  }

  /** Full economic position: balances, stake, era escrow volume, pending emissions. */
  async netPosition(address: string): Promise<NetPosition> {
    const [accountCodec, stakeCodec, escrowVolCodec, accCodec, debtCodec, weightCodec] =
      await Promise.all([
        queryEntry(this.api, 'system', 'account')(address),
        queryEntry(this.api, 'agents', 'agentStake')(address),
        queryEntry(this.api, 'agents', 'eraEscrowVolume')(address),
        queryEntry(this.api, 'emissions', 'accRewardPerStake')(),
        queryEntry(this.api, 'emissions', 'agentRewardDebt')(address),
        queryEntry(this.api, 'emissions', 'agentWeightSnapshot')(address),
      ]);

    const data = (accountCodec as unknown as {
      data: { free: Codec; reserved?: Codec; frozen?: Codec };
    }).data;
    const free = toBig(data.free);
    const reserved = toBig(data.reserved);
    const frozen = toBig(data.frozen);

    const stake = toBig(stakeCodec);
    const eraEscrowVolume = toBig(escrowVolCodec);

    // Mirror pallet-emissions::do_claim: pending = (acc - debt) * weight / ACC_SCALE.
    const acc = toBig(accCodec);
    const debt = toBig(debtCodec);
    const weight = toBig(weightCodec);
    let pendingEmissions = 0n;
    if (acc > debt && weight > 0n) {
      pendingEmissions = ((acc - debt) * weight) / ACC_SCALE;
    }

    return {
      free,
      reserved,
      frozen,
      stake,
      eraEscrowVolume,
      pendingEmissions,
      // `stake` is a lock inside `free`, never a separate pot — see NetPosition.total.
      total: free + pendingEmissions,
    };
  }
}

export default ScalarCommonsClient;
