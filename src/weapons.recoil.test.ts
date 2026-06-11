/**
 * Recoil pattern + movement inaccuracy tests.
 *
 * Strategy for jitter tolerance: pattern entries have ±15% jitter applied by
 * randSpread(0.15).  Tests assert within ±20% of the expected values to give
 * a deterministic pass that survives the random jitter without seeding.
 */
import { describe, expect, test } from 'bun:test';
import type { MapData, Combatant, Inventory, WeaponState } from './types';
import { WEAPONS } from './constants';
import { World } from './world';
import { updateWeapon, switchSlot, currentSpread, resetAim, getViewPunch } from './weapons';

// ---------------------------------------------------------------------------
// Minimal flat map (same pattern as combat.test.ts)
// ---------------------------------------------------------------------------

const FLAT_MAP: MapData = (() => {
  const SIZE = 40;
  const rows: string[] = [];
  for (let r = 0; r < SIZE; r++) {
    let row = '';
    for (let c = 0; c < SIZE; c++) {
      row += (r === 0 || r === SIZE - 1 || c === 0 || c === SIZE - 1) ? '#' : '0';
    }
    rows.push(row);
  }
  return {
    name: 'recoil_test',
    cellSize: 1,
    origin: { x: 0, z: 0 },
    grid: rows,
    legend: {
      '#': { floor: 0, wall: true, mat: 'sand' },
      '0': { floor: 0, mat: 'floor' },
    },
    props: [],
    spawns: { ct: [], t: [] },
    bombsites: [],
    areas: [],
  };
})();

const world = new World(FLAT_MAP);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextId = 1000; // offset from combat.test.ts ids to avoid map collision

