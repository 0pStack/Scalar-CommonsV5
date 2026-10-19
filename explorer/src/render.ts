/**
 * Server-side HTML rendering.
 *
 * Pure functions from view model to markup: no chain access, no JavaScript
 * shipped to the browser, no client-side framework. An explorer is read-only by
 * nature, so a page that arrives fully rendered is both the simplest thing that
 * works and the one that keeps working when a node is slow — there is no second
 * round trip to fail.
 *
 * Every interpolated value goes through `escapeHtml`, because every value on
 * these pages came off a public chain and is therefore attacker-supplied.
 */

import { escapeHtml, formatBalance, formatTimestamp, shortHash } from './format.js';
import { accountPath, activityPath, blockPath, extrinsicPath } from './routes.js';
import type {
  AccountView,
  ActivityEntry,
  ActivityField,
  ActivityView,
  BlockView,
  ChainInfo,
  EventView,
  ExtrinsicView,
  HomeView,
  Outcome,
} from './types.js';

const STYLES = `
:root { color-scheme: dark; --bg:#0d1117; --raised:#151b23; --border:#2a3340; --text:#e8edf3;
  --dim:#a3b0c0; --accent:#6fd3c7; --ok:#7ddba3; --bad:#f08c8c; }
* { box-sizing: border-box; }
body { margin:0; padding:0 1.5rem 4rem; background:var(--bg); color:var(--text);
  font:400 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
header, main, footer { max-width:64rem; margin-inline:auto; }
header { display:flex; flex-wrap:wrap; gap:1rem; align-items:baseline; justify-content:space-between;
  padding:1.5rem 0; border-bottom:1px solid var(--border); }
.wordmark { font-size:.8125rem; font-weight:600; letter-spacing:.16em; text-transform:uppercase;
  color:var(--accent); text-decoration:none; }
.chain { color:var(--dim); font-size:.8125rem; }
nav a { font-size:.8125rem; margin-right:1rem; }
.kind { display:inline-block; padding:0 .45rem; border:1px solid var(--border); border-radius:.25rem;
  font-size:.75rem; white-space:nowrap; color:var(--accent); }
.kind.slash, .kind.dispute { color:var(--bad); }
.kind.heartbeat { color:var(--dim); }
form.filter { display:flex; flex-wrap:wrap; gap:.5rem; margin:1rem 0; }
form.filter input { flex:1 1 24rem; min-width:0; padding:.4rem .6rem; background:var(--raised); color:var(--text);
  border:1px solid var(--border); border-radius:.25rem; font:inherit; font-size:.875rem; }
form.filter button { padding:.4rem .9rem; background:var(--raised); color:var(--accent);
  border:1px solid var(--border); border-radius:.25rem; font:inherit; font-size:.875rem; cursor:pointer; }
a { color:var(--accent); }
h1 { font-size:1.5rem; margin:2rem 0 .5rem; }
h2 { font-size:1rem; margin:2rem 0 .5rem; color:var(--dim); text-transform:uppercase; letter-spacing:.08em; }
code, .mono, td, th { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
table { width:100%; border-collapse:collapse; font-size:.875rem; }
th, td { text-align:left; padding:.5rem .6rem; border-bottom:1px solid var(--border); vertical-align:top;
  word-break:break-all; }
th { color:var(--dim); font-weight:600; }
.kv th { width:14rem; }
.empty { color:var(--dim); font-style:italic; }
.ok { color:var(--ok); }
.bad { color:var(--bad); }
.unknown { color:var(--dim); }
footer { padding-top:2rem; color:var(--dim); font-size:.8125rem; }
`;

/**
 * Wraps a page body in the shared chrome. `chain` is null before a connection exists.
 *
 * `refreshSeconds` makes the page reload itself — the one way a server-rendered,
 * script-free page stays live.
 */
