import { describe, expect, it } from 'vitest';
import { Agent } from '../src/agent.js';
import type { AgentConfig, AgreementView, Chain } from '../src/types.js';

const ME = '5Me';
const BUYER = '5Buyer';
const CMN = 1_000_000_000_000n;

interface Fake extends Chain {
  calls: string[];
  set(patch: Partial<State>): void;
}
interface State {
  head: bigint;
  registered: boolean;
  lastHb: bigint | null;
  accept: boolean;
  pending: bigint;
  asProvider: AgreementView[];
  asBuyer: AgreementView[];
  agents: string[];
  failOn: string | null;
  messaging: boolean;
  onChainKey: string | null;
}

function fake(init: Partial<State> = {}): Fake {
  const s: State = {
    head: 1000n, registered: true, lastHb: 900n, accept: false, pending: 0n,
    asProvider: [], asBuyer: [], agents: [ME], failOn: null, messaging: false, onChainKey: null, ...init,
  };
  const calls: string[] = [];
  const rec = (name: string, ...args: unknown[]) => {
    if (s.failOn === name) return Promise.reject(new Error(`boom ${name}`));
    calls.push([name, ...args.map(String)].join(':'));
    return Promise.resolve('0xhash');
  };
  return {
    calls,
    set: (p) => Object.assign(s, p),
    head: async () => s.head,
    isRegistered: async () => s.registered,
    lastHeartbeat: async () => s.lastHb,
    supportsAccept: () => s.accept,
    freeBalance: async () => 5_000n * CMN,
    pendingEmissions: async () => s.pending,
    agreementsAsProvider: async () => s.asProvider,
    agreementsAsBuyer: async () => s.asBuyer,
    registeredAgents: async () => s.agents,
    register: (stake) => rec('register', stake),
    setMetadata: (name) => rec('metadata', name),
    heartbeat: () => rec('heartbeat'),
    acceptAgreement: (b, q) => rec('accept', b, q),
    recordDelivery: (b, q, h) => rec('deliver', b, q, h),
    createAgreement: (p, a, h, d) => rec('create', p, a, d),
    confirmDelivery: (p, q) => rec('confirm', p, q),
    claim: () => rec('claim'),
    supportsMessaging: () => s.messaging,
    messagingKeyOf: async () => s.onChainKey,
    setMessagingKey: (k) => rec('messaging-key', k),
  };
}

const cfg: AgentConfig = {
  address: ME, mode: 'provider', stake: 1000n * CMN, name: 'operator-reference-agent',
  heartbeatEveryBlocks: 600n, minDeliveryBlocks: 10n, buyerPeers: [], buyerAmount: 10n * CMN, buyerMaxOpen: 2, buyerDeliverWithin: 200n,
};

const agreement = (over: Partial<AgreementView> = {}): AgreementView => ({
  buyer: BUYER, provider: ME, seq: 0, amount: 10n * CMN, deliverableHash: '0x' + '11'.repeat(32),
  deliverBy: 5000n, createdAt: 990n, status: 'Created', ...over,
});

function make(chain: Fake, over: Partial<AgentConfig> = {}) {
  const events: { event: string; [k: string]: unknown }[] = [];
  const agent = new Agent(chain, { ...cfg, ...over }, (event, f) => events.push({ event, ...f }));
  return { agent, events };
}

describe('registration and heartbeat', () => {
  it('registers an unregistered agent, then heartbeats immediately', async () => {
    const c = fake({ registered: false, lastHb: null });
    const { agent } = make(c);
    await agent.tick();
    expect(c.calls).toEqual([`register:${1000n * CMN}`, 'metadata:operator-reference-agent', 'heartbeat']);
  });

  it('heartbeats right after registering even when the runtime already stamped the register block', async () => {
    // Spec 306 starts the heartbeat clock at register (#161): lastHeartbeat is recent, not null.
    const c = fake({ registered: false, lastHb: 999n, head: 1000n });
    await make(c).agent.tick();
    expect(c.calls).toEqual([`register:${1000n * CMN}`, 'metadata:operator-reference-agent', 'heartbeat']);
  });

  it('does not re-register a registered agent', async () => {
    const c = fake({ lastHb: 900n });
    await make(c).agent.tick();
    expect(c.calls.some((x) => x.startsWith('register'))).toBe(false);
  });

  it('heartbeats once the interval has elapsed, and not before', async () => {
    const c = fake({ head: 1499n, lastHb: 900n });
    const { agent } = make(c);
    await agent.tick();
    expect(c.calls).not.toContain('heartbeat');
    c.set({ head: 1500n });
    await agent.tick();
    expect(c.calls).toContain('heartbeat');
  });

  it('heartbeats when the agent has never beaten', async () => {
    const c = fake({ lastHb: null });
    await make(c).agent.tick();
    expect(c.calls).toContain('heartbeat');
  });
});

