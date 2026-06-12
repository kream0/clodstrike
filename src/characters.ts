import * as THREE from 'three';
import { clone as SkeletonUtilsClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Combatant, Team } from './types';
import { MOVEMENT } from './constants';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKIN_COLOR   = 0xc9a182;
const HELMET_COLOR = 0x3a3a3a;
const GUN_COLOR    = 0x222222;

const TEAM_TORSO: Record<Team, number> = {
  CT: 0x5a7da8,
  T:  0xa8824f,
};

const FALL_DURATION = 0.25;

/**
 * glTF Quaternius models face +Z; our yaw=0 faces −Z (per math.ts convention).
 * Flip the model 180° around Y to align.  The human smoke-test may want to
 * toggle this if the characters turn out backwards.
 */
export const MODEL_YAW_OFFSET: number = Math.PI;

/**
 * Baked-in prop mesh node names that are embedded in the character GLTF but
 * should never be visible in-game (they duplicate a wrist-attached weapon).
 * Exported so tests can assert membership without loading GLTFs.
 */
export const BAKED_PROP_NODES: ReadonlySet<string> = new Set(['Pistol']);

/** Reference walk speed for AnimationMixer timeScale (m/s). */
const REF_WALK_SPEED = 2.6;
/** Reference run speed for AnimationMixer timeScale (m/s). */
const REF_RUN_SPEED  = 4.7;

/** Duration of locomotion crossfade (seconds). */
const CROSSFADE_DURATION = 0.18;

// ---------------------------------------------------------------------------
// Model path registry
// ---------------------------------------------------------------------------

/**
 * Relative paths (from assets/) for the two rigged team character GlTFs.
 * main.ts passes full GLTF objects to setCharacterAssets().
 */
export const CHARACTER_MODEL_PATHS: { ct: string; t: string } = {
  ct: 'models/rigged/ct_operator.gltf',
  t:  'models/rigged/t_phoenix.gltf',
};

/**
 * Relative paths (from assets/) for the 9 weapons_v2 static GLB files.
 * Keyed by file stem.
 */
export const THIRD_PERSON_WEAPON_PATHS: Readonly<Record<string, string>> = {
  pistol:         'models/weapons_v2/pistol.glb',
  revolver:       'models/weapons_v2/revolver.glb',
  smg:            'models/weapons_v2/smg.glb',
  scifi_smg:      'models/weapons_v2/scifi_smg.glb',
  shotgun:        'models/weapons_v2/shotgun.glb',
  assault_rifle:  'models/weapons_v2/assault_rifle.glb',
  assault_rifle_2:'models/weapons_v2/assault_rifle_2.glb',
  sniper_rifle:   'models/weapons_v2/sniper_rifle.glb',
  knife:          'models/weapons_v2/knife.glb',
} as const;

/**
 * Maps every WEAPONS id → file stem for third-person weapon attachment.
 * Grenades or unknown ids → no attachment.
 */
export const THIRD_PERSON_WEAPON_FILES: Record<string, string> = {
  // Knife
  knife: 'knife',

  // Pistols → pistol
  glock:     'pistol',
  usp:       'pistol',
  p250:      'pistol',
  dualies:   'pistol',
  fiveseven: 'pistol',

  // Revolver-style → revolver
  tec9:   'revolver',
  deagle: 'revolver',

  // SMGs → smg
  mac10: 'smg',
  mp9:   'smg',
  mp7:   'smg',
  ump45: 'smg',

  // Sci-fi SMG (P90/Bizon) → scifi_smg
  p90:   'scifi_smg',
  bizon: 'scifi_smg',

  // Shotguns → shotgun
  nova:     'shotgun',
  xm1014:   'shotgun',
  sawedoff: 'shotgun',
  mag7:     'shotgun',

  // Assault rifles → assault_rifle
  m249:  'assault_rifle',
  negev: 'assault_rifle',
  famas: 'assault_rifle',
  galil: 'assault_rifle',
  m4a4:  'assault_rifle',
  ak47:  'assault_rifle',

  // Scoped assault rifles → assault_rifle_2
  aug:   'assault_rifle_2',
  sg553: 'assault_rifle_2',

  // Sniper rifles → sniper_rifle
  ssg08:  'sniper_rifle',
  awp:    'sniper_rifle',
  g3sg1:  'sniper_rifle',
  scar20: 'sniper_rifle',
};

// ---------------------------------------------------------------------------
// Third-person weapon normalization
// NOTE: mirrors viewmodel.ts normalizeWeaponModel approach but is local to
// avoid a circular import (viewmodel.ts already imports from characters.ts).
// ---------------------------------------------------------------------------

/**
 * World-space target lengths (meters) for each weapons_v2 stem, used to
 * normalize third-person weapon holder scale so all weapons read as a
 * plausible real-world size regardless of raw GLB scale.
 *
 * Ground truth raw longest extents from dump-rig:
 *   pistol 1.82, revolver 1.99, smg 4.04, scifi_smg 2.20,
 *   shotgun 5.78, assault_rifle 5.17, assault_rifle_2 5.42,
 *   sniper_rifle 7.29, knife 1.56 (Y-long)
 * Without normalization rifles render ~3-5 m long — invisible as "held."
 */
export const TP_WEAPON_TARGET_LEN: Readonly<Record<string, number>> = {
  knife:           0.30,
  pistol:          0.32,
  revolver:        0.34,
  smg:             0.65,
  scifi_smg:       0.60,
  shotgun:         1.00,
  assault_rifle:   0.95,
  assault_rifle_2: 0.98,
  sniper_rifle:    1.15,
} as const;

/**
 * Fraction of the normalized weapon length that sits behind the grip origin
 * (rear end offset).  After axis alignment the "rear" of the gun (stock end)
 * is placed at +z = GRIP_BACK_FRAC * targetLen so the holder origin sits
 * near the grip/trigger area.  0.12 works for most rifles; knife is smaller.
 */
