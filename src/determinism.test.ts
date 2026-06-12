/**
 * determinism.test.ts
 *
 * Two sequential simulations with the SAME masterSeed should produce
 * bit-exact combatant state at every checkpoint.
 *
 * IMPORTANT architectural note:
 *   gameEvents (src/combat.ts) is a module-level singleton shared by all
 *   Game instances in the same process.  Running two simulations concurrently
 *   would cross-contaminate events (shots/kills from sim-A would fire
 *   sim-B's BotManager listeners, causing immediate divergence).
 *
 *   Solution: run each simulation fully SEQUENTIALLY, disposing the BotManager
 *   (which unsubscribes from gameEvents) before starting the next one.
 *   Record checkpoints for each run, then compare.
 *
 * The aimStates Map in weapons.ts is also module-level; since we reset aim via
 * resetAim() at each round start (called from game._startRound) and both runs
 * use the same combatant IDs (per-match deterministic), the Map will hold the
 * same values after the same number of ticks in each run.
 */

import { describe, test, expect } from 'bun:test';
import { Game } from './game';
import type { MatchOptions } from './game';
import { World } from './world';
import { NavGrid } from './bots/nav';
import { BotManager } from './bots/bot';
import { DUST2 } from './maps/dust2';
import { RULES } from './constants';
import type { Combatant } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_DT = 1 / 128;

interface CombatantSnapshot {
  id:           number;
  alive:        boolean;
  health:       number;
  armor:        number;
  posX:         number;
  posY:         number;
  posZ:         number;
  velX:         number;
  velY:         number;
  velZ:         number;
  yaw:          number;
  pitch:        number;
  crouching:    boolean;
  onGround:     boolean;
  hasBomb:      boolean;
  money:        number;
  kills:        number;
  deaths:       number;
  ammo:         number;
  reserve:      number;
  shotsFired:   number;
  reloading:    boolean;
}

function snapshot(c: Combatant): CombatantSnapshot {
  const slot = c.inventory.activeSlot;
  const ws   = c.inventory[slot];
  return {
    id:         c.id,
    alive:      c.alive,
    health:     c.health,
    armor:      c.armor,
    posX:       c.pos.x,
    posY:       c.pos.y,
    posZ:       c.pos.z,
    velX:       c.vel.x,
    velY:       c.vel.y,
    velZ:       c.vel.z,
    yaw:        c.yaw,
    pitch:      c.pitch,
    crouching:  c.crouching,
    onGround:   c.onGround,
    hasBomb:    c.hasBomb,
    money:      c.money,
    kills:      c.kills,
    deaths:     c.deaths,
    ammo:       ws?.ammo ?? 0,
    reserve:    ws?.reserve ?? 0,
    shotsFired: ws?.shotsFired ?? 0,
    reloading:  ws?.reloading ?? false,
  };
}

interface GameSnapshot {
  phase:       string;
  roundNumber: number;
  scoreCT:     number;
  scoreT:      number;
  bombState:   string;
  bombPosX:    number;
  bombPosZ:    number;
  combatants:  CombatantSnapshot[];
}

function takeSnapshot(game: Game): GameSnapshot {
  return {
    phase:       game.phase,
    roundNumber: game.roundNumber,
    scoreCT:     game.score.CT,
    scoreT:      game.score.T,
    bombState:   game.bomb.state,
    bombPosX:    game.bomb.pos.x,
    bombPosZ:    game.bomb.pos.z,
    combatants:  game.combatants.map(snapshot),
  };
}

/**
 * Run a single simulation for `totalTicks` ticks after FREEZE, capturing
 * a snapshot every `checkpointEvery` ticks. Disposes the BotManager after
 * the run so its gameEvents subscriptions are torn down before the next run.
 */
