/**
 * BotManager — Fills game.botBrains with per-bot closure-based AI.
 *
 * Per-tick pipeline (same as player):
 *   1. Perception (staggered, every 0.12 s per bot offset by id)
 *   2. FSM transition
 *   3. Decide move intent + aim
 *   4. simulateMovement(bot, intent, world, dt, now)
 *   5. updateWeapon(bot, world, targets, input, now, dt)
 */

import type { Combatant, Vec3, MapData } from '../types';
import type { World } from '../world';
import type { Game } from '../game';
import type { ShotResult } from '../combat';
import { gameEvents } from '../combat';
import { BOT_DIFFICULTY } from '../constants';
import { simulateMovement } from '../movement';
import type { MoveIntent } from '../movement';
import { updateWeapon, getViewPunch, switchSlot, isScoped } from '../weapons';
import { NavGrid } from './nav';
import { DUST2 } from '../maps/dust2';
import {
  distance,
  distanceSq,
  angleDiff,
  clamp,
  randSpread,
} from '../math';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VISION_FOV_HALF_RAD    = (100 / 2) * (Math.PI / 180); // 50 degrees
const PERCEPTION_INTERVAL    = 0.12;  // seconds between vision checks per bot
const REACTION_FLANK_MULT    = 1.3;
const REPLAN_INTERVAL        = 2.5;   // seconds
const WAYPOINT_ARRIVE_DIST   = 1.2;   // meters
const ESCORT_FOLLOW_DIST     = 5.5;   // T escort: re-path when farther than this
const ESCORT_REPLAN_DIST     = 6.0;   // re-path when carrier moves this far
const FOOTSTEP_DISTANCE      = 2.3;   // meters between footstep events
const STUCK_VEL_THRESHOLD    = 0.3;   // m/s horizontal below = stuck
const STUCK_DETECT_TIME      = 0.7;   // seconds of stuck before jump
const STUCK_REPLAN_TIME      = 1.5;   // seconds of stuck before full replan
const SIGHT_LOSE_TIME        = 1.5;   // seconds after losing sight before hunt
const AIM_ERROR_RESAMPLE     = 0.25;  // seconds between aim error resamples
const AIM_LOCK_TIME          = 1.2;   // seconds on same target before error shrinks
const AIM_LOCK_SHRINK        = 0.65;
const JIGGLE_INTERVAL_MIN    = 0.5;
const JIGGLE_INTERVAL_MAX    = 0.8;
const BURST_LEN_MIN          = 3;
const BURST_LEN_MAX          = 6;
const CLOSE_RANGE_M          = 12;
const HEAD_AIM_CHANCE_HARD   = 0.3;
const CROUCH_RANGE_CHANCE    = 0.4;
const GUARD_JITTER_DIST      = 2.0;
const DEFUSE_APPROACH_DIST   = 1.3;
const CT_BOMB_CONVERGE_DIST  = 14;

const TURN_SPEED: Record<'easy' | 'normal' | 'hard', number> = {
  easy:   4.5,
  normal: 8.0,
  hard:   13.0,
};

// ---------------------------------------------------------------------------
// Route definitions (T-side)
// ---------------------------------------------------------------------------

type RouteName = 'LONG_A' | 'SHORT_A' | 'TUNNELS_B';
interface RouteSpec { weight: number; areas: string[]; site: 'A' | 'B' }

const T_ROUTES: Record<RouteName, RouteSpec> = {
  LONG_A:    { weight: 0.4, areas: ['OutsideLong', 'LongDoors', 'LongA', 'ARamp', 'ASite'], site: 'A' },
  SHORT_A:   { weight: 0.3, areas: ['LowerMid', 'Catwalk', 'AShort', 'ASite'], site: 'A' },
  TUNNELS_B: { weight: 0.3, areas: ['OutsideTunnels', 'UpperTunnels', 'BSite'], site: 'B' },
};

// CT position assignments (cycled by bot index).
const CT_ASSIGNMENTS: Array<{ areas: string[]; entranceDir: string }> = [
  { areas: ['ASite', 'GooseA'],     entranceDir: 'LongA'       },
  { areas: ['ARamp', 'ASite'],      entranceDir: 'ARamp'       },
  { areas: ['BSite', 'BPlat'],      entranceDir: 'BDoors'      },
  { areas: ['BSite', 'MidToB'],     entranceDir: 'UpperTunnels'},
  { areas: ['CTMid',  'TopMid'],    entranceDir: 'MidDoors'    },
];

// ---------------------------------------------------------------------------
// FSM states
// ---------------------------------------------------------------------------

type BotState = 'objective' | 'engage' | 'hunt' | 'plant' | 'defuse' | 'guard';

// ---------------------------------------------------------------------------
// Per-bot state object
// ---------------------------------------------------------------------------

interface BotBrain {
  bot:              Combatant;
  state:            BotState;

