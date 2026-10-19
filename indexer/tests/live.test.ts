import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { ApiPromise } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady, decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import type { KeyringPair } from '@polkadot/keyring/types';
import type { SubmittableExtrinsic } from '@polkadot/api/types';

import { connectChain } from '../src/chain.ts';
import { IndexerStore } from '../src/store.ts';
import { ChainIndexer } from '../src/indexer.ts';
import { createApiServer, ROUTES } from '../src/api.ts';
import { fetchAgents, fetchEscrows } from '../src/chainState.ts';
import { loadConfig } from '../src/config.ts';

/**
 * End-to-end against the live devnet node.
 *
 * This suite is the contract the issue states: every one of the 25 v1 endpoints
 * must answer with data read from a real chain — never a fixture. So it
 * (1) submits real extrinsics, (2) lets the indexer ingest the real finalized
 * blocks those landed in, and (3) cross-checks each response against a direct
 * RPC read of the same state. If the node is unreachable the suite fails loudly:
 * a missing chain is a finding, not a reason to fall back to mocks.
 */

const RPC_URL = process.env.INDEXER_RPC_URL ?? 'ws://127.0.0.1:9944';

let chain: Awaited<ReturnType<typeof connectChain>>;
let api: ApiPromise;
let store: IndexerStore;
let indexer: ChainIndexer;
let server: Server;
let baseUrl: string;

/**
 * Untyped access to this chain's own pallets.
 *
 * polkadot-js generates types from a chain's metadata, and there are none for
 * `agents`, `escrow` or `emissions` here — which is exactly why `chainState.ts`
 * reads them through the node's metadata instead. These accessors keep that
 * escape hatch in one place so the assertions below read plainly and
 * `npm run typecheck` still covers this file.
 */
const chainQuery = (): any => api.query;
const chainTx = (): any => api.tx;
const chainConsts = (): any => api.consts;

/** Reads a JSON response body without claiming to know its shape. */
const jsonBody = (response: Response): Promise<any> => response.json();

/** Route paths this suite actually exercised, to prove none is left untested. */
const exercised = new Set<string>();

/** Fills a route template (`/v1/blocks/:id`) and records that it was hit. */
async function getRoute(
  template: string,
  params: Record<string, string | number> = {},
  query = '',
): Promise<{ status: number; body: any }> {
  let path = template;
  for (const [key, value] of Object.entries(params)) {
    path = path.replace(`:${key}`, encodeURIComponent(String(value)));
  }
  expect(path, `unfilled parameter in ${template}`).not.toContain(':');
  exercised.add(template);
  const response = await fetch(`${baseUrl}${path}${query}`);
  return { status: response.status, body: await response.json() };
}

/**
 * Wraps the live api so storage reads can be counted.
 *
 * Nothing is faked: every call goes through to the node. Counting is the only
 * way to observe read *amplification* — an endpoint that answers a one-row page
 * by reading the whole of a map costs the validator the same whatever `?limit=`
 * says, and the response alone cannot show that.
 */
function countingApi(target: ApiPromise): {
  api: ApiPromise;
  counts: Map<string, number>;
  calls: { key: string; args: unknown[] }[];
} {
  const counts = new Map<string, number>();
  const calls: { key: string; args: unknown[] }[] = [];
  const bump = (key: string, args: unknown[]) => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    calls.push({ key, args });
  };

  const queryProxy = new Proxy(target.query as unknown as Record<string, any>, {
    get(section, palletName: string) {
      const pallet = section[palletName];
      if (pallet === undefined || typeof palletName !== 'string') return pallet;
      return new Proxy(pallet, {
        get(storage, itemName: string) {
          const item = storage[itemName];
          if (typeof item !== 'function') return item;
          const wrapped = (...args: unknown[]) => {
            bump(`${palletName}.${itemName}`, args);
            return item(...args);
          };
          return new Proxy(wrapped, {
            get(_target, property) {
              const member = (item as Record<string | symbol, unknown>)[property];
              if (typeof member !== 'function') return member;
              return (...args: unknown[]) => {
                bump(`${palletName}.${itemName}.${String(property)}`, args);
                return (member as (...a: unknown[]) => unknown).apply(item, args);
              };
            },
          });
        },
      });
    },
  });

  const api = new Proxy(target, {
    get: (chainApi, property) =>
      property === 'query' ? queryProxy : (chainApi as unknown as Record<string | symbol, unknown>)[property],
  }) as ApiPromise;

  return { api, counts, calls };
}

/** Submits an extrinsic and resolves with the block number it landed in. */
function submit(tx: SubmittableExtrinsic<'promise'>, signer: KeyringPair): Promise<number> {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, ({ status, dispatchError, txIndex }) => {
      if (dispatchError) {
        reject(new Error(`extrinsic failed: ${dispatchError.toString()} (txIndex ${txIndex})`));
        return;
      }
      if (status.isInBlock) {
        api.rpc.chain
          .getHeader(status.asInBlock)
          .then((header) => resolve(header.number.toNumber()))
          .catch(reject);
      }
    }).catch(reject);
  });
}

