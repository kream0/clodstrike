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
//
// RIG GROUND TRUTH (fp_arms.glb):
//   - Armature: T=(2.9867,0,0), R=quat(-0.7071,0,0,0.7071) i.e. -90°X, S=188.4413
//   - At rest arms extend along +X; scene bbox roughly -2..5 × -0.6..0.6 × -3..3
//   - Hand.L world rest: (3.1473, -0.0038, -2.2377)
//   - Hand.R.001 world rest: (3.1473, -0.0038, 2.2375)
//   - Total reach per arm ≈ 5.17 units (upper 2.11 + fore 3.06)
// ---------------------------------------------------------------------------

/**
 * Uniform scale applied to the fp_arms clone.
 * 0.075 × 5.17 units ≈ 0.39 m total reach — human-plausible at viewmodel FOV.
 * Replaces the old ARMS_SCALE = 0.9 which produced ~4.6 m wide arms.
 */
export const ARMS_ROOT_SCALE = 0.075;

/**
 * Position of the arms root in _group space (weapon anchor).
 * Shoulders sit behind and below the weapon, toward the camera bottom.
 * X: left/right; Y: up/down; Z: forward/back (positive = toward camera).
 */
export const ARMS_ROOT_POS = new THREE.Vector3(0.0, -0.16, 0.30);

/**
 * Y-rotation applied to the arms clone to map the rig's rest +X arm direction
 * to -Z (pointing away from camera into the scene).
 * +PI/2 turns: +X arm direction → -Z scene direction.
 */
export const ARMS_ROOT_ROT_Y = Math.PI / 2;

// ---------------------------------------------------------------------------
// Legacy aliases kept for tests that still import them.
// The old ARMS_SCALE = 0.9 is replaced by ARMS_ROOT_SCALE.
// The old ARMS_OFFSET is replaced by ARMS_ROOT_POS.
// These aliases redirect tests to the new values.
// ---------------------------------------------------------------------------

/** @deprecated Use ARMS_ROOT_SCALE instead. Kept for backward-compatible tests. */
export const ARMS_SCALE: number = ARMS_ROOT_SCALE;

/** @deprecated Use ARMS_ROOT_POS instead. Kept for backward-compatible tests. */
export const ARMS_OFFSET: THREE.Vector3 = ARMS_ROOT_POS;

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
// Grip family classification
// ---------------------------------------------------------------------------

export type GripFamily = 'two_handed_long' | 'pistol' | 'knife';

// ---------------------------------------------------------------------------
// GRIP_TARGETS — IK target positions in _group (weapon anchor) space.
//
// Coordinates relative to weapon anchor origin, barrel toward -Z.
// targetLength L is resolved per-weapon from resolveWeaponTuning().
// These are fractional along L so they scale naturally.
//
// Exported so tests and human tuning can read them directly.
// ---------------------------------------------------------------------------

export interface GripTarget {
  family: GripFamily;
  /**
   * Right-hand grip position in _group space.
   * [xAbs, yAbs, zFrac] — x/y are absolute meters; z is a FRACTION of the
   * weapon's effective rendered half-length:
   *   halfLen(id) = resolveWeaponTuning(id).targetLength × scaleMult × VIEWMODEL_SCALE / 2
   * Positive zFrac = toward camera (stock side); negative = toward muzzle.
   * At pose time: worldZ = zFrac * halfLen(id)
   */
  rightHand: readonly [number, number, number];
  /**
   * Left-hand grip position in _group space.
   * Same [xAbs, yAbs, zFrac] convention as rightHand.
   * Exception: knife leftHand is a FIXED absolute position (not fraction-based);
   * treat the third component as an absolute z meter offset for the knife family.
   */
  leftHand: readonly [number, number, number];
  /**
   * Finger curl applied to all finger bones (XYZ Euler radians).
   */
  fingerCurl: readonly [number, number, number];
  /**
   * When true, the leftHand z component is an absolute meter value, not a
   * fraction of halfLen.  Used for the knife family's tucked left hand.
   */
  leftHandZAbsolute?: true;
}

/**
 * Compute the effective rendered half-length for a weapon id.
 * halfLen = targetLength × scaleMult × VIEWMODEL_SCALE / 2
 * This is the distance from the weapon anchor origin to the stock end (+z) or
 * muzzle end (−z).  Grip z targets are expressed as fractions of this value.
 * Exported for tests.
 */
