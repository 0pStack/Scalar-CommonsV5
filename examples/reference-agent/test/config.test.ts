import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { SCALAR_WS: 'wss://rpc.scalarnet.io', SCALAR_SEED_FILE: '/etc/scalar-agent/seed' };

describe('loadConfig', () => {
  it('applies defaults that pass the chain gates', () => {
    const c = loadConfig(base);
    expect(c.wsUrl).toBe('wss://rpc.scalarnet.io');
    expect(c.seedFile).toBe('/etc/scalar-agent/seed');
    // agents.minStake is 1 000 CMN; the default must not be below it.
    expect(c.stakePlancks).toBe(1_000n * 10n ** 12n);
    // Well inside agents.heartbeatGracePeriod (10 800 blocks).
    expect(c.heartbeatEveryBlocks).toBe(600);
    expect(c.capabilities).toEqual([]);
    expect(c.acceptUncategorised).toBe(true);
    expect(c.autoConfirm).toBe(false);
    expect(c.claimRewards).toBe(true);
  });

  it('parses CMN amounts as exact bigint plancks, never floats', () => {
    const c = loadConfig({ ...base, AGENT_STAKE_CMN: '1000.000000000001' });
    expect(c.stakePlancks).toBe(1_000_000_000_000_001n);
  });

  it('rejects more than 12 decimal places instead of rounding', () => {
    expect(() => loadConfig({ ...base, AGENT_STAKE_CMN: '1.0000000000001' })).toThrow(/decimal/);
  });

  it('parses a capability list', () => {
    expect(loadConfig({ ...base, AGENT_CAPABILITIES: '7, 12,3' }).capabilities).toEqual([7, 12, 3]);
  });

  it('refuses a heartbeat interval longer than the grace period', () => {
    expect(() => loadConfig({ ...base, HEARTBEAT_EVERY_BLOCKS: '10801' })).toThrow(/grace/);
  });

  it('requires the endpoint and the seed file, and never accepts a seed in the environment', () => {
    expect(() => loadConfig({ SCALAR_SEED_FILE: '/x' })).toThrow(/SCALAR_WS/);
    expect(() => loadConfig({ SCALAR_WS: 'wss://x' })).toThrow(/SCALAR_SEED_FILE/);
    expect(() => loadConfig({ ...base, SCALAR_SEED: 'bottom drive obey lake curtain smoke basket hold race lonely fit walk' }))
      .toThrow(/SCALAR_SEED_FILE/);
  });

  it('rejects non-boolean flags', () => {
    expect(() => loadConfig({ ...base, AUTO_CONFIRM: 'yes please' })).toThrow(/AUTO_CONFIRM/);
    expect(loadConfig({ ...base, AUTO_CONFIRM: 'true' }).autoConfirm).toBe(true);
  });
});
