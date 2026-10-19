/**
 * A-3 SYBIL-FARM (protocol §5, tests C-1b vs burned fees).
 *
 * A single controller spins up `count` accounts (protocol default 1,000), each
 * posting the minimum stake, heart-beating, and trying to qualify for floor
 * emissions — while doing *no real escrow volume*. The point is to measure the
 * cumulative net position (emissions − burned BASE_TX_FEE) and show it goes
 * negative fast (prediction P4): every heartbeat and claim burns the flat tx
 * fee, and none of the accounts ever clears MinQualifyingVol, so the floor
 * emission never fires. The guard under test is the burned base fee, not any
 * per-account identity check.
 *
 * "Multiple agents from same controller": all sub-accounts derive from one
 * controller label, but each signs its own extrinsics. None is privileged.
 */
import { SYBIL_MIN_STAKE } from './constants.ts';
import { memberId } from './identity.ts';
import type { AgentSdk, Archetype, CohortContext, EraContext } from './types.ts';

/** How many sub-accounts attempt settlement each era (bounded to keep the
 *  recorded stream readable; settlement only needs one winner anyway). */
const SETTLERS_PER_ERA = 3;

export const A3_SybilFarm: Archetype = {
  id: 'A-3',
  name: 'SYBIL-FARM',

  async setup(sdk: AgentSdk, cohort: CohortContext): Promise<string[]> {
    const accounts: string[] = [];
    for (let i = 0; i < Math.max(1, cohort.count); i += 1) {
      // Same controller (`cohortIndex`), many sub-accounts (`sybil${i}`).
      const id = memberId('A-3', cohort.cohortIndex, 'sybil', i);
      accounts.push(id);
      await sdk.register(id, SYBIL_MIN_STAKE);
      await sdk.heartbeat(id);
    }
    return accounts;
  },

  async perEra(ctx: EraContext, cohort: CohortContext): Promise<void> {
    const { sdk, era, settlement } = ctx;
    for (let i = 0; i < cohort.accounts.length; i += 1) {
      const sub = cohort.accounts[i];
      // Heartbeat-only + a hopeful claim: no escrow volume ⇒ never qualifies,
      // yet each fee-bearing call still burns BASE_TX_FEE. That asymmetry is P4.
      await sdk.heartbeat(sub);
      await sdk.claim(sub);
      if (i < SETTLERS_PER_ERA) settlement.attempt(sub, era);
    }
  },
};