function runSim(opts: MatchOptions, totalTicks: number, checkpointEvery: number): GameSnapshot[] {
  const world = new World(DUST2);
  const nav   = new NavGrid(DUST2);
  const game  = new Game(world, null);

  game.startMatch(opts, 0);

  const mgr = new BotManager(game, world, nav, undefined, DUST2);
  mgr.attach();

  // Advance through the freeze phase.
  const freezeTicks = Math.ceil((RULES.FREEZE_TIME + 0.01) / FIXED_DT);
  let now = 0;
  for (let t = 0; t < freezeTicks; t++) {
    now += FIXED_DT;
    game.update(FIXED_DT, now);
  }

  // Sanity: must be live after freeze.
  if (game.phase !== 'live') {
    throw new Error(`Expected 'live' after freeze, got '${game.phase}'`);
  }

  // Run and snapshot.
  const checkpoints: GameSnapshot[] = [];
  for (let t = 0; t < totalTicks; t++) {
    now += FIXED_DT;
    game.update(FIXED_DT, now);
    if ((t + 1) % checkpointEvery === 0) {
      checkpoints.push(takeSnapshot(game));
    }
  }

  // Tear down subscriptions.
  mgr.dispose();
  game.dispose();

  return checkpoints;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('determinism', () => {

  test('same seed → identical state at every 500-tick checkpoint over 5000 ticks', () => {
    const SEED = 0xdeadcafe;
    const TOTAL_TICKS = 5000;
    const CHECKPOINT_EVERY = 500;

    const opts: MatchOptions = {
      playerTeam:  'CT',
      difficulty:  'normal',
      botsPerTeam: 4,
      seed:        SEED,
    };

    // Run simulation A, then B sequentially.
    const checkpointsA = runSim(opts, TOTAL_TICKS, CHECKPOINT_EVERY);
    const checkpointsB = runSim(opts, TOTAL_TICKS, CHECKPOINT_EVERY);

    expect(checkpointsA.length).toBe(checkpointsB.length);
    expect(checkpointsA.length).toBeGreaterThan(0);

    for (let i = 0; i < checkpointsA.length; i++) {
      expect(checkpointsA[i]).toEqual(checkpointsB[i]);
    }
  });

  test('different seeds → state diverges within 5000 ticks', () => {
    const TOTAL_TICKS = 5000;
    const CHECKPOINT_EVERY = 500;

    const optsA: MatchOptions = { playerTeam: 'CT', difficulty: 'normal', botsPerTeam: 4, seed: 0x11111111 };
    const optsB: MatchOptions = { playerTeam: 'CT', difficulty: 'normal', botsPerTeam: 4, seed: 0x22222222 };

    const checkpointsA = runSim(optsA, TOTAL_TICKS, CHECKPOINT_EVERY);
    const checkpointsB = runSim(optsB, TOTAL_TICKS, CHECKPOINT_EVERY);

    expect(checkpointsA.length).toBe(checkpointsB.length);
    expect(checkpointsA.length).toBeGreaterThan(0);

    let diverged = false;
    for (let i = 0; i < checkpointsA.length && !diverged; i++) {
      const cpA = checkpointsA[i]!;
      const cpB = checkpointsB[i]!;
      if (
        cpA.bombState !== cpB.bombState ||
        Math.abs(cpA.bombPosX - cpB.bombPosX) > 0.001 ||
        Math.abs(cpA.bombPosZ - cpB.bombPosZ) > 0.001
      ) {
        diverged = true;
        break;
      }
      for (let j = 0; j < cpA.combatants.length && !diverged; j++) {
        const cA = cpA.combatants[j]!;
        const cB = cpB.combatants[j]!;
        if (
          Math.abs(cA.posX - cB.posX) > 0.001 ||
          Math.abs(cA.posZ - cB.posZ) > 0.001 ||
          cA.money !== cB.money ||
          cA.hasBomb !== cB.hasBomb ||
          cA.health !== cB.health
        ) {
          diverged = true;
        }
      }
    }

    expect(diverged).toBe(true);
  });

  test('same seed with hard difficulty → deterministic over 3000 ticks', () => {
    const SEED = 0xbadf00d1;
    const opts: MatchOptions = {
      playerTeam:  'CT',
      difficulty:  'hard',
      botsPerTeam: 4,
      seed:        SEED,
    };

    const checkpointsA = runSim(opts, 3000, 500);
    const checkpointsB = runSim(opts, 3000, 500);

    for (let i = 0; i < checkpointsA.length; i++) {
      expect(checkpointsA[i]).toEqual(checkpointsB[i]);
    }
  });

});
