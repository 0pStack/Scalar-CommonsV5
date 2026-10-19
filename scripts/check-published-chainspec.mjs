/**
 * Guards the chain spec published to testers at
 * https://scalarnet.io/docs/chainspec.json (source: docs/public/chainspec.json).
 *
 * A stranger's full node is only as good as this file. Two ways it can rot, and
 * both are silent:
 *
 *   1. The genesis state drifts from deploy/scalar-local-raw.json — the spec the
 *      operator actually runs. A tester would then sync a DIFFERENT chain, or
 *      fail to sync at all, with no error pointing here.
 *   2. bootNodes is emptied or malformed. The published spec is the only place a
 *      stranger can learn the peer addresses; without them there is no way in,
 *      because the p2p ports are useless without peer ids.
 *
 * This check is deterministic and offline on purpose: it compares two files in
 * the tree rather than dialling the live chain, so it cannot go red because a
 * validator was rebooting.
 *
 * It deliberately does NOT compare bootNodes between the two files — the
 * operator spec carries none, and adding them is exactly what makes the
 * published copy useful.
 */
import { readFileSync } from 'node:fs';

const PUBLISHED = 'docs/public/chainspec.json';
const OPERATOR = 'deploy/scalar-local-raw.json';
const EXPECTED_BOOTNODE_COUNT = 5;
const MULTIADDR = /^\/ip4\/\d+\.\d+\.\d+\.\d+\/tcp\/\d+\/p2p\/12D3KooW[1-9A-HJ-NP-Za-km-z]+$/;

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

const published = JSON.parse(readFileSync(PUBLISHED, 'utf8'));
const operator = JSON.parse(readFileSync(OPERATOR, 'utf8'));

// 1. Genesis must be byte-identical. This is the "same chain" assertion.
const a = JSON.stringify(published.genesis);
const b = JSON.stringify(operator.genesis);
if (a !== b) {
  fail(
    `genesis in ${PUBLISHED} differs from ${OPERATOR}.\n` +
      `  A tester syncing the published spec would join a different chain.\n` +
      `  Regenerate: copy ${OPERATOR} to ${PUBLISHED} and re-add bootNodes.`,
  );
} else {
  console.log(`✓ genesis matches ${OPERATOR} (${Object.keys(published.genesis.raw.top).length} raw top entries)`);
}

// 2. Identity fields must agree too — name/id/properties feed the node's UI and
//    the token decimals every balance in the guide depends on.
for (const key of ['name', 'id', 'chainType', 'properties']) {
  if (JSON.stringify(published[key]) !== JSON.stringify(operator[key])) {
    fail(`"${key}" differs between ${PUBLISHED} and ${OPERATOR}`);
  }
}

// 3. bootNodes must be present and well-formed, or the file is unusable.
const boot = published.bootNodes;
if (!Array.isArray(boot) || boot.length === 0) {
  fail(`${PUBLISHED} has no bootNodes — a stranger cannot join without them`);
} else {
  if (boot.length !== EXPECTED_BOOTNODE_COUNT) {
    fail(`expected ${EXPECTED_BOOTNODE_COUNT} bootNodes, found ${boot.length}`);
  }
  for (const addr of boot) {
    if (!MULTIADDR.test(addr)) fail(`malformed bootnode multiaddr: ${addr}`);
  }
  if (new Set(boot).size !== boot.length) fail('duplicate bootnode entries');
  if (process.exitCode !== 1) {
    console.log(`✓ ${boot.length} well-formed bootnode multiaddrs with real peer ids`);
  }
}

if (process.exitCode === 1) {
  console.error('\nSee docs/guide/testnet-tester-guide.md §6 for why this file matters.');
} else {
  console.log('✓ published chain spec is publishable');
}
