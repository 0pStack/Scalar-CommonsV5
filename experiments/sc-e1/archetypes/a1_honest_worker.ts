/**
 * A-1 HONEST-WORKER (protocol §5, tests C-1a upside).
 *
 * Loop per era: heartbeat → accept/complete `n` *real* escrows with genuine
 * counterparties → honest oracle votes → governance votes → claim → attempt
 * permissionless settlement. This is the archetype the whole thesis is about:
 * an agent doing verifiable work should out-earn an equally capitalised passive
 * staker (prediction P1). Workers operate in pairs (buyer/provider round-robin)
 * so every escrow has a real, non-self counterparty — unlike the wash-trader
 * (A-4), whose "volume" cycles between two colluding accounts.
 *
 * Equal-endowment rule (§5): the manifest gives a worker a `stakeCmn` that,
 * summed with its working capital, equals the passive staker's stake, so any
 * earnings gap is attributable to *work*, not capital.
 */
import { cmn, NOMINAL_BLOCKS_PER_ERA, PLANCKS_PER_CMN } from './constants.ts';
import { eraPrng, hash32, memberId } from './identity.ts';
import type { AgentSdk, Archetype, CohortContext, EraContext } from './types.ts';

/** Per-escrow value in CMN; 2 escrows/era clears MinQualifyingVol (50 CMN). */
const ESCROW_CMN = 30;

export const A1_HonestWorker: Archetype = {
  id: 'A-1',
  name: 'HONEST-WORKER',

  async setup(sdk: AgentSdk, cohort: CohortContext): Promise<string[]> {
    const stake = cmn(cohort.params.stakeCmn ?? 5_000);
    const accounts: string[] = [];
    const size = Math.max(2, cohort.count); // pairs need ≥ 2 members
    for (let i = 0; i < size; i += 1) {
      const id = memberId('A-1', cohort.cohortIndex, 'worker', i);
      accounts.push(id);
      await sdk.register(id, stake);
      await sdk.heartbeat(id);
    }
    return accounts;
  },

  async perEra(ctx: EraContext, cohort: CohortContext): Promise<void> {
    const { sdk, era, settlement } = ctx;
    const rng = eraPrng(cohort.seed, era);
    const members = cohort.accounts;
    const n = Math.max(1, cohort.params.escrowsPerEra ?? 2);
    const stake = cmn(cohort.params.stakeCmn ?? 5_000);
    const pollIndex = cohort.params.pollIndex ?? 0;
    const capability = cohort.params.capability ?? 1;

    for (let i = 0; i < members.length; i += 1) {
      const buyer = members[i];
      const provider = members[(i + 1) % members.length];
      await sdk.heartbeat(buyer);

      // n real escrows: buyer opens, provider delivers, buyer confirms.
      for (let k = 0; k < n; k += 1) {
        const amount = cmn(ESCROW_CMN) + BigInt(rng.nextInt(5)) * PLANCKS_PER_CMN;
        const deliverBy = BigInt(era + 2) * NOMINAL_BLOCKS_PER_ERA;
        const deliverable = hash32(cohort.seed, 'deliverable', era, i, k);
        const seq = await sdk.createEscrow(buyer, provider, amount, deliverable, deliverBy);
        const delivery = hash32(cohort.seed, 'delivery', era, i, k);
        await sdk.acceptEscrow(provider, buyer, seq, delivery);
        await sdk.completeEscrow(buyer, provider, seq);
      }

      // Honest oracle answer + governance vote — both feed emission weight.
      const requestId = hash32(cohort.seed, 'oracle-req', era);
      const answer = hash32(cohort.seed, 'oracle-honest', era, i);
      await sdk.submitOracle(buyer, requestId, answer, capability);
      await sdk.vote(buyer, pollIndex, true, stake);
      await sdk.claim(buyer);

      // settle_era-with-backoff, from participant incentive alone (§5).
      settlement.attempt(buyer, era);
    }
  },
};
