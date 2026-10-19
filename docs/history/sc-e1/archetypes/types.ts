/**
 * Shared types for the SC-E1 archetype runners.
 *
 * The archetypes are written against {@link AgentSdk} — the minimal write/read
 * surface of protocol §8.3 — NOT against any concrete transport. Two things
 * implement this interface:
 *
 *  1. {@link RecordingSdk} (this package): a deterministic, in-memory SDK that
 *     records every extrinsic instead of broadcasting it. It makes the
 *     acceptance criterion — "replaying a manifest reproduces identical
 *     extrinsic sequences per seed" — verifiable *now*, before a dev node
 *     exists.
 *  2. The real polkadot-js SDK from P0-3 (`sdk/`, `ScalarCommonsClient`), via a
 *     thin adapter that maps an `account` id to a keyring pair. The archetypes
 *     do not change when the real hands are plugged in.
 *
 * `account` is an opaque agent identifier (a string). In the recording SDK it is
 * just a label; in the real adapter it keys a keypair. Crucially it is NEVER a
 * privileged/root key — see `privileged.ts` and protocol §5 ("No archetype ever
 * holds a privileged key").
 */

/** A 32-byte hash carried as a `0x…` hex string. */
export type Hash32 = string;

/** One recorded extrinsic — the atomic unit of a reproducible run. */
export interface ExtrinsicRecord {
  /** Global monotonic order within a single run (0-based). */
  seq: number;
  /** Era in which the extrinsic was submitted. */
  era: number;
  /** Signing account id. Guaranteed non-privileged (asserted in tests). */
  signer: string;
  /** Canonical `pallet.method` name, matching the real chain (SDK README map). */
  method: string;
  /**
   * Canonical, JSON-safe argument list. `bigint`s are rendered as decimal
   * strings so the sequence serialises deterministically and hashes stably.
   */
  args: Array<string | number | boolean | null>;
}

/**
 * The agent-facing SDK surface (protocol §8.3), reduced to what archetypes call.
 * Every method signs as `account`. Writes resolve once "included"; `createEscrow`
 * resolves to the on-chain agreement `seq` the provider will later reference.
 */
export interface AgentSdk {
  register(account: string, stake: bigint): Promise<void>;
  stake(account: string, amount: bigint): Promise<void>;
  heartbeat(account: string): Promise<void>;
  createEscrow(
    account: string,
    provider: string,
    amount: bigint,
    deliverableHash: Hash32,
    deliverBy: bigint,
    capabilityId?: number | null,
  ): Promise<number>;
  acceptEscrow(account: string, buyer: string, seq: number, deliveryHash: Hash32): Promise<void>;
  completeEscrow(account: string, provider: string, seq: number): Promise<void>;
  submitOracle(
    account: string,
    requestId: Hash32,
    answerHash: Hash32,
    capability: number,
  ): Promise<void>;
  vote(account: string, pollIndex: number, aye: boolean, balance: bigint): Promise<void>;
  settleEra(account: string): Promise<void>;
  claim(account: string): Promise<void>;
}

/** Everything an archetype's per-era loop needs. */
export interface EraContext {
  /** Current era number (0-based). */
  era: number;
  /** The shared SDK (recording or real). */
  sdk: AgentSdk;
  /**
   * Settlement coordinator shared across the whole run. Each archetype calls
   * `attempt(account, era)` at the end of its loop — settle_era-with-backoff,
   * from participant incentive alone (protocol §5 settlement rule, §3 P0 gate:
   * "no root-gated liveness").
   */
  settlement: SettlementCoordinator;
}

/** A runnable archetype: a deterministic scripted loop over the SDK. */
export interface Archetype {
  /** Protocol id, e.g. `"A-1"`. */
  readonly id: string;
  /** Human name, e.g. `"HONEST-WORKER"`. */
  readonly name: string;
  /**
   * Set up the cohort (registration, initial stake). Called once before era 0.
   * Returns the list of accounts this cohort controls (for run-level settlement).
   */
  setup(sdk: AgentSdk, cohort: CohortContext): Promise<string[]>;
  /** One era of behaviour. Called once per era, in order. */
  perEra(ctx: EraContext, cohort: CohortContext): Promise<void>;
}

/** Per-cohort configuration + derived deterministic state. */
export interface CohortContext {
  /** Cohort seed, derived from the run seed + archetype id + cohort index. */
  seed: bigint;
  /** Index of this cohort within the run. */
  cohortIndex: number;
  /** Number of agents in the cohort (meaning is archetype-specific). */
  count: number;
  /** Free-form archetype parameters from the manifest. */
  params: Record<string, number>;
  /** Deterministic account ids owned by this cohort. Populated by `setup`. */
  accounts: string[];
}

/** Coordinates permissionless era settlement with per-agent backoff. */
export interface SettlementCoordinator {
  /**
   * Register `account` as willing to settle `era` after its seed-derived backoff.
   * The lowest-backoff account (ties broken by account id) is the one that
   * actually submits `emissions.settleEra` when the era is flushed — everyone
   * else observes it settled during their backoff and stands down. This models
   * the mainnet incentive without any privileged settler.
   */
  attempt(account: string, era: number): void;
  /** The maximum backoff any agent may draw, in abstract ticks. */
  readonly maxBackoff: number;
}