export function weaponHalfLen(id: string): number {
  const t = resolveWeaponTuning(id);
  return (t.targetLength * t.scaleMult * VIEWMODEL_SCALE) / 2;
}

/**
 * Per-stem grip targets.
 *
 * rightHand / leftHand = [xAbs (m), yAbs (m), zFrac]
 *   where zFrac × halfLen(id) = the actual z in _group space at pose time.
 *   Exception: knife leftHand uses leftHandZAbsolute = true so its z is meters.
 *
 * two_handed_long: right at pistol grip (stock side, +zFrac ≈ +0.72),
 *                  left forward under barrel (−zFrac ≈ −0.80).
 * pistol:          right at grip (+zFrac ≈ +0.65), left support (zFrac ≈ +0.70).
 * knife:           right at handle (+zFrac ≈ +0.70), left tucked (fixed absolute).
 */
export const GRIP_TARGETS: Readonly<Record<string, GripTarget>> = {
  // ─── Two-handed long guns ────────────────────────────────────────────────
  assault_rifle: {
    family: 'two_handed_long',
    // Right at pistol grip — stock side, z = +0.72 × halfLen
    rightHand:  [ 0.02, -0.04,  0.72],
    // Left forward under barrel — muzzle side, z = −0.80 × halfLen
    leftHand:   [-0.01, -0.05, -0.80],
    fingerCurl: [ 0.30,  0.00,  0.00],
  },
  assault_rifle_2: {
    family: 'two_handed_long',
    rightHand:  [ 0.02, -0.04,  0.72],
    leftHand:   [-0.01, -0.05, -0.80],
    fingerCurl: [ 0.30,  0.00,  0.00],
  },
  sniper_rifle: {
    family: 'two_handed_long',
    // Sniper: right slightly farther back, left a bit closer under the stock
    rightHand:  [ 0.02, -0.04,  0.80],
    leftHand:   [-0.01, -0.05, -0.72],
    fingerCurl: [ 0.25,  0.00,  0.00],
  },
  smg: {
    family: 'two_handed_long',
    rightHand:  [ 0.02, -0.04,  0.72],
    leftHand:   [-0.01, -0.05, -0.80],
    fingerCurl: [ 0.30,  0.00,  0.00],
  },
  scifi_smg: {
    family: 'two_handed_long',
    rightHand:  [ 0.02, -0.04,  0.72],
    leftHand:   [-0.01, -0.05, -0.80],
    fingerCurl: [ 0.30,  0.00,  0.00],
  },
  shotgun: {
    family: 'two_handed_long',
    rightHand:  [ 0.02, -0.04,  0.72],
    leftHand:   [-0.01, -0.05, -0.80],
    fingerCurl: [ 0.28,  0.00,  0.00],
  },
  // ─── Pistols ─────────────────────────────────────────────────────────────
  pistol: {
    family: 'pistol',
    // Right at grip (+0.65 × halfLen); left support below/beside (+0.70 × halfLen)
    rightHand:  [ 0.01, -0.03,  0.65],
    leftHand:   [-0.02, -0.06,  0.70],
    fingerCurl: [ 0.25,  0.00,  0.00],
  },
  revolver: {
    family: 'pistol',
    rightHand:  [ 0.01, -0.03,  0.65],
    leftHand:   [-0.02, -0.06,  0.70],
    fingerCurl: [ 0.25,  0.00,  0.00],
  },
  // ─── Knife ───────────────────────────────────────────────────────────────
  knife: {
    family: 'knife',
    // Right at handle: +0.70 × halfLen from center
    rightHand:       [ 0.01, -0.02,  0.70],
    // Left tucked — FIXED absolute position in _group space (not fraction-based)
    leftHand:        [-0.14, -0.20,  0.12],
    leftHandZAbsolute: true,
    fingerCurl:      [ 0.35,  0.00,  0.00],
  },
} as const;

// ---------------------------------------------------------------------------
// Legacy GRIP_PRESETS shim — kept so existing tests importing it still compile.
// Bridges the new GRIP_TARGETS shape to the old shape expected by tests.
// ---------------------------------------------------------------------------

export interface GripPreset {
  family: GripFamily;
  upperArmR: readonly [number, number, number];
  lowerArmR: readonly [number, number, number];
  handR:     readonly [number, number, number];
  upperArmL: readonly [number, number, number];
  lowerArmL: readonly [number, number, number];
  handL:     readonly [number, number, number];
  fingerCurl: readonly [number, number, number];
}

