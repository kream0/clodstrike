/**
 * replay.test.ts
 *
 * Tests for ReplayRecorder, ReplayCursor, and the critical record→replay
 * equivalence suite (demonstrates that the log captures sufficient inputs
 * for deterministic re-simulation).
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  ReplayRecorder,
  ReplayCursor,
} from './replay';
import type { ReplayTickInput, ReplayLog } from './replay';
import { Game } from './game';
import type { MatchOptions } from './game';
import { World } from './world';
import { NavGrid } from './bots/nav';
import { BotManager } from './bots/bot';
import { DUST2 } from './maps/dust2';
import { RULES } from './constants';
import type { Combatant } from './types';
import { simulateMovement } from './movement';
import { updateWeapon } from './weapons';
import { gameEvents } from './combat';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_DT = 1 / 128;

/** Build a default all-idle tick input. */
function idleTick(overrides: Partial<ReplayTickInput> = {}): ReplayTickInput {
  return {
    forward:             0,
    strafe:              0,
    jump:                false,
    crouch:              false,
    walk:                false,
    eHeld:               false,
    mouseDown:           false,
    mousePressed:        false,
    mouse2Pressed:       false,
    reloadEdge:          false,
    digit4Pressed:       false,
    wheelDelta:          0,
    slotSwitchThisFrame: false,
    ...overrides,
  };
}

/** Snapshot the fields we compare for record→replay equivalence. */
interface CombatantSnapshot {
  id:         number;
  alive:      boolean;
  health:     number;
  armor:      number;
  posX:       number;
  posY:       number;
  posZ:       number;
  velX:       number;
  velY:       number;
  velZ:       number;
  yaw:        number;
  pitch:      number;
  crouching:  boolean;
  onGround:   boolean;
  hasBomb:    boolean;
  money:      number;
  kills:      number;
  deaths:     number;
  ammo:       number;
  reserve:    number;
  shotsFired: number;
  reloading:  boolean;
}

interface GameSnapshot {
  phase:       string;
  roundNumber: number;
  scoreCT:     number;
  scoreT:      number;
  bombState:   string;
  combatants:  CombatantSnapshot[];
}

