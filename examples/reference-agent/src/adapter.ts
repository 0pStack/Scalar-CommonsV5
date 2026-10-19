/**
 * ScalarAgentAdapter — the smallest surface an existing agent framework needs.
 *
 * Every method below is one SDK call (or one extrinsic through the SDK's own
 * `submitAndWatch`), named for what an agent framework means rather than what
 * the pallet calls it. The daemon in ./agent.ts is built on this class, and the
 * "Wrap your own agent" section of docs/guide/run-an-agent.md shows a framework
 * using it directly.
 *
 * Two deliberate choices:
 *  - `maxRetries: 0`. The SDK's default retries ANY failure three times, and a
 *    deterministic runtime rejection pays a fee on every attempt (issue #160).
 *    A daemon that runs for weeks must not multiply its mistakes by four; it
 *    logs the failure and reconsiders on the next block instead.
 *  - Every write resolves to a {@link TxRecord} carrying the extrinsic hash,
 *    the block, and an explorer URL, so the caller can log proof of every action.
 */
import { readFileSync, statSync } from 'node:fs';
import { ScalarCommonsClient, submitAndWatch, type SubmitResult } from '@scalar-commons/sdk';
import type { ApiPromise } from '@polkadot/api';
import type { KeyringPair } from '@polkadot/keyring/types';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';

import type { AgreementStatus, AgreementView } from './work.js';
import { sdkLogger } from './log.js';

export interface TxRecord {
  label: string;
  txHash: string;
  blockHash: string;
  blockNumber: number;
  /** `https://explorer.scalarnet.io/extrinsic/<block>/<index>` — the route the explorer serves. */
  explorerUrl: string;
}

/**
 * Load a signing key from a file holding a mnemonic or secret URI.
 *
 * Refuses a file readable by group or other: on a shared host that is the
 * whole agent's balance and stake, one `cat` away from anyone.
 */
