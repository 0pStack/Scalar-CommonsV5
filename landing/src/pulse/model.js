// /pulse — the pure model. Which runtime events the page reacts to, what each
// one means in plain words, and the arithmetic of the counters and the
// effect cap. No DOM, no clock, no network: everything here is a function of
// its arguments, so the tests can hold every sentence and every animation to
// the event names the runtime itself declares (chain-events.json) without a
// browser.
//
// Why a table: the page's promise is that every light is a real transaction.
// EVENTS is the whole list of what can light up. A reviewer can read it
// against the pallets' event enums, and the test does.

import { shortAddress } from '../observatory/format.js';
import { EXPLORER_ORIGIN, field } from '../observatory/data.js';

/** The kinds of light, in the order the legend shows them. */
export const KINDS = ['agreement', 'message', 'settled', 'dispute', 'resolved', 'oracle', 'registered'];

/**
 * One row per runtime event the page reacts to. `lifetimeMs` is how long its
 * animation lives; `describe` is the word the legend and tooltips use.
 * `resolved` has no light of its own: it is the moment an amber thread
 * (DisputeOpened) returns to the accent and goes.
 */
export const EVENTS = [
  { section: 'escrow', method: 'AgreementCreated', kind: 'agreement', lifetimeMs: 400, describe: 'agreement opened' },
  { section: 'messages', method: 'MessageSent', kind: 'message', lifetimeMs: 1200, describe: 'message sent' },
  { section: 'escrow', method: 'DeliveryConfirmed', kind: 'settled', lifetimeMs: 1500, describe: 'work paid for' },
  { section: 'escrow', method: 'DisputeOpened', kind: 'dispute', lifetimeMs: 800, describe: 'dispute opened' },
  { section: 'escrow', method: 'DisputeResolved', kind: 'resolved', lifetimeMs: 1500, describe: 'dispute resolved' },
  { section: 'oracle', method: 'OracleResponseSubmitted', kind: 'oracle', lifetimeMs: 500, describe: 'oracle answer' },
  { section: 'oracle', method: 'BatchResponseSubmitted', kind: 'oracle', lifetimeMs: 500, describe: 'oracle answer' },
  { section: 'agents', method: 'AgentRegistered', kind: 'registered', lifetimeMs: 600, describe: 'agent joined' },
];

/**
 * How far behind the chain's head an event may be and still be animated: 30
 * blocks, three minutes at six seconds a block. The event index is read per
 * block as the chain finalizes, normally two blocks behind the head; anything
 * older than this window is history, and history is not a light.
 */
export const LIVE_WINDOW_BLOCKS = 30;
/** Live effects on screen at once; the oldest expire first past this. */
export const EFFECT_CAP = 200;
export const ACTIVE_WINDOW_MS = 10 * 60_000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
/** How many lines the ticker keeps, newest first. */
export const TICKER_MAX = 30;

const rows = new Map(EVENTS.map((row) => [`${row.section}.${row.method}`, row]));
const AGREEMENT_KINDS = new Set(['agreement', 'settled', 'dispute', 'resolved']);

/** The EVENTS row for an indexed event, or null when the page has no light for it. */
export function kindOf(event) {
  if (!event || typeof event !== 'object') return null;
  return rows.get(`${event.section}.${event.method}`) ?? null;
}

const rowOrThrow = (event) => {
  const row = kindOf(event);
  if (!row) throw new Error(`not an event the page reacts to: ${event?.section}.${event?.method}`);
  return row;
};

/**
 * Who is party to an event: `from` → `to`, the direction a thread is drawn.
 * An agreement's thread runs buyer → provider; a message runs sender →
 * recipient; an oracle answer and a registration have one party. Reads
 * through `field`, so a missing key is an error, never a guessed account.
 */
export function partiesOf(event) {
  const row = rowOrThrow(event);
  const data = field(event, 'data');
  if (AGREEMENT_KINDS.has(row.kind)) return { from: field(data, 'buyer'), to: field(data, 'provider') };
  if (row.kind === 'message') return { from: field(data, 'from'), to: field(data, 'to') };
  if (row.kind === 'oracle') return { from: field(data, 'agent'), to: null };
  return { from: field(data, 'who'), to: null };
}

/** The one key for an agreement: the chain identifies it by (buyer, provider, seq). */
export function agreementKey(buyer, provider, seq) {
  return `${buyer}>${provider}#${seq}`;
}

/**
 * The agreement an event is about, as a key, or null. A message names its
 * agreement as `[provider, seq]` when it is about one; the buyer is then
 * whichever end of the message is not the provider. A message about nothing
 * in particular has no thread to travel.
 */
export function agreementKeyOf(event) {
  const row = kindOf(event);
  if (!row) return null;
  const data = field(event, 'data');
  if (AGREEMENT_KINDS.has(row.kind)) return agreementKey(field(data, 'buyer'), field(data, 'provider'), field(data, 'seq'));
  if (row.kind !== 'message') return null;
  const agreement = data.agreement; // nullable by design: not every message is about an agreement
  if (!Array.isArray(agreement) || agreement.length !== 2) return null;
  const [provider, seq] = agreement;
  const from = field(data, 'from');
  const to = field(data, 'to');
  const buyer = from === provider ? to : from;
  if (buyer === provider) return null;
  return agreementKey(buyer, provider, seq);
}

