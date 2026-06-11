export type Vec2 = { x: number; z: number };
export type Vec3 = { x: number; y: number; z: number };
export type Team = 'CT' | 'T';

// ----- Map -----
export interface CellLegend {
  floor: number;          // floor height in meters
  ceil?: number;          // absolute ceiling Y in meters; undefined = open sky
  wall?: boolean;         // solid full-height wall cell
  mat?: string;           // material key for rendering ('sand','sandLight','stone','floor','wood','metal','dark')
}
export interface MapProp {
  kind: 'crate' | 'door' | 'barrel' | 'plank' | 'block' | 'sandbag' | 'car';
  pos: [number, number, number];   // world coords, y = bottom of the prop
  size: [number, number, number];  // full extents in meters (axis-aligned)
  mat?: string;
  collide?: boolean;               // default true
}
export interface SpawnPoint { x: number; z: number; angle: number } // yaw radians; 0 faces -Z (north), +X is east
export interface NamedArea { name: string; min: Vec2; max: Vec2 }
export interface MapData {
  name: string;
  cellSize: number;                 // meters per grid cell
  origin: Vec2;                     // world pos of corner of grid[0] row, [0] col; col index grows toward +X, row toward +Z
  grid: string[];                   // rows of legend chars; all rows equal length
  legend: Record<string, CellLegend>;
  props: MapProp[];
  spawns: { ct: SpawnPoint[]; t: SpawnPoint[] };
  bombsites: { name: 'A' | 'B'; min: Vec2; max: Vec2 }[];
  areas: NamedArea[];
}

// ----- Grenades -----
export type GrenadeType = 'he' | 'flash' | 'smoke';

/** One live grenade projectile in flight or at rest. */
export interface GrenadeProjectile {
  id: number;
  type: GrenadeType;
  pos: Vec3;
  vel: Vec3;
  thrower: Combatant;
  /** game-time seconds at which this grenade detonates */
  detonatesAt: number;
  /** set to true once detonation logic has run */
  detonated: boolean;
}

/** A live smoke volume produced after a smoke grenade pops. */
export interface SmokeVolume {
  center: Vec3;
  radius: number;
  /** game-time seconds at which the smoke dissipates */
  expiresAt: number;
}

// ----- Combat -----
export type HitGroup = 'head' | 'body' | 'legs';
export type WeaponSlot = 'primary' | 'secondary' | 'knife';
export interface WeaponDef {
  id: string; name: string; slot: WeaponSlot; price: number;
  damage: number; headshotMult: number; rangeModifier: number; // dmg *= rangeModifier^(dist/15)
  rpm: number; magSize: number; reserveAmmo: number; reloadTime: number; // seconds
  moveSpeed: number;             // m/s while held (running)
  spreadBase: number;            // radians, standing still
  spreadMove: number;            // additional radians at full move speed
  spreadAir: number;             // additional radians while airborne
  recoilPitch: number;           // view punch per shot (radians)
  recoilYaw: number;             // max horizontal punch per shot
  recoilRecovery: number;        // punch recovery (radians/second)
  auto: boolean;                 // hold-to-fire
  scope?: boolean;               // AWP-style zoom
  killReward: number;
  isKnife?: boolean;
  range?: number;                // knife reach in meters
}
export interface WeaponState { def: WeaponDef; ammo: number; reserve: number; reloading: boolean; reloadEnd: number; nextFire: number; shotsFired: number }
export interface Inventory { knife: WeaponState; secondary: WeaponState | null; primary: WeaponState | null; activeSlot: WeaponSlot }
export interface Combatant {
  id: number; name: string; team: Team; isPlayer: boolean;
  pos: Vec3;            // feet position
  vel: Vec3;
  yaw: number; pitch: number;
  health: number; armor: number; helmet: boolean;
  alive: boolean; crouching: boolean; walking: boolean; onGround: boolean;
  inventory: Inventory;
  money: number; kills: number; deaths: number;
  hasBomb: boolean; hasDefuseKit: boolean;
  tagSlowUntil: number; // game-time seconds; movement slowed while now < this
  // ----- Grenade inventory & status (optional: existing construction sites are outside types.ts) -----
  /** Counts of each grenade type currently carried. */
  grenades?: Record<GrenadeType, number>;
  /** Which grenade type is currently "equipped" (ready to throw). null = none. */
  equippedGrenade?: GrenadeType | null;
  /** game-time seconds until which this combatant is blinded; 0 = not blind. */
  blindUntil?: number;
  /** Blind intensity at the moment blindness was applied, in range 0..1. */
  blindIntensity?: number;
}

// ----- Match stats -----
/** Per-combatant cumulative stats for the current match. Produced by Game, consumed by HUD. */
export interface MatchStats {
  headshotKills: number;
  damageDealt: number;
  moneySpent: number;
  mvps: number;
}

// ----- Events -----
export interface GameEvents {
  kill: { attacker: Combatant | null; victim: Combatant; weaponId: string; headshot: boolean };
  shot: { shooter: Combatant; pos: Vec3; weaponId: string };
  damage: { attacker: Combatant | null; victim: Combatant; amount: number; hitGroup: HitGroup };
  reload: { who: Combatant };
  footstep: { who: Combatant };
  roundStart: { roundNumber: number };
  roundEnd: { winner: Team; reason: string };
  bombPlanted: { site: 'A' | 'B'; pos: Vec3 };
  bombDefused: Record<string, never>;
  bombExploded: Record<string, never>;
  matchEnd: { winner: Team };
  grenadeThrown: { thrower: Combatant; type: GrenadeType };
  grenadeDetonated: { type: GrenadeType; pos: Vec3 };
  combatantFlashed: { victim: Combatant; intensity: number; duration: number };
}