function layout(
  title: string,
  chain: ChainInfo | null,
  body: string,
  refreshSeconds?: number,
  footer = "Read directly from the node's runtime metadata. Nothing on this page is cached or hand-written.",
): string {
  const identity = chain
    ? `${escapeHtml(chain.chain)} · ${escapeHtml(chain.specName)}/${chain.specVersion} · ${escapeHtml(
        chain.tokenSymbol,
      )}`
    : 'not connected';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${
    refreshSeconds === undefined ? '' : `\n<meta http-equiv="refresh" content="${refreshSeconds}">`
  }
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<header>
  <a class="wordmark" href="/">Scalar Commons Explorer</a>
  <nav><a href="${activityPath()}">Agent activity</a></nav>
  <span class="chain">${identity}</span>
</header>
<main>
${body}
</main>
<footer>${escapeHtml(footer)}</footer>
</body>
</html>
`;
}

/** Renders a dispatch outcome, keeping "unknown" visibly distinct from "success". */
function outcomeCell(outcome: Outcome): string {
  switch (outcome.kind) {
    case 'success':
      return '<span class="ok">success</span>';
    case 'failed':
      return `<span class="bad">failed: ${escapeHtml(outcome.reason)}</span>`;
    case 'unknown':
      return '<span class="unknown">outcome not recorded</span>';
  }
}

/**
 * Renders who signed an extrinsic.
 *
 * `signer` is only set when the extrinsic's address decoded to an `AccountId`,
 * which `MultiAddress::Index`, `::Raw` and `::Address20` never do. Those are
 * still signed extrinsics, so the decision is made on `isSigned` — the field
 * the chain itself reports — and not on whether there happened to be an account
 * to link to. Deciding on the link alone would print "unsigned" over a
 * signature the node did report.
 */
function signerCell(isSigned: boolean, signer: string | null, unsignedLabel: string): string {
  if (signer !== null) {
    return accountLink(signer);
  }
  return isSigned
    ? '<span class="empty">signed (its address is not an AccountId)</span>'
    : `<span class="empty">${unsignedLabel}</span>`;
}

function accountLink(address: string): string {
  return `<a class="mono" href="${escapeHtml(accountPath(address))}">${escapeHtml(address)}</a>`;
}

function blockLinkByNumber(number: number): string {
  return `<a href="${escapeHtml(blockPath({ kind: 'number', number }))}">${number}</a>`;
}

function blockLinkByHash(hash: string): string {
  return `<a class="mono" href="${escapeHtml(blockPath({ kind: 'hash', hash }))}">${escapeHtml(
    shortHash(hash),
  )}</a>`;
}

function kvTable(rows: readonly (readonly [string, string])[]): string {
  const body = rows
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${value}</td></tr>`)
    .join('\n');
  return `<table class="kv"><tbody>\n${body}\n</tbody></table>`;
}

/** The index page: which chain this is, and the way in to the block view. */
export function renderHome(view: HomeView): string {
  const body = `<h1>Scalar Commons block explorer</h1>
<h2>Chain</h2>
${kvTable([
  ['Chain', escapeHtml(view.chain.chain)],
  ['Runtime', `${escapeHtml(view.chain.specName)} spec ${view.chain.specVersion}`],
  ['Token', `${escapeHtml(view.chain.tokenSymbol)} (${view.chain.tokenDecimals} decimals)`],
  ['SS58 format', String(view.chain.ss58Format)],
  ['Genesis hash', `<span class="mono">${escapeHtml(view.chain.genesisHash)}</span>`],
  ['Head', `${blockLinkByNumber(view.head.number)} ${blockLinkByHash(view.head.hash)}`],
])}
<p><a href="${activityPath()}">Agent activity</a> — messages, registrations, heartbeats, agreements, disputes, oracle votes and slashes, newest first.</p>`;

  return layout('Scalar Commons Explorer', view.chain, body);
}

/** A block, and the list of extrinsics that is the way through to everything else. */
export function renderBlock(view: BlockView, chain: ChainInfo): string {
  const extrinsics = view.extrinsics
    .map(
      (extrinsic) => `<tr>
  <td><a href="${escapeHtml(
    extrinsicPath({ kind: 'number', number: view.number }, extrinsic.index),
  )}">${view.number}-${extrinsic.index}</a></td>
  <td>${escapeHtml(`${extrinsic.section}.${extrinsic.method}`)}</td>
  <td>${signerCell(extrinsic.isSigned, extrinsic.signer, 'unsigned')}</td>
  <td>${outcomeCell(extrinsic.outcome)}</td>
</tr>`,
    )
    .join('\n');

  const list =
    view.extrinsics.length === 0
      ? '<p class="empty">This block has no extrinsics.</p>'
      : `<table><thead><tr><th>Extrinsic</th><th>Call</th><th>Signer</th><th>Outcome</th></tr></thead>
<tbody>
${extrinsics}
</tbody></table>`;

  const body = `<h1>Block ${view.number}</h1>
${kvTable([
  ['Hash', `<span class="mono">${escapeHtml(view.hash)}</span>`],
  ['Parent', `<a class="mono" href="${escapeHtml(blockPath({ kind: 'hash', hash: view.parentHash }))}">${escapeHtml(view.parentHash)}</a>`],
  ['Time', escapeHtml(formatTimestamp(view.timestampMs))],
  ['State root', `<span class="mono">${escapeHtml(view.stateRoot)}</span>`],
  ['Extrinsics root', `<span class="mono">${escapeHtml(view.extrinsicsRoot)}</span>`],
  ['Runtime', `spec ${view.specVersion}`],
])}
<h2>Extrinsics (${view.extrinsics.length})</h2>
${list}`;

  return layout(`Block ${view.number}`, chain, body);
}

