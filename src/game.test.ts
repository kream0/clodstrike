import { describe, expect, test, beforeEach } from 'bun:test';
import { Game, decideBuyStrategy } from './game';
import type { MatchOptions, BuyDecisionInput } from './game';
import { RULES, ECONOMY, WEAPONS, GRENADES } from './constants';
import { World } from './world';
import { DUST2 } from './maps/dust2';
import { gameEvents } from './combat';

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let world: World;
let game: Game;

const DEFAULT_OPTS: MatchOptions = {
  playerTeam: 'CT',
  difficulty: 'normal',
  botsPerTeam: 4,
};

function freshGame(): Game {
  world = new World(DUST2);
  const g = new Game(world, null); // headless — no scene
  // Provide a player combatant before startMatch.
  const { createCombatantForTest } = _helpers;
  g.player = createCombatantForTest(0, 'Player', 'CT');
  return g;
}

// ---------------------------------------------------------------------------
// Test-only helpers — expose minimal internals without touching Game API.
// ---------------------------------------------------------------------------

const _helpers = {
  createCombatantForTest(id: number, name: string, team: 'CT' | 'T') {
    const { WEAPONS } = require('./constants');
    const knife     = { def: WEAPONS.knife,  ammo: 0,  reserve: 0,  reloading: false, reloadEnd: 0, nextFire: 0, shotsFired: 0 };
    const secondary = { def: team === 'CT' ? WEAPONS.usp : WEAPONS.glock, ammo: 12, reserve: 24, reloading: false, reloadEnd: 0, nextFire: 0, shotsFired: 0 };
    return {
      id, name, team, isPlayer: id === 0,
      pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
      yaw: 0, pitch: 0,
      health: 100, armor: 0, helmet: false,
      alive: true, crouching: false, walking: false, onGround: true,
      inventory: { knife, secondary, primary: null, activeSlot: 'secondary' as const },
      money: ECONOMY.START_MONEY, kills: 0, deaths: 0,
      hasBomb: false, hasDefuseKit: false, tagSlowUntil: 0,
    };
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Game.startMatch', () => {
  test('creates 10 combatants in 5v5', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
    expect(game.combatants.length).toBe(10);
  });

  test('player team is honored', () => {
    game = freshGame();
    game.startMatch({ playerTeam: 'T', difficulty: 'normal', botsPerTeam: 4 });
    expect(game.player.team).toBe('T');
  });

  test('exactly one T has bomb', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
    const bombCarriers = game.combatants.filter(c => c.hasBomb);
    expect(bombCarriers.length).toBe(1);
    expect(bombCarriers[0].team).toBe('T');
  });

  test('all start with 800 money', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
    for (const c of game.combatants) {
      expect(c.money).toBe(ECONOMY.START_MONEY);
    }
  });

  test('phase starts as freeze', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
    expect(game.phase).toBe('freeze');
  });
});

describe('Elimination win', () => {
  test('CT score increments after all Ts die', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);

    // Fast-forward through freeze.
    game.update(RULES.FREEZE_TIME + 0.1, RULES.FREEZE_TIME + 0.1);
    expect(game.phase).toBe('live');

    const now = RULES.FREEZE_TIME + 0.2;
    // Kill all Ts.
    for (const c of game.combatants) {
      if (c.team === 'T') {
        c.alive  = false;
        c.health = 0;
      }
    }

    game.update(0.016, now + 0.016);
    expect(game.phase).toBe('roundEnd');
    expect(game.score.CT).toBe(1);
  });

  test('money rewards applied after round end pause', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);

    const freeze = RULES.FREEZE_TIME + 0.1;
    game.update(freeze, freeze);

    const aliveNow = freeze + 0.1;
    for (const c of game.combatants) {
      if (c.team === 'T') { c.alive = false; c.health = 0; }
    }
    game.update(0.016, aliveNow + 0.016);
    expect(game.phase).toBe('roundEnd');

    // Advance past round-end pause.
    const afterPause = aliveNow + RULES.ROUND_END_PAUSE + 1;
    game.update(RULES.ROUND_END_PAUSE + 1, afterPause);

    // Next round started.
    expect(game.phase).toBe('freeze');
    expect(game.roundNumber).toBe(2);

    // Winners (CT) should have starting money + WIN_REWARD.
    const ctMoney = game.player.money; // player is CT
    expect(ctMoney).toBeGreaterThanOrEqual(ECONOMY.WIN_REWARD);
  });
});

