#!/usr/bin/env node
/**
 * Assert that every chain value quoted in the docs still matches the runtime.
 *
 * Wired into `npm run lint`, so a runtime change that is not reflected in the
 * prose fails the docs gate. It reads `.chain/snapshot.json` (captured from a
 * live node by `snapshot-chain.mjs`) rather than the node itself, so the gate
 * is deterministic and needs no network — the live-node verification happens
 * once, at snapshot time, and is auditable from the snapshot's provenance
 * block.
 *
 * Five checks:
 *
 *  1. CONSTANTS — in a table tagged `<!-- chain-check:constants -->`, any code
 *     span naming a real chain constant must be accompanied by a code span
 *     holding that constant's exact raw value. The name may sit anywhere in the
 *     row, so a cell like "Hard supply cap (`emissions.supplyCap`)" counts.
 *  2. REQUIRED COVERAGE — the constants the economic model turns on must each be
 *     documented in some checked row, so that deleting rows cannot quietly
 *     reduce coverage to nothing and still pass.
 *  3. INVARIANTS — cross-pallet relationships the prose asserts (the supply cap
 *     duplicated across three pallets, pallet-constitution's floors) are
 *     evaluated, not merely quoted.
 *  4. PALLET INDICES — tables tagged `<!-- chain-check:pallet-index -->` must
 *     give each pallet its real `construct_runtime` index. (Repo rule: indices
 *     are append-only, so a mismatch here is either doc rot or a hard bug.)
 *  5. PROSE FACTS AND SURFACE COVERAGE — a fixed list of snapshot-derived
 *     strings (spec version, chain name, token symbol, …) must appear literally
 *     on a given page; and every extrinsic of every custom pallet, plus every
 *     `ScalarCommonsApi` method, must be documented somewhere on the site.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const snapshot = JSON.parse(readFileSync(join(ROOT, '.chain', 'snapshot.json'), 'utf8'))

/** Pallets this repo owns; their whole extrinsic surface must be documented. */
const CUSTOM_PALLETS = [
  'agents',
  'escrow',
  'oracle',
  'emissions',
  'autoParams',
  'orchestrator',
  'constitution',
]

/**
 * Constants the token model turns on. Each must appear in a checked table row
 * somewhere on the site. Without this list, deleting rows would *raise* the
 * pass rate — a check that rewards saying less is worse than no check.
 */
const REQUIRED_CONSTANTS = [
  'emissions.supplyCap',
  'emissions.eraDuration',
  'emissions.targetEmissionPerAgent',
  'emissions.floorEmissionPerEra',
  'emissions.initialEmissionsPerEra',
  'emissions.oracleBonusBps',
  'emissions.velocityBonusBps',
  'emissions.minQualifyingVol',
  'emissions.unitVolume',
  'emissions.maxProposalsPerEra',
  'agents.minStake',
  'agents.fullFloorStake',
  'agents.maxStakePerAgent',
  'agents.baseRegistrationFee',
  'agents.unstakeCooldown',
  'agents.heartbeatGracePeriod',
  'agents.heartbeatDecayPeriod',
  'autoParams.initialAlpha',
  'autoParams.initialBeta',
  'autoParams.initialFloorBps',
  'autoParams.initialCompletionFeeBps',
  'constitution.supplyCap',
]

/**
 * Cross-pallet invariants the docs assert in prose, checked here so the prose
 * cannot claim a relationship the runtime has stopped honouring.
 *
 * `pallet-constitution` exists to floor parameters that other pallets set, and
 * the supply cap is duplicated across three pallets. Both are only meaningful
 * if the copies actually agree, so compare them rather than describing them.
 */
const INVARIANTS = [
  ['emissions.supplyCap', '==', 'constitution.supplyCap'],
  ['orchestrator.supplyCap', '==', 'constitution.supplyCap'],
  ['agents.unstakeCooldown', '>=', 'constitution.minUnstakeCooldown'],
  ['oracle.minChallengeWindow', '>=', 'constitution.minChallengeWindow'],
  ['agents.baseRegistrationFee', '>=', 'constitution.minRegistrationBurn'],
]

