import * as THREE from 'three';
import type { Combatant, Team } from './types';
import { MOVEMENT } from './constants';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKIN_COLOR       = 0xc9a182;
const HELMET_COLOR     = 0x3a3a3a;
const GUN_COLOR        = 0x222222;

// CT: slightly bluer than base; T: sandy-brown
const TEAM_TORSO: Record<Team, number> = {
  CT: 0x5a7da8,
  T:  0xa8824f,
};

const FALL_DURATION = 0.25;

// ---------------------------------------------------------------------------
// Model path registry
// ---------------------------------------------------------------------------

/**
 * Relative paths (from assets/) for the two team character GLBs.
 * Integration calls loadGLB(CHARACTER_MODEL_PATHS.ct) etc. and passes the
 * resulting scenes to setCharacterModels().
 */
export const CHARACTER_MODEL_PATHS: { ct: string; t: string } = {
  ct: 'models/characters/character-ct.glb',
  t:  'models/characters/character-t.glb',
};

// ---------------------------------------------------------------------------
// GLB normalization constants
// ---------------------------------------------------------------------------

/**
 * Kenney Blocky Characters 2.0 — CASE 2: no skins, named limb nodes.
 *
 * Model world height measured headlessly:
 *   feet at y=0.0, head top at y≈2.7 (head node at 1.9 + 0.8 from scaled head mesh).
 * Target height = MOVEMENT.PLAYER_HEIGHT = 1.83 m.
 * Scale = 1.83 / 2.7 ≈ 0.6778.
 *
 * Yaw convention: model faces -Z at default orientation, matching the
 * existing procedural mesh and the game's yaw=0→face -Z convention.
 * No extra rotation needed.
 */
const MODEL_SOURCE_HEIGHT = 2.7;
const MODEL_SCALE = MOVEMENT.PLAYER_HEIGHT / MODEL_SOURCE_HEIGHT; // ≈ 0.6778

// ---------------------------------------------------------------------------
// Preloaded source models (set once by integration)
// ---------------------------------------------------------------------------

const _sourceModels: { ct: THREE.Object3D | null; t: THREE.Object3D | null } = {
  ct: null,
  t:  null,
};

/**
 * Register preloaded GLB scenes for each team.
 * Call this once after loading; all subsequent createCharacterMesh calls will
 * use GLB clones. Characters created before this call remain procedural.
 * Idempotent — safe to call multiple times.
 */
export function setCharacterModels(models: { ct?: THREE.Object3D; t?: THREE.Object3D }): void {
  if (models.ct !== undefined) _sourceModels.ct = models.ct;
  if (models.t  !== undefined) _sourceModels.t  = models.t;
}

// ---------------------------------------------------------------------------
// Per-limb node references, cached at clone time
// ---------------------------------------------------------------------------

interface LimbRefs {
  root:     THREE.Object3D | null;
  torso:    THREE.Object3D | null;
  legLeft:  THREE.Object3D | null;
  legRight: THREE.Object3D | null;
  armLeft:  THREE.Object3D | null;
  armRight: THREE.Object3D | null;
  head:     THREE.Object3D | null;
}

function findNode(root: THREE.Object3D, name: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((obj) => {
    if (found === null && obj.name === name) found = obj;
  });
  return found;
}

function extractLimbs(cloned: THREE.Object3D): LimbRefs {
  return {
    root:     findNode(cloned, 'root'),
    torso:    findNode(cloned, 'torso'),
    legLeft:  findNode(cloned, 'leg-left'),
    legRight: findNode(cloned, 'leg-right'),
    armLeft:  findNode(cloned, 'arm-left'),
    armRight: findNode(cloned, 'arm-right'),
    head:     findNode(cloned, 'head'),
  };
}

// ---------------------------------------------------------------------------
// Per-character animation state (stored on the group)
// ---------------------------------------------------------------------------

interface AnimState {
  /** Walk cycle phase accumulator (radians), advanced per frame. */
  walkPhase: number;
  /** Breathing phase accumulator (radians), advanced per frame. */
  breathPhase: number;
}

