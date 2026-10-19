// Builds the static site into dist/ (or $LANDING_OUT_DIR).
//
// The landing page build is deliberately dependency-free: the gate for this
// site is `npm ci && npm run build`, and the fewer moving parts stand between
// a fresh clone and a rendered page, the fewer ways that gate has to fail for
// reasons that have nothing to do with the page. @polkadot/api is a
// devDependency used only by the scripts that read the chain.
//
// /observatory is the exception, and the one place a bundler is used: its
// instruments are drawn with d3-force, d3-scale and d3-shape, and esbuild
// bundles just those modules with the page's own script into one file —
// one script, no chunks, no WebGL and no animation library (the scroll
// reveal is the browser's IntersectionObserver). /pulse is bundled the same
// way into its own one script, with force-graph and gsap, which no other
// page loads. The landing page itself still ships no script at all.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';
import { content } from '../src/content.mjs';
import { sourceClaims } from '../src/source-claims.mjs';
import { renderPage } from '../src/render.mjs';
import { renderObservatory } from '../src/observatory.mjs';
import { renderPulse } from '../src/pulse.mjs';
import { FONTS, observatoryCss } from '../src/observatory-assets.mjs';

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const readJson = (relative) => JSON.parse(readFileSync(here(relative), 'utf8'));

const facts = readJson('../chain-facts.json');

// renderPage throws on an unresolvable placeholder, so a page that would state a
// figure the chain never reported fails the build instead of shipping.
const html = renderPage({ facts, content, sourceClaims });

const outDir = process.env.LANDING_OUT_DIR ?? here('../dist');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), html);
copyFileSync(here('../src/styles.css'), join(outDir, 'styles.css'));

// /observatory: a static frame whose live figures the reader's browser fetches.
// The two sets of figures it is built with are checked-in records, and both
// are also copied out so the page can link to the raw file it was built from.
const history = readJson('../runtime-history.json');
const posture = readJson('../public/posture.json');
// The stylesheet ships minified, inlined in the page for first paint and as a
// file for reading; the source in src/ stays the readable copy.
const css = (await transform(observatoryCss(), { loader: 'css', minify: true })).code.trim();
writeFileSync(join(outDir, 'observatory.html'), renderObservatory({ history, posture, css }));
writeFileSync(join(outDir, 'observatory.css'), css);
copyFileSync(here('../runtime-history.json'), join(outDir, 'runtime-history.json'));
copyFileSync(here('../public/posture.json'), join(outDir, 'posture.json'));

// /pulse: the same design system (the observatory's stylesheet, then the
// page's own), inlined the same way, written out the same way.
const pulseCss = (
  await transform(`${observatoryCss()}\n${readFileSync(here('../src/pulse.css'), 'utf8')}`, { loader: 'css', minify: true })
).code.trim();
writeFileSync(join(outDir, 'pulse.html'), renderPulse({ css: pulseCss }));
writeFileSync(join(outDir, 'pulse.css'), pulseCss);

mkdirSync(join(outDir, 'fonts'), { recursive: true });
for (const [source, name] of FONTS) {
  copyFileSync(here(`../node_modules/${source}`), join(outDir, 'fonts', name));
}

const common = {
  bundle: true,
  minify: true,
  format: 'esm',
  target: ['es2022', 'chrome100', 'safari16', 'firefox100'],
  legalComments: 'none',
  metafile: true,
  logLevel: 'silent',
};
// One script for the page, observatory.js. The network graph (with
// d3-force) is a second, self-contained bundle, observatory-graph.js, which
// the page imports by URL only when its switch is first turned on; nothing is
// shared between the two, so the first screen fetches one script.
const bundle = await build({
  ...common,
  entryPoints: [here('../src/observatory/main.js')],
  outfile: join(outDir, 'observatory.js'),
});
const graph = await build({
  ...common,
  entryPoints: [here('../src/observatory/instruments/constellation.js')],
  outfile: join(outDir, 'observatory-graph.js'),
});
// /pulse is one script too: its canvas library (force-graph) and its easing
// (gsap) ride in pulse.js, and nowhere near the observatory's bundles.
const pulseBundle = await build({
  ...common,
  entryPoints: [here('../src/pulse/main.js')],
  outfile: join(outDir, 'pulse.js'),
});
const bundleBytes = Object.values(bundle.metafile.outputs)[0]?.bytes ?? 0;
const chunkBytes = Object.values(graph.metafile.outputs)[0]?.bytes ?? 0;
const pulseBytes = Object.values(pulseBundle.metafile.outputs)[0]?.bytes ?? 0;

console.log(
  `built ${outDir}/index.html (${(html.length / 1024).toFixed(1)} kB) from ${facts.provenance.specName} spec ` +
    `${facts.provenance.specVersion}, metadata v${facts.provenance.metadataVersion}, block ` +
    `#${facts.provenance.readAtBlock}; observatory.js ${(bundleBytes / 1024).toFixed(1)} kB` +
    `, observatory-graph.js (on demand) ${(chunkBytes / 1024).toFixed(1)} kB; pulse.js ${(pulseBytes / 1024).toFixed(1)} kB`,
);
