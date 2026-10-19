/**
 * Paging rules for every list endpoint.
 *
 * The index grows for as long as the chain produces blocks, so no list endpoint
 * may ever answer "all of it". The cap here is what keeps one mistyped query
 * from turning a read into a denial of service against the indexer's own API.
 *
 * It bounds the *response*, not the work behind it. Endpoints that answer from
 * live chain state bound their own reads separately — see `MAX_LIVE_SCAN` in
 * `chainState.ts` — because a window applied after the fact leaves the cost of
 * enumerating a whole storage map sitting on the node.
 */

/** Raised when a query string cannot be honoured as written. */
export class InvalidQueryError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidQueryError';
  }
}

/** Rows returned when the caller does not ask for a size. */
export const DEFAULT_LIMIT = 25;

/** Hard ceiling on rows per response, applied even when the caller asks for more. */
export const MAX_LIMIT = 200;

/** A validated window onto a result set. */
export interface Page {
  readonly limit: number;
  readonly offset: number;
}

/** Parses a decimal integer, rejecting anything else rather than coercing it. */
function parseInteger(name: string, raw: string): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new InvalidQueryError(`${name} must be an integer, got "${raw}"`);
  }
  return Number(raw);
}

/**
 * Reads `limit`/`offset` from a query string.
 *
 * An over-large `limit` is clamped rather than refused — clients paging through
 * history should not break on an off-by-one — but a `limit` below 1 is refused,
 * because silently returning nothing looks identical to "the chain has nothing"
 * and hides the bug from whoever wrote the query.
 *
 * @throws {InvalidQueryError} on non-integer, negative, or zero-limit input.
 */
export function parsePage(params: URLSearchParams): Page {
  const rawLimit = params.get('limit');
  const rawOffset = params.get('offset');

  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    limit = parseInteger('limit', rawLimit);
    if (limit < 1) {
      throw new InvalidQueryError(`limit must be at least 1, got ${limit}`);
    }
    limit = Math.min(limit, MAX_LIMIT);
  }

  let offset = 0;
  if (rawOffset !== null) {
    offset = parseInteger('offset', rawOffset);
    if (offset < 0) {
      throw new InvalidQueryError(`offset must not be negative, got ${offset}`);
    }
  }

  return { limit, offset };
}

/** Reads an optional non-negative integer filter (e.g. `?blockNumber=`). */
export function parseOptionalInteger(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null) {
    return undefined;
  }
  const value = parseInteger(name, raw);
  if (value < 0) {
    throw new InvalidQueryError(`${name} must not be negative, got ${value}`);
  }
  return value;
}