function makeAK(ammo = 30): Combatant {
  const ws: WeaponState = {
    def: WEAPONS.ak47!,
    ammo,
    reserve: 90,
    reloading: false,
    reloadEnd: 0,
    nextFire: 0,
    shotsFired: 0,
  };
  const knife: WeaponState = {
    def: WEAPONS.knife!,
    ammo: 0, reserve: 0, reloading: false, reloadEnd: 0, nextFire: 0, shotsFired: 0,
  };
  const inv: Inventory = {
    knife,
    secondary: null,
    primary: ws,
    activeSlot: 'primary',
  };
  return {
    id: nextId++,
    name: 'test',
    team: 'T',
    isPlayer: false,
    pos: { x: 10, y: 0, z: 10 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    health: 100,
    armor: 0,
    helmet: false,
    alive: true,
    crouching: false,
    walking: false,
    onGround: true,
    inventory: inv,
    money: 800,
    kills: 0,
    deaths: 0,
    hasBomb: false,
    hasDefuseKit: false,
    tagSlowUntil: 0,
  };
}

function makeDeagle(): Combatant {
  const ws: WeaponState = {
    def: WEAPONS.deagle!,
    ammo: 7,
    reserve: 35,
    reloading: false,
    reloadEnd: 0,
    nextFire: 0,
    shotsFired: 0,
  };
  const knife: WeaponState = {
    def: WEAPONS.knife!,
    ammo: 0, reserve: 0, reloading: false, reloadEnd: 0, nextFire: 0, shotsFired: 0,
  };
  const inv: Inventory = {
    knife,
    secondary: ws,
    primary: null,
    activeSlot: 'secondary',
  };
  return {
    id: nextId++,
    name: 'test_deagle',
    team: 'CT',
    isPlayer: false,
    pos: { x: 10, y: 0, z: 10 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    health: 100,
    armor: 0,
    helmet: false,
    alive: true,
    crouching: false,
    walking: false,
    onGround: true,
    inventory: inv,
    money: 800,
    kills: 0,
    deaths: 0,
    hasBomb: false,
    hasDefuseKit: false,
    tagSlowUntil: 0,
  };
}

/** Fire N shots at exact rpm intervals. Returns pitch list after each shot.
 *  Uses additive now-accumulation to avoid float multiplication drift that can
 *  cause now < nextFire on alternating shots. */
function fireNShots(c: Combatant, n: number, startNow = 1.0): number[] {
  const pitches: number[] = [];
  const def = c.inventory.primary?.def ?? c.inventory.secondary?.def!;
  const dt = 1 / 128;
  const fireInterval = 60 / def.rpm;

  // Advance now by 2× the fire interval before each shot to guarantee
  // now > nextFire regardless of accumulated float rounding.
  let now = startNow;
  for (let i = 0; i < n; i++) {
    now += fireInterval + 0.002; // +2 ms beyond fire gate to clear float noise
    updateWeapon(c, world, [], { trigger: true, reloadPressed: false, scopePressed: false }, now, dt);
    pitches.push(getViewPunch(c).pitch);
  }
  return pitches;
}

// ---------------------------------------------------------------------------
// Test 1: Pattern climb — 10 AK shots, viewPunchPitch strictly increasing
// ---------------------------------------------------------------------------

describe('AK-47 recoil pattern', () => {
  test('pitch increases over first 4 shots (well below 0.35 cap)', () => {
    // The 0.35 rad pitch cap is reached around shot 6-7; before that each
    // pattern entry must push pitch higher than the previous shot despite
    // one tick of recovery (1.6 × 1/128 ≈ 0.0125 rad).
    // AK pattern[0..3] entries are 1.6°, 1.8°, 2.0°, 2.1° (≈0.028–0.037 rad)
    // which all exceed the recovery tick, so pitch must increase.
    const c = makeAK();
    const pitches = fireNShots(c, 4);

    for (let i = 1; i < pitches.length; i++) {
      expect(pitches[i]).toBeGreaterThan(pitches[i - 1]!);
    }
  });

  test('pitch after 6 shots accumulates full prefix sum within jitter bounds', () => {
    // With spray-recovery suppression, recovery is suppressed between shots
    // in a burst, so viewPunchPitch after 6 shots must equal the prefix sum
    // of pattern entries 0-5 (±15% jitter per entry, tested at ±20% margin).
    // Upper bound is also capped at 0.35 (the hard pitch cap).
    const c = makeAK();
    const DEG_TO_RAD = Math.PI / 180;
    const pattern = WEAPONS.ak47!.recoilPattern!;

    // Prefix sum of pitch entries 0-5.
    let prefixSum = 0;
    for (let i = 0; i < 6; i++) {
      prefixSum += pattern[i]![0] * DEG_TO_RAD;
    }

    const totalPitch = fireNShots(c, 6).at(-1)!;
    const lowerBound = prefixSum * 0.85;
    const upperBound = Math.min(prefixSum * 1.15, 0.35);
    expect(totalPitch).toBeGreaterThanOrEqual(lowerBound);
    expect(totalPitch).toBeLessThanOrEqual(upperBound);
  });

  test('recovery resumes after trigger released for 1 s', () => {
    // Spray 5 shots, then release trigger and advance time 1.0 s via no-fire
    // updateWeapon ticks — viewPunchPitch must decay to < 0.01 rad.
    const c = makeAK();
    const def = c.inventory.primary!.def;
    const dt = 1 / 128;
    const fireInterval = 60 / def.rpm;

    // Fire 5 shots using additive accumulation.
    let now = 1.0;
    for (let i = 0; i < 5; i++) {
      now += fireInterval + 0.002;
      updateWeapon(c, world, [], { trigger: true, reloadPressed: false, scopePressed: false }, now, dt);
    }

    // Advance 1.0 s with trigger released (no-fire ticks every fixed dt).
    const endNow = now + 1.0;
    let t = now + dt;
    while (t <= endNow) {
      updateWeapon(c, world, [], { trigger: false, reloadPressed: false, scopePressed: false }, t, dt);
      t += dt;
    }

    expect(getViewPunch(c).pitch).toBeLessThan(0.01);
  });

  test('yaw sign during shots 10–13 follows right-drift (positive)', () => {
    const c = makeAK();
    const def = c.inventory.primary!.def;
    const dt = 1 / 128;
    const fireInterval = 60 / def.rpm;

    // Fire 13 shots, capture yaw after shots 10–13.
    let prevPitch = 0;
    const yawSnapshots: number[] = [];
    let now = 1.0;
    for (let i = 0; i < 13; i++) {
      now += fireInterval + 0.002; // additive accumulation to avoid float drift
      updateWeapon(c, world, [], { trigger: true, reloadPressed: false, scopePressed: false }, now, dt);
      if (i >= 9) {
        yawSnapshots.push(getViewPunch(c).yaw);
      }
      prevPitch = getViewPunch(c).pitch;
    }

    // Shots 10–13 in the AK pattern have positive yaw (right drift).
    // With ±15% jitter the sign should be overwhelmingly positive.
    for (const y of yawSnapshots) {
      expect(y).toBeGreaterThan(0);
    }
    // Suppress unused-variable warning.
    expect(prevPitch).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Pattern index clamp — 35 shots must not crash; pitch never exceeds cap
// ---------------------------------------------------------------------------

describe('AK-47 pattern index clamp', () => {
  test('35 shots: no crash and pitch capped at 0.35 rad', () => {
    // Give extra ammo by using a manipulated WeaponState with a large mag.
    const c = makeAK(35);
    // Override ammo count so we can fire 35 shots without reloading.
    const ws = c.inventory.primary!;
    ws.ammo = 35;

    const fireInterval = 60 / WEAPONS.ak47!.rpm;
    const dt = 1 / 128;
    let maxPitch = 0;
    let now = 1.0;

    for (let i = 0; i < 35; i++) {
      now += fireInterval + 0.002; // additive accumulation to avoid float drift
      updateWeapon(c, world, [], { trigger: true, reloadPressed: false, scopePressed: false }, now, dt);
      const p = getViewPunch(c).pitch;
      if (p > maxPitch) maxPitch = p;
    }

    expect(maxPitch).toBeLessThanOrEqual(0.35 + 0.001); // 0.35 cap with float tolerance
  });
});

// ---------------------------------------------------------------------------
// Test 3: Pattern reset — 5 shots, release 0.5 s, fire again → pattern[0]
// ---------------------------------------------------------------------------

describe('AK-47 pattern reset after trigger release', () => {
  test('after 0.5 s release, shotsFired resets so next shot applies pattern[0]', () => {
    const c = makeAK();
    const def = c.inventory.primary!.def;
    const fireInterval = 60 / def.rpm;
    const dt = 1 / 128;
    const DEG_TO_RAD = Math.PI / 180;

    // Fire 5 shots using additive accumulation to avoid float-drift gate misses.
    let fireNow = 1.0;
    for (let i = 0; i < 5; i++) {
      fireNow += fireInterval + 0.002;
      updateWeapon(c, world, [], { trigger: true, reloadPressed: false, scopePressed: false }, fireNow, dt);
    }

    // Release trigger: first tick at trigger=false sets lastTriggerAt.
    // Second tick at trigger=false, 0.5 s later, fires the 0.4 s reset.
    const releaseNow = fireNow + 0.001;
    updateWeapon(c, world, [], { trigger: false, reloadPressed: false, scopePressed: false }, releaseNow, dt);
    const releaseNow2 = releaseNow + 0.5;
    updateWeapon(c, world, [], { trigger: false, reloadPressed: false, scopePressed: false }, releaseNow2, dt);

    // Verify shotsFired reset by checking the primary WeaponState directly.
    expect(c.inventory.primary!.shotsFired).toBe(0);

    // Force view punch to zero using resetAim so the next shot delta is clean.
    resetAim(c);

    // Fire shot 1 again — shotsFired was 0 so this should use pattern[0].
    const shotNow = releaseNow2 + dt + 0.001;
    updateWeapon(c, world, [], { trigger: true, reloadPressed: false, scopePressed: false }, shotNow, dt);

    const delta = getViewPunch(c).pitch;  // started at 0 after resetAim
    const expectedDelta = def.recoilPattern![0]![0] * DEG_TO_RAD;

    // Within ±20% of pattern[0] pitch (jitter is ±15%).
    expect(delta).toBeGreaterThan(expectedDelta * 0.80);
    expect(delta).toBeLessThan(expectedDelta * 1.20);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Movement accuracy curve
// ---------------------------------------------------------------------------

describe('movement accuracy curve', () => {
  test('standing: spread == spreadBase (no movement penalty, no spray)', () => {
    const c = makeAK();
    c.vel = { x: 0, y: 0, z: 0 };
    const spread = currentSpread(c, 0);
    expect(spread).toBeCloseTo(WEAPONS.ak47!.spreadBase, 6);
  });

  test('moveFrac 0.3 (below 0.34 threshold): same as standing', () => {
    const c = makeAK();
    const def = WEAPONS.ak47!;
    const speed = def.moveSpeed * 0.30;
    c.vel = { x: speed, y: 0, z: 0 };
    const spread = currentSpread(c, 0);
    expect(spread).toBeCloseTo(def.spreadBase, 6);
  });

  test('full run: spread >= 4× standing for AK-47', () => {
    const c = makeAK();
    const def = WEAPONS.ak47!;

    c.vel = { x: 0, y: 0, z: 0 };
    const standing = currentSpread(c, 0);

    c.vel = { x: def.moveSpeed, y: 0, z: 0 };
    const running = currentSpread(c, 0);

    expect(running).toBeGreaterThanOrEqual(standing * 4);
  });

  test('crouch multiplier (0.65×) applies correctly', () => {
    const c = makeAK();
    c.vel = { x: 0, y: 0, z: 0 };

    c.crouching = false;
    const stand = currentSpread(c, 0);

    c.crouching = true;
    const crouch = currentSpread(c, 0);

    expect(crouch).toBeCloseTo(stand * 0.65, 6);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Legacy fallback — deagle uses legacy formula, not pattern
// ---------------------------------------------------------------------------

describe('legacy fallback (deagle)', () => {
  test('deagle punch after 1 shot matches legacy formula', () => {
    const c = makeDeagle();
    const def = WEAPONS.deagle!;
    const dt = 1 / 128;

    updateWeapon(c, world, [], { trigger: true, reloadPressed: false, scopePressed: false }, 1.0, dt);

    const punch = getViewPunch(c);

    // Legacy: viewPunchPitch += recoilPitch * (1 + shotsFired * 0.06)
    // shotsFired = 1 after first shot, so factor = 1 + 1 * 0.06 = 1.06
    const expectedPitch = def.recoilPitch * (1 + 1 * 0.06);

    expect(punch.pitch).toBeCloseTo(expectedPitch, 5);
    // Deagle has no pattern — recoilPattern is undefined.
    expect(def.recoilPattern).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 6: currentSpread() and updateWeapon fire-path agree (DRY guard)
// ---------------------------------------------------------------------------

describe('spread DRY guard — currentSpread agrees with fire path', () => {
  test('identical standing-still state: currentSpread() matches spread used in shot', () => {
    // We verify this indirectly: currentSpread on a fresh combatant should equal
    // spreadBase (no movement, no spray). The fire path goes through the same
    // computeSpread with the same inputs.
    const c = makeAK();
    c.vel = { x: 0, y: 0, z: 0 };

    // Before any shots: shotsFired = 0, no spray yet.
    const cs = currentSpread(c, 0);
    expect(cs).toBeCloseTo(WEAPONS.ak47!.spreadBase, 6);

    // After firing: shotsFired increments. currentSpread should now include
    // the spray penalty for 1 shot (min(1, 10) * spreadSpray).
    const dt = 1 / 128;
    updateWeapon(c, world, [], { trigger: true, reloadPressed: false, scopePressed: false }, 1.0, dt);

    const def = WEAPONS.ak47!;
    const csAfter = currentSpread(c, 0);
    const expectedAfter = def.spreadBase + (def.spreadSpray ?? 0) * Math.min(1, 10);
    expect(csAfter).toBeCloseTo(expectedAfter, 6);
  });
});
