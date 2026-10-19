// Agents pallet lifecycle, asserted on emitted events and read-back storage (never on the
// submission result alone). Runs against any node: SCALAR_WS=ws://host:port npm test.
// Skips (and says so) when no node answers, so a missing node is visible, not a false pass.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiPromise } from '@polkadot/api';
import type { KeyringPair } from '@polkadot/keyring/types';
import { SCALAR_WS, connect, eventsOf, freshAccount, fund, nodeIsUp, send } from './helpers';

const up = await nodeIsUp();
if (!up) console.warn(`[testkit] no node at ${SCALAR_WS}: agents lifecycle suite SKIPPED`);

describe.skipIf(!up)(`agents lifecycle @ ${SCALAR_WS}`, () => {
  let api: ApiPromise;
  let minStake: bigint;
  let agent: KeyringPair;
  let outsider: KeyringPair;
  let delegate: KeyringPair;

  beforeAll(async () => {
    api = await connect();
    minStake = (api.consts.agents.minStake as unknown as { toBigInt(): bigint }).toBigInt();
    agent = freshAccount('agent');
    outsider = freshAccount('outsider');
    delegate = freshAccount('delegate');
    // Stake + registration fee + headroom for tx fees.
    await fund(api, agent, minStake * 3n + 1_000_000_000_000n);
    await fund(api, outsider, 10_000_000_000_000n);
  });

  afterAll(async () => {
    await api?.disconnect();
  });

  const stakeOf = async (who: KeyringPair) => (await api.query.agents.agentStake(who.address)).toJSON();

  it('rejects heartbeat / delegation / unstake from an unregistered account and writes nothing', async () => {
    for (const tx of [
      api.tx.agents.heartbeat(),
      api.tx.agents.delegateVoting(delegate.address, 1_000_000),
      api.tx.agents.requestUnstake(),
    ]) {
      const o = await send(api, tx, outsider);
      expect(o.ok).toBe(false);
      expect(o.error).toBe('agents.NotRegistered');
      expect(eventsOf(o, 'agents')).toHaveLength(0);
    }
    expect(await stakeOf(outsider)).toBeNull();
    expect((await api.query.agents.lastHeartbeat(outsider.address)).toJSON()).toBe(0);
  });

  it('rejects registration below MinStake without locking or burning anything', async () => {
    const before = (await api.query.system.account(agent.address)).toJSON() as { data: { free: string | number } };
    const o = await send(api, api.tx.agents.register(minStake - 1n), agent);
    expect(o.ok).toBe(false);
    expect(o.error).toBe('agents.StakeTooLow');
    expect(eventsOf(o, 'agents')).toHaveLength(0);
    expect(await stakeOf(agent)).toBeNull();
    const after = (await api.query.system.account(agent.address)).toJSON() as { data: { free: string | number } };
    // The failed extrinsic still pays its transaction fee, but no stake lock was taken.
    expect(BigInt(after.data.free)).toBeLessThanOrEqual(BigInt(before.data.free));
    expect(await api.query.balances.locks(agent.address)).toHaveLength(0);
  });

  it('register -> event, stake, lock, heartbeat clock started at registration block', async () => {
    const o = await send(api, api.tx.agents.register(minStake), agent);
    expect(o.ok).toBe(true);
    const ev = eventsOf(o, 'agents').find((e) => e.method === 'AgentRegistered');
    expect(ev).toBeDefined();
    expect(ev!.data.who).toBe(agent.address);
    expect(BigInt(ev!.data.stake!.replaceAll(',', ''))).toBe(minStake);

    expect(BigInt(String(await stakeOf(agent)))).toBe(minStake);
    const header = await api.rpc.chain.getHeader(o.blockHash);
    const block = header.number.toNumber();
    expect((await api.query.agents.lastHeartbeat(agent.address)).toJSON()).toBe(block);
    expect((await api.query.agents.stakeRegisteredAt(agent.address)).toJSON()).toBe(block);
    const locks = (await api.query.balances.locks(agent.address)).toJSON() as { amount: string | number }[];
    expect(locks.some((l) => BigInt(l.amount) === minStake)).toBe(true);
  });

  it('E20: registering again while registered is rejected and leaves stake unchanged', async () => {
    const o = await send(api, api.tx.agents.register(minStake * 2n), agent);
    expect(o.ok).toBe(false);
    expect(o.error).toBe('agents.AlreadyRegistered');
    expect(eventsOf(o, 'agents')).toHaveLength(0);
    expect(BigInt(String(await stakeOf(agent)))).toBe(minStake);
  });

  it('heartbeat advances the clock and emits HeartbeatSent', async () => {
    const o = await send(api, api.tx.agents.heartbeat(), agent);
    expect(o.ok).toBe(true);
    expect(eventsOf(o, 'agents').map((e) => e.method)).toEqual(['HeartbeatSent']);
    const block = (await api.rpc.chain.getHeader(o.blockHash)).number.toNumber();
    expect((await api.query.agents.lastHeartbeat(agent.address)).toJSON()).toBe(block);
  });

  it('add_stake grows stake and lock; event carries the new total', async () => {
    const o = await send(api, api.tx.agents.addStake(minStake), agent);
    expect(o.ok).toBe(true);
    const ev = eventsOf(o, 'agents').find((e) => e.method === 'StakeAdded');
    expect(ev).toBeDefined();
    expect(BigInt(ev!.data.total!.replaceAll(',', ''))).toBe(minStake * 2n);
    expect(BigInt(String(await stakeOf(agent)))).toBe(minStake * 2n);
  });

  it('E33: delegate_voting stores the record + event; expiry bounds are enforced; revoke clears it', async () => {
    const head = (await api.rpc.chain.getHeader()).number.toNumber();
    const maxPeriod = (api.consts.agents.maxDelegationPeriod as unknown as { toNumber(): number }).toNumber();

    const past = await send(api, api.tx.agents.delegateVoting(delegate.address, 1), agent);
    expect(past.error).toBe('agents.DelegationExpired');
    const tooLong = await send(api, api.tx.agents.delegateVoting(delegate.address, head + maxPeriod + 1000), agent);
    expect(tooLong.error).toBe('agents.DelegationPeriodTooLong');
    expect((await api.query.agents.votingDelegations(agent.address)).toJSON()).toBeNull();

    const until = head + 1000;
    const ok = await send(api, api.tx.agents.delegateVoting(delegate.address, until), agent);
    expect(ok.ok).toBe(true);
    const ev = eventsOf(ok, 'agents').find((e) => e.method === 'VotingDelegated');
    expect(ev?.data.to).toBe(delegate.address);
    const rec = (await api.query.agents.votingDelegations(agent.address)).toJSON() as Record<string, unknown>;
    expect(rec.delegateTo).toBe(delegate.address);
    expect(rec.expiresAt).toBe(until);

    const revoke = await send(api, api.tx.agents.delegateVoting(delegate.address, 0), agent);
    expect(revoke.ok).toBe(true);
    expect(eventsOf(revoke, 'agents').map((e) => e.method)).toEqual(['VotingDelegationRemoved']);
    expect((await api.query.agents.votingDelegations(agent.address)).toJSON()).toBeNull();
  });

  it('E22: appealing a slash that never happened is rejected with no appeal stored', async (ctx) => {
    // The E22 guard ships in spec 307. A node still on 306 (prod's runtime) has no
    // `NoSuchSlash` error and accepts the appeal, so skip loudly rather than assert a fix that
    // node does not contain. Against a 307+ node this test is live.
    if (!api.errors.agents?.NoSuchSlash) {
      console.warn('[testkit] E22 SKIPPED: runtime has no agents.NoSuchSlash (pre-307)');
      ctx.skip();
    }
    const o = await send(api, api.tx.agents.slashAppeal(0, `0x${'11'.repeat(32)}`), agent);
    expect(o.ok).toBe(false);
    expect(o.error).toBe('agents.NoSuchSlash');
    expect(eventsOf(o, 'agents')).toHaveLength(0);
    expect((await api.query.agents.openAppealCount(agent.address)).toJSON()).toBe(0);
    expect((await api.query.agents.pendingSlashAppeals(agent.address)).toJSON()).toBeNull();
  });

  it('unstake cooldown: request records deadline = block + UnstakeCooldown; early completion is rejected; stake frozen', async () => {
    const cooldown = (api.consts.agents.unstakeCooldown as unknown as { toNumber(): number }).toNumber();
    const req = await send(api, api.tx.agents.requestUnstake(), agent);
    expect(req.ok).toBe(true);
    const block = (await api.rpc.chain.getHeader(req.blockHash)).number.toNumber();
    const ev = eventsOf(req, 'agents').find((e) => e.method === 'UnstakeRequested');
    expect(ev).toBeDefined();
    expect(Number(ev!.data.unstakeAt!.replaceAll(',', ''))).toBe(block + cooldown);
    expect((await api.query.agents.unstakeAt(agent.address)).toJSON()).toBe(block + cooldown);

    const early = await send(api, api.tx.agents.completeUnstake(), agent);
    expect(early.error).toBe('agents.UnstakeCooldownNotElapsed');
    expect(eventsOf(early, 'agents')).toHaveLength(0);

    const again = await send(api, api.tx.agents.requestUnstake(), agent);
    expect(again.error).toBe('agents.UnstakeAlreadyPending');
    const frozen = await send(api, api.tx.agents.addStake(minStake), agent);
    expect(frozen.error).toBe('agents.UnstakeAlreadyPending');
    const reg = await send(api, api.tx.agents.register(minStake), agent);
    expect(reg.error).toBe('agents.AlreadyRegistered');

    // Stake is untouched and still locked throughout the cooldown.
    expect(BigInt(String(await stakeOf(agent)))).toBe(minStake * 2n);
    expect((await api.query.agents.unstakeAt(agent.address)).toJSON()).toBe(block + cooldown);
  });
});
