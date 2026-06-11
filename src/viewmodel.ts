import * as THREE from 'three';
import type { Vec3 } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VM_OFFSET = new THREE.Vector3(0.22, -0.22, -0.45);
const GUNMETAL  = 0x2a2a2e;
const GUN_DARK  = 0x1a1a1c;
const GUN_WOOD  = 0x5a3a1a;

// ---------------------------------------------------------------------------
// Per-weapon mesh factories (box-based)
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
// ViewModel class
// ---------------------------------------------------------------------------

export class ViewModel {
  private _group: THREE.Group;
  private _camera: THREE.Camera;
  private _anim: AnimState;
  private _muzzle: THREE.Object3D;
  private _visible = true;

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

  setWeapon(id: string): void {
    // Clear old meshes (keep muzzle).
    while (this._group.children.length > 0) {
      this._group.remove(this._group.children[0]);
    }
    this._group.add(this._muzzle);

    let weaponMesh: THREE.Group;
    let muzzleZ: number;

    switch (id) {
      case 'ak47':
      case 'm4a4':
        weaponMesh = buildRifle();
        muzzleZ    = -0.32;
        break;
      case 'awp':
        weaponMesh = buildAWP();
        muzzleZ    = -0.45;
        break;
      case 'knife':
        weaponMesh = buildKnife();
        muzzleZ    = -0.18;
        break;
      default: // pistols
        weaponMesh = buildPistol();
        muzzleZ    = -0.14;
        break;
    }

    // Muzzle position in viewmodel local space.
    this._muzzle.position.set(0, 0.02, muzzleZ);

    this._group.add(weaponMesh);
    this._group.position.copy(VM_OFFSET);
    this._group.rotation.set(0, 0, 0);

    // Reset switch animation.
    this._anim.switchTimer = 0.3;
    this._anim.reloadTimer = -1;
  }

  onFire(): void {
    this._anim.kickZ     = 0.06;
    this._anim.kickPitch = 0.05; // radians, visually added to group rotation
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
}
