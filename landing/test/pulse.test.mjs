// /pulse as built: the page, its one script, its stylesheet, and the rules
// the observatory's modules are held to, applied to the pulse's modules the
// same way. The build runs once into a temporary directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENTS, KINDS } from '../src/pulse/model.js';
import { FIGURES, LEGEND, CAPTION } from '../src/pulse.mjs';
import { KEYS } from '../src/pulse/strip.js';
import { SOURCES, API_ORIGIN, blockEventsSource } from '../src/observatory/data.js';

const landingDir = fileURLToPath(new URL('..', import.meta.url));
const readRepoFile = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

function pulseSources() {
  const dir = fileURLToPath(new URL('../src/pulse/', import.meta.url));
  return readdirSync(dir)
    .filter((name) => name.endsWith('.js') && statSync(join(dir, name)).isFile())
    .map((name) => [name, readFileSync(join(dir, name), 'utf8')]);
}

function build() {
  const out = mkdtempSync(join(tmpdir(), 'landing-pulse-'));
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: landingDir, env: { ...process.env, LANDING_OUT_DIR: out }, stdio: 'pipe' });
  return out;
}

const out = build();
const page = readFileSync(join(out, 'pulse.html'), 'utf8');
const observatory = readFileSync(join(out, 'observatory.html'), 'utf8');
const index = readFileSync(join(out, 'index.html'), 'utf8');
const bundle = readFileSync(join(out, 'pulse.js'), 'utf8');
const observatoryBundle = readFileSync(join(out, 'observatory.js'), 'utf8');
const css = readFileSync(new URL('../src/pulse.css', import.meta.url), 'utf8');

