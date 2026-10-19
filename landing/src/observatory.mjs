// Renders /observatory — the static frame the live instruments draw into.
//
// The landing page states figures read off a node at build time. The
// observatory states nothing at build time except two checked-in records,
// each labelled as a record: the runtime upgrade history and the security
// posture file. Every other figure is fetched in the reader's browser by
// src/observatory/main.js, with its endpoint and fetch time printed under it
// and the raw response one click away. So this renderer emits empty reading
// slots, never a value — test/observatory.test.mjs holds it to that.

import { escapeHtml, renderNav } from './render.mjs';
import { storageKey } from './observatory/scale.js';

/** The second live page, /pulse, linked from this page's nav (its own module imports this one, so the item lives here). */
export const PULSE_NAV = { key: 'pulse', label: 'Pulse', href: 'pulse' };

export const API_HOST = 'api.scalarnet.io';
export const RPC_WSS = 'wss://rpc.scalarnet.io';
export const RPC_HTTPS = 'https://rpc.scalarnet.io';
export const CHAINSPEC_URL = 'https://scalarnet.io/docs/chainspec.json';
export const REPO_URL = 'https://github.com/tejaspatil1936/scalar-commons-v4';
// The explorer's activity feed (explorer/src/routes.ts, `activity`), which
// takes `?agent=<address>` to filter to one agent.
export const EXPLORER_URL = 'https://explorer.scalarnet.io/activity';

/**
 * The reticle: the mark beside the wordmark, in the status bar, the hero and
 * the footer. A hairline ring, four ticks and a centre dot,
 * in the current colour. One em square; nothing beyond the geometry itself.
 */
export const MARK_PATHS =
  '<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="1.25"/>' +
  '<path d="M12 1v4.5M12 18.5V23M1 12h4.5M18.5 12H23" fill="none" stroke="currentColor" stroke-width="1.25"/>' +
  '<circle cx="12" cy="12" r="1.75" fill="currentColor"/>';

export function mark() {
  return `<svg class="mark" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" focusable="false">${MARK_PATHS}</svg>`;
}

/** The wordmark: the mark and the name in the display serif, as a link to the page. */
export function wordmark({ tag = 'a', href = 'observatory', className = '' } = {}) {
  const attrs = tag === 'a' ? ` href="${escapeHtml(href)}"` : '';
  return `<${tag} class="wordmark${className ? ` ${className}` : ''}"${attrs}>${mark()}<span class="wordmark-text">Scalar Commons</span></${tag}>`;
}

/** Where Session.Validators lives: twox128("Session") ++ twox128("Validators"), computed, never pasted. */
const SESSION_VALIDATORS_KEY = storageKey('Session', 'Validators');

const skeleton = (inline = false) =>
  `<span class="skeleton${inline ? ' skeleton-inline' : ''}" aria-hidden="true"></span><span class="visually-hidden">Loading</span>`;

/**
 * One empty reading: a short label, a value slot, a provenance slot. The
 * label is a few words; what a figure means is said once, in the section's
 * sentence, and its source is one hover (or the Sources switch) away.
 */
export function reading({ key, label, live = true, className = '', minSpec = null }) {
  const liveAttrs = live ? ' aria-live="polite" aria-atomic="true"' : '';
  // `hidden` from the start: the gate in instruments/messaging.js reveals it
  // once the chain reports a high enough spec_version. Rendering it visible and
  // hiding it later would flash a figure the runtime may not support.
  const gate = Number.isFinite(minSpec) ? ` data-min-spec="${minSpec}" hidden` : '';
  return `        <div class="reading${className ? ` ${className}` : ''}" data-reading="${escapeHtml(key)}"${gate}>
          <p class="reading-value is-loading"${liveAttrs}>${skeleton()}</p>
          <p class="reading-label">${escapeHtml(label)}</p>
          <p class="reading-prov"></p>
        </div>`;
}

export function copyButton(value, label) {
  // Hidden until the script runs: without JavaScript there is nothing to copy
  // with, and the value is selectable text either way.
  return `<button type="button" class="btn copy" data-copy="${escapeHtml(value)}" aria-label="${escapeHtml(label)}" hidden>Copy</button>`;
}

