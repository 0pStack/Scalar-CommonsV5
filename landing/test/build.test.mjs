// The gate for issue #74 is `npm ci && npm run build`, so the build script
// itself is under test: it must emit a self-contained static site into the
// output directory and must refuse to emit a page with unresolved content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const landingDir = fileURLToPath(new URL('../', import.meta.url));

test('npm run build emits a self-contained static site', () => {
  const out = mkdtempSync(join(tmpdir(), 'landing-build-'));
  execFileSync(process.execPath, ['scripts/build.mjs'], {
    cwd: landingDir,
    env: { ...process.env, LANDING_OUT_DIR: out },
    stdio: 'pipe',
  });

  const files = readdirSync(out);
  assert.ok(files.includes('index.html'), `build produced no index.html (got: ${files.join(', ')})`);
  assert.ok(files.includes('styles.css'), `build produced no styles.css (got: ${files.join(', ')})`);

  const indexHtml = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(indexHtml, /^<!doctype html>/i);
  assert.match(indexHtml, /<link rel="stylesheet" href="styles\.css">/);
  // A static marketing page has no reason to ship script: no script tag means
  // nothing on the page can drift from what the build verified.
  assert.ok(!/<script/i.test(indexHtml), 'the page must stay script-free');

  const css = readFileSync(join(out, 'styles.css'), 'utf8');
  assert.ok(css.length > 0, 'styles.css is empty');
});
