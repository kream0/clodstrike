import { describe, test, expect, beforeEach } from 'bun:test';
import { Game } from '../game';
import type { MatchOptions } from '../game';
import { World } from '../world';
import { NavGrid } from './nav';
import { BotManager } from './bot';
import { DUST2 } from '../maps/dust2';
import { RULES, ECONOMY, WEAPONS } from '../constants';
import { gameEvents } from '../combat';
import type { Combatant, Inventory } from '../types';

// ---------------------------------------------------------------------------
// Shared factories
// ---------------------------------------------------------------------------

function makeWeaponState(def: typeof WEAPONS.knife) {
  return { def, ammo: def.magSize, reserve: def.reserveAmmo, reloading: false, reloadEnd: 0, nextFire: 0, shotsFired: 0 };
}

function makeCombatant(id: number, name: string, team: 'CT' | 'T'): Combatant {
  const knife     = makeWeaponState(WEAPONS.knife);
  const secondary = makeWeaponState(team === 'CT' ? WEAPONS.usp : WEAPONS.glock);
  const inv: Inventory = { knife, secondary, primary: null, activeSlot: 'secondary' };
  return {
    id, name, team, isPlayer: id === 0,
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0,
    health: 100, armor: 0, helmet: false,
    alive: true, crouching: false, walking: false, onGround: true,
    inventory: inv,
    money: ECONOMY.START_MONEY, kills: 0, deaths: 0,
    hasBomb: false, hasDefuseKit: false, tagSlowUntil: 0,
  };
}

function freshSetup(opts?: Partial<MatchOptions>) {
  const world  = new World(DUST2);
  const nav    = new NavGrid(DUST2);
  const game   = new Game(world, null);
  game.player  = makeCombatant(0, 'Player', 'CT');
  game.startMatch({ playerTeam: 'CT', difficulty: 'normal', botsPerTeam: 4, ...opts });

  const mgr = new BotManager(game, world, nav);
  mgr.attach();
  return { game, world, nav, mgr };
}

function advanceFreeze(game: Game): number {
  const now = RULES.FREEZE_TIME + 0.1;
  game.update(now, now);
  expect(game.phase).toBe('live');
  return now;
}

function tickBrains(game: Game, mgr: BotManager, ticks: number, startNow: number, dt = 1 / 64): number {
  let now = startNow;
  for (let i = 0; i < ticks; i++) {
    now += dt;
    // Call each bot brain directly (game.update does this too, but for control we do it here).
    for (const c of game.combatants) {
      if (c.isPlayer || !c.alive) continue;
      const brain = game.botBrains.get(c.id);
      if (brain) brain(c, dt, now);
    }
    game.update(dt, now);
  }
  return now;
}

// ---------------------------------------------------------------------------
// attach / dispose
// ---------------------------------------------------------------------------

