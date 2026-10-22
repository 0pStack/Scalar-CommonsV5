// Pure CHANGELOG.md and version logic for the changelog-release workflow.
// Everything that talks to git or GitHub lives in run.mjs, so this file can be
// tested without either.

const UNRELEASED = '## Unreleased';

// Fixed order of sections inside a release. Security comes first because
// operators deciding whether to upgrade read it first.
export const SECTIONS = ['Security', 'Fixed', 'Changed', 'Documentation', 'Maintenance'];

const LABEL_SECTIONS = [
  ['security', 'Security'],
  ['bug', 'Fixed'],
  ['documentation', 'Documentation'],
  ['tidy', 'Maintenance'],
  ['qa', 'Maintenance'],
];

/** Section for a merged PR, from its own labels plus those of the issues it closes. */
export function sectionFor(labels) {
  if (labels.includes('skip-changelog')) return null;
  const hit = LABEL_SECTIONS.find(([label]) => labels.includes(label));
  return hit ? hit[1] : 'Changed';
}

export function entryLine({ repo, number, title, closes }) {
  const pr = `[#${number}](${repo}/pull/${number})`;
  const issues = closes.map((n) => `[#${n}](${repo}/issues/${n})`).join(', ');
  // Titles here often start "#28: " or end "(#19)"; the "closes" links already say that.
  const bare = title.replace(/^#\d+:\s*/, '').replace(/\s*\(#\d+\)\s*$/, '');
  return `- ${bare} (${issues ? `${pr}, closes ${issues}` : pr})`;
}

function splitUnreleased(raw) {
  const changelog = raw.replace(/\r\n/g, '\n');
  const match = /^## Unreleased$/m.exec(changelog);
  if (!match) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" heading`);
  const bodyStart = match.index + UNRELEASED.length;
  const next = changelog.indexOf('\n## ', bodyStart);
  const end = next === -1 ? changelog.length : next + 1;
  return {
    head: changelog.slice(0, match.index),
    body: changelog.slice(bodyStart, end),
    tail: changelog.slice(end),
  };
}

// Unreleased is rewritten on every edit, so anything this parser does not
// understand would be silently lost. Refuse it instead.
function parseSections(body) {
  const sections = new Map();
  let current = null;
  for (const line of body.split('\n')) {
    const heading = line.match(/^### (.+)$/);
    if (heading) {
      current = heading[1];
      sections.set(current, sections.get(current) ?? []);
    } else if (current && line.startsWith('- ')) {
      sections.set(current, [...sections.get(current), line]);
    } else if (line.trim() !== '') {
      throw new Error(
        `CHANGELOG.md: line under ${UNRELEASED} is not a "### Section" heading or a one-line "- " entry: "${line}"`,
      );
    }
  }
  return sections;
}

function renderSections(sections) {
  const extra = [...sections.keys()].filter((s) => !SECTIONS.includes(s));
  return [...SECTIONS, ...extra]
    .filter((name) => (sections.get(name) ?? []).length > 0)
    .map((name) => `### ${name}\n\n${sections.get(name).join('\n')}\n`)
    .join('\n');
}

function withUnreleased(head, rendered, tail) {
  const body = rendered ? `\n\n${rendered}` : '\n';
  return `${head}${UNRELEASED}${body}${tail ? `\n${tail}` : ''}`;
}

/** Add an entry under Unreleased. A PR already listed anywhere in the file is skipped. */
export function addEntry(changelog, section, line) {
  const pr = line.match(/\[#\d+\]\([^)]*\/pull\/\d+\)/);
  if (pr && changelog.includes(pr[0])) return changelog;
  const { head, body, tail } = splitUnreleased(changelog);
  const sections = parseSections(body);
  const updated = new Map(sections).set(section, [...(sections.get(section) ?? []), line]);
  return withUnreleased(head, renderSections(updated), tail);
}

/**
 * Next release tag, or null when nothing shipped in the node binary changed.
 * Pre-1.0, a runtime spec_version change is a minor bump and a node-only
 * change is a patch.
 */
export function nextVersion(lastTag, { specChanged = false, nodeChanged = false, force } = {}) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(lastTag);
  if (!m) throw new Error(`last tag "${lastTag}" is not vMAJOR.MINOR.PATCH`);
  if (force !== undefined && force !== 'minor' && force !== 'patch') {
    throw new Error(`force must be "minor" or "patch", got "${force}"`);
  }
  const [major, minor, patch] = m.slice(1).map(Number);
  const bump = force ?? (specChanged ? 'minor' : nodeChanged ? 'patch' : null);
  if (bump === 'minor') return `v${major}.${minor + 1}.0`;
  if (bump === 'patch') return `v${major}.${minor}.${patch + 1}`;
  return null;
}

/** Turn Unreleased into a dated release section and open a fresh Unreleased. */
export function cutRelease(changelog, version, date) {
  const { head, body, tail } = splitUnreleased(changelog);
  const notes = renderSections(parseSections(body)) || 'No changes recorded.\n';
  const released = `## [${version}] - ${date}\n\n${notes}`;
  return {
    changelog: `${head}${UNRELEASED}\n\n${released}${tail ? `\n${tail}` : ''}`,
    notes,
  };
}

/** The runtime's spec_version, from the `spec_version: N,` field of RuntimeVersion. */
export function parseSpecVersion(libRs) {
  const m = libRs.match(/^\s*spec_version:\s*(\d+),/m);
  if (!m) throw new Error('no `spec_version: N,` field found in runtime/src/lib.rs');
  return Number(m[1]);
}

/**
 * The PR a first-parent commit on main came from, read from its subject: a merge
 * commit's "Merge pull request #N from …" or a squash commit's trailing "(#N)".
 */
export function prNumberFromSubject(subject) {
  const m = subject.match(/^Merge pull request #(\d+) from /) ?? subject.match(/\(#(\d+)\)$/);
  return m ? Number(m[1]) : null;
}

const RELEASE_BADGE = /(img\.shields\.io\/badge\/release-)v\d+\.\d+\.\d+(-)/;

/**
 * Point the README's release badge at a new version. The repo is private, so
 * shields.io cannot read its releases and the badge has to be static. Returns
 * null when the README has no release badge.
 */
export function setReleaseBadge(readme, version) {
  if (!RELEASE_BADGE.test(readme)) return null;
  return readme.replace(RELEASE_BADGE, `$1${version}$2`);
}