const GRIP_BACK_FRAC = 0.12;

/**
 * Pure function: compute the uniform scale and axis-alignment rotation needed
 * to normalise a weapon GLB bbox to `targetLen` meters along its longest axis,
 * aligning that axis to -Z (barrel forward in holder space).
 *
 * Mirrors viewmodel.ts normalizeWeaponModel (no import — avoids circular dep).
 * Cross-reference: viewmodel.ts `normalizeWeaponModel` for the first-person path.
 *
 * @param bbox      - World-space bbox of the raw source GLB (before any scaling).
 * @param targetLen - Desired world-space length of the longest axis (meters).
 * @returns { scale, rotX, rotY } — apply scale uniformly; rotations are XYZ Euler.
 */
export function tpComputeWeaponNorm(
  bbox: THREE.Box3,
  targetLen: number,
): { scale: number; rotX: number; rotY: number; centerZ: number } {
  const size = new THREE.Vector3();
  bbox.getSize(size);

  const maxExtent = Math.max(size.x, size.y, size.z, 0.001);
  const scale = targetLen / maxExtent;

  // Determine which axis is longest and align it to -Z
  let rotY = 0;
  let rotX = 0;
  if (size.x >= size.y && size.x >= size.z) {
    // X-long (pistols, rifles): rotate 90° around Y → -Z becomes the long axis
    rotY = Math.PI / 2;
  } else if (size.y >= size.x && size.y >= size.z) {
    // Y-long (knife): rotate -90° around X → -Z becomes the long axis
    rotX = -Math.PI / 2;
  }
  // else Z-long: already aligned, no rotation needed

  // After axis alignment and scaling the normalized length along -Z = targetLen.
  // centerZ in holder space: place rear end at +GRIP_BACK_FRAC * targetLen from origin.
  // Bbox center of the clone (after rotation) is at -0.5 * targetLen along -Z,
  // so we shift it +z by (0.5 - GRIP_BACK_FRAC) * targetLen.
  const centerZ = (0.5 - GRIP_BACK_FRAC) * targetLen;

  return { scale, rotX, rotY, centerZ };
}

// ---------------------------------------------------------------------------
// Third-person weapon attach offsets — holder local to Wrist.R
// (now sane because sizes are normalized; small tweaks only)
// ---------------------------------------------------------------------------

export interface TpAttachOffset {
  /** Position of the holder relative to Wrist.R (meters, model-local after normalScale). */
  pos: readonly [number, number, number];
  /** Additional Euler XYZ rotation on the holder (radians). */
  rot: readonly [number, number, number];
}

const _DEFAULT_TP_ATTACH: TpAttachOffset = {
  pos: [0, 0, 0],
  rot: [0, 0, 0],
};

/**
 * Per-stem attach offsets for the normalized weapon holder relative to Wrist.R.
 * Exported for tuning from outside (e.g. debug UI, tests).
 */
export const TP_WEAPON_ATTACH_OFFSETS: Readonly<Record<string, TpAttachOffset>> = {
  knife: {
    pos: [0.00,  0.00, -0.05],
    rot: [0.00,  0.00,  0.40],  // slight outward cant
  },
  pistol: {
    pos: [0.00,  0.00,  0.00],
    rot: [0.00,  0.00,  0.00],
  },
  revolver: {
    pos: [0.00,  0.00,  0.00],
    rot: [0.00,  0.00,  0.00],
  },
  smg: {
    pos: [0.00,  0.00, -0.05],
    rot: [0.00,  0.00,  0.00],
  },
  scifi_smg: {
    pos: [0.00,  0.00, -0.05],
    rot: [0.00,  0.00,  0.00],
  },
  shotgun: {
    pos: [0.00,  0.00, -0.08],
    rot: [0.00,  0.00,  0.00],
  },
  assault_rifle: {
    pos: [0.00,  0.00, -0.08],
    rot: [0.00,  0.00,  0.00],
  },
  assault_rifle_2: {
    pos: [0.00,  0.00, -0.08],
    rot: [0.00,  0.00,  0.00],
  },
  sniper_rifle: {
    pos: [0.00,  0.00, -0.10],
    rot: [0.00,  0.00,  0.00],
  },
} as const;

// ---------------------------------------------------------------------------
// Gun-hold arm pose constants — override after mixer.update every frame
// for any living combatant with a weapon attached.
//
// Bone chain (Quaternius rig): Shoulder.R, UpperArm.R, LowerArm.R, Wrist.R
//                             (mirrored .L side).
// At rest (arms hang at sides): all rotations ≈ 0 in local space.
// The model faces +Z at rest (before MODEL_YAW_OFFSET π flip),
// but local bone axes are defined in Blender rest pose (arms down).
// FK chain: rotate Shoulder to lift arm, UpperArm to angle forearm,
// LowerArm to bend elbow, Wrist to orient hand.
//
// Positive X rotation on arm bones = flex forward (raise arm).
// Positive Y rotation = abduct outward.
// ---------------------------------------------------------------------------

export type TpHoldFamily = 'twoHanded' | 'pistol' | 'knife';

export interface TpArmPose {
  family: TpHoldFamily;
  /** Shoulder.R local Euler XYZ (radians). */
  shoulderR: readonly [number, number, number];
  /** UpperArm.R local Euler XYZ (radians). */
  upperArmR: readonly [number, number, number];
  /** LowerArm.R local Euler XYZ (radians). */
  lowerArmR: readonly [number, number, number];
  /** Wrist.R local Euler XYZ (radians). */
  wristR:    readonly [number, number, number];
  /** Shoulder.L local Euler XYZ (radians). */
  shoulderL: readonly [number, number, number];
  /** UpperArm.L local Euler XYZ (radians). */
  upperArmL: readonly [number, number, number];
  /** LowerArm.L local Euler XYZ (radians). */
  lowerArmL: readonly [number, number, number];
  /** Wrist.L local Euler XYZ (radians). */
  wristL:    readonly [number, number, number];
}

