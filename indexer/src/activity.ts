/**
 * The agent-activity feed: which indexed events count as something an agent
 * did, and what to call each one.
 *
 * `/v1/events` answers "what happened"; this answers "what have the agents been
 * doing" — registrations, liveness, the agreement lifecycle, disputes, oracle
 * votes, slashes and messages, in one stream. It is a projection over the event
 * index, not a second store: every row it returns is an event row the indexer
 * already holds, so the feed can never disagree with `/v1/events` about what a
 * block contained.
 *
 * Classification is by exact `(pallet, event)` pair. Matching on the method
 * name alone would let any pallet that happens to emit an `AgentRegistered`
 * write itself into another pallet's history.
 */

import type { EventRow } from './store.ts';

/** The families of agent activity the feed reports, in display order. */
export const ACTIVITY_KINDS = [
  'message',
  'registration',
  'heartbeat',
  'agreement',
  'dispute',
  'oracle_vote',
  'slash',
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * One event (or, with `method: null`, every event of one pallet) the feed takes.
 *
 * `section` is the pallet as polkadot-js names it: the runtime's pallet name
 * with a lower-case first letter.
 */
export interface ActivitySource {
  readonly kind: ActivityKind;
  readonly section: string;
  readonly method: string | null;
}

/**
 * Every event the feed takes, and the kind each is reported as.
 *
 * Messaging is matched by pallet rather than by event, so every event a
 * messaging pallet emits joins the feed without an indexer release.
 *
 * The pallet landed in runtime **309** (PR #242) and its section is `messages`.
 * This list was written before it existed and guessed at `messaging` and
 * `agentMessaging`; neither is what shipped, so the feed silently reported zero
 * messages against a chain that had them. Found by sending a real message
 * through the SDK on dev-real and watching `/v1/activity` stay empty, which is
 * also the only way it could have been found — a wrong section name matches
 * nothing and raises nothing, in the indexer or in its tests.
 *
 * The two guessed names are kept alongside the real one. They cost one array
 * entry each, and the failure they protect against is exactly the one that just
 * happened: a rename on the runtime side that nothing here would notice.
 *
 * Oracle votes are the two ways an agent answers a request — singly or in a
 * batch. Request creation, finalisation and expiry are about the request, not
 * about any one agent's vote, and stay out. Slash appeals sit beside the slash
 * itself: an appeal is the agent's side of the same proceeding.
 */
export const ACTIVITY_SOURCES: readonly ActivitySource[] = [
  { kind: 'message', section: 'messages', method: null },
  { kind: 'message', section: 'messaging', method: null },
  { kind: 'message', section: 'agentMessaging', method: null },
  { kind: 'registration', section: 'agents', method: 'AgentRegistered' },
  { kind: 'heartbeat', section: 'agents', method: 'HeartbeatSent' },
  { kind: 'agreement', section: 'escrow', method: 'AgreementCreated' },
  { kind: 'agreement', section: 'escrow', method: 'DeliveryRecorded' },
  { kind: 'agreement', section: 'escrow', method: 'DeliveryConfirmed' },
  { kind: 'agreement', section: 'escrow', method: 'RefundClaimed' },
  { kind: 'agreement', section: 'escrow', method: 'DeadlineExtended' },
  // E18/E2 (#180). These four are the agreement's other endings, and leaving
  // them out is not a cosmetic gap: a consumer that opens an agreement on
  // `AgreementCreated` and closes it on `DeliveryConfirmed`/`RefundClaimed`
  // would report every rejected, cancelled and expired agreement as
  // permanently open. The classifier is an allow-list, so the omission is
  // silent — nothing errors, the rows simply never appear.
  { kind: 'agreement', section: 'escrow', method: 'AgreementAccepted' },
  { kind: 'agreement', section: 'escrow', method: 'AgreementRejected' },
  { kind: 'agreement', section: 'escrow', method: 'PendingCancelled' },
  { kind: 'agreement', section: 'escrow', method: 'AgreementExpired' },
  { kind: 'dispute', section: 'escrow', method: 'DisputeOpened' },
  { kind: 'dispute', section: 'escrow', method: 'DisputeResolved' },
  { kind: 'oracle_vote', section: 'oracle', method: 'OracleResponseSubmitted' },
  { kind: 'oracle_vote', section: 'oracle', method: 'BatchResponseSubmitted' },
  { kind: 'slash', section: 'agents', method: 'SlashExecuted' },
  { kind: 'slash', section: 'agents', method: 'SlashAppealed' },
  { kind: 'slash', section: 'agents', method: 'SlashAppealWithdrawn' },
];

/** The kind an event is reported as, or null when it is not agent activity. */
export function classifyActivity(section: string, method: string): ActivityKind | null {
  for (const source of ACTIVITY_SOURCES) {
    if (source.section === section && (source.method === null || source.method === method)) {
      return source.kind;
    }
  }
  return null;
}

/** Thrown for a `?kind=` the feed does not report; the API turns it into a 400. */
export class UnknownActivityKindError extends Error {
  constructor(raw: string) {
    super(`unknown activity kind "${raw}"; expected one of ${ACTIVITY_KINDS.join(', ')}`);
    this.name = 'UnknownActivityKindError';
  }
}

/**
 * Validates a `?kind=` filter.
 *
 * An unknown kind is refused rather than matched against nothing: a typo that
 * answered an empty feed would read as "this agent has never been slashed".
 */
export function parseActivityKind(raw: string | undefined): ActivityKind | undefined {
  if (raw === undefined) return undefined;
  if ((ACTIVITY_KINDS as readonly string[]).includes(raw)) return raw as ActivityKind;
  throw new UnknownActivityKindError(raw);
}

/** The sources for one kind, or all of them. */
export function sourcesFor(kind: ActivityKind | undefined): readonly ActivitySource[] {
  return kind === undefined ? ACTIVITY_SOURCES : ACTIVITY_SOURCES.filter((source) => source.kind === kind);
}

/** One row of `/v1/activity`. */
export interface ActivityItem {
  /** The event's own id, `<block>-<index>`, so a row resolves on `/v1/events/:id`. */
  id: string;
  blockNumber: number;
  index: number;
  extrinsicId: string | null;
  /** The block's `timestamp.set` value, in milliseconds. */
  timestampMs: number | null;
  kind: ActivityKind;
  section: string;
  method: string;
  /** Every account the event names — the agents involved, in argument order. */
  agents: string[];
  data: unknown;
}

/**
 * Shapes an indexed event as a feed row.
 *
 * Throws on an event that is not activity: the store is asked only for activity
 * sources, so reaching here with anything else is a query bug, and labelling it
 * with a guessed kind would put it in front of a reader as fact.
 */
export function activityItem(event: EventRow & { timestampMs: number | null }): ActivityItem {
  const kind = classifyActivity(event.section, event.method);
  if (kind === null) {
    throw new Error(`${event.section}.${event.method} is not an agent-activity event`);
  }
  return {
    id: event.id,
    blockNumber: event.blockNumber,
    index: event.index,
    extrinsicId: event.extrinsicId,
    timestampMs: event.timestampMs,
    kind,
    section: event.section,
    method: event.method,
    agents: event.accounts,
    data: event.data,
  };
}
