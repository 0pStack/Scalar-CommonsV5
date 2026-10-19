#!/usr/bin/env python3
"""check_lambda_scaling.py — P0-2 / protocol §8.2, HL-3.

Enumerate EVERY block-denominated constant in the runtime source and assert that
they all scale *uniformly* by the fast-era factor λ (lambda).

Why this matters (HL-3): the `sc-e1` fast-era preset shortens time by dividing
block-denominated durations by λ. If even a single constant does not divide
cleanly by λ, its fast-era value rounds and desynchronises from the rest — which
"invalidates all time-dependent results" (era settlement, bonding, dispute
windows, governance tracks, …). Uniform scaling therefore means: the mainnet
block-count of every block-denominated constant is an exact multiple of λ.

This script is source-of-truth-driven: it resolves the base time units from the
runtime itself (SECS_PER_BLOCK → MINUTES/HOURS/DAYS/ERA_BLOCKS) and evaluates
every `BlockNumber`-typed constant against them, so new constants are picked up
automatically with no hand-maintained list.

Usage:
    scripts/check_lambda_scaling.py                # λ = FAST_ERA_LAMBDA from chain_spec.rs (default 10)
    scripts/check_lambda_scaling.py --lambda 20    # override λ
    LAMBDA=6 scripts/check_lambda_scaling.py        # override λ via env

Exit code 0 = PASS (uniform), 1 = violations found. Intended as a `ci-fast` gate.
"""
from __future__ import annotations

import argparse
import ast
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RUNTIME_LIB = REPO_ROOT / "runtime" / "src" / "lib.rs"
TRACKS = REPO_ROOT / "runtime" / "src" / "governance" / "tracks.rs"
CHAIN_SPEC = REPO_ROOT / "node" / "src" / "chain_spec.rs"

# Base time units are derived from SECS_PER_BLOCK in the runtime. We resolve them
# from source rather than hardcoding, so a change to block time is reflected here.
BASE_ORDER = [
    "SECS_PER_BLOCK",
    "MILLISECS_PER_BLOCK",
    "SLOT_DURATION",
    "MINUTES",
    "HOURS",
    "DAYS",
    "ERA_BLOCKS",
]


class SafeEval(ast.NodeVisitor):
    """Evaluate an integer arithmetic expression over a fixed symbol table.

    Only names in `env`, integer literals, +, -, *, /, //, %, and parentheses are
    permitted. Anything else raises — we never exec arbitrary runtime source.
    """

    def __init__(self, env: dict[str, int]):
        self.env = env

    def visit(self, node):  # noqa: D102
        if isinstance(node, ast.Expression):
            return self.visit(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, int):
            return node.value
        if isinstance(node, ast.Name):
            if node.id in self.env:
                return self.env[node.id]
            raise ValueError(f"unknown symbol '{node.id}'")
        if isinstance(node, ast.BinOp):
            left, right = self.visit(node.left), self.visit(node.right)
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Sub):
                return left - right
            if isinstance(node.op, ast.Mult):
                return left * right
            if isinstance(node.op, (ast.Div, ast.FloorDiv)):
                return left // right
            if isinstance(node.op, ast.Mod):
                return left % right
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
            return -self.visit(node.operand)
        raise ValueError(f"unsupported expression node: {ast.dump(node)}")


def rust_expr_to_int(expr: str, env: dict[str, int]) -> int:
    """Evaluate a Rust integer expression (e.g. `HOURS * 6`) against `env`."""
    cleaned = expr.strip()
    cleaned = re.sub(r"//.*$", "", cleaned)            # strip trailing line comments
    cleaned = re.sub(r"(?<=\d)_(?=\d)", "", cleaned)   # 1_000 -> 1000 (digits only)
    cleaned = re.sub(r"\b(\d+)(u\d+|i\d+|usize|isize)\b", r"\1", cleaned)  # 6u64 -> 6
    cleaned = re.sub(r"\bas\s+\w+\b", "", cleaned)     # drop `as BlockNumber` casts
    cleaned = cleaned.strip().rstrip(";").strip()
    tree = ast.parse(cleaned, mode="eval")
    return SafeEval(env).visit(tree)


def resolve_base_units() -> dict[str, int]:
    """Resolve SECS_PER_BLOCK → MINUTES/HOURS/DAYS/ERA_BLOCKS from the runtime."""
    src = RUNTIME_LIB.read_text()
    env: dict[str, int] = {}
    for name in BASE_ORDER:
        m = re.search(rf"pub const {name}\s*:\s*[\w<>]+\s*=\s*([^;]+);", src)
        if not m:
            raise SystemExit(f"FATAL: base unit `{name}` not found in {RUNTIME_LIB}")
        env[name] = rust_expr_to_int(m.group(1), env)
    return env


def read_lambda() -> int:
    """λ precedence: --lambda flag > LAMBDA env > FAST_ERA_LAMBDA in chain_spec.rs."""
    parser = argparse.ArgumentParser(add_help=True, description=__doc__)
    parser.add_argument("--lambda", dest="lam", type=int, default=None)
    args, _ = parser.parse_known_args()
    if args.lam is not None:
        return args.lam
    if os.environ.get("LAMBDA"):
        return int(os.environ["LAMBDA"])
    m = re.search(r"pub const FAST_ERA_LAMBDA\s*:\s*u32\s*=\s*(\d+)", CHAIN_SPEC.read_text())
    if m:
        return int(m.group(1))
    return 10


