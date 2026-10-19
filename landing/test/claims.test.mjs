// Honesty tests for the landing page.
//
// The page is marketing copy for a chain that runs real money, so the risk here
// is not a broken build — it is a true-sounding sentence the runtime does not
// back. These tests make that mechanical: every figure must come from metadata
// read off a live node, every pallet/extrinsic named must exist in that
// metadata, every descriptive claim must be grounded in a snippet that is still
// present in the repo, and a fixed list of unearned marketing claims must never
// appear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { content } from '../src/content.mjs';
import { sourceClaims } from '../src/source-claims.mjs';
import { renderPage, proseOf, placeholdersIn, resolve } from '../src/render.mjs';

const facts = JSON.parse(readFileSync(new URL('../chain-facts.json', import.meta.url), 'utf8'));
const repoRoot = new URL('../../', import.meta.url);
const html = renderPage({ facts, content, sourceClaims });

const readRepoFile = (relPath) => readFileSync(new URL(relPath, repoRoot), 'utf8');

test('chain-facts.json is stamped as live runtime metadata, not hand-authored', () => {
  const p = facts.provenance;
  assert.equal(p.source, 'live-runtime-metadata');
  assert.match(p.rpc, /^wss?:\/\//);
  assert.equal(p.specName, 'scalar-commons');
  assert.ok(Number.isInteger(p.specVersion) && p.specVersion > 0, 'specVersion must be an integer');
  assert.ok(p.metadataVersion >= 14, `metadata v${p.metadataVersion} is older than the v14 type registry`);
  assert.match(p.genesisHash, /^0x[0-9a-f]{64}$/);
  assert.match(p.readAtBlockHash, /^0x[0-9a-f]{64}$/);
  assert.ok(Number.isInteger(p.readAtBlock) && p.readAtBlock > 0);
  assert.equal(facts.token.symbol, 'CMN');
  assert.equal(facts.token.decimals, 12);
});

test('every placeholder in the page content resolves against chain-facts.json', () => {
  for (const [where, str] of proseOf(content)) {
    for (const token of placeholdersIn(str)) {
      const value = resolve(facts, token);
      assert.ok(
        value !== undefined && value !== null && String(value).length > 0,
        `${where}: placeholder {{${token}}} does not resolve against chain-facts.json`,
      );
    }
  }
});

test('no chain figure is hand-typed: prose carries digits only through placeholders', () => {
  for (const [where, str] of proseOf(content)) {
    const withoutPlaceholders = str.replace(/\{\{[^}]+\}\}/g, '');
    assert.ok(
      !/\d/.test(withoutPlaceholders),
      `${where}: literal digits in prose ("${withoutPlaceholders.match(/[^.]*\d[^.]*/)?.[0]?.trim()}") — ` +
        'every number must come from chain-facts.json via a {{placeholder}}',
    );
  }
});

test('every pallet and extrinsic named in the content exists in live metadata', () => {
  const refs = content.sections.flatMap((s) => (s.bullets ?? []).flatMap((b) => b.chainRefs ?? []));
  assert.ok(refs.length > 0, 'content must cite the pallets it describes');
  for (const ref of refs) {
    const [palletName, callName] = ref.split('.');
    const pallet = facts.pallets.find((p) => p.name === palletName);
    assert.ok(pallet, `content cites pallet "${palletName}" which is absent from live metadata`);
    if (callName) {
      assert.ok(
        pallet.calls.includes(callName),
        `content cites ${ref} but ${palletName} exposes only: ${pallet.calls.join(', ')}`,
      );
    }
  }
});

test('the page makes no claim the runtime does not implement', () => {
  // Each pattern is an affirmative claim this runtime cannot back. Sources:
  // no halving/decay logic exists (the per-era pool depends only on agent
  // count); there is no yield product, no sale, no audit, and no mainnet.
  const forbidden = [
    /halving/i,
    /\bAPY\b/i,
    /\bROI\b/i,
    /passive income/i,
    /guaranteed/i,
    /risk-free/i,
    /\baudited\b/i,
    /security audit/i,
    /presale|pre-sale|token sale|\bICO\b/i,
    /airdrop/i,
    /mainnet is live/i,
    /price/i,
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(html), `rendered page matches forbidden claim ${pattern}`);
  }
});

