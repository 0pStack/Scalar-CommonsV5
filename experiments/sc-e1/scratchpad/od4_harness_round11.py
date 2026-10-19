#!/usr/bin/env python3
"""ROUND11 OD-4 verification harness — NOT the factory deliverable.

This file was written for ROUND11 analysis. It is NOT experiments/sc-e1/tests/
test_od4_pool_scaling.py (which does not exist), and it is NOT an OD-4
implementation in the sim (there is none).

Method:
  1. compute_weight / log2_scaled / diversity_score_bps / rank_bps_for /
     onboarding_boost_bps are COPIED VERBATIM from SC-E1-phase0-sim.py.
     Anchor test below proves this harness reproduces the published v2
     RUN-D wash figure (+1556.4082243577097) exactly. If the anchor fails,
     every number below is void.
  2. OD-4 mechanisms A/B/C are then layered as independently switchable flags,
     implemented from the RFC's own algebra (docs/rfcs/OD-4-pool-scaled-costs.md
     sections 3.1, 4.1, 5.1).
"""
import math, json, itertools, random, statistics

# ============ VERBATIM FROM SC-E1-phase0-sim.py (do not edit) ============
CMN = 1.0
TXFEE = 10 * CMN
COMPFEE = 100 * CMN
ESCROW_SIZE = 100 * CMN
BPS_SCALE = 10_000
SCORE_SCALE = 10_000
ALPHA = 4_000
BETA = 5_000
FLOOR_BPS = 1_000
ORACLE_BONUS_BPS = 2_000
UNIT_VOLUME = 10 * CMN
MAX_PROPS = 20
VELOCITY_BONUS_BPS = 3_000
MIN_QUAL = 50 * CMN
FULL_FLOOR_STAKE = 10_000 * CMN
TARGET_EMISSION_PER_AGENT = 10_000 * CMN
FLOOR_EMISSION_PER_ERA = 100_000 * CMN
INITIAL_EMISSIONS_PER_ERA = 1_000_000 * CMN


def emission_pool(agent_count):
    raw = TARGET_EMISSION_PER_AGENT * agent_count
    return min(INITIAL_EMISSIONS_PER_ERA, max(FLOOR_EMISSION_PER_ERA, raw))


