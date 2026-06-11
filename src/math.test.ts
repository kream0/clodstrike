import { describe, expect, test } from 'bun:test';
import {
  angleDiff,
  clamp,
  dirToYaw,
  lerp,
  rayAABB,
  rayAABBNormal,
  v3,
  yawPitchToDir,
} from './math';

describe('yawPitchToDir', () => {
  test('yaw 0, pitch 0 faces -Z', () => {
    const d = yawPitchToDir(0, 0);
    expect(d.x).toBeCloseTo(0, 6);
    expect(d.y).toBeCloseTo(0, 6);
    expect(d.z).toBeCloseTo(-1, 6);
  });

  test('positive pitch looks up', () => {
    const d = yawPitchToDir(0, Math.PI / 4);
    expect(d.y).toBeCloseTo(Math.SQRT1_2, 6);
    expect(d.z).toBeCloseTo(-Math.SQRT1_2, 6);
  });

  test('round-trips through dirToYaw', () => {
    expect(dirToYaw(yawPitchToDir(0.7, 0))).toBeCloseTo(0.7, 6);
    expect(dirToYaw(yawPitchToDir(-2.1, 0.2))).toBeCloseTo(-2.1, 6);
  });
});

describe('rayAABB', () => {
  // Unit box centered on the -Z axis, 2..3 meters ahead of the origin.
  const box = { min: v3(-0.5, -0.5, -3), max: v3(0.5, 0.5, -2) };
  const invDirForward = v3(Infinity, Infinity, -1); // dir (0, 0, -1)

  test('hits a unit box straight ahead', () => {
    const t = rayAABB(v3(0, 0, 0), invDirForward, box);
    expect(t).not.toBeNull();
    expect(t!).toBeCloseTo(2, 6);
  });

  test('misses when pointing away', () => {
    const t = rayAABB(v3(0, 0, 0), v3(Infinity, Infinity, 1), box); // dir (0, 0, +1)
    expect(t).toBeNull();
  });

  test('misses when offset to the side', () => {
    const t = rayAABB(v3(2, 0, 0), invDirForward, box);
    expect(t).toBeNull();
  });

  test('returns 0 when starting inside', () => {
    const t = rayAABB(v3(0, 0, -2.5), invDirForward, box);
    expect(t).toBe(0);
  });

  test('rayAABBNormal reports entry t and face normal', () => {
    const hit = rayAABBNormal(v3(0, 0, 0), invDirForward, box);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(2, 6);
    expect(hit!.normal).toEqual({ x: 0, y: 0, z: 1 });
  });
});

describe('clamp & lerp', () => {
  test('clamp', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.25, 0, 1)).toBe(0.25);
  });

  test('lerp', () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(2, 4, 0)).toBe(2);
    expect(lerp(2, 4, 1)).toBe(4);
  });
});

describe('angleDiff', () => {
  test('simple difference', () => {
    expect(angleDiff(0.5, 0.75)).toBeCloseTo(0.25, 6);
  });

  test('wraps across the +/- PI boundary', () => {
    expect(angleDiff(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2, 6);
    expect(angleDiff(-Math.PI + 0.1, Math.PI - 0.1)).toBeCloseTo(-0.2, 6);
  });

  test('stays within [-PI, PI]', () => {
    expect(Math.abs(angleDiff(0, 3 * Math.PI))).toBeCloseTo(Math.PI, 6);
    expect(angleDiff(0, 4 * Math.PI)).toBeCloseTo(0, 6);
  });
});
