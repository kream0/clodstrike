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
const SPARK_COLOR   = 0xffd27a;
const DUST_COLOR    = 0xb8a888;
const CASING_COLOR  = 0xd8a23a; // warm brass

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
const POOL_SPARKS   = 64;   // total spark mesh slots (~8 shots × 8 sparks each)
const POOL_DUST     = 16;   // one puff per world impact
const POOL_CASINGS  = 16;   // rolling window — cosmetic only

const TRACER_LIFE   = 0.07;   // seconds
const IMPACT_LIFE   = 0.25;
const BLOOD_LIFE    = 0.35;
const FLASH_LIFE    = 0.045;
const SPARK_LIFE_MIN = 0.18;  // seconds — minimum spark life
const SPARK_LIFE_MAX = 0.35;  // seconds — maximum spark life
const DUST_LIFE     = 0.30;   // seconds
const SPARKS_PER_IMPACT = 7;  // sparks emitted per world hit
const SPARK_GRAVITY = 12;     // m/s² downward (cosmetic)
const SPARK_SPEED_MIN = 1.5;  // m/s initial speed
const SPARK_SPEED_MAX = 4.5;  // m/s initial speed
const DUST_SCALE_START = 0.08; // world units
const DUST_SCALE_END   = 0.40; // world units

// Muzzle smoke — subtle grey wisps, normal alpha (not additive) to read as smoke
const SMOKE_COLOR       = 0x9a9a96;
const POOL_SMOKE        = 12;
const SMOKE_LIFE        = 0.35;  // seconds — short, won't fog sustained auto-fire
const SMOKE_SCALE_START = 0.06;  // world units at spawn
const SMOKE_SCALE_END   = 0.35;  // world units at expiry
const SMOKE_OPACITY_START = 0.35; // low initial alpha — subtle
const SMOKE_DRIFT_UP    = 0.40;  // m/s upward drift

// Casing ejection constants
const CASING_GRAVITY    = 9.8;  // m/s² — realistic tumble gravity
const CASING_LIFE_MIN   = 1.2;  // seconds
const CASING_LIFE_MAX   = 1.8;  // seconds
const CASING_SPEED_MIN  = 2.0;  // m/s ejection speed
const CASING_SPEED_MAX  = 3.5;  // m/s ejection speed
const CASING_BOUNCE_DY  = 0.4;  // vy damping on floor bounce
const CASING_BOUNCE_DXZ = 0.5;  // horizontal damping on bounce
const CASING_SPIN_MIN   = 6;    // rad/s rotation speed minimum
const CASING_SPIN_MAX   = 18;   // rad/s rotation speed maximum
const CASING_FADE_START = 0.3;  // seconds before expiry when fade begins

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
// Spark particle — Particle + per-axis velocity (no per-frame heap alloc)
// ---------------------------------------------------------------------------

interface SparkParticle extends Particle {
  vx: number;
  vy: number;
  vz: number;
}

// ---------------------------------------------------------------------------
// Dust puff particle — Particle + start/end scale for expand-and-fade
// ---------------------------------------------------------------------------

interface DustParticle extends Particle {
  startScale: number;
  endScale:   number;
}

// ---------------------------------------------------------------------------
// Muzzle smoke particle — Particle + upward drift (no heap alloc)
// ---------------------------------------------------------------------------

interface SmokeParticle extends Particle {
  vy: number;  // upward drift velocity (m/s), set per-emission
}

// ---------------------------------------------------------------------------
// Casing particle — Particle + velocity, angular spin, floor Y, bounce flag
// ---------------------------------------------------------------------------

interface CasingParticle extends Particle {
  vx:      number;
  vy:      number;
  vz:      number;
  spinX:   number;  // rad/s rotation around local X
  spinZ:   number;  // rad/s rotation around local Z
  floorY:  number;
  bounced: boolean;
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

  // Impact spark pool — additive tiny boxes, world hits only.
  private _sparks: SparkParticle[] = [];
  private _sparkIdx = 0;

  // Dust puff pool — additive quads that expand and fade, world hits only.
  private _dust: DustParticle[] = [];
  private _dustIdx = 0;

