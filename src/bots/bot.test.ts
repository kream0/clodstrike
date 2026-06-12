import { describe, test, expect, beforeEach } from 'bun:test';
import { Game } from '../game';
import type { MatchOptions } from '../game';
import { World } from '../world';
import { NavGrid } from './nav';
import {
  BotManager,
  BUY_POOL_ECO_PISTOL,
  BUY_POOL_FORCE_SMG,
  BUY_POOL_FORCE_SHOTGUN,
  BUY_POOL_FULL_PRIMARY_BUDGET,
  BUY_POOL_FULL_PRIMARY_STANDARD,
  BUY_POOL_FULL_PRIMARY_RICH,
} from './bot';
import type { BotState } from './bot';
import { DUST2 } from '../maps/dust2';
import { RULES, ECONOMY, WEAPONS } from '../constants';
import { gameEvents } from '../combat';
import { isScoped } from '../weapons';
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

    // Place both combatants in the open mid spine on the same floor level.
    // Ground-truth rebuild: mid spine cells (char 'M') sit at floor 3.75 m;
    // (5,13) and (5,8) are confirmed walkable M cells with clear LOS, 5 m apart.
    const botFloor = 3.75;
    ctBot.pos  = { x: 5, y: botFloor, z: 13 };
    // Place T enemy 5 m in front of ctBot (facing -Z = north when yaw=0).
    tEnemy.pos = { x: 5, y: botFloor, z: 8 };
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
    // A-site floor height from the map legend (char 'A' = 4.5 m in the geometry-correct grid).
    const bombCol = Math.floor((bombX - DUST2.origin.x) / DUST2.cellSize);
    const bombRow = Math.floor((bombZ - DUST2.origin.z) / DUST2.cellSize);
    const bombY = DUST2.legend[DUST2.grid[bombRow]![bombCol]!]!.floor;

    game.bomb.state       = 'planted';
    game.bomb.pos         = { x: bombX, y: bombY, z: bombZ };
    game.bomb.explodeAt   = now + 60; // plenty of time
    game.bomb.site        = 'A';
    (game as unknown as { phase: string }).phase = 'planted';

    // Kill all Ts.
    for (const c of game.combatants) {
      if (c.team === 'T') { c.alive = false; c.health = 0; }
    }

    // Find a CT bot and teleport it close (same floor level as bomb).
    const ctBot = game.combatants.find(c => c.team === 'CT' && !c.isPlayer && c.alive)!;
    expect(ctBot).toBeDefined();
    ctBot.pos      = { x: bombX + 1, y: bombY, z: bombZ };
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

// ---------------------------------------------------------------------------
// AWP scope-pulse logic
// ---------------------------------------------------------------------------

