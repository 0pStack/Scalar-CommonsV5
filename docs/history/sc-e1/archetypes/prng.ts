/**
 * Deterministic seeded PRNG + seed derivation for the SC-E1 archetypes.
 *
 * Reproducibility is a protocol requirement (§10): "per-cohort RNG seeds in the
 * run manifest … a run that cannot be re-executed from its manifest alone does
 * not count." Every stochastic decision an archetype makes — backoff length,
 * work rate jitter, which counterparty, deliverable hashes — is drawn from one
 * of these generators, seeded from the manifest. No wall-clock, no `Math.random`,
 * no ambient entropy. Same manifest + same seed ⇒ byte-identical extrinsic stream.
 *
 * Algorithm: SplitMix64 over 64-bit BigInt lanes — small, well-distributed, and
 * trivially portable to any language a future re-implementation might use.
 */

const U64 = (x: bigint): bigint => BigInt.asUintN(64, x);

const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;
const MIX_A = 0xbf58476d1ce4e5b9n;
const MIX_B = 0x94d049bb133111ebn;

/** FNV-1a 64-bit offset basis / prime, used for string→seed folding. */
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

/** A deterministic SplitMix64 generator. */
export class Prng {
  private state: bigint;

  constructor(seed: bigint | number) {
    this.state = U64(BigInt(seed));
  }

  /** Next raw 64-bit value. */
  next(): bigint {
    this.state = U64(this.state + GOLDEN_GAMMA);
    let z = this.state;
    z = U64((z ^ (z >> 30n)) * MIX_A);
    z = U64((z ^ (z >> 27n)) * MIX_B);
    return U64(z ^ (z >> 31n));
  }

  /** Float in [0, 1) with 53 bits of resolution. */
  nextFloat(): number {
    return Number(this.next() >> 11n) / 2 ** 53;
  }

  /** Integer in [0, n). `n` must be a positive safe integer. */
  nextInt(n: number): number {
    if (n <= 0) throw new RangeError(`nextInt bound must be > 0, got ${n}`);
    return Number(this.next() % BigInt(n));
  }

  /** Backoff draw: an integer in [0, maxInclusive]. */
  nextBackoff(maxInclusive: number): number {
    return Number(this.next() % BigInt(maxInclusive + 1));
  }

  /** A `bytes`-long lowercase hex string (deterministic). Useful for 32-byte hashes. */
  nextHex(bytes: number): string {
    let out = '';
    let acc = 0n;
    let have = 0;
    while (out.length < bytes * 2) {
      if (have === 0) {
        acc = this.next();
        have = 8;
      }
      const byte = Number(acc & 0xffn);
      acc >>= 8n;
      have -= 1;
      out += byte.toString(16).padStart(2, '0');
    }
    return `0x${out.slice(0, bytes * 2)}`;
  }
}

/**
 * Fold a base seed plus a list of labels into a fresh 64-bit seed.
 *
 * This is how per-cohort and per-member seeds are derived from the single
 * manifest seed: `deriveSeed(runSeed, 'A-3', cohortIndex, memberIndex)`. The
 * fold is order-sensitive and collision-resistant enough for cohort separation;
 * it is NOT a cryptographic KDF and is not used for anything security-bearing.
 */
export function deriveSeed(base: bigint | number, ...labels: Array<string | number>): bigint {
  let h = U64(BigInt(base) ^ FNV_OFFSET);
  for (const label of labels) {
    const s = String(label);
    for (let i = 0; i < s.length; i += 1) {
      h = U64((h ^ BigInt(s.charCodeAt(i))) * FNV_PRIME);
    }
    // Separate labels so ('a','b') ≠ ('ab').
    h = U64(h + GOLDEN_GAMMA);
  }
  // Final avalanche via one SplitMix step.
  return new Prng(h).next();
}
