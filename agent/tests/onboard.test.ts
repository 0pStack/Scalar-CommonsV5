import { describe, expect, it } from 'vitest';
import {
  FEE_HEADROOM,
  formatCmn,
  isTestnet,
  latestTx,
  planStart,
  registrationNeed,
} from '../src/onboard-core.js';

const CMN = 10n ** 12n;
// Live on spec 306: agents.minStake 1 000 CMN, agents.baseRegistrationFee 50 CMN,
// balances.existentialDeposit 0.01 CMN.
const costs = { stake: 1_000n * CMN, registrationFee: 50n * CMN, existentialDeposit: CMN / 100n };
const ME = '5G4HCTEup52wR6JpgNrdnCJCbvm9sDqWR1nUtqMUAVC2VYeT';
const need = registrationNeed(costs);
const base = { address: ME, approvedAddress: ME, chain: 'Scalar Commons Local Testnet', need };

describe('formatCmn', () => {
  it('prints exact decimals, never a float', () => {
    expect(formatCmn(1_100n * CMN)).toBe('1100');
    expect(formatCmn(108_157_107n)).toBe('0.000108157107');
    expect(formatCmn(0n)).toBe('0');
  });
});

describe('registrationNeed', () => {
  it('is stake + registration fee + existential deposit + fee headroom', () => {
    expect(registrationNeed(costs)).toBe(1_050_010_000_000_000n + FEE_HEADROOM);
  });
  it('fits inside one faucet drip (1 100 CMN), or the automatic flow could never register', () => {
    expect(registrationNeed(costs) <= 1_100n * CMN).toBe(true);
  });
});

describe('isTestnet', () => {
  it('accepts the public testnet by its chain name', () => {
    expect(isTestnet('Scalar Commons Local Testnet')).toBe(true);
  });
  it('refuses anything that does not call itself a testnet', () => {
    expect(isTestnet('Scalar Commons')).toBe(false);
    expect(isTestnet('Polkadot')).toBe(false);
  });
});

describe('planStart', () => {
  it('refuses a chain that is not a testnet, even when approved', () => {
    expect(planStart({ ...base, chain: 'Scalar Commons', registered: true, free: 0n }).action).toBe('refuse');
  });

  it('refuses when no address was approved — the agent never spends without that one explicit step', () => {
    const p = planStart({ ...base, approvedAddress: '', registered: false, free: 1_100n * CMN });
    expect(p.action).toBe('refuse');
    expect(p.message).toMatch(/APPROVED_AGENT_ADDRESS/);
  });

  it('refuses a key whose address is not the approved one: never silently use an unknown wallet', () => {
    const p = planStart({ ...base, approvedAddress: '5CFbRsiZQqc6YUyqEstGF1P4KuQV84A6CTvudLq7Fp3PhBxy', registered: true, free: 0n });
    expect(p.action).toBe('refuse');
    expect(p.message).toMatch(/does not match/);
  });

  it('an approved, registered agent just runs', () => {
    expect(planStart({ ...base, registered: true, free: 5n * CMN }).action).toBe('run');
  });

  it('an approved, funded, unregistered agent runs and the agent registers itself', () => {
    expect(planStart({ ...base, registered: false, free: need }).action).toBe('run-and-register');
  });

  it('an approved, unfunded, unregistered agent asks the faucet first — never registers underfunded', () => {
    expect(planStart({ ...base, registered: false, free: need - 1n }).action).toBe('faucet');
  });
});

describe('latestTx', () => {
  it('returns the newest agent event carrying a transaction hash', () => {
    const log = [
      '{"ts":"t1","event":"start","address":"5X"}',
      '{"ts":"t2","event":"register","tx":"0xaa"}',
      '{"ts":"t3","event":"heartbeat","block":"9","tx":"0xbb"}',
      '{"ts":"t4","event":"error","step":"claim","message":"x"}',
      'not json',
    ].join('\n');
    expect(latestTx(log)).toEqual({ event: 'heartbeat', tx: '0xbb', ts: 't3' });
  });

  it('can ignore events before a given time, so start waits for THIS run', () => {
    const log = '{"ts":"2026-01-01T00:00:00.000Z","event":"heartbeat","tx":"0xaa"}';
    expect(latestTx(log, '2026-06-01T00:00:00.000Z')).toBeNull();
    expect(latestTx(log)).toEqual({ event: 'heartbeat', tx: '0xaa', ts: '2026-01-01T00:00:00.000Z' });
  });
});
