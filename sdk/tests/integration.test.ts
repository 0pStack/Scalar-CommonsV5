import { describe, it, expect, vi } from 'vitest';

import { ScalarCommonsClient, ACC_SCALE } from '../src/index.js';
import type { Logger } from '../src/logger.js';

/**
 * These tests exercise the SDK against a mock polkadot-js `ApiPromise` by
 * default so they run green in CI without a node. When `RUN_INTEGRATION=1` and
 * `WS_ENDPOINT` are set (e.g. a `--dev` node in CI), the final block also runs
 * the read path against the real chain.
 */

// ─── Mock ApiPromise ─────────────────────────────────────────────────────────

interface TxCall {
  section: string;
  method: string;
  args: unknown[];
}

/** Codec-ish leaf. */
const leaf = (v: unknown) => ({ toString: () => String(v) });
/** Option::Some codec-ish. */
const some = (v: unknown) => ({ isSome: true, unwrap: () => leaf(v) });
/** Option::None codec-ish. */
const none = () => ({ isSome: false, unwrap: () => leaf('') });

function makeMockApi() {
  const calls: TxCall[] = [];

  // A submittable extrinsic whose signAndSend succeeds on the first attempt.
  const makeTx = (section: string, method: string) => (...args: unknown[]) => {
    calls.push({ section, method, args });
    return {
      signAndSend: (_signer: unknown, cb: (r: unknown) => void) => {
        cb({
          status: {
            isInBlock: true,
            asInBlock: { toHex: () => '0xblockhash' },
            isInvalid: false,
            isDropped: false,
            isUsurped: false,
            type: 'InBlock',
          },
          dispatchError: undefined,
          txHash: { toHex: () => '0xtxhash' },
        });
        return Promise.resolve(() => {});
      },
    };
  };

  const acc = 3n * ACC_SCALE;
  const debt = 1n * ACC_SCALE;

  const api = {
    tx: {
      agents: {
        register: makeTx('agents', 'register'),
        addStake: makeTx('agents', 'addStake'),
        heartbeat: makeTx('agents', 'heartbeat'),
        recordGovVote: makeTx('agents', 'recordGovVote'),
      },
      escrow: {
        createAgreement: makeTx('escrow', 'createAgreement'),
        recordDelivery: makeTx('escrow', 'recordDelivery'),
        confirmDelivery: makeTx('escrow', 'confirmDelivery'),
      },
      oracle: { submitResponse: makeTx('oracle', 'submitResponse') },
      convictionVoting: { vote: makeTx('convictionVoting', 'vote') },
      emissions: {
        settleEra: makeTx('emissions', 'settleEra'),
        claim: makeTx('emissions', 'claim'),
      },
    },
    query: {
      agents: {
        eraNumber: async () => leaf(7),
        agentStake: async () => some(500),
        eraEscrowVolume: async () => leaf(200),
      },
      emissions: {
        eraStartBlock: async () => leaf(100),
        lastSettledEra: async () => some(6),
        lastEraEmission: async () => leaf(5000),
        accRewardPerStake: async () => leaf(acc.toString()),
        agentRewardDebt: async () => leaf(debt.toString()),
        agentWeightSnapshot: async () => leaf(2),
      },
      system: {
        number: async () => leaf(250),
        // Real `PalletBalancesAccountData`: the agent stake lock lives *inside*
        // `free` and is reported as `frozen` — it is not a separate pot.
        account: async () => ({
          data: { free: leaf(1000), reserved: leaf(0), frozen: leaf(500) },
        }),
      },
      balances: {
        totalIssuance: async () => leaf(9_000),
      },
    },
    consts: { emissions: { eraDuration: leaf(100) } },
    registry: {
      findMetaError: () => ({ section: 'agents', name: 'NotRegistered', docs: ['not registered'] }),
    },
  };

  return { api: api as never, calls };
}

const SIGNER = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY' as never;
const PROVIDER = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const HASH = '0x' + '11'.repeat(32);

// ─── Write-path mapping ─────────────────────────────────────────────────────

