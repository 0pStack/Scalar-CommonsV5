/**
 * The versioned REST surface.
 *
 * Twenty-five endpoints under `/v1`, covering blocks, extrinsics, events,
 * accounts, agents, escrows, eras, emissions and the agent-activity feed. Everything they return is
 * either read live from the node or read from the index built out of finalized
 * blocks — there are no fixtures behind any of them.
 *
 * The path prefix is a promise: `/v1` responses keep their shape. Chain events
 * change with the runtime, so a shape change here means a new prefix, not a
 * quiet edit — the SDK and the landing page read these responses.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { ApiPromise } from '@polkadot/api';
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';

import type { IndexerConfig } from './config.ts';
import type { ChainConnection } from './chain.ts';
import type { ChainIndexer } from './indexer.ts';
import { UnknownActivityKindError, activityItem, parseActivityKind, sourcesFor } from './activity.ts';
import { InvalidQueryError, parseOptionalInteger, parsePage, type Page } from './pagination.ts';
import type { IndexerStore, PageResult } from './store.ts';
import {
  MAX_LIVE_SCAN,
  fetchAccountState,
  fetchAgent,
  fetchAgents,
  fetchChainStatus,
  fetchCurrentEra,
  fetchEmissions,
  fetchEscrow,
  fetchEscrows,
  fetchEscrowStats,
  fetchSupply,
  type EraState,
  type LiveList,
} from './chainState.ts';

/** An error that maps onto an HTTP status rather than a 500. */
class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const notFound = (what: string) => new HttpError(404, `${what} not found`);

export interface ApiDependencies {
  readonly store: IndexerStore;
  readonly api: ApiPromise;
  readonly chain: ChainConnection;
  readonly indexer: ChainIndexer;
  readonly config: IndexerConfig;
}

/** Everything a handler needs to answer one request. */
interface RequestContext extends ApiDependencies {
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  readonly page: Page;
}

export interface RouteDefinition {
  /** Stable identifier for the endpoint, used in docs and coverage checks. */
  readonly name: string;
  /** Path template; `:name` segments become `params`. */
  readonly path: string;
  readonly summary: string;
  readonly handler: (context: RequestContext) => Promise<unknown>;
}

/** Wraps a page of rows in the envelope every list endpoint shares. */
function paged<T>(result: PageResult<T>, page: Page): Record<string, unknown> {
  return { total: result.total, limit: page.limit, offset: page.offset, items: result.items };
}

/** Applies a page window to a list already read whole from chain state. */
function pageArray<T>(items: T[], page: Page): Record<string, unknown> {
  return {
    total: items.length,
    limit: page.limit,
    offset: page.offset,
    items: items.slice(page.offset, page.offset + page.limit),
  };
}

/**
 * Envelope for a list read live off the node, whose window it already applied.
 *
 * Carries `truncated` beside the usual fields: live enumeration is bounded so
 * one request cannot sweep an unbounded map on the validator, and a caller has
 * to be able to tell a complete answer from one the ceiling cut short.
 */
function pagedLive<T>(list: LiveList<T>, page: Page): Record<string, unknown> {
  return {
    total: list.total,
    limit: page.limit,
    offset: page.offset,
    items: list.items,
    truncated: list.truncated,
    scanLimit: MAX_LIVE_SCAN,
  };
}

/** As {@link pagedLive}, for a live list the window still has to be cut from. */
function pageArrayLive<T>(list: LiveList<T>, page: Page): Record<string, unknown> {
  return { ...pageArray(list.items, page), truncated: list.truncated, scanLimit: MAX_LIVE_SCAN };
}

/**
 * Validates an SS58 address and re-encodes it in this chain's format.
 *
 * The same account written with another chain's prefix must not read as a
 * different account, or per-address history silently splits in two.
 */
