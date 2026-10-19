/**
 * The five ENDGOAL §3.4 attacker archetypes, plus the honest baseline they are
 * measured against.
 *
 * Every archetype is a real strategy submitting real extrinsics. The point of
 * the exercise is that the chain gets to refuse them: a strategy the runtime
 * blocks produces a different — and more useful — number than one it merely
 * makes unprofitable, and the report distinguishes the two.
 */

import { cmnToPlancks } from '../units.mjs';
import { registerAgent, escrowRoundTrip, short } from '../ops.mjs';
import { submit, hash32 } from '../chain.mjs';
import { recordExtrinsic, recordFailure, note } from '../ledger.mjs';

const CMN = (n) => cmnToPlancks(n);

/**
 * Stake used by every archetype that registers, so the comparison is not
 * confounded by stake size. MinStake is 1 000 CMN; the weight formula uses
 * sqrt(stake), so a bigger stake buys sub-linear weight and the archetypes are
 * distinguished by what they DO, which is the question being asked.
 */
export const STANDARD_STAKE = CMN(1000);

/** Registration costs MinStake + BaseRegistrationFee; fund headroom above it. */
export const PER_AGENT_FUNDING = CMN(3000);

/**
 * HONEST WORKER — the baseline every attacker number is relative to.
 *
 * Real escrow work with DISTINCT buyers. Buyer diversity is the multiplier that
 * separates this from a ring: `diversity_score_bps(unique_buyers)` scales the
 * work score, and a ring of colluders keeps re-presenting the same few buyers.
 */
export const honest = {
  key: 'honest',
  title: 'Honest worker',
  accounts: 4, // 1 provider + 3 distinct buyers
  async run(ctx) {
    const [provider, ...buyers] = ctx.accounts;
    await registerAgent(ctx.api, ctx.ledger, provider, STANDARD_STAKE, ctx.log);
    note(ctx.ledger, `1 provider, ${buyers.length} distinct buyers`);
    for (let i = 0; i < buyers.length; i++) {
      await escrowRoundTrip(ctx.api, ctx.ledger, buyers[i], provider, CMN(60), `honest-${i}`, ctx.log);
    }
  },
};

/**
 * WASH TRADER — two accounts trading with each other to manufacture volume.
 *
 * Both register, then buy from each other in alternating directions. Volume
 * accrues to whichever side is the provider, so alternating farms both. The
 * costs are real and unavoidable: two registrations, the escrow completion fee
 * on every settlement (CompletionFeeBps, which auto-params RAISED from 25 to 50
 * the first time ring farming was detected), and a transaction fee per
 * extrinsic. The question is whether era emissions exceed that.
 */
export const wash = {
  key: 'wash',
  title: 'Wash trader',
  accounts: 2,
  async run(ctx) {
    const [a, b] = ctx.accounts;
    await registerAgent(ctx.api, ctx.ledger, a, STANDARD_STAKE, ctx.log);
    await registerAgent(ctx.api, ctx.ledger, b, STANDARD_STAKE, ctx.log);
    note(ctx.ledger, '2 accounts, alternating buyer/provider — 1 unique buyer each');
    // Volume per side must clear MinQualifyingVol (50 CMN) to earn the floor
    // share at all; below it the strategy earns only the work-score sliver.
    const size = CMN(60);
    for (let i = 0; i < ctx.rounds; i++) {
      await escrowRoundTrip(ctx.api, ctx.ledger, a, b, size, `wash-ab-${i}`, ctx.log);
      await escrowRoundTrip(ctx.api, ctx.ledger, b, a, size, `wash-ba-${i}`, ctx.log);
    }
  },
};

/**
 * SYBIL FARM — many cheap identities in a ring.
 *
 * Each account registers and buys from the next, closing the loop. This is the
 * strategy MinQualifyingVol and the stake-weighted diversity cap were added to
 * price: more identities means more registrations to pay for, and the bloom
 * filter only credits each distinct buyer once per era.
 */
export const sybil = {
  key: 'sybil',
  title: 'Sybil farm',
  accounts: 5,
  async run(ctx) {
    for (const a of ctx.accounts) {
      await registerAgent(ctx.api, ctx.ledger, a, STANDARD_STAKE, ctx.log);
    }
    note(ctx.ledger, `${ctx.accounts.length}-account ring, each buys from the next`);
    for (let r = 0; r < ctx.rounds; r++) {
      for (let i = 0; i < ctx.accounts.length; i++) {
        const buyer = ctx.accounts[i];
        const provider = ctx.accounts[(i + 1) % ctx.accounts.length];
        await escrowRoundTrip(ctx.api, ctx.ledger, buyer, provider, CMN(60), `sybil-${r}-${i}`, ctx.log);
      }
    }
  },
};