  // Path following.
  currentPath:      Vec3[];
  pathIdx:          number;
  lastReplanAt:     number;
  routeAreas:       string[];
  routeAreaIdx:     number;
  routeSite:        'A' | 'B' | null;
  escortTarget:     Combatant | null;
  escortLastPos:    Vec3 | null;
  guardPos:         Vec3 | null;
  guardFacing:      number;

  // Combat.
  target:           Combatant | null;
  firstSeenAt:      number;
  targetVisibleAt:  number;
  lastKnownPos:     Vec3 | null;
  lastKnownAt:      number;

  // Aiming.
  aimErrorDeg:      number;
  aimErrorLastAt:   number;
  aimOnTargetSince: number;
  aimHeadEngagement: boolean;

  // Firing.
  burstRemaining:   number;

  // Jiggle strafe.
  jiggleDir:        number;
  jiggleFlipAt:     number;
  shouldCrouch:     boolean;

  // Stuck detection.
  stuckMoveWanted:  boolean;
  stuckStartAt:     number;
  stuckJumpPending: boolean;
  stuckJumpedAt:    number;

  // Footstep accumulator.
  stepAccum:        number;

  // Perception stagger.
  nextPerceptAt:    number;

  // Scope pulse tracking (AWP bots).
  scopeLastToggleAt: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function eyePos(c: Combatant): Vec3 {
  return { x: c.pos.x, y: c.pos.y + (c.crouching ? 1.17 : 1.64), z: c.pos.z };
}
function chestPos(c: Combatant): Vec3 {
  return { x: c.pos.x, y: c.pos.y + 1.2, z: c.pos.z };
}
function headPos(c: Combatant): Vec3 {
  return { x: c.pos.x, y: c.pos.y + 1.65, z: c.pos.z };
}

function pickRoute(): RouteName {
  let r = Math.random();
  for (const [name, spec] of Object.entries(T_ROUTES) as [RouteName, RouteSpec][]) {
    r -= spec.weight;
    if (r <= 0) return name;
  }
  return 'TUNNELS_B';
}

// ---------------------------------------------------------------------------
// BotManager
// ---------------------------------------------------------------------------

export class BotManager {
  private readonly _game:       Game;
  private readonly _world:      World;
  private readonly _nav:        NavGrid;
  private readonly _onBotShot?: (bot: Combatant, result: ShotResult) => void;

  private _brains:  Map<number, BotBrain> = new Map();
  private _unsubs:  Array<() => void>     = [];
  private _lastNow: number                = 0;

  private readonly _mapData: MapData = DUST2;

  constructor(
    game:       Game,
    world:      World,
    nav:        NavGrid,
    onBotShot?: (bot: Combatant, result: ShotResult) => void,
  ) {
    this._game      = game;
    this._world     = world;
    this._nav       = nav;
    this._onBotShot = onBotShot;
  }

  // Expose brain state for tests.
  getBrainState(botId: number): BotState | undefined {
    return this._brains.get(botId)?.state;
  }

  // ---------------------------------------------------------------------------
  // attach
  // ---------------------------------------------------------------------------

  attach(): void {
    const game = this._game;

    for (const c of game.combatants) {
      if (c.isPlayer) continue;
      const brain = this._makeBrain(c);
      this._brains.set(c.id, brain);
      // Capture brain in closure — tick is called by game.update.
      const captured = brain;
      game.botBrains.set(c.id, (bot, dt, now) => this._tick(captured, dt, now));
    }

    // Event subscriptions.
    this._unsubs.push(
      gameEvents.on('roundStart', () => {
        for (const [, br] of this._brains) this._roundStart(br);
      }),
      gameEvents.on('kill', (ev) => this._onKill(ev.victim)),
      gameEvents.on('shot', (ev) => this._onShot(ev.shooter)),
      gameEvents.on('bombPlanted', (ev) => this._onBombPlanted(ev.site)),
    );

    // Initial assignment (round may already be running).
    for (const [, br] of this._brains) this._roundStart(br);
  }

  // ---------------------------------------------------------------------------
  // dispose
  // ---------------------------------------------------------------------------

  dispose(): void {
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
    for (const [id] of this._brains) this._game.botBrains.delete(id);
    this._brains.clear();
  }

  // ---------------------------------------------------------------------------
  // Brain factory
  // ---------------------------------------------------------------------------

  private _makeBrain(bot: Combatant): BotBrain {
    const diff = BOT_DIFFICULTY[this._game.difficulty];
    return {
      bot,
      state:             'objective',
      currentPath:       [],
      pathIdx:           0,
      lastReplanAt:      -999,
      routeAreas:        [],
      routeAreaIdx:      0,
      routeSite:         null,
      escortTarget:      null,
      escortLastPos:     null,
      guardPos:          null,
      guardFacing:       0,
      target:            null,
      firstSeenAt:       -1,
      targetVisibleAt:   -1,
      lastKnownPos:      null,
      lastKnownAt:       -999,
      aimErrorDeg:       diff.aimErrorDeg,
      aimErrorLastAt:    -1,
      aimOnTargetSince:  -1,
      aimHeadEngagement: false,
      burstRemaining:    0,
      jiggleDir:         1,
      jiggleFlipAt:      0,
      shouldCrouch:      false,
      stuckMoveWanted:   false,
      stuckStartAt:      0,
      stuckJumpPending:  false,
      stuckJumpedAt:     -999,
      stepAccum:         0,
      // Stagger perception by bot id to spread CPU across bots.
      nextPerceptAt:     (bot.id % 12) * (PERCEPTION_INTERVAL / 12),

      scopeLastToggleAt: -999,
    };
  }