describe('ScalarCommonsClient — write method → extrinsic mapping', () => {
  it('maps every write method to the correct extrinsic + args', async () => {
    const { api, calls } = makeMockApi();
    const client = new ScalarCommonsClient(api, { retryDelayMs: 0 });

    const r1 = await client.register(SIGNER, 1_000n);
    expect(r1).toEqual({ txHash: '0xtxhash', blockHash: '0xblockhash', attempts: 1 });

    await client.stake(SIGNER, 250n);
    await client.heartbeat(SIGNER);
    await client.createEscrow(SIGNER, PROVIDER, 500n, HASH, 1_000n, 3);
    await client.acceptEscrow(SIGNER, PROVIDER, 0, HASH);
    await client.completeEscrow(SIGNER, PROVIDER, 0);
    await client.submitOracle(SIGNER, HASH, HASH, 3);
    await client.vote(SIGNER, 1, { Standard: { vote: { aye: true, conviction: 'Locked1x' }, balance: 100n } });
    await client.recordGovVote(SIGNER, 9);
    await client.settleEra(SIGNER);
    await client.claim(SIGNER);

    expect(calls.map((c) => `${c.section}.${c.method}`)).toEqual([
      'agents.register',
      'agents.addStake',
      'agents.heartbeat',
      'escrow.createAgreement',
      'escrow.recordDelivery',
      'escrow.confirmDelivery',
      'oracle.submitResponse',
      'convictionVoting.vote',
      'agents.recordGovVote',
      'emissions.settleEra',
      'emissions.claim',
    ]);

    // Spot-check argument forwarding.
    expect(calls[0]?.args).toEqual([1_000n]);
    expect(calls[3]?.args).toEqual([PROVIDER, 500n, HASH, 1_000n, 3]);
    expect(calls[4]?.args).toEqual([PROVIDER, 0, HASH]);
    // record_gov_vote is self-only on chain (signer must equal agent), so the SDK
    // derives the agent argument from the signer rather than trusting a caller-
    // supplied address that the runtime would only reject as `Unauthorized`.
    expect(calls[8]?.args).toEqual([SIGNER, 9]);
  });
});

// ─── Read-path decoding ─────────────────────────────────────────────────────

describe('ScalarCommonsClient — read methods', () => {
  it('eraInfo decodes timing and settlement', async () => {
    const { api } = makeMockApi();
    const client = new ScalarCommonsClient(api);
    const info = await client.eraInfo();
    expect(info.era).toBe(7);
    expect(info.eraDuration).toBe(100n);
    expect(info.eraStartBlock).toBe(100n);
    expect(info.lastSettledEra).toBe(6);
    expect(info.lastEraEmission).toBe(5000n);
    // head=250 >= start(100)+duration(100)=200 → settleable
    expect(info.settleable).toBe(true);
  });

  it('weightOf returns the snapshot as bigint', async () => {
    const { api } = makeMockApi();
    const client = new ScalarCommonsClient(api);
    expect(await client.weightOf(PROVIDER)).toBe(2n);
  });

  it('netPosition mirrors do_claim pending math', async () => {
    const { api } = makeMockApi();
    const client = new ScalarCommonsClient(api);
    const pos = await client.netPosition(PROVIDER);
    expect(pos.free).toBe(1000n);
    expect(pos.reserved).toBe(0n);
    expect(pos.frozen).toBe(500n);
    expect(pos.stake).toBe(500n);
    expect(pos.eraEscrowVolume).toBe(200n);
    // pending = (acc - debt) * weight / ACC_SCALE = (3-1)*ACC_SCALE * 2 / ACC_SCALE = 4
    expect(pos.pendingEmissions).toBe(4n);
    // The stake lock is already part of `free`; adding it again would invent 500
    // plancks that no account ever held.
    expect(pos.total).toBe(1000n + 4n);
  });

  it('totalIssuance reads balances.totalIssuance', async () => {
    const { api } = makeMockApi();
    const client = new ScalarCommonsClient(api);
    expect(await client.totalIssuance()).toBe(9_000n);
  });

  it('eraInfo maps a None lastSettledEra to null, not zero', async () => {
    const { api } = makeMockApi();
    (api as unknown as { query: { emissions: { lastSettledEra: unknown } } }).query.emissions
      .lastSettledEra = async () => none();
    const client = new ScalarCommonsClient(api);
    expect((await client.eraInfo()).lastSettledEra).toBeNull();
  });

  it('eraInfo maps a Some(0) lastSettledEra to 0, not null', async () => {
    // The other half of the `Option<u32>` contract, and the half that makes the
    // `None` case above mean something: "era 0 has settled" and "nothing has ever
    // settled" are different states of the chain, and the F-04 double-settlement
    // guard branches on the difference. A decoder that answered `null` to both
    // would pass the `None` test and still be wrong.
    const { api } = makeMockApi();
    (api as unknown as { query: { emissions: { lastSettledEra: unknown } } }).query.emissions
      .lastSettledEra = async () => some(0);
    const client = new ScalarCommonsClient(api);
    expect((await client.eraInfo()).lastSettledEra).toBe(0);
  });

  it('fails loudly when the runtime does not expose a queried storage item', async () => {
    const { api } = makeMockApi();
    delete (api as unknown as { query: { emissions: Record<string, unknown> } }).query.emissions
      .lastSettledEra;
    const client = new ScalarCommonsClient(api);
    await expect(client.eraInfo()).rejects.toThrow(
      'runtime does not expose storage item emissions.lastSettledEra',
    );
  });
});