function eventRows(events: readonly EventView[]): string {
  if (events.length === 0) {
    return '<p class="empty">No events were recorded for this extrinsic.</p>';
  }
  const rows = events
    .map((event) => {
      const fields = event.fields
        .map((field) => `${escapeHtml(field.name)}: ${escapeHtml(field.value)}`)
        .join('<br>');
      return `<tr><td>${event.index}</td><td>${escapeHtml(
        `${event.section}.${event.method}`,
      )}</td><td>${fields}</td></tr>`;
    })
    .join('\n');
  return `<table><thead><tr><th>#</th><th>Event</th><th>Fields</th></tr></thead><tbody>
${rows}
</tbody></table>`;
}

/** One extrinsic, including the accounts it touched — the hop into the account view. */
export function renderExtrinsic(view: ExtrinsicView, chain: ChainInfo): string {
  const args =
    view.args.length === 0
      ? '<p class="empty">This call takes no arguments.</p>'
      : `<table><thead><tr><th>Argument</th><th>Type</th><th>Value</th></tr></thead><tbody>
${view.args
  .map(
    (arg) =>
      `<tr><td>${escapeHtml(arg.name)}</td><td>${escapeHtml(arg.type)}</td><td>${escapeHtml(
        arg.value,
      )}</td></tr>`,
  )
  .join('\n')}
</tbody></table>`;

  const accounts =
    view.accounts.length === 0
      ? '<p class="empty">This extrinsic named no accounts.</p>'
      : `<ul>${view.accounts.map((address) => `<li>${accountLink(address)}</li>`).join('')}</ul>`;

  const body = `<h1>Extrinsic ${view.block.number}-${view.index}</h1>
${kvTable([
  ['Call', escapeHtml(`${view.section}.${view.method}`)],
  ['Block', `${blockLinkByNumber(view.block.number)} <span class="mono">${escapeHtml(view.block.hash)}</span>`],
  ['Hash', `<span class="mono">${escapeHtml(view.hash)}</span>`],
  ['Signer', signerCell(view.isSigned, view.signer, 'unsigned (inherent)')],
  ['Nonce', view.nonce === null ? '<span class="empty">—</span>' : String(view.nonce)],
  [
    'Tip',
    view.tip === null
      ? '<span class="empty">—</span>'
      : escapeHtml(formatBalance(view.tip, chain.tokenDecimals, chain.tokenSymbol)),
  ],
  ['Length', `${view.lengthBytes} bytes`],
  ['Outcome', outcomeCell(view.outcome)],
])}
<h2>Arguments</h2>
${args}
<h2>Accounts touched</h2>
${accounts}
<h2>Events</h2>
${eventRows(view.events)}`;

  return layout(`Extrinsic ${view.block.number}-${view.index}`, chain, body);
}

/** An account: the state the runtime holds for it, at the block it was read. */
export function renderAccount(view: AccountView, chain: ChainInfo): string {
  const balance = (value: bigint): string =>
    escapeHtml(formatBalance(value, chain.tokenDecimals, chain.tokenSymbol));

  const body = `<h1>Account</h1>
${kvTable([
  ['Address', `<span class="mono">${escapeHtml(view.address)}</span>`],
  ['Public key', `<span class="mono">${escapeHtml(view.publicKey)}</span>`],
  ['Free', balance(view.free)],
  ['Reserved', balance(view.reserved)],
  ['Frozen', balance(view.frozen)],
  ['Nonce', String(view.nonce)],
  ['State read at', `${blockLinkByNumber(view.at.number)} <span class="mono">${escapeHtml(view.at.hash)}</span>`],
])}`;

  return layout('Account', chain, body);
}

/**
 * How often the newest page of the activity feed reloads itself.
 *
 * Two block times: the indexer only follows finalized blocks, so reloading
 * faster than blocks finalize would mostly redraw the same rows.
 */
export const ACTIVITY_REFRESH_SECONDS = 12;

/** The indexer's kind names, as a reader would say them. Unknown kinds are shown as served. */
const KIND_LABELS: Readonly<Record<string, string>> = {
  message: 'message',
  registration: 'registration',
  heartbeat: 'heartbeat',
  agreement: 'agreement',
  dispute: 'dispute',
  oracle_vote: 'oracle vote',
  slash: 'slash',
};

function kindBadge(kind: string): string {
  const label = KIND_LABELS[kind] ?? kind;
  return `<span class="kind ${escapeHtml(kind)}">${escapeHtml(label)}</span>`;
}

/** An agent: a link to their own activity, plus the hop into their account view. */
function agentLink(address: string): string {
  return `<a class="mono" href="${escapeHtml(activityPath(address))}">${escapeHtml(address)}</a> <a href="${escapeHtml(
    accountPath(address),
  )}" title="account">↗</a>`;
}

