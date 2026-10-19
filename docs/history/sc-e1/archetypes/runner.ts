/**
 * Manifest runner + replay tooling for the SC-E1 archetypes.
 *
 * The acceptance criterion: "replaying a manifest reproduces identical extrinsic
 * sequences per seed." {@link runOne} executes one `(run, seed)` against the
 * deterministic {@link RecordingSdk} and returns the ordered extrinsic ledger
 * plus a compact digest. Because every stochastic choice descends from the
 * manifest seed via {@link deriveSeed}, two runs of the same `(run, seed)` yield
 * byte-identical ledgers and equal digests — that equality is what the replay
 * test asserts.
 *
 * Run directly (`node --experimental-strip-types runner.ts`) to print the digest
 * of every `(run, seed)` in `manifest.json`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { deriveSeed } from './prng.ts';
import { RecordingSdk } from './recording-sdk.ts';
import { getArchetype } from './registry.ts';
import { Settlement, type SettlementOutcome } from './settlement.ts';
import type { CohortContext, ExtrinsicRecord } from './types.ts';

/** One archetype cohort in a run. */
export interface CohortSpec {
  archetype: string;
  count: number;
  params?: Record<string, number>;
}

/** A single reproducible run configuration. */
export interface RunSpec {
  id: string;
  seeds: number[];
  eras: number;
  settlement?: { maxBackoff: number };
  cohorts: CohortSpec[];
}

/** The manifest: a set of runs, each replayable per seed. */
export interface Manifest {
  version: number;
  description?: string;
  runs: RunSpec[];
}

/** The full result of executing one `(run, seed)`. */
export interface RunResult {
  runId: string;
  seed: number;
  eras: number;
  records: ExtrinsicRecord[];
  settlements: SettlementOutcome[];
  digest: string;
}

const DEFAULT_MAX_BACKOFF = 8;

/** Execute one run at one seed. Pure function of `(run, seed)` — no ambient state. */
export async function runOne(run: RunSpec, seed: number): Promise<RunResult> {
  const sdk = new RecordingSdk();
  const settlement = new Settlement(
    sdk,
    deriveSeed(seed, 'settlement', run.id),
    run.settlement?.maxBackoff ?? DEFAULT_MAX_BACKOFF,
  );

  // Build cohorts with per-cohort derived seeds.
  const cohorts: CohortContext[] = run.cohorts.map((spec, cohortIndex) => ({
    seed: deriveSeed(seed, run.id, spec.archetype, cohortIndex),
    cohortIndex,
    count: spec.count,
    params: spec.params ?? {},
    accounts: [],
  }));

  // Setup phase (registration + initial stake), labelled era 0.
  sdk.setEra(0);
  for (let c = 0; c < cohorts.length; c += 1) {
    const arch = getArchetype(run.cohorts[c].archetype);
    cohorts[c].accounts = await arch.setup(sdk, cohorts[c]);
  }

  // Working eras 1..eras: per-era behaviour then permissionless settlement.
  const settlements: SettlementOutcome[] = [];
  for (let era = 1; era <= run.eras; era += 1) {
    sdk.setEra(era);
    for (let c = 0; c < cohorts.length; c += 1) {
      const arch = getArchetype(run.cohorts[c].archetype);
      await arch.perEra({ sdk, era, settlement }, cohorts[c]);
    }
    const outcome = await settlement.flush(era);
    if (outcome) settlements.push(outcome);
  }

  return {
    runId: run.id,
    seed,
    eras: run.eras,
    records: sdk.ledger,
    settlements,
    digest: digestSequence(sdk.ledger),
  };
}

/** Execute every `(run, seed)` in a manifest. */
export async function runManifest(manifest: Manifest): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const run of manifest.runs) {
    for (const seed of run.seeds) {
      results.push(await runOne(run, seed));
    }
  }
  return results;
}

/** Canonical, stable serialisation of an extrinsic ledger. */
export function serializeSequence(records: ExtrinsicRecord[]): string {
  return records
    .map((r) => `${r.seq}|${r.era}|${r.signer}|${r.method}|${JSON.stringify(r.args)}`)
    .join('\n');
}

/** A compact 64-bit FNV-1a digest (hex) of an extrinsic ledger. */
export function digestSequence(records: ExtrinsicRecord[]): string {
  const s = serializeSequence(records);
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h ^ BigInt(s.charCodeAt(i))) * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

/** Load and parse a manifest JSON file. */
export function loadManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

/** Path to the bundled `manifest.json`, resolved relative to this module. */
export function defaultManifestPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), 'manifest.json');
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('runner.ts');

if (invokedDirectly) {
  const manifest = loadManifest(defaultManifestPath());
  const results = await runManifest(manifest);
  // eslint-disable-next-line no-console
  console.log(`SC-E1 archetype manifest — ${manifest.runs.length} runs\n`);
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${r.runId.padEnd(6)} seed=${String(r.seed).padStart(3)}  ` +
        `extrinsics=${String(r.records.length).padStart(6)}  ` +
        `settlements=${String(r.settlements.length).padStart(3)}  digest=${r.digest}`,
    );
  }
}
