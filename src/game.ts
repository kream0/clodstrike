import * as THREE from 'three';
import type { Combatant, Inventory, Vec3, Team, WeaponDef, WeaponState, SpawnPoint, MatchStats } from './types';
import { WEAPONS, ECONOMY, RULES, BOT_NAMES, BOT_DIFFICULTY, TEAM_COLORS, GRENADES } from './constants';
import { DUST2 } from './maps/dust2';
import type { MapData } from './types';
import type { World } from './world';
import { gameEvents } from './combat';
import { createCharacterMesh, updateCharacterMesh } from './characters';
import { resetAim, switchSlot } from './weapons';
import { GameRng, makeMatchSeed } from './rng';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GamePhase = 'menu' | 'freeze' | 'live' | 'planted' | 'roundEnd' | 'matchEnd';
export type Difficulty = 'easy' | 'normal' | 'hard';

// ---------------------------------------------------------------------------
// Bot buy strategy — pure, testable decision function
// ---------------------------------------------------------------------------

export type BuyStrategy = 'eco' | 'force' | 'full' | 'awp';

export interface BuyDecisionInput {
  money:         number;
  team:          Team;
  hasPrimary:    boolean;
  teamAvgMoney:  number;
  lossStreak:    number;
  /** 0..1 random roll — pass Math.random() at the call site; tests inject fixed values. */
  roll:          number;
  /** AWP team quota not yet consumed this round (max 1 AWP per team). */
  awpAllowed:    boolean;
}

/**
 * Decide the buy strategy for a single bot.
 *
 * Thresholds (tuned values):
 *   awp  : awpAllowed && !hasPrimary && money ≥ 5750 && roll < 0.35
 *   full : T money ≥ 3700 (ak47 2700 + armor 1000);  CT ≥ 3900 (m4a4 2900 + armor 1000)
 *   force: can't full-buy AND (lossStreak ≥ 2 OR teamAvgMoney ≥ 2000) AND money ≥ 1300
 *   eco  : otherwise
 */
export function decideBuyStrategy(inp: BuyDecisionInput): BuyStrategy {
  const { money, team, hasPrimary, awpAllowed, roll, lossStreak, teamAvgMoney } = inp;

  // AWP check: occasional; requires large budget (AWP 4750 + vest+helmet 1000 = 5750).
  // Requires !hasPrimary so a survivor already holding a weapon cannot claim the AWP slot.
  const AWP_BUDGET = 5750; // AWP 4750 + vest+helmet 1000
  if (awpAllowed && !hasPrimary && money >= AWP_BUDGET && roll < 0.35) {
    return 'awp';
  }

  // Full-buy check.
  const fullThreshold = team === 'T' ? 3700 : 3900;
  if (money >= fullThreshold) {
    return 'full';
  }

  // Force-buy check.
  if (money >= 1300 && (lossStreak >= 2 || teamAvgMoney >= 2000)) {
    return 'force';
  }

  return 'eco';
}

/**
 * Pick the round MVP from the combatants list using the following precedence:
 * 1. CT wins + defuser is present → defuser wins MVP.
 * 2. T wins + planter is present → planter wins MVP.
 * 3. Otherwise: winning-team combatant with the most round-kills;
 *    ties broken by lower id; if the top kill count is 0 → null.
 *
 * NOTE: defuser/planter snapshots are only set when those specific actions ended
 * the round — so no team-alignment check is needed here.
 */
export function pickRoundMvp(
  combatants: readonly Combatant[],
  roundKills: ReadonlyMap<number, number>,
  winner: Team,
  planter: Combatant | null,
  defuser: Combatant | null,
): Combatant | null {
  // Precedence 1: CT win with a defuser.
  if (winner === 'CT' && defuser !== null) return defuser;
  // Precedence 2: T win with a planter.
  if (winner === 'T' && planter !== null) return planter;
  // Precedence 3: most round-kills on the winning team.
  let best: Combatant | null = null;
  let bestKills = 0;
  for (const c of combatants) {
    if (c.team !== winner) continue;
    const k = roundKills.get(c.id) ?? 0;
    if (k > bestKills || (k === bestKills && best !== null && c.id < best.id)) {
      best = c;
      bestKills = k;
    }
  }
  return bestKills > 0 ? best : null;
}

export interface MatchOptions {
  playerTeam: Team;
  difficulty: Difficulty;
  botsPerTeam?: number; // default 4 teammates + 5 enemies (5v5 total)
  /** Map id from the registry (e.g. 'dust2', 'mirage'). Defaults to 'dust2'. */
  mapId?: string;
  /**
   * Master RNG seed for this match. When provided (e.g. by a replay system),
   * the simulation will be deterministic given identical inputs.
   * Omit to let the game derive a random seed from Math.random().
   */
  seed?: number;
}

interface BombState {
  state: 'carried' | 'dropped' | 'planted' | 'defused' | 'exploded';
  carrier: Combatant | null;
  pos: Vec3;
  site: 'A' | 'B' | null;
  plantProgress: number;  // 0..1, -1 when inactive
  defuseProgress: number; // 0..1, -1 when inactive
  planter: Combatant | null;
  defuser: Combatant | null;
  explodeAt: number; // game-time seconds, when planted
}

// ---------------------------------------------------------------------------
// Helpers (module-local)
// ---------------------------------------------------------------------------

// _nextId is no longer a module-level counter; bot IDs are managed per-match
// by Game._nextBotId, which resets to BOT_ID_BASE at each startMatch.
// This guarantees cross-match id determinism for a given masterSeed.