function normalizeAddress(raw: string, ss58Format: number): string {
  try {
    return encodeAddress(decodeAddress(raw), ss58Format);
  } catch (error) {
    throw new HttpError(400, `not a valid SS58 address: ${raw}`);
  }
}

/** Reads an optional string filter from the query string. */
function optionalString(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  return value === null || value === '' ? undefined : value;
}

/** Reads an optional address filter, in this chain's SS58 format. */
function optionalAddress(context: RequestContext, name: string): string | undefined {
  const raw = optionalString(context.query, name);
  return raw === undefined ? undefined : normalizeAddress(raw, context.chain.ss58Format);
}

/** Resolves an agent, or 404s — used by every agent-scoped route. */
async function requireAgent(context: RequestContext, address: string) {
  const agent = await fetchAgent(context.api, address);
  if (agent === null) {
    throw notFound(`agent ${address}`);
  }
  return agent;
}

/** One settled era, exactly as the pallet reported it at settlement. */
export interface SettledEra {
  era: number;
  settled: true;
  totalEmissionPlancks: string;
  totalWeight: string;
  settledAtBlock: number;
}

/**
 * Reads one field of a decoded event, refusing to guess at a missing one.
 *
 * Metadata may hand a field back under either spelling, and an unnamed field
 * arrives as `arg0`. Any of those is a decode mismatch, and a decode mismatch
 * must surface as a failure — on a supply-capped chain "this era emitted 0" is
 * read as a fact about issuance, not as "the field could not be found".
 */
function requireField(data: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const value = data[name];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  throw new HttpError(
    500,
    `emissions.EraSettled event carries no ${names[0]} field (saw: ${Object.keys(data).join(', ') || 'nothing'})`,
  );
}

/** Shapes an indexed `emissions.EraSettled` event into a settled-era entry. */
export function settledEraFromEvent(event: { blockNumber: number; data: unknown }): SettledEra {
  const data = (event.data ?? {}) as Record<string, unknown>;
  return {
    era: Number(requireField(data, 'era')),
    settled: true,
    // Emission and weight are u128-scale, so they stay decimal strings.
    totalEmissionPlancks: String(requireField(data, 'total_emission', 'totalEmission')),
    totalWeight: String(requireField(data, 'total_weight', 'totalWeight')),
    settledAtBlock: event.blockNumber,
  };
}

/**
 * One entry of `/v1/eras`, with the same keys whether it is settled or not.
 *
 * A settled era and the era in progress describe different things, but a caller
 * paging the list should not have to branch on `settled` to know which fields
 * exist. The fields that do not apply are present and null.
 */
function eraEntry(settled?: SettledEra, current?: EraState): Record<string, unknown> {
  return {
    era: settled?.era ?? current!.era,
    settled: settled !== undefined,
    totalEmissionPlancks: settled?.totalEmissionPlancks ?? null,
    totalWeight: settled?.totalWeight ?? null,
    settledAtBlock: settled?.settledAtBlock ?? null,
    startBlock: current?.startBlock ?? null,
    durationBlocks: current?.durationBlocks ?? null,
    blocksElapsed: current?.blocksElapsed ?? null,
    blocksRemaining: current?.blocksRemaining ?? null,
    dueForSettlement: current?.dueForSettlement ?? null,
  };
}

