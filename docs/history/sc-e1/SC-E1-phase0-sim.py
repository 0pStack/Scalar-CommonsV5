#!/usr/bin/env python3
"""SC-E1 Phase-0 v2 economic simulator (model, NOT the chain).

v2 CHANGE (issue #3 / P0-1a/b): the MA-3 *assumed* weight formula has been REPLACED
with the real emissions weight formula transcribed verbatim from the runtime source in
`docs/VERIFIED-CONSTANTS.md` (read of `pallets/emissions/src/lib.rs:432-536`,
`pallets/agents/src/lib.rs`, `runtime/src/lib.rs`). See `compute_weight` below.

WHAT CHANGED vs v1 (the old MA block, preserved in git history):
 * MA-1 (pool is a free parameter, swept to 1e9) -> the pool is the CAPPED SCHEDULE
   emission = clamp(TargetEmissionPerAgent*agent_count, FloorEmissionPerEra,
   InitialEmissionsPerEra) = clamp(10_000*n, 100_000, 1_000_000) CMN/era. Hard ceiling
   1_000_000 CMN/era (VERIFIED-CONSTANTS §1.3, F-4).
 * MA-2/MA-4 (a 60:40 work:stake split with a separate stake pool) -> DELETED. There is
   NO stake pool. A single weight combines everything and the whole pool is distributed
   in proportion to it (VERIFIED-CONSTANTS §1, F-1). `wsplit` is retired.
 * MA-3 (weight = volume*rank*(1+.1*oracle)*(1+.05*gov)*(1+velocity)) -> REPLACED by the
   real `compute_weight`: base is √stake (anti-whale), volume enters only through
   log2-scaled work_score gated by buyer diversity, then rank/heartbeat/oracle/
   onboarding/velocity multipliers (VERIFIED-CONSTANTS §1.2, F-1/F-6/F-7).

WHAT IS DELIBERATELY UNCHANGED (to isolate the weight-formula delta — one variable at a
time): the MA-7 fee model (flat 10 CMN tx fee, flat 100 CMN completion fee) is kept as in
v1 so fee changes do not confound the formula delta. The runtime's completion fee is
actually a 0.25% bps fee (VERIFIED-CONSTANTS F-3); modeling that is deferred to a later
phase and would only make the adversary runs *more* profitable, not less.

v2 MODEL ASSUMPTIONS (MA'-x) — every result is conditional on these:
 MA'-1 Pool = capped schedule (above); agent_count = len(registered agents).
 MA'-2 Distribution is single-weight proportional (no split). Orchestrator carve-out omitted
       (no orchestrator agent in the synthetic population).
 MA'-3 weight_i = compute_weight(...) exactly as transcribed (VERIFIED-CONSTANTS §1.2).
 MA'-4 rank_bps modeled as 12_000 (rank 2) for agents at/above FullFloorStake (10_000 CMN),
       else 10_000 (rank 1). Rank 3 (15_000) is unreachable at genesis because its oracle-score
       gate is inert (OracleScoreProvider = (), best_score = 0; F-5/F-6).
 MA'-5 Buyer diversity: honest workers/oracles transact with >=5 distinct buyers
       (diversity_bps = 10_000); a self-dealing wash trader has 1 counterparty
       (diversity_bps = 1_000) — the diversity gate is the real anti-wash defense (F-1).
 MA'-6 Oracle score bonus is INERT on-chain (best_score = 0, F-5); modeled as 0.
 MA'-7 Fees: unchanged from v1 MA-7 (see above).
 MA'-8 settle_era: unchanged from v1 MA-8 (rational call-if-benefit>fee + random backoff).
"""
import random, statistics, json, itertools, math

CMN = 1.0
TXFEE = 10 * CMN
COMPFEE = 100 * CMN          # MA'-7: flat, kept from v1 (see header; real chain uses bps, F-3)
ESCROW_SIZE = 100 * CMN

# --- Verified emissions constants (docs/VERIFIED-CONSTANTS.md §1.1/§2) ---
BPS_SCALE = 10_000
SCORE_SCALE = 10_000
ALPHA = 4_000               # gov weight            (auto-params genesis, VC §2.2)
BETA = 5_000                # work weight           (auto-params genesis)
FLOOR_BPS = 1_000           # activity floor        (auto-params genesis)
ORACLE_BONUS_BPS = 2_000    # +20% max (inert, F-5)
UNIT_VOLUME = 10 * CMN      # log2_scaled unit      (VC §2.1)
MAX_PROPS = 20              # MaxProposalsPerEra
VELOCITY_BONUS_BPS = 3_000  # +30% cap              (VC §2.1)
MIN_QUAL = 50 * CMN         # MinQualifyingVol      (VC §2.1 / §3)
FULL_FLOOR_STAKE = 10_000 * CMN     # rank 1->2 gate (VC §2.3)

