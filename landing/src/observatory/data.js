// The data layer for /observatory.
//
// Three rules hold for every figure on the page, and they are enforced here
// rather than in each instrument:
//
//   1. Provenance. Every response is wrapped in a record carrying the endpoint
//      it came from, the UTC instant of the fetch, the raw bytes received and
//      a URL that re-opens the request where one exists. Instruments show the
//      record, not a number they derived somewhere.
//   2. No stale values. A failed request is a record with `ok: false` and the
//      reason. It is handed to the instrument the same way a success is, so
//      the instrument replaces its figure with "unavailable" rather than
//      leaving the last one standing.
//   3. No guessed fields. `field()` throws on a missing key instead of
//      defaulting; a missing field becomes an "unavailable" reading.
//
// Live chain events (new heads, finalized heads) arrive over one WebSocket
// shared by the whole page. JSON-RPC calls ride the same socket. Everything
// pauses while the tab is hidden.

import { storageKey } from './scale.js';

export const API_ORIGIN = 'https://api.scalarnet.io';
export const RPC_URL = 'wss://rpc.scalarnet.io';
export const EXPLORER_ORIGIN = 'https://explorer.scalarnet.io';
export const GITHUB_COMMITS_URL =
  'https://api.github.com/repos/tejaspatil1936/scalar-commons-v4/commits?sha=master&per_page=1';

/** The indexer's `MAX_LIMIT` (indexer/src/pagination.ts). */
export const INDEXER_MAX_LIMIT = 200;
export const FETCH_TIMEOUT_MS = 8_000;

/** The plain storage values read raw off the node, located by their names (see scale.js). */
export const STORAGE_KEYS = {
  sessionValidators: storageKey('Session', 'Validators'),
  sessionQueuedKeys: storageKey('Session', 'QueuedKeys'),
  babeAuthorities: storageKey('Babe', 'Authorities'),
};

const rpc = (method, params, label, readings = []) => ({ kind: 'rpc', method, params, label, readings });
const api = (path, readings = []) => ({ kind: 'api', path, readings });
const events = (section, method, readings = []) =>
  api(`/v1/events?section=${section}&method=${method}&limit=${INDEXER_MAX_LIMIT}`, readings);

/**
 * Where each reading comes from. `readings` are the `data-reading` keys a
 * source feeds; the test suite checks every reading on the page has one and
 * every indexer path exists in indexer/src/api.ts.
 */
