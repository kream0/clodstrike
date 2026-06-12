import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { Game, pickRoundMvp } from './game';
import type { MatchOptions } from './game';
import { ECONOMY, WEAPONS } from './constants';
import { World } from './world';
import { DUST2 } from './maps/dust2';
import { gameEvents } from './combat';
import type { Combatant } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_OPTS: MatchOptions = {
  playerTeam: 'CT',
  difficulty: 'normal',
  botsPerTeam: 4,
};

function makeCombatant(id: number, team: 'CT' | 'T', name = `Bot${id}`): Combatant {
  const { WEAPONS: W } = require('./constants');
  const knife     = { def: W.knife,  ammo: 0,  reserve: 0,  reloading: false, reloadEnd: 0, nextFire: 0, shotsFired: 0 };
  const secondary = { def: team === 'CT' ? W.usp : W.glock, ammo: 12, reserve: 24, reloading: false, reloadEnd: 0, nextFire: 0, shotsFired: 0 };
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
}

// Track the most recently created Game so tests can dispose it in afterEach,
// preventing listener accumulation on the module-global gameEvents bus.
let _lastGame: Game | null = null;

function freshGame(): Game {
  // Dispose the previous instance before creating a new one so its listeners
  // are removed from the shared bus immediately (not deferred to afterEach).
  _lastGame?.dispose();
  const world = new World(DUST2);
  const g = new Game(world, null);
  g.player = makeCombatant(0, 'CT', 'Player');
  _lastGame = g;
  return g;
}

// ---------------------------------------------------------------------------
// pickRoundMvp — pure function matrix
// ---------------------------------------------------------------------------

