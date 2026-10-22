#!/usr/bin/env node
// CLI for the changelog-release workflow. Logic lives in changelog.mjs; this
// file only reads git and GitHub and writes CHANGELOG.md.
//
//   node scripts/release/run.mjs entries [from] [to]   add an entry per PR merged in from..to
//                                                      (default: last v* tag..HEAD)
//   node scripts/release/run.mjs release [minor|patch] cut a release if one is due (or forced)
//
// `release` writes `tag` and `notes` to $GITHUB_OUTPUT; `tag` is empty when
// no release is due.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import {
  sectionFor,
  entryLine,
  addEntry,
  nextVersion,
  cutRelease,
  parseSpecVersion,
  prNumberFromSubject,
  setReleaseBadge,
} from './changelog.mjs';

const CHANGELOG = 'CHANGELOG.md';
const README = 'README.md';
const RUNTIME = 'runtime/src/lib.rs';
const NODE_DIR = 'node/';

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const git = (...args) => run('git', args);
const gh = (...args) => run('gh', args);

const repoSlug = () =>
  process.env.GITHUB_REPOSITORY ??
  gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner');

const PR_QUERY = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      title
      labels(first: 20) { nodes { name } }
      closingIssuesReferences(first: 20) { nodes { number labels(first: 20) { nodes { name } } } }
    }
  }
}`;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// GitHub indexes a merge commit's PR shortly after the push, so an empty
// answer right away is retried before the commit is treated as a direct push.
// The endpoint also fails outright at times (a 500, or a 200 with an empty
// body); if it never answers, the PR number comes from the commit subject.
function mergedPrFor(slug, sha) {
  let answered = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const prs = JSON.parse(gh('api', `repos/${slug}/commits/${sha}/pulls`));
      answered = true;
      const pr = prs.find((p) => p.merged_at && p.base.ref === 'main');
      if (pr) return pr;
    } catch (err) {
      console.warn(`${sha.slice(0, 7)}: PR lookup failed (attempt ${attempt}): ${err.message}`);
    }
    if (attempt < 3) sleep(5000);
  }
  if (!answered) {
    const number = prNumberFromSubject(git('log', '-1', '--format=%s', sha));
    if (number) {
      console.warn(
        `::warning::${sha.slice(0, 7)}: PR lookup unavailable; #${number} taken from the subject`,
      );
      return { number };
    }
    throw new Error(`${sha.slice(0, 7)}: PR lookup unavailable and the subject names no PR`);
  }
  console.warn(`::warning::${sha.slice(0, 7)} has no merged PR; no changelog entry`);
  return null;
}

const lastTag = () => git('describe', '--tags', '--abbrev=0', '--match', 'v*');

function prDetails(slug, number) {
  const [owner, name] = slug.split('/');
  const data = JSON.parse(
    gh(
      'api',
      'graphql',
      '-f',
      `query=${PR_QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `n=${number}`,
    ),
  );
  const pr = data.data.repository.pullRequest;
  const issues = pr.closingIssuesReferences.nodes;
  return {
    title: pr.title,
    closes: issues.map((i) => i.number).sort((a, b) => a - b),
    labels: [...pr.labels.nodes, ...issues.flatMap((i) => i.labels.nodes)].map((l) => l.name),
  };
}

function entries(from, to) {
  const slug = repoSlug();
  const repo = `https://github.com/${slug}`;
  // The bot's own CHANGELOG.md commits have no PR; skip them rather than warn.
  const shas = git('log', '--first-parent', '--reverse', '--format=%H %ae', `${from}..${to}`)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' '))
    .filter(([, email]) => !email.includes('github-actions[bot]'))
    .map(([sha]) => sha);
  const seen = new Set();
  let changelog = readFileSync(CHANGELOG, 'utf8');
  for (const sha of shas) {
    const pr = mergedPrFor(slug, sha);
    if (!pr || seen.has(pr.number)) continue;
    seen.add(pr.number);
    const { title, closes, labels } = prDetails(slug, pr.number);
    const section = sectionFor(labels);
    if (!section) {
      console.log(`#${pr.number}: skip-changelog`);
      continue;
    }
    changelog = addEntry(changelog, section, entryLine({ repo, number: pr.number, title, closes }));
    console.log(`#${pr.number}: ${section}`);
  }
  writeFileSync(CHANGELOG, changelog);
}

function release(force) {
  const last = lastTag();
  const specAt = (ref) => parseSpecVersion(git('show', `${ref}:${RUNTIME}`));
  const specChanged = specAt(last) !== specAt('HEAD');
  const nodeChanged = git('diff', '--name-only', last, 'HEAD', '--', NODE_DIR) !== '';
  const version = nextVersion(last, { specChanged, nodeChanged, force });
  console.log(
    `last ${last}; spec changed: ${specChanged}; node changed: ${nodeChanged}; next: ${version ?? 'none'}`,
  );

  let notes = '';
  if (version) {
    const date = new Date().toISOString().slice(0, 10);
    const cut = cutRelease(readFileSync(CHANGELOG, 'utf8'), version, date);
    writeFileSync(CHANGELOG, cut.changelog);
    notes = cut.notes;
    const readme = setReleaseBadge(readFileSync(README, 'utf8'), version);
    if (readme === null) console.warn(`::warning::${README} has no release badge to update`);
    else writeFileSync(README, readme);
  }
  if (process.env.GITHUB_OUTPUT) {
    // The build runs in another job on another runner, so the notes travel as
    // a multi-line output rather than a file.
    const eof = `NOTES_${randomUUID()}`;
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `tag=${version ?? ''}\nnotes<<${eof}\n${notes}\n${eof}\n`,
    );
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === 'entries' && args.length <= 2) {
  entries(args[0] ?? lastTag(), args[1] ?? 'HEAD');
} else if (command === 'release' && args.length <= 1) {
  release(args[0] || undefined);
} else {
  console.error('usage: run.mjs entries [from] [to] | run.mjs release [minor|patch]');
  process.exit(2);
}
