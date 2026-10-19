#!/usr/bin/env python3
"""ROUND12 — independent adversarial re-derivation of the OD-4 wash-trading finding.

Written FROM SCRATCH against primary sources only:
  * pallets/emissions/src/lib.rs   (compute_weight_cached L536-690, settle_era L255-273,
                                    log2_scaled L670-683, diversity_score_bps L685-694)
  * pallets/agents/src/lib.rs      (add_era_escrow_volume L1246-1300, drain_era_maps L1329-)
  * pallets/escrow/src/lib.rs      (create_agreement L280-, confirm_delivery fee L404-427)
  * runtime/src/lib.rs             (economic constants)
  * docs/VERIFIED-CONSTANTS.md     (P0-1a / P0-1b)
  * docs/rfcs/OD-4-pool-scaled-costs.md
  * experiments/sc-e1/SC-E1-phase0-sim.py + SC-E1-phase0-v2-verdicts.json  (anchor)

The ROUND11 harness (od4_harness_round11.py) was NOT read before this file's numbers
were produced. Diff against it is a separate, later step.

PART 0  anchor: reproduce the published v2 verdicts bit-exactly
PART 1  is P pinned at the 1,000,000 CMN ceiling for n >= 100?
PART 2  wash-trader net CMN/era at baseline
PART 3  THE CRUX: a RATIONAL washer that chooses its own volume vs MinQualifyingVol
PART 4  per-counterparty-era cost that drives the rational washer strictly negative
"""
import json
import math
import statistics
import itertools
import random

# ---------------------------------------------------------------------------
# Constants — transcribed from runtime/src/lib.rs and VERIFIED-CONSTANTS.md.
# All money in CMN (the chain works in plancks; every place the chain's value
# enters is either a ratio (scale-invariant) or sqrt (uniform 1e6 factor that
# cancels in a proportional distribution) — see FIDELITY NOTE in the report.
# ---------------------------------------------------------------------------
CMN = 1.0
BPS_SCALE = 10_000
SCORE_SCALE = 10_000

ALPHA = 4_000                      # InitialAlpha        runtime/src/lib.rs:1065
BETA = 5_000                       # InitialBeta         :1066
FLOOR_BPS = 1_000                  # InitialFloorBps     :1067
ORACLE_BONUS_BPS = 2_000           # OracleBonusBps      :1012  (INERT, F-5)
UNIT_VOLUME = 10 * CMN             # UnitVolume          :1014
MAX_PROPS = 20                     # MaxProposalsPerEra  :1013
VELOCITY_BONUS_BPS = 3_000         # VelocityBonusBps    :1026
MIN_QUAL = 50 * CMN                # MinQualifyingVol    :1020
FULL_FLOOR_STAKE = 10_000 * CMN    # FullFloorStake      :897
MIN_STAKE = 1_000 * CMN            # AgentsMinStake      :1077
BASE_REG_FEE = 50 * CMN            # BaseRegistrationFee :1081
MAX_VOL_TO_STAKE = 10              # MaxVolToStakeRatio  :1087
MIN_AGREEMENT = 10 * CMN           # EscrowMinAmount     :1137
COMPLETION_FEE_BPS = 25            # InitialCompletionFeeBps :1064  (0.25%, F-3)

TARGET_EMISSION_PER_AGENT = 10_000 * CMN     # :1009
FLOOR_EMISSION_PER_ERA = 100_000 * CMN       # :1010
INITIAL_EMISSIONS_PER_ERA = 1_000_000 * CMN  # :1008  hard ceiling
ERAS_PER_DAY = 4                             # ERA_BLOCKS 3600 @ 6s = 6h

# Model-only fee assumptions carried from the v2 sim's MA'-7 so PART 0 can anchor.
TXFEE = 10 * CMN
COMPFEE = 100 * CMN
ESCROW_SIZE = 100 * CMN

OUT = {}


def emission_pool(agent_count):
    """settle_era, pallets/emissions/src/lib.rs:255-272."""
    return min(INITIAL_EMISSIONS_PER_ERA,
               max(FLOOR_EMISSION_PER_ERA, TARGET_EMISSION_PER_AGENT * agent_count))