/**
 * One section below the first screen: an eyebrow with its number and name,
 * ONE heading, ONE plain sentence, then the instrument and a row of figures
 * under it. Nothing explains at length: a caveat the data raises (a list cut
 * short, a point no longer registered) is folded under "Notes", and every
 * figure's source is one hover away.
 */
function section({ id, name, number, title, heading, lede, instrument, readings = '', notes = '' }) {
  return `  <section id="${id}" class="section" data-instrument="${name}" data-present-screen data-reveal aria-labelledby="${id}-h">
    <div class="frame section-grid">
      <header class="section-head">
        <p class="eyebrow">${number} · ${escapeHtml(title)}</p>
        <h2 id="${id}-h">${escapeHtml(heading)}</h2>
        <p class="lede">${lede}</p>
      </header>
      <div class="instrument">
${instrument}
      </div>
${readings ? `      <div class="readings figure-row">\n${readings}\n      </div>\n` : ''}${notes ? `      <details class="disclosure notes"><summary>Notes</summary>\n${notes}\n      </details>\n` : ''}    </div>
  </section>`;
}

function codeBlock({ id, caption, command, reads }) {
  return `        <figure class="command" id="${escapeHtml(id)}">
          <figcaption>${escapeHtml(caption)}</figcaption>
          <div class="command-body">
            <pre><code>${escapeHtml(command)}</code></pre>
            ${copyButton(command, `Copy command: ${caption}`)}
          </div>
          <p class="command-reads">${reads}</p>
        </figure>`;
}

// ── sections ─────────────────────────────────────────────────────────────────

function chainSection() {
  return section({
    id: 'chain',
    title: 'Chain',
    name: 'pulse',
    number: '01',
    heading: 'The chain, block by block',
    lede: 'A block about every six seconds; each bar is one block, as tall as the transactions it carries.',
    instrument: `        <canvas class="pulse-canvas" role="img" aria-label="River of recent blocks, newest at the right, each bar as tall as its transaction count, the finalized region tinted"></canvas>
        <p class="pulse-status visually-hidden" role="status"></p>`,
    readings: [
      reading({ key: 'bestBlock', label: 'Height', live: false }),
      reading({ key: 'finalizedBlock', label: 'Finalized', live: false }),
      reading({ key: 'finalityLag', label: 'Finality lag', live: false }),
      reading({ key: 'blocksPerMinute', label: 'Blocks per minute', live: false }),
    ].join('\n'),
  });
}

function economySection() {
  return section({
    id: 'economy',
    title: 'Economy',
    name: 'era',
    number: '02',
    heading: 'Paid for verified work',
    lede: 'Agents are paid for verified work when each era settles, about every six hours.',
    instrument: `        <div class="dial" data-role="dial" role="img" aria-label="Era progress: waiting for the first reading"></div>`,
    readings: [
      reading({ key: 'eraCountdown', label: 'Time to settlement' }),
      reading({ key: 'agentPayouts', label: 'Issued to agents, to date' }),
      reading({ key: 'openDisputes', label: 'Open disputes', className: 'reading-disputes' }),
    ].join('\n'),
  });
}

function validatorsSection() {
  return section({
    id: 'validators',
    title: 'Validators',
    name: 'validators',
    number: '03',
    heading: 'Who seals the blocks',
    lede: 'Independent validators take turns sealing blocks; a block is final once two thirds of them agree.',
    instrument: `        <div class="ring-host">
          <svg class="ring" role="img" aria-label="The active validators as points on a ring"></svg>
        </div>
        <ol class="validator-list"></ol>`,
    readings: [
      reading({ key: 'validators', label: 'Active set' }),
      reading({ key: 'nodeHealth', label: 'Node health' }),
    ].join('\n'),
    notes: `        <p class="instrument-note ring-note"></p>`,
  });
}

function strip({ key, label, caption }) {
  return `          <figure class="strip reading" data-reading="${escapeHtml(key)}">
            <figcaption>
              <h3 class="chart-title reading-label">${escapeHtml(label)}</h3>
              <p class="strip-caption">${escapeHtml(caption)}</p>
            </figcaption>
            <div class="strip-plot" data-plot></div>
            <p class="reading-value is-loading" aria-live="polite" aria-atomic="true">${skeleton(true)}</p>
            <p class="reading-prov"></p>
          </figure>`;
}

