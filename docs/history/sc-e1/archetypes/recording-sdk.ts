/**
 * RecordingSdk — a deterministic, in-memory implementation of {@link AgentSdk}.
 *
 * Instead of broadcasting extrinsics to a node, it appends each one to an
 * ordered ledger. This is what makes the acceptance criterion checkable today:
 * "replaying a manifest reproduces identical extrinsic sequences per seed." The
 * ledger IS the extrinsic sequence.
 *
 * It maps the §8.3 SDK method names onto the real chain's `pallet.method` names
 * (per the SDK README mapping) so the recorded stream is a faithful preview of
 * what the live SDK will submit. It also mirrors the tiny amount of chain
 * bookkeeping the archetypes need to be well-formed: the per-buyer agreement
 * `seq` counter. It re-implements no economics.
 *
 * Every write passes through {@link assertNotPrivileged} — a defence-in-depth
 * enforcement of protocol §5 at the point of recording, not just in tests.
 */
import type { AgentSdk, ExtrinsicRecord, Hash32 } from './types.ts';
import { assertNotPrivileged } from './privileged.ts';

/** Render a bigint arg as a decimal string so the ledger is JSON-stable. */
function big(v: bigint): string {
  return v.toString();
}

export class RecordingSdk implements AgentSdk {
  /** The ordered extrinsic ledger — the reproducible artefact. */
  readonly ledger: ExtrinsicRecord[] = [];

  /** Per-buyer monotonic agreement seq, mirroring on-chain allocation. */
  private readonly nextSeq = new Map<string, number>();

  /** Era pointer, advanced by the runner before each era's work. */
  private era = 0;

  /** Point the SDK at the era whose extrinsics are now being produced. */
  setEra(era: number): void {
    this.era = era;
  }

  private push(signer: string, method: string, args: ExtrinsicRecord['args']): void {
    assertNotPrivileged(signer, method);
    this.ledger.push({ seq: this.ledger.length, era: this.era, signer, method, args });
  }

  async register(account: string, stake: bigint): Promise<void> {
    this.push(account, 'agents.register', [big(stake)]);
  }

  async stake(account: string, amount: bigint): Promise<void> {
    this.push(account, 'agents.addStake', [big(amount)]);
  }

  async heartbeat(account: string): Promise<void> {
    this.push(account, 'agents.heartbeat', []);
  }

  async createEscrow(
    account: string,
    provider: string,
    amount: bigint,
    deliverableHash: Hash32,
    deliverBy: bigint,
    capabilityId: number | null = null,
  ): Promise<number> {
    const seq = this.nextSeq.get(account) ?? 0;
    this.nextSeq.set(account, seq + 1);
    this.push(account, 'escrow.createAgreement', [
      provider,
      big(amount),
      deliverableHash,
      big(deliverBy),
      capabilityId,
    ]);
    return seq;
  }

  async acceptEscrow(
    account: string,
    buyer: string,
    seq: number,
    deliveryHash: Hash32,
  ): Promise<void> {
    this.push(account, 'escrow.recordDelivery', [buyer, seq, deliveryHash]);
  }

  async completeEscrow(account: string, provider: string, seq: number): Promise<void> {
    this.push(account, 'escrow.confirmDelivery', [provider, seq]);
  }

  async submitOracle(
    account: string,
    requestId: Hash32,
    answerHash: Hash32,
    capability: number,
  ): Promise<void> {
    this.push(account, 'oracle.submitResponse', [requestId, answerHash, capability]);
  }

  async vote(account: string, pollIndex: number, aye: boolean, balance: bigint): Promise<void> {
    this.push(account, 'convictionVoting.vote', [pollIndex, aye, big(balance)]);
  }

  async settleEra(account: string): Promise<void> {
    this.push(account, 'emissions.settleEra', []);
  }

  async claim(account: string): Promise<void> {
    this.push(account, 'emissions.claim', []);
  }
}