// ---------------------------------------------------------------------------
// State stored on the group for updateCharacterMesh / updateVisual
// ---------------------------------------------------------------------------

interface MeshState {
  prevAlive:  boolean;
  deadTimer:  number;   // seconds since death, -1 if still alive
  team:       Team;
  isGLB:      boolean;
  limbs:      LimbRefs | null;
  anim:       AnimState;
  /** Head node's resting local Y, captured once at clone time (GLB path only). */
  headRestY:  number;
}

// Augmented group type to carry state without index signature.
type CharGroup = THREE.Group & { _cs2State: MeshState };

// ---------------------------------------------------------------------------
// Pure animation math helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Compute leg-swing rotation (radians) for a given phase and leg side.
 * Returns the X-axis rotation for the specified leg.
 *
 * @param phase    - walk cycle phase in radians (advances with dt * freq)
 * @param isLeft   - true for left leg, false for right (opposite phase)
 * @param amplitude - max rotation in radians
 */
export function legSwingAngle(phase: number, isLeft: boolean, amplitude: number): number {
  return Math.sin(isLeft ? phase : phase + Math.PI) * amplitude;
}

/**
 * Arm counter-swing angle (opposite to the leg on the same side).
 * Arms swing opposite to legs (left arm forward when right leg forward).
 */
export function armSwingAngle(phase: number, isLeft: boolean, amplitude: number): number {
  return Math.sin(isLeft ? phase + Math.PI : phase) * amplitude;
}

/**
 * Breathing bob Y offset in LOCAL model units.
 * Amplitude and frequency produce a subtle inhale/exhale.
 */
export function breathingBobY(breathPhase: number): number {
  return Math.sin(breathPhase) * 0.012; // ~1.2 cm model-space at scale 0.68 ≈ 0.8 cm world
}

/**
 * Crouch Y-offset for the root node in model units, to keep feet planted.
 * When crouching, we translate the root down so visual height ≈ crouch ratio.
 */
export function crouchRootOffsetY(crouching: boolean): number {
  if (!crouching) return 0;
  const ratio = MOVEMENT.PLAYER_HEIGHT_CROUCH / MOVEMENT.PLAYER_HEIGHT; // ≈ 0.738
  // Lower root by (1 - ratio) * MODEL_SOURCE_HEIGHT in model space
  return -(1 - ratio) * MODEL_SOURCE_HEIGHT * 0.35;
}

/**
 * Death rotation around Z axis — falls sideways.
 * @param t - normalized progress [0,1]
 */
export function deathRotationZ(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return (Math.PI / 2) * clamped;
}

/**
 * Normalise a source height H to a target height T.
 * Returns the uniform scale factor T/H.
 */
export function normalizeHeight(sourceHeight: number, targetHeight: number): number {
  if (sourceHeight <= 0) return 1;
  return targetHeight / sourceHeight;
}

// ---------------------------------------------------------------------------
// Procedural character mesh builder (fallback when no GLB loaded)
// ---------------------------------------------------------------------------

function buildProceduralMesh(team: Team): THREE.Group {
  const group = new THREE.Group();

  const torsoColor = TEAM_TORSO[team];

  function box(
    sx: number,
    sy: number,
    sz: number,
    color: number,
    cx = 0,
    cy = 0,
    cz = 0,
  ): THREE.Mesh {
    const geo  = new THREE.BoxGeometry(sx, sy, sz);
    const mat  = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx, cy, cz);
    mesh.castShadow    = true;
    mesh.receiveShadow = false;
    return mesh;
  }

  // --- Legs (two boxes, side by side) ---
  // y 0–0.85
  const legH = 0.85;
  const legW = 0.18;
  const legD = 0.20;
  const leftLeg  = box(legW, legH, legD, torsoColor, -0.11, legH / 2, 0);
  const rightLeg = box(legW, legH, legD, torsoColor,  0.11, legH / 2, 0);

  // --- Torso --- y 0.85–1.50
  const torsoH = 0.65;
  const torsoY = 0.85 + torsoH / 2;
  const torso  = box(0.44, torsoH, 0.26, torsoColor, 0, torsoY, 0);

  // --- Arms (two thin boxes) ---
  const armH = 0.55;
  const armW = 0.14;
  const armD = 0.14;
  const armY = 0.85 + 0.45;
  const leftArm  = box(armW, armH, armD, torsoColor, -0.29, armY - armH / 2 + 0.1, 0.02);
  const rightArm = box(armW, armH, armD, torsoColor,  0.29, armY - armH / 2 + 0.1, 0.02);

  // --- Head (skin) --- y 1.50–1.72
  const headH = 0.22;
  const headY = 1.50 + headH / 2;
  const head  = box(0.24, headH, 0.26, SKIN_COLOR, 0, headY, 0);

  // --- Helmet (darker box over head) --- y 1.72–1.83
  const helmetH = 0.11;
  const helmetY = 1.50 + headH + helmetH / 2;
  const helmet  = box(0.27, helmetH, 0.28, HELMET_COLOR, 0, helmetY, 0.0);

  // --- Gun (dark box held in front-right) ---
  const gun = box(0.06, 0.12, 0.38, GUN_COLOR, 0.20, 1.05, -0.22);

  group.add(leftLeg, rightLeg, torso, leftArm, rightArm, head, helmet, gun);
  return group;
}

