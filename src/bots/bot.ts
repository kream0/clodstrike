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
import { BOT_DIFFICULTY, WEAPONS, ECONOMY } from '../constants';
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
const BOT_SEPARATION_DIST    = 0.6;   // meters — start pushing when closer than this
const BOT_SEPARATION_IMPULSE = 2.0;   // m/s at full overlap
const ESCORT_STOP_DIST       = 2.0;   // stop pushing toward carrier within this dist
const SPAWN_ZONE_MARGIN      = 6.0;   // meters padding around spawn AABBs

// ---------------------------------------------------------------------------
// Bot economy: tiered buy pools (CS2-style)
//
// Each pool is an explicit list of weapon ids.  Pools are filtered at runtime
// by def.teams so adding a weapon to WEAPONS that belongs to only one team
// will not require touching these lists — the eligibility check enforces it.
//
// NEVER add m249, negev, g3sg1, scar20 to any pool: bots skip meme tier
// (MGs are impractical in 5v5; auto-snipers are camp-fest weapons).
// ---------------------------------------------------------------------------

/**
 * Pistol-round / eco upgrade pool.
 * Used when the bot chose 'eco' strategy and has some leftover budget.
 * Filtered by team at runtime; deagle is both-teams and appears only at $700+.
 */
export const BUY_POOL_ECO_PISTOL: readonly string[] = [
  'p250',     // $250 — both teams
  'dualies',  // $300 — both teams
  'tec9',     // $500 — T only (filtered below)
  'fiveseven',// $500 — CT only (filtered below)
  'deagle',   // $700 — both teams (classic eco deagle)
];

/**
 * Force-buy SMG / shotgun pool.
 * Used when strategy is 'force'.  mac10 is T-only; mp9 is CT-only; rest both.
 * Shotguns appear at ~20% rate — handled by caller logic.
 */
export const BUY_POOL_FORCE_SMG: readonly string[] = [
  'mac10',  // $1050 — T only
  'mp9',    // $1250 — CT only
  'ump45',  // $1200 — both teams
  'mp7',    // $1500 — both teams
  'bizon',  // $1400 — both teams (budget option, large mag)
];

export const BUY_POOL_FORCE_SHOTGUN: readonly string[] = [
  'nova',    // $1050 — both teams
  'sawedoff',// $1100 — T only
  'mag7',    // $1300 — CT only
];

/**
 * Full-buy primary pool.
 * ak47 is T-only; m4a4 is CT-only; galil T-only; famas CT-only.
 * aug is CT-only; sg553 is T-only.
 * Hard bots with $6000+ may roll aug(CT)/sg553(T) at 25% chance.
 */
export const BUY_POOL_FULL_PRIMARY_BUDGET: readonly string[] = [
  'galil',  // $1800 — T only (mid-budget T rifle)
  'famas',  // $2050 — CT only (mid-budget CT rifle)
];

export const BUY_POOL_FULL_PRIMARY_STANDARD: readonly string[] = [
  'ak47',   // $2700 — T only
  'm4a4',   // $2900 — CT only
];

export const BUY_POOL_FULL_PRIMARY_RICH: readonly string[] = [
  'aug',    // $3300 — CT only
  'sg553',  // $3000 — T only
];

// ---------------------------------------------------------------------------
// Module-init pool validity check (catches id typos at boot, not at runtime).
// Runs once when the module is first imported.
// ---------------------------------------------------------------------------

(function _assertBuyPoolIds(): void {
  const allPools: ReadonlyArray<readonly string[]> = [
    BUY_POOL_ECO_PISTOL,
    BUY_POOL_FORCE_SMG,
    BUY_POOL_FORCE_SHOTGUN,
    BUY_POOL_FULL_PRIMARY_BUDGET,
    BUY_POOL_FULL_PRIMARY_STANDARD,
    BUY_POOL_FULL_PRIMARY_RICH,
  ];
  for (const pool of allPools) {
    for (const id of pool) {
      if (!WEAPONS[id]) {
        throw new Error(`BotManager buy-pool: weapon id '${id}' not found in WEAPONS table`);
      }
    }
  }
})();

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