/**
 * Per-family arm-pose constants for third-person gun-hold override.
 * Applied post-mixer.update every frame when alive + weapon attached.
 * Legs/torso/head keep full clip animation — only arm chain is overridden.
 * Exported for tuning and tests.
 *
 * Derivation notes (Quaternius rig, arms hang at rest):
 *   - Lifting the arm to chest height requires ~1.0 rad flex (X) on UpperArm.
 *   - Bringing forearm horizontal requires ~0.9 rad on LowerArm.
 *   - Shoulder adds shoulder-forward shrug: small +X, slight abduction.
 *   - The character faces +Z at rest (MODEL_YAW_OFFSET π not yet applied when
 *     bone rotations are set — we operate in armature local space).
 *   - twoHanded: right arm at grip (chest-high forearm), left arm across to foregrip.
 *   - pistol: right arm forward-low, left supporting loosely.
 *   - knife: right arm low-forward (blade at side), left relaxed.
 */
export const TP_HOLD_POSES: Readonly<Record<TpHoldFamily, TpArmPose>> = {
  twoHanded: {
    family:    'twoHanded',
    shoulderR: [ 0.40,  0.10, -0.15],
    upperArmR: [ 1.05,  0.25, -0.10],
    lowerArmR: [ 0.90,  0.00,  0.00],
    wristR:    [-0.10,  0.00,  0.00],
    shoulderL: [ 0.30, -0.10,  0.10],
    upperArmL: [ 1.20, -0.30,  0.10],
    lowerArmL: [ 0.95,  0.00,  0.00],
    wristL:    [-0.10,  0.00,  0.00],
  },
  pistol: {
    family:    'pistol',
    shoulderR: [ 0.30,  0.10, -0.10],
    upperArmR: [ 0.85,  0.20, -0.10],
    lowerArmR: [ 0.75,  0.00,  0.00],
    wristR:    [ 0.00,  0.00,  0.00],
    shoulderL: [ 0.20, -0.05,  0.05],
    upperArmL: [ 0.70, -0.15,  0.05],
    lowerArmL: [ 0.65,  0.00,  0.00],
    wristL:    [ 0.00,  0.00,  0.00],
  },
  knife: {
    family:    'knife',
    shoulderR: [ 0.20,  0.05, -0.05],
    upperArmR: [ 0.60,  0.15, -0.05],
    lowerArmR: [ 0.55,  0.00,  0.00],
    wristR:    [ 0.20, -0.25,  0.00],
    shoulderL: [ 0.10,  0.00,  0.00],
    upperArmL: [ 0.20,  0.00,  0.00],
    lowerArmL: [ 0.20,  0.00,  0.00],
    wristL:    [ 0.00,  0.00,  0.00],
  },
} as const;

/**
 * Map weapon stem → hold family for arm-pose selection.
 * Exported for tests.
 */
export const TP_STEM_TO_FAMILY: Readonly<Record<string, TpHoldFamily>> = {
  knife:           'knife',
  pistol:          'pistol',
  revolver:        'pistol',
  smg:             'twoHanded',
  scifi_smg:       'twoHanded',
  shotgun:         'twoHanded',
  assault_rifle:   'twoHanded',
  assault_rifle_2: 'twoHanded',
  sniper_rifle:    'twoHanded',
} as const;

// ---------------------------------------------------------------------------
// Preloaded source assets (set once by integration)
// ---------------------------------------------------------------------------

interface CharacterAssets {
  gltf:           GLTF;
  clips:          THREE.AnimationClip[];
  /** Uniform scale to normalise model to PLAYER_HEIGHT. */
  normalScale:    number;
}

const _sourceAssets: { ct: CharacterAssets | null; t: CharacterAssets | null } = {
  ct: null,
  t:  null,
};

/** Registry of third-person weapon models keyed by file stem. */
const _weaponModels: Map<string, THREE.Object3D> = new Map();

// ---------------------------------------------------------------------------
// setCharacterAssets — replaces old setCharacterModels
// ---------------------------------------------------------------------------

/**
 * Register preloaded rigged character GlTFs for each team.
 * Call once after loading; all subsequent createCharacterMesh calls use these.
 * Idempotent — safe to call multiple times.
 */
export function setCharacterAssets(assets: { ct?: GLTF; t?: GLTF }): void {
  if (assets.ct !== undefined) {
    _sourceAssets.ct = _buildCharacterAssets(assets.ct);
  }
  if (assets.t !== undefined) {
    _sourceAssets.t = _buildCharacterAssets(assets.t);
  }
}

/**
 * Legacy compatibility shim: accepts Object3D scenes (used by old code paths).
 * @deprecated Use setCharacterAssets instead.
 */
export function setCharacterModels(_models: { ct?: THREE.Object3D; t?: THREE.Object3D }): void {
  // No-op: the rigged pipeline requires full GLTF with animation clips.
  // This shim prevents crashes from old call sites; real setup goes via setCharacterAssets.
}

function _buildCharacterAssets(gltf: GLTF): CharacterAssets {
  const box    = new THREE.Box3().setFromObject(gltf.scene);
  const height = box.max.y - box.min.y;
  const normalScale = normalizeHeight(height > 0 ? height : 1.8, MOVEMENT.PLAYER_HEIGHT);
  return {
    gltf,
    clips:       gltf.animations,
    normalScale,
  };
}

// ---------------------------------------------------------------------------
// setThirdPersonWeaponModels
// ---------------------------------------------------------------------------

/**
 * Register preloaded static weapon models keyed by file stem
 * (e.g. 'pistol', 'assault_rifle', 'knife').
 * Call once after loading. Idempotent.
 */
export function setThirdPersonWeaponModels(models: Record<string, THREE.Object3D>): void {
  for (const [stem, obj] of Object.entries(models)) {
    _weaponModels.set(stem, obj);
  }
}

