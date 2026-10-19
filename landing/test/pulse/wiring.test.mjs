// The pure parts of the page's wiring: what the strip says a figure was
// counted from, what the banner says for each feed state, which states take
// the figures down, an agent's role from the open agreements, and where the
// feed reads from again after a block the index had not reached.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basisText, COUNTER, KEYS } from '../../src/pulse/strip.js';
import { bannerText, feedDown, roleOf } from '../../src/pulse/wiring.js';
import { retryFrom } from '../../src/pulse/feed.js';
import { FIGURES } from '../../src/pulse.mjs';

test('the strip names both reads a figure comes from, and the three keys are the page’s three figures', () => {
  assert.equal(basisText(0), 'from the index’s last hour');
  assert.equal(basisText(1), 'from the index’s last hour and 1 live event since');
  assert.equal(basisText(12), 'from the index’s last hour and 12 live events since');
  assert.deepEqual(KEYS, FIGURES.map(([key]) => key));
  assert.deepEqual(Object.keys(COUNTER), KEYS);
  assert.deepEqual(Object.values(COUNTER), ['activeAgents', 'eventsLastMinute', 'messagesLastHour']);
});

test('the banner says why nothing is moving — a feed that is down or an index behind the chain are both "unavailable" — and nothing when live', () => {
  assert.equal(bannerText({ state: 'live' }), '');
  assert.equal(bannerText({ state: 'connecting' }), '');
  assert.equal(bannerText({ state: 'unavailable', reason: 'socket WebSocket closed (code 1006); status poll request failed' }), 'live feed unavailable — socket WebSocket closed (code 1006); status poll request failed');
  assert.equal(bannerText({ state: 'unavailable' }), 'live feed unavailable — no source answered');
  assert.equal(bannerText({ state: 'stale', head: 920_000, indexed: 919_000 }, (n) => n.toLocaleString('en-US')), 'live feed unavailable — the index is 1,000 blocks behind the chain');
  assert.equal(bannerText({ state: 'stale', reason: 'the index has not reported its height' }), 'live feed unavailable — the index has not reported its height');
  assert.ok(feedDown('stale') && feedDown('unavailable'));
  assert.ok(!feedDown('live') && !feedDown('connecting'));
});

test('an agent’s role is provider if it provides in any open agreement, else buyer if it buys, else agent', () => {
  const links = [
    { buyer: 'a', provider: 'b' },
    { buyer: 'b', provider: 'c' },
  ];
  assert.equal(roleOf('a', links), 'buyer');
  assert.equal(roleOf('b', links), 'provider', 'providing outranks buying');
  assert.equal(roleOf('c', links), 'provider');
  assert.equal(roleOf('d', links), 'agent');
  assert.equal(roleOf('a', []), 'agent');
});

test('a block the index has not reached is read again from the next head, not skipped', () => {
  assert.equal(retryFrom(null, 920_100), 920_099, 'the first head, not yet indexed: the next head reads it first');
  assert.equal(retryFrom(920_090, 920_100), 920_090, 'blocks already read stay read');
  assert.equal(retryFrom(920_105, 920_100), 920_099, 'never ahead of the block to retry');
});
