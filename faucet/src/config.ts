/**
 * Operator configuration, from the environment.
 *
 * Every value is validated at startup and the process refuses to boot on a bad
 * one. A faucet that silently falls back to a default drip amount or a default
 * rate limit is a faucet that quietly hands out more than the operator intended.
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { DEV_PHRASE } from '@polkadot/keyring/defaults';
import { parseCmnToPlancks } from './amount.js';
import type { RateLimitRule } from './rateLimiter.js';

export interface FaucetConfig {
  readonly rpcEndpoint: string;
  /** Signing seed/URI; a published dev seed only with FAUCET_ALLOW_DEV_SEED. Never a mint authority. */
  readonly faucetSeed: string;
  readonly ss58Format: number;
  readonly dripAmountPlancks: bigint;
  readonly reservePlancks: bigint;
  readonly perAddress: RateLimitRule;
  readonly perIp: RateLimitRule;
  /** Total budgets across every requester (F11, #20). */
  readonly global: readonly [hourly: RateLimitRule, daily: RateLimitRule];
  /** How long a drip waits for its turn to check the balance and submit. */
  readonly lockWaitMs: number;
  /** How long a submitted transfer may take to reach a block. */
  readonly inclusionTimeoutMs: number;
  /** How long an included transfer may take to finalize. */
  readonly finalityTimeoutMs: number;
  /** Absolute path of the file that keeps rate-limit grants across restarts. */
  readonly stateFile: string;
  readonly host: string;
  readonly port: number;
  readonly trustProxy: boolean;
}

/**
 * Agents abort a drip request after 60 s (agent/src/onboard.ts) and nginx stops
 * waiting for the faucet at 60 s, so a drip's waits must add up to less.
 */
