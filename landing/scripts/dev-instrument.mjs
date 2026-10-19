// Builds and serves ONE observatory instrument on its own section, against the
// live services, so it can be developed and screenshotted without the rest of
// the page:
//
//   node scripts/dev-instrument.mjs <name> [--out DIR] [--port N] [--no-serve]
//
// <name> is a section name from src/observatory.mjs (pulse, era,
// constellation, validators, history, upgrades, posture, verify). The build
// writes DIR/index.html (the harness page with that section's markup),
// DIR/observatory.css, the fonts, and DIR/observatory.js bundled from
// src/observatory/harness.js with `instrument-under-test` aliased to
// src/observatory/instruments/<file>.js.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { renderHarness } from '../src/observatory.mjs';
import { FONTS, observatoryCss } from '../src/observatory-assets.mjs';

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const readJson = (relative) => JSON.parse(readFileSync(here(relative), 'utf8'));

const INSTRUMENT_FILES = {
  pulse: 'pulse.js',
  era: 'era-dial.js',
  economy: 'economy.js',
  'agent-field': 'agent-field.js',
  'last-hour': 'last-hour.js',
  constellation: 'constellation.js',
  validators: 'validator-ring.js',
  history: 'history.js',
  upgrades: 'upgrade-rail.js',
  posture: 'posture.js',
  verify: 'verify.js',
};

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--'));
const flag = (key, fallback) => {
  const i = args.indexOf(key);
  return i === -1 ? fallback : args[i + 1];
};
if (!name || !INSTRUMENT_FILES[name]) {
  console.error(`usage: dev-instrument.mjs <${Object.keys(INSTRUMENT_FILES).join('|')}> [--out DIR] [--port N] [--no-serve]`);
  process.exit(2);
}
const outDir = flag('--out', here(`../dist-harness/${name}`));
const port = Number(flag('--port', 8770));

mkdirSync(join(outDir, 'fonts'), { recursive: true });
const history = readJson('../runtime-history.json');
const posture = readJson('../public/posture.json');
const css = observatoryCss();
writeFileSync(join(outDir, 'index.html'), renderHarness(name, { history, posture, css }));
writeFileSync(join(outDir, 'observatory.css'), css);
for (const [source, file] of FONTS) copyFileSync(here(`../node_modules/${source}`), join(outDir, 'fonts', file));

await build({
  entryPoints: [here('../src/observatory/harness.js')],
  bundle: true,
  format: 'esm',
  sourcemap: 'inline',
  target: ['es2022'],
  outfile: join(outDir, 'observatory.js'),
  alias: { 'instrument-under-test': here(`../src/observatory/instruments/${INSTRUMENT_FILES[name]}`) },
  logLevel: 'warning',
});
// The network graph, fetched by the agent field on demand, as on the page.
await build({
  entryPoints: [here('../src/observatory/instruments/constellation.js')],
  bundle: true,
  format: 'esm',
  sourcemap: 'inline',
  target: ['es2022'],
  outfile: join(outDir, 'observatory-graph.js'),
  logLevel: 'warning',
});
console.log(`harness for "${name}" built into ${outDir}`);

if (!args.includes('--no-serve')) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.woff2': 'font/woff2',
  };
  createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    for (const candidate of [path, join(path, 'index.html'), `${path}.html`]) {
      try {
        const file = join(outDir, candidate);
        if (statSync(file).isFile()) {
          res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
          res.end(readFileSync(file));
          return;
        }
      } catch {
        // try the next candidate
      }
    }
    res.writeHead(404);
    res.end('404');
  }).listen(port, () => console.log(`serving ${outDir} at http://127.0.0.1:${port}/`));
}
