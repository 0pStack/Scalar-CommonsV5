import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import type { KeyringPair } from '@polkadot/keyring/types';

import { ScalarCommonsClient, submitAndWatch } from '../src/index.js';

/**
 * Live-node conformance: every shape asserted here is read from the running
 * devnet's **real runtime metadata**, never hand-written.
 *
 * The SDK's read helpers decode against the real chain (an `Option<u32>` that is
 * `None`, a balance lock that lives *inside* `free`), and this suite is what
 * proves it rather than trusting a hand-rolled mock.
 *
 * Opt-in, like the live block in `integration.test.ts`: `npm test` stays the
 * mock-driven, node-free suite it has always been, and this file runs under
 * `RUN_INTEGRATION=1` (`npm run test:integration`). When it *is* enabled it
 * still fails rather than skips on an unreachable node — "cannot reach the
 * chain" is a finding, not a pass — it simply no longer forces a devnet on
 * every `npm test`.
 */
const RUN_LIVE = process.env.RUN_INTEGRATION === '1';
const ENDPOINT = process.env.SCALAR_WS ?? process.env.WS_ENDPOINT ?? 'ws://127.0.0.1:9944';

/** First spec version carrying the ROUND14 `record_gov_vote(agent, poll_index)` signature. */
const MIN_SPEC_VERSION = 304;

let api: ApiPromise;
let client: ScalarCommonsClient;
let alice: KeyringPair;
/** An account the chain actually reports as a registered agent. */
let agentAddress: string;

beforeAll(async () => {
  if (!RUN_LIVE) return;
  await cryptoWaitReady();
  // `throwOnConnect` turns an unreachable node into an immediate rejection
  // instead of an invisible reconnect loop — no silent retries, ever.
  api = await ApiPromise.create({ provider: new WsProvider(ENDPOINT), throwOnConnect: true });
  // Runtime rejections here are information, not transient faults: never retry them.
  client = new ScalarCommonsClient(api, { maxRetries: 0 });
  alice = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');

  const staked = await api.query.agents!.agentStake!.entries();
  const first = staked.find(([, value]) => !(value as unknown as { isNone: boolean }).isNone);
  expect(first, 'devnet has at least one registered agent').toBeDefined();
  agentAddress = first![0].args[0]!.toString();
});

afterAll(async () => {
  if (api) await api.disconnect();
});

describe.skipIf(!RUN_LIVE)('live devnet — runtime metadata matches the SDK surface', () => {
  it('is running the spec the SDK targets', () => {
    expect(api.runtimeVersion.specName.toString()).toBe('scalar-commons');
    expect(api.runtimeVersion.specVersion.toNumber()).toBeGreaterThanOrEqual(MIN_SPEC_VERSION);
  });

  it('agents.recordGovVote takes (agent, pollIndex) — the ROUND14 signature', () => {
    const meta = api.tx.agents!.recordGovVote!.meta;
    expect(meta.args.map((a) => a.name.toString())).toEqual(['agent', 'pollIndex']);
    expect(meta.args.map((a) => a.type.toString())).toEqual(['AccountId32', 'u32']);
  });

  it('emissions.lastSettledEra is an Option<u32> the SDK must not blindly unwrap', async () => {
    const raw = await api.query.emissions!.lastSettledEra!();
    expect(raw.toRawType()).toBe('Option<u32>');
  });

  it('balances.totalIssuance is a plain u128', async () => {
    const raw = await api.query.balances!.totalIssuance!();
    expect(raw.toRawType()).toBe('u128');
  });
});