/** Resolves once the node's best block reaches `target`, or throws. */
async function waitForChainBlock(target: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const head = await api.rpc.chain.getHeader();
    if (head.number.toNumber() >= target) return;
    if (Date.now() > deadline) {
      throw new Error(`chain did not reach block ${target} within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** Seeded on-chain facts the endpoint assertions are checked against. */
const seeded = {
  heartbeatBlock: 0,
  transferBlock: 0,
  escrowBlock: 0,
  buyer: '',
  provider: '',
  seq: 0,
  amountPlancks: '',
};

let alice: KeyringPair;
let dave: KeyringPair;
/** The seeded agreement's provider, kept so `afterAll` can settle it. */
let providerSigner: KeyringPair | undefined;

beforeAll(async () => {
  chain = await connectChain(RPC_URL);
  api = chain.api;
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519', ss58Format: chain.ss58Format });
  alice = keyring.addFromUri('//Alice');
  dave = keyring.addFromUri('//Dave');

  // Releasing the seeded agreement needs the provider's own signature —
  // `record_delivery` is the provider's call — so the pair below is picked from
  // the genesis agents whose well-known devnet key this suite actually holds.
  const providerSigners = new Map<string, KeyringPair>();
  for (const seed of ['//Bob', '//Charlie', '//Dave', '//Eve', '//Ferdie']) {
    const candidate = keyring.addFromUri(seed);
    providerSigners.set(candidate.address, candidate);
  }

  // Index from well before the seeded activity so the suite has real history to
  // page through, not just the blocks it created itself.
  store = IndexerStore.open(':memory:');
  indexer = new ChainIndexer(api, store, { backfillDepth: 20 });
  await indexer.start();

  // ── Seed real chain activity ────────────────────────────────────────────
  // Alice is a genesis agent, so `heartbeat` is a call she can actually make.
  seeded.heartbeatBlock = await submit(chainTx().agents.heartbeat(), alice);

  // A transfer gives the account endpoints a second real account to report.
  seeded.transferBlock = await submit(
    chainTx().balances.transferKeepAlive(dave.address, 1_000_000_000_000n),
    alice,
  );

  // An escrow agreement between two genesis agents. The pair is chosen at
  // runtime because `MaxAgreementsPerPair` bounds how many a single pair can
  // hold — running out is a real failure, not something to skip past.
  const maxPerPair = (chainConsts().escrow.maxAgreementsPerPair as unknown as { toNumber(): number }).toNumber();
  const agentEntries = await chainQuery().agents.agentStake.entries();
  const agentAddresses = agentEntries.map(([key]: [any, any]) => key.args[0]!.toString());
  const aliceIsAgent = agentAddresses.includes(alice.address);
  expect(aliceIsAgent, `//Alice (${alice.address}) must be a registered agent on the devnet`).toBe(true);

  let provider = '';
  for (const candidate of agentAddresses) {
    if (candidate === alice.address) continue;
    if (!providerSigners.has(candidate)) continue;
    const existing = await chainQuery().escrow.agreements(alice.address, candidate);
    if ((existing as unknown as { length: number }).length < maxPerPair) {
      provider = candidate;
      providerSigner = providerSigners.get(candidate);
      break;
    }
  }
  expect(
    provider,
    `every signable provider pair for //Alice is at MaxAgreementsPerPair (${maxPerPair}); the devnet needs cleaning up`,
  ).not.toBe('');

  const minAmount = (chainConsts().escrow.minAgreementAmount as unknown as { toString(): string }).toString();
  const nextSeq = await chainQuery().escrow.nextSeq(alice.address, provider);
  const head = await api.rpc.chain.getHeader();
  const deliverBy = head.number.toNumber() + 100_000;
  const deliverableHash = `0x${'11'.repeat(32)}`;

  seeded.escrowBlock = await submit(
    chainTx().escrow.createAgreement(provider, minAmount, deliverableHash, deliverBy, null),
    alice,
  );
  seeded.buyer = alice.address;
  seeded.provider = provider;
  seeded.seq = Number((nextSeq as unknown as { toString(): string }).toString());
  seeded.amountPlancks = minAmount;

  // Ingestion is over finalized blocks, so wait for the indexer to actually
  // reach the highest seeded block rather than sleeping and hoping.
  await indexer.waitForBlock(
    Math.max(seeded.heartbeatBlock, seeded.transferBlock, seeded.escrowBlock),
    200_000,
  );

  const config = loadConfig({ ...process.env, INDEXER_PORT: '0' });
  server = createApiServer({ store, api, chain, indexer, config });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  try {
    // ── Release the seeded escrow agreement ─────────────────────────────────
    // `Agreements(buyer, provider)` is a BoundedVec capped at
    // `MaxAgreementsPerPair`, and an open agreement also keeps the buyer's
    // stake reserved. A suite that seeds one every run and walks away burns a
    // pair slot permanently, so after ~10 runs per provider `beforeAll` can no
    // longer find a pair with room and the whole suite aborts. Settling the
    // agreement is what returns the slot: the pallet `swap_remove`s the entry
    // on `confirm_delivery`.
    if (seeded.provider && providerSigner) {
      // `record_delivery` is gated on `MinDeliveryBlocks` having elapsed since
      // the agreement was created, so wait for that block rather than assuming
      // the suite itself ran long enough to clear it.
      const minDeliveryBlocks = (
        chainConsts().escrow.minDeliveryBlocks as unknown as { toNumber(): number }
      ).toNumber();
      await waitForChainBlock(seeded.escrowBlock + minDeliveryBlocks, 200_000);

      await submit(
        chainTx().escrow.recordDelivery(seeded.buyer, seeded.seq, `0x${'22'.repeat(32)}`),
        providerSigner,
      );
      await submit(chainTx().escrow.confirmDelivery(seeded.provider, seeded.seq), alice);

      const remaining = (await chainQuery().escrow.agreements(
        seeded.buyer,
        seeded.provider,
      )) as unknown as { seq: { toNumber(): number } }[];
      expect(
        [...remaining].map((a) => a.seq.toNumber()),
        `seeded agreement seq ${seeded.seq} must be released back to the pair`,
      ).not.toContain(seeded.seq);
    }
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (indexer) await indexer.stop();
    if (store) store.close();
    if (chain) await chain.disconnect();
  }
});

describe('v1 surface', () => {
  it('exposes exactly the 25 documented endpoints', () => {
    expect(ROUTES).toHaveLength(25);
    // Paths are the public contract — duplicates would mean one is unreachable.
    expect(new Set(ROUTES.map((r) => r.path)).size).toBe(25);
    for (const route of ROUTES) {
      expect(route.path.startsWith('/v1/'), `${route.path} must be version-prefixed`).toBe(true);
    }
  });

  it('404s an unknown path rather than falling through to a handler', async () => {
    const response = await fetch(`${baseUrl}/v1/not-a-real-endpoint`);
    expect(response.status).toBe(404);
    expect((await jsonBody(response)).error).toBeTruthy();
  });

  it('answers malformed percent-encoding with a 400 and stays up', async () => {
    // `decodeURIComponent('%')` throws URIError. Any anonymous caller can put
    // that byte in a path segment, so it has to become a client error — not an
    // unhandled rejection that takes the process down and answers nothing.
    for (const path of ['/v1/blocks/%', '/v1/accounts/%', '/v1/escrows/%/x/1', '/v1/agents/%E0%A4%A/events']) {
      const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
      expect(response.status, path).toBe(400);
      expect((await jsonBody(response)).error, path).toBeTruthy();
    }

    // The point of the previous assertions: the server survived all of them.
    const after = await fetch(`${baseUrl}/v1/status`, { signal: AbortSignal.timeout(15_000) });
    expect(after.status).toBe(200);
  });
});

describe('status', () => {
  it('reports the live runtime and the indexer position', async () => {
    const { status, body } = await getRoute('/v1/status');
    expect(status).toBe(200);
    expect(body.chain.specName).toBe(api.runtimeVersion.specName.toString());
    expect(body.chain.specVersion).toBe(api.runtimeVersion.specVersion.toNumber());
    expect(body.chain.ss58Format).toBe(chain.ss58Format);
    expect(body.chain.tokenSymbol).toBe('CMN');
    expect(body.chain.tokenDecimals).toBe(12);
    // The indexer cannot be ahead of the chain, and must have reached the seed.
    expect(body.indexer.syncedHeight).toBeGreaterThanOrEqual(seeded.escrowBlock);
    expect(body.indexer.syncedHeight).toBeLessThanOrEqual(body.chain.bestBlock);
    expect(body.indexer.indexedBlocks).toBeGreaterThan(0);
  });
});

describe('blocks', () => {
  it('lists real finalized blocks, newest first', async () => {
    const { status, body } = await getRoute('/v1/blocks', {}, '?limit=5');
    expect(status).toBe(200);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.length).toBeLessThanOrEqual(5);
    expect(body.total).toBeGreaterThanOrEqual(body.items.length);

    const numbers = body.items.map((b: any) => b.number);
    expect([...numbers]).toEqual([...numbers].sort((a: number, b: number) => b - a));

    // Cross-check the newest listed block against the node itself.
    const head = body.items[0];
    const hashOnChain = await api.rpc.chain.getBlockHash(head.number);
    expect(head.hash).toBe(hashOnChain.toHex());
  });

  it('serves a single block by number and by hash, matching the node', async () => {
    const onChainHash = (await api.rpc.chain.getBlockHash(seeded.heartbeatBlock)).toHex();
    const signedBlock = await api.rpc.chain.getBlock(onChainHash);

    const byNumber = await getRoute('/v1/blocks/:id', { id: seeded.heartbeatBlock });
    expect(byNumber.status).toBe(200);
    expect(byNumber.body.hash).toBe(onChainHash);
    expect(byNumber.body.parentHash).toBe(signedBlock.block.header.parentHash.toHex());
    expect(byNumber.body.extrinsicCount).toBe(signedBlock.block.extrinsics.length);
    expect(byNumber.body.timestampMs).toBeGreaterThan(0);

    const byHash = await getRoute('/v1/blocks/:id', { id: onChainHash });
    expect(byHash.body).toEqual(byNumber.body);
  });

  it('lists the extrinsics of a block, including the timestamp inherent', async () => {
    const { status, body } = await getRoute('/v1/blocks/:id/extrinsics', { id: seeded.heartbeatBlock });
    expect(status).toBe(200);
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    expect(body.items[0].section).toBe('timestamp');
    expect(body.items[0].method).toBe('set');
    expect(body.items[0].isSigned).toBe(false);

    const heartbeat = body.items.find((x: any) => x.section === 'agents' && x.method === 'heartbeat');
    expect(heartbeat, 'the seeded heartbeat must be indexed in its block').toBeTruthy();
    expect(heartbeat.signer).toBe(alice.address);
    expect(heartbeat.success).toBe(true);
  });

  it('lists the events of a block with their phase and extrinsic link', async () => {
    const { status, body } = await getRoute('/v1/blocks/:id/events', { id: seeded.heartbeatBlock });
    expect(status).toBe(200);

    const apiAt = await api.at(await api.rpc.chain.getBlockHash(seeded.heartbeatBlock));
    const onChain = (await (apiAt.query as any).system.events()) as unknown[];
    expect(body.total).toBe(onChain.length);

    const heartbeatEvent = body.items.find((e: any) => e.section === 'agents' && e.method === 'HeartbeatSent');
    expect(heartbeatEvent, 'HeartbeatSent must be indexed').toBeTruthy();
    expect(heartbeatEvent.phase).toBe('ApplyExtrinsic');
    expect(heartbeatEvent.extrinsicId).toMatch(new RegExp(`^${seeded.heartbeatBlock}-\\d+$`));
    expect(heartbeatEvent.data.who).toBe(alice.address);

    // The dispatch info on the matching success event is the shape most easily
    // mangled in decoding: two plain enums and a struct of 64-bit weights.
    const success = body.items.find(
      (e: any) =>
        e.section === 'system' &&
        e.method === 'ExtrinsicSuccess' &&
        e.extrinsicId === heartbeatEvent.extrinsicId,
    );
    expect(success).toBeTruthy();
    // A signed user call is Normal and pays a fee — never null, which is what a
    // decoder that mistakes an enum for an absent Option reports.
    expect(success.data.dispatch_info.class).toBe('Normal');
    expect(success.data.dispatch_info.paysFee).toBe('Yes');
    // 64-bit weights arrive as decimal strings, not floats.
    expect(success.data.dispatch_info.weight.refTime).toMatch(/^\d+$/);
  });

  it('404s a block the indexer does not have', async () => {
    const far = (await api.rpc.chain.getHeader()).number.toNumber() + 1_000_000;
    const response = await fetch(`${baseUrl}/v1/blocks/${far}`);
    expect(response.status).toBe(404);
  });
});

