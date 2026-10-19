import { createHash } from 'node:crypto';
import type { AgentConfig, AgreementView, Chain, Emit } from './types.js';

/** Persistent per-agent memory, so a restart never repeats a finished step. */
export interface AgentState {
  /** `buyer:seq` keys we already accepted as provider. */
  accepted: string[];
  /** `buyer:seq` keys we already delivered as provider. */
  delivered: string[];
  /** `provider:seq` keys we already confirmed as buyer. */
  confirmed: string[];
}

const key = (counterparty: string, seq: number) => `${counterparty}:${seq}`;

/**
 * The work stub: a deterministic delivery hash for one agreement.
 *
 * A real worker would do the work named by `deliverableHash` and hash its
 * output. The stub commits to the agreement identity instead, so the delivery
 * proof is reproducible and never collides across agreements.
 */
export function deliveryHashFor(a: AgreementView): string {
  const h = createHash('sha256')
    .update(`scalar-reference-agent/v1|${a.buyer}|${a.provider}|${a.seq}|${a.deliverableHash}`)
    .digest('hex');
  return `0x${h}`;
}

/**
 * The reference worker: one `tick()` is one pass of
 * register → heartbeat → accept → deliver → (buyer) confirm/open → claim.
 *
 * Each step is independent and failure-isolated: an error is logged with its
 * step name and the tick carries on, so a bad agreement cannot stop the
 * heartbeat. Nothing is retried inside a tick; the next tick is the retry, and
 * each one is a fresh, logged attempt (the SDK's no-silent-retry rule).
 */
export class Agent {
  /** Set once we registered this run and the metadata name is not yet on chain. */
  private metadataPending = false;

  constructor(
    readonly chain: Chain,
    readonly config: AgentConfig,
    readonly emit: Emit,
    readonly state: AgentState = { accepted: [], delivered: [], confirmed: [] },
  ) {}