describe('metadata after register', () => {
  it('a rejected metadata update still reports the register, heartbeats, and is retried next tick', async () => {
    const c = fake({ registered: false, lastHb: null, failOn: 'metadata' });
    const { agent, events } = make(c);
    await agent.tick();
    expect(events.some((e) => e.event === 'register')).toBe(true);
    expect(c.calls).toContain('heartbeat');
    expect(events.some((e) => e.event === 'error' && e.step === 'metadata')).toBe(true);
    expect(events.some((e) => e.event === 'metadata')).toBe(false);

    c.set({ registered: true, failOn: null });
    await agent.tick();
    expect(events.some((e) => e.event === 'metadata')).toBe(true);
    expect(c.calls.filter((x) => x.startsWith('metadata'))).toHaveLength(1);
    await agent.tick();
    expect(c.calls.filter((x) => x.startsWith('metadata'))).toHaveLength(1);
  });
});

describe('provider flow', () => {
  it('delivers a Created agreement once, with a hash derived from the deliverable', async () => {
    const c = fake({ asProvider: [agreement()] });
    const { agent } = make(c);
    await agent.tick();
    const d = c.calls.filter((x) => x.startsWith('deliver'));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatch(new RegExp(`^deliver:${BUYER}:0:0x[0-9a-f]{64}$`));
    await agent.tick(); // chain still says Created (not yet indexed): must not redeliver
    expect(c.calls.filter((x) => x.startsWith('deliver'))).toHaveLength(1);
  });

  it('delivery hash is deterministic per agreement and differs across agreements', async () => {
    const c = fake({ asProvider: [agreement(), agreement({ seq: 1, deliverableHash: '0x' + '22'.repeat(32) })] });
    await make(c).agent.tick();
    const [a, b] = c.calls.filter((x) => x.startsWith('deliver')).map((x) => x.split(':')[3]);
    expect(a).not.toEqual(b);
  });

  it('skips agreements that are not Created, not ours, or past their deadline', async () => {
    const c = fake({
      head: 1000n,
      asProvider: [
        agreement({ seq: 0, status: 'Delivered' }),
        agreement({ seq: 1, status: 'Disputed' }),
        agreement({ seq: 2, provider: 'someone-else' }),
        agreement({ seq: 3, deliverBy: 999n }),
      ],
    });
    await make(c).agent.tick();
    expect(c.calls.filter((x) => x.startsWith('deliver'))).toEqual([]);
  });

  it('waits out MinDeliveryBlocks instead of sending a doomed delivery', async () => {
    const c = fake({ head: 1000n, asProvider: [agreement({ createdAt: 995n })] });
    await make(c).agent.tick();
    expect(c.calls.filter((x) => x.startsWith('deliver'))).toEqual([]);
  });

  it('accepts before delivering when the runtime supports acceptAgreement', async () => {
    const c = fake({ accept: true, asProvider: [agreement()] });
    await make(c).agent.tick();
    const order = c.calls.filter((x) => /^(accept|deliver)/.test(x)).map((x) => x.split(':')[0]);
    expect(order).toEqual(['accept', 'deliver']);
  });

  it('never calls accept on a runtime without it', async () => {
    const c = fake({ accept: false, asProvider: [agreement()] });
    await make(c).agent.tick();
    expect(c.calls.some((x) => x.startsWith('accept'))).toBe(false);
  });

  it('a failing accept is logged and does not stop delivery', async () => {
    const c = fake({ accept: true, asProvider: [agreement()], failOn: 'accept' });
    const { agent, events } = make(c);
    await agent.tick();
    expect(events.some((e) => e.event === 'error' && e.step === 'accept')).toBe(true);
    expect(c.calls.some((x) => x.startsWith('deliver'))).toBe(true);
  });

  it('a failing delivery is logged, retried next tick, and never crashes tick()', async () => {
    const c = fake({ asProvider: [agreement()], failOn: 'deliver' });
    const { agent, events } = make(c);
    await expect(agent.tick()).resolves.toBeUndefined();
    expect(events.some((e) => e.event === 'error' && e.step === 'deliver')).toBe(true);
    c.set({ failOn: null });
    await agent.tick();
    expect(c.calls.filter((x) => x.startsWith('deliver'))).toHaveLength(1);
  });
});

describe('claim', () => {
  it('claims when emissions are pending, not otherwise', async () => {
    const c = fake({ pending: 0n });
    const { agent } = make(c);
    await agent.tick();
    expect(c.calls).not.toContain('claim');
    c.set({ pending: 5n });
    await agent.tick();
    expect(c.calls).toContain('claim');
  });
});

