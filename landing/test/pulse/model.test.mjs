// The pulse page's pure model, held to the runtime's own event names
// (chain-events.json, read from the chain's metadata) and to the sentences the
// issue asks for, word for word.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EVENTS,
  KINDS,
  LIVE_WINDOW_BLOCKS,
  EFFECT_CAP,
  TICKER_MAX,
  kindOf,
  partiesOf,
  agreementKey,
  agreementKeyOf,
  displayName,
  isLive,
  explorerHref,
  sentence,
  ageText,
  counters,
  nodeValue,
  expire,
} from '../../src/pulse/model.js';
import { formatCmn } from '../../src/observatory/format.js';
import { EXPLORER_ORIGIN } from '../../src/observatory/data.js';

const metadata = JSON.parse(readFileSync(new URL('../../chain-events.json', import.meta.url), 'utf8'));

const BUYER = '5CdCULdBrDXrsm43KPaiUWJSG9WTBHHW5s8kJVz5U89bLiuq';
const PROVIDER = '5Dt87gd2vXhAumh2P3cBbNDkTbnb983cWn6uhkTZrDp1BPXW';
const AGENT = '5DLtHhwkjwrFVR4MypaSme4TmK3uKZHaz1HWiAZVvTsLeHMA';
const names = new Map([
  [BUYER, 'swarm-0042'],
  [PROVIDER, 'swarm-0117'],
]);

/** An indexed event as /v1/blocks/<n>/events reports one (shape read live on 2026-10-06). */
const indexed = (section, method, data, block = 919951, index = 38) => ({
  id: `${block}-${index}`,
  blockNumber: block,
  index,
  section,
  method,
  phase: 'ApplyExtrinsic',
  extrinsicId: `${block}-8`,
  data,
  accounts: Object.values(data).filter((v) => typeof v === 'string' && v.startsWith('5')),
});

const FIXTURES = {
  agreement: indexed('escrow', 'AgreementCreated', { buyer: BUYER, provider: PROVIDER, seq: 0, amount: '10000000000000' }),
  settled: indexed('escrow', 'DeliveryConfirmed', { buyer: BUYER, provider: PROVIDER, seq: 49, amount: '10000000000000' }),
  message: indexed('messages', 'MessageSent', {
    from: BUYER,
    to: PROVIDER,
    kind: 'DeliveryNotice',
    agreement: [PROVIDER, 1],
    payload_hash: '0x4b9a',
    payload_len: 290,
    nonce: '64',
  }),
  dispute: indexed('escrow', 'DisputeOpened', { buyer: BUYER, provider: PROVIDER, seq: 0, request_id: '0xb798' }),
  resolved: indexed('escrow', 'DisputeResolved', { buyer: BUYER, provider: PROVIDER, seq: 0, provider_wins: true }),
  oracle: indexed('oracle', 'OracleResponseSubmitted', { id: '0x2268', agent: AGENT }),
  batch: indexed('oracle', 'BatchResponseSubmitted', { agent: AGENT, accepted: 10, skipped: 0 }),
  registered: indexed('agents', 'AgentRegistered', { who: AGENT, stake: '1000000000000000', fee: '50000000000000' }),
};

test('every light is an event the runtime declares, read from its own metadata, and every kind has a light', () => {
  assert.equal(metadata.provenance.specName, 'scalar-commons');
  for (const row of EVENTS) {
    const pallet = metadata.pallets[row.section];
    assert.ok(pallet, `${row.section}.${row.method}: the runtime has no pallet ${row.section}`);
    assert.ok(pallet.includes(row.method), `${row.section} emits no ${row.method} (it emits ${pallet.join(', ')})`);
    assert.ok(KINDS.includes(row.kind), `${row.method} lights an unknown kind ${row.kind}`);
    assert.ok(row.lifetimeMs > 0 && row.lifetimeMs <= 2000, `${row.method}: a light lives between 0 and 2 s`);
  }
  for (const kind of KINDS) assert.ok(EVENTS.some((row) => row.kind === kind), `no event lights ${kind}`);
  // The issue's names, exactly: the settlement light is DeliveryConfirmed; the oracle answers are both ways of answering.
  assert.deepEqual(
    EVENTS.map((r) => `${r.section}.${r.method}`),
    [
      'escrow.AgreementCreated',
      'messages.MessageSent',
      'escrow.DeliveryConfirmed',
      'escrow.DisputeOpened',
      'escrow.DisputeResolved',
      'oracle.OracleResponseSubmitted',
      'oracle.BatchResponseSubmitted',
      'agents.AgentRegistered',
    ],
  );
  assert.ok(!metadata.pallets.escrow.includes('AgreementSettled'));
});