export async function loadSigner(seedFile: string, ss58Format = 42): Promise<KeyringPair> {
  const mode = statSync(seedFile).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${seedFile} is mode ${mode.toString(8)}; run: chmod 600 ${seedFile}`);
  }
  const secret = readFileSync(seedFile, 'utf8').trim();
  if (secret === '') throw new Error(`${seedFile} is empty`);
  await cryptoWaitReady();
  return new Keyring({ type: 'sr25519', ss58Format }).addFromUri(secret);
}

function decodeAgreement(buyer: string, provider: string, raw: Record<string, unknown>): AgreementView {
  const hex = (v: unknown) => String(v);
  const status = String(raw.status) as AgreementStatus;
  return {
    buyer,
    provider,
    seq: Number(raw.seq),
    amount: BigInt(String(raw.amount)),
    deliverableHash: hex(raw.deliverableHash),
    deliverBy: Number(raw.deliverBy),
    createdAt: Number(raw.createdAt),
    status,
    deliveryProof: raw.deliveryProof == null ? null : hex(raw.deliveryProof),
    capabilityId: raw.capabilityId == null ? null : Number(raw.capabilityId),
  };
}

export class ScalarAgentAdapter {
  readonly client: ScalarCommonsClient;
  readonly signer: KeyringPair;
  private readonly explorerBase: string;

  private constructor(client: ScalarCommonsClient, signer: KeyringPair, explorerBase: string) {
    this.client = client;
    this.signer = signer;
    this.explorerBase = explorerBase;
  }

  static async connect(wsUrl: string, signer: KeyringPair, explorerBase = 'https://explorer.scalarnet.io'): Promise<ScalarAgentAdapter> {
    const client = await ScalarCommonsClient.connect(wsUrl, { maxRetries: 0, logger: sdkLogger });
    return new ScalarAgentAdapter(client, signer, explorerBase);
  }

  get api(): ApiPromise {
    return this.client.api;
  }

  get address(): string {
    return this.signer.address;
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }

  // ─── reads ──────────────────────────────────────────────────────────────

  async head(): Promise<number> {
    return (await this.api.rpc.chain.getHeader()).number.toNumber();
  }

  /** `agents.is_agent` is `AgentStake::contains_key`, so a present stake entry is the test. */
  async isRegistered(who = this.address): Promise<boolean> {
    const stake = await this.api.query.agents!.agentStake!(who);
    return !(stake as unknown as { isEmpty: boolean }).isEmpty;
  }

  async capabilities(who = this.address): Promise<number[]> {
    const caps = await this.api.query.agents!.agentCapabilities!(who);
    return (caps.toJSON() as number[] | null) ?? [];
  }

  async hasIdentity(who = this.address): Promise<boolean> {
    const id = await this.api.query.identity!.identityOf!(who);
    return !(id as unknown as { isNone?: boolean; isEmpty: boolean }).isEmpty;
  }

  async lastHeartbeat(who = this.address): Promise<number> {
    return Number((await this.api.query.agents!.lastHeartbeat!(who)).toString());
  }

  async freeBalance(who = this.address): Promise<bigint> {
    return (await this.client.netPosition(who)).free;
  }

  async pendingRewards(who = this.address): Promise<bigint> {
    return (await this.client.netPosition(who)).pendingEmissions;
  }

  /** `escrow.minDeliveryBlocks`, read from the connected runtime rather than hard-coded. */
  minDeliveryBlocks(): number {
    return Number(this.api.consts.escrow!.minDeliveryBlocks!.toString());
  }

  /**
   * Every escrow agreement on chain, flattened. `escrow.agreements` is a double
   * map keyed (buyer, provider); the provider is the second key, so there is no
   * prefix to iterate by provider and a full scan is the honest way to find
   * "work addressed to me". Fine at testnet scale; an indexer query
   * (`/v1/escrows/...`) is the scalable replacement.
   */
  async allAgreements(): Promise<AgreementView[]> {
    const entries = await this.api.query.escrow!.agreements!.entries();
    const out: AgreementView[] = [];
    for (const [key, value] of entries) {
      const [buyer, provider] = key.args.map((a) => a.toString()) as [string, string];
      for (const raw of value.toJSON() as Record<string, unknown>[]) {
        out.push(decodeAgreement(buyer, provider, raw));
      }
    }
    return out;
  }

  // ─── writes: one SDK call each ─────────────────────────────────────────

  /** → `client.register(signer, stake)` → `agents.register(stake)` */
  async register(stakePlancks: bigint): Promise<TxRecord> {
    return this.record('register', await this.client.register(this.signer, stakePlancks));
  }

  /** → `client.heartbeat(signer)` → `agents.heartbeat()` */
  async heartbeat(): Promise<TxRecord> {
    return this.record('heartbeat', await this.client.heartbeat(this.signer));
  }

  /**
   * `identity.setIdentity({ display })`. Needed once, because `agents.setCapability`
   * refuses an account without an identity record (`IdentityRequired`). Reserves
   * `identity.basicDeposit` + `byteDeposit` × bytes (10 CMN + 0.1 CMN/byte on spec 306).
   */
  async setDisplayName(display: string): Promise<TxRecord> {
    const tx = this.api.tx.identity!.setIdentity!({ display: { Raw: display } });
    return this.record('setIdentity', await submitAndWatch(this.api, tx, this.signer, 'setIdentity', { maxRetries: 0, logger: sdkLogger }));
  }

  /** `agents.setCapability(id, true)` — publishes a capability id. The SDK has no wrapper for it yet. */
  async publishCapability(capabilityId: number): Promise<TxRecord> {
    const tx = this.api.tx.agents!.setCapability!(capabilityId, true);
    return this.record('setCapability', await submitAndWatch(this.api, tx, this.signer, 'setCapability', { maxRetries: 0, logger: sdkLogger }));
  }

  /** → `client.acceptEscrow(signer, buyer, seq, deliveryHash)` → `escrow.recordDelivery` */
  async deliver(job: AgreementView, deliveryHash: string): Promise<TxRecord> {
    return this.record('recordDelivery', await this.client.acceptEscrow(this.signer, job.buyer, job.seq, deliveryHash));
  }

  /** Buyer side. → `client.createEscrow(...)` → `escrow.createAgreement` */
  async hire(provider: string, amountPlancks: bigint, deliverableHash: string, deliverBy: number, capabilityId: number | null = null): Promise<TxRecord> {
    return this.record('createAgreement', await this.client.createEscrow(this.signer, provider, amountPlancks, deliverableHash, deliverBy, capabilityId));
  }

  /** Buyer side. → `client.completeEscrow(signer, provider, seq)` → `escrow.confirmDelivery` */
  async confirm(job: AgreementView): Promise<TxRecord> {
    return this.record('confirmDelivery', await this.client.completeEscrow(this.signer, job.provider, job.seq));
  }

  /** → `client.claim(signer)` → `emissions.claim()`. Check {@link pendingRewards} first: a zero claim fails with `NothingToClaim` and still pays the fee. */
  async claim(): Promise<TxRecord> {
    return this.record('claim', await this.client.claim(this.signer));
  }

  private async record(label: string, r: SubmitResult): Promise<TxRecord> {
    const block = await this.api.rpc.chain.getBlock(r.blockHash);
    const blockNumber = block.block.header.number.toNumber();
    const index = block.block.extrinsics.findIndex((x) => x.hash.toHex() === r.txHash);
    return {
      label,
      txHash: r.txHash,
      blockHash: r.blockHash,
      blockNumber,
      explorerUrl: `${this.explorerBase}/extrinsic/${blockNumber}/${index}`,
    };
  }
}