export const SOURCES = {
  // Live, pushed by the node.
  newHeads: {
    kind: 'subscription',
    method: 'chain_subscribeNewHeads',
    unsubscribe: 'chain_unsubscribeNewHeads',
    label: 'chain_subscribeNewHeads',
    readings: ['bestBlock', 'networkStatus', 'heroHeight'],
  },
  finalizedHeads: {
    kind: 'subscription',
    method: 'chain_subscribeFinalizedHeads',
    unsubscribe: 'chain_unsubscribeFinalizedHeads',
    label: 'chain_subscribeFinalizedHeads',
    readings: ['finalizedBlock', 'finalityLag', 'networkStatus'],
  },

  // Chain position and identity.
  status: api('/v1/status', ['bestBlock', 'finalizedBlock', 'finalityLag', 'specVersion', 'networkStatus', 'heroHeight']),
  blocks: api(`/v1/blocks?limit=${INDEXER_MAX_LIMIT}`, ['blocksPerMinute', 'blockTime']),
  // The era dial draws the era and its settlement block from this read; the countdown is its reading.
  era: api('/v1/eras/current', ['eraCountdown']),
  // The era in progress plus 13 settled ones: 12 whole eras need 13 boundaries.
  eras: api('/v1/eras?limit=14', ['agreementsCumulative']),
  // Every settled era the index holds (read whole, in pages), for the running total of CMN issued to agents.
  erasAll: api(`/v1/eras?limit=${INDEXER_MAX_LIMIT}`, ['agentPayouts', 'emissionCumulative']),
  // Total issuance from every source against the hard cap: context for the agent figure, never the figure itself.
  supply: api('/v1/emissions/supply', ['emissionCumulative']),
  upgrades: events('system', 'CodeUpdated', ['lastUpgrade']),
  genesis: rpc('chain_getBlockHash', [0], 'chain_getBlockHash(0)', ['genesis']),

  // Agents and their contracts.
  // The agent field draws one cell per row (or per bucket of rows); the hero's
  // figure is the index's own count, and the operator-run figure counts the
  // rows whose on-chain name carries the `swarm-` prefix.
  agents: api(`/v1/agents?limit=${INDEXER_MAX_LIMIT}`, ['agents', 'operatorRun']),
  // The open agreements: which agents are working or in dispute, and the network graph's lines.
  escrows: api(`/v1/escrows?limit=${INDEXER_MAX_LIMIT}`, []),
  escrowStats: api('/v1/escrows/stats', ['activeAgreements', 'openDisputes']),
  agreementsCreated: events('escrow', 'AgreementCreated', ['agreementsCumulative']),
  // Messaging (spec 309 and later). One read feeds both figures: the running
  // total comes from the response's `total`, the hour from the items at or
  // after the block of one hour ago — the same shape every other hour figure
  // uses. On a chain below 309 the `messages` pallet does not exist, the read
  // returns nothing, and the gate below hides both rather than showing zero.
  messagesSent: events('messages', 'MessageSent', ['messagesSent', 'hourMessages']),
  // The recently settled agreements: the network graph's dashed lines, and the
  // last hour's settlements.
  deliveriesConfirmed: events('escrow', 'DeliveryConfirmed', ['hourSettled']),
  // The rest of the last hour's activity, each read back to the block of one hour ago.
  oracleAnswers: events('oracle', 'OracleResponseSubmitted', ['hourOracle']),
  oracleBatches: events('oracle', 'BatchResponseSubmitted', ['hourOracle']),
  disputesOpened: events('escrow', 'DisputeOpened', ['hourDisputes']),
  // Also the agent field's "recently slashed" cells.
  slashes: events('agents', 'SlashExecuted', ['hourSlashes']),
  registrations: events('agents', 'AgentRegistered', ['agentsOverTime']),
  unstakes: events('agents', 'UnstakeCompleted', ['agentsOverTime']),

  // Validators.
  validators: rpc(
    'state_getStorage',
    [STORAGE_KEYS.sessionValidators],
    'state_getStorage(Session.Validators)',
    ['validators', 'networkStatus'],
  ),
  queuedKeys: rpc('state_getStorage', [STORAGE_KEYS.sessionQueuedKeys], 'state_getStorage(Session.QueuedKeys)'),
  babeAuthorities: rpc('state_getStorage', [STORAGE_KEYS.babeAuthorities], 'state_getStorage(Babe.Authorities)'),
  health: rpc('system_health', [], 'system_health', ['nodeHealth']),
  grandpa: rpc('grandpa_roundState', [], 'grandpa_roundState', []),

  // The repository.
  lastMerge: { kind: 'github', url: GITHUB_COMMITS_URL, readings: ['lastMerge'] },
};

/**
 * The two reads the hero makes for each block as it arrives, to learn how
 * many extrinsics it carried and the chain's own timestamp for it: the hash
 * at a height, then the block by hash. Neither feeds a reading slot of its
 * own; both are shown through the river and its provenance line.
 */
export const blockHashSource = (number) =>
  rpc('chain_getBlockHash', [number], `chain_getBlockHash(${number})`);
export const blockSource = (hash) => rpc('chain_getBlock', [hash], `chain_getBlock(${String(hash).slice(0, 10)}…)`);
// Every event one finalized block emitted, in emission order: the one read /pulse makes per block, so each animation is a real event and none is a poll's replay.
export const blockEventsSource = (number) => api(`/v1/blocks/${number}/events?limit=${INDEXER_MAX_LIMIT}`);