# --- Pool schedule (VERIFIED-CONSTANTS §1.3) ---
TARGET_EMISSION_PER_AGENT = 10_000 * CMN
FLOOR_EMISSION_PER_ERA = 100_000 * CMN
INITIAL_EMISSIONS_PER_ERA = 1_000_000 * CMN   # hard ceiling


def emission_pool(agent_count):
    """clamp(TargetEmissionPerAgent*agent_count, floor, ceiling) — VC §1.3, F-4."""
    raw = TARGET_EMISSION_PER_AGENT * agent_count
    return min(INITIAL_EMISSIONS_PER_ERA, max(FLOOR_EMISSION_PER_ERA, raw))


def log2_scaled(vol, unit=UNIT_VOLUME):
    """pallets/emissions/src/lib.rs:539-545 (VERIFIED-CONSTANTS Appendix A).
    ratio = vol*1e6/unit; bits = bit_length(ratio); return min(10_000, sat_sub(bits,19)*1_000).
    Sub-UnitVolume volume -> 0 (bits <= 19)."""
    if vol == 0 or unit == 0:
        return 0
    ratio = int(vol * 1_000_000 / unit)
    if ratio == 0:
        return 0
    bits = ratio.bit_length()
    return min(SCORE_SCALE, max(0, bits - 19) * (SCORE_SCALE // 10))


def diversity_score_bps(unique_buyers):
    """pallets/emissions/src/lib.rs:547-551 (VERIFIED-CONSTANTS Appendix A)."""
    return {0: 0, 1: 1_000, 2: 3_000, 3: 6_000, 4: 8_000}.get(unique_buyers, 10_000)


def rank_bps_for(stake):
    """MA'-4: rank 2 (12_000) at/above FullFloorStake, else rank 1 (10_000).
    Rank 3 (15_000) unreachable at genesis (inert oracle gate, F-5/F-6)."""
    return 12_000 if stake >= FULL_FLOOR_STAKE else 10_000


def onboarding_boost_bps(completions):
    """+100% decaying over first 10 completions (VC §2.4 / lib.rs:250-254)."""
    return (10_000 - completions * 1_000) if completions < 10 else 0


def compute_weight(stake, vol, unique_buyers, gov_votes, hb, completions, oracle_score=0):
    """The real per-agent weight — VERIFIED-CONSTANTS §1.2, STEP 1..11.
    stake, vol in CMN; hb in [10,100]; oracle_score inert (0, F-5)."""
    if stake <= 0:
        return 0.0
    # STEP 1: √stake base (anti-whale)
    sqrt_stake = math.isqrt(int(stake))
    # STEP 2: rank multiplier
    rank_bps = rank_bps_for(stake)
    # STEP 3: heartbeat
    has_heartbeat = hb >= 90
    # STEP 4: work_score = log2_scaled(vol) * diversity
    raw_vol = log2_scaled(vol)
    div_bps = diversity_score_bps(unique_buyers)
    work_score = 0 if (raw_vol == 0 or div_bps == 0) else raw_vol * div_bps // SCORE_SCALE
    # STEP 5: floor gate (MinQualifyingVol gates the FLOOR ONLY)
    did_work = vol > 0
    is_active = did_work and has_heartbeat
    qualifies_for_floor = is_active and (MIN_QUAL == 0 or vol >= MIN_QUAL)
    effective_floor = FLOOR_BPS if qualifies_for_floor else 0
    # STEP 6: gov contribution (cannot substitute for work)
    gov_score = min(gov_votes, MAX_PROPS) * SCORE_SCALE // MAX_PROPS
    gov_contribution = (ALPHA * gov_score // SCORE_SCALE) if work_score > 0 else 0
    # STEP 7: activity (clamped to 100%)
    activity = min(BPS_SCALE, effective_floor + gov_contribution + BETA * work_score // SCORE_SCALE)
    # STEP 8: base weight
    base_weight = sqrt_stake * rank_bps / BPS_SCALE * activity / BPS_SCALE * hb / 100
    # STEP 9: oracle bonus (inert on-chain, F-5)
    bonus = base_weight * oracle_score / BPS_SCALE * ORACLE_BONUS_BPS / BPS_SCALE
    weight_after_oracle = base_weight + bonus
    # STEP 10: onboarding boost
    after_onboarding = weight_after_oracle * (10_000 + onboarding_boost_bps(completions)) / 10_000
    # STEP 11: velocity bonus (+30% cap)
    velocity_ratio = min(BPS_SCALE, vol * BPS_SCALE / stake) if stake > 0 else 0
    v_bonus = after_onboarding * velocity_ratio / BPS_SCALE * VELOCITY_BONUS_BPS / BPS_SCALE
    return after_onboarding + v_bonus


class Ag:
    def __init__(s, aid, kind, stake, work=0.0, buyers=5):
        s.id = aid; s.kind = kind; s.stake = stake; s.work = work
        s.buyers = buyers          # distinct escrow counterparties this era (diversity input)
        s.earn = 0.0; s.fees = 0.0
        s.completions = 0          # cumulative CompletedAgreements[who]
        s.hb = 100                 # heartbeat multiplier (all active in this synthetic pop)

    def vol(s):
        return s.work

    def gov_votes(s):
        return MAX_PROPS if s.kind in ('A-1', 'A-5') else 0


def run(seed, eras=20, pop=None, collude_frac=0.0):
    rng = random.Random(seed)
    ags = []
    aid = itertools.count()
    pop = pop or {}
    for v in pop.get('workers', []):                     # graded worker sub-cohorts
        for _ in range(pop.get('n_work', 20)):
            ags.append(Ag(next(aid), 'A-1', 10_000 * CMN, work=v, buyers=5))
    for _ in range(pop.get('n_stake', 20)):
        ags.append(Ag(next(aid), 'A-2', 100_000 * CMN, buyers=0))   # pure staker, no work
    for _ in range(pop.get('n_sybil', 0)):
        ags.append(Ag(next(aid), 'A-3', 100 * CMN, buyers=0))       # low-stake, no work
    for _ in range(pop.get('n_wash', 0)):
        ags.append(Ag(next(aid), 'A-4', 10_000 * CMN, work=MIN_QUAL, buyers=1))  # self-escrow
    for _ in range(pop.get('n_oracle', 0)):
        ags.append(Ag(next(aid), 'A-5', 10_000 * CMN, work=500 * CMN, buyers=5))

    agent_count = len(ags)
    E_era = emission_pool(agent_count)   # capped schedule — NOT a free parameter (F-4)
    lags = []
    for era in range(eras):
        # activity + fees (MA'-7, unchanged from v1 MA-7)
        for a in ags:
            a.fees += TXFEE  # heartbeat
            if a.vol() > 0:
                n_esc = max(1, int(a.vol() / ESCROW_SIZE))
                a.fees += (n_esc * (3 * TXFEE) + n_esc * COMPFEE) if a.kind == 'A-4' \
                    else (n_esc * (1.5 * TXFEE) + n_esc * (COMPFEE / 2))
                a.completions += n_esc
        # weights (MA'-3: the real compute_weight)
        Wq = [compute_weight(a.stake, a.vol(), a.buyers, a.gov_votes(), a.hb, a.completions)
              for a in ags]
        tw = sum(Wq)
        for a, w in zip(ags, Wq):
            if tw > 0:
                a.earn += E_era * w / tw
        # settlement (MA'-8): first backoff among agents whose unclaimed earnings > fee
        eligible = [a for a in ags if a.earn / (era + 1) > TXFEE]
        if eligible:
            lag = min(rng.uniform(0, 0.2) for _ in eligible)
            caller = rng.choice(eligible); caller.fees += TXFEE
            lags.append(lag)
        else:
            lags.append(None)
    return ags, lags, E_era


def net(a):
    return a.earn - a.fees


def by(ags, k):
    return [a for a in ags if a.kind == k]


def gini(x):
    x = sorted(x); n = len(x); s = sum(x)
    if s == 0:
        return 0.0
    return sum((2 * (i + 1) - n - 1) * v for i, v in enumerate(x)) / (n * s)


def spearman(x, y):
    rx = {v: i for i, v in enumerate(sorted(set(x)))}
    ry = sorted(range(len(y)), key=lambda i: y[i])
    r_y = [0] * len(y)
    for rank, i in enumerate(ry):
        r_y[i] = rank
    r_x = [rx[v] for v in x]
    mx, my = statistics.mean(r_x), statistics.mean(r_y)
    num = sum((a - mx) * (b - my) for a, b in zip(r_x, r_y))
    den = math.sqrt(sum((a - mx) ** 2 for a in r_x) * sum((b - my) ** 2 for b in r_y))
    return num / den if den else 0.0


WORK_GRADES = [100, 500, 1000, 2000, 5000]
BASEPOP = {'workers': WORK_GRADES, 'n_work': 20, 'n_stake': 100}
V = {}
SEEDS = [1, 2, 3]


def agg(f):
    return [f(s) for s in SEEDS]


# RUN-A: the real single-weight formula (P1,P2,P3,P8). RUN-B (stake-only split) has NO
# analogue under the verified formula — there is no W:S split to zero out (F-1).
ratios = []; rhos = []; g20 = []; top = []; pools = []
for s in SEEDS:
    ags, _, E = run(s, 20, pop=BASEPOP)
    wk, stk = by(ags, 'A-1'), by(ags, 'A-2')
    ratios.append(statistics.mean(net(a) for a in wk) / statistics.mean(net(a) for a in stk))
    rhos.append(spearman([a.work for a in wk], [net(a) for a in wk]))
    earns = [a.earn for a in ags]; g20.append(gini(earns)); top.append(max(earns) / sum(earns))
    pools.append(E)
V['RUN-A'] = {'ratio': ratios, 'rho': rhos, 'gini': g20, 'top1': top, 'pool_used': pools,
              'staker_earn_mean': [statistics.mean(a.earn for a in by(run(s, 20, pop=BASEPOP)[0], 'A-2'))
                                   for s in SEEDS]}
V['RUN-B'] = {'note': 'NO ANALOGUE under verified formula: single weight, no work:stake split (F-1). '
                      'A pure staker earns 0 regardless (weight=0 without escrow work).'}

# NC-3 label shuffle on RUN-A
ags, _, _ = run(1, 20, pop=BASEPOP); wk = by(ags, 'A-1')
xs = [a.work for a in wk]; ys = [net(a) for a in wk]; rng = random.Random(99)
perm = []
for _ in range(100):
    xx = xs[:]; rng.shuffle(xx); perm.append(abs(spearman(xx, ys)))
V['NC-3'] = {'observed': spearman(xs, ys), 'perm95': sorted(perm)[94]}

# RUN-C sybil (P4): pure-stake sybils do NO work -> weight 0 -> earn 0. Pool is capped, so
# there is no pool at which stake-only sybils earn emissions. Break-even pool = infinite.
V['RUN-C'] = {
    'net_at_capped_pool': agg(lambda s: statistics.mean(
        net(a) for a in by(run(s, 3, pop={**BASEPOP, 'n_sybil': 1000})[0], 'A-3'))),
    'sybil_earn_mean': agg(lambda s: statistics.mean(
        a.earn for a in by(run(s, 3, pop={**BASEPOP, 'n_sybil': 1000})[0], 'A-3'))),
    'pool_used': run(1, 3, pop={**BASEPOP, 'n_sybil': 1000})[2],
    'break_even_pool_exact': 'infinite (weight=0 for zero-work agents; no stake pool, F-1)'}

# RUN-D wash (P5): self-escrow at exactly MinQualifyingVol; diversity gate = 1 buyer (1_000 bps).
V['RUN-D'] = {
    'net_per_era_at_capped_pool': agg(lambda s: statistics.mean(
        net(a) / 10 for a in by(run(s, 10, pop={**BASEPOP, 'n_wash': 2})[0], 'A-4'))),
    'gross_per_era': agg(lambda s: statistics.mean(
        a.earn / 10 for a in by(run(s, 10, pop={**BASEPOP, 'n_wash': 2})[0], 'A-4'))),
    'pool_used': run(1, 10, pop={**BASEPOP, 'n_wash': 2})[2]}

# RUN-E oracle collusion (P6): oracle bonus is INERT on-chain (best_score=0, F-5) -> uplift 0.
up = []
for s in SEEDS:
    ags, _, _ = run(s, 10, pop={**BASEPOP, 'n_oracle': 20}, collude_frac=0.2)
    col = statistics.mean(net(a) for a in by(ags, 'A-5'))
    ref = statistics.mean(net(a) for a in by(ags, 'A-1') if a.work == 500)
    up.append(col / ref - 1)
V['RUN-E'] = {'uplift': up,
              'note': 'oracle score bonus inert on-chain (OracleScoreProvider=(), best_score=0, F-5); '
                      'any residual delta is fee-model noise vs the 500-vol worker reference.'}

# RUN-F liveness (P7): 100 eras, lag stats
_, lags, _ = run(1, 100, pop=BASEPOP)
ok = [l for l in lags if l is not None]
V['RUN-F'] = {'settled': len(ok), 'p95_lag_frac': sorted(ok)[int(0.95 * len(ok)) - 1]}

# NC-2 zero-work
ags, _, _ = run(1, 5, pop={'workers': [], 'n_work': 0, 'n_stake': 50})
V['NC-2'] = {'worker_metric': 'undefined (no A-1 cohort)' if not by(ags, 'A-1') else 'FABRICATED'}

print(json.dumps(V, indent=1, default=str))
json.dump(V, open('experiments/sc-e1/SC-E1-phase0-v2-verdicts.json', 'w'), indent=1, default=str)