describe('buyer mode', () => {
  it('fails closed: with no BUYER_PEERS it opens and confirms nothing, and says why', async () => {
    const c = fake({
      agents: [ME, 'peer'],
      asBuyer: [agreement({ buyer: ME, provider: 'peer', status: 'Delivered' })],
    });
    const { agent, events } = make(c, { mode: 'buyer', buyerPeers: [] });
    await agent.tick();
    expect(c.calls.some((x) => x.startsWith('create') || x.startsWith('confirm'))).toBe(false);
    expect(events.some((e) => e.event === 'error' && e.step === 'buyer')).toBe(true);
  });

  it('provider mode never opens agreements', async () => {
    const c = fake({ agents: [ME, 'peer'] });
    await make(c, { mode: 'provider', buyerPeers: ['peer'] }).agent.tick();
    expect(c.calls.some((x) => x.startsWith('create'))).toBe(false);
  });

  it('opens one small agreement with another agent, never with itself', async () => {
    const c = fake({ agents: [ME, 'peer'] });
    await make(c, { mode: 'buyer', buyerPeers: ['peer'] }).agent.tick();
    const created = c.calls.filter((x) => x.startsWith('create'));
    expect(created).toHaveLength(1);
    expect(created[0]).toBe(`create:peer:${10n * CMN}:${1000n + 200n}`);
  });

  it('with a peer allowlist, only opens agreements with listed agents', async () => {
    const c = fake({ agents: [ME, 'stranger', 'friend'] });
    await make(c, { mode: 'buyer', buyerPeers: ['friend'] }).agent.tick();
    expect(c.calls.filter((x) => x.startsWith('create'))).toEqual([`create:friend:${10n * CMN}:${1200n}`]);
  });

  it('with an allowlist and no listed agent registered, opens nothing', async () => {
    const c = fake({ agents: [ME, 'stranger'] });
    await make(c, { mode: 'buyer', buyerPeers: ['friend'] }).agent.tick();
    expect(c.calls.some((x) => x.startsWith('create'))).toBe(false);
  });

  it('does nothing when there is no other agent', async () => {
    const c = fake({ agents: [ME] });
    await make(c, { mode: 'buyer', buyerPeers: ['peer'] }).agent.tick();
    expect(c.calls.some((x) => x.startsWith('create'))).toBe(false);
  });

  it('respects the open-agreement cap', async () => {
    const open = [agreement({ buyer: ME, provider: 'p1', seq: 0 }), agreement({ buyer: ME, provider: 'p2', seq: 0 })];
    const c = fake({ agents: [ME, 'peer'], asBuyer: open });
    await make(c, { mode: 'buyer', buyerPeers: ['peer'] }).agent.tick();
    expect(c.calls.some((x) => x.startsWith('create'))).toBe(false);
  });

  it('confirms a Delivered agreement, releasing funds, exactly once', async () => {
    const c = fake({ asBuyer: [agreement({ buyer: ME, provider: 'peer', status: 'Delivered' })], agents: [ME] });
    const { agent } = make(c, { mode: 'both', buyerPeers: ['peer'] });
    await agent.tick();
    await agent.tick();
    expect(c.calls.filter((x) => x.startsWith('confirm'))).toEqual(['confirm:peer:0']);
  });

  it('will not open an agreement it cannot afford', async () => {
    const c = fake({ agents: [ME, 'peer'] });
    c.freeBalance = async () => 1n;
    await make(c, { mode: 'buyer', buyerPeers: ['peer'] }).agent.tick();
    expect(c.calls.some((x) => x.startsWith('create'))).toBe(false);
  });
});

describe('logging', () => {
  it('emits one event per action', async () => {
    const c = fake({ registered: false, lastHb: null });
    const { agent, events } = make(c);
    await agent.tick();
    const names = events.map((e) => e.event);
    expect(names).toContain('register');
    expect(names).toContain('heartbeat');
  });
});

describe('messaging key (spec 308)', () => {
  const KEY = '0x' + 'ab'.repeat(32);

  it('publishes the derived key when the runtime supports it and none is on chain', async () => {
    const c = fake({ messaging: true });
    const { agent, events } = make(c, { messagingKey: KEY });
    await agent.tick();
    expect(c.calls).toContain(`messaging-key:${KEY}`);
    expect(events).toContainEqual(expect.objectContaining({ event: 'messaging-key', key: KEY, previous: null }));
  });

  it('rotates a stale on-chain key, and does nothing when it already matches', async () => {
    const stale = fake({ messaging: true, onChainKey: '0x' + '01'.repeat(32) });
    await make(stale, { messagingKey: KEY }).agent.tick();
    expect(stale.calls).toContain(`messaging-key:${KEY}`);

    const current = fake({ messaging: true, onChainKey: KEY });
    await make(current, { messagingKey: KEY }).agent.tick();
    expect(current.calls.some((x) => x.startsWith('messaging-key'))).toBe(false);
  });

  it('skips on a runtime without messaging, or when no key is configured', async () => {
    const old = fake({ messaging: false });
    await make(old, { messagingKey: KEY }).agent.tick();
    const none = fake({ messaging: true });
    await make(none).agent.tick();
    expect([...old.calls, ...none.calls].some((x) => x.startsWith('messaging-key'))).toBe(false);
  });

  it('is failure-isolated: a failed publish does not stop the rest of the tick', async () => {
    const c = fake({ messaging: true, failOn: 'messaging-key', pending: 5n });
    const { agent, events } = make(c, { messagingKey: KEY });
    await agent.tick();
    expect(c.calls).toContain('claim');
    expect(events).toContainEqual(expect.objectContaining({ event: 'error', step: 'messaging-key' }));
  });
});
