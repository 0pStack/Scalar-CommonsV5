/**
 * A-5 ORACLE-COLLUDER (protocol §5, tests C-1b oracle surface).
 *
 * A cohort of `k` accounts coordinates identical oracle answers to farm the
 * accuracy bonus. The collusion signal is that every member submits the *same*
 * answer hash for the same request each era (derived once from the cohort seed,
 * not per-member) — a coordinated bloc rather than independent honest reporters.
 * Prediction P6: at k ≤ 20% of the oracle set the earnings uplift versus the
 * honest baseline is ≤ 5%, because the accuracy bonus is bounded and the cohort
 * still pays fees. The oracle scoring guard is the surface under test.
 *
 * Colluders register and heartbeat (they must be live oracles) but do no real
 * escrow work — their only lever is the coordinated oracle answer.
 */
import { cmn } from './constants.ts';
import { eraPrng, hash32, memberId } from './identity.ts';
import type { AgentSdk, Archetype, CohortContext, EraContext } from './types.ts';

/** How many colluders attempt settlement each era (only one wins anyway). */
const SETTLERS_PER_ERA = 3;

export const A5_OracleColluder: Archetype = {
  id: 'A-5',
  name: 'ORACLE-COLLUDER',

  async setup(sdk: AgentSdk, cohort: CohortContext): Promise<string[]> {
    const stake = cmn(cohort.params.stakeCmn ?? 100);
    const accounts: string[] = [];
    for (let i = 0; i < Math.max(1, cohort.count); i += 1) {
      const id = memberId('A-5', cohort.cohortIndex, 'colluder', i);
      accounts.push(id);
      await sdk.register(id, stake);
      await sdk.heartbeat(id);
    }
    return accounts;
  },

  async perEra(ctx: EraContext, cohort: CohortContext): Promise<void> {
    const { sdk, era, settlement } = ctx;
    void eraPrng(cohort.seed, era); // reserved for future jitter; keeps seed lineage
    const capability = cohort.params.capability ?? 1;

    // The coordinated answer: identical across the whole cohort — that IS the
    // collusion. Derived from the cohort seed, so all members agree without
    // per-member variation.
    const requestId = hash32(cohort.seed, 'oracle-req', era);
    const collusiveAnswer = hash32(cohort.seed, 'oracle-collusive', era);

    for (let i = 0; i < cohort.accounts.length; i += 1) {
      const colluder = cohort.accounts[i];
      await sdk.heartbeat(colluder);
      await sdk.submitOracle(colluder, requestId, collusiveAnswer, capability);
      await sdk.claim(colluder);
      if (i < SETTLERS_PER_ERA) settlement.attempt(colluder, era);
    }
  },
};
