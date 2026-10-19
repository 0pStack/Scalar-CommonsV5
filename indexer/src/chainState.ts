/**
 * Live reads of pallet state.
 *
 * History comes from the index; *current* state comes from here, straight off
 * the node at every request. Stakes, agreements, issuance and era timing are
 * exactly the values agents act on, so serving a cached copy would mean
 * answering "what is true now" with "what was true at some point". Every value
 * below is read through the node's own metadata.
 */

import type { ApiPromise } from '@polkadot/api';

import type { ChainConnection } from './chain.ts';
import type { Page } from './pagination.ts';

/** Reads a codec as a decimal planck string — never as a number. */
function plancks(value: unknown): string {
  return (value as { toString(): string }).toString();
}

/** Reads a small integer codec (block numbers, counters, era indices). */
function count(value: unknown): number {
  return Number((value as { toString(): string }).toString());
}

/**
 * A storage entry as resolved from the node's own metadata.
 *
 * Typed loosely on purpose: the pallets this indexer reads are chain-specific,
 * so there are no generated types for them here, and the alternative — writing
 * the shapes out by hand — is exactly the guesswork that goes stale the first
 * time the runtime changes.
 */
type StorageEntry = ((...args: unknown[]) => Promise<unknown>) & {
  entriesPaged: (options: {
    args: unknown[];
    pageSize: number;
    startKey?: string;
  }) => Promise<StorageEntryPair[]>;
};

/** One key/value pair of a storage map, keyed by its decoded key arguments. */
type StorageEntryPair = [{ args: { toString(): string }[]; toHex(): string }, unknown];

/** Resolves a storage item, refusing to run against a runtime that lacks it. */
function entry(api: ApiPromise, pallet: string, item: string): StorageEntry {
  const resolved = (api.query as unknown as Record<string, Record<string, StorageEntry | undefined>>)[
    pallet
  ]?.[item];
  if (resolved === undefined) {
    throw new Error(`runtime does not expose storage ${pallet}.${item}`);
  }
  return resolved;
}

/** Reads one storage value from the live chain. */
function read(api: ApiPromise, pallet: string, item: string, ...args: unknown[]): Promise<unknown> {
  return entry(api, pallet, item)(...args);
}

/**
 * Ceiling on how many live storage entries one request may pull off the node.
 *
 * The maps behind `/v1/agents` and `/v1/escrows` grow with the chain, and a
 * request that enumerates one whole costs the validator the same work whatever
 * `?limit=` asked for. That is amplification pointed at the node, not at this
 * process, so it is bounded here rather than left to the paging rules. Reaching
 * the ceiling is reported (`truncated`), never silently swallowed.
 */
export const MAX_LIVE_SCAN = 512;

/** Entries per `state_getKeysPaged` round trip while scanning. */
const SCAN_PAGE_SIZE = 128;

/** A bounded read of a storage map, with whether the bound cut it short. */
interface EntryScan {
  entries: StorageEntryPair[];
  truncated: boolean;
}

/**
 * Reads a storage map in pages, stopping at {@link MAX_LIVE_SCAN}.
 *
 * `args` narrows the scan to a key prefix — for the buyer-first `agreements`
 * double map, passing the buyer means the node never touches another buyer's
 * agreements. One entry beyond the ceiling is requested deliberately: it is the
 * only way to tell "the map ended here" from "the ceiling stopped us".
 */
async function scanEntries(
  api: ApiPromise,
  pallet: string,
  item: string,
  options: { args?: unknown[]; limit?: number } = {},
): Promise<EntryScan> {
  const args = options.args ?? [];
  const limit = options.limit ?? MAX_LIVE_SCAN;
  const storage = entry(api, pallet, item);

  const entries: StorageEntryPair[] = [];
  let startKey: string | undefined;
  while (entries.length <= limit) {
    const pageSize = Math.min(SCAN_PAGE_SIZE, limit + 1 - entries.length);
    const page = await storage.entriesPaged({ args, pageSize, startKey });
    if (page.length === 0) {
      break;
    }
    entries.push(...page);
    startKey = page[page.length - 1]![0].toHex();
    if (page.length < pageSize) {
      break;
    }
  }

  if (entries.length > limit) {
    return { entries: entries.slice(0, limit), truncated: true };
  }
  return { entries, truncated: false };
}