function snapshotCombatant(c: Combatant): CombatantSnapshot {
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

function takeSnapshot(game: Game): GameSnapshot {
  return {
    phase:       game.phase,
    roundNumber: game.roundNumber,
    scoreCT:     game.score.CT,
    scoreT:      game.score.T,
    bombState:   game.bomb.state,
    combatants:  game.combatants.map(snapshotCombatant),
  };
}

/**
 * Minimal tick-body sim used by both the original recording run and the replay run.
 * Mirrors the structure of main.ts's fixed-step tick, but stripped of render/audio/effects.
 */
function simTick(
  game: Game,
  world: World,
  inp: ReplayTickInput,
  now: number,
  edgesConsumed: boolean,
): void {
  const player = game.player;

  // Movement.
  if (player.alive && game.phase !== 'freeze') {
    simulateMovement(player, {
      forward: inp.forward,
      strafe:  inp.strafe,
      jump:    inp.jump,
      crouch:  inp.crouch,
      walk:    inp.walk,
    }, world, FIXED_DT, now);
  }

  // E key.
  if (player.alive && game.phase !== 'freeze') {
    game.useHeld(player, inp.eHeld, now, FIXED_DT);
  }

  // Weapon: use the pre-recorded reloadEdge directly (already gated at record time).
  const reloadEdge = inp.reloadEdge;
  const trigger    = player.inventory[player.inventory.activeSlot]?.def.auto
    ? inp.mouseDown
    : (!edgesConsumed && inp.mousePressed);

  if (player.alive && game.phase !== 'freeze') {
    updateWeapon(player, world, game.combatants, {
      trigger,
      reloadPressed: reloadEdge,
      scopePressed:  !edgesConsumed && inp.mouse2Pressed,
    }, now, FIXED_DT, game.rng.combat);
  }

  // Game state machine.
  game.update(FIXED_DT, now);
}

/**
 * Run a scripted simulation with recording.
 * inputProvider receives (tick, now) and returns the tick input for that tick.
 * Returns original checkpoints + completed log.
 */
function runScriptedSim(
  opts: MatchOptions,
  totalTicks: number,
  checkpointEvery: number,
  inputProvider: (tick: number, now: number) => ReplayTickInput,
): { checkpoints: GameSnapshot[]; log: ReplayLog } {
  const recorder = new ReplayRecorder();
  const world    = new World(DUST2);
  const nav      = new NavGrid(DUST2);
  const game     = new Game(world, null);
  const seed     = opts.seed ?? 0xdeadbeef;

  game.startMatch({ ...opts, seed }, 0);

  const mgr = new BotManager(game, world, nav, undefined, DUST2);
  mgr.attach();

  recorder.beginMatch(seed, {
    playerTeam:  opts.playerTeam,
    difficulty:  opts.difficulty,
    botsPerTeam: opts.botsPerTeam,
    mapId:       opts.mapId,
  });

  const player = game.player;

  // Wire roundStart / roundEnd.
  const unsubRS = gameEvents.on('roundStart', () => {
    recorder.markRoundStart(recorder.globalTick);
  });
  const unsubRE = gameEvents.on('roundEnd', () => {
    recorder.notifyRoundEnd();
  });

  // Advance through freeze phase.
  const freezeTicks = Math.ceil((RULES.FREEZE_TIME + 0.01) / FIXED_DT);
  let now = 0;
  for (let t = 0; t < freezeTicks; t++) {
    now += FIXED_DT;
    game.update(FIXED_DT, now);
  }

  const checkpoints: GameSnapshot[] = [];
  const TICKS_PER_FRAME = 2;
  let tickInFrame  = 0;

  for (let t = 0; t < totalTicks; t++) {
    now += FIXED_DT;

    const isFirstTick = (tickInFrame === 0);
    if (isFirstTick) {
      recorder.beginFrame(player.yaw, player.pitch);
    }

    const raw = inputProvider(t, now);

    // Gate edge flags: only valid on first tick of the frame.
    // reloadEdge is pre-computed by the caller and stored directly in the input.
    const effectiveInp: ReplayTickInput = {
      ...raw,
      mousePressed:  isFirstTick ? raw.mousePressed  : false,
      mouse2Pressed: isFirstTick ? raw.mouse2Pressed : false,
      digit4Pressed: isFirstTick ? raw.digit4Pressed : false,
    };

    recorder.recordTick(effectiveInp);

    simTick(game, world, effectiveInp, now, !isFirstTick);

    tickInFrame++;
    if (tickInFrame >= TICKS_PER_FRAME) {
      recorder.flushFrame();
      tickInFrame = 0;
    }

    if ((t + 1) % checkpointEvery === 0) {
      checkpoints.push(takeSnapshot(game));
    }
  }

  if (tickInFrame > 0) recorder.flushFrame();

  unsubRS();
  unsubRE();
  mgr.dispose();
  game.dispose();

  return { checkpoints, log: recorder.endMatch()! };
}

/**
 * Replay a log headlessly.
 * Returns snapshots every `checkpointEvery` ticks after startTick.
 */
function runReplaySim(
  log: ReplayLog,
  startTick: number,
  totalPlaybackTicks: number,
  checkpointEvery: number,
): GameSnapshot[] {
  const cursor = new ReplayCursor(log);
  const world  = new World(DUST2);
  const nav    = new NavGrid(DUST2);
  const game   = new Game(world, null);

  game.startMatch({
    playerTeam:  log.opts.playerTeam,
    difficulty:  log.opts.difficulty,
    botsPerTeam: log.opts.botsPerTeam,
    mapId:       log.opts.mapId,
    seed:        log.seed,
  }, 0);

  const mgr = new BotManager(game, world, nav, undefined, DUST2);
  mgr.attach();

  const player = game.player;
  cursor.seekTick(startTick);

  // Advance through freeze phase.
  const freezeTicks = Math.ceil((RULES.FREEZE_TIME + 0.01) / FIXED_DT);
  let now = 0;
  for (let t = 0; t < freezeTicks; t++) {
    now += FIXED_DT;
    game.update(FIXED_DT, now);
  }

  const checkpoints: GameSnapshot[] = [];
  let playedTicks = 0;

  while (playedTicks < totalPlaybackTicks && !cursor.done) {
    const frame = cursor.nextFrame();
    if (frame === null) break;

    // Apply frame-level yaw/pitch.
    player.yaw   = frame.yaw;
    player.pitch = frame.pitch;

    for (let ti = 0; ti < frame.ticks.length && playedTicks < totalPlaybackTicks; ti++) {
      const inp = frame.ticks[ti]!;
      now += FIXED_DT;

      // First tick in the frame: edges may fire. Later ticks: edges already consumed.
      const edgesConsumed = (ti > 0);

      simTick(game, world, inp, now, edgesConsumed);

      playedTicks++;
      if (playedTicks % checkpointEvery === 0) {
        checkpoints.push(takeSnapshot(game));
      }
    }
  }

  mgr.dispose();
  game.dispose();
  return checkpoints;
}

// ---------------------------------------------------------------------------
// Tests: ReplayRecorder
// ---------------------------------------------------------------------------

describe('ReplayRecorder', () => {
  let recorder: ReplayRecorder;

  beforeEach(() => {
    recorder = new ReplayRecorder();
  });

  test('begins with null log and zero completed rounds', () => {
    expect(recorder.log).toBeNull();
    expect(recorder.lastCompletedRound).toBe(0);
    expect(recorder.globalTick).toBe(0);
  });

  test('beginMatch creates a fresh log with correct shape', () => {
    recorder.beginMatch(0xdeadbeef, { playerTeam: 'CT', difficulty: 'normal' });
    const log = recorder.log;
    expect(log).not.toBeNull();
    expect(log!.version).toBe(1);
    expect(log!.seed).toBe(0xdeadbeef);
    expect(log!.opts.playerTeam).toBe('CT');
    expect(log!.opts.difficulty).toBe('normal');
    expect(log!.frames).toHaveLength(0);
    expect(log!.roundStartTicks).toHaveLength(0);
  });

  test('records ticks into frames correctly', () => {
    recorder.beginMatch(1, { playerTeam: 'T', difficulty: 'easy' });
    recorder.beginFrame(1.5, 0.2);
    recorder.recordTick(idleTick({ forward: 1 }));
    recorder.recordTick(idleTick({ strafe: -1 }));
    recorder.flushFrame();

    const log = recorder.log!;
    expect(log.frames).toHaveLength(1);
    expect(log.frames[0]!.yaw).toBe(1.5);
    expect(log.frames[0]!.pitch).toBe(0.2);
    expect(log.frames[0]!.ticks).toHaveLength(2);
    expect(log.frames[0]!.ticks[0]!.forward).toBe(1);
    expect(log.frames[0]!.ticks[1]!.strafe).toBe(-1);
    expect(recorder.globalTick).toBe(2);
  });

  test('markRoundStart appends to roundStartTicks', () => {
    recorder.beginMatch(1, { playerTeam: 'CT', difficulty: 'normal' });
    recorder.markRoundStart(0);
    recorder.markRoundStart(1);
    expect(recorder.log!.roundStartTicks).toEqual([0, 1]);
  });

  test('roundStartTicks are monotonically non-decreasing when marked in order', () => {
    recorder.beginMatch(1, { playerTeam: 'CT', difficulty: 'normal' });
    const starts = [0, 500, 1000, 2000];
    for (const tick of starts) {
      recorder.markRoundStart(tick);
    }
    const ticks = recorder.log!.roundStartTicks;
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!).toBeGreaterThanOrEqual(ticks[i - 1]!);
    }
  });

  test('notifyRoundEnd increments completedRounds', () => {
    recorder.beginMatch(1, { playerTeam: 'CT', difficulty: 'normal' });
    expect(recorder.lastCompletedRound).toBe(0);
    recorder.notifyRoundEnd();
    expect(recorder.lastCompletedRound).toBe(1);
    recorder.notifyRoundEnd();
    expect(recorder.lastCompletedRound).toBe(2);
  });

  test('endMatch returns the log and flushes open frame', () => {
    recorder.beginMatch(42, { playerTeam: 'CT', difficulty: 'hard' });
    recorder.beginFrame(0, 0);
    recorder.recordTick(idleTick());
    // Do NOT call flushFrame — endMatch should flush it.
    const log = recorder.endMatch();
    expect(log).not.toBeNull();
    expect(log!.frames).toHaveLength(1);
  });

  test('beginMatch resets everything from the previous match', () => {
    recorder.beginMatch(1, { playerTeam: 'CT', difficulty: 'normal' });
    recorder.beginFrame(0.5, 0.1);
    recorder.recordTick(idleTick());
    recorder.recordTick(idleTick());
    recorder.flushFrame();
    recorder.notifyRoundEnd();

    expect(recorder.lastCompletedRound).toBe(1);
    expect(recorder.globalTick).toBe(2);

    // Start a new match.
    recorder.beginMatch(99, { playerTeam: 'T', difficulty: 'easy' });
    expect(recorder.lastCompletedRound).toBe(0);
    expect(recorder.globalTick).toBe(0);
    expect(recorder.log!.frames).toHaveLength(0);
  });

  test('frames with no ticks are not pushed', () => {
    recorder.beginMatch(1, { playerTeam: 'CT', difficulty: 'normal' });
    recorder.beginFrame(0, 0);
    // No recordTick calls.
    recorder.flushFrame();
    expect(recorder.log!.frames).toHaveLength(0);
  });

  test('ticks are copies (mutation of original does not corrupt log)', () => {
    recorder.beginMatch(1, { playerTeam: 'CT', difficulty: 'normal' });
    recorder.beginFrame(0, 0);
    const tick = idleTick({ forward: 1 });
    recorder.recordTick(tick);
    tick.forward = -1;  // mutate after record
    recorder.flushFrame();
    expect(recorder.log!.frames[0]!.ticks[0]!.forward).toBe(1);
  });

  test('globalTick is accurate across multiple frames', () => {
    recorder.beginMatch(1, { playerTeam: 'CT', difficulty: 'normal' });
    recorder.beginFrame(0, 0);
    recorder.recordTick(idleTick());
    recorder.recordTick(idleTick());
    recorder.flushFrame();
    recorder.beginFrame(0, 0);
    recorder.recordTick(idleTick());
    recorder.flushFrame();
    expect(recorder.globalTick).toBe(3);
  });

  test('endMatch without any frames returns log with empty frames array', () => {
    recorder.beginMatch(7, { playerTeam: 'T', difficulty: 'hard' });
    const log = recorder.endMatch();
    expect(log).not.toBeNull();
    expect(log!.frames).toHaveLength(0);
    expect(log!.roundStartTicks).toHaveLength(0);
  });

  test('recording without beginMatch silently no-ops', () => {
    // No beginMatch.
    recorder.beginFrame(0, 0);
    recorder.recordTick(idleTick());
    recorder.flushFrame();
    expect(recorder.log).toBeNull();
    expect(recorder.globalTick).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: ReplayCursor
// ---------------------------------------------------------------------------

describe('ReplayCursor', () => {
  function buildLog(frameCount: number, ticksPerFrame: number): ReplayLog {
    const r = new ReplayRecorder();
    r.beginMatch(0xfeed, { playerTeam: 'CT', difficulty: 'normal' });
    for (let f = 0; f < frameCount; f++) {
      r.beginFrame(f * 0.01, 0);
      for (let t = 0; t < ticksPerFrame; t++) {
        r.recordTick(idleTick({ forward: f * 10 + t }));
      }
      r.flushFrame();
    }
    return r.endMatch()!;
  }

  test('rejects log with wrong version', () => {
    const log = buildLog(1, 1);
    const badLog = { ...log, version: 2 as unknown as 1 };
    expect(() => new ReplayCursor(badLog)).toThrow();
  });

  test('iterates all frames in order', () => {
    const log = buildLog(5, 3);
    const cursor = new ReplayCursor(log);
    let count = 0;
    while (!cursor.done) {
      const frame = cursor.nextFrame();
      expect(frame).not.toBeNull();
      count++;
    }
    expect(count).toBe(5);
    expect(cursor.nextFrame()).toBeNull();
  });

  test('done is true after all frames consumed', () => {
    const log = buildLog(3, 2);
    const cursor = new ReplayCursor(log);
    for (let i = 0; i < 3; i++) cursor.nextFrame();
    expect(cursor.done).toBe(true);
  });

  test('seekTick(0) resets to beginning', () => {
    const log = buildLog(4, 2);
    const cursor = new ReplayCursor(log);
    cursor.nextFrame();
    cursor.nextFrame();
    cursor.seekTick(0);
    expect(cursor.frameIndex).toBe(0);
  });

  test('seekTick lands on the correct frame', () => {
    // 4 frames × 3 ticks each = 12 ticks total.
    // tick 0-2: frame 0, tick 3-5: frame 1, tick 6-8: frame 2, tick 9-11: frame 3.
    const log = buildLog(4, 3);
    const cursor = new ReplayCursor(log);
    cursor.seekTick(6);
    expect(cursor.frameIndex).toBe(2);
    const frame = cursor.nextFrame()!;
    // yaw was set to f * 0.01 → frame index 2 → yaw ≈ 0.02.
    expect(Math.round(frame.yaw * 100)).toBe(2);
  });

  test('seekTick beyond end sets cursor to done', () => {
    const log = buildLog(3, 2);
    const cursor = new ReplayCursor(log);
    cursor.seekTick(999);
    expect(cursor.done).toBe(true);
  });

  test('replaying an empty log does not throw', () => {
    const r = new ReplayRecorder();
    r.beginMatch(1, { playerTeam: 'CT', difficulty: 'normal' });
    const log = r.endMatch()!;
    const cursor = new ReplayCursor(log);
    expect(cursor.done).toBe(true);
    expect(cursor.nextFrame()).toBeNull();
  });

  test('frame tick data is preserved exactly through cursor', () => {
    const log = buildLog(2, 4);
    const cursor = new ReplayCursor(log);
    const frame0 = cursor.nextFrame()!;
    expect(frame0.ticks).toHaveLength(4);
    // Frame 0: forward = 0,1,2,3.
    expect(frame0.ticks[0]!.forward).toBe(0);
    expect(frame0.ticks[1]!.forward).toBe(1);
    expect(frame0.ticks[2]!.forward).toBe(2);
    expect(frame0.ticks[3]!.forward).toBe(3);

    const frame1 = cursor.nextFrame()!;
    // Frame 1: forward = 10,11,12,13.
    expect(frame1.ticks[0]!.forward).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Record → replay equivalence test
// ---------------------------------------------------------------------------

describe('replay equivalence', () => {

  /**
   * THE BIG ONE: record a scripted sim, then replay it headlessly, and assert
   * that bot/game state checkpoints match the original run.
   *
   * Scripted inputs:
   *   - Walk forward for the first 300 ticks.
   *   - Hold mouseDown from tick 70 onward (fire during live play); mousePressed
   *     edge fires on the first tick of the frame containing tick 70.
   *   - Stand still after tick 300.
   * Checkpoints assert per-combatant pos/vel/health/money/ammo for deep fidelity.
   */
  test('record→replay produces identical game-state checkpoints (bot positions, scores, bomb)', () => {
    const SEED = 0xc0ffee42;
    const TOTAL_TICKS = 800;
    const CHECKPOINT_EVERY = 100;

    const opts: MatchOptions = {
      playerTeam:  'CT',
      difficulty:  'normal',
      botsPerTeam: 2,
      seed:        SEED,
    };

    function inputProvider(tick: number, _now: number): ReplayTickInput {
      const mouseDown    = tick >= 70;
      // mousePressed is the rising edge — set it on the frame boundary tick that
      // first crosses 70 (tick 70 itself, since TICKS_PER_FRAME=2 → frames at 0,2,4...70...).
      const mousePressed = tick === 70;
      return idleTick({
        forward:      tick < 300 ? 1 : 0,
        mouseDown,
        mousePressed,
      });
    }

    const { checkpoints: orig, log } = runScriptedSim(opts, TOTAL_TICKS, CHECKPOINT_EVERY, inputProvider);

    expect(log.version).toBe(1);
    expect(log.seed).toBe(SEED);
    expect(log.frames.length).toBeGreaterThan(0);

    const replayCP = runReplaySim(log, 0, TOTAL_TICKS, CHECKPOINT_EVERY);

    expect(replayCP.length).toBe(orig.length);
    expect(orig.length).toBeGreaterThan(0);

    for (let i = 0; i < orig.length; i++) {
      const o = orig[i]!;
      const r = replayCP[i]!;
      expect(r.phase).toBe(o.phase);
      expect(r.roundNumber).toBe(o.roundNumber);
      expect(r.scoreCT).toBe(o.scoreCT);
      expect(r.scoreT).toBe(o.scoreT);
      expect(r.bombState).toBe(o.bombState);
      expect(r.combatants.length).toBe(o.combatants.length);

      // Deep per-combatant check (matches depth of determinism.test.ts).
      for (let ci = 0; ci < o.combatants.length; ci++) {
        const oc = o.combatants[ci]!;
        const rc = r.combatants[ci]!;
        expect(rc.posX).toBeCloseTo(oc.posX, 5);
        expect(rc.posY).toBeCloseTo(oc.posY, 5);
        expect(rc.posZ).toBeCloseTo(oc.posZ, 5);
        expect(rc.velX).toBeCloseTo(oc.velX, 5);
        expect(rc.velY).toBeCloseTo(oc.velY, 5);
        expect(rc.velZ).toBeCloseTo(oc.velZ, 5);
        expect(rc.health).toBe(oc.health);
        expect(rc.money).toBe(oc.money);
        expect(rc.ammo).toBe(oc.ammo);
        expect(rc.shotsFired).toBe(oc.shotsFired);
        expect(rc.alive).toBe(oc.alive);
      }
    }
  });

  test('replaying from a non-zero startTick does not throw', () => {
    const opts: MatchOptions = {
      playerTeam:  'CT',
      difficulty:  'easy',
      botsPerTeam: 1,
      seed:        0xabcdef01,
    };

    const { log } = runScriptedSim(opts, 200, 50, () => idleTick());
    expect(() => runReplaySim(log, 50, 50, 25)).not.toThrow();
  });

  test('roundStartTicks is an array (may be empty if no round transitions captured)', () => {
    const opts: MatchOptions = {
      playerTeam:  'CT',
      difficulty:  'easy',
      botsPerTeam: 1,
      seed:        0x12345678,
    };
    const { log } = runScriptedSim(opts, 50, 50, () => idleTick());
    // roundStartTicks is always an array in the log (may be empty for short runs
    // where the initial roundStart fires before the listener is wired).
    expect(Array.isArray(log.roundStartTicks)).toBe(true);
    // All recorded start ticks should be non-negative.
    for (const tick of log.roundStartTicks) {
      expect(tick).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Defensive / edge-case tests
// ---------------------------------------------------------------------------

describe('replay defensive cases', () => {

  test('version mismatch is rejected', () => {
    const r = new ReplayRecorder();
    r.beginMatch(1, { playerTeam: 'CT', difficulty: 'normal' });
    const log = r.endMatch()!;
    const tampered = { ...log, version: 99 as unknown as 1 };
    expect(() => new ReplayCursor(tampered)).toThrow();
  });

  test('empty log cursor is immediately done', () => {
    const r = new ReplayRecorder();
    r.beginMatch(1, { playerTeam: 'CT', difficulty: 'normal' });
    const log = r.endMatch()!;
    const cursor = new ReplayCursor(log);
    expect(cursor.done).toBe(true);
    expect(cursor.nextFrame()).toBeNull();
  });

  test('log version is exactly 1', () => {
    const r = new ReplayRecorder();
    r.beginMatch(5, { playerTeam: 'T', difficulty: 'hard' });
    const log = r.endMatch()!;
    expect(log.version).toBe(1);
  });

  test('seekTick(-1) treats as 0 and resets to beginning', () => {
    const r = new ReplayRecorder();
    r.beginMatch(1, { playerTeam: 'CT', difficulty: 'normal' });
    r.beginFrame(0, 0);
    r.recordTick(idleTick());
    r.flushFrame();
    const log = r.endMatch()!;
    const cursor = new ReplayCursor(log);
    cursor.nextFrame();
    cursor.seekTick(-1);
    expect(cursor.frameIndex).toBe(0);
  });

  test('multiple rounds all get their roundStartTick recorded', () => {
    // Simulate markRoundStart being called multiple times.
    const r = new ReplayRecorder();
    r.beginMatch(1, { playerTeam: 'CT', difficulty: 'normal' });
    r.markRoundStart(0);
    r.markRoundStart(512);
    r.markRoundStart(1024);
    const log = r.endMatch()!;
    expect(log.roundStartTicks).toHaveLength(3);
    expect(log.roundStartTicks[0]).toBe(0);
    expect(log.roundStartTicks[1]).toBe(512);
    expect(log.roundStartTicks[2]).toBe(1024);
  });
});
