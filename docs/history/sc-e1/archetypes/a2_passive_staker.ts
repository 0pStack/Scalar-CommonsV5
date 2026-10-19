/**
 * A-2 PASSIVE-STAKER (protocol §5, tests C-1a baseline).
 *
 * Loop per era: heartbeat → claim → attempt permissionless settlement. That's
 * it — no escrow, no oracle, no governance work. The passive staker is the
 * control against which the honest worker's earnings are measured (prediction
 * P1: equal-endowment worker/staker ratio ≥ 2.0). Per the equal-endowment rule
 * (§5) it stakes its *entire* endowment, up to MaxStake, so any earnings gap
 * versus A-1 is attributable to work rather than capital.
 *
 * It still calls `settle_era`-with-backoff every era: liveness must not depend
 * on the workers being present (§3 P0 gate; CLAUDE.md first-principle #3).
 */
import { cmn, MAX_STAKE } from './constants.ts';
import { memberId } from './identity.ts';
import type { AgentSdk, Archetype, CohortContext, EraContext } from './types.ts';

export const A2_PassiveStaker: Archetype = {
  id: 'A-2',
  name: 'PASSIVE-STAKER',

  async setup(sdk: AgentSdk, cohort: CohortContext): Promise<string[]> {
    let stake = cmn(cohort.params.stakeCmn ?? 10_000);
    if (stake > MAX_STAKE) stake = MAX_STAKE; // MaxStake ceiling (§4)
    const accounts: string[] = [];
    for (let i = 0; i < Math.max(1, cohort.count); i += 1) {
      const id = memberId('A-2', cohort.cohortIndex, 'staker', i);
      accounts.push(id);
      await sdk.register(id, stake);
      await sdk.heartbeat(id);
    }
    return accounts;
  },

  async perEra(ctx: EraContext, cohort: CohortContext): Promise<void> {
    const { sdk, era, settlement } = ctx;
    for (const staker of cohort.accounts) {
      await sdk.heartbeat(staker);
      await sdk.claim(staker);
      settlement.attempt(staker, era);
    }
  },
};