export const ROUTES: readonly RouteDefinition[] = [
  {
    name: 'status',
    path: '/v1/status',
    summary: 'Chain identity, head position, and how far the indexer has followed it.',
    handler: async (context) => ({
      chain: await fetchChainStatus(context.api, context.chain),
      indexer: {
        syncedHeight: context.indexer.syncedHeight,
        indexedBlocks: context.indexer.indexedBlocks,
        backfillDepth: context.config.backfillDepth,
      },
      api: { version: 'v1', endpoints: ROUTES.length },
    }),
  },
  {
    name: 'blocks.list',
    path: '/v1/blocks',
    summary: 'Indexed finalized blocks, newest first.',
    handler: async (context) => paged(context.store.listBlocks(context.page), context.page),
  },
  {
    name: 'blocks.get',
    path: '/v1/blocks/:id',
    summary: 'One block by height or block hash.',
    handler: async (context) => {
      const block = context.store.getBlock(context.params.id!);
      if (block === null) throw notFound(`block ${context.params.id}`);
      return block;
    },
  },
  {
    name: 'blocks.extrinsics',
    path: '/v1/blocks/:id/extrinsics',
    summary: 'Extrinsics in one block, in execution order.',
    handler: async (context) => {
      const block = context.store.getBlock(context.params.id!);
      if (block === null) throw notFound(`block ${context.params.id}`);
      return paged(
        context.store.listExtrinsics({ ...context.page, blockNumber: block.number, order: 'asc' }),
        context.page,
      );
    },
  },
  {
    name: 'blocks.events',
    path: '/v1/blocks/:id/events',
    summary: 'Events emitted in one block, in emission order.',
    handler: async (context) => {
      const block = context.store.getBlock(context.params.id!);
      if (block === null) throw notFound(`block ${context.params.id}`);
      return paged(
        context.store.listEvents({ ...context.page, blockNumber: block.number, order: 'asc' }),
        context.page,
      );
    },
  },
  {
    name: 'extrinsics.list',
    path: '/v1/extrinsics',
    summary: 'Indexed extrinsics, filterable by signer, pallet, call and block.',
    handler: async (context) =>
      paged(
        context.store.listExtrinsics({
          ...context.page,
          blockNumber: parseOptionalInteger(context.query, 'blockNumber'),
          // Through `normalizeAddress` like every other address filter: the
          // index holds one spelling per account, so a foreign SS58 prefix must
          // find that history rather than answer 200 with an empty list.
          signer: optionalAddress(context, 'signer'),
          section: optionalString(context.query, 'section'),
          method: optionalString(context.query, 'method'),
        }),
        context.page,
      ),
  },
  {
    name: 'extrinsics.get',
    path: '/v1/extrinsics/:id',
    summary: 'One extrinsic by `<block>-<index>`, with its decoded call and outcome.',
    handler: async (context) => {
      const extrinsic = context.store.getExtrinsic(context.params.id!);
      if (extrinsic === null) throw notFound(`extrinsic ${context.params.id}`);
      return extrinsic;
    },
  },
  {
    name: 'extrinsics.events',
    path: '/v1/extrinsics/:id/events',
    summary: 'Events emitted by one extrinsic.',
    handler: async (context) => {
      const extrinsic = context.store.getExtrinsic(context.params.id!);
      if (extrinsic === null) throw notFound(`extrinsic ${context.params.id}`);
      return paged(
        context.store.listEvents({ ...context.page, extrinsicId: extrinsic.id, order: 'asc' }),
        context.page,
      );
    },
  },
  {
    name: 'events.list',
    path: '/v1/events',
    summary: 'Indexed events, filterable by pallet, method, block and account.',
    handler: async (context) =>
      paged(
        context.store.listEvents({
          ...context.page,
          blockNumber: parseOptionalInteger(context.query, 'blockNumber'),
          section: optionalString(context.query, 'section'),
          method: optionalString(context.query, 'method'),
          account: optionalAddress(context, 'account'),
        }),
        context.page,
      ),
  },
  {
    name: 'events.get',
    path: '/v1/events/:id',
    summary: 'One event by `<block>-<index>`.',
    handler: async (context) => {
      const event = context.store.getEvent(context.params.id!);
      if (event === null) throw notFound(`event ${context.params.id}`);
      return event;
    },
  },
  {
    name: 'accounts.list',
    path: '/v1/accounts',
    summary: 'Accounts the indexer has observed on chain, most recently active first.',
    handler: async (context) => paged(context.store.listAccounts(context.page), context.page),
  },
  {
    name: 'accounts.get',
    path: '/v1/accounts/:address',
    summary: 'Live balance and nonce for an account, plus its indexed activity.',
    handler: async (context) => {
      const address = normalizeAddress(context.params.address!, context.chain.ss58Format);
      const state = await fetchAccountState(context.api, address);
      const indexed = context.store.getAccount(address);
      return {
        ...state,
        activity: {
          firstSeenBlock: indexed?.firstSeenBlock ?? null,
          lastSeenBlock: indexed?.lastSeenBlock ?? null,
          eventCount: indexed?.eventCount ?? 0,
          extrinsicCount: indexed?.extrinsicCount ?? 0,
        },
      };
    },
  },
  {
    name: 'accounts.extrinsics',
    path: '/v1/accounts/:address/extrinsics',
    summary: 'Extrinsics signed by an account.',
    handler: async (context) => {
      const address = normalizeAddress(context.params.address!, context.chain.ss58Format);
      return paged(context.store.listExtrinsics({ ...context.page, signer: address }), context.page);
    },
  },
  {
    name: 'agents.list',
    path: '/v1/agents',
    summary: 'Registered agents with live stake and era-scoped work counters.',
    // The window goes down to the chain reader, not applied after the fact:
    // describing an agent costs ten storage reads, so a one-row page must not
    // cost ten reads per agent registered.
    handler: async (context) => pagedLive(await fetchAgents(context.api, context.page), context.page),
  },
  {
    name: 'agents.get',
    path: '/v1/agents/:address',
    summary: 'One agent: stake, liveness, era volume and governance participation.',
    handler: async (context) => {
      const address = normalizeAddress(context.params.address!, context.chain.ss58Format);
      return requireAgent(context, address);
    },
  },
  {
    name: 'agents.events',
    path: '/v1/agents/:address/events',
    summary: 'Indexed events naming this agent, newest first.',
    handler: async (context) => {
      const address = normalizeAddress(context.params.address!, context.chain.ss58Format);
      await requireAgent(context, address);
      return paged(context.store.listEvents({ ...context.page, account: address }), context.page);
    },
  },
  {
    name: 'agents.escrows',
    path: '/v1/agents/:address/escrows',
    summary: 'Open agreements this agent is party to, on either side.',
    handler: async (context) => {
      const address = normalizeAddress(context.params.address!, context.chain.ss58Format);
      await requireAgent(context, address);
      const involved = await fetchEscrows(context.api, { party: address });
      return pageArrayLive(
        {
          ...involved,
          items: involved.items.map((agreement) => ({
            ...agreement,
            role: agreement.buyer === address ? 'buyer' : 'provider',
          })),
        },
        context.page,
      );
    },
  },
  {
    name: 'escrows.list',
    path: '/v1/escrows',
    summary: 'Open escrow agreements from live chain storage, newest first.',
    handler: async (context) => {
      const buyer = optionalString(context.query, 'buyer');
      const provider = optionalString(context.query, 'provider');
      const agreements = await fetchEscrows(context.api, {
        buyer: buyer === undefined ? undefined : normalizeAddress(buyer, context.chain.ss58Format),
        provider:
          provider === undefined ? undefined : normalizeAddress(provider, context.chain.ss58Format),
      });
      return pageArrayLive(agreements, context.page);
    },
  },
  {
    name: 'escrows.stats',
    path: '/v1/escrows/stats',
    summary: 'Aggregate escrow state: open agreements, funds reserved, pallet limits.',
    handler: async (context) => fetchEscrowStats(context.api),
  },
  {
    name: 'escrows.get',
    path: '/v1/escrows/:buyer/:provider/:seq',
    summary: 'One agreement by its (buyer, provider, seq) key.',
    handler: async (context) => {
      const buyer = normalizeAddress(context.params.buyer!, context.chain.ss58Format);
      const provider = normalizeAddress(context.params.provider!, context.chain.ss58Format);
      const rawSeq = context.params.seq!;
      if (!/^\d+$/.test(rawSeq)) {
        throw new HttpError(400, `seq must be a non-negative integer, got "${rawSeq}"`);
      }
      const agreement = await fetchEscrow(context.api, buyer, provider, Number(rawSeq));
      if (agreement === null) throw notFound(`agreement ${buyer}/${provider}/${rawSeq}`);
      return agreement;
    },
  },
  {
    name: 'eras.list',
    path: '/v1/eras',
    summary: 'Eras settled within the indexed window, plus the era in progress.',
    handler: async (context) => {
      const current = await fetchCurrentEra(context.api);
      const { limit, offset } = context.page;

      // The era in progress is always the newest: `settle_era` settles era N
      // and the agents pallet advances to N+1 before `EraSettled` is emitted,
      // so no settled entry can ever tie or outrank it. That puts it at index 0
      // of the merged list, and the settled window shifts by one behind it.
      const currentOnPage = offset === 0;
      const settledPage = context.store.listEvents({
        limit: currentOnPage ? Math.max(0, limit - 1) : limit,
        offset: currentOnPage ? 0 : offset - 1,
        section: 'emissions',
        method: 'EraSettled',
      });

      // Settled eras are reconstructed from the `EraSettled` events the indexer
      // has seen. The emission and weight totals are the ones the pallet itself
      // reported at settlement — this endpoint never recomputes them, and never
      // substitutes a zero for a total it could not find.
      const settled = settledPage.items.map((event) => eraEntry(settledEraFromEvent(event)));
      const items = currentOnPage ? [eraEntry(undefined, current), ...settled] : settled;

      return {
        // `total` counts every settled era the index holds, not the ones on
        // this page, plus the one in progress.
        total: settledPage.total + 1,
        limit,
        offset,
        items,
        // The settled history is only as deep as the index reaches; say so
        // rather than let an empty list read as "no era was ever settled". That
        // depth is the oldest block held, which grows past the startup backfill
        // window for as long as the follower runs.
        settledHistoryFrom: context.store.earliestBlockNumber(),
      };
    },
  },
  {
    name: 'eras.current',
    path: '/v1/eras/current',
    summary: 'The era in progress and whether its settlement window has opened.',
    handler: async (context) => fetchCurrentEra(context.api),
  },
  {
    name: 'emissions.get',
    path: '/v1/emissions',
    summary: 'Emission parameters and the last settlement the pallet recorded.',
    handler: async (context) => fetchEmissions(context.api),
  },
  {
    name: 'emissions.supply',
    path: '/v1/emissions/supply',
    summary: 'Total issuance against the hard supply cap, with remaining headroom.',
    handler: async (context) => fetchSupply(context.api, context.chain),
  },
  {
    name: 'activity.list',
    path: '/v1/activity',
    summary: 'Agent activity — messages, registrations, heartbeats, agreements, disputes, oracle votes, slashes — newest first; `?agent=`, `?kind=`.',
    handler: async (context) => {
      const kind = parseActivityKind(optionalString(context.query, 'kind'));
      // Deliberately not `requireAgent`: a deregistered or fully slashed agent
      // still has a history, and a messaging peer need not be registered at
      // all. The filter is an address, not a live registration check.
      const agent = optionalAddress(context, 'agent');
      const page = context.store.listActivity({ ...context.page, sources: sourcesFor(kind), account: agent });
      return {
        ...paged({ total: page.total, items: page.items.map(activityItem) }, context.page),
        agent: agent ?? null,
        kind: kind ?? null,
        // As on `/v1/eras`: the feed is only as deep as the index, and an empty
        // page must not read as "this agent has never done anything".
        historyFrom: context.store.earliestBlockNumber(),
      };
    },
  },
];

