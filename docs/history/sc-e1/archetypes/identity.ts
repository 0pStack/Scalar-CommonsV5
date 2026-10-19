/**
 * Deterministic account-id and hash helpers.
 *
 * Account ids are pure functions of `(archetype id, cohort index, role, member
 * index)` — no randomness — so the same manifest always yields the same
 * population, and the recorded signer stream is stable across replays. Ids are
 * plain labels here; the real SDK adapter maps each to a keypair. None of them
 * can ever be a privileged key (see `privileged.ts`).
 */
import { Prng, deriveSeed } from './prng.ts';
import type { Hash32 } from './types.ts';

/** A stable account id, e.g. `A-1:c0:worker3`. */
export function memberId(
  archId: string,
  cohortIndex: number,
  role: string,
  index: number,
): string {
  return `${archId}:c${cohortIndex}:${role}${index}`;
}

/** A fresh per-era generator, isolated so eras don't couple across replays. */
export function eraPrng(cohortSeed: bigint, era: number): Prng {
  return new Prng(deriveSeed(cohortSeed, 'era', era));
}

/** A deterministic 32-byte hash for the given purpose + coordinates. */
export function hash32(cohortSeed: bigint, ...labels: Array<string | number>): Hash32 {
  return new Prng(deriveSeed(cohortSeed, 'hash', ...labels)).nextHex(32);
}
