import * as THREE from 'three';
import { clone as SkeletonUtilsClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Vec3, GrenadeType } from './types';
import { THIRD_PERSON_WEAPON_FILES } from './characters';

// ---------------------------------------------------------------------------
// Weapon ID type (union of all weapon ids from constants.ts WEAPONS table)
// ---------------------------------------------------------------------------

export type WeaponId =
  | 'knife'
  | 'glock' | 'usp' | 'deagle' | 'dualies' | 'p250' | 'fiveseven' | 'tec9'
  | 'ak47' | 'm4a4' | 'famas' | 'aug' | 'galil' | 'sg553'
  | 'awp' | 'ssg08' | 'g3sg1' | 'scar20'
  | 'mac10' | 'mp9' | 'mp7' | 'ump45' | 'p90' | 'bizon'
  | 'nova' | 'xm1014' | 'sawedoff' | 'mag7' | 'm249' | 'negev';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Global viewmodel size multiplier.  Applied uniformly on top of every per-weapon
 * WEAPON_TUNING scaleMult (both GLB and procedural fallback paths).
 * 1.3 matches CS2's larger first-person weapon presence.
 */
export const VIEWMODEL_SCALE = 1.3;

// Base offset — shifted slightly lower-right vs the old 0.22/-0.22/-0.45 so
// the 30% larger models sit at a CS2-like lower-right position without clipping
// the camera near plane (near = 0.05 m; the viewmodel group is at Z ≈ -0.45 from
// the camera, well clear of the 0.05 m near plane even at 1.3× scale).
const VM_OFFSET = new THREE.Vector3(0.25, -0.26, -0.45);
const GUNMETAL  = 0x2a2a2e;
const GUN_DARK  = 0x1a1a1c;
const GUN_WOOD  = 0x5a3a1a;

// ---------------------------------------------------------------------------
// Arms tuning constants (exported so tests and callers can reference them).
// ---------------------------------------------------------------------------

/**
 * Uniform scale applied to the fp_arms clone. The arms rig is roughly 0.5 m
 * from shoulder to fingertip at rest — scale to match the viewmodel camera FOV.
 */
export const ARMS_SCALE = 0.9;

/**
 * Position offset of the arms root relative to the weapon anchor group.
 * X: left/right shift; Y: up/down; Z: forward/back (negative = toward camera).
 * Tuned so hands sit at the grip area of each weapon.
 */
export const ARMS_OFFSET = new THREE.Vector3(0.0, -0.12, 0.05);

// ---------------------------------------------------------------------------
// Team sleeve tint colors (CT = cool blue-grey; T = sand/tan).
// Chosen to match TEAM_TORSO in characters.ts: CT 0x5a7da8, T 0xa8824f.
// ---------------------------------------------------------------------------

/** CT sleeve tint (cool blue-grey, consistent with character CT torso). */
export const ARMS_TINT_CT = 0x5a7da8;
/** T sleeve tint (sand/tan, consistent with character T torso). */
export const ARMS_TINT_T  = 0xa8824f;

/**
 * Pure helper: map team string to sleeve hex tint color.
 * Exported for tests.
 */
export function teamSleeveColor(team: 'CT' | 'T'): number {
  return team === 'CT' ? ARMS_TINT_CT : ARMS_TINT_T;
}

// ---------------------------------------------------------------------------
// Grip preset table — bone-rotation presets for first-person arms.
// Reworked for the fp_arms.glb 24-joint rig (J-Toastie, CC BY 4.0).
//
// Real bone names in this rig:
//   Left side:  UpperArm.L, LowerArm.L, Hand.L,
//               DoubleFingersBeginning, DoubleFingers.L, DoubleFingersTip.L,
//               IndexBeginning.L, Index.L, IndexTip.L,
//               ThumbBeginning.L, Thumb.L, ThumbTip.L
//   Right side: UpperArm.R.001, LowerArm.R.001, Hand.R.001,
//               DoubleFingersBeginning.001, DoubleFingers.R.001, DoubleFingersTip.R.001,
//               IndexBeginning.R.001, Index.R.001, IndexTip.R.001,
//               ThumbBeginning.R.001, Thumb.R.001, ThumbTip.R.001
//
// NOTE: the Blender mirror convention puts ".001" suffix on all RIGHT-side bones.
// Poses are static: applied once on weapon switch, not per frame.
// ---------------------------------------------------------------------------

export type GripFamily = 'two_handed_long' | 'pistol' | 'knife';

export interface GripPreset {
  family: GripFamily;
  /** UpperArm.R.001 local rotation (Euler XYZ radians). */
  upperArmR: readonly [number, number, number];
  /** LowerArm.R.001 local rotation (Euler XYZ radians). */
  lowerArmR: readonly [number, number, number];
  /** Hand.R.001 local rotation (Euler XYZ radians). */
  handR: readonly [number, number, number];
  /** UpperArm.L local rotation (Euler XYZ radians). */
  upperArmL: readonly [number, number, number];
  /** LowerArm.L local rotation (Euler XYZ radians). */
  lowerArmL: readonly [number, number, number];
  /** Hand.L local rotation (Euler XYZ radians). */
  handL: readonly [number, number, number];
  /**
   * Finger curl (XYZ radians) applied identically to ALL finger bones on BOTH
   * sides. A slight curl makes grips read much better — cheap win.
   * Set all to 0 for a flat open hand.
   */
  fingerCurl: readonly [number, number, number];
}

