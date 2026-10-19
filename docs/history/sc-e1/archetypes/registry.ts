/**
 * Archetype registry — maps protocol ids to their runnable implementations.
 *
 * The manifest references archetypes by id (`"A-1"` … `"A-5"`); this is where
 * those ids resolve to code. Adding a sixth archetype means adding it here and
 * nowhere else.
 */
import { A1_HonestWorker } from './a1_honest_worker.ts';
import { A2_PassiveStaker } from './a2_passive_staker.ts';
import { A3_SybilFarm } from './a3_sybil_farm.ts';
import { A4_WashTrader } from './a4_wash_trader.ts';
import { A5_OracleColluder } from './a5_oracle_colluder.ts';
import type { Archetype } from './types.ts';

export const ARCHETYPES: Readonly<Record<string, Archetype>> = {
  'A-1': A1_HonestWorker,
  'A-2': A2_PassiveStaker,
  'A-3': A3_SybilFarm,
  'A-4': A4_WashTrader,
  'A-5': A5_OracleColluder,
};

/** Resolve an archetype id or throw a clear error naming the unknown id. */
export function getArchetype(id: string): Archetype {
  const arch = ARCHETYPES[id];
  if (!arch) {
    throw new Error(`unknown archetype id "${id}"; known: ${Object.keys(ARCHETYPES).join(', ')}`);
  }
  return arch;
}