describe('pickRoundMvp', () => {
  const ct1 = makeCombatant(1, 'CT', 'CT1');
  const ct2 = makeCombatant(2, 'CT', 'CT2');
  const t1  = makeCombatant(3, 'T',  'T1');
  const t2  = makeCombatant(4, 'T',  'T2');
  const all = [ct1, ct2, t1, t2];

  test('CT win + defuser → defuser wins', () => {
    const kills = new Map([[ct1.id, 3], [t1.id, 2]]);
    expect(pickRoundMvp(all, kills, 'CT', null, ct2)).toBe(ct2);
  });

  test('T win + planter → planter wins', () => {
    const kills = new Map([[ct1.id, 3], [t1.id, 1]]);
    expect(pickRoundMvp(all, kills, 'T', t2, null)).toBe(t2);
  });

  test('planter present but CT wins → falls back to kills (planter ignored)', () => {
    // T planted but CT won (defuse or time-out), no defuser snapshot
    const kills = new Map([[ct1.id, 3], [t1.id, 1]]);
    expect(pickRoundMvp(all, kills, 'CT', t1, null)).toBe(ct1);
  });

  test('defuser present but T wins → falls back to kills (defuser ignored)', () => {
    // Defuser was set but T ended up winning (shouldn't happen normally, edge case)
    const kills = new Map([[t1.id, 2], [t2.id, 1]]);
    expect(pickRoundMvp(all, kills, 'T', null, ct1)).toBe(t1);
  });

  test('top kills on winning team wins', () => {
    const kills = new Map([[ct1.id, 1], [ct2.id, 3], [t1.id, 5]]);
    expect(pickRoundMvp(all, kills, 'CT', null, null)).toBe(ct2);
  });

  test('kills on the losing team never win MVP', () => {
    const kills = new Map([[t1.id, 10], [ct1.id, 1]]);
    // T has 10 kills but CT won
    expect(pickRoundMvp(all, kills, 'CT', null, null)).toBe(ct1);
  });

  test('ties broken by lower id', () => {
    // ct1 (id=1) and ct2 (id=2) both have 2 kills
    const kills = new Map([[ct1.id, 2], [ct2.id, 2]]);
    expect(pickRoundMvp(all, kills, 'CT', null, null)).toBe(ct1);
  });

  test('zero kills everywhere → null', () => {
    const kills = new Map<number, number>();
    expect(pickRoundMvp(all, kills, 'CT', null, null)).toBeNull();
  });

  test('zero kills for winning team → null (even if losing team has kills)', () => {
    const kills = new Map([[t1.id, 3]]);
    expect(pickRoundMvp(all, kills, 'CT', null, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stats accumulation via gameEvents bus
// ---------------------------------------------------------------------------

describe('statsFor accumulation', () => {
  let game: Game;

  beforeEach(() => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
  });

  afterEach(() => {
    game.dispose();
  });

  test('headshot kill increments headshotKills', () => {
    const player = game.player;
    const victim = game.combatants.find(c => c.team === 'T')!;
    player.kills = 1; // simulate the kill having been recorded on the combatant
    gameEvents.emit('kill', {
      attacker: player,
      victim,
      weaponId: 'ak47',
      headshot: true,
    });
    expect(game.statsFor(player).headshotKills).toBe(1);
  });

  test('non-headshot kill does NOT increment headshotKills', () => {
    const player = game.player;
    const victim = game.combatants.find(c => c.team === 'T')!;
    player.kills = 1;
    gameEvents.emit('kill', {
      attacker: player,
      victim,
      weaponId: 'ak47',
      headshot: false,
    });
    expect(game.statsFor(player).headshotKills).toBe(0);
  });

  test('null attacker kill is ignored', () => {
    const victim = game.combatants.find(c => c.team === 'T')!;
    gameEvents.emit('kill', {
      attacker: null,
      victim,
      weaponId: 'bomb',
      headshot: false,
    });
    // No crash; nothing to assert beyond that — just ensure no stats are wrongly created
    expect(game.statsFor(game.player).headshotKills).toBe(0);
  });

  test('self-kill is ignored (attacker === victim)', () => {
    const player = game.player;
    gameEvents.emit('kill', {
      attacker: player,
      victim:   player,
      weaponId: 'he',
      headshot: false,
    });
    expect(game.statsFor(player).headshotKills).toBe(0);
  });

  test('damage amounts sum into damageDealt', () => {
    const player = game.player;
    const victim = game.combatants.find(c => c.team === 'T')!;
    gameEvents.emit('damage', { attacker: player, victim, amount: 40, hitGroup: 'body' });
    gameEvents.emit('damage', { attacker: player, victim, amount: 25, hitGroup: 'head' });
    expect(game.statsFor(player).damageDealt).toBe(65);
  });

  test('null attacker damage is ignored', () => {
    const victim = game.combatants.find(c => c.team === 'T')!;
    gameEvents.emit('damage', { attacker: null, victim, amount: 50, hitGroup: 'body' });
    expect(game.statsFor(game.player).damageDealt).toBe(0);
  });

  test('self-damage is ignored', () => {
    const player = game.player;
    gameEvents.emit('damage', { attacker: player, victim: player, amount: 30, hitGroup: 'body' });
    expect(game.statsFor(player).damageDealt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// moneySpent via buy()
// ---------------------------------------------------------------------------

describe('moneySpent via buy()', () => {
  let game: Game;

  beforeEach(() => {
    game = freshGame();
    game.startMatch(DEFAULT_OPTS);
  });

  afterEach(() => {
    game.dispose();
  });

  test('buying a rifle tracks moneySpent and deducts money identically', () => {
    const player = game.player;
    const initialMoney = 5000;
    player.money = initialMoney;

    const price = WEAPONS.m4a4.price; // 2900 — player is CT, use CT-only rifle
    const ok = game.buy(player, 'm4a4', 0);
    expect(ok).toBe(true);
    expect(player.money).toBe(initialMoney - price);
    expect(game.statsFor(player).moneySpent).toBe(price);
  });

  test('buying armor tracks moneySpent', () => {
    const player = game.player;
    player.money = 5000;
    const ok = game.buy(player, 'armor', 0);
    expect(ok).toBe(true);
    expect(game.statsFor(player).moneySpent).toBe(ECONOMY.ARMOR_PRICE);
  });

  test('buying armorHelmet tracks full helmet price', () => {
    const player = game.player;
    player.money = 5000;
    const ok = game.buy(player, 'armorHelmet', 0);
    expect(ok).toBe(true);
    expect(game.statsFor(player).moneySpent).toBe(ECONOMY.ARMOR_HELMET_PRICE);
  });

  test('multiple purchases accumulate moneySpent', () => {
    const player = game.player;
    player.money = 5000;
    game.buy(player, 'm4a4', 0); // player is CT — CT-only rifle
    game.buy(player, 'armor', 0);
    const expected = WEAPONS.m4a4.price + ECONOMY.ARMOR_PRICE; // 2900 + 650 = 3550
    expect(game.statsFor(player).moneySpent).toBe(expected);
  });

  test('failed purchase does not increase moneySpent', () => {
    const player = game.player;
    player.money = 100; // can't afford ak47
    game.buy(player, 'ak47', 0);
    expect(game.statsFor(player).moneySpent).toBe(0);
    expect(player.money).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Stats reset on startMatch
// ---------------------------------------------------------------------------

describe('statsFor reset', () => {
  test('startMatch clears previously accumulated stats', () => {
    const game = freshGame();
    game.startMatch(DEFAULT_OPTS);

    const player = game.player;
    // Manually set some stats.
    const stats = game.statsFor(player);
    stats.headshotKills = 5;
    stats.damageDealt   = 200;
    stats.moneySpent    = 1500;
    stats.mvps          = 2;

    // Restart the match.
    game.startMatch(DEFAULT_OPTS);

    // Stats for the same player id should be reset to zeros.
    const fresh = game.statsFor(player);
    expect(fresh.headshotKills).toBe(0);
    expect(fresh.damageDealt).toBe(0);
    expect(fresh.moneySpent).toBe(0);
    expect(fresh.mvps).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dispose() — listener detachment
// ---------------------------------------------------------------------------

describe('Game.dispose()', () => {
  test('kill event no longer mutates stats after dispose()', () => {
    const game = freshGame();
    game.startMatch(DEFAULT_OPTS);

    const player = game.player;
    const victim = game.combatants.find(c => c.team === 'T')!;

    // Confirm accumulation works before dispose.
    gameEvents.emit('kill', { attacker: player, victim, weaponId: 'ak47', headshot: true });
    expect(game.statsFor(player).headshotKills).toBe(1);

    game.dispose();

    // After dispose, further events must not mutate the instance.
    gameEvents.emit('kill', { attacker: player, victim, weaponId: 'ak47', headshot: true });
    expect(game.statsFor(player).headshotKills).toBe(1); // still 1, not 2
  });

  test('dispose() is idempotent — calling it twice does not throw', () => {
    const game = freshGame();
    game.startMatch(DEFAULT_OPTS);
    game.dispose();
    expect(() => game.dispose()).not.toThrow();
  });
});