/**
 * Synthetic GRIP_PRESETS built from GRIP_TARGETS.
 * The arm/hand rotation fields are zero because IK computes them at runtime.
 * Tests that assert `family` classification and `fingerCurl` finiteness still pass.
 * Exported for backward compatibility with existing test imports.
 */
export const GRIP_PRESETS: Readonly<Record<string, GripPreset>> = Object.fromEntries(
  Object.entries(GRIP_TARGETS).map(([stem, gt]) => [
    stem,
    {
      family:     gt.family,
      upperArmR:  [0, 0, 0] as readonly [number, number, number],
      lowerArmR:  [0, 0, 0] as readonly [number, number, number],
      handR:      [0, 0, 0] as readonly [number, number, number],
      upperArmL:  [0, 0, 0] as readonly [number, number, number],
      lowerArmL:  [0, 0, 0] as readonly [number, number, number],
      handL:      [0, 0, 0] as readonly [number, number, number],
      fingerCurl: gt.fingerCurl,
    } satisfies GripPreset,
  ]),
) as Readonly<Record<string, GripPreset>>;

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
// Two-bone analytic IK
// ---------------------------------------------------------------------------

/**
 * Describes the three bones of a two-bone IK chain:
 *  root (shoulder/upper arm) → mid (elbow/lower arm) → tip (hand/wrist)
 */
export interface TwoBoneChain {
  /** The root bone (upper arm / shoulder). */
  root: THREE.Bone;
  /** The mid bone (lower arm / elbow). */
  mid: THREE.Bone;
  /** The tip bone (hand / wrist). */
  tip: THREE.Bone;
}

// Reusable temporaries for IK solver — allocated once, never in the hot path.
const _ikRootWorldPos  = new THREE.Vector3();
const _ikMidWorldPos   = new THREE.Vector3();
const _ikTipWorldPos   = new THREE.Vector3();
const _ikParentWorldQ  = new THREE.Quaternion();
const _ikInvParentQ    = new THREE.Quaternion();
const _ikDesiredDir    = new THREE.Vector3();
const _ikCurrentDir    = new THREE.Vector3();
const _ikElbowWorld    = new THREE.Vector3();
const _ikElbowDir      = new THREE.Vector3();
const _ikPole          = new THREE.Vector3();
const _ikTipDir        = new THREE.Vector3();
const _ikAlignQ        = new THREE.Quaternion();
const _ikV0            = new THREE.Vector3();
const _ikV1            = new THREE.Vector3();
const _ikM             = new THREE.Matrix4();

/**
 * Extract the world-space rotation quaternion from a bone's parent (or identity).
 */
function _getParentWorldQ(bone: THREE.Bone, out: THREE.Quaternion): void {
  const parent = bone.parent;
  if (parent !== null) {
    parent.updateWorldMatrix(true, false);
    out.setFromRotationMatrix(_ikM.extractRotation(parent.matrixWorld));
  } else {
    out.identity();
  }
}

/**
 * Align a bone so its "child direction" (current world vector from bone to its
 * child joint) points toward a desired world direction.
 *
 * Uses the parent-space delta approach:
 *  1. Transform both current and desired directions into parent space.
 *  2. Compute the quaternion that rotates one to the other.
 *  3. Premultiply (apply in parent space) onto the bone's local quaternion.
 *
 * After this call the bone's local quaternion is updated; call
 * bone.updateWorldMatrix(true, true) to propagate downstream.
 *
 * @param bone          - The bone to rotate.
 * @param currentWorld  - Current world direction (bone → child), normalised.
 * @param desiredWorld  - Desired world direction (bone → target), normalised.
 * @param parentWorldQ  - Parent's world rotation (pass identity if no parent).
 */
function _alignBoneAxis(
  bone: THREE.Bone,
  currentWorld: THREE.Vector3,
  desiredWorld: THREE.Vector3,
  parentWorldQ: THREE.Quaternion,
): void {
  _ikInvParentQ.copy(parentWorldQ).invert();
  // Both directions expressed in parent-local space.
  const localCurrent = _ikV0.copy(currentWorld).applyQuaternion(_ikInvParentQ);
  const localDesired = _ikV1.copy(desiredWorld).applyQuaternion(_ikInvParentQ);
  const lenC = localCurrent.length();
  const lenD = localDesired.length();
  if (lenC < 1e-10 || lenD < 1e-10) return;
  localCurrent.divideScalar(lenC);
  localDesired.divideScalar(lenD);
  // setFromUnitVectors: rotation that maps localCurrent → localDesired.
  _ikAlignQ.setFromUnitVectors(localCurrent, localDesired);
  // Premultiply applies the delta in parent space: new_local = delta * old_local.
  bone.quaternion.premultiply(_ikAlignQ);
}