// ---------------------------------------------------------------------------
// Pure animation helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Normalise a source height H to a target height T.
 * Returns the uniform scale factor T/H.
 */
export function normalizeHeight(sourceHeight: number, targetHeight: number): number {
  if (sourceHeight <= 0) return 1;
  return targetHeight / sourceHeight;
}

/**
 * Death rotation around Z axis — falls sideways.
 * @param t - normalised progress [0,1]
 */
export function deathRotationZ(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return (Math.PI / 2) * clamped;
}

/**
 * Pick the locomotion clip name based on velocity-derived quantities.
 *
 * @param fwd   - velocity component in model-forward direction (+ve = forward)
 * @param right - velocity component in model-right direction (+ve = right)
 * @param speed - horizontal speed (m/s)
 * @param onGround  - whether the combatant is on the ground
 * @param alive     - whether the combatant is alive
 *
 * Yaw convention: yaw=0 faces −Z in world space (math.ts).
 * Model-forward = −Z world = (0,0,−1) at yaw=0.
 * Model-right   = +X world = (1,0,0)  at yaw=0.
 */
export function pickLocomotionClip(
  fwd:   number,
  right: number,
  speed: number,
  onGround: boolean,
  alive: boolean,
): string {
  if (!alive)     return 'Death';
  if (!onGround)  return 'Idle_Gun';
  if (speed <= 0.3) return 'Idle_Gun';
  if (speed < 3.0)  return 'Walk';

  // Running — dominant axis decides strafe vs forward/back
  if (Math.abs(fwd) >= Math.abs(right)) {
    return fwd > 0 ? 'Run' : 'Run_Back';
  }
  return right > 0 ? 'Run_Right' : 'Run_Left';
}

/**
 * Project world-space XZ velocity onto model-local forward and right axes.
 *
 * Yaw convention (math.ts): yaw=0 faces −Z in world space.
 *   model-forward = (−sin(yaw), 0, −cos(yaw))  (the direction the character faces)
 *   model-right   = (−sin(yaw−π/2), 0, −cos(yaw−π/2))
 *                 = (cos(yaw), 0, −sin(yaw))
 *
 * Returns { fwd, right } in m/s.
 */
export function projectVelocityToLocal(
  vx: number,
  vz: number,
  yaw: number,
): { fwd: number; right: number } {
  // model-forward unit vector
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  // model-right unit vector
  const rx =  Math.cos(yaw);
  const rz = -Math.sin(yaw);

  const fwd   = vx * fx + vz * fz;
  const right = vx * rx + vz * rz;
  return { fwd, right };
}

/**
 * Clamp AnimationMixer timeScale for foot-slide control.
 */
export function locomotionTimeScale(speed: number, refSpeed: number): number {
  if (refSpeed <= 0) return 1;
  const raw = speed / refSpeed;
  return Math.max(0.6, Math.min(1.6, raw));
}

/**
 * Compute crouch Y offset for the Hips bone in model units.
 * factor in [0,1]; 0=standing, 1=fully crouched.
 * normalScale maps between world metres and model units (model * normalScale = world).
 */
export function crouchHipsOffsetY(factor: number, normalScale: number): number {
  if (factor <= 0) return 0;
  const worldDelta = (1 - MOVEMENT.PLAYER_HEIGHT_CROUCH / MOVEMENT.PLAYER_HEIGHT) * MOVEMENT.PLAYER_HEIGHT;
  // Convert world offset to model-local units (divide by normalScale)
  return -(worldDelta * factor) / normalScale;
}

/**
 * Abdomen forward tilt (rad) for crouching hunch.
 */
export function crouchAbdomenTilt(factor: number): number {
  return 0.25 * factor;
}

/**
 * Resolve a clip name defensively: tries the name, falls back to 'Idle',
 * then returns null if even 'Idle' is missing.
 */
export function resolveClipName(
  name: string,
  clips: THREE.AnimationClip[],
): THREE.AnimationClip | null {
  const direct = THREE.AnimationClip.findByName(clips, name);
  if (direct) return direct;
  const idle = THREE.AnimationClip.findByName(clips, 'Idle');
  return idle ?? null;
}

// ---------------------------------------------------------------------------
// Legacy helpers kept for backward-compat in tests that haven't been deleted
// ---------------------------------------------------------------------------

/** @deprecated Use pickLocomotionClip + AnimationMixer instead. */
export function legSwingAngle(phase: number, isLeft: boolean, amplitude: number): number {
  return Math.sin(isLeft ? phase : phase + Math.PI) * amplitude;
}

/** @deprecated */
export function armSwingAngle(phase: number, isLeft: boolean, amplitude: number): number {
  return Math.sin(isLeft ? phase + Math.PI : phase) * amplitude;
}

/** @deprecated */
export function breathingBobY(breathPhase: number): number {
  return Math.sin(breathPhase) * 0.012;
}

/** @deprecated */
export function crouchRootOffsetY(crouching: boolean): number {
  if (!crouching) return 0;
  const ratio = MOVEMENT.PLAYER_HEIGHT_CROUCH / MOVEMENT.PLAYER_HEIGHT;
  return -(1 - ratio) * 2.7 * 0.35;
}

// ---------------------------------------------------------------------------
// Per-character animation state stored on the group
// ---------------------------------------------------------------------------

interface ArmBoneCache {
  shoulderR: THREE.Bone | null;
  upperArmR: THREE.Bone | null;
  lowerArmR: THREE.Bone | null;
  wristR:    THREE.Bone | null;
  shoulderL: THREE.Bone | null;
  upperArmL: THREE.Bone | null;
  lowerArmL: THREE.Bone | null;
  wristL:    THREE.Bone | null;
}

