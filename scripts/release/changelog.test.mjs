import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sectionFor,
  entryLine,
  addEntry,
  nextVersion,
  cutRelease,
  parseSpecVersion,
} from './changelog.mjs';

const REPO = 'https://github.com/0pStack/Scalar-CommonsV5';
const EMPTY = '# Changelog\n\n## Unreleased\n';

test('security outranks every other label, on the PR or a closed issue', () => {
  assert.equal(sectionFor(['bug', 'security']), 'Security');
  assert.equal(sectionFor(['bug']), 'Fixed');
  assert.equal(sectionFor(['documentation']), 'Documentation');
  assert.equal(sectionFor(['tidy', 'qa']), 'Maintenance');
  assert.equal(sectionFor([]), 'Changed');
  assert.equal(sectionFor(['security', 'skip-changelog']), null);
});

test('an entry links the PR and every issue it closes', () => {
  assert.equal(
    entryLine({ repo: REPO, number: 121, title: 'runtime: ship quick-fix bundle (#19)', closes: [19] }),
    `- runtime: ship quick-fix bundle ([#121](${REPO}/pull/121), closes [#19](${REPO}/issues/19))`,
  );
  assert.equal(
    entryLine({ repo: REPO, number: 120, title: '#28: reject unsafe offsets', closes: [28] }),
    `- reject unsafe offsets ([#120](${REPO}/pull/120), closes [#28](${REPO}/issues/28))`,
  );
  assert.equal(
    entryLine({ repo: REPO, number: 112, title: 'chore: LF line endings', closes: [] }),
    `- chore: LF line endings ([#112](${REPO}/pull/112))`,
  );
});

test('entries land under their section in a fixed order', () => {
  let log = addEntry(EMPTY, 'Fixed', '- b ([#2](x/pull/2))');
  log = addEntry(log, 'Security', '- a ([#1](x/pull/1))');
  log = addEntry(log, 'Fixed', '- c ([#3](x/pull/3))');
  assert.equal(
    log,
    '# Changelog\n\n## Unreleased\n\n### Security\n\n- a ([#1](x/pull/1))\n\n### Fixed\n\n- b ([#2](x/pull/2))\n- c ([#3](x/pull/3))\n',
  );
});

test('adding the same PR twice is a no-op, so a re-run cannot duplicate it', () => {
  const once = addEntry(EMPTY, 'Fixed', '- b ([#2](x/pull/2))');
  assert.equal(addEntry(once, 'Changed', '- b again ([#2](x/pull/2))'), once);
});

test('entries never leak into an already released section', () => {
  const log = '# Changelog\n\n## Unreleased\n\n## [v0.5.0] - 2026-10-20\n\n### Fixed\n\n- old ([#1](x/pull/1))\n';
  const out = addEntry(log, 'Fixed', '- new ([#2](x/pull/2))');
  assert.equal(
    out,
    '# Changelog\n\n## Unreleased\n\n### Fixed\n\n- new ([#2](x/pull/2))\n\n## [v0.5.0] - 2026-10-20\n\n### Fixed\n\n- old ([#1](x/pull/1))\n',
  );
});

test('a spec_version change is a minor release, a node change a patch, anything else none', () => {
  assert.equal(nextVersion('v0.5.0', { specChanged: true, nodeChanged: true }), 'v0.6.0');
  assert.equal(nextVersion('v0.5.3', { specChanged: true, nodeChanged: false }), 'v0.6.0');
  assert.equal(nextVersion('v0.5.0', { specChanged: false, nodeChanged: true }), 'v0.5.1');
  assert.equal(nextVersion('v0.5.0', { specChanged: false, nodeChanged: false }), null);
});

test('a forced bump overrides the detected one', () => {
  assert.equal(nextVersion('v0.5.0', { specChanged: false, nodeChanged: false, force: 'minor' }), 'v0.6.0');
  assert.equal(nextVersion('v0.5.0', { specChanged: true, nodeChanged: false, force: 'patch' }), 'v0.5.1');
  assert.throws(() => nextVersion('v0.5.0', { force: 'major' }), /force/);
  assert.throws(() => nextVersion('0.5', {}), /tag/);
});

test('cutting a release dates the Unreleased section and opens a fresh one', () => {
  const log = addEntry(EMPTY, 'Fixed', '- b ([#2](x/pull/2))');
  const { changelog, notes } = cutRelease(log, 'v0.6.0', '2026-10-22');
  assert.equal(
    changelog,
    '# Changelog\n\n## Unreleased\n\n## [v0.6.0] - 2026-10-22\n\n### Fixed\n\n- b ([#2](x/pull/2))\n',
  );
  assert.equal(notes, '### Fixed\n\n- b ([#2](x/pull/2))\n');
});

test('a release with nothing unreleased still gets a section', () => {
  const { changelog, notes } = cutRelease(EMPTY, 'v0.5.1', '2026-10-22');
  assert.match(changelog, /## \[v0\.5\.1\] - 2026-10-22\n\nNo changes recorded\.\n/);
  assert.equal(notes, 'No changes recorded.\n');
});

test('spec_version is read from the RuntimeVersion literal, not from comments or tests', () => {
  const src = [
    '    // accompanied by a spec_version bump.',
    '    spec_version: 313,',
    '    fn spec_version_is_313() { assert_eq!(VERSION.spec_version, 313); }',
  ].join('\n');
  assert.equal(parseSpecVersion(src), 313);
  assert.throws(() => parseSpecVersion('no version here'), /spec_version/);
});