/**
 * Solve a two-bone analytic IK chain and apply rotations directly to the bones.
 *
 * Algorithm:
 *  1. Read current world positions of root, mid, tip from the live clone.
 *  2. Measure L1 = |root→mid|, L2 = |mid→tip| from the live clone (robust to any scale).
 *  3. Clamp target distance d to [|L1-L2|+ε, L1+L2-ε].
 *  4. Law of cosines → elbow angle → elbow world position using a pole vector.
 *  5. Rotate root bone so root→mid aligns with root→elbowWorld (in root's parent space).
 *  6. Update world matrices, then rotate mid bone so mid→tip aligns with mid→target.
 *
 * This is called once per weapon switch, NOT per frame.
 *
 * @param chain       - The three-bone IK chain (root=shoulder, mid=elbow, tip=hand).
 * @param targetWorld - Desired hand world position.
 * @param poleWorld   - Pole vector world position that the elbow bends toward.
 * @returns true if solved successfully, false if chain has zero-length segments.
 */
export function solveTwoBoneIK(
  chain: TwoBoneChain,
  targetWorld: THREE.Vector3,
  poleWorld: THREE.Vector3,
): boolean {
  const { root, mid, tip } = chain;

  // Ensure world matrices are up to date on the entire chain.
  root.updateWorldMatrix(true, true);

  // Read world positions from live matrices.
  _ikRootWorldPos.setFromMatrixPosition(root.matrixWorld);
  _ikMidWorldPos.setFromMatrixPosition(mid.matrixWorld);
  _ikTipWorldPos.setFromMatrixPosition(tip.matrixWorld);

  // Measure segment lengths from the live clone (robust to all scales in chain).
  const L1 = _ikRootWorldPos.distanceTo(_ikMidWorldPos);
  const L2 = _ikMidWorldPos.distanceTo(_ikTipWorldPos);

  if (L1 < 1e-6 || L2 < 1e-6) return false; // degenerate chain

  // Vector from root to target.
  _ikDesiredDir.subVectors(targetWorld, _ikRootWorldPos);
  let d = _ikDesiredDir.length();

  // Clamp target distance to reachable range.
  const eps = 1e-4;
  const dMin = Math.abs(L1 - L2) + eps;
  const dMax = L1 + L2 - eps;
  if (d < dMin) d = dMin;
  if (d > dMax) d = dMax;

  // Normalised direction root → target (clamped).
  let toTargetX: number, toTargetY: number, toTargetZ: number;
  if (_ikDesiredDir.lengthSq() < 1e-12) {
    toTargetX = 0; toTargetY = 0; toTargetZ = -1;
  } else {
    const len = _ikDesiredDir.length();
    toTargetX = _ikDesiredDir.x / len;
    toTargetY = _ikDesiredDir.y / len;
    toTargetZ = _ikDesiredDir.z / len;
  }
  const toTarget = _ikV0.set(toTargetX, toTargetY, toTargetZ);

  // Clamped target world position.
  const clampedTarget = _ikElbowWorld.copy(_ikRootWorldPos).addScaledVector(toTarget, d);
  // (re-use _ikElbowWorld temporarily; will overwrite with real elbow below)
  const ctX = clampedTarget.x, ctY = clampedTarget.y, ctZ = clampedTarget.z;

  // Law of cosines: angle at root (between root→elbow and root→clampedTarget).
  // cos(A) = (L1² + d² - L2²) / (2 * L1 * d)
  const cosA = THREE.MathUtils.clamp(
    (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d),
    -1, 1,
  );
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));

  // Compute pole-perpendicular direction for the elbow plane.
  const toPole = _ikPole.subVectors(poleWorld, _ikRootWorldPos);
  // Project out the toTarget component.
  const poleDotTarget = toPole.dot(toTarget);
  const polePerp = _ikElbowDir.copy(toPole).addScaledVector(toTarget, -poleDotTarget);
  if (polePerp.lengthSq() < 1e-12) {
    // Pole is collinear with target — pick any perpendicular.
    // Build an arbitrary vector perpendicular to toTarget.
    if (Math.abs(toTargetX) < 0.9) {
      polePerp.set(1, 0, 0);
    } else {
      polePerp.set(0, 1, 0);
    }
    polePerp.addScaledVector(toTarget, -polePerp.dot(toTarget));
  }
  polePerp.normalize();

  // Elbow world position:
  //   from root, cosA * L1 along root→target, sinA * L1 along polePerp.
  _ikElbowWorld.copy(_ikRootWorldPos)
    .addScaledVector(toTarget, cosA * L1)
    .addScaledVector(polePerp, sinA * L1);

  // ── Apply rotation to root bone ──────────────────────────────────────────
  // Desired: root bone's child (mid) should move to the elbow position.
  // Current child direction (world): root → mid.
  _ikCurrentDir.subVectors(_ikMidWorldPos, _ikRootWorldPos).normalize();
  // Desired child direction (world): root → elbow.
  _ikTipDir.subVectors(_ikElbowWorld, _ikRootWorldPos).normalize();

  _getParentWorldQ(root, _ikParentWorldQ);
  _alignBoneAxis(root, _ikCurrentDir, _ikTipDir, _ikParentWorldQ);

  // Propagate world matrices: root → mid → tip.
  root.updateWorldMatrix(false, true);

  // ── Apply rotation to mid bone ───────────────────────────────────────────
  // After root update, re-read mid and tip world positions.
  _ikMidWorldPos.setFromMatrixPosition(mid.matrixWorld);
  _ikTipWorldPos.setFromMatrixPosition(tip.matrixWorld);

  // Current child direction (world): mid → tip (after root update).
  _ikCurrentDir.subVectors(_ikTipWorldPos, _ikMidWorldPos).normalize();
  // Desired child direction (world): mid → clampedTarget.
  _ikTipDir.set(ctX - _ikMidWorldPos.x, ctY - _ikMidWorldPos.y, ctZ - _ikMidWorldPos.z).normalize();

  _getParentWorldQ(mid, _ikParentWorldQ);
  _alignBoneAxis(mid, _ikCurrentDir, _ikTipDir, _ikParentWorldQ);

  // Final world matrix update.
  mid.updateWorldMatrix(false, true);

  return true;
}

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
// IK arm pose helpers
// ---------------------------------------------------------------------------