interface AnimMixerState {
  mixer:       THREE.AnimationMixer;
  actions:     Map<string, THREE.AnimationAction>;
  /** The name of the REQUESTED clip (set before fallback resolution). */
  currentClip: string;
  /** The action that _crossfadeTo most recently handed control to (null before first crossfade). */
  activeAction: THREE.AnimationAction | null;
  /** Smoothed crouch factor [0,1]. */
  crouchFactor: number;
  /** Cached normalScale for this instance (used to compensate weapon attach scale). */
  normalScale: number;
  /** Cached ref to the Hips bone (may be null if absent). */
  hipsBone: THREE.Bone | null;
  /** Cached ref to the Abdomen bone (may be null if absent). */
  abdomenBone: THREE.Bone | null;
  /** Cached ref to the Wrist.R bone for weapon attachment. */
  wristRBone: THREE.Object3D | null;
  /** Currently attached weapon stem ('' = none). */
  attachedStem: string;
  /** Normalized weapon holders cached per stem (avoid re-building on every switch). */
  weaponCache: Map<string, THREE.Group>;
  /** The currently visible weapon holder child (or null). */
  currentWeaponAttach: THREE.Object3D | null;
  /** Cached arm bone refs for gun-hold pose override. */
  armBones: ArmBoneCache;
  /** Cached wrist world scale (measured once, defensive against upstream changes). */
  wristWorldScale: THREE.Vector3 | null;
}

interface MeshState {
  prevAlive:  boolean;
  deadTimer:  number;
  team:       Team;
  isRigged:   boolean;
  mixerState: AnimMixerState | null;
}

type CharGroup = THREE.Group & { _cs2State: MeshState };

// ---------------------------------------------------------------------------
// Procedural fallback builder (unchanged from original)
// ---------------------------------------------------------------------------

function buildProceduralMesh(team: Team): THREE.Group {
  const group = new THREE.Group();
  const torsoColor = TEAM_TORSO[team];

  function box(
    sx: number, sy: number, sz: number, color: number,
    cx = 0, cy = 0, cz = 0,
  ): THREE.Mesh {
    const geo  = new THREE.BoxGeometry(sx, sy, sz);
    const mat  = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx, cy, cz);
    mesh.castShadow    = true;
    mesh.receiveShadow = false;
    return mesh;
  }

  const legH = 0.85; const legW = 0.18; const legD = 0.20;
  const leftLeg  = box(legW, legH, legD, torsoColor, -0.11, legH / 2, 0);
  const rightLeg = box(legW, legH, legD, torsoColor,  0.11, legH / 2, 0);

  const torsoH = 0.65; const torsoY = 0.85 + torsoH / 2;
  const torso  = box(0.44, torsoH, 0.26, torsoColor, 0, torsoY, 0);

  const armH = 0.55; const armW = 0.14; const armD = 0.14; const armY = 0.85 + 0.45;
  const leftArm  = box(armW, armH, armD, torsoColor, -0.29, armY - armH / 2 + 0.1, 0.02);
  const rightArm = box(armW, armH, armD, torsoColor,  0.29, armY - armH / 2 + 0.1, 0.02);

  const headH = 0.22; const headY = 1.50 + headH / 2;
  const head  = box(0.24, headH, 0.26, SKIN_COLOR, 0, headY, 0);

  const helmetH = 0.11; const helmetY = 1.50 + headH + helmetH / 2;
  const helmet  = box(0.27, helmetH, 0.28, HELMET_COLOR, 0, helmetY, 0.0);

  const gun = box(0.06, 0.12, 0.38, GUN_COLOR, 0.20, 1.05, -0.22);

  group.add(leftLeg, rightLeg, torso, leftArm, rightArm, head, helmet, gun);
  return group;
}

// ---------------------------------------------------------------------------
// Rigged GLB clone builder
// ---------------------------------------------------------------------------

function _findBone(root: THREE.Object3D, name: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((obj) => {
    if (found === null && obj.name === name) found = obj;
  });
  return found;
}

function _findBoneTyped(root: THREE.Object3D, name: string): THREE.Bone | null {
  let found: THREE.Bone | null = null;
  root.traverse((obj) => {
    if (found === null && obj.name === name && obj instanceof THREE.Bone) {
      found = obj;
    }
  });
  return found;
}