test('each descriptive claim is grounded in a snippet still present in the repo', () => {
  assert.ok(sourceClaims.length > 0);
  for (const claim of sourceClaims) {
    assert.ok(claim.claim && claim.file && claim.snippet, 'a source claim is missing claim/file/snippet');
    const source = readRepoFile(claim.file);
    assert.ok(
      source.includes(claim.snippet),
      `claim "${claim.claim}" cites ${claim.file} for \`${claim.snippet}\`, which is no longer there`,
    );
  }
});

test('the inert oracle-accuracy term is disclosed for as long as it stays unwired', () => {
  const runtime = readRepoFile('runtime/src/lib.rs');
  const unwired = runtime.includes('type OracleScoreProvider = ();');
  assert.ok(
    unwired,
    'OracleScoreProvider is now wired — update the oracle caveat in src/content.mjs instead of deleting this test',
  );
  assert.match(
    html,
    /data-caveat="oracle-score-provider"/,
    'the oracle-accuracy term contributes zero on this runtime and the page must say so',
  );
});

test('docs, explorer, faucet and repo are all linked, and unbuilt ones say so', () => {
  const keys = content.links.map((l) => l.key);
  for (const required of ['docs', 'explorer', 'faucet', 'repo']) {
    assert.ok(keys.includes(required), `issue #74 requires a ${required} link`);
  }
  for (const link of content.links) {
    assert.match(link.url, /^https:\/\//, `${link.key} must be an absolute https URL`);
    assert.ok(['available', 'planned'].includes(link.status), `${link.key} has an unknown status`);
    if (link.status === 'planned') {
      assert.match(
        link.url,
        /github\.com\/[^/]+\/[^/]+\/issues\/\d+$/,
        `${link.key} is not built yet, so it must link to its tracking issue`,
      );
      assert.match(
        html,
        new RegExp(`data-link="${link.key}"[^>]*data-status="planned"`),
        `${link.key} is unbuilt and must be labelled planned on the page`,
      );
    }
  }
});

test('the rendered document is complete and fully resolved', () => {
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<\/html>\s*$/);
  assert.ok(!html.includes('{{'), 'rendered page still contains an unresolved template token');
  assert.ok(!/TODO|FIXME|lorem ipsum/i.test(html), 'rendered page contains placeholder copy');
  assert.match(html, /coordination infrastructure/i);
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]+"/);
});

test('a component whose code is already in the repository is not still advertised as planned', () => {
  // The "Planned" badge is a promise that the thing does not exist yet. Once
  // the component lands, that badge is a lie the page keeps telling — and the
  // link keeps pointing at a closed tracking issue instead of the code. Each
  // entry below pins a link key to the file that proves the component shipped.
  const shipped = { faucet: 'faucet/package.json' };
  for (const [key, marker] of Object.entries(shipped)) {
    const link = content.links.find((l) => l.key === key);
    assert.ok(link, `content must link ${key}`);
    assert.ok(readRepoFile(marker).length > 0, `${marker} is missing — has ${key} been removed from the repo?`);
    assert.notEqual(link.status, 'planned', `${key} has shipped (${marker}) but the page still calls it planned`);
    assert.doesNotMatch(
      link.url,
      /\/issues\/\d+$/,
      `${key} has shipped, so the page must link the component itself, not its tracking issue`,
    );
  }
});

test('the committed chain snapshot comes from the long-running devnet, not the genesis window', () => {
  // chain-facts.json is what makes the page offline-reproducible, and it is
  // also the thing that silently rots: the first capture was taken a few
  // thousand blocks after genesis and stayed on the page long after the devnet
  // had run past it. This floor only ever moves up, and re-running
  // `npm run fetch:chain-facts` against the devnet clears it.
  const MIN_READ_AT_BLOCK = 400_000;
  assert.ok(
    facts.provenance.readAtBlock > MIN_READ_AT_BLOCK,
    `chain-facts.json was read at block ${facts.provenance.readAtBlock}, at or below the stale floor of ` +
      `${MIN_READ_AT_BLOCK} — re-run \`npm run fetch:chain-facts\` against the devnet`,
  );
});
