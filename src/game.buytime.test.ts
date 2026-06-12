import { describe, expect, test, afterEach } from 'bun:test';
import { Game } from './game';
import type { MatchOptions } from './game';
import { RULES, ECONOMY, WEAPONS } from './constants';
import { World } from './world';
import { DUST2 } from './maps/dust2';

// ---------------------------------------------------------------------------
// Helpers — mirror pattern from stats.test.ts
// ---------------------------------------------------------------------------

const DEFAULT_OPTS: MatchOptions = {
  playerTeam: 'CT',
  difficulty: 'normal',
  botsPerTeam: 4,
};

let _lastGame: Game | null = null;

function freshGame(): Game {
  _lastGame?.dispose();
  const world = new World(DUST2);
  const g = new Game(world, null);
  // Provide a player combatant before startMatch (mirrors game.test.ts pattern).
  const W = WEAPONS;
  const knife = { def: W.knife, ammo: 0, reserve: 0, reloading: false, reloadEnd: 0, nextFire: 0, shotsFired: 0 };
  const secondary = { def: W.usp, ammo: 12, reserve: 24, reloading: false, reloadEnd: 0, nextFire: 0, shotsFired: 0 };
  g.player = {
    id: 0, name: 'Player', team: 'CT', isPlayer: true,
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0,
    health: 100, armor: 0, helmet: false,
    alive: true, crouching: false, walking: false, onGround: true,
    inventory: { knife, secondary, primary: null, activeSlot: 'secondary' as const },
    money: ECONOMY.START_MONEY, kills: 0, deaths: 0,
    hasBomb: false, hasDefuseKit: false, tagSlowUntil: 0,
  };
  _lastGame = g;
  return g;
}

afterEach(() => {
  _lastGame?.dispose();
  _lastGame = null;
});

// ---------------------------------------------------------------------------
// canBuy phase gating
// ---------------------------------------------------------------------------