function buildRiggedMesh(assets: CharacterAssets): {
  outerGroup: THREE.Group;
  mixerState: AnimMixerState;
} {
  // SkeletonUtils.clone creates an independent rig per instance
  const clonedRoot = SkeletonUtilsClone(assets.gltf.scene) as THREE.Object3D;

  // Apply castShadow + frustumCulled=false on every SkinnedMesh;
  // also hide any baked-in prop meshes that duplicate wrist-attached weapons.
  clonedRoot.traverse((child) => {
    if (BAKED_PROP_NODES.has(child.name)) {
      child.visible = false;
    }
    if (child instanceof THREE.SkinnedMesh) {
      child.castShadow      = true;
      child.receiveShadow   = false;
      child.frustumCulled   = false;
    } else if (child instanceof THREE.Mesh) {
      child.castShadow    = true;
      child.receiveShadow = false;
    }
  });

  // Inner group: carries normalisation scale + yaw offset
  const innerGroup = new THREE.Group();
  innerGroup.scale.setScalar(assets.normalScale);
  innerGroup.rotation.y = MODEL_YAW_OFFSET;
  innerGroup.add(clonedRoot);

  // Outer group: game positions it, sets rotation.y = c.yaw
  const outerGroup = new THREE.Group();
  outerGroup.add(innerGroup);

  // Build AnimationMixer over the cloned scene root
  const mixer   = new THREE.AnimationMixer(clonedRoot);
  const actions = new Map<string, THREE.AnimationAction>();
  for (const clip of assets.clips) {
    const action = mixer.clipAction(clip);
    actions.set(clip.name, action);
  }

  // Start with Idle_Gun (or Idle fallback)
  const startClip = assets.clips.find(c => c.name === 'Idle_Gun') ??
                    assets.clips.find(c => c.name === 'Idle')      ??
                    assets.clips[0];
  let currentClip = 'Idle_Gun';
  if (startClip) {
    const startAction = actions.get(startClip.name);
    if (startAction) {
      startAction.reset().play();
      currentClip = startClip.name;
    }
  }

  const hipsBone     = _findBoneTyped(clonedRoot, 'Hips');
  const abdomenBone  = _findBoneTyped(clonedRoot, 'Abdomen');
  const wristRBone   = _findBone(clonedRoot, 'Wrist.R');

  // Cache arm bone references for gun-hold pose overrides
  const armBones: ArmBoneCache = {
    shoulderR: _findBoneTyped(clonedRoot, 'Shoulder.R'),
    upperArmR: _findBoneTyped(clonedRoot, 'UpperArm.R'),
    lowerArmR: _findBoneTyped(clonedRoot, 'LowerArm.R'),
    wristR:    _findBoneTyped(clonedRoot, 'Wrist.R'),
    shoulderL: _findBoneTyped(clonedRoot, 'Shoulder.L'),
    upperArmL: _findBoneTyped(clonedRoot, 'UpperArm.L'),
    lowerArmL: _findBoneTyped(clonedRoot, 'LowerArm.L'),
    wristL:    _findBoneTyped(clonedRoot, 'Wrist.L'),
  };

  const mixerState: AnimMixerState = {
    mixer,
    actions,
    currentClip,
    activeAction: startClip ? (actions.get(startClip.name) ?? null) : null,
    crouchFactor: 0,
    normalScale:  assets.normalScale,
    hipsBone,
    abdomenBone,
    wristRBone,
    attachedStem:        '',
    weaponCache:         new Map(),
    currentWeaponAttach: null,
    armBones,
    wristWorldScale:     null,
  };

  return { outerGroup, mixerState };
}

// ---------------------------------------------------------------------------
// createCharacterMesh
// ---------------------------------------------------------------------------

export function createCharacterMesh(team: Team): THREE.Group {
  const assets = team === 'CT' ? _sourceAssets.ct : _sourceAssets.t;

  let group: THREE.Group;
  let isRigged = false;
  let mixerState: AnimMixerState | null = null;

  if (assets !== null) {
    const built = buildRiggedMesh(assets);
    group       = built.outerGroup;
    mixerState  = built.mixerState;
    isRigged    = true;
  } else {
    group = buildProceduralMesh(team);
  }

  const state: MeshState = {
    prevAlive:  true,
    deadTimer:  -1,
    team,
    isRigged,
    mixerState,
  };
  (group as CharGroup)._cs2State = state;

  return group;
}

// ---------------------------------------------------------------------------
// updateCharacterMesh — called every render frame
// ---------------------------------------------------------------------------

export function updateCharacterMesh(
  group: THREE.Group,
  c: Combatant,
  dt: number,
  _now: number,
): void {
  const state = (group as Partial<CharGroup>)._cs2State;
  if (!state) return;

  // Position (feet-anchored).
  group.position.set(c.pos.x, c.pos.y, c.pos.z);
  // Outer group rotation = c.yaw; model yaw offset is baked into innerGroup.rotation.y
  group.rotation.y = c.yaw;

  if (state.isRigged && state.mixerState !== null) {
    _updateRiggedMesh(group, state, c, dt);
  } else {
    _updateProceduralMesh(group, state, c, dt, _now);
  }
}

// ---------------------------------------------------------------------------
// updateVisual — alias for external callers (game.ts compatible)
// ---------------------------------------------------------------------------

export function updateVisual(
  group: THREE.Group,
  c: Combatant,
  now: number,
  dt: number,
): void {
  updateCharacterMesh(group, c, dt, now);
}

// ---------------------------------------------------------------------------
// Internal: rigged-path update
// ---------------------------------------------------------------------------

function _updateRiggedMesh(
  group: THREE.Group,
  state: MeshState,
  c: Combatant,
  dt: number,
): void {
  const ms = state.mixerState!;

  // --- Death transition ---
  const justDied    = state.prevAlive && !c.alive;
  const justRevived = !state.prevAlive && c.alive;
  state.prevAlive   = c.alive;

  if (justDied) {
    state.deadTimer = 0;
    _crossfadeTo(ms, 'Death', 0.1, false);
  }
  if (justRevived) {
    state.deadTimer = -1;
    group.rotation.z = 0;
    group.position.y = c.pos.y;
    ms.activeAction = null;
    ms.mixer.stopAllAction();
    _crossfadeTo(ms, 'Idle_Gun', 0, true);
  }

  if (!c.alive) {
    if (state.deadTimer >= 0) {
      state.deadTimer += dt;
    }
    const t = state.deadTimer < 0 ? 1 : Math.min(1, state.deadTimer / FALL_DURATION);
    group.rotation.z = deathRotationZ(t);
    group.position.y = c.pos.y - 0.1 * t;
    ms.mixer.update(dt);
    return;
  }

  // Reset death visual
  group.rotation.z = 0;

  const vx = c.vel.x;
  const vz = c.vel.z;
  const speed = Math.sqrt(vx * vx + vz * vz);

  const { fwd, right } = projectVelocityToLocal(vx, vz, c.yaw);
  const targetClip = pickLocomotionClip(fwd, right, speed, c.onGround, true);

  // --- Locomotion crossfade ---
  if (targetClip !== ms.currentClip) {
    _crossfadeTo(ms, targetClip, CROSSFADE_DURATION, true);
  }

  // --- timeScale for foot-slide control ---
  // Use ms.activeAction (the action currently playing) rather than a name lookup, so
  // timeScale always drives the action actually in control even mid-crossfade.
  if (ms.activeAction !== null) {
    const activeClipName = ms.activeAction.getClip().name;
    if (activeClipName === 'Walk') {
      ms.activeAction.timeScale = locomotionTimeScale(speed, REF_WALK_SPEED);
    } else if (
      activeClipName === 'Run' || activeClipName === 'Run_Back' ||
      activeClipName === 'Run_Left' || activeClipName === 'Run_Right'
    ) {
      ms.activeAction.timeScale = locomotionTimeScale(speed, REF_RUN_SPEED);
    } else {
      ms.activeAction.timeScale = 1;
    }
  }

  // --- Advance mixer ---
  ms.mixer.update(dt);

  // --- Post-mixer: crouch bone adjustment ---
  const targetCrouch = c.crouching ? 1 : 0;
  ms.crouchFactor += (targetCrouch - ms.crouchFactor) * Math.min(1, 14 * dt);

  const assets = (c.team === 'CT') ? _sourceAssets.ct : _sourceAssets.t;
  const ns = assets?.normalScale ?? 1;

  if (ms.hipsBone !== null && ms.crouchFactor > 0.001) {
    const offset = crouchHipsOffsetY(ms.crouchFactor, ns);
    ms.hipsBone.position.y += offset;
  }
  if (ms.abdomenBone !== null && ms.crouchFactor > 0.001) {
    const tilt = crouchAbdomenTilt(ms.crouchFactor);
    ms.abdomenBone.rotation.x = tilt;
  } else if (ms.abdomenBone !== null) {
    ms.abdomenBone.rotation.x = 0;
  }

  // --- Third-person weapon attachment ---
  _updateWeaponAttachment(ms, c);

  // --- Post-mixer: gun-hold arm pose override ---
  // Applied after attachment so the wrist already has the correct weapon child.
  // When dead: no override (Death clip plays arms naturally).
  // When alive + weapon: override arm chain each frame for consistent hold pose
  // across all locomotion clips (Walk/Run/strafe arms swing; this pins them).
  // Even Idle_Gun gets the override for grip consistency with moving states.
  if (ms.attachedStem !== '') {
    _applyGunHoldPose(ms);
  }
}

