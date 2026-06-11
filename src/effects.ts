import * as THREE from 'three';
import type { Vec3 } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRACER_COLOR  = 0xffeeaa;
const IMPACT_COLOR  = 0xd8c49a;
const BLOOD_COLOR   = 0x8a1010;
const FLASH_COLOR   = 0xffffdd;
const DECAL_COLOR   = 0x331100;

const POOL_TRACERS  = 24;
const POOL_IMPACTS  = 32;
const POOL_BLOOD    = 16;
const POOL_FLASH    = 8;
const POOL_DECALS   = 64;

const TRACER_LIFE   = 0.07;   // seconds
const IMPACT_LIFE   = 0.25;
const BLOOD_LIFE    = 0.35;
const FLASH_LIFE    = 0.045;

const MIN_TRACER_LEN = 3;     // meters — skip tracers shorter than this

// ---------------------------------------------------------------------------
// Pooled particle entry
// ---------------------------------------------------------------------------

interface Particle {
  mesh:    THREE.Mesh;
  life:    number;   // remaining life in seconds (-1 = inactive)
  maxLife: number;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export class Effects {
  private _scene: THREE.Scene;

  // Tracer pool (thin stretched boxes).
  private _tracers: Particle[] = [];
  private _tracerIdx = 0;

  // Impact pool (small quads).
  private _impacts: Particle[] = [];
  private _impactIdx = 0;

  // Blood pool.
  private _blood: Particle[] = [];
  private _bloodIdx = 0;

  // Muzzle flash pool.
  private _flashes: Particle[] = [];
  private _flashIdx = 0;

  // Decal pool (circles).
  private _decals: THREE.Mesh[] = [];
  private _decalIdx = 0;

  constructor(scene: THREE.Scene) {
    this._scene = scene;
    this._init();
  }

  private _init(): void {
    // --- Tracers ---
    const tracerGeo = new THREE.BoxGeometry(0.012, 0.012, 1);
    const tracerMat = new THREE.MeshBasicMaterial({
      color: TRACER_COLOR,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    for (let i = 0; i < POOL_TRACERS; i++) {
      const mesh = new THREE.Mesh(tracerGeo, tracerMat.clone());
      mesh.visible = false;
      this._scene.add(mesh);
      this._tracers.push({ mesh, life: -1, maxLife: TRACER_LIFE });
    }

    // --- Impacts ---
    const impactGeo = new THREE.PlaneGeometry(0.25, 0.25);
    const impactMat = new THREE.MeshBasicMaterial({
      color: IMPACT_COLOR,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (let i = 0; i < POOL_IMPACTS; i++) {
      const mesh = new THREE.Mesh(impactGeo, impactMat.clone());
      mesh.visible = false;
      this._scene.add(mesh);
      this._impacts.push({ mesh, life: -1, maxLife: IMPACT_LIFE });
    }

    // --- Blood ---
    const bloodGeo = new THREE.SphereGeometry(0.06, 4, 4);
    const bloodMat = new THREE.MeshBasicMaterial({
      color: BLOOD_COLOR,
      transparent: true,
      depthWrite: false,
    });
    for (let i = 0; i < POOL_BLOOD; i++) {
      const mesh = new THREE.Mesh(bloodGeo, bloodMat.clone());
      mesh.visible = false;
      this._scene.add(mesh);
      this._blood.push({ mesh, life: -1, maxLife: BLOOD_LIFE });
    }

    // --- Muzzle flash ---
    const flashGeo = new THREE.PlaneGeometry(0.22, 0.22);
    const flashMat = new THREE.MeshBasicMaterial({
      color: FLASH_COLOR,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    for (let i = 0; i < POOL_FLASH; i++) {
      const mesh = new THREE.Mesh(flashGeo, flashMat.clone());
      mesh.visible = false;
      this._scene.add(mesh);
      this._flashes.push({ mesh, life: -1, maxLife: FLASH_LIFE });
    }

    // --- Decals ---
    const decalGeo = new THREE.CircleGeometry(0.05, 8);
    const decalMat = new THREE.MeshBasicMaterial({
      color: DECAL_COLOR,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    for (let i = 0; i < POOL_DECALS; i++) {
      const mesh = new THREE.Mesh(decalGeo, decalMat.clone());
      mesh.visible = false;
      this._scene.add(mesh);
      this._decals.push(mesh);
    }
  }

  update(dt: number): void {
    this._updatePool(this._tracers, dt);
    this._updatePool(this._impacts, dt);
    this._updatePool(this._blood, dt);
    this._updatePool(this._flashes, dt);
  }

  private _updatePool(pool: Particle[], dt: number): void {
    for (const p of pool) {
      if (p.life < 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.life = -1;
        p.mesh.visible = false;
        return;
      }
      const t = p.life / p.maxLife; // 1 at start, 0 at end
      const m = p.mesh.material as THREE.MeshBasicMaterial;
      m.opacity = t;
    }
  }

  private _nextParticle(
    pool: Particle[],
    idx: { value: number },
  ): Particle {
    const p = pool[idx.value % pool.length];
    idx.value = (idx.value + 1) % pool.length;
    return p;
  }

  tracer(from: Vec3, to: Vec3): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < MIN_TRACER_LEN) return;

    const idx = { value: this._tracerIdx };
    const p   = this._nextParticle(this._tracers, idx);
    this._tracerIdx = idx.value;

    p.life    = TRACER_LIFE;
    p.maxLife = TRACER_LIFE;

    const mesh = p.mesh;
    mesh.visible = true;

    // Position at midpoint, scale Z to length, orient along direction.
    mesh.position.set(
      (from.x + to.x) / 2,
      (from.y + to.y) / 2,
      (from.z + to.z) / 2,
    );
    mesh.scale.set(1, 1, len);
    mesh.lookAt(to.x, to.y, to.z);

    const m = mesh.material as THREE.MeshBasicMaterial;
    m.opacity = 1;
  }

  impact(point: Vec3, normal: Vec3, _surface: 'world' | 'flesh'): void {
    const idx = { value: this._impactIdx };
    const p   = this._nextParticle(this._impacts, idx);
    this._impactIdx = idx.value;

    p.life    = IMPACT_LIFE;
    p.maxLife = IMPACT_LIFE;

    const mesh = p.mesh;
    mesh.visible = true;
    mesh.position.set(point.x, point.y, point.z);
    // Orient plane to face along normal.
    const target = new THREE.Vector3(
      point.x + normal.x,
      point.y + normal.y,
      point.z + normal.z,
    );
    mesh.lookAt(target);
    const scale = 0.8 + Math.random() * 0.5;
    mesh.scale.set(scale, scale, 1);

    const m = mesh.material as THREE.MeshBasicMaterial;
    m.opacity = 1;
  }

  blood(point: Vec3): void {
    const idx = { value: this._bloodIdx };
    const p   = this._nextParticle(this._blood, idx);
    this._bloodIdx = idx.value;

    p.life    = BLOOD_LIFE;
    p.maxLife = BLOOD_LIFE;

    const mesh = p.mesh;
    mesh.visible = true;
    mesh.position.set(
      point.x + (Math.random() - 0.5) * 0.15,
      point.y + 0.05 + Math.random() * 0.2,
      point.z + (Math.random() - 0.5) * 0.15,
    );
    const scale = 0.6 + Math.random() * 0.8;
    mesh.scale.set(scale, scale, scale);

    const m = mesh.material as THREE.MeshBasicMaterial;
    m.opacity = 1;
  }

  muzzleFlash(worldPos: Vec3): void {
    const idx = { value: this._flashIdx };
    const p   = this._nextParticle(this._flashes, idx);
    this._flashIdx = idx.value;

    p.life    = FLASH_LIFE;
    p.maxLife = FLASH_LIFE;

    const mesh = p.mesh;
    mesh.visible = true;
    mesh.position.set(worldPos.x, worldPos.y, worldPos.z);
    mesh.rotation.z = Math.random() * Math.PI * 2;
    const scale = 0.8 + Math.random() * 0.6;
    mesh.scale.set(scale, scale, 1);

    const m = mesh.material as THREE.MeshBasicMaterial;
    m.opacity = 1;
  }

  addDecal(point: Vec3, normal: Vec3): void {
    const mesh = this._decals[this._decalIdx % POOL_DECALS];
    this._decalIdx = (this._decalIdx + 1) % POOL_DECALS;

    mesh.visible = true;
    // Offset along normal to avoid z-fighting.
    mesh.position.set(
      point.x + normal.x * 0.01,
      point.y + normal.y * 0.01,
      point.z + normal.z * 0.01,
    );
    const target = new THREE.Vector3(
      point.x + normal.x,
      point.y + normal.y,
      point.z + normal.z,
    );
    mesh.lookAt(target);

    const m = mesh.material as THREE.MeshBasicMaterial;
    m.opacity = 0.75;
  }

  clearDecals(): void {
    for (const mesh of this._decals) {
      mesh.visible = false;
    }
    this._decalIdx = 0;
  }
}