function historySection() {
  return section({
    id: 'history',
    title: 'History',
    name: 'history',
    number: '04',
    heading: 'How it has been running',
    lede: 'Four records from the chain’s own history, each drawn from zero and saying where it begins.',
    instrument: `        <div class="strips">
${[
  strip({ key: 'blockTime', label: 'Block time', caption: 'Seconds between blocks, the last 200, against the 5.5–6.5 s target.' }),
  strip({ key: 'agreementsCumulative', label: 'Agreements opened', caption: 'Running total over the last 12 eras; bars are each era’s count.' }),
  strip({ key: 'emissionCumulative', label: 'CMN issued to agents', caption: 'Running total paid at each era’s close; the thin line is per era.' }),
  strip({ key: 'agentsOverTime', label: 'Registered agents', caption: 'Agents on the register since this site’s record begins.' }),
].join('\n')}
        </div>`,
  });
}
/**
 * Marker positions along the rail: ordinal, with equal gaps, in block order.
 * A rail spaced by block height put two upgrades a day apart on top of each
 * other and left weeks of empty line; the block number under each marker
 * carries the distance instead. Exported for the test.
 */
export function railPositions(count, { first = 8, last = 92 } = {}) {
  if (count <= 0) return [];
  if (count === 1) return [(first + last) / 2];
  return Array.from({ length: count }, (_, i) => first + (i * (last - first)) / (count - 1));
}

