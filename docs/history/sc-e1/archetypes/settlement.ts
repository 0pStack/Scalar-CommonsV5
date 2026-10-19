/**
 * Permissionless era settlement with per-agent backoff.
 *
 * Protocol §5 settlement rule: "no run scripts a dedicated settler. Every
 * archetype's loop includes 'call settle_era if era is due and unsettled' with
 * a per-agent random backoff — settlement must emerge from the same incentive
 * the mainnet will rely on." Protocol §3 P0 gate and CLAUDE.md first-principle
 * #3 forbid root-gated liveness outright.
 *
 * Model: every agent that finishes its era calls {@link attempt}. Each draws a
 * backoff deterministically from `(settlementSeed, account, era)` — NOT from a
 * stateful stream, so the outcome is independent of the order agents happen to
 * act in. When the runner flushes the era, the agent with the lowest backoff
 * (ties broken by account id) is the one whose `settle_era` actually lands; the
 * others would have observed the era already settled during their own backoff
 * and stood down, so they emit nothing. Exactly one `emissions.settleEra` per
 * era, signed by a rotating, non-privileged participant.
 */
import { deriveSeed } from './prng.ts';
import type { AgentSdk, SettlementCoordinator } from './types.ts';

/** Outcome of settling one era. */
export interface SettlementOutcome {
  era: number;
  /** The account that actually submitted `settle_era`. */
  settler: string;
  /** Winning backoff, in abstract ticks (a proxy for settlement lag). */
  backoff: number;
  /** How many agents were willing to settle this era. */
  candidates: number;
}

export class Settlement implements SettlementCoordinator {
  readonly maxBackoff: number;
  private readonly sdk: AgentSdk;
  private readonly seed: bigint;
  private readonly current = new Map<string, number>();
  private currentEra = -1;

  constructor(sdk: AgentSdk, seed: bigint, maxBackoff: number) {
    if (maxBackoff < 0) throw new RangeError(`maxBackoff must be ≥ 0, got ${maxBackoff}`);
    this.sdk = sdk;
    this.seed = seed;
    this.maxBackoff = maxBackoff;
  }

  /** Backoff for `(account, era)`, deterministic and order-independent. */
  private backoffOf(account: string, era: number): number {
    return Number(deriveSeed(this.seed, 'settle', account, era) % BigInt(this.maxBackoff + 1));
  }

  attempt(account: string, era: number): void {
    if (era !== this.currentEra) {
      this.current.clear();
      this.currentEra = era;
    }
    this.current.set(account, this.backoffOf(account, era));
  }

  /**
   * Resolve the era: the lowest-backoff candidate submits `settle_era`. Returns
   * `null` if no agent volunteered (a degenerate run — the runner treats that as
   * a liveness failure to surface, never as something to paper over with a
   * privileged call).
   */
  async flush(era: number): Promise<SettlementOutcome | null> {
    if (era !== this.currentEra || this.current.size === 0) return null;

    let settler: string | null = null;
    let best = Number.POSITIVE_INFINITY;
    // Deterministic winner: min backoff, ties broken by lexicographic account id.
    for (const [account, backoff] of this.current) {
      if (backoff < best || (backoff === best && (settler === null || account < settler))) {
        best = backoff;
        settler = account;
      }
    }
    if (settler === null) return null;

    const outcome: SettlementOutcome = {
      era,
      settler,
      backoff: best,
      candidates: this.current.size,
    };
    await this.sdk.settleEra(settler);
    this.current.clear();
    this.currentEra = -1;
    return outcome;
  }
}
