/**
 * Operator configuration, from the environment.
 *
 * Every value is validated at startup and the process refuses to boot on a bad
 * one. A faucet that silently falls back to a default drip amount or a default
 * rate limit is a faucet that quietly hands out more than the operator intended.
 */

import { parseCmnToPlancks } from './amount.js';
import type { RateLimitRule } from './rateLimiter.js';

export interface FaucetConfig {
  readonly rpcEndpoint: string;
  /** Seed/URI of the pre-funded devnet account. Never a mint authority. */
  readonly faucetSeed: string;
  readonly ss58Format: number;
  readonly dripAmountPlancks: bigint;
  readonly reservePlancks: bigint;
  readonly perAddress: RateLimitRule;
  readonly perIp: RateLimitRule;
  readonly host: string;
  readonly port: number;
  readonly trustProxy: boolean;
}

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

/**
 * Builds config from `env`.
 *
 * Defaults target the local 5-validator devnet: `//Ferdie` is endowed at genesis
 * and is not a validator, so spending from it moves no staked funds.
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

  const config: FaucetConfig = {
    rpcEndpoint: str(env, 'FAUCET_RPC_ENDPOINT', 'ws://127.0.0.1:9944'),
    faucetSeed: str(env, 'FAUCET_SEED', '//Ferdie'),
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
