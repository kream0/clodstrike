import * as THREE from 'three';
import type { Combatant, GrenadeType, GrenadeProjectile, SmokeVolume, Vec3 } from './types';
import { GRENADES, MOVEMENT } from './constants';
import { gameEvents } from './combat';
import { yawPitchToDir, normalize, dot, v3 } from './math';
import type { World } from './world';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SMOKE_REST_SPEED    = 0.5;    // m/s — grenade is "at rest" below this
const SMOKE_FUSE_CAP      = 3.0;    // s  — smoke detonates even if still rolling
const SMOKE_SCALE_IN_TIME = 0.4;    // s  — cloud grows from 0 to full radius
const SMOKE_FADE_TIME     = 1.5;    // s  — cloud fades out at end of life
const SELF_DAMAGE_SCALE   = 0.5;    // HE self-damage fraction
const WALLBANG_MULT       = 0.3;    // LOS-blocked damage multiplier
const FLASH_RANGE         = 22;     // m  — maximum flash range (mirrors GRENADES.flash.radius)
const FLASH_FULL_ANG      = Math.PI / 3;       // 60° — full-intensity arc
const FLASH_MID_ANG       = (2 * Math.PI) / 3; // 120° — mid-intensity boundary
const FLASH_INTENSITY_MID  = 0.45;
const FLASH_INTENSITY_AWAY = 0.20;
const FLASH_BASE_DUR       = 0.6;
const FLASH_EXTRA_DUR      = 3.4;

// Visual colors per grenade type.
const GRENADE_COLORS: Record<GrenadeType, number> = {
  he:    0x4a5d23,
  flash: 0xd8d8d0,
  smoke: 0x6a7a8a,
};

const SMOKE_SPHERE_COLOR  = 0x9aa4a8;
const SMOKE_SPHERE_OPACITY = 0.88;
const POOL_SMOKE_CLOUDS   = 4;      // max simultaneous smoke clouds
const SPHERES_PER_CLOUD   = 3;

// ---------------------------------------------------------------------------
// Internal pooled smoke cloud entry
// ---------------------------------------------------------------------------

interface SmokeCloud {
  meshes: THREE.Mesh[];
  active:    boolean;
  spawnAt:   number;   // game-time when this cloud spawned (for scale-in)
  expiresAt: number;   // game-time when this cloud expires (for fade-out)
  radius:    number;   // world-space full radius
}

// ---------------------------------------------------------------------------
// GrenadeManager
// ---------------------------------------------------------------------------

export type OnBounceCallback    = (pos: Vec3, speed: number) => void;
export type OnExplosionDamage   = (victim: Combatant, damage: number, thrower: Combatant | null) => void;

export class GrenadeManager {
  private readonly _scene: THREE.Scene;
  private _world: World;

  // Live projectiles.
  private _projectiles: GrenadeProjectile[] = [];
  private _nextId = 0;

  // Active smoke volumes (game-logic).
  private _smokes: SmokeVolume[] = [];

  // Pooled projectile meshes (one sphere per slot).
  private _projMeshes: THREE.Mesh[] = [];
  private _projMeshUsed: boolean[] = [];

  // Pooled smoke cloud meshes.
  private _smokeClouds: SmokeCloud[] = [];

  // Pre-allocated work vectors (no per-tick allocations).
  private readonly _wv      = v3();  // general work vector (raycast direction, allocation-free)
  private readonly _victEye = v3();  // reused per-victim eye position in detonation loops
  private readonly _blastDir = v3(); // reused per-victim blast direction in flash loop

  // Callbacks (wired by integration).
  onBounce?: OnBounceCallback;
  /** Called for each victim hit by an HE grenade with pre-computed damage + thrower reference. */
  onExplosionDamage?: OnExplosionDamage;

  constructor(scene: THREE.Scene, world: World) {
    this._scene = scene;
    this._world = world;
    this._initMeshPools();
  }

  setWorld(world: World): void { this._world = world; }

  // ---------------------------------------------------------------------------
  // Pool initialisation
  // ---------------------------------------------------------------------------