describe.skipIf(!RUN_LIVE)('live devnet — read methods decode real storage', () => {
  it('eraInfo decodes lastSettledEra whether it is Some or None', async () => {
    // Read the head first: block numbers only ever grow, so a head sampled before
    // the call can never claim "due" for an era the call itself saw as not-yet-due.
    const headBefore = await currentBlock();
    const info = await client.eraInfo();
    const raw = await api.query.emissions!.lastSettledEra!();
    const isSome = (raw as unknown as { isSome: boolean }).isSome;

    expect(Number.isInteger(info.era)).toBe(true);
    expect(info.eraDuration).toBeGreaterThan(0n);
    if (isSome) {
      expect(info.lastSettledEra).toBe(Number(raw.toString()));
    } else {
      // The bug this pins: a `None` era must decode to `null`, not `0` and not a throw.
      expect(info.lastSettledEra).toBeNull();
    }
    if (headBefore >= info.eraStartBlock + info.eraDuration) {
      expect(info.settleable).toBe(true);
    }
  });

  it('totalIssuance reads balances.totalIssuance and respects the supply cap', async () => {
    const issuance = await client.totalIssuance();
    const raw = await api.query.balances!.totalIssuance!();
    expect(issuance).toBe(BigInt(raw.toString()));
    expect(issuance).toBeGreaterThan(0n);
    expect(issuance).toBeLessThanOrEqual(BigInt(api.consts.emissions!.supplyCap!.toString()));
  });

  it('netPosition does not double-count the agent stake lock', async () => {
    const pos = await client.netPosition(agentAddress);
    const account = await api.query.system!.account!(agentAddress);
    const data = (account as unknown as {
      data: { free: { toString(): string }; reserved: { toString(): string }; frozen: { toString(): string } };
    }).data;

    expect(pos.free).toBe(BigInt(data.free.toString()));
    expect(pos.reserved).toBe(BigInt(data.reserved.toString()));
    expect(pos.frozen).toBe(BigInt(data.frozen.toString()));

    // pallet-agents locks stake with `Currency::set_lock`, so the stake is *inside*
    // `free` and shows up as `frozen`. Adding it to `free` would invent tokens.
    expect(pos.stake).toBeGreaterThan(0n);
    expect(pos.free).toBeGreaterThanOrEqual(pos.stake);
    expect(pos.frozen).toBeGreaterThanOrEqual(pos.stake);
    expect(pos.total).toBe(pos.free + pos.pendingEmissions);

    // The invariant the double-count broke: no account can hold more than exists.
    expect(pos.total).toBeLessThanOrEqual(await client.totalIssuance());
  });
});

describe.skipIf(!RUN_LIVE)('live devnet — recordGovVote encodes against real metadata', () => {
  it('is rejected by the runtime guard, not by an encoding mismatch', async () => {
    // A poll Alice provably holds no live vote on. Reaching `NotActivelyVoting`
    // proves the call encoded with the right arity and types: a stale one-argument
    // signature would fail to encode long before the runtime saw it.
    await expect(client.recordGovVote(alice, 4_294_967_295)).rejects.toThrow(
      /^agents\.(NotActivelyVoting|PollAlreadyCredited|GovVoteCapReached)/,
    );
  });

  it('rejects an agent argument that is not the signer with Unauthorized', async () => {
    // The reason `recordGovVote` derives `agent` from `signer` instead of taking it
    // from the caller. `ensure!(signer == agent, Unauthorized)` is the *first* guard
    // in `record_gov_vote`, ahead of `NotRegistered`, so a mismatched pair reaches it
    // whatever the accounts' registration state. Submitted raw rather than through
    // the client because the client cannot express the mismatch — which is the point.
    const bob = new Keyring({ type: 'sr25519' }).addFromUri('//Bob');
    const mismatched = api.tx.agents!.recordGovVote!(bob.address, 4_294_967_295);
    await expect(
      submitAndWatch(api, mismatched, alice, 'recordGovVote(agent!=signer)', { maxRetries: 0 }),
    ).rejects.toThrow(/^agents\.Unauthorized/);
  });
});

async function currentBlock(): Promise<bigint> {
  const now = await api.query.system!.number!();
  return BigInt(now.toString());
}