test('kindOf answers only for the table; anything else is no light', () => {
  assert.equal(kindOf(FIXTURES.settled).kind, 'settled');
  assert.equal(kindOf(FIXTURES.batch).kind, 'oracle');
  assert.equal(kindOf(indexed('balances', 'Withdraw', { who: AGENT, amount: '1' })), null);
  assert.equal(kindOf(indexed('escrow', 'DeliveryRecorded', { buyer: BUYER, provider: PROVIDER, seq: 0 })), null);
  assert.equal(kindOf(null), null);
});

test('parties run in the direction a thread is drawn, and a missing account is an error, not a guess', () => {
  assert.deepEqual(partiesOf(FIXTURES.agreement), { from: BUYER, to: PROVIDER });
  assert.deepEqual(partiesOf(FIXTURES.settled), { from: BUYER, to: PROVIDER });
  assert.deepEqual(partiesOf(FIXTURES.dispute), { from: BUYER, to: PROVIDER });
  assert.deepEqual(partiesOf(FIXTURES.resolved), { from: BUYER, to: PROVIDER });
  assert.deepEqual(partiesOf(FIXTURES.message), { from: BUYER, to: PROVIDER });
  assert.deepEqual(partiesOf(FIXTURES.oracle), { from: AGENT, to: null });
  assert.deepEqual(partiesOf(FIXTURES.registered), { from: AGENT, to: null });
  assert.throws(() => partiesOf(indexed('escrow', 'AgreementCreated', { buyer: BUYER })), /response has no provider/);
  assert.throws(() => partiesOf(indexed('system', 'ExtrinsicSuccess', {})), /not an event the page reacts to/);
});

test('an agreement has one key; a message about one finds it from either end; a message about nothing has none', () => {
  assert.equal(agreementKey(BUYER, PROVIDER, 3), `${BUYER}>${PROVIDER}#3`);
  assert.equal(agreementKeyOf(FIXTURES.agreement), agreementKey(BUYER, PROVIDER, 0));
  assert.equal(agreementKeyOf(FIXTURES.settled), agreementKey(BUYER, PROVIDER, 49));
  assert.equal(agreementKeyOf(FIXTURES.message), agreementKey(BUYER, PROVIDER, 1), 'the buyer is the end that is not the provider');
  const reply = indexed('messages', 'MessageSent', { ...FIXTURES.message.data, from: PROVIDER, to: BUYER });
  assert.equal(agreementKeyOf(reply), agreementKey(BUYER, PROVIDER, 1), 'the provider replying names the same agreement');
  const plain = indexed('messages', 'MessageSent', { ...FIXTURES.message.data, agreement: null });
  assert.equal(agreementKeyOf(plain), null);
  assert.equal(agreementKeyOf(FIXTURES.oracle), null);
});

test('an agent is called by its on-chain name when it has one, else by its shortened address, never a made-up label', () => {
  assert.equal(displayName(BUYER, names), 'swarm-0042');
  assert.equal(displayName(AGENT, names), '5DLt…eHMA');
  assert.equal(displayName(AGENT, new Map([[AGENT, '']])), '5DLt…eHMA');
  assert.equal(displayName(AGENT, null), '5DLt…eHMA');
});

test('only an event within the live window of the head lights up; history and the future do not', () => {
  assert.equal(LIVE_WINDOW_BLOCKS, 30);
  assert.ok(isLive(FIXTURES.agreement, 919951));
  assert.ok(isLive(FIXTURES.agreement, 919951 + LIVE_WINDOW_BLOCKS));
  assert.ok(!isLive(FIXTURES.agreement, 919951 + LIVE_WINDOW_BLOCKS + 1), 'three minutes old: history');
  assert.ok(!isLive(FIXTURES.agreement, 919950), 'an event ahead of the head is not trusted');
  assert.ok(!isLive(FIXTURES.agreement, null));
});

