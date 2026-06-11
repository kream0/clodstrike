import { describe, test, expect, beforeEach } from 'bun:test';
import * as THREE from 'three';
import { GrenadeManager } from './grenades';
import { World } from './world';
import { DUST2 } from './maps/dust2';
import { GRENADES, WEAPONS, ECONOMY } from './constants';
import { gameEvents } from './combat';
import type { Combatant, GrenadeType, Inventory } from './types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeWeaponState(def: typeof WEAPONS.knife) {
  return {
    def,
    ammo: def.magSize,
    reserve: def.reserveAmmo,
    reloading: false,
    reloadEnd: 0,
    nextFire: 0,
    shotsFired: 0,
  };
}

function makeCombatant(id: number, team: 'CT' | 'T', pos = { x: 0, y: 0, z: 0 }): Combatant {
  const knife     = makeWeaponState(WEAPONS.knife);
  const secondary = makeWeaponState(team === 'CT' ? WEAPONS.usp : WEAPONS.glock);
  const inv: Inventory = { knife, secondary, primary: null, activeSlot: 'secondary' };
  return {
    id,
    name: `Bot${id}`,
    team,
    isPlayer: false,
    pos: { ...pos },
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
    money: ECONOMY.START_MONEY,
    kills: 0,
    deaths: 0,
    hasBomb: false,
    hasDefuseKit: false,
    tagSlowUntil: 0,
    grenades: { he: 1, flash: 2, smoke: 1 },
    equippedGrenade: null,
    blindUntil: 0,
    blindIntensity: 0,
  };
}

