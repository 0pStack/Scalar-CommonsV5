#!/usr/bin/env python3
"""ROUND13 magnitude check — gov_contribution as a fraction of the activity budget.

Analysis only. Reproduces the arithmetic of pallets/emissions/src/lib.rs:598-616
(gov_score / gov_contribution / activity) to size the governance-farming vector.
No runtime or pallet code is written or changed by this round.
"""
BPS_SCALE = 10_000
SCORE_SCALE = 10_000
ALPHA = 4_000        # InitialAlpha, runtime/src/lib.rs:1065
BETA = 5_000         # InitialBeta,  runtime/src/lib.rs:1066
FLOOR_BPS = 1_000    # InitialFloorBps, runtime/src/lib.rs:1067
MAX_PROPS = 20       # EmissionsMaxProposalsPerEra, runtime/src/lib.rs:1194


def log2_scaled(vol_cmn, unit_cmn=10):
    if vol_cmn == 0:
        return 0
    ratio = int(vol_cmn * 1_000_000 / unit_cmn)
    if ratio == 0:
        return 0
    return min(SCORE_SCALE, max(0, ratio.bit_length() - 19) * (SCORE_SCALE // 10))


DIV = {0: 0, 1: 1_000, 2: 3_000, 3: 6_000, 4: 8_000}


def diversity(b):
    return DIV.get(b, 10_000)


def activity(vol, buyers, gov_votes, min_qual=50):
    """emissions/src/lib.rs:598-616, STEP 5..7."""
    raw = log2_scaled(vol)
    dv = diversity(buyers)
    work_score = 0 if (raw == 0 or dv == 0) else raw * dv // SCORE_SCALE
    eff_floor = FLOOR_BPS if (vol > 0 and vol >= min_qual) else 0
    gov_score = min(gov_votes, MAX_PROPS) * SCORE_SCALE // MAX_PROPS
    gov_contrib = (ALPHA * gov_score // SCORE_SCALE) if work_score > 0 else 0
    return min(BPS_SCALE, eff_floor + gov_contrib + BETA * work_score // SCORE_SCALE), \
        work_score, gov_contrib


print("=" * 76)
print("1. gov_contribution ceiling")
print("=" * 76)
gs = min(MAX_PROPS, MAX_PROPS) * SCORE_SCALE // MAX_PROPS
gc = ALPHA * gs // SCORE_SCALE
print(f"  gov_votes = MaxProposalsPerEra = {MAX_PROPS}")
print(f"  gov_score        = min(votes,{MAX_PROPS}) * {SCORE_SCALE} / {MAX_PROPS} = {gs:,}")
print(f"  gov_contribution = alpha({ALPHA:,}) * gov_score / {SCORE_SCALE}      = {gc:,} bps")
print(f"  as a fraction of BPS_SCALE ({BPS_SCALE:,})                    = {100*gc/BPS_SCALE:.0f}%")
print(f"  votes needed for the FULL {gc:,} bps: {MAX_PROPS} (one per era, capped)")
print(f"  marginal bps per record_gov_vote call: {gc/MAX_PROPS:.0f} bps")

print()
print("=" * 76)
print("2. effect on weight, by agent profile (activity enters weight LINEARLY,")
print("   so activity ratio == weight ratio exactly)")
print("=" * 76)
print(f"  {'profile':<38} {'no gov':>8} {'gov=20':>8} {'ratio':>7} {'pre-clamp':>10}")
profiles = [
    ("minimal work @ MinQualifyingVol, 1 buyer", 50, 1),
    ("ROUND12 washer: vol 10,000, 1 buyer", 10_000, 1),
    ("wash ring: vol 10,000, 5 buyers", 10_000, 5),
    ("honest low-vol: 100, 5 buyers", 100, 5),
    ("honest mid-vol: 1,000, 5 buyers", 1_000, 5),
    ("honest high-vol: 5,000, 5 buyers", 5_000, 5),
]
rows = []
for name, vol, buyers in profiles:
    a0, ws, _ = activity(vol, buyers, 0)
    a1, _, gc1 = activity(vol, buyers, MAX_PROPS)
    uncapped = FLOOR_BPS + gc1 + BETA * ws // SCORE_SCALE
    rows.append((name, a0, a1, a1 / a0, uncapped))
    flag = f"{uncapped:,}" + ("*" if uncapped >= BPS_SCALE else "")
    print(f"  {name:<38} {a0:>8,} {a1:>8,} {a1/a0:>6.2f}x {flag:>10}")
print("  (* = activity clamped at BPS_SCALE=10,000; gov credit is what pushes it there)")

print()
print("  KEY: the multiplier is REGRESSIVE in real work — the less genuine work an")
print("  agent does, the more the +4,000 bps is worth to it:")
lo = rows[0][3]
hi = rows[-1][3]
print(f"    minimal-work agent  : {lo:.2f}x")
print(f"    honest high-vol agent: {hi:.2f}x  (activity clamped at BPS_SCALE)")
print(f"    ratio of benefit     : {lo/hi:.2f}x more valuable to the minimal-work agent")

print()
print("=" * 76)
print("3. cost of the vector")
print("=" * 76)
print("  one-time : 1 x conviction_voting::vote() on any ongoing referendum.")
print("             try_vote (conviction-voting/src/lib.rs:418-425) checks only")
print("             `vote.balance() <= total_balance(who)` — NO minimum vote balance,")
print("             so balance may be ~0 and Conviction::None locks nothing.")
print(f"  per era  : up to {MAX_PROPS} x record_gov_vote() extrinsic fees.")
print("  recurring capital cost: ZERO. The vote is never required to be removed,")
print("  and votes leave VotingFor only via an explicit remove_vote() by the voter")
print("  (conviction-voting/src/lib.rs:472-486). Poll completion does NOT prune it.")