/** Per-stem grip preset. Every stem in THIRD_PERSON_WEAPON_PATHS must appear here. */
export const GRIP_PRESETS: Readonly<Record<string, GripPreset>> = {
  // ─── Two-handed long guns ────────────────────────────────────────────────
  // Right hand at grip: elbow bent inward, forearm extended forward.
  // Left hand forward under the barrel: arm reaches further out.
  assault_rifle: {
    family:    'two_handed_long',
    upperArmR: [ 0.55,  0.30, -0.20],
    lowerArmR: [ 0.80,  0.10,  0.00],
    handR:     [-0.10,  0.00,  0.00],
    upperArmL: [ 0.70, -0.35,  0.20],
    lowerArmL: [ 0.90, -0.10,  0.00],
    handL:     [-0.10,  0.00,  0.00],
    fingerCurl: [ 0.30,  0.00,  0.00],
  },
  assault_rifle_2: {
    family:    'two_handed_long',
    upperArmR: [ 0.55,  0.30, -0.20],
    lowerArmR: [ 0.80,  0.10,  0.00],
    handR:     [-0.10,  0.00,  0.00],
    upperArmL: [ 0.70, -0.35,  0.20],
    lowerArmL: [ 0.90, -0.10,  0.00],
    handL:     [-0.10,  0.00,  0.00],
    fingerCurl: [ 0.30,  0.00,  0.00],
  },
  sniper_rifle: {
    family:    'two_handed_long',
    upperArmR: [ 0.60,  0.25, -0.20],
    lowerArmR: [ 0.85,  0.10,  0.00],
    handR:     [-0.10,  0.00,  0.00],
    upperArmL: [ 0.75, -0.40,  0.20],
    lowerArmL: [ 0.95, -0.10,  0.00],
    handL:     [-0.10,  0.00,  0.00],
    fingerCurl: [ 0.25,  0.00,  0.00],
  },
  smg: {
    family:    'two_handed_long',
    upperArmR: [ 0.50,  0.30, -0.20],
    lowerArmR: [ 0.75,  0.10,  0.00],
    handR:     [-0.10,  0.00,  0.00],
    upperArmL: [ 0.65, -0.30,  0.20],
    lowerArmL: [ 0.85, -0.10,  0.00],
    handL:     [-0.10,  0.00,  0.00],
    fingerCurl: [ 0.30,  0.00,  0.00],
  },
  scifi_smg: {
    family:    'two_handed_long',
    upperArmR: [ 0.50,  0.30, -0.20],
    lowerArmR: [ 0.75,  0.10,  0.00],
    handR:     [-0.10,  0.00,  0.00],
    upperArmL: [ 0.65, -0.30,  0.20],
    lowerArmL: [ 0.85, -0.10,  0.00],
    handL:     [-0.10,  0.00,  0.00],
    fingerCurl: [ 0.30,  0.00,  0.00],
  },
  shotgun: {
    family:    'two_handed_long',
    upperArmR: [ 0.55,  0.30, -0.20],
    lowerArmR: [ 0.80,  0.10,  0.00],
    handR:     [-0.10,  0.00,  0.00],
    upperArmL: [ 0.70, -0.35,  0.20],
    lowerArmL: [ 0.90, -0.10,  0.00],
    handL:     [-0.10,  0.00,  0.00],
    fingerCurl: [ 0.28,  0.00,  0.00],
  },
  // ─── Pistols (right-hand grip, left arm low/supporting) ──────────────────
  pistol: {
    family:    'pistol',
    upperArmR: [ 0.45,  0.20, -0.15],
    lowerArmR: [ 0.70,  0.05,  0.00],
    handR:     [ 0.00,  0.00,  0.00],
    upperArmL: [ 0.35, -0.15,  0.10],
    lowerArmL: [ 0.60,  0.00,  0.00],
    handL:     [ 0.00,  0.00,  0.00],
    fingerCurl: [ 0.25,  0.00,  0.00],
  },
  revolver: {
    family:    'pistol',
    upperArmR: [ 0.45,  0.20, -0.15],
    lowerArmR: [ 0.70,  0.05,  0.00],
    handR:     [ 0.00,  0.00,  0.00],
    upperArmL: [ 0.35, -0.15,  0.10],
    lowerArmL: [ 0.60,  0.00,  0.00],
    handL:     [ 0.00,  0.00,  0.00],
    fingerCurl: [ 0.25,  0.00,  0.00],
  },
  // ─── Knife (right arm forward/extended, left arm low/back) ───────────────
  knife: {
    family:    'knife',
    upperArmR: [ 0.35,  0.10, -0.10],
    lowerArmR: [ 0.55,  0.00,  0.00],
    handR:     [ 0.25, -0.30,  0.00],
    upperArmL: [ 0.10,  0.00,  0.00],
    lowerArmL: [ 0.20,  0.00,  0.00],
    handL:     [ 0.00,  0.00,  0.00],
    fingerCurl: [ 0.35,  0.00,  0.00],
  },
} as const;

// ---------------------------------------------------------------------------
// Authoritative list of all 24 bone names in fp_arms.glb (J-Toastie rig).
// Used for pose application and tests. Do NOT edit without re-inspecting the GLB.
// ---------------------------------------------------------------------------

export const FP_ARMS_BONE_NAMES: readonly string[] = [
  // Left side (no suffix)
  'UpperArm.L', 'LowerArm.L', 'Hand.L',
  'DoubleFingersBeginning', 'DoubleFingers.L', 'DoubleFingersTip.L',
  'IndexBeginning.L', 'Index.L', 'IndexTip.L',
  'ThumbBeginning.L', 'Thumb.L', 'ThumbTip.L',
  // Right side (Blender mirror: .001 suffix)
  'UpperArm.R.001', 'LowerArm.R.001', 'Hand.R.001',
  'DoubleFingersBeginning.001', 'DoubleFingers.R.001', 'DoubleFingersTip.R.001',
  'IndexBeginning.R.001', 'Index.R.001', 'IndexTip.R.001',
  'ThumbBeginning.R.001', 'Thumb.R.001', 'ThumbTip.R.001',
] as const;

