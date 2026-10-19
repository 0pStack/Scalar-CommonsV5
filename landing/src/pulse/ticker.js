// The ticker down the right of /pulse: every live event as one plain
// sentence, newest first, thirty kept, each a link to the extrinsic on the
// explorer. The sentences are the model's (tested word for word against the
// issue); this file only puts them on the page in order of when they
// happened, keeps their ages current, narrows them to one agent while that
// agent is followed, and says so when the feed is down. Nothing is written
// here that the chain did not do: the ticker has no sample lines and no
// filler, and before the first event it says it is waiting.

import { TICKER_MAX, ageText, displayName, explorerHref, sentence } from './model.js';
import { feedDown } from './wiring.js';

export function init(root, ctx, feed) {
  const list = root.querySelector('.ticker-lines');
  const toggle = root.querySelector('.ticker-toggle');
  const following = root.querySelector('.ticker-following');
  const followingName = following?.querySelector('.ticker-following-name');
  const release = following?.querySelector('.ticker-release');
  const empty = root.querySelector('.ticker-empty');
  const stage = root.closest('.pulse-stage');
  const lines = []; // newest first: { li, age, at, parties }
  let filterAddress = null;
  let downReason = null; // while the feed is unavailable or behind the chain
  const releaseListeners = new Set();

  function render() {
    const now = ctx.now();
    let shown = 0;
    for (const line of lines) {
      const hidden = filterAddress !== null && line.parties.from !== filterAddress && line.parties.to !== filterAddress;
      line.li.hidden = hidden;
      if (!hidden) {
        shown += 1;
        line.age.textContent = ageText(line.at, now);
      }
    }
    if (empty) {
      if (downReason) {
        empty.hidden = false;
        empty.textContent = `live feed unavailable — ${downReason}. ${shown ? 'The lines below are dated; nothing newer is known.' : ''}`.trim();
      } else {
        empty.hidden = shown > 0;
        empty.textContent = lines.length === 0 ? 'Waiting for the first event.' : 'Nothing yet for this agent.';
      }
    }
  }

  /** Adds a line where its instant belongs: the list is newest first, whether a line arrives live or from the index's record. */
  function push({ event, row, parties, at }) {
    const li = document.createElement('li');
    li.dataset.kind = row.kind;
    const a = document.createElement('a');
    a.href = explorerHref(event);
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = sentence(event, feed.names(), ctx.format.formatCmn);
    const age = document.createElement('span');
    age.className = 'ticker-age';
    li.append(a, ' · ', age);
    const index = lines.findIndex((line) => line.at <= at);
    if (index === -1) {
      list.append(li);
      lines.push({ li, age, at, parties });
    } else {
      list.insertBefore(li, lines[index].li);
      lines.splice(index, 0, { li, age, at, parties });
    }
    while (lines.length > TICKER_MAX) lines.pop().li.remove();
    render();
  }

  function filter(address) {
    filterAddress = address ?? null;
    if (following) {
      following.hidden = filterAddress === null;
      if (followingName && filterAddress !== null) followingName.textContent = displayName(filterAddress, feed.names());
    }
    render();
  }

  toggle?.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'false';
    toggle.setAttribute('aria-expanded', String(!open));
    toggle.textContent = open ? 'Show' : 'Hide';
    if (stage) stage.dataset.ticker = open ? 'closed' : 'open';
  });
  release?.addEventListener('click', () => {
    filter(null);
    for (const fn of releaseListeners) fn();
  });
  feed.on('status', (status) => {
    downReason = feedDown(status.state) ? (status.reason ?? 'no source answered') : null;
    render();
  });

  render();
  return {
    push,
    filter,
    tick: render,
    /** Called when the reader releases the followed agent from the ticker's own button. */
    onRelease: (fn) => releaseListeners.add(fn),
  };
}