// ── pure helpers ─────────────────────────────────────────────────────────────

/**
 * Reads a dotted path out of a response, refusing to guess at a missing one.
 * A field that is not there is a decode mismatch, and it must surface as an
 * unavailable reading, not as a zero.
 */
export function field(value, path) {
  let current = value;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object' || !(key in current)) {
      throw new Error(`response has no ${path}`);
    }
    current = current[key];
  }
  if (current === undefined || current === null) {
    throw new Error(`response has no ${path}`);
  }
  return current;
}

/**
 * Counts newest-first events at or after `startBlock`. `reachedStart` says the
 * page went back past the start, so there is nothing older left to count.
 */
export function countSince(items, startBlock) {
  let count = 0;
  for (const item of items) {
    if (item.blockNumber < startBlock) return { count, reachedStart: true };
    count += 1;
  }
  return { count, reachedStart: false };
}

/** The same source, one page further on. */
export function pageOf(source, offset) {
  return `${source.path}&offset=${offset}`;
}

export function labelOf(source, path = source.path) {
  if (source.kind === 'api') return `${API_ORIGIN}${path}`.replace('https://', '');
  if (source.kind === 'github') return source.url.replace('https://', '').replace(/\?.*$/, '');
  return `${RPC_URL.replace('wss://', '')} · ${source.label}`;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/**
 * One HTTP request, and everything the page needs to show where its answer
 * came from. Never throws; a failure is a record with `ok: false`.
 */
export async function fetchHttp(source, path = source.path) {
  const at = new Date();
  const url = source.kind === 'api' ? `${API_ORIGIN}${path}` : source.url;
  const base = { at, label: labelOf(source, path), link: url, source };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { ...base, ok: false, raw, error: `HTTP ${response.status}, response is not JSON` };
    }
    if (!response.ok) {
      const detail = typeof data?.error === 'string' ? data.error : data?.message;
      return { ...base, ok: false, raw, error: `HTTP ${response.status}${detail ? `: ${detail}` : ''}` };
    }
    return { ...base, ok: true, raw, data };
  } catch (error) {
    const reason = error.name === 'AbortError' ? `no response within ${FETCH_TIMEOUT_MS / 1000} s` : error.message;
    return { ...base, ok: false, raw: null, error: `request failed: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every page of a list endpoint up to `maxPages`, concatenated newest-first.
 * The result says whether it holds the whole list (`complete`), so a caller
 * can label a count as a floor when the cap cut it short.
 *
 * A newest-first event list read only back to a block: `source.stopBelow()`
 * returns that block, and paging stops at the first page that reaches below
 * it. `since` is the block, and `reachedStart` says the items hold everything
 * from it to now (the list went past it, or ended); when the page cap stops
 * the read first, `reachedStart` is false and a count from it is a floor.
 */
export async function fetchAllPages(source, { maxPages = 5, fetcher = fetchHttp } = {}) {
  const items = [];
  let first = null;
  let total = 0;
  const since = typeof source.stopBelow === 'function' ? source.stopBelow() : null;
  const bounded = Number.isFinite(since);
  const extra = (reachedStart) => (bounded ? { since, reachedStart } : {});
  for (let page = 0; page < maxPages; page += 1) {
    const record = await fetcher(source, page === 0 ? source.path : pageOf(source, items.length));
    first ??= record;
    if (!record.ok) return { ...record, items, complete: false, ...extra(false) };
    const pageItems = field(record.data, 'items');
    total = field(record.data, 'total');
    items.push(...pageItems);
    if (items.length >= total || pageItems.length === 0) {
      return { ...first, items, total, complete: true, pages: page + 1, ...extra(true) };
    }
    if (bounded && field(pageItems[pageItems.length - 1], 'blockNumber') < since) {
      return { ...first, items, total, complete: false, pages: page + 1, ...extra(true) };
    }
  }
  return { ...first, items, total, complete: false, pages: maxPages, ...extra(false) };
}

// ── the shared WebSocket ─────────────────────────────────────────────────────

/** A minimal event emitter. */
export class Emitter {
  constructor() {
    this.listeners = new Map();
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        fn(payload);
      } catch (error) {
        console.error(error);
      }
    }
  }
}

/**
 * One JSON-RPC WebSocket for the page: calls and subscriptions share it, it
 * re-subscribes after a reconnect, and it is closed while the tab is hidden.
 *
 * One standing socket per viewer counts against the edge's per-address
 * connection limit (20), which a room of phones behind one NAT shares. The
 * hero falls back to polling the indexer if the socket cannot be opened.
 */
export class RpcSocket extends Emitter {
  constructor(url = RPC_URL, { WebSocketImpl = globalThis.WebSocket } = {}) {
    super();
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.socket = null;
    this.opening = null;
    this.state = 'idle';
    this.paused = false;
    this.attempts = 0;
    this.nextId = 1;
    this.pending = new Map();
    this.subscriptions = new Map(); // local key -> { source, handler, remoteId }
    this.retryTimer = null;
    this.subscriptionCounter = 0;
  }

  setState(state, detail) {
    this.state = state;
    this.emit('state', { state, detail, attempts: this.attempts });
  }

  /** Opens the socket if needed; resolves once it is open. */
  connect() {
    if (this.socket && this.socket.readyState === 1) return Promise.resolve();
    if (this.opening) return this.opening;
    if (this.paused) return Promise.reject(new Error('socket paused while the tab is hidden'));
    this.setState('connecting');
    this.opening = new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new this.WebSocketImpl(this.url);
      } catch (error) {
        this.opening = null;
        this.setState('failed', error.message);
        reject(error);
        return;
      }
      const timer = setTimeout(() => {
        socket.close();
        settle(new Error(`no connection within ${FETCH_TIMEOUT_MS / 1000} s`));
      }, FETCH_TIMEOUT_MS);
      let settled = false;
      const settle = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.opening = null;
        if (error) {
          this.setState('failed', error.message);
          reject(error);
        } else {
          this.attempts = 0;
          this.setState('open');
          resolve();
        }
      };
      socket.onopen = () => {
        this.socket = socket;
        settle(null);
        for (const [key, sub] of this.subscriptions) this.sendSubscribe(key, sub);
      };
      socket.onmessage = (event) => this.receive(String(event.data));
      socket.onerror = () => settle(new Error('WebSocket connection failed'));
      socket.onclose = (event) => {
        settle(new Error(`WebSocket closed (code ${event.code})`));
        if (this.socket === socket) this.socket = null;
        this.failPending(new Error(`WebSocket closed (code ${event.code})`));
        for (const sub of this.subscriptions.values()) sub.remoteId = null;
        if (!this.paused) {
          this.setState('closed', `code ${event.code}`);
          this.scheduleReconnect();
        }
      };
    });
    return this.opening;
  }

  scheduleReconnect() {
    if (this.retryTimer || this.paused) return;
    this.attempts += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(5, this.attempts - 1));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  failPending(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  receive(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(`RPC error ${message.error.code}: ${message.error.message}`));
      else resolve({ raw, data: message });
      return;
    }
    if (message.method && message.params && message.params.subscription !== undefined) {
      for (const sub of this.subscriptions.values()) {
        if (sub.remoteId === message.params.subscription) {
          sub.handler({
            ok: true,
            at: new Date(),
            label: labelOf(sub.source),
            link: null,
            raw,
            data: message.params.result,
            source: sub.source,
          });
        }
      }
    }
  }

  send(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no response within ${FETCH_TIMEOUT_MS / 1000} s`));
      }, FETCH_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify({ id, jsonrpc: '2.0', method, params }));
    return promise;
  }

  /** One JSON-RPC call, as a provenance record. Never throws. */
  async call(source) {
    const at = new Date();
    const base = { at, label: labelOf(source), link: null, source };
    try {
      await this.connect();
      const { raw, data } = await this.send(source.method, source.params);
      return { ...base, ok: true, raw, data };
    } catch (error) {
      return { ...base, ok: false, raw: null, error: `request failed: ${error.message}` };
    }
  }

  sendSubscribe(key, sub) {
    if (!this.socket || this.socket.readyState !== 1 || sub.remoteId) return;
    this.send(sub.source.method, sub.source.params ?? [])
      .then(({ data }) => {
        if (this.subscriptions.get(key) === sub) sub.remoteId = data.result;
      })
      .catch((error) => this.emit('subscription-error', { source: sub.source, error }));
  }

  /** Subscribes; the handler receives one record per notification. Returns an unsubscribe. */
  subscribe(source, handler) {
    this.subscriptionCounter += 1;
    const key = this.subscriptionCounter;
    const sub = { source, handler, remoteId: null };
    this.subscriptions.set(key, sub);
    this.connect()
      .then(() => this.sendSubscribe(key, sub))
      .catch((error) => this.emit('subscription-error', { source, error }));
    return () => {
      this.subscriptions.delete(key);
      if (sub.remoteId && this.socket?.readyState === 1) {
        this.send(source.unsubscribe, [sub.remoteId]).catch(() => {});
      }
    };
  }

  /** Closes the socket without reconnecting; subscriptions resume on `resume()`. */
  pause() {
    this.paused = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close();
    this.setState('paused');
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.attempts = 0;
    if (this.subscriptions.size > 0 || this.pending.size > 0) this.connect().catch(() => {});
  }
}