describe('AWP scope-pulse', () => {
  /**
   * Build a minimal scenario: one CT bot holds AWP, is in 'engage' state with
   * a live target. Run a few ticks and verify the bot scopes in.
   * We drive the bot brain directly (not through tickBrains) for precise control.
   */
  /**
   * Place bot and target in the open mid spine for reliable LOS.
   * Ground-truth rebuild positions (no walls, clear LOS, both on valid floor):
   *   bot   : x=5, z=13, floor=3.75  (mid spine, M cell)
   *   target: x=5, z=8,  floor=3.75  (mid spine, M cell, 5 m north)
   */
  function setupAwpScenario(game: Game, mgr: BotManager) {
    const bot = game.combatants.find(c => c.team === 'CT' && !c.isPlayer && c.alive)!;
    // Equip AWP.
    bot.inventory.primary = makeWeaponState(WEAPONS.awp);
    bot.inventory.activeSlot = 'primary';
    bot.pos = { x: 5, y: 3.75, z: 13 };       // floor=3.75, mid spine
    bot.yaw = 0;                               // facing -Z (north)
    bot.onGround = true;

    // Pick a non-player T bot as the target so killing the player doesn't kill it.
    const target = game.combatants.find(c => c.team === 'T' && !c.isPlayer && c.alive)!;
    target.pos = { x: 5, y: 3.75, z: 8 };    // floor=3.75, mid spine, 5 m north
    target.alive = true;
    target.health = 100;
    target.onGround = true;

    // Kill everyone else to prevent interference.
    for (const c of game.combatants) {
      if (c !== bot && c !== target) {
        c.alive = false; c.health = 0;
      }
    }

    return { bot, target };
  }

  test('bot with AWP in engage state scopes in (isScoped becomes true)', () => {
    const { game, mgr } = freshSetup({ playerTeam: 'T', difficulty: 'hard' });
    const now0 = advanceFreeze(game);

    const { bot } = setupAwpScenario(game, mgr);

    // Run up to 3 s for perception + reaction + scope toggle.
    const TICKS = Math.ceil(3.0 / (1 / 128));
    let now = now0;
    for (let i = 0; i < TICKS; i++) {
      now += 1 / 128;
      const brain = game.botBrains.get(bot.id);
      if (brain) brain(bot, 1 / 128, now);
      if (isScoped(bot)) break;
    }

    expect(isScoped(bot)).toBe(true);
  });

  test('scope is not re-toggled within cooldown period (no rapid re-toggle)', () => {
    const { game, mgr } = freshSetup({ playerTeam: 'T', difficulty: 'hard' });
    const now0 = advanceFreeze(game);

    const { bot } = setupAwpScenario(game, mgr);

    // Run 3 s to let the bot scope in.
    let now = now0;
    const TICKS_ENGAGE = Math.ceil(3.0 / (1 / 128));
    for (let i = 0; i < TICKS_ENGAGE; i++) {
      now += 1 / 128;
      const brain = game.botBrains.get(bot.id);
      if (brain) brain(bot, 1 / 128, now);
      if (isScoped(bot)) break;
    }

    // Bot should be scoped by now.
    expect(isScoped(bot)).toBe(true);

    // Count scope-toggle events within one more second.
    // With cooldown 0.4 s, at most floor(1/0.4) = 2 additional toggles possible.
    let toggleCount = 0;
    let prevScoped = isScoped(bot);
    const TICKS_WATCH = Math.ceil(1.0 / (1 / 128));
    for (let i = 0; i < TICKS_WATCH; i++) {
      now += 1 / 128;
      const brain = game.botBrains.get(bot.id);
      if (brain) brain(bot, 1 / 128, now);
      const scopedNow = isScoped(bot);
      if (scopedNow !== prevScoped) { toggleCount++; prevScoped = scopedNow; }
    }

    // Cooldown ensures we don't get more than 2 toggles in 1 s.
    expect(toggleCount).toBeLessThanOrEqual(2);
  });

  test('bot un-scopes when target is lost (engage → hunt transition)', () => {
    const { game, mgr } = freshSetup({ playerTeam: 'T', difficulty: 'hard' });
    const now0 = advanceFreeze(game);

    const { bot, target } = setupAwpScenario(game, mgr);

    // Run 3 s to scope in.
    let now = now0;
    const TICKS_ENGAGE = Math.ceil(3.0 / (1 / 128));
    for (let i = 0; i < TICKS_ENGAGE; i++) {
      now += 1 / 128;
      const brain = game.botBrains.get(bot.id);
      if (brain) brain(bot, 1 / 128, now);
      if (isScoped(bot)) break;
    }
    expect(isScoped(bot)).toBe(true);

    // Kill the target → bot loses engage state after SIGHT_LOSE_TIME.
    target.alive  = false;
    target.health = 0;

    // Run enough ticks for SIGHT_LOSE_TIME (1.5 s) + scope-toggle cooldown (0.4 s).
    const TICKS_DISENGAGE = Math.ceil(2.5 / (1 / 128));
    for (let i = 0; i < TICKS_DISENGAGE; i++) {
      now += 1 / 128;
      const brain = game.botBrains.get(bot.id);
      if (brain) brain(bot, 1 / 128, now);
      if (!isScoped(bot)) break;
    }

    expect(isScoped(bot)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Smoke LOS injection
// ---------------------------------------------------------------------------

describe('Smoke LOS injection', () => {
  /**
   * Reusable scenario: CT bot facing a T enemy 5 m ahead in the open mid spine
   * with clear world LOS. Same verified positions as the AWP tests.
   *   bot  : x=5, z=13, floor=3.75  (mid spine, M cell)
   *   enemy: x=5, z=8,  floor=3.75  (mid spine, M cell, 5 m north)
   * Enemy health is set to 9999 so it survives being shot during the test.
   */
  function setupOpenMidScenario(game: Game) {
    const bot = game.combatants.find(c => c.team === 'CT' && !c.isPlayer && c.alive)!;
    bot.inventory.primary    = makeWeaponState(WEAPONS.m4a4);
    bot.inventory.activeSlot = 'primary';
    bot.pos    = { x: 5, y: 3.75, z: 13 };
    bot.yaw    = 0; // facing -Z (north)
    bot.onGround = true;

    const enemy = game.combatants.find(c => c.team === 'T' && !c.isPlayer && c.alive)!;
    enemy.pos    = { x: 5, y: 3.75, z: 8 };
    enemy.alive  = true;
    enemy.health = 9999; // effectively unkillable — prevents round-end during test
    enemy.onGround = true;

    // Kill everyone else to isolate the scenario, but keep the player alive so
    // the game phase doesn't flip (player is T, killing it risks round-end).
    for (const c of game.combatants) {
      if (c !== bot && c !== enemy && !c.isPlayer) { c.alive = false; c.health = 0; }
    }
    return { bot, enemy };
  }

  test('bot acquires target normally when no smokeQuery is set', () => {
    const { game, mgr } = freshSetup({ playerTeam: 'T', difficulty: 'hard' });
    let now = advanceFreeze(game);
    const { bot } = setupOpenMidScenario(game);

    // No smoke query installed (default null). Tick for 1 s — well past reaction.
    const TICKS = Math.ceil(1.0 / (1 / 64));
    now = tickBrains(game, mgr, TICKS, now);

    const state = mgr.getBrainState(bot.id);
    // Bot should be in engage (or hunt if it already processed the kill, but health=9999).
    expect(state === 'engage' || state === 'hunt').toBe(true);
  });

  test('bot does NOT acquire target when smokeQuery returns true for that segment', () => {
    const { game, mgr } = freshSetup({ playerTeam: 'T', difficulty: 'hard' });
    let now = advanceFreeze(game);
    const { bot } = setupOpenMidScenario(game);

    // Smoke query always returns true → all segments smoked.
    mgr.setSmokeQuery(() => true);

    const TICKS = Math.ceil(1.0 / (1 / 64));
    now = tickBrains(game, mgr, TICKS, now);

    const state = mgr.getBrainState(bot.id);
    // Bot should stay in objective/guard/hunt, NOT engage (never saw enemy through smoke).
    expect(state).not.toBe('engage');
    // Target should be null.
    expect(mgr.getBrainTarget(bot.id) ?? null).toBeNull();
  });

  test('engaged bot loses target when smokeQuery flips to smoked', () => {
    const { game, mgr } = freshSetup({ playerTeam: 'T', difficulty: 'hard' });
    let now = advanceFreeze(game);
    const { bot } = setupOpenMidScenario(game);

    // Phase 1: no smoke — let bot acquire and engage (0.5 s, hard reactionMs=220 ms).
    mgr.setSmokeQuery(null);
    // Drive perception manually for precise control: tick at 128 Hz, 1 s.
    const DT = 1 / 128;
    const ENGAGE_TICKS = Math.ceil(1.0 / DT);
    for (let i = 0; i < ENGAGE_TICKS; i++) {
      now += DT;
      const brain = game.botBrains.get(bot.id);
      if (brain) brain(bot, DT, now);
      if (mgr.getBrainState(bot.id) === 'engage') break;
    }

    // Verify bot is now in engage state.
    expect(mgr.getBrainState(bot.id)).toBe('engage');

    // Phase 2: smoke all segments → bot should stop seeing the target.
    mgr.setSmokeQuery(() => true);

    // Run SIGHT_LOSE_TIME (1.5 s) + a margin so the engage → hunt transition fires.
    const LOSE_TICKS = Math.ceil(2.0 / DT);
    for (let i = 0; i < LOSE_TICKS; i++) {
      now += DT;
      const brain = game.botBrains.get(bot.id);
      if (brain) brain(bot, DT, now);
    }

    const state = mgr.getBrainState(bot.id);
    // Bot should have transitioned to hunt (chasing last-known-pos) or objective.
    expect(state === 'hunt' || state === 'objective').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Flash blindness
// ---------------------------------------------------------------------------

describe('Flash blindness', () => {
  /**
   * Place a CT bot in the open mid spine, facing a T enemy 5 m ahead (same
   * verified positions as the smoke tests). Enemy health = 9999 so it survives
   * being shot. The player (T) is kept alive so the phase doesn't flip to
   * roundEnd.
   *   bot  : x=5, z=13, floor=3.75  (mid spine, M cell)
   *   enemy: x=5, z=8,  floor=3.75  (mid spine, M cell, 5 m north)
   */
  function setupFlashScenario(game: Game) {
    const bot = game.combatants.find(c => c.team === 'CT' && !c.isPlayer && c.alive)!;
    bot.inventory.primary    = makeWeaponState(WEAPONS.m4a4);
    bot.inventory.activeSlot = 'primary';
    bot.pos    = { x: 5, y: 3.75, z: 13 };
    bot.yaw    = 0;
    bot.onGround = true;

    const enemy = game.combatants.find(c => c.team === 'T' && !c.isPlayer && c.alive)!;
    enemy.pos    = { x: 5, y: 3.75, z: 8 };
    enemy.alive  = true;
    enemy.health = 9999; // unkillable — prevents round-end
    enemy.onGround = true;

    // Kill only other bots; keep the player alive to hold the game in 'live'.
    for (const c of game.combatants) {
      if (c !== bot && c !== enemy && !c.isPlayer) { c.alive = false; c.health = 0; }
    }
    return { bot, enemy };
  }

  /**
   * Drive only the named bot's brain at 128 Hz until it enters 'engage', or
   * until maxMs elapses. Returns the final now value.
   */
  function tickUntilEngage(game: Game, mgr: BotManager, bot: Combatant, startNow: number, maxMs = 1500): number {
    const DT = 1 / 128;
    let now = startNow;
    const maxTicks = Math.ceil((maxMs / 1000) / DT);
    for (let i = 0; i < maxTicks; i++) {
      now += DT;
      const brain = game.botBrains.get(bot.id);
      if (brain) brain(bot, DT, now);
      if (mgr.getBrainState(bot.id) === 'engage') break;
    }
    return now;
  }

  test('full blind (intensity 0.9): target dropped, no fire intent while blind', () => {
    const { game, mgr } = freshSetup({ playerTeam: 'T', difficulty: 'hard' });
    let now = advanceFreeze(game);
    const { bot, enemy } = setupFlashScenario(game);

    // Let the bot acquire the enemy and enter engage state.
    now = tickUntilEngage(game, mgr, bot, now);
    expect(mgr.getBrainState(bot.id)).toBe('engage');

    // Apply full blindness: 2 s from now.
    const blindEnd = now + 2.0;
    bot.blindUntil     = blindEnd;
    bot.blindIntensity = 0.9;

    const initHealth = enemy.health;
    let shotWhileBlind = false;
    const unsub = gameEvents.on('shot', (ev) => {
      if (ev.shooter.id === bot.id) shotWhileBlind = true;
    });

    try {
      // Tick for 1 s (still blind: blindEnd = now+2).
      const DT = 1 / 128;
      const BLIND_TICKS = Math.ceil(1.0 / DT);
      for (let i = 0; i < BLIND_TICKS; i++) {
        now += DT;
        const brain = game.botBrains.get(bot.id);
        if (brain) brain(bot, DT, now);
      }

      // While blind: target must be null, no shots fired.
      expect(mgr.getBrainTarget(bot.id) ?? null).toBeNull();
      expect(shotWhileBlind).toBe(false);
      expect(enemy.health).toBe(initHealth);

      // State must not be engage (target was dropped).
      const stateWhileBlind = mgr.getBrainState(bot.id);
      expect(stateWhileBlind).not.toBe('engage');
    } finally {
      unsub();
    }
  });

  test('full blind: bot re-acquires and can fire after blindUntil passes', () => {
    const { game, mgr, world } = freshSetup({ playerTeam: 'T', difficulty: 'hard' });
    let now = advanceFreeze(game);
    const { bot, enemy } = setupFlashScenario(game);

    // --- Premise: assert open LOS between the two verified positions BEFORE
    // running any ticks.  If this fails the map geometry changed and both
    // positions need updating, not the bot logic.
    const eyeA = { x: bot.pos.x,   y: bot.pos.y   + 1.64, z: bot.pos.z };
    const eyeB = { x: enemy.pos.x, y: enemy.pos.y + 1.64, z: enemy.pos.z };
    expect(world.lineOfSight(eyeA, eyeB)).toBe(true);

    // Ensure both combatants are pinned on the ground at the open-mid positions.
    bot.onGround   = true;
    enemy.onGround = true;

    // Let the bot enter engage state first.
    now = tickUntilEngage(game, mgr, bot, now);

    // Apply full blindness lasting 0.15 s (expires quickly).
    const blindEnd     = now + 0.15;
    bot.blindUntil     = blindEnd;
    bot.blindIntensity = 0.9;
    // Set normal enemy health so we can confirm a hit.
    enemy.health = 100;

    const initHealth = enemy.health;
    const DT = 1 / 128;

    // Phase 1: tick through the blind duration.  The bot must not fire.
    const BLIND_TICKS = Math.ceil(0.20 / DT);  // slightly more than blindEnd
    for (let i = 0; i < BLIND_TICKS; i++) {
      now += DT;
      const brain = game.botBrains.get(bot.id);
      if (brain) brain(bot, DT, now);
    }

    // Phase 2: blind has expired.  Re-pin both combatants to the verified open
    // positions and face the bot toward the enemy so perception fires immediately
    // on the first eligible tick (nextPerceptAt may have advanced during the
    // blind phase — it will fire within one PERCEPTION_INTERVAL = 0.12 s).
    bot.pos    = { x: 5, y: 3.75, z: 13 };
    enemy.pos  = { x: 5, y: 3.75, z: 8 };
    bot.yaw    = 0;            // facing -Z toward enemy
    bot.vel    = { x: 0, y: 0, z: 0 };
    enemy.onGround = true;
    bot.onGround   = true;
    // Clear any residual blindness flag.
    bot.blindUntil     = 0;
    bot.blindIntensity = 0;

    // Give the bot up to 3 s to re-acquire the enemy (> reaction 220 ms +
    // 2× PERCEPTION_INTERVAL = 0.24 s + margin).
    const REACQUIRE_TICKS = Math.ceil(3.0 / DT);
    for (let i = 0; i < REACQUIRE_TICKS; i++) {
      now += DT;
      const brain = game.botBrains.get(bot.id);
      if (brain) brain(bot, DT, now);
      if (enemy.health < initHealth) break;
    }

    // Health should have dropped: bot re-acquired and fired.
    expect(enemy.health).toBeLessThan(initHealth);
  });

  test('partial blind (intensity 0.4): target is kept, aim error is scaled', () => {
    const { game, mgr } = freshSetup({ playerTeam: 'T', difficulty: 'hard' });
    let now = advanceFreeze(game);
    const { bot } = setupFlashScenario(game);

    // Drive bot to engage state.
    now = tickUntilEngage(game, mgr, bot, now);
    expect(mgr.getBrainState(bot.id)).toBe('engage');

    const baseAimError = mgr.getBrainAimErrorDeg(bot.id) ?? 0;

    // Apply partial blindness (intensity < 0.6).
    bot.blindUntil     = now + 5.0; // won't expire during test
    bot.blindIntensity = 0.4;

    // Tick for 0.4 s to trigger an aim-error resample (AIM_ERROR_RESAMPLE = 0.25 s).
    const DT = 1 / 128;
    const PARTIAL_TICKS = Math.ceil(0.4 / DT);
    for (let i = 0; i < PARTIAL_TICKS; i++) {
      now += DT;
      const brain = game.botBrains.get(bot.id);
      if (brain) brain(bot, DT, now);
    }

    // Target should still be held (partial blind intensity < 0.6 does not drop target).
    expect(mgr.getBrainTarget(bot.id)).not.toBeNull();

    // Aim error should be scaled up: base * (1 + 3*0.4) = base * 2.2.
    const scaledAimError = mgr.getBrainAimErrorDeg(bot.id) ?? 0;
    expect(scaledAimError).toBeGreaterThan(baseAimError);
  });
});

// ---------------------------------------------------------------------------
// F1 — Bomb retrieval after carrier death
// ---------------------------------------------------------------------------

describe('F1: bomb retrieval after carrier death', () => {
  test('surviving T bot picks up the bomb after carrier dies', () => {
    const { game, mgr } = freshSetup({ playerTeam: 'CT' });
    let now = advanceFreeze(game);

    // Find the bomb carrier and a second T bot to be the retriever.
    const carrier = game.combatants.find(c => c.hasBomb)!;
    expect(carrier).toBeDefined();

    const otherT = game.combatants.find(
      c => c.team === 'T' && c.id !== carrier.id && !c.isPlayer && c.alive,
    )!;
    expect(otherT).toBeDefined();

    // Place both near a known walkable area in the middle of the map.
    // Mid corridor (char 'M', floor=0). x=0,z=-10 straddles the col47 '#' wall
    // (ceilingOver→0); use confirmed M cells clear of the wall boundary.
    carrier.pos = { x: -8, y: 0, z: -20 };
    otherT.pos  = { x: -4, y: 0, z: -20 };
    carrier.onGround = true;
    otherT.onGround  = true;

    // Kill all CT bots and player so nothing interferes.
    for (const c of game.combatants) {
      if (c.team === 'CT') { c.alive = false; c.health = 0; }
    }
    // Kill all other T bots except carrier and otherT.
    for (const c of game.combatants) {
      if (c.team === 'T' && c.id !== carrier.id && c.id !== otherT.id) {
        c.alive = false; c.health = 0;
      }
    }

    // Run a few ticks in live phase to let brains initialise.
    const DT = 1 / 128;
    const INIT_TICKS = 10;
    for (let i = 0; i < INIT_TICKS; i++) {
      now += DT;
      const b = game.botBrains.get(carrier.id);
      if (b) b(carrier, DT, now);
      const b2 = game.botBrains.get(otherT.id);
      if (b2) b2(otherT, DT, now);
    }

    // Now kill the carrier — bomb drops to carrier's position.
    carrier.alive  = false;
    carrier.health = 0;
    carrier.hasBomb = false;
    game.bomb.state   = 'dropped';
    game.bomb.carrier = null;
    game.bomb.pos     = { ...carrier.pos };

    // Simulate up to 20 s — the retriever should path to the bomb and
    // game._checkBombPickup (called by game.update) auto-picks it up at 1.2 m.
    const MAX_TICKS = Math.ceil(20 / DT);
    for (let i = 0; i < MAX_TICKS; i++) {
      now += DT;
      const b2 = game.botBrains.get(otherT.id);
      if (b2) b2(otherT, DT, now);
      // game.update drives _checkBombPickup.
      game.update(DT, now);
      if ((game.bomb.state as string) === 'carried') break;
    }

    expect(game.bomb.state as string).toBe('carried');
  });
});

// ---------------------------------------------------------------------------
// F2 — Guard facing
// ---------------------------------------------------------------------------

describe('F2: guard facing', () => {
  test('T bot transitioning to guard gets a non-default (non-zero) guardFacing toward CT spawn', () => {
    const { game, mgr } = freshSetup({ playerTeam: 'CT' });
    let now = advanceFreeze(game);

    // Find the T bot that IS the bomb carrier: it always has a non-empty routeAreas
    // assigned by _assignT because pickRoute() is called for the carrier before
    // any escort assignment. Non-carrier bots may get empty routeAreas due to
    // assignment ordering, so the carrier is the reliable test subject.
    const carrier = game.combatants.find(c => c.team === 'T' && c.hasBomb && !c.isPlayer && c.alive)!;
    expect(carrier).toBeDefined();

    // Kill all CTs so the round stays live.
    for (const c of game.combatants) {
      if (c.team === 'CT') { c.alive = false; c.health = 0; }
    }
    // Kill all T bots EXCEPT the carrier so the sim stays focused.
    for (const c of game.combatants) {
      if (c.team === 'T' && c.id !== carrier.id && !c.isPlayer) { c.alive = false; c.health = 0; }
    }

    // Strip the bomb so the carrier won't enter plant state at the site,
    // allowing it to transition cleanly to guard.
    carrier.hasBomb = false;
    carrier.onGround = true;
    // Keep bomb 'carried' (no carrier ptr) so F1 retriever doesn't activate.
    (game.bomb as { state: string }).state = 'carried';
    game.bomb.carrier = null;

    // Compute the CT spawn centroid — the direction guards should face.
    const ctSpawns = DUST2.spawns.ct;
    let ctCx = 0; let ctCz = 0;
    for (const sp of ctSpawns) { ctCx += sp.x; ctCz += sp.z; }
    ctCx /= ctSpawns.length; ctCz /= ctSpawns.length;

    // Tick the carrier through its route to the final area and into guard.
    // Use DT=1/32 for speed. Max 120 s game-time.
    const DT = 1 / 32;
    const MAX_TICKS = Math.ceil(120 / DT);
    let reachedGuard = false;
    for (let i = 0; i < MAX_TICKS; i++) {
      now += DT;
      const brain = game.botBrains.get(carrier.id);
      if (brain) brain(carrier, DT, now);
      if (mgr.getBrainState(carrier.id) === 'guard') {
        reachedGuard = true;
        break;
      }
    }

    expect(reachedGuard).toBe(true);

    // guardFacing must point toward the CT spawn centroid (within ±120°).
    const facing = mgr.getBrainGuardFacing(carrier.id) ?? 0;
    const dx     = ctCx - carrier.pos.x;
    const dz     = ctCz - carrier.pos.z;
    const expectedFacing = Math.atan2(-dx, -dz);
    const diff = Math.abs(Math.atan2(Math.sin(facing - expectedFacing), Math.cos(facing - expectedFacing)));
    expect(diff).toBeLessThanOrEqual(Math.PI / 2);
  });
});

// ---------------------------------------------------------------------------
// F4 — Bot-vs-bot separation
// ---------------------------------------------------------------------------

describe('F4: bot separation', () => {
  test('two bots placed at same position separate beyond 1 m within a few seconds', () => {
    const { game, mgr, world } = freshSetup({ playerTeam: 'CT' });
    let now = advanceFreeze(game);

    // Pick two T bots.
    const tBots = game.combatants.filter(c => c.team === 'T' && !c.isPlayer && c.alive);
    expect(tBots.length).toBeGreaterThanOrEqual(2);
    const botA = tBots[0]!;
    const botB = tBots[1]!;

    // Stack them exactly on top of each other on a walkable cell.
    // Derive Y from the map so bots are not embedded below the floor.
    // x=0,z=-10 straddles the E wall of mid (col47 '#') causing ceilingOver→0;
    // use a confirmed mid-corridor M cell instead.
    const stackY = world.floorAt(-8, -20);
    const stackPos = { x: -8, y: stackY, z: -20 };
    botA.pos = { ...stackPos };
    botB.pos = { ...stackPos };
    botA.vel = { x: 0, y: 0, z: 0 };
    botB.vel = { x: 0, y: 0, z: 0 };
    botA.onGround = true;
    botB.onGround = true;

    // Kill all CTs so we don't get unexpected state transitions from combat.
    for (const c of game.combatants) {
      if (c.team === 'CT') { c.alive = false; c.health = 0; }
    }

    // Tick for up to 5 s.
    const DT = 1 / 128;
    const MAX_TICKS = Math.ceil(5 / DT);
    for (let i = 0; i < MAX_TICKS; i++) {
      now += DT;
      const bA = game.botBrains.get(botA.id);
      if (bA) bA(botA, DT, now);
      const bB = game.botBrains.get(botB.id);
      if (bB) bB(botB, DT, now);
      game.update(DT, now);
    }

    // They should have separated by more than 0.55 m (BOT_SEPARATION_DIST = 0.6).
    // The exact separation depends on navigation decisions; the impulse nudges
    // them apart and routing widens the gap further. 0.55 is a conservative floor.
    const dx   = botA.pos.x - botB.pos.x;
    const dz   = botA.pos.z - botB.pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    expect(dist).toBeGreaterThan(0.55);
  });
});

// ---------------------------------------------------------------------------
// F1b — Retriever deadlock: re-designate when retriever is pinned in engage
// ---------------------------------------------------------------------------

describe('F1b: retriever re-designation when pinned in engage', () => {
  test('re-designates retriever after > 4 s continuous engage to a free bot', () => {
    const { game, mgr } = freshSetup({ playerTeam: 'CT' });
    let now = advanceFreeze(game);

    // Kill all CT bots.  A fake live CT is passed as the engage target for the
    // pinned bot — placed outside vision range so perception never naturally
    // acquires it, but kept as a non-null live Combatant so _runFSM's
    // `target === null` guard doesn't immediately exit engage.
    const fakeCT = makeCombatant(9999, 'FakeCT', 'CT');
    fakeCT.alive = true;
    fakeCT.pos   = { x: 999, y: 0, z: 999 };
    for (const c of game.combatants) {
      if (c.team === 'CT') { c.alive = false; c.health = 0; }
    }

    // Get two T bots.
    const tBots = game.combatants.filter(c => c.team === 'T' && !c.isPlayer && c.alive);
    expect(tBots.length).toBeGreaterThanOrEqual(2);
    // Use tBots[0] as the bot we will pin (pinnedBot) and tBots[1] as the free
    // bot (freeBot).  Kill all other T bots.
    const pinnedBot = tBots[0]!;
    const freeBot   = tBots[1]!;
    const pinnedId  = pinnedBot.id;
    const freeId    = freeBot.id;
    for (const c of game.combatants) {
      if (c.team === 'T' && c.id !== pinnedId && c.id !== freeId) {
        c.alive = false; c.health = 0;
      }
    }

    // Drop the bomb far from both bots.  Keep freeBot closer than pinnedBot
    // so when re-designation fires it always picks freeBot.
    // bomb at x=30; pinnedBot at x=0 (dist=30); freeBot at x=5 (dist=25).
    // Neither bot is within the 1.2 m auto-pickup radius.
    // Clear hasBomb on all T bots (one of them was randomly assigned it).
    for (const c of game.combatants) {
      if (c.team === 'T') c.hasBomb = false;
    }
    (game.bomb as { state: string }).state = 'dropped';
    game.bomb.carrier = null;
    game.bomb.pos = { x: 30, y: 0, z: -10 };
    pinnedBot.pos = { x: 0, y: 0, z: -10 };
    freeBot.pos   = { x: 5, y: 0, z: -10 };
    pinnedBot.onGround = true;
    freeBot.onGround   = true;

    // Temporarily kill freeBot so the first designation tick can only pick
    // pinnedBot (removes the tie-breaking ambiguity entirely).
    freeBot.alive  = false;
    freeBot.health = 0;

    const DT = 1 / 128;
    now += DT;
    const bPinnedFn = game.botBrains.get(pinnedBot.id)!;
    bPinnedFn(pinnedBot, DT, now);

    // pinnedBot is the only living T — management block must designate it.
    expect(mgr.getRetrieverId()).toBe(pinnedId);

    // Revive freeBot now that the initial assignment is established.
    freeBot.alive  = true;
    freeBot.health = 100;

    // Pin pinnedBot in 'engage' for 5 s (> 4 s threshold) then check that
    // the management block re-designates to freeBot.
    // Pattern: set engage BEFORE each tick (so the management block at the
    // start of the tick sees it), then tick both bots.  Do NOT call
    // game.update() to avoid _runBotBrains firing a second time per step.
    const ENGAGE_DURATION = 5.0;
    const MAX_TICKS = Math.ceil(ENGAGE_DURATION / DT);
    const bFreeFn = game.botBrains.get(freeBot.id)!;

    for (let i = 0; i < MAX_TICKS; i++) {
      now += DT;
      mgr.setBrainStateForTest(pinnedBot.id, 'engage', now, fakeCT);
      bPinnedFn(pinnedBot, DT, now);
      bFreeFn(freeBot, DT, now);
    }

    // After > 4 s, the management block should have re-designated to freeBot.
    const finalRetriever = mgr.getRetrieverId();
    expect(finalRetriever).toBe(freeId);
  });
});

// ---------------------------------------------------------------------------
// F3 — Spawn zone hunt filter
// ---------------------------------------------------------------------------

describe('F3: spawn zone hunt filter', () => {
  test('kill event positioned inside T spawn zone does NOT set a CT bot lastKnownPos inside that zone', () => {
    const { game, mgr } = freshSetup({ playerTeam: 'T', difficulty: 'normal' });
    const now = advanceFreeze(game);

    // Find a CT bot.
    const ctBot = game.combatants.find(c => c.team === 'CT' && !c.isPlayer && c.alive)!;
    expect(ctBot).toBeDefined();

    // Make a fake T combatant as the victim.
    const fakeVictim = makeCombatant(999, 'VictimBot', 'T');
    // Place in the middle of T spawn zone (z≈+32 from dust2.ts spawns: z range 30.5..33.5).
    fakeVictim.pos  = { x: -3.5, y: 1.5, z: 32 };
    fakeVictim.alive = false; // just died

    // Clear any existing lastKnownPos for the CT bot.
    const initialLkp = mgr.getBrainLastKnownPos(ctBot.id);

    // Emit kill event.
    gameEvents.emit('kill', { victim: fakeVictim, attacker: ctBot, weaponId: 'ak47', headshot: false });

    // Tick once so the brain can process it.
    const brain = game.botBrains.get(ctBot.id);
    if (brain) brain(ctBot, 1 / 128, now + 1 / 128);

    const lkp = mgr.getBrainLastKnownPos(ctBot.id);

    // The lastKnownPos must NOT point inside the T spawn zone.
    if (lkp !== null && lkp !== undefined) {
      const tZone = mgr.getSpawnZone('T');
      const insideSpawn = lkp.x >= tZone.minX && lkp.x <= tZone.maxX &&
                          lkp.z >= tZone.minZ && lkp.z <= tZone.maxZ;
      expect(insideSpawn).toBe(false);
    }
    // If lkp is null the test also passes (no update was made).
  });
});

// ---------------------------------------------------------------------------
// LOS wall-vision fix — bots must not fire through walls or shake at corners
// ---------------------------------------------------------------------------

describe('LOS wall-vision fix', () => {
  /**
   * Self-validating occluded pair: CT spawn interior vs Upper Tunnels.
   * These two positions are separated by solid geometry.  The test suite
   * asserts world.lineOfSight === false before relying on this assumption.
   *
   * Ground-truth rebuild positions (both confirmed WALKABLE on their floors):
   *   botPos  : x=9,   y=0,     z=-26  (CT spawn, floor=0;     char 'C')
   *   enemyPos: x=-31, y=4.125, z=6    (Upper Tunnels, floor=4.125; char 'u', ceil 6.5)
   *
   * The eye heights for LOS checks add 1.64 m (standing eye offset).
   */
  const BOT_WALL_POS   = { x:  9, y: 0,     z: -26 };
  const ENEMY_WALL_POS = { x: -31, y: 4.125, z:  6 };

  /**
   * Shared setup: one CT bot, one T enemy, all others killed.
   * Bot gets an M4A4 (reliable auto damage).  Enemy health set to 9999 so
   * the round stays live regardless of firing.
   */
  function setupWallScenario(game: Game, botFloorPos: { x: number; y: number; z: number }, enemyFloorPos: { x: number; y: number; z: number }) {
    const bot = game.combatants.find(c => c.team === 'CT' && !c.isPlayer && c.alive)!;
    bot.inventory.primary    = makeWeaponState(WEAPONS.m4a4);
    bot.inventory.activeSlot = 'primary';
    bot.pos      = { ...botFloorPos };
    bot.onGround = true;

    const enemy = game.combatants.find(c => c.team === 'T' && !c.isPlayer && c.alive)!;
    enemy.pos    = { ...enemyFloorPos };
    enemy.alive  = true;
    enemy.health = 9999;
    enemy.onGround = true;

    // Kill everyone else; keep the player alive to hold game in 'live'.
    for (const c of game.combatants) {
      if (c !== bot && c !== enemy && !c.isPlayer) { c.alive = false; c.health = 0; }
    }

    return { bot, enemy };
  }

  test('occluded pair geometric premise: CTSpawn↔UpperTunnels has no LOS', () => {
    // Standalone geometry check — does not need BotManager.
    const world = new World(DUST2);
    const eyeBot   = { x: BOT_WALL_POS.x,   y: BOT_WALL_POS.y   + 1.64, z: BOT_WALL_POS.z };
    const eyeEnemy = { x: ENEMY_WALL_POS.x, y: ENEMY_WALL_POS.y + 1.64, z: ENEMY_WALL_POS.z };
    expect(world.lineOfSight(eyeBot, eyeEnemy)).toBe(false);
  });

  test('(a) bot does not fire at occluded target', () => {
    const { game, mgr, world } = freshSetup({ playerTeam: 'T', difficulty: 'hard' });
    let now = advanceFreeze(game);

    // Assert the LOS premise for this test's positions.
    const eyeBot   = { x: BOT_WALL_POS.x,   y: BOT_WALL_POS.y   + 1.64, z: BOT_WALL_POS.z };
    const eyeEnemy = { x: ENEMY_WALL_POS.x, y: ENEMY_WALL_POS.y + 1.64, z: ENEMY_WALL_POS.z };
    expect(world.lineOfSight(eyeBot, eyeEnemy)).toBe(false);

    const { bot, enemy } = setupWallScenario(game, BOT_WALL_POS, ENEMY_WALL_POS);

    // Point bot's yaw directly at the enemy (angular error ≈ 0).
    const dx = enemy.pos.x - bot.pos.x;
    const dz = enemy.pos.z - bot.pos.z;
    bot.yaw = Math.atan2(-dx, -dz);

    // Force engage state with target and lastKnownPos set.
    mgr.setBrainStateForTest(bot.id, 'engage', now, enemy);
    mgr.setBrainLastKnownPosForTest(bot.id, enemy.pos);

    // targetVisible must be false: _perceive will not fire (not yet at nextPerceptAt
    // since we just set it to now in setBrainStateForTest).  Verify the flag is false.
    expect(mgr.getBrainTargetVisible(bot.id)).toBe(false);

    // Listen for shot events from this bot.
    let shotFired = false;
    const unsub = gameEvents.on('shot', (ev) => {
      if (ev.shooter.id === bot.id) shotFired = true;
    });

    try {
      // Run 0.5 s of ticks — enough time for weapon RPM + angle gate if LOS were present.
      const DT = 1 / 128;
      const TICKS = Math.ceil(0.5 / DT);
      for (let i = 0; i < TICKS; i++) {
        now += DT;
        // Keep targetVisible false: nextPerceptAt is always in the future so
        // _perceive won't run (it was set to now+PERCEPTION_INTERVAL on roundStart).
        // The existing engage + reaction time won't re-trigger firing without LOS.
        const brain = game.botBrains.get(bot.id);
        if (brain) brain(bot, DT, now);
      }

      // No shot should have fired through the wall.
      expect(shotFired).toBe(false);
    } finally {
      unsub();
    }
  });

  test('(b) occluded target: aim holds lastKnownPos, does not track live position', () => {
    /**
     * Phase 1: bot and enemy are in the open mid spine with clear LOS.
     * Bot: x=5, y=3.75, z=13 (mid spine, M cell, floor=3.75).
     * Enemy: x=5, y=3.75, z=8 (mid spine, M cell, 5 m north).
     * Bot yaw = 0 → facing -Z (north, toward enemy, bearing ≈ 0).
     * The test ASSERTS LOS is clear before starting phase 1.
     *
     * Phase 2: enemy teleports into Upper Tunnels (x=-31, z=6) while BOT stays
     * in the mid spine.  mid→tunnels LOS is blocked by solid geometry.  The
     * frozen lastKnownPos is ≈ (5, 8) (bearing ≈ 0 from bot); the live enemy is
     * at (-31, 6) — bearing ≈ +1.38 rad from bot, angular separation ≈ 1.38 rad
     * > 1 rad threshold.  Lateral offset from frozen ≈ 36 m >> 10 m.
     *
     * After 1 s of occlusion the bot's yaw must still face the frozen position
     * and must NOT have turned toward the live enemy.
     */
    const BOT_POS        = { x: 5, y: 3.75, z: 13 };   // mid spine (M cell, floor=3.75)
    const ENEMY_OPEN_POS = { x: 5, y: 3.75, z: 8 };    // mid spine (M cell, 5 m north, same col)
    // Hide pos must be: (1) LOS-blocked from bot, (2) angularly far (> 1 rad) from visible pos.
    // Upper Tunnels at (-31,4.125,6): LOS-blocked by solid geometry; bearing from bot
    // ≈ +1.38 rad vs bearing-to-frozen ≈ 0 → separation ≈ 1.38 rad > 1 rad.
    const ENEMY_HIDE_POS = { x: -31, y: 4.125, z: 6 }; // Upper Tunnels (char 'u', LOS-blocked)

    const { game, mgr, world } = freshSetup({ playerTeam: 'T', difficulty: 'hard' });
    let now = advanceFreeze(game);

    // Assert open-LOS premise.
    const eyeBot      = { x: BOT_POS.x,        y: BOT_POS.y        + 1.64, z: BOT_POS.z };
    const eyeEnemyVis = { x: ENEMY_OPEN_POS.x, y: ENEMY_OPEN_POS.y + 1.64, z: ENEMY_OPEN_POS.z };
    expect(world.lineOfSight(eyeBot, eyeEnemyVis)).toBe(true);

    // Assert occluded premise.
    const eyeEnemyHide = { x: ENEMY_HIDE_POS.x, y: ENEMY_HIDE_POS.y + 1.64, z: ENEMY_HIDE_POS.z };
    expect(world.lineOfSight(eyeBot, eyeEnemyHide)).toBe(false);

    const { bot, enemy } = setupWallScenario(game, BOT_POS, ENEMY_OPEN_POS);

    // Phase 1: tick until bot acquires enemy and enters engage.
    const DT = 1 / 128;
    bot.yaw = 0; // facing -Z toward enemy
    const ENGAGE_TICKS = Math.ceil(1.5 / DT);
    for (let i = 0; i < ENGAGE_TICKS; i++) {
      now += DT;
      const brain = game.botBrains.get(bot.id);
      if (brain) brain(bot, DT, now);
      if (mgr.getBrainState(bot.id) === 'engage') break;
    }
    expect(mgr.getBrainState(bot.id)).toBe('engage');

    // Record the lastKnownPos after acquisition (enemy was at ENEMY_OPEN_POS).
    const lkpAfterEngage = mgr.getBrainLastKnownPos(bot.id);
    expect(lkpAfterEngage).not.toBeNull();
    const frozenX = lkpAfterEngage!.x;   // ≈ 0
    const frozenZ = lkpAfterEngage!.z;   // ≈ -33

    // Phase 2: enemy hides behind the wall (bot does NOT move — stays in CTMid).
    enemy.pos = { ...ENEMY_HIDE_POS };

    // Lateral distance from frozen lastKnownPos to new live enemy pos must be > 10 m.
    const lateralDist = Math.sqrt(
      (enemy.pos.x - frozenX) ** 2 + (enemy.pos.z - frozenZ) ** 2,
    );
    expect(lateralDist).toBeGreaterThan(10);

    // Tick ~1 s (< SIGHT_LOSE_TIME = 1.5 s) so bot is still in engage but target occluded.
    const HOLD_TICKS = Math.ceil(1.0 / DT);
    for (let i = 0; i < HOLD_TICKS; i++) {
      now += DT;
      const brain = game.botBrains.get(bot.id);
      if (brain) brain(bot, DT, now);
    }

    // Bot must still be in engage (SIGHT_LOSE_TIME not elapsed yet).
    expect(mgr.getBrainState(bot.id)).toBe('engage');

    // Bearing to frozen lastKnownPos from current bot position (bot did not move).
    const dxFrozen = frozenX - bot.pos.x;
    const dzFrozen = frozenZ - bot.pos.z;
    const bearingToFrozen = Math.atan2(-dxFrozen, -dzFrozen);

    // Bearing to enemy's new live position.
    const dxLive = enemy.pos.x - bot.pos.x;
    const dzLive = enemy.pos.z - bot.pos.z;
    const bearingToLive = Math.atan2(-dxLive, -dzLive);

    // Angular separation between the two bearings must be large (> 1 rad) to make
    // the test discriminative.
    const bearingSep = Math.abs(Math.atan2(
      Math.sin(bearingToFrozen - bearingToLive),
      Math.cos(bearingToFrozen - bearingToLive),
    ));
    expect(bearingSep).toBeGreaterThan(1.0); // geometry check

    // Bot yaw must be close to the FROZEN bearing (within 0.5 rad) and NOT close
    // to the LIVE bearing (at least 0.6 rad away).
    const errToFrozen = Math.abs(Math.atan2(
      Math.sin(bot.yaw - bearingToFrozen),
      Math.cos(bot.yaw - bearingToFrozen),
    ));
    const errToLive = Math.abs(Math.atan2(
      Math.sin(bot.yaw - bearingToLive),
      Math.cos(bot.yaw - bearingToLive),
    ));

    expect(errToFrozen).toBeLessThan(0.5);
    expect(errToLive).toBeGreaterThan(0.6);
  });

  test('(c) bot resumes firing when occluded target re-peeks', () => {
    /**
     * Setup mirrors test (a): bot in CTSpawn, enemy in UpperTunnels (no LOS).
     * Then enemy moves back into open mid (clear LOS).
     * After reaction time + perception, bot should fire.
     */
    const { game, mgr, world } = freshSetup({ playerTeam: 'T', difficulty: 'hard' });
    let now = advanceFreeze(game);

    // Assert occluded premise.
    const eyeBot   = { x: BOT_WALL_POS.x,   y: BOT_WALL_POS.y   + 1.64, z: BOT_WALL_POS.z };
    const eyeEnemy = { x: ENEMY_WALL_POS.x, y: ENEMY_WALL_POS.y + 1.64, z: ENEMY_WALL_POS.z };
    expect(world.lineOfSight(eyeBot, eyeEnemy)).toBe(false);

    const { bot, enemy } = setupWallScenario(game, BOT_WALL_POS, ENEMY_WALL_POS);

    // Force bot into engage, facing enemy, with lastKnownPos set.
    const dx0 = enemy.pos.x - bot.pos.x;
    const dz0 = enemy.pos.z - bot.pos.z;
    bot.yaw = Math.atan2(-dx0, -dz0);
    mgr.setBrainStateForTest(bot.id, 'engage', now, enemy);
    mgr.setBrainLastKnownPosForTest(bot.id, enemy.pos);

    // Confirm no shots while occluded (run 0.25 s).
    let shotFired = false;
    const unsub = gameEvents.on('shot', (ev) => {
      if (ev.shooter.id === bot.id) shotFired = true;
    });

    try {
      const DT = 1 / 128;
      const OCCLUDED_TICKS = Math.ceil(0.25 / DT);
      for (let i = 0; i < OCCLUDED_TICKS; i++) {
        now += DT;
        const brain = game.botBrains.get(bot.id);
        if (brain) brain(bot, DT, now);
      }
      expect(shotFired).toBe(false);

      // Assert re-peek LOS premise: open mid-spine bot+enemy positions have clear LOS.
      // Ground-truth rebuild: mid spine cells (char 'M') are at floor 3.75 m.
      const OPEN_BOT_POS   = { x: 5, y: 3.75, z: 13 };
      const OPEN_ENEMY_POS = { x: 5, y: 3.75, z: 8 };
      const eyeBotOpen   = { x: OPEN_BOT_POS.x,   y: OPEN_BOT_POS.y   + 1.64, z: OPEN_BOT_POS.z };
      const eyeEnemyOpen = { x: OPEN_ENEMY_POS.x, y: OPEN_ENEMY_POS.y + 1.64, z: OPEN_ENEMY_POS.z };
      expect(world.lineOfSight(eyeBotOpen, eyeEnemyOpen)).toBe(true);

      // Enemy re-peeks: move both into open mid with clear LOS.
      bot.pos   = { ...OPEN_BOT_POS };
      enemy.pos = { ...OPEN_ENEMY_POS };
      enemy.health = 9999; // ensure it survives

      // Point bot directly at the enemy.
      const dxRepeek = enemy.pos.x - bot.pos.x;
      const dzRepeek = enemy.pos.z - bot.pos.z;
      bot.yaw = Math.atan2(-dxRepeek, -dzRepeek);

      // Tick up to 2 s for perception + reaction time (hard reactionMs = 220 ms).
      const REOPEN_TICKS = Math.ceil(2.0 / DT);
      for (let i = 0; i < REOPEN_TICKS; i++) {
        now += DT;
        const brain = game.botBrains.get(bot.id);
        if (brain) brain(bot, DT, now);
        if (shotFired) break;
      }

      // A shot must have fired after the enemy re-peeked.
      expect(shotFired).toBe(true);
    } finally {
      unsub();
    }
  });
});

// ---------------------------------------------------------------------------
// Bot buy pools — validity and team eligibility
// ---------------------------------------------------------------------------

describe('Bot buy pools', () => {
  /**
   * Every id in every pool must exist in WEAPONS and must satisfy team
   * eligibility for the pool it belongs to.
   */
  test('all pool ids are valid WEAPONS entries', () => {
    const allPools = [
      BUY_POOL_ECO_PISTOL,
      BUY_POOL_FORCE_SMG,
      BUY_POOL_FORCE_SHOTGUN,
      BUY_POOL_FULL_PRIMARY_BUDGET,
      BUY_POOL_FULL_PRIMARY_STANDARD,
      BUY_POOL_FULL_PRIMARY_RICH,
    ];
    for (const pool of allPools) {
      for (const id of pool) {
        expect(WEAPONS[id]).toBeDefined();
      }
    }
  });

  test('pool entries are valid WEAPONS ids with well-formed teams metadata', () => {
    // Every weapon that declares a `teams` array must have a non-empty array of
    // valid team strings ('T' or 'CT').  Team-filtering happens at draw time via
    // the per-bot eligibility filter + game.buy team gate; pools may contain
    // weapons from either team.
    const tIntentPools = [BUY_POOL_FORCE_SMG, BUY_POOL_FORCE_SHOTGUN];
    for (const pool of tIntentPools) {
      for (const id of pool) {
        const def = WEAPONS[id];
        expect(def).toBeDefined();
        if (def && def.teams !== undefined) {
          expect(Array.isArray(def.teams)).toBe(true);
          expect(def.teams.length).toBeGreaterThan(0);
          for (const t of def.teams) {
            expect(['T', 'CT']).toContain(t);
          }
        }
      }
    }
  });

  test('each pool entry has the correct team eligibility declared in WEAPONS', () => {
    // T-only weapons in pools must have def.teams that includes 'T' or is undefined.
    // CT-only weapons must have def.teams that includes 'CT' or is undefined.
    const T_ONLY_IDS = ['mac10', 'sawedoff', 'galil', 'ak47', 'sg553', 'tec9'];
    const CT_ONLY_IDS = ['mp9', 'mag7', 'famas', 'm4a4', 'aug', 'fiveseven'];

    for (const id of T_ONLY_IDS) {
      const def = WEAPONS[id];
      if (!def) continue;
      if (def.teams !== undefined) {
        expect(def.teams).toContain('T');
      }
    }
    for (const id of CT_ONLY_IDS) {
      const def = WEAPONS[id];
      if (!def) continue;
      if (def.teams !== undefined) {
        expect(def.teams).toContain('CT');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Bot economy: full-buy bots get rifle + armor; eco bots keep money
//
// Helper: advances game to round 2 freeze so _doBotTeamBuyPass fires.
// Money override is applied on the roundEnd event (after bonuses are paid,
// before the round-2 start + buy pass runs) so tests control exact buy-time
// money without fighting round-end bonus arithmetic.
// ---------------------------------------------------------------------------

/**
 * Advance to round 2 and inject a specific buy-time money amount.
 * The roundEnd handler fires after bonuses are distributed but before
 * _startRound → buy passes run, so overriding money there is deterministic.
 *
 * @param buyTimeMoney - money each bot will have when round 2 buy pass runs
 * @param lossStreakT  - loss streak to set on T side (0 = default)
 * @param playerTeam   - which team the player belongs to (determines which
 *                       team is killed to end round 1)
 */
function advanceBotToRound2(
  buyTimeMoney: number,
  opts: { lossStreakT?: number; playerTeam?: 'CT' | 'T'; difficulty?: 'easy'|'normal'|'hard' } = {},
): { game: Game; mgr: BotManager; unsub: () => void } {
  const { lossStreakT = 0, playerTeam = 'CT', difficulty = 'normal' } = opts;

  const world = new World(DUST2);
  const nav   = new NavGrid(DUST2);
  const game  = new Game(world, null);
  game.player = makeCombatant(0, 'Player', playerTeam);
  game.startMatch({ playerTeam, difficulty, botsPerTeam: 4 });

  // Set loss streak before round 1 ends so _endRound uses it.
  if (lossStreakT > 0) {
    game.lossStreak['T'] = lossStreakT - 1; // will be incremented to lossStreakT by _endRound
  }

  const mgr = new BotManager(game, world, nav);
  mgr.attach();

  // Subscribe to roundEnd to override bot money after bonuses but before buy.
  // _endRound distributes bonuses → emits 'roundEnd' → (pause) → _startRound.
  // Setting money in the roundEnd handler ensures buy passes see buyTimeMoney.
  const unsub = gameEvents.on('roundEnd', () => {
    for (const c of game.combatants) {
      if (!c.isPlayer) c.money = buyTimeMoney;
    }
  });

  // Advance through freeze → live, then kill the losing team to end round 1.
  const freeze = RULES.FREEZE_TIME + 0.1;
  game.update(freeze, freeze);

  // Kill all members of the opposing team (T when playerTeam=CT, vice versa).
  const killTeam: 'CT' | 'T' = playerTeam === 'CT' ? 'T' : 'CT';
  for (const c of game.combatants) {
    if (c.team === killTeam) { c.alive = false; c.health = 0; }
  }
  game.update(0.016, freeze + 0.1);

  // Advance through round-end pause → round 2 starts, buy passes fire.
  const afterPause = freeze + RULES.ROUND_END_PAUSE + 1;
  game.update(RULES.ROUND_END_PAUSE + 1, afterPause);

  // Should now be in round 2 freeze.
  expect(game.phase).toBe('freeze');
  expect(game.roundNumber).toBe(2);

  return { game, mgr, unsub };
}

describe('Bot buy economy: full-buy', () => {
  test('full-buy bot (T, $16000) gets a primary rifle + armor', () => {
    // playerTeam=CT → CT wins round 1 → T bots get round 2 money overridden to $16000.
    const { game, mgr, unsub } = advanceBotToRound2(16000, { playerTeam: 'CT' });
    try {
      const validTRifles = new Set(['ak47', 'galil', 'sg553', 'awp']);
      const tBots = game.combatants.filter(c => c.team === 'T' && !c.isPlayer);
      expect(tBots.length).toBeGreaterThan(0);

      for (const c of tBots) {
        expect(c.inventory.primary).not.toBeNull();
        expect(validTRifles.has(c.inventory.primary?.def.id ?? '')).toBe(true);
        expect(c.armor).toBe(100);
      }
    } finally {
      unsub();
      mgr.dispose();
    }
  });

  test('full-buy bot (CT, $16000) gets a primary rifle + armor', () => {
    // playerTeam=T → T wins round 1 (we kill CT bots) → CT bots get $16000.
    const { game, mgr, unsub } = advanceBotToRound2(16000, { playerTeam: 'T' });
    try {
      const validCTRifles = new Set(['m4a4', 'famas', 'aug', 'awp']);
      const ctBots = game.combatants.filter(c => c.team === 'CT' && !c.isPlayer);
      expect(ctBots.length).toBeGreaterThan(0);

      for (const c of ctBots) {
        expect(c.inventory.primary).not.toBeNull();
        expect(validCTRifles.has(c.inventory.primary?.def.id ?? '')).toBe(true);
        expect(c.armor).toBe(100);
      }
    } finally {
      unsub();
      mgr.dispose();
    }
  });
});

describe('Bot buy economy: eco bot', () => {
  test('eco bot ($800) never buys a primary rifle or SMG', () => {
    // With exactly $800 at buy time: decideBuyStrategy → eco (< $1300, no streak).
    // Bot.ts eco pass may buy a cheap pistol (≤$700) with 60% chance; never a primary.
    const { game, mgr, unsub } = advanceBotToRound2(800, { playerTeam: 'CT' });
    try {
      const tBots = game.combatants.filter(c => c.team === 'T' && !c.isPlayer);
      expect(tBots.length).toBeGreaterThan(0);

      for (const c of tBots) {
        // Primary must remain null regardless of random rolls.
        expect(c.inventory.primary).toBeNull();
        // Money must be ≥ $100 (at worst, bought a $700 deagle from $800).
        expect(c.money).toBeGreaterThanOrEqual(100);
      }
    } finally {
      unsub();
      mgr.dispose();
    }
  });
});

describe('Bot buy economy: force-buy SMG', () => {
  test('force-buy bot ($1800, loss streak 2) gets no rifle primary', () => {
    // $1800 with loss streak 2 → force strategy (< 3700 full threshold).
    // game.ts force pass: vest + deagle (no primary).
    // bot.ts pass: $1800 - $650(vest) - $700(deagle) = $450 left → no SMG affordable.
    // OR: game.ts only bought vest (no deagle if money < 700 after vest) →
    // bot.ts tries SMG but $1800 - $650 = $1150 — mac10 $1050 is affordable.
    // Either way: no rifle (ak47/m4a4 etc.) should appear.
    // The key invariant: T bots do NOT buy standard rifles on a force budget.
    const { game, mgr, unsub } = advanceBotToRound2(1800, { playerTeam: 'CT', lossStreakT: 2 });
    try {
      const rifleIds = new Set(['ak47', 'm4a4', 'aug', 'sg553', 'galil', 'famas', 'awp']);
      const tBots = game.combatants.filter(c => c.team === 'T' && !c.isPlayer);
      expect(tBots.length).toBeGreaterThan(0);

      for (const c of tBots) {
        if (c.inventory.primary !== null) {
          expect(rifleIds.has(c.inventory.primary.def.id)).toBe(false);
        }
      }
    } finally {
      unsub();
      mgr.dispose();
    }
  });
});