/**
 * A list read live from chain state, and whether the scan ceiling truncated it.
 *
 * `total` counts what the scan found, so a truncated list is a floor, not a
 * count. Callers surface the flag rather than reporting the floor as a total.
 */
export interface LiveList<T> {
  total: number;
  items: T[];
  truncated: boolean;
}

/** Reads a `#[pallet::constant]` off the runtime metadata. */
function constant(api: ApiPromise, pallet: string, name: string): { toString(): string } {
  const value = (api.consts as unknown as Record<string, Record<string, { toString(): string }>>)[pallet]?.[name];
  if (value === undefined) {
    throw new Error(`runtime does not expose constant ${pallet}.${name}`);
  }
  return value;
}

export interface ChainStatus {
  chain: {
    name: string;
    specName: string;
    specVersion: number;
    ss58Format: number;
    tokenSymbol: string;
    tokenDecimals: number;
    bestBlock: number;
    finalizedBlock: number;
  };
}

/** Chain identity plus where its head currently is. */
export async function fetchChainStatus(api: ApiPromise, chain: ChainConnection): Promise<ChainStatus['chain']> {
  const [chainName, bestHeader, finalizedHash] = await Promise.all([
    api.rpc.system.chain(),
    api.rpc.chain.getHeader(),
    api.rpc.chain.getFinalizedHead(),
  ]);
  const finalizedHeader = await api.rpc.chain.getHeader(finalizedHash);

  return {
    name: chainName.toString(),
    specName: api.runtimeVersion.specName.toString(),
    specVersion: api.runtimeVersion.specVersion.toNumber(),
    ss58Format: chain.ss58Format,
    tokenSymbol: chain.tokenSymbol,
    tokenDecimals: chain.tokenDecimals,
    bestBlock: bestHeader.number.toNumber(),
    finalizedBlock: finalizedHeader.number.toNumber(),
  };
}

export interface AccountState {
  address: string;
  nonce: number;
  balance: {
    freePlancks: string;
    reservedPlancks: string;
    frozenPlancks: string;
  };
  isAgent: boolean;
}

/** Live balance and agent status for one account. */
export async function fetchAccountState(api: ApiPromise, address: string): Promise<AccountState> {
  const [account, stake] = await Promise.all([
    read(api, 'system', 'account', address),
    read(api, 'agents', 'agentStake', address),
  ]);
  const info = account as unknown as {
    nonce: { toNumber(): number };
    data: { free: unknown; reserved: unknown; frozen: unknown };
  };

  return {
    address,
    nonce: info.nonce.toNumber(),
    balance: {
      freePlancks: plancks(info.data.free),
      reservedPlancks: plancks(info.data.reserved),
      frozenPlancks: plancks(info.data.frozen),
    },
    isAgent: (stake as unknown as { isSome: boolean }).isSome,
  };
}

export interface AgentState {
  address: string;
  /** Stake backing this agent, in plancks. Weight in emissions starts here. */
  stakePlancks: string;
  registeredAtBlock: number;
  /** Block the agent last proved liveness at. */
  lastHeartbeatBlock: number;
  /** Set once an unstake has been requested; the agent exits at this block. */
  unstakeAtBlock: number | null;
  completedAgreements: number;
  activeEscrowCount: number;
  /** Escrow volume this era — the gate on qualifying for emissions at all. */
  eraVolumePlancks: string;
  /** Distinct counterparties this era; the anti-ring-trading signal. */
  eraUniqueBuyers: number;
  /** Governance votes credited this era, one per distinct referendum. */
  eraGovParticipation: number;
  capabilities: number[];
  metadata: { uri: string; name: string; updatedAtBlock: number } | null;
}

/** Decodes a `BoundedVec<u8>` metadata field (URI, display name) as UTF-8. */
function decodeBytes(value: unknown): string {
  const bytes = value as { toU8a?: (isBare?: boolean) => Uint8Array; toString(): string };
  return typeof bytes.toU8a === 'function'
    ? Buffer.from(bytes.toU8a(true)).toString('utf8')
    : bytes.toString();
}

