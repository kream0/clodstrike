import { describe, expect, test } from 'bun:test';
import type { MapData } from './types';
import { World } from './world';
import { DUST2 } from './maps/dust2';
import { MOVEMENT } from './constants';

// ---------------------------------------------------------------------------
// 1. DUST2 smoke-tests
// ---------------------------------------------------------------------------

describe('World(DUST2) smoke tests', () => {
  const world = new World(DUST2);
  const spawn  = DUST2.spawns.t[0]; // { x: -6, z: 31, angle: 0 }

  test('floorAt T spawn is roughly 1.5', () => {
    const f = world.floorAt(spawn.x, spawn.z);
    expect(f).toBeGreaterThanOrEqual(1.4);
    expect(f).toBeLessThanOrEqual(1.6);
  });

  test('floorAt inside a wall cell returns +Infinity', () => {
    // Find a '#' wall cell near the boundary.
    // Row 1 col 5 is '#' (known from grid header: row 1 = "     ###...").
    const wallX = DUST2.origin.x + 5 * DUST2.cellSize + 0.5;
    const wallZ = DUST2.origin.z + 1 * DUST2.cellSize + 0.5;
    const f = world.floorAt(wallX, wallZ);
    expect(f).toBe(Infinity);
  });

  test('raycast from T spawn going north (-Z) returns a finite hit', () => {
    const origin = { x: spawn.x, y: 1.5 + MOVEMENT.EYE_STAND, z: spawn.z };
    const dir    = { x: 0, y: 0, z: -1 };
    const hit    = world.raycast(origin, dir, 200);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeGreaterThan(0);
    expect(isFinite(hit!.distance)).toBe(true);
  });

  test('raycast aimed 45 degrees down hits a floor', () => {
    // Shoot at 45° downward from a few meters up at T spawn.
    const origin = { x: spawn.x, y: 4.0, z: spawn.z };
    const angle  = -Math.PI / 4;
    const dir    = { x: 0, y: Math.sin(angle), z: -Math.cos(angle) }; // forward-down
    const len    = Math.sqrt(dir.x ** 2 + dir.y ** 2 + dir.z ** 2);
    const normDir = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
    const hit    = world.raycast(origin, normDir, 50);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('floor');
  });
});

// ---------------------------------------------------------------------------
// 2. Synthetic 6×6 micro-map tests
// ---------------------------------------------------------------------------

/*
  Micro-map: 6×6, cellSize=1, origin {x:0,z:0}
  Legend:
    ' ' wall
    '0' floor=0
    '1' floor=0.375  (one step up, climbable)
    'H' floor=0.75   (two steps, >STEP_HEIGHT=0.5 → blocks horizontal move)
    'L' floor=0      (with ceil=1.5 — low ceiling)
  Grid (row 0=north / -Z, row 5=south / +Z):
    row 0:  ' ' ' ' ' ' ' ' ' ' ' '
    row 1:  ' ' '0' '0' '0' '0' ' '
    row 2:  ' ' '0' '1' 'H' '0' ' '    step and ledge
    row 3:  ' ' '0' '0' '0' '0' ' '
    row 4:  ' ' '0' '0' '0' 'L' ' '    low ceiling at col 4
    row 5:  ' ' ' ' ' ' ' ' ' ' ' '
*/

const MICRO_MAP: MapData = {
  name: 'micro',
  cellSize: 1,
  origin: { x: 0, z: 0 },
  grid: [
    '      ',
    ' 0000 ',
    ' 01H0 ',
    ' 0000 ',
    ' 000L ',
    '      ',
  ],
  legend: {
    ' ': { floor: 0, wall: true },
    '0': { floor: 0 },
    '1': { floor: 0.375 },
    H:   { floor: 0.75 },
    L:   { floor: 0, ceil: 1.5 },
  },
  props: [
    // Collidable crate at (3.5, 0, 3.5) size 1×1×1 — center of col3,row3
    { kind: 'crate', pos: [3.5, 0, 3.5], size: [1.0, 1.0, 1.0], mat: 'wood', collide: true },
  ],
  spawns: { ct: [], t: [] },
  bombsites: [],
  areas: [],
};