describe('extrinsics', () => {
  let heartbeatId = '';

  it('lists extrinsics and filters them by signer', async () => {
    const { status, body } = await getRoute('/v1/extrinsics', {}, `?signer=${alice.address}&limit=50`);
    expect(status).toBe(200);
    expect(body.total).toBeGreaterThanOrEqual(3); // heartbeat + transfer + escrow
    for (const item of body.items) expect(item.signer).toBe(alice.address);

    const heartbeat = body.items.find((x: any) => x.method === 'heartbeat');
    expect(heartbeat).toBeTruthy();
    heartbeatId = heartbeat.id;
    expect(heartbeatId.startsWith(`${seeded.heartbeatBlock}-`)).toBe(true);
  });

  it('answers ?signer= written with a foreign SS58 prefix', async () => {
    const foreign = encodeAddress(decodeAddress(alice.address), chain.ss58Format === 0 ? 2 : 0);
    const native = await getRoute('/v1/extrinsics', {}, `?signer=${alice.address}&limit=5`);
    const alien = await getRoute('/v1/extrinsics', {}, `?signer=${foreign}&limit=5`);
    expect(native.body.total).toBeGreaterThanOrEqual(3);
    expect(alien.status).toBe(200);
    expect(alien.body.total).toBe(native.body.total);
  });

  it('rejects a ?signer= filter that is not an address', async () => {
    const response = await fetch(`${baseUrl}/v1/extrinsics?signer=not-an-address`);
    expect(response.status).toBe(400);
  });

  it('serves one extrinsic with its decoded call and outcome', async () => {
    const { status, body } = await getRoute('/v1/extrinsics/:id', { id: heartbeatId });
    expect(status).toBe(200);
    expect(body.section).toBe('agents');
    expect(body.method).toBe('heartbeat');
    expect(body.isSigned).toBe(true);
    expect(body.signer).toBe(alice.address);
    expect(body.success).toBe(true);
    expect(body.blockNumber).toBe(seeded.heartbeatBlock);
    expect(body.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('serves the events emitted by one extrinsic', async () => {
    const { status, body } = await getRoute('/v1/extrinsics/:id/events', { id: heartbeatId });
    expect(status).toBe(200);
    const methods = body.items.map((e: any) => `${e.section}.${e.method}`);
    expect(methods).toContain('agents.HeartbeatSent');
    expect(methods).toContain('system.ExtrinsicSuccess');
    for (const event of body.items) expect(event.extrinsicId).toBe(heartbeatId);
  });

  it('404s an extrinsic id that was never indexed', async () => {
    const response = await fetch(`${baseUrl}/v1/extrinsics/0-999`);
    expect(response.status).toBe(404);
  });
});

describe('events', () => {
  it('lists events and filters by pallet and method', async () => {
    const { status, body } = await getRoute(
      '/v1/events',
      {},
      '?section=escrow&method=AgreementCreated&limit=50',
    );
    expect(status).toBe(200);
    expect(body.total).toBeGreaterThanOrEqual(1);

    const created = body.items.find((e: any) => e.blockNumber === seeded.escrowBlock);
    expect(created, 'the seeded AgreementCreated event must be indexed').toBeTruthy();
    expect(created.data.buyer).toBe(seeded.buyer);
    expect(created.data.provider).toBe(seeded.provider);
    expect(String(created.data.amount)).toBe(seeded.amountPlancks);
  });

  it('answers ?account= written with a foreign SS58 prefix', async () => {
    // The same account written with another chain's prefix is the same account.
    // Answering 200 with an empty list splits one address's history in two and
    // says nothing about why.
    const foreign = encodeAddress(decodeAddress(alice.address), chain.ss58Format === 0 ? 2 : 0);
    expect(foreign).not.toBe(alice.address);

    const native = await getRoute('/v1/events', {}, `?account=${alice.address}&limit=5`);
    const alien = await getRoute('/v1/events', {}, `?account=${foreign}&limit=5`);
    expect(native.body.total).toBeGreaterThan(0);
    expect(alien.status).toBe(200);
    expect(alien.body.total).toBe(native.body.total);
  });

  it('rejects an ?account= filter that is not an address', async () => {
    const response = await fetch(`${baseUrl}/v1/events?account=not-an-address`);
    expect(response.status).toBe(400);
  });

  it('serves a single event by id', async () => {
    const list = await getRoute('/v1/events', {}, `?blockNumber=${seeded.escrowBlock}&section=escrow`);
    const first = list.body.items[0];
    const { status, body } = await getRoute('/v1/events/:id', { id: first.id });
    expect(status).toBe(200);
    expect(body).toEqual(first);
    expect(body.accounts).toContain(seeded.buyer);
  });
});

describe('accounts', () => {
  it('lists accounts the indexer has seen on chain', async () => {
    const { status, body } = await getRoute('/v1/accounts', {}, '?limit=50');
    expect(status).toBe(200);
    expect(body.total).toBeGreaterThanOrEqual(2);
    const addresses = body.items.map((a: any) => a.address);
    expect(addresses).toContain(alice.address);
    expect(addresses).toContain(dave.address); // seen via the seeded transfer
  });

  it('reports an account with its live on-chain balance', async () => {
    const { status, body } = await getRoute('/v1/accounts/:address', { address: alice.address });
    expect(status).toBe(200);

    const onChain = await chainQuery().system.account(alice.address);
    expect(body.address).toBe(alice.address);
    expect(body.balance.freePlancks).toBe(onChain.data.free.toString());
    expect(body.balance.reservedPlancks).toBe(onChain.data.reserved.toString());
    expect(body.nonce).toBe(onChain.nonce.toNumber());
    expect(body.isAgent).toBe(true);
    expect(body.activity.extrinsicCount).toBeGreaterThanOrEqual(3);
  });

  it('rejects a malformed address instead of guessing', async () => {
    const response = await fetch(`${baseUrl}/v1/accounts/not-an-address`);
    expect(response.status).toBe(400);
  });

  it('lists the extrinsics an account signed', async () => {
    const { status, body } = await getRoute('/v1/accounts/:address/extrinsics', { address: alice.address });
    expect(status).toBe(200);
    expect(body.total).toBeGreaterThanOrEqual(3);
    const calls = body.items.map((x: any) => `${x.section}.${x.method}`);
    expect(calls).toContain('agents.heartbeat');
    expect(calls).toContain('escrow.createAgreement');
    for (const item of body.items) expect(item.signer).toBe(alice.address);
  });
});

describe('agents', () => {
  it('lists every registered agent with its live stake', async () => {
    const { status, body } = await getRoute('/v1/agents');
    expect(status).toBe(200);

    const onChain = await chainQuery().agents.agentStake.entries();
    expect(body.total).toBe(onChain.length);
    expect(body.total).toBeGreaterThan(0);

    const stakeByAddress = new Map(
      onChain.map(([key, value]: [any, any]) => [key.args[0]!.toString(), value.toString()]),
    );
    for (const agent of body.items) {
      expect(stakeByAddress.get(agent.address)).toBe(agent.stakePlancks);
      expect(BigInt(agent.stakePlancks) > 0n).toBe(true);
    }
  });

  it('reads only the agents in the requested window', async () => {
    // Every agent costs ten storage reads to describe. Reading all of them to
    // answer a one-row page turns `?limit=1` into O(agents × 10) RPC calls
    // against the validator this indexer points at.
    const onChain = await chainQuery().agents.agentStake.entries();
    expect(onChain.length, 'the devnet must have more than one agent for this to mean anything').toBeGreaterThan(1);

    const { api: counting, counts } = countingApi(api);
    const page = await fetchAgents(counting, { limit: 1, offset: 0 });

    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(onChain.length);
    // `stakeRegisteredAt` is read exactly once per agent described.
    expect(counts.get('agents.stakeRegisteredAt') ?? 0).toBe(1);
    // The key enumeration is paged, never an unbounded `entries()` sweep.
    expect(counts.get('agents.agentStake.entries') ?? 0).toBe(0);
    expect(counts.get('agents.agentStake.entriesPaged') ?? 0).toBeGreaterThan(0);
  });

  it('orders agents by stake with a comparator that is stable across calls', async () => {
    // The devnet's genesis agents all hold the same stake, so an inconsistent
    // comparator (one that never returns 0) shows up here as an order that
    // changes between two identical requests.
    const first = await getRoute('/v1/agents', {}, '?limit=100');
    const second = await getRoute('/v1/agents', {}, '?limit=100');
    expect(second.body.items.map((a: any) => a.address)).toEqual(
      first.body.items.map((a: any) => a.address),
    );

    const stakes = first.body.items.map((a: any) => BigInt(a.stakePlancks));
    for (let i = 1; i < stakes.length; i += 1) {
      expect(stakes[i - 1] >= stakes[i], 'stake must be non-increasing').toBe(true);
    }
  });

  it('pages the agent list without dropping or repeating an agent', async () => {
    const whole = await getRoute('/v1/agents', {}, '?limit=100');
    const firstPage = await getRoute('/v1/agents', {}, '?limit=1&offset=0');
    const rest = await getRoute('/v1/agents', {}, `?limit=100&offset=1`);

    expect(firstPage.body.total).toBe(whole.body.total);
    expect(firstPage.body.items).toHaveLength(1);
    expect([...firstPage.body.items, ...rest.body.items].map((a: any) => a.address)).toEqual(
      whole.body.items.map((a: any) => a.address),
    );
    // A page that fits inside the scan ceiling is complete, and says so.
    expect(whole.body.truncated).toBe(false);
  });

  it('reports one agent, including the heartbeat just sent', async () => {
    const { status, body } = await getRoute('/v1/agents/:address', { address: alice.address });
    expect(status).toBe(200);
    expect(body.address).toBe(alice.address);
    expect(body.stakePlancks).toBe((await chainQuery().agents.agentStake(alice.address)).toString());
    // The seeded heartbeat wrote this, so it must be at least that block.
    expect(body.lastHeartbeatBlock).toBeGreaterThanOrEqual(seeded.heartbeatBlock);
    expect(body.activeEscrowCount).toBe(
      Number((await chainQuery().agents.activeEscrowCount(alice.address)).toString()),
    );
    expect(body.eraVolumePlancks).toBe((await chainQuery().agents.eraEscrowVolume(alice.address)).toString());
  });

  it('404s an account that is not an agent', async () => {
    const response = await fetch(`${baseUrl}/v1/agents/${dave.address}`);
    expect(response.status).toBe(404);
  });

  it('serves the agent-scoped event history', async () => {
    const { status, body } = await getRoute('/v1/agents/:address/events', { address: alice.address });
    expect(status).toBe(200);
    expect(body.total).toBeGreaterThanOrEqual(2);
    const methods = body.items.map((e: any) => `${e.section}.${e.method}`);
    expect(methods).toContain('agents.HeartbeatSent');
    expect(methods).toContain('escrow.AgreementCreated');
    for (const event of body.items) expect(event.accounts).toContain(alice.address);
  });

  it('serves the agreements an agent is party to', async () => {
    const { status, body } = await getRoute('/v1/agents/:address/escrows', { address: alice.address });
    expect(status).toBe(200);
    expect(body.total).toBeGreaterThanOrEqual(1);

    const seededAgreement = body.items.find(
      (a: any) => a.buyer === seeded.buyer && a.provider === seeded.provider && a.seq === seeded.seq,
    );
    expect(seededAgreement, 'the seeded agreement must be visible from the buyer side').toBeTruthy();
    expect(seededAgreement.role).toBe('buyer');
    expect(seededAgreement.amountPlancks).toBe(seeded.amountPlancks);
  });
});

describe('escrows', () => {
  it('lists live agreements straight from chain storage', async () => {
    const { status, body } = await getRoute('/v1/escrows', {}, '?limit=100');
    expect(status).toBe(200);
    expect(body.total).toBeGreaterThanOrEqual(1);

    const found = body.items.find(
      (a: any) => a.buyer === seeded.buyer && a.provider === seeded.provider && a.seq === seeded.seq,
    );
    expect(found).toBeTruthy();
    expect(found.status).toBe('Created');
    expect(found.amountPlancks).toBe(seeded.amountPlancks);
    expect(found.createdAtBlock).toBe(seeded.escrowBlock);
    expect(found.deliverableHash).toBe(`0x${'11'.repeat(32)}`);
  });

  it('filters agreements by buyer', async () => {
    const { body } = await getRoute('/v1/escrows', {}, `?buyer=${seeded.buyer}&limit=100`);
    expect(body.total).toBeGreaterThanOrEqual(1);
    for (const item of body.items) expect(item.buyer).toBe(seeded.buyer);
  });

  it('answers a fully-keyed filter with a direct read, not a map sweep', async () => {
    // (buyer, provider) is the storage key of the double map. Enumerating the
    // whole map to answer a query that names both halves of its key puts the
    // cost of every other pair's agreements on the node for nothing.
    const { api: counting, counts } = countingApi(api);
    const list = await fetchEscrows(counting, { buyer: seeded.buyer, provider: seeded.provider });

    expect(list.items.length).toBeGreaterThanOrEqual(1);
    expect(counts.get('escrow.agreements.entries') ?? 0).toBe(0);
    expect(counts.get('escrow.agreements.entriesPaged') ?? 0).toBe(0);
    expect(counts.get('escrow.agreements') ?? 0).toBe(1);
  });

  it('bounds an unfiltered sweep instead of pulling the whole map', async () => {
    const { api: counting, counts } = countingApi(api);
    const list = await fetchEscrows(counting, {});

    expect(list.items.length).toBeGreaterThanOrEqual(1);
    expect(list.truncated).toBe(false);
    expect(counts.get('escrow.agreements.entries') ?? 0).toBe(0);
    expect(counts.get('escrow.agreements.entriesPaged') ?? 0).toBeGreaterThan(0);
  });

  it('scopes a buyer filter to that buyer’s storage prefix', async () => {
    const { api: counting, counts, calls } = countingApi(api);
    const list = await fetchEscrows(counting, { buyer: seeded.buyer });

    expect(list.items.every((agreement) => agreement.buyer === seeded.buyer)).toBe(true);
    expect(counts.get('escrow.agreements.entries') ?? 0).toBe(0);

    // The double map is keyed buyer-first, so a buyer filter is a key prefix —
    // the node need never look at another buyer's agreements.
    const sweeps = calls.filter((call) => call.key === 'escrow.agreements.entriesPaged');
    expect(sweeps.length).toBeGreaterThan(0);
    for (const sweep of sweeps) {
      expect((sweep.args[0] as { args: unknown[] }).args).toEqual([seeded.buyer]);
    }
  });

  it('reports aggregate escrow state matching the chain counter', async () => {
    const { status, body } = await getRoute('/v1/escrows/stats');
    expect(status).toBe(200);
    expect(body.activeAgreementCount).toBe(
      Number((await chainQuery().escrow.activeAgreementCount()).toString()),
    );
    expect(body.activeAgreementCount).toBeGreaterThanOrEqual(1);
    expect(BigInt(body.totalLockedPlancks) >= BigInt(seeded.amountPlancks)).toBe(true);
    expect(body.byStatus.Created).toBeGreaterThanOrEqual(1);
    // The split describes every pair the scan reached; say when it reached them all.
    expect(body.scanTruncated).toBe(false);
    expect(body.enumeratedAgreements).toBeGreaterThanOrEqual(1);
  });

  it('serves one agreement by its (buyer, provider, seq) key', async () => {
    const { status, body } = await getRoute('/v1/escrows/:buyer/:provider/:seq', {
      buyer: seeded.buyer,
      provider: seeded.provider,
      seq: seeded.seq,
    });
    expect(status).toBe(200);
    expect(body.buyer).toBe(seeded.buyer);
    expect(body.provider).toBe(seeded.provider);
    expect(body.seq).toBe(seeded.seq);
    expect(body.amountPlancks).toBe(seeded.amountPlancks);
    expect(body.status).toBe('Created');
    expect(body.deliverByBlock).toBeGreaterThan(body.createdAtBlock);
  });

  it('404s an agreement sequence that does not exist', async () => {
    const response = await fetch(`${baseUrl}/v1/escrows/${seeded.buyer}/${seeded.provider}/99999`);
    expect(response.status).toBe(404);
  });
});

describe('eras', () => {
  it('reports the current era from live chain state', async () => {
    const { status, body } = await getRoute('/v1/eras/current');
    expect(status).toBe(200);

    const eraOnChain = Number((await chainQuery().agents.eraNumber()).toString());
    const startBlock = Number((await chainQuery().emissions.eraStartBlock()).toString());
    const duration = Number((chainConsts().emissions.eraDuration as unknown as { toString(): string }).toString());

    expect(body.era).toBe(eraOnChain);
    expect(body.startBlock).toBe(startBlock);
    expect(body.durationBlocks).toBe(duration);
    expect(body.currentBlock).toBeGreaterThanOrEqual(seeded.escrowBlock);
    expect(body.blocksElapsed).toBe(body.currentBlock - startBlock);
    // `settle_era` is permissionless and gated only on era duration, so this
    // flag is exactly that guard's condition — not an authority check.
    expect(body.dueForSettlement).toBe(body.blocksElapsed >= duration);
  });

  it('lists eras with the in-progress one included', async () => {
    const { status, body } = await getRoute('/v1/eras');
    expect(status).toBe(200);
    expect(body.total).toBeGreaterThanOrEqual(1);

    const eraOnChain = Number((await chainQuery().agents.eraNumber()).toString());
    const current = body.items.find((e: any) => e.era === eraOnChain);
    expect(current, 'the current era must always be listed').toBeTruthy();
    expect(current.settled).toBe(false);
    // Settled eras carry the emission that was actually minted for them.
    for (const era of body.items) {
      if (era.settled) expect(BigInt(era.totalEmissionPlancks) >= 0n).toBe(true);
    }
  });

  it('gives every era entry the same keys, settled or not', async () => {
    const { body } = await getRoute('/v1/eras', {}, '?limit=200');
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    const shape = Object.keys(body.items[0]).sort();
    for (const era of body.items) {
      expect(Object.keys(era).sort(), `era ${era.era} must not need a branch on \`settled\``).toEqual(shape);
    }
  });

  it('reports how far back its settled history actually reaches', async () => {
    // The indexer keeps accumulating for as long as it runs, so the depth of
    // history is the oldest block it holds — not the startup backfill window,
    // which understates it by every block indexed since.
    const first = await getRoute('/v1/blocks', {}, '?limit=1');
    const oldest = await getRoute('/v1/blocks', {}, `?limit=1&offset=${first.body.total - 1}`);
    const { body } = await getRoute('/v1/eras');
    expect(body.settledHistoryFrom).toBe(oldest.body.items[0].number);
  });

  it('counts every settled era in `total`, not just the ones on this page', async () => {
    const whole = await getRoute('/v1/eras', {}, '?limit=200');
    const oneRow = await getRoute('/v1/eras', {}, '?limit=1');
    expect(oneRow.body.items).toHaveLength(1);
    // A `total` computed from a materialised slice reports the slice.
    expect(oneRow.body.total).toBe(whole.body.total);
    // The era in progress is the newest entry, so it heads the list.
    expect(oneRow.body.items[0].settled).toBe(false);
    expect(oneRow.body.items[0].era).toBe(Number((await chainQuery().agents.eraNumber()).toString()));
  });
});

describe('follower shutdown', () => {
  it('fails a pending waiter on stop rather than resolving it', async () => {
    // `waitForBlock` is what the tests above use to know the index reached a
    // block. Resolving it on shutdown would report "reached" for a block the
    // indexer never saw, turning a stopped follower into a green test.
    const scratchStore = IndexerStore.open(':memory:');
    const scratch = new ChainIndexer(api, scratchStore, { backfillDepth: 0 });
    try {
      const pending = scratch.waitForBlock(Number.MAX_SAFE_INTEGER, 60_000);
      await scratch.stop();
      await expect(pending).rejects.toThrow(/stopped/i);
    } finally {
      scratchStore.close();
    }
  });
});

describe('emissions', () => {
  it('reports emission parameters and settlement state from the runtime', async () => {
    const { status, body } = await getRoute('/v1/emissions');
    expect(status).toBe(200);

    const consts = chainConsts().emissions as unknown as Record<string, { toString(): string }>;
    expect(body.parameters.eraDurationBlocks).toBe(Number(consts.eraDuration!.toString()));
    expect(body.parameters.initialEmissionPerEraPlancks).toBe(consts.initialEmissionsPerEra!.toString());
    expect(body.parameters.floorEmissionPerEraPlancks).toBe(consts.floorEmissionPerEra!.toString());
    expect(body.parameters.velocityBonusBps).toBe(Number(consts.velocityBonusBps!.toString()));
    expect(body.parameters.minQualifyingVolumePlancks).toBe(consts.minQualifyingVol!.toString());

    expect(body.lastEraEmissionPlancks).toBe((await chainQuery().emissions.lastEraEmission()).toString());
    const lastSettled = await chainQuery().emissions.lastSettledEra();
    expect(body.lastSettledEra).toBe(lastSettled.isSome ? Number(lastSettled.unwrap().toString()) : null);
  });

  it('reports issuance against the hard supply cap', async () => {
    const { status, body } = await getRoute('/v1/emissions/supply');
    expect(status).toBe(200);

    const cap = (chainConsts().emissions.supplyCap as unknown as { toString(): string }).toString();
    const issuance = (await chainQuery().balances.totalIssuance()).toString();

    expect(body.capPlancks).toBe(cap);
    expect(body.totalIssuancePlancks).toBe(issuance);
    // The cap is absolute: remaining headroom is cap - issuance, exactly, in
    // bigint. Reporting it any other way would misstate the chain's one
    // inviolable economic bound.
    expect(body.remainingPlancks).toBe((BigInt(cap) - BigInt(issuance)).toString());
    expect(BigInt(body.remainingPlancks) > 0n).toBe(true);
    expect(body.tokenSymbol).toBe('CMN');
    expect(body.tokenDecimals).toBe(12);
  });
});

describe('activity', () => {
  it('feeds the seeded heartbeat and agreement, newest first, and nothing else', async () => {
    const { status, body } = await getRoute('/v1/activity', {}, `?agent=${alice.address}&limit=200`);
    expect(status).toBe(200);
    expect(body.agent).toBe(alice.address);
    expect(body.kind).toBeNull();
    expect(body.historyFrom).toBe(store.earliestBlockNumber());

    const heartbeat = body.items.find(
      (item: any) => item.kind === 'heartbeat' && item.blockNumber === seeded.heartbeatBlock,
    );
    expect(heartbeat, 'the seeded heartbeat must appear in the feed').toBeTruthy();
    expect(heartbeat.agents).toContain(alice.address);

    const created = body.items.find(
      (item: any) =>
        item.kind === 'agreement' &&
        item.method === 'AgreementCreated' &&
        item.blockNumber === seeded.escrowBlock &&
        item.data.seq === seeded.seq,
    );
    expect(created, 'the seeded AgreementCreated must appear in the feed').toBeTruthy();
    expect(created.agents).toEqual(expect.arrayContaining([seeded.buyer, seeded.provider]));

    // The transfer is Alice's too, but it is not agent activity.
    for (const item of body.items) {
      expect(`${item.section}.${item.method}`).not.toMatch(/^(balances|system|transactionPayment)\./);
      expect(item.agents).toContain(alice.address);
    }

    // Newest first, block then position.
    for (let i = 1; i < body.items.length; i += 1) {
      const [prev, next] = [body.items[i - 1], body.items[i]];
      expect(prev.blockNumber * 1e6 + prev.index).toBeGreaterThan(next.blockNumber * 1e6 + next.index);
    }

    // Every row is the indexed event itself, with that block's own clock.
    const direct = await getRoute('/v1/events/:id', { id: created.id });
    expect(direct.body.data).toEqual(created.data);
    const block = await getRoute('/v1/blocks/:id', { id: created.blockNumber });
    expect(created.timestampMs).toBe(block.body.timestampMs);
  });

  it('narrows to one kind and refuses one it does not know', async () => {
    const { body } = await getRoute('/v1/activity', {}, `?agent=${alice.address}&kind=heartbeat`);
    expect(body.total).toBeGreaterThanOrEqual(1);
    for (const item of body.items) expect(item.kind).toBe('heartbeat');

    const bad = await fetch(`${baseUrl}/v1/activity?kind=heartbeats`);
    expect(bad.status).toBe(400);
  });

  it('answers ?agent= written with a foreign SS58 prefix', async () => {
    const foreign = encodeAddress(decodeAddress(alice.address), 0);
    const { body } = await getRoute('/v1/activity', {}, `?agent=${foreign}&kind=heartbeat`);
    expect(body.agent).toBe(alice.address);
    expect(body.total).toBeGreaterThanOrEqual(1);
  });
});

describe('endpoint coverage', () => {
  it('exercised every one of the 25 endpoints against the live node', () => {
    const declared = ROUTES.map((r) => r.path).sort();
    expect([...exercised].sort()).toEqual(declared);
  });
});
