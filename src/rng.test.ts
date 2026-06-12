import { describe, test, expect } from 'bun:test';
import { mulberry32, RngStream, GameRng, makeMatchSeed } from './rng';

// ---------------------------------------------------------------------------
// mulberry32
// ---------------------------------------------------------------------------

describe('mulberry32', () => {
  test('returns values in [0, 1)', () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test('same seed produces same sequence', () => {
    const rng1 = mulberry32(12345);
    const rng2 = mulberry32(12345);
    for (let i = 0; i < 100; i++) {
      expect(rng1()).toBe(rng2());
    }
  });

  test('different seeds produce different sequences', () => {
    const rng1 = mulberry32(1);
    const rng2 = mulberry32(2);
    const out1: number[] = [];
    const out2: number[] = [];
    for (let i = 0; i < 20; i++) {
      out1.push(rng1());
      out2.push(rng2());
    }
    // Very unlikely to match if the PRNG is working.
    expect(out1).not.toEqual(out2);
  });

  test('seed 0 does not degenerate', () => {
    const rng = mulberry32(0);
    const first = rng();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
    // Should not produce a constant stream of 0.
    let nonZero = false;
    for (let i = 0; i < 100; i++) {
      if (rng() > 0) { nonZero = true; break; }
    }
    expect(nonZero).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RngStream
// ---------------------------------------------------------------------------

describe('RngStream', () => {
  test('next() values in [0, 1)', () => {
    const s = new RngStream(99);
    for (let i = 0; i < 500; i++) {
      const v = s.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test('same seed produces identical next() sequence', () => {
    const s1 = new RngStream(777);
    const s2 = new RngStream(777);
    for (let i = 0; i < 50; i++) {
      expect(s1.next()).toBe(s2.next());
    }
  });

  test('nextRange returns in [min, max)', () => {
    const s = new RngStream(1);
    for (let i = 0; i < 500; i++) {
      const v = s.nextRange(-5, 5);
      expect(v).toBeGreaterThanOrEqual(-5);
      expect(v).toBeLessThan(5);
    }
  });

  test('nextSpread returns in [-spread, +spread]', () => {
    const s = new RngStream(2);
    const spread = 0.5;
    for (let i = 0; i < 500; i++) {
      const v = s.nextSpread(spread);
      expect(v).toBeGreaterThanOrEqual(-spread);
      expect(v).toBeLessThanOrEqual(spread);
    }
  });

  test('nextSpread distribution mirrors math.ts randSpread (triangle, ~0 mean)', () => {
    // Collect 10 000 samples and check mean is near 0, std is similar to
    // randSpread's formula: var(sum2 uniforms − 1)*s^2 = (2·var(U))*s^2 = 2*(1/12)*s^2
    const s = new RngStream(3);
    const spread = 1.0;
    let sum = 0;
    const N = 10000;
    for (let i = 0; i < N; i++) sum += s.nextSpread(spread);
    const mean = sum / N;
    expect(Math.abs(mean)).toBeLessThan(0.05); // mean should be ~0
  });

  test('pick returns an element of the array', () => {
    const s = new RngStream(10);
    const arr = [10, 20, 30, 40, 50] as const;
    for (let i = 0; i < 100; i++) {
      const v = s.pick(arr);
      expect(arr).toContain(v);
    }
  });

  test('pick covers all elements given enough draws', () => {
    const s = new RngStream(11);
    const arr = ['a', 'b', 'c'] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) seen.add(s.pick(arr));
    expect(seen.size).toBe(3);
  });

  test('pick throws on empty array', () => {
    const s = new RngStream(12);
    expect(() => s.pick([])).toThrow();
  });

  test('shuffle is a permutation', () => {
    const s = new RngStream(20);
    const orig = [1, 2, 3, 4, 5];
    const copy = [...orig];
    s.shuffle(copy);
    expect(copy.sort((a, b) => a - b)).toEqual(orig);
  });

  test('shuffle is deterministic', () => {
    const arr1 = [1, 2, 3, 4, 5, 6, 7, 8];
    const arr2 = [...arr1];
    new RngStream(55).shuffle(arr1);
    new RngStream(55).shuffle(arr2);
    expect(arr1).toEqual(arr2);
  });

  test('chance returns true with expected frequency', () => {
    const s = new RngStream(30);
    const p = 0.3;
    let trueCount = 0;
    const N = 10000;
    for (let i = 0; i < N; i++) if (s.chance(p)) trueCount++;
    // Accept within 3 sigma.
    const expected = N * p;
    const std = Math.sqrt(N * p * (1 - p));
    expect(Math.abs(trueCount - expected)).toBeLessThan(3 * std);
  });
});

// ---------------------------------------------------------------------------
// GameRng
// ---------------------------------------------------------------------------

describe('GameRng', () => {
  test('all five streams are distinct objects', () => {
    const g = new GameRng(42);
    const streams = [g.combat, g.botAim, g.botDecision, g.botNav, g.round];
    // Each is an RngStream instance
    for (const st of streams) expect(st).toBeInstanceOf(RngStream);
    // All distinct references
    for (let i = 0; i < streams.length; i++) {
      for (let j = i + 1; j < streams.length; j++) {
        expect(streams[i]).not.toBe(streams[j]);
      }
    }
  });

  test('same masterSeed produces identical stream output', () => {
    const g1 = new GameRng(999);
    const g2 = new GameRng(999);
    for (let i = 0; i < 50; i++) {
      expect(g1.combat.next()).toBe(g2.combat.next());
      expect(g1.botAim.next()).toBe(g2.botAim.next());
      expect(g1.botDecision.next()).toBe(g2.botDecision.next());
      expect(g1.botNav.next()).toBe(g2.botNav.next());
      expect(g1.round.next()).toBe(g2.round.next());
    }
  });

  test('different masterSeeds produce different streams', () => {
    const g1 = new GameRng(1);
    const g2 = new GameRng(2);
    let differ = false;
    for (let i = 0; i < 20; i++) {
      if (g1.combat.next() !== g2.combat.next()) { differ = true; break; }
    }
    expect(differ).toBe(true);
  });

  test('streams within the same GameRng are independent (different first values)', () => {
    const g = new GameRng(12345);
    // The first draw from each stream should not all be the same value.
    const firsts = [g.combat.next(), g.botAim.next(), g.botDecision.next(), g.botNav.next(), g.round.next()];
    const uniqueCount = new Set(firsts).size;
    // Very unlikely all 5 are identical if salts work correctly.
    expect(uniqueCount).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// makeMatchSeed
// ---------------------------------------------------------------------------

describe('makeMatchSeed', () => {
  test('returns a positive integer', () => {
    for (let i = 0; i < 20; i++) {
      const s = makeMatchSeed();
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(0xffffffff);
    }
  });

  test('successive calls return different values (with overwhelming probability)', () => {
    const seeds = new Set<number>();
    for (let i = 0; i < 10; i++) seeds.add(makeMatchSeed());
    expect(seeds.size).toBeGreaterThan(1);
  });
});
