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

// ---------------------------------------------------------------------------
// Dynamic flash light constants (tunable)
// Keep the pool SMALL — each always-present PointLight adds a per-fragment
// light-loop cost even when its intensity is 0 (driver/three.js still
// branches on it unless you call renderer.shadowMap.enabled = false globally).
// 5 slots covers simultaneous muzzle-flash + HE/bomb + flashbang.
// ---------------------------------------------------------------------------
const FLASH_LIGHT_POOL       = 5;

// Muzzle flash — warm, brief, modest radius
const MUZZLE_LIGHT_COLOR     = 0xffd9a0;
const MUZZLE_LIGHT_INTENSITY = 3.0;
const MUZZLE_LIGHT_DISTANCE  = 8;       // meters
const MUZZLE_LIGHT_DECAY     = 2;       // physically-based quadratic
const MUZZLE_LIGHT_LIFE      = 0.045;   // seconds (matches sprite life)

// Bomb / grenade explosion — warm orange, large radius
const EXPLOSION_LIGHT_COLOR     = 0xff7a30;
const EXPLOSION_LIGHT_INTENSITY = 12.0;
const EXPLOSION_LIGHT_DISTANCE  = 26;   // meters
const EXPLOSION_LIGHT_DECAY     = 2;
const EXPLOSION_LIGHT_LIFE      = 0.22; // seconds

// HE grenade — same colour, slightly smaller
const HE_LIGHT_INTENSITY = 9.0;
const HE_LIGHT_DISTANCE  = 22;          // meters
const HE_LIGHT_LIFE      = 0.18;        // seconds

// Flash-bang — pure white, widest radius
const FLASH_BANG_LIGHT_COLOR     = 0xffffff;
const FLASH_BANG_LIGHT_INTENSITY = 16.0;
const FLASH_BANG_LIGHT_DISTANCE  = 30;  // meters
const FLASH_BANG_LIGHT_DECAY     = 2;
const FLASH_BANG_LIGHT_LIFE      = 0.15; // seconds

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
// Pooled flash-light entry (dynamic PointLight, permanent scene member)
// ---------------------------------------------------------------------------

interface FlashLight {
  light:   THREE.PointLight;
  life:    number;   // remaining life in seconds (≤0 = inactive)
  maxLife: number;
  peak:    number;   // intensity at life=maxLife
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

  // Dynamic flash-light pool — created ONCE, NEVER added/removed at runtime.
  private _flashLights: FlashLight[] = [];
  private _flashLightIdx = 0;

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

