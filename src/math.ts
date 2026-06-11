import type { Vec3 } from './types';

// ----- Vec3 helpers (plain objects, no three.js here) -----

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function lengthSq(v: Vec3): number {
  return v.x * v.x + v.y * v.y + v.z * v.z;
}

export function length(v: Vec3): number {
  return Math.sqrt(lengthSq(v));
}

/** Returns the zero vector when `v` has (near) zero length. */
export function normalize(v: Vec3): Vec3 {
  const len = length(v);
  return len > 1e-12 ? scale(v, 1 / len) : v3(0, 0, 0);
}

export function distanceSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.sqrt(distanceSq(a, b));
}

// ----- Scalars -----

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Gaussian-ish random in [-scale, scale], centered on 0 (sum of two uniforms). */
export function randSpread(scale = 1): number {
  return (Math.random() + Math.random() - 1) * scale;
}

// ----- Angles -----

/**
 * Right-handed three.js convention: yaw 0 faces -Z (north), positive pitch looks up.
 * dir = { x: -sin(yaw)*cos(pitch), y: sin(pitch), z: -cos(yaw)*cos(pitch) }
 */
export function yawPitchToDir(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp,
  };
}

/** Inverse of yawPitchToDir for the horizontal components. */
export function dirToYaw(dir: Vec3): number {
  return Math.atan2(-dir.x, -dir.z);
}

/** Signed shortest rotation from angle `a` to angle `b`, normalized to [-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ----- AABB -----

export interface AABB {
  min: Vec3;
  max: Vec3;
}

export function aabbOverlap(a: AABB, b: AABB): boolean {
  return (
    a.min.x <= b.max.x && a.max.x >= b.min.x &&
    a.min.y <= b.max.y && a.max.y >= b.min.y &&
    a.min.z <= b.max.z && a.max.z >= b.min.z
  );
}

/**
 * Slab-method ray vs AABB. `invDir` is the component-wise inverse of the ray
 * direction (+/-Infinity for zero components is fine). Returns the entry
 * distance t >= 0 along the ray (0 when the origin is inside), or null on miss.
 */
export function rayAABB(origin: Vec3, invDir: Vec3, box: AABB): number | null {
  let t1 = (box.min.x - origin.x) * invDir.x;
  let t2 = (box.max.x - origin.x) * invDir.x;
  let tmin = Math.min(t1, t2);
  let tmax = Math.max(t1, t2);

  t1 = (box.min.y - origin.y) * invDir.y;
  t2 = (box.max.y - origin.y) * invDir.y;
  tmin = Math.max(tmin, Math.min(t1, t2));
  tmax = Math.min(tmax, Math.max(t1, t2));

  t1 = (box.min.z - origin.z) * invDir.z;
  t2 = (box.max.z - origin.z) * invDir.z;
  tmin = Math.max(tmin, Math.min(t1, t2));
  tmax = Math.min(tmax, Math.max(t1, t2));

  if (tmax < Math.max(tmin, 0)) return null;
  return Math.max(tmin, 0);
}

/**
 * Like rayAABB but also returns the outward normal of the face crossed at the
 * entry point (entry-axis normal even when the origin is inside the box).
 */
export function rayAABBNormal(
  origin: Vec3,
  invDir: Vec3,
  box: AABB,
): { t: number; normal: Vec3 } | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  let hitAxis: 'x' | 'y' | 'z' = 'x';

  for (const axis of ['x', 'y', 'z'] as const) {
    const t1 = (box.min[axis] - origin[axis]) * invDir[axis];
    const t2 = (box.max[axis] - origin[axis]) * invDir[axis];
    const lo = Math.min(t1, t2);
    const hi = Math.max(t1, t2);
    if (lo > tmin) {
      tmin = lo;
      hitAxis = axis;
    }
    tmax = Math.min(tmax, hi);
  }

  if (tmax < Math.max(tmin, 0)) return null;
  const normal = v3(0, 0, 0);
  normal[hitAxis] = invDir[hitAxis] > 0 ? -1 : 1;
  return { t: Math.max(tmin, 0), normal };
}
