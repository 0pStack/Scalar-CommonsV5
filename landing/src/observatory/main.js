// Boot for /observatory: one shared context, then the instruments in order of
// what the reader sees first. The chain pulse starts immediately and draws
// the river strip along the first screen's foot as well as its own plate;
// the hero's height and the status bar (with the hero's live line, a second
// view of the same state) listen to it, so they start right after it; the
// agent field, framed in the hero, and the last hour's row come next (the
// network graph is fetched only when its switch is turned on); the rest yield to the
// browser between them so the page never blocks on an instrument. The
// Sources switch, presenter mode (the P key or the Present button — never a
// URL flag) and the scroll reveal are wired last, once every section exists.

import { createContext } from './context.js';
import { relativeTime } from './format.js';
import * as pulse from './instruments/pulse.js';
import * as agentField from './instruments/agent-field.js';
import * as lastHour from './instruments/last-hour.js';
import * as messaging from './instruments/messaging.js';
import * as era from './instruments/era-dial.js';
import * as economy from './instruments/economy.js';
import * as validators from './instruments/validator-ring.js';
import * as history from './instruments/history.js';
import * as upgrades from './instruments/upgrade-rail.js';
import * as posture from './instruments/posture.js';
import * as verify from './instruments/verify.js';
import * as statusbar from './statusbar.js';
import * as presenter from './presenter.js';
import * as hero from './hero.js';
import * as sources from './sources.js';
import { start as startReveal } from './reveal.js';

/** Each instrument and the element it draws into, in boot order. */
const INSTRUMENTS = [
  ['pulse', pulse, '#chain'],
  ['agent-field', agentField, '.hero'],
  ['last-hour', lastHour, '.hero'],
  ['messaging', messaging, '.hero'],
  ['era', era, '#economy'],
  ['economy', economy, '#economy'],
  ['validators', validators, '#validators'],
  ['history', history, '#history'],
  ['upgrades', upgrades, '#upgrades'],
  ['posture', posture, '#verify'],
  ['verify', verify, '#verify'],
];

function yieldToBrowser() {
  return new Promise((resolve) => {
    if ('requestIdleCallback' in window) window.requestIdleCallback(() => resolve(), { timeout: 250 });
    else setTimeout(resolve, 0);
  });
}

/** Marks an instrument that threw during init: the failure is shown, not hidden. */
function markFailed(root, error) {
  console.error(error);
  const note = document.createElement('p');
  note.className = 'instrument-failed';
  note.setAttribute('role', 'alert');
  note.textContent = `This instrument could not start: ${error.message}`;
  root.querySelector('.instrument')?.replaceChildren(note);
}

async function boot() {
  const ctx = createContext();
  ctx.start();
  let river = null; // the chain pulse's handle: its tick re-reads the rate, so a stall is said without a new block

  for (const [name, instrument, selector] of INSTRUMENTS) {
    const root = document.querySelector(selector);
    if (!root) continue;
    try {
      if (name === 'pulse') river = instrument.init(root, ctx, { strip: document.querySelector('.hero-river') });
      else instrument.init(root, ctx);
    } catch (error) {
      markFailed(root, error);
    }
    if (name === 'pulse') {
      try {
        hero.init(document.querySelector('.hero'), ctx);
      } catch (error) {
        console.error(error);
      }
      try {
        const bar = statusbar.init(document.querySelector('[data-reading="networkStatus"]'), ctx, {
          mirrors: [...document.querySelectorAll('.live-line')],
        });
        // A stalled chain emits no events, so the bar cannot notice a stall
        // from events alone. main.js is the only module allowed to hold an
        // interval (see observatory.test.mjs), so the prompt lives here and
        // stops while the tab is hidden.
        if (bar?.tick || river?.tick) {
          setInterval(() => {
            if (document.hidden) return;
            bar?.tick?.();
            river?.tick?.();
          }, statusbar.STALL_CHECK_MS);
        }
      } catch (error) {
        console.error(error);
      }
      continue; // the first screen is first; everything else yields
    }
    await yieldToBrowser();
  }

  lastMerge(ctx);
  sources.init(document, ctx);
  presenter.init(document, ctx);
  reveal(ctx);
}

/**
 * Sections fade up 12 px once as they are scrolled to — CSS and an
 * IntersectionObserver, no library. Nothing is hidden under reduced motion,
 * and turning it on mid-visit shows everything at once.
 */
function reveal(ctx) {
  const running = startReveal({
    targets: [...document.querySelectorAll('[data-reveal]')],
    html: document.documentElement,
    IntersectionObserver: window.IntersectionObserver,
    reduced: () => ctx.motion.reduced(),
  });
  if (running) {
    ctx.motion.onChange((reduced) => {
      if (reduced) running.stop();
    });
  }
}

/** "Last merge to master: N hours ago" — from the public GitHub API, retried each minute on failure. */
function lastMerge(ctx) {
  const target = ctx.reading('lastMerge');
  if (!target) return;
  let record = null;
  const render = () => {
    ctx.readout.apply(target, record, (data) => {
      const date = Date.parse(ctx.field(data, '0.commit.committer.date'));
      if (Number.isNaN(date)) throw new Error('commit date is not a date');
      ctx.readout.showValue(target, record, { value: relativeTime(date, ctx.now()) });
      const prov = target.querySelector('.reading-prov');
      const commit = document.createElement('a');
      commit.href = ctx.field(data, '0.html_url');
      commit.target = '_blank';
      commit.rel = 'noopener';
      commit.className = 'mono';
      commit.textContent = String(ctx.field(data, '0.sha')).slice(0, 7);
      prov.append(' · commit ', commit);
    });
  };
  const load = async () => {
    record = await ctx.fetch(ctx.SOURCES.lastMerge);
    render();
  };
  load();
  setInterval(() => {
    if (document.hidden) return;
    if (record?.ok) render();
    else load();
  }, 60_000);
}

boot();