  // Shell-casing pool — cosmetic only, never affects sim.
  private _casings: CasingParticle[] = [];
  private _casingIdx = 0;

  // Muzzle smoke pool — soft grey quads, normal alpha blending.
  private _smoke: SmokeParticle[] = [];
  private _smokeIdx = 0;

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

    // --- Impact sparks (world hits only) ---
    // Tiny bright boxes with additive blending so bloom catches them.
    const sparkGeo = new THREE.BoxGeometry(0.022, 0.022, 0.022);
    const sparkMat = new THREE.MeshBasicMaterial({
      color: SPARK_COLOR,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    for (let i = 0; i < POOL_SPARKS; i++) {
      const mesh = new THREE.Mesh(sparkGeo, sparkMat.clone());
      mesh.visible = false;
      this._scene.add(mesh);
      this._sparks.push({ mesh, life: -1, maxLife: SPARK_LIFE_MAX, vx: 0, vy: 0, vz: 0 });
    }

    // --- Dust puffs (world hits only) ---
    // Additive grey-tan quads that expand and fade; positioned along the hit normal.
    const dustGeo = new THREE.PlaneGeometry(1, 1); // scaled per-puff
    const dustMat = new THREE.MeshBasicMaterial({
      color: DUST_COLOR,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    for (let i = 0; i < POOL_DUST; i++) {
      const mesh = new THREE.Mesh(dustGeo, dustMat.clone());
      mesh.visible = false;
      this._scene.add(mesh);
      this._dust.push({
        mesh,
        life:       -1,
        maxLife:    DUST_LIFE,
        startScale: DUST_SCALE_START,
        endScale:   DUST_SCALE_END,
      });
    }

    // --- Muzzle smoke wisps ---
    // Soft grey quads with normal alpha (not additive) so they read as smoke,
    // not a glow.  Short life + small pool self-limit fogging during auto-fire.
    const smokeGeo = new THREE.PlaneGeometry(1, 1); // scaled per-emission
    const smokeMat = new THREE.MeshBasicMaterial({
      color:       SMOKE_COLOR,
      transparent: true,
      depthWrite:  false,
      side:        THREE.DoubleSide,
      // No AdditiveBlending — normal alpha so smoke appears grey, not bright.
    });
    for (let i = 0; i < POOL_SMOKE; i++) {
      const mesh = new THREE.Mesh(smokeGeo, smokeMat.clone());
      mesh.visible = false;
      this._scene.add(mesh);
      this._smoke.push({ mesh, life: -1, maxLife: SMOKE_LIFE, vy: 0 });
    }

    // --- Shell casings (player gunshot, cosmetic only) ---
    // Tiny brass cylinder: ~0.02 m radius, 0.045 m tall.
    const casingGeo = new THREE.CylinderGeometry(0.010, 0.010, 0.045, 6);
    const casingMat = new THREE.MeshBasicMaterial({
      color: CASING_COLOR,
      transparent: true,
    });
    for (let i = 0; i < POOL_CASINGS; i++) {
      const mesh = new THREE.Mesh(casingGeo, casingMat.clone());
      mesh.visible = false;
      this._scene.add(mesh);
      this._casings.push({
        mesh,
        life:    -1,
        maxLife: CASING_LIFE_MAX,
        vx: 0, vy: 0, vz: 0,
        spinX: 0, spinZ: 0,
        floorY:  0,
        bounced: false,
      });
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
    this._updateSparks(dt);
    this._updateDust(dt);
    this._updateCasings(dt);
    this._updateMuzzleSmoke(dt);
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

    if (_surface === 'world') {
      this._emitSparks(point, normal);
      this._emitDust(point, normal);
    }
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

    // Smoke wisp — internal, cosmetic only.
    this._emitMuzzleSmoke(worldPos);
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
  // Impact sparks + dust puff (world hits only, cosmetic, Math.random ok)
  // ---------------------------------------------------------------------------

  /**
   * Emit SPARKS_PER_IMPACT spark particles from a world-hit point.
   * Each spark gets a velocity that is: surface-normal base direction
   * + random hemisphere spread.  Gravity is integrated in _updateSparks.
   * No heap allocation: reuses pooled SparkParticle objects.
   */
  private _emitSparks(point: Vec3, normal: Vec3): void {
    // Build two arbitrary tangent vectors from the normal so we can spread
    // sparks into a hemisphere around it.  Use a stable "up" fallback.
    const nx = normal.x;
    const ny = normal.y;
    const nz = normal.z;

    // Pick a vector not parallel to normal for cross-product.
    const absDotUp = Math.abs(ny);
    let tx: number, ty: number, tz: number;
    if (absDotUp < 0.9) {
      // cross(normal, worldUp)
      tx =  nz;
      ty =  0;
      tz = -nx;
    } else {
      // cross(normal, worldRight)
      tx =  0;
      ty = -nz;
      tz =  ny;
    }
    // Normalise tangent.
    const tlen = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    tx /= tlen; ty /= tlen; tz /= tlen;

    // Bitangent = cross(normal, tangent).
    const bx = ny * tz - nz * ty;
    const by = nz * tx - nx * tz;
    const bz = nx * ty - ny * tx;

    for (let i = 0; i < SPARKS_PER_IMPACT; i++) {
      const sp = this._sparks[this._sparkIdx % POOL_SPARKS];
      this._sparkIdx = (this._sparkIdx + 1) % POOL_SPARKS;

      // Random direction in the outward hemisphere: normal + spread.
      const spreadAngle = Math.random() * Math.PI * 2;
      const spreadRadius = Math.random() * 0.85; // 0..0.85 controls cone width
      const dirX = nx + (Math.cos(spreadAngle) * tx + Math.sin(spreadAngle) * bx) * spreadRadius;
      const dirY = ny + (Math.cos(spreadAngle) * ty + Math.sin(spreadAngle) * by) * spreadRadius;
      const dirZ = nz + (Math.cos(spreadAngle) * tz + Math.sin(spreadAngle) * bz) * spreadRadius;
      const dlen = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;

      const speed = SPARK_SPEED_MIN + Math.random() * (SPARK_SPEED_MAX - SPARK_SPEED_MIN);
      sp.vx = (dirX / dlen) * speed;
      sp.vy = (dirY / dlen) * speed;
      sp.vz = (dirZ / dlen) * speed;

      const life = SPARK_LIFE_MIN + Math.random() * (SPARK_LIFE_MAX - SPARK_LIFE_MIN);
      sp.life    = life;
      sp.maxLife = life;

      // Spawn at impact point (offset 1 cm along normal to avoid z-fight).
      sp.mesh.position.set(
        point.x + nx * 0.01,
        point.y + ny * 0.01,
        point.z + nz * 0.01,
      );
      sp.mesh.scale.set(1, 1, 1);
      sp.mesh.visible = true;
      (sp.mesh.material as THREE.MeshBasicMaterial).opacity = 1;
    }
  }

  /**
   * Emit a single dust puff at the impact point, offset along the normal,
   * facing the normal direction.  Expands and fades over DUST_LIFE seconds.
   * No heap allocation: reuses pooled DustParticle objects.
   */
  private _emitDust(point: Vec3, normal: Vec3): void {
    const dp = this._dust[this._dustIdx % POOL_DUST];
    this._dustIdx = (this._dustIdx + 1) % POOL_DUST;

    dp.life    = DUST_LIFE;
    dp.maxLife = DUST_LIFE;

    // Place slightly off the surface along the normal.
    dp.mesh.position.set(
      point.x + normal.x * 0.04,
      point.y + normal.y * 0.04,
      point.z + normal.z * 0.04,
    );
    // Orient the quad to face along the normal (billboard toward the hit surface).
    dp.mesh.lookAt(
      point.x + normal.x,
      point.y + normal.y,
      point.z + normal.z,
    );
    dp.mesh.scale.set(DUST_SCALE_START, DUST_SCALE_START, 1);
    dp.mesh.visible = true;
    (dp.mesh.material as THREE.MeshBasicMaterial).opacity = 0.55;
  }

  /** Integrate spark velocities + gravity, fade opacity over life. */
  private _updateSparks(dt: number): void {
    for (const sp of this._sparks) {
      if (sp.life < 0) continue;
      sp.life -= dt;
      if (sp.life <= 0) {
        sp.life = -1;
        sp.mesh.visible = false;
        continue;
      }
      // Integrate velocity (gravity in -Y).
      sp.vy -= SPARK_GRAVITY * dt;
      sp.mesh.position.x += sp.vx * dt;
      sp.mesh.position.y += sp.vy * dt;
      sp.mesh.position.z += sp.vz * dt;

      // Fade to transparent; clamp to [0,1].
      const t = sp.life / sp.maxLife; // 1→0
      (sp.mesh.material as THREE.MeshBasicMaterial).opacity = t;
    }
  }

  /** Expand and fade dust puffs over their lifetime. */
  private _updateDust(dt: number): void {
    for (const dp of this._dust) {
      if (dp.life < 0) continue;
      dp.life -= dt;
      if (dp.life <= 0) {
        dp.life = -1;
        dp.mesh.visible = false;
        continue;
      }
      const t = dp.life / dp.maxLife; // 1→0; we want scale to grow as t falls
      const s = dp.startScale + (dp.endScale - dp.startScale) * (1 - t);
      dp.mesh.scale.set(s, s, 1);
      // Opacity fades but also eases-in at the start to avoid a harsh pop.
      const opacity = t * t * 0.55; // quadratic fade-out
      (dp.mesh.material as THREE.MeshBasicMaterial).opacity = opacity;
    }
  }

  // ---------------------------------------------------------------------------
  // Muzzle smoke (every muzzle flash — player + bots, cosmetic)
  // ---------------------------------------------------------------------------

  /**
   * Emit a single smoke wisp at the muzzle position.
   * Placed at worldPos with a tiny random XZ jitter so repeat shots don't
   * stack identically.  Starts small and faint; expands + drifts upward +
   * fades over SMOKE_LIFE seconds.  No heap allocation.
   */
  private _emitMuzzleSmoke(worldPos: Vec3): void {
    const sp = this._smoke[this._smokeIdx % POOL_SMOKE];
    this._smokeIdx = (this._smokeIdx + 1) % POOL_SMOKE;

    sp.life    = SMOKE_LIFE;
    sp.maxLife = SMOKE_LIFE;
    sp.vy      = SMOKE_DRIFT_UP + Math.random() * 0.15; // slight speed variation

    const jx = (Math.random() - 0.5) * 0.06;
    const jz = (Math.random() - 0.5) * 0.06;
    sp.mesh.position.set(worldPos.x + jx, worldPos.y, worldPos.z + jz);

    // Random billboard rotation so repeated shots don't overlap identically.
    sp.mesh.rotation.z = Math.random() * Math.PI * 2;

    sp.mesh.scale.set(SMOKE_SCALE_START, SMOKE_SCALE_START, 1);
    sp.mesh.visible = true;
    (sp.mesh.material as THREE.MeshBasicMaterial).opacity = SMOKE_OPACITY_START;
  }

  /** Expand, drift upward, and fade smoke wisps over their lifetime. */
  private _updateMuzzleSmoke(dt: number): void {
    for (const sp of this._smoke) {
      if (sp.life < 0) continue;
      sp.life -= dt;
      if (sp.life <= 0) {
        sp.life = -1;
        sp.mesh.visible = false;
        continue;
      }

      // t goes 1 → 0 as life drains.
      const t = sp.life / sp.maxLife;

      // Expand: lerp from start scale to end scale as t decreases.
      const s = SMOKE_SCALE_START + (SMOKE_SCALE_END - SMOKE_SCALE_START) * (1 - t);
      sp.mesh.scale.set(s, s, 1);

      // Upward drift: integrate vy.
      sp.mesh.position.y += sp.vy * dt;

      // Fade: linear, from SMOKE_OPACITY_START to 0.
      (sp.mesh.material as THREE.MeshBasicMaterial).opacity = SMOKE_OPACITY_START * t;
    }
  }

  // ---------------------------------------------------------------------------
  // Shell-casing ejection (cosmetic, player only)
  // ---------------------------------------------------------------------------

  /**
   * Eject a brass shell casing to the right of the muzzle.
   * `origin`   — world-space spawn position (muzzle + right offset).
   * `ejectDir` — initial velocity direction (player right + slight upward bias).
   * `floorY`   — world Y of the floor the casing should bounce on / settle onto.
   * Math.random() is fine here; casings are never in the recorded replay frames.
   */
  ejectCasing(origin: Vec3, ejectDir: Vec3, floorY: number): void {
    const cp = this._casings[this._casingIdx % POOL_CASINGS];
    this._casingIdx = (this._casingIdx + 1) % POOL_CASINGS;

    const speed = CASING_SPEED_MIN + Math.random() * (CASING_SPEED_MAX - CASING_SPEED_MIN);
    // Normalise ejectDir (caller may pass an un-normalised sum).
    const len = Math.sqrt(ejectDir.x * ejectDir.x + ejectDir.y * ejectDir.y + ejectDir.z * ejectDir.z) || 1;
    // Add small random spread so casings don't stack identically.
    const spreadScale = 0.15;
    cp.vx = (ejectDir.x / len + (Math.random() - 0.5) * spreadScale) * speed;
    cp.vy = (ejectDir.y / len + Math.random() * spreadScale)          * speed; // only upward spread
    cp.vz = (ejectDir.z / len + (Math.random() - 0.5) * spreadScale) * speed;

    cp.spinX = (Math.random() < 0.5 ? 1 : -1) * (CASING_SPIN_MIN + Math.random() * (CASING_SPIN_MAX - CASING_SPIN_MIN));
    cp.spinZ = (Math.random() < 0.5 ? 1 : -1) * (CASING_SPIN_MIN + Math.random() * (CASING_SPIN_MAX - CASING_SPIN_MIN));
    cp.floorY  = floorY;
    cp.bounced = false;

    const life = CASING_LIFE_MIN + Math.random() * (CASING_LIFE_MAX - CASING_LIFE_MIN);
    cp.life    = life;
    cp.maxLife = life;

    cp.mesh.position.set(origin.x, origin.y, origin.z);
    cp.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    cp.mesh.visible = true;
    (cp.mesh.material as THREE.MeshBasicMaterial).opacity = 1;
  }

  /** Integrate casing trajectories: gravity, one floor bounce, spin, fade. */
  private _updateCasings(dt: number): void {
    for (const cp of this._casings) {
      if (cp.life < 0) continue;
      cp.life -= dt;
      if (cp.life <= 0) {
        cp.life = -1;
        cp.mesh.visible = false;
        continue;
      }

      // Integrate gravity.
      cp.vy -= CASING_GRAVITY * dt;

      // Integrate position.
      cp.mesh.position.x += cp.vx * dt;
      cp.mesh.position.y += cp.vy * dt;
      cp.mesh.position.z += cp.vz * dt;

      // Floor collision — one bounce, then settle.
      const casingFloor = cp.floorY + 0.022; // half casing height
      if (cp.mesh.position.y < casingFloor && cp.vy < 0) {
        cp.mesh.position.y = casingFloor;
        if (!cp.bounced) {
          // First bounce: reflect vy with damping.
          cp.vy  = Math.abs(cp.vy) * CASING_BOUNCE_DY;
          cp.vx *= CASING_BOUNCE_DXZ;
          cp.vz *= CASING_BOUNCE_DXZ;
          cp.spinX *= 0.6;
          cp.spinZ *= 0.6;
          cp.bounced = true;
        } else {
          // Settled: kill vertical, drain horizontal quickly.
          cp.vy  = 0;
          cp.vx *= Math.max(0, 1 - dt * 8);
          cp.vz *= Math.max(0, 1 - dt * 8);
          cp.spinX *= Math.max(0, 1 - dt * 6);
          cp.spinZ *= Math.max(0, 1 - dt * 6);
        }
      }

      // Angular rotation.
      cp.mesh.rotation.x += cp.spinX * dt;
      cp.mesh.rotation.z += cp.spinZ * dt;

      // Fade opacity over the last CASING_FADE_START seconds.
      if (cp.life < CASING_FADE_START) {
        const t = cp.life / CASING_FADE_START; // 1→0
        (cp.mesh.material as THREE.MeshBasicMaterial).opacity = t;
      }
    }
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