def log2_scaled(vol, unit=UNIT_VOLUME):
    """pallets/emissions/src/lib.rs:670-683."""
    if vol == 0 or unit == 0:
        return 0
    ratio = int(vol * 1_000_000 / unit)
    if ratio == 0:
        return 0
    bits = ratio.bit_length()
    return min(SCORE_SCALE, max(0, bits - 19) * (SCORE_SCALE // 10))


def diversity_bps(unique_buyers):
    """pallets/emissions/src/lib.rs:685-694."""
    return {0: 0, 1: 1_000, 2: 3_000, 3: 6_000, 4: 8_000}.get(unique_buyers, 10_000)


def rank_bps_for(stake):
    """rank_of -> rank_bps, lib.rs:560-564. Rank 3 unreachable at genesis (F-5/F-6)."""
    return 12_000 if stake >= FULL_FLOOR_STAKE else 10_000


def onboarding_bps(completions):
    """lib.rs:249-254 / 645-648."""
    return (10_000 - completions * 1_000) if completions < 10 else 0


def weight(stake, vol, buyers, gov_votes, hb, completions,
           min_qual=MIN_QUAL, oracle_score=0):
    """compute_weight_cached — pallets/emissions/src/lib.rs:536-666, STEP 1..11."""
    if stake <= 0:
        return 0.0
    sqrt_stake = math.isqrt(int(stake))                                    # STEP 1
    rk = rank_bps_for(stake)                                               # STEP 2
    has_hb = hb >= 90                                                      # STEP 3
    raw_vol = log2_scaled(vol)                                             # STEP 4
    dv = diversity_bps(buyers)
    work_score = 0 if (raw_vol == 0 or dv == 0) else raw_vol * dv // SCORE_SCALE
    is_active = (vol > 0) and has_hb                                       # STEP 5
    qualifies = is_active and (min_qual == 0 or vol >= min_qual)
    eff_floor = FLOOR_BPS if qualifies else 0
    gov_score = min(gov_votes, MAX_PROPS) * SCORE_SCALE // MAX_PROPS       # STEP 6
    gov_contrib = (ALPHA * gov_score // SCORE_SCALE) if work_score > 0 else 0
    activity = min(BPS_SCALE,                                              # STEP 7
                   eff_floor + gov_contrib + BETA * work_score // SCORE_SCALE)
    base = sqrt_stake * rk / BPS_SCALE * activity / BPS_SCALE * hb / 100   # STEP 8
    after_oracle = base + base * oracle_score / BPS_SCALE * ORACLE_BONUS_BPS / BPS_SCALE
    after_onb = after_oracle * (10_000 + onboarding_bps(completions)) / 10_000   # STEP 10
    vratio = min(BPS_SCALE, vol * BPS_SCALE / stake) if stake > 0 else 0   # STEP 11
    return after_onb + after_onb * vratio / BPS_SCALE * VELOCITY_BONUS_BPS / BPS_SCALE


# ===========================================================================
# PART 0 — ANCHOR. Reproduce the published v2 verdicts bit-exactly.
# ===========================================================================
class A:
    def __init__(s, kind, stake, work=0.0, buyers=5):
        s.kind, s.stake, s.work, s.buyers = kind, stake, work, buyers
        s.earn = 0.0
        s.fees = 0.0
        s.completions = 0
        s.hb = 100

    def gov(s):
        return MAX_PROPS if s.kind in ('A-1', 'A-5') else 0


WORK_GRADES = [100, 500, 1000, 2000, 5000]
BASEPOP = {'workers': WORK_GRADES, 'n_work': 20, 'n_stake': 100}


def sim(seed, eras=20, pop=None):
    """Era loop transcribed from SC-E1-phase0-sim.py `run` (MA'-1..MA'-8)."""
    rng = random.Random(seed)
    pop = pop or {}
    ags = []
    for v in pop.get('workers', []):
        for _ in range(pop.get('n_work', 20)):
            ags.append(A('A-1', 10_000 * CMN, work=v, buyers=5))
    for _ in range(pop.get('n_stake', 20)):
        ags.append(A('A-2', 100_000 * CMN, buyers=0))
    for _ in range(pop.get('n_sybil', 0)):
        ags.append(A('A-3', 100 * CMN, buyers=0))
    for _ in range(pop.get('n_wash', 0)):
        ags.append(A('A-4', 10_000 * CMN, work=MIN_QUAL, buyers=1))
    for _ in range(pop.get('n_oracle', 0)):
        ags.append(A('A-5', 10_000 * CMN, work=500 * CMN, buyers=5))

    E = emission_pool(len(ags))
    lags = []
    for era in range(eras):
        for a in ags:
            a.fees += TXFEE
            if a.work > 0:
                n_esc = max(1, int(a.work / ESCROW_SIZE))
                a.fees += (n_esc * (3 * TXFEE) + n_esc * COMPFEE) if a.kind == 'A-4' \
                    else (n_esc * (1.5 * TXFEE) + n_esc * (COMPFEE / 2))
                a.completions += n_esc
        W = [weight(a.stake, a.work, a.buyers, a.gov(), a.hb, a.completions) for a in ags]
        tw = sum(W)
        for a, w in zip(ags, W):
            if tw > 0:
                a.earn += E * w / tw
        elig = [a for a in ags if a.earn / (era + 1) > TXFEE]
        if elig:
            lag = min(rng.uniform(0, 0.2) for _ in elig)
            rng.choice(elig).fees += TXFEE
            lags.append(lag)
        else:
            lags.append(None)
    return ags, lags, E


def net(a):
    return a.earn - a.fees


def by(ags, k):
    return [a for a in ags if a.kind == k]


def gini(xs):
    xs = sorted(xs)
    n, s = len(xs), sum(xs)
    if s == 0:
        return 0.0
    return sum((2 * (i + 1) - n - 1) * v for i, v in enumerate(xs)) / (n * s)


# RUN-A gini
ags_a, _, pool_a = sim(1, 20, pop=BASEPOP)
gini_a = gini([a.earn for a in ags_a])
# RUN-C sybil net
sy = statistics.mean(net(a) for a in by(sim(1, 3, pop={**BASEPOP, 'n_sybil': 1000})[0], 'A-3'))
# RUN-D wash net/era
wd_ags = by(sim(1, 10, pop={**BASEPOP, 'n_wash': 2})[0], 'A-4')
wash_net_era = statistics.mean(net(a) / 10 for a in wd_ags)
wash_gross_era = statistics.mean(a.earn / 10 for a in wd_ags)

TARGETS = {'RUN-A gini': (gini_a, 0.5260849509298967),
           'RUN-C sybil net': (sy, -30.0),
           'RUN-D wash net/era': (wash_net_era, 1556.4082243577097),
           'RUN-D wash gross/era': (wash_gross_era, 1696.4082243577097),
           'RUN-A pool': (pool_a, 1000000.0)}
anchor_ok = all(mine == theirs for mine, theirs in TARGETS.values())
OUT['PART0_anchor'] = {k: {'mine': repr(m), 'published': repr(p), 'exact': m == p}
                       for k, (m, p) in TARGETS.items()}
OUT['PART0_anchor']['ALL_BIT_EXACT'] = anchor_ok

print("=" * 78)
print("PART 0 — ANCHOR (must be bit-exact before anything below is trustworthy)")
print("=" * 78)
for k, (m, p) in TARGETS.items():
    print(f"  {'OK ' if m == p else 'FAIL'}  {k:22s} mine={m!r:22s} published={p!r}")
if not anchor_ok:
    raise SystemExit("ANCHOR FAILED — transcription is wrong; stop and fix.")
print("  --> ANCHOR PASSES BIT-EXACTLY. Proceeding.\n")


# ===========================================================================
# PART 1 — Is P pinned at the 1,000,000 CMN ceiling for populations >= 100?
# ===========================================================================
print("=" * 78)
print("PART 1 — pool pinning")
print("=" * 78)
# Arithmetic: 10_000 * n >= 1_000_000  <=>  n >= 100.
n_star = math.ceil(INITIAL_EMISSIONS_PER_ERA / TARGET_EMISSION_PER_AGENT)
sweep = {n: emission_pool(n) for n in [1, 10, 50, 99, 100, 101, 200, 202, 1000, 10_000, 10**6]}
pinned = all(v == INITIAL_EMISSIONS_PER_ERA for n, v in sweep.items() if n >= 100)
first_pin = min(n for n in range(1, 5000) if emission_pool(n) == INITIAL_EMISSIONS_PER_ERA)
print(f"  ceiling/slope = {INITIAL_EMISSIONS_PER_ERA:,.0f} / {TARGET_EMISSION_PER_AGENT:,.0f}"
      f" = n* = {n_star}")
print(f"  smallest n with P == ceiling (by run): {first_pin}")
for n, v in sweep.items():
    print(f"    n={n:<9,} P={v:>12,.0f}  {'CEILING' if v == INITIAL_EMISSIONS_PER_ERA else ''}")
print(f"  P pinned for all tested n >= 100: {pinned}")
# Consequence for OD-4 Mechanism A, variant by variant.
mechA = {
    'V_min = k*P (pool-indexed)':
        'NO-OP for n>=100: P is the constant 1e6, so k*P is a constant. Re-parameterised '
        'flat guard, not a scaling one.',
    'V_min = k*P/active_agents (per-capita)':
        'NOT a no-op: 1e6/n DECREASES in n, so the guard WEAKENS as the chain grows — '
        'the opposite of the OD-4 design intent.',
    'V_min = k*median_honest_volume':
        'NOT a no-op (tracks a live quantity), but it is not pool-indexed at all; it is a '
        'different mechanism wearing Mechanism A\'s name, and OD-4 3.3 already flags it '
        'as cartel-gameable.',
}
for k, v in mechA.items():
    print(f"    [{k}] {v}")
OUT['PART1_pool'] = {'n_star_arith': n_star, 'first_pinned_n_by_run': first_pin,
                     'sweep': {str(k): v for k, v in sweep.items()},
                     'pinned_for_n_ge_100': pinned, 'mechanism_A_variants': mechA}
print()


# ===========================================================================
# PART 2 — wash-trader net CMN/era at baseline
# ===========================================================================
print("=" * 78)
print("PART 2 — baseline wash-trader profitability")
print("=" * 78)


def wash_timeseries(eras=30, n_wash=2):
    """Per-era (not cumulative-mean) washer net, to separate the onboarding transient."""
    rng = random.Random(1)
    ags = []
    for v in WORK_GRADES:
        for _ in range(20):
            ags.append(A('A-1', 10_000 * CMN, work=v, buyers=5))
    for _ in range(100):
        ags.append(A('A-2', 100_000 * CMN, buyers=0))
    for _ in range(n_wash):
        ags.append(A('A-4', 10_000 * CMN, work=MIN_QUAL, buyers=1))
    E = emission_pool(len(ags))
    series = []
    for era in range(eras):
        pre = {id(a): (a.earn, a.fees) for a in ags}
        for a in ags:
            a.fees += TXFEE
            if a.work > 0:
                n_esc = max(1, int(a.work / ESCROW_SIZE))
                a.fees += (n_esc * (3 * TXFEE) + n_esc * COMPFEE) if a.kind == 'A-4' \
                    else (n_esc * (1.5 * TXFEE) + n_esc * (COMPFEE / 2))
                a.completions += n_esc
        W = [weight(a.stake, a.work, a.buyers, a.gov(), a.hb, a.completions) for a in ags]
        tw = sum(W)
        for a, w in zip(ags, W):
            a.earn += E * w / tw
        w4 = [a for a in ags if a.kind == 'A-4']
        series.append(statistics.mean(
            (a.earn - pre[id(a)][0]) - (a.fees - pre[id(a)][1]) for a in w4))
    return series, E


ser, E_ts = wash_timeseries()
print(f"  pool P = {E_ts:,.0f} CMN/era (202 agents -> ceiling)")
print(f"  marginal washer net by era: era0={ser[0]:.2f} era1={ser[1]:.2f} "
      f"era5={ser[5]:.2f} era9={ser[9]:.2f}")
print(f"  steady state (era 15-29, onboarding exhausted): {statistics.mean(ser[15:]):.4f} CMN/era")
print(f"  10-era cumulative mean (the RUN-D published stat): {wash_net_era:.4f} CMN/era")
print(f"  20-era cumulative mean: {statistics.mean(ser[:20]):.4f} CMN/era")
print(f"  30-era cumulative mean: {statistics.mean(ser):.4f} CMN/era")
claim_1301 = statistics.mean(ser[15:])
print(f"  ~+1,301 claim -> nearest quantity found: steady-state net = {claim_1301:.2f}")
# Hunt for the exact population/window that yields ~1,301, so the ROUND11 figure can be
# either located or refuted rather than hand-waved.
hunt = {}
for nw in (1, 2, 5, 10):
    s_nw, _ = wash_timeseries(eras=40, n_wash=nw)
    for wnd in (5, 10, 15, 20, 25, 30, 40):
        hunt[f'n_wash={nw},eras={wnd}'] = statistics.mean(s_nw[:wnd])
near = sorted(hunt.items(), key=lambda kv: abs(kv[1] - 1301.0))[:5]
print("  search for a window/population producing ~1,301 (5 closest):")
for k, v in near:
    print(f"    {k:24s} -> {v:10.4f}   (delta {v - 1301:+.2f})")
OUT['PART2_hunt_1301'] = {'closest': near, 'all': hunt}
OUT['PART2_baseline'] = {
    'pool': E_ts,
    'net_by_era_first10': ser[:10],
    'steady_state_net_per_era': statistics.mean(ser[15:]),
    'cum_mean_10_eras_RUND': wash_net_era,
    'cum_mean_20_eras': statistics.mean(ser[:20]),
    'cum_mean_30_eras': statistics.mean(ser),
    'note': 'RUN-D 1556.408 is a 10-era CUMULATIVE MEAN that includes the +100% decaying '
            'onboarding boost. The steady-state (post-onboarding) figure is lower.'}
print()


# ===========================================================================
# PART 3 — THE CRUX. A RATIONAL washer that chooses its own volume.
# ===========================================================================
print("=" * 78)
print("PART 3 — THE CRUX: rational washer vs MinQualifyingVol")
print("=" * 78)

# Honest reference population at STEADY STATE (completions >= 10, no onboarding boost).
# This is the denominator the washer competes against.
HONEST = []
for v in WORK_GRADES:
    for _ in range(20):
        HONEST.append(dict(stake=10_000 * CMN, vol=v, buyers=5, gov=MAX_PROPS, hb=100, comp=99))
for _ in range(100):
    HONEST.append(dict(stake=100_000 * CMN, vol=0, buyers=0, gov=0, hb=100, comp=99))
SIGMA_HONEST = sum(weight(h['stake'], h['vol'], h['buyers'], h['gov'], h['hb'], h['comp'])
                   for h in HONEST)
print(f"  Sigma_honest (steady state, 200 agents) = {SIGMA_HONEST:,.4f}")


def washer_reward(vol, buyers, stake, min_qual, comp=99, n_washers=1, P=None, gov=0):
    """Emission the washer draws, competing against the honest steady-state population."""
    P = P if P is not None else INITIAL_EMISSIONS_PER_ERA
    w = weight(stake, vol, buyers, gov, 100, comp, min_qual=min_qual)
    tw = SIGMA_HONEST + n_washers * w
    return (P * w / tw) if tw > 0 else 0.0, w


def cost_sim_fee(vol, buyers, n_esc):
    """MA'-7 model fee: flat 100 CMN completion fee per 100-CMN escrow slice."""
    return TXFEE + n_esc * (3 * TXFEE) + n_esc * COMPFEE


def cost_chain_fee(vol, buyers, n_esc):
    """Real chain (F-3): CompletionFeeBps = 25 bps of value + base tx fees per escrow.
    Base fee b = 10 CMN is the MA-7 model value and is NOT verified on-chain."""
    return TXFEE + n_esc * (3 * TXFEE) + vol * COMPLETION_FEE_BPS / BPS_SCALE


# Volume grid: from the escrow minimum up past the log2 saturation point.
VOL_GRID = sorted(set(
    [MIN_AGREEMENT] + [round(v, 4) for v in
                       [10, 11, 15, 20, 30, 40, 49, 50, 51, 80, 100, 160, 200, 320, 500,
                        640, 1000, 1280, 2000, 2560, 2684, 2685, 3000, 5000, 10_000,
                        20_000, 50_000, 100_000]]))


# --- The MaxVolToStakeRatio diversity cap is ORDER-DEPENDENT and therefore evadable. ---
# agents/src/lib.rs:1254-1281: era_total is accumulated FIRST, then a new buyer slot is
# credited only if era_total <= stake*ratio. A washer that front-loads k tiny escrows
# (10 CMN each, EscrowMinAmount) banks full diversity credit BEFORE pushing real volume;
# every later escrow reuses an already-seen slot and needs no credit.
DIVERSITY_CAP_EVADABLE = True


def best_strategy(min_qual, buyers, fee_model, stake=10_000 * CMN, comp=99,
                  counterparty_cost=0.0, n_washers=1, gov_options=(0, MAX_PROPS),
                  respect_vol_cap_naively=False):
    """A rational washer maximises net over volume, escrow count AND gov participation.

    Governance is part of the strategy space: gov_contribution is gated on work_score>0
    (emissions lib.rs:606-610), which a washer HAS, and GovVoteVerifier only checks that a
    conviction vote was cast — it cannot check sincerity. Excluding gov from the attacker's
    options under-powers the adversary; ROUND12 includes it.
    """
    best = None
    for v in VOL_GRID:
        if v < MIN_AGREEMENT:
            continue                       # EscrowMinAmount, escrow/src/lib.rs:1137
        if respect_vol_cap_naively and v > stake * MAX_VOL_TO_STAKE:
            eff_buyers = 1                 # naive reading of the stake-weighted cap
        else:
            eff_buyers = buyers            # front-loading defeats the cap (see above)
        if fee_model is cost_sim_fee:
            n_esc = max(1, int(v / ESCROW_SIZE))
        else:
            n_esc = max(1, buyers)         # >=1 escrow per distinct counterparty
        for g in gov_options:
            r, w = washer_reward(v, eff_buyers, stake, min_qual, comp=comp,
                                 n_washers=n_washers, gov=g)
            # Gov farming is NOT free: record_gov_vote must be called once per credited
            # vote (agents/src/lib.rs:901-930), so g calls x base fee per era. The
            # is_actively_voting check (runtime/src/lib.rs:1029-1036) is a single boolean
            # over ANY non-empty Casting vote — one conviction vote, cast once and held,
            # satisfies it forever. So the recurring cost is only the extrinsic fees.
            gov_cost = g * TXFEE
            c = fee_model(v, eff_buyers, n_esc) + counterparty_cost * buyers + gov_cost
            if best is None or (r - c) > best['net']:
                best = dict(vol=v, buyers=eff_buyers, n_esc=n_esc, weight=w, gov=g,
                            reward=r, cost=c, net=r - c, qualifies=v >= min_qual)
    return best


def honest_benchmark(work_vol, stake=10_000 * CMN, fee_model=None):
    """The correct comparator. 'Profitable' is nearly tautological here: a pure staker
    earns exactly 0 (VERIFIED-CONSTANTS Section 3), so ANY positive-net strategy beats
    abstention. The decision-relevant test is whether washing beats HONEST work at equal
    capital."""
    r, w = washer_reward(work_vol, 5, stake, MIN_QUAL, comp=99, gov=MAX_PROPS)
    c = TXFEE + 3 * TXFEE + work_vol * COMPLETION_FEE_BPS / BPS_SCALE + MAX_PROPS * TXFEE
    return dict(vol=work_vol, weight=w, reward=r, cost=c, net=r - c,
                net_per_cmn_stake=(r - c) / stake)


print("\n  (a) 1 counterparty (pure self-ring), sweep MinQualifyingVol -- REAL chain fee (F-3)")
print(f"  {'V_min':>9} | {'best V':>9} {'qual?':>6} {'weight':>9} {'reward':>10} "
      f"{'cost':>8} {'NET':>10}")
sweepA = {}
for mq in [0, 50, 100, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 1_000_000]:
    b = best_strategy(mq, 1, cost_chain_fee)
    sweepA[mq] = b
    print(f"  {mq:>9,} | {b['vol']:>9,.0f} {str(b['qualifies']):>6} {b['weight']:>9.3f} "
          f"{b['reward']:>10,.2f} {b['cost']:>8,.2f} {b['net']:>+10,.2f}")

print("\n  (b) same, but the v2 sim's MA'-7 flat-fee model (100 CMN per 100-CMN slice)")
print(f"  {'V_min':>9} | {'best V':>9} {'qual?':>6} {'weight':>9} {'reward':>10} "
      f"{'cost':>8} {'NET':>10}")
sweepB = {}
for mq in [0, 50, 100, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 1_000_000]:
    b = best_strategy(mq, 1, cost_sim_fee)
    sweepB[mq] = b
    print(f"  {mq:>9,} | {b['vol']:>9,.0f} {str(b['qualifies']):>6} {b['weight']:>9.3f} "
          f"{b['reward']:>10,.2f} {b['cost']:>8,.2f} {b['net']:>+10,.2f}")

print("\n  (c) 5 counterparties (diversity gate fully defeated), REAL chain fee")
print(f"  {'V_min':>9} | {'best V':>9} {'qual?':>6} {'weight':>9} {'reward':>10} "
      f"{'cost':>8} {'NET':>10}")
sweepC = {}
for mq in [0, 50, 5_000, 100_000, 1_000_000]:
    b = best_strategy(mq, 5, cost_chain_fee)
    sweepC[mq] = b
    print(f"  {mq:>9,} | {b['vol']:>9,.0f} {str(b['qualifies']):>6} {b['weight']:>9.3f} "
          f"{b['reward']:>10,.2f} {b['cost']:>8,.2f} {b['net']:>+10,.2f}")

print("\n  (d) THE DECISION-RELEVANT COMPARISON — wash vs HONEST work at equal capital")
print("      (a pure staker earns exactly 0, so 'net > 0' is nearly tautological here)")
hb100 = honest_benchmark(100 * CMN)
hb5000 = honest_benchmark(5_000 * CMN)
w_1cp_gov = best_strategy(MIN_QUAL, 1, cost_chain_fee)
w_5cp_gov = best_strategy(MIN_QUAL, 5, cost_chain_fee)
w_1cp_nogov = best_strategy(MIN_QUAL, 1, cost_chain_fee, gov_options=(0,))
rows = [
    ('honest worker, vol=100, 5 real buyers', hb100['weight'], hb100['reward'],
     hb100['cost'], hb100['net'], 10_000),
    ('honest worker, vol=5000, 5 real buyers', hb5000['weight'], hb5000['reward'],
     hb5000['cost'], hb5000['net'], 10_000),
    ('washer, 1 sybil cp, NO gov', w_1cp_nogov['weight'], w_1cp_nogov['reward'],
     w_1cp_nogov['cost'], w_1cp_nogov['net'], 10_000 + 1_000),
    ('washer, 1 sybil cp, votes gov', w_1cp_gov['weight'], w_1cp_gov['reward'],
     w_1cp_gov['cost'], w_1cp_gov['net'], 10_000 + 1_000),
    ('washer, 5 sybil cps, votes gov', w_5cp_gov['weight'], w_5cp_gov['reward'],
     w_5cp_gov['cost'], w_5cp_gov['net'], 10_000 + 5 * 1_000),
]
print(f"  {'strategy':<40} {'weight':>8} {'reward':>10} {'net':>10} {'capital':>9} "
      f"{'net/1k cap':>11}")
bench = {}
for name, w, r, c, n, cap in rows:
    print(f"  {name:<40} {w:>8.2f} {r:>10,.0f} {n:>+10,.0f} {cap:>9,} {1000 * n / cap:>+11,.1f}")
    bench[name] = dict(weight=w, reward=r, cost=c, net=n, capital=cap,
                       net_per_1k_capital=1000 * n / cap)
dominates = w_5cp_gov['net'] / (10_000 + 5_000) > hb100['net'] / 10_000
print(f"\n  does the 5-sybil gov-voting ring BEAT honest work per unit capital? {dominates}")
OUT['PART3_honest_comparison'] = {'rows': bench, 'ring_beats_honest_per_capital': dominates}

# Does the washer ever abandon the floor?
abandons = {mq: (not b['qualifies']) for mq, b in sweepA.items()}
profitable_always = all(b['net'] > 0 for b in sweepA.values())
print(f"\n  rational washer ABANDONS the V_min floor at V_min >= "
      f"{min([mq for mq, a in abandons.items() if a], default=None)}")
print(f"  net > 0 at EVERY V_min tested (real chain fee, 1 counterparty): {profitable_always}")
print(f"  net > 0 at EVERY V_min tested (sim flat fee, 1 counterparty): "
      f"{all(b['net'] > 0 for b in sweepB.values())}")

# The unqualified-washer plateau: once the floor is abandoned, V_min is irrelevant.
plateau = best_strategy(10**9, 1, cost_chain_fee)
print(f"  V_min -> 1e9 (floor unreachable): best V={plateau['vol']:,.0f}, "
      f"NET={plateau['net']:+,.2f} CMN/era  <-- the floor-free plateau")
# CLOSED FORM: why NO value of MinQualifyingVol can close wash, independent of the pool.
# MinQualifyingVol gates ONLY `effective_floor` (emissions lib.rs:594-596). The floor is
# floor_bps = 1,000 of an activity budget capped at BPS_SCALE = 10,000. So the MOST that
# any MinQualifyingVol setting — including +infinity — can remove is floor_bps/activity.
act_qual = FLOOR_BPS + ALPHA + BETA * (SCORE_SCALE * diversity_bps(1) // SCORE_SCALE) // SCORE_SCALE
act_unqual = act_qual - FLOOR_BPS
print(f"\n  CLOSED FORM — the structural ceiling on Mechanism A:")
print(f"    washer activity when qualifying   = {act_qual:,} bps")
print(f"    washer activity when NOT qualifying = {act_unqual:,} bps")
print(f"    max weight removable by ANY V_min = {100 * FLOOR_BPS / act_qual:.1f}%")
print(f"    -> V_min -> infinity still leaves {plateau['net']:+,.0f} CMN/era. Mechanism A "
      f"cannot reach zero at any parameter value.")
OUT['PART3_closed_form'] = {
    'activity_qualifying_bps': act_qual, 'activity_unqualifying_bps': act_unqual,
    'max_pct_weight_removable_by_any_Vmin': 100 * FLOOR_BPS / act_qual,
    'net_at_Vmin_infinity': plateau['net'],
    'conclusion': 'MinQualifyingVol gates only effective_floor (1,000 bps of a 10,000 bps '
                  'activity budget). No value of it, including infinity, drives the washer '
                  'negative. This is independent of P and of the fee model.'}

OUT['PART3_crux'] = {
    'sigma_honest': SIGMA_HONEST,
    'sweep_1cp_chainfee': {str(k): v for k, v in sweepA.items()},
    'sweep_1cp_simfee': {str(k): v for k, v in sweepB.items()},
    'sweep_5cp_chainfee': {str(k): v for k, v in sweepC.items()},
    'abandons_floor_at': min([mq for mq, a in abandons.items() if a], default=None),
    'profitable_at_every_min_qual_chainfee': profitable_always,
    'profitable_at_every_min_qual_simfee': all(b['net'] > 0 for b in sweepB.values()),
    'floor_free_plateau': plateau}
print()


# ===========================================================================
# PART 4 — per-counterparty-era cost that drives the rational washer negative
# ===========================================================================
print("=" * 78)
print("PART 4 — counterparty cost as the binding surface")
print("=" * 78)

# What does an extra counterparty actually cost on-chain TODAY?
# create_agreement (escrow/src/lib.rs:290-293) requires BuyerNotAgent -> every
# counterparty must be a REGISTERED AGENT: MinStake locked + BaseRegistrationFee.
print("  observed on-chain counterparty cost today (escrow/src/lib.rs:290-293 BuyerNotAgent):")
print(f"    one-time BaseRegistrationFee = {BASE_REG_FEE:,.0f} CMN (spent)")
print(f"    MinStake locked              = {MIN_STAKE:,.0f} CMN (opportunity cost, recoverable)")
for apr in (0.05, 0.20, 1.00):
    per_era = MIN_STAKE * apr / (ERAS_PER_DAY * 365)
    print(f"    amortised at {apr:>5.0%} APR opportunity cost: {per_era:>8.4f} CMN/era")
amort_reg = BASE_REG_FEE / (ERAS_PER_DAY * 365)   # spread over one year
print(f"    BaseRegistrationFee spread over 1 year: {amort_reg:.4f} CMN/era")
today_cost = MIN_STAKE * 0.20 / (ERAS_PER_DAY * 365) + amort_reg + 2 * TXFEE
print(f"    => realistic TODAY, incl. 2 tx/era: ~{today_cost:.2f} CMN/era per counterparty")

# Now: what per-counterparty-era cost c* makes the BEST washer strategy net <= 0,
# where the washer optimises over BOTH volume and number of counterparties?
CP_GRID = [1, 2, 3, 4, 5, 8, 20]


def best_over_counterparties(c, min_qual=MIN_QUAL, fee_model=cost_chain_fee,
                             stake=10_000 * CMN):
    best = None
    for k in CP_GRID:
        b = best_strategy(min_qual, k, fee_model, stake=stake, counterparty_cost=c)
        b = dict(b, n_counterparties=k)
        if best is None or b['net'] > best['net']:
            best = b
    return best


def find_cstar(min_qual=MIN_QUAL, fee_model=cost_chain_fee, stake=10_000 * CMN):
    lo, hi = 0.0, 1e7
    if best_over_counterparties(hi, min_qual, fee_model, stake)['net'] > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        if best_over_counterparties(mid, min_qual, fee_model, stake)['net'] > 0:
            lo = mid
        else:
            hi = mid
    return hi


print(f"\n  washer's best net vs per-counterparty-era cost c (V_min = {MIN_QUAL:,.0f}, chain fee)")
print(f"  {'c (CMN/era)':>12} | {'k':>3} {'V':>9} {'reward':>10} {'cost':>10} {'NET':>11}")
cp_table = {}
for c in [0, 1, 10, 50, 100, 200, 500, 1_000, 1_200, 1_500, 2_000, 5_000, 10_000]:
    b = best_over_counterparties(c)
    cp_table[c] = b
    print(f"  {c:>12,} | {b['n_counterparties']:>3} {b['vol']:>9,.0f} {b['reward']:>10,.2f} "
          f"{b['cost']:>10,.2f} {b['net']:>+11,.2f}")

def find_cstar_nogov(min_qual=MIN_QUAL, fee_model=cost_chain_fee, stake=10_000 * CMN):
    lo, hi = 0.0, 1e7
    for _ in range(200):
        mid = (lo + hi) / 2
        best = None
        for k in CP_GRID:
            b = best_strategy(min_qual, k, fee_model, stake=stake,
                              counterparty_cost=mid, gov_options=(0,))
            if best is None or b['net'] > best['net']:
                best = b
        if best['net'] > 0:
            lo = mid
        else:
            hi = mid
    return hi


cstar_default = find_cstar()
print(f"\n  c* (V_min=50, chain fee, stake=10k)              = {cstar_default:,.2f} CMN/era")
cstar_simfee = find_cstar(fee_model=cost_sim_fee)
print(f"  c* (V_min=50, sim MA'-7 flat fee)                = "
      f"{cstar_simfee:,.2f} CMN/era" if cstar_simfee else "  c* (sim fee) = already negative")
cstar_nofloor = find_cstar(min_qual=10**9)
print(f"  c* (V_min unreachable -> floor abandoned)        = {cstar_nofloor:,.2f} CMN/era")
for st in [1_000, 10_000, 100_000, 1_000_000]:
    cs = find_cstar(stake=st * CMN)
    print(f"  c* at washer stake {st:>9,} CMN                 = {cs:,.2f} CMN/era")
# The two under-powering choices that reproduce a ~1,200 figure, isolated one at a time.
cs_nogov_chain = find_cstar_nogov()
cs_nogov_sim = find_cstar_nogov(fee_model=cost_sim_fee)
print(f"\n  ROUND11 cross-check — isolate the two attacker-weakening modelling choices:")
print(f"    c* with gov farming ON,  real chain fee (F-3)  = {cstar_default:>10,.2f}  <-- ROUND12")
print(f"    c* with gov farming OFF, real chain fee (F-3)  = {cs_nogov_chain:>10,.2f}")
print(f"    c* with gov farming ON,  sim MA'-7 flat fee    = {cstar_simfee:>10,.2f}")
print(f"    c* with gov farming OFF, sim MA'-7 flat fee    = {cs_nogov_sim:>10,.2f}"
      f"  <-- reproduces ROUND11's ~1,200")
OUT['PART4_round11_crosscheck'] = {
    'gov_on_chain_fee': cstar_default, 'gov_off_chain_fee': cs_nogov_chain,
    'gov_on_sim_fee': cstar_simfee, 'gov_off_sim_fee': cs_nogov_sim,
    'understatement_factor': cstar_default / cs_nogov_sim}

# Is a c* of this magnitude even IMPLEMENTABLE as a monetary cost? Price it as a bond.
print("\n  feasibility of c* as a MONETARY counterparty cost (bond at opportunity cost r):")
MAX_STAKE_PER_AGENT = 1_000_000 * CMN     # AgentsMaxStakePerAgent, runtime :898
bonds = {}
for apr in (0.05, 0.20, 1.00):
    bond = cstar_default * (ERAS_PER_DAY * 365) / apr
    bonds[apr] = bond
    print(f"    at {apr:>5.0%} APR, bond required per counterparty = {bond:>18,.0f} CMN"
          f"   ({bond / MAX_STAKE_PER_AGENT:>8,.1f}x MaxStakePerAgent)")
print(f"    MaxStakePerAgent = {MAX_STAKE_PER_AGENT:,.0f} CMN -> a bond that large is "
      f"NOT expressible under the current stake cap.")
print(f"    c* as a flat per-era FEE = {cstar_default:,.0f} CMN/era = "
      f"{cstar_default * ERAS_PER_DAY:,.0f} CMN/day per counterparty relationship,")
print("    which would also be charged to every HONEST 5-counterparty agent.")

OUT['PART4_feasibility'] = {
    'bond_required_by_apr': {str(k): v for k, v in bonds.items()},
    'max_stake_per_agent': MAX_STAKE_PER_AGENT,
    'monetary_cost_reachable': False,
    'note': 'c* is not reachable as a price under MaxStakePerAgent; only a non-fungible '
            'identity/attestation constraint (unbuyable at any price) implements it.'}

OUT['PART4_counterparty'] = {
    'onchain_cost_today_cmn_per_era': today_cost,
    'components': {'base_registration_fee_onetime': BASE_REG_FEE,
                   'min_stake_locked': MIN_STAKE,
                   'buyer_must_be_registered_agent': True,
                   'src': 'pallets/escrow/src/lib.rs:290-293 (BuyerNotAgent)'},
    'net_vs_c': {str(k): v for k, v in cp_table.items()},
    'c_star_default': cstar_default,
    'c_star_sim_fee': cstar_simfee,
    'c_star_floor_abandoned': cstar_nofloor,
    'c_star_by_stake': {str(st): find_cstar(stake=st * CMN)
                        for st in [1_000, 10_000, 100_000, 1_000_000]},
    'gap_factor_vs_today': cstar_default / today_cost}
print(f"\n  GAP: required c* / actual today = {cstar_default / today_cost:,.1f}x")
print()


# ===========================================================================
# PART 5 — replication of ROUND11's published figures (run AFTER the above).
# Uses ROUND11's declared population (ROUND11.md 2.1: 272 agents) and its
# declared conditional setup, to locate each disagreement precisely.
# ===========================================================================
print("=" * 78)
print("PART 5 — replication of ROUND11's published numbers")
print("=" * 78)

R11POP = {**BASEPOP, 'n_sybil': 50, 'n_wash': 2, 'n_oracle': 20}
r11_ags, _, r11_E = sim(1, 10, pop=R11POP)
r11_wash = statistics.mean(net(a) / 10 for a in by(r11_ags, 'A-4'))
r11_honest = statistics.mean(net(a) / 10 for a in by(r11_ags, 'A-1'))
r11_stk = statistics.mean(net(a) / 10 for a in by(r11_ags, 'A-2'))
r11_syb = statistics.mean(net(a) / 10 for a in by(r11_ags, 'A-3'))
r11_orc = statistics.mean(net(a) / 10 for a in by(r11_ags, 'A-5'))
print(f"  ROUND11 2.1 population = {len(r11_ags)} agents (published: 272), P={r11_E:,.0f}")
print(f"  {'cohort':<12} {'ROUND12 repro':>14} {'ROUND11 published':>19} {'match':>7}")
for name, mine, theirs in [('A-4 WASH', r11_wash, 1301.5), ('A-1 honest', r11_honest, 7339.3),
                           ('A-2 staker', r11_stk, -10.0), ('A-3 sybil', r11_syb, -10.0),
                           ('A-5 oracle', r11_orc, 7183.8)]:
    ok = abs(mine - theirs) < 0.1
    print(f"  {name:<12} {mine:>14,.1f} {theirs:>19,.1f} {'YES' if ok else 'NO':>7}")
OUT['PART5_replication'] = {
    'population': len(r11_ags), 'pool': r11_E,
    'A-4_wash': r11_wash, 'A-1_honest': r11_honest, 'A-2_staker': r11_stk,
    'A-3_sybil': r11_syb, 'A-5_oracle': r11_orc,
    'published': {'A-4': 1301.5, 'A-1': 7339.3, 'A-2': -10.0, 'A-3': -10.0, 'A-5': 7183.8}}

# ROUND11 3.5: c* ~1,200 is measured under a CONDITIONAL setup -- div_bps(1)=0 AND
# V_min=10,000 already applied -- not at genesis parameters. Reproduce that.
_orig_div = diversity_bps


def div_zero_one_buyer(unique_buyers):
    """ROUND11 4's proposed change: diversity_score_bps(1) = 0."""
    return 0 if unique_buyers == 1 else _orig_div(unique_buyers)


print("\n  ROUND11 3.5 context — c* measured with div_bps(1)=0 AND V_min=10,000 applied:")
globals()['diversity_bps'] = div_zero_one_buyer
SIGMA_HONEST_DZ = sum(weight(h['stake'], h['vol'], h['buyers'], h['gov'], h['hb'], h['comp'])
                      for h in HONEST)
_saved_sigma = SIGMA_HONEST
SIGMA_HONEST = SIGMA_HONEST_DZ
cstar_r11ctx = find_cstar_nogov(min_qual=10_000 * CMN, fee_model=cost_sim_fee)
cstar_r11ctx_gov = find_cstar(min_qual=10_000 * CMN, fee_model=cost_sim_fee)
SIGMA_HONEST = _saved_sigma
globals()['diversity_bps'] = _orig_div
print(f"    c* in ROUND11's conditional setup, gov OFF = {cstar_r11ctx:>10,.2f}"
      f"   (ROUND11 published ~1,200)")
print(f"    c* in ROUND11's conditional setup, gov ON  = {cstar_r11ctx_gov:>10,.2f}")
print(f"    c* at GENESIS params (nothing else changed) = {cstar_default:>10,.2f}  <-- ROUND12")
OUT['PART5_cstar_context'] = {
    'r11_conditional_gov_off': cstar_r11ctx, 'r11_conditional_gov_on': cstar_r11ctx_gov,
    'genesis_params_gov_on': cstar_default,
    'note': "ROUND11's ~1,200 is conditional on div_bps(1)=0 AND V_min=10,000 being shipped "
            "first. At genesis parameters the required counterparty cost is far higher."}
print()

json.dump(OUT, open('experiments/sc-e1/scratchpad/round12_results.json', 'w'),
          indent=1, default=str)
print("wrote experiments/sc-e1/scratchpad/round12_results.json")