// All RIGHT-side finger bones (for curl application).
const FINGER_BONES_R = [
  'DoubleFingersBeginning.001', 'DoubleFingers.R.001', 'DoubleFingersTip.R.001',
  'IndexBeginning.R.001', 'Index.R.001', 'IndexTip.R.001',
  'ThumbBeginning.R.001', 'Thumb.R.001', 'ThumbTip.R.001',
] as const;

// All LEFT-side finger bones (for curl application).
const FINGER_BONES_L = [
  'DoubleFingersBeginning', 'DoubleFingers.L', 'DoubleFingersTip.L',
  'IndexBeginning.L', 'Index.L', 'IndexTip.L',
  'ThumbBeginning.L', 'Thumb.L', 'ThumbTip.L',
] as const;

// ---------------------------------------------------------------------------
// Per-weapon procedural mesh factories (box-based fallback)
// ---------------------------------------------------------------------------

function mat(color: number): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color });
}

function box(
  sx: number, sy: number, sz: number,
  color: number,
  cx = 0, cy = 0, cz = 0,
): THREE.Mesh {
  const geo  = new THREE.BoxGeometry(sx, sy, sz);
  const mesh = new THREE.Mesh(geo, mat(color));
  mesh.position.set(cx, cy, cz);
  return mesh;
}

function buildPistol(): THREE.Group {
  const g = new THREE.Group();
  // Slide
  g.add(box(0.055, 0.09, 0.22, GUNMETAL, 0, 0.02, 0));
  // Grip
  g.add(box(0.05,  0.12, 0.09, GUN_DARK, 0, -0.06, 0.065));
  return g;
}

function buildRifle(): THREE.Group {
  const g = new THREE.Group();
  // Body
  g.add(box(0.055, 0.085, 0.38, GUNMETAL, 0, 0, 0));
  // Barrel extension
  g.add(box(0.032, 0.032, 0.12, GUN_DARK, 0, 0.006, -0.25));
  // Magazine
  g.add(box(0.044, 0.14, 0.06, GUN_DARK, 0, -0.10, 0.06));
  // Stock
  g.add(box(0.05,  0.07, 0.12, GUN_WOOD, 0, -0.01, 0.22));
  return g;
}

function buildAWP(): THREE.Group {
  const g = new THREE.Group();
  // Long body
  g.add(box(0.055, 0.07, 0.60, GUNMETAL, 0, 0, 0));
  // Long barrel tip
  g.add(box(0.028, 0.028, 0.15, GUN_DARK, 0, 0.004, -0.375));
  // Scope cylinder
  g.add(box(0.036, 0.036, 0.18, 0x444444, 0, 0.06, -0.05));
  // Stock
  g.add(box(0.048, 0.065, 0.14, GUN_WOOD, 0, -0.005, 0.28));
  return g;
}

function buildKnife(): THREE.Group {
  const g = new THREE.Group();
  // Blade (flat plane via thin box)
  g.add(box(0.018, 0.10, 0.20, 0x9090a0, 0, 0.02, -0.08));
  // Handle
  g.add(box(0.032, 0.06, 0.10, GUN_WOOD, 0, -0.01, 0.06));
  return g;
}

function buildSMG(): THREE.Group {
  const g = new THREE.Group();
  // Compact body
  g.add(box(0.050, 0.075, 0.30, GUNMETAL, 0, 0, 0));
  // Short barrel
  g.add(box(0.028, 0.028, 0.08, GUN_DARK, 0, 0.005, -0.19));
  // Magazine
  g.add(box(0.040, 0.12, 0.05, GUN_DARK, 0, -0.09, 0.04));
  return g;
}

function buildShotgun(): THREE.Group {
  const g = new THREE.Group();
  // Body
  g.add(box(0.060, 0.085, 0.42, GUNMETAL, 0, 0, 0));
  // Barrel pair
  g.add(box(0.042, 0.036, 0.12, GUN_DARK, 0, 0.006, -0.27));
  // Stock
  g.add(box(0.052, 0.072, 0.13, GUN_WOOD, 0, -0.01, 0.24));
  return g;
}

// ---------------------------------------------------------------------------
// Normalization support types + pure function (exported for tests)
// ---------------------------------------------------------------------------

export interface NormalizeConfig {
  /** The approximate length (Z-extent) the weapon should appear as, in meters. */
  targetLength: number;
  /** World-space position offset to place the model at the procedural gun's location. */
  gripOffset: { x: number; y: number; z: number };
  /** Optional extra rotation (Euler, in radians) applied after axis alignment. */
  extraRotation?: { x: number; y: number; z: number };
}

export interface NormalizeResult {
  /** Uniform scale factor to apply to the model. */
  scale: number;
  /**
   * Euler rotation (in radians) to align the model's longest bbox axis to -Z
   * (barrel pointing away from camera). If the model is already aligned, this
   * is the zero rotation.
   */
  rotation: THREE.Euler;
  /** Position offset to apply. */
  position: THREE.Vector3;
}

/**
 * Compute scale, rotation, and position to normalise a loaded weapon model.
 *
 * Pure function — no THREE rendering state modified.
 *
 * @param bbox     - The world-space Box3 of the original unscaled model scene.
 * @param config   - Per-weapon target configuration.
 * @returns        - Scale, rotation, and position ready to apply to the model root.
 */
export function normalizeWeaponModel(
  bbox: THREE.Box3,
  config: NormalizeConfig,
): NormalizeResult {
  const size = new THREE.Vector3();
  bbox.getSize(size);

  // Guard against degenerate / zero bbox
  const maxExtent = Math.max(size.x, size.y, size.z, 0.001);

  const scale = config.targetLength / maxExtent;

  // Determine which axis is the longest to align to -Z (barrel forward)
  let rotY = 0;
  let rotX = 0;
  if (size.x >= size.y && size.x >= size.z) {
    // Longest axis is X: rotate 90° around Y to point -Z
    rotY = Math.PI / 2;
  } else if (size.y >= size.x && size.y >= size.z) {
    // Longest axis is Y: rotate -90° around X to point -Z
    rotX = -Math.PI / 2;
  }
  // else longest axis is Z (already aligned) — identity rotation

  let finalRotX = rotX;
  let finalRotY = rotY;
  let finalRotZ = 0;

  if (config.extraRotation !== undefined) {
    finalRotX += config.extraRotation.x;
    finalRotY += config.extraRotation.y;
    finalRotZ += config.extraRotation.z;
  }

  const rotation = new THREE.Euler(finalRotX, finalRotY, finalRotZ, 'XYZ');
  const position = new THREE.Vector3(
    config.gripOffset.x,
    config.gripOffset.y,
    config.gripOffset.z,
  );

  return { scale, rotation, position };
}

