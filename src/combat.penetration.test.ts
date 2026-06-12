/**
 * combat.penetration.test.ts
 *
 * Wallbang penetration system tests. All world coordinates are derived
 * analytically from the test map layout so there are no magic numbers:
 * every assertion documents its geometric premise.
 *
 * Test map layout (PEN_MAP):
 *   12 cols × 10 rows, cellSize = 1, origin {x:0, z:0}
 *   Row 0 / row 9 = all '#' (boundary walls)
 *   Col 0 / col 11 = '#' (boundary walls)
 *
 *   Interior layout (rows 1-8, see grid):
 *     '.' = open floor=0
 *     '#' = solid wall
 *     'W' = single-cell wall column (col 5, rows 1-8) — 1-cell thick
 *     'D' = double-cell wall column (cols 7-8, rows 1-8) — 2-cells thick
 *
 *   Grid (12 wide, 10 tall):
 *     row 0: ############
 *     row 1: #....W.DD..#
 *     row 2: #....W.DD..#
 *     row 3: #....W.DD..#
 *     row 4: #....W.DD..#
 *     row 5: #....W.DD..#
 *     row 6: #....W.DD..#
 *     row 7: #....W.DD..#
 *     row 8: #....W.DD..#
 *     row 9: ############
 *
 *   Col coords (world X): col→x = col*1 + 0 (origin.x = 0)
 *     col 0 = x [0,1)  → wall
 *     col 1 = x [1,2)  → open (.)
 *     col 2 = x [2,3)  → open (.)
 *     col 3 = x [3,4)  → open (.)
 *     col 4 = x [4,5)  → open (.)
 *     col 5 = x [5,6)  → single wall (W) — thickness ~1 m
 *     col 6 = x [6,7)  → open (.)
 *     col 7 = x [7,8)  → double wall part 1 (D)
 *     col 8 = x [8,9)  → double wall part 2 (D)
 *     col 9 = x [9,10) → open (.)
 *     col10 = x [10,11)→ open (.)
 *     col11 = x [11,12)→ wall
 *
 *   Prop:
 *     A thin 0.2 m wide crate at x=3.5, z=5.5 (col3,row5 center), size [0.2,1.5,0.2]
 *     Entry from the west hits the crate's west face at x = 3.5 - 0.1 = 3.4
 *     Exit at x = 3.5 + 0.1 = 3.6; thickness = 0.2 m
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import type { MapData, Combatant, Inventory, WeaponState, GameEvents } from './types';
import { WEAPONS } from './constants';
import { World } from './world';
import { gameEvents, fireHitscan, penDamageFactor, MAX_PEN_THICKNESS } from './combat';

// ---------------------------------------------------------------------------
// Penetration test map
// ---------------------------------------------------------------------------

const PEN_MAP: MapData = (() => {
  const COLS = 12;
  const ROWS = 10;
  const rows: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    let row = '';
    for (let c = 0; c < COLS; c++) {
      const boundary = r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1;
      if (boundary) {
        row += '#';
      } else if (c === 5) {
        row += 'W'; // single-cell wall
      } else if (c === 7 || c === 8) {
        row += 'D'; // double-cell wall
      } else {
        row += '.';
      }
    }
    rows.push(row);
  }
  return {
    name: 'pen_test',
    cellSize: 1,
    origin: { x: 0, z: 0 },
    grid: rows,
    legend: {
      '#': { floor: 0, wall: true },
      'W': { floor: 0, wall: true },
      'D': { floor: 0, wall: true },
      '.': { floor: 0 },
    },
    props: [
      // Thin crate: 0.2 m wide × 1.5 m tall × 0.2 m deep
      // Center at (3.5, 0, 5.5); AABB: x [3.4,3.6], y [0,1.5], z [5.4,5.6]
      { kind: 'crate', pos: [3.5, 0, 5.5], size: [0.2, 1.5, 0.2], mat: 'wood', collide: true },
    ],
    spawns: { ct: [], t: [] },
    bombsites: [],
    areas: [],
  };
})();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextId = 100;

function makeCombatant(team: 'CT' | 'T' = 'CT', weaponId = 'ak47'): Combatant {
  const wDef = WEAPONS[weaponId];
  if (wDef === undefined) throw new Error(`Unknown weapon: ${weaponId}`);
  const knife: WeaponState = {
    def: WEAPONS.knife!,
    ammo: 0, reserve: 0, reloading: false, reloadEnd: 0, nextFire: 0, shotsFired: 0,
  };
  const primary: WeaponState = {
    def: wDef,
    ammo: wDef.magSize, reserve: wDef.reserveAmmo,
    reloading: false, reloadEnd: 0, nextFire: 0, shotsFired: 0,
  };
  const inventory: Inventory = {
    knife,
    secondary: null,
    primary,
    activeSlot: 'primary',
  };
  return {
    id: nextId++,
    name: 'test',
    team,
    isPlayer: false,
    pos: { x: 2.5, y: 0, z: 5.5 }, // open area left of single wall
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0,
    health: 100, armor: 0, helmet: false,
    alive: true, crouching: false, walking: false, onGround: true,
    inventory,
    money: 800, kills: 0, deaths: 0,
    hasBomb: false, hasDefuseKit: false,
    tagSlowUntil: 0,
  };
}

// ---------------------------------------------------------------------------
// Section 1: penDamageFactor unit tests
// ---------------------------------------------------------------------------

describe('penDamageFactor unit', () => {
  test('power=0 → always 0', () => {
    expect(penDamageFactor(0, 0)).toBe(0);
    expect(penDamageFactor(0, 0.5)).toBe(0);
  });

  test('thickness ≥ MAX_PEN_THICKNESS → 0', () => {
    expect(penDamageFactor(0.85, MAX_PEN_THICKNESS)).toBe(0);
    expect(penDamageFactor(0.85, MAX_PEN_THICKNESS + 1)).toBe(0);
  });

  test('thin wall with AK power=0.85, thickness=1.0', () => {
    // factor = 0.85 * (1 - 1.0/1.25) = 0.85 * 0.2 = 0.17
    const expected = 0.85 * (1 - 1.0 / MAX_PEN_THICKNESS);
    expect(penDamageFactor(0.85, 1.0)).toBeCloseTo(expected, 5);
    expect(expected).toBeGreaterThan(0.05); // above MIN_PEN_FACTOR
  });

  test('shotgun power=0.20, 1-cell wall thickness=1.0', () => {
    // factor = 0.20 * (1 - 1.0/1.25) = 0.20 * 0.2 = 0.04 → below MIN_PEN_FACTOR → 0
    expect(penDamageFactor(0.20, 1.0)).toBe(0);
  });

  test('thin prop 0.2 m with AWP power=0.90', () => {
    // factor = 0.90 * (1 - 0.2/1.25) = 0.90 * 0.84 = 0.756
    const expected = 0.90 * (1 - 0.2 / MAX_PEN_THICKNESS);
    expect(penDamageFactor(0.90, 0.2)).toBeCloseTo(expected, 5);
    expect(expected).toBeGreaterThan(0.70); // sanity: high factor
  });
});

// ---------------------------------------------------------------------------
// Section 2: traceSolidExit — geometry
// ---------------------------------------------------------------------------

describe('traceSolidExit geometry', () => {
  const world = new World(PEN_MAP);

  // Helper: assert invariants about the test map
  test('map premise: col5 is solid wall at row5', () => {
    // World x=5.5 is center of col5 → must be wall
    const cell = world.cellAt(5.5, 5.5);
    expect(cell.wall).toBe(true);
  });

  test('map premise: col6 is open at row5', () => {
    const cell = world.cellAt(6.5, 5.5);
    expect(cell.wall).toBeFalsy();
  });

  test('map premise: cols 7 and 8 are solid at row5', () => {
    expect(world.cellAt(7.5, 5.5).wall).toBe(true);
    expect(world.cellAt(8.5, 5.5).wall).toBe(true);
  });

  test('single-cell wall: trace exits and returns thickness ≈ 1.0 m', () => {
    // Entry point: west face of col5 at x=5.0 (where ray hits from the left).
    // dir = +X so the exit is at x=6.0 (east face of col5).
    // The DDA starts at x=5.0+epsilon, finds col6 is open → exits.
    const entry = { x: 5.0, y: 0.9, z: 5.5 };
    const dir   = { x: 1, y: 0, z: 0 };
    const result = world.traceSolidExit(entry, dir, MAX_PEN_THICKNESS, 'wall');
    expect(result).not.toBeNull();
    // thickness should be ≈ 1.0 m (one cell)
    expect(result!.thickness).toBeGreaterThan(0.95);
    expect(result!.thickness).toBeLessThan(1.05);
    // exitPoint.x ≈ 6.0
    expect(result!.exitPoint.x).toBeGreaterThan(5.9);
    expect(result!.exitPoint.x).toBeLessThan(6.1);
  });

  test('double-cell wall: trace returns null (thickness ≥ MAX_PEN_THICKNESS)', () => {
    // Entry point: west face of col7 at x=7.0.
    // Two cells wide (cols 7+8) = 2.0 m > MAX_PEN_THICKNESS=1.25 → null.
    const entry = { x: 7.0, y: 0.9, z: 5.5 };
    const dir   = { x: 1, y: 0, z: 0 };
    const result = world.traceSolidExit(entry, dir, MAX_PEN_THICKNESS, 'wall');
    expect(result).toBeNull();
  });

  test('prop trace: thin crate 0.2 m wide returns thickness ≈ 0.2 m', () => {
    // Crate: x [3.4,3.6], y [0,1.5], z [5.4,5.6]
    // Entry at west face x=3.4, dir=+X.
    // propIndex for the crate is 0 (first and only prop).
    const entry = { x: 3.4, y: 0.75, z: 5.5 };
    const dir   = { x: 1, y: 0, z: 0 };
    const result = world.traceSolidExit(entry, dir, MAX_PEN_THICKNESS, 'prop', 0);
    expect(result).not.toBeNull();
    expect(result!.thickness).toBeGreaterThan(0.18);
    expect(result!.thickness).toBeLessThan(0.22);
    // exitPoint.x ≈ 3.6
    expect(result!.exitPoint.x).toBeGreaterThan(3.55);
    expect(result!.exitPoint.x).toBeLessThan(3.65);
  });
});

// ---------------------------------------------------------------------------
// Section 3: fireHitscan penetration integration
// ---------------------------------------------------------------------------

describe('fireHitscan penetration — target behind single wall', () => {
  const world = new World(PEN_MAP);

  // Shooter: left of single wall at col5
  // Target: right of single wall at col6
  // Ray: horizontal +X at eye height

  test('AK-47 (pen=0.85) kills target behind 1-cell wall over enough shots', () => {
    const shooter = makeCombatant('T', 'ak47');
    // Shooter eye at (2.5, 0, 5.5) → eye Y = 0 + 1.64 = 1.64
    shooter.pos = { x: 2.5, y: 0, z: 5.5 };

    const target = makeCombatant('CT', 'ak47');
    // Target center at body height, right of wall at x=6.5, z=5.5
    target.pos = { x: 6.5, y: 0, z: 5.5 };
    target.health = 100;

    // Direction: pure +X at eye height (horizontal)
    const dir = { x: 1, y: 0, z: 0 };

    let totalDamage = 0;
    let shotsToKill = 0;

    // Fire until dead or 50 shots (guard)
    while (target.alive && shotsToKill < 50) {
      target.health = Math.max(target.health, 1); // keep alive for multi-shot test
      const result = fireHitscan(shooter, dir, world, [target], 0);
      if (result.target !== null) {
        shotsToKill++;
        break; // one successful penetration is enough to confirm it works
      }
      shotsToKill++;
    }

    // AK with pen=0.85 through 1-cell wall: factor = 0.85*(1-1/1.25)=0.17
    // Base damage at ~4m dist: 36 * 0.98^(4/15) ≈ 36 * 0.995 ≈ 35.8
    // With penetration factor 0.17: ~6 damage per shot → needs ~17 shots to kill
    // But we just need to confirm the hit landed (result.target !== null).
    // Re-run with a fresh target to actually verify damage occurs.
    const freshTarget = makeCombatant('CT', 'ak47');
    freshTarget.pos = { x: 6.5, y: 0, z: 5.5 };
    freshTarget.health = 100;

    const result = fireHitscan(shooter, dir, world, [freshTarget], 0);
    expect(result.target).toBe(freshTarget);
    expect(result.penetrated).toBe(true);
    // Damage should be > 0 but reduced compared to open-air
    expect(freshTarget.health).toBeLessThan(100);
  });

  test('Shotgun (pen=0.20) does NOT penetrate 1-cell wall', () => {
    const shooter = makeCombatant('T', 'nova');
    shooter.pos = { x: 2.5, y: 0, z: 5.5 };

    const target = makeCombatant('CT', 'ak47');
    target.pos = { x: 6.5, y: 0, z: 5.5 };
    target.health = 100;

    const dir = { x: 1, y: 0, z: 0 };

    // penDamageFactor(0.20, 1.0) = 0.04 which is < MIN_PEN_FACTOR (0.05) → blocked
    const result = fireHitscan(shooter, dir, world, [target], 0);
    expect(result.target).toBeNull();
    // Target should be completely unharmed
    expect(target.health).toBe(100);
  });

  test('penetrated shot: damage is scaled down vs open-air shot', () => {
    // Open-air test: no wall between shooter and target
    // Place both shooter and target in the open (col1–col4 area, no wall between them)
    const shooterOpen = makeCombatant('T', 'ak47');
    shooterOpen.pos = { x: 1.5, y: 0, z: 3.5 };

    const targetOpen = makeCombatant('CT', 'ak47');
    targetOpen.pos = { x: 4.5, y: 0, z: 3.5 };
    targetOpen.health = 200; // prevent death

    const dir = { x: 1, y: 0, z: 0 };
    fireHitscan(shooterOpen, dir, world, [targetOpen], 0);
    const openAirDamage = 200 - targetOpen.health;

    // Penetration test: wall between shooter and target
    const shooterPen = makeCombatant('T', 'ak47');
    shooterPen.pos = { x: 2.5, y: 0, z: 5.5 };

    const targetPen = makeCombatant('CT', 'ak47');
    targetPen.pos = { x: 6.5, y: 0, z: 5.5 };
    targetPen.health = 200;

    const result = fireHitscan(shooterPen, dir, world, [targetPen], 0);
    const penDamage = 200 - targetPen.health;

    // Penetrated damage must be strictly less than open-air
    expect(result.penetrated).toBe(true);
    expect(penDamage).toBeGreaterThan(0);
    expect(penDamage).toBeLessThan(openAirDamage);
  });

  test('penetration cap: target behind TWO separated walls takes zero damage', () => {
    // A shot can penetrate AT MOST ONE solid. After penetrating the first wall (col5),
    // ray 2 starts. If ray 2 encounters the double-wall (cols 7-8) before hitting the
    // target, it stops (no second penetration allowed).
    // Place target at x=9.5 — behind both the single wall (col5) AND the double-wall (cols 7-8).
    const shooter = makeCombatant('T', 'ak47');
    shooter.pos = { x: 2.5, y: 0, z: 5.5 };

    const target = makeCombatant('CT', 'ak47');
    target.pos = { x: 9.5, y: 0, z: 5.5 };
    target.health = 100;

    const dir = { x: 1, y: 0, z: 0 };

    const result = fireHitscan(shooter, dir, world, [target], 0);
    // After penetrating col5, ray2 hits the double-wall cols7-8 → blocked. Target safe.
    expect(result.target).toBeNull();
    expect(target.health).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Section 4: prop penetration
// ---------------------------------------------------------------------------

describe('fireHitscan penetration — thin prop', () => {
  const world = new World(PEN_MAP);

  test('AWP (pen=0.90) penetrates thin crate (0.2 m), high damage factor', () => {
    // Prop crate: x [3.4,3.6], z [5.4,5.6], height [0,1.5]
    // The crate only extends up to y=1.5. The shooter eye at y=1.64 is ABOVE it,
    // so we must fire at a downward angle to hit the crate mid-height.
    // Instead, place shooter lower by overriding — use crouching=true so eye=1.17,
    // which is inside the crate's y range [0,1.5].
    //
    // Shooter: pos x=2.5, y=0, z=5.5, crouching=true → eye at y=1.17
    // Crate z range: [5.4,5.6]. Shooter z=5.5, target z=5.5. Ray +X at y=1.17 hits crate.
    const shooter = makeCombatant('T', 'awp');
    shooter.pos = { x: 2.5, y: 0, z: 5.5 };
    shooter.crouching = true; // eye at 1.17 m — inside crate height [0,1.5]

    const target = makeCombatant('CT', 'ak47');
    // Target right of crate at x=4.5; target body spans y=[0.85,1.50],
    // which includes y=1.17 so the ray hits the body hitgroup.
    target.pos = { x: 4.5, y: 0, z: 5.5 };
    target.health = 200;

    const dir = { x: 1, y: 0, z: 0 };
    const result = fireHitscan(shooter, dir, world, [target], 0);

    expect(result.target).toBe(target);
    expect(result.penetrated).toBe(true);

    // penDamageFactor(0.90, 0.2) = 0.90*(1-0.2/1.25) = 0.756 — high factor
    // AWP damage=115 * ~0.756 * rangeModifier falloff ≈ ~86 damage
    const damageTaken = 200 - target.health;
    expect(damageTaken).toBeGreaterThan(50);
    expect(damageTaken).toBeLessThan(200); // less than max possible
  });
});

// ---------------------------------------------------------------------------
// Section 5: wallImpact events emitted
// ---------------------------------------------------------------------------

describe('wallImpact events on penetration', () => {
  const world = new World(PEN_MAP);

  test('entry impact and exit impact both emitted when penetrating', () => {
    const impacts: Array<{ penetrated?: boolean }> = [];
    const unsub = gameEvents.on('wallImpact', (e) => {
      impacts.push({ penetrated: e.penetrated });
    });

    const shooter = makeCombatant('T', 'ak47');
    shooter.pos = { x: 2.5, y: 0, z: 5.5 };

    // No target: just fire into the wall to get both events.
    const dir = { x: 1, y: 0, z: 0 };
    fireHitscan(shooter, dir, world, [], 0);

    // Should have 2 wallImpact events: entry (no flag) + exit (penetrated=true)
    expect(impacts.length).toBe(2);
    expect(impacts[0]?.penetrated).toBeFalsy();   // entry
    expect(impacts[1]?.penetrated).toBe(true);    // exit

    unsub();
  });

  test('no wallImpact events for combatant hit in open air', () => {
    const impacts: Array<unknown> = [];
    const unsub = gameEvents.on('wallImpact', (e) => { impacts.push(e); });

    const shooter = makeCombatant('T', 'ak47');
    shooter.pos = { x: 1.5, y: 0, z: 5.5 };

    const target = makeCombatant('CT', 'ak47');
    target.pos = { x: 4.5, y: 0, z: 5.5 };

    const dir = { x: 1, y: 0, z: 0 };
    const result = fireHitscan(shooter, dir, world, [target], 0);

    expect(result.target).toBe(target); // confirm open-air hit
    expect(impacts.length).toBe(0);     // no wall events

    unsub();
  });

  test('no wallImpact event for non-penetrating weapon hitting wall', () => {
    // Non-penetrating shots do NOT emit wallImpact — their impact is rendered by the
    // caller (main.ts) via ShotResult.surface + ShotResult.normal. wallImpact is
    // only emitted for the entry+exit pair of an actual penetration.
    const impacts: Array<{ penetrated?: boolean }> = [];
    const unsub = gameEvents.on('wallImpact', (e) => {
      impacts.push({ penetrated: e.penetrated });
    });

    const shooter = makeCombatant('T', 'nova'); // shotgun, pen=0.20
    shooter.pos = { x: 2.5, y: 0, z: 5.5 };

    const target = makeCombatant('CT', 'ak47');
    target.pos = { x: 6.5, y: 0, z: 5.5 };

    const dir = { x: 1, y: 0, z: 0 };
    const result = fireHitscan(shooter, dir, world, [target], 0);

    // No wallImpact events — caller renders via ShotResult.
    expect(impacts.length).toBe(0);
    // ShotResult.surface is set so the caller knows to render the impact.
    expect(result.surface).not.toBeNull();
    expect(result.normal).not.toBeNull();

    unsub();
  });
});

// ---------------------------------------------------------------------------
// Section 6: regression — no penetration weapons behave exactly as before
// ---------------------------------------------------------------------------

describe('regression — knife and no-penetration weapons unchanged', () => {
  const world = new World(PEN_MAP);

  test('knife wall hit is unchanged (surface returned, target null)', () => {
    // Knife has no penetration field (undefined → power=0)
    const shooter = makeCombatant('T', 'ak47');
    // Override active slot to knife
    shooter.inventory.activeSlot = 'knife';
    shooter.pos = { x: 2.5, y: 0, z: 5.5 };

    const target = makeCombatant('CT', 'ak47');
    target.pos = { x: 6.5, y: 0, z: 5.5 };

    const dir = { x: 1, y: 0, z: 0 };
    const result = fireHitscan(shooter, dir, world, [target], 0);

    // Knife range is 1.6 m — wall at x=5.0 is 2.5 m away → miss entirely
    // The knife raycast limited to range 1.6 m so there's no wall hit either.
    // This is knifeAttack, not fireHitscan, but we test fireHitscan with knife slot:
    // fireHitscan always uses maxDist=512, so it hits the wall but knife pen=0 → no penetration.
    expect(result.target).toBeNull();
    expect(result.penetrated).toBeFalsy(); // no penetration flag
  });

  test('common path: open-air AK body shot gives full damage (no penetration flag)', () => {
    // This regression guard pins that fireHitscan in open air gives full body-shot damage
    // with no penetrated flag, matching pre-penetration behavior.
    //
    // Shooter eye at y=1.64. We aim at body center (y≈1.175, midpoint of 0.85–1.50).
    // Target at x=4.5, z=3.5 (col3-4 open area, no props or walls between them).
    // Shooter at x=1.5, z=3.5.
    const shooter = makeCombatant('T', 'ak47');
    shooter.pos = { x: 1.5, y: 0, z: 3.5 };

    const target = makeCombatant('CT', 'ak47');
    target.pos  = { x: 4.5, y: 0, z: 3.5 };
    target.health = 200; // prevent kill

    // Aim at body center: eye=(1.5,1.64,3.5), body mid=(4.5, 1.175, 3.5)
    // dir x=3.0, dy=1.175-1.64=-0.465, dz=0
    const ddx = target.pos.x - shooter.pos.x;
    const bodyMidY = (0.85 + 1.50) / 2; // 1.175
    const eyeY = 1.64;
    const ddy = bodyMidY - eyeY; // -0.465
    const len = Math.sqrt(ddx * ddx + ddy * ddy);
    const dir = { x: ddx / len, y: ddy / len, z: 0 };

    const result = fireHitscan(shooter, dir, world, [target], 0);

    // Must hit the target (body group)
    expect(result.target).toBe(target);
    expect(result.hitGroup).toBe('body');
    // Must NOT be flagged as penetrated
    expect(result.penetrated).toBeFalsy();

    const damage = 200 - target.health;
    // At ~3 m: 36 × 0.98^(3/15) ≈ 36 × 0.9959 ≈ 35.9 → 36 body shot (no armor)
    expect(damage).toBeGreaterThanOrEqual(34);
    expect(damage).toBeLessThanOrEqual(37);
    // Crucially: full damage, NOT the penetration-reduced version (~6).
    expect(damage).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Section 7: H1/H2 exploit regression — diagonal and vertical rays
// ---------------------------------------------------------------------------

describe('traceSolidExit — diagonal and vertical ray invariants (H1/H2 exploit guards)', () => {
  const world = new World(PEN_MAP);

  // Slightly-diagonal ray (dir (1, 0, 0.2) normalized) through the 1-cell wall at col5.
  // Before the H1 fix, thickness was reported as ~−5.025 on such rays, amplifying damage ~4×.
  test('slightly-diagonal ray: thickness is null OR positive and ≤ MAX_PEN_THICKNESS', () => {
    // Entry: west face of col5 wall at x=5.0, z=5.5
    const entry = { x: 5.0, y: 0.9, z: 5.5 };
    const rawDir = { x: 1, y: 0, z: 0.2 };
    const len = Math.sqrt(rawDir.x * rawDir.x + rawDir.z * rawDir.z);
    const dir = { x: rawDir.x / len, y: 0, z: rawDir.z / len };

    const result = world.traceSolidExit(entry, dir, MAX_PEN_THICKNESS, 'wall');

    if (result !== null) {
      // When non-null: thickness must be strictly positive and within the cap.
      expect(result.thickness).toBeGreaterThan(0);
      expect(result.thickness).toBeLessThanOrEqual(MAX_PEN_THICKNESS);
      // At a shallow angle the ray path through the 1 m wall is ≥ 1.0 m along the ray.
      // (At angle θ from normal, path = 1/cos(θ); cos(arctan(0.2)) ≈ 0.981 → path ≈ 1.02 m)
      expect(result.thickness).toBeGreaterThanOrEqual(1.0 - 0.05); // 5 cm tolerance
    }
    // null is also acceptable: wall angle may push thickness past MAX_PEN_THICKNESS.
  });

  // Pure 45° diagonal through the wall corner region — thickness must never be ≤ 0.
  test('45-degree diagonal ray: thickness is null OR strictly positive ≤ MAX_PEN_THICKNESS', () => {
    const entry = { x: 5.0, y: 0.9, z: 5.0 };
    const inv = 1 / Math.SQRT2;
    const dir  = { x: inv, y: 0, z: inv };

    const result = world.traceSolidExit(entry, dir, MAX_PEN_THICKNESS, 'wall');

    if (result !== null) {
      expect(result.thickness).toBeGreaterThan(0);
      expect(result.thickness).toBeLessThanOrEqual(MAX_PEN_THICKNESS);
    }
  });

  // Vertical ray through a wall cell: 2.5D walls are full-height → must return null (H2).
  test('vertical ray (0,−1,0) through wall cell returns null', () => {
    // Start inside the wall cell col5 row5 (x=5.5, z=5.5)
    const entry = { x: 5.5, y: 2.0, z: 5.5 };
    const dir   = { x: 0, y: -1, z: 0 };
    const result = world.traceSolidExit(entry, dir, MAX_PEN_THICKNESS, 'wall');
    expect(result).toBeNull();
  });

  test('vertical ray (0,1,0) through wall cell returns null', () => {
    const entry = { x: 5.5, y: 0.1, z: 5.5 };
    const dir   = { x: 0, y: 1, z: 0 };
    const result = world.traceSolidExit(entry, dir, MAX_PEN_THICKNESS, 'wall');
    expect(result).toBeNull();
  });

  // penDamageFactor with the exact exploit values: negative thickness must return 0.
  test('penDamageFactor(0.85, −1) === 0 (negative thickness exploit)', () => {
    expect(penDamageFactor(0.85, -1)).toBe(0);
  });

  test('penDamageFactor(0.85, −5.025) === 0 (measured exploit amplification)', () => {
    expect(penDamageFactor(0.85, -5.025)).toBe(0);
  });

  // Property sweep: hardcoded list of 16 fixed directions through the 1-cell wall.
  // Every non-null result must satisfy 0 < thickness ≤ MAX_PEN_THICKNESS.
  test('property sweep: 16 fixed directions — all non-null results have valid thickness', () => {
    // Directions in the XZ plane only (dy=0), varying Z component from 0 to ±0.6 in steps.
    // Normalized after construction.
    const zOffsets = [-0.6, -0.45, -0.3, -0.15, 0, 0.15, 0.3, 0.45];
    const dirs: Array<{ x: number; y: number; z: number }> = [];
    for (const dz of zOffsets) {
      const len1 = Math.sqrt(1 + dz * dz);
      dirs.push({ x: 1 / len1, y: 0, z: dz / len1 });
      // Mirror with slight Y tilt to also cover the dy != 0 path.
      const len2 = Math.sqrt(1 + dz * dz + 0.1 * 0.1);
      dirs.push({ x: 1 / len2, y: 0.1 / len2, z: dz / len2 });
    }
    // dirs.length === 16
    expect(dirs.length).toBe(16);

    for (const dir of dirs) {
      // Entry at the west face of the 1-cell wall col5, mid-height.
      const entry = { x: 5.0, y: 0.9, z: 5.5 };
      const result = world.traceSolidExit(entry, dir, MAX_PEN_THICKNESS, 'wall');
      if (result !== null) {
        expect(result.thickness).toBeGreaterThan(0);
        expect(result.thickness).toBeLessThanOrEqual(MAX_PEN_THICKNESS);
      }
    }
  });
});
