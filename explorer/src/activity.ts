/**
 * The agent-activity feed, read from the indexer.
 *
 * Every other view in the explorer is decoded from the node at request time,
 * and each costs a bounded handful of node reads. A feed of "everything agents
 * did, newest first" cannot be built that way: it is a question about history,
 * and answering it from a node means walking blocks — an unbounded amount of
 * validator work per page view. The indexer already holds that history, and
 * already classifies it (`/v1/activity`), so this page asks the indexer once and
 * the node not at all.
 *
 * What the explorer adds is the part only a metadata-aware reader can: the
 * indexer serves event fields as plain JSON, and the explorer types each field
 * from its own connection's runtime metadata, so an account renders as a link
 * and a balance renders in tokens because the runtime says so.
 */

import type { ActivityEntry, ActivityField, ActivityView } from './types.js';

/** Rows per page. A screenful: the page refreshes, so it should stay cheap. */
export const ACTIVITY_PAGE_SIZE = 50;

const DEFAULT_TIMEOUT_MS = 10_000;

/** The indexer did not answer, or answered with an error. Rendered as 502. */
export class IndexerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexerUnavailableError';
  }
}

/** The indexer answered 200 with something that is not the activity feed. Rendered as 502. */
export class IndexerResponseError extends Error {
  constructor(message: string) {
    super(`the indexer's /v1/activity answer did not have the expected shape: ${message}`);
    this.name = 'IndexerResponseError';
  }
}

export interface ActivityQuery {
  readonly agent: string | null;
  readonly offset: number;
}

/** Where the activity page reads from. The server takes it as a dependency so it can be stood in for. */
export interface ActivitySource {
  /** Raw `/v1/activity` JSON for one page. Shaping happens in {@link toActivityView}. */
  activity(query: ActivityQuery & { readonly limit: number }): Promise<unknown>;
}

export interface IndexerClientOptions {
  /** The indexer's origin, e.g. `http://127.0.0.1:8080`. */
  readonly baseUrl: string;
  readonly timeoutMs?: number;
}

/** A read-only client for the indexer's activity endpoint. */
export function createIndexerClient(options: IndexerClientOptions): ActivitySource {
  const base = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async activity(query) {
      const params = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset) });
      if (query.agent !== null) params.set('agent', query.agent);
      const url = `${base}/v1/activity?${params.toString()}`;

      let response: Response;
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        throw new IndexerUnavailableError(
          `the indexer at ${base} did not answer: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const reason =
          body !== null && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
            ? (body as { error: string }).error
            : `HTTP ${response.status}`;
        throw new IndexerUnavailableError(`the indexer at ${base} answered ${response.status}: ${reason}`);
      }
      return body;
    },
  };
}

/** Field name → metadata type name, for one event; null when the runtime does not know the event. */
export type EventFieldTypes = (section: string, method: string) => ReadonlyMap<string, string> | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireInteger(record: Record<string, unknown>, key: string, where: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new IndexerResponseError(`${where}.${key} is not an integer`);
  }
  return value;
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new IndexerResponseError(`${where}.${key} is not a string`);
  }
  return value;
}

/**
 * Types one field from metadata.
 *
 * Only two types change how a value is shown: an account (a link) and a balance
 * (tokens, never raw plancks). A balance is only marked as one when its value is
 * the decimal string the indexer serves wide integers as; anything else is shown
 * as it came rather than coerced into a number it may not be.
 */
function typedField(name: string, value: unknown, typeName: string | undefined): ActivityField {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeName !== undefined && /AccountId/.test(typeName) && typeof value === 'string') {
    return { name, value: text, kind: 'account' };
  }
  if (typeName !== undefined && /Balance/.test(typeName) && /^\d+$/.test(text)) {
    return { name, value: text, kind: 'balance' };
  }
  return { name, value: text, kind: 'plain' };
}

/** The extrinsic index out of an indexer extrinsic id, `<block>-<index>`. */
function extrinsicIndexOf(raw: unknown, where: string): number | null {
  if (raw === null) return null;
  const match = typeof raw === 'string' ? /^\d+-(\d+)$/.exec(raw) : null;
  if (match === null) {
    throw new IndexerResponseError(`${where}.extrinsicId is not a <block>-<index> id`);
  }
  return Number(match[1]);
}

/**
 * Shapes the indexer's `/v1/activity` answer into the page's view model.
 *
 * Strict about shape: an explorer that rendered a half-understood answer as a
 * feed would show a reader activity that is not what the index holds. Order is
 * kept exactly as the indexer served it — newest first is the indexer's
 * guarantee, and re-sorting here could only disagree with it.
 */
export function toActivityView(raw: unknown, fieldTypes: EventFieldTypes, query: ActivityQuery): ActivityView {
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    throw new IndexerResponseError('no items list');
  }
  const total = requireInteger(raw, 'total', 'feed');
  const limit = requireInteger(raw, 'limit', 'feed');
  const historyFrom = raw.historyFrom === null ? null : requireInteger(raw, 'historyFrom', 'feed');

  const entries = raw.items.map((item, position): ActivityEntry => {
    const where = `items[${position}]`;
    if (!isRecord(item)) throw new IndexerResponseError(`${where} is not an object`);
    const section = requireString(item, 'section', where);
    const method = requireString(item, 'method', where);
    const agents = item.agents;
    if (!Array.isArray(agents) || !agents.every((agent) => typeof agent === 'string')) {
      throw new IndexerResponseError(`${where}.agents is not a list of addresses`);
    }
    const timestamp = item.timestampMs;
    if (timestamp !== null && (typeof timestamp !== 'number' || !Number.isInteger(timestamp))) {
      throw new IndexerResponseError(`${where}.timestampMs is not an integer`);
    }
    const data = isRecord(item.data) ? item.data : {};
    const types = fieldTypes(section, method);

    return {
      id: requireString(item, 'id', where),
      blockNumber: requireInteger(item, 'blockNumber', where),
      extrinsicIndex: extrinsicIndexOf(item.extrinsicId, where),
      timestampMs: timestamp === null ? null : BigInt(timestamp),
      kind: requireString(item, 'kind', where),
      section,
      method,
      agents: agents as string[],
      fields: Object.entries(data).map(([name, value]) => typedField(name, value, types?.get(name))),
    };
  });

  return { agent: query.agent, offset: query.offset, limit, total, historyFrom, entries };
}