/** Full agent record, or null when the account is not a registered agent. */
export async function fetchAgent(api: ApiPromise, address: string): Promise<AgentState | null> {
  const stake = await read(api, 'agents', 'agentStake', address);
  if (!(stake as unknown as { isSome: boolean }).isSome) {
    return null;
  }

  const [
    registeredAt,
    lastHeartbeat,
    unstakeAt,
    completed,
    activeEscrows,
    eraVolume,
    eraBuyers,
    eraGov,
    capabilities,
    metadata,
  ] = await Promise.all([
    read(api, 'agents', 'stakeRegisteredAt', address),
    read(api, 'agents', 'lastHeartbeat', address),
    read(api, 'agents', 'unstakeAt', address),
    read(api, 'agents', 'completedAgreements', address),
    read(api, 'agents', 'activeEscrowCount', address),
    read(api, 'agents', 'eraEscrowVolume', address),
    read(api, 'agents', 'eraUniqueBuyers', address),
    read(api, 'agents', 'eraGovParticipation', address),
    read(api, 'agents', 'agentCapabilities', address),
    read(api, 'agents', 'agentMetadata', address),
  ]);

  const unstake = unstakeAt as unknown as { isSome: boolean; unwrap(): unknown };
  const meta = metadata as unknown as { isSome: boolean; unwrap(): Record<string, unknown> };

  return {
    address,
    stakePlancks: plancks((stake as unknown as { unwrap(): unknown }).unwrap()),
    registeredAtBlock: count(registeredAt),
    lastHeartbeatBlock: count(lastHeartbeat),
    unstakeAtBlock: unstake.isSome ? count(unstake.unwrap()) : null,
    completedAgreements: count(completed),
    activeEscrowCount: count(activeEscrows),
    eraVolumePlancks: plancks(eraVolume),
    eraUniqueBuyers: count(eraBuyers),
    eraGovParticipation: count(eraGov),
    capabilities: (capabilities as unknown as { toArray(): unknown[] }).toArray().map(count),
    metadata: meta.isSome
      ? (() => {
          const record = meta.unwrap();
          return {
            uri: decodeBytes(record.uri),
            name: decodeBytes(record.name),
            updatedAtBlock: count(record.updatedAt),
          };
        })()
      : null,
  };
}

/**
 * Orders agents by stake, descending, breaking ties on address.
 *
 * A comparator that never returns `0` is not an ordering: it claims `a` before
 * `b` *and* `b` before `a` for two agents on equal stake, so "ordered by stake"
 * stops being a guarantee and the same request can answer in a different order
 * twice running. Genesis agents all hold identical stake, so ties are the
 * normal case here, not the edge one.
 */
export function compareByStakeDescending(
  a: Pick<AgentState, 'address' | 'stakePlancks'>,
  b: Pick<AgentState, 'address' | 'stakePlancks'>,
): number {
  const left = BigInt(a.stakePlancks);
  const right = BigInt(b.stakePlancks);
  if (right > left) return 1;
  if (right < left) return -1;
  if (a.address < b.address) return -1;
  if (a.address > b.address) return 1;
  return 0;
}

/**
 * One page of registered agents, ordered by stake descending.
 *
 * Describing an agent costs ten storage reads, so only the agents actually in
 * the window are described. Ranking still needs every stake — but stakes come
 * back with the keys in one bounded enumeration, which is a single scan rather
 * than ten reads per agent on chain.
 */
export async function fetchAgents(api: ApiPromise, page: Page): Promise<LiveList<AgentState>> {
  const { entries, truncated } = await scanEntries(api, 'agents', 'agentStake');
  const ranked = entries
    .map(([key, value]) => ({ address: key.args[0]!.toString(), stakePlancks: plancks(value) }))
    .sort(compareByStakeDescending);

  const window = ranked.slice(page.offset, page.offset + page.limit);
  const agents = await Promise.all(window.map(({ address }) => fetchAgent(api, address)));

  return {
    total: ranked.length,
    // An agent whose stake was withdrawn between the scan and the read is gone,
    // not a null row.
    items: agents.filter((agent): agent is AgentState => agent !== null),
    truncated,
  };
}