    // --- Flash lights (permanent, intensity-modulated) ---
    // All lights are added to the scene ONCE here and NEVER removed.
    // Runtime mutations touch only position/color/intensity/distance.
    for (let i = 0; i < FLASH_LIGHT_POOL; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 1, MUZZLE_LIGHT_DECAY);
      light.castShadow = false; // point-light shadows are very expensive
      this._scene.add(light);
      this._flashLights.push({ light, life: 0, maxLife: 1, peak: 0 });
    }
  }

  update(dt: number): void {
    this._updatePool(this._tracers, dt);
    this._updatePool(this._impacts, dt);
    this._updatePool(this._blood, dt);
    this._updatePool(this._flashes, dt);
    if (this._expPoolsReady) this._updateExplosionPools(dt);
    if (this._grnPoolsReady) this._updateGrenadePool(dt);
    this._updateFlashLights(dt);
  }

  private _updatePool(pool: Particle[], dt: number): void {
    for (const p of pool) {
      if (p.life < 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.life = -1;
        p.mesh.visible = false;
        continue;
      }
      const t = p.life / p.maxLife; // 1 at start, 0 at end
      const m = p.mesh.material as THREE.MeshBasicMaterial;
      m.opacity = t;
    }
  }

  /**
   * Grab the next pooled PointLight and configure it for a new flash pulse.
   * Round-robin: if all slots are active, the oldest is recycled (rare).
   * No heap allocation — only scalar field writes.
   */
  private _flashLight(
    pos:          Vec3,
    colorHex:     number,
    peakIntensity: number,
    distance:     number,
    decay:        number,
    maxLife:      number,
  ): void {
    const slot = this._flashLights[this._flashLightIdx % FLASH_LIGHT_POOL];
    this._flashLightIdx = (this._flashLightIdx + 1) % FLASH_LIGHT_POOL;

    slot.light.position.set(pos.x, pos.y, pos.z);
    slot.light.color.setHex(colorHex);
    slot.light.distance = distance;
    slot.light.decay    = decay;
    slot.light.intensity = peakIntensity;
    slot.peak    = peakIntensity;
    slot.maxLife = maxLife;
    slot.life    = maxLife;
  }

  /**
   * Decay all active flash lights.  No allocation; quadratic ease-out
   * (t² curve) reads as a snappy pop then smooth tail.
   */
  private _updateFlashLights(dt: number): void {
    for (const slot of this._flashLights) {
      if (slot.life <= 0) continue;
      slot.life -= dt;
      if (slot.life <= 0) {
        slot.life = 0;
        slot.light.intensity = 0;
        continue;
      }
      // t goes 1 → 0 as life drains; square it for quadratic ease-out.
      const t = slot.life / slot.maxLife; // linear 1→0
      slot.light.intensity = slot.peak * (t * t);
    }
  }

  tracer(from: Vec3, to: Vec3): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < MIN_TRACER_LEN) return;

    const p = this._tracers[this._tracerIdx % this._tracers.length];
    this._tracerIdx = (this._tracerIdx + 1) % this._tracers.length;

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
    const p = this._impacts[this._impactIdx % this._impacts.length];
    this._impactIdx = (this._impactIdx + 1) % this._impacts.length;

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
    const p = this._blood[this._bloodIdx % this._blood.length];
    this._bloodIdx = (this._bloodIdx + 1) % this._blood.length;

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
    const p = this._flashes[this._flashIdx % this._flashes.length];
    this._flashIdx = (this._flashIdx + 1) % this._flashes.length;

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

    // Dynamic point-light pulse — illuminates nearby walls/geometry.
    this._flashLight(
      worldPos,
      MUZZLE_LIGHT_COLOR,
      MUZZLE_LIGHT_INTENSITY,
      MUZZLE_LIGHT_DISTANCE,
      MUZZLE_LIGHT_DECAY,
      MUZZLE_LIGHT_LIFE,
    );
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

  // ---------------------------------------------------------------------------
  // Explosion effect (appended — existing code untouched above)
  // ---------------------------------------------------------------------------
  // Pool sizes for explosion effects.
  // ExpParticle is an extended Particle with scale interpolation data.
  private _expFlash:  Particle[]    = [];
  private _expFlashIdx = 0;
  private _expSphere: Particle[]    = [];
  private _expSphereIdx = 0;
  private _expDebris: Particle[]    = [];
  private _expDebrisIdx = 0;
  private _expPoolsReady = false;

  private _initExplosionPools(): void {
    if (this._expPoolsReady) return;
    this._expPoolsReady = true;

    // Flash quad — large bright additive plane.
    const flashGeo = new THREE.PlaneGeometry(1, 1);
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    for (let i = 0; i < 4; i++) {
      const mesh = new THREE.Mesh(flashGeo, flashMat.clone());
      mesh.visible = false;
      this._scene.add(mesh);
      this._expFlash.push({ mesh, life: -1, maxLife: 0.18 });
    }

    // Expanding sphere.
    const sphereGeo = new THREE.SphereGeometry(1, 12, 8);
    const sphereMat = new THREE.MeshBasicMaterial({
      color: 0xff6600,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    for (let i = 0; i < 4; i++) {
      const mesh = new THREE.Mesh(sphereGeo, sphereMat.clone());
      mesh.visible = false;
      this._scene.add(mesh);
      this._expSphere.push({ mesh, life: -1, maxLife: 0.7 });
    }

    // Debris puffs — reuse impact-style quads.
    const debrisGeo = new THREE.PlaneGeometry(0.3, 0.3);
    const debrisMat = new THREE.MeshBasicMaterial({
      color: IMPACT_COLOR,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (let i = 0; i < 24; i++) {
      const mesh = new THREE.Mesh(debrisGeo, debrisMat.clone());
      mesh.visible = false;
      this._scene.add(mesh);
      this._expDebris.push({ mesh, life: -1, maxLife: 0.6 });
    }
  }

  explosion(center: Vec3): void {
    this._initExplosionPools();

    // Dynamic point-light — warm-orange burst illuminates the whole area.
    this._flashLight(
      { x: center.x, y: center.y + 1.5, z: center.z },
      EXPLOSION_LIGHT_COLOR,
      EXPLOSION_LIGHT_INTENSITY,
      EXPLOSION_LIGHT_DISTANCE,
      EXPLOSION_LIGHT_DECAY,
      EXPLOSION_LIGHT_LIFE,
    );

    // Flash quad — scale up fast.
    {
      const p = this._expFlash[this._expFlashIdx % this._expFlash.length];
      this._expFlashIdx = (this._expFlashIdx + 1) % this._expFlash.length;
      p.life    = 0.18;
      p.maxLife = 0.18;
      (p as Particle & { _startScale: number; _endScale: number })._startScale = 2;
      (p as Particle & { _startScale: number; _endScale: number })._endScale   = 16;
      p.mesh.visible = true;
      p.mesh.position.set(center.x, center.y + 2, center.z);
      p.mesh.scale.set(2, 2, 1);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = 1;
    }

    // Expanding sphere.
    {
      const p = this._expSphere[this._expSphereIdx % this._expSphere.length];
      this._expSphereIdx = (this._expSphereIdx + 1) % this._expSphere.length;
      p.life    = 0.7;
      p.maxLife = 0.7;
      (p as Particle & { _startScale: number; _endScale: number })._startScale = 0.5;
      (p as Particle & { _startScale: number; _endScale: number })._endScale   = 12;
      p.mesh.visible = true;
      p.mesh.position.set(center.x, center.y, center.z);
      p.mesh.scale.set(0.5, 0.5, 0.5);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.75;
    }

    // Debris puffs.
    for (let i = 0; i < 12; i++) {
      const p = this._expDebris[this._expDebrisIdx % this._expDebris.length];
      this._expDebrisIdx = (this._expDebrisIdx + 1) % this._expDebris.length;
      p.life    = 0.3 + Math.random() * 0.3;
      p.maxLife = p.life;
      const angle  = Math.random() * Math.PI * 2;
      const radius = 1.5 + Math.random() * 4;
      p.mesh.visible = true;
      p.mesh.position.set(
        center.x + Math.cos(angle) * radius,
        center.y + 0.5 + Math.random() * 3,
        center.z + Math.sin(angle) * radius,
      );
      const s = 0.5 + Math.random() * 1.2;
      p.mesh.scale.set(s, s, 1);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9;
    }
  }

  private _updateExplosionPools(dt: number): void {
    // Flash.
    for (const p of this._expFlash) {
      if (p.life < 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.life = -1; p.mesh.visible = false; continue; }
      const t  = p.life / p.maxLife; // 1→0
      const ep = p as Particle & { _startScale: number; _endScale: number };
      const s  = ep._endScale + (ep._startScale - ep._endScale) * t;
      p.mesh.scale.set(s, s, 1);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = t;
    }
    // Sphere.
    for (const p of this._expSphere) {
      if (p.life < 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.life = -1; p.mesh.visible = false; continue; }
      const t  = p.life / p.maxLife;
      const ep = p as Particle & { _startScale: number; _endScale: number };
      const s  = ep._startScale + (ep._endScale - ep._startScale) * (1 - t);
      p.mesh.scale.set(s, s, s);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = t * 0.6;
    }
    // Debris.
    for (const p of this._expDebris) {
      if (p.life < 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.life = -1; p.mesh.visible = false; continue; }
      const t = p.life / p.maxLife;
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = t;
    }
  }

  // ---------------------------------------------------------------------------
  // Grenade effects (appended — existing code untouched above)
  // ---------------------------------------------------------------------------
  // Lazy-initialised pools; allocated on first use to keep constructor fast.

  private _grnFlash:  Particle[] = [];
  private _grnFlashIdx = 0;
  private _grnSphere: Particle[] = [];
  private _grnSphereIdx = 0;
  private _grnDebris: Particle[] = [];
  private _grnDebrisIdx = 0;
  private _grnWhiteFlash: Particle[] = [];
  private _grnWhiteFlashIdx = 0;
  private _grnPoolsReady = false;

  private _initGrenadePool(): void {
    if (this._grnPoolsReady) return;
    this._grnPoolsReady = true;

    // HE flash quad — additive, scales up and fades (~0.55× bomb flash).
    const heFlashGeo = new THREE.PlaneGeometry(1, 1);
    const heFlashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    for (let i = 0; i < 4; i++) {
      const mesh = new THREE.Mesh(heFlashGeo, heFlashMat.clone());
      mesh.visible = false;
      this._scene.add(mesh);
      this._grnFlash.push({ mesh, life: -1, maxLife: 0.10 });
    }

    // HE expanding sphere — smaller/faster than bomb (~0.55× scale).
    const heSphereGeo = new THREE.SphereGeometry(1, 12, 8);
    const heSphereMat = new THREE.MeshBasicMaterial({
      color: 0xff7700,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    for (let i = 0; i < 4; i++) {
      const mesh = new THREE.Mesh(heSphereGeo, heSphereMat.clone());
      mesh.visible = false;
      this._scene.add(mesh);
      this._grnSphere.push({ mesh, life: -1, maxLife: 0.38 });
    }

    // HE debris puffs — same style as bomb debris.
    const debrisGeo = new THREE.PlaneGeometry(0.22, 0.22);
    const debrisMat = new THREE.MeshBasicMaterial({
      color: IMPACT_COLOR,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (let i = 0; i < 16; i++) {
      const mesh = new THREE.Mesh(debrisGeo, debrisMat.clone());
      mesh.visible = false;
      this._scene.add(mesh);
      this._grnDebris.push({ mesh, life: -1, maxLife: 0.4 });
    }

    // Flash-bang white burst — expanding point-light-style additive sprite.
    const wfGeo = new THREE.PlaneGeometry(1, 1);
    const wfMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    for (let i = 0; i < 4; i++) {
      const mesh = new THREE.Mesh(wfGeo, wfMat.clone());
      mesh.visible = false;
      this._scene.add(mesh);
      this._grnWhiteFlash.push({ mesh, life: -1, maxLife: 0.25 });
    }
  }

  /**
   * HE grenade detonation visual — ~0.55× scale of the bomb explosion.
   * Reuses the same flash-quad + expanding-sphere + debris-puff pattern.
   */
  heExplosion(pos: Vec3): void {
    this._initGrenadePool();

    // Dynamic point-light — same warm-orange colour as bomb, slightly smaller.
    this._flashLight(
      { x: pos.x, y: pos.y + 1.1, z: pos.z },
      EXPLOSION_LIGHT_COLOR,
      HE_LIGHT_INTENSITY,
      HE_LIGHT_DISTANCE,
      EXPLOSION_LIGHT_DECAY,
      HE_LIGHT_LIFE,
    );

    // Flash quad.
    {
      const p = this._grnFlash[this._grnFlashIdx % this._grnFlash.length];
      this._grnFlashIdx = (this._grnFlashIdx + 1) % this._grnFlash.length;
      p.life    = 0.10;
      p.maxLife = 0.10;
      (p as Particle & { _startScale: number; _endScale: number })._startScale = 1.1;
      (p as Particle & { _startScale: number; _endScale: number })._endScale   = 8.8;
      p.mesh.visible = true;
      p.mesh.position.set(pos.x, pos.y + 1.1, pos.z);
      p.mesh.scale.set(1.1, 1.1, 1);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = 1;
    }

    // Expanding sphere.
    {
      const p = this._grnSphere[this._grnSphereIdx % this._grnSphere.length];
      this._grnSphereIdx = (this._grnSphereIdx + 1) % this._grnSphere.length;
      p.life    = 0.38;
      p.maxLife = 0.38;
      (p as Particle & { _startScale: number; _endScale: number })._startScale = 0.28;
      (p as Particle & { _startScale: number; _endScale: number })._endScale   = 6.6;
      p.mesh.visible = true;
      p.mesh.position.set(pos.x, pos.y, pos.z);
      p.mesh.scale.set(0.28, 0.28, 0.28);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.75;
    }

    // Debris puffs.
    for (let i = 0; i < 8; i++) {
      const p = this._grnDebris[this._grnDebrisIdx % this._grnDebris.length];
      this._grnDebrisIdx = (this._grnDebrisIdx + 1) % this._grnDebris.length;
      p.life    = 0.18 + Math.random() * 0.22;
      p.maxLife = p.life;
      const angle  = Math.random() * Math.PI * 2;
      const radius = 0.8 + Math.random() * 2.2;
      p.mesh.visible = true;
      p.mesh.position.set(
        pos.x + Math.cos(angle) * radius,
        pos.y + 0.3 + Math.random() * 1.65,
        pos.z + Math.sin(angle) * radius,
      );
      const s = 0.3 + Math.random() * 0.66;
      p.mesh.scale.set(s, s, 1);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9;
    }

    // Scorch decal on floor plane (normal pointing up).
    this.addDecal({ x: pos.x, y: pos.y + 0.02, z: pos.z }, { x: 0, y: 1, z: 0 });
  }

  /**
   * Flash-bang detonation visual — expanding white point-light burst, ~0.25 s.
   */
  flashBurst(pos: Vec3): void {
    this._initGrenadePool();

    // Dynamic point-light — pure white, very bright, widest radius.
    this._flashLight(
      { x: pos.x, y: pos.y + 0.5, z: pos.z },
      FLASH_BANG_LIGHT_COLOR,
      FLASH_BANG_LIGHT_INTENSITY,
      FLASH_BANG_LIGHT_DISTANCE,
      FLASH_BANG_LIGHT_DECAY,
      FLASH_BANG_LIGHT_LIFE,
    );

    const p = this._grnWhiteFlash[this._grnWhiteFlashIdx % this._grnWhiteFlash.length];
    this._grnWhiteFlashIdx = (this._grnWhiteFlashIdx + 1) % this._grnWhiteFlash.length;
    p.life    = 0.25;
    p.maxLife = 0.25;
    (p as Particle & { _startScale: number; _endScale: number })._startScale = 0.5;
    (p as Particle & { _startScale: number; _endScale: number })._endScale   = 6;
    p.mesh.visible = true;
    p.mesh.position.set(pos.x, pos.y + 0.5, pos.z);
    p.mesh.scale.set(0.5, 0.5, 1);
    (p.mesh.material as THREE.MeshBasicMaterial).opacity = 1;
  }

  /**
   * Grenade bounce dust puff — tiny impact-style quad from the impact pool.
   */
  grenadeBounceDust(pos: Vec3): void {
    const p = this._impacts[this._impactIdx % this._impacts.length];
    this._impactIdx = (this._impactIdx + 1) % this._impacts.length;

    p.life    = IMPACT_LIFE * 0.6;
    p.maxLife = p.life;

    const mesh = p.mesh;
    mesh.visible = true;
    mesh.position.set(pos.x, pos.y + 0.05, pos.z);
    mesh.rotation.set(0, 0, Math.random() * Math.PI * 2);
    const scale = 0.35 + Math.random() * 0.25;
    mesh.scale.set(scale, scale, 1);

    const m = mesh.material as THREE.MeshBasicMaterial;
    m.opacity = 0.7;
  }

  private _updateGrenadePool(dt: number): void {
    // HE flash.
    for (const p of this._grnFlash) {
      if (p.life < 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.life = -1; p.mesh.visible = false; continue; }
      const t  = p.life / p.maxLife;
      const ep = p as Particle & { _startScale: number; _endScale: number };
      const s  = ep._endScale + (ep._startScale - ep._endScale) * t;
      p.mesh.scale.set(s, s, 1);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = t;
    }
    // HE sphere.
    for (const p of this._grnSphere) {
      if (p.life < 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.life = -1; p.mesh.visible = false; continue; }
      const t  = p.life / p.maxLife;
      const ep = p as Particle & { _startScale: number; _endScale: number };
      const s  = ep._startScale + (ep._endScale - ep._startScale) * (1 - t);
      p.mesh.scale.set(s, s, s);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = t * 0.6;
    }
    // HE debris.
    for (const p of this._grnDebris) {
      if (p.life < 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.life = -1; p.mesh.visible = false; continue; }
      const t = p.life / p.maxLife;
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = t;
    }
    // White flash burst.
    for (const p of this._grnWhiteFlash) {
      if (p.life < 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.life = -1; p.mesh.visible = false; continue; }
      const t  = p.life / p.maxLife;
      const ep = p as Particle & { _startScale: number; _endScale: number };
      const s  = ep._startScale + (ep._endScale - ep._startScale) * (1 - t);
      p.mesh.scale.set(s, s, 1);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = t * 0.85;
    }
  }
}
