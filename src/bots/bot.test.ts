import { describe, test, expect, beforeEach } from 'bun:test';
import { Game } from '../game';
import type { MatchOptions } from '../game';
import { World } from '../world';
import { NavGrid } from './nav';
import { BotManager } from './bot';
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
   * Place bot and target in open mid for reliable LOS.
   * Verified positions (no walls, clear LOS, both on valid floor cells):
   *   bot  : x=0, z=-28, floor=0      (CTMid area)
   *   target: x=0, z=-33, floor=0.375  (MidDoors area, 5 m in front)
   */
  function setupAwpScenario(game: Game, mgr: BotManager) {
    const bot = game.combatants.find(c => c.team === 'CT' && !c.isPlayer && c.alive)!;
    // Equip AWP.
    bot.inventory.primary = makeWeaponState(WEAPONS.awp);
    bot.inventory.activeSlot = 'primary';
    bot.pos = { x: 0, y: 0, z: -28 };       // floor=0
    bot.yaw = 0;                               // facing -Z
    bot.onGround = true;

    // Pick a non-player T bot as the target so killing the player doesn't kill it.
    const target = game.combatants.find(c => c.team === 'T' && !c.isPlayer && c.alive)!;
    target.pos = { x: 0, y: 0.375, z: -33 }; // floor=0.375, 5 m in front
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
   * Reusable scenario: CT bot facing a T enemy 5 m ahead in open mid with
   * clear world LOS. We use the same verified positions as the AWP tests.
   *   bot  : x=0, z=-28, floor=0       (CTMid)
   *   enemy: x=0, z=-33, floor=0.375   (MidDoors, 5 m in front)
   * Enemy health is set to 9999 so it survives being shot during the test.
   */
  function setupOpenMidScenario(game: Game) {
    const bot = game.combatants.find(c => c.team === 'CT' && !c.isPlayer && c.alive)!;
    bot.inventory.primary    = makeWeaponState(WEAPONS.m4a4);
    bot.inventory.activeSlot = 'primary';
    bot.pos    = { x: 0, y: 0, z: -28 };
    bot.yaw    = 0; // facing -Z
    bot.onGround = true;

    const enemy = game.combatants.find(c => c.team === 'T' && !c.isPlayer && c.alive)!;
    enemy.pos    = { x: 0, y: 0.375, z: -33 };
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
   * Place a CT bot in open mid, facing a T enemy 5 m ahead (same verified
   * positions as smoke tests). Enemy health = 9999 so it survives being shot.
   * The player (T) is kept alive so the game phase doesn't flip to roundEnd.
   */
  function setupFlashScenario(game: Game) {
    const bot = game.combatants.find(c => c.team === 'CT' && !c.isPlayer && c.alive)!;
    bot.inventory.primary    = makeWeaponState(WEAPONS.m4a4);
    bot.inventory.activeSlot = 'primary';
    bot.pos    = { x: 0, y: 0, z: -28 };
    bot.yaw    = 0;
    bot.onGround = true;

    const enemy = game.combatants.find(c => c.team === 'T' && !c.isPlayer && c.alive)!;
    enemy.pos    = { x: 0, y: 0.375, z: -33 };
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
    const { game, mgr } = freshSetup({ playerTeam: 'T', difficulty: 'hard' });
    let now = advanceFreeze(game);
    const { bot, enemy } = setupFlashScenario(game);

    // Apply full blindness lasting 0.15 s (expires quickly).
    bot.blindUntil     = now + 0.15;
    bot.blindIntensity = 0.9;
    // Set normal enemy health so we can confirm a hit.
    enemy.health = 100;

    const initHealth = enemy.health;
    const DT = 1 / 128;
    // Tick for 3 s: blind ends at +0.15 s, reaction fires at ~+0.37 s.
    const TICKS = Math.ceil(3.0 / DT);
    for (let i = 0; i < TICKS; i++) {
      now += DT;
      const brain = game.botBrains.get(bot.id);
      if (brain) brain(bot, DT, now);
      if (enemy.health < initHealth) break;
    }

    // Health should have dropped after blindness expired and reaction window passed.
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
