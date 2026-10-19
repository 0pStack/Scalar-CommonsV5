import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { isLoopbackWs } from '../src/loopback.js';

describe('loadConfig', () => {
  const base = { AGENT_MNEMONIC: 'test test test test test test test test test test test junk' };

  it('applies defaults', () => {
    const c = loadConfig({ ...base });
    expect(c.ws).toBe('ws://127.0.0.1:9944');
    expect(c.mode).toBe('provider');
    expect(c.heartbeatEveryBlocks).toBe(600n);
    expect(c.stake).toBe(1000n * 1_000_000_000_000n);
    expect(c.name).toBe('operator-reference-agent');
  });

  it('parses BUYER_PEERS as a trimmed list, empty by default', () => {
    expect(loadConfig({ ...base }).buyerPeers).toEqual([]);
    expect(loadConfig({ ...base, BUYER_PEERS: ' 5A , 5B,,' }).buyerPeers).toEqual(['5A', '5B']);
  });

  it('refuses to start without a key', () => {
    expect(() => loadConfig({})).toThrow(/AGENT_MNEMONIC/);
  });

  it('accepts AGENT_URI for dev keys instead of a mnemonic', () => {
    expect(loadConfig({ AGENT_URI: '//Alice//ref' }).secret).toBe('//Alice//ref');
  });

  it('rejects an unknown mode', () => {
    expect(() => loadConfig({ ...base, AGENT_MODE: 'chaos' })).toThrow(/AGENT_MODE/);
  });

  it('parses fractional CMN amounts into plancks without float error', () => {
    const c = loadConfig({ ...base, STAKE_CMN: '1000.5', BUYER_AMOUNT_CMN: '0.1' });
    expect(c.stake).toBe(1_000_500_000_000_000n);
    expect(c.buyerAmount).toBe(100_000_000_000n);
  });

  it('rejects garbage numbers rather than defaulting silently', () => {
    expect(() => loadConfig({ ...base, STAKE_CMN: 'lots' })).toThrow(/STAKE_CMN/);
    expect(() => loadConfig({ ...base, HEARTBEAT_BLOCKS: '-5' })).toThrow(/HEARTBEAT_BLOCKS/);
  });

  it('never includes the secret in its printable summary', () => {
    const c = loadConfig({ ...base });
    expect(JSON.stringify(c.redacted())).not.toContain('junk');
  });
});

describe('buyer fails closed', () => {
  const base = { AGENT_URI: '//Alice//ref' };

  it('refuses buyer and both modes without BUYER_PEERS', () => {
    expect(() => loadConfig({ ...base, AGENT_MODE: 'buyer' })).toThrow(/BUYER_PEERS/);
    expect(() => loadConfig({ ...base, AGENT_MODE: 'both', BUYER_PEERS: ' , ' })).toThrow(/BUYER_PEERS/);
  });

  it('starts a buyer with an explicit allowlist, and a provider without one', () => {
    expect(loadConfig({ ...base, AGENT_MODE: 'buyer', BUYER_PEERS: '5A' }).buyerPeers).toEqual(['5A']);
    expect(loadConfig({ ...base }).mode).toBe('provider');
  });
});

describe('isLoopbackWs', () => {
  it('accepts exact loopback hosts', () => {
    for (const u of ['ws://127.0.0.1:9955', 'ws://localhost:9944', 'wss://localhost', 'ws://[::1]:9944']) {
      expect(isLoopbackWs(u), u).toBe(true);
    }
  });

  it('rejects look-alike and remote hosts', () => {
    for (const u of [
      'ws://localhost.attacker.example',
      'ws://127.0.0.1.evil.com:9944',
      'ws://evil.com/127.0.0.1',
      'ws://127.0.0.1@evil.com',
      'wss://rpc.scalarnet.io',
      'http://127.0.0.1:9944',
      'not a url',
      '',
    ]) {
      expect(isLoopbackWs(u), u).toBe(false);
    }
  });
});