/**
 * The unversioned index served at `/`.
 *
 * Deliberately outside `ROUTES`: `/v1` is a promise about response shapes, and
 * a greeting for whoever pastes the bare host into a browser is not part of it.
 * Keeping it out also keeps `api.endpoints` on `/v1/status` counting the 25
 * endpoints a client can actually call.
 *
 * It reads nothing — no store, no node. `/` is the first thing a human tries
 * when they want to know whether the host is alive, so it must answer 200 even
 * while the chain connection is down; a pointer to the entry point is true
 * regardless of chain state. The 404 this replaces carried almost the same
 * bytes, but its status code told every monitor the host was broken.
 */
export function rootIndex(): Record<string, unknown> {
  return {
    service: 'scalar-commons-indexer',
    api: 'v1',
    status: '/v1/status',
    endpoints: ROUTES.map((route) => route.path),
  };
}

interface CompiledRoute extends RouteDefinition {
  readonly segments: string[];
}

const COMPILED: CompiledRoute[] = ROUTES.map((route) => ({
  ...route,
  segments: route.path.split('/').filter((segment) => segment.length > 0),
}));

/**
 * Percent-decodes one path segment.
 *
 * `decodeURIComponent` throws `URIError` on a malformed escape — `%` on its own
 * is enough — and that byte is entirely under an anonymous caller's control. It
 * has to become a client error here; escaping as a raw fault kills the process.
 */