function makeWeaponState(def: WeaponDef): WeaponState {
  return {
    def,
    ammo: def.magSize,
    reserve: def.reserveAmmo,
    reloading: false,
    reloadEnd: 0,
    nextFire: 0,
    shotsFired: 0,
  };
}

function createCombatant(id: number, name: string, team: Team, isPlayer: boolean): Combatant {
  const knife     = makeWeaponState(WEAPONS.knife);
  const secondary = makeWeaponState(team === 'CT' ? WEAPONS.usp : WEAPONS.glock);

  const inventory: Inventory = {
    knife,
    secondary,
    primary: null,
    activeSlot: 'secondary',
  };

  return {
    id,
    name,
    team,
    isPlayer,
    pos:       { x: 0, y: 0, z: 0 },
    vel:       { x: 0, y: 0, z: 0 },
    yaw:       0,
    pitch:     0,
    health:    100,
    armor:     0,
    helmet:    false,
    alive:     true,
    crouching: false,
    walking:   false,
    onGround:  false,
    inventory,
    money:        ECONOMY.START_MONEY,
    kills:        0,
    deaths:       0,
    hasBomb:      false,
    hasDefuseKit: false,
    tagSlowUntil: 0,
  };
}

/** Refill all owned weapons' ammo to full. */
function refillAmmo(c: Combatant): void {
  c.inventory.knife.ammo    = 0;
  c.inventory.knife.reserve = 0;
  if (c.inventory.secondary) {
    c.inventory.secondary.ammo    = c.inventory.secondary.def.magSize;
    c.inventory.secondary.reserve = c.inventory.secondary.def.reserveAmmo;
    c.inventory.secondary.reloading = false;
  }
  if (c.inventory.primary) {
    c.inventory.primary.ammo    = c.inventory.primary.def.magSize;
    c.inventory.primary.reserve = c.inventory.primary.def.reserveAmmo;
    c.inventory.primary.reloading = false;
  }
}

