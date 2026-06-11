import { describe, expect, test } from 'bun:test';
import type { MapData, Combatant, Inventory, WeaponState } from './types';
import { WEAPONS } from './constants';
import { World } from './world';
import { gameEvents, applyDamage, getHitboxes, fireHitscan } from './combat';
import { updateWeapon, switchSlot, currentSpread } from './weapons';

// ---------------------------------------------------------------------------
// Flat test map (same structure as movement.test.ts)
// ---------------------------------------------------------------------------

const FLAT_MAP: MapData = (() => {
  const SIZE = 40;
  const rows: string[] = [];
  for (let r = 0; r < SIZE; r++) {
    let row = '';
    for (let c = 0; c < SIZE; c++) {
      if (r === 0 || r === SIZE - 1 || c === 0 || c === SIZE - 1) {
        row += '#';
      } else {
        row += '0';
      }
    }
    rows.push(row);
  }
  return {
    name: 'combat_test',
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextId = 1;

function makeCombatant(team: 'CT' | 'T' = 'CT', withPrimary = false): Combatant {
  const knife: WeaponState = {
    def: WEAPONS.knife,
    ammo: 0, reserve: 0, reloading: false, reloadEnd: 0, nextFire: 0, shotsFired: 0,
  };
  const secondary: WeaponState = {
    def: WEAPONS.usp,
    ammo: WEAPONS.usp.magSize, reserve: WEAPONS.usp.reserveAmmo,
    reloading: false, reloadEnd: 0, nextFire: 0, shotsFired: 0,
  };
  const primary: WeaponState | null = withPrimary
    ? {
        def: WEAPONS.ak47,
        ammo: WEAPONS.ak47.magSize, reserve: WEAPONS.ak47.reserveAmmo,
        reloading: false, reloadEnd: 0, nextFire: 0, shotsFired: 0,
      }
    : null;

  const inventory: Inventory = {
    knife,
    secondary,
    primary,
    activeSlot: withPrimary ? 'primary' : 'secondary',
  };

  return {
    id: nextId++,
    name: 'test',
    team,
    isPlayer: false,
    pos: { x: 10, y: 0, z: 10 },
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
// Tests: falloff
// ---------------------------------------------------------------------------

describe('applyDamage falloff', () => {
  test('ak47 at 0 m gives base damage (pre-armor)', () => {
    const shooter = makeCombatant('T');
    const victim  = makeCombatant('CT');
    const ak      = WEAPONS.ak47;

    // No armor, body shot.
    const { amount } = applyDamage(victim, shooter, ak, 0, 'body', 0);
    // base = 36 × 0.98^0 = 36, round to ≥1 → 36.
    expect(amount).toBe(36);
  });

  test('ak47 at 30 m gives approximately rangeModifier^2 × base', () => {
    const shooter = makeCombatant('T');
    const victim  = makeCombatant('CT');
    victim.health = 200; // keep alive
    const ak   = WEAPONS.ak47;
    // expected ≈ 36 × 0.98^2 = 36 × 0.9604 ≈ 34.57 → 35
    const expected = 36 * Math.pow(0.98, 2);
    const { amount } = applyDamage(victim, shooter, ak, 30, 'body', 0);
    expect(amount).toBeGreaterThan(expected - 0.6);
    expect(amount).toBeLessThan(expected + 0.6);
  });
});

// ---------------------------------------------------------------------------
// Tests: armor
// ---------------------------------------------------------------------------

describe('applyDamage armor', () => {
  test('body shot with armor reduces damage by ARMOR_DAMAGE_MULT (0.775)', () => {
    const shooter = makeCombatant('T');
    const victim  = makeCombatant('CT');
    victim.armor  = 100;
    const prevArmor = victim.armor;
    const ak = WEAPONS.ak47;

    const { amount } = applyDamage(victim, shooter, ak, 0, 'body', 0);
    const expected = Math.max(1, Math.round(36 * 0.775));
    expect(amount).toBe(expected);
    expect(victim.armor).toBeLessThan(prevArmor);
  });

  test('head shot with helmet applies armor reduction', () => {
    const shooter = makeCombatant('T');
    const victim  = makeCombatant('CT');
    victim.armor  = 100;
    victim.helmet = true;
    const ak = WEAPONS.ak47;

    const rawHeadDmg   = 36 * 4; // headshotMult = 4
    const armoredDmg   = Math.max(1, Math.round(rawHeadDmg * 0.775));
    const { amount }   = applyDamage(victim, shooter, ak, 0, 'head', 0);
    expect(amount).toBe(armoredDmg);
  });

  test('head shot without helmet ignores armor', () => {
    const shooter = makeCombatant('T');
    const victim  = makeCombatant('CT');
    victim.armor  = 100;
    victim.helmet = false;
    const ak = WEAPONS.ak47;

    const rawHeadDmg = Math.max(1, Math.round(36 * 4)); // 144
    const { amount } = applyDamage(victim, shooter, ak, 0, 'head', 0);
    expect(amount).toBe(rawHeadDmg);
  });

  test('legs shot ignores armor', () => {
    const shooter = makeCombatant('T');
    const victim  = makeCombatant('CT');
    victim.armor  = 100;
    const ak = WEAPONS.ak47;

    // legs: 36 × 0.75 = 27, no armor
    const expected = Math.max(1, Math.round(36 * 0.75));
    const { amount } = applyDamage(victim, shooter, ak, 0, 'legs', 0);
    expect(amount).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Tests: kill flow
// ---------------------------------------------------------------------------

describe('kill flow', () => {
  test('repeated body AK shots kill victim, kill event fired once, attacker gets reward', () => {
    const shooter = makeCombatant('T');
    const victim  = makeCombatant('CT');
    const ak = WEAPONS.ak47;
    const startMoney = shooter.money;

    let killCount = 0;
    const unsub = gameEvents.on('kill', () => { killCount++; });

    // Each body shot at 10 m: 36 × 0.98^(10/15) ≈ 36 × 0.987 ≈ 35.5 → 36
    // With no armor: 36 damage. Need 3 shots.
    let shots = 0;
    while (victim.alive && shots < 20) {
      applyDamage(victim, shooter, ak, 10, 'body', 0);
      shots++;
    }

    expect(victim.alive).toBe(false);
    expect(victim.health).toBe(0);
    expect(killCount).toBe(1);
    expect(shooter.kills).toBe(1);
    expect(shooter.money).toBeGreaterThan(startMoney);
    expect(shooter.money).toBeLessThanOrEqual(16000);

    unsub();
  });

  test('deaths counter incremented on victim', () => {
    const shooter = makeCombatant('T');
    const victim  = makeCombatant('CT');
    const ak = WEAPONS.ak47;
    victim.health = 1;
    applyDamage(victim, shooter, ak, 0, 'body', 0);
    expect(victim.deaths).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: hitboxes
// ---------------------------------------------------------------------------

describe('getHitboxes', () => {
  test('standing: ray at eye height hits head', () => {
    const c = makeCombatant('CT');
    c.pos = { x: 10, y: 0, z: 10 };
    c.crouching = false;

    const boxes = getHitboxes(c);
    // Head spans y: 1.50–1.83 at pos.y=0
    // A ray at y=1.65 should be inside head box.
    expect(boxes.head.min.y).toBeCloseTo(1.50, 1);
    expect(boxes.head.max.y).toBeCloseTo(1.83, 1);

    // Check y=1.65 is inside.
    expect(1.65).toBeGreaterThan(boxes.head.min.y);
    expect(1.65).toBeLessThan(boxes.head.max.y);
  });

  test('standing: ray at 0.4 m height hits legs', () => {
    const c = makeCombatant('CT');
    c.pos = { x: 10, y: 0, z: 10 };
    c.crouching = false;

    const boxes = getHitboxes(c);
    // Legs span y: 0–0.85
    expect(boxes.legs.min.y).toBeCloseTo(0, 1);
    expect(boxes.legs.max.y).toBeCloseTo(0.85, 1);
    expect(0.4).toBeGreaterThan(boxes.legs.min.y);
    expect(0.4).toBeLessThan(boxes.legs.max.y);
  });

  test('crouched: hitboxes scale down by 1.35/1.83', () => {
    const c = makeCombatant('CT');
    c.pos = { x: 10, y: 0, z: 10 };
    c.crouching = true;

    const scale  = 1.35 / 1.83;
    const boxes  = getHitboxes(c);
    expect(boxes.head.max.y).toBeCloseTo(1.83 * scale, 2);
    expect(boxes.legs.max.y).toBeCloseTo(0.85 * scale, 2);
  });
});

// ---------------------------------------------------------------------------
// Tests: hitscan ray
// ---------------------------------------------------------------------------

describe('fireHitscan ray direction → hitGroup', () => {
  test('ray at head height toward target hits head', () => {
    const world   = new World(FLAT_MAP);
    const shooter = makeCombatant('T', true);
    const target  = makeCombatant('CT');

    // Shooter at (5, 0, 10), target at (20, 0, 10).
    shooter.pos = { x: 5,  y: 0, z: 10 };
    target.pos  = { x: 20, y: 0, z: 10 };

    // Direction straight along +X (yaw = -PI/2 in three.js convention, but we pass dir directly).
    // Head center Y ≈ 1.665 above feet (mid of 1.50–1.83).
    const headMidY = (1.50 + 1.83) / 2;
    // Eye origin: shooter.pos.y + 1.64 = 1.64
    const eyeY = 0 + 1.64;
    const dx   = target.pos.x - shooter.pos.x; // 15
    const dy   = (target.pos.y + headMidY) - eyeY;
    const dz   = 0;
    const len  = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const dir  = { x: dx / len, y: dy / len, z: dz / len };

    const result = fireHitscan(shooter, dir, world, [target], 0);
    expect(result.hitGroup).toBe('head');
    expect(result.headshot).toBe(true);
  });

  test('ray at leg height toward target hits legs', () => {
    const world   = new World(FLAT_MAP);
    const shooter = makeCombatant('T', true);
    const target  = makeCombatant('CT');

    shooter.pos = { x: 5,  y: 0, z: 10 };
    target.pos  = { x: 20, y: 0, z: 10 };

    // Legs center Y ≈ 0.425 above feet.
    const legMidY = (0 + 0.85) / 2;
    const eyeY    = 0 + 1.64;
    const dx = target.pos.x - shooter.pos.x;
    const dy = (target.pos.y + legMidY) - eyeY;
    const dz = 0;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const dir = { x: dx / len, y: dy / len, z: dz / len };

    const result = fireHitscan(shooter, dir, world, [target], 0);
    expect(result.hitGroup).toBe('legs');
  });
});

// ---------------------------------------------------------------------------
// Tests: weapons RPM gate
// ---------------------------------------------------------------------------

describe('updateWeapon', () => {
  test('two calls 10 ms apart → only 1 shot for AK at 600 rpm', () => {
    const world   = new World(FLAT_MAP);
    const shooter = makeCombatant('T', true);
    shooter.pos   = { x: 5, y: 0, z: 10 };
    // AK: 600 rpm → 0.1 s between shots.
    // 10 ms gap should not allow second shot.

    const input = { trigger: true, reloadPressed: false, scopePressed: false };
    const r1 = updateWeapon(shooter, world, [], input, 0,        1 / 128);
    const r2 = updateWeapon(shooter, world, [], input, 0.010,    1 / 128);

    expect(r1).not.toBeNull();   // first shot fires
    expect(r2).toBeNull();       // second blocked (need 0.1 s interval)
  });

  test('reload fills mag from reserve', () => {
    const world   = new World(FLAT_MAP);
    const shooter = makeCombatant('T', true);
    const ws = shooter.inventory.primary!;
    ws.ammo    = 5;
    ws.reserve = 30;

    const noTrigger = { trigger: false, reloadPressed: false, scopePressed: false };
    const reload    = { trigger: false, reloadPressed: true,  scopePressed: false };

    // Start reload.
    updateWeapon(shooter, world, [], reload, 0, 1 / 128);
    expect(ws.reloading).toBe(true);

    // Fast-forward past reloadEnd.
    const reloadEnd = ws.reloadEnd;
    updateWeapon(shooter, world, [], noTrigger, reloadEnd + 0.01, 1 / 128);

    expect(ws.reloading).toBe(false);
    expect(ws.ammo).toBe(WEAPONS.ak47.magSize);
  });

  test('semi-auto: trigger held down does not auto-fire (caller passes edge)', () => {
    // USP is semi-auto (auto=false). In updateWeapon, trigger=true is treated as
    // edge-processed by caller. Two consecutive ticks with trigger=true → second
    // shot should be blocked by RPM gate, not by semi logic.
    // At 352 rpm: 60/352 ≈ 0.17 s between shots; 1 tick apart is too fast.
    const world   = new World(FLAT_MAP);
    const shooter = makeCombatant('CT');
    shooter.pos   = { x: 5, y: 0, z: 10 };

    const input = { trigger: true, reloadPressed: false, scopePressed: false };
    const r1 = updateWeapon(shooter, world, [], input, 0,      1 / 128);
    const r2 = updateWeapon(shooter, world, [], input, 0.001,  1 / 128);

    expect(r1).not.toBeNull();
    expect(r2).toBeNull(); // blocked by nextFire gate
  });

  test('switchSlot delay blocks instant fire after switch', () => {
    const world   = new World(FLAT_MAP);
    const shooter = makeCombatant('T', true);
    // Switch from primary to secondary at t=0.
    shooter.inventory.activeSlot = 'primary';

    switchSlot(shooter, 'secondary', 0);

    // Try to fire immediately after switch.
    const input = { trigger: true, reloadPressed: false, scopePressed: false };
    const r = updateWeapon(shooter, world, [], input, 0.01, 1 / 128);
    // nextFire was set to now+0.45 → 0.01 < 0.45 → blocked.
    expect(r).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: spread
// ---------------------------------------------------------------------------

describe('spread', () => {
  test('moving spread > standing spread', () => {
    const shooter = makeCombatant('T', true);
    shooter.pos   = { x: 10, y: 0, z: 10 };

    // Standing still.
    shooter.vel = { x: 0, y: 0, z: 0 };
    const standSpread = currentSpread(shooter, 0);

    // Moving at full speed.
    shooter.vel = { x: WEAPONS.ak47.moveSpeed, y: 0, z: 0 };
    const moveSpread = currentSpread(shooter, 0);

    expect(moveSpread).toBeGreaterThan(standSpread);
  });

  test('crouching spread < standing spread', () => {
    const shooter = makeCombatant('T', true);
    shooter.pos   = { x: 10, y: 0, z: 10 };
    shooter.vel   = { x: 0, y: 0, z: 0 };

    shooter.crouching = false;
    const standSpread = currentSpread(shooter, 0);

    shooter.crouching = true;
    const crouchSpread = currentSpread(shooter, 0);

    expect(crouchSpread).toBeLessThan(standSpread);
  });
});