/**
 * ORACLE COLLUDER — a bloc answering its own questions identically.
 *
 * One account raises an oracle request, the others submit the same answer hash
 * to force consensus. Expected to be INERT for emissions on this runtime:
 * `OracleScoreProvider = ()`, so the oracle term contributes +0 to weight. The
 * archetype runs anyway and the report says so — "the bonus is wired to nothing"
 * is a finding, and a fixture that skipped the calls would have hidden it.
 */
export const oracle = {
  key: 'oracle',
  title: 'Oracle colluder',
  accounts: 3,
  async run(ctx) {
    for (const a of ctx.accounts) {
      await registerAgent(ctx.api, ctx.ledger, a, STANDARD_STAKE, ctx.log);
    }
    const [requester, ...responders] = ctx.accounts;
    const questionHash = hash32(`oracle-q:${ctx.runSeedTag}`);
    const bounty = ctx.api.consts.oracle.minOracleBounty.toBigInt() * 2n;
    const now = await ctx.head();
    const r = await submit(
      ctx.api,
      ctx.api.tx.oracle.createOracleRequest(
        questionHash, bounty, 'Majority', responders.length, 51,
        now + 600, ctx.api.consts.oracle.minChallengeWindow.toNumber() + 10, null,
      ),
      requester,
    );
    recordExtrinsic(ctx.ledger);
    if (!r.ok) {
      recordFailure(ctx.ledger, 'createOracleRequest', r.error);
      note(ctx.ledger, `oracle request refused: ${r.error}`);
      ctx.log(`    oracle request REFUSED: ${r.error}`);
      return;
    }
    const answer = hash32('collusive-answer');
    for (const responder of responders) {
      const s = await submit(ctx.api, ctx.api.tx.oracle.submitResponse(questionHash, answer, 0), responder);
      recordExtrinsic(ctx.ledger);
      if (!s.ok) {
        recordFailure(ctx.ledger, 'submitResponse', s.error);
        ctx.log(`    oracle response ${short(responder.address)} REFUSED: ${s.error}`);
      }
    }
    note(ctx.ledger, 'OracleScoreProvider = () on this runtime — the oracle term contributes +0 to weight');
  },
};

/**
 * GOVERNANCE FARMER — votes without working.
 *
 * Registers and calls record_gov_vote, doing minimal escrow. The V4 fix gates
 * the governance term on `work_score > 0`, so this should earn nothing: gov
 * participation amplifies work-based weight and cannot substitute for it. The
 * archetype exists to keep that gate honest — if the gate regressed, this row
 * would go positive.
 */
export const governance = {
  key: 'governance',
  title: 'Governance farmer',
  accounts: 2,
  async run(ctx) {
    const [a, b] = ctx.accounts;
    await registerAgent(ctx.api, ctx.ledger, a, STANDARD_STAKE, ctx.log);
    await registerAgent(ctx.api, ctx.ledger, b, STANDARD_STAKE, ctx.log);
    const maxProps = ctx.api.consts.agents.maxProposalsPerEra.toNumber();
    let recorded = 0;
    for (let poll = 0; poll < Math.min(maxProps, 5); poll++) {
      const r = await submit(ctx.api, ctx.api.tx.agents.recordGovVote(a.address, poll), a);
      recordExtrinsic(ctx.ledger);
      if (r.ok) recorded += 1;
      else recordFailure(ctx.ledger, `recordGovVote(${poll})`, r.error);
    }
    ctx.log(`    recorded ${recorded} gov vote(s) of ${Math.min(maxProps, 5)} attempted`);
    note(ctx.ledger, `${recorded} gov votes recorded, no escrow work — gov term is gated on work_score > 0`);
  },
};

/**
 * PASSIVE STAKER — stake, do nothing else.
 *
 * The project's central claim is that stake alone earns nothing. This row is
 * that claim under test. It should come out NEGATIVE by exactly the
 * registration fee and transaction fees: no volume means no work score, which
 * means no floor share and no governance amplification.
 */
export const passive = {
  key: 'passive',
  title: 'Passive staker',
  accounts: 1,
  async run(ctx) {
    const [a] = ctx.accounts;
    await registerAgent(ctx.api, ctx.ledger, a, STANDARD_STAKE, ctx.log);
    note(ctx.ledger, 'stake only, zero escrow volume — the "stake earns nothing" claim under test');
  },
};

export const ARCHETYPES = { honest, wash, sybil, oracle, governance, passive };
export const ATTACKERS = ['wash', 'sybil', 'oracle', 'governance', 'passive'];