describe('BotManager.attach / dispose', () => {
  test('attach fills botBrains for all 9 bots', () => {
    const { game } = freshSetup();
    const bots = game.combatants.filter(c => !c.isPlayer);
    expect(bots.length).toBe(9);
    for (const bot of bots) {
      expect(game.botBrains.has(bot.id)).toBe(true);
    }
  });

  test('dispose empties botBrains', () => {
    const { game, mgr } = freshSetup();
    mgr.dispose();
    expect(game.botBrains.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Movement: T bot makes progress toward its route
// ---------------------------------------------------------------------------

describe('Bot movement — T bot objective progress', () => {
  test('T bot moves at least 5 m toward first route target in 6 s', () => {
    const { game, mgr } = freshSetup({ playerTeam: 'CT' });
    let now = advanceFreeze(game);

    // Find a T bot.
    const tBot = game.combatants.find(c => c.team === 'T' && !c.isPlayer && c.alive)!;
    expect(tBot).toBeDefined();

    const startPos = { ...tBot.pos };
    const TICKS    = Math.round(6 / (1 / 64));
    now = tickBrains(game, mgr, TICKS, now);

    const dx   = tBot.pos.x - startPos.x;
    const dz   = tBot.pos.z - startPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // The bot should have moved at least 5 m.
    expect(dist).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Vision gating — reaction time
// ---------------------------------------------------------------------------

describe('Vision gating', () => {
  test('bot does not fire before reactionMs elapses', () => {
    const { game, mgr } = freshSetup({ playerTeam: 'T', difficulty: 'easy' });
    let now = advanceFreeze(game);

    // Find a CT bot.
    const ctBot = game.combatants.find(c => c.team === 'CT' && !c.isPlayer && c.alive)!;
    expect(ctBot).toBeDefined();

    // Place a T enemy directly in front, within LOS.
    const tEnemy = game.combatants.find(c => c.team === 'T' && c.alive)!;
    tEnemy.pos   = { x: ctBot.pos.x, y: ctBot.pos.y, z: ctBot.pos.z - 10 };
    ctBot.yaw    = 0; // facing -Z

    const initHealth = tEnemy.health;
    let shotFired    = false;
    const unsub      = gameEvents.on('shot', (ev) => {
      if (ev.shooter.id === ctBot.id) shotFired = true;
    });

    try {
      // Tick for 200 ms (less than easy reactionMs = 550 ms).
      const shortTicks = Math.ceil(0.2 / (1 / 64));
      now = tickBrains(game, mgr, shortTicks, now);
      expect(shotFired).toBe(false);
      expect(tEnemy.health).toBe(initHealth);
    } finally {
      unsub();
    }
  });

  test('bot fires after reactionMs elapses (health drops)', () => {
    const { game, mgr } = freshSetup({ playerTeam: 'T', difficulty: 'hard' });
    let now = advanceFreeze(game);

    // Find a CT bot and a T enemy.
    const ctBot  = game.combatants.find(c => c.team === 'CT' && !c.isPlayer && c.alive)!;
    const tEnemy = game.combatants.find(c => c.team === 'T' && c.alive)!;

    // Give the CT bot a rifle for reliable damage.
    ctBot.inventory.primary = makeWeaponState(WEAPONS.m4a4);
    ctBot.inventory.activeSlot = 'primary';
    // Strip enemy armor so damage is guaranteed.
    tEnemy.armor   = 0;
    tEnemy.helmet  = false;

    // Place both combatants in open mid area on the same floor level.
    // CT mid (CTMid area): x≈-2, z≈-28, floor=0.
    const botFloor = 0;
    ctBot.pos  = { x: 0, y: botFloor, z: -28 };
    // Place T enemy 5 m in front of ctBot (facing -Z when yaw=0).
    tEnemy.pos = { x: 0, y: botFloor, z: -28 - 5 };
    ctBot.yaw  = 0; // facing -Z toward tEnemy
    ctBot.onGround = true;
    tEnemy.onGround = true;

    const initHealth = tEnemy.health;

    // Tick for 2 s (hard reactionMs = 220 ms, so well past reaction).
    const ticks = Math.ceil(2.0 / (1 / 64));
    now = tickBrains(game, mgr, ticks, now);

    // Health should have dropped.
    expect(tEnemy.health).toBeLessThan(initHealth);
  });

  test('enemy behind a solid wall (no LOS) is never shot at initial positions', () => {
    const { game, world } = freshSetup({ playerTeam: 'T', difficulty: 'hard' });

    // Verify that world.lineOfSight blocks between CT spawn (inside CT room)
    // and a point inside the upper tunnels (separated by walls).
    // CT spawn ~ x=6.5, z=-40 (floor=1.5, enclosed room)
    // Upper tunnels ~ x=-28, z=0 (floor=1.5, covered tunnel)
    const ctEye  = { x: 6.5,  y: 1.5 + 1.64, z: -40  };
    const tunEye = { x: -28,  y: 1.5 + 1.64, z:  0   };

    // These two points are separated by a solid wall section.
    // The world.lineOfSight check should return false.
    const los = world.lineOfSight(ctEye, tunEye);
    expect(los).toBe(false);

    // Also verify: a bot that never perceives any enemy never fires.
    // Place CT bot in CT spawn room, kill all other bots except one T enemy placed
    // at upper tunnels (blocked by walls). Run for 2 s and verify no damage.
    const mgr2   = new BotManager(game, world, new NavGrid(DUST2));
    mgr2.attach();
    let now = advanceFreeze(game);

    const ctBot  = game.combatants.find(c => c.team === 'CT' && !c.isPlayer && c.alive)!;
    const tEnemy = game.combatants.find(c => c.team === 'T' && c.alive)!;

    // Kill all other T and CT bots (leave only ctBot alive on CT side).
    for (const c of game.combatants) {
      if (c === ctBot || c === tEnemy || c.isPlayer) continue;
      c.alive = false; c.health = 0;
    }

    ctBot.pos  = { x: 6.5, y: 1.5, z: -40 };
    ctBot.yaw  = 0;
    tEnemy.pos = { x: -28, y: 1.5, z: 0 };

    const initHealth = tEnemy.health;
    // Force ctBot to stay put (disable stuck replan by not requiring movement).
    const TICKS = Math.ceil(2.0 / (1 / 64));
    for (let i = 0; i < TICKS; i++) {
      now += 1 / 64;
      const brain = game.botBrains.get(ctBot.id);
      if (brain) brain(ctBot, 1 / 64, now);
    }

    expect(tEnemy.health).toBe(initHealth);
    mgr2.dispose();
  });
});

// ---------------------------------------------------------------------------
// Plant test
// ---------------------------------------------------------------------------

describe('Bomb plant', () => {
  test('T bomb carrier teleported into site A plants within 30 s', () => {
    const { game, mgr } = freshSetup({ playerTeam: 'CT' });
    let now = advanceFreeze(game);

    const carrier = game.combatants.find(c => c.hasBomb)!;
    expect(carrier).toBeDefined();

    const siteA = DUST2.bombsites[0];
    carrier.pos  = {
      x: (siteA.min.x + siteA.max.x) / 2,
      y: 3.0,
      z: (siteA.min.z + siteA.max.z) / 2,
    };
    carrier.onGround = true;

    // Kill all CTs so they don't interfere.
    for (const c of game.combatants) {
      if (c.team === 'CT') { c.alive = false; c.health = 0; }
    }
    // Ensure game stays 'live' — manually keep phase.
    // We simulate up to 30 s worth of ticks.
    const maxTicks = Math.ceil(30 / (1 / 64));
    for (let i = 0; i < maxTicks; i++) {
      now += 1 / 64;
      const brain = game.botBrains.get(carrier.id);
      if (brain) brain(carrier, 1 / 64, now);
      if (game.bomb.state === 'planted') break;
    }

    expect(game.bomb.state).toBe('planted');
  });
});

// ---------------------------------------------------------------------------
// Defuse test
// ---------------------------------------------------------------------------

describe('Bomb defuse', () => {
  test('CT teleported 3 m from planted bomb defuses it', () => {
    const { game, mgr } = freshSetup({ playerTeam: 'T' });
    let now = advanceFreeze(game);

    // Force-plant the bomb at site A.
    const siteA = DUST2.bombsites[0];
    const bombX = (siteA.min.x + siteA.max.x) / 2;
    const bombZ = (siteA.min.z + siteA.max.z) / 2;

    game.bomb.state       = 'planted';
    game.bomb.pos         = { x: bombX, y: 3.0, z: bombZ };
    game.bomb.explodeAt   = now + 60; // plenty of time
    game.bomb.site        = 'A';
    (game as unknown as { phase: string }).phase = 'planted';

    // Kill all Ts.
    for (const c of game.combatants) {
      if (c.team === 'T') { c.alive = false; c.health = 0; }
    }

    // Find a CT bot and teleport it close.
    const ctBot = game.combatants.find(c => c.team === 'CT' && !c.isPlayer && c.alive)!;
    expect(ctBot).toBeDefined();
    ctBot.pos      = { x: bombX + 1, y: 3.0, z: bombZ };
    ctBot.onGround = true;

    const defuseMs = (RULES.DEFUSE_TIME + 2) * 1000;
    const ticks    = Math.ceil(defuseMs / (1000 * (1 / 64)));

    for (let i = 0; i < ticks; i++) {
      now += 1 / 64;
      const brain = game.botBrains.get(ctBot.id);
      if (brain) brain(ctBot, 1 / 64, now);
      const bombStateNow = game.bomb.state as string;
      if (bombStateNow === 'defused') break;
    }

    expect(game.bomb.state as string).toBe('defused');
  });
});

// ---------------------------------------------------------------------------
// Hearing: enemy shot heard → hunt state
// ---------------------------------------------------------------------------

describe('Hearing', () => {
  test('enemy shot 20 m away triggers hunt state', () => {
    const { game, mgr } = freshSetup({ playerTeam: 'T', difficulty: 'normal' });
    let now = advanceFreeze(game);

    // Find a CT bot.
    const ctBot = game.combatants.find(c => c.team === 'CT' && !c.isPlayer && c.alive)!;
    expect(ctBot).toBeDefined();

    // Place a T enemy 20 m away out of FOV (behind the CT bot).
    const tShooter = game.combatants.find(c => c.team === 'T' && c.alive)!;
    tShooter.pos = {
      x: ctBot.pos.x + 0,
      y: ctBot.pos.y,
      z: ctBot.pos.z + 20, // behind (+Z when facing -Z)
    };
    ctBot.yaw = 0; // facing -Z (away from tShooter)

    // Make sure CT bot is in objective/guard, not engage.
    const priorState = mgr.getBrainState(ctBot.id);

    // Emit a 'shot' event as if tShooter fired.
    gameEvents.emit('shot', { shooter: tShooter, pos: tShooter.pos, weaponId: 'ak47' });

    // Tick once.
    const brain = game.botBrains.get(ctBot.id);
    if (brain) brain(ctBot, 1 / 64, now + 1 / 64);

    const newState = mgr.getBrainState(ctBot.id);
    // Should have transitioned to hunt (or engage if somehow saw them).
    expect(newState === 'hunt' || newState === 'engage').toBe(true);
  });
});
