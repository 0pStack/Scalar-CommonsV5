// Oracle lifecycles against a live node. Assertions are on events and storage.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { blake2AsU8a } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import type { ApiPromise } from '@polkadot/api';
import type { KeyringPair } from '@polkadot/keyring/types';
import { devAccounts, send, hasEvent, waitBlocks, WS } from './helpers.js';
import { connectLiveSuite, E2E_ALLOW_SKIP, skipOrFail, waitForBlock } from '../../support/chain.js';

const liveApi = await connectLiveSuite('oracle lifecycle', WS);
const liveTest = liveApi ? test : test.skip;
let api = liveApi as ApiPromise;
let authoring = false;
const derived = await devAccounts(['Alice', 'Bob', 'Charlie', 'TestkitJuror']);
const acc: Record<string, KeyringPair> = { ...derived, Juror: derived.TestkitJuror! };
const qid = (tag: string) => u8aToHex(blake2AsU8a(`e2e:${tag}:${Date.now()}`));
const ans = (value: string) => u8aToHex(blake2AsU8a(value));

beforeAll(async () => {
  if (!liveApi) return;
  api = liveApi;
  const head = (await api.rpc.chain.getHeader()).number.toNumber();
  try {
    await waitForBlock(api, head + 2, 20_000);
    authoring = true;
  } catch (error) {
    if (!E2E_ALLOW_SKIP) {
      throw new Error(`node at ${WS} is connected but not authoring blocks`, { cause: error });
    }
    return;
  }

  const jurorBalance = (await api.query.system.account(acc.Juror.address)) as any;
  if (jurorBalance.data.free.toBigInt() === 0n) {
    const minimum = (api.consts.agents.minStake as any).toBigInt();
    await send(api, api.tx.balances.transferKeepAlive(acc.Juror.address, minimum * 3n), acc.Alice);
  }
  for (const name of ['Alice', 'Bob', 'Charlie', 'Juror']) {
    const stake = (await api.query.agents.agentStake(acc[name]!.address)) as any;
    if (stake.isNone || stake.toString() === '0') {
      const minimum = (api.consts.agents.minStake as any).toBigInt();
      await send(api, api.tx.agents.register(minimum), acc[name]!);
    }
  }
}, 120_000);

afterAll(async () => {
  await liveApi?.disconnect();
});

liveTest(
  'E8: expireRequest returns the bounty and clears the request',
  async (ctx) => {
    if (!authoring) skipOrFail(ctx, 'node is not authoring blocks');
    const id = qid('e8');
    const bounty = (api.consts.oracle.minOracleBounty as any).toBigInt();
    const challengeWindow = (api.consts.oracle.minChallengeWindow as any).toNumber();
    const head = (await api.rpc.chain.getHeader()).number.toNumber();
    await send(
      api,
      api.tx.oracle.createOracleRequest(
        id,
        bounty,
        'Factual',
        3,
        67,
        head + 2,
        challengeWindow,
        null,
      ),
      acc.Juror,
    );
    await waitBlocks(api, 3, acc.Juror);
    const events = await send(api, api.tx.oracle.expireRequest(id), acc.Bob);
    expect(hasEvent(events, 'oracle', 'OracleRequestExpired')).toBe(true);
    expect(((await api.query.oracle.oracleRequests(id)) as any).isNone).toBe(true);
  },
  120_000,
);

liveTest(
  'E25: over-cap batch is rejected and the chain stays live',
  async (ctx) => {
    if (!authoring) skipOrFail(ctx, 'node is not authoring blocks');
    const cap = (api.consts.oracle.maxBatchSubmissions as any).toNumber();
    const submissions = Array.from({ length: cap + 1 }, (_, index) => [
      ans(`q${index}`),
      ans('a'),
      0,
    ]);
    const before = (await api.rpc.chain.getHeader()).number.toNumber();
    await expect(
      send(api, api.tx.oracle.batchSubmitResponse(submissions), acc.Bob),
    ).rejects.toThrow(
      /1002|Invalid Transaction|Could not decode|Unable to decode|validate_transaction|Bad input|Bad Proof|wasm trap|Cannot decode/i,
    );
    await waitBlocks(api, 1, acc.Juror);
    expect((await api.rpc.chain.getHeader()).number.toNumber()).toBeGreaterThan(before);
  },
  120_000,
);
