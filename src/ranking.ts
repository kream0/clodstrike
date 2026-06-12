/**
 * ranking.ts — Elo-style player rating for Clodstrike.
 *
 * Pure library module: NO imports from main.ts, game.ts, or hud.ts.
 * Storage is injected so tests can use in-memory mocks and non-DOM
 * contexts (test runner, private mode) never crash.
 */

import type { Difficulty } from './game';

// ---------------------------------------------------------------------------
// Tier ratings — the "opponent" Elo for each bot difficulty tier.
// ---------------------------------------------------------------------------

export const TIER_RATINGS: Record<Difficulty, number> = {
  easy:   800,
  normal: 1200,
  hard:   1600,
};

// ---------------------------------------------------------------------------
// Elo math
// ---------------------------------------------------------------------------

/**
 * Expected score for a player with `player` rating against an opponent
 * with `opponent` rating. Standard Elo formula: 1 / (1 + 10^((opp-p)/400)).
 * Returns a value in (0, 1).
 */
export function expectedScore(player: number, opponent: number): number {
  return 1 / (1 + Math.pow(10, (opponent - player) / 400));
}

/**
 * Compute the new rating after one match result.
 *
 * @param current  - current player rating
 * @param opponent - opponent rating (use TIER_RATINGS[difficulty])
 * @param score    - 1 = win, 0.5 = draw, 0 = loss
 * @param k        - K-factor (default 32)
 * @returns new rating, rounded to nearest integer, clamped to >= 100
 */
export function updateRating(
  current: number,
  opponent: number,
  score: 0 | 0.5 | 1,
  k = 32,
): number {
  const expected = expectedScore(current, opponent);
  const raw = current + k * (score - expected);
  return Math.max(100, Math.round(raw));
}

// ---------------------------------------------------------------------------
// RankState
// ---------------------------------------------------------------------------

export interface RankState {
  rating:  number;
  matches: number;
  wins:    number;
  losses:  number;
  draws:   number;
}

export const DEFAULT_RANK: RankState = {
  rating:  1000,
  matches: 0,
  wins:    0,
  losses:  0,
  draws:   0,
};

// ---------------------------------------------------------------------------
// RankStore
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'clodstrike.rank.v1';

/**
 * Minimal Storage subset needed by RankStore.
 * Matches the browser Storage interface for localStorage/sessionStorage
 * but allows injection of test doubles.
 */
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export class RankStore {
  private _storage: StorageLike | null;
  /** In-memory cache: loaded at construction, kept in sync with storage writes. */
  private _cached: RankState;

  /**
   * @param storage  Optional storage backend. Pass `localStorage` in production.
   *                 When omitted or when the provided storage throws, the store
   *                 operates in-memory for the session without crashing.
   */
  constructor(storage?: StorageLike) {
    // Verify the storage is usable by attempting a round-trip probe.
    if (storage !== undefined) {
      try {
        storage.getItem(STORAGE_KEY); // probe read
        this._storage = storage;
      } catch {
        // Throws in private/sandboxed contexts — degrade gracefully.
        this._storage = null;
      }
    } else {
      this._storage = null;
    }

    this._cached = this._readFromStorage();
  }

  /** Load and return the current RankState (from cache — always fast). */
  load(): RankState {
    return { ...this._cached };
  }

  /** Persist the given state to storage (updates the in-memory cache too). */
  save(state: RankState): void {
    this._cached = { ...state };
    if (this._storage === null) return;
    try {
      const payload = JSON.stringify({ v: 1, ...state });
      this._storage.setItem(STORAGE_KEY, payload);
    } catch {
      // Quota exceeded or security error — stay silent, in-memory only.
    }
  }

  /**
   * Apply a completed match result to the given state.
   * Returns a NEW RankState — does NOT call save(); the caller decides when to persist.
   *
   * @param state      - current RankState
   * @param difficulty - bot difficulty tier of the completed match
   * @param score      - 1 = win, 0.5 = draw, 0 = loss
   */
  applyMatch(
    state: RankState,
    difficulty: Difficulty,
    score: 0 | 0.5 | 1,
  ): RankState {
    const tierRating = TIER_RATINGS[difficulty];
    const newRating = updateRating(state.rating, tierRating, score);

    const newState: RankState = {
      rating:  newRating,
      matches: state.matches + 1,
      wins:    state.wins    + (score === 1   ? 1 : 0),
      losses:  state.losses  + (score === 0   ? 1 : 0),
      draws:   state.draws   + (score === 0.5 ? 1 : 0),
    };

    return newState;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _readFromStorage(): RankState {
    if (this._storage === null) return { ...DEFAULT_RANK };
    try {
      const raw = this._storage.getItem(STORAGE_KEY);
      if (raw === null) return { ...DEFAULT_RANK };
      const parsed: unknown = JSON.parse(raw);
      return _validatePayload(parsed);
    } catch {
      return { ...DEFAULT_RANK };
    }
  }
}

/**
 * Validate a parsed JSON payload and return a sanitised RankState.
 * Falls back to DEFAULT_RANK for any field that is missing or invalid.
 */
function _validatePayload(raw: unknown): RankState {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_RANK };

  const obj = raw as Record<string, unknown>;

  function num(key: string, fallback: number): number {
    const v = obj[key];
    if (typeof v === 'number' && isFinite(v) && v >= 0) return v;
    return fallback;
  }

  return {
    rating:  Math.max(100, num('rating',  DEFAULT_RANK.rating)),
    matches: num('matches', DEFAULT_RANK.matches),
    wins:    num('wins',    DEFAULT_RANK.wins),
    losses:  num('losses',  DEFAULT_RANK.losses),
    draws:   num('draws',   DEFAULT_RANK.draws),
  };
}
