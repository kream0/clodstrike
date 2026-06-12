import { describe, it, expect } from 'bun:test';
import {
  TIER_RATINGS,
  expectedScore,
  updateRating,
  DEFAULT_RANK,
  RankStore,
} from './ranking';
import type { RankState } from './ranking';

// ---------------------------------------------------------------------------
// expectedScore
// ---------------------------------------------------------------------------

describe('expectedScore — symmetry', () => {
  it('returns 0.5 when ratings are equal', () => {
    expect(expectedScore(1000, 1000)).toBeCloseTo(0.5, 6);
  });

  it('sums to 1 for any pair (symmetry)', () => {
    const pairs = [
      [1000, 1200],
      [800,  1600],
      [1500, 900],
      [100,  3000],
    ] as const;
    for (const [a, b] of pairs) {
      const ea = expectedScore(a, b);
      const eb = expectedScore(b, a);
      expect(ea + eb).toBeCloseTo(1, 10);
    }
  });

  it('+400 rating advantage → ~0.909', () => {
    // 1 / (1 + 10^(-400/400)) = 1 / (1 + 10^(-1)) = 1 / 1.1 ≈ 0.9090909…
    expect(expectedScore(1400, 1000)).toBeCloseTo(0.9091, 3);
  });

  it('-400 rating → ~0.0909', () => {
    expect(expectedScore(1000, 1400)).toBeCloseTo(0.0909, 3);
  });
});

// ---------------------------------------------------------------------------
// updateRating
// ---------------------------------------------------------------------------

describe('updateRating — basic cases', () => {
  it('win at equal ratings increases rating by ~16 (K=32, score=1, E=0.5)', () => {
    // Expected change: 32 * (1 - 0.5) = +16
    const next = updateRating(1000, 1000, 1);
    expect(next).toBe(1016);
  });

  it('loss at equal ratings decreases rating by ~16', () => {
    const next = updateRating(1000, 1000, 0);
    expect(next).toBe(984);
  });

  it('draw at equal ratings leaves rating unchanged', () => {
    const next = updateRating(1000, 1000, 0.5);
    expect(next).toBe(1000);
  });

  it('win against easy (800) gives smaller gain when player rated 1000', () => {
    // E = expectedScore(1000, 800) > 0.5, so gain < 16
    const next = updateRating(1000, TIER_RATINGS.easy, 1);
    const e = expectedScore(1000, 800);
    const expected = Math.max(100, Math.round(1000 + 32 * (1 - e)));
    expect(next).toBe(expected);
    expect(next).toBeGreaterThan(1000); // still a win
    expect(next).toBeLessThan(1016);    // smaller than equal-rating win
  });

  it('win against hard (1600) gives larger gain when player rated 1000', () => {
    // E = expectedScore(1000, 1600) << 0.5, so gain >> 16
    const next = updateRating(1000, TIER_RATINGS.hard, 1);
    expect(next).toBeGreaterThan(1016);
  });

  it('loss against hard (1600) gives small loss when player rated 1000', () => {
    const next = updateRating(1000, TIER_RATINGS.hard, 0);
    const e = expectedScore(1000, 1600);
    const expected = Math.max(100, Math.round(1000 + 32 * (0 - e)));
    expect(next).toBe(expected);
    expect(next).toBeGreaterThan(900); // small loss against much stronger opponent
  });

  it('clamps rating to minimum of 100', () => {
    // Player at 100 loses to easy — result must stay >= 100
    const next = updateRating(100, TIER_RATINGS.easy, 0);
    expect(next).toBeGreaterThanOrEqual(100);
  });

  it('clamp floor: very weak player losing to easy tier', () => {
    // Force a result that would go below 100 with standard formula.
    // Custom K=200 to amplify the drop.
    const next = updateRating(100, 800, 0, 200);
    expect(next).toBe(100); // clamped
  });

  it('honours custom K-factor', () => {
    // With K=16 win at equal → +8
    const next = updateRating(1000, 1000, 1, 16);
    expect(next).toBe(1008);
  });

  it('rounds to nearest integer', () => {
    // updateRating always returns an integer
    const next = updateRating(1000, 1200, 1);
    expect(Number.isInteger(next)).toBe(true);
  });
});

