import type { AddressOrPair } from '@polkadot/api/types';
import type { Codec } from '@polkadot/types/types';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { ScalarCommonsClient } from '@scalar-commons/sdk';
import type { AgreementView, Chain } from './types.js';

/** Read a codec's numeric value as bigint (missing → 0). */
function big(c: Codec | undefined | null): bigint {
  const s = c?.toString() ?? '';
  return s === '' ? 0n : BigInt(s);
}

/** Any storage entry, narrowed away from polkadot-js's index signatures. */
interface Entry {
  (...args: unknown[]): Promise<Codec>;
  entries(...args: unknown[]): Promise<[{ args: Codec[] }, Codec][]>;
  keys(...args: unknown[]): Promise<{ args: Codec[] }[]>;
}

/**
 * The {@link Chain} implementation over `@scalar-commons/sdk`.
 *
 * Writes go through the SDK client (signed, in-block, no silent retries);
 * reads use polkadot-js storage queries directly, because the SDK has no
 * agreement-listing surface yet. `escrow.acceptAgreement` is feature-detected
 * from the runtime metadata: spec 306 nodes do not have it.
 */
export class SdkChain implements Chain {
  constructor(
    private readonly client: ScalarCommonsClient,
    private readonly signer: AddressOrPair,
  ) {}

  private get api() {
    return this.client.api;
  }

  private query(section: string, item: string): Entry {
    const e = this.api.query[section]?.[item];
    if (typeof e !== 'function') throw new Error(`runtime does not expose storage item ${section}.${item}`);
    return e as unknown as Entry;
  }

  private toView(buyer: string, provider: string, v: Codec): AgreementView[] {
    const list = v as unknown as Iterable<Record<string, Codec & { type?: string }>>;
    return [...list].map((a) => ({
      buyer,
      provider,
      seq: Number(a.seq?.toString()),
      amount: big(a.amount),
      deliverableHash: (a.deliverableHash as unknown as { toHex(): string }).toHex(),
      deliverBy: big(a.deliverBy),
      createdAt: big(a.createdAt),
      status: String(a.status?.type ?? a.status?.toString()),
    }));
  }

  async head(): Promise<bigint> {
    return big(await this.query('system', 'number')());
  }

  async isRegistered(address: string): Promise<boolean> {
    const stake = (await this.query('agents', 'agentStake')(address)) as unknown as { isSome: boolean };
    return stake.isSome;
  }

  async lastHeartbeat(address: string): Promise<bigint | null> {
    // ValueQuery: an agent that never beat reads as block 0.
    const b = big(await this.query('agents', 'lastHeartbeat')(address));
    return b === 0n ? null : b;
  }

  supportsAccept(): boolean {
    return typeof this.api.tx.escrow?.acceptAgreement === 'function';
  }

  async freeBalance(address: string): Promise<bigint> {
    const acct = (await this.query('system', 'account')(address)) as unknown as { data: { free: Codec } };
    return big(acct.data.free);
  }

  async pendingEmissions(address: string): Promise<bigint> {
    return (await this.client.netPosition(address)).pendingEmissions;
  }

  async agreementsAsProvider(provider: string): Promise<AgreementView[]> {
    const all = await this.query('escrow', 'agreements').entries();
    return all
      .filter(([k]) => k.args[1]?.toString() === provider)
      .flatMap(([k, v]) => this.toView(k.args[0]!.toString(), provider, v));
  }

  async agreementsAsBuyer(buyer: string): Promise<AgreementView[]> {
    const rows = await this.query('escrow', 'agreements').entries(buyer);
    return rows.flatMap(([k, v]) => this.toView(buyer, k.args[1]!.toString(), v));
  }

  async registeredAgents(): Promise<string[]> {
    return (await this.query('agents', 'agentStake').keys()).map((k) => k.args[0]!.toString());
  }

  async register(stake: bigint): Promise<string> {
    return (await this.client.register(this.signer, stake)).txHash;
  }

  async setMetadata(name: string): Promise<string | null> {
    // Name the instance so ambient activity is attributable to its operator.
    const meta = this.api.tx.agents?.updateMetadata;
    if (typeof meta !== 'function') return null;
    return new Promise<string>((resolve, reject) => {
      meta('', name)
        .signAndSend(this.signer, ({ status, dispatchError, txHash }) => {
          if (dispatchError) reject(new Error(dispatchError.toString()));
          else if (status.isInBlock) resolve(txHash.toHex());
        })
        .catch(reject);
    });
  }

  async heartbeat(): Promise<string> {
    return (await this.client.heartbeat(this.signer)).txHash;
  }

  async acceptAgreement(buyer: string, seq: number): Promise<string> {
    const call = this.api.tx.escrow?.acceptAgreement;
    if (typeof call !== 'function') throw new Error('runtime does not expose escrow.acceptAgreement');
    return new Promise<string>((resolve, reject) => {
      call(buyer, seq)
        .signAndSend(this.signer, ({ status, dispatchError, txHash }) => {
          if (dispatchError) reject(new Error(dispatchError.toString()));
          else if (status.isInBlock) resolve(txHash.toHex());
        })
        .catch(reject);
    });
  }

  async recordDelivery(buyer: string, seq: number, deliveryHash: string): Promise<string> {
    return (await this.client.acceptEscrow(this.signer, buyer, seq, deliveryHash)).txHash;
  }

  async createAgreement(provider: string, amount: bigint, deliverableHash: string, deliverBy: bigint): Promise<string> {
    return (await this.client.createEscrow(this.signer, provider, amount, deliverableHash, deliverBy)).txHash;
  }

  async confirmDelivery(provider: string, seq: number): Promise<string> {
    return (await this.client.completeEscrow(this.signer, provider, seq)).txHash;
  }

  async claim(): Promise<string> {
    return (await this.client.claim(this.signer)).txHash;
  }

  supportsMessaging(): boolean {
    return typeof this.api.tx.agents?.setMessagingKey === 'function' && typeof this.api.tx.messages?.send === 'function';
  }

  async messagingKeyOf(address: string): Promise<string | null> {
    const key = await this.client.messagingKeyOf(address);
    return key === null ? null : u8aToHex(key);
  }

  async setMessagingKey(publicKey: string): Promise<string> {
    return (await this.client.setMessagingKey(this.signer, hexToU8a(publicKey))).txHash;
  }
}