// ---------------------------------------------------------------------------
// Per-weapon tuning table (keyed by weapons_v2 file stem)
// Single place to tweak offsets/rotation/scale after playtesting.
// ---------------------------------------------------------------------------

export interface WeaponTuning {
  /** targetLength fed into normalizeWeaponModel (approximate Z-span in meters). */
  targetLength: number;
  /** Grip/anchor offset in viewmodel local space — fine-tune after playtesting. */
  gripOffset: { x: number; y: number; z: number };
  /** Extra rotation tweak in radians (XYZ Euler). */
  extraRotation: { x: number; y: number; z: number };
  /** Additional uniform scale multiplier applied on top of normalisation. */
  scaleMult: number;
  /** Muzzle Z offset (in viewmodel local space) for the muzzle flash anchor. */
  muzzleZ: number;
}

// Stem-level base tuning (one entry per weapons_v2 file stem)
const STEM_TUNING: Record<string, WeaponTuning> = {
  pistol: {
    targetLength: 0.22,
    gripOffset: { x: 0, y: 0, z: 0 },
    extraRotation: { x: 0, y: 0, z: 0 },
    scaleMult: 1.0,
    muzzleZ: -0.14,
  },
  revolver: {
    targetLength: 0.22,
    gripOffset: { x: 0, y: 0, z: 0 },
    extraRotation: { x: 0, y: 0, z: 0 },
    scaleMult: 1.1,
    muzzleZ: -0.14,
  },
  smg: {
    targetLength: 0.30,
    gripOffset: { x: 0, y: 0, z: 0 },
    extraRotation: { x: 0, y: 0, z: 0 },
    scaleMult: 0.82,
    muzzleZ: -0.22,
  },
  scifi_smg: {
    targetLength: 0.32,
    gripOffset: { x: 0, y: 0, z: 0 },
    extraRotation: { x: 0, y: 0, z: 0 },
    scaleMult: 0.84,
    muzzleZ: -0.24,
  },
  shotgun: {
    targetLength: 0.38,
    gripOffset: { x: 0, y: 0, z: 0 },
    extraRotation: { x: 0, y: 0, z: 0 },
    scaleMult: 1.0,
    muzzleZ: -0.30,
  },
  assault_rifle: {
    targetLength: 0.38,
    gripOffset: { x: 0, y: 0, z: 0 },
    extraRotation: { x: 0, y: 0, z: 0 },
    scaleMult: 1.0,
    muzzleZ: -0.32,
  },
  assault_rifle_2: {
    targetLength: 0.38,
    gripOffset: { x: 0, y: 0, z: 0 },
    extraRotation: { x: 0, y: 0, z: 0 },
    scaleMult: 1.0,
    muzzleZ: -0.32,
  },
  sniper_rifle: {
    targetLength: 0.60,
    gripOffset: { x: 0, y: 0, z: 0 },
    extraRotation: { x: 0, y: 0, z: 0 },
    scaleMult: 1.0,
    muzzleZ: -0.45,
  },
  knife: {
    targetLength: 0.20,
    gripOffset: { x: 0, y: 0, z: 0 },
    extraRotation: { x: 0, y: 0, z: 0 },
    scaleMult: 1.0,
    muzzleZ: -0.12,
  },
} satisfies Record<string, WeaponTuning>;

// Per-id tuning overrides (only fields that differ from the stem base).
// DRY: only patch what differs.
interface TuningOverride {
  scaleMult?: number;
  muzzleZ?: number;
  targetLength?: number;
  /** Optional per-id grip offset override (replaces stem value wholesale). */
  gripOffset?: { x: number; y: number; z: number };
  /** Optional per-id extra rotation override (replaces stem value wholesale). */
  extraRotation?: { x: number; y: number; z: number };
}

const WEAPON_TUNING_OVERRIDES: Record<string, TuningOverride> = {
  // --- Snipers: ssg08 is shorter (scout) ---
  ssg08:  { scaleMult: 0.92, targetLength: 0.55, muzzleZ: -0.40 },

  // --- Pistols: compact variants ---
  p250:   { scaleMult: 0.92, targetLength: 0.20, muzzleZ: -0.12 },

  // --- SMGs: per-weapon feel ---
  mp7:    { scaleMult: 0.84, targetLength: 0.32, muzzleZ: -0.24 },
  ump45:  { scaleMult: 0.86, targetLength: 0.34, muzzleZ: -0.26 },
  p90:    { scaleMult: 0.88, targetLength: 0.36, muzzleZ: -0.28 },
  bizon:  { scaleMult: 0.84, targetLength: 0.32, muzzleZ: -0.24 },

  // --- Shotguns: sawed-off is compact ---
  sawedoff: { scaleMult: 0.98, targetLength: 0.32, muzzleZ: -0.24 },
  mag7:     { scaleMult: 1.02, targetLength: 0.36, muzzleZ: -0.28 },

  // --- Heavy: MGs enlarged ---
  m249:  { scaleMult: 1.15, targetLength: 0.44, muzzleZ: -0.36 },
  negev: { scaleMult: 1.15, targetLength: 0.44, muzzleZ: -0.36 },
};