// ---------------------------------------------------------------------------
// GLB character clone builder
// ---------------------------------------------------------------------------

function buildGLBMesh(source: THREE.Object3D): { group: THREE.Group; limbs: LimbRefs } {
  // No SkinnedMesh in these models — plain .clone(true) is correct.
  const cloned = source.clone(true) as THREE.Group;

  // Scale to match PLAYER_HEIGHT.
  cloned.scale.setScalar(MODEL_SCALE);

  // Apply castShadow to all meshes (matches procedural behavior).
  cloned.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow    = true;
      child.receiveShadow = false;
    }
  });

  const limbs = extractLimbs(cloned);
  return { group: cloned, limbs };
}

// ---------------------------------------------------------------------------
// createCharacterMesh
// ---------------------------------------------------------------------------

export function createCharacterMesh(team: Team): THREE.Group {
  const source = team === 'CT' ? _sourceModels.ct : _sourceModels.t;

  let group: THREE.Group;
  let limbs: LimbRefs | null = null;
  let isGLB = false;

  if (source !== null) {
    const built = buildGLBMesh(source);
    group  = built.group;
    limbs  = built.limbs;
    isGLB  = true;
  } else {
    group = buildProceduralMesh(team);
  }

  // Capture head resting Y once at clone time (no per-frame allocation).
  const headRestY = (isGLB && limbs !== null && limbs.head !== null)
    ? limbs.head.position.y
    : 1.2;

  const state: MeshState = {
    prevAlive:  true,
    deadTimer:  -1,
    team,
    isGLB,
    limbs,
    anim: {
      walkPhase:   0,
      breathPhase: 0,
    },
    headRestY,
  };
  (group as CharGroup)._cs2State = state;

  return group;
}

// ---------------------------------------------------------------------------
// updateCharacterMesh — called every render frame by game.ts updateVisuals
// ---------------------------------------------------------------------------

export function updateCharacterMesh(
  group: THREE.Group,
  c: Combatant,
  dt: number,
  now: number,
): void {
  const state = (group as Partial<CharGroup>)._cs2State;
  if (!state) return;

  // Position (feet-anchored).
  group.position.set(c.pos.x, c.pos.y, c.pos.z);
  // Mesh faces −Z at yaw 0, matching the convention in math.ts.
  group.rotation.y = c.yaw;

  if (state.isGLB) {
    _updateGLBMesh(group, state, c, dt, now);
  } else {
    _updateProceduralMesh(group, state, c, dt, now);
  }
}

// ---------------------------------------------------------------------------
// updateVisual — additive alias for external callers (integration compatible)
// Delegates to updateCharacterMesh.
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
// Internal: GLB-path update
// ---------------------------------------------------------------------------