test('a ticker line links to the extrinsic on the explorer, by the id the index gives the event', () => {
  assert.equal(explorerHref(FIXTURES.settled), `${EXPLORER_ORIGIN}/extrinsic/919951/8`);
  const noExtrinsic = { ...FIXTURES.oracle, extrinsicId: null };
  assert.equal(explorerHref(noExtrinsic), `${EXPLORER_ORIGIN}/activity?agent=${encodeURIComponent(AGENT)}`);
});

test('each sentence reads as the issue wrote it', () => {
  const say = (event) => sentence(event, names, formatCmn);
  assert.equal(say(FIXTURES.settled), 'swarm-0042 paid swarm-0117 10 CMN for completed work');
  assert.equal(say(FIXTURES.message), 'swarm-0042 sent a message to swarm-0117');
  assert.equal(say(FIXTURES.dispute), 'swarm-0042 disputed a delivery from swarm-0117');
  assert.equal(say(FIXTURES.oracle), '5DLt…eHMA answered an oracle question');
  assert.equal(say(FIXTURES.batch), '5DLt…eHMA answered 10 oracle questions');
  assert.equal(say(FIXTURES.agreement), 'swarm-0042 opened an agreement with swarm-0117 for 10 CMN');
  assert.equal(say(FIXTURES.resolved), 'the dispute between swarm-0042 and swarm-0117 was resolved');
  assert.equal(say(FIXTURES.registered), '5DLt…eHMA joined the network');
  assert.equal(sentence(indexed('oracle', 'BatchResponseSubmitted', { agent: AGENT, accepted: 1, skipped: 0 }), names, formatCmn), '5DLt…eHMA answered 1 oracle question');
});

test('ages are short, because they are said thirty times over', () => {
  assert.equal(ageText(100_000, 104_000), '4 s ago');
  assert.equal(ageText(100_000, 100_000), '0 s ago');
  assert.equal(ageText(0, 2 * 60_000 + 5_000), '2 min ago');
  assert.equal(ageText(0, 3_600_000 + 1), '1 h ago');
  assert.equal(ageText(200, 100), '0 s ago', 'a clock that runs backwards is not a negative age');
});

test('the three figures: agents active in ten minutes, events in a minute, messages in an hour', () => {
  const now = 1_000_000_000;
  const seen = [
    { kind: 'message', at: now - 10_000, parties: { from: BUYER, to: PROVIDER } },
    { kind: 'settled', at: now - 50_000, parties: { from: BUYER, to: PROVIDER } },
    { kind: 'oracle', at: now - 61_000, parties: { from: AGENT, to: null } },
    { kind: 'message', at: now - 11 * 60_000, parties: { from: 'x', to: 'y' } }, // eleven minutes: not active, still a message of the hour
    { kind: 'message', at: now - 61 * 60_000, parties: { from: 'z', to: null } }, // over an hour: nothing
    { kind: 'message', at: now + 5_000, parties: { from: 'future', to: null } }, // ahead of the clock: ignored
  ];
  assert.deepEqual(counters(seen, now), { activeAgents: 3, eventsLastMinute: 2, messagesLastHour: 2 });
  assert.deepEqual(counters([], now), { activeAgents: 0, eventsLastMinute: 0, messagesLastHour: 0 });
});

test('a node grows with the square root of its hour, from one to at most six', () => {
  assert.equal(nodeValue(0), 1);
  assert.equal(nodeValue(4), 3);
  assert.equal(nodeValue(100), 6);
  assert.equal(nodeValue(undefined), 1);
});

test('effects expire by lifetime, then the oldest first past the cap, in order', () => {
  assert.equal(EFFECT_CAP, 200);
  assert.equal(TICKER_MAX, 30);
  const now = 10_000;
  const effects = Array.from({ length: 250 }, (_, i) => ({ i, until: i < 20 ? now - 1 : now + 1 }));
  const alive = expire(effects, now);
  assert.equal(alive.length, 200);
  assert.equal(alive[0].i, 50, 'the 20 dead and the 30 oldest living are gone');
  assert.equal(alive[199].i, 249);
  assert.deepEqual(expire([{ until: now + 1 }], now, 5), [{ until: now + 1 }]);
});
