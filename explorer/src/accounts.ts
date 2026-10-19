/**
 * Finding the accounts an extrinsic touched.
 *
 * This is the join that makes the explorer navigable: without it an extrinsic
 * page is a dead end, and an account page cannot list what happened to it.
 *
 * The search is structural, not textual. Decoded values are walked as the
 * codec tree the runtime metadata produced, and an account is recognised by
 * being an `AccountId` — never by pattern-matching a string that looks
 * address-shaped. A textual scan would both miss accounts (a `MultiAddress::Id`
 * renders as an object, a raw `[u8; 32]` as hex) and invent them (a 32-byte
 * hash is indistinguishable from a public key once it is a string).
 */

import { GenericAccountId } from '@polkadot/types';
import type { Codec } from '@polkadot/types-codec/types';
import { encodeAddress } from '@polkadot/util-crypto';

/**
 * How deep to walk a decoded value.
 *
 * Calls nest (utility.batch of proxy.proxy of ...), and the depth is bounded by
 * the runtime's own decoding limits, but the walk is over data an untrusted
 * account submitted — so it gets its own explicit ceiling rather than trusting
 * the shape to be sane.
 */
const MAX_DEPTH = 16;

/** True for the values polkadot-js decodes an `AccountId32` into. */
function isAccountId(value: unknown): value is GenericAccountId {
  return value instanceof GenericAccountId;
}

function walk(value: unknown, depth: number, sink: (address: string) => void, ss58Format: number): void {
  if (value === null || value === undefined || depth > MAX_DEPTH) {
    return;
  }

  if (isAccountId(value)) {
    sink(encodeAddress(value.toU8a(), ss58Format));
    return;
  }

  // Vec, Tuple and VecFixed all decode to array-likes.
  if (Array.isArray(value)) {
    for (const entry of value) {
      walk(entry, depth + 1, sink, ss58Format);
    }
    return;
  }

  // Struct and BTreeMap are Maps; BTreeSet is a Set. Map keys can be accounts
  // too (an `AccountId`-keyed map is the usual shape), so both halves are walked.
  if (value instanceof Map) {
    for (const [key, entry] of value.entries()) {
      walk(key, depth + 1, sink, ss58Format);
      walk(entry, depth + 1, sink, ss58Format);
    }
    return;
  }
  if (value instanceof Set) {
    for (const entry of value.values()) {
      walk(entry, depth + 1, sink, ss58Format);
    }
    return;
  }

  const codec = value as Partial<Codec> & { value?: unknown; isSome?: boolean; unwrap?: () => unknown };

  // Option: only a Some carries anything, and unwrapping a None throws.
  if (typeof codec.isSome === 'boolean' && typeof codec.unwrap === 'function') {
    if (codec.isSome) {
      walk(codec.unwrap(), depth + 1, sink, ss58Format);
    }
    return;
  }

  // Enum (including MultiAddress and Result): the payload hangs off `.value`.
  // `MultiAddress::Id` is how nearly every signed call names its counterparty,
  // so missing this branch would lose most of the graph.
  if (codec.value !== undefined && codec.value !== value) {
    walk(codec.value, depth + 1, sink, ss58Format);
  }
}

/**
 * Collects every account named by the given decoded values, de-duplicated and in
 * first-seen order.
 *
 * Order is stable so the extrinsic page reads the way the call does — signer
 * first, then the parties the call named, then whoever the events mentioned.
 */
export function collectAccounts(values: Iterable<unknown>, ss58Format: number): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  const sink = (address: string): void => {
    if (!seen.has(address)) {
      seen.add(address);
      found.push(address);
    }
  };
  for (const value of values) {
    walk(value, 0, sink, ss58Format);
  }
  return found;
}