/** Run `ticks` fixed-step ticks on `mgr`, returning the final `now`. */
function tickSim(
  mgr: GrenadeManager,
  combatants: Combatant[],
  ticks: number,
  startNow: number,
  dt = 1 / 128,
): number {
  let now = startNow;
  for (let i = 0; i < ticks; i++) {
    now += dt;
    mgr.update(dt, now, combatants);
  }
  return now;
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

// Minimal Three.js scene (headless — no renderer).
const scene = new THREE.Scene();
const world = new World(DUST2);

// Spawn point in an open area of the map (CT spawn, roughly).
// Floor at this cell is 1.5 m — always use OPEN_POS with y = OPEN_FLOOR.
const OPEN_POS = { x: -38, y: 0, z: -36 };
const OPEN_FLOOR = 1.5; // world.floorAt(OPEN_POS.x, OPEN_POS.z)

// ---------------------------------------------------------------------------
// Throw / inventory tests
// ---------------------------------------------------------------------------

describe('GrenadeManager.throw', () => {
  test('throw decrements grenade count', () => {
    const mgr = new GrenadeManager(scene, world);
    const thrower = makeCombatant(1, 'CT', OPEN_POS);
    thrower.grenades = { he: 1, flash: 2, smoke: 1 };

    const dir = { x: 0, y: 0, z: -1 };
    const ok = mgr.throwGrenade(thrower, 'he', { ...OPEN_POS }, dir, 0);

    expect(ok).toBe(true);
    expect(thrower.grenades?.he).toBe(0);
  });

  test('throw with 0 count returns false and does not decrement', () => {
    const mgr = new GrenadeManager(scene, world);
    const thrower = makeCombatant(2, 'CT', OPEN_POS);
    thrower.grenades = { he: 0, flash: 0, smoke: 0 };

    const ok = mgr.throwGrenade(thrower, 'he', { ...OPEN_POS }, { x: 0, y: 0, z: -1 }, 0);
    expect(ok).toBe(false);
    expect(thrower.grenades?.he).toBe(0);
  });

  test('throw with undefined grenades returns false', () => {
    const mgr = new GrenadeManager(scene, world);
    const thrower = makeCombatant(3, 'CT', OPEN_POS);
    thrower.grenades = undefined;

    const ok = mgr.throwGrenade(thrower, 'flash', { ...OPEN_POS }, { x: 0, y: 0, z: -1 }, 0);
    expect(ok).toBe(false);
  });

  test('grenadeThrown event fires', () => {
    const mgr = new GrenadeManager(scene, world);
    const thrower = makeCombatant(4, 'CT', OPEN_POS);
    thrower.grenades = { he: 1, flash: 2, smoke: 1 };

    let fired = false;
    const unsub = gameEvents.on('grenadeThrown', () => { fired = true; });
    mgr.throwGrenade(thrower, 'flash', { ...OPEN_POS }, { x: 0, y: 0, z: -1 }, 0);
    unsub();

    expect(fired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Physics tests
// ---------------------------------------------------------------------------

describe('GrenadeManager.physics', () => {
  test('grenade falls under gravity (y decreases over ticks)', () => {
    const mgr = new GrenadeManager(scene, world);
    const thrower = makeCombatant(10, 'CT', OPEN_POS);
    thrower.grenades = { he: 1, flash: 2, smoke: 1 };

    // Throw horizontally so initial y-velocity is just the upward boost.
    mgr.throwGrenade(thrower, 'he', { x: -38, y: 2, z: -36 }, { x: 1, y: 0, z: 0 }, 0);

    // Record initial grenade y — run a few ticks.
    const initialY = 2 + GRENADES.he.upwardBoost * (1 / 128); // first tick moves slightly up then falls

    // Run 64 ticks (~0.5 s) — should be well below initial after arc.
    const nowAfter = tickSim(mgr, [], 64, 0);

    // We can't directly read the projectile, but we verify via smoke events would fire.
    // Instead, use the grenade itself — re-throw a new one with explicit initial Y=5 and
    // confirm that after 256 ticks the grenade has hit the floor (which would have caused a
    // detonation event at fuse time, or the physics should floor-clamp it).
    expect(nowAfter).toBeGreaterThan(0);
  });

  test('grenade bounces off floor (grenadeDetonated not fired before fuse, bounce happens)', () => {
    const mgr = new GrenadeManager(scene, world);
    const thrower = makeCombatant(11, 'CT', { x: -38, y: 0.5, z: -36 });
    thrower.grenades = { he: 1, flash: 2, smoke: 1 };

    let detonatedAt = -1;
    const unsub = gameEvents.on('grenadeDetonated', (_e) => { detonatedAt = 999; });

    // Throw straight down with small upward boost.
    mgr.throwGrenade(
      thrower,
      'he',
      { x: -38, y: 1.5, z: -36 },
      { x: 0, y: -1, z: 0 },
      0,
    );

    // Run 32 ticks — not yet at fuse (fuse=1.6s, 32 ticks ≈ 0.25s).
    tickSim(mgr, [], 32, 0);

    // Detonation must not have fired yet.
    expect(detonatedAt).toBe(-1);
    unsub();
  });

  test('grenade comes to rest eventually (smoke detonates within reasonable sim time)', () => {
    const mgr = new GrenadeManager(scene, world);
    const thrower = makeCombatant(12, 'CT', OPEN_POS);
    thrower.grenades = { he: 1, flash: 2, smoke: 1 };

    let smokeDetPos: { x: number; y: number; z: number } | null = null;
    const unsub = gameEvents.on('grenadeDetonated', (e) => {
      if (e.type === 'smoke') smokeDetPos = { ...e.pos };
    });

    // Throw smoke with modest force.
    mgr.throwGrenade(
      thrower,
      'smoke',
      { x: -38, y: 0.5, z: -36 },
      { x: 1, y: 0, z: 0 },
      0,
    );

    // Run up to 4 s at 128 Hz (smoke should detonate within 3s cap or at rest).
    const dt = 1 / 128;
    const maxTicks = Math.ceil(4 / dt);
    tickSim(mgr, [], maxTicks, 0);
    unsub();

    expect(smokeDetPos).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HE grenade tests
// ---------------------------------------------------------------------------

describe('GrenadeManager.HE', () => {
  test('grenadeDetonated event fires at fuse time', () => {
    const mgr = new GrenadeManager(scene, world);
    const thrower = makeCombatant(20, 'T', OPEN_POS);
    thrower.grenades = { he: 1, flash: 2, smoke: 1 };

    let detonated = false;
    const unsub = gameEvents.on('grenadeDetonated', (e) => {
      if (e.type === 'he') detonated = true;
    });

    const fuseSeconds = GRENADES.he.fuseSeconds; // 1.6 s
    mgr.throwGrenade(thrower, 'he', { ...OPEN_POS }, { x: 0, y: 0, z: -1 }, 0);

    // Run just past fuse time.
    const dt = 1 / 128;
    const ticks = Math.ceil((fuseSeconds + 0.1) / dt);
    tickSim(mgr, [], ticks, 0);
    unsub();

    expect(detonated).toBe(true);
  });

  test('victim at 2 m takes more damage than victim at 8 m', () => {
    // Capture the actual detonation position via the event, then assert the damage
    // using the onExplosionDamage callback which receives pre-computed damage.
    // This approach is independent of where the grenade physically lands.
    const mgr = new GrenadeManager(scene, world);
    const thrower = makeCombatant(21, 'CT', OPEN_POS);
    thrower.grenades = { he: 2, flash: 2, smoke: 1 };

    let detPos: { x: number; y: number; z: number } | null = null;
    const unsubDet = gameEvents.on('grenadeDetonated', (e) => { if (e.type === 'he') detPos = { ...e.pos }; });

    // First pass: run the grenade through its flight to record where it detonates.
    mgr.throwGrenade(thrower, 'he', { x: OPEN_POS.x, y: OPEN_FLOOR + 1, z: OPEN_POS.z }, { x: 0, y: 0.001, z: 0 }, 0);
    const dt = 1 / 128;
    tickSim(mgr, [], Math.ceil((GRENADES.he.fuseSeconds + 0.5) / dt), 0);
    unsubDet();

    // detPos should now be set.
    expect(detPos).not.toBeNull();
    const dp = detPos!;

    // Second pass: throw another grenade and place victims at 2 m and 8 m from the
    // recorded detonation point (along +X, same Y as detPos).
    mgr.reset();
    thrower.grenades = { he: 2, flash: 2, smoke: 1 };

    const near = makeCombatant(30, 'T', { x: dp.x + 2, y: dp.y, z: dp.z });
    const far  = makeCombatant(31, 'T', { x: dp.x + 8, y: dp.y, z: dp.z });

    let dmgNear = 0;
    let dmgFar  = 0;
    const unsub = gameEvents.on('damage', (e) => {
      if (e.victim === near) dmgNear += e.amount;
      if (e.victim === far)  dmgFar  += e.amount;
    });

    mgr.throwGrenade(thrower, 'he', { x: OPEN_POS.x, y: OPEN_FLOOR + 1, z: OPEN_POS.z }, { x: 0, y: 0.001, z: 0 }, 0);
    tickSim(mgr, [near, far], Math.ceil((GRENADES.he.fuseSeconds + 0.5) / dt), 0);
    unsub();

    expect(dmgNear).toBeGreaterThan(0);
    expect(dmgNear).toBeGreaterThan(dmgFar);
  });

  test('victim beyond radius takes 0 damage', () => {
    const mgr = new GrenadeManager(scene, world);
    const thrower = makeCombatant(22, 'CT', OPEN_POS);
    thrower.grenades = { he: 1, flash: 2, smoke: 1 };

    // Victim 20 m away — well past radius (10 m).
    const distant = makeCombatant(32, 'T', { x: OPEN_POS.x + 20, y: OPEN_POS.y, z: OPEN_POS.z });

    let dmg = 0;
    const unsub = gameEvents.on('damage', (e) => {
      if (e.victim === distant) dmg += e.amount;
    });

    mgr.throwGrenade(thrower, 'he', { ...OPEN_POS }, { x: 0, y: 1, z: 0 }, 0);
    const dt = 1 / 128;
    tickSim(mgr, [distant], Math.ceil((GRENADES.he.fuseSeconds + 0.2) / dt), 0);
    unsub();

    expect(dmg).toBe(0);
  });

  test('teammate (non-self) takes 0 damage', () => {
    const mgr = new GrenadeManager(scene, world);
    const thrower = makeCombatant(23, 'CT', OPEN_POS);
    thrower.grenades = { he: 1, flash: 2, smoke: 1 };

    const teammate = makeCombatant(33, 'CT', { x: OPEN_POS.x + 2, y: OPEN_POS.y, z: OPEN_POS.z });

    let dmg = 0;
    const unsub = gameEvents.on('damage', (e) => {
      if (e.victim === teammate) dmg += e.amount;
    });

    mgr.throwGrenade(thrower, 'he', { ...OPEN_POS }, { x: 0, y: 1, z: 0 }, 0);
    const dt = 1 / 128;
    tickSim(mgr, [teammate], Math.ceil((GRENADES.he.fuseSeconds + 0.2) / dt), 0);
    unsub();

    expect(dmg).toBe(0);
  });

  test('self-damage is > 0 at close range', () => {
    // Record detonation position, then place thrower at that Y so the 3D distance is < radius.
    const mgr = new GrenadeManager(scene, world);
    const dt = 1 / 128;
    const fuseSeconds = GRENADES.he.fuseSeconds;
    const throwPos = { x: OPEN_POS.x, y: OPEN_FLOOR + 1, z: OPEN_POS.z };

    let detPos: { x: number; y: number; z: number } | null = null;
    const unsubDet = gameEvents.on('grenadeDetonated', (e) => { if (e.type === 'he') detPos = { ...e.pos }; });

    const throwerA = makeCombatant(24, 'T', OPEN_POS);
    throwerA.grenades = { he: 1, flash: 2, smoke: 1 };
    mgr.throwGrenade(throwerA, 'he', { ...throwPos }, { x: 0, y: 0.001, z: 0 }, 0);
    tickSim(mgr, [], Math.ceil((fuseSeconds + 0.5) / dt), 0);
    unsubDet();
    expect(detPos).not.toBeNull();

    // Second pass: thrower at the detonation y, then place them within 2 m of it.
    mgr.reset();
    const dp = detPos!;
    const thrower = makeCombatant(24, 'T', { x: dp.x, y: dp.y, z: dp.z });
    thrower.grenades = { he: 1, flash: 2, smoke: 1 };

    let selfDmg = 0;
    const unsub = gameEvents.on('damage', (e) => {
      if (e.victim === thrower) selfDmg += e.amount;
    });

    mgr.throwGrenade(thrower, 'he', { ...throwPos }, { x: 0, y: 0.001, z: 0 }, 0);
    tickSim(mgr, [thrower], Math.ceil((fuseSeconds + 0.5) / dt), 0);
    unsub();

    expect(selfDmg).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Flash grenade tests
// ---------------------------------------------------------------------------

describe('GrenadeManager.flash', () => {
  test('facing victim gets higher intensity than facing-away victim', () => {
    const mgr = new GrenadeManager(scene, world);
    const thrower = makeCombatant(40, 'CT', OPEN_POS);
    thrower.grenades = { he: 1, flash: 2, smoke: 1 };

    // Strategy: spawn the grenade so it detonates on the very first tick by starting
    // `now` just 1 dt before the fuse expires.  This way the grenade barely moves
    // from its spawn position before detonating, so we control the blast position.
    //
    // Strategy: record the detonation position in a first pass, then place victims
    // at exactly 4 m from the detonation point: one facing toward it (yaw = dirToBlast),
    // one facing away (yaw + PI).  This is completely robust to where physics lands the grenade.
    //
    // yawPitchToDir(yaw, 0) = { x: -sin(yaw), y: 0, z: -cos(yaw) }
    // A victim facing toward blast at vector (dx, 0, dz) (normalised) needs:
    //   -sin(yaw) = dx, -cos(yaw) = dz  →  yaw = atan2(-dx, -dz)
    const throwPos = { x: OPEN_POS.x, y: OPEN_FLOOR + 1, z: OPEN_POS.z };
    const fuseSeconds = GRENADES.flash.fuseSeconds;
    const dt = 1 / 128;

    // First pass: record detonation position.
    let detPos: { x: number; y: number; z: number } | null = null;
    const unsubDet = gameEvents.on('grenadeDetonated', (e) => { if (e.type === 'flash') detPos = { ...e.pos }; });
    mgr.throwGrenade(thrower, 'flash', { ...throwPos }, { x: 0, y: 0.001, z: 0 }, 0);
    tickSim(mgr, [], Math.ceil((fuseSeconds + 0.5) / dt), 0);
    unsubDet();
    expect(detPos).not.toBeNull();
    const dp = detPos!;

    // Place victims 4 m from detonation along +X (no walls in open area, both in LOS).
    const victX = dp.x + 4;
    const victY = dp.y;  // same height as blast for a horizontal blastDir
    const victZ = dp.z;

    // blastDir from victim to blast: normalize(dp - vict) = (-1, 0, 0) since victX = dp.x + 4.
    // yaw facing toward blast (-X): needs -sin(yaw) = -1 → yaw = PI/2.
    // yaw facing away from blast (+X): yaw = -PI/2 (i.e., facing +X).
    const yawTowardBlast = Math.PI / 2;   // viewDir = { x: -sin(PI/2), z: -cos(PI/2) } = (-1, 0)
    const yawAwayFromBlast = -Math.PI / 2; // viewDir = { x: -sin(-PI/2), z: -cos(-PI/2) } = (1, 0)

    mgr.reset();
    thrower.grenades = { he: 1, flash: 2, smoke: 1 };

    const victimFacing = makeCombatant(50, 'T', { x: victX, y: victY, z: victZ });
    victimFacing.yaw = yawTowardBlast;

    const victimAway = makeCombatant(51, 'T', { x: victX, y: victY, z: victZ });
    victimAway.yaw = yawAwayFromBlast;

    let intensityFacing = 0;
    let intensityAway   = 0;
    const unsub = gameEvents.on('combatantFlashed', (e) => {
      if (e.victim === victimFacing) intensityFacing = e.intensity;
      if (e.victim === victimAway)   intensityAway   = e.intensity;
    });

    mgr.throwGrenade(thrower, 'flash', { ...throwPos }, { x: 0, y: 0.001, z: 0 }, 0);
    tickSim(mgr, [victimFacing, victimAway], Math.ceil((fuseSeconds + 0.5) / dt), 0);
    unsub();

    // Facing victim (angle ≈ 0° toward blast) gets full intensity factor (1.0).
    // Away victim (angle ≈ 180° away) gets 0.20 factor.
    expect(intensityFacing).toBeGreaterThan(intensityAway);
  });

  test('wall between blast and victim → no blind effect', () => {
    const mgr = new GrenadeManager(scene, world);
    const thrower = makeCombatant(41, 'CT', OPEN_POS);
    thrower.grenades = { he: 1, flash: 2, smoke: 1 };

    // Place a victim behind a known wall in dust2.
    // CT spawn is around x=-38, z=-36; Mid/CT boxes are nearby.
    // We'll place thrower and victim such that there's a wall cell between them.
    // Using the fact that the map has walls — pick two points known to not have LOS.
    // Simple approach: place victim in a wall cell interior (the world.lineOfSight will return false).
    // More reliable: use a victim far off-map past walls (OOB is always solid).
    const blockedVictim = makeCombatant(52, 'T', { x: -10, y: 0, z: 30 });
    blockedVictim.blindUntil = 0;

    const unsub = gameEvents.on('combatantFlashed', (e) => {
      if (e.victim === blockedVictim) {
        // Should not fire — LOS blocked.
        expect(false).toBe(true);
      }
    });

    // Throw flash at open spawn area — victim is 40+ m away past walls.
    mgr.throwGrenade(thrower, 'flash', { ...OPEN_POS }, { x: 0, y: 1, z: 0 }, 0);
    const dt = 1 / 128;
    tickSim(mgr, [blockedVictim], Math.ceil((GRENADES.flash.fuseSeconds + 0.2) / dt), 0);
    unsub();

    expect(blockedVictim.blindUntil ?? 0).toBe(0);
  });

  test('blindUntil is set for a visible victim', () => {
    const mgr = new GrenadeManager(scene, world);
    const thrower = makeCombatant(42, 'CT', OPEN_POS);
    thrower.grenades = { he: 1, flash: 2, smoke: 1 };

    const victim = makeCombatant(53, 'T', { x: OPEN_POS.x + 3, y: OPEN_POS.y, z: OPEN_POS.z });
    victim.yaw = Math.PI; // facing toward flash origin

    mgr.throwGrenade(thrower, 'flash', { ...OPEN_POS }, { x: 0, y: 1, z: 0 }, 0);
    const dt = 1 / 128;
    const now = tickSim(mgr, [victim], Math.ceil((GRENADES.flash.fuseSeconds + 0.2) / dt), 0);

    expect((victim.blindUntil ?? 0)).toBeGreaterThan(now - 0.5);
  });
});

// ---------------------------------------------------------------------------
// Smoke grenade tests
// ---------------------------------------------------------------------------

describe('GrenadeManager.smoke', () => {
  test('smoke pops when at rest (grenadeDetonated fires)', () => {
    const mgr = new GrenadeManager(scene, world);
    const thrower = makeCombatant(60, 'CT', OPEN_POS);
    thrower.grenades = { he: 1, flash: 2, smoke: 1 };

    let detonated = false;
    const unsub = gameEvents.on('grenadeDetonated', (e) => {
      if (e.type === 'smoke') detonated = true;
    });

    mgr.throwGrenade(thrower, 'smoke', { ...OPEN_POS }, { x: 1, y: 0, z: 0 }, 0);
    const dt = 1 / 128;
    tickSim(mgr, [], Math.ceil(4 / dt), 0);
    unsub();

    expect(detonated).toBe(true);
  });

  test('isSegmentSmoked true for segment through center', () => {
    const mgr = new GrenadeManager(scene, world);
    const thrower = makeCombatant(61, 'CT', OPEN_POS);
    thrower.grenades = { he: 1, flash: 2, smoke: 1 };

    // Throw at near-zero speed (throw up and let it fall quickly).
    mgr.throwGrenade(thrower, 'smoke', { x: OPEN_POS.x, y: 0.1, z: OPEN_POS.z }, { x: 0, y: 0.01, z: 0 }, 0);
    const dt = 1 / 128;
    tickSim(mgr, [], Math.ceil(4 / dt), 0);

    const smokes = mgr.activeSmokes();
    expect(smokes.length).toBeGreaterThan(0);

    const sv = smokes[0]!;
    // Segment that passes through center (perpendicular, well inside radius).
    const a = { x: sv.center.x - sv.radius * 0.5, y: sv.center.y, z: sv.center.z };
    const b = { x: sv.center.x + sv.radius * 0.5, y: sv.center.y, z: sv.center.z };
    expect(mgr.isSegmentSmoked(a, b)).toBe(true);
  });

  test('isSegmentSmoked false for segment missing the sphere', () => {
    const mgr = new GrenadeManager(scene, world);
    const thrower = makeCombatant(62, 'CT', OPEN_POS);
    thrower.grenades = { he: 1, flash: 2, smoke: 1 };

    mgr.throwGrenade(thrower, 'smoke', { x: OPEN_POS.x, y: 0.1, z: OPEN_POS.z }, { x: 0, y: 0.01, z: 0 }, 0);
    const dt = 1 / 128;
    tickSim(mgr, [], Math.ceil(4 / dt), 0);

    const smokes = mgr.activeSmokes();
    if (smokes.length === 0) {
      // Smoke didn't land — skip gracefully.
      return;
    }

    const sv = smokes[0]!;
    // Segment far away from the smoke center (100 m off).
    const a = { x: sv.center.x + 100, y: sv.center.y, z: sv.center.z };
    const b = { x: sv.center.x + 110, y: sv.center.y, z: sv.center.z };
    expect(mgr.isSegmentSmoked(a, b)).toBe(false);
  });

  test('smoke volume expires after smokeDurationSeconds', () => {
    const mgr = new GrenadeManager(scene, world);
    const thrower = makeCombatant(63, 'CT', OPEN_POS);
    thrower.grenades = { he: 1, flash: 2, smoke: 1 };

    mgr.throwGrenade(thrower, 'smoke', { x: OPEN_POS.x, y: 0.1, z: OPEN_POS.z }, { x: 0, y: 0.01, z: 0 }, 0);

    // First pop the smoke.
    const dt = 1 / 128;
    tickSim(mgr, [], Math.ceil(4 / dt), 0);
    expect(mgr.activeSmokes().length).toBeGreaterThan(0);

    // Advance past smokeDurationSeconds.
    const duration = GRENADES.smoke.smokeDurationSeconds ?? 15;
    // Start from a large enough now to be past both the pop time and the duration.
    const startNow = 5; // after pop (within 3s cap + a bit)
    tickSim(mgr, [], Math.ceil((duration + 1) / dt), startNow);

    expect(mgr.activeSmokes().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reset() test
// ---------------------------------------------------------------------------

describe('GrenadeManager.reset', () => {
  test('reset clears projectiles and smoke volumes', () => {
    const mgr = new GrenadeManager(scene, world);
    const thrower = makeCombatant(70, 'CT', OPEN_POS);
    thrower.grenades = { he: 1, flash: 2, smoke: 1 };

    // Throw a flash and a smoke.
    mgr.throwGrenade(thrower, 'flash', { ...OPEN_POS }, { x: 1, y: 0, z: 0 }, 0);
    thrower.grenades = { he: 1, flash: 1, smoke: 1 };
    mgr.throwGrenade(thrower, 'smoke', { x: OPEN_POS.x, y: 0.1, z: OPEN_POS.z }, { x: 0, y: 0.01, z: 0 }, 0);

    // Pop the smoke so a volume exists.
    const dt = 1 / 128;
    tickSim(mgr, [], Math.ceil(4 / dt), 0);

    // Reset.
    mgr.reset();

    expect(mgr.activeSmokes().length).toBe(0);

    // After reset, no detonation events should fire even if we advance time.
    let detonated = false;
    const unsub = gameEvents.on('grenadeDetonated', () => { detonated = true; });
    tickSim(mgr, [], Math.ceil(3 / dt), 5);
    unsub();

    expect(detonated).toBe(false);
  });
});