/** Snapshot-derived strings that must appear verbatim on a specific page. */
const PROSE_FACTS = [
  ['reference/token-model.md', 'spec version', `spec ${snapshot.runtime.specVersion}`],
  ['reference/token-model.md', 'token symbol', snapshot.properties.tokenSymbol],
  ['reference/rpc.md', 'spec version', `spec ${snapshot.runtime.specVersion}`],
  ['reference/rpc.md', 'metadata version', `v${snapshot.runtime.metadataVersion}`],
  ['reference/rpc.md', 'RPC method count', `${snapshot.rpcMethods.length}`],
  ['guide/run-a-node.md', 'chain name', snapshot.chain.name],
  ['guide/run-a-node.md', 'ss58 format', `${snapshot.properties.ss58Format}`],
  ['guide/sdk.md', 'token decimals', `10^${snapshot.properties.tokenDecimals}`],
]

/** Every markdown page under `dir`, as a ROOT-relative slash-separated path. */
function pagesUnder(dir) {
  const found = []
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = posix.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...pagesUnder(rel))
    else if (entry.name.endsWith('.md')) found.push(rel)
  }
  return found
}

const PAGES = ['index.md', ...pagesUnder('guide'), ...pagesUnder('reference')].sort()

const errors = []
const stats = { consts: 0, indices: 0, prose: 0, extrinsics: 0, apiMethods: 0, invariants: 0 }
/** `pallet.constant` names that were checked against their raw value. */
const covered = new Set()

/** All code spans in a line, in order. */
const codeSpans = (line) => [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1])

/** Split a markdown table row into trimmed cells. */
const cells = (line) =>
  line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())

const isTableRow = (line) => /^\s*\|/.test(line)
const isSeparatorRow = (line) => /^\s*\|[\s:|-]+\|?\s*$/.test(line)

const sourceText = new Map()
for (const page of PAGES) {
  sourceText.set(page, readFileSync(join(ROOT, page), 'utf8'))
}

// ── 1 & 2: table-driven checks ───────────────────────────────────────────────
//
// A `<!-- chain-check:<mode> -->` comment arms the table that follows it. Only
// armed tables are checked, because naming a constant is not the same as
// quoting its value: the SDK guide says "bounded by `agents.maxUriLen`" to tell
// you a limit exists, and demanding a raw value there would bury the prose in
// planck integers. Reference tables that do state values opt in explicitly.
for (const [page, text] of sourceText) {
  const lines = text.split('\n')
  let mode = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const directive = /<!--\s*chain-check:(pallet-index|constants)\s*-->/.exec(line)
    if (directive) {
      mode = directive[1]
      continue
    }
    if (!isTableRow(line)) {
      // A directive applies to the next table only; blank lines between the
      // comment and the table are fine, prose in between disarms it.
      if (line.trim() !== '' && !line.trim().startsWith('<!--')) mode = null
      continue
    }
    if (mode === null || isSeparatorRow(line)) continue

    const row = cells(line)
    const spans = codeSpans(line)
    const first = row[0].replace(/^`|`$/g, '')
    const where = `${page}:${i + 1}`

    // (2) pallet index rows: `| `Emissions` | 29 | … |`
    if (mode === 'pallet-index') {
      const idx = snapshot.pallets[first]
      if (idx === undefined) {
        // Header row ("Pallet | Index | …") or a pallet not in the runtime.
        if (/^`.+`$/.test(row[0])) {
          errors.push(`${where}: \`${first}\` is not a pallet in the runtime`)
        }
        continue
      }
      const claimed = row[1]
      if (claimed !== String(idx)) {
        errors.push(
          `${where}: pallet \`${first}\` documented at index ${claimed || '(missing)'}, runtime says ${idx}`,
        )
      } else {
        stats.indices++
      }
      continue
    }

    // (1) constant rows in a `chain-check:constants` table. Any code span
    // naming a real chain constant must be accompanied by that constant's raw
    // value. Matching anywhere in the row, not just cell 1, is deliberate —
    // "Hard supply cap (`emissions.supplyCap`)" is a row a reader trusts, so it
    // is a row the gate has to cover.
    for (const span of spans) {
      const dotted = /^([A-Za-z][A-Za-z0-9]*)\.([a-z][A-Za-z0-9]*)$/.exec(span)
      if (!dotted) continue
      const [, pallet, name] = dotted
      const raw = snapshot.consts[pallet]?.[name]
      if (raw === undefined) continue

      if (!spans.includes(raw)) {
        errors.push(
          `${where}: \`${pallet}.${name}\` — no code span holding the on-chain raw value \`${raw}\`` +
            ` (row has: ${spans.map((s) => `\`${s}\``).join(', ')})`,
        )
      } else {
        stats.consts++
        covered.add(`${pallet}.${name}`)
      }
    }
  }
}

// ── 1b: required coverage ────────────────────────────────────────────────────
for (const required of REQUIRED_CONSTANTS) {
  const [pallet, name] = required.split('.')
  if (snapshot.consts[pallet]?.[name] === undefined) {
    errors.push(`snapshot: required constant \`${required}\` no longer exists on chain`)
  } else if (!covered.has(required)) {
    errors.push(`\`${required}\` is not documented with its raw value in any table row`)
  }
}

