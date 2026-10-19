// The descriptive (non-numeric) claims the page makes, each pinned to the line
// of runtime source that backs it.
//
// Numbers on the page are covered by chain-facts.json: they come out of live
// metadata and `npm run verify:chain` re-checks them. Sentences like "stake
// counts sub-linearly" have no metadata equivalent, so they are pinned here
// instead: the test suite asserts every `snippet` below is still present in its
// `file`. If someone changes the mechanism, the claim on the page breaks the
// build instead of quietly becoming a lie.
export const sourceClaims = [
  {
    claim: 'Reward weight starts from the square root of stake, not stake itself.',
    file: 'pallets/emissions/src/lib.rs',
    snippet: 'let sqrt_stake = integer_sqrt(stake_u128);',
  },
  {
    claim: 'Escrow volume enters the weight on a logarithmic scale.',
    file: 'pallets/emissions/src/lib.rs',
    snippet: 'let raw_vol = log2_scaled(vol_u128, unit_u128);',
  },
  {
    claim: 'Volume is multiplied by a buyer-diversity score, so one repeat counterparty is worth less.',
    file: 'pallets/emissions/src/lib.rs',
    snippet: 'let diversity_bps = diversity_score_bps(unique_buyers);',
  },
  {
    claim: 'A missing heartbeat decays an agent’s weight.',
    file: 'pallets/emissions/src/lib.rs',
    snippet: 'agents_pallet::Pallet::<T>::heartbeat_multiplier(who)',
  },
  {
    claim: 'Governance participation adds weight only for an agent that did work in the era.',
    file: 'pallets/emissions/src/lib.rs',
    snippet: 'let gov_contribution = if work_score > 0 {',
  },
  {
    claim: 'An era cannot mint more than alpha times the qualifying escrow volume it settled.',
    file: 'pallets/emissions/src/lib.rs',
    snippet: 'let alpha_bps = T::AutoParams::emission_volume_alpha_bps() as u128;',
  },
  {
    claim: 'Volume from a ring-flagged provider does not count toward what an era may mint.',
    file: 'pallets/agents/src/lib.rs',
    snippet: 'if is_established && EraUniqueBuyers::<T>::get(agent) <= 1 {',
  },
  {
    claim: 'Escrow between two accounts that traded in both directions in one era does not qualify.',
    file: 'pallets/agents/src/lib.rs',
    snippet: 'if rev_era == this_era && rev_vol > Zero::zero() {',
  },
  {
    claim: 'Volume that can size an era’s emission is capped by the provider’s own locked stake.',
    file: 'pallets/agents/src/lib.rs',
    snippet: 'total.min(stake_ceiling)',
  },
  {
    claim: 'Registering as an agent starts the heartbeat clock.',
    file: 'pallets/agents/src/lib.rs',
    snippet: 'LastHeartbeat::<T>::insert(&who, now);',
  },
  {
    claim: 'The minimum qualifying volume gates the activity floor.',
    file: 'pallets/emissions/src/lib.rs',
    snippet: 'let qualifies_for_floor = is_active && (min_qual == 0 || vol_u128 >= min_qual);',
  },
  {
    claim: 'A reward claim mints at most the headroom left under the supply cap, then reports the cap is reached.',
    file: 'pallets/emissions/src/lib.rs',
    snippet: 'let mintable = supply_cap.saturating_sub(total_issued).min(pending_u128);',
  },
  {
    claim: 'Era settlement accepts any signed origin — no privileged caller gates it.',
    file: 'pallets/emissions/src/lib.rs',
    snippet: 'pub fn settle_era(origin: OriginFor<T>) -> DispatchResult {',
  },
  {
    claim: 'An orchestrator cannot link itself as its own sub-agent.',
    file: 'pallets/orchestrator/src/lib.rs',
    snippet: 'ensure!(orchestrator != sub_agent, Error::<T>::SelfLink);',
  },
  {
    claim: 'The devnet faucet only moves funds that already exist — it transfers, and has no mint path.',
    file: 'faucet/src/chain.ts',
    snippet: 'transferKeepAlive(dest, amountPlancks)',
  },
  {
    claim: 'The oracle-accuracy term exists in the formula, but this runtime wires no score provider into it.',
    file: 'runtime/src/lib.rs',
    snippet: 'type OracleScoreProvider = ();',
  },
];