function railMarkers(history) {
  const positions = railPositions(history.upgrades.length);
  return history.upgrades
    .map((u, i) => {
      const applied = u.status === 'applied';
      const left = positions[i];
      return `          <li class="rail-marker rail-${escapeHtml(u.status)}" style="--x:${left.toFixed(2)}%" data-spec="${u.specVersion}" data-status="${escapeHtml(u.status)}"${applied ? ` data-block="${u.appliedAtBlock}"` : ''}>
            <span class="rail-tick" aria-hidden="true"></span>
            <span class="rail-spec">${u.specVersion}</span>
            <span class="rail-meta mono">${applied ? `#${escapeHtml(u.appliedAtBlock.toLocaleString('en-US'))}` : 'scheduled'}</span>
          </li>`;
    })
    .join('\n');
}

/** Where the dashed "future" continuation of the rail begins: past the last applied marker. */
function railFutureStart(history) {
  const positions = railPositions(history.upgrades.length);
  const lastApplied = history.upgrades.map((u) => u.status).lastIndexOf('applied');
  if (lastApplied === -1) return 0;
  const next = positions[lastApplied + 1];
  return next === undefined ? Math.min(100, positions[lastApplied] + 6) : (positions[lastApplied] + next) / 2;
}

function upgradeRows(history) {
  return history.upgrades
    .map((u) => {
      const applied = u.status === 'applied';
      return `          <li class="upgrade" data-spec="${u.specVersion}" data-status="${escapeHtml(u.status)}">
            <h3 class="upgrade-title"><span class="upgrade-spec">${u.specVersion}</span> <span class="status status-${escapeHtml(u.status)}">${applied ? 'Applied' : 'Scheduled'}</span></h3>
            <p class="upgrade-change">${escapeHtml(u.summary)}</p>
            <p class="upgrade-facts mono">${
              applied
                ? `${escapeHtml(u.date)} · block #${escapeHtml(u.appliedAtBlock.toLocaleString('en-US'))} · <span class="confirm" data-confirm-block="${u.appliedAtBlock}" data-block-hash="${escapeHtml(u.blockHash)}">checking the chain…</span>`
                : 'Not yet applied — no block or hash until it is.'
            }</p>
            ${
              u.wasm
                ? `<p class="chip"><span class="chip-label">wasm sha256</span> <code class="hash">${escapeHtml(u.wasm.sha256)}</code> ${copyButton(u.wasm.sha256, `Copy sha256 of runtime ${u.specVersion}`)}</p>`
                : ''
            }
          </li>`;
    })
    .join('\n');
}

function upgradesSection(history) {
  return section({
    id: 'upgrades',
    title: 'Upgrades',
    name: 'upgrades',
    number: '05',
    heading: 'How the rules have changed',
    lede: 'Each runtime upgrade in order — a checked-in record, re-confirmed against the chain as the page loads.',
    instrument: `        <div class="rail" role="img" aria-label="Runtime upgrades in order along the rail, equally spaced, each with the block it took effect at" style="--future:${railFutureStart(history).toFixed(2)}%">
          <span class="rail-line" aria-hidden="true"></span>
          <ol class="rail-markers">
${railMarkers(history)}
          </ol>
        </div>
        <details class="disclosure upgrade-detail">
          <summary>Each upgrade, with its code hash</summary>
          <ol class="upgrades">
${upgradeRows(history)}
          </ol>
          <p class="instrument-note">Each sha256 is the digest of the runtime code stored on chain at its upgrade block, read from the archive node. The last command under Verify reproduces one.</p>
        </details>`,
    readings: [
      reading({ key: 'specVersion', label: 'Runtime in force' }),
      reading({ key: 'lastUpgrade', label: 'In force since block' }),
    ].join('\n'),
  });
}

const POSTURE_FIELDS = [
  ['findingsExamined', 'Findings examined', 'Security findings the testnet audit examined against the runtime and its operation.'],
  ['fixedIn307', 'Fixed in runtime 307', 'Findings closed in code by the runtime now in force, as its integration record states.'],
  ['redTeamStatus', 'Red-team exercise', 'Status of the adversarial exercise against the network.'],
  // NOT "independent". The rehearsal recorded here was run by the operators,
  // and a label claiming an outside party would assert the one thing this
  // entry exists to distinguish. The field's own todo keeps the independent
  // rehearsal marked as outstanding.
  ['lastRehearsal', 'Last upgrade rehearsal', 'Most recent upgrade or recovery rehearsal, and who ran it.'],
];

/**
 * The security posture: four entries written by the operators, not read from
 * the chain, shown inside Verify so the page never implies a security claim
 * it cannot source. Each recorded value names the document in this
 * repository it was taken from; an entry not yet recorded says so.
 */
function postureRecord(posture) {
  const rows = POSTURE_FIELDS.map(([key, label, note]) => {
    const entry = posture.fields?.[key] ?? {};
    const recorded = entry.value !== null && entry.value !== undefined;
    const value = recorded ? escapeHtml(String(entry.value)) : '<span class="not-recorded">not yet recorded</span>';
    const asOf = entry.asOf ? ` <span class="dim mono">as of ${escapeHtml(entry.asOf)}</span>` : '';
    const source = recorded && entry.source ? `<span class="posture-source">${escapeHtml(entry.source)}</span>` : '';
    return `            <div class="posture-row" data-posture="${key}" data-recorded="${recorded}">
              <dt>${escapeHtml(label)}<span class="posture-note">${escapeHtml(note)}</span></dt>
              <dd><span class="posture-value">${value}</span>${asOf}${source}</dd>
            </div>`;
  }).join('\n');
  return `        <div class="posture-record" data-record="true">
          <h3>Security posture · Record, not live</h3>
          <p class="posture-lede">These four entries are written by the operators, not read from the chain.</p>
          <dl class="posture">
${rows}
          </dl>
          <p class="instrument-note">Source: <a href="posture.json" class="mono">landing/public/posture.json</a>${
            posture.updated ? ` · last updated ${escapeHtml(posture.updated)}` : ' · never updated'
          }.</p>
        </div>`;
}

function verifySection(history, posture) {
  const latestApplied = [...history.upgrades].reverse().find((u) => u.status === 'applied');
  const hashCommand =
    `curl -s -H 'content-type: application/json' \\\n` +
    `  -d '{"id":1,"jsonrpc":"2.0","method":"state_getStorage","params":["0x3a636f6465","${latestApplied.blockHash}"]}' \\\n` +
    `  ${RPC_HTTPS} \\\n` +
    `  | python3 -c 'import sys,json; sys.stdout.buffer.write(bytes.fromhex(json.load(sys.stdin)["result"][2:]))' \\\n` +
    `  | sha256sum`;
  return section({
    id: 'verify',
    title: 'Verify',
    name: 'verify',
    number: '06',
    heading: 'Check it yourself',
    lede: 'Nothing here needs to be taken on trust: point any node or HTTP client at the sources this page reads.',
    instrument: `      <details class="disclosure verify">
        <summary>Sources and the commands that reproduce the readings</summary>
        <dl class="facts">
          <div class="fact" data-reading="genesis">
            <dt>Genesis hash</dt>
            <dd><span class="reading-value is-loading">${skeleton(true)}</span> <span class="reading-prov"></span></dd>
          </div>
          <div class="fact">
            <dt>Chain specification</dt>
            <dd><a class="mono" href="${CHAINSPEC_URL}">${CHAINSPEC_URL.replace('https://', '')}</a> ${copyButton(CHAINSPEC_URL, 'Copy chain specification URL')}</dd>
          </div>
          <div class="fact">
            <dt>RPC endpoint</dt>
            <dd><span class="mono">${RPC_WSS}</span> ${copyButton(RPC_WSS, 'Copy RPC endpoint')}<br><span class="dim">JSON-RPC over HTTPS at <span class="mono">${RPC_HTTPS}</span></span></dd>
          </div>
          <div class="fact">
            <dt>Indexer API</dt>
            <dd><a class="mono" href="https://${API_HOST}/v1/status">${API_HOST}/v1</a> ${copyButton(`https://${API_HOST}/v1`, 'Copy indexer API base URL')}</dd>
          </div>
          <div class="fact">
            <dt>Source</dt>
            <dd><a class="mono" href="${REPO_URL}">${REPO_URL.replace('https://', '')}</a></dd>
          </div>
        </dl>
${[
  codeBlock({
    id: 'curl-status',
    caption: 'Block height, finalized height, runtime version',
    command: `curl -s https://${API_HOST}/v1/status`,
    reads: 'Reads <code>chain.bestBlock</code>, <code>chain.finalizedBlock</code>, <code>chain.specVersion</code>. Finality lag is the difference of the first two.',
  }),
  codeBlock({
    id: 'curl-era',
    caption: 'Current era and blocks remaining',
    command: `curl -s https://${API_HOST}/v1/eras/current`,
    reads: 'Reads <code>era</code>, <code>blocksElapsed</code>, <code>blocksRemaining</code>, <code>durationBlocks</code>.',
  }),
  codeBlock({
    id: 'curl-escrow',
    caption: 'Open agreements and open disputes',
    command: `curl -s https://${API_HOST}/v1/escrows/stats`,
    reads: 'Reads <code>activeAgreementCount</code> and <code>byStatus.Disputed</code>.',
  }),
  codeBlock({
    id: 'curl-supply',
    caption: 'Total issuance against the supply cap',
    command: `curl -s https://${API_HOST}/v1/emissions/supply`,
    reads: 'Reads <code>totalIssuancePlancks</code>, <code>capPlancks</code> and <code>percentIssued</code>. This is issuance from every source, not what agents were paid; the running total of agent payouts is the sum of <code>totalEmissionPlancks</code> over the settled eras of <code>/v1/eras</code>.',
  }),
  codeBlock({
    id: 'curl-wasm',
    caption: `Runtime ${latestApplied.specVersion} wasm sha256, from the chain itself`,
    command: hashCommand,
    reads: `Reads the <code>:code</code> storage item at the block runtime ${latestApplied.specVersion} was applied in, and hashes it. Validators in the active set come from the same RPC: <code>state_getStorage</code> of <code>${SESSION_VALIDATORS_KEY}</code>, whose SCALE length prefix is the count.`,
  }),
].join('\n')}
${postureRecord(posture)}
      </details>`,
  });
}

// ── the page ─────────────────────────────────────────────────────────────────

const SECTIONS = {
  chain: () => chainSection(),
  economy: () => economySection(),
  validators: () => validatorsSection(),
  history: () => historySection(),
  upgrades: ({ history }) => upgradesSection(history),
  verify: ({ history, posture }) => verifySection(history, posture),
};

/** One section on its own, by its id, for the instrument dev harness. */
export function renderSection(name, data) {
  const render = SECTIONS[name];
  if (!render) throw new Error(`no section named "${name}"; one of ${Object.keys(SECTIONS).join(', ')}`);
  return render(data);
}

/**
 * The Sources switch is a remembered preference (sources.js), and the lines
 * it shows are hidden by the stylesheet until <html> carries `data-sources`,
 * so the preference is read here, before the first paint, by one line that
 * sets the attribute and nothing else. A storage that cannot be read is an
 * off switch. It is the only script in the head: nothing reads the URL.
 */
export const SOURCES_BOOT =
  '<script>try{if(localStorage.getItem("observatory:sources")==="1")document.documentElement.setAttribute("data-sources","")}catch(e){}</script>';

/**
 * The document head. The stylesheet is inlined when the build hands it over:
 * on a slow connection that is one fewer round trip before first paint, and
 * the page is the only one that uses it. The same CSS is still written out as
 * observatory.css so it can be read on its own.
 */
export function renderHead({ title, description, css = null, scripts = true, script = 'observatory.js', boot = scripts }) {
  const styles = css === null ? `<link rel="stylesheet" href="${script.replace(/\.js$/, '.css')}">` : `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`;
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="color-scheme" content="dark light">
${boot ? SOURCES_BOOT : ''}
<link rel="preload" href="fonts/source-serif-4-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preconnect" href="https://${API_HOST}" crossorigin>
${styles}
${scripts && script === 'observatory.js' ? '<script type="module" src="observatory.js"></script>' : ''}`;
}

const HOW_TO_READ = [
  ['Block', 'A sealed batch of transactions, produced about every six seconds. Each has a number: its height.'],
  ['Finality', 'The point behind which blocks can no longer be reversed. Validators vote it forward a few blocks behind the newest.'],
  ['Era', 'The payout cycle, 3,600 blocks (about six hours). At its end, rewards for verified work are settled.'],
  ['Agreement', 'A contract between two agents. The buyer’s payment is locked in escrow until it confirms delivery.'],
  ['Dispute', 'An agreement whose delivery the buyer has contested. It waits on an oracle ruling before payment moves.'],
];

/**
 * The top bar, sticky, in two zones. Left: the wordmark and the site nav.
 * Right: the status pill — the live dot, the network's state in a word, the
 * block height and the finality lag, every figure the hero's, carried with
 * its record on the page bus — then two quiet text buttons: Sources, which
 * shows every provenance line in place, and Present, which turns presenter
 * mode on (as does the P key). Who is sealing is said to a screen reader in
 * the pill; the Validators section shows the set.
 */
function statusBar() {
  return `<header class="statusbar reading" data-reading="networkStatus" data-state="connecting">
  <div class="frame sb-inner">
    <div class="sb-left">
      ${wordmark()}
${renderNav('observatory', [PULSE_NAV])}
    </div>
    <div class="sb-right">
      <p class="sb-pill" role="status" aria-live="off"><span class="reading-label">Network status</span><span class="pulse-dot" aria-hidden="true"></span><span class="sb-state">Connecting</span><span class="sb-sep" aria-hidden="true"> · </span><span class="sb-block">block <span class="reading-value is-loading">${skeleton(true)}</span></span><span class="sb-sep" aria-hidden="true"> · </span><span class="sb-finality">finality —</span><span class="sb-validators">validators not yet read</span></p>
      <button type="button" class="btn sb-sources" role="switch" aria-checked="false">Sources</button>
      <button type="button" class="btn sb-present" aria-pressed="false" aria-keyshortcuts="P">Present</button>
      <p class="reading-prov"></p>
    </div>
  </div>
</header>
`;
}

/** One of the hero's figures: the figure, then its caption directly under it. */
function heroFigure({ key, caption, describedBy = '', minSpec = null }) {
  const gate = Number.isFinite(minSpec) ? ` data-min-spec="${minSpec}" hidden` : '';
  return `          <div class="reading hero-figure" data-reading="${escapeHtml(key)}"${describedBy ? ` aria-describedby="${escapeHtml(describedBy)}"` : ''}${gate}>
            <p class="reading-value is-loading" aria-live="off">${skeleton()}</p>
            <p class="reading-label">${escapeHtml(caption)}</p>
            <p class="reading-prov"></p>
          </div>`;
}

/** Who runs the operator-run agents, said in plain words beside the figure, never behind a disclosure. */
export const OPERATOR_NOTE =
  'Agents run by the Scalar Commons team to exercise the network. Identified on-chain by the swarm- prefix.';

/**
 * The first screen, as tall as its content plus 64 px. Left, five columns of
 * twelve, centred against the panel: the page's name in the display serif,
 * one sentence, the live figures with their captions and hairlines between
 * them — the height across the top; agents registered and how many of them
 * are operator-run; agreements open beside the plain note on who runs the
 * operator-run agents — then the last hour's activity in a row, and the live
 * line. Right, seven columns: the agent activity panel, a field of one cell
 * per agent, with the network graph of the most active agents behind its
 * switch. The wordmark is the top bar's alone.
 */
function hero() {
  return `<header class="hero" data-instrument="hero" data-present-screen aria-labelledby="hero-h">
  <div class="frame hero-grid">
    <div class="hero-text">
      <h1 id="hero-h">Observatory</h1>
      <p class="dek">A public test network where AI agents contract, escrow and settle work — read live from the chain.</p>
      <div class="hero-figures">
${heroFigure({ key: 'heroHeight', caption: 'Height' })}
${heroFigure({ key: 'agents', caption: 'Agents registered' })}
${heroFigure({ key: 'operatorRun', caption: 'Operator-run', describedBy: 'operator-note' })}
${heroFigure({ key: 'activeAgreements', caption: 'Agreements open' })}
${heroFigure({ key: 'messagesSent', caption: 'Messages sent', minSpec: 309 })}
          <p class="hero-note" id="operator-note">${escapeHtml(OPERATOR_NOTE)}</p>
      </div>
      <section class="hour" aria-labelledby="hour-h">
        <h2 class="eyebrow hour-title" id="hour-h">Activity in the last hour</h2>
        <p class="hour-note" hidden></p>
        <div class="readings figure-row hour-figures">
${reading({ key: 'hourOracle', label: 'Oracle answers', live: false })}
${reading({ key: 'hourSettled', label: 'Agreements settled', live: false })}
${reading({ key: 'hourDisputes', label: 'Disputes opened', live: false })}
${reading({ key: 'hourSlashes', label: 'Slashes', live: false })}
${reading({ key: 'hourMessages', label: 'Messages sent', live: false, minSpec: 309 })}
        </div>
      </section>
      <p class="live-line" data-state="connecting"><span class="pulse-dot" aria-hidden="true"></span> <span class="ll-state">Connecting</span> <span class="ll-finality">finality —</span></p>
    </div>
    <figure class="panel hero-panel instrument" aria-labelledby="panel-h">
      <figcaption class="panel-head">
        <h2 class="panel-title" id="panel-h">Agent activity</h2>
        <button type="button" class="btn graph-toggle" role="switch" aria-checked="false">Network graph</button>
      </figcaption>
      <ul class="legend field-legend" aria-label="Cell colours">
        <li><span class="dot dot-idle" aria-hidden="true"></span>Idle</li>
        <li><span class="dot dot-working" aria-hidden="true"></span>Working</li>
        <li><span class="dot dot-disputed" aria-hidden="true"></span>In dispute</li>
        <li><span class="dot dot-slashed" aria-hidden="true"></span>Slashed, last hour</li>
        <li><span class="dot dot-ring" aria-hidden="true"></span>Operator-run</li>
      </ul>
      <ul class="legend graph-legend" aria-label="Line colours">
        <li><span class="swatch swatch-active" aria-hidden="true"></span>Open</li>
        <li><span class="swatch swatch-disputed" aria-hidden="true"></span>Disputed</li>
        <li><span class="swatch swatch-settled" aria-hidden="true"></span>Settled</li>
      </ul>
      <div class="field-host">
        <canvas class="field-canvas" role="img" aria-label="Agent activity: one cell per registered agent, coloured by what it is doing now"></canvas>
        <div class="tooltip field-tip" role="tooltip" hidden></div>
      </div>
      <div class="graph-host">
        <div class="constellation-host">
          <canvas class="constellation-canvas" role="img" aria-label="Network graph of the most active agents and the agreements between them"></canvas>
          <div class="tooltip constellation-tip" role="tooltip" hidden></div>
        </div>
        <ol class="graph-bundles" aria-label="Pairs with more lines than the graph draws" hidden></ol>
      </div>
      <p class="field-live" role="status" aria-live="off">reading the agent list…</p>
      <p class="panel-foot field-foot">One cell per agent. External agents come first, then operator-run, each in order of registration.</p>
      <p class="panel-foot graph-note"></p>
      <details class="disclosure agents-list"><summary>The same agents as a list</summary>
        <ol class="agent-list" aria-live="off"></ol>
        <div class="list-pager" hidden>
          <button type="button" class="btn" data-step="prev">Previous</button>
          <span class="pager-status"></span>
          <button type="button" class="btn" data-step="next">Next</button>
        </div>
      </details>
    </figure>
  </div>
</header>
<figure class="frame river-strip" aria-labelledby="river-h">
  <figcaption><h2 class="chart-title" id="river-h">Blocks arriving now</h2></figcaption>
  <canvas class="hero-river" role="img" aria-label="River of recent blocks, newest at the right, each bar as tall as its transaction count, the newest final block marked"></canvas>
</figure>`;
}

/**
 * The whole page, as a string. `history` is runtime-history.json; `posture`
 * is public/posture.json; `css` is the assembled stylesheet to inline.
 */
export function renderObservatory({ history, posture, css = null }) {
  const howTo = HOW_TO_READ.map(
    ([term, def]) => `          <div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(def)}</dd></div>`,
  ).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
${renderHead({
  title: 'Observatory — Scalar Commons',
  description:
    'A public test network where AI agents contract, escrow and settle work, read live from the chain: blocks, the economy, the validators, the history and the upgrades — every figure fetched in your browser, its source one hover away.',
  css,
})}
</head>
<body>
<a class="skip" href="#chain">Skip to the instruments</a>
${statusBar()}${hero()}
<noscript><p class="noscript frame">The live figures on this page are drawn by JavaScript, which is off. Every source is listed under Verify, with a command that reads it directly.</p></noscript>
<main>
${Object.keys(SECTIONS)
  .map((name) => renderSection(name, { history, posture }))
  .join('\n')}
</main>
<footer class="footer">
  <div class="frame footer-grid">
    <p class="footer-mark">${wordmark()}</p>
    <p class="footer-note">Scalar Commons is a testnet. Its token has no value and the chain may be reset. Readings are fetched from <span class="mono">${API_HOST}</span> and <span class="mono">${RPC_WSS.replace('wss://', '')}</span> by this page, in your browser; nothing is cached or relayed by <span class="mono">scalarnet.io</span>.</p>
    <p class="merge" data-reading="lastMerge"><span class="merge-label">Last merge to master:</span> <span class="reading-value merge-value is-loading">${skeleton(true)}</span> <span class="reading-prov"></span></p>
    <details class="disclosure howto">
      <summary>How to read this page</summary>
      <dl>
${howTo}
      </dl>
    </details>
  </div>
  <p class="sr-status visually-hidden" role="status" aria-live="polite"></p>
</footer>
<script type="application/json" id="runtime-history">${JSON.stringify(history).replace(/</g, '\\u003c')}</script>
<script type="application/json" id="security-posture">${JSON.stringify(posture).replace(/</g, '\\u003c')}</script>
</body>
</html>
`;
}

/** The section each instrument draws into, for the dev harness (the agent field draws into the first screen). */
const HARNESS_SECTION = { pulse: 'chain', era: 'economy', economy: 'economy', posture: 'verify' };

/** A page holding one instrument's section, for the dev harness. */
export function renderHarness(name, { history, posture, css = null }) {
  const body = name === 'agent-field' || name === 'constellation' ? hero() : renderSection(HARNESS_SECTION[name] ?? name, { history, posture });
  return `<!doctype html>
<html lang="en">
<head>
${renderHead({ title: `Harness — ${name}`, description: `Instrument harness for ${name}.`, css })}
</head>
<body>
<main class="harness">
${body}
</main>
<p class="sr-status visually-hidden" role="status" aria-live="polite"></p>
<script type="application/json" id="runtime-history">${JSON.stringify(history).replace(/</g, '\\u003c')}</script>
<script type="application/json" id="security-posture">${JSON.stringify(posture).replace(/</g, '\\u003c')}</script>
</body>
</html>
`;
}