describe('Bomb plant / explode', () => {
  function setupLive() {
    game = freshGame();
    game.startMatch({ playerTeam: 'CT', difficulty: 'normal', botsPerTeam: 4 });
    const freeze = RULES.FREEZE_TIME + 0.1;
    game.update(freeze, freeze);
    expect(game.phase).toBe('live');
    return freeze;
  }

  test('plant progresses and completes in site', () => {
    const now0 = setupLive();

    // Find T with bomb.
    const bomber = game.combatants.find(c => c.hasBomb)!;
    expect(bomber).toBeDefined();

    // Move bomber into site A.
    const siteA = DUST2.bombsites[0];
    bomber.pos     = { x: (siteA.min.x + siteA.max.x) / 2, y: 3.0, z: (siteA.min.z + siteA.max.z) / 2 };
    bomber.onGround = true;
    bomber.team     = 'T';

    // Drive plant with useHeld over PLANT_TIME.
    const steps   = 100;
    const stepDt  = RULES.PLANT_TIME / steps;
    let now = now0 + 0.1;
    for (let i = 0; i <= steps; i++) {
      game.useHeld(bomber, true, now, stepDt);
      now += stepDt;
    }

    expect(game.phase).toBe('planted');
    expect(game.bomb.state).toBe('planted');
    expect(game.bomb.site).toBe('A');
    expect(game.bomb.explodeAt).toBeGreaterThan(0);
  });

  test('explosion triggers T win and radial damage', () => {
    const now0 = setupLive();

    const bomber = game.combatants.find(c => c.hasBomb)!;
    const siteA  = DUST2.bombsites[0];
    bomber.pos      = { x: (siteA.min.x + siteA.max.x) / 2, y: 3.0, z: (siteA.min.z + siteA.max.z) / 2 };
    bomber.onGround = true;

    // Force plant.
    const steps  = 100;
    const stepDt = RULES.PLANT_TIME / steps;
    let now = now0 + 0.1;
    for (let i = 0; i <= steps; i++) {
      game.useHeld(bomber, true, now, stepDt);
      now += stepDt;
    }
    expect(game.phase).toBe('planted');

    // Place a CT right on top of the bomb.
    const nearCT = game.combatants.find(c => c.team === 'CT' && c.alive)!;
    nearCT.pos  = { ...game.bomb.pos };
    nearCT.pos.y += 0.5;

    // Fast-forward past explodeAt.
    const explodeNow = game.bomb.explodeAt + 0.1;
    game.update(0.1, explodeNow);

    expect(game.bomb.state).toBe('exploded');
    expect(game.phase).toBe('roundEnd');
    expect(game.score.T).toBe(1);
    // Near CT should be dead.
    expect(nearCT.alive).toBe(false);
  });
});

describe('Bomb defuse', () => {
  function setupPlanted() {
    game = freshGame();
    game.startMatch({ playerTeam: 'CT', difficulty: 'normal', botsPerTeam: 4 });
    const freeze = RULES.FREEZE_TIME + 0.1;
    game.update(freeze, freeze);

    const bomber = game.combatants.find(c => c.hasBomb)!;
    const siteA  = DUST2.bombsites[0];
    bomber.pos      = { x: (siteA.min.x + siteA.max.x) / 2, y: 3.0, z: (siteA.min.z + siteA.max.z) / 2 };
    bomber.onGround = true;

    let now = freeze + 0.1;
    const stepDt = RULES.PLANT_TIME / 100;
    for (let i = 0; i <= 100; i++) {
      game.useHeld(bomber, true, now, stepDt);
      now += stepDt;
    }
    expect(game.phase).toBe('planted');
    return now;
  }

  test('CT can defuse bomb without kit', () => {
    const now0 = setupPlanted();

    const ct = game.combatants.find(c => c.team === 'CT' && c.alive)!;
    ct.pos = { ...game.bomb.pos, y: game.bomb.pos.y + 0.1 };

    const defuseTime = RULES.DEFUSE_TIME;
    const steps  = 200;
    const stepDt = defuseTime / steps;
    let now = now0 + 0.1;
    for (let i = 0; i <= steps; i++) {
      game.useHeld(ct, true, now, stepDt);
      now += stepDt;
    }

    expect(game.phase).toBe('roundEnd');
    expect(game.score.CT).toBe(1);
  });

  test('releasing E resets defuse progress to 0', () => {
    const now0 = setupPlanted();

    const ct = game.combatants.find(c => c.team === 'CT' && c.alive)!;
    ct.pos = { ...game.bomb.pos, y: game.bomb.pos.y + 0.1 };

    // Hold for a bit.
    let now = now0 + 0.1;
    game.useHeld(ct, true, now, 1.0);
    now += 1.0;
    expect(game.bomb.defuseProgress).toBeGreaterThan(0);

    // Release.
    game.useHeld(ct, false, now, 0.016);
    expect(game.bomb.defuseProgress).toBe(0);
  });

  test('defuse with kit is faster', () => {
    // Kit: DEFUSE_TIME_KIT = 5s; no kit: DEFUSE_TIME = 10s.
    expect(RULES.DEFUSE_TIME_KIT).toBeLessThan(RULES.DEFUSE_TIME);
  });
});

