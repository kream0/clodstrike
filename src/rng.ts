/**
 * rng.ts — Seeded PRNG streams for deterministic simulation.
 *
 * PRNG choice: mulberry32, a well-known 32-bit state generator by Tommy Ettinger.
 * Period: 2^32 ≈ 4 billion. Passes BigCrush, very fast, < 10 bytes state.
 * Source: https://gist.github.com/tommyettinger/46a874533244883189143505d203312c
 *
 * Stream derivation: each stream is seeded by mixing the masterSeed with a
 * distinct salt via a single fmix32 pass (same technique as MurmurHash3 finalizer).
 * Distinct integer salts guarantee independent, non-correlated streams for
 * any masterSeed.
 */

// ---------------------------------------------------------------------------
// mulberry32 PRNG factory
// ---------------------------------------------------------------------------

/**
 * Returns a mulberry32 random function seeded at `seed`.
 * The returned function returns values in [0, 1) like Math.random.
 */
export function mulberry32(seed: number): () => number {
  // Force 32-bit unsigned int (>>> 0) so the algorithm behaves the same
  // on all platforms regardless of JS engine integer handling.
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// fmix32 — avalanche-quality seed derivation (MurmurHash3 finalizer)
// ---------------------------------------------------------------------------

function fmix32(h: number): number {
  h = ((h ^ (h >>> 16)) * 0x85ebca6b) >>> 0;
  h = ((h ^ (h >>> 13)) * 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// ---------------------------------------------------------------------------
// RngStream — convenience wrapper around a mulberry32 instance
// ---------------------------------------------------------------------------

export class RngStream {
  private readonly _rng: () => number;

  constructor(seed: number) {
    this._rng = mulberry32(seed >>> 0);
  }

  /** Raw sample in [0, 1). */
  next(): number {
    return this._rng();
  }

  /** Uniform sample in [min, max). */
  nextRange(min: number, max: number): number {
    return min + this._rng() * (max - min);
  }

  /**
   * Spread sample in [−spread, +spread], triangle-distributed (sum of 2 uniforms).
   * Mirrors the semantics of math.ts::randSpread exactly:
   *   randSpread(s) = (Math.random() + Math.random() - 1) * s
   * We call next() twice to preserve the distribution shape (triangle, not uniform).
   */
  nextSpread(spread: number): number {
    return (this._rng() + this._rng() - 1) * spread;
  }

  /** Pick a uniformly random element from a readonly array. */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new RangeError('RngStream.pick: empty array');
    return arr[Math.floor(this._rng() * arr.length)]!;
  }

  /**
   * In-place Fisher-Yates shuffle. Returns the same array for chaining.
   * Deterministic given the same stream state at call time.
   */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this._rng() * (i + 1));
      const tmp = arr[i]!;
      arr[i] = arr[j]!;
      arr[j] = tmp;
    }
    return arr;
  }

  /** Returns true with probability p (clamped to [0, 1]). */
  chance(p: number): boolean {
    return this._rng() < p;
  }
}

// ---------------------------------------------------------------------------
// Stream salts — distinct fixed constants per stream
// ---------------------------------------------------------------------------
// Derived from fractional bits of phi × 2^32 so they're well-distributed.

const SALT_COMBAT       = 0x9e3779b9 | 0;  // phi
const SALT_BOT_AIM      = 0x6c62272e | 0;  // FNV offset basis low
const SALT_BOT_DECISION = 0x243f6a88 | 0;  // pi high
const SALT_BOT_NAV      = 0xb7e15163 | 0;  // e high
const SALT_ROUND        = 0x517cc1b7 | 0;  // ln(2) high

// ---------------------------------------------------------------------------
// GameRng — five independent streams derived from one masterSeed
// ---------------------------------------------------------------------------

export class GameRng {
  readonly combat:      RngStream;
  readonly botAim:      RngStream;
  readonly botDecision: RngStream;
  readonly botNav:      RngStream;
  readonly round:       RngStream;

  constructor(masterSeed: number) {
    const s = masterSeed >>> 0;
    this.combat      = new RngStream(fmix32((s ^ SALT_COMBAT)       >>> 0));
    this.botAim      = new RngStream(fmix32((s ^ SALT_BOT_AIM)      >>> 0));
    this.botDecision = new RngStream(fmix32((s ^ SALT_BOT_DECISION)  >>> 0));
    this.botNav      = new RngStream(fmix32((s ^ SALT_BOT_NAV)       >>> 0));
    this.round       = new RngStream(fmix32((s ^ SALT_ROUND)         >>> 0));
  }
}

// ---------------------------------------------------------------------------
// makeMatchSeed — non-replay default: one Math.random() draw
// ---------------------------------------------------------------------------

/**
 * Produce a master seed for a new non-recorded match.
 * In replay mode the caller injects the recorded seed instead.
 */
export function makeMatchSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}