describe('World(micro-map) moveAABB physics', () => {
  const world  = new World(MICRO_MAP);
  const R      = MOVEMENT.PLAYER_RADIUS;
  const HEIGHT = MOVEMENT.PLAYER_HEIGHT;

  test('step 0.375 is climbed via moveAABB', () => {
    // Micro-map grid row 2 = ' 01H0 ': col1='0'(floor=0), col2='1'(floor=0.375), col3='H', col4='0'.
    // World: col→x, row→z. col1,row1 center = (1.5, 1.5). col2,row2 = (2.5, 2.5).
    // Place player at (1.5, 0, 2.5) facing +X — from '0' cell into '1' cell.
    const pos = { x: 1.5, y: 0, z: 2.5 };
    const vel = { x: 2.0, y: 0, z: 0 };    // moving +X into '1' cell (floor=0.375)
    const result = world.moveAABB(pos, vel, 0.1, R, HEIGHT);
    // Should have stepped up: x moved forward.
    expect(result.pos.x).toBeGreaterThan(1.5);
    // Y should be at 0.375 or close.
    expect(result.pos.y).toBeGreaterThanOrEqual(0.37);
  });

  test('ledge of 0.75 (> STEP_HEIGHT=0.5) blocks horizontal move', () => {
    // 'H' cell is at col3, row2 → world x=[3,4], z=[2,3].
    // Place player at (2.4, 0, 2.5) (col2=1 floor=0.375) moving +X into H (floor=0.75).
    // Rise = 0.75 - 0 = 0.75 > STEP_HEIGHT (0.5) → should be blocked.
    const pos = { x: 2.4, y: 0, z: 2.5 };
    const vel = { x: 3.0, y: 0, z: 0 };
    const result = world.moveAABB(pos, vel, 0.1, R, HEIGHT);
    // Should be blocked — x should not have advanced much.
    expect(result.hitWall).toBe(true);
    expect(result.pos.x).toBeLessThanOrEqual(2.4 + 0.05);
  });

  test('wall blocks movement', () => {
    // Move into the north wall (row 0).
    const pos = { x: 1.5, y: 0, z: 1.5 };
    const vel = { x: 0, y: 0, z: -3.0 };
    const result = world.moveAABB(pos, vel, 0.1, R, HEIGHT);
    expect(result.hitWall).toBe(true);
    expect(result.pos.z).toBeGreaterThan(0 + R - 0.05);
  });

  test('falling from a height lands on the ground', () => {
    // Start at y=3.0 (elevated), let it fall.
    const pos = { x: 1.5, y: 3.0, z: 1.5 };
    const vel = { x: 0, y: -5.0, z: 0 };
    // Simulate several steps until it lands.
    let cur = { pos: { ...pos }, vel: { ...vel } };
    let landed = false;
    for (let i = 0; i < 100; i++) {
      const r = world.moveAABB(cur.pos, cur.vel, 1 / 128, R, HEIGHT);
      cur = { pos: r.pos, vel: r.vel };
      if (r.onGround) { landed = true; break; }
    }
    expect(landed).toBe(true);
    expect(cur.pos.y).toBeCloseTo(0, 1);
  });

  test('prop box blocks horizontal movement', () => {
    // Crate at (3.5, 0, 3.5) size 1×1×1 → AABB min=(3,0,3), max=(4,1,4).
    // Place player at x=2.5, z=3.5. With r=0.4, player right edge = 2.9.
    // Moving at vel 5.0 m/s for dt=0.5s → newX = 2.5 + 5.0*0.5 = 5.0.
    // Crate top=1.0 > feetY=0 + STEP_HEIGHT=0.5 → rise=1.0 blocked.
    const pos = { x: 2.5, y: 0, z: 3.5 };
    const vel = { x: 5.0, y: 0, z: 0 };
    const result = world.moveAABB(pos, vel, 0.5, R, HEIGHT);
    // Should be blocked.
    expect(result.hitWall).toBe(true);
    // Player center x should not have advanced into the crate.
    expect(result.pos.x + R).toBeLessThanOrEqual(3.0 + 0.01);
  });

  test('can stand on top of a prop', () => {
    // Crate top is at y=1.0 (pos[1]=0 + size[1]=1.0).
    // Start player just above the crate with slight downward velocity.
    const pos = { x: 3.5, y: 1.05, z: 3.5 };
    const vel = { x: 0, y: -1.0, z: 0 };
    let cur = { pos: { ...pos }, vel: { ...vel } };
    let landed = false;
    for (let i = 0; i < 20; i++) {
      const r = world.moveAABB(cur.pos, cur.vel, 1 / 128, R, HEIGHT);
      cur = { pos: r.pos, vel: r.vel };
      if (r.onGround) { landed = true; break; }
    }
    expect(landed).toBe(true);
    // Feet should be at or near y=1.0 (top of crate).
    expect(cur.pos.y).toBeGreaterThanOrEqual(0.95);
    expect(cur.pos.y).toBeLessThanOrEqual(1.05);
  });
});
