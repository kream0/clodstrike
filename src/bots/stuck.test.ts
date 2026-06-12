/**
 * stuck.test.ts — Bot stuck-detector harness (Task B)
 *
 * Verifies that alive bots navigating in 'objective' or 'hunt' state (i.e.
 * with active movement intent) do not remain motionless for more than 4 s.
 *
 * Definition of "stuck" used here:
 *   - Bot is alive
 *   - Game phase = 'live'
 *   - Bot brain state is 'objective', 'hunt', or 'engage' (states that
 *     require movement; 'guard', 'plant', 'defuse' are intentionally excluded
 *     because standing still is expected in those states)
 *   - Bot has non-zero movement intent (forward or strafe != 0)
 *   - Net XZ displacement over the last 4 s window < STUCK_DISPLACEMENT_M
 *
 * The test runs seeded headless matches (no Three.js scene) at 128 Hz for
 * several rounds on both DUST2 and MIRAGE.  Three seeds × 2 maps × 3 rounds
 * = 18 round-segments exercised.  Zero stuck events are allowed.
 */

import { describe, test, expect } from 'bun:test';
import { Game } from '../game';
import type { MatchOptions } from '../game';
import { BotManager } from './bot';
import { NavGrid } from './nav';
import { World } from '../world';
import { DUST2 } from '../maps/dust2';
import { MIRAGE } from '../maps/mirage';
import { RULES, WEAPONS, ECONOMY } from '../constants';
import type { Combatant, MapData, Inventory } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bot net displacement over this window (seconds) must exceed the threshold. */
const STUCK_WINDOW_S   = 4.0;
/** If net displacement over STUCK_WINDOW_S is below this, the bot is stuck. */
const STUCK_DISPLACEMENT_M = 0.5;
/** Simulation time-step — matches game.ts FIXED_DT = 1/128. */
const SIM_DT = 1 / 128;
/** Seconds of live-phase sim time per round. */
const ROUND_SIM_S = 90;
/** Fixed seeds for deterministic runs (avoids Math.random() variance). */
const SEEDS = [42, 137, 999] as const;
/** Maps under test. */
const MAPS: { label: string; data: MapData }[] = [
  { label: 'dust2',  data: DUST2 },
  { label: 'mirage', data: MIRAGE },
];
/**
 * FSM states where a bot should be navigating.  'engage' is intentionally
 * excluded: engage bots legally remain near-stationary while counterstrafe-
 * strafing (strafe ≠ 0, net XZ displacement ~ 0 due to oscillation).  Only
 * 'objective' and 'hunt' are checked — these states require a bot to be
 * travelling toward a destination.
 */