# Constants counted in *eras* or *sessions*, not blocks — dimensionless counts
# that are NOT block-scaled by λ. Reported for completeness so nothing is silently
# dropped, but excluded from the uniform-scaling assertion.
ERA_DENOMINATED = {"SessionsPerEra", "BondingDuration", "SlashDeferDuration"}


def collect_block_constants(env: dict[str, int]) -> list[tuple[str, str, int, str]]:
    """Return (name, raw_expr, block_value, source) for every block-denominated const.

    Covers three forms found in the runtime:
      * `pub const NAME: BlockNumber = <expr>;`
      * `type NAME = ConstU32<{ <expr> }>;`   (block-typed associated consts)
      * `EpochDuration: u64 = <expr>;`         (BABE epoch length, in blocks)
      * ERA_BLOCKS multiples inside governance/tracks.rs TrackInfo periods
    """
    found: list[tuple[str, str, int, str]] = []

    lib = RUNTIME_LIB.read_text()
    # pub const NAME: BlockNumber = expr;
    for m in re.finditer(r"pub const (\w+)\s*:\s*BlockNumber\s*=\s*([^;]+);", lib):
        name, expr = m.group(1), m.group(2)
        found.append((name, expr.strip(), rust_expr_to_int(expr, env), "runtime/src/lib.rs"))
    # EpochDuration: u64 = ERA_BLOCKS as u64 / 2;  (block-denominated despite u64)
    for m in re.finditer(r"pub const (EpochDuration)\s*:\s*u64\s*=\s*([^;]+);", lib):
        name, expr = m.group(1), m.group(2)
        found.append((name, expr.strip(), rust_expr_to_int(expr, env), "runtime/src/lib.rs"))
    # type NAME = ConstU32<{ expr }>;  (e.g. VoteLockingPeriod, PendingUsernameExpiration)
    for m in re.finditer(r"type (\w+)\s*=\s*ConstU32<\{\s*([^}]+)\}>", lib):
        name, expr = m.group(1), m.group(2)
        try:
            val = rust_expr_to_int(expr, env)
        except ValueError:
            continue  # not a block-unit expression (unrelated ConstU32)
        found.append((name, expr.strip(), val, "runtime/src/lib.rs"))

    # governance/tracks.rs — ERA_BLOCKS is redefined locally as 3_600.
    tracks_src = TRACKS.read_text()
    tenv = dict(env)
    tm = re.search(r"const ERA_BLOCKS\s*:\s*u32\s*=\s*([^;]+);", tracks_src)
    if tm:
        tenv["ERA_BLOCKS"] = rust_expr_to_int(tm.group(1), tenv)
        found.append(("tracks::ERA_BLOCKS", tm.group(1).strip(), tenv["ERA_BLOCKS"],
                      "runtime/src/governance/tracks.rs"))
    for field in ("prepare_period", "decision_period", "confirm_period", "min_enactment_period"):
        for m in re.finditer(rf"{field}\s*:\s*([^,]+),", tracks_src):
            expr = m.group(1)
            if "ERA_BLOCKS" not in expr:
                continue
            found.append((f"track.{field}", expr.strip(),
                          rust_expr_to_int(expr, tenv),
                          "runtime/src/governance/tracks.rs"))
    return found


def main() -> int:
    lam = read_lambda()
    env = resolve_base_units()

    print("=" * 78)
    print(f"  Lambda (λ) fast-era uniform-scaling check   —   λ = {lam}")
    print("=" * 78)
    print("\nResolved base time units (from runtime source):")
    for name in BASE_ORDER:
        print(f"  {name:<20} = {env[name]:>10}")

    consts = collect_block_constants(env)
    consts.sort(key=lambda c: (c[3], c[0]))

    print(f"\nBlock-denominated constants enumerated: {len(consts)}")
    print(f"{'constant':<32}{'blocks':>10}{'/λ':>10}   uniform?")
    print("-" * 78)

    violations: list[str] = []
    for name, expr, blocks, _src in consts:
        clean = blocks % lam == 0
        scaled = blocks // lam
        mark = "ok" if clean else "NON-UNIFORM"
        print(f"{name:<32}{blocks:>10}{scaled:>10}   {mark}    ({expr})")
        if not clean:
            violations.append(
                f"{name} = {blocks} blocks is not divisible by λ={lam} "
                f"(remainder {blocks % lam}) — fast-era value would round"
            )

    # Era/session-denominated counts: enumerated for completeness, not λ-scaled.
    lib = RUNTIME_LIB.read_text()
    era_counts = []
    for name in ERA_DENOMINATED:
        m = re.search(rf"pub const {name}\s*:\s*[^=]+=\s*(\d+)", lib)
        if m:
            era_counts.append((name, int(m.group(1))))
    if era_counts:
        print("\nEra/session-denominated (dimensionless counts — NOT λ-scaled):")
        for name, val in era_counts:
            print(f"  {name:<30} = {val}")

    print("=" * 78)
    if violations:
        print(f"FAIL: {len(violations)} block-denominated constant(s) do NOT scale "
              f"uniformly by λ={lam}:")
        for v in violations:
            print(f"  ✗ {v}")
        print("\nHL-3: one unscaled block-denominated constant invalidates all "
              "time-dependent results. Pick a λ that divides every value above, "
              "or adjust the offending constant.")
        return 1

    print(f"PASS: all {len(consts)} block-denominated constants scale uniformly "
          f"by λ={lam}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
