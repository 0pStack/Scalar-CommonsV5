import type { AgentMode } from './types.js';

/** 1 CMN = 10^12 plancks. */
const PLANCKS_PER_CMN = 1_000_000_000_000n;
const CMN_DECIMALS = 12;

export interface Config {
  /** Node WebSocket endpoint (`SCALAR_WS`). */
  ws: string;
  /** Mnemonic or dev `//URI`. Secret: never logged, never in `redacted()`. */
  secret: string;
  mode: AgentMode;
  /** Stake locked on registration, in plancks. */
  stake: bigint;
  name: string;
  heartbeatEveryBlocks: bigint;
  minDeliveryBlocks: bigint;
  buyerAmount: bigint;
  /** Providers a buyer may open agreements with. Required (non-empty) for `buyer` and `both`: the buyer fails closed. */
  buyerPeers: string[];
  buyerMaxOpen: number;
  buyerDeliverWithin: bigint;
  pollSeconds: number;
  /** Directory for `state.json` and `agent.jsonl` (the container's `/state` volume). */
  stateDir: string;
  /** Printable summary with the secret removed. */
  redacted(): Record<string, unknown>;
}

type Env = Record<string, string | undefined>;

/** A whole number of blocks/counts. Garbage fails loudly instead of defaulting. */
function wholeNumber(env: Env, key: string, fallback: string, min: bigint): bigint {
  const raw = (env[key] ?? fallback).trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a non-negative whole number, got "${raw}"`);
  const n = BigInt(raw);
  if (n < min) throw new Error(`${key} must be >= ${min}, got ${n}`);
  return n;
}

/**
 * A CMN amount with up to 12 decimals, converted to plancks with integer math.
 * Floats would turn `0.1 CMN` into 100000000000.00002 plancks; the balance
 * rules of this repo forbid that class of error.
 */
function cmn(env: Env, key: string, fallback: string): bigint {
  const raw = (env[key] ?? fallback).trim();
  const m = /^(\d+)(?:\.(\d{1,12}))?$/.exec(raw);
  if (!m) throw new Error(`${key} must be a CMN amount with at most ${CMN_DECIMALS} decimals, got "${raw}"`);
  const whole = BigInt(m[1] ?? '0') * PLANCKS_PER_CMN;
  const frac = BigInt((m[2] ?? '').padEnd(CMN_DECIMALS, '0') || '0');
  return whole + frac;
}

/**
 * Read the agent's configuration from the environment.
 *
 * The key is taken from `AGENT_MNEMONIC` (or `AGENT_URI` for dev keys such as
 * `//Alice//ref`) and only from the environment: there is deliberately no
 * command-line flag for it, so it never lands in shell history or `ps`.
 */
export function loadConfig(env: Env): Config {
  const mnemonic = env.AGENT_MNEMONIC?.trim();
  const uri = env.AGENT_URI?.trim();
  if (mnemonic && uri) throw new Error('set only one of AGENT_MNEMONIC and AGENT_URI');
  const secret = mnemonic || uri;
  if (!secret) throw new Error('AGENT_MNEMONIC is required (or AGENT_URI for a dev key)');

  const mode = (env.AGENT_MODE ?? 'provider').trim();
  if (mode !== 'provider' && mode !== 'buyer' && mode !== 'both') {
    throw new Error(`AGENT_MODE must be provider, buyer or both, got "${mode}"`);
  }

  const cfg: Config = {
    ws: (env.SCALAR_WS ?? 'ws://127.0.0.1:9944').trim(),
    secret,
    mode,
    stake: cmn(env, 'STAKE_CMN', '1000'),
    name: (env.AGENT_NAME ?? 'operator-reference-agent').trim(),
    heartbeatEveryBlocks: wholeNumber(env, 'HEARTBEAT_BLOCKS', '600', 1n),
    minDeliveryBlocks: wholeNumber(env, 'MIN_DELIVERY_BLOCKS', '10', 0n),
    buyerAmount: cmn(env, 'BUYER_AMOUNT_CMN', '10'),
    buyerPeers: (env.BUYER_PEERS ?? '').split(',').map((x) => x.trim()).filter((x) => x !== ''),
    buyerMaxOpen: Number(wholeNumber(env, 'BUYER_MAX_OPEN', '2', 0n)),
    buyerDeliverWithin: wholeNumber(env, 'BUYER_DELIVER_WITHIN_BLOCKS', '600', 1n),
    pollSeconds: Number(wholeNumber(env, 'POLL_SECONDS', '6', 1n)),
    stateDir: (env.STATE_DIR ?? './state').trim(),
    redacted() {
      const { secret: _secret, redacted: _redacted, ...rest } = cfg;
      return Object.fromEntries(
        Object.entries(rest).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]),
      );
    },
  };
  // Fail closed: an empty allowlist would let the buyer reserve funds with any
  // registered agent, which may never deliver.
  if (mode !== 'provider' && cfg.buyerPeers.length === 0) {
    throw new Error(`BUYER_PEERS is required when AGENT_MODE is ${mode}: list the provider addresses this buyer may pay`);
  }
  return cfg;
}