  private _initMeshPools(): void {
    // Projectile spheres — 16 slots is far more than enough for 5v5.
    const projGeo = new THREE.SphereGeometry(0.07, 6, 4);
    for (let i = 0; i < 16; i++) {
      // Each mesh gets its own material so we can colour per type.
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const mesh = new THREE.Mesh(projGeo, mat);
      mesh.visible = false;
      this._scene.add(mesh);
      this._projMeshes.push(mesh);
      this._projMeshUsed.push(false);
    }

    // Smoke cloud meshes — 4 clouds × 3 spheres each.
    const smokeGeo = new THREE.SphereGeometry(1, 8, 6);
    for (let c = 0; c < POOL_SMOKE_CLOUDS; c++) {
      const meshes: THREE.Mesh[] = [];
      for (let s = 0; s < SPHERES_PER_CLOUD; s++) {
        const mat = new THREE.MeshLambertMaterial({
          color: SMOKE_SPHERE_COLOR,
          transparent: true,
          opacity: SMOKE_SPHERE_OPACITY,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(smokeGeo, mat);
        mesh.visible = false;
        this._scene.add(mesh);
        meshes.push(mesh);
      }
      this._smokeClouds.push({
        meshes,
        active: false,
        spawnAt: 0,
        expiresAt: 0,
        radius: 0,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Public API — throwing
  // ---------------------------------------------------------------------------

  /**
   * Attempt to throw a grenade of `type` from `origin` in direction `dir`.
   * Returns false if the thrower has no grenades of that type.
   */
  throwGrenade(
    thrower: Combatant,
    type: GrenadeType,
    origin: Vec3,
    dir: Vec3,
    now: number,
  ): boolean {
    const count = thrower.grenades?.[type] ?? 0;
    if (count <= 0) return false;

    // Decrement inventory.
    if (thrower.grenades !== undefined) {
      thrower.grenades[type] = count - 1;
    }

    const def = GRENADES[type];
    const nDir = normalize(dir);

    // Initial velocity: throw direction + upward boost + 30% of thrower velocity.
    const vx = nDir.x * def.throwSpeed
      + (thrower.vel.x * 0.3);
    const vy = nDir.y * def.throwSpeed + def.upwardBoost
      + (thrower.vel.y * 0.3);
    const vz = nDir.z * def.throwSpeed
      + (thrower.vel.z * 0.3);

    // Detonation time: smoke fuse=0 → uses at-rest / cap logic; others use fuseSeconds.
    const detonatesAt = type === 'smoke'
      ? now + SMOKE_FUSE_CAP   // will be short-circuited by at-rest check in update
      : now + def.fuseSeconds;

    const pos: Vec3 = { x: origin.x, y: origin.y, z: origin.z };
    const vel: Vec3 = { x: vx, y: vy, z: vz };

    const proj: GrenadeProjectile = {
      id: this._nextId++,
      type,
      pos,
      vel,
      thrower,
      detonatesAt,
      detonated: false,
    };

    // Acquire a mesh from the pool.
    const meshIdx = this._acquireMesh();
    if (meshIdx >= 0) {
      const mesh = this._projMeshes[meshIdx]!;
      (mesh.material as THREE.MeshLambertMaterial).color.setHex(GRENADE_COLORS[type]);
      mesh.visible = true;
      mesh.position.set(pos.x, pos.y, pos.z);
      // Tag mesh to projectile id via userData.
      mesh.userData['projId'] = proj.id;
      mesh.userData['poolIdx'] = meshIdx;
      this._projMeshUsed[meshIdx] = true;
    }

    this._projectiles.push(proj);
    gameEvents.emit('grenadeThrown', { thrower, type });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Public API — update (called every fixed tick)
  // ---------------------------------------------------------------------------

  update(dt: number, now: number, combatants: Combatant[]): void {
    // Prune expired smoke volumes.
    for (let i = this._smokes.length - 1; i >= 0; i--) {
      if (now >= (this._smokes[i]?.expiresAt ?? 0)) {
        this._smokes.splice(i, 1);
      }
    }

    // Update each live projectile.
    for (let i = this._projectiles.length - 1; i >= 0; i--) {
      const p = this._projectiles[i];
      if (p === undefined) continue;
      if (p.detonated) {
        this._releaseMeshFor(p.id);
        this._projectiles.splice(i, 1);
        continue;
      }

      // --- Physics integration ---
      const def = GRENADES[p.type];

      // Gravity.
      p.vel.y -= MOVEMENT.GRAVITY * def.gravityScale * dt;

      // Displacement this tick.
      const dx = p.vel.x * dt;
      const dy = p.vel.y * dt;
      const dz = p.vel.z * dt;
      const stepDist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (stepDist > 1e-6) {
        // Raycast along displacement.
        this._wv.x = dx / stepDist;
        this._wv.y = dy / stepDist;
        this._wv.z = dz / stepDist;

        const hit = this._world.raycast(p.pos, this._wv, stepDist + def.projectileRadius);
        if (hit !== null && hit.distance <= stepDist + def.projectileRadius) {
          // Bounce: snap to just off surface.
          const snapDist = Math.max(0, hit.distance - def.projectileRadius);
          p.pos.x = p.pos.x + this._wv.x * snapDist;
          p.pos.y = p.pos.y + this._wv.y * snapDist;
          p.pos.z = p.pos.z + this._wv.z * snapDist;

          // Reflect velocity about hit normal, scaled by restitution.
          const n = hit.normal;
          const nLen = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
          if (nLen > 0) {
            const nx = n.x / nLen;
            const ny = n.y / nLen;
            const nz = n.z / nLen;
            const vDotN = p.vel.x * nx + p.vel.y * ny + p.vel.z * nz;

            // Normal component: reflect and scale by restitution.
            const rnx = -2 * vDotN * nx * def.restitution;
            const rny = -2 * vDotN * ny * def.restitution;
            const rnz = -2 * vDotN * nz * def.restitution;

            p.vel.x += rnx;
            p.vel.y += rny;
            p.vel.z += rnz;

            // If floor-like bounce (normal pointing mostly up), apply ground friction.
            if (ny > 0.7) {
              p.vel.x *= def.groundFriction;
              p.vel.z *= def.groundFriction;
            }

            const speed = Math.sqrt(p.vel.x * p.vel.x + p.vel.y * p.vel.y + p.vel.z * p.vel.z);
            this.onBounce?.(p.pos, speed);
          }
        } else {
          // Free flight.
          p.pos.x += dx;
          p.pos.y += dy;
          p.pos.z += dz;
        }
      }

      // Floor safety clamp.
      const floorY = this._world.floorAt(p.pos.x, p.pos.z);
      if (isFinite(floorY) && p.pos.y < floorY + def.projectileRadius) {
        p.pos.y = floorY + def.projectileRadius;
        if (p.vel.y < 0) p.vel.y = 0;
      }

      // Update mesh position.
      this._updateMeshPos(p);

      // --- Detonation checks ---
      const speed = Math.sqrt(
        p.vel.x * p.vel.x + p.vel.y * p.vel.y + p.vel.z * p.vel.z,
      );

      let shouldDetonate = false;

      if (p.type === 'smoke') {
        // Smoke: detonate when at rest or fuse cap reached.
        if (speed < SMOKE_REST_SPEED || now >= p.detonatesAt) {
          shouldDetonate = true;
        }
      } else {
        // HE / flash: fuse timer.
        if (now >= p.detonatesAt) {
          shouldDetonate = true;
        }
      }

      if (shouldDetonate) {
        p.detonated = true;
        this._detonate(p, now, combatants);
        this._releaseMeshFor(p.id);
        this._projectiles.splice(i, 1);
      }
    }

    // Update smoke cloud visuals.
    this._updateSmokeClouds(now);
  }

  // ---------------------------------------------------------------------------
  // Public API — queries
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the segment from `a` to `b` passes through any active
   * smoke volume (sphere). Allocation-free.
   */
  isSegmentSmoked(a: Vec3, b: Vec3): boolean {
    for (const sv of this._smokes) {
      if (this._segmentIntersectsSphere(a, b, sv.center, sv.radius)) {
        return true;
      }
    }
    return false;
  }

  activeSmokes(): readonly SmokeVolume[] {
    return this._smokes;
  }

  // ---------------------------------------------------------------------------
  // Public API — reset
  // ---------------------------------------------------------------------------

  reset(): void {
    // Clear all live projectiles and release meshes.
    for (const p of this._projectiles) {
      this._releaseMeshFor(p.id);
    }
    this._projectiles = [];
    this._smokes = [];

    // Hide all smoke cloud meshes.
    for (const cloud of this._smokeClouds) {
      cloud.active = false;
      for (const mesh of cloud.meshes) {
        mesh.visible = false;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Detonation
  // ---------------------------------------------------------------------------

  private _detonate(p: GrenadeProjectile, now: number, combatants: Combatant[]): void {
    const def = GRENADES[p.type];
    const pos = p.pos;

    gameEvents.emit('grenadeDetonated', { type: p.type, pos: { x: pos.x, y: pos.y, z: pos.z } });

    if (p.type === 'he') {
      this._detonateHE(p, def, pos, now, combatants);
    } else if (p.type === 'flash') {
      this._detonateFlash(p, def, pos, now, combatants);
    } else {
      // smoke
      this._detonateSmoke(def, pos, now);
    }
  }

  private _detonateHE(
    p: GrenadeProjectile,
    def: typeof GRENADES.he,
    pos: Vec3,
    now: number,
    combatants: Combatant[],
  ): void {
    const maxDmg = def.heMaxDamage ?? 98;
    const radius = def.radius;

    for (const victim of combatants) {
      if (!victim.alive) continue;

      // Friendly fire OFF: skip teammates, EXCEPT the thrower themselves.
      if (victim.team === p.thrower.team && victim !== p.thrower) continue;

      // Distance from blast to victim eye (feet + ~eye-height approximation).
      const eyeY = victim.pos.y + (victim.crouching ? 1.17 : 1.64);
      const dx = victim.pos.x - pos.x;
      const dy = eyeY - pos.y;
      const dz = victim.pos.z - pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist >= radius) continue;

      let dmg = maxDmg * (1 - dist / radius);

      // Self-damage at 50%.
      if (victim === p.thrower) dmg *= SELF_DAMAGE_SCALE;

      // LOS attenuation: if blast cannot see victim, wallbang-lite multiplier.
      this._victEye.x = victim.pos.x; this._victEye.y = eyeY; this._victEye.z = victim.pos.z;
      if (!this._world.lineOfSight(pos, this._victEye)) {
        dmg *= WALLBANG_MULT;
      }

      dmg = Math.max(0, Math.round(dmg));
      if (dmg <= 0) continue;

      if (this.onExplosionDamage !== undefined) {
        // Delegate actual health mutation + killfeed to integration.
        this.onExplosionDamage(victim, dmg, p.thrower);
      } else {
        // Fallback: apply directly (mirrors bomb logic in game.ts).
        victim.health -= dmg;
        if (victim.health <= 0) {
          victim.health = 0;
          victim.alive  = false;
          victim.deaths++;
          if (victim !== p.thrower) {
            p.thrower.kills++;
          }
          gameEvents.emit('kill', {
            attacker: p.thrower,
            victim,
            weaponId: 'hegrenade',
            headshot: false,
          });
        }
        gameEvents.emit('damage', {
          attacker: p.thrower,
          victim,
          amount: dmg,
          hitGroup: 'body',
        });
      }
    }
  }

  private _detonateFlash(
    p: GrenadeProjectile,
    def: typeof GRENADES.flash,
    pos: Vec3,
    _now: number,
    combatants: Combatant[],
  ): void {
    const radius = def.radius ?? FLASH_RANGE;

    for (const victim of combatants) {
      if (!victim.alive) continue;

      const eyeY = victim.pos.y + (victim.crouching ? 1.17 : 1.64);
      const dx = victim.pos.x - pos.x;
      const dy = eyeY - pos.y;
      const dz = victim.pos.z - pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist >= radius) continue;

      // LOS check: wall between blast and victim → no effect.
      this._victEye.x = victim.pos.x; this._victEye.y = eyeY; this._victEye.z = victim.pos.z;
      if (!this._world.lineOfSight(pos, this._victEye)) continue;

      // Facing factor: direction from victim to blast.
      this._blastDir.x = -dx / (dist + 1e-9);
      this._blastDir.y = -dy / (dist + 1e-9);
      this._blastDir.z = -dz / (dist + 1e-9);
      const viewDir = yawPitchToDir(victim.yaw, victim.pitch);
      const cosAngle = dot(viewDir, this._blastDir);
      const angle = Math.acos(Math.max(-1, Math.min(1, cosAngle)));

      let facingFactor: number;
      if (angle < FLASH_FULL_ANG) {
        facingFactor = 1.0;
      } else if (angle < FLASH_MID_ANG) {
        facingFactor = FLASH_INTENSITY_MID;
      } else {
        facingFactor = FLASH_INTENSITY_AWAY;
      }

      const intensity = (1 - dist / radius) * facingFactor;
      const duration  = FLASH_BASE_DUR + FLASH_EXTRA_DUR * intensity;

      victim.blindUntil     = _now + duration;
      victim.blindIntensity = intensity;

      gameEvents.emit('combatantFlashed', { victim, intensity, duration });
    }
  }

  private _detonateSmoke(
    def: typeof GRENADES.smoke,
    pos: Vec3,
    now: number,
  ): void {
    const duration = def.smokeDurationSeconds ?? 15;
    const sv: SmokeVolume = {
      center: { x: pos.x, y: pos.y, z: pos.z },
      radius: def.radius,
      expiresAt: now + duration,
    };
    this._smokes.push(sv);

    // Activate a pooled smoke cloud.
    const cloud = this._acquireSmokeCloud();
    if (cloud !== null) {
      cloud.active    = true;
      cloud.spawnAt   = now;
      cloud.expiresAt = sv.expiresAt;
      cloud.radius    = def.radius;

      // Position the three overlapping spheres with slight offsets.
      const offsets: [number, number, number][] = [
        [0, 0, 0],
        [def.radius * 0.3, def.radius * 0.15, def.radius * 0.2],
        [-def.radius * 0.2, def.radius * 0.1, -def.radius * 0.25],
      ];
      for (let s = 0; s < SPHERES_PER_CLOUD; s++) {
        const mesh = cloud.meshes[s];
        if (mesh === undefined) continue;
        const off = offsets[s] ?? [0, 0, 0];
        mesh.position.set(
          pos.x + off[0],
          pos.y + off[1],
          pos.z + off[2],
        );
        mesh.scale.set(0.001, 0.001, 0.001);
        mesh.visible = true;
        (mesh.material as THREE.MeshLambertMaterial).opacity = SMOKE_SPHERE_OPACITY;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Smoke cloud visuals update
  // ---------------------------------------------------------------------------

  private _updateSmokeClouds(now: number): void {
    for (const cloud of this._smokeClouds) {
      if (!cloud.active) continue;

      const age      = now - cloud.spawnAt;
      const remaining = cloud.expiresAt - now;

      if (remaining <= 0) {
        // Expired — hide meshes.
        cloud.active = false;
        for (const mesh of cloud.meshes) {
          mesh.visible = false;
        }
        continue;
      }

      // Scale: lerp from 0 to 1 over SMOKE_SCALE_IN_TIME.
      const scaleT = Math.min(1, age / SMOKE_SCALE_IN_TIME);
      const s = cloud.radius * scaleT;

      // Opacity: 1 for most of life, then fade over SMOKE_FADE_TIME.
      let opacity = SMOKE_SPHERE_OPACITY;
      if (remaining < SMOKE_FADE_TIME) {
        opacity = SMOKE_SPHERE_OPACITY * (remaining / SMOKE_FADE_TIME);
      }

      for (const mesh of cloud.meshes) {
        mesh.scale.set(s, s, s);
        (mesh.material as THREE.MeshLambertMaterial).opacity = opacity;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Mesh pool helpers
  // ---------------------------------------------------------------------------

  private _acquireMesh(): number {
    for (let i = 0; i < this._projMeshes.length; i++) {
      if (!this._projMeshUsed[i]) return i;
    }
    return -1;
  }

  private _releaseMeshFor(projId: number): void {
    for (let i = 0; i < this._projMeshes.length; i++) {
      const mesh = this._projMeshes[i];
      if (mesh !== undefined && mesh.userData['projId'] === projId) {
        mesh.visible = false;
        mesh.userData['projId'] = -1;
        this._projMeshUsed[i] = false;
        return;
      }
    }
  }

  private _updateMeshPos(p: GrenadeProjectile): void {
    for (let i = 0; i < this._projMeshes.length; i++) {
      const mesh = this._projMeshes[i];
      if (mesh !== undefined && mesh.userData['projId'] === p.id) {
        mesh.position.set(p.pos.x, p.pos.y, p.pos.z);
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Smoke cloud pool helpers
  // ---------------------------------------------------------------------------

  private _acquireSmokeCloud(): SmokeCloud | null {
    for (const cloud of this._smokeClouds) {
      if (!cloud.active) return cloud;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Segment-sphere intersection (allocation-free)
  // ---------------------------------------------------------------------------

  private _segmentIntersectsSphere(a: Vec3, b: Vec3, center: Vec3, radius: number): boolean {
    // Vector from a to b.
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const lenSq = dx * dx + dy * dy + dz * dz;

    // Vector from a to center.
    const cx = center.x - a.x;
    const cy = center.y - a.y;
    const cz = center.z - a.z;

    // Project center onto segment.
    let t = lenSq > 1e-12 ? (cx * dx + cy * dy + cz * dz) / lenSq : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;

    // Closest point.
    const closestX = a.x + t * dx - center.x;
    const closestY = a.y + t * dy - center.y;
    const closestZ = a.z + t * dz - center.z;

    const distSq = closestX * closestX + closestY * closestY + closestZ * closestZ;
    return distSq <= radius * radius;
  }
}
