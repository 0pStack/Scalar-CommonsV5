/**
 * A-4 WASH-TRADER (protocol §5, tests C-1b vs completion+tx fees).
 *
 * Two colluding accounts self-escrow volume ≥ MinQualifyingVol each era to
 * fabricate floor qualification and farm the velocity bonus. The escrow self-link
 * guard (`orchestrator != sub_agent`) forbids buying from yourself, which is
 * exactly why this needs *two* accounts: A buys from B, B delivers, A confirms;
 * then the pair reverses. The prediction (P5): the incremental emissions from
 * qualification + velocity bonus are less than the AgreementCompletionFee plus
 * the burned tx fees per qualifying cycle, so the strategy is net-negative at
 * genesis parameters. The cost floors are the guard under test, not volume
 * detection.
 */
import { cmn, MIN_QUALIFYING_VOL, NOMINAL_BLOCKS_PER_ERA, PLANCKS_PER_CMN } from './constants.ts';
import { eraPrng, hash32, memberId } from './identity.ts';
import type { AgentSdk, Archetype, CohortContext, EraContext } from './types.ts';

/** Volume per leg (CMN). Two legs/era ⇒ ≥ MinQualifyingVol, triggering velocity. */
const LEG_CMN = 50;

export const A4_WashTrader: Archetype = {
  id: 'A-4',
  name: 'WASH-TRADER',

  async setup(sdk: AgentSdk, cohort: CohortContext): Promise<string[]> {
    const stake = cmn(cohort.params.stakeCmn ?? 200);
    // Exactly two colluding accounts, regardless of manifest `count`.
    const a = memberId('A-4', cohort.cohortIndex, 'wash', 0);
    const b = memberId('A-4', cohort.cohortIndex, 'wash', 1);
    for (const id of [a, b]) {
      await sdk.register(id, stake);
      await sdk.heartbeat(id);
    }
    return [a, b];
  },

  async perEra(ctx: EraContext, cohort: CohortContext): Promise<void> {
    const { sdk, era, settlement } = ctx;
    const rng = eraPrng(cohort.seed, era);
    const [a, b] = cohort.accounts;
    const deliverBy = BigInt(era + 2) * NOMINAL_BLOCKS_PER_ERA;

    await sdk.heartbeat(a);
    await sdk.heartbeat(b);

    // Two legs in opposite directions — the self-link guard forces the pair.
    const legs: Array<[string, string]> = [
      [a, b],
      [b, a],
    ];
    for (let l = 0; l < legs.length; l += 1) {
      const [buyer, provider] = legs[l];
      const amount =
        MIN_QUALIFYING_VOL + BigInt(rng.nextInt(3)) * PLANCKS_PER_CMN + cmn(LEG_CMN - 50);
      const deliverable = hash32(cohort.seed, 'wash-deliverable', era, l);
      const seq = await sdk.createEscrow(buyer, provider, amount, deliverable, deliverBy);
      const delivery = hash32(cohort.seed, 'wash-delivery', era, l);
      await sdk.acceptEscrow(provider, buyer, seq, delivery);
      await sdk.completeEscrow(buyer, provider, seq);
    }

    await sdk.claim(a);
    await sdk.claim(b);
    settlement.attempt(a, era);
    settlement.attempt(b, era);
  },
};