// ── 1c: cross-pallet invariants ──────────────────────────────────────────────
const constValue = (dotted) => {
  const [pallet, name] = dotted.split('.')
  return snapshot.consts[pallet]?.[name]
}

for (const [left, op, right] of INVARIANTS) {
  const l = constValue(left)
  const r = constValue(right)
  if (l === undefined || r === undefined) {
    errors.push(
      `snapshot: invariant \`${left} ${op} ${right}\` references a constant that no longer exists`,
    )
    continue
  }
  const holds = op === '==' ? BigInt(l) === BigInt(r) : BigInt(l) >= BigInt(r)
  if (!holds) {
    errors.push(`runtime invariant violated: ${left} (${l}) ${op} ${right} (${r}) is false`)
  } else {
    stats.invariants++
  }
}

// ── 3: prose facts ───────────────────────────────────────────────────────────
for (const [page, label, value] of PROSE_FACTS) {
  const text = sourceText.get(page)
  if (text === undefined) {
    errors.push(`${page}: page is missing but is required to document the ${label}`)
    continue
  }
  if (!text.includes(value)) {
    errors.push(`${page}: does not mention the live ${label} ("${value}")`)
  } else {
    stats.prose++
  }
}

// ── 4: surface coverage ──────────────────────────────────────────────────────
const allText = [...sourceText.values()].join('\n')

for (const pallet of CUSTOM_PALLETS) {
  // `api.tx` / `api.query` omit pallets with no dispatchables / no storage,
  // which is legitimate — pallet-constitution is invariant checks and hooks
  // only. So confirm the pallet is in the runtime via its index, then document
  // whatever call surface it does expose.
  const declared = pallet[0].toUpperCase() + pallet.slice(1)
  if (snapshot.pallets[declared] === undefined) {
    errors.push(`snapshot: custom pallet \`${declared}\` is not in the runtime`)
    continue
  }
  const calls = snapshot.extrinsics[pallet] ?? {}
  for (const call of Object.keys(calls)) {
    if (allText.includes(`${pallet}.${call}`)) stats.extrinsics++
    else errors.push(`undocumented extrinsic: \`${pallet}.${call}\` appears on no page`)
  }
}

const scalarApi = snapshot.runtimeApis.ScalarCommonsApi ?? []
if (scalarApi.length === 0) errors.push('snapshot: ScalarCommonsApi has no methods recorded')
for (const signature of scalarApi) {
  const method = signature.slice(0, signature.indexOf('('))
  if (allText.includes(`ScalarCommonsApi_${method}`)) stats.apiMethods++
  else errors.push(`undocumented runtime API method: \`ScalarCommonsApi_${method}\``)
}

// ── report ───────────────────────────────────────────────────────────────────
const provenance =
  `${snapshot.chain.name} — ${snapshot.runtime.specName} spec ${snapshot.runtime.specVersion}` +
  ` @ #${snapshot.provenance.capturedAtBlock}`

if (errors.length > 0) {
  console.error(`✗ docs disagree with the runtime snapshot (${provenance})\n`)
  for (const e of errors) console.error(`  ${e}`)
  console.error(
    `\n  ${errors.length} problem(s). If the runtime changed, re-run` +
      ' `npm run snapshot:chain` against a live node and update the prose.',
  )
  process.exit(1)
}

const totalConsts = Object.values(snapshot.consts).reduce((n, c) => n + Object.keys(c).length, 0)

console.log(`✓ docs match the runtime snapshot (${provenance})`)
console.log(
  `  ${stats.consts} constant reference(s) covering ${covered.size}/${totalConsts} chain constants` +
    ` (all ${REQUIRED_CONSTANTS.length} required ones present),`,
)
console.log(
  `  ${stats.indices} pallet indices, ${stats.invariants} cross-pallet invariants,` +
    ` ${stats.prose} prose facts, ${stats.extrinsics} extrinsics,` +
    ` ${stats.apiMethods} runtime API methods checked across ${PAGES.length} pages`,
)