export type BotState = 'objective' | 'engage' | 'hunt' | 'plant' | 'defuse' | 'guard';

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
  targetVisible:    boolean;       // true only when target had LOS this tick
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

  // Flash blindness state.
  // wasBlind: true if the bot was blinded on the previous tick. Used to detect
  // the transition from blind→not-blind so we can trigger a fresh reaction.
  wasBlind: boolean;
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

// Axis-aligned bounding box for a spawn zone.
interface SpawnZoneAABB {
  minX: number; maxX: number;
  minZ: number; maxZ: number;
}

export class BotManager {
  private readonly _game:       Game;
  private readonly _world:      World;
  private readonly _nav:        NavGrid;
  private readonly _onBotShot?: (bot: Combatant, result: ShotResult) => void;

  private _brains:  Map<number, BotBrain> = new Map();
  private _unsubs:  Array<() => void>     = [];
  private _lastNow: number                = 0;

  // Optional smoke-segment query: returns true when the segment a→b is obscured
  // by a smoke volume. Null = no smoke system available (all segments clear).
  private _smokeQuery: ((a: Vec3, b: Vec3) => boolean) | null = null;

  private readonly _mapData: MapData = DUST2;

  // F1: sticky retriever id when the bomb is dropped.
  private _retrieverId: number | null = null;
  // F1: game-time when the current retriever first entered 'engage' continuously.
  // Sentinel -1 means the retriever is NOT currently engaging.
  private _retrieverEngagedSince: number = -1;

  // F3: spawn zone AABBs computed once at construction.
  private readonly _ctSpawnZone: SpawnZoneAABB;
  private readonly _tSpawnZone:  SpawnZoneAABB;

  // Pre-allocated work vector for separation impulse (no per-tick heap alloc).
  private readonly _sepWork: Vec3 = { x: 0, y: 0, z: 0 };

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