const MOVING_STATES = new Set(['objective', 'hunt']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInventory(team: 'CT' | 'T'): Inventory {
  const knife = { def: WEAPONS.knife, ammo: 0, reserve: 0, reloading: false, reloadEnd: 0, nextFire: 0, shotsFired: 0 };
  const secondary = team === 'CT'
    ? { def: WEAPONS.usp,   ammo: WEAPONS.usp.magSize,   reserve: WEAPONS.usp.reserveAmmo,   reloading: false, reloadEnd: 0, nextFire: 0, shotsFired: 0 }
    : { def: WEAPONS.glock, ammo: WEAPONS.glock.magSize, reserve: WEAPONS.glock.reserveAmmo, reloading: false, reloadEnd: 0, nextFire: 0, shotsFired: 0 };
  return { knife, secondary, primary: null, activeSlot: 'secondary' };
}

function makePlayer(id: number, team: 'CT' | 'T'): Combatant {
  return {
    id, name: 'Player', team, isPlayer: true,
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0,
    health: 100, armor: 0, helmet: false,
    alive: true, crouching: false, walking: false, onGround: true,
    inventory: makeInventory(team),
    money: ECONOMY.START_MONEY, kills: 0, deaths: 0,
    hasBomb: false, hasDefuseKit: false, tagSlowUntil: 0,
  };
}

interface PosSnapshot {
  x: number;
  z: number;
  time: number;
}

interface StuckEvent {
  botId:       number;
  map:         string;
  seed:        number;
  round:       number;
  state:       string;
  windowStart: number;
  windowEnd:   number;
  netDisplacement: number;
}

// ---------------------------------------------------------------------------
// Core harness
// ---------------------------------------------------------------------------

/**
 * Runs a seeded headless match on the given map for numRounds rounds.
 * Returns an array of StuckEvents (should be empty for a healthy sim).
 */
function runStuckHarness(
  mapData:   MapData,
  mapLabel:  string,
  seed:      number,
  numRounds: number,
): StuckEvent[] {
  const world = new World(mapData);
  const game  = new Game(world, null);
  game.setMap(mapData);    // set the map BEFORE startMatch so spawns and bombsites are correct
  game.player = makePlayer(0, 'CT');

  const opts: MatchOptions = {
    playerTeam: 'CT',
    difficulty: 'normal',
    botsPerTeam: 4,
    seed,
  };
  game.startMatch(opts);

  // Move the player far off the map so bots never perceive or hunt the static
  // dummy player.  The match is effectively all-bot from both sides.
  game.player.pos = { x: -999, y: 0, z: -999 };

  const nav = new NavGrid(mapData);
  const mgr = new BotManager(game, world, nav, undefined, mapData);
  mgr.attach();

  const stuck: StuckEvent[] = [];

  // 'now' tracks game-time continuously across rounds — critical because
  // game._freezeStartAt is set relative to the running now, not reset to 0.
  let now = 0;

  // Per-bot position history ring buffer (persists across rounds for bots that
  // survive; cleared/reset at round start below).
  const SNAPSHOT_INTERVAL = 0.25; // seconds between snapshots
  const SNAPSHOT_COUNT    = Math.ceil(STUCK_WINDOW_S / SNAPSHOT_INTERVAL) + 2;
  const posHistory     = new Map<number, PosSnapshot[]>();
  const nextSnapshotAt = new Map<number, number>();

  for (let roundNum = 1; roundNum <= numRounds; roundNum++) {
    // Advance through freeze phase tick-by-tick.
    const freezeEnd = now + RULES.FREEZE_TIME + SIM_DT;
    while (now < freezeEnd && game.phase === 'freeze') {
      now += SIM_DT;
      game.update(SIM_DT, now);
    }

    if (game.phase !== 'live') {
      // Round didn't start (match over or never left freeze?), stop.
      break;
    }

    // Re-initialise position history for all bots alive at round start.
    posHistory.clear();
    nextSnapshotAt.clear();
    for (const b of game.combatants) {
      if (b.isPlayer) continue;
      posHistory.set(b.id, [{ x: b.pos.x, z: b.pos.z, time: now }]);
      nextSnapshotAt.set(b.id, now + SNAPSHOT_INTERVAL);
    }

    // Run live phase for ROUND_SIM_S seconds.
    // game.update internally calls _runBotBrains — do NOT tick brains separately.
    const endNow = now + ROUND_SIM_S;
    while (now < endNow && game.phase === 'live') {
      now += SIM_DT;
      game.update(SIM_DT, now);

      // Snapshot positions and check for stuck bots (every SNAPSHOT_INTERVAL).
      for (const c of game.combatants) {
        if (c.isPlayer || !c.alive) continue;
        if (game.phase !== 'live') break;

        const botState = mgr.getBrainState(c.id);
        if (!botState || !MOVING_STATES.has(botState)) continue;

        // Record snapshot.
        const nextSnap = nextSnapshotAt.get(c.id) ?? now;
        if (now >= nextSnap) {
          nextSnapshotAt.set(c.id, now + SNAPSHOT_INTERVAL);
          let hist = posHistory.get(c.id);
          if (!hist) { hist = []; posHistory.set(c.id, hist); }
          hist.push({ x: c.pos.x, z: c.pos.z, time: now });
          // Evict old snapshots beyond the window.
          while (hist.length > SNAPSHOT_COUNT) hist.shift();
        }

        // Check for stuck condition: compare current pos vs oldest snapshot
        // within the 4 s window.
        const hist = posHistory.get(c.id);
        if (!hist || hist.length < 2) continue;

        const oldest = hist[0]!;
        const windowLen = now - oldest.time;
        if (windowLen < STUCK_WINDOW_S) continue; // window not full yet

        const dx = c.pos.x - oldest.x;
        const dz = c.pos.z - oldest.z;
        const displacement = Math.sqrt(dx * dx + dz * dz);

        if (displacement < STUCK_DISPLACEMENT_M) {
          stuck.push({
            botId:           c.id,
            map:             mapLabel,
            seed,
            round:           roundNum,
            state:           botState,
            windowStart:     oldest.time,
            windowEnd:       now,
            netDisplacement: displacement,
          });
          // Evict the oldest snapshot so we don't spam one event per tick.
          // The next stuck event will only fire after another full window.
          hist.length = 0;
        }
      }
    }

    // Trigger round end to advance to next round.
    // Kill all remaining non-player combatants so the game exits 'live' phase.
    if (game.phase === 'live' || game.phase === 'planted') {
      for (const c of game.combatants) {
        if (!c.isPlayer) { c.alive = false; c.health = 0; }
      }
      // Drive a few ticks so game.update detects the round-over condition.
      for (let i = 0; i < 10; i++) {
        now += SIM_DT;
        game.update(SIM_DT, now);
      }
    }

    // Step through roundEnd pause + freeze phase tick-by-tick until the next
    // round goes live.  A single large-dt call only processes one phase
    // transition per invocation, so we must loop.
    const interRoundEnd = now + RULES.ROUND_END_PAUSE + RULES.FREEZE_TIME + 2 * SIM_DT;
    while (now < interRoundEnd && game.phase !== 'live' && game.phase !== 'matchEnd') {
      now += SIM_DT;
      game.update(SIM_DT, now);
    }
    if ((game.phase as string) === 'matchEnd') break;

    // After inter-round, re-teleport the dummy player off-map in case
    // _startRound respawned them.
    game.player.pos = { x: -999, y: 0, z: -999 };
  }

  mgr.dispose();
  return stuck;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bot stuck detector', () => {
  for (const { label, data } of MAPS) {
    describe(`map: ${label}`, () => {
      for (const seed of SEEDS) {
        test(`seed ${seed}: zero stuck bots over 3 rounds`, () => {
          const events = runStuckHarness(data, label, seed, 3);

          if (events.length > 0) {
            const summary = events
              .map(e =>
                `  bot${e.botId} round${e.round} state=${e.state} ` +
                `displacement=${e.netDisplacement.toFixed(2)}m ` +
                `window=[${e.windowStart.toFixed(1)},${e.windowEnd.toFixed(1)}]`,
              )
              .join('\n');
            expect(events.length, `Stuck events on ${label} seed=${seed}:\n${summary}`).toBe(0);
          } else {
            expect(events.length).toBe(0);
          }
        });
      }
    });
  }
});