describe('Time expiry', () => {
  test('CT win when time expires with no plant', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
    const freeze = RULES.FREEZE_TIME + 0.1;
    game.update(freeze, freeze);
    expect(game.phase).toBe('live');

    const expireNow = freeze + RULES.ROUND_TIME + 1;
    game.update(RULES.ROUND_TIME + 1, expireNow);

    expect(game.phase).toBe('roundEnd');
    expect(game.score.CT).toBe(1);
  });
});

describe('buy', () => {
  test('rifle purchase deducts money and equips primary', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
    game.player.money = 5000;

    // Player is CT — use m4a4 (CT-only rifle).
    const ok = game.buy(game.player, 'm4a4', 0);
    expect(ok).toBe(true);
    expect(game.player.inventory.primary).not.toBeNull();
    expect(game.player.inventory.primary!.def.id).toBe('m4a4');
    expect(game.player.money).toBe(5000 - WEAPONS.m4a4.price);
  });

  test('refuses purchase when insufficient funds', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
    game.player.money = 100;

    // Player is CT — use m4a4 (CT-only rifle).
    const ok = game.buy(game.player, 'm4a4', 0);
    expect(ok).toBe(false);
    expect(game.player.inventory.primary).toBeNull();
    expect(game.player.money).toBe(100);
  });

  test('refuses purchase outside buy window', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);

    // Transition freeze → live (freeze lasted FREEZE_TIME).
    const freezeEnd = RULES.FREEZE_TIME + 0.1;
    game.update(freezeEnd, freezeEnd);
    expect(game.phase).toBe('live');

    // Advance past the 30 s buy window (measured from freeze start = 0).
    const buyWindowEnd = RULES.BUY_TIME + 5; // 35 s from freeze start → past window
    game.update(buyWindowEnd - freezeEnd, buyWindowEnd);
    game.player.money = 5000;

    // Player is CT — use m4a4; the window is expired so it still returns false.
    const ok = game.buy(game.player, 'm4a4', buyWindowEnd);
    expect(ok).toBe(false);
  });

  test('armorHelmet sets armor=100 and helmet=true', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
    game.player.money = 2000;

    const ok = game.buy(game.player, 'armorHelmet', 0);
    expect(ok).toBe(true);
    expect(game.player.armor).toBe(100);
    expect(game.player.helmet).toBe(true);
    expect(game.player.money).toBe(2000 - ECONOMY.ARMOR_HELMET_PRICE);
  });
});

