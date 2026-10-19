/**
 * Shaping helpers between SCALE-decoded chain data and the REST surface.
 *
 * Everything here is deliberately free of chain connections so the rules that
 * govern the numbers — above all, that a `u128` planck amount never touches a
 * JavaScript float — can be tested on their own.
 */

/** One decoded argument of an event or call, with the metadata type that produced it. */
export interface DecodedArg {
  readonly name: string;
  /** The type as the runtime metadata names it, e.g. `AccountId32`, `u128`. */
  readonly type: string;
  readonly value: unknown;
}

function assertIndex(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer, got ${value}`);
  }
}

/**
 * Identifier for an extrinsic: `<block>-<index>`.
 *
 * Block-scoped rather than the extrinsic hash, because the same call submitted
 * twice by the same signer is two distinct extrinsics that a hash alone would
 * conflate.
 */
export function extrinsicId(blockNumber: number, index: number): string {
  assertIndex('blockNumber', blockNumber);
  assertIndex('index', index);
  return `${blockNumber}-${index}`;
}

/** Identifier for an event: `<block>-<index within the block's event record>`. */
export function eventId(blockNumber: number, index: number): string {
  assertIndex('blockNumber', blockNumber);
  assertIndex('index', index);
  return `${blockNumber}-${index}`;
}

/** Splits `A, Vec<B>, C` on its top-level commas only. */
function topLevelArgs(generics: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < generics.length; i += 1) {
    const char = generics[i]!;
    if (char === '<' || char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === '>' || char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(generics.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(generics.slice(start));
  return parts.map((part) => part.trim());
}

/**
 * Strips homogeneous collection wrappers down to the type they hold.
 *
 * `Vec<AccountId32>` and `[AccountId32;4]` are collections *of* one type, so
 * every string inside them is that type. A tuple or a struct is not: it mixes
 * types, and is deliberately left intact so it fails the account test below.
 */
function leafType(type: string): string {
  let leaf = type.trim();
  for (;;) {
    const array = /^\[\s*(.+?)\s*;\s*\d+\s*\]$/.exec(leaf);
    if (array !== null) {
      leaf = array[1]!.trim();
      continue;
    }
    // `BoundedVec<T, S>` carries its bound as a second parameter; the element
    // type is always the first.
    const generic = /^(?:Vec|Option|BTreeSet|BoundedVec|WeakBoundedVec)<(.+)>$/.exec(leaf);
    if (generic !== null) {
      leaf = topLevelArgs(generic[1]!)[0]!;
      continue;
    }
    return leaf;
  }
}

/**
 * True when a metadata type is an account, or a collection of nothing else.
 *
 * Anchored on the leaf type, exactly as `ingest.ts:plain()` is. A substring
 * match would call `(AccountId32, H256)` an account type, and the walk below
 * would then harvest the 32-byte hash beside the address as though it were one.
 */
function isAccountType(type: string): boolean {
  return /^AccountId/.test(leafType(type));
}

/** Collects every string reachable from a decoded value. */
function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === 'string') {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, into);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) collectStrings(entry, into);
  }
}

/**
 * Extracts the accounts an event refers to, in argument order and de-duplicated.
 *
 * This is what makes "show me everything that touched this address" answerable
 * without re-scanning the chain: the account index is built as events are
 * ingested. Only arguments whose leaf metadata type is an account are followed,
 * so a 32-byte question hash is never mistaken for an address — including when
 * it sits next to a real address inside a tuple or a struct.
 */
export function accountsFromArgs(args: readonly DecodedArg[]): string[] {
  const found: string[] = [];
  for (const arg of args) {
    if (isAccountType(arg.type)) {
      collectStrings(arg.value, found);
    }
  }
  return [...new Set(found)];
}

/**
 * Makes a decoded value safe to `JSON.stringify`.
 *
 * `bigint` becomes a decimal string rather than a number. A single agent stake
 * (10^16 plancks) already exceeds `Number.MAX_SAFE_INTEGER`, so the alternative
 * is an API that silently misreports stakes, emissions and the supply cap.
 */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(jsonSafe);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]));
  }
  return value;
}
