#!/usr/bin/env python3
"""ROUND14 — before/after profitability under the governance-credit and alpha changes.

Built on the ROUND12 harness (`od4_harness_round12.py`), whose weight transcription is
re-derived here with ALPHA and the governance-credit rule as parameters. PART 0 anchors
against ROUND12's published §3.3 table bit-exactly before anything downstream runs, so a
broken transcription cannot silently produce a pretty table.

Two things change between BEFORE and AFTER:

  1. ALPHA 4,000 -> 1,500 bps        (runtime/src/lib.rs AutoInitialAlpha)
  2. governance credit semantics     (pallets/agents record_gov_vote + verifier)
       BEFORE: one held vote, redeemed MaxProposalsPerEra=20 times/era, for ever.
               Everyone who has ever voted once scores the full 20/20.
       AFTER:  credit = distinct LIVE referenda actually voted on this era, so the
               achievable maximum is R = the number of concurrently live referenda.
               This binds the washer and the honest agent EQUALLY — the fix is not
               an asymmetric penalty, it just stops 20 being free.

R is unknown until the chain is live (3 tracks configured), so it is swept over 1..5.

Run: python3 round14_sim.py
"""
import math

# ── Constants — same source transcription as ROUND12 ─────────────────────────
CMN = 1.0
BPS_SCALE = 10_000
SCORE_SCALE = 10_000

BETA = 5_000
FLOOR_BPS = 1_000
ORACLE_BONUS_BPS = 2_000            # inert (F-5)
UNIT_VOLUME = 10 * CMN
MAX_PROPS = 20                      # MaxProposalsPerEra — the gov_score DENOMINATOR
VELOCITY_BONUS_BPS = 3_000
MIN_QUAL = 50 * CMN
FULL_FLOOR_STAKE = 10_000 * CMN
MIN_AGREEMENT = 10 * CMN
COMPLETION_FEE_BPS = 25
INITIAL_EMISSIONS_PER_ERA = 1_000_000 * CMN
TXFEE = 10 * CMN                    # model-only assumption, inherited from MA-7

ALPHA_BEFORE = 4_000
ALPHA_AFTER = 1_500

WORK_GRADES = [100, 500, 1000, 2000, 5000]