export interface EscrowAgreement {
  buyer: string;
  provider: string;
  seq: number;
  amountPlancks: string;
  deliverableHash: string;
  deliverByBlock: number;
  createdAtBlock: number;
  status: 'Created' | 'Delivered' | 'Disputed';
  deliveryProof: string | null;
  capabilityId: number | null;
  disputeOpenedAtBlock: number | null;
  disputeRequestId: string | null;
}

/** The agreement statuses this build knows how to report. */
const AGREEMENT_STATUSES: readonly EscrowAgreement['status'][] = ['Created', 'Delivered', 'Disputed'];

/**
 * Shapes one decoded `Agreement` for the API.
 *
 * An unrecognised status is a hard error, not a row with an odd label: a
 * variant this build has never heard of means the runtime moved on, and the
 * honest answer is to say so. Counting it silently into a status split seeded
 * with the old variants yields `undefined + 1 = NaN`, which serialises as
 * `null` and makes the agreement vanish from the split with no error anywhere.
 */
export function toAgreement(buyer: string, provider: string, raw: Record<string, any>): EscrowAgreement {
  const status = String(raw.status.type);
  if (!AGREEMENT_STATUSES.includes(status as EscrowAgreement['status'])) {
    throw new Error(
      `runtime reports unknown escrow agreement status "${status}"; known statuses are ${AGREEMENT_STATUSES.join(', ')}`,
    );
  }
  return {
    buyer,
    provider,
    seq: count(raw.seq),
    amountPlancks: plancks(raw.amount),
    deliverableHash: raw.deliverableHash.toHex(),
    deliverByBlock: count(raw.deliverBy),
    createdAtBlock: count(raw.createdAt),
    status: status as EscrowAgreement['status'],
    deliveryProof: raw.deliveryProof.isSome ? raw.deliveryProof.unwrap().toHex() : null,
    capabilityId: raw.capabilityId.isSome ? count(raw.capabilityId.unwrap()) : null,
    disputeOpenedAtBlock: raw.disputeOpenedAt.isSome ? count(raw.disputeOpenedAt.unwrap()) : null,
    disputeRequestId: raw.disputeRequestId.isSome ? raw.disputeRequestId.unwrap().toHex() : null,
  };
}

export interface EscrowFilter {
  buyer?: string;
  provider?: string;
  /** Agreements this address is party to, on either side of the pair. */
  party?: string;
}

/**
 * Live agreements matching a filter, newest first.
 *
 * Settled agreements are removed from chain storage by the pallet, so this is
 * the set of open commitments — the funds actually reserved right now.
 *
 * How much of the map is read depends on how much of its key the caller gave:
 *
 * - **buyer and provider** — that *is* the key of the double map, so it is one
 *   read and no enumeration at all;
 * - **buyer** — the map is keyed buyer-first, so the scan is scoped to that
 *   buyer's prefix and never touches another buyer's agreements;
 * - **provider, party, or nothing** — there is no reverse index on chain, so
 *   pairs are walked and filtered here, bounded by {@link MAX_LIVE_SCAN}.
 */
export async function fetchEscrows(
  api: ApiPromise,
  filter: EscrowFilter = {},
): Promise<LiveList<EscrowAgreement>> {
  const agreements: EscrowAgreement[] = [];
  let truncated = false;

  if (filter.buyer !== undefined && filter.provider !== undefined) {
    const value = await read(api, 'escrow', 'agreements', filter.buyer, filter.provider);
    for (const raw of value as unknown as Record<string, any>[]) {
      agreements.push(toAgreement(filter.buyer, filter.provider, raw));
    }
  } else {
    const scan = await scanEntries(api, 'escrow', 'agreements', {
      args: filter.buyer === undefined ? [] : [filter.buyer],
    });
    truncated = scan.truncated;

    for (const [key, value] of scan.entries) {
      const buyer = key.args[0]!.toString();
      const provider = key.args[1]!.toString();
      if (filter.provider !== undefined && filter.provider !== provider) continue;
      if (filter.party !== undefined && filter.party !== buyer && filter.party !== provider) continue;
      for (const raw of value as unknown as Record<string, any>[]) {
        agreements.push(toAgreement(buyer, provider, raw));
      }
    }
  }

  return {
    total: agreements.length,
    items: agreements.sort((a, b) => b.createdAtBlock - a.createdAtBlock),
    truncated,
  };
}

