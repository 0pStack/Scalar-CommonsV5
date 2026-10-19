/**
 * URL parsing and link building.
 *
 * The explorer's navigation contract lives here: a block links to its
 * extrinsics, and an extrinsic links to the accounts it touched. Keeping both
 * halves — parsing and building — in one pure module is what lets a test prove
 * those links actually resolve, instead of proving that two hand-written
 * strings happen to match.
 */

import { decodeAddress } from '@polkadot/util-crypto';

/** How a block was addressed in a URL. A block is named by its number or its hash. */
export type BlockRef =
  | { readonly kind: 'number'; readonly number: number }
  | { readonly kind: 'hash'; readonly hash: string };

export type Route =
  | { readonly kind: 'home' }
  | { readonly kind: 'block'; readonly ref: BlockRef }
  | { readonly kind: 'extrinsic'; readonly ref: BlockRef; readonly index: number }
  | { readonly kind: 'account'; readonly address: string }
  | { readonly kind: 'activity'; readonly agent: string | null; readonly offset: number }
  | { readonly kind: 'badRequest'; readonly message: string }
  | { readonly kind: 'notFound' };

const BLOCK_HASH = /^0x[0-9a-f]{64}$/i;
const BLOCK_NUMBER = /^\d+$/;

/**
 * The largest value a block number can take.
 *
 * The runtime's `BlockNumber` is a `u32`. A larger value is not a block this
 * chain could ever have: rejecting it here is what keeps it out of polkadot-js
 * encoding, where it would throw and be reported as "the node did not answer"
 * — a 502 blaming the node for what is a client-side typo.
 */
const MAX_BLOCK_NUMBER = 0xffff_ffff;

/**
 * Percent-decodes one path segment, or returns null when it is not decodable.
 *
 * `decodeURIComponent` throws `URIError` on a malformed escape such as a lone
 * "%". That is a malformed request, so it has to become a 400 here rather than
 * escaping to the server's catch-all, which reports everything it catches as an
 * upstream node failure.
 */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** The bad-request route for a segment that is not valid percent-encoding. */
function undecodable(segment: string): Route {
  return { kind: 'badRequest', message: `not a valid URL-encoded path segment: ${segment}` };
}

/**
 * Parses a block reference, or returns null.
 *
 * Deliberately strict: a partially-valid hash is a typo, and resolving it to
 * "something close" would show a visitor a block that is not the one they asked
 * for. Refusing is the honest answer.
 */
export function parseBlockRef(raw: string): BlockRef | null {
  if (BLOCK_NUMBER.test(raw)) {
    const number = Number(raw);
    return Number.isSafeInteger(number) && number <= MAX_BLOCK_NUMBER ? { kind: 'number', number } : null;
  }
  if (BLOCK_HASH.test(raw)) {
    return { kind: 'hash', hash: raw.toLowerCase() };
  }
  return null;
}

/** True when the string decodes as an SS58 address for any network. */
export function isAddress(raw: string): boolean {
  try {
    decodeAddress(raw);
    return true;
  } catch {
    return false;
  }
}

/** Maps a request URL onto a view. Unknown paths are 404; malformed ones are 400. */
export function parseRoute(url: string): Route {
  const parsed = new URL(url, 'http://explorer.invalid');
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return { kind: 'home' };
  }

  const [head, first, second] = segments;

  if (head === 'activity' && segments.length === 1) {
    return parseActivity(parsed.searchParams);
  }

  if (head === 'block' && segments.length === 2 && first !== undefined) {
    const raw = decodeSegment(first);
    if (raw === null) {
      return undecodable(first);
    }
    const ref = parseBlockRef(raw);
    return ref
      ? { kind: 'block', ref }
      : { kind: 'badRequest', message: `not a block number or block hash: ${raw}` };
  }

  if (head === 'extrinsic' && segments.length === 3 && first !== undefined && second !== undefined) {
    const raw = decodeSegment(first);
    if (raw === null) {
      return undecodable(first);
    }
    const rawIndex = decodeSegment(second);
    if (rawIndex === null) {
      return undecodable(second);
    }
    const ref = parseBlockRef(raw);
    if (!ref) {
      return { kind: 'badRequest', message: `not a block number or block hash: ${raw}` };
    }
    if (!BLOCK_NUMBER.test(rawIndex)) {
      return { kind: 'badRequest', message: `not an extrinsic index: ${rawIndex}` };
    }
    return { kind: 'extrinsic', ref, index: Number(rawIndex) };
  }

  if (head === 'account' && segments.length === 2 && first !== undefined) {
    const address = decodeSegment(first);
    if (address === null) {
      return undecodable(first);
    }
    return isAddress(address)
      ? { kind: 'account', address }
      : { kind: 'badRequest', message: `not a valid SS58 account address: ${address}` };
  }

  return { kind: 'notFound' };
}

/**
 * The largest `?offset=` the activity page accepts.
 *
 * Past it there is no page a reader would click through to, and a bounded value
 * keeps a hand-typed offset from being forwarded to the indexer as a number it
 * has to reject.
 */
const MAX_ACTIVITY_OFFSET = 1_000_000;

/**
 * Reads the activity page's query: an optional agent and an optional offset.
 *
 * `URLSearchParams` has already percent-decoded the values. An empty agent is
 * what the filter form submits when cleared, so it means "every agent"; a value
 * that is not an address is refused rather than forwarded, because an empty feed
 * for a typo would read as "this agent has done nothing".
 */
function parseActivity(params: URLSearchParams): Route {
  const rawAgent = (params.get('agent') ?? '').trim();
  if (rawAgent !== '' && !isAddress(rawAgent)) {
    return { kind: 'badRequest', message: `not a valid SS58 account address: ${rawAgent}` };
  }
  const rawOffset = params.get('offset') ?? '0';
  const offset = Number(rawOffset);
  if (!BLOCK_NUMBER.test(rawOffset) || offset > MAX_ACTIVITY_OFFSET) {
    return { kind: 'badRequest', message: `not an activity offset: ${rawOffset}` };
  }
  return { kind: 'activity', agent: rawAgent === '' ? null : rawAgent, offset };
}

/** Renders a block reference back into its URL segment. */
export function blockRefSegment(ref: BlockRef): string {
  switch (ref.kind) {
    case 'number':
      return String(ref.number);
    case 'hash':
      return ref.hash;
  }
}

export function blockPath(ref: BlockRef): string {
  return `/block/${blockRefSegment(ref)}`;
}

export function extrinsicPath(ref: BlockRef, index: number): string {
  return `/extrinsic/${blockRefSegment(ref)}/${index}`;
}

export function accountPath(address: string): string {
  return `/account/${address}`;
}

/** The activity feed, optionally filtered to one agent and paged back from the newest. */
export function activityPath(agent: string | null = null, offset = 0): string {
  const params = new URLSearchParams();
  if (agent !== null) params.set('agent', agent);
  if (offset > 0) params.set('offset', String(offset));
  const query = params.toString();
  return query === '' ? '/activity' : `/activity?${query}`;
}