def log2_scaled(vol, unit=UNIT_VOLUME):
    """pallets/emissions/src/lib.rs:672-684. Bit-length ladder, NOT a float log."""
    if vol == 0 or unit == 0:
        return 0
    ratio = int(vol * 1_000_000 / unit)
    if ratio == 0:
        return 0
    bits = ratio.bit_length()
    return min(SCORE_SCALE, max(0, bits - 19) * (SCORE_SCALE // 10))


def diversity_bps(unique_buyers):
    """pallets/emissions/src/lib.rs:686-695."""
    return {0: 0, 1: 1_000, 2: 3_000, 3: 6_000, 4: 8_000}.get(unique_buyers, 10_000)


def rank_bps_for(stake):
    return 12_000 if stake >= FULL_FLOOR_STAKE else 10_000


def onboarding_bps(completions):
    """pallets/emissions/src/lib.rs:306-310."""
    return (10_000 - completions * 1_000) if completions < 10 else 0


def weight(stake, vol, buyers, gov_votes, hb, completions, alpha,
           min_qual=MIN_QUAL, oracle_score=0):
    """compute_weight_cached — pallets/emissions/src/lib.rs STEP 1..11, alpha injected."""
    if stake <= 0:
        return 0.0
    sqrt_stake = math.isqrt(int(stake))
    rk = rank_bps_for(stake)
    has_hb = hb >= 90
    raw_vol = log2_scaled(vol)
    dv = diversity_bps(buyers)
    work_score = 0 if (raw_vol == 0 or dv == 0) else raw_vol * dv // SCORE_SCALE
    is_active = (vol > 0) and has_hb
    qualifies = is_active and (min_qual == 0 or vol >= min_qual)
    eff_floor = FLOOR_BPS if qualifies else 0
    gov_score = min(gov_votes, MAX_PROPS) * SCORE_SCALE // MAX_PROPS
    gov_contrib = (alpha * gov_score // SCORE_SCALE) if work_score > 0 else 0
    activity = min(BPS_SCALE, eff_floor + gov_contrib + BETA * work_score // SCORE_SCALE)
    base = sqrt_stake * rk / BPS_SCALE * activity / BPS_SCALE * hb / 100
    after_oracle = base + base * oracle_score / BPS_SCALE * ORACLE_BONUS_BPS / BPS_SCALE
    after_onb = after_oracle * (10_000 + onboarding_bps(completions)) / 10_000
    vratio = min(BPS_SCALE, vol * BPS_SCALE / stake) if stake > 0 else 0
    return after_onb + after_onb * vratio / BPS_SCALE * VELOCITY_BONUS_BPS / BPS_SCALE


# ── Honest steady-state population — the denominator the washer competes against ──
def honest_pop(gov):
    pop = []
    for v in WORK_GRADES:
        for _ in range(20):
            pop.append(dict(stake=10_000 * CMN, vol=v, buyers=5, gov=gov, hb=100, comp=99))
    for _ in range(100):
        pop.append(dict(stake=100_000 * CMN, vol=0, buyers=0, gov=0, hb=100, comp=99))
    return pop


def sigma_honest(alpha, gov):
    return sum(weight(h['stake'], h['vol'], h['buyers'], h['gov'], h['hb'], h['comp'], alpha)
               for h in honest_pop(gov))


def reward(stake, vol, buyers, gov, alpha, sigma, n_washers=1):
    w = weight(stake, vol, buyers, gov, 100, 99, alpha)
    tw = sigma + n_washers * w
    return (INITIAL_EMISSIONS_PER_ERA * w / tw if tw > 0 else 0.0), w


def washer(vol, buyers, gov, alpha, sigma, stake=10_000 * CMN):
    """Washer with `buyers` sybil counterparties. Capital = own stake + MinStake per sybil."""
    r, w = reward(stake, vol, buyers, gov, alpha, sigma)
    n_esc = max(1, buyers)
    cost = (TXFEE + n_esc * (3 * TXFEE)
            + vol * COMPLETION_FEE_BPS / BPS_SCALE
            + gov * TXFEE)
    capital = stake + buyers * 1_000 * CMN
    return dict(weight=w, reward=r, cost=cost, net=r - cost, capital=capital,
                per_1k=(r - cost) / capital * 1_000)


def honest(vol, gov, alpha, sigma, stake=10_000 * CMN):
    r, w = reward(stake, vol, 5, gov, alpha, sigma)
    cost = TXFEE + 3 * TXFEE + vol * COMPLETION_FEE_BPS / BPS_SCALE + gov * TXFEE
    return dict(weight=w, reward=r, cost=cost, net=r - cost, capital=stake,
                per_1k=(r - cost) / stake * 1_000)


# ===========================================================================
# PART 0 — ANCHOR against ROUND12 §3.3, published table. Must be exact.
# ===========================================================================
print("=" * 78)
print("PART 0 — ANCHOR: reproduce ROUND12 §3.3 at ALPHA=4000, gov=20")
print("=" * 78)

SIG_BEFORE = sigma_honest(ALPHA_BEFORE, MAX_PROPS)
print(f"  Sigma_honest (200 agents, steady state) = {SIG_BEFORE:,.4f}")

anchors = [
    ("honest worker, vol 100, 5 real buyers", honest(100, MAX_PROPS, ALPHA_BEFORE, SIG_BEFORE),
     90.27, 7701, 770.1),
    ("honest worker, vol 5,000, 5 real buyers", honest(5000, MAX_PROPS, ALPHA_BEFORE, SIG_BEFORE),
     138.00, 11836, 1183.6),
    ("washer, 1 sybil cp, no gov", washer(10_000, 1, 0, ALPHA_BEFORE, SIG_BEFORE),
     23.40, 2006, 182.3),
    ("washer, 1 sybil cp, farms gov", washer(10_000, 1, MAX_PROPS, ALPHA_BEFORE, SIG_BEFORE),
     85.80, 7286, 662.3),
    ("washer, 5 sybil cps, farms gov", washer(10_000, 5, MAX_PROPS, ALPHA_BEFORE, SIG_BEFORE),
     156.00, 13259, 883.9),
]
print(f"  {'strategy':<40} {'weight':>8} {'net/era':>11} {'per 1k cap':>11}  anchor")
ok = True
for name, d, aw, an, ap in anchors:
    hit = (abs(d['weight'] - aw) < 0.01 and abs(d['net'] - an) < 1.0
           and abs(d['per_1k'] - ap) < 0.1)
    ok &= hit
    print(f"  {name:<40} {d['weight']:>8.2f} {d['net']:>+11,.0f} {d['per_1k']:>11.1f}  "
          f"{'OK' if hit else 'MISS (%.2f/%.0f/%.1f)' % (aw, an, ap)}")
if not ok:
    raise SystemExit("ANCHOR FAILED — transcription does not reproduce ROUND12 §3.3")
print("  ✅ all five ROUND12 §3.3 anchors reproduced\n")


# ===========================================================================
# PART 1 — the denominator question (ROUND13 §4 / ROUND14 task 5)
# ===========================================================================
print("=" * 78)
print("PART 1 — honest gov_score at realistic referendum counts (denominator = 20)")
print("=" * 78)
print(f"  {'live referenda R':>16} | {'gov_score':>10} | {'gov_contrib @a=4000':>20} | "
      f"{'gov_contrib @a=1500':>20}")
for R in range(0, 6):
    gs = min(R, MAX_PROPS) * SCORE_SCALE // MAX_PROPS
    print(f"  {R:>16} | {gs:>10,} | {ALPHA_BEFORE * gs // SCORE_SCALE:>17,} bps | "
          f"{ALPHA_AFTER * gs // SCORE_SCALE:>17,} bps")
print(f"  {'20 (ceiling)':>16} | {SCORE_SCALE:>10,} | {ALPHA_BEFORE:>17,} bps | "
      f"{ALPHA_AFTER:>17,} bps")
print("\n  Activity budget is BPS_SCALE = 10,000. At R=3 and alpha=1,500 governance is")
print("  worth 225 bps = 2.25% of the budget, against 4,000 bps = 40% before.\n")


# ===========================================================================
# PART 2 — BEFORE vs AFTER profitability
# ===========================================================================
COHORTS = [
    ("honest, vol 100, 5 buyers", lambda a, s, g: honest(100, g, a, s)),
    ("honest, vol 1,000, 5 buyers", lambda a, s, g: honest(1000, g, a, s)),
    ("honest, vol 5,000, 5 buyers", lambda a, s, g: honest(5000, g, a, s)),
    ("washer, 1 sybil cp", lambda a, s, g: washer(10_000, 1, g, a, s)),
    ("washer, 5 sybil cps", lambda a, s, g: washer(10_000, 5, g, a, s)),
]

print("=" * 78)
print("PART 2 — BEFORE (alpha 4,000, gov credit 20/20 from one held vote)")
print("=" * 78)
print(f"  {'strategy':<28} {'weight':>8} {'reward':>11} {'cost':>9} {'net/era':>11} "
      f"{'per 1k cap':>11}")
before = {}
for name, fn in COHORTS:
    d = fn(ALPHA_BEFORE, SIG_BEFORE, MAX_PROPS)
    before[name] = d
    print(f"  {name:<28} {d['weight']:>8.2f} {d['reward']:>11,.0f} {d['cost']:>9,.0f} "
          f"{d['net']:>+11,.0f} {d['per_1k']:>11.1f}")

for R in (1, 2, 3, 5):
    sig = sigma_honest(ALPHA_AFTER, R)
    print()
    print("=" * 78)
    print(f"PART 2 — AFTER (alpha 1,500, gov credit = R = {R} distinct live referenda)")
    print("=" * 78)
    print(f"  {'strategy':<28} {'weight':>8} {'reward':>11} {'cost':>9} {'net/era':>11} "
          f"{'per 1k cap':>11}  {'Δ per 1k':>10}")
    for name, fn in COHORTS:
        d = fn(ALPHA_AFTER, sig, R)
        dp = d['per_1k'] - before[name]['per_1k']
        print(f"  {name:<28} {d['weight']:>8.2f} {d['reward']:>11,.0f} {d['cost']:>9,.0f} "
              f"{d['net']:>+11,.0f} {d['per_1k']:>11.1f}  {dp:>+10.1f}")

    w5 = washer(10_000, 5, R, ALPHA_AFTER, sig)['per_1k']
    h100 = honest(100, R, ALPHA_AFTER, sig)['per_1k']
    h5000 = honest(5000, R, ALPHA_AFTER, sig)['per_1k']
    print(f"  → strongest ring ({w5:.1f}/1k) vs low-vol honest ({h100:.1f}/1k): "
          f"{'ring still ahead' if w5 > h100 else 'HONEST NOW AHEAD'}")
    print(f"  → strongest ring ({w5:.1f}/1k) vs high-vol honest ({h5000:.1f}/1k): "
          f"{'ring ahead' if w5 > h5000 else 'honest ahead'}")


# ===========================================================================
# PART 3 — regressivity: who captures the governance term?
# ===========================================================================
print()
print("=" * 78)
print("PART 3 — the gov multiplier, before vs after (ROUND13 §2.4 regressivity)")
print("=" * 78)
print(f"  {'profile':<32} {'mult BEFORE':>12} {'mult AFTER R=3':>15}")
PROFILES = [
    ("minimal work @ MinQualifyingVol", 50, 1),
    ("washer: vol 10,000, 1 buyer", 10_000, 1),
    ("wash ring: vol 10,000, 5 buyers", 10_000, 5),
    ("honest low-vol: 100, 5 buyers", 100, 5),
    ("honest mid-vol: 1,000, 5 buyers", 1_000, 5),
    ("honest high-vol: 5,000, 5 buyers", 5_000, 5),
]
for name, vol, buyers in PROFILES:
    st = 10_000 * CMN
    w_no_b = weight(st, vol, buyers, 0, 100, 99, ALPHA_BEFORE)
    w_gov_b = weight(st, vol, buyers, MAX_PROPS, 100, 99, ALPHA_BEFORE)
    w_no_a = weight(st, vol, buyers, 0, 100, 99, ALPHA_AFTER)
    w_gov_a = weight(st, vol, buyers, 3, 100, 99, ALPHA_AFTER)
    mb = w_gov_b / w_no_b if w_no_b else float('nan')
    ma = w_gov_a / w_no_a if w_no_a else float('nan')
    print(f"  {name:<32} {mb:>11.2f}x {ma:>14.2f}x")
print("\n  Spread BEFORE (most-favoured / least-favoured profile) vs AFTER:")
mults_b, mults_a = [], []
for name, vol, buyers in PROFILES:
    st = 10_000 * CMN
    b0 = weight(st, vol, buyers, 0, 100, 99, ALPHA_BEFORE)
    a0 = weight(st, vol, buyers, 0, 100, 99, ALPHA_AFTER)
    if b0:
        mults_b.append(weight(st, vol, buyers, MAX_PROPS, 100, 99, ALPHA_BEFORE) / b0)
    if a0:
        mults_a.append(weight(st, vol, buyers, 3, 100, 99, ALPHA_AFTER) / a0)
print(f"    BEFORE: {max(mults_b):.2f}x / {min(mults_b):.2f}x = "
      f"{max(mults_b)/min(mults_b):.2f}x regressive spread")
print(f"    AFTER : {max(mults_a):.2f}x / {min(mults_a):.2f}x = "
      f"{max(mults_a)/min(mults_a):.2f}x regressive spread")


# ===========================================================================
# PART 4 — DECOMPOSITION. Which of the two changes moves which cohort?
#   The pool P is fixed (1e6/era at n>=100), so this is a share game: what
#   matters is each cohort's weight relative to Sigma, not its absolute weight.
#   gov_contribution is a FLAT additive term in the activity budget, so it is a
#   larger fraction of a low-activity agent's weight than a high-activity one's.
#   Shrinking it therefore redistributes share from low-activity to high-activity
#   agents — for attackers AND for honest low-volume agents alike.
# ===========================================================================
print()
print("=" * 78)
print("PART 4 — DECOMPOSITION: alpha cut vs credit-distinctness fix (R=3)")
print("=" * 78)
R = 3
SCEN = [
    ("BEFORE          (a=4000, gov=20)", ALPHA_BEFORE, MAX_PROPS),
    ("fix only        (a=4000, gov=3)", ALPHA_BEFORE, R),
    ("alpha only      (a=1500, gov=20)", ALPHA_AFTER, MAX_PROPS),
    ("BOTH  = shipped (a=1500, gov=3)", ALPHA_AFTER, R),
]
rows = [("honest, vol 100, 5 buyers", lambda a, s, g: honest(100, g, a, s)),
        ("honest, vol 1,000, 5 buyers", lambda a, s, g: honest(1000, g, a, s)),
        ("honest, vol 5,000, 5 buyers", lambda a, s, g: honest(5000, g, a, s)),
        ("washer, 1 sybil cp", lambda a, s, g: washer(10_000, 1, g, a, s)),
        ("washer, 5 sybil cps", lambda a, s, g: washer(10_000, 5, g, a, s))]
print(f"  {'scenario':<34}" + "".join(f"{n.split(',')[0][:9]:>11}" for n, _ in rows))
print(f"  {'(net per 1,000 CMN capital)':<34}" + "".join(
    f"{('v' + n.split('vol ')[1].split(',')[0][:5]) if 'vol' in n else (n.split()[-2] + 'cp'):>11}"
    for n, _ in rows))
for label, a, g in SCEN:
    sig = sigma_honest(a, g)
    print(f"  {label:<34}" + "".join(f"{fn(a, sig, g)['per_1k']:>11.1f}" for _, fn in rows))


# ===========================================================================
# PART 5 — what alpha holds the low-volume honest cohort whole at R=3?
# ===========================================================================
print()
print("=" * 78)
print("PART 5 — alpha that keeps honest low-vol whole at R=3 (NOT shipped — input only)")
print("=" * 78)
target = honest(100, MAX_PROPS, ALPHA_BEFORE, SIG_BEFORE)['per_1k']
print(f"  BEFORE honest vol-100 net per 1k capital = {target:.1f}")
print(f"  {'alpha':>7} | {'honest v100':>12} {'honest v5000':>13} {'ring 5cp':>10}")
best_a = None
for a in range(1000, 8001, 250):
    sig = sigma_honest(a, R)
    h = honest(100, R, a, sig)['per_1k']
    if best_a is None or abs(h - target) < abs(best_a[1] - target):
        best_a = (a, h)
    print(f"  {a:>7,} | {h:>12.1f} {honest(5000, R, a, sig)['per_1k']:>13.1f} "
          f"{washer(10_000, 5, R, a, sig)['per_1k']:>10.1f}")
print(f"\n  closest on this grid: alpha={best_a[0]:,} → {best_a[1]:.1f} vs target {target:.1f}")
print("  AlphaBounds at genesis are min=1,000 max=8,000 (pallets/auto-params/src/lib.rs),")
print("  so the whole of this grid is reachable by governance without a migration.")


# ===========================================================================
# PART 6 — THE DENOMINATOR is the strong lever, not alpha (ROUND14 task 5)
#   gov_score = min(votes, D) * SCORE_SCALE / D, with D = MaxProposalsPerEra.
#   At D=20 and R=3 live referenda an honest full participant scores 1,500/10,000
#   -- 15% of the scale -- no matter what alpha is. Re-tuning D is what makes the
#   term meaningful again. NOT CHANGED THIS ROUND: quantified for the maintainer.
# ===========================================================================
print()
print("=" * 78)
print("PART 6 — MaxProposalsPerEra denominator sweep (alpha = 1,500, R = 3, NOT shipped)")
print("=" * 78)


def weight_d(stake, vol, buyers, gov_votes, alpha, D, hb=100, completions=99):
    """Same as weight(), with the gov_score denominator D exposed."""
    sqrt_stake = math.isqrt(int(stake))
    rk = rank_bps_for(stake)
    raw_vol = log2_scaled(vol)
    dv = diversity_bps(buyers)
    work_score = 0 if (raw_vol == 0 or dv == 0) else raw_vol * dv // SCORE_SCALE
    qualifies = vol > 0 and hb >= 90 and vol >= MIN_QUAL
    eff_floor = FLOOR_BPS if qualifies else 0
    gov_score = min(gov_votes, D) * SCORE_SCALE // D
    gov_contrib = (alpha * gov_score // SCORE_SCALE) if work_score > 0 else 0
    activity = min(BPS_SCALE, eff_floor + gov_contrib + BETA * work_score // SCORE_SCALE)
    base = sqrt_stake * rk / BPS_SCALE * activity / BPS_SCALE * hb / 100
    after_onb = base * (10_000 + onboarding_bps(completions)) / 10_000
    vratio = min(BPS_SCALE, vol * BPS_SCALE / stake)
    return after_onb + after_onb * vratio / BPS_SCALE * VELOCITY_BONUS_BPS / BPS_SCALE


print(f"  {'D':>4} | {'gov_score @R=3':>14} {'gov_contrib':>12} | "
      f"{'honest v100':>12} {'honest v5000':>13} {'ring 5cp':>10}")
for D in (20, 10, 5, 4, 3, 2, 1):
    sig = sum(weight_d(h['stake'], h['vol'], h['buyers'], 3 if h['vol'] else 0,
                       ALPHA_AFTER, D) for h in honest_pop(3))

    def per1k(stake, vol, buyers, cps):
        w = weight_d(stake, vol, buyers, 3, ALPHA_AFTER, D)
        r = INITIAL_EMISSIONS_PER_ERA * w / (sig + w)
        n_esc = max(1, cps)
        c = TXFEE + n_esc * 3 * TXFEE + vol * COMPLETION_FEE_BPS / BPS_SCALE + 3 * TXFEE
        return (r - c) / (stake + (cps if cps > 1 else 0) * 1_000 * CMN) * 1_000

    gs = min(3, D) * SCORE_SCALE // D
    print(f"  {D:>4} | {gs:>14,} {ALPHA_AFTER * gs // SCORE_SCALE:>9,} bps | "
          f"{per1k(10_000 * CMN, 100, 5, 1):>12.1f} {per1k(10_000 * CMN, 5000, 5, 1):>13.1f} "
          f"{per1k(10_000 * CMN, 10_000, 5, 5):>10.1f}")
print("\n  BEFORE reference (honest v100 = 770.1 per 1k capital).")