test('the build emits the pulse page, its one script and its stylesheet, and the observatory keeps its own', () => {
  const files = readdirSync(out);
  for (const name of ['pulse.html', 'pulse.js', 'pulse.css']) assert.ok(files.includes(name), `build produced no ${name}`);
  assert.deepEqual([...page.matchAll(/<script[^>]* src="([^"]+)"/g)].map((m) => m[1]), ['pulse.js'], 'the page loads one script');
  assert.ok(!page.includes('observatory.js') && !page.includes('observatory-graph'), 'and never the observatory’s');
  assert.deepEqual([...observatory.matchAll(/<script[^>]* src="([^"]+)"/g)].map((m) => m[1]), ['observatory.js']);
  assert.ok(!observatory.includes('pulse.js'));
  // The canvas library and the easing library ride in pulse.js and nowhere else.
  // Minification keeps the libraries' own property names, not their identifiers.
  assert.ok(/linkDirectionalParticles|nodeCanvasObject/.test(bundle), 'force-graph lives in pulse.js');
  assert.ok(/gsap|globalTimeline/i.test(bundle), 'gsap lives in pulse.js');
  assert.ok(!/gsap|globalTimeline|linkDirectionalParticles|nodeCanvasObject/.test(observatoryBundle), 'and not in observatory.js');
  assert.ok(page.includes('<style>') && !page.includes('<link rel="stylesheet"'), 'the stylesheet is inlined');
  assert.ok(page.includes('fonts/source-serif-4-latin-opsz-normal.woff2'), 'the display serif is preloaded');
});

test('Pulse is linked from the observatory nav, and from its own, as the current page; the landing page is untouched', () => {
  assert.match(observatory, /<a href="pulse">Pulse<\/a>/);
  assert.match(page, /<a href="pulse" aria-current="page">Pulse<\/a>/);
  assert.match(page, /<a href="observatory">Observatory<\/a>/);
  assert.ok(!index.includes('href="pulse"'), 'the landing page’s nav is not changed by this page');
});

test('the strip has exactly the three figures, the caption and a legend of six', () => {
  const keys = [...page.matchAll(/data-reading="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys, FIGURES.map(([key]) => key));
  assert.deepEqual(KEYS, FIGURES.map(([key]) => key));
  for (const [, label] of FIGURES) assert.ok(page.includes(label), `no figure labelled "${label}"`);
  assert.ok(page.includes(CAPTION));
  assert.equal(CAPTION, 'Every light is a real transaction on the Scalar Commons test network.');
  assert.equal(LEGEND.length, 6);
  assert.equal((page.match(/<li><span class="sym sym-/g) ?? []).length, 6);
  // One symbol per kind that lights up: every kind but `resolved`, which has no light of its own.
  assert.equal(KINDS.filter((kind) => kind !== 'resolved').length, 6);
});

test('the stage: the graph host, the tooltip, the banner, the fallback list, the ticker and the fullscreen key', () => {
  assert.match(page, /<div class="pulse-graph" id="graph" role="img" tabindex="0" aria-label="[^"]+"><\/div>/, 'the host ships empty: force-graph takes it over');
  assert.match(page, /<div class="tooltip pulse-tip" role="tooltip" hidden>/);
  assert.match(page, /<p class="pulse-banner" role="status" hidden>/);
  assert.match(page, /<section class="pulse-fallback" hidden/);
  assert.match(page, /<aside class="ticker" aria-label="Live events">/);
  assert.match(page, /class="btn ticker-toggle" aria-expanded="true"/);
  assert.match(page, /<ol class="ticker-lines" id="ticker-lines" aria-live="off"><\/ol>/, 'the ticker ships empty: no sample lines');
  assert.match(page, /class="btn pulse-fullscreen" aria-pressed="false" aria-keyshortcuts="F"/);
  assert.match(page, /<p class="sr-status visually-hidden" aria-live="polite">/);
  assert.match(page, /<noscript>/);
});

test('every light is an event the runtime declares (chain-events.json), and the per-block read is a route the indexer serves', () => {
  const metadata = JSON.parse(readFileSync(new URL('../chain-events.json', import.meta.url), 'utf8'));
  assert.ok(metadata.provenance.specVersion >= 309, 'the record is from a runtime with the messages pallet');
  for (const row of EVENTS) {
    assert.ok(metadata.pallets[row.section]?.includes(row.method), `${row.section}.${row.method} is not an event the runtime declares`);
  }
  const api = readRepoFile('indexer/src/api.ts');
  const toPattern = (route) => new RegExp(`^${route.replace(/:[a-zA-Z]+/g, '[^/]+')}$`);
  const routes = [...api.matchAll(/path: '(\/v1\/[^']+)'/g)].map((m) => m[1]);
  const source = blockEventsSource(919900);
  const path = new URL(source.path, API_ORIGIN).pathname;
  assert.ok(routes.some((route) => toPattern(route).test(path)), `${path} is not a route in indexer/src/api.ts`);
  assert.equal(new URL(source.path, API_ORIGIN).searchParams.get('limit'), '200');
  for (const name of ['agents', 'escrows', 'finalizedHeads', 'status', 'messagesSent', 'deliveriesConfirmed', 'agreementsCreated', 'disputesOpened', 'oracleAnswers', 'oracleBatches', 'registrations']) {
    assert.ok(SOURCES[name], `the feed reads source "${name}", which data.js does not define`);
  }
});

test('the pulse’s modules keep the observatory’s rules: one timer, in main.js; the chain’s hosts only; no pasted keys; no URL flags', () => {
  const allowed = new Set(['api.scalarnet.io', 'rpc.scalarnet.io', 'explorer.scalarnet.io', 'scalarnet.io']);
  const files = pulseSources();
  assert.ok(files.length >= 5, `expected the pulse modules, found ${files.map(([f]) => f).join(', ')}`);
  for (const [file, src] of files) {
    assert.ok(!/setInterval\(|setTimeout\(/.test(src) || file === 'main.js', `${file} holds a timer; use ctx.watch so it pauses when hidden`);
    assert.ok(!/animation-iteration-count|infinite/.test(src), `${file} declares an infinite animation`);
    assert.ok(!/0x[0-9a-f]{64}/i.test(src), `${file} contains a 32-byte hex literal`);
    assert.ok(!/location\.search|URLSearchParams/.test(src), `${file} reads a URL flag`);
    assert.ok(!/eslint-disable/.test(src), `${file} disables lint`);
    assert.ok(!/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(src), `${file} has an empty catch`);
    for (const m of src.matchAll(/(?:https|wss):\/\/([a-z0-9.-]+)/g)) assert.ok(allowed.has(m[1]), `${file} references ${m[1]}`);
  }
  assert.equal((readFileSync(new URL('../src/pulse/main.js', import.meta.url), 'utf8').match(/setInterval\(/g) ?? []).length, 1, 'main.js holds exactly one timer');
});

test('the stylesheet honours reduced motion and the light scheme, never loops, and adds one colour: green, for a payment', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(prefers-color-scheme: light\)/);
  assert.ok(!/infinite/.test(css), 'pulse.css declares an infinite animation');
  assert.match(css, /--paid: #[0-9a-f]{6};/);
  assert.ok(!/gradient\(/.test(css), 'no gradients');
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) 320px;/, 'the ticker is 320 px');
});