/** Reset combatant to default loadout (called for dead players at round start). */
function resetLoadout(c: Combatant): void {
  c.inventory.primary   = null;
  c.inventory.secondary = makeWeaponState(c.team === 'CT' ? WEAPONS.usp : WEAPONS.glock);
  c.inventory.activeSlot = 'secondary';
  refillAmmo(c);
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

export class Game {
  // ----- Public state -----
  combatants: Combatant[] = []; // index 0 = player (after startMatch)
  player!: Combatant;
  phase: GamePhase = 'menu';
  roundNumber = 0;
  score: Record<Team, number> = { CT: 0, T: 0 };
  difficulty: Difficulty = 'normal';
  lossStreak: Record<Team, number> = { CT: 0, T: 0 };

  bomb: BombState = {
    state:         'carried',
    carrier:       null,
    pos:           { x: 0, y: 0, z: 0 },
    site:          null,
    plantProgress:  -1,
    defuseProgress: -1,
    planter:       null,
    defuser:       null,
    explodeAt:     Infinity,
  };

  /** AI hook map — intentionally empty this wave; next agent fills it. */
  botBrains: Map<number, (bot: Combatant, dt: number, now: number) => void> = new Map();

  // ----- Private -----
  private _world: World;
  private _map: MapData = DUST2;
  /** Per-match deterministic RNG. Created/replaced each startMatch call. */
  private _rng: GameRng = new GameRng(makeMatchSeed());
  /** Per-match bot ID counter — resets to BOT_ID_BASE at each startMatch. */
  private _nextBotId: number = 200;
  private _scene: THREE.Scene | null;
  private _botMeshes: Map<number, THREE.Group> = new Map();
  private _bombMesh:  THREE.Group | null = null;
  private _bombLight: THREE.PointLight | null = null;
  /** Bot id whose mesh should be hidden (player is first-person spectating it). null = no hidden bot. */
  private _spectateHiddenId: number | null = null;

  private _freezeStartAt  = 0;
  private _roundStartAt   = 0; // game-time when live began
  private _roundEndAt     = 0; // game-time when roundEnd began
  private _roundWinner: Team | null = null;
  private _roundReason = '';
  private _opts: MatchOptions | null = null;
  private _bombPlanted    = false; // track if bomb was planted this round (for T team bonus)

  // ----- Match stats -----
  // Per-combatant cumulative stats. Keys are Combatant.id.
  // NOTE: the gameEvents bus is module-global. Tests construct multiple Game
  // instances, so these handlers must only mutate THIS instance's own maps and
  // must never throw for combatants not in this.combatants (statsFor is lazy).
  private _stats: Map<number, MatchStats> = new Map();
  private _roundKills: Map<number, number> = new Map();
  private _roundPlanter: Combatant | null = null;
  private _roundDefuser: Combatant | null = null;

  // Beep scheduling
  private _lastBeepAt = 0;

  // Unsubscribe handles for the gameEvents listeners attached in the constructor.
  // Stored so dispose() can cleanly detach them (used by tests / future
  // multi-instance callers — production main.ts holds one Game for the app
  // lifetime and never needs to call dispose()).
  private _unsubKill:   (() => void) | null = null;
  private _unsubDamage: (() => void) | null = null;

  constructor(world: World, scene: THREE.Scene | null = null) {
    this._world = world;
    this._scene = scene;

    // Subscribe to combat events for stat accumulation.
    // These handlers only mutate this instance's own maps; they are safe in
    // multi-Game test environments because statsFor() creates entries lazily.
    this._unsubKill = gameEvents.on('kill', (ev) => {
      const attacker = ev.attacker;
      if (attacker === null || attacker.id === ev.victim.id) return;
      const prev = this._roundKills.get(attacker.id) ?? 0;
      this._roundKills.set(attacker.id, prev + 1);
      if (ev.headshot) {
        this.statsFor(attacker).headshotKills++;
      }
    });

    this._unsubDamage = gameEvents.on('damage', (ev) => {
      const attacker = ev.attacker;
      if (attacker === null || attacker.id === ev.victim.id) return;
      this.statsFor(attacker).damageDealt += ev.amount;
    });
  }

  /** Expose the per-match RNG for consumers (BotManager, main.ts weapon call). */
  get rng(): GameRng {
    return this._rng;
  }

  /**
   * Detach this instance from the module-global gameEvents bus.
   *
   * Call this when the Game instance is no longer needed (e.g., in tests after
   * each case) so listeners do not accumulate across instances.
   *
   * NOT called from startMatch()/restart(): a restarted match reuses the same
   * instance and its constructor-attached listeners — auto-disposing on restart
   * would strip them and silently break post-restart stat accumulation.
   * Production main.ts creates exactly one Game and never needs to call this.
   */
  dispose(): void {
    if (this._unsubKill !== null) {
      this._unsubKill();
      this._unsubKill = null;
    }
    if (this._unsubDamage !== null) {
      this._unsubDamage();
      this._unsubDamage = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Map / world swap (called by main.ts before startMatch on map change)
  // ---------------------------------------------------------------------------

  /** Replace the World used for floor lookups and movement collision. */
  setWorld(world: World): void {
    this._world = world;
  }

  /** Replace the MapData used for spawn positions and bombsite checks. */
  setMap(map: MapData): void {
    this._map = map;
  }

  // ---------------------------------------------------------------------------
  // Stats public API
  // ---------------------------------------------------------------------------

  /** Return the MatchStats for a combatant, creating a zero entry if needed. */
  statsFor(c: Combatant): MatchStats {
    let s = this._stats.get(c.id);
    if (s === undefined) {
      s = { headshotKills: 0, damageDealt: 0, moneySpent: 0, mvps: 0 };
      this._stats.set(c.id, s);
    }
    return s;
  }

  /** Deduct money from a combatant and track the spend in match stats. */
  private _spend(c: Combatant, amount: number): void {
    c.money -= amount;
    this.statsFor(c).moneySpent += amount;
  }

  // ---------------------------------------------------------------------------
  // startMatch
  // ---------------------------------------------------------------------------

  startMatch(opts: MatchOptions, now = 0): void {
    this._opts = opts;
    this.difficulty = opts.difficulty;
    const botsPerTeam = opts.botsPerTeam ?? 4;

    // Initialise per-match deterministic RNG.
    this._rng = new GameRng(opts.seed ?? makeMatchSeed());

    // Reset bot ID counter so IDs are deterministic per match.
    // Player always gets id 0; bots start at 200 (BOT_ID_BASE).
    this._nextBotId = 200;

    // Reset global state.
    this.score       = { CT: 0, T: 0 };
    this.lossStreak  = { CT: 0, T: 0 };
    this.roundNumber = 0;
    this._spectateHiddenId = null;

    // Clear match stats — fresh match, fresh slate.
    this._stats.clear();
    this._roundKills.clear();
    this._roundPlanter = null;
    this._roundDefuser = null;

    // Clear old bot meshes from scene.
    for (const [, mesh] of this._botMeshes) {
      this._scene?.remove(mesh);
    }
    this._botMeshes.clear();
    this._removeBombMesh();

    // Build roster.
    // Player is index 0; bots fill the rest.
    const playerTeam  = opts.playerTeam;
    const enemyTeam: Team = playerTeam === 'CT' ? 'T' : 'CT';

    // Player combatant — caller (main.ts) owns the actual Combatant object
    // that already exists. We trust game.player has been set before startMatch OR
    // we create one here and main.ts replaces it.
    // To keep it clean: if a player combatant already exists (player field set),
    // reset it; otherwise create one with id=0.
    if (!this.player) {
      this.player = createCombatant(0, 'Player', playerTeam, true);
    } else {
      this.player.team          = playerTeam;
      this.player.kills         = 0;
      this.player.deaths        = 0;
      this.player.grenades      = { he: 0, flash: 0, smoke: 0 };
      this.player.equippedGrenade = null;
      this.player.blindUntil    = 0;
      this.player.blindIntensity = 0;
    }

    // Assign starting money.
    this.player.money = ECONOMY.START_MONEY;

    // Bot names pool — shuffle copy (round stream for determinism).
    const namePool = [...BOT_NAMES];
    this._rng.round.shuffle(namePool);
    let nameIdx = 0;

    this.combatants = [this.player];

    // Create player-team bots.
    for (let i = 0; i < botsPerTeam; i++) {
      const bot = createCombatant(this._nextBotId++, namePool[nameIdx++ % namePool.length], playerTeam, false);
      this.combatants.push(bot);
      if (this._scene) {
        const mesh = createCharacterMesh(playerTeam);
        this._botMeshes.set(bot.id, mesh);
        this._scene.add(mesh);
      }
    }

    // Create enemy bots (one extra to match 5v5 when botsPerTeam=4).
    const enemyCount = botsPerTeam + 1;
    for (let i = 0; i < enemyCount; i++) {
      const bot = createCombatant(this._nextBotId++, namePool[nameIdx++ % namePool.length], enemyTeam, false);
      this.combatants.push(bot);
      if (this._scene) {
        const mesh = createCharacterMesh(enemyTeam);
        this._botMeshes.set(bot.id, mesh);
        this._scene.add(mesh);
      }
    }

    this._startRound(now);
  }

  // ---------------------------------------------------------------------------
  // _startRound
  // ---------------------------------------------------------------------------

  private _startRound(now = 0): void {
    this.roundNumber++;
    this.phase         = 'freeze';
    this._bombPlanted  = false;
    this._lastBeepAt   = 0;
    this._roundKills.clear();
    this._roundPlanter = null;
    this._roundDefuser = null;
    this._spectateHiddenId = null;

    this._freezeStartAt = now;
    this._roundStartAt  = 0;

    // Teleport everyone to spawns, reset health/vel/alive.
    const ctSpawns = [...this._map.spawns.ct];
    const tSpawns  = [...this._map.spawns.t];
    let ctIdx = 0;
    let tIdx  = 0;

    for (const c of this.combatants) {
      // If dead last round: reset loadout.
      if (!c.alive) {
        resetLoadout(c);
        c.armor   = 0;
        c.helmet  = false;
        c.hasDefuseKit = false;
        // Dead combatants lose their grenades (CS semantics: no carry-over).
        c.grenades = { he: 0, flash: 0, smoke: 0 };
      } else {
        // Survivors keep weapons but refill ammo. Grenade counts carry over.
        refillAmmo(c);
      }

      // Restore health, vel, alive.
      c.health    = 100;
      c.alive     = true;
      c.vel       = { x: 0, y: 0, z: 0 };
      c.crouching = false;
      c.walking   = false;
      c.hasBomb   = false;

      // Clear blind state each round.
      c.blindUntil     = 0;
      c.blindIntensity = 0;
      c.equippedGrenade = null;

      // Assign spawn.
      let sp: SpawnPoint;
      if (c.team === 'CT') {
        sp = ctSpawns[ctIdx % ctSpawns.length];
        ctIdx++;
      } else {
        sp = tSpawns[tIdx % tSpawns.length];
        tIdx++;
      }

      const floorY = this._world.floorAt(sp.x, sp.z);
      c.pos = { x: sp.x, y: isFinite(floorY) ? floorY : 0, z: sp.z };
      c.yaw = sp.angle;
      resetAim(c);

      // Switch to best available weapon.
      if (c.inventory.primary) {
        switchSlot(c, 'primary', now);
      } else if (c.inventory.secondary) {
        switchSlot(c, 'secondary', now);
      }
    }

    // Assign bomb to a random T (round stream for determinism).
    const ts = this.combatants.filter(c => c.team === 'T' && c.alive);
    if (ts.length > 0) {
      const bomber = this._rng.round.pick(ts);
      bomber.hasBomb = true;
      this.bomb = {
        state:         'carried',
        carrier:       bomber,
        pos:           { ...bomber.pos },
        site:          null,
        plantProgress:  -1,
        defuseProgress: -1,
        planter:       null,
        defuser:       null,
        explodeAt:     Infinity,
      };
    }

    // Bot auto-buy (round 2+; round 1 has only 800 start money).
    if (this.roundNumber > 1) {
      this._botTeamBuy(now);
    }

    gameEvents.emit('roundStart', { roundNumber: this.roundNumber });
  }

  // ---------------------------------------------------------------------------
  // _botTeamBuy — economy-aware team buy pass (round 2+)
  // ---------------------------------------------------------------------------

  private _botTeamBuy(now: number): void {
    const teams: Team[] = ['CT', 'T'];

    for (const team of teams) {
      const teamBots = this.combatants.filter(c => !c.isPlayer && c.team === team);
      if (teamBots.length === 0) continue;

      const teamAvgMoney =
        teamBots.reduce((sum, c) => sum + c.money, 0) / teamBots.length;
      const streak = this.lossStreak[team];

      // One AWP allowed per team per round.
      let awpAllowed = true;

      for (const c of teamBots) {
        const hasPrimary = c.inventory.primary !== null;
        const strategy = decideBuyStrategy({
          money:        c.money,
          team:         c.team,
          hasPrimary,
          teamAvgMoney,
          lossStreak:   streak,
          roll:         this._rng.round.next(),
          awpAllowed,
        });

        // Consume the AWP slot as soon as one bot takes it.
        if (strategy === 'awp') awpAllowed = false;

        this._executeBotBuy(c, strategy, now);
      }
    }
  }

  /** Apply purchases for the given strategy onto a single bot. */
  private _executeBotBuy(c: Combatant, strategy: BuyStrategy, now: number): void {
    switch (strategy) {
      case 'awp': {
        // Buy AWP.
        const awp = WEAPONS['awp'];
        if (awp && !c.inventory.primary && c.money >= awp.price) {
          c.inventory.primary = makeWeaponState(awp);
          this._spend(c, awp.price);
          switchSlot(c, 'primary', now);
        }
        // Armor: vest+helmet if affordable, else vest.
        if (c.armor === 0) {
          if (c.money >= ECONOMY.ARMOR_HELMET_PRICE) {
            this._spend(c, ECONOMY.ARMOR_HELMET_PRICE);
            c.armor  = 100;
            c.helmet = true;
          } else if (c.money >= ECONOMY.ARMOR_PRICE) {
            this._spend(c, ECONOMY.ARMOR_PRICE);
            c.armor  = 100;
          }
        }
        // CT kit on leftover.
        if (c.team === 'CT' && !c.hasDefuseKit && c.money >= ECONOMY.DEFUSE_KIT_PRICE) {
          c.hasDefuseKit = true;
          this._spend(c, ECONOMY.DEFUSE_KIT_PRICE);
        }
        break;
      }

      case 'full': {
        // Armor + helmet first.
        if (c.armor === 0 && c.money >= ECONOMY.ARMOR_HELMET_PRICE) {
          this._spend(c, ECONOMY.ARMOR_HELMET_PRICE);
          c.armor  = 100;
          c.helmet = true;
        }
        // Team rifle.
        const rifleId = c.team === 'T' ? 'ak47' : 'm4a4';
        const rifle   = WEAPONS[rifleId];
        if (rifle && !c.inventory.primary && c.money >= rifle.price) {
          c.inventory.primary = makeWeaponState(rifle);
          this._spend(c, rifle.price);
          switchSlot(c, 'primary', now);
        }
        // CT kit.
        if (c.team === 'CT' && !c.hasDefuseKit && c.money >= ECONOMY.DEFUSE_KIT_PRICE) {
          c.hasDefuseKit = true;
          this._spend(c, ECONOMY.DEFUSE_KIT_PRICE);
        }
        break;
      }

      case 'force': {
        // Vest (no helmet on force).
        if (c.armor === 0 && c.money >= ECONOMY.ARMOR_PRICE) {
          this._spend(c, ECONOMY.ARMOR_PRICE);
          c.armor  = 100;
        }
        // Deagle if no primary and affordable.
        if (!c.inventory.primary && c.money >= WEAPONS.deagle.price) {
          c.inventory.secondary = makeWeaponState(WEAPONS.deagle);
          this._spend(c, WEAPONS.deagle.price);
        }
        // CT kit only if well-funded leftovers.
        if (c.team === 'CT' && !c.hasDefuseKit && c.money >= 1000) {
          c.hasDefuseKit = true;
          this._spend(c, ECONOMY.DEFUSE_KIT_PRICE);
        }
        break;
      }

      case 'eco':
        // Buy nothing — save for next round.
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // update — phase state machine
  // ---------------------------------------------------------------------------

  update(dt: number, now: number): void {
    if (this.phase === 'menu' || this.phase === 'matchEnd') return;

    // Sync bomb position to carrier so radar always shows correct location.
    if (this.bomb.state === 'carried' && this.bomb.carrier !== null) {
      this.bomb.pos = { ...this.bomb.carrier.pos };
    }

    // ----- Freeze → Live -----
    if (this.phase === 'freeze') {
      if (now - this._freezeStartAt >= RULES.FREEZE_TIME) {
        this.phase         = 'live';
        this._roundStartAt = now;
      }
      return;
    }

    // ----- Live -----
    if (this.phase === 'live') {
      this._runBotBrains(dt, now);
      this._checkBombPickup(now);

      const timeLeft = this.roundTimeLeft(now);

      // Win checks.
      const aliveCTs = this.combatants.filter(c => c.team === 'CT' && c.alive);
      const aliveTs  = this.combatants.filter(c => c.team === 'T'  && c.alive);

      if (aliveTs.length === 0) {
        this._endRound('CT', 'Elimination', now);
        return;
      }
      if (aliveCTs.length === 0) {
        this._endRound('T', 'Elimination', now);
        return;
      }
      if (timeLeft <= 0) {
        this._endRound('CT', 'Time', now);
        return;
      }
      return;
    }

    // ----- Planted -----
    if (this.phase === 'planted') {
      this._runBotBrains(dt, now);
      this._checkBombPickup(now);

      const aliveCTs = this.combatants.filter(c => c.team === 'CT' && c.alive);
      const aliveTs  = this.combatants.filter(c => c.team === 'T'  && c.alive);

      // All CTs dead → T win immediately even when planted.
      if (aliveCTs.length === 0) {
        this._endRound('T', 'Elimination', now);
        return;
      }
      // All Ts dead AND not yet exploded → CT win (defused by attrition).
      if (aliveTs.length === 0) {
        this._triggerDefuse(now);
        return;
      }

      // Bomb timer.
      if (now >= this.bomb.explodeAt) {
        this._triggerExplosion(now);
        return;
      }
      return;
    }

    // ----- RoundEnd pause -----
    if (this.phase === 'roundEnd') {
      if (now - this._roundEndAt >= RULES.ROUND_END_PAUSE) {
        this._startNextRoundOrMatchEnd(now);
      }
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Bot brains hook
  // ---------------------------------------------------------------------------

  private _runBotBrains(dt: number, now: number): void {
    for (const c of this.combatants) {
      if (c.isPlayer || !c.alive) continue;
      const brain = this.botBrains.get(c.id);
      if (brain) brain(c, dt, now);
      // Placeholder bots: stationary. No movement or firing.
    }
  }

  // ---------------------------------------------------------------------------
  // Bomb pickup auto-collect
  // ---------------------------------------------------------------------------

  private _checkBombPickup(now: number): void {
    if (this.bomb.state !== 'dropped') return;
    for (const c of this.combatants) {
      if (c.team !== 'T' || !c.alive) continue;
      const dx = c.pos.x - this.bomb.pos.x;
      const dz = c.pos.z - this.bomb.pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 1.2) {
        this.bomb.state   = 'carried';
        this.bomb.carrier = c;
        c.hasBomb         = true;
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // useHeld — E key
  // ---------------------------------------------------------------------------

  useHeld(c: Combatant, held: boolean, now: number, dt: number): void {
    if (!held) {
      // Release: cancel in-progress plant/defuse.
      if (this.bomb.state === 'carried' && this.bomb.plantProgress >= 0 && this.bomb.planter === c) {
        this.bomb.plantProgress = -1;
        this.bomb.planter       = null;
      }
      if (this.bomb.state === 'planted' && this.bomb.defuseProgress >= 0 && this.bomb.defuser === c) {
        this.bomb.defuseProgress = 0; // CS: reset to 0 on release
        this.bomb.defuser        = null;
      }
      return;
    }

    // Bomb pickup (T walks near dropped bomb).
    if (c.team === 'T' && this.bomb.state === 'dropped') {
      const dx   = c.pos.x - this.bomb.pos.x;
      const dz   = c.pos.z - this.bomb.pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 1.5) {
        this.bomb.state   = 'carried';
        this.bomb.carrier = c;
        c.hasBomb         = true;
      }
    }

    // Plant: T with bomb, inside bombsite, on ground.
    if (
      c.team === 'T' &&
      c.hasBomb &&
      c.onGround &&
      (this.phase === 'live' || this.phase === 'freeze') &&
      this.bomb.state === 'carried'
    ) {
      const site = this._getActiveSite(c.pos);
      if (site !== null) {
        if (this.bomb.planter !== c) {
          this.bomb.planter       = c;
          this.bomb.plantProgress = 0;
        }
        this.bomb.plantProgress += dt / RULES.PLANT_TIME;
        if (this.bomb.plantProgress >= 1) {
          this._triggerPlant(c, site, now);
        }
        return;
      }
    }

    // Defuse: CT near planted bomb.
    if (
      c.team === 'CT' &&
      c.alive &&
      this.bomb.state === 'planted' &&
      this.phase === 'planted'
    ) {
      const dx   = c.pos.x - this.bomb.pos.x;
      const dy   = c.pos.y - this.bomb.pos.y;
      const dz   = c.pos.z - this.bomb.pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 1.4) {
        if (this.bomb.defuser !== c) {
          this.bomb.defuser        = c;
          this.bomb.defuseProgress = 0;
        }
        const defuseTime = c.hasDefuseKit ? RULES.DEFUSE_TIME_KIT : RULES.DEFUSE_TIME;
        this.bomb.defuseProgress += dt / defuseTime;
        if (this.bomb.defuseProgress >= 1) {
          this._triggerDefuse(now);
        }
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // buy
  // ---------------------------------------------------------------------------

  buy(c: Combatant, itemId: string, now: number): boolean {
    if (!this.canBuy(now)) return false;
    if (!c.alive) return false;

    if (itemId === 'armor') {
      const price = ECONOMY.ARMOR_PRICE;
      if (c.money < price) return false;
      this._spend(c, price);
      c.armor  = 100;
      return true;
    }

    if (itemId === 'armorHelmet') {
      // If player already has vest (armor > 0) but no helmet, only charge upgrade price.
      if (c.armor > 0 && !c.helmet) {
        const price = ECONOMY.ARMOR_UPGRADE_PRICE;
        if (c.money < price) return false;
        this._spend(c, price);
        c.armor  = 100;
        c.helmet = true;
        return true;
      }
      const price = ECONOMY.ARMOR_HELMET_PRICE;
      if (c.money < price) return false;
      this._spend(c, price);
      c.armor  = 100;
      c.helmet = true;
      return true;
    }

    if (itemId === 'kit') {
      if (c.team !== 'CT') return false;
      const price = ECONOMY.DEFUSE_KIT_PRICE;
      if (c.money < price) return false;
      this._spend(c, price);
      c.hasDefuseKit = true;
      return true;
    }

    // Grenades.
    if (itemId === 'he' || itemId === 'flash' || itemId === 'smoke') {
      const grenDef = GRENADES[itemId];
      if (c.money < grenDef.price) return false;
      const carried = c.grenades?.[itemId] ?? 0;
      if (carried >= grenDef.maxCarry) return false;
      if (c.grenades === undefined) {
        c.grenades = { he: 0, flash: 0, smoke: 0 };
      }
      c.grenades[itemId] = carried + 1;
      this._spend(c, grenDef.price);
      return true;
    }

    // Weapon.
    const def = WEAPONS[itemId];
    if (!def) return false;
    if (def.teams && !def.teams.includes(c.team)) return false;
    if (c.money < def.price) return false;

    this._spend(c, def.price);
    const ws = makeWeaponState(def);

    if (def.slot === 'primary') {
      c.inventory.primary = ws;
      switchSlot(c, 'primary', now);
    } else if (def.slot === 'secondary') {
      c.inventory.secondary = ws;
      switchSlot(c, 'secondary', now);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // applyExplosionDamage — shared by HE grenade and bomb explosion
  // ---------------------------------------------------------------------------

  /**
   * Apply pre-computed explosion damage to a victim.
   * Handles health clamp, death detection, kill credit,
   * kill reward, and killfeed + damage event emission.
   * Called by grenades.ts onExplosionDamage callback AND by _triggerExplosion.
   *
   * @param applyArmor - true for HE grenade (armor absorbs damage);
   *                     false for bomb (raw health damage, no armor absorption).
   */
  applyExplosionDamage(
    victim: Combatant,
    damage: number,
    thrower: Combatant | null,
    weaponId: string,
    applyArmor = true,
  ): void {
    if (!victim.alive || damage <= 0) return;

    // Armor absorption: armor takes a share of the damage (HE only, not bomb).
    let remainingDmg = damage;
    if (applyArmor && victim.armor > 0) {
      const absorbed = Math.min(victim.armor, remainingDmg * (1 - RULES.ARMOR_DAMAGE_MULT));
      victim.armor   = Math.max(0, victim.armor - absorbed);
      remainingDmg   = Math.round(remainingDmg * RULES.ARMOR_DAMAGE_MULT);
    }

    victim.health = Math.max(0, victim.health - remainingDmg);

    gameEvents.emit('damage', {
      attacker: thrower,
      victim,
      amount:   remainingDmg,
      hitGroup: 'body',
    });

    if (victim.health <= 0) {
      victim.health = 0;
      victim.alive  = false;
      victim.deaths++;

      // Kill credit to thrower (but not self-kills).
      if (thrower !== null && thrower !== victim) {
        thrower.kills++;
        thrower.money = Math.min(
          ECONOMY.MAX_MONEY,
          thrower.money + (WEAPONS[weaponId]?.killReward ?? 300),
        );
      }

      gameEvents.emit('kill', {
        attacker: thrower,
        victim,
        weaponId,
        headshot: false,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // canBuy
  // ---------------------------------------------------------------------------

  canBuy(now: number): boolean {
    if (this.phase === 'freeze') return true;
    if (this.phase === 'live' || this.phase === 'planted') {
      // Buy window extends RULES.BUY_TIME seconds from when the freeze phase began,
      // so players can still buy for the first (BUY_TIME - FREEZE_TIME) seconds of live.
      return now < this._freezeStartAt + RULES.BUY_TIME;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Time helpers
  // ---------------------------------------------------------------------------

  roundTimeLeft(now: number): number {
    if (this.phase !== 'live') return 0;
    return Math.max(0, RULES.ROUND_TIME - (now - this._roundStartAt));
  }

  /** Seconds remaining in the buy window (0 once expired or in a non-buyable phase). */
  buyTimeLeft(now: number): number {
    if (this.phase === 'freeze' || this.phase === 'live' || this.phase === 'planted') {
      return Math.max(0, this._freezeStartAt + RULES.BUY_TIME - now);
    }
    return 0;
  }

  bombTimeLeft(now: number): number {
    if (this.bomb.state !== 'planted') return 0;
    return Math.max(0, this.bomb.explodeAt - now);
  }

  freezeTimeLeft(now: number): number {
    if (this.phase !== 'freeze') return 0;
    return Math.max(0, RULES.FREEZE_TIME - (now - this._freezeStartAt));
  }

  // ---------------------------------------------------------------------------
  // updateVisuals — called at render rate by main.ts
  // ---------------------------------------------------------------------------

  updateVisuals(frameDt: number, now: number = performance.now() / 1000): void {
    for (const c of this.combatants) {
      if (c.isPlayer) continue;
      const mesh = this._botMeshes.get(c.id);
      if (mesh) {
        updateCharacterMesh(mesh, c, frameDt, now);
        // Hide the spectated bot's mesh while player is viewing from inside its head.
        mesh.visible = c.id !== this._spectateHiddenId;
      }
    }

    // Bomb mesh management.
    if (this.bomb.state === 'planted' || this.bomb.state === 'dropped') {
      this._ensureBombMesh();
      if (this._bombMesh) {
        this._bombMesh.position.set(this.bomb.pos.x, this.bomb.pos.y + 0.15, this.bomb.pos.z);
        this._bombMesh.visible = true;
      }
      // Blink light.
      if (this._bombLight && this.bomb.state === 'planted') {
        const blink = Math.sin(performance.now() / 80) > 0;
        this._bombLight.intensity = blink ? 2 : 0;
      }
    } else {
      if (this._bombMesh) this._bombMesh.visible = false;
    }
  }

  // ---------------------------------------------------------------------------
  // restart
  // ---------------------------------------------------------------------------

  restart(opts?: MatchOptions, now = 0): void {
    if (!opts && !this._opts) {
      // Full reset to menu.
      this.phase = 'menu';
      for (const [, mesh] of this._botMeshes) {
        this._scene?.remove(mesh);
      }
      this._botMeshes.clear();
      this._removeBombMesh();
      this.combatants = [];
      return;
    }
    const o = opts ?? this._opts!;
    this._opts = o;
    this.startMatch(o, now);
  }

  // ---------------------------------------------------------------------------
  // onPlayerDied — called by main.ts
  // ---------------------------------------------------------------------------

  onPlayerDied(): void {
    // Drop bomb if player was carrying it.
    if (this.player.hasBomb && this.bomb.state === 'carried') {
      this._dropBomb(this.player);
    }
  }

  /**
   * Set which bot id (if any) should have its mesh hidden because the player is
   * first-person spectating it. Pass null to restore all bot meshes to normal.
   * The actual visibility is applied inside updateVisuals each frame.
   */
  setSpectateHiddenBot(id: number | null): void {
    this._spectateHiddenId = id;
  }

  // ---------------------------------------------------------------------------
  // Internal: plant / defuse / explode / round end
  // ---------------------------------------------------------------------------

  private _getActiveSite(pos: Vec3): 'A' | 'B' | null {
    for (const site of this._map.bombsites) {
      if (
        pos.x >= site.min.x && pos.x <= site.max.x &&
        pos.z >= site.min.z && pos.z <= site.max.z
      ) {
        return site.name;
      }
    }
    return null;
  }

  private _triggerPlant(c: Combatant, site: 'A' | 'B', now: number): void {
    c.hasBomb            = false;
    this.bomb.state       = 'planted';
    this.bomb.carrier     = null;
    this.bomb.planter     = c;
    this.bomb.site        = site;
    this.bomb.pos         = { ...c.pos };
    this.bomb.plantProgress  = 1;
    this.bomb.defuseProgress = 0;
    this.bomb.explodeAt   = now + RULES.BOMB_TIME;
    this._bombPlanted     = true;
    this.phase            = 'planted';
    this._lastBeepAt      = now;

    c.money = Math.min(ECONOMY.MAX_MONEY, c.money + ECONOMY.PLANT_BONUS_PLANTER);

    this._roundPlanter = c; // snapshot for MVP calculation
    this._ensureBombMesh();
    gameEvents.emit('bombPlanted', { site, pos: { ...this.bomb.pos } });
  }

  private _triggerDefuse(now: number): void {
    this.bomb.state          = 'defused';
    this.bomb.defuseProgress = 1;
    this._roundDefuser = this.bomb.defuser; // snapshot for MVP calculation
    gameEvents.emit('bombDefused', {});
    this._endRound('CT', 'Bomb defused', now);
  }

  private _triggerExplosion(now: number): void {
    this.bomb.state = 'exploded';
    gameEvents.emit('bombExploded', {});

    // Radial damage — delegate to applyExplosionDamage for consistent armor/kill logic.
    const center = this.bomb.pos;
    const BLAST_RADIUS = 25;
    for (const c of this.combatants) {
      if (!c.alive) continue;
      const dx   = c.pos.x - center.x;
      const dy   = c.pos.y - center.y;
      const dz   = c.pos.z - center.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < BLAST_RADIUS) {
        const dmg = Math.round(500 * Math.pow(1 - dist / BLAST_RADIUS, 1.6));
        if (dmg <= 0) continue;
        this.applyExplosionDamage(c, dmg, null, 'bomb', false);
      }
    }

    this._endRound('T', 'Target bombed', now);
  }

  private _dropBomb(c: Combatant): void {
    c.hasBomb         = false;
    this.bomb.state   = 'dropped';
    this.bomb.carrier = null;
    this.bomb.pos     = { ...c.pos };
  }

  private _endRound(winner: Team, reason: string, now: number): void {
    if (this.phase === 'roundEnd') return; // guard double-trigger
    this.phase         = 'roundEnd';
    this._roundEndAt   = now;
    this._roundWinner  = winner;
    this._roundReason  = reason;

    // Update score.
    this.score[winner]++;

    // Award MVP for this round.
    const mvp = pickRoundMvp(
      this.combatants,
      this._roundKills,
      winner,
      this._roundPlanter,
      this._roundDefuser,
    );
    if (mvp !== null) {
      this.statsFor(mvp).mvps++;
    }

    // Economy.
    const loser: Team = winner === 'CT' ? 'T' : 'CT';

    // Win streak reset, loss streak increment.
    this.lossStreak[winner] = 0;
    this.lossStreak[loser]  = Math.min(this.lossStreak[loser] + 1, 4);

    const winBonus  = ECONOMY.WIN_REWARD;
    const lossBonus = ECONOMY.LOSS_BONUS[this.lossStreak[loser] - 1] ?? ECONOMY.LOSS_BONUS[0];

    // Plant bonus for T losers: if bomb was planted.
    const tPlantBonus = (this._bombPlanted && winner === 'CT') ? ECONOMY.PLANT_BONUS_TEAM : 0;

    for (const c of this.combatants) {
      if (c.team === winner) {
        c.money = Math.min(ECONOMY.MAX_MONEY, c.money + winBonus);
      } else {
        c.money = Math.min(ECONOMY.MAX_MONEY, c.money + lossBonus + tPlantBonus);
      }
    }

    gameEvents.emit('roundEnd', { winner, reason });
  }

  private _startNextRoundOrMatchEnd(now: number): void {
    const winner = this._roundWinner;
    // No halftime side-swap — note: in real CS2 sides swap at round 13 (halftime).
    // This implementation skips that for simplicity.
    if (
      winner !== null &&
      this.score[winner] >= RULES.ROUNDS_TO_WIN
    ) {
      this.phase = 'matchEnd';
      gameEvents.emit('matchEnd', { winner });
      return;
    }
    if (this.roundNumber >= RULES.MAX_ROUNDS) {
      // Determine winner by score.
      const w: Team = this.score.CT >= this.score.T ? 'CT' : 'T';
      this.phase = 'matchEnd';
      gameEvents.emit('matchEnd', { winner: w });
      return;
    }
    this._startRound(now);
  }

  // ---------------------------------------------------------------------------
  // Bomb mesh helpers
  // ---------------------------------------------------------------------------

  private _ensureBombMesh(): void {
    if (this._bombMesh || !this._scene) return;

    const group = new THREE.Group();

    const bodyGeo = new THREE.BoxGeometry(0.3, 0.2, 0.5);
    const bodyMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
    const body    = new THREE.Mesh(bodyGeo, bodyMat);
    group.add(body);

    const lightMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.04, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0xff0000 }),
    );
    lightMesh.position.set(0, 0.12, 0);
    group.add(lightMesh);

    const light = new THREE.PointLight(0xff2200, 0, 4);
    light.position.set(0, 0.15, 0);
    group.add(light);
    this._bombLight = light;

    this._bombMesh = group;
    this._scene.add(group);
  }

  private _removeBombMesh(): void {
    if (this._bombMesh && this._scene) {
      this._scene.remove(this._bombMesh);
    }
    this._bombMesh  = null;
    this._bombLight = null;
  }

  // ---------------------------------------------------------------------------
  // Bomb beep scheduling helper (called from main.ts)
  // ---------------------------------------------------------------------------

  /** Returns true if a beep should fire now; main.ts calls audio.bombBeep(). */
  shouldBeep(now: number): boolean {
    if (this.bomb.state !== 'planted') return false;
    const timeLeft = this.bomb.explodeAt - now;
    // Interval interpolates from 1.0 s at full time to 0.15 s at 0 s.
    const fraction  = Math.max(0, Math.min(1, timeLeft / RULES.BOMB_TIME));
    const interval  = 0.15 + fraction * (1.0 - 0.15);
    if (now - this._lastBeepAt >= interval) {
      this._lastBeepAt = now;
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Convenience: now (game-time) — stored externally in clock.now by main.ts
  // ---------------------------------------------------------------------------

  private _now(): number {
    // Fallback: game doesn't have direct access to clock, but startMatch/update
    // always receive 'now' as a parameter. We use 0 as init.
    return 0;
  }
}