// Reusable temporaries for _poseArms — module-level so they are never
// allocated per-call (pose runs at most once per weapon-family switch).
const _poseTargetWorld = new THREE.Vector3();
const _posePoleWorld   = new THREE.Vector3();
const _poseGroupWorld  = new THREE.Vector3();
const _poseGroupM      = new THREE.Matrix4();

// Pole-offset constants for IK elbow direction.
// Right arm: elbow down and slightly inward (-X screen-right = inward for right arm).
const _poleOffsetR = new THREE.Vector3( 0.1, -0.15, 0.05);
// Left arm: elbow down and slightly inward (+X screen-left = inward for left arm).
const _poleOffsetL = new THREE.Vector3(-0.1, -0.15, 0.05);

/**
 * Compute world-space grip target from _group-local coordinates.
 */
function groupLocalToWorld(
  localX: number, localY: number, localZ: number,
  groupWorldMatrix: THREE.Matrix4,
  out: THREE.Vector3,
): void {
  out.set(localX, localY, localZ).applyMatrix4(groupWorldMatrix);
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
    // Apply IK pose for the current weapon.
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

    // Re-pose arms for new weapon (IK runs per weapon switch).
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
   * Grenade view keeps the last weapon pose (arms stay during grenade hold).
   * This avoids re-solving IK for a transient item that has no grip target.
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

    // Scale: 0.075 gives ~0.39 m total arm reach (human-plausible at viewmodel FOV).
    // Position: shoulders behind/below the weapon, toward camera bottom.
    // Rotation: +PI/2 around Y maps rest +X arm direction to -Z scene direction.
    clone.scale.setScalar(ARMS_ROOT_SCALE);
    clone.position.copy(ARMS_ROOT_POS);
    clone.rotation.set(0, ARMS_ROOT_ROT_Y, 0, 'XYZ');

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
   * Apply IK-solved arm pose for the given weapon id.
   *
   * Runs two-bone analytic IK for each arm (solveTwoBoneIK) to place
   * Hand.L and Hand.R.001 at their respective grip targets.
   *
   * Only re-poses when the family changes (weapon switch within the same
   * family e.g. ak47 → m4a4 skips the IK solve — same two_handed_long pose).
   *
   * Grenade view: arms keep the last weapon pose (no re-solve needed — the
   * grenade hold uses the pistol-family arm position from the last real weapon).
   *
   * Must be called AFTER _buildArmsClone so _armsBoneMap is populated.
   * No-op if arms are not registered (no-arms fallback).
   */
  private _poseArms(id: string): void {
    if (this._armsClone === null || this._armsBoneMap.size === 0) return;

    const stem = THIRD_PERSON_WEAPON_FILES[id] ?? id;
    const gripTarget = GRIP_TARGETS[stem];
    if (gripTarget === undefined) return;

    // Only re-pose when the family changes.
    if (gripTarget.family === this._currentGripFamily) return;
    this._currentGripFamily = gripTarget.family;

    // Compute the weapon's effective rendered half-length for this specific id.
    // rightHand[2] and leftHand[2] are fractions of this value (unless leftHandZAbsolute).
    const halfLen = weaponHalfLen(id);

    // Get the arms clone's bones.
    const upperArmR = this._armsBoneMap.get('UpperArm.R.001');
    const lowerArmR = this._armsBoneMap.get('LowerArm.R.001');
    const handR     = this._armsBoneMap.get('Hand.R.001');
    const upperArmL = this._armsBoneMap.get('UpperArm.L');
    const lowerArmL = this._armsBoneMap.get('LowerArm.L');
    const handL     = this._armsBoneMap.get('Hand.L');

    // Update world matrices of the full arms clone hierarchy.
    this._armsClone.updateWorldMatrix(true, true);

    // Get the _group world matrix for converting local grip targets to world space.
    this._group.updateWorldMatrix(true, false);
    _poseGroupM.copy(this._group.matrixWorld);

    // ── Right hand IK ────────────────────────────────────────────────────────
    if (upperArmR !== undefined && lowerArmR !== undefined && handR !== undefined) {
      const [rx, ry, rzFrac] = gripTarget.rightHand;
      groupLocalToWorld(rx, ry, rzFrac * halfLen, _poseGroupM, _poseTargetWorld);

      // Pole: elbow down and slightly inward (right arm).
      upperArmR.updateWorldMatrix(true, false);
      _poseGroupWorld.setFromMatrixPosition(upperArmR.matrixWorld);
      _posePoleWorld.copy(_poseGroupWorld).add(_poleOffsetR);

      solveTwoBoneIK(
        { root: upperArmR, mid: lowerArmR, tip: handR },
        _poseTargetWorld,
        _posePoleWorld,
      );
    }

    // ── Left hand IK ─────────────────────────────────────────────────────────
    if (upperArmL !== undefined && lowerArmL !== undefined && handL !== undefined) {
      const [lx, ly, lzFracOrAbs] = gripTarget.leftHand;
      // For knife the left hand uses a fixed absolute z; all others use zFrac * halfLen.
      const lzWorld = gripTarget.leftHandZAbsolute === true
        ? lzFracOrAbs
        : lzFracOrAbs * halfLen;
      groupLocalToWorld(lx, ly, lzWorld, _poseGroupM, _poseTargetWorld);

      upperArmL.updateWorldMatrix(true, false);
      _poseGroupWorld.setFromMatrixPosition(upperArmL.matrixWorld);
      // Pole: elbow down and slightly inward (left arm).
      _posePoleWorld.copy(_poseGroupWorld).add(_poleOffsetL);

      solveTwoBoneIK(
        { root: upperArmL, mid: lowerArmL, tip: handL },
        _poseTargetWorld,
        _posePoleWorld,
      );
    }

    // ── Finger curl ───────────────────────────────────────────────────────────
    const curl = gripTarget.fingerCurl;
    const setBone = (name: string, rot: readonly [number, number, number]): void => {
      const bone = this._armsBoneMap.get(name);
      if (bone === undefined) return;
      bone.rotation.set(rot[0], rot[1], rot[2], 'XYZ');
    };

    for (const boneName of FINGER_BONES_R) {
      setBone(boneName, curl);
    }
    for (const boneName of FINGER_BONES_L) {
      setBone(boneName, curl);
    }
  }
}