const CALLER_DEADLINE_MS = 60_000;

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function int(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function positiveInt(env: Env, key: string, fallback: number): number {
  const value = int(env, key, fallback);
  if (value < 1) {
    throw new Error(`${key} must be at least 1, got ${value}`);
  }
  return value;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${key} must be true or false, got ${JSON.stringify(raw)}`);
}

const DEV_SEED = '//Ferdie';

/**
 * The signing seed has no silent default. `//Ferdie`, every other `//Name` URI, and
 * DEV_PHRASE itself (`//Name` is shorthand for `DEV_PHRASE//Name`) are published:
 * once RPC is public anyone can empty that account with a plain transfer, and the
 * rate limits and reserve protect nothing (I-6, #123). Any URI starting with `/` is
 * refused too: it is a derivation path with no phrase of its own, so a soft path
 * such as `/Alice` can only name a key everyone can derive (subkey reads it as
 * `DEV_PHRASE/Alice`). A dev seed is accepted only when the operator opts in with
 * FAUCET_ALLOW_DEV_SEED.
 *
 * Errors never echo the seed: a `///password` suffix would land in the journal.
 */
function faucetSeed(env: Env): string {
  const allowDevSeed = bool(env, 'FAUCET_ALLOW_DEV_SEED', false);
  const seed = str(env, 'FAUCET_SEED', allowDevSeed ? DEV_SEED : '');
  if (seed === '') {
    throw new Error(
      'FAUCET_SEED is required. For a local devnet only, set FAUCET_ALLOW_DEV_SEED=true to sign with //Ferdie.',
    );
  }
  const isDevSeed = seed.startsWith('/') || seed.startsWith(DEV_PHRASE);
  if (isDevSeed && !allowDevSeed) {
    throw new Error(
      'FAUCET_SEED is a published dev seed (/Name, //Name or the dev phrase); set FAUCET_ALLOW_DEV_SEED=true if this is a local devnet.',
    );
  }
  return seed;
}

/**
 * Builds config from `env`.
 *
 * Drip and rate-limit defaults target the local 5-validator devnet. The signing
 * seed is the exception — see `faucetSeed`.
 */
export function configFromEnv(env: Env = process.env): FaucetConfig {
  // 1 500 CMN: one registration (1 050.01) plus ~450 CMN to experiment with. At
  // 1 100 a single 100 CMN transfer before registering stranded a tester behind
  // the 60-minute per-address window (#162). Worst case per IP: 5 × 1 500 CMN/hour.
  const dripAmountPlancks = parseCmnToPlancks(str(env, 'FAUCET_DRIP_CMN', '1500'));
  if (dripAmountPlancks <= 0n) {
    throw new Error('FAUCET_DRIP_CMN must be greater than zero');
  }
  const perAddressWindowMinutes = int(env, 'FAUCET_ADDRESS_WINDOW_MINUTES', 60);
  const perIpWindowMinutes = int(env, 'FAUCET_IP_WINDOW_MINUTES', 60);
  // F11 (#20): at the default drip, 50 a day caps the faucet's loss at 75 000 CMN
  // per day however many addresses and IPs ask.
  const hourlyMax = positiveInt(env, 'FAUCET_GLOBAL_HOURLY_MAX', 20);
  const dailyMax = positiveInt(env, 'FAUCET_GLOBAL_DAILY_MAX', 50);
  if (dailyMax < hourlyMax) {
    throw new Error(`FAUCET_GLOBAL_DAILY_MAX (${dailyMax}) must be at least FAUCET_GLOBAL_HOURLY_MAX (${hourlyMax})`);
  }
  const lockWaitMs = positiveInt(env, 'FAUCET_LOCK_WAIT_SECONDS', 10) * 1000;
  const inclusionTimeoutMs = positiveInt(env, 'FAUCET_INCLUSION_TIMEOUT_SECONDS', 18) * 1000;
  const finalityTimeoutMs = positiveInt(env, 'FAUCET_FINALITY_TIMEOUT_SECONDS', 24) * 1000;
  if (lockWaitMs + inclusionTimeoutMs + finalityTimeoutMs >= CALLER_DEADLINE_MS) {
    throw new Error(
      'FAUCET_LOCK_WAIT_SECONDS + FAUCET_INCLUSION_TIMEOUT_SECONDS + FAUCET_FINALITY_TIMEOUT_SECONDS must stay under ' +
        'the 60 s agents and nginx wait for a drip',
    );
  }
  const stateFile = str(env, 'FAUCET_STATE_FILE', join(homedir(), '.local', 'state', 'scalar-commons', 'faucet-limits.json'));
  if (!isAbsolute(stateFile)) {
    // Node does not expand `~`, and a relative path would move with the working directory.
    throw new Error(`FAUCET_STATE_FILE must be an absolute path, got ${JSON.stringify(stateFile)}`);
  }

  const config: FaucetConfig = {
    rpcEndpoint: str(env, 'FAUCET_RPC_ENDPOINT', 'ws://127.0.0.1:9944'),
    faucetSeed: faucetSeed(env),
    ss58Format: int(env, 'FAUCET_SS58_FORMAT', 42),
    dripAmountPlancks,
    reservePlancks: parseCmnToPlancks(str(env, 'FAUCET_RESERVE_CMN', '1000')),
    perAddress: {
      maxRequests: int(env, 'FAUCET_ADDRESS_MAX_REQUESTS', 1),
      windowMs: perAddressWindowMinutes * 60_000,
    },
    perIp: {
      maxRequests: int(env, 'FAUCET_IP_MAX_REQUESTS', 5),
      windowMs: perIpWindowMinutes * 60_000,
    },
    global: [
      { maxRequests: hourlyMax, windowMs: 60 * 60_000 },
      { maxRequests: dailyMax, windowMs: 24 * 60 * 60_000 },
    ],
    lockWaitMs,
    inclusionTimeoutMs,
    finalityTimeoutMs,
    stateFile,
    host: str(env, 'FAUCET_HOST', '127.0.0.1'),
    port: int(env, 'FAUCET_PORT', 8080),
    trustProxy: bool(env, 'FAUCET_TRUST_PROXY', false),
  };

  if (config.perAddress.maxRequests < 1) {
    throw new Error('FAUCET_ADDRESS_MAX_REQUESTS must be at least 1');
  }
  if (config.perIp.maxRequests < 1) {
    throw new Error('FAUCET_IP_MAX_REQUESTS must be at least 1');
  }
  if (config.perAddress.windowMs <= 0) {
    throw new Error('FAUCET_ADDRESS_WINDOW_MINUTES must be greater than zero');
  }
  if (config.perIp.windowMs <= 0) {
    throw new Error('FAUCET_IP_WINDOW_MINUTES must be greater than zero');
  }
  return config;
}
