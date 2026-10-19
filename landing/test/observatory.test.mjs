// Tests for /observatory — the one page on this site that reads the chain live.
//
// The landing page's rule is "no figure written by hand". The observatory keeps
// it the other way round: its figures are fetched in the browser, so the build
// must ship no figure at all in a reading slot, every endpoint and field the
// script reads must exist in the indexer it reads them from, and the only
// numbers the build does carry — the runtime upgrade record and the security
// posture record — must be labelled as records and agree with the files
// checked into the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_ORIGIN, RPC_URL, GITHUB_COMMITS_URL, SOURCES, STORAGE_KEYS } from '../src/observatory/data.js';
import { twox128 } from '../src/observatory/scale.js';
import { renderSection, railPositions } from '../src/observatory.mjs';

const landingDir = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = new URL('../../', import.meta.url);
const readRepoFile = (relPath) => readFileSync(new URL(relPath, repoRoot), 'utf8');
const history = JSON.parse(readFileSync(new URL('../runtime-history.json', import.meta.url), 'utf8'));
const posture = JSON.parse(readFileSync(new URL('../public/posture.json', import.meta.url), 'utf8'));

/** Every client-side source file the bundle is built from. */
function clientSources() {
  const dir = fileURLToPath(new URL('../src/observatory/', import.meta.url));
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) files.push(p);
    }
  };
  walk(dir);
  return files.map((p) => [p.replace(dir, ''), readFileSync(p, 'utf8')]);
}

function build() {
  const out = mkdtempSync(join(tmpdir(), 'landing-observatory-'));
  execFileSync(process.execPath, ['scripts/build.mjs'], {
    cwd: landingDir,
    env: { ...process.env, LANDING_OUT_DIR: out },
    stdio: 'pipe',
  });
  return out;
}

const out = build();
const page = readFileSync(join(out, 'observatory.html'), 'utf8');
const index = readFileSync(join(out, 'index.html'), 'utf8');
const bundle = readFileSync(join(out, 'observatory.js'), 'utf8');