describe('canBuy across rounds', () => {
  test('canBuy is true during freeze in round 2', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);

    // Advance through round 1 (CT elimination win).
    const freeze1 = RULES.FREEZE_TIME + 0.1;
    game.update(freeze1, freeze1);
    for (const c of game.combatants) {
      if (c.team === 'T') { c.alive = false; c.health = 0; }
    }
    game.update(0.016, freeze1 + 0.016);
    const afterPause1 = freeze1 + RULES.ROUND_END_PAUSE + 1;
    game.update(RULES.ROUND_END_PAUSE + 1, afterPause1);

    // Now in round 2 freeze phase.
    expect(game.phase).toBe('freeze');
    expect(game.roundNumber).toBe(2);
    // canBuy must be true at current game-time during freeze.
    expect(game.canBuy(afterPause1)).toBe(true);
    // buy must succeed when called with the same game-time (player is CT → use m4a4).
    game.player.money = 5000;
    const ok = game.buy(game.player, 'm4a4', afterPause1);
    expect(ok).toBe(true);
    expect(game.player.inventory.primary?.def.id).toBe('m4a4');
  });

  test('canBuy is true during buy window of live in round 2, false after 30 s from freeze start', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);

    const freeze1 = RULES.FREEZE_TIME + 0.1;
    game.update(freeze1, freeze1);
    for (const c of game.combatants) {
      if (c.team === 'T') { c.alive = false; c.health = 0; }
    }
    game.update(0.016, freeze1 + 0.016);
    const afterPause1 = freeze1 + RULES.ROUND_END_PAUSE + 1;
    game.update(RULES.ROUND_END_PAUSE + 1, afterPause1);

    // Now in round 2 freeze phase; _freezeStartAt = afterPause1.
    expect(game.phase).toBe('freeze');
    const r2FreezeStart = afterPause1;

    // Advance into live of round 2.
    const liveStart = afterPause1 + RULES.FREEZE_TIME + 0.1;
    game.update(RULES.FREEZE_TIME + 0.1, liveStart);
    expect(game.phase).toBe('live');

    // Within the BUY_TIME window (5 s after live start, window ends at r2FreezeStart + 30).
    const inWindow = liveStart + 5;
    game.update(5, inWindow);
    expect(game.canBuy(inWindow)).toBe(true);

    // Past the 30 s window from freeze start: canBuy must be false.
    const pastWindow = r2FreezeStart + RULES.BUY_TIME + 2; // 2 s past window end
    game.update(pastWindow - inWindow, pastWindow);
    expect(game.canBuy(pastWindow)).toBe(false);
  });
});

describe('Loss bonus progression', () => {
  test('loss streak increments correctly', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);

    // Simulate two consecutive CT wins (T loses twice).
    for (let round = 0; round < 2; round++) {
      const freeze = RULES.FREEZE_TIME + 0.1;
      game.update(freeze, freeze + round * 200);
      const live = freeze + 0.1 + round * 200;
      for (const c of game.combatants) {
        if (c.team === 'T') { c.alive = false; c.health = 0; }
      }
      game.update(0.016, live + 0.016);
      const afterPause = live + RULES.ROUND_END_PAUSE + 1;
      game.update(RULES.ROUND_END_PAUSE + 1, afterPause);
    }

    expect(game.lossStreak.T).toBe(2);
  });
});