// ── polling ──────────────────────────────────────────────────────────────────

/**
 * Deduplicated polling: several instruments may watch the same source, and it
 * is fetched once per interval and handed to all of them. Paused while the
 * tab is hidden; resumed with an immediate refresh.
 */
export class Scheduler {
  constructor(fetcher) {
    this.fetcher = fetcher;
    this.watches = new Map(); // name -> { source, handlers: Map<fn, interval>, timer, inFlight, latest }
    this.paused = false;
  }

  watch(name, source, handler, intervalMs) {
    let entry = this.watches.get(name);
    if (!entry) {
      entry = { source, handlers: new Map(), timer: null, inFlight: null, latest: null };
      this.watches.set(name, entry);
    }
    entry.handlers.set(handler, intervalMs);
    if (entry.latest) handler(entry.latest);
    if (!entry.inFlight && !entry.timer) this.run(name);
    return () => {
      entry.handlers.delete(handler);
      if (entry.handlers.size === 0) {
        clearTimeout(entry.timer);
        this.watches.delete(name);
      }
    };
  }

  interval(entry) {
    return Math.min(...entry.handlers.values());
  }

  async run(name) {
    const entry = this.watches.get(name);
    if (!entry || this.paused) return;
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.inFlight = this.fetcher(entry.source);
    const record = await entry.inFlight;
    entry.inFlight = null;
    entry.latest = record;
    for (const handler of entry.handlers.keys()) {
      try {
        handler(record);
      } catch (error) {
        console.error(error);
      }
    }
    if (this.watches.get(name) === entry && !this.paused) {
      entry.timer = setTimeout(() => this.run(name), this.interval(entry));
    }
  }

  /** Re-fetches a source now, ahead of its interval. */
  refresh(name) {
    const entry = this.watches.get(name);
    if (entry && !entry.inFlight) this.run(name);
  }

  latest(name) {
    return this.watches.get(name)?.latest ?? null;
  }

  pause() {
    this.paused = true;
    for (const entry of this.watches.values()) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    for (const name of this.watches.keys()) this.run(name);
  }
}