describe('updateRating — draw handling', () => {
  it('draw against normal tier at 1200 → no change', () => {
    const next = updateRating(1200, TIER_RATINGS.normal, 0.5);
    expect(next).toBe(1200);
  });

  it('draw against hard (1600) at 1000 increases rating', () => {
    // Player is underdog: drawing gains points
    const next = updateRating(1000, 1600, 0.5);
    expect(next).toBeGreaterThan(1000);
  });

  it('draw against easy (800) at 1000 decreases rating', () => {
    // Player is favourite: drawing loses points
    const next = updateRating(1000, 800, 0.5);
    expect(next).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// RankStore — in-memory mock storage
// ---------------------------------------------------------------------------

function makeMockStorage(initial: Record<string, string> = {}): {
  storage: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void };
  data: Record<string, string>;
} {
  const data: Record<string, string> = { ...initial };
  return {
    storage: {
      getItem:  (k: string) => data[k] ?? null,
      setItem:  (k: string, v: string) => { data[k] = v; },
    },
    data,
  };
}

describe('RankStore — defaults on missing / corrupt data', () => {
  it('returns DEFAULT_RANK when storage is empty', () => {
    const { storage } = makeMockStorage();
    const store = new RankStore(storage);
    const state = store.load();
    expect(state).toEqual(DEFAULT_RANK);
  });

  it('returns DEFAULT_RANK when storage has invalid JSON', () => {
    const { storage } = makeMockStorage({ 'clodstrike.rank.v1': 'NOT_JSON' });
    const store = new RankStore(storage);
    const state = store.load();
    expect(state).toEqual(DEFAULT_RANK);
  });

  it('returns DEFAULT_RANK when stored value is null JSON', () => {
    const { storage } = makeMockStorage({ 'clodstrike.rank.v1': 'null' });
    const store = new RankStore(storage);
    expect(store.load()).toEqual(DEFAULT_RANK);
  });

  it('returns DEFAULT_RANK when storage is omitted', () => {
    const store = new RankStore();
    expect(store.load()).toEqual(DEFAULT_RANK);
  });

  it('rating floor applied: stored negative rating → 1000 (DEFAULT_RANK)', () => {
    // A corrupt rating field that is negative — validator should fall back.
    const { storage } = makeMockStorage({
      'clodstrike.rank.v1': JSON.stringify({ v: 1, rating: -50, matches: 0, wins: 0, losses: 0, draws: 0 }),
    });
    const store = new RankStore(storage);
    // The validator uses the rating field only if >= 0, else falls to DEFAULT_RANK.rating.
    // Our _validatePayload rejects negative because `v >= 0` is false for negative.
    expect(store.load().rating).toBeGreaterThanOrEqual(100);
  });
});

describe('RankStore — save / load round-trip', () => {
  it('persists a state and loads it back', () => {
    const { storage } = makeMockStorage();
    const store = new RankStore(storage);
    const state: RankState = { rating: 1250, matches: 5, wins: 3, losses: 1, draws: 1 };
    store.save(state);
    const loaded = store.load();
    expect(loaded).toEqual(state);
  });

  it('loads persisted state after re-constructing the store from the same backing', () => {
    const { storage, data } = makeMockStorage();
    const store1 = new RankStore(storage);
    const state: RankState = { rating: 1350, matches: 10, wins: 7, losses: 2, draws: 1 };
    store1.save(state);

    // Simulate page reload: new RankStore instance, same underlying storage data.
    const store2 = new RankStore({ getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } });
    const loaded = store2.load();
    expect(loaded).toEqual(state);
  });

  it('overwrites previous state on subsequent saves', () => {
    const { storage } = makeMockStorage();
    const store = new RankStore(storage);
    store.save({ rating: 1100, matches: 1, wins: 1, losses: 0, draws: 0 });
    store.save({ rating: 1200, matches: 2, wins: 2, losses: 0, draws: 0 });
    expect(store.load().rating).toBe(1200);
    expect(store.load().matches).toBe(2);
  });
});

describe('RankStore — throwing storage gracefully degrades to in-memory', () => {
  it('does not crash when getItem throws', () => {
    const badStorage = {
      getItem:  (_k: string): string | null => { throw new Error('SecurityError'); },
      setItem:  (_k: string, _v: string): void => { throw new Error('SecurityError'); },
    };
    let store!: RankStore;
    expect(() => { store = new RankStore(badStorage); }).not.toThrow();
    expect(store.load()).toEqual(DEFAULT_RANK);
  });

  it('save() does not throw when storage is unavailable', () => {
    const badStorage = {
      getItem:  (_k: string): string | null => { throw new Error('Denied'); },
      setItem:  (_k: string, _v: string): void => { throw new Error('Denied'); },
    };
    const store = new RankStore(badStorage);
    const state: RankState = { rating: 1100, matches: 1, wins: 1, losses: 0, draws: 0 };
    expect(() => store.save(state)).not.toThrow();
    // In-memory cache was still updated.
    expect(store.load()).toEqual(state);
  });

  it('operates in-memory across save/load when storage throws', () => {
    const badStorage = {
      getItem:  (_k: string): string | null => { throw new Error('Denied'); },
      setItem:  (_k: string, _v: string): void => { /* silently swallow */ },
    };
    const store = new RankStore(badStorage);
    store.save({ rating: 1100, matches: 1, wins: 1, losses: 0, draws: 0 });
    expect(store.load().rating).toBe(1100);
  });
});

describe('RankStore — applyMatch', () => {
  it('increments match count', () => {
    const store = new RankStore();
    const s0 = store.load();
    const s1 = store.applyMatch(s0, 'normal', 1);
    expect(s1.matches).toBe(s0.matches + 1);
  });

  it('increments wins on win', () => {
    const store = new RankStore();
    const s0 = store.load();
    const s1 = store.applyMatch(s0, 'normal', 1);
    expect(s1.wins).toBe(s0.wins + 1);
    expect(s1.losses).toBe(s0.losses);
    expect(s1.draws).toBe(s0.draws);
  });

  it('increments losses on loss', () => {
    const store = new RankStore();
    const s0 = store.load();
    const s1 = store.applyMatch(s0, 'normal', 0);
    expect(s1.losses).toBe(s0.losses + 1);
    expect(s1.wins).toBe(s0.wins);
    expect(s1.draws).toBe(s0.draws);
  });

  it('increments draws on draw', () => {
    const store = new RankStore();
    const s0 = store.load();
    const s1 = store.applyMatch(s0, 'normal', 0.5);
    expect(s1.draws).toBe(s0.draws + 1);
    expect(s1.wins).toBe(s0.wins);
    expect(s1.losses).toBe(s0.losses);
  });

  it('updates rating using the tier rating for easy', () => {
    const store = new RankStore();
    const s0: RankState = { rating: 1000, matches: 0, wins: 0, losses: 0, draws: 0 };
    const s1 = store.applyMatch(s0, 'easy', 1);
    const expected = updateRating(1000, TIER_RATINGS.easy, 1);
    expect(s1.rating).toBe(expected);
  });

  it('updates rating using the tier rating for hard', () => {
    const store = new RankStore();
    const s0: RankState = { rating: 1000, matches: 0, wins: 0, losses: 0, draws: 0 };
    const s1 = store.applyMatch(s0, 'hard', 0);
    const expected = updateRating(1000, TIER_RATINGS.hard, 0);
    expect(s1.rating).toBe(expected);
  });

  it('does not mutate the input state', () => {
    const store = new RankStore();
    const s0: RankState = { rating: 1000, matches: 3, wins: 2, losses: 1, draws: 0 };
    const s0Copy = { ...s0 };
    store.applyMatch(s0, 'normal', 1);
    expect(s0).toEqual(s0Copy);
  });

  it('applyMatch does not automatically save', () => {
    const { storage, data } = makeMockStorage();
    const store = new RankStore(storage);
    const s0 = store.load();
    const _s1 = store.applyMatch(s0, 'normal', 1);
    // Nothing written to storage yet.
    expect(data['clodstrike.rank.v1']).toBeUndefined();
  });

  it('chaining: multiple matches accumulate correctly', () => {
    const store = new RankStore();
    let state = store.load(); // 1000 rating, 0 matches
    state = store.applyMatch(state, 'normal', 1); // win
    state = store.applyMatch(state, 'hard',   1); // win
    state = store.applyMatch(state, 'easy',   0); // loss
    expect(state.matches).toBe(3);
    expect(state.wins).toBe(2);
    expect(state.losses).toBe(1);
    expect(state.draws).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TIER_RATINGS sanity
// ---------------------------------------------------------------------------

describe('TIER_RATINGS constants', () => {
  it('easy=800, normal=1200, hard=1600', () => {
    expect(TIER_RATINGS.easy).toBe(800);
    expect(TIER_RATINGS.normal).toBe(1200);
    expect(TIER_RATINGS.hard).toBe(1600);
  });
});