  // ---------------------------------------------------------------------------
  // Round-start assignment
  // ---------------------------------------------------------------------------

  private _roundStart(br: BotBrain): void {
    br.state              = 'objective';
    br.target             = null;
    br.firstSeenAt        = -1;
    br.targetVisibleAt    = -1;
    br.lastKnownPos       = null;
    br.currentPath        = [];
    br.pathIdx            = 0;
    br.lastReplanAt       = -999;
    br.burstRemaining     = 0;
    br.shouldCrouch       = false;
    br.stuckMoveWanted    = false;
    br.stuckStartAt       = 0;
    br.stuckJumpPending   = false;
    br.scopeLastToggleAt  = -999;

    if (br.bot.team === 'T') {
      this._assignT(br);
    } else {
      this._assignCT(br);
    }
  }

  private _assignT(br: BotBrain): void {
    const game    = this._game;
    const carrier = game.combatants.find(c => c.hasBomb);
    const bot     = br.bot;

    if (!carrier || carrier.id === bot.id) {
      // This bot is the carrier.
      const route = T_ROUTES[pickRoute()];
      br.routeAreas    = [...route.areas];
      br.routeSite     = route.site;
      br.routeAreaIdx  = 0;
      br.escortTarget  = null;
      return;
    }

    // Check how many already escort the carrier.
    const escortCount = [...this._brains.values()].filter(
      b => b.bot.id !== bot.id && b.escortTarget === carrier
    ).length;

    if (escortCount < 2) {
      br.escortTarget  = carrier;
      br.escortLastPos = { ...carrier.pos };
      const carrierBr  = this._brains.get(carrier.id);
      br.routeAreas    = carrierBr ? [...carrierBr.routeAreas] : [];
      br.routeSite     = carrierBr?.routeSite ?? null;
      br.routeAreaIdx  = 0;
    } else {
      // Push a different site.
      const carrierSite = this._brains.get(carrier.id)?.routeSite ?? 'A';
      const alts = (Object.values(T_ROUTES) as RouteSpec[]).filter(r => r.site !== carrierSite);
      const route = alts.length > 0 ? alts[Math.floor(Math.random() * alts.length)] : T_ROUTES.TUNNELS_B;
      br.routeAreas    = [...route.areas];
      br.routeSite     = route.site;
      br.routeAreaIdx  = 0;
      br.escortTarget  = null;
    }
  }