function activityFieldValue(field: ActivityField, chain: ChainInfo): string {
  switch (field.kind) {
    case 'account':
      return `<a class="mono" href="${escapeHtml(activityPath(field.value))}">${escapeHtml(field.value)}</a>`;
    case 'balance':
      return escapeHtml(formatBalance(BigInt(field.value), chain.tokenDecimals, chain.tokenSymbol));
    case 'plain':
      return escapeHtml(field.value);
  }
}

function activityRow(entry: ActivityEntry, chain: ChainInfo): string {
  const where =
    entry.extrinsicIndex === null
      ? `${blockLinkByNumber(entry.blockNumber)}`
      : `${blockLinkByNumber(entry.blockNumber)} · <a href="${escapeHtml(
          extrinsicPath({ kind: 'number', number: entry.blockNumber }, entry.extrinsicIndex),
        )}">${entry.blockNumber}-${entry.extrinsicIndex}</a>`;
  // Accounts are already listed under Agents; the field table keeps them so
  // their role (buyer, provider, who) is still readable.
  const fields = entry.fields
    .map((field) => `${escapeHtml(field.name)}: ${activityFieldValue(field, chain)}`)
    .join('<br>');
  const agents =
    entry.agents.length === 0 ? '<span class="empty">none named</span>' : entry.agents.map(agentLink).join('<br>');
  return `<tr id="${escapeHtml(entry.id)}">
  <td>${where}<br><span class="empty">${escapeHtml(entry.id)} · ${escapeHtml(formatTimestamp(entry.timestampMs))}</span></td>
  <td>${kindBadge(entry.kind)}<br>${escapeHtml(`${entry.section}.${entry.method}`)}</td>
  <td>${agents}</td>
  <td>${fields === '' ? '<span class="empty">—</span>' : fields}</td>
</tr>`;
}

/**
 * The agent-activity feed: one stream of what agents did, newest first.
 *
 * The newest page reloads itself; an older page does not, because a reader
 * paging back through history is reading, and a reload would shift the window
 * under them as new rows push the old ones down.
 */
export function renderActivity(view: ActivityView, chain: ChainInfo): string {
  const scope =
    view.agent === null
      ? 'every agent'
      : `<span class="mono">${escapeHtml(view.agent)}</span> (<a href="${escapeHtml(
          accountPath(view.agent),
        )}">account</a> · <a href="${escapeHtml(activityPath())}">show every agent</a>)`;

  const form = `<form class="filter" method="get" action="/activity">
  <input type="text" name="agent" placeholder="Filter by agent address (SS58)" value="${escapeHtml(
    view.agent ?? '',
  )}" autocomplete="off" spellcheck="false">
  <button type="submit">Filter</button>
</form>`;

  const table =
    view.entries.length === 0
      ? `<p class="empty">No agent activity ${
          view.offset > 0 ? 'this far back' : 'in the indexed history'
        }${view.agent === null ? '' : ' for this agent'}.</p>`
      : `<table><thead><tr><th>When</th><th>Activity</th><th>Agents</th><th>Details</th></tr></thead>
<tbody>
${view.entries.map((entry) => activityRow(entry, chain)).join('\n')}
</tbody></table>`;

  const pager: string[] = [];
  if (view.offset > 0) {
    pager.push(`<a href="${escapeHtml(activityPath(view.agent))}">Newest</a>`);
  }
  if (view.offset + view.entries.length < view.total) {
    pager.push(`<a href="${escapeHtml(activityPath(view.agent, view.offset + view.limit))}">Older →</a>`);
  }

  const reach =
    view.historyFrom === null
      ? 'The indexer holds no blocks yet.'
      : `History reaches back to block ${view.historyFrom}, the oldest the indexer holds.`;
  const live = view.offset === 0 ? ` This page refreshes every ${ACTIVITY_REFRESH_SECONDS}s.` : '';

  const body = `<h1>Agent activity</h1>
<p>Showing ${scope}: ${view.total} event${view.total === 1 ? '' : 's'}, newest first. ${escapeHtml(reach)}${live}</p>
${form}
${table}
${pager.length === 0 ? '' : `<p>${pager.join(' · ')}</p>`}`;

  return layout(
    'Agent activity',
    chain,
    body,
    view.offset === 0 ? ACTIVITY_REFRESH_SECONDS : undefined,
    "Activity read from the indexer's index of finalized blocks; field types from the node's runtime metadata.",
  );
}

/** An error page. The reason is chain- or user-supplied, so it is escaped like any other value. */
export function renderError(status: number, message: string, chain: ChainInfo | null): string {
  const body = `<h1>${status}</h1>
<p>${escapeHtml(message)}</p>`;
  return layout(`${status}`, chain, body);
}
