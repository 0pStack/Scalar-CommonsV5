// The strip across the top of /pulse: three live figures in the display
// serif — agents active now (party to an event in the last ten minutes),
// events in the last minute, messages in the last hour. Each is counted from
// two reads and says so: the index's last hour (the six event lists, read
// with provenance at load, so the figures are right from the first second)
// and every live event the page has seen since. A read that fails, or a feed
// that is down or behind the chain, makes all three "unavailable" — a counter
// that silently dropped one of its six lists, or stood still while the feed
// was gone, would be a number presented as the truth.

import { HOUR_MS, counters } from './model.js';
import { feedDown } from './wiring.js';

/** The reading keys the strip fills, in order, and the counter each shows. */
export const KEYS = ['activeAgents', 'eventsPerMinute', 'messagesHour'];
export const COUNTER = { activeAgents: 'activeAgents', eventsPerMinute: 'eventsLastMinute', messagesHour: 'messagesLastHour' };
const EXTRA = {
  activeAgents: 'agents party to an event in the last 10 minutes',
  eventsPerMinute: 'events the page reacts to, in the last minute',
  messagesHour: 'messages.MessageSent in the last hour',
};

/** The words under a figure for where it was counted from. Pure; tested. */
export function basisText(liveSeen) {
  if (!liveSeen) return 'from the index’s last hour';
  return `from the index’s last hour and ${liveSeen} live ${liveSeen === 1 ? 'event' : 'events'} since`;
}

export function init(root, ctx, feed) {
  const targets = Object.fromEntries(KEYS.map((key) => [key, ctx.reading(key, root)]).filter(([, el]) => el));
  let seeded = []; // from the index's last hour: { id, kind, at, parties }
  let live = []; // from the blocks read since
  const liveIds = new Set();
  let provenance = null; // the record the figures are read from: the index's hour, then the newest live block
  let liveSeen = 0;
  // Two separate reasons to say "unavailable", each cleared by its own stream.
  let hourBroken = null; // { record, reason } while the hour's read is failing
  let down = null; // { record, reason } while the feed is unavailable or behind the chain

  function show() {
    const failed = down ?? hourBroken;
    if (failed) {
      for (const target of Object.values(targets)) ctx.readout.showError(target, failed.record, failed.reason);
      return;
    }
    if (!provenance) return; // nothing read yet: the skeleton stays
    const now = ctx.now();
    const cutoff = now - HOUR_MS;
    live = live.filter((item) => item.at >= cutoff);
    const figures = counters([...seeded, ...live], now);
    for (const key of KEYS) {
      if (!targets[key]) continue;
      ctx.readout.showValue(targets[key], provenance, { value: figures[COUNTER[key]], extra: `${EXTRA[key]} · ${basisText(liveSeen)}`, motion: ctx.motion });
    }
  }

  feed.on('hour', ({ records, events, error }) => {
    const list = Object.values(records);
    const broken = list.find((record) => !record?.ok);
    if (broken || error) {
      hourBroken = { record: broken ?? list[0] ?? null, reason: broken?.error ?? error };
      show();
      return;
    }
    hourBroken = null;
    // An event the page already saw live is counted once, whichever read it came from.
    seeded = events
      .filter(({ event }) => !liveIds.has(event.id))
      .map(({ event, row, parties, at }) => ({ id: event.id, kind: row.kind, at, parties }));
    provenance ??= records.messagesSent ?? list[0];
    show();
  });

  feed.on('event', ({ event, row, parties, at, record }) => {
    if (liveIds.has(event.id)) return;
    liveIds.add(event.id);
    live.push({ id: event.id, kind: row.kind, at, parties });
    seeded = seeded.filter((item) => item.id !== event.id);
    liveSeen += 1;
    if (record?.ok) provenance = record;
    show();
  });

  feed.on('status', (status) => {
    down = feedDown(status.state) ? { record: status.record ?? null, reason: status.reason ?? 'live feed unavailable' } : null;
    show();
  });

  return { tick: show };
}