  private _assignCT(br: BotBrain): void {
    const bot    = br.bot;
    const ctBots = this._game.combatants.filter(c => c.team === 'CT' && !c.isPlayer && c.alive);
    const idx    = ctBots.findIndex(c => c.id === bot.id);
    const assign = CT_ASSIGNMENTS[Math.abs(idx) % CT_ASSIGNMENTS.length];

    br.routeAreas   = [...assign.areas];
    br.routeSite    = null;
    br.routeAreaIdx = 0;
    br.escortTarget = null;

    // Compute guard facing toward the entrance.
    const map       = this._mapData;
    const entArea   = map.areas.find((a: { name: string }) => a.name === assign.entranceDir);
    const holdName  = assign.areas[assign.areas.length - 1];
    const holdArea  = map.areas.find((a: { name: string }) => a.name === holdName);
    if (entArea && holdArea) {
      const ex = (entArea.min.x + entArea.max.x) / 2;
      const ez = (entArea.min.z + entArea.max.z) / 2;
      const hx = (holdArea.min.x + holdArea.max.x) / 2;
      const hz = (holdArea.min.z + holdArea.max.z) / 2;
      br.guardFacing = Math.atan2(-(ex - hx), -(ez - hz));
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private _onKill(victim: Combatant): void {
    for (const [, br] of this._brains) {
      if (!br.bot.alive) continue;
      if (br.bot.team === victim.team) continue; // own team died — not relevant to hearing
      const d = distance(br.bot.pos, victim.pos);
      if (d <= 40) {
        br.lastKnownPos = { ...victim.pos };
        br.lastKnownAt  = this._lastNow;
      }
    }
  }

  private _onShot(shooter: Combatant): void {
    for (const [, br] of this._brains) {
      if (!br.bot.alive) continue;
      if (br.bot.team === shooter.team) continue;
      const d = distance(br.bot.pos, shooter.pos);
      if (d <= 30 && br.state !== 'engage') {
        br.lastKnownPos = { ...shooter.pos };
        if (br.state === 'objective' || br.state === 'guard') {
          br.state = 'hunt';
        }
      }
    }
  }

  private _onBombPlanted(site: 'A' | 'B'): void {
    const areaName = site === 'A' ? 'ASite' : 'BSite';
    for (const [, br] of this._brains) {
      if (!br.bot.alive || br.bot.team !== 'CT') continue;
      if (br.state === 'engage' || br.state === 'defuse') continue;
      br.routeAreas    = [areaName];
      br.routeAreaIdx  = 0;
      br.state         = 'objective';
      br.currentPath   = [];
      br.pathIdx       = 0;
      br.lastReplanAt  = -999;
    }
  }

  // ---------------------------------------------------------------------------
  // Per-tick update — called by game.botBrains
  // ---------------------------------------------------------------------------

  private _tick(br: BotBrain, dt: number, now: number): void {
    const bot  = br.bot;
    const game = this._game;

    // Track current time for event handlers that have no 'now' parameter.
    this._lastNow = now;

    if (game.phase === 'freeze') return;
    if (!bot.alive) return;

    const diff = BOT_DIFFICULTY[game.difficulty];

    // 1. Perception (staggered).
    if (now >= br.nextPerceptAt) {
      br.nextPerceptAt = now + PERCEPTION_INTERVAL;
      this._perceive(br, now, diff);
    }

    // 2. FSM — build move intent and handle useHeld.
    const intent: MoveIntent = { forward: 0, strafe: 0, jump: false, crouch: false, walk: false };
    this._runFSM(br, dt, now, diff, intent);

    // 3. Crouch flag.
    intent.crouch = br.shouldCrouch;

    // 4. Stuck jump injection.
    if (br.stuckJumpPending) {
      intent.jump        = true;
      br.stuckJumpPending = false;
    }

    // 5. Simulate movement.
    const moveEv = simulateMovement(bot, intent, this._world, dt, now);

    // 6. Footstep events.
    if (bot.onGround && !bot.walking) {
      br.stepAccum += moveEv.stepDistance;
      if (br.stepAccum >= FOOTSTEP_DISTANCE) {
        br.stepAccum = 0;
        gameEvents.emit('footstep', { who: bot });
      }
    }

    // 7. Stuck detection.
    this._detectStuck(br, dt, now, intent);

    // 8. Aim.
    this._aimAt(br, dt, now, diff);

    // 9. Weapon update.
    const weapInput = this._weaponInput(br, now, diff);
    const shotResult = updateWeapon(bot, this._world, game.combatants, weapInput, now, dt);
    if (shotResult !== null && this._onBotShot) {
      this._onBotShot(bot, shotResult);
    }
  }

  // ---------------------------------------------------------------------------
  // Perception
  // ---------------------------------------------------------------------------

  private _perceive(
    br: BotBrain,
    now: number,
    diff: { reactionMs: number; aimErrorDeg: number; recoilControl: number; visionRange: number },
  ): void {
    const bot   = br.bot;
    const world = this._world;
    const game  = this._game;

    let nearest: Combatant | null = null;
    let nearestDSq = Infinity;

    for (const c of game.combatants) {
      if (!c.alive || c.team === bot.team || c === bot) continue;
      const d = distance(bot.pos, c.pos);
      if (d > diff.visionRange) continue;

      // FOV.
      const dx  = c.pos.x - bot.pos.x;
      const dz  = c.pos.z - bot.pos.z;
      const da  = Math.abs(angleDiff(bot.yaw, Math.atan2(-dx, -dz)));
      if (da > VISION_FOV_HALF_RAD) continue;

      // LOS.
      const botEye = eyePos(bot);
      if (!world.lineOfSight(botEye, eyePos(c)) &&
          !world.lineOfSight(botEye, chestPos(c))) continue;

      const dSq = distanceSq(bot.pos, c.pos);
      if (dSq < nearestDSq) { nearestDSq = dSq; nearest = c; }
    }

    if (nearest !== null) {
      const dx  = nearest.pos.x - bot.pos.x;
      const dz  = nearest.pos.z - bot.pos.z;
      const da  = Math.abs(angleDiff(bot.yaw, Math.atan2(-dx, -dz)));
      const isBehind = da > Math.PI * 0.6;
      const rxMs = diff.reactionMs * (isBehind ? REACTION_FLANK_MULT : 1);

      if (br.target !== nearest) {
        br.firstSeenAt        = now;
        br.aimOnTargetSince   = now;
        br.aimHeadEngagement  = (game.difficulty === 'hard' && Math.random() < HEAD_AIM_CHANCE_HARD);
        br.shouldCrouch       = (
          game.difficulty === 'hard' &&
          Math.random() < CROUCH_RANGE_CHANCE &&
          distance(bot.pos, nearest.pos) > 15
        );
      }

      br.target          = nearest;
      br.targetVisibleAt = now;
      br.lastKnownPos    = { ...nearest.pos };
      br.lastKnownAt     = now;

      if ((now - br.firstSeenAt) * 1000 >= rxMs) {
        if (br.state !== 'plant' && br.state !== 'defuse') {
          br.state = 'engage';
        }
      }
    } else {
      if (br.state === 'engage' && now - br.targetVisibleAt >= SIGHT_LOSE_TIME) {
        br.state  = 'hunt';
        br.target = null;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // FSM + intent building
  // ---------------------------------------------------------------------------

  private _runFSM(
    br: BotBrain,
    dt: number,
    now: number,
    diff: { reactionMs: number; aimErrorDeg: number; recoilControl: number; visionRange: number },
    intent: MoveIntent,
  ): void {
    const bot  = br.bot;
    const game = this._game;
    const nav  = this._nav;
    const map  = this._mapData;

    // Global: T bot in site with bomb → plant.
    if (bot.team === 'T' && bot.hasBomb && bot.onGround && game.phase === 'live') {
      if (this._activeSite(bot.pos) !== null) {
        br.state = 'plant';
      }
    }

    // Global: all Ts guard when bomb planted (non-carrier, non-engage states).
    if (bot.team === 'T' && game.bomb.state === 'planted' &&
        br.state !== 'plant' && br.state !== 'engage' && br.state !== 'guard') {
      const bPos = game.bomb.pos;
      if (br.guardPos === null) {
        const jitter = nav.nearestWalkable({
          x: bPos.x + (Math.random() * 8 - 4),
          y: bPos.y,
          z: bPos.z + (Math.random() * 8 - 4),
        });
        br.guardPos = jitter ?? { ...bPos };
      }
      br.state = 'guard';
    }

    // Global: CT near bomb → defuse.
    if (bot.team === 'CT' && game.bomb.state === 'planted' &&
        br.state !== 'defuse' && br.state !== 'engage') {
      if (distance(bot.pos, game.bomb.pos) < CT_BOMB_CONVERGE_DIST) {
        br.state       = 'defuse';
        br.currentPath = [];
        br.pathIdx     = 0;
      }
    }

    switch (br.state) {
      // ----------------------------------------------------------------
      case 'objective': {
        this._doObjective(br, now, intent);
        break;
      }
      // ----------------------------------------------------------------
      case 'engage': {
        if (br.target === null || !br.target.alive) {
          br.target = null;
          br.state  = br.lastKnownPos ? 'hunt' : 'objective';
          break;
        }
        // Jiggle flip.
        if (now >= br.jiggleFlipAt) {
          br.jiggleDir  = br.jiggleDir === 1 ? -1 : 1;
          br.jiggleFlipAt = now + JIGGLE_INTERVAL_MIN + Math.random() * (JIGGLE_INTERVAL_MAX - JIGGLE_INTERVAL_MIN);
        }
        // Movement: strafe/stop logic.
        const d        = distance(bot.pos, br.target.pos);
        const activeWs = bot.inventory[bot.inventory.activeSlot];
        const isAuto   = activeWs?.def.auto ?? false;
        if (isAuto && d > CLOSE_RANGE_M && br.burstRemaining > 0) {
          // Counter-strafe: stop while firing.
          intent.forward = 0;
          intent.strafe  = 0;
        } else {
          intent.strafe = br.jiggleDir;
        }
        break;
      }
      // ----------------------------------------------------------------
      case 'hunt': {
        if (br.lastKnownPos === null) {
          br.state = 'objective';
          break;
        }
        const d = distance(bot.pos, br.lastKnownPos);
        if (d < WAYPOINT_ARRIVE_DIST * 1.5) {
          br.lastKnownPos = null;
          br.state        = br.guardPos !== null ? 'guard' : 'objective';
          break;
        }
        this._pathToward(br, br.lastKnownPos, now);
        this._followPath(br, intent);
        break;
      }
      // ----------------------------------------------------------------
      case 'plant': {
        if (game.bomb.state === 'planted') {
          // Assign guard post near bomb.
          const bPos = game.bomb.pos;
          br.guardPos = nav.nearestWalkable({
            x: bPos.x + (Math.random() * 8 - 4),
            y: bPos.y,
            z: bPos.z + (Math.random() * 8 - 4),
          }) ?? { ...bPos };
          br.state = 'guard';
          break;
        }
        if (!bot.hasBomb) {
          br.state = 'objective';
          break;
        }
        // Stand still and call useHeld.
        intent.forward = 0;
        intent.strafe  = 0;
        game.useHeld(bot, true, now, dt);
        break;
      }
      // ----------------------------------------------------------------
      case 'defuse': {
        if (game.bomb.state !== 'planted') {
          br.state = 'objective';
          break;
        }
        // Visible enemy → go engage first.
        if (br.target !== null && br.target.alive) {
          br.state = 'engage';
          break;
        }
        const bombPos = game.bomb.pos;
        const dBomb   = distance(bot.pos, bombPos);
        if (dBomb > DEFUSE_APPROACH_DIST) {
          this._pathToward(br, bombPos, now);
          this._followPath(br, intent);
          game.useHeld(bot, false, now, dt); // release while moving
        } else {
          intent.forward = 0;
          intent.strafe  = 0;
          game.useHeld(bot, true, now, dt);
        }
        break;
      }
      // ----------------------------------------------------------------
      case 'guard': {
        // CT: bomb planted → start defusing.
        if (bot.team === 'CT' && game.bomb.state === 'planted') {
          br.state       = 'defuse';
          br.currentPath = [];
          br.pathIdx     = 0;
          break;
        }
        if (br.guardPos === null) {
          br.state = 'objective';
          break;
        }
        const d = distance(bot.pos, br.guardPos);
        if (d > WAYPOINT_ARRIVE_DIST * 2) {
          this._pathToward(br, br.guardPos, now);
          this._followPath(br, intent);
        } else {
          // Jitter within guard radius.
          if (br.pathIdx >= br.currentPath.length) {
            const gp = br.guardPos;
            const jitter = nav.randomPointInRect(
              { x: gp.x - GUARD_JITTER_DIST, z: gp.z - GUARD_JITTER_DIST },
              { x: gp.x + GUARD_JITTER_DIST, z: gp.z + GUARD_JITTER_DIST },
            );
            if (jitter) {
              const path = nav.findPath(bot.pos, jitter);
              if (path) { br.currentPath = path; br.pathIdx = 0; }
            }
          }
          this._followPath(br, intent);
          intent.walk = true;
        }
        break;
      }
    }
  }

  private _doObjective(br: BotBrain, now: number, intent: MoveIntent): void {
    const bot = br.bot;
    const nav = this._nav;
    const map = this._mapData;

    // Escort logic.
    if (br.escortTarget !== null) {
      const carrier = br.escortTarget;
      if (!carrier.alive) {
        br.escortTarget = null;
        // Fall through to normal route below.
      } else {
        const dToCarrier  = distance(bot.pos, carrier.pos);
        const movedFar    = br.escortLastPos
          ? distance(carrier.pos, br.escortLastPos) > ESCORT_REPLAN_DIST
          : true;

        if (dToCarrier > ESCORT_FOLLOW_DIST || movedFar || br.currentPath.length === 0) {
          const path = nav.findPath(bot.pos, carrier.pos);
          if (path) {
            br.currentPath    = path;
            br.pathIdx        = 0;
            br.lastReplanAt   = now;
            br.escortLastPos  = { ...carrier.pos };
          }
        }
        this._followPath(br, intent);
        return;
      }
    }

    if (br.routeAreas.length === 0) return;

    const areaName = br.routeAreas[br.routeAreaIdx];
    const area     = map.areas.find((a: { name: string }) => a.name === areaName);
    if (!area) {
      br.routeAreaIdx = Math.min(br.routeAreaIdx + 1, br.routeAreas.length - 1);
      return;
    }

    // Pick a random point in the target area.
    let targetPt = nav.randomPointInRect(area.min, area.max);
    if (!targetPt) {
      targetPt = nav.nearestWalkable({
        x: (area.min.x + area.max.x) / 2,
        y: 0,
        z: (area.min.z + area.max.z) / 2,
      });
    }
    if (!targetPt) return;

    // Check if arrived at area.
    const dToArea = distance(bot.pos, targetPt);
    if (dToArea < WAYPOINT_ARRIVE_DIST * 3) {
      if (br.routeAreaIdx < br.routeAreas.length - 1) {
        br.routeAreaIdx++;
        br.currentPath  = [];
        br.pathIdx      = 0;
        br.lastReplanAt = -999;
      } else {
        // Final leg reached → guard.
        br.guardPos = { ...targetPt };
        br.state    = 'guard';
        br.guardFacing = br.guardFacing; // keep existing
      }
      return;
    }

    // Replan if stale or exhausted.
    const needReplan = br.currentPath.length === 0 ||
                       br.pathIdx >= br.currentPath.length ||
                       now - br.lastReplanAt > REPLAN_INTERVAL;
    if (needReplan) {
      const path = nav.findPath(bot.pos, targetPt);
      if (path) {
        br.currentPath  = path;
        br.pathIdx      = 0;
        br.lastReplanAt = now;
      }
    }

    this._followPath(br, intent);
  }

  // ---------------------------------------------------------------------------
  // Path helpers
  // ---------------------------------------------------------------------------

  private _pathToward(br: BotBrain, target: Vec3, now: number): void {
    const needReplan = br.currentPath.length === 0 ||
                       br.pathIdx >= br.currentPath.length ||
                       now - br.lastReplanAt > REPLAN_INTERVAL;
    if (needReplan) {
      const path = this._nav.findPath(br.bot.pos, target);
      if (path) {
        br.currentPath  = path;
        br.pathIdx      = 0;
        br.lastReplanAt = now;
      }
    }
  }

  private _followPath(br: BotBrain, intent: MoveIntent): void {
    const bot = br.bot;
    if (br.pathIdx >= br.currentPath.length) return;

    const wp  = br.currentPath[br.pathIdx];
    const dx  = wp.x - bot.pos.x;
    const dz  = wp.z - bot.pos.z;
    const d   = Math.sqrt(dx * dx + dz * dz);

    if (d < WAYPOINT_ARRIVE_DIST) {
      br.pathIdx++;
      if (br.pathIdx >= br.currentPath.length) return;
    }

    const wp2 = br.currentPath[br.pathIdx];
    const dx2 = wp2.x - bot.pos.x;
    const dz2 = wp2.z - bot.pos.z;
    const desiredYaw = Math.atan2(-dx2, -dz2);
    const da = angleDiff(bot.yaw, desiredYaw);

    if (Math.abs(da) < Math.PI / 3) {
      intent.forward = 1;
    } else {
      intent.forward = 0.3;
    }
  }

  // ---------------------------------------------------------------------------
  // Aiming
  // ---------------------------------------------------------------------------

  private _aimAt(
    br: BotBrain,
    dt: number,
    now: number,
    diff: { reactionMs: number; aimErrorDeg: number; recoilControl: number; visionRange: number },
  ): void {
    const bot      = br.bot;
    const game     = this._game;
    const turnRate = TURN_SPEED[game.difficulty];
    const dtFixed  = dt;

    // If in guard and no target, face guard direction.
    if (br.state === 'guard' && br.target === null) {
      const da = angleDiff(bot.yaw, br.guardFacing);
      bot.yaw += clamp(da, -turnRate * dtFixed, turnRate * dtFixed);
      return;
    }

    const target = br.target;
    if (target === null) {
      // Face movement direction.
      if (br.pathIdx < br.currentPath.length) {
        const wp  = br.currentPath[br.pathIdx];
        const dx  = wp.x - bot.pos.x;
        const dz  = wp.z - bot.pos.z;
        const ang = Math.atan2(-dx, -dz);
        const da  = angleDiff(bot.yaw, ang);
        bot.yaw  += clamp(da, -turnRate * dtFixed, turnRate * dtFixed);
      }
      return;
    }

    // Resample aim error.
    if (now - br.aimErrorLastAt > AIM_ERROR_RESAMPLE) {
      br.aimErrorLastAt = now;
      let err = diff.aimErrorDeg;
      if (br.aimOnTargetSince >= 0 && now - br.aimOnTargetSince > AIM_LOCK_TIME) {
        err *= AIM_LOCK_SHRINK;
      }
      br.aimErrorDeg = err;
    }

    // Target point.
    const aimPt  = br.aimHeadEngagement ? headPos(target) : chestPos(target);
    const errRad = randSpread(br.aimErrorDeg) * (Math.PI / 180);

    // Recoil compensation.
    const punch     = getViewPunch(bot);
    const recoilAdj = punch.pitch * diff.recoilControl;

    const botEye = eyePos(bot);
    const dx     = aimPt.x - botEye.x;
    const dy     = aimPt.y - botEye.y;
    const dz     = aimPt.z - botEye.z;
    const horiz  = Math.sqrt(dx * dx + dz * dz);

    const desYaw   = Math.atan2(-dx, -dz) + errRad;
    const desPitch = Math.atan2(dy, horiz) + errRad - recoilAdj;

    const dyaw   = angleDiff(bot.yaw,   desYaw);
    const dpitch = angleDiff(bot.pitch, desPitch);

    bot.yaw   += clamp(dyaw,   -turnRate * dtFixed, turnRate * dtFixed);
    bot.pitch  = clamp(
      bot.pitch + clamp(dpitch, -turnRate * dtFixed, turnRate * dtFixed),
      -Math.PI / 2 * 0.99,
       Math.PI / 2 * 0.99,
    );
  }

  // ---------------------------------------------------------------------------
  // Weapon input
  // ---------------------------------------------------------------------------

  private _weaponInput(
    br: BotBrain,
    now: number,
    diff: { reactionMs: number; aimErrorDeg: number; recoilControl: number; visionRange: number },
  ): { trigger: boolean; reloadPressed: boolean; scopePressed: boolean } {
    const bot  = br.bot;
    const game = this._game;

    // Reload logic.
    const slot = bot.inventory.activeSlot;
    const ws   = bot.inventory[slot];
    if (ws && !ws.def.isKnife && ws.reserve > 0 && !ws.reloading) {
      if (ws.ammo === 0 || (ws.ammo < ws.def.magSize * 0.35 && br.target === null)) {
        return { trigger: false, reloadPressed: true, scopePressed: false };
      }
    }

    // Weapon switch when dry.
    if (ws && ws.ammo === 0 && ws.reserve === 0 && br.state === 'engage') {
      if (slot !== 'primary' && bot.inventory.primary) {
        switchSlot(bot, 'primary', now);
      } else if (slot !== 'secondary' && bot.inventory.secondary) {
        switchSlot(bot, 'secondary', now);
      } else if (slot !== 'knife') {
        switchSlot(bot, 'knife', now);
      }
    }

    // AWP scope pulse: runs after the reload early-return (scope never toggles mid-reload,
    // which is intentional) and before the accuracy gate (so the bot can scope in even
    // while still swinging toward the target).
    // scopePressed is an edge (rising): one tick only, then returns false.
    // Cooldown of 0.4 s between toggles prevents rapid re-toggling.
    const SCOPE_COOLDOWN = 0.4; // seconds between scope-toggle pulses
    let scopePressed = false;

    const activeWs2 = bot.inventory[bot.inventory.activeSlot];
    const holdsAwp  = (
      bot.inventory.activeSlot === 'primary' &&
      activeWs2 !== null &&
      activeWs2.def.id === 'awp'
    );

    if (holdsAwp && now - br.scopeLastToggleAt >= SCOPE_COOLDOWN) {
      const currentlyScoped = isScoped(bot);
      const inEngage        = br.state === 'engage' && br.target !== null && br.target.alive;

      if (inEngage && !currentlyScoped) {
        // Toggle scope ON.
        scopePressed          = true;
        br.scopeLastToggleAt  = now;
      } else if (!inEngage && currentlyScoped) {
        // Toggle scope OFF (leaving engage or target lost).
        scopePressed          = true;
        br.scopeLastToggleAt  = now;
      }
    }

    // Only fire in engage state with a live target.
    if (br.state !== 'engage' || br.target === null || !br.target.alive) {
      return { trigger: false, reloadPressed: false, scopePressed };
    }

    const target   = br.target;
    const activeWs = bot.inventory[bot.inventory.activeSlot];
    if (!activeWs) return { trigger: false, reloadPressed: false, scopePressed };

    // Angular accuracy gate.
    const botEye  = eyePos(bot);
    const aimPt   = br.aimHeadEngagement ? headPos(target) : chestPos(target);
    const dx      = aimPt.x - botEye.x;
    const dy      = aimPt.y - botEye.y;
    const dz      = aimPt.z - botEye.z;
    const horiz   = Math.sqrt(dx * dx + dz * dz);
    const desYaw  = Math.atan2(-dx, -dz);
    const desPit  = Math.atan2(dy, horiz);

    const angErr = Math.sqrt(
      angleDiff(bot.yaw,   desYaw) ** 2 +
      angleDiff(bot.pitch, desPit) ** 2,
    ) * (180 / Math.PI);

    const maxErr = Math.max(1.5, diff.aimErrorDeg);
    if (angErr > maxErr) {
      return { trigger: false, reloadPressed: false, scopePressed };
    }

    // Fire decision.
    const distToTarget = distance(bot.pos, target.pos);
    const isAuto       = activeWs.def.auto;
    let trigger        = false;

    if (game.difficulty === 'hard' && distToTarget <= CLOSE_RANGE_M) {
      // Spray full auto at close range for hard bots.
      trigger = true;
    } else if (isAuto) {
      if (br.burstRemaining > 0) {
        trigger = true;
        br.burstRemaining--;
      } else {
        const len = BURST_LEN_MIN + Math.floor(Math.random() * (BURST_LEN_MAX - BURST_LEN_MIN + 1));
        br.burstRemaining = len - 1;
        trigger = true;
      }
    } else {
      // Semi-auto: fire each frame we're on target.
      trigger = true;
    }

    return { trigger, reloadPressed: false, scopePressed };
  }

  // ---------------------------------------------------------------------------
  // Stuck detection
  // ---------------------------------------------------------------------------

  private _detectStuck(br: BotBrain, dt: number, now: number, intent: MoveIntent): void {
    const bot     = br.bot;
    const moving  = intent.forward !== 0 || intent.strafe !== 0;

    if (!moving) {
      br.stuckMoveWanted = false;
      br.stuckStartAt    = now;
      return;
    }

    const horizSpd = Math.sqrt(bot.vel.x ** 2 + bot.vel.z ** 2);
    if (horizSpd >= STUCK_VEL_THRESHOLD) {
      br.stuckMoveWanted = false;
      br.stuckStartAt    = now;
      return;
    }

    if (!br.stuckMoveWanted) {
      br.stuckMoveWanted = true;
      br.stuckStartAt    = now;
    }

    const stuckTime = now - br.stuckStartAt;

    if (stuckTime >= STUCK_DETECT_TIME && now - br.stuckJumpedAt > 1.2) {
      br.stuckJumpPending = true;
      br.stuckJumpedAt    = now;
    }

    if (stuckTime >= STUCK_REPLAN_TIME) {
      br.stuckMoveWanted = false;
      br.stuckStartAt    = now;
      br.currentPath     = [];
      br.pathIdx         = 0;
      br.lastReplanAt    = -999;
      // Snap to nearest walkable cell.
      const snap = this._nav.nearestWalkable(bot.pos);
      if (snap && distance(snap, bot.pos) < 2.0) {
        bot.pos = { ...snap };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helper: bombsite detection
  // ---------------------------------------------------------------------------

  private _activeSite(pos: Vec3): 'A' | 'B' | null {
    for (const site of this._mapData.bombsites) {
      if (pos.x >= site.min.x && pos.x <= site.max.x &&
          pos.z >= site.min.z && pos.z <= site.max.z) {
        return site.name;
      }
    }
    return null;
  }
}
