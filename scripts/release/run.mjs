#!/usr/bin/env node
// CLI for the changelog-release workflow. Logic lives in changelog.mjs; this
// file only reads git and GitHub and writes CHANGELOG.md.
//
//   node scripts/release/run.mjs entries <from> <to>   add an entry per PR merged in from..to
//   node scripts/release/run.mjs release [minor|patch] cut a release if one is due (or forced)
//
// `release` writes `tag` and `notes` to $GITHUB_OUTPUT; `tag` is empty when
// no release is due.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { sectionFor, entryLine, addEntry, nextVersion, cutRelease, parseSpecVersion } from './changelog.mjs';

const CHANGELOG = 'CHANGELOG.md';
const RUNTIME = 'runtime/src/lib.rs';
const NODE_DIR = 'node/';

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const git = (...args) => run('git', args);
const gh = (...args) => run('gh', args);

const repoSlug = () => process.env.GITHUB_REPOSITORY ?? gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner');

const PR_QUERY = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      title
      labels(first: 20) { nodes { name } }
      closingIssuesReferences(first: 20) { nodes { number labels(first: 20) { nodes { name } } } }
    }
  }
}`;

function mergedPrFor(slug, sha) {
  const prs = JSON.parse(gh('api', `repos/${slug}/commits/${sha}/pulls`));
  return prs.find((pr) => pr.merged_at && pr.base.ref === 'main') ?? null;
}

function prDetails(slug, number) {
  const [owner, name] = slug.split('/');
  const data = JSON.parse(
    gh('api', 'graphql', '-f', `query=${PR_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `n=${number}`),
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
  const shas = git('rev-list', '--first-parent', '--reverse', `${from}..${to}`).split('\n').filter(Boolean);
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
  const lastTag = git('describe', '--tags', '--abbrev=0', '--match', 'v*');
  const specAt = (ref) => parseSpecVersion(git('show', `${ref}:${RUNTIME}`));
  const specChanged = specAt(lastTag) !== specAt('HEAD');
  const nodeChanged = git('diff', '--name-only', lastTag, 'HEAD', '--', NODE_DIR) !== '';
  const version = nextVersion(lastTag, { specChanged, nodeChanged, force });
  console.log(`last ${lastTag}; spec changed: ${specChanged}; node changed: ${nodeChanged}; next: ${version ?? 'none'}`);

  let notes = '';
  if (version) {
    const date = new Date().toISOString().slice(0, 10);
    const cut = cutRelease(readFileSync(CHANGELOG, 'utf8'), version, date);
    writeFileSync(CHANGELOG, cut.changelog);
    notes = cut.notes;
  }
  if (process.env.GITHUB_OUTPUT) {
    // The build runs in another job on another runner, so the notes travel as
    // a multi-line output rather than a file.
    const eof = `NOTES_${randomUUID()}`;
    appendFileSync(process.env.GITHUB_OUTPUT, `tag=${version ?? ''}\nnotes<<${eof}\n${notes}\n${eof}\n`);
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === 'entries' && args.length === 2) {
  entries(args[0], args[1]);
} else if (command === 'release' && args.length <= 1) {
  release(args[0] || undefined);
} else {
  console.error('usage: run.mjs entries <from> <to> | run.mjs release [minor|patch]');
  process.exit(2);
}
