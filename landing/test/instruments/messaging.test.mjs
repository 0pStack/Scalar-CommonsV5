// The spec gate. `shouldShow` decides whether a version-fenced figure may be
// seen, and the cases that matter are the ones where the answer is "no":
// below the fence, and — the one easy to get wrong — when the spec cannot be
// read at all.

import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldShow } from '../../src/observatory/instruments/messaging.js';
import { SOURCES } from '../../src/observatory/data.js';
import { FIGURES } from '../../src/observatory/instruments/last-hour.js';

test('the spec gate shows a 309 figure only on 309 and later', () => {
  assert.equal(shouldShow(309, 309), true, 'exactly at the fence');
  assert.equal(shouldShow(309, 310), true, 'above the fence');
  assert.equal(shouldShow(309, 400), true);
  assert.equal(shouldShow(309, 307), false, 'below the fence');
  assert.equal(shouldShow(309, 0), false);
});

test('an unreadable spec HIDES the figure rather than guessing', () => {
  // This is the case that protects the page's contract. If we cannot tell
  // which runtime is in force we cannot stand behind its figures, and leaving
  // a figure visible would outlive the knowledge that justified it.
  assert.equal(shouldShow(309, null), false);
  assert.equal(shouldShow(309, undefined), false);
  assert.equal(shouldShow(309, NaN), false);
  assert.equal(shouldShow(309, 'nine'), false);
});

test('an element with no fence is not gated', () => {
  assert.equal(shouldShow(NaN, 307), true, 'no data-min-spec means always shown');
  assert.equal(shouldShow(null, 307), true);
});

test('both messaging readings are fed by a declared source', () => {
  for (const key of ['messagesSent', 'hourMessages']) {
    assert.ok(
      Object.values(SOURCES).some((s) => s.readings?.includes(key)),
      `${key} has a source in data.js`,
    );
  }
});

test('the messages source reads the messages pallet from the indexer', () => {
  assert.match(SOURCES.messagesSent.path, /section=messages/);
  assert.match(SOURCES.messagesSent.path, /method=MessageSent/);
  assert.equal(SOURCES.messagesSent.kind, 'api');
});

test('hourMessages counts the messages source and nothing else', () => {
  const figure = FIGURES.find((f) => f.key === 'hourMessages');
  assert.ok(figure, 'hourMessages is one of the last-hour figures');
  assert.deepEqual(figure.sources, ['messagesSent']);
});