// ---------------------------------------------------------------------------
// Crossfade helper
// ---------------------------------------------------------------------------

function _crossfadeTo(
  ms: AnimMixerState,
  clipName: string,
  duration: number,
  loop: boolean,
): void {
  // Record the REQUESTED name immediately so the per-frame guard (targetClip !== ms.currentClip)
  // suppresses re-requests even when the clip is missing and falls back to a shared fallback.
  ms.currentClip = clipName;

  const target = ms.actions.get(clipName) ??
                 ms.actions.get('Idle')    ??
                 null;
  if (target === null) return;

  // Bail out early if the resolved target is already the active action.
  // This prevents self-crossfade when two distinct missing clips both resolve to the same
  // fallback (e.g. 'Idle').  Unlike isRunning(), this does NOT bail on a mid-fade-out
  // action — a legitimate Walk→Run→Walk within a fade window will correctly re-enter Walk.
  if (target === ms.activeAction) return;

  const prevAction = ms.activeAction;

  target.reset();
  target.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  if (!loop) {
    target.clampWhenFinished = true;
  }

  if (prevAction !== null && duration > 0) {
    target.fadeIn(duration);
    prevAction.fadeOut(duration);
  } else if (prevAction !== null) {
    prevAction.stop();
  }
  target.play();

  ms.activeAction = target;
}

// ---------------------------------------------------------------------------
// Gun-hold arm pose override
// ---------------------------------------------------------------------------

// Module-scope scratch vector — avoids per-frame heap allocation.
const _scratchWristScale = new THREE.Vector3();

/**
 * Apply the static gun-hold arm pose to the arm bone chain post mixer.update.
 * Only called when alive + weapon attached. Does not touch legs/torso/head.
 *
 * Design: override arm bone local Euler rotations directly after mixer.update.
 * The mixer would overwrite these next frame's mixer.update, so we re-apply
 * every frame (cheap: just 8 rotation.set calls — no allocation).
 */
function _applyGunHoldPose(ms: AnimMixerState): void {
  const family = TP_STEM_TO_FAMILY[ms.attachedStem];
  if (family === undefined) return;

  const pose = TP_HOLD_POSES[family];
  const ab = ms.armBones;

  if (ab.shoulderR !== null) ab.shoulderR.rotation.set(pose.shoulderR[0], pose.shoulderR[1], pose.shoulderR[2]);
  if (ab.upperArmR !== null) ab.upperArmR.rotation.set(pose.upperArmR[0], pose.upperArmR[1], pose.upperArmR[2]);
  if (ab.lowerArmR !== null) ab.lowerArmR.rotation.set(pose.lowerArmR[0], pose.lowerArmR[1], pose.lowerArmR[2]);
  if (ab.wristR    !== null) ab.wristR.rotation.set(   pose.wristR[0],    pose.wristR[1],    pose.wristR[2]);

  if (ab.shoulderL !== null) ab.shoulderL.rotation.set(pose.shoulderL[0], pose.shoulderL[1], pose.shoulderL[2]);
  if (ab.upperArmL !== null) ab.upperArmL.rotation.set(pose.upperArmL[0], pose.upperArmL[1], pose.upperArmL[2]);
  if (ab.lowerArmL !== null) ab.lowerArmL.rotation.set(pose.lowerArmL[0], pose.lowerArmL[1], pose.lowerArmL[2]);
  if (ab.wristL    !== null) ab.wristL.rotation.set(   pose.wristL[0],    pose.wristL[1],    pose.wristL[2]);
}

// ---------------------------------------------------------------------------
// Weapon attachment update — builds normalized holder Groups
// ---------------------------------------------------------------------------

/**
 * Build a normalized weapon holder Group for a given stem.
 * The holder wraps the weapon clone, applies axis alignment + scale so the
 * longest axis equals TP_WEAPON_TARGET_LEN[stem] in world space.
 *
 * The holder is what attaches under Wrist.R; the holder's own scale compensates
 * the ancestor normalScale so the world size equals the target length.
 *
 * Design mirrors viewmodel.ts normalizeWeaponModel but operates in 3P space.
 */