/** One agreement by its (buyer, provider, seq) key, or null. */
export async function fetchEscrow(
  api: ApiPromise,
  buyer: string,
  provider: string,
  seq: number,
): Promise<EscrowAgreement | null> {
  const value = await read(api, 'escrow', 'agreements', buyer, provider);
  for (const raw of value as unknown as Record<string, any>[]) {
    if (count(raw.seq) === seq) {
      return toAgreement(buyer, provider, raw);
    }
  }
  return null;
}

export interface EscrowStats {
  /** The pallet's own counter of live agreements. */
  activeAgreementCount: number;
  /** Agreements the indexer enumerated from storage, as a cross-check. */
  enumeratedAgreements: number;
  /**
   * True when the scan ceiling stopped the enumeration before the map ended.
   *
   * The figures below then describe the pairs that were read, not the whole
   * map — which is why they are published beside `activeAgreementCount`, the
   * pallet's own counter, rather than in place of it.
   */
  scanTruncated: boolean;
  byStatus: Record<EscrowAgreement['status'], number>;
  /** Buyer funds currently reserved across all open agreements. */
  totalLockedPlancks: string;
  distinctPairs: number;
  limits: {
    maxAgreementsPerPair: number;
    minAgreementPlancks: string;
    maxAgreementSpanBlocks: number;
  };
}

export async function fetchEscrowStats(api: ApiPromise): Promise<EscrowStats> {
  const [counter, agreements] = await Promise.all([
    read(api, 'escrow', 'activeAgreementCount'),
    fetchEscrows(api),
  ]);

  // Seeded from the same list `toAgreement` validates against, so a variant the
  // runtime adds can never land here as an untracked key.
  const byStatus = Object.fromEntries(AGREEMENT_STATUSES.map((status) => [status, 0])) as Record<
    EscrowAgreement['status'],
    number
  >;
  // Reserved balances are u128 plancks; summing them anywhere but in bigint
  // would silently round the total once it passes 2^53.
  let locked = 0n;
  const pairs = new Set<string>();
  for (const agreement of agreements.items) {
    byStatus[agreement.status] += 1;
    locked += BigInt(agreement.amountPlancks);
    pairs.add(`${agreement.buyer}/${agreement.provider}`);
  }

  return {
    activeAgreementCount: count(counter),
    enumeratedAgreements: agreements.items.length,
    scanTruncated: agreements.truncated,
    byStatus,
    totalLockedPlancks: locked.toString(),
    distinctPairs: pairs.size,
    limits: {
      maxAgreementsPerPair: count(constant(api, 'escrow', 'maxAgreementsPerPair')),
      minAgreementPlancks: constant(api, 'escrow', 'minAgreementAmount').toString(),
      maxAgreementSpanBlocks: count(constant(api, 'escrow', 'maxAgreementSpan')),
    },
  };
}

export interface EraState {
  era: number;
  startBlock: number;
  durationBlocks: number;
  currentBlock: number;
  blocksElapsed: number;
  blocksRemaining: number;
  /**
   * Whether `settle_era`'s timing guard would pass right now.
   *
   * Settlement is permissionless by design — this is the era-duration gate, not
   * a check on who may call it.
   */
  dueForSettlement: boolean;
  lastSettledEra: number | null;
  ringSnapshot: number;
  activeSnapshot: number;
}

export async function fetchCurrentEra(api: ApiPromise): Promise<EraState> {
  const [era, startBlock, header, lastSettled, ringSnapshot, activeSnapshot] = await Promise.all([
    read(api, 'agents', 'eraNumber'),
    read(api, 'emissions', 'eraStartBlock'),
    api.rpc.chain.getHeader(),
    read(api, 'emissions', 'lastSettledEra'),
    read(api, 'agents', 'eraRingSnapshot'),
    read(api, 'agents', 'eraActiveSnapshot'),
  ]);

  const start = count(startBlock);
  const current = header.number.toNumber();
  const duration = count(constant(api, 'emissions', 'eraDuration'));
  const elapsed = current - start;
  const settled = lastSettled as unknown as { isSome: boolean; unwrap(): unknown };

  return {
    era: count(era),
    startBlock: start,
    durationBlocks: duration,
    currentBlock: current,
    blocksElapsed: elapsed,
    blocksRemaining: Math.max(0, duration - elapsed),
    dueForSettlement: elapsed >= duration,
    lastSettledEra: settled.isSome ? count(settled.unwrap()) : null,
    ringSnapshot: count(ringSnapshot),
    activeSnapshot: count(activeSnapshot),
  };
}