function decodeSegment(segment: string, name: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, `path parameter ${name} is not valid percent-encoding: "${segment}"`);
  }
}

/**
 * Resolves a request path to a route, filling its `:params`.
 *
 * @throws {HttpError} 400 when a parameter segment is malformed percent-encoding.
 */
export function matchRoute(pathname: string): { route: RouteDefinition; params: Record<string, string> } | null {
  const parts = pathname.split('/').filter((segment) => segment.length > 0);
  for (const route of COMPILED) {
    if (route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < route.segments.length; i += 1) {
      const expected = route.segments[i]!;
      const actual = parts[i]!;
      if (expected.startsWith(':')) {
        const name = expected.slice(1);
        params[name] = decodeSegment(actual, name);
      } else if (expected !== actual) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { route, params };
    }
  }
  return null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Builds the HTTP server.
 *
 * `node:http` with a small router rather than a framework: the surface is 25
 * read-only GETs, and a framework would add more dependency than routing.
 */
export function createApiServer(dependencies: ApiDependencies): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    // Last resort. `handle` catches its own failures, so reaching here means
    // the response itself could not be written — and an unhandled rejection
    // takes the whole process down under Node's default policy, turning one
    // malformed anonymous request into an outage.
    handle(req, res, dependencies).catch((error) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      } else {
        res.end();
      }
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, dependencies: ApiDependencies): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: `method ${req.method} not allowed; this API is read-only` });
    return;
  }

  try {
    // Parsing and routing sit inside the `try` with the handler: both are fed
    // raw request bytes, and both can reject them — a URL the spec does not
    // define, or a path segment that is not valid percent-encoding.
    const url = new URL(req.url ?? '/', 'http://indexer.local');

    // Answered before routing, and without touching `dependencies`: `/` names
    // the entry point rather than refusing the request. See `rootIndex`.
    if (url.pathname === '/') {
      sendJson(res, 200, rootIndex());
      return;
    }

    const matched = matchRoute(url.pathname);
    if (matched === null) {
      sendJson(res, 404, {
        error: `no such endpoint: ${url.pathname}`,
        endpoints: ROUTES.map((route) => route.path),
      });
      return;
    }

    const page = parsePage(url.searchParams);
    const body = await matched.route.handler({
      ...dependencies,
      params: matched.params,
      query: url.searchParams,
      page,
    });
    sendJson(res, 200, body);
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message });
      return;
    }
    if (error instanceof InvalidQueryError || error instanceof UnknownActivityKindError) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    // Anything else is a genuine fault — an unreachable node, a decode failure
    // against unexpected metadata. Report it rather than answering with a
    // plausible-looking empty result.
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}