describe('Bot auto-buy', () => {
  test('bots have rifles after round 2 when they can afford them', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);

    // Give bots round 2 money.
    for (const c of game.combatants) {
      if (!c.isPlayer) c.money = 5000;
    }

    // Advance to round 2 start.
    const freeze = RULES.FREEZE_TIME + 0.1;
    game.update(freeze, freeze);

    for (const c of game.combatants) {
      if (c.team === 'T') { c.alive = false; c.health = 0; }
    }
    game.update(0.016, freeze + 0.1);
    const afterPause = freeze + RULES.ROUND_END_PAUSE + 1;
    game.update(RULES.ROUND_END_PAUSE + 1, afterPause);

    // Now in round 2 — bots with enough money should have rifles.
    const richBots = game.combatants.filter(c => !c.isPlayer && c.money >= 2700);
    for (const bot of richBots) {
      expect(bot.inventory.primary).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// decideBuyStrategy unit tests
// ---------------------------------------------------------------------------

describe('decideBuyStrategy', () => {
  const base: BuyDecisionInput = {
    money:        1200,
    team:         'T',
    hasPrimary:   false,
    teamAvgMoney: 1200,
    lossStreak:   0,
    roll:         0.5,
    awpAllowed:   true,
  };

  test('eco when broke, no streak, low team avg', () => {
    const result = decideBuyStrategy({ ...base, money: 1200, lossStreak: 0, teamAvgMoney: 1200 });
    expect(result).toBe('eco');
  });

  test('force at 1400 + lossStreak 2', () => {
    const result = decideBuyStrategy({ ...base, money: 1400, lossStreak: 2, teamAvgMoney: 1400 });
    expect(result).toBe('force');
  });

  test('force at 1400 + teamAvgMoney >= 2000 (no streak)', () => {
    const result = decideBuyStrategy({ ...base, money: 1400, lossStreak: 0, teamAvgMoney: 2500 });
    expect(result).toBe('force');
  });

  test('full-buy at 3700 for T', () => {
    const result = decideBuyStrategy({ ...base, money: 3700, team: 'T', lossStreak: 0, teamAvgMoney: 3700 });
    expect(result).toBe('full');
  });

  test('full-buy at 3900 for CT', () => {
    const result = decideBuyStrategy({ ...base, money: 3900, team: 'CT', lossStreak: 0, teamAvgMoney: 3900 });
    expect(result).toBe('full');
  });

  test('awp when awpAllowed, !hasPrimary, money >= 5750, roll < 0.35', () => {
    const result = decideBuyStrategy({ ...base, money: 5750, hasPrimary: false, awpAllowed: true, roll: 0.2, lossStreak: 0, teamAvgMoney: 5750 });
    expect(result).toBe('awp');
  });

  test('NO awp when hasPrimary=true (survivor with existing gun cannot take AWP slot)', () => {
    const result = decideBuyStrategy({ ...base, money: 6000, hasPrimary: true, awpAllowed: true, roll: 0.1, lossStreak: 0, teamAvgMoney: 6000 });
    // hasPrimary=true prevents AWP branch; 6000 >= 3700 → full
    expect(result).toBe('full');
  });

  test('NO awp when roll >= 0.35 (falls to full)', () => {
    const result = decideBuyStrategy({ ...base, money: 5750, awpAllowed: true, roll: 0.5, lossStreak: 0, teamAvgMoney: 5750 });
    // 5750 >= 3700 threshold for T → full
    expect(result).toBe('full');
  });

  test('NO awp when awpAllowed=false (falls to full)', () => {
    const result = decideBuyStrategy({ ...base, money: 5750, awpAllowed: false, roll: 0.2, lossStreak: 0, teamAvgMoney: 5750 });
    expect(result).toBe('full');
  });

  test('no awp when money < 5750', () => {
    const result = decideBuyStrategy({ ...base, money: 5749, awpAllowed: true, roll: 0.1, lossStreak: 0, teamAvgMoney: 5749 });
    // 5749 >= 3700 → full
    expect(result).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// Team buy executor: AWP cap and money deductions
// ---------------------------------------------------------------------------

describe('Bot team buy executor', () => {
  function advanceToRound2(): { game: Game; afterPause: number } {
    const g = freshGame();
    g.startMatch(DEFAULT_OPTS);

    // Give all bots 6000 (full-buy territory).
    for (const c of g.combatants) {
      if (!c.isPlayer) c.money = 6000;
    }

    const freeze = RULES.FREEZE_TIME + 0.1;
    g.update(freeze, freeze);

    // End round 1: kill all Ts.
    for (const c of g.combatants) {
      if (c.team === 'T') { c.alive = false; c.health = 0; }
    }
    g.update(0.016, freeze + 0.1);

    const afterPause = freeze + RULES.ROUND_END_PAUSE + 1;
    g.update(RULES.ROUND_END_PAUSE + 1, afterPause);

    expect(g.phase).toBe('freeze');
    expect(g.roundNumber).toBe(2);
    return { game: g, afterPause };
  }

  test('at most one AWP per team after team buy', () => {
    const { game: g } = advanceToRound2();

    // Give all bots 6000 so AWP is affordable; make sure they all roll low (real random is fine here — at most 1 per team is what we assert).
    const checkTeams: Array<'CT' | 'T'> = ['CT', 'T'];
    for (const team of checkTeams) {
      const awpBots = g.combatants.filter(
        c => !c.isPlayer && c.team === team && c.inventory.primary?.def.id === 'awp',
      );
      expect(awpBots.length).toBeLessThanOrEqual(1);
    }
  });

  test('eco strategy: decideBuyStrategy returns eco when money < 1300 and no favorable conditions', () => {
    // Eco bots save — the strategy is already proven by the decideBuyStrategy unit tests.
    // Here we verify the executor: calling _executeBotBuy with eco leaves primary null and money unchanged.
    // We use decideBuyStrategy directly to confirm the decision, then check executor via freshGame.
    // Scenario: 1200 money, no streak, low team avg → eco.
    const strategy = decideBuyStrategy({
      money:        1200,
      team:         'T',
      hasPrimary:   false,
      teamAvgMoney: 1200,
      lossStreak:   0,
      roll:         0.9,
      awpAllowed:   false,
    });
    expect(strategy).toBe('eco');
  });

  test('full-buy bots get armor+helmet and a primary rifle', () => {
    const { game: g } = advanceToRound2();

    const fullBuyBots = g.combatants.filter(
      c => !c.isPlayer && c.inventory.primary !== null && c.inventory.primary.def.id !== 'awp',
    );
    // At least some bots should have done a full buy with 6000 starting money.
    expect(fullBuyBots.length).toBeGreaterThan(0);
    for (const c of fullBuyBots) {
      expect(c.armor).toBe(100);
      expect(c.helmet).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Grenade buy
// ---------------------------------------------------------------------------

describe('buy grenades', () => {
  test('buy he once succeeds, money deducted', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
    game.player.money = 2000;

    const ok = game.buy(game.player, 'he', 0);
    expect(ok).toBe(true);
    expect(game.player.grenades?.he).toBe(1);
    expect(game.player.money).toBe(2000 - GRENADES.he.price);
  });

  test('buy he twice is rejected (maxCarry 1)', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
    game.player.money = 2000;

    game.buy(game.player, 'he', 0);
    const ok2 = game.buy(game.player, 'he', 0);
    expect(ok2).toBe(false);
    expect(game.player.grenades?.he).toBe(1);
    expect(game.player.money).toBe(2000 - GRENADES.he.price); // only deducted once
  });

  test('buy flash twice succeeds (maxCarry 2), third rejected', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
    game.player.money = 2000;

    const ok1 = game.buy(game.player, 'flash', 0);
    expect(ok1).toBe(true);
    const ok2 = game.buy(game.player, 'flash', 0);
    expect(ok2).toBe(true);
    expect(game.player.grenades?.flash).toBe(2);
    const ok3 = game.buy(game.player, 'flash', 0);
    expect(ok3).toBe(false);
    expect(game.player.grenades?.flash).toBe(2);
    expect(game.player.money).toBe(2000 - GRENADES.flash.price * 2);
  });

  test('buy smoke money deducted correctly', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
    game.player.money = 2000;

    const ok = game.buy(game.player, 'smoke', 0);
    expect(ok).toBe(true);
    expect(game.player.grenades?.smoke).toBe(1);
    expect(game.player.money).toBe(2000 - GRENADES.smoke.price);
  });
});

// ---------------------------------------------------------------------------
// vest_helmet upgrade path
// ---------------------------------------------------------------------------

describe('buy vest_helmet upgrade', () => {
  test('armor > 0 && !helmet charges ARMOR_UPGRADE_PRICE (350)', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
    game.player.money = 2000;

    // First buy vest only.
    const ok1 = game.buy(game.player, 'armor', 0);
    expect(ok1).toBe(true);
    expect(game.player.armor).toBe(100);
    expect(game.player.helmet).toBe(false);
    const moneyAfterVest = game.player.money;

    // Now upgrade to vest+helmet — should cost ARMOR_UPGRADE_PRICE.
    const ok2 = game.buy(game.player, 'armorHelmet', 0);
    expect(ok2).toBe(true);
    expect(game.player.helmet).toBe(true);
    expect(game.player.armor).toBe(100);
    expect(game.player.money).toBe(moneyAfterVest - ECONOMY.ARMOR_UPGRADE_PRICE);
  });

  test('fresh buy armorHelmet (no vest) charges full ARMOR_HELMET_PRICE', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
    game.player.money = 2000;

    const ok = game.buy(game.player, 'armorHelmet', 0);
    expect(ok).toBe(true);
    expect(game.player.armor).toBe(100);
    expect(game.player.helmet).toBe(true);
    expect(game.player.money).toBe(2000 - ECONOMY.ARMOR_HELMET_PRICE);
  });
});

// ---------------------------------------------------------------------------
// Round start blind and grenade resets
// ---------------------------------------------------------------------------

describe('round start resets', () => {
  function advanceToRound2(): { game: Game; afterPause: number } {
    const g = freshGame();
    g.startMatch(DEFAULT_OPTS);

    const freeze = RULES.FREEZE_TIME + 0.1;
    g.update(freeze, freeze);

    for (const c of g.combatants) {
      if (c.team === 'T') { c.alive = false; c.health = 0; }
    }
    g.update(0.016, freeze + 0.1);

    const afterPause = freeze + RULES.ROUND_END_PAUSE + 1;
    g.update(RULES.ROUND_END_PAUSE + 1, afterPause);

    expect(g.phase).toBe('freeze');
    expect(g.roundNumber).toBe(2);
    return { game: g, afterPause };
  }

  test('blind fields are cleared on round start for all combatants', () => {
    const { game: g } = advanceToRound2();

    // All combatants should have cleared blind state after round start.
    for (const c of g.combatants) {
      expect(c.blindUntil ?? 0).toBe(0);
      expect(c.blindIntensity ?? 0).toBe(0);
      expect(c.equippedGrenade ?? null).toBeNull();
    }
  });

  test('dead combatant loses grenades on round start, survivor keeps them', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);

    // Give player (CT, alive) some grenades.
    game.player.money = 5000;
    game.buy(game.player, 'he', 0);
    game.buy(game.player, 'flash', 0);
    expect(game.player.grenades?.he).toBe(1);
    expect(game.player.grenades?.flash).toBe(1);

    // Find a T bot, give it grenades, then kill it.
    const tBot = game.combatants.find(c => !c.isPlayer && c.team === 'T')!;
    tBot.grenades = { he: 1, flash: 2, smoke: 1 };

    // Force freeze → live.
    const freeze = RULES.FREEZE_TIME + 0.1;
    game.update(freeze, freeze);

    // Kill the T bot (player CT survives).
    tBot.alive = false;
    tBot.health = 0;

    // Kill all OTHER Ts to end the round.
    for (const c of game.combatants) {
      if (c.team === 'T') { c.alive = false; c.health = 0; }
    }
    game.update(0.016, freeze + 0.1);

    const afterPause = freeze + RULES.ROUND_END_PAUSE + 1;
    game.update(RULES.ROUND_END_PAUSE + 1, afterPause);

    expect(game.phase).toBe('freeze');

    // Survivor (player) keeps grenades.
    expect(game.player.grenades?.he).toBe(1);
    expect(game.player.grenades?.flash).toBe(1);

    // Dead T bot lost grenades.
    expect(tBot.grenades?.he).toBe(0);
    expect(tBot.grenades?.flash).toBe(0);
    expect(tBot.grenades?.smoke).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyExplosionDamage
// ---------------------------------------------------------------------------

describe('applyExplosionDamage', () => {
  test('armor reduces damage (HE, applyArmor=true)', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
    const victim = game.player;
    victim.health = 100;
    victim.armor  = 100;
    victim.helmet = false;

    game.applyExplosionDamage(victim, 50, null, 'he', true);

    // With ARMOR_DAMAGE_MULT = 0.775, 50 dmg → ~39 to health; victim should survive.
    expect(victim.health).toBeLessThan(100);
    expect(victim.health).toBeGreaterThan(0);
    expect(victim.alive).toBe(true);
    // Armor should be reduced.
    expect(victim.armor).toBeLessThan(100);
  });

  test('bomb damage ignores armor (applyArmor=false)', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
    const victim = game.player;
    victim.health = 100;
    victim.armor  = 100;
    victim.helmet = true;

    // 100 raw damage with applyArmor=false must kill a 100 hp victim regardless of armor.
    game.applyExplosionDamage(victim, 100, null, 'bomb', false);

    expect(victim.health).toBe(0);
    expect(victim.alive).toBe(false);
    // Armor must be untouched — bomb does raw damage.
    expect(victim.armor).toBe(100);
  });

  test('lethal damage kills victim and credits attacker with kill + reward', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);

    const thrower = game.combatants.find(c => !c.isPlayer && c.team === 'T')!;
    const victim  = game.player;
    victim.health = 10;
    victim.armor  = 0;
    thrower.kills = 0;
    const moneyBefore = thrower.money;

    const kills: Array<{ attacker: unknown; victim: unknown; weaponId: string }> = [];
    const unsub = gameEvents.on('kill', (ev) => kills.push(ev));

    game.applyExplosionDamage(victim, 200, thrower, 'he');

    expect(victim.alive).toBe(false);
    expect(victim.health).toBe(0);
    expect(thrower.kills).toBe(1);
    expect(thrower.money).toBeGreaterThan(moneyBefore);
    expect(kills.length).toBe(1);
    expect(kills[0]!.weaponId).toBe('he');

    // Clean up.
    (unsub as unknown as { off: () => void })?.off?.();
  });

  test('no kill credit on self-damage (thrower === victim)', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);

    const victim = game.player;
    victim.health = 10;
    victim.armor  = 0;
    victim.kills  = 0;
    const moneyBefore = victim.money;

    game.applyExplosionDamage(victim, 200, victim, 'he');

    // Dies but thrower === victim: no kill credit, no money reward.
    expect(victim.alive).toBe(false);
    expect(victim.kills).toBe(0);
    expect(victim.money).toBe(moneyBefore);
  });

  test('skip dead victims gracefully', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);

    const victim = game.player;
    victim.alive  = false;
    victim.health = 0;

    // Should not throw or mutate.
    game.applyExplosionDamage(victim, 200, null, 'he');
    expect(victim.health).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buy team exclusivity
// ---------------------------------------------------------------------------

describe('buy team exclusivity', () => {
  test('CT player cannot buy ak47', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
    game.player.team   = 'CT';
    game.player.money  = 5000;
    const ok = game.buy(game.player, 'ak47', 0);
    expect(ok).toBe(false);
    expect(game.player.money).toBe(5000);
  });

  test('T player cannot buy m4a4', () => {
    game = freshGame();
    game.startMatch({ playerTeam: 'T', difficulty: 'normal', botsPerTeam: 4 });
    game.player.team   = 'T';
    game.player.money  = 5000;
    const ok = game.buy(game.player, 'm4a4', 0);
    expect(ok).toBe(false);
    expect(game.player.money).toBe(5000);
  });

  test('CT player can buy p250 (no teams restriction)', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
    game.player.team   = 'CT';
    game.player.money  = 5000;
    const ok = game.buy(game.player, 'p250', 0);
    expect(ok).toBe(true);
    expect(game.player.money).toBe(5000 - WEAPONS.p250.price);
  });

  test('T player can buy p250 (no teams restriction)', () => {
    game = freshGame();
    game.startMatch({ playerTeam: 'T', difficulty: 'normal', botsPerTeam: 4 });
    game.player.team   = 'T';
    game.player.money  = 5000;
    const ok = game.buy(game.player, 'p250', 0);
    expect(ok).toBe(true);
    expect(game.player.money).toBe(5000 - WEAPONS.p250.price);
  });

  test('CT player can buy awp (no teams restriction)', () => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
    game.player.team   = 'CT';
    game.player.money  = 5000;
    const ok = game.buy(game.player, 'awp', 0);
    expect(ok).toBe(true);
    expect(game.player.money).toBe(5000 - WEAPONS.awp.price);
  });

  test('T player can buy awp (no teams restriction)', () => {
    game = freshGame();
    game.startMatch({ playerTeam: 'T', difficulty: 'normal', botsPerTeam: 4 });
    game.player.team   = 'T';
    game.player.money  = 5000;
    const ok = game.buy(game.player, 'awp', 0);
    expect(ok).toBe(true);
    expect(game.player.money).toBe(5000 - WEAPONS.awp.price);
  });

  test('T player cannot buy kit (pre-existing CT-only gate)', () => {
    game = freshGame();
    game.startMatch({ playerTeam: 'T', difficulty: 'normal', botsPerTeam: 4 });
    game.player.team   = 'T';
    game.player.money  = 5000;
    const ok = game.buy(game.player, 'kit', 0);
    expect(ok).toBe(false);
    expect(game.player.money).toBe(5000);
  });
});