    // F3: compute spawn-zone AABBs once from map data (+ margin).
    this._ctSpawnZone = BotManager._buildSpawnZone(DUST2.spawns.ct);
    this._tSpawnZone  = BotManager._buildSpawnZone(DUST2.spawns.t);
  }

  /** Build an AABB over an array of spawn points plus SPAWN_ZONE_MARGIN. */
  private static _buildSpawnZone(
    pts: ReadonlyArray<{ x: number; z: number }>,
  ): SpawnZoneAABB {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    return {
      minX: minX - SPAWN_ZONE_MARGIN,
      maxX: maxX + SPAWN_ZONE_MARGIN,
      minZ: minZ - SPAWN_ZONE_MARGIN,
      maxZ: maxZ + SPAWN_ZONE_MARGIN,
    };
  }

  /** Returns true when the given position is inside the specified spawn zone AABB. */
  private static _inSpawnZone(pos: Vec3, zone: SpawnZoneAABB): boolean {
    return pos.x >= zone.minX && pos.x <= zone.maxX &&
           pos.z >= zone.minZ && pos.z <= zone.maxZ;
  }

  /**
   * Inject (or remove) the smoke-segment query used by bot perception and
   * engage-state LOS revalidation. Pass null to disable smoke checks.
   * Integration: call this from main.ts after BotManager construction, e.g.:
   *   botManager.setSmokeQuery((a, b) => isSegmentSmoked(a, b));
   */
  setSmokeQuery(q: ((a: Vec3, b: Vec3) => boolean) | null): void {
    this._smokeQuery = q;
  }

  // Expose brain state for tests.
  getBrainState(botId: number): BotState | undefined {
    return this._brains.get(botId)?.state;
  }

  // Expose current aim error (degrees) for tests (partial-blind verification).
  getBrainAimErrorDeg(botId: number): number | undefined {
    return this._brains.get(botId)?.aimErrorDeg;
  }

  // Expose current target for tests.
  getBrainTarget(botId: number): Combatant | null | undefined {
    return this._brains.get(botId)?.target;
  }

  // Expose retriever id for tests (F1).
  getRetrieverId(): number | null {
    return this._retrieverId;
  }

  // Expose guardFacing for tests (F2).
  getBrainGuardFacing(botId: number): number | undefined {
    return this._brains.get(botId)?.guardFacing;
  }

  // Expose lastKnownPos for tests (F3).
  getBrainLastKnownPos(botId: number): Vec3 | null | undefined {
    return this._brains.get(botId)?.lastKnownPos;
  }

  // Expose targetVisible for tests (LOS gate verification).
  getBrainTargetVisible(botId: number): boolean | undefined {
    return this._brains.get(botId)?.targetVisible;
  }

  // Force lastKnownPos for tests (LOS gate + corner-hold tests).
  setBrainLastKnownPosForTest(botId: number, pos: Vec3 | null): void {
    const br = this._brains.get(botId);
    if (br) br.lastKnownPos = pos !== null ? { ...pos } : null;
  }

  // Expose spawn zone AABBs for tests (F3).
  getSpawnZone(team: 'CT' | 'T'): SpawnZoneAABB {
    return team === 'CT' ? this._ctSpawnZone : this._tSpawnZone;
  }

  // Force a bot's FSM state — used only by unit tests to pin a bot in a
  // specific state without needing to drive it there through full perception.
  // For 'engage', a non-null live target must be provided so the FSM's
  // `target === null` guard does not immediately exit the state.
  setBrainStateForTest(botId: number, state: BotState, now: number, target?: Combatant): void {
    const br = this._brains.get(botId);
    if (!br) return;
    br.state = state;
    if (state === 'engage') {
      // Keep the engage state alive across ticks:
      // - targetVisibleAt close to now so the sight-loss timer doesn't fire.
      // - firstSeenAt in the distant past so reaction time is already elapsed.
      // - target set to a plausible live combatant so _runFSM's null-guard passes.
      br.targetVisibleAt = now;
      br.firstSeenAt     = now - 9999;
      if (target !== undefined) {
        br.target = target;
      }
    }
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
      gameEvents.on('roundStart', ({ roundNumber }) => {
        // Tiered buy pass runs BEFORE per-brain round-start so weapon slots
        // are ready when brains enter their first tick.
        // Skip round 1: bots start with pistols only (800 start money).
        if (roundNumber > 1) {
          this._doBotTeamBuyPass(this._lastNow);
        }
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
      targetVisible:     false,
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

      wasBlind:          false,
    };
  }

  // ---------------------------------------------------------------------------
  // Bot tiered buy pass — runs once per round (round 2+) for all bots.
  //
  // Design: game.ts _botTeamBuy already ran a simple pass (ak47/m4a4 for full,
  // deagle for force, nothing for eco/awp).  This pass runs AFTER that (fired
  // by the roundStart event which fires after _botTeamBuy), and:
  //   - Full-buy: game.ts already set primary; we may swap to galil/famas on
  //     a budget, or to aug/sg553 for rich hard-difficulty bots.
  //   - Force-buy: game.ts left primary null; we pick from the SMG/shotgun pool.
  //   - Eco-buy:   occasionally buy a pistol upgrade or deagle.
  //   - AWP:       game.ts already bought AWP; we leave it untouched.
  //
  // AWP cap: game.ts already enforces max-1-AWP per team via its own pass.
  // We never add a second AWP here.
  // ---------------------------------------------------------------------------

  private _doBotTeamBuyPass(now: number): void {
    const game = this._game;
    const teams: Array<'CT' | 'T'> = ['CT', 'T'];

    for (const team of teams) {
      const teamBots = game.combatants.filter(c => !c.isPlayer && c.team === team && c.alive);
      if (teamBots.length === 0) continue;

      const teamAvgMoney = teamBots.reduce((s, c) => s + c.money, 0) / teamBots.length;

      for (const c of teamBots) {
        this._doBotBuyForCombatant(c, team, teamAvgMoney, now);
      }
    }
  }

  /**
   * Pick items for a single bot based on money and current inventory state.
   * Called after game.ts has already run its own buy pass for this round.
   */
  private _doBotBuyForCombatant(
    c: Combatant,
    team: 'CT' | 'T',
    _teamAvgMoney: number,
    now: number,
  ): void {
    const game = this._game;
    const money = c.money;

    // If the bot already holds an AWP, leave it completely alone — game.ts AWP
    // logic already equipped armor.  Do not buy additional items that could
    // waste the remaining money needed for next-round AWP.
    if (c.inventory.primary?.def.id === 'awp') return;

    // -----------------------------------------------------------------------
    // Case: bot has NO primary after game.ts pass (eco or force with no deagle).
    // This means game.ts chose eco (no primary bought) or force (deagle secondary,
    // no primary).  We may upgrade with an SMG/shotgun or pistol.
    // -----------------------------------------------------------------------
    const hasPrimary = c.inventory.primary !== null;

    if (!hasPrimary) {
      // Rich enough for force-tier SMG?
      const FORCE_BUDGET = 1400; // enough for any force SMG; vest added on top when live money still allows
      if (money >= FORCE_BUDGET) {
        // 20% chance of shotgun instead of SMG on force buys.
        const useShotgun = Math.random() < 0.20;
        const rawPool = useShotgun ? BUY_POOL_FORCE_SHOTGUN : BUY_POOL_FORCE_SMG;
        // Filter by team eligibility.
        const pool = rawPool.filter(id => {
          const def = WEAPONS[id];
          return def !== undefined && (def.teams === undefined || def.teams.includes(team));
        });
        if (pool.length > 0) {
          // Try in random order until one fits the budget.
          const shuffled = pool.slice().sort(() => Math.random() - 0.5);
          for (const id of shuffled) {
            const def = WEAPONS[id];
            if (def && money >= def.price) {
              game.buy(c, id, now);
              break;
            }
          }
        }
      } else if (money >= 250) {
        // Eco pistol upgrade: skip if bot starts with a decent pistol already
        // (usp $200 / glock $200 are start pistols — we only upgrade to something
        // meaningfully better).
        // Deagle requires $700 to be meaningful; cheaper pistols at $250+.
        const ecoPool = BUY_POOL_ECO_PISTOL.filter(id => {
          const def = WEAPONS[id];
          if (!def) return false;
          if (def.teams !== undefined && !def.teams.includes(team)) return false;
          if (money < def.price) return false;
          // Deagle only on $700+ eco (classic CS2 eco deagle).
          if (id === 'deagle') return money >= 700;
          return true;
        });
        if (ecoPool.length > 0) {
          // 60% chance to actually spend (sometimes just save).
          if (Math.random() < 0.60) {
            const id = ecoPool[Math.floor(Math.random() * ecoPool.length)]!;
            game.buy(c, id, now);
          }
        }
      }
      // Regardless of primary choice, buy vest if affordable and not already armored.
      if (c.armor === 0 && c.money >= ECONOMY.ARMOR_PRICE) {
        game.buy(c, 'armor', now);
      }
      return;
    }

    // -----------------------------------------------------------------------
    // Case: bot HAS a primary (game.ts full-buy gave ak47/m4a4).
    // We may swap to galil/famas (budget) or aug/sg553 (rich, hard difficulty).
    // Only replace if we can afford the upgrade while keeping armor.
    // -----------------------------------------------------------------------
    const primaryId = c.inventory.primary?.def.id ?? '';

    // Already has a non-standard primary from a previous pass (should not happen
    // in normal flow, but guard it).
    const standardIds = new Set(['ak47', 'm4a4']);
    if (!standardIds.has(primaryId)) return;

    const armorCost = c.armor > 0 ? 0 : ECONOMY.ARMOR_HELMET_PRICE;

    // Rich hard-bot upgrade: aug(CT)/sg553(T) at 25% chance.
    const richPool = BUY_POOL_FULL_PRIMARY_RICH.filter(id => {
      const def = WEAPONS[id];
      return def !== undefined && (def.teams === undefined || def.teams.includes(team));
    });
    const richId = richPool[0]; // one entry per team
    const richDef = richId !== undefined ? WEAPONS[richId] : undefined;
    if (
      this._game.difficulty === 'hard' &&
      richDef !== undefined &&
      richId !== undefined &&
      money >= richDef.price + armorCost &&
      Math.random() < 0.25
    ) {
      // Swap: use game.buy which replaces primary slot.
      game.buy(c, richId, now);
      return;
    }

    // Budget rifle swap: galil(T)/famas(CT) when bot got the standard rifle
    // but happens to have less money (edge case: game.ts gave ak47 even at
    // 2700, which leaves very little; famas/galil might already be cheaper
    // but game.ts already bought the standard — skip downgrade, only upgrade).
    // → We only upgrade, never downgrade.  This branch is a no-op for standard
    // rifles; included for future extensibility.
  }

  // ---------------------------------------------------------------------------
  // Round-start assignment
  // ---------------------------------------------------------------------------

  private _roundStart(br: BotBrain): void {
    br.state              = 'objective';
    br.target             = null;
    br.targetVisible      = false;
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
    br.wasBlind           = false;

    // F1: reset retriever on each round start.
    this._retrieverId = null;
    this._retrieverEngagedSince = -1;

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
      // F3: ignore positions inside the enemy team's spawn zone to avoid luring
      // bots into enemy spawn.  For a bot on team X, the "enemy spawn" is the
      // spawn of the opposite team (= victim.team, which equals the enemy of br.bot).
      const enemySpawn = br.bot.team === 'CT' ? this._tSpawnZone : this._ctSpawnZone;
      if (BotManager._inSpawnZone(victim.pos, enemySpawn)) continue;
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
      // F3: ignore positions inside the enemy team's spawn zone.
      const enemySpawn = br.bot.team === 'CT' ? this._tSpawnZone : this._ctSpawnZone;
      if (BotManager._inSpawnZone(shooter.pos, enemySpawn)) continue;
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

    // F1: sticky retriever management — run once per tick (the first live bot
    // that executes updates the shared state; subsequent bots within the same
    // game tick may see a stale _retrieverId but the worst-case latency is one
    // full tick = 1/128 s, which is negligible).
    if (game.phase === 'live' && game.bomb.state === 'dropped') {
      const aliveTs = this._game.combatants.filter(c => c.team === 'T' && c.alive && !c.hasBomb);
      if (aliveTs.length > 0) {
        // Check if current retriever is still valid.
        const currentRetriever = this._retrieverId !== null
          ? this._game.combatants.find(c => c.id === this._retrieverId && c.alive && c.team === 'T')
          : undefined;

        if (currentRetriever === undefined) {
          // No valid retriever — designate the closest living T bot.
          this._retrieverEngagedSince = -1;
          let closest: Combatant | null = null;
          let closestD = Infinity;
          for (const t of aliveTs) {
            const d = distanceSq(t.pos, game.bomb.pos);
            if (d < closestD) { closestD = d; closest = t; }
          }
          if (closest !== null) {
            this._retrieverId = closest.id;
            // Force a fresh path to the bomb for this bot.
            const retrieverBrain = this._brains.get(closest.id);
            if (retrieverBrain) {
              retrieverBrain.currentPath = [];
              retrieverBrain.pathIdx     = 0;
              retrieverBrain.lastReplanAt = -999;
            }
          }
        } else {
          // Retriever exists — track whether it is pinned in engage.
          const retrieverBrain = this._brains.get(currentRetriever.id);
          const isEngaging = retrieverBrain?.state === 'engage';
          if (isEngaging) {
            if (this._retrieverEngagedSince < 0) {
              // First tick entering engage — start the clock.
              this._retrieverEngagedSince = now;
            } else if (now - this._retrieverEngagedSince > 4) {
              // Pinned for > 4 s — try to re-designate to a non-engaging T.
              const freeTs = aliveTs.filter(
                c => c.id !== currentRetriever.id &&
                     this._brains.get(c.id)?.state !== 'engage',
              );
              if (freeTs.length > 0) {
                let closest: Combatant | null = null;
                let closestD = Infinity;
                for (const t of freeTs) {
                  const d = distanceSq(t.pos, game.bomb.pos);
                  if (d < closestD) { closestD = d; closest = t; }
                }
                if (closest !== null) {
                  this._retrieverId = closest.id;
                  this._retrieverEngagedSince = -1;
                  const newBrain = this._brains.get(closest.id);
                  if (newBrain) {
                    newBrain.currentPath = [];
                    newBrain.pathIdx     = 0;
                    newBrain.lastReplanAt = -999;
                  }
                }
              }
              // If no free bot exists, leave current retriever assigned and keep
              // the engaged-since clock running so we re-check every tick.
            }
          } else {
            // Retriever is not engaging — reset the clock.
            this._retrieverEngagedSince = -1;
          }
        }
      }
    } else if (game.bomb.state !== 'dropped') {
      // Bomb picked up or state changed — clear retriever.
      this._retrieverId = null;
      this._retrieverEngagedSince = -1;
    }

    const diff = BOT_DIFFICULTY[game.difficulty];

    // ----- Flash-blindness gate -----
    const blind          = now < (bot.blindUntil ?? 0);
    const blindIntensity = bot.blindIntensity ?? 0;
    const fullBlind      = blind && blindIntensity >= 0.6;

    // When a full-blind bot transitions back to sighted, reset firstSeenAt so
    // the reaction-time machinery fires a fresh "first contact" window.
    if (!blind && br.wasBlind) {
      // Only reset if there is still a visible target (recheck happens in
      // _perceive below). If the target is gone, perception will clear it.
      if (br.target !== null) {
        br.firstSeenAt = now;  // treat it like the first time we see this target
      }
    }
    br.wasBlind = blind;

    // Full-blind: drop any current target immediately and skip perception.
    if (fullBlind) {
      br.target        = null;
      br.targetVisible = false;
      br.targetVisibleAt = -1;
      // Transition out of engage (no visible target).
      if (br.state === 'engage') {
        br.state = br.lastKnownPos !== null ? 'hunt' : 'objective';
      }
    }

    // 1. Perception (staggered).
    if (!fullBlind && now >= br.nextPerceptAt) {
      br.nextPerceptAt = now + PERCEPTION_INTERVAL;
      this._perceive(br, now, diff);
    } else if (fullBlind && now >= br.nextPerceptAt) {
      // Advance the timer even when blinded so we don't spam checks on unblind.
      br.nextPerceptAt = now + PERCEPTION_INTERVAL;
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

    // 4b. F4: Bot-vs-bot separation — nudge velocity before movement to prevent
    // stacking. Only applies to living bots; never shoves mid-plant/defuse.
    const isPlanting  = br.state === 'plant' || br.state === 'defuse';
    if (!isPlanting) {
      for (const [otherId, otherBr] of this._brains) {
        if (otherId === bot.id) continue;
        const other = otherBr.bot;
        if (!other.alive) continue;
        const dx = bot.pos.x - other.pos.x;
        const dz = bot.pos.z - other.pos.z;
        const dSq = dx * dx + dz * dz;
        if (dSq < BOT_SEPARATION_DIST * BOT_SEPARATION_DIST && dSq > 0.0001) {
          const d = Math.sqrt(dSq);
          const overlap = BOT_SEPARATION_DIST - d;
          const scale   = (overlap / BOT_SEPARATION_DIST) * BOT_SEPARATION_IMPULSE;
          // Reuse pre-allocated work vec.
          this._sepWork.x = (dx / d) * scale;
          this._sepWork.y = 0;
          this._sepWork.z = (dz / d) * scale;
          bot.vel.x += this._sepWork.x;
          bot.vel.z += this._sepWork.z;
        }
      }
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
    this._aimAt(br, dt, now, diff, blind ? blindIntensity : 0);

    // 9. Weapon update.
    const weapInput = this._weaponInput(br, now, diff, fullBlind, blind ? blindIntensity : 0);
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

      // LOS: a sample is visible when geometry LOS passes AND it is not smoked.
      // The enemy is visible if EITHER sample survives both checks.
      const botEye = eyePos(bot);
      const eyeGeo   = world.lineOfSight(botEye, eyePos(c));
      const chestGeo = world.lineOfSight(botEye, chestPos(c));
      const eyeSmoked   = this._smokeQuery !== null && this._smokeQuery(botEye, eyePos(c));
      const chestSmoked = this._smokeQuery !== null && this._smokeQuery(botEye, chestPos(c));
      const eyeVisible   = eyeGeo   && !eyeSmoked;
      const chestVisible = chestGeo && !chestSmoked;
      if (!eyeVisible && !chestVisible) continue;

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
      br.targetVisible   = true;
      br.targetVisibleAt = now;
      br.lastKnownPos    = { ...nearest.pos };
      br.lastKnownAt     = now;

      if ((now - br.firstSeenAt) * 1000 >= rxMs) {
        if (br.state !== 'plant' && br.state !== 'defuse') {
          br.state = 'engage';
        }
      }
    } else {
      br.targetVisible = false;
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

    // F1: if this bot is the designated retriever and the bomb is dropped,
    // override the FSM to path toward the bomb regardless of current state
    // (except engage/plant/defuse which take priority).
    if (
      bot.team === 'T' &&
      game.bomb.state === 'dropped' &&
      this._retrieverId === bot.id &&
      br.state !== 'engage' && br.state !== 'plant' && br.state !== 'defuse'
    ) {
      const bombPos = game.bomb.pos;
      // If path is stale, re-request via _pathToward.
      this._pathToward(br, bombPos, now);
      const pathOk = br.currentPath.length > 0 && br.pathIdx < br.currentPath.length;
      if (!pathOk && br.currentPath.length === 0) {
        // Path failed — clear retriever so another bot can try.
        this._retrieverId = null;
      } else {
        this._followPath(br, intent);
        return;
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
          // F3: resume guard state anchored on the original guardPos so the bot
          // paths back to its post rather than jittering from its current position.
          if (br.guardPos !== null) {
            br.state       = 'guard';
            // Force a fresh path toward guardPos so _guard state picks it up.
            br.currentPath = [];
            br.pathIdx     = 0;
            br.lastReplanAt = -999;
          } else {
            br.state = 'objective';
          }
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
              // F2b: re-derive CT guard facing from the new jitter point toward
              // the entrance area this assignment originally used.
              if (bot.team === 'CT' && br.routeAreas.length > 0) {
                const entranceName = br.routeAreas[0];
                const entArea = map.areas.find((a: { name: string }) => a.name === entranceName);
                if (entArea && jitter) {
                  const ex = (entArea.min.x + entArea.max.x) / 2;
                  const ez = (entArea.min.z + entArea.max.z) / 2;
                  br.guardFacing = Math.atan2(-(ex - jitter.x), -(ez - jitter.z));
                }
              }
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

        // F5a: within close range of the carrier, stop pushing toward them so
        // bots don't bunch up (separation from F4 naturally spreads them).
        if (dToCarrier <= ESCORT_STOP_DIST) {
          // Already close enough — stand by, let separation nudge spread us.
          return;
        }

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
        // F2a: compute guard facing toward the CT spawn centroid so T guards
        // face the direction enemies approach from.
        if (bot.team === 'T') {
          const ctSpawns = map.spawns.ct;
          let ctCx = 0; let ctCz = 0;
          for (const sp of ctSpawns) { ctCx += sp.x; ctCz += sp.z; }
          const n = ctSpawns.length;
          if (n > 0) {
            ctCx /= n; ctCz /= n;
            br.guardFacing = Math.atan2(-(ctCx - targetPt.x), -(ctCz - targetPt.z));
          }
        }
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
    // Partial blind intensity (0 = not blind, 0..0.59 = partial, capped at 0.59 here).
    // Full-blind (>= 0.6) bots have no target so this method returns early anyway.
    partialBlindIntensity: number,
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

    // When target is occluded (no LOS this tick), hold aim on the frozen
    // last-known position and skip the jitter resample to avoid corner shake.
    if (!br.targetVisible && br.lastKnownPos !== null) {
      // Aim at chest height of last-known feet position (same offset as chestPos).
      const lkp  = br.lastKnownPos;
      const botEyeLkp = eyePos(bot);
      const dxLkp  = lkp.x - botEyeLkp.x;
      const dyLkp  = (lkp.y + 1.2) - botEyeLkp.y;  // +1.2 = chest offset from feet
      const dzLkp  = lkp.z - botEyeLkp.z;
      const horizLkp = Math.sqrt(dxLkp * dxLkp + dzLkp * dzLkp);
      const desYawLkp   = Math.atan2(-dxLkp, -dzLkp);
      const desPitchLkp = Math.atan2(dyLkp, horizLkp);
      const dyawLkp   = angleDiff(bot.yaw,   desYawLkp);
      const dpitchLkp = angleDiff(bot.pitch, desPitchLkp);
      bot.yaw   += clamp(dyawLkp,   -turnRate * dtFixed, turnRate * dtFixed);
      bot.pitch  = clamp(
        bot.pitch + clamp(dpitchLkp, -turnRate * dtFixed, turnRate * dtFixed),
        -Math.PI / 2 * 0.99,
         Math.PI / 2 * 0.99,
      );
      return;
    }

    // Resample aim error.
    if (now - br.aimErrorLastAt > AIM_ERROR_RESAMPLE) {
      br.aimErrorLastAt = now;
      let err = diff.aimErrorDeg;
      if (br.aimOnTargetSince >= 0 && now - br.aimOnTargetSince > AIM_LOCK_TIME) {
        err *= AIM_LOCK_SHRINK;
      }
      // Partial blind: scale aim error up by (1 + 3*intensity).
      if (partialBlindIntensity > 0) {
        err *= (1 + 3 * partialBlindIntensity);
      }
      br.aimErrorDeg = err;
    }

    // Target point.
    const aimPt  = br.aimHeadEngagement ? headPos(target) : chestPos(target);
    const errRad = randSpread(br.aimErrorDeg) * (Math.PI / 180);

    // Recoil compensation. Partial blind: halve recoil control.
    const punch     = getViewPunch(bot);
    const recoilControl = partialBlindIntensity > 0
      ? diff.recoilControl * 0.5
      : diff.recoilControl;
    const recoilAdj = punch.pitch * recoilControl;

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
    // fullBlind: suppress all firing; partialBlindIntensity > 0: bot may still fire.
    fullBlind: boolean,
    _partialBlindIntensity: number,
  ): { trigger: boolean; reloadPressed: boolean; scopePressed: boolean } {
    const bot  = br.bot;
    const game = this._game;

    // Full blind: do not fire at all (target already dropped before this call).
    if (fullBlind) {
      return { trigger: false, reloadPressed: false, scopePressed: false };
    }

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

    // LOS gate: never fire at an occluded target (no current-tick LOS).
    // The bot may still hold the corner (aim tracks lastKnownPos) but no shots.
    if (!br.targetVisible) {
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
      // F5b: if stuck while escorting, abandon escort permanently for this round
      // so the bot becomes an independent router and avoids the snap-stuck loop.
      if (br.escortTarget !== null) {
        br.escortTarget  = null;
        br.escortLastPos = null;
        // If the bot has a route objective, force it to re-engage it.
        if (br.routeAreas.length > 0) {
          br.state = 'objective';
        }
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