function _buildNormalizedHolder(
  stem: string,
  sourceModel: THREE.Object3D,
  ancestorWorldScale: THREE.Vector3,
): THREE.Group {
  const targetLen = TP_WEAPON_TARGET_LEN[stem] ?? 0.50;

  // Compute source bbox ONCE on the un-scaled source (clone for measurement only)
  const measureClone = sourceModel.clone(true);
  const bbox = new THREE.Box3().setFromObject(measureClone);

  const { scale, rotX, rotY, centerZ } = tpComputeWeaponNorm(bbox, targetLen);

  // The weapon clone will be the child of the holder Group.
  const weaponClone = sourceModel.clone(true);

  // Align and scale the clone inside the holder.
  // The holder itself is unit scale (world compensation handled below).
  weaponClone.rotation.set(rotX, rotY, 0);
  weaponClone.position.set(0, 0, centerZ);

  // Holder: compensate for ancestor scale so world size = target.
  // ancestor = innerGroup (normalScale); CharacterArmature is identity; bones inherit armature.
  // holderScale * ancestorScale * weaponGeomScale = targetLen / maxExtent * 1
  // → holderScale = scale / ancestorScale (per axis — uniform, so use x)
  const ancestorUniform = ancestorWorldScale.x > 0 ? ancestorWorldScale.x : 1;
  const holderScale = scale / ancestorUniform;

  const holder = new THREE.Group();
  holder.scale.setScalar(holderScale);
  holder.add(weaponClone);

  // Apply per-stem attach offset + rotation on the holder
  const attachOffset = TP_WEAPON_ATTACH_OFFSETS[stem] ?? _DEFAULT_TP_ATTACH;
  const [px, py, pz] = attachOffset.pos;
  const [arx, ary, arz] = attachOffset.rot;
  holder.position.set(px, py, pz);
  // Additional attach rotation stacks on top of holder (set after scale to avoid
  // affecting scale compensation — holder.rotation is independent of scale).
  holder.rotation.set(arx, ary, arz);

  return holder;
}

function _updateWeaponAttachment(ms: AnimMixerState, c: Combatant): void {
  // Resolve current weapon id
  const slot = c.inventory.activeSlot;
  const weaponState = c.inventory[slot];
  const weaponId = weaponState?.def?.id ?? '';

  // Map to file stem
  const stem = THIRD_PERSON_WEAPON_FILES[weaponId] ?? '';

  if (stem === ms.attachedStem) return; // no change

  // Remove old attachment
  if (ms.currentWeaponAttach !== null && ms.wristRBone !== null) {
    ms.wristRBone.remove(ms.currentWeaponAttach);
    ms.currentWeaponAttach = null;
  }
  ms.attachedStem = stem;

  if (stem === '' || ms.wristRBone === null) return;

  // Check if source model is available
  const sourceModel = _weaponModels.get(stem);
  if (sourceModel === undefined) return;

  // Use cached normalized holder or build a new one
  let holder = ms.weaponCache.get(stem);
  if (holder === undefined) {
    // Measure ancestor world scale once (defensive — accounts for future upstream changes).
    // The wrist bone's parent chain contains innerGroup (normalScale) as ancestor.
    // We use the innerGroup's scale directly (normalScale uniform) but measure defensively.
    if (ms.wristWorldScale === null) {
      ms.wristRBone.getWorldScale(_scratchWristScale);
      // wristWorldScale ≈ normalScale (bone inherits innerGroup scale)
      // Store a copy (Vector3 is mutable — clone it)
      ms.wristWorldScale = _scratchWristScale.clone();
    }
    holder = _buildNormalizedHolder(stem, sourceModel, ms.wristWorldScale);
    ms.weaponCache.set(stem, holder);
  }

  ms.wristRBone.add(holder);
  ms.currentWeaponAttach = holder;
}

// ---------------------------------------------------------------------------
// Internal: procedural-path update (original logic preserved)
// ---------------------------------------------------------------------------

function _updateProceduralMesh(
  group: THREE.Group,
  state: MeshState,
  c: Combatant,
  dt: number,
  _now: number,
): void {
  const targetScaleY = c.crouching
    ? MOVEMENT.PLAYER_HEIGHT_CROUCH / MOVEMENT.PLAYER_HEIGHT
    : 1.0;
  group.scale.y += (targetScaleY - group.scale.y) * Math.min(1, 14 * dt);

  if (state.prevAlive && !c.alive) {
    state.deadTimer = 0;
  }
  state.prevAlive = c.alive;

  if (!c.alive) {
    if (state.deadTimer >= 0) {
      state.deadTimer += dt;
    }
    const t = state.deadTimer < 0 ? 1 : Math.min(1, state.deadTimer / FALL_DURATION);
    group.rotation.z = (Math.PI / 2) * t;
    group.position.y = c.pos.y - 0.1 * t;
  } else {
    if (state.deadTimer >= 0) {
      state.deadTimer = -1;
    }
    group.rotation.z = 0;

    const horizSpeed = Math.sqrt(c.vel.x * c.vel.x + c.vel.z * c.vel.z);
    if (c.onGround && horizSpeed > 0.3) {
      const amp   = 0.25;
      const freq  = horizSpeed * 2.5;
      const swing = Math.sin(_now * freq) * amp;
      const leftLeg  = group.children[0] as THREE.Mesh;
      const rightLeg = group.children[1] as THREE.Mesh;
      leftLeg.rotation.x  =  swing;
      rightLeg.rotation.x = -swing;
    } else {
      const leftLeg  = group.children[0] as THREE.Mesh;
      const rightLeg = group.children[1] as THREE.Mesh;
      leftLeg.rotation.x  = 0;
      rightLeg.rotation.x = 0;
    }
  }
}