// Fallback tuning for unknown ids
const DEFAULT_TUNING: WeaponTuning = {
  targetLength: 0.22,
  gripOffset: { x: 0, y: 0, z: 0 },
  extraRotation: { x: 0, y: 0, z: 0 },
  scaleMult: 1.0,
  muzzleZ: -0.14,
};

/**
 * Resolve effective tuning for any weapon id.
 * Order: stem-level base tuning (via THIRD_PERSON_WEAPON_FILES) + per-id override → DEFAULT_TUNING.
 * Returns a fresh object; callers may not mutate the internal tables.
 * Exported for tests.
 */
export function resolveWeaponTuning(id: string): WeaponTuning {
  const stem = THIRD_PERSON_WEAPON_FILES[id];
  const baseTuning: WeaponTuning =
    (stem !== undefined ? STEM_TUNING[stem] : undefined) ?? DEFAULT_TUNING;
  const override = WEAPON_TUNING_OVERRIDES[id];
  if (override !== undefined) {
    // Spread scalars; for object-typed fields produce fresh copies so callers
    // cannot accidentally mutate the internal base table via the returned object.
    const resolved: WeaponTuning = {
      ...baseTuning,
      ...override,
      gripOffset: override.gripOffset !== undefined
        ? { ...override.gripOffset }
        : { ...baseTuning.gripOffset },
      extraRotation: override.extraRotation !== undefined
        ? { ...override.extraRotation }
        : { ...baseTuning.extraRotation },
    };
    return resolved;
  }
  // No override — still return fresh nested objects to honour the fresh-object contract.
  return {
    ...baseTuning,
    gripOffset:    { ...baseTuning.gripOffset },
    extraRotation: { ...baseTuning.extraRotation },
  };
}

// ---------------------------------------------------------------------------
// Grenade procedural mesh builders (lazy, pooled once per type)
// ---------------------------------------------------------------------------

function buildGrenadeHE(): THREE.Group {
  const g = new THREE.Group();
  // Olive rounded box (approximate with a sphere-ish box)
  g.add(box(0.055, 0.07, 0.07, 0x556b2f, 0, 0, 0));
  // Safety lever nub
  g.add(box(0.016, 0.016, 0.022, 0x3a3a2a, 0.035, 0.01, -0.02));
  return g;
}

function buildGrenadeFlash(): THREE.Group {
  const g = new THREE.Group();
  // Light gray cylinder approximated with a thin taller box
  g.add(box(0.05, 0.09, 0.05, 0xd0d0d0, 0, 0, 0));
  // Black safety pin top
  g.add(box(0.012, 0.012, 0.012, 0x222222, 0, 0.052, 0));
  return g;
}

function buildGrenadeSmoke(): THREE.Group {
  const g = new THREE.Group();
  // Blue-gray cylinder — taller than flash
  g.add(box(0.05, 0.11, 0.05, 0x7090a0, 0, 0, 0));
  // Green safety ring marker
  g.add(box(0.056, 0.014, 0.056, 0x3a7a3a, 0, -0.03, 0));
  return g;
}

// ---------------------------------------------------------------------------
// Animation state
// ---------------------------------------------------------------------------

interface AnimState {
  // Walk bob
  bobAccum:    number;
  bobPhase:    number;
  // Fire kick
  kickZ:       number;
  kickPitch:   number;
  // Reload
  reloadTimer: number;
  reloadDur:   number;
  // Switch raise
  switchTimer: number;
  // Idle sway (mouse lag)
  swayX:       number;
  swayY:       number;
}

function freshAnim(): AnimState {
  return {
    bobAccum:    0,
    bobPhase:    0,
    kickZ:       0,
    kickPitch:   0,
    reloadTimer: -1,
    reloadDur:   0,
    switchTimer: 0.3,
    swayX:       0,
    swayY:       0,
  };
}

// ---------------------------------------------------------------------------
// Helper: apply viewmodel render properties to every mesh in a model
// Mirrors the same settings the procedural box meshes rely on implicitly
// (They're added to the camera's sub-graph which has no depth-clip issues,
//  so no special renderOrder/layers tricks are needed — preserve that here.)
// ---------------------------------------------------------------------------

