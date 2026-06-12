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
// Weapon attachment tuning — local transform relative to Wrist.R
// (all values in MODEL-LOCAL units, i.e. pre-character-scale)
// ---------------------------------------------------------------------------

interface WeaponAttachTuning {
  pos: readonly [number, number, number];
  rot: readonly [number, number, number]; // Euler XYZ in radians
  scale: number;
}

const DEFAULT_WEAPON_ATTACH: WeaponAttachTuning = {
  pos:   [0, 0, 0.1],
  rot:   [0, Math.PI / 2, 0],
  scale: 0.5,
};

/** Per-family overrides (keyed by file stem). */
const WEAPON_ATTACH_OVERRIDES: Partial<Record<string, WeaponAttachTuning>> = {
  knife: {
    pos:   [0, 0, 0.08],
    rot:   [0, Math.PI / 2, -Math.PI / 4],
    scale: 0.45,
  },
  pistol: {
    pos:   [0, 0, 0.1],
    rot:   [0, Math.PI / 2, 0],
    scale: 0.45,
  },
  smg: {
    pos:   [0, 0.02, 0.12],
    rot:   [0, Math.PI / 2, 0],
    scale: 0.55,
  },
  scifi_smg: {
    pos:   [0, 0.02, 0.12],
    rot:   [0, Math.PI / 2, 0],
    scale: 0.55,
  },
  assault_rifle: {
    pos:   [0, 0.02, 0.15],
    rot:   [0, Math.PI / 2, 0],
    scale: 0.65,
  },
  assault_rifle_2: {
    pos:   [0, 0.02, 0.15],
    rot:   [0, Math.PI / 2, 0],
    scale: 0.65,
  },
  sniper_rifle: {
    pos:   [0, 0.02, 0.2],
    rot:   [0, Math.PI / 2, 0],
    scale: 0.75,
  },
  shotgun: {
    pos:   [0, 0.02, 0.15],
    rot:   [0, Math.PI / 2, 0],
    scale: 0.65,
  },
  revolver: {
    pos:   [0, 0, 0.1],
    rot:   [0, Math.PI / 2, 0],
    scale: 0.48,
  },
};

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
  /** Cloned weapon meshes cached per stem (avoid re-cloning on every switch). */
  weaponCache: Map<string, THREE.Object3D>;
  /** The currently visible weapon attachment child (or null). */
  currentWeaponAttach: THREE.Object3D | null;
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

function buildRiggedMesh(assets: CharacterAssets): {
  outerGroup: THREE.Group;
  mixerState: AnimMixerState;
} {
  // SkeletonUtils.clone creates an independent rig per instance
  const clonedRoot = SkeletonUtilsClone(assets.gltf.scene) as THREE.Object3D;

  // Apply castShadow + frustumCulled=false on every SkinnedMesh
  clonedRoot.traverse((child) => {
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

  const hipsBone     = _findBone(clonedRoot, 'Hips')     as THREE.Bone | null;
  const abdomenBone  = _findBone(clonedRoot, 'Abdomen')  as THREE.Bone | null;
  const wristRBone   = _findBone(clonedRoot, 'Wrist.R');

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
// Weapon attachment update
// ---------------------------------------------------------------------------

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

  // Use cached clone or create a new one
  let weaponClone = ms.weaponCache.get(stem);
  if (weaponClone === undefined) {
    weaponClone = sourceModel.clone(true);
    ms.weaponCache.set(stem, weaponClone);
  }

  // Apply tuning
  const tuning = WEAPON_ATTACH_OVERRIDES[stem] ?? DEFAULT_WEAPON_ATTACH;
  const [px, py, pz] = tuning.pos;
  const [rx, ry, rz] = tuning.rot;
  weaponClone.position.set(px, py, pz);
  weaponClone.rotation.set(rx, ry, rz);
  // Compensate for the inner-group's normalScale so the weapon renders at tuning.scale
  // in world units (the wrist bone lives inside the inner group scaled to normalScale).
  weaponClone.scale.setScalar(tuning.scale / ms.normalScale);

  ms.wristRBone.add(weaponClone);
  ms.currentWeaponAttach = weaponClone;
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
