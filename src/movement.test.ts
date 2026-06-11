import { describe, expect, test } from 'bun:test';
import type { MapData, Combatant, Inventory, WeaponState } from './types';
import { WEAPONS, MOVEMENT } from './constants';
import { World } from './world';
import { simulateMovement } from './movement';
import type { MoveIntent } from './movement';

// ---------------------------------------------------------------------------
// Flat infinite-ish map for movement tests
// ---------------------------------------------------------------------------

// A 20×20 flat floor at y=0 surrounded by walls, plus a low-ceiling cell.
// cellSize=1, origin {x:0, z:0}.
// Center play area is cols 1..18, rows 1..18 (floor=0).
// Low ceiling cell at col 10, row 10 (floor=0, ceil=1.4 — too low to stand).
const FLAT_MAP: MapData = (() => {
  const SIZE = 20;
  const rows: string[] = [];
  for (let r = 0; r < SIZE; r++) {
    let row = '';
    for (let c = 0; c < SIZE; c++) {
      if (r === 0 || r === SIZE - 1 || c === 0 || c === SIZE - 1) {
        row += '#'; // wall
      } else if (r === 1 && c === 1) {
        // Low-ceiling cell tucked in the near-wall corner — won't be traversed
        // by players placed at (10,10) or (10,10,z).
        row += 'X';
      } else {
        row += '0'; // floor 0
      }
    }
    rows.push(row);
  }
  return {
    name: 'flat_test',
    cellSize: 1,
    origin: { x: 0, z: 0 },
    grid: rows,
    legend: {
      '#': { floor: 0, wall: true, mat: 'sand' },
      '0': { floor: 0, mat: 'floor' },
      X:   { floor: 0, ceil: 1.4, mat: 'floor' }, // too low for standing (need 1.83)
    },
    props: [],
    spawns: { ct: [], t: [] },
    bombsites: [],
    areas: [],
  };
})();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestCombatant(): Combatant {
  const knife: WeaponState = {
    def: WEAPONS.knife,
    ammo: 0, reserve: 0, reloading: false, reloadEnd: 0, nextFire: 0, shotsFired: 0,
  };
  const secondary: WeaponState = {
    def: WEAPONS.usp,
    ammo: WEAPONS.usp.magSize,
    reserve: WEAPONS.usp.reserveAmmo,
    reloading: false, reloadEnd: 0, nextFire: 0, shotsFired: 0,
  };
  const inventory: Inventory = {
    knife,
    secondary,
    primary: null,
    activeSlot: 'secondary',
  };
  return {
    id: 0, name: 'test', team: 'CT', isPlayer: false,
    pos: { x: 5, y: 0, z: 5 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0,
    health: 100, armor: 0, helmet: false,
    alive: true, crouching: false, walking: false, onGround: true,
    inventory,
    money: 0, kills: 0, deaths: 0,
    hasBomb: false, hasDefuseKit: false,
    tagSlowUntil: 0,
  };
}

const noInput: MoveIntent  = { forward: 0, strafe: 0, jump: false, crouch: false, walk: false };
const fwdInput: MoveIntent = { forward: 1, strafe: 0, jump: false, crouch: false, walk: false };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('simulateMovement', () => {
  const FIXED_DT = 1 / 128;

  test('accelerates to approximately weapon moveSpeed when holding forward', () => {
    const world = new World(FLAT_MAP);
    const c     = makeTestCombatant();
    // Place in center (10,10) so there's plenty of room in -Z direction before hitting wall at row 0.
    c.pos = { x: 10, y: 0, z: 10 };
    // Run forward for 1 second (128 ticks) — not long enough to reach north wall.
    for (let i = 0; i < 128; i++) {
      simulateMovement(c, fwdInput, world, FIXED_DT, 0);
    }
    const speed = Math.sqrt(c.vel.x ** 2 + c.vel.z ** 2);
    const expectedSpeed = WEAPONS.usp.moveSpeed;
    // Allow ±0.3 m/s tolerance.
    expect(speed).toBeGreaterThan(expectedSpeed - 0.3);
    expect(speed).toBeLessThan(expectedSpeed + 0.3);
  });

  test('friction stops player after releasing input', () => {
    const world = new World(FLAT_MAP);
    const c     = makeTestCombatant();
    c.pos = { x: 10, y: 0, z: 10 };
    // Accelerate briefly (don't reach wall).
    for (let i = 0; i < 64; i++) simulateMovement(c, fwdInput, world, FIXED_DT, 0);
    // Release and let friction stop.
    for (let i = 0; i < 256; i++) simulateMovement(c, noInput, world, FIXED_DT, 0);
    const speed = Math.sqrt(c.vel.x ** 2 + c.vel.z ** 2);
    expect(speed).toBeLessThan(0.1);
  });

  test('jump makes player airborne and then lands', () => {
    const world = new World(FLAT_MAP);
    const c     = makeTestCombatant();
    c.pos = { x: 10, y: 0, z: 10 };
    // Ensure on ground.
    for (let i = 0; i < 20; i++) simulateMovement(c, noInput, world, FIXED_DT, 0);
    expect(c.onGround).toBe(true);

    // Jump.
    const jumpInput: MoveIntent = { forward: 0, strafe: 0, jump: true, crouch: false, walk: false };
    simulateMovement(c, jumpInput, world, FIXED_DT, 0);
    expect(c.onGround).toBe(false);
    expect(c.vel.y).toBeGreaterThan(0);

    // Let it land.
    let landed = false;
    for (let i = 0; i < 200; i++) {
      const ev = simulateMovement(c, noInput, world, FIXED_DT, 0);
      if (ev.landed) { landed = true; break; }
    }
    expect(landed).toBe(true);
    expect(c.onGround).toBe(true);
    expect(c.pos.y).toBeCloseTo(0, 1);
  });

  test('crouch reduces top speed', () => {
    const world       = new World(FLAT_MAP);
    const c           = makeTestCombatant();
    c.pos = { x: 10, y: 0, z: 10 };
    const crouchInput: MoveIntent = { forward: 1, strafe: 0, jump: false, crouch: true, walk: false };
    for (let i = 0; i < 128; i++) simulateMovement(c, crouchInput, world, FIXED_DT, 0);
    const crouchSpeed = Math.sqrt(c.vel.x ** 2 + c.vel.z ** 2);
    const expected    = WEAPONS.usp.moveSpeed * MOVEMENT.CROUCH_MULT;
    expect(crouchSpeed).toBeLessThan(WEAPONS.usp.moveSpeed * 0.9);
    expect(crouchSpeed).toBeGreaterThan(expected - 0.3);
  });

  test('walk (shift) reduces top speed', () => {
    const world      = new World(FLAT_MAP);
    const c          = makeTestCombatant();
    c.pos = { x: 10, y: 0, z: 10 };
    const walkInput: MoveIntent = { forward: 1, strafe: 0, jump: false, crouch: false, walk: true };
    for (let i = 0; i < 128; i++) simulateMovement(c, walkInput, world, FIXED_DT, 0);
    const walkSpeed = Math.sqrt(c.vel.x ** 2 + c.vel.z ** 2);
    expect(walkSpeed).toBeLessThan(WEAPONS.usp.moveSpeed * 0.9);
  });

  test('un-crouch is blocked under a low ceiling', () => {
    const world = new World(FLAT_MAP);
    const c     = makeTestCombatant();
    // Position player at the low-ceiling cell (col 1, row 1 → world center x=1.5, z=1.5).
    c.pos = { x: 1.5, y: 0, z: 1.5 };
    c.crouching = true;

    // Repeatedly ask to stand up — should remain crouched.
    const tryStandInput: MoveIntent = { forward: 0, strafe: 0, jump: false, crouch: false, walk: false };
    for (let i = 0; i < 10; i++) {
      simulateMovement(c, tryStandInput, world, FIXED_DT, 0);
    }
    expect(c.crouching).toBe(true);
  });
});
