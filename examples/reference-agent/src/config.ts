/**
 * Daemon configuration, read from the environment (a systemd `EnvironmentFile`).
 *
 * Two rules shape this file:
 *  - The signing seed is never an environment variable. Environments leak into
 *    `ps e`, crash reports and `systemctl show`; the seed lives in a 0600 file
 *    and only its PATH is configured. `SCALAR_SEED` is rejected outright so a
 *    well-meaning operator cannot put it there by accident.
 *  - Amounts are CMN strings parsed to exact bigint plancks. A float would
 *    silently round a stake, and `agents.register` below `minStake` fails.
 */

/** 1 CMN = 10^12 plancks. */
const PLANCKS_PER_CMN = 10n ** 12n;

/**
 * `agents.heartbeatGracePeriod` on the live chain (spec 306): 10 800 blocks.
 * A heartbeat interval longer than this lets the liveness multiplier decay
 * between beats, which fails the emissions activity gate (`hb >= 90`).
 */
export const HEARTBEAT_GRACE_BLOCKS = 10_800;

export interface AgentConfig {
  /** WebSocket endpoint, e.g. `wss://rpc.scalarnet.io` or your own node's loopback. */
  wsUrl: string;
  /** Path to a file containing the agent's mnemonic or secret URI. Must be mode 0600. */
  seedFile: string;
  /** Stake locked by `agents.register`, in plancks. */
  stakePlancks: bigint;
  /** Send `agents.heartbeat` every N blocks. */
  heartbeatEveryBlocks: number;
  /** Capability ids this agent publishes via `agents.setCapability` and accepts work for. */
  capabilities: number[];
  /** Accept agreements that carry no capability id. */
  acceptUncategorised: boolean;
  /** Confirm deliveries on agreements where this agent is the BUYER. Off by default — see README. */
  autoConfirm: boolean;
  /** Call `emissions.claim` after each settled emissions era when something is pending. */
  claimRewards: boolean;
  /** Optional on-chain display name and metadata URI (`agents.updateMetadata`). */
  name: string | null;
  metadataUri: string | null;
  /** Base URL used to print explorer links next to every extrinsic hash. */
  explorerBase: string;
}

type Env = Record<string, string | undefined>;

/** Parse a decimal CMN string into exact plancks. */
export function parseCmn(name: string, raw: string): bigint {
  const s = raw.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`${name}: '${raw}' is not a non-negative decimal CMN amount`);
  const whole = m[1] ?? '0';
  const frac = m[2] ?? '';
  if (frac.length > 12) {
    throw new Error(`${name}: '${raw}' has more than 12 decimal places (1 CMN = 10^12 plancks); refusing to round`);
  }
  return BigInt(whole) * PLANCKS_PER_CMN + BigInt(frac.padEnd(12, '0') || '0');
}

function parseBool(name: string, raw: string | undefined, dflt: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return dflt;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new Error(`${name}: expected true/false, got '${raw}'`);
}

function parsePositiveInt(name: string, raw: string | undefined, dflt: number): number {
  if (raw === undefined || raw.trim() === '') return dflt;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name}: expected a positive integer, got '${raw}'`);
  return n;
}

function required(env: Env, name: string): string {
  const v = env[name];
  if (v === undefined || v.trim() === '') throw new Error(`${name} is required`);
  return v.trim();
}

export function loadConfig(env: Env): AgentConfig {
  if (env.SCALAR_SEED !== undefined) {
    throw new Error('SCALAR_SEED is not supported: put the seed in a 0600 file and set SCALAR_SEED_FILE to its path');
  }
  const wsUrl = required(env, 'SCALAR_WS');
  const seedFile = required(env, 'SCALAR_SEED_FILE');

  const stakePlancks = parseCmn('AGENT_STAKE_CMN', env.AGENT_STAKE_CMN ?? '1000');

  const heartbeatEveryBlocks = parsePositiveInt('HEARTBEAT_EVERY_BLOCKS', env.HEARTBEAT_EVERY_BLOCKS, 600);
  if (heartbeatEveryBlocks > HEARTBEAT_GRACE_BLOCKS) {
    throw new Error(
      `HEARTBEAT_EVERY_BLOCKS=${heartbeatEveryBlocks} exceeds the heartbeat grace period ` +
        `(${HEARTBEAT_GRACE_BLOCKS} blocks); the liveness multiplier would decay between beats`,
    );
  }

  const capsRaw = (env.AGENT_CAPABILITIES ?? '').trim();
  const capabilities = capsRaw === ''
    ? []
    : capsRaw.split(',').map((c) => {
      const n = Number(c.trim());
      if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`AGENT_CAPABILITIES: '${c}' is not a u32`);
      return n;
    });

  return {
    wsUrl,
    seedFile,
    stakePlancks,
    heartbeatEveryBlocks,
    capabilities,
    acceptUncategorised: parseBool('ACCEPT_UNCATEGORISED', env.ACCEPT_UNCATEGORISED, true),
    autoConfirm: parseBool('AUTO_CONFIRM', env.AUTO_CONFIRM, false),
    claimRewards: parseBool('CLAIM_REWARDS', env.CLAIM_REWARDS, true),
    name: env.AGENT_NAME?.trim() || null,
    metadataUri: env.AGENT_METADATA_URI?.trim() || null,
    explorerBase: (env.EXPLORER_BASE?.trim() || 'https://explorer.scalarnet.io').replace(/\/+$/, ''),
  };
}