function applyViewmodelMaterial(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = false;
      child.frustumCulled = false;
      // Preserve GLB materials; just ensure depth behaves correctly
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) {
        if (m instanceof THREE.Material) {
          m.depthTest = true;
          m.depthWrite = true;
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// ViewModel class
// ---------------------------------------------------------------------------

export class ViewModel {
  private _group: THREE.Group;
  private _camera: THREE.Camera;
  private _anim: AnimState;
  private _muzzle: THREE.Object3D;
  private _visible = true;

  /** Current weapon id */
  private _currentId = 'usp';

  /** Preloaded weapons_v2 models keyed by file stem, set by setWeaponModelsV2. */
  private _stemModels: Record<string, THREE.Object3D> = {};

  /** The currently active model node (GLB clone) or null when procedural */
  private _activeModel: THREE.Object3D | null = null;

  /** The currently active procedural mesh group */
  private _proceduralMesh: THREE.Group | null = null;

  /** Lazily-built grenade meshes, keyed by type — built once, reused. */
  private _grenadeMeshes: Partial<Record<GrenadeType, THREE.Group>> = {};

  /** Currently displayed grenade group (non-null while grenade is equipped). */
  private _activeGrenade: THREE.Group | null = null;

  // ---------------------------------------------------------------------------
  // Arms state
  // ---------------------------------------------------------------------------

  /** Source GLTF scene from fp_arms.glb — retained as the clone source. */
  private _armsSource: THREE.Object3D | null = null;

  /** Cloned arms Object3D currently attached to _group. */
  private _armsClone: THREE.Object3D | null = null;

  /**
   * Bone-name → Bone lookup built at registration from the cloned hierarchy.
   * Reset each clone so bone refs are always from the live clone, not the source.
   */
  private _armsBoneMap: Map<string, THREE.Bone> = new Map();

  /**
   * Pending team to apply when arms are registered.
   * Stored so setArmsTeam() before setArmsAssets() is safe.
   */
  private _pendingTeam: 'CT' | 'T' = 'CT';

  /** Sleeve material clone (MeshStandardMaterial) — tinted per team. */
  private _sleeveMatClone: THREE.MeshStandardMaterial | null = null;

  /** Current grip family — tracks last posed family to avoid re-posing unchanged weapon. */
  private _currentGripFamily: GripFamily | null = null;

  constructor(camera: THREE.Camera) {
    this._camera = camera;
    this._group  = new THREE.Group();
    this._anim   = freshAnim();

    // Muzzle marker (invisible, at barrel tip).
    this._muzzle = new THREE.Object3D();

    camera.add(this._group);
    this._group.add(this._muzzle);

    this.setWeapon('usp');
  }

  /**
   * Register preloaded weapons_v2 static GLB scenes keyed by file stem
   * (e.g. 'pistol', 'assault_rifle', 'knife').
   * Replaces the old setWeaponModels(Partial<Record<WeaponId, ...>>) API.
   * Idempotent — safe to call before or after any setWeapon() call.
   * If called after setWeapon(), immediately swaps in the model for the current weapon.
   */
  setWeaponModelsV2(models: Record<string, THREE.Object3D>): void {
    this._stemModels = models;
    // Re-apply for the current weapon so the swap happens immediately
    this._applyCurrentWeaponVisual(this._currentId);
  }

  /**
   * Register the fp_arms GLTF scene.  Must be called with the raw GLTF returned
   * by loadGLB — SkeletonUtils.clone is applied here so the source is kept pristine
   * for future re-clones (e.g. if setArmsAssets is called again).
   *
   * Safe to call before or after setWeapon() / setArmsTeam().
   * A failed load in main.ts must NOT call this — the fallback (no-arms) is preserved.
   */
  setArmsAssets(gltf: GLTF): void {
    this._armsSource = gltf.scene;
    this._buildArmsClone();
    // Apply pending team tint (in case setArmsTeam was called before registration).
    this._applyTeamTint(this._pendingTeam);
    // Apply pose for the current weapon.
    this._poseArms(this._currentId);
  }

  /**
   * Switch the sleeve tint to match the player's team.
   * Safe to call before setArmsAssets — the team is remembered and applied at
   * registration time.  Also safe to call multiple times.
   */
  setArmsTeam(team: 'CT' | 'T'): void {
    this._pendingTeam = team;
    if (this._sleeveMatClone !== null) {
      this._applyTeamTint(team);
    }
  }

  setWeapon(id: string): void {
    this._currentId = id;

    // _applyCurrentWeaponVisual removes old visuals and updates muzzle position.
    this._applyCurrentWeaponVisual(id);

    this._group.position.copy(VM_OFFSET);
    this._group.rotation.set(0, 0, 0);

    // Reset switch animation.
    this._anim.switchTimer = 0.3;
    this._anim.reloadTimer = -1;

    // Re-pose arms for new weapon (only when family changes — _poseArms tracks this).
    this._poseArms(id);
  }

  onFire(): void {
    this._anim.kickZ     = 0.06;
    this._anim.kickPitch = 0.05;
  }

  onReloadStart(duration: number): void {
    this._anim.reloadTimer = 0;
    this._anim.reloadDur   = duration;
  }

  setVisible(v: boolean): void {
    this._visible = v;
    this._group.visible = v;
  }

  /**
   * Show a procedural grenade mesh in the hand area (bob/sway still apply via
   * the shared anchor group).  Pass null to dismiss the grenade and restore the
   * current weapon visual.
   *
   * Integration MUST call this:
   *  - setGrenadeView(type)  immediately after updateGrenadeEquip sets equippedGrenade
   *  - setGrenadeView(null)  after updateGrenadeEquip clears equippedGrenade (throw, cancel, slot switch)
   */
  setGrenadeView(type: GrenadeType | null): void {
    if (type !== null) {
      // Hide current weapon visual without destroying it.
      if (this._activeModel !== null) {
        this._activeModel.visible = false;
      }
      if (this._proceduralMesh !== null) {
        this._proceduralMesh.visible = false;
      }

      // Detach previous grenade if switching types.
      if (this._activeGrenade !== null) {
        this._group.remove(this._activeGrenade);
        this._activeGrenade = null;
      }

      // Lazily build grenade mesh.
      let grenadeMesh = this._grenadeMeshes[type];
      if (grenadeMesh === undefined) {
        switch (type) {
          case 'he':    grenadeMesh = buildGrenadeHE();    break;
          case 'flash': grenadeMesh = buildGrenadeFlash(); break;
          case 'smoke': grenadeMesh = buildGrenadeSmoke(); break;
        }
        this._grenadeMeshes[type] = grenadeMesh;
      }

      this._group.add(grenadeMesh);
      this._activeGrenade = grenadeMesh;

      // Reset switch raise so grenade swings up nicely.
      this._anim.switchTimer = 0.2;
    } else {
      // Remove grenade mesh from anchor.
      if (this._activeGrenade !== null) {
        this._group.remove(this._activeGrenade);
        this._activeGrenade = null;
      }

      // Restore weapon visual.
      if (this._activeModel !== null) {
        this._activeModel.visible = true;
      }
      if (this._proceduralMesh !== null) {
        this._proceduralMesh.visible = true;
      }

      // Trigger raise animation on restore.
      this._anim.switchTimer = 0.2;
    }
  }

  /**
   * Trigger a quick forward-kick on the anchor (same mechanism as onFire) to
   * provide throw feedback.  Integration calls this when a ThrowRequest is returned
   * by updateGrenadeEquip.
   */
  playThrowAnim(_now: number): void {
    this._anim.kickZ     = 0.08;
    this._anim.kickPitch = 0.07;
  }

  getMuzzleWorldPos(out?: Vec3): Vec3 {
    const wp = new THREE.Vector3();
    this._muzzle.getWorldPosition(wp);
    if (out) {
      out.x = wp.x;
      out.y = wp.y;
      out.z = wp.z;
    }
    return { x: wp.x, y: wp.y, z: wp.z };
  }

  update(
    dt: number,
    opts: { speed: number; onGround: boolean; mouseDx: number; mouseDy: number; scoped: boolean },
  ): void {
    if (opts.scoped) {
      this._group.visible = false;
      return;
    }
    this._group.visible = this._visible;

    const a = this._anim;

    // --- Switch raise (slide in from below) ---
    if (a.switchTimer > 0) {
      a.switchTimer = Math.max(0, a.switchTimer - dt);
      const t = a.switchTimer / 0.3;
      this._group.position.y = VM_OFFSET.y - 0.18 * t;
    } else {
      this._group.position.y = VM_OFFSET.y;
    }

    // --- Walk bob ---
    if (opts.onGround && opts.speed > 0.3) {
      a.bobAccum += opts.speed * dt;
      a.bobPhase  = a.bobAccum * 2.8; // cycles per meter
    }
    const bobAmp  = Math.min(opts.speed / 4, 1) * 0.006;
    const bobX    = Math.sin(a.bobPhase) * bobAmp;
    const bobY    = Math.abs(Math.sin(a.bobPhase * 2)) * bobAmp * 0.5;

    // --- Idle sway (mouse delta lag) ---
    const swayDecay = 8 * dt;
    a.swayX += (-opts.mouseDx * 0.001 - a.swayX) * swayDecay;
    a.swayY += (-opts.mouseDy * 0.001 - a.swayY) * swayDecay;

    // --- Fire kick spring return ---
    const kickReturn = 18 * dt;
    a.kickZ     = Math.max(0, a.kickZ     - kickReturn * 0.06);
    a.kickPitch = Math.max(0, a.kickPitch - kickReturn * 0.05);

    // --- Reload drop/tilt ---
    let reloadOffsetY   = 0;
    let reloadOffsetPitch = 0;
    if (a.reloadTimer >= 0) {
      a.reloadTimer += dt;
      const prog  = Math.min(a.reloadTimer / a.reloadDur, 1);
      // First half: drop + tilt down; second half: rise back.
      const phase = prog < 0.5 ? prog * 2 : (1 - prog) * 2;
      reloadOffsetY     = -0.06 * phase;
      reloadOffsetPitch =  0.3  * phase;
      if (a.reloadTimer >= a.reloadDur) {
        a.reloadTimer = -1;
      }
    }

    // Apply all offsets.
    this._group.position.set(
      VM_OFFSET.x + bobX + a.swayX,
      VM_OFFSET.y + bobY + (a.switchTimer > 0 ? this._group.position.y - VM_OFFSET.y : 0) + reloadOffsetY,
      VM_OFFSET.z + a.kickZ,
    );

    // Fix switch raise after it's calculated.
    if (a.switchTimer > 0) {
      const t = a.switchTimer / 0.3;
      this._group.position.y = VM_OFFSET.y - 0.18 * t + bobY + reloadOffsetY;
    }

    this._group.rotation.set(
      -a.kickPitch + a.swayY * 0.5 + reloadOffsetPitch,
      a.swayX * 0.3,
      0,
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Remove any existing weapon visual children (model or procedural) as well
   * as any grenade overlay mesh.  Always keeps the muzzle marker and the arms
   * clone (arms are a permanent child of _group — they persist across weapon
   * switches so bob/sway/kick move them with the gun automatically).
   */
  private _removeWeaponVisuals(): void {
    // Collect the children to keep: muzzle marker + arms clone (if present).
    const keepSet = new Set<THREE.Object3D>();
    keepSet.add(this._muzzle);
    if (this._armsClone !== null) keepSet.add(this._armsClone);

    const toRemove: THREE.Object3D[] = this._group.children.filter(
      (c) => !keepSet.has(c),
    );
    for (const child of toRemove) {
      this._group.remove(child);
    }
    this._activeModel = null;
    this._proceduralMesh = null;
    this._activeGrenade = null;
  }

  /**
   * Attach either a normalized GLB clone or a procedural mesh for the given
   * weapon id. Picks GLB stem model when available in _stemModels; otherwise
   * falls back to procedural boxes.
   *
   * Resolution: weapon id → stem (via THIRD_PERSON_WEAPON_FILES) → GLB clone.
   * weapons_v2 GLBs are static (not skinned) — plain .clone(true) is correct.
   */
  private _applyCurrentWeaponVisual(id: string): void {
    // Remove previous visuals before reattaching
    this._removeWeaponVisuals();

    const tuning = resolveWeaponTuning(id);
    this._muzzle.position.set(0, 0.02, tuning.muzzleZ);

    // Resolve stem for this weapon id
    const stem = THIRD_PERSON_WEAPON_FILES[id];
    const sourceModel = stem !== undefined ? this._stemModels[stem] : undefined;

    if (sourceModel !== undefined) {
      // --- GLB path ---
      // weapons_v2 models are static (no SkinnedMesh) — plain .clone(true) is correct.
      // Do NOT use SkeletonUtils here; that's only for rigged meshes.
      const modelClone: THREE.Object3D = sourceModel.clone(true);

      // Compute normalization
      const bbox = new THREE.Box3().setFromObject(sourceModel);
      const normResult = normalizeWeaponModel(bbox, {
        targetLength: tuning.targetLength,
        gripOffset: tuning.gripOffset,
        extraRotation: tuning.extraRotation,
      });

      // Apply scale + per-weapon scaleMult + global VIEWMODEL_SCALE multiplier
      const finalScale = normResult.scale * tuning.scaleMult * VIEWMODEL_SCALE;
      modelClone.scale.setScalar(finalScale);
      modelClone.rotation.copy(normResult.rotation);
      modelClone.position.copy(normResult.position);

      // Apply viewmodel render settings to every child mesh
      applyViewmodelMaterial(modelClone);

      this._group.add(modelClone);
      this._activeModel = modelClone;
    } else {
      // --- Procedural fallback (GLBs not loaded, load failed, or unknown id) ---
      const shapeId = stem ?? id;
      let weaponMesh: THREE.Group;

      switch (shapeId) {
        case 'assault_rifle':
        case 'assault_rifle_2':
          weaponMesh = buildRifle();
          break;
        case 'sniper_rifle':
          weaponMesh = buildAWP();
          break;
        case 'knife':
          weaponMesh = buildKnife();
          break;
        case 'smg':
        case 'scifi_smg':
          weaponMesh = buildSMG();
          break;
        case 'shotgun':
          weaponMesh = buildShotgun();
          break;
        default:
          // pistol, revolver, unknown
          weaponMesh = buildPistol();
          break;
      }

      // Apply global VIEWMODEL_SCALE to the procedural mesh so it matches
      // the same size multiplier as the GLB path.
      weaponMesh.scale.setScalar(VIEWMODEL_SCALE);
      this._group.add(weaponMesh);
      this._proceduralMesh = weaponMesh;
    }
  }

  // ---------------------------------------------------------------------------
  // Arms private helpers
  // ---------------------------------------------------------------------------

  /**
   * Clone the source arms GLTF into the anchor group.
   * Uses SkeletonUtils.clone so the SkinnedMesh's skeleton bones are owned by
   * the cloned hierarchy (plain .clone(true) on a skinned mesh leaves bones
   * referencing the source skeleton — they never update → arms render invisible).
   */
  private _buildArmsClone(): void {
    if (this._armsSource === null) return;

    // Remove old clone if any.
    if (this._armsClone !== null) {
      this._group.remove(this._armsClone);
      this._armsClone = null;
    }
    this._armsBoneMap = new Map();
    this._sleeveMatClone = null;
    this._currentGripFamily = null;

    const clone = SkeletonUtilsClone(this._armsSource) as THREE.Object3D;

    // Scale and offset the arms so they sit at the weapon grip area.
    clone.scale.setScalar(ARMS_SCALE);
    clone.position.copy(ARMS_OFFSET);

    // Apply viewmodel render properties (frustumCulled=false, depthTest/Write).
    clone.traverse((child) => {
      if (child instanceof THREE.SkinnedMesh) {
        child.frustumCulled = false;
        child.castShadow = false;

        // Clone materials so we can tint the sleeve per-team without mutating
        // the shared GLTF source materials.
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        const clonedMats = mats.map((m) => {
          const mc = (m as THREE.Material).clone();
          if (m instanceof THREE.MeshStandardMaterial && mc instanceof THREE.MeshStandardMaterial) {
            // Detect the "Shirt" material by name — that's the sleeve to tint.
            if (m.name === 'Shirt') {
              this._sleeveMatClone = mc;
            }
          }
          return mc;
        });
        child.material = clonedMats.length === 1 ? clonedMats[0] : clonedMats;

        for (const mc of clonedMats) {
          if (mc instanceof THREE.Material) {
            mc.depthTest  = true;
            mc.depthWrite = true;
          }
        }
      }

      // Build bone map from the LIVE cloned hierarchy.
      if (child instanceof THREE.Bone) {
        this._armsBoneMap.set(child.name, child);
      }
    });

    this._group.add(clone);
    this._armsClone = clone;
  }

  /**
   * Apply team sleeve tint to the cloned Shirt material.
   */
  private _applyTeamTint(team: 'CT' | 'T'): void {
    if (this._sleeveMatClone === null) return;
    const hex = teamSleeveColor(team);
    this._sleeveMatClone.color.setHex(hex);
    this._sleeveMatClone.needsUpdate = true;
  }

  /**
   * Apply the grip preset for the given weapon id.
   * Looks up the family via GRIP_PRESETS (keyed by stem), then applies rotations
   * to the arm bones.  Only re-poses when the family changes (weapon switch within
   * the same family e.g. ak47 → m4a4 skips the pose — same two_handed_long pose).
   *
   * Must be called AFTER _buildArmsClone so _armsBoneMap is populated.
   * No-op if arms are not registered (no-arms fallback).
   */
  private _poseArms(id: string): void {
    if (this._armsClone === null || this._armsBoneMap.size === 0) return;

    const stem = THIRD_PERSON_WEAPON_FILES[id] ?? id;
    const preset = GRIP_PRESETS[stem];
    if (preset === undefined) return;

    // Only re-pose when the family changes to avoid unnecessary work.
    if (preset.family === this._currentGripFamily) return;
    this._currentGripFamily = preset.family;

    // Helper: set a bone's local rotation (Euler XYZ) if it exists in the map.
    const setBone = (name: string, rot: readonly [number, number, number]): void => {
      const bone = this._armsBoneMap.get(name);
      if (bone === undefined) return;
      bone.rotation.set(rot[0], rot[1], rot[2], 'XYZ');
    };

    // Apply arm poses.
    setBone('UpperArm.R.001', preset.upperArmR);
    setBone('LowerArm.R.001', preset.lowerArmR);
    setBone('Hand.R.001',     preset.handR);
    setBone('UpperArm.L',     preset.upperArmL);
    setBone('LowerArm.L',     preset.lowerArmL);
    setBone('Hand.L',         preset.handL);

    // Apply finger curl to all finger bones on both sides.
    const curl = preset.fingerCurl;
    for (const boneName of FINGER_BONES_R) {
      setBone(boneName, curl);
    }
    for (const boneName of FINGER_BONES_L) {
      setBone(boneName, curl);
    }
  }
}