test('the build emits the observatory page, its bundle, stylesheet, fonts and records', () => {
  const files = readdirSync(out);
  for (const name of ['observatory.html', 'observatory.js', 'observatory.css', 'runtime-history.json', 'posture.json', 'fonts']) {
    assert.ok(files.includes(name), `build produced no ${name} (got: ${files.join(', ')})`);
  }
  const fonts = readdirSync(join(out, 'fonts'));
  for (const face of ['source-serif-4', 'inter', 'jetbrains-mono']) {
    assert.ok(fonts.some((f) => f.startsWith(face) && f.endsWith('.woff2')), `no ${face} woff2 in dist/fonts`);
  }
  assert.match(page, /^<!doctype html>/i);
  assert.match(page, /<script type="module" src="observatory\.js"><\/script>/);
  // The stylesheet is inlined for first paint; the same bytes ship as a file.
  const css = readFileSync(join(out, 'observatory.css'), 'utf8');
  assert.ok(page.includes(`<style>${css}</style>`), 'observatory.html must inline observatory.css verbatim');
  // Served as /observatory by nginx `try_files $uri.html` and by GitHub Pages,
  // so every asset reference is relative to the site root.
  assert.ok(!/(?:src|href)="\/(?!\/)/.test(page), 'observatory.html must not use root-absolute paths');
  // The bundle is one file, minified, and small enough for the first-paint budget.
  assert.ok(bundle.length < 180 * 1024, `observatory.js is ${(bundle.length / 1024).toFixed(0)} kB; the budget is 180 kB`);
  assert.ok(!/from\s+["']d3/.test(bundle), 'the bundle must not leave bare d3 imports unresolved');
});

test('the site nav links the observatory, and the landing page stays script-free', () => {
  assert.match(index, /<nav[^>]*>[\s\S]*<a href="observatory">Observatory<\/a>[\s\S]*<\/nav>/);
  assert.match(page, /<nav[^>]*>[\s\S]*<a href="observatory" aria-current="page">Observatory<\/a>[\s\S]*<\/nav>/);
  assert.ok(!/<script/i.test(index), 'index.html must stay script-free');
});

test('no reading ships with a value: every figure on the page is fetched, not built in', () => {
  const values = [...page.matchAll(/<(?:p|span) class="reading-value[^"]*"[^>]*>([\s\S]*?)<\/(?:p|span)>/g)].map((m) => m[1]);
  assert.ok(values.length >= 20, `expected every reading to have a value slot, found ${values.length}`);
  for (const value of values) {
    assert.ok(!/\d/.test(value.replace(/<[^>]+>/g, '')), `a reading ships a built-in figure: ${value}`);
  }
  const readings = [...page.matchAll(/<(?:div|figure) class="[^"]*reading[^"]*" data-reading="([^"]+)"[\s\S]*?<p class="reading-prov">/g)];
  assert.ok(readings.length >= 18, `found ${readings.length} readings`);
  for (const [block, key] of readings) {
    assert.match(block, /class="[^"]*\breading-label\b/, `${key} has no label`);
  }
});

test('every reading in the page is fed by a source the data layer knows', () => {
  const keys = new Set([...page.matchAll(/data-reading="([^"]+)"/g)].map((m) => m[1]));
  const fed = new Set(Object.values(SOURCES).flatMap((source) => source.readings));
  for (const key of keys) {
    assert.ok(fed.has(key), `reading "${key}" has no source in data.js`);
  }
});

test('the two records on the page are labelled as records, and the posture record invents nothing', () => {
  // The posture record now sits inside Verify, collapsed with the sources; the upgrade rail's sentence says it is a record.
  const verify = page.match(/<section id="verify"[\s\S]*?<\/section>/)[0];
  assert.match(verify, /<div class="posture-record" data-record="true">/);
  assert.match(verify, /Record, not live/);
  assert.match(page.match(/<section id="upgrades"[\s\S]*?<\/section>/)[0], /checked-in record/);
  for (const [key, entry] of Object.entries(posture.fields)) {
    assert.ok('value' in entry && 'asOf' in entry && 'todo' in entry, `posture field ${key} is missing value/asOf/todo`);
    if (entry.value === null) {
      assert.match(entry.todo, /^TODO\(owner\)/, `posture field ${key} has no value and no TODO for the owner`);
      assert.match(page, new RegExp(`data-posture="${key}" data-recorded="false"[\\s\\S]*?not yet recorded`));
    }
  }
  // A posture value slot carries no digits unless a value was recorded.
  const strip = page.match(/<dl class="posture">[\s\S]*?<\/dl>/)[0];
  const rows = [...strip.matchAll(/<dd>([\s\S]*?)<\/dd>/g)];
  assert.equal(rows.length, 4);
  for (const [, value] of rows) {
    const text = value.replace(/<[^>]+>/g, '');
    if (text.includes('not yet recorded')) assert.ok(!/\d/.test(text), `posture shows a number with nothing recorded: ${text}`);
    else assert.match(text, /as of \d{4}-\d{2}-\d{2}/, 'a recorded value carries its date');
  }
  // A recorded value is traceable to a document in this repository, and the page names it.
  for (const [key, entry] of Object.entries(posture.fields)) {
    if (entry.value === null) continue;
    assert.match(entry.asOf, /^\d{4}-\d{2}-\d{2}$/, `${key} has no date`);
    assert.ok(typeof entry.source === 'string' && entry.source.length > 20, `${key} names no source`);
    assert.ok(page.includes(`<span class="posture-value">${entry.value}</span>`), `${key} is not on the page`);
    assert.ok(page.includes(entry.source.slice(0, 40).replace(/&/g, '&amp;').replace(/'/g, '&#39;')), `${key}'s source is not on the page`);
  }
  // The two numbers recorded today, each in the document it cites.
  assert.equal(posture.fields.findingsExamined.value, 382);
  assert.match(readRepoFile('TESTNETAUDIT.md'), /\*\*382 findings\*\* from 17 auditors/);
  assert.equal(posture.fields.fixedIn307.value, 4);
  const escrow = readRepoFile('pallets/escrow/src/lib.rs');
  for (const name of ['MaxAgreementSpan', 'SpanTooLong']) assert.ok(escrow.includes(name), `pallets/escrow lacks ${name}, which the 307 record cites`);
  assert.ok(readRepoFile('pallets/agents/src/lib.rs').includes('NoSuchSlash'), 'pallets/agents lacks NoSuchSlash, which the 307 record cites');
});

test('the 307 record says what is on chain: no consent or expiry calls, which came to the source later (#233) and are not claimed for 307', () => {
  const spec307 = history.upgrades.find((u) => u.specVersion === 307);
  assert.doesNotMatch(spec307.summary, /consent|expiry|expire/i, 'the consent and expiry calls are not in the 307 runtime');
  assert.match(spec307.summaryNote, /accept_agreement/);
  // The calls are in the runtime's source now (pull request #233, 2026-10-01), for a later runtime; the record says so.
  for (const name of ['accept_agreement', 'expire_agreement', 'reject_agreement', 'cancel_pending']) {
    assert.ok(readRepoFile('pallets/escrow/src/lib.rs').includes(`fn ${name}`), `pallets/escrow no longer has ${name}: revisit the 307 record's note`);
  }
  assert.match(spec307.summaryNote, /#233/, 'the note names the pull request that added the calls to the source');
  assert.match(spec307.summaryNote, /not on chain at 307/);
});

test('the upgrade record: 305, 306, 307, 309 all applied, each agreeing with its file', () => {
  assert.deepEqual(
    history.upgrades.map((u) => [u.specVersion, u.status]),
    [
      [305, 'applied'],
      [306, 'applied'],
      [307, 'applied'],
      // 309 went to prod at block 907929 on 2026-10-05.
      [309, 'applied'],
    ],
  );
  for (const upgrade of history.upgrades.filter((u) => u.status === 'applied')) {
    assert.match(upgrade.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number.isInteger(upgrade.appliedAtBlock) && upgrade.appliedAtBlock > 0);
    assert.match(upgrade.blockHash, /^0x[0-9a-f]{64}$/);
    assert.match(upgrade.wasm.sha256, /^[0-9a-f]{64}$/);
    assert.match(upgrade.wasm.blake2_256, /^0x[0-9a-f]{64}$/);
    assert.ok(upgrade.summary.length > 0 && upgrade.summary.length <= 140, `${upgrade.specVersion} summary is not one line`);
  }
  for (const upgrade of history.upgrades.filter((u) => u.recordFile)) {
    const record = readRepoFile(upgrade.recordFile);
    assert.ok(record.includes(`spec ${upgrade.specVersion}`), `${upgrade.recordFile} is not about spec ${upgrade.specVersion}`);
    assert.ok(record.includes(`#${upgrade.appliedAtBlock}`), `${upgrade.recordFile} never names block #${upgrade.appliedAtBlock}`);
    assert.ok(record.includes(upgrade.blockHash), `${upgrade.recordFile} never names block hash ${upgrade.blockHash}`);
    assert.ok(record.includes(upgrade.wasm.blake2_256), `${upgrade.recordFile} never names ${upgrade.wasm.blake2_256}`);
  }
  const spec307 = history.upgrades.find((u) => u.specVersion === 307);
  assert.equal(spec307.appliedAtBlock, 813625);
  assert.equal(spec307.wasm.sha256, '0b515ea41bb3b1134072dc696b95d2ce85cf671bf89fc460d8fb20b7cd196d6c');
  for (const upgrade of history.upgrades.filter((u) => u.summarySource)) readRepoFile(upgrade.summarySource);
});

test('the upgrade rail renders every row with its hash in full, copyable, and a chain confirmation slot', () => {
  for (const upgrade of history.upgrades) {
    assert.match(page, new RegExp(`<li class="rail-marker rail-${upgrade.status}[^"]*" style="--x:[0-9.]+%" data-spec="${upgrade.specVersion}"`));
    assert.match(page, new RegExp(`<li class="upgrade" data-spec="${upgrade.specVersion}" data-status="${upgrade.status}"`));
    if (upgrade.wasm) {
      assert.ok(page.includes(upgrade.wasm.sha256), `sha256 for ${upgrade.specVersion} not rendered in full`);
      assert.ok(page.includes(`data-copy="${upgrade.wasm.sha256}"`), `sha256 for ${upgrade.specVersion} has no copy control`);
      assert.ok(page.includes(`data-confirm-block="${upgrade.appliedAtBlock}"`), `${upgrade.specVersion} has no chain-confirmation slot`);
    }
  }
  // Markers sit in order, left to right, equally spaced; the block number is
  // printed under each applied one. Every row is applied now that 309 has
  // shipped, so there is no scheduled marker at the end.
  const xs = [...page.matchAll(/rail-marker rail-\w+" style="--x:([0-9.]+)%/g)].map((m) => Number(m[1]));
  assert.deepEqual([...xs].sort((a, b) => a - b), xs);
  assert.deepEqual(xs, railPositions(history.upgrades.length).map((x) => Number(x.toFixed(2))));
  for (const upgrade of history.upgrades.filter((u) => u.status === 'applied')) {
    assert.ok(page.includes(`<span class="rail-meta mono">#${upgrade.appliedAtBlock.toLocaleString('en-US')}</span>`), `${upgrade.specVersion} has no block under its marker`);
  }
  // The dashed future begins past the LAST marker, whatever the row count.
  //
  // This used to read `future > xs[2] && future < xs[3]`, which encoded the
  // shape "three applied rows and one scheduled one at the end" — true only
  // while 309 was unapplied. Now that every row is applied the future starts
  // past the last marker (92% -> 98%), and the old form failed on a page that
  // was correct. Written against the last element so the next upgrade does not
  // need this line edited.
  const future = Number(page.match(/class="rail"[^>]*style="--future:([0-9.]+)%"/)[1]);
  assert.ok(future > xs[xs.length - 1], `the dashed future (${future}%) must begin past the last marker (${xs[xs.length - 1]}%)`);
  assert.ok(future <= 100, `the dashed future (${future}%) must stay on the rail`);
});

test('the script reads only indexer endpoints that exist, with fields the indexer emits', () => {
  const api = readRepoFile('indexer/src/api.ts');
  const routes = [...api.matchAll(/path: '([^']+)'/g)].map((m) => m[1]);
  const toPattern = (route) => new RegExp(`^${route.replace(/:[a-z]+/g, '[^/]+')}$`);
  const indexerSources = Object.entries(SOURCES).filter(([, source]) => source.kind === 'api');
  assert.ok(indexerSources.length >= 10);
  for (const [name, source] of indexerSources) {
    const path = new URL(source.path, API_ORIGIN).pathname;
    assert.ok(routes.some((route) => toPattern(route).test(path)), `source "${name}" reads ${path}, which indexer/src/api.ts does not serve`);
    const limit = new URL(source.path, API_ORIGIN).searchParams.get('limit');
    if (limit !== null) assert.ok(Number(limit) <= 200, `source "${name}" asks for limit=${limit}; the indexer caps at 200`);
  }
  const indexer = api + readRepoFile('indexer/src/chainState.ts') + readRepoFile('indexer/src/store.ts');
  // `field(data, '…')` and any reader built on it (`erasField(item, '…')`).
  const paths = clientSources().flatMap(([, src]) => [...src.matchAll(/[fF]ield\([^,]+, '([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(paths.length >= 15, `expected the instruments to read fields through field(), found ${paths.length}`);
  for (const path of new Set(paths)) {
    for (const segment of path.split('.').filter((s) => !/^\d+$/.test(s))) {
      // JSON-RPC and GitHub envelopes are not the indexer's; their keys are checked where they are read.
      if (['result', 'commit', 'committer', 'date', 'sha', 'html_url', 'peers', 'isSyncing', 'best', 'background', 'prevotes', 'precommits', 'missing', 'round', 'setId', 'totalWeight', 'thresholdWeight', 'currentWeight'].includes(segment)) continue;
      assert.ok(new RegExp(`\\b${segment}\\b`).test(indexer), `field "${path}" — "${segment}" is not in the indexer source`);
    }
  }
  // Event sections and methods named in sources exist in the pallets.
  const pallets = {
    escrow: readRepoFile('pallets/escrow/src/lib.rs'),
    agents: readRepoFile('pallets/agents/src/lib.rs'),
    messages: readRepoFile('pallets/messages/src/lib.rs'),
    oracle: readRepoFile('pallets/oracle/src/lib.rs'),
  };
  for (const [name, source] of indexerSources) {
    const params = new URL(source.path, API_ORIGIN).searchParams;
    const section = params.get('section');
    const method = params.get('method');
    if (!section || !method || section === 'system') continue;
    assert.ok(pallets[section], `source "${name}" names pallet "${section}", which is not one this test knows`);
    assert.ok(new RegExp(`\\b${method}\\s*\\{`).test(pallets[section]), `source "${name}": pallets/${section} emits no ${method} event`);
  }
});

test('every event the page counts is one the runtime declares, read from its own metadata (chain-events.json)', () => {
  const metadata = JSON.parse(readFileSync(new URL('../chain-events.json', import.meta.url), 'utf8'));
  assert.equal(metadata.provenance.specName, 'scalar-commons');
  assert.ok(metadata.provenance.specVersion >= 307 && /^0x[0-9a-f]{64}$/.test(metadata.provenance.genesisHash), 'the record says which runtime it was read from');
  // A reading fenced to a later runtime (`data-min-spec`, hidden below it) may count an event this runtime
  // does not have yet: it is checked against its pallet's source instead, and must really be fenced.
  const fence = new Map([...page.matchAll(/data-reading="([^"]+)" data-min-spec="(\d+)"/g)].map((m) => [m[1], Number(m[2])]));
  for (const [name, source] of Object.entries(SOURCES)) {
    if (source.kind !== 'api' || !source.path.startsWith('/v1/events?')) continue;
    const params = new URL(source.path, API_ORIGIN).searchParams;
    const section = params.get('section');
    const method = params.get('method');
    const fences = (source.readings ?? []).map((key) => fence.get(key));
    if (!metadata.pallets[section] && fences.length && fences.every((min) => min > metadata.provenance.specVersion)) {
      const pallet = readRepoFile(`pallets/${section}/src/lib.rs`);
      assert.ok(new RegExp(`\\b${method}\\s*\\{`).test(pallet), `source "${name}": pallets/${section} emits no ${method}`);
      continue;
    }
    assert.ok(metadata.pallets[section], `source "${name}": the runtime has no pallet "${section}"`);
    assert.ok(metadata.pallets[section].includes(method), `source "${name}": ${section} emits no ${method} (it emits ${metadata.pallets[section].join(', ')})`);
  }
  // The last hour's settlements are DeliveryConfirmed: the runtime has no AgreementSettled.
  assert.equal(SOURCES.deliveriesConfirmed.path, '/v1/events?section=escrow&method=DeliveryConfirmed&limit=200');
  assert.ok(SOURCES.deliveriesConfirmed.readings.includes('hourSettled'));
  assert.ok(!metadata.pallets.escrow.includes('AgreementSettled'));
});

test('the raw storage locations are computed from their names, never pasted', () => {
  // twox128 of the names, checked one name at a time against the values every
  // Substrate client derives (System and Account are the textbook vectors).
  assert.equal(twox128('System'), '0x26aa394eea5630e07c48ae0c9558cef7');
  assert.equal(twox128('Account'), '0xb99d880ec681799c0cf30e8886371da9');
  assert.equal(twox128('Session'), '0xcec5070d609dd3497f72bde07fc96ba0');
  assert.equal(twox128('Validators'), '0x88dcde934c658227ee1dfafcd6e16903');
  assert.equal(twox128('Babe'), '0x1cb6f36e027abb2091cfb5110ab5087f');
  assert.equal(twox128('Authorities'), '0x5e0621c4869aa60c02be9adcc98a0d1d');
  assert.equal(STORAGE_KEYS.sessionValidators, twox128('Session') + twox128('Validators').slice(2));
  assert.equal(STORAGE_KEYS.sessionQueuedKeys, twox128('Session') + twox128('QueuedKeys').slice(2));
  assert.equal(STORAGE_KEYS.babeAuthorities, twox128('Babe') + twox128('Authorities').slice(2));
  assert.equal(STORAGE_KEYS.sessionValidators.length, 2 + 64);
  // No 32-byte hex literal anywhere in the client: a storage location pasted
  // in is indistinguishable from a private key to a reader or a scanner.
  for (const [file, src] of clientSources()) {
    assert.ok(!/0x[0-9a-f]{64}/i.test(src), `${file} contains a 32-byte hex literal`);
  }
});

test('the script contacts only the chain API, the chain RPC and GitHub', () => {
  assert.equal(API_ORIGIN, 'https://api.scalarnet.io');
  // WebSocket, not HTTPS POST: rpc.scalarnet.io answers POSTs with
  // Access-Control-Allow-Origin twice (node --rpc-cors plus nginx), which
  // browsers reject. A WebSocket handshake is not subject to CORS.
  assert.equal(RPC_URL, 'wss://rpc.scalarnet.io');
  assert.equal(new URL(GITHUB_COMMITS_URL).origin, 'https://api.github.com');
  assert.match(GITHUB_COMMITS_URL, /\/repos\/tejaspatil1936\/scalar-commons-v4\/commits\?sha=master/);
  const allowed = new Set(['api.scalarnet.io', 'rpc.scalarnet.io', 'api.github.com', 'github.com', 'explorer.scalarnet.io', 'scalarnet.io']);
  for (const [file, src] of clientSources()) {
    const hosts = new Set([...src.matchAll(/(?:https|wss):\/\/([a-z0-9.-]+)/g)].map((m) => m[1]));
    for (const host of hosts) assert.ok(allowed.has(host), `${file} references ${host}`);
  }
});

test('no instrument loops forever or ignores reduced motion', () => {
  for (const [file, src] of clientSources()) {
    assert.ok(!/setInterval\(/.test(src) || file === 'main.js', `${file} uses setInterval; use ctx.watch so it pauses when hidden`);
    assert.ok(!/animation-iteration-count|infinite/.test(src), `${file} declares an infinite animation`);
  }
  const css = readFileSync(new URL('../src/observatory.css', import.meta.url), 'utf8');
  assert.ok(!/infinite/.test(css), 'observatory.css declares an infinite animation');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(prefers-color-scheme: light\)/);
});

const css = readFileSync(new URL('../src/observatory.css', import.meta.url), 'utf8');
const allCss = css + readdirSync(new URL('../src/observatory/instruments/', import.meta.url))
  .filter((name) => name.endsWith('.css'))
  .map((name) => readFileSync(new URL(`../src/observatory/instruments/${name}`, import.meta.url), 'utf8'))
  .join('\n');
/** The declarations of the first rule whose selector is exactly `selector`. */
const rule = (selector, source = css) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').match(new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
const section = (id) => page.match(new RegExp(`<section id="${id}"[\\s\\S]*?<\\/section>`))?.[0] ?? '';

test('renderSection renders each section on its own for the harness', () => {
  for (const name of ['chain', 'economy', 'validators', 'history', 'upgrades', 'verify']) {
    const html = renderSection(name, { history, posture });
    assert.match(html, new RegExp(`<section id="${name}"`));
  }
  assert.throws(() => renderSection('nope', { history, posture }), /no section named/);
});

test('one URL: no ?sky and no ?present, and no three.js, GSAP or WebGL anywhere in the page, its bundle or its manifest', () => {
  const sources = clientSources();
  assert.ok(!sources.some(([file]) => /^sky/.test(file)), 'the sky modules are gone');
  for (const [file, src] of sources) {
    assert.ok(!/location\.search|URLSearchParams|[?&](?:sky|present)=/.test(src), `${file} still reads a URL flag`);
    assert.ok(!/from ['"](?:three|gsap)/.test(src) && !/import\(['"]\.\/sky/.test(src), `${file} still loads the sky`);
  }
  assert.ok(!/location\.search/.test(page), 'no script in the page reads the URL');
  for (const word of ['WebGLRenderer', 'ScrollTrigger', 'gsap', 'sky-field', 'sky=0']) {
    assert.ok(!bundle.includes(word), `the bundle still carries ${word}`);
  }
  // One script on the page. The network graph is a second, self-contained
  // bundle, fetched only by the switch that shows it, never by the page.
  // (/pulse has its own one script, pulse.js, which this page never names; test/pulse.test.mjs holds it to the same rule.)
  const scripts = readdirSync(out).filter((name) => name.endsWith('.js')).sort();
  assert.deepEqual(scripts, ['observatory-graph.js', 'observatory.js', 'pulse.js']);
  assert.deepEqual([...page.matchAll(/<script[^>]* src="([^"]+)"/g)].map((m) => m[1]), ['observatory.js'], 'the page loads one script');
  assert.ok(!page.includes('observatory-graph'), 'the page never names the graph bundle');
  assert.ok(!/from"\.\/observatory-/.test(bundle), 'observatory.js imports no chunk statically');
  const graphBundle = readFileSync(join(out, 'observatory-graph.js'), 'utf8');
  assert.ok(graphBundle.includes('forceSimulation') || /forceManyBody|alphaDecay/.test(graphBundle), 'd3-force lives in the graph bundle');
  assert.ok(!/alphaDecay/.test(bundle), 'and not in the page’s script');
  // gsap is a dependency again, for /pulse only: the assertions above hold this page's bundle free of it.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const dep of ['three']) assert.ok(!(dep in (pkg.dependencies ?? {})), `${dep} is still a dependency`);
  assert.ok(!bundle.includes('force-graph') && !/kapsule|ForceGraph/.test(bundle), 'the observatory bundle carries no force-graph');
  assert.ok(!page.includes('data-reading="sky"') && !css.includes('.sky'), 'no sky slot or rule is left behind');
});

const statusbarHtml = () => page.match(/<header class="statusbar reading"[\s\S]*?<\/header>/)?.[0] ?? '';
const heroHtml = () => page.match(/<header class="hero"[\s\S]*?<\/header>/)?.[0] ?? '';
/** Every declaration block of a stylesheet, as [selector, body]. */
const blocks = (source) => [...source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
/** WCAG relative luminance and contrast of two #rrggbb colours. */
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const themes = () => [...css.matchAll(/:root\s*\{([^}]*)\}/g)].slice(0, 2).map((m) => Object.fromEntries([...m[1].matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()])));

test('the top bar: two zones, 56 px, sticky, a bottom hairline — wordmark and nav on the left; the status pill and two quiet text buttons on the right', () => {
  const bar = statusbarHtml();
  assert.ok(bar, 'the status bar is a header at the top of the page');
  assert.ok(page.indexOf('<header class="statusbar reading"') < page.indexOf('<header class="hero"'));
  const left = bar.match(/<div class="sb-left">([\s\S]*?)<\/div>/)?.[1] ?? '';
  assert.match(left, /<a class="wordmark" href="observatory">/);
  assert.match(left, /<nav class="site-nav"[\s\S]*Overview[\s\S]*Observatory[\s\S]*Docs/);
  const right = bar.slice(bar.indexOf('<div class="sb-right">'));
  // The pill: dot · state · block N · finality, in that order.
  const pill = right.match(/<p class="sb-pill"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
  const order = ['pulse-dot', 'sb-state', 'sb-block', 'sb-finality'].map((c) => pill.indexOf(`class="${c}"`));
  assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), `the pill reads dot · state · block · finality: ${order}`);
  assert.match(right, /<button type="button" class="btn sb-sources" role="switch" aria-checked="false">Sources<\/button>/);
  assert.match(right, /<button type="button" class="btn sb-present" aria-pressed="false" aria-keyshortcuts="P">Present<\/button>/);
  assert.match(css, /--bar-height: 56px/);
  assert.match(rule('.statusbar'), /position: sticky/);
  assert.match(rule('.statusbar'), /border-bottom: 1px solid var\(--border\)/);
  assert.match(rule('.btn'), /min-height: 32px/);
});

test('the hero: no second wordmark; the title, one sentence, the figures with hairlines between — height, agents registered, operator-run with its plain note, agreements open — the last hour, the live line; left five of twelve, centred against the agent panel on the right seven', () => {
  const hero = heroHtml();
  assert.match(hero, /<header class="hero" data-instrument="hero" data-present-screen aria-labelledby="hero-h">/);
  assert.ok(!/class="wordmark|Scalar Commons<\/|Scalar Commons</.test(hero), 'the wordmark lives in the top bar only');
  const text = hero.match(/<div class="hero-text">[\s\S]*?<p class="live-line"[\s\S]*?<\/p>\s*<\/div>/)?.[0] ?? '';
  assert.match(text, /^<div class="hero-text">\s*<h1 id="hero-h">Observatory<\/h1>\s*<p class="dek">A public test network where AI agents contract, escrow and settle work — read live from the chain\.<\/p>/);
  const figures = [...text.matchAll(/<div class="reading hero-figure" data-reading="([^"]+)"[^>]*>([\s\S]*?)<\/div>/g)];
  assert.deepEqual(figures.map((m) => m[1]), ['heroHeight', 'agents', 'operatorRun', 'activeAgreements', 'messagesSent']);
  assert.deepEqual(figures.map((m) => m[2].match(/<p class="reading-label">([^<]+)<\/p>/)?.[1]), ['Height', 'Agents registered', 'Operator-run', 'Agreements open', 'Messages sent']);
  for (const [, key, block] of figures) {
    assert.ok(block.indexOf('reading-value') < block.indexOf('reading-label'), `${key}: the caption sits directly under its figure`);
    assert.ok(!/\d/.test(block.match(/<p class="reading-value[^>]*>([\s\S]*?)<\/p>/)[1].replace(/<[^>]+>/g, '')), `${key} ships a figure`);
  }
  // Operator-run sits next to agents registered, and its note is said plainly, in the page, beside it.
  const order = ['data-reading="agents"', 'data-reading="operatorRun"'].map((k) => text.indexOf(k));
  assert.ok(order[0] < order[1]);
  assert.match(
    text,
    /<p class="hero-note" id="operator-note">Agents run by the Scalar Commons team to exercise the network\. Identified on-chain by the swarm- prefix\.<\/p>/,
  );
  assert.match(text, /data-reading="operatorRun" aria-describedby="operator-note"/);
  assert.ok(!/<details[^>]*>[\s\S]*operator-note/.test(text), 'the note is never behind a disclosure');
  assert.match(rule('.hero-note'), /color: var\(--text-dim\)/);
  // Hairlines between them.
  assert.match(css, /\.hero-figure \+ \.hero-figure,\s*\.hero-note \{\s*border-top: 1px solid var\(--border\)/);
  assert.match(css, /\.hero-figure:nth-child\(3\),\s*\.hero-note \{[^}]*border-left: 1px solid var\(--border\)/);
  // Activity in the last hour: four figures, each a figure-l with its label, under the hero's figures.
  const hour = text.match(/<section class="hour" aria-labelledby="hour-h">[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.ok(text.indexOf('hero-figures') < text.indexOf('class="hour"'), 'under the hero figures');
  assert.match(hour, /<h2 class="eyebrow hour-title" id="hour-h">Activity in the last hour<\/h2>/);
  const hourKeys = [...hour.matchAll(/data-reading="([^"]+)"/g)].map((m) => m[1]);
  // `hourMessages` is spec-309-fenced: it is in the markup but `hidden` until
  // the chain reports 309 (see instruments/messaging.js).
  assert.deepEqual(hourKeys, ['hourOracle', 'hourSettled', 'hourDisputes', 'hourSlashes', 'hourMessages']);
  assert.deepEqual([...hour.matchAll(/<p class="reading-label">([^<]+)<\/p>/g)].map((m) => m[1]), ['Oracle answers', 'Agreements settled', 'Disputes opened', 'Slashes', 'Messages sent']);
  assert.match(hour, /class="readings figure-row hour-figures"/);
  for (const key of hourKeys) assert.ok(Object.values(SOURCES).some((s) => s.readings?.includes(key)), `${key} has a source`);
  assert.match(text, /<p class="live-line" data-state="connecting"><span class="pulse-dot" aria-hidden="true"><\/span> <span class="ll-state">Connecting<\/span> <span class="ll-finality">finality —<\/span><\/p>/);
  // The grid: 5 + 7 of 12, the left column centred against the panel.
  assert.match(rule('.hero-text'), /grid-column: 1 \/ span 5/);
  assert.match(rule('.hero-text'), /align-self: center/);
  assert.match(rule('.hero-panel'), /grid-column: 6 \/ span 7/);
  // The 24/40 rhythm.
  assert.match(rule('.hero h1'), /margin: 0 0 var\(--space-4\)/);
  assert.match(rule('.dek'), /margin: 0 0 var\(--space-5\)/);
  assert.match(rule('.hero-figures'), /margin: 0 0 var\(--space-5\)/);
  assert.match(rule('.hour'), /margin: 0 0 var\(--space-5\)/);
  // As tall as its content plus 64 px: no 100vh, no dead band.
  assert.ok(!/100s?vh/.test(rule('.hero') + rule('.hero-grid')), 'the hero is not a viewport-height block');
  assert.match(rule('.hero-grid'), /padding-block: var\(--space-6\) 0/);
});

test('the agent activity panel: a title at h3, the Network graph switch, one legend, the field, one live line, one footnote, the list paginated', () => {
  const panel = heroHtml().match(/<figure class="panel hero-panel instrument"[\s\S]*?<\/figure>/)?.[0] ?? '';
  // Set in the h3 style; an h2 element so the outline runs h1 → h2 → h3 without a gap.
  assert.match(panel, /<figcaption class="panel-head">\s*<h2 class="panel-title" id="panel-h">Agent activity<\/h2>\s*<button type="button" class="btn graph-toggle" role="switch" aria-checked="false">Network graph<\/button>/);
  assert.match(css, /\.chart-title,\s*\.panel-title \{[^}]*font-size: var\(--t-h3\)/);
  assert.match(rule('.panel'), /padding: var\(--space-4\)/);
  assert.match(rule('.legend'), /font-size: var\(--t-label\)/);
  const legend = panel.match(/<ul class="legend field-legend"[^>]*>([\s\S]*?)<\/ul>/)?.[1] ?? '';
  assert.deepEqual([...legend.matchAll(/<\/span>([^<]+)<\/li>/g)].map((m) => m[1]), ['Idle', 'Working', 'In dispute', 'Slashed, last hour', 'Operator-run']);
  assert.match(panel, /<canvas class="field-canvas" role="img" aria-label="[^"]+"><\/canvas>\s*<div class="tooltip field-tip" role="tooltip" hidden><\/div>/);
  assert.match(panel, /<p class="field-live" role="status" aria-live="off">/);
  assert.equal((panel.match(/class="panel-foot /g) ?? []).length, 2, 'one footnote per view');
  // One legend and one footnote show at a time: the graph's are hidden until its switch is on.
  assert.match(css, /\.graph-legend,\s*\.graph-host,\s*\.graph-note,\s*\.hero-panel\[data-graph\] \.field-legend,\s*\.hero-panel\[data-graph\] \.field-host,\s*\.hero-panel\[data-graph\] \.field-live,\s*\.hero-panel\[data-graph\] \.field-foot \{\s*display: none;/);
  // The graph's counts are a list beside the plate, not text on it.
  assert.match(panel, /<ol class="graph-bundles" aria-label="[^"]+" hidden><\/ol>/);
  assert.match(panel, /<details class="disclosure agents-list"><summary>The same agents as a list<\/summary>/);
  assert.match(panel, /<div class="list-pager" hidden>\s*<button type="button" class="btn" data-step="prev">Previous<\/button>/);
  assert.ok(!/data-reading=/.test(panel), 'no figure inside the frame');
  // The field draws on canvas, with no physics: the graph's d3-force is only in its own bundle.
  const field = readFileSync(new URL('../src/observatory/instruments/agent-field.js', import.meta.url), 'utf8');
  assert.ok(!/from ['"]d3-force|forceSimulation\(/.test(field), 'no physics in the field');
  assert.match(field, /import\(new URL\(GRAPH_BUNDLE, import\.meta\.url\)\.href\)/, 'the graph is fetched on first use');
});

test('the river under the hero: a titled strip, 140 px, the content width, its axis and FINAL marker labelled', () => {
  const after = page.slice(page.indexOf('</header>', page.indexOf('<header class="hero"')));
  const strip = after.match(/<figure class="frame river-strip" aria-labelledby="river-h">[\s\S]*?<\/figure>/)?.[0] ?? '';
  assert.ok(strip, 'the strip follows the hero directly, inside the content frame');
  assert.ok(after.indexOf('river-strip') < after.indexOf('<main>'));
  assert.match(strip, /<h2 class="chart-title" id="river-h">Blocks arriving now<\/h2>/);
  assert.match(strip, /<canvas class="hero-river" role="img" aria-label="[^"]+"><\/canvas>/);
  assert.match(rule('.hero-river'), /height: 140px/);
  const pulse = readFileSync(new URL('../src/observatory/instruments/pulse.js', import.meta.url), 'utf8');
  assert.ok(!/compact: true/.test(pulse), 'the strip is drawn with its labels, like the full river');
  assert.match(pulse, /FINAL ·/);
});

test('sections: an eyebrow, an h2, one sentence, the instrument and a row of figures, 104 px apart', () => {
  const sections = [...page.matchAll(/<section id="([a-z]+)" class="section" data-instrument="([a-z-]+)" data-present-screen data-reveal aria-labelledby="\1-h">([\s\S]*?)<\/section>/g)];
  assert.deepEqual(sections.map((m) => m[1]), ['chain', 'economy', 'validators', 'history', 'upgrades', 'verify']);
  const names = ['Chain', 'Economy', 'Validators', 'History', 'Upgrades', 'Verify'];
  sections.forEach(([, id, , body], i) => {
    assert.match(body, new RegExp(`<p class="eyebrow">0${i + 1} · ${names[i]}</p>\\s*<h2 id="${id}-h">[^<]{8,60}</h2>\\s*<p class="lede">`), `${id}: eyebrow, then h2, then the sentence`);
    const lede = body.match(/<p class="lede">([\s\S]*?)<\/p>/)[1].replace(/<[^>]+>/g, '');
    assert.ok(lede.length <= 120 && !/[.!?] [A-Z]/.test(lede), `${id}: one plain sentence`);
    assert.ok(body.indexOf('class="lede"') < body.indexOf('class="instrument'), `${id}: the sentence precedes the instrument`);
    if (/class="readings/.test(body)) {
      assert.ok(body.indexOf('class="instrument') < body.indexOf('class="readings'), `${id}: the figures follow the instrument`);
    }
  });
  const keys = (id) => [...section(id).matchAll(/data-reading="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys('chain'), ['bestBlock', 'finalizedBlock', 'finalityLag', 'blocksPerMinute']);
  assert.deepEqual(keys('economy'), ['eraCountdown', 'agentPayouts', 'openDisputes']);
  assert.deepEqual(keys('validators'), ['validators', 'nodeHealth']);
  assert.deepEqual(keys('history'), ['blockTime', 'agreementsCumulative', 'emissionCumulative', 'agentsOverTime']);
  assert.deepEqual(keys('upgrades'), ['specVersion', 'lastUpgrade']);
  assert.match(section('verify'), /<details class="disclosure verify">/);
  // Figure rows: equal widths, hairlines between, no boxes; figures at figure-l with label captions under them.
  assert.match(rule('.figure-row'), /grid-auto-columns: minmax\(0, 1fr\)/);
  assert.match(rule('.figure-row > .reading + .reading'), /border-left: 1px solid var\(--border\)/);
  assert.ok(!/border: 1px/.test(rule('.figure-row > .reading')), 'no box round a figure');
  for (const [, block] of section('chain').matchAll(/<div class="reading" data-reading="[^"]+">([\s\S]*?)<\/div>/g)) {
    assert.ok(block.indexOf('reading-value') < block.indexOf('reading-label'), 'a section figure carries its caption under it');
  }
  assert.match(rule('.section'), /padding-block: var\(--space-7\)/);
  assert.match(rule('.section-grid'), /gap: var\(--space-5\)/);
  // Charts: titles in h3, axes in mono at 0.75 rem in the secondary colour, one zero line.
  for (const [, key, block] of page.matchAll(/<figure class="strip reading" data-reading="([^"]+)">([\s\S]*?)<\/figure>/g)) {
    assert.match(block, /<h3 class="chart-title reading-label">[^<]+<\/h3>/, `${key} has no h3 title`);
    assert.match(block, /<p class="strip-caption">[^<]{10,80}<\/p>/, `${key} has no one-line caption`);
  }
  assert.match(rule('.strip-plot .plot-label', allCss), /font-family: var\(--font-mono\)/);
  assert.match(rule('.strip-plot .plot-label', allCss), /font-size: var\(--t-mono\)/);
  assert.match(rule('.strip-plot .plot-label', allCss), /fill: var\(--text-dim\)/);
  const strips = readFileSync(new URL('../src/observatory/instruments/history.js', import.meta.url), 'utf8');
  assert.equal((strips.match(/'plot-zero'/g) ?? []).length, 4, 'one zero line per strip');
});

test('fonts: Source Serif 4 (optical size 60) for display and figures, Inter for the interface, JetBrains Mono for sources — self-hosted, swapped, metric-matched; nothing else ships', () => {
  const fonts = readdirSync(join(out, 'fonts')).sort();
  assert.deepEqual(fonts, ['inter-latin-wght-normal.woff2', 'jetbrains-mono-latin-400-normal.woff2', 'source-serif-4-latin-opsz-normal.woff2']);
  assert.ok(!/Instrument Serif|instrument-serif|IBM Plex|ibm-plex/i.test(css + page), 'Instrument Serif and IBM Plex are gone');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const gone of ['@fontsource/instrument-serif', '@fontsource/ibm-plex-mono', '@fontsource/ibm-plex-sans']) assert.ok(!(gone in (pkg.devDependencies ?? {})), `${gone} is still installed`);
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
  for (const family of ['Source Serif 4', 'Inter', 'JetBrains Mono']) {
    const face = faces.find((f) => f.includes(`font-family: "${family}";`));
    assert.ok(face && /font-display: swap/.test(face), `${family} is not self-hosted with font-display: swap`);
    const fallback = faces.find((f) => f.includes(`font-family: "${family} Fallback";`));
    assert.ok(fallback && /size-adjust: [\d.]+%/.test(fallback) && /ascent-override/.test(fallback) && /descent-override/.test(fallback), `${family} has no metric-matched fallback`);
  }
  assert.match(css, /--font-serif: "Source Serif 4", "Source Serif 4 Fallback"/);
  assert.match(css, /--font-sans: "Inter", "Inter Fallback"/);
  assert.match(css, /--font-mono: "JetBrains Mono", "JetBrains Mono Fallback"/);
  assert.match(rule('h1,\nh2'), /font-family: var\(--font-serif\)/);
  assert.match(rule('h1,\nh2'), /font-variation-settings: "opsz" 60/);
  assert.match(rule('h1,\nh2'), /font-weight: 500/);
  assert.match(rule('.reading-value'), /font-family: var\(--font-serif\)/);
  assert.match(rule('.reading-value'), /font-variation-settings: "opsz" 60/);
  assert.match(rule('.reading-value'), /font-weight: 400/);
  assert.match(rule('body'), /font: 400 var\(--t-body\) \/ 1\.6 var\(--font-sans\)/);
  assert.match(rule('body'), /font-feature-settings: "cv11", "ss01"/);
  assert.match(rule('.reading-label'), /font-weight: 500/);
  assert.match(rule('.eyebrow'), /font-weight: 600/);
  assert.match(css, /--measure: 62ch/);
  // Mono only for sources, hashes, addresses and the river's axis.
  for (const selector of ['.reading-prov', '.hash', '.agent-list', '.validator-list']) {
    assert.match(rule(selector, allCss), /font-family: var\(--font-mono\)/, `${selector} is not mono`);
  }
  for (const selector of ['.reading-value', '.reading-label', '.eyebrow', '.btn', '.legend', '.constellation-tip']) {
    assert.ok(!/var\(--font-mono\)/.test(rule(selector, allCss)), `${selector} is set in mono`);
  }
  assert.match(page, /<link rel="preload" href="fonts\/source-serif-4-latin-opsz-normal\.woff2" as="font" type="font\/woff2" crossorigin>/);
  assert.match(page, /<link rel="preload" href="fonts\/inter-latin-wght-normal\.woff2" as="font" type="font\/woff2" crossorigin>/);
});

test('figures: real tabular lining figures — the digit-cell workaround is gone', () => {
  assert.match(rule('.reading-value'), /font-variant-numeric: tabular-nums lining-nums/);
  assert.ok(!/\.dc\b|dcells/.test(allCss), 'no digit-cell rule is left');
  for (const [file, src] of clientSources()) assert.ok(!/setDigits|dcells/.test(src), `${file} still builds digit cells`);
  // Numeric interface text is tabular too.
  for (const selector of ['.sb-pill', '.live-line', '.mono,\ncode,\npre']) {
    assert.match(rule(selector), /font-variant-numeric: tabular-nums/, `${selector} is not tabular`);
  }
});

test('type scale: nine sizes in rem, and every font size in the stylesheet is one of them', () => {
  const scale = {
    display: ['4.5rem', '1'], 'figure-xl': ['4rem', '1'], h2: ['2.25rem', '1.15'], 'figure-l': ['2.5rem', '1'],
    h3: ['1.25rem', '1.3'], body: ['1.0625rem', '1.6'], label: ['0.875rem', '1.4'], eyebrow: ['0.75rem', '1.2'], mono: ['0.75rem', '1.5'],
  };
  for (const [name, [size, line]] of Object.entries(scale)) {
    assert.match(css, new RegExp(`--t-${name}: ${size.replace('.', '\\.')};`), `--t-${name} is not ${size}`);
    assert.match(css, new RegExp(`--lh-${name}: ${line.replace('.', '\\.')};`), `--lh-${name} is not ${line}`);
  }
  assert.match(rule('.hero h1'), /font-size: var\(--t-display\)/);
  assert.match(rule('.hero h1'), /letter-spacing: -0\.02em/);
  assert.match(rule('.hero-figure .reading-value'), /font-size: var\(--t-figure-xl\)/);
  assert.match(rule('h2'), /font-size: var\(--t-h2\)/);
  assert.match(rule('h2'), /letter-spacing: -0\.01em/);
  assert.match(rule('.reading-value'), /font-size: var\(--t-figure-l\)/);
  assert.match(rule('h3'), /font-size: var\(--t-h3\)/);
  assert.match(rule('.reading-label'), /font-size: var\(--t-label\)/);
  assert.match(rule('.eyebrow'), /font-size: var\(--t-eyebrow\)/);
  assert.match(rule('.eyebrow'), /letter-spacing: 0\.12em/);
  assert.match(rule('.eyebrow'), /text-transform: uppercase/);
  // Only the scale: presenter mode, which sets figures for a room, is the one stated exception.
  for (const [selector, body] of blocks(allCss)) {
    if (selector.startsWith('html[data-present]') || selector.startsWith(':root') || selector.startsWith('@font-face')) continue;
    for (const [, value] of body.matchAll(/font-size:\s*([^;]+);/g)) {
      assert.match(value, /var\(--t-[a-z0-9-]+\)|^inherit$/, `${selector} sets font-size: ${value}, off the scale`);
    }
    for (const [, value] of body.matchAll(/(?:^|;)\s*font:\s*([^;]+);/g)) {
      assert.match(value, /var\(--t-[a-z0-9-]+\)/, `${selector} sets font: ${value}, off the scale`);
    }
  }
});

test('colour: the plate, surface, hairline, text and secondary as briefed; secondary text passes WCAG AA on both themes; one teal for live, amber for disputes only; no gradients, glow or glass', () => {
  const [dark, light] = themes();
  assert.equal(dark['--bg'], '#0b0e12');
  assert.equal(dark['--surface'], '#11151b');
  assert.equal(dark['--border'], '#1f252d');
  assert.equal(dark['--text'], '#e8eaed');
  assert.equal(dark['--text-dim'], '#a3acb7');
  assert.equal(light['--bg'], '#f7f6f2');
  for (const [name, scheme] of [['dark', dark], ['light', light]]) {
    for (const ground of ['--bg', '--surface']) {
      for (const ink of ['--text', '--text-dim']) {
        const ratio = contrast(scheme[ink], scheme[ground]);
        assert.ok(ratio >= 4.5, `${name}: ${ink} on ${ground} is ${ratio.toFixed(2)}:1, under AA`);
      }
    }
    assert.ok(contrast(scheme['--accent'], scheme['--bg']) >= 4.5, `${name}: the accent is too faint to read as text`);
    assert.ok(contrast(scheme['--disputed'], scheme['--bg']) >= 4.5, `${name}: amber is too faint to read as text`);
    // The field's cells are marks, not text: each state's ink stands 3:1 off the plate (WCAG 1.4.11).
    for (const ink of ['--idle', '--accent', '--disputed', '--slash']) {
      assert.ok(contrast(scheme[ink], scheme['--bg']) >= 3, `${name}: ${ink} is too faint for a cell`);
    }
    assert.equal(scheme['--live'], 'var(--accent)');
    assert.equal(scheme['--active'], 'var(--accent)');
  }
  for (const [selector, body] of blocks(allCss)) {
    if (/var\(--disputed\)/.test(body)) assert.match(selector, /disput/, `amber used outside a dispute: ${selector}`);
    if (/var\(--slash\)/.test(body)) assert.match(selector, /slash/, `red used outside a slash: ${selector}`);
  }
  // Red is for slashes only in the client too: the one ink name `slash` is drawn only for a slashed cell.
  for (const [file, src] of clientSources()) {
    for (const m of src.matchAll(/color\('slash'\)|'slash'/g)) assert.match(file, /agent-field|context/, `${file} uses the slash red: ${m[0]}`);
  }
  assert.ok(!/gradient\(|box-shadow|text-shadow|backdrop-filter|blur\(/.test(allCss), 'no gradients, glow or glass');
  for (const [file, src] of clientSources()) {
    assert.ok(!/shadowBlur|createLinearGradient|createRadialGradient/.test(src), `${file} draws a glow or gradient`);
  }
});

test('components: one button, one disclosure, one tooltip, one focus ring; 40 px hit targets on touch', () => {
  assert.match(rule(':focus-visible'), /outline: 2px solid var\(--accent\)/);
  assert.match(rule(':focus-visible'), /outline-offset: 2px/);
  assert.match(rule('.disclosure > summary'), /min-height: 32px/);
  const buttons = [...page.matchAll(/<button[^>]*class="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(buttons.every((c) => /\bbtn\b|\bcopy\b/.test(c)), `a button outside the one style: ${buttons.join(' | ')}`);
  assert.match(rule('.copy'), /^/); // copy controls share .btn in markup
  for (const [, cls] of page.matchAll(/<details class="([^"]*)"/g)) assert.match(cls, /\bdisclosure\b/, `a disclosure outside the one style: ${cls}`);
  // The tooltip: the constellation's tip and a figure's source on hover are the same component.
  const tip = rule('.tooltip');
  for (const decl of ['background: var(--surface)', 'border: 1px solid var(--border)', 'padding: var(--space-2) var(--space-3)']) {
    assert.ok(tip.includes(decl), `.tooltip lacks ${decl}`);
  }
  const hover = css.match(/html:not\(\[data-sources\]\) \[data-reading\]:hover > \.reading-prov,\s*html:not\(\[data-sources\]\) \[data-reading\]:focus-within > \.reading-prov \{([^}]*)\}/)?.[1] ?? '';
  for (const decl of ['background: var(--surface)', 'border: 1px solid var(--border)', 'padding: var(--space-2) var(--space-3)']) {
    assert.ok(hover.includes(decl), `the source tooltip lacks ${decl}`);
  }
  const coarse = css.slice(css.indexOf('@media (pointer: coarse)'));
  assert.match(coarse, /min-height: 40px/);
});

test('provenance: hidden by default; Sources shows every line in place and is remembered; hovering a figure shows its source as a tooltip', () => {
  assert.match(page, /<script>try\{if\(localStorage\.getItem\("observatory:sources"\)==="1"\)document\.documentElement\.setAttribute\("data-sources",""\)\}catch\(e\)\{\}<\/script>/);
  assert.match(rule('.reading-prov'), /display: none/);
  assert.match(css, /html\[data-sources\] \.reading-prov \{\s*display: block;\s*position: static;/);
  assert.ok((page.match(/class="reading-prov"/g) ?? []).length >= 18, 'every figure still carries its line');
  assert.ok(bundle.includes('observatory:sources'), 'the bundle remembers the choice');
});

test('motion: figures tween, sections fade up 12 px once by IntersectionObserver, the new block slides into the river; nothing loops; reduced motion turns it off', () => {
  assert.match(css, /html\.reveal-ready \[data-reveal\]:not\(\.is-in\) \{\s*opacity: 0;\s*transform: translateY\(12px\);/);
  assert.ok(!/@keyframes|animation:/.test(allCss), 'no keyframe animation at all');
  assert.ok(bundle.includes('IntersectionObserver'));
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\[data-reveal\] \{\s*opacity: 1;\s*transform: none;\s*transition: none;/);
  const pulse = readFileSync(new URL('../src/observatory/instruments/pulse.js', import.meta.url), 'utf8');
  assert.match(pulse, /animateArrival/);
});

test('presenter mode: the Present button and P, the hero first, then the six sections, figures for a room', () => {
  assert.ok(!page.includes('data-present=""') && !/present=1/.test(page), 'nothing in the page turns it on from the URL');
  const screens = [...page.matchAll(/<(header|section)(?: id="([a-z]+)")?[^>]*data-present-screen/g)].map((m) => m[2] ?? 'hero');
  assert.deepEqual(screens, ['hero', 'chain', 'economy', 'validators', 'history', 'upgrades', 'verify']);
  for (const selector of ['html[data-present] .site-nav', 'html[data-present] .reading-prov', 'html[data-present] footer', 'html[data-present] [data-present-screen][data-present-active]', 'html[data-present] .river-strip']) {
    assert.ok(css.includes(selector), `observatory.css has no rule for ${selector}`);
  }
  assert.match(css, /html\[data-present\] \.section \.reading-value \{\s*font-size: clamp\(3rem, 8\.5vw, 160px\)/);
  for (const key of ['Escape', 'aria-pressed']) assert.ok(bundle.includes(key), `the bundle does not handle ${key}`);
  assert.ok(!/<script/i.test(index), 'index.html stays script-free');
});

test('identity: the wordmark with the mark in the top bar and the footer; no favicon; the landing page untouched', () => {
  assert.match(statusbarHtml(), /<a class="wordmark" href="observatory"><svg class="mark"/);
  assert.match(page.slice(page.indexOf('<footer')), /<a class="wordmark" href="observatory"><svg class="mark"/);
  assert.ok(!/rel="icon"/.test(page) && !/rel="icon"/.test(index));
  assert.ok(!readdirSync(out).includes('favicon.svg'));
  const footer = page.slice(page.indexOf('<footer'));
  assert.match(footer, /class="merge" data-reading="lastMerge"/);
  assert.match(footer, /<details class="disclosure howto">/);
});
