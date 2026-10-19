// "The last hour", as the event index can answer it. Counts of events come
// from the finalized-block index, which can fall behind the chain; an hour
// measured back from the chain's head would then start past everything the
// index holds and every count would read 0. So the hour is the 600 blocks up
// to the newest block the index has synced (`indexer.syncedHeight` on
// /v1/status), and when the index is an hour or more behind the chain the
// page says so in words beside the counts.
//
// One status read per page serves every instrument that counts the last
// hour (the hour row, the agent field's slashed cells), so they always count
// the same blocks.

/** The runtime's HOURS: SECS_PER_BLOCK = 6 (runtime/src/lib.rs), so 600 blocks. */
export const BLOCKS_PER_HOUR = 600;
const STATUS_INTERVAL_MS = 30_000;

/** The index's newest hour from a /v1/status body: blocks `since`…`to`, and how far the index is behind the head. Pure; tested. */
export function indexHour(status, field) {
  const to = field(status, 'indexer.syncedHeight');
  const best = field(status, 'chain.bestBlock');
  return { since: Math.max(0, to - BLOCKS_PER_HOUR), to, best, behind: Math.max(0, best - to) };
}

/** The sentence the page shows when the index is an hour or more behind the chain; empty otherwise. Pure; tested. */
export function lagNote({ to, behind }, formatInteger = String) {
  if (behind < BLOCKS_PER_HOUR) return '';
  const hours = (behind / BLOCKS_PER_HOUR).toFixed(1);
  return (
    `Counted over the index’s newest hour, to block #${formatInteger(to)}: ` +
    `the index is ${formatInteger(behind)} blocks (about ${hours} h) behind the chain.`
  );
}

const trackers = new WeakMap();

/**
 * The page's one tracker of the index's newest hour: `get()` is the latest
 * `{ since, to, best, behind }` or null, `record()` the status read it came
 * from, and `onChange(fn)` calls `fn({ hour, record, error })` on every read
 * (and at once if one has arrived).
 */
export function hourTracker(ctx) {
  if (trackers.has(ctx)) return trackers.get(ctx);
  let hour = null;
  let latest = null;
  let error = null;
  const listeners = new Set();
  const tracker = {
    get: () => hour,
    record: () => latest,
    onChange(fn) {
      listeners.add(fn);
      if (latest) fn({ hour, record: latest, error });
    },
  };
  trackers.set(ctx, tracker);
  ctx.watch(
    'status',
    (record) => {
      latest = record;
      if (!record.ok) {
        error = record.error;
        hour = null;
      } else {
        try {
          hour = indexHour(record.data, ctx.field);
          error = null;
        } catch (e) {
          hour = null;
          error = e.message;
        }
      }
      for (const fn of listeners) fn({ hour, record, error });
    },
    STATUS_INTERVAL_MS,
  );
  return tracker;
}