  private async step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      this.emit('error', { step: name, message: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  }

  async tick(): Promise<void> {
    const registered = await this.ensureRegistered();
    if (registered === undefined) return;
    await this.step('heartbeat', () => this.maybeHeartbeat(registered === 'new'));
    if (this.metadataPending) await this.step('metadata', () => this.updateMetadata());
    await this.step('messaging-key', () => this.ensureMessagingKey());
    const { mode } = this.config;
    if (mode === 'provider' || mode === 'both') await this.step('provider', () => this.provide());
    if (mode === 'buyer' || mode === 'both') await this.step('buyer', () => this.buy());
    await this.step('claim', () => this.maybeClaim());
  }

  /** `'existing'`/`'new'` when the agent is (now) registered; `undefined` if the tick must stop. */
  private async ensureRegistered(): Promise<'existing' | 'new' | undefined> {
    const already = await this.step('registered-check', () => this.chain.isRegistered(this.config.address));
    if (already === undefined) return undefined;
    if (already) return 'existing';
    const tx = await this.step('register', () => this.chain.register(this.config.stake));
    if (tx === undefined) return undefined;
    this.emit('register', { stake: this.config.stake.toString(), name: this.config.name, tx });
    // The agent IS registered from here on; naming it is best-effort and is
    // retried on later ticks, so it can never hide the register or delay the
    // first heartbeat.
    this.metadataPending = true;
    await this.step('metadata', () => this.updateMetadata());
    return 'new';
  }

  private async updateMetadata(): Promise<void> {
    const tx = await this.chain.setMetadata(this.config.name);
    this.metadataPending = false;
    if (tx !== null) this.emit('metadata', { name: this.config.name, tx });
  }

  /**
   * Keep the derived messaging key published (D14). Registered agents only —
   * this runs after `ensureRegistered` — and only on spec 308+ runtimes. The
   * key is a pure function of the agent secret, so a mismatch means the chain
   * holds a stale or foreign key: senders would encrypt to a key this agent
   * cannot open. Publishing is fee-only (no deposit), and one read per tick
   * keeps it from repeating once the chain agrees.
   */
  private async ensureMessagingKey(): Promise<void> {
    const key = this.config.messagingKey;
    if (key === undefined || !this.chain.supportsMessaging()) return;
    const previous = await this.chain.messagingKeyOf(this.config.address);
    if (previous !== null && previous.toLowerCase() === key.toLowerCase()) return;
    const tx = await this.chain.setMessagingKey(key);
    this.emit('messaging-key', { key, previous, tx });
  }

  /**
   * `force` is set right after registering: from spec 306 `register` stamps the
   * heartbeat clock itself, so the interval rule alone would skip the first
   * beat. One explicit beat proves the liveness path works from the start.
   */
  private async maybeHeartbeat(force: boolean): Promise<void> {
    const [head, last] = await Promise.all([this.chain.head(), this.chain.lastHeartbeat(this.config.address)]);
    // Economic why: the heartbeat multiplier rewards liveness, and the grace
    // period is far longer than our interval, so one missed tick costs nothing.
    if (!force && last !== null && head - last < this.config.heartbeatEveryBlocks) return;
    const tx = await this.chain.heartbeat();
    this.emit('heartbeat', { block: head.toString(), previous: last === null ? null : last.toString(), tx });
  }

  private async provide(): Promise<void> {
    const head = await this.chain.head();
    const mine = (await this.chain.agreementsAsProvider(this.config.address)).filter(
      (a) => a.provider === this.config.address && a.status === 'Created' && head <= a.deliverBy,
    );
    for (const a of mine) {
      const k = key(a.buyer, a.seq);
      if (this.chain.supportsAccept() && !this.state.accepted.includes(k)) {
        const tx = await this.step('accept', () => this.chain.acceptAgreement(a.buyer, a.seq));
        if (tx !== undefined) {
          this.state.accepted.push(k);
          this.emit('accept', { buyer: a.buyer, seq: a.seq, tx });
        }
      }
      if (this.state.delivered.includes(k)) continue;
      // recordDelivery is rejected before created_at + MinDeliveryBlocks; wait
      // instead of paying for a transaction that is bound to fail.
      if (head < a.createdAt + this.config.minDeliveryBlocks) continue;
      const proof = deliveryHashFor(a);
      const tx = await this.step('deliver', () => this.chain.recordDelivery(a.buyer, a.seq, proof));
      if (tx !== undefined) {
        this.state.delivered.push(k);
        this.emit('deliver', { buyer: a.buyer, seq: a.seq, amount: a.amount.toString(), proof, tx });
      }
    }
  }

  private async buy(): Promise<void> {
    // Defence in depth (loadConfig also refuses): a buyer with no explicit
    // peers would pay any registered stranger, so it does nothing at all.
    if (this.config.buyerPeers.length === 0) {
      this.emit('error', { step: 'buyer', message: 'BUYER_PEERS is empty; buyer mode refuses to act' });
      return;
    }
    const me = this.config.address;
    const mine = (await this.chain.agreementsAsBuyer(me)).filter((a) => a.buyer === me);

    for (const a of mine) {
      const k = key(a.provider, a.seq);
      if (a.status !== 'Delivered' || this.state.confirmed.includes(k)) continue;
      const tx = await this.step('confirm', () => this.chain.confirmDelivery(a.provider, a.seq));
      if (tx !== undefined) {
        this.state.confirmed.push(k);
        this.emit('confirm', { provider: a.provider, seq: a.seq, amount: a.amount.toString(), tx });
      }
    }

    // Guards before funds move: cap and affordability are checked before the
    // create call reserves anything.
    if (mine.length >= this.config.buyerMaxOpen) return;
    if ((await this.chain.freeBalance(me)) < this.config.buyerAmount) return;
    const busy = new Set(mine.map((a) => a.provider));
    const { buyerPeers } = this.config;
    // Only providers the operator explicitly trusts (BUYER_PEERS) qualify.
    const peer = (await this.chain.registeredAgents()).find(
      (p) => p !== me && !busy.has(p) && buyerPeers.includes(p),
    );
    if (peer === undefined) return;

    const head = await this.chain.head();
    const deliverBy = head + this.config.buyerDeliverWithin;
    const deliverable = `0x${createHash('sha256').update(`scalar-reference-agent/v1|${me}|${peer}|${head}`).digest('hex')}`;
    const tx = await this.step('create', () =>
      this.chain.createAgreement(peer, this.config.buyerAmount, deliverable, deliverBy),
    );
    if (tx !== undefined) {
      this.emit('create', {
        provider: peer,
        amount: this.config.buyerAmount.toString(),
        deliverBy: deliverBy.toString(),
        tx,
      });
    }
  }

  private async maybeClaim(): Promise<void> {
    const pending = await this.chain.pendingEmissions(this.config.address);
    if (pending <= 0n) return;
    const tx = await this.chain.claim();
    this.emit('claim', { pending: pending.toString(), tx });
  }
}