/**
 * What an agent is called: its on-chain name when the index reports one (the
 * operator-run agents' `swarm-` names), else its address shortened the way
 * the observatory shortens it. Never an invented label.
 */
export function displayName(address, names) {
  const name = names?.get?.(address);
  return typeof name === 'string' && name.length > 0 ? name : shortAddress(address);
}

/** Whether an event is recent enough to light up: within LIVE_WINDOW_BLOCKS of the head, and not from its future. */
export function isLive(event, headNumber) {
  const block = field(event, 'blockNumber');
  if (!Number.isFinite(headNumber) || !Number.isFinite(block)) return false;
  const behind = headNumber - block;
  return behind >= 0 && behind <= LIVE_WINDOW_BLOCKS;
}

/**
 * Where a ticker line links: the extrinsic that emitted the event, on the
 * explorer, by the `<block>-<index>` id the index gives it — the same page the
 * observatory's upgrade rail links to. An event with no extrinsic (none the
 * page reacts to) links to its first party's activity instead.
 */
export function explorerHref(event) {
  const id = event?.extrinsicId;
  if (typeof id === 'string' && /^\d+-\d+$/.test(id)) {
    const [block, index] = id.split('-');
    return `${EXPLORER_ORIGIN}/extrinsic/${block}/${index}`;
  }
  return `${EXPLORER_ORIGIN}/activity?agent=${encodeURIComponent(partiesOf(event).from)}`;
}

/**
 * The event in one plain sentence, for a reader who knows nothing about the
 * chain: who did what to whom, and for how much. No time suffix — the ticker
 * adds "· 4 s ago" itself and keeps it current.
 */
export function sentence(event, names, formatCmn) {
  const row = rowOrThrow(event);
  const data = field(event, 'data');
  const who = (address) => displayName(address, names);
  switch (row.kind) {
    case 'agreement':
      return `${who(field(data, 'buyer'))} opened an agreement with ${who(field(data, 'provider'))} for ${formatCmn(field(data, 'amount'))} CMN`;
    case 'settled':
      return `${who(field(data, 'buyer'))} paid ${who(field(data, 'provider'))} ${formatCmn(field(data, 'amount'))} CMN for completed work`;
    case 'message':
      return `${who(field(data, 'from'))} sent a message to ${who(field(data, 'to'))}`;
    case 'dispute':
      return `${who(field(data, 'buyer'))} disputed a delivery from ${who(field(data, 'provider'))}`;
    case 'resolved':
      return `the dispute between ${who(field(data, 'buyer'))} and ${who(field(data, 'provider'))} was resolved`;
    case 'oracle':
      if (row.method === 'BatchResponseSubmitted') {
        const accepted = field(data, 'accepted');
        return `${who(field(data, 'agent'))} answered ${accepted} oracle ${accepted === 1 ? 'question' : 'questions'}`;
      }
      return `${who(field(data, 'agent'))} answered an oracle question`;
    default:
      return `${who(field(data, 'who'))} joined the network`;
  }
}

/** "4 s ago", "2 min ago", "1 h ago": the ticker's age, short because it is said thirty times over. */
export function ageText(atMs, nowMs) {
  const seconds = Math.max(0, Math.floor((nowMs - atMs) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

/**
 * The strip's three figures from the events seen: agents party to an event
 * in the last ten minutes, events in the last minute, messages in the last
 * hour. `seen` is `[{ kind, at, parties: { from, to } }]` with `at` in epoch
 * milliseconds — the instant the page read each one.
 */
export function counters(seen, nowMs) {
  const active = new Set();
  let eventsLastMinute = 0;
  let messagesLastHour = 0;
  for (const item of seen) {
    const age = nowMs - item.at;
    if (age < 0) continue;
    if (age <= ACTIVE_WINDOW_MS) {
      if (item.parties?.from) active.add(item.parties.from);
      if (item.parties?.to) active.add(item.parties.to);
    }
    if (age <= MINUTE_MS) eventsLastMinute += 1;
    if (item.kind === 'message' && age <= HOUR_MS) messagesLastHour += 1;
  }
  return { activeAgents: active.size, eventsLastMinute, messagesLastHour };
}

/**
 * A node's size from its activity in the last hour: one for a quiet agent,
 * growing with the square root of its count so a busy agent stands out
 * without crowding its neighbours, capped at six.
 */
export function nodeValue(activityLastHour) {
  const count = Number.isFinite(activityLastHour) && activityLastHour > 0 ? activityLastHour : 0;
  return Math.min(6, 1 + Math.sqrt(count));
}

/**
 * The effects still alive: those whose `until` is in the future, then only
 * the newest `cap` of them — the oldest expire first when the chain is busier
 * than the screen can show. Order is kept.
 */
export function expire(effects, nowMs, cap = EFFECT_CAP) {
  const alive = effects.filter((effect) => effect.until > nowMs);
  return alive.length > cap ? alive.slice(alive.length - cap) : alive;
}