export interface EmissionsState {
  lastSettledEra: number | null;
  lastEraEmissionPlancks: string;
  /** Accumulator the per-agent reward claim is computed against. */
  accRewardPerStake: string;
  parameters: {
    eraDurationBlocks: number;
    initialEmissionPerEraPlancks: string;
    floorEmissionPerEraPlancks: string;
    targetEmissionPerAgentPlancks: string;
    /** Cap on the velocity bonus, in basis points (3000 bps = +30%). */
    velocityBonusBps: number;
    /** Oracle-accuracy bonus, in basis points (2000 bps = +20%). */
    oracleBonusBps: number;
    /** Era escrow volume an agent must clear before it earns anything. */
    minQualifyingVolumePlancks: string;
    unitVolumePlancks: string;
  };
}

export async function fetchEmissions(api: ApiPromise): Promise<EmissionsState> {
  const [lastSettled, lastEmission, acc] = await Promise.all([
    read(api, 'emissions', 'lastSettledEra'),
    read(api, 'emissions', 'lastEraEmission'),
    read(api, 'emissions', 'accRewardPerStake'),
  ]);
  const settled = lastSettled as unknown as { isSome: boolean; unwrap(): unknown };

  return {
    lastSettledEra: settled.isSome ? count(settled.unwrap()) : null,
    lastEraEmissionPlancks: plancks(lastEmission),
    accRewardPerStake: plancks(acc),
    parameters: {
      eraDurationBlocks: count(constant(api, 'emissions', 'eraDuration')),
      initialEmissionPerEraPlancks: constant(api, 'emissions', 'initialEmissionsPerEra').toString(),
      floorEmissionPerEraPlancks: constant(api, 'emissions', 'floorEmissionPerEra').toString(),
      targetEmissionPerAgentPlancks: constant(api, 'emissions', 'targetEmissionPerAgent').toString(),
      velocityBonusBps: count(constant(api, 'emissions', 'velocityBonusBps')),
      oracleBonusBps: count(constant(api, 'emissions', 'oracleBonusBps')),
      minQualifyingVolumePlancks: constant(api, 'emissions', 'minQualifyingVol').toString(),
      unitVolumePlancks: constant(api, 'emissions', 'unitVolume').toString(),
    },
  };
}

export interface SupplyState {
  capPlancks: string;
  totalIssuancePlancks: string;
  remainingPlancks: string;
  /** Share of the cap already issued, to 4 decimal places. */
  percentIssued: number;
  tokenSymbol: string;
  tokenDecimals: number;
}

/**
 * Issuance against the hard cap.
 *
 * The cap is the chain's one inviolable economic bound, so headroom is computed
 * in `bigint` from the runtime's own constant and the live total issuance —
 * never from a stored or derived figure that could drift from either.
 */
export async function fetchSupply(api: ApiPromise, chain: ChainConnection): Promise<SupplyState> {
  const issuance = await read(api, 'balances', 'totalIssuance');
  const cap = BigInt(constant(api, 'emissions', 'supplyCap').toString());
  const issued = BigInt(plancks(issuance));
  const remaining = cap > issued ? cap - issued : 0n;

  return {
    capPlancks: cap.toString(),
    totalIssuancePlancks: issued.toString(),
    remainingPlancks: remaining.toString(),
    // Scaled in bigint before the divide so the ratio never passes through a
    // float at full planck magnitude.
    percentIssued: cap === 0n ? 0 : Number((issued * 1_000_000n) / cap) / 10_000,
    tokenSymbol: chain.tokenSymbol,
    tokenDecimals: chain.tokenDecimals,
  };
}
