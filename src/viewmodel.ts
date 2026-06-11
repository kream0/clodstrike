import * as THREE from 'three';
import type { Vec3 } from './types';

// ---------------------------------------------------------------------------
// Weapon ID type (union of all weapon ids from constants.ts WEAPONS table)
// ---------------------------------------------------------------------------

export type WeaponId = 'knife' | 'glock' | 'usp' | 'deagle' | 'ak47' | 'm4a4' | 'awp';

// ---------------------------------------------------------------------------
// Model path registry — 6 gun ids only (knife stays procedural)
// ---------------------------------------------------------------------------

export const WEAPON_MODEL_PATHS: Readonly<Partial<Record<WeaponId, string>>> = {
  glock:  'models/weapons/glock.glb',
  usp:    'models/weapons/usp.glb',
  deagle: 'models/weapons/deagle.glb',
  ak47:   'models/weapons/ak47.glb',
  m4a4:   'models/weapons/m4a4.glb',
  awp:    'models/weapons/awp.glb',
} as const;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VM_OFFSET = new THREE.Vector3(0.22, -0.22, -0.45);
const GUNMETAL  = 0x2a2a2e;
const GUN_DARK  = 0x1a1a1c;
const GUN_WOOD  = 0x5a3a1a;

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
// Per-weapon tuning table
// Single place to tweak offsets/rotation/scale after playtesting.
// ---------------------------------------------------------------------------

interface WeaponTuning {
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

const WEAPON_TUNING: Record<string, WeaponTuning> = {
  glock: {
    targetLength: 0.22,
    gripOffset: { x: 0, y: 0, z: 0 },
    extraRotation: { x: 0, y: 0, z: 0 },
    scaleMult: 1.0,
    muzzleZ: -0.14,
  },
  usp: {
    targetLength: 0.22,
    gripOffset: { x: 0, y: 0, z: 0 },
    extraRotation: { x: 0, y: 0, z: 0 },
    scaleMult: 1.0,
    muzzleZ: -0.14,
  },
  deagle: {
    targetLength: 0.22,
    gripOffset: { x: 0, y: 0, z: 0 },
    extraRotation: { x: 0, y: 0, z: 0 },
    scaleMult: 1.1,
    muzzleZ: -0.14,
  },
  ak47: {
    targetLength: 0.38,
    gripOffset: { x: 0, y: 0, z: 0 },
    extraRotation: { x: 0, y: 0, z: 0 },
    scaleMult: 1.0,
    muzzleZ: -0.32,
  },
  m4a4: {
    targetLength: 0.38,
    gripOffset: { x: 0, y: 0, z: 0 },
    extraRotation: { x: 0, y: 0, z: 0 },
    scaleMult: 1.0,
    muzzleZ: -0.32,
  },
  awp: {
    targetLength: 0.60,
    gripOffset: { x: 0, y: 0, z: 0 },
    extraRotation: { x: 0, y: 0, z: 0 },
    scaleMult: 1.0,
    muzzleZ: -0.45,
  },
} as const satisfies Record<string, WeaponTuning>;

// Fallback tuning for unknown ids (procedural fallback anyway)
const DEFAULT_TUNING: WeaponTuning = {
  targetLength: 0.22,
  gripOffset: { x: 0, y: 0, z: 0 },
  extraRotation: { x: 0, y: 0, z: 0 },
  scaleMult: 1.0,
  muzzleZ: -0.14,
};

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

// Check if a scene has any SkinnedMesh nodes
function hasSkinnedMesh(obj: THREE.Object3D): boolean {
  let found = false;
  obj.traverse((child) => {
    if (child instanceof THREE.SkinnedMesh) found = true;
  });
  return found;
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

  /** Preloaded models, set once by the integration layer */
  private _models: Partial<Record<WeaponId, THREE.Object3D>> = {};

  /** The currently active model node (GLB clone) or null when procedural */
  private _activeModel: THREE.Object3D | null = null;

  /** The currently active procedural mesh group */
  private _proceduralMesh: THREE.Group | null = null;

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
   * Called once (or whenever models are updated) after async GLB loading.
   * Idempotent — safe to call before or after any setWeapon() call.
   * If called after setWeapon(), it will immediately swap in the model for
   * the current weapon if one is now available.
   */
  setWeaponModels(models: Partial<Record<WeaponId, THREE.Object3D>>): void {
    this._models = models;
    // Re-apply for the current weapon so the swap happens immediately
    this._applyCurrentWeaponVisual(this._currentId);
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
   * Remove any existing weapon visual children (model or procedural).
   * Always keeps the muzzle marker.
   */
  private _removeWeaponVisuals(): void {
    while (this._group.children.length > 0) {
      this._group.remove(this._group.children[0]);
    }
    this._group.add(this._muzzle);
    this._activeModel = null;
    this._proceduralMesh = null;
  }

  /**
   * Attach either a normalized GLB clone or a procedural mesh for the given
   * weapon id. Picks GLB when available in _models; otherwise falls back to
   * procedural boxes.
   */
  private _applyCurrentWeaponVisual(id: string): void {
    // Remove previous visuals before reattaching
    this._removeWeaponVisuals();

    const tuning = WEAPON_TUNING[id] ?? DEFAULT_TUNING;
    this._muzzle.position.set(0, 0.02, tuning.muzzleZ);

    const weaponId = id as WeaponId;
    const sourceModel = this._models[weaponId];

    if (sourceModel !== undefined) {
      // --- GLB path ---
      // Clone the model. If any SkinnedMesh is present we need SkeletonUtils;
      // these flat-gun packs have no skinned meshes, so .clone(true) suffices.
      // (Check is performed defensively; will warn in console if bones found.)
      if (hasSkinnedMesh(sourceModel)) {
        console.warn(
          `[viewmodel] SkinnedMesh found in ${id} model — shallow clone used; ` +
          'bones may not animate correctly. Consider importing SkeletonUtils.clone().',
        );
      }
      const modelClone: THREE.Object3D = sourceModel.clone(true);

      // Compute normalization
      const bbox = new THREE.Box3().setFromObject(sourceModel);
      const normResult = normalizeWeaponModel(bbox, {
        targetLength: tuning.targetLength,
        gripOffset: tuning.gripOffset,
        extraRotation: tuning.extraRotation,
      });

      // Apply scale + scaleMult
      const finalScale = normResult.scale * tuning.scaleMult;
      modelClone.scale.setScalar(finalScale);
      modelClone.rotation.copy(normResult.rotation);
      modelClone.position.copy(normResult.position);

      // Apply viewmodel render settings to every child mesh
      applyViewmodelMaterial(modelClone);

      this._group.add(modelClone);
      this._activeModel = modelClone;
    } else {
      // --- Procedural fallback ---
      let weaponMesh: THREE.Group;

      switch (id) {
        case 'ak47':
        case 'm4a4':
          weaponMesh = buildRifle();
          break;
        case 'awp':
          weaponMesh = buildAWP();
          break;
        case 'knife':
          weaponMesh = buildKnife();
          break;
        default:
          weaponMesh = buildPistol();
          break;
      }

      this._group.add(weaponMesh);
      this._proceduralMesh = weaponMesh;
    }
  }
}
