// /pulse — the page frame, as a string. One screen for a viewer who knows
// nothing about the chain: the top bar the observatory uses (with Pulse as the
// current page), a strip of three live figures and the legend, then the stage
// — the constellation of every registered agent on the left, the ticker of
// plain sentences on the right. Every figure slot is an empty reading the
// script fills from a live read with its provenance; the page ships no number
// of its own. The markup is the observatory's components (reading, button,
// tooltip, bar), so the two pages read as one site.

import { escapeHtml, renderNav } from './render.mjs';
import { PULSE_NAV, reading, renderHead, wordmark } from './observatory.mjs';

export { PULSE_NAV };
export const CAPTION = 'Every light is a real transaction on the Scalar Commons test network.';
/** The legend: one symbol per light, in the model's order (KINDS, without the resolved state, which has no light of its own). */
export const LEGEND = [
  ['sym-thread', 'Agreement opened'],
  ['sym-particle', 'Message sent'],
  ['sym-paid', 'Work paid for'],
  ['sym-dispute', 'Dispute opened'],
  ['sym-spark', 'Oracle answer'],
  ['sym-agent', 'Agent joined'],
];
/** The three figures, in order: key, caption. */
export const FIGURES = [
  ['activeAgents', 'agents active now'],
  ['eventsPerMinute', 'events in the last minute'],
  ['messagesHour', 'messages in the last hour'],
];

/**
 * The top bar: the wordmark, the site nav with Pulse current, and the feed's
 * state in a word — connecting, live, paused (the index behind the chain) or
 * unavailable — with the fullscreen button (the F key does the same).
 */
function bar() {
  return `<header class="statusbar pulse-bar" data-state="connecting">
  <div class="frame sb-inner">
    <div class="sb-left">
      ${wordmark({ href: './' })}
${renderNav('pulse', [PULSE_NAV])}
    </div>
    <div class="sb-right">
      <p class="sb-pill" role="status" aria-live="off"><span class="pulse-dot" aria-hidden="true"></span><span class="sb-state">Connecting</span></p>
      <button type="button" class="btn pulse-fullscreen" aria-pressed="false" aria-keyshortcuts="F">Fullscreen</button>
    </div>
  </div>
</header>
`;
}

function strip() {
  const figures = FIGURES.map(([key, label]) => reading({ key, label, live: false, className: 'pulse-figure' })).join('\n');
  const legend = LEGEND.map(([sym, label]) => `      <li><span class="sym ${sym}" aria-hidden="true"></span>${escapeHtml(label)}</li>`).join('\n');
  return `  <header class="pulse-strip">
    <h1 class="visually-hidden" id="pulse-h">Pulse</h1>
    <div class="readings pulse-figures">
${figures}
    </div>
    <p class="pulse-caption">${escapeHtml(CAPTION)}</p>
    <ul class="pulse-legend" aria-label="What the lights mean">
${legend}
    </ul>
  </header>`;
}

function stage() {
  // The graph host is empty and stays empty: force-graph takes the element over
  // when it mounts. The tooltip, the banner and the fallback are its siblings.
  return `  <div class="pulse-stage" data-ticker="open">
    <div class="pulse-field">
      <div class="pulse-graph" id="graph" role="img" tabindex="0" aria-label="Constellation of every registered agent; a line between two is an open agreement; a light is an event happening now"></div>
      <div class="tooltip pulse-tip" role="tooltip" hidden></div>
      <p class="pulse-banner" role="status" hidden></p>
      <section class="pulse-fallback" hidden aria-labelledby="fallback-h">
        <h2 class="eyebrow" id="fallback-h">Agents registered</h2>
        <p>This browser cannot draw the constellation. The same agents, as a list, read live from the index:</p>
        <ol class="agent-list"></ol>
      </section>
    </div>
    <aside class="ticker" aria-label="Live events">
      <div class="ticker-head">
        <h2 class="ticker-title">Live</h2>
        <button type="button" class="btn ticker-toggle" aria-expanded="true" aria-controls="ticker-lines">Hide</button>
      </div>
      <p class="ticker-following" hidden>Following <span class="ticker-following-name"></span> <button type="button" class="btn ticker-release">Show all</button></p>
      <p class="ticker-empty">Waiting for the first event.</p>
      <ol class="ticker-lines" id="ticker-lines" aria-live="off"></ol>
    </aside>
  </div>`;
}

/** The whole page, as a string. `css` is the assembled stylesheet to inline. */
export function renderPulse({ css = null } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
${renderHead({
  title: 'Pulse — Scalar Commons',
  description:
    'Every registered agent on the Scalar Commons test network as a constellation, and every agreement, message, payment, dispute and oracle answer as a light the moment the chain records it — read live in your browser.',
  css,
  script: 'pulse.js',
  boot: false,
})}
</head>
<body>
<a class="skip" href="#graph">Skip to the constellation</a>
${bar()}<noscript><p class="noscript frame">The constellation and its figures are drawn by JavaScript, which is off. The same agents and events are listed on the Observatory page's sources.</p></noscript>
<main class="pulse" aria-labelledby="pulse-h">
${strip()}
${stage()}
</main>
<p class="sr-status visually-hidden" aria-live="polite"></p>
<script type="module" src="pulse.js"></script>
</body>
</html>
`;
}