function _updateGLBMesh(
  group: THREE.Group,
  state: MeshState,
  c: Combatant,
  dt: number,
  _now: number,
): void {
  const limbs = state.limbs;
  if (!limbs) return;

  // --- Death ---
  if (state.prevAlive && !c.alive) {
    state.deadTimer = 0;
  }
  state.prevAlive = c.alive;

  if (!c.alive) {
    if (state.deadTimer >= 0) {
      state.deadTimer += dt;
    }
    const t = state.deadTimer < 0
      ? 1
      : Math.min(1, state.deadTimer / FALL_DURATION);
    group.rotation.z  = deathRotationZ(t);
    group.position.y  = c.pos.y - 0.1 * t;
    return;
  }

  // Reset on respawn.
  if (state.deadTimer >= 0) {
    state.deadTimer   = -1;
  }
  group.rotation.z = 0;

  const horizSpeed = Math.sqrt(c.vel.x * c.vel.x + c.vel.z * c.vel.z);
  const isMoving   = c.onGround && horizSpeed > 0.3;

  // --- Advance animation phases ---
  // Walk frequency: cycles proportional to speed (2.5 cycles/m ≈ per second at 4 m/s)
  if (isMoving) {
    state.anim.walkPhase += horizSpeed * 2.5 * dt;
  }
  // Breathing: ~0.5 Hz
  state.anim.breathPhase += Math.PI * 2 * 0.5 * dt; // 0.5 Hz

  // --- Crouch: lower root node Y ---
  if (limbs.root !== null) {
    const rootTargetY = crouchRootOffsetY(c.crouching);
    const currentY    = limbs.root.position.y;
    limbs.root.position.y = currentY + (rootTargetY - currentY) * Math.min(1, 14 * dt);
  }

  // --- Breathing (idle head bob) ---
  // Use the resting Y captured at clone time (stored in state.headRestY).
  // No per-frame allocation.
  if (limbs.head !== null) {
    const bob = breathingBobY(state.anim.breathPhase);
    limbs.head.position.y = state.headRestY + bob;
  }

  // --- Walk animation ---
  if (isMoving) {
    const walkAmp = Math.min(horizSpeed / 5, 1) * 0.45; // max ≈0.45 rad

    // Legs: opposite phase sinusoids
    if (limbs.legLeft  !== null) limbs.legLeft.rotation.x  = legSwingAngle(state.anim.walkPhase, true,  walkAmp);
    if (limbs.legRight !== null) limbs.legRight.rotation.x = legSwingAngle(state.anim.walkPhase, false, walkAmp);

    // Arms: counter-swing (reduced amplitude)
    const armAmp = walkAmp * 0.5;
    if (limbs.armLeft  !== null) limbs.armLeft.rotation.x  = armSwingAngle(state.anim.walkPhase, true,  armAmp);
    if (limbs.armRight !== null) limbs.armRight.rotation.x = armSwingAngle(state.anim.walkPhase, false, armAmp);

    // Slight torso lean forward at run speed
    if (limbs.torso !== null) {
      const leanTarget = Math.min(horizSpeed / 6, 1) * (-0.12); // slight forward lean
      limbs.torso.rotation.x += (leanTarget - limbs.torso.rotation.x) * Math.min(1, 8 * dt);
    }
  } else {
    // Return limbs to neutral
    if (limbs.legLeft  !== null) limbs.legLeft.rotation.x  *= (1 - Math.min(1, 12 * dt));
    if (limbs.legRight !== null) limbs.legRight.rotation.x *= (1 - Math.min(1, 12 * dt));
    if (limbs.armLeft  !== null) limbs.armLeft.rotation.x  *= (1 - Math.min(1, 12 * dt));
    if (limbs.armRight !== null) limbs.armRight.rotation.x *= (1 - Math.min(1, 12 * dt));
    if (limbs.torso    !== null) limbs.torso.rotation.x    *= (1 - Math.min(1, 8  * dt));
  }
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
  // Crouch: scale Y, keeping feet grounded.
  const targetScaleY = c.crouching
    ? MOVEMENT.PLAYER_HEIGHT_CROUCH / MOVEMENT.PLAYER_HEIGHT
    : 1.0;
  group.scale.y += (targetScaleY - group.scale.y) * Math.min(1, 14 * dt);

  // Death.
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
      state.deadTimer  = -1;
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