describe('canBuy — phase gating', () => {
  test('true during freeze phase', () => {
    const g = freshGame();
    g.startMatch(DEFAULT_OPTS);
    expect(g.phase).toBe('freeze');
    // Any game-time during freeze is allowed.
    expect(g.canBuy(0)).toBe(true);
    expect(g.canBuy(RULES.FREEZE_TIME - 0.1)).toBe(true);
  });

  test('true during live phase before BUY_TIME expires', () => {
    const g = freshGame();
    g.startMatch(DEFAULT_OPTS);
    // _freezeStartAt = 0 (default from _startRound(0)).
    // Advance through freeze into live.
    const liveNow = RULES.FREEZE_TIME + 0.1;
    g.update(liveNow, liveNow);
    expect(g.phase).toBe('live');

    // Well inside the 30 s window from freeze start.
    const inWindow = RULES.FREEZE_TIME + 10;
    expect(g.canBuy(inWindow)).toBe(true);
  });

  test('false during live phase after BUY_TIME expires', () => {
    const g = freshGame();
    g.startMatch(DEFAULT_OPTS);
    // _freezeStartAt = 0. Window ends at 0 + BUY_TIME = 30.
    const liveNow = RULES.FREEZE_TIME + 0.1;
    g.update(liveNow, liveNow);
    expect(g.phase).toBe('live');

    // 1 second past the window.
    const pastWindow = RULES.BUY_TIME + 1;
    g.update(pastWindow - liveNow, pastWindow);
    expect(g.canBuy(pastWindow)).toBe(false);
  });

  test('false during roundEnd phase', () => {
    const g = freshGame();
    g.startMatch(DEFAULT_OPTS);
    // Enter live.
    const liveNow = RULES.FREEZE_TIME + 0.1;
    g.update(liveNow, liveNow);
    // Kill all Ts to trigger roundEnd.
    for (const c of g.combatants) {
      if (c.team === 'T') { c.alive = false; c.health = 0; }
    }
    const roundEndNow = liveNow + 0.016;
    g.update(0.016, roundEndNow);
    expect(g.phase).toBe('roundEnd');
    expect(g.canBuy(roundEndNow)).toBe(false);
  });

  test('false during matchEnd phase', () => {
    const g = freshGame();
    g.startMatch(DEFAULT_OPTS);
    // Jump to matchEnd by overriding phase directly (public field).
    g.phase = 'matchEnd';
    expect(g.canBuy(0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canBuy boundary: exactly at and past BUY_TIME from freeze start
// ---------------------------------------------------------------------------

describe('canBuy — BUY_TIME boundary', () => {
  test('true at 1 ms before BUY_TIME expires', () => {
    const g = freshGame();
    g.startMatch(DEFAULT_OPTS);
    const liveNow = RULES.FREEZE_TIME + 0.1;
    g.update(liveNow, liveNow);

    // 1 ms (0.001 s) before the window closes.
    const almostExpired = RULES.BUY_TIME - 0.001;
    expect(g.canBuy(almostExpired)).toBe(true);
  });

  test('false at exactly BUY_TIME (window is strict <)', () => {
    const g = freshGame();
    g.startMatch(DEFAULT_OPTS);
    const liveNow = RULES.FREEZE_TIME + 0.1;
    g.update(liveNow, liveNow);

    // Exactly at the boundary: now === freezeStart + BUY_TIME → NOT < → false.
    expect(g.canBuy(RULES.BUY_TIME)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// purchase rejected after window — money unchanged
// ---------------------------------------------------------------------------

describe('buy() rejected after buy window', () => {
  test('buy returns false and money is unchanged after window expires', () => {
    const g = freshGame();
    g.startMatch(DEFAULT_OPTS);
    // Advance through freeze into live.
    const liveNow = RULES.FREEZE_TIME + 0.1;
    g.update(liveNow, liveNow);
    expect(g.phase).toBe('live');

    // Advance past the window.
    const pastWindow = RULES.BUY_TIME + 5;
    g.update(pastWindow - liveNow, pastWindow);

    g.player.money = 5000;
    const moneyBefore = g.player.money;

    const ok = g.buy(g.player, 'ak47', pastWindow);
    expect(ok).toBe(false);
    expect(g.player.money).toBe(moneyBefore); // unchanged
    expect(g.player.inventory.primary).toBeNull();
  });

  test('buy succeeds just before window and fails just after', () => {
    // Two separate game instances to test both sides cleanly.
    const g1 = freshGame();
    g1.startMatch(DEFAULT_OPTS);
    const live1 = RULES.FREEZE_TIME + 0.1;
    g1.update(live1, live1);

    const justBefore = RULES.BUY_TIME - 1; // 1 s before window closes
    g1.update(justBefore - live1, justBefore);
    g1.player.money = 5000;
    const ok1 = g1.buy(g1.player, 'm4a4', justBefore); // player is CT — CT-only rifle
    expect(ok1).toBe(true);
    g1.dispose();

    const g2 = freshGame();
    g2.startMatch(DEFAULT_OPTS);
    const live2 = RULES.FREEZE_TIME + 0.1;
    g2.update(live2, live2);

    const justAfter = RULES.BUY_TIME + 1; // 1 s after window closes
    g2.update(justAfter - live2, justAfter);
    g2.player.money = 5000;
    const ok2 = g2.buy(g2.player, 'm4a4', justAfter); // player is CT — CT-only rifle
    expect(ok2).toBe(false);
    g2.dispose();
  });
});

// ---------------------------------------------------------------------------
// Round 2: _freezeStartAt tracks per-round start correctly
// ---------------------------------------------------------------------------

describe('canBuy across rounds', () => {
  test('buy window in round 2 resets to new freeze start (not game-time 0)', () => {
    const g = freshGame();
    g.startMatch(DEFAULT_OPTS);

    // Advance round 1.
    const freeze1 = RULES.FREEZE_TIME + 0.1;
    g.update(freeze1, freeze1);
    for (const c of g.combatants) {
      if (c.team === 'T') { c.alive = false; c.health = 0; }
    }
    g.update(0.016, freeze1 + 0.016);
    const afterPause1 = freeze1 + RULES.ROUND_END_PAUSE + 1;
    g.update(RULES.ROUND_END_PAUSE + 1, afterPause1);

    // Round 2 started; _freezeStartAt should now equal afterPause1.
    expect(g.phase).toBe('freeze');
    expect(g.roundNumber).toBe(2);

    // Move into round 2 live.
    const r2Live = afterPause1 + RULES.FREEZE_TIME + 0.1;
    g.update(RULES.FREEZE_TIME + 0.1, r2Live);
    expect(g.phase).toBe('live');

    // Shortly after live start — still within the 30 s window from r2 freeze start.
    const inWindow = r2Live + 5;
    g.update(5, inWindow);
    expect(g.canBuy(inWindow)).toBe(true);

    // Past the 30 s window from round 2 freeze start.
    const r2WindowEnd = afterPause1 + RULES.BUY_TIME;
    const pastWindow = r2WindowEnd + 2;
    g.update(pastWindow - inWindow, pastWindow);
    expect(g.canBuy(pastWindow)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Match restart with monotonic clock — buy window must not be stale
// ---------------------------------------------------------------------------

describe('buy window works after match restart with monotonic clock', () => {
  test('canBuy true and buyTimeLeft ≈ 29 just after restart at now=450', () => {
    const g = freshGame();
    // Match 1: start at now=0 (default).
    g.startMatch(DEFAULT_OPTS, 0);
    expect(g.phase).toBe('freeze');

    // Simulate restart at monotonic clock now=450 (as if ~450 s elapsed in match 1).
    g.restart(DEFAULT_OPTS, 450);
    expect(g.phase).toBe('freeze');
    expect(g.roundNumber).toBe(1);

    // Immediately after restart the buy window should be open.
    expect(g.canBuy(451)).toBe(true);

    // buyTimeLeft at now=451 should be ~29 s (BUY_TIME=30, 1 s elapsed since freeze start 450).
    const btl = g.buyTimeLeft(451);
    expect(btl).toBeGreaterThan(28.5);
    expect(btl).toBeLessThanOrEqual(30);
  });
});

// ---------------------------------------------------------------------------
// Dead player cannot buy (alive gate in buy(), not canBuy())
// ---------------------------------------------------------------------------

describe('dead player cannot buy', () => {
  test('buy returns false when combatant is dead, regardless of buy window', () => {
    const g = freshGame();
    g.startMatch(DEFAULT_OPTS);
    // Still in freeze — buy window open.
    expect(g.phase).toBe('freeze');
    expect(g.canBuy(0)).toBe(true);

    g.player.alive  = false;
    g.player.health = 0;
    g.player.money  = 5000;

    const ok = g.buy(g.player, 'ak47', 0);
    expect(ok).toBe(false);
    expect(g.player.inventory.primary).toBeNull();
    expect(g.player.money).toBe(5000); // unchanged
  });
});