// ─── No-silent-retry submit path ────────────────────────────────────────────

describe('ScalarCommonsClient — submit retries are logged, never silent', () => {
  it('logs the retry then succeeds on the second attempt', async () => {
    const logged: string[] = [];
    const logger: Logger = {
      info: (m) => logged.push(`info:${m}`),
      warn: (m) => logged.push(`warn:${m}`),
      error: (m) => logged.push(`error:${m}`),
    };

    const { api } = makeMockApi();
    // Override register with a tx that fails once (module error) then succeeds.
    let attempt = 0;
    (api as unknown as { tx: { agents: { register: unknown } } }).tx.agents.register = () => ({
      signAndSend: (_s: unknown, cb: (r: unknown) => void) => {
        attempt += 1;
        if (attempt === 1) {
          cb({
            status: { isInBlock: false, isInvalid: false, isDropped: false, isUsurped: false, type: 'Ready' },
            dispatchError: { isModule: true, asModule: {} },
            txHash: { toHex: () => '0xtx' },
          });
        } else {
          cb({
            status: {
              isInBlock: true,
              asInBlock: { toHex: () => '0xblock2' },
              isInvalid: false,
              isDropped: false,
              isUsurped: false,
              type: 'InBlock',
            },
            dispatchError: undefined,
            txHash: { toHex: () => '0xtx2' },
          });
        }
        return Promise.resolve(() => {});
      },
    });

    const client = new ScalarCommonsClient(api, { logger, retryDelayMs: 0 });
    const res = await client.register(SIGNER, 10n);
    expect(res.attempts).toBe(2);
    expect(res.blockHash).toBe('0xblock2');
    // The retry was surfaced (not silent).
    expect(logged.some((l) => l.startsWith('warn:') && l.includes('attempt 1/4'))).toBe(true);
  });
});

// ─── Optional: real dev node ────────────────────────────────────────────────

const runReal = process.env.RUN_INTEGRATION === '1';
const endpoint = process.env.SCALAR_WS ?? process.env.WS_ENDPOINT ?? 'ws://127.0.0.1:9944';

describe.skipIf(!runReal)('ScalarCommonsClient — real dev node', () => {
  it('connects and reads era info from a live node', async () => {
    const client = await ScalarCommonsClient.connect(endpoint);
    try {
      const info = await client.eraInfo();
      expect(typeof info.era).toBe('number');
      expect(info.eraDuration).toBeGreaterThan(0n);
    } finally {
      await client.disconnect();
    }
  });
});