def log2_scaled(vol, unit=UNIT_VOLUME):
    if vol == 0 or unit == 0:
        return 0
    ratio = int(vol * 1_000_000 / unit)
    if ratio == 0:
        return 0
    bits = ratio.bit_length()
    return min(SCORE_SCALE, max(0, bits - 19) * (SCORE_SCALE // 10))


def diversity_score_bps(unique_buyers):
    return {0: 0, 1: 1_000, 2: 3_000, 3: 6_000, 4: 8_000}.get(unique_buyers, 10_000)


def rank_bps_for(stake):
    return 12_000 if stake >= FULL_FLOOR_STAKE else 10_000


def onboarding_boost_bps(completions):
    return (10_000 - completions * 1_000) if completions < 10 else 0


def compute_weight(stake, vol, unique_buyers, gov_votes, hb, completions,
                   oracle_score=0, min_qual=MIN_QUAL):
    """VERBATIM except `min_qual` is a parameter instead of the module constant.
    That is the ONLY change, and it is exactly Mechanism A's lever (RFC 3).
    With min_qual=MIN_QUAL it is bit-identical to the sim."""
    if stake <= 0:
        return 0.0
    sqrt_stake = math.isqrt(int(stake))
    rank_bps = rank_bps_for(stake)
    has_heartbeat = hb >= 90
    raw_vol = log2_scaled(vol)
    div_bps = diversity_score_bps(unique_buyers)
    work_score = 0 if (raw_vol == 0 or div_bps == 0) else raw_vol * div_bps // SCORE_SCALE
    did_work = vol > 0
    is_active = did_work and has_heartbeat
    qualifies_for_floor = is_active and (min_qual == 0 or vol >= min_qual)
    effective_floor = FLOOR_BPS if qualifies_for_floor else 0
    gov_score = min(gov_votes, MAX_PROPS) * SCORE_SCALE // MAX_PROPS
    gov_contribution = (ALPHA * gov_score // SCORE_SCALE) if work_score > 0 else 0
    activity = min(BPS_SCALE, effective_floor + gov_contribution + BETA * work_score // SCORE_SCALE)
    base_weight = sqrt_stake * rank_bps / BPS_SCALE * activity / BPS_SCALE * hb / 100
    bonus = base_weight * oracle_score / BPS_SCALE * ORACLE_BONUS_BPS / BPS_SCALE
    weight_after_oracle = base_weight + bonus
    after_onboarding = weight_after_oracle * (10_000 + onboarding_boost_bps(completions)) / 10_000
    velocity_ratio = min(BPS_SCALE, vol * BPS_SCALE / stake) if stake > 0 else 0
    v_bonus = after_onboarding * velocity_ratio / BPS_SCALE * VELOCITY_BONUS_BPS / BPS_SCALE
    return after_onboarding + v_bonus


# ============ OD-4 CONFIG ============
class OD4:
    """Independently switchable mechanisms. All-off == published baseline.

    MECH A (RFC 3): min_qual = k_a * P  (pool-indexed MinQualifyingVol).
                     k_a = 5e-5 reproduces 50 CMN at the 1M ceiling pool.
    MECH B (RFC 4): completion fee = fee_bps(P)/10_000 * escrow value,
                     fee_bps(P) = clamp(base_bps * P/P_ref, 25, 2500).
                     2500 bps is the auto-params hard max (VC 2.2).
    MECH C (RFC 5.1): reward-space cap, per era: claimable <= fees burned that era.
    """
    def __init__(s, a=False, b=False, c=False, k_a=5e-5, base_bps=25.0,
                 p_ref=1_000_000.0, real_bps_fee=False):
        s.a, s.b, s.c = a, b, c
        s.k_a, s.base_bps, s.p_ref = k_a, base_bps, p_ref
        s.real_bps_fee = real_bps_fee   # F-3: use 25bps instead of flat 100 CMN

    def min_qual(s, P):
        return s.k_a * P if s.a else MIN_QUAL

    def fee_bps(s, P):
        if s.b:
            return min(2500.0, max(25.0, s.base_bps * P / s.p_ref))
        return s.base_bps if s.real_bps_fee else None   # None => flat COMPFEE


OFF = OD4()

# ============ SIM ============
class Ag:
    def __init__(s, aid, kind, stake, work=0.0, buyers=5):
        s.id = aid; s.kind = kind; s.stake = stake; s.work = work
        s.buyers = buyers
        s.earn = 0.0; s.fees = 0.0
        s.completions = 0
        s.hb = 100

    def vol(s):
        return s.work

    def gov_votes(s):
        return MAX_PROPS if s.kind in ('A-1', 'A-5') else 0


def run(seed, eras=20, pop=None, cfg=OFF, pool_override=None, wash_vol=None):
    rng = random.Random(seed)
    ags = []
    aid = itertools.count()
    pop = pop or {}
    for v in pop.get('workers', []):
        for _ in range(pop.get('n_work', 20)):
            ags.append(Ag(next(aid), 'A-1', 10_000 * CMN, work=v, buyers=5))
    for _ in range(pop.get('n_stake', 20)):
        ags.append(Ag(next(aid), 'A-2', 100_000 * CMN, buyers=0))
    for _ in range(pop.get('n_sybil', 0)):
        ags.append(Ag(next(aid), 'A-3', 100 * CMN, buyers=0))
    for _ in range(pop.get('n_wash', 0)):
        ags.append(Ag(next(aid), 'A-4', 10_000 * CMN, work=MIN_QUAL, buyers=1))
    for _ in range(pop.get('n_oracle', 0)):
        ags.append(Ag(next(aid), 'A-5', 10_000 * CMN, work=500 * CMN, buyers=5))

    agent_count = len(ags)
    E_era = pool_override if pool_override is not None else emission_pool(agent_count)
    mq = cfg.min_qual(E_era)
    fbps = cfg.fee_bps(E_era)

    # Washer volume choice. Baseline sim hardcodes MIN_QUAL (50). A rational washer
    # re-targets the *live* floor. wash_vol=None => track the floor (mq).
    for a in ags:
        if a.kind == 'A-4':
            a.work = mq if wash_vol is None else wash_vol

    lags = []
    for era in range(eras):
        era_fees = {}
        for a in ags:
            f = TXFEE                                    # heartbeat
            if a.vol() > 0:
                n_esc = max(1, int(a.vol() / ESCROW_SIZE))
                if fbps is None:
                    comp = n_esc * COMPFEE if a.kind == 'A-4' else n_esc * (COMPFEE / 2)
                else:
                    comp = a.vol() * fbps / 10_000.0     # bps of escrow value
                f += n_esc * (3 * TXFEE) + comp if a.kind == 'A-4' \
                    else n_esc * (1.5 * TXFEE) + comp
                a.completions += n_esc
            a.fees += f
            era_fees[a.id] = f
        Wq = [compute_weight(a.stake, a.vol(), a.buyers, a.gov_votes(), a.hb,
                             a.completions, min_qual=mq) for a in ags]
        tw = sum(Wq)
        for a, w in zip(ags, Wq):
            if tw > 0:
                gross = E_era * w / tw
                if cfg.c:
                    gross = min(gross, era_fees[a.id])   # RFC 5.1 reward-space cap
                a.earn += gross
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


WORK_GRADES = [100, 500, 1000, 2000, 5000]
BASEPOP = {'workers': WORK_GRADES, 'n_work': 20, 'n_stake': 100}
