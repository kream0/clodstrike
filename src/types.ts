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
}
