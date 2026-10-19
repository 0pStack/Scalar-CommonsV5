/**
 * The reference agent daemon loop.
 *
 * On start: register with stake if not yet an agent, heartbeat immediately,
 * publish capabilities. Then, on every new block:
 *   - heartbeat every `heartbeatEveryBlocks`
 *   - deliver open agreements addressed to this agent (see work.ts for the rules)
 *   - optionally confirm deliveries on agreements where this agent is the buyer
 *   - after each settled emissions era, claim if anything is pending
 *
 * Every action is serialised through one queue. Two extrinsics from the same
 * account in flight at once race for the same nonce and one of them is
 * rejected as a duplicate — a daemon has to avoid that by construction.
 */
import type { AgentConfig } from './config.js';
import { ScalarAgentAdapter, type TxRecord } from './adapter.js';
import { selectToConfirm, selectWork, type AgreementView } from './work.js';
import { referenceWorker, type Worker } from './worker.js';
import { log } from './log.js';

const key = (a: AgreementView) => `${a.buyer}/${a.provider}/${a.seq}`;

/** Delivery attempts per agreement before the daemon stops paying fees on it. */
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_BLOCKS = 10;

export class ReferenceAgent {
  private queue: Promise<void> = Promise.resolve();
  private busy = false;
  private lastHeartbeatSent = 0;
  private lastSeenSettledEra: number | null = null;
  /** Agreements already acted on or reported, so each is logged once, not every block. */
  private readonly handled = new Set<string>();
  private readonly reported = new Set<string>();
  private readonly failures = new Map<string, { count: number; retryAt: number }>();

  constructor(
    private readonly chain: ScalarAgentAdapter,
    private readonly cfg: AgentConfig,
    private readonly worker: Worker = referenceWorker,
  ) {}

  private logTx(tx: TxRecord, extra: Record<string, unknown> = {}): void {
    log('info', `extrinsic ${tx.label}`, { ...tx, ...extra });
  }

  /** Run one action at a time; a failure is logged and the loop carries on. */
  private enqueue(name: string, fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn).catch((e: unknown) => {
      log('error', `${name} failed`, { error: e instanceof Error ? e.message : String(e) });
    });
    return this.queue;
  }

  async start(): Promise<void> {
    const c = this.chain;
    log('info', 'starting', {
      address: c.address,
      endpoint: this.cfg.wsUrl,
      spec: c.api.runtimeVersion.specVersion.toNumber(),
      free: await c.freeBalance(),
    });

    if (!(await c.isRegistered())) {
      const fee = BigInt(c.api.consts.agents!.baseRegistrationFee!.toString());
      const need = this.cfg.stakePlancks + fee + BigInt(c.api.consts.balances!.existentialDeposit!.toString());
      const free = await c.freeBalance();
      if (free < need) {
        throw new Error(`cannot register: free ${free} < stake + registration fee + existential deposit = ${need} plancks`);
      }
      this.logTx(await c.register(this.cfg.stakePlancks), { stake: this.cfg.stakePlancks });
    } else {
      log('info', 'already registered', { address: c.address });
    }

    // Heartbeat at once: the emissions activity gate needs a recent one.
    this.logTx(await c.heartbeat());
    this.lastHeartbeatSent = await c.head();

    if (this.cfg.capabilities.length > 0) {
      const published = await c.capabilities();
      const missing = this.cfg.capabilities.filter((id) => !published.includes(id));
      if (missing.length > 0 && !(await c.hasIdentity())) {
        // agents.setCapability requires an identity record (IdentityRequired).
        this.logTx(await c.setDisplayName(this.cfg.name ?? `agent-${c.address.slice(0, 8)}`));
      }
      for (const id of missing) this.logTx(await c.publishCapability(id), { capabilityId: id });
      log('info', 'capabilities', { published: await c.capabilities() });
    }

    this.lastSeenSettledEra = (await c.client.eraInfo()).lastSettledEra;

    await c.api.rpc.chain.subscribeNewHeads((header) => {
      const n = header.number.toNumber();
      // Skip a block rather than pile up work if the previous tick is still running.
      if (this.busy) return;
      this.busy = true;
      void this.enqueue('tick', () => this.tick(n)).finally(() => {
        this.busy = false;
      });
    });
    log('info', 'watching new blocks', {
      heartbeatEveryBlocks: this.cfg.heartbeatEveryBlocks,
      capabilities: this.cfg.capabilities,
      acceptUncategorised: this.cfg.acceptUncategorised,
      autoConfirm: this.cfg.autoConfirm,
    });
  }

  async tick(now: number): Promise<void> {
    const c = this.chain;

    if (now - this.lastHeartbeatSent >= this.cfg.heartbeatEveryBlocks) {
      this.logTx(await c.heartbeat());
      this.lastHeartbeatSent = now;
    }

    const all = await c.allAgreements();
    const { deliver, skipped } = selectWork(all, {
      me: c.address,
      now,
      minDeliveryBlocks: c.minDeliveryBlocks(),
      capabilities: this.cfg.capabilities,
      acceptUncategorised: this.cfg.acceptUncategorised,
    });
    for (const s of skipped) {
      const k = `${key(s.agreement)}:${s.reason}`;
      if (this.reported.has(k)) continue;
      this.reported.add(k);
      log('info', 'agreement not actionable yet', { agreement: key(s.agreement), reason: s.reason });
    }
    for (const job of deliver) {
      const k = key(job);
      if (this.handled.has(k)) continue;
      const f = this.failures.get(k);
      if (f && (f.count >= MAX_ATTEMPTS || now < f.retryAt)) continue;
      log('info', 'work found', { agreement: k, amount: job.amount, capabilityId: job.capabilityId, deliverableHash: job.deliverableHash });
      try {
        const deliveryHash = await this.worker.perform(job, c.address);
        this.logTx(await c.deliver(job, deliveryHash), { agreement: k, deliveryHash });
        this.handled.add(k);
        this.failures.delete(k);
      } catch (e) {
        // Bounded: a failed attempt paid a fee, so back off and give up after
        // MAX_ATTEMPTS instead of re-submitting every block.
        const count = (f?.count ?? 0) + 1;
        this.failures.set(k, { count, retryAt: now + RETRY_AFTER_BLOCKS });
        log('error', 'delivery failed', {
          agreement: k,
          attempt: count,
          giveUp: count >= MAX_ATTEMPTS,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (this.cfg.autoConfirm) {
      for (const job of selectToConfirm(all, c.address)) {
        if (this.handled.has(`confirm:${key(job)}`)) continue;
        this.handled.add(`confirm:${key(job)}`);
        this.logTx(await c.confirm(job), { agreement: key(job), deliveryProof: job.deliveryProof });
      }
    }

    if (this.cfg.claimRewards) {
      const info = await c.client.eraInfo();
      if (info.lastSettledEra !== this.lastSeenSettledEra) {
        this.lastSeenSettledEra = info.lastSettledEra;
        const pending = await c.pendingRewards();
        log('info', 'emissions era settled', { era: info.lastSettledEra, eraEmission: info.lastEraEmission, pending });
        // A zero claim fails with emissions.NothingToClaim and still pays the fee.
        if (pending > 0n) this.logTx(await c.claim(), { claimed: pending });
      }
    }
  }
}
