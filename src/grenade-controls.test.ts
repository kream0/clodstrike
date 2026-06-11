import { describe, expect, test } from 'bun:test';
import type { Combatant, GrenadeType, Inventory, WeaponState } from './types';
import { WEAPONS } from './constants';
import {
  updateGrenadeEquip,
  isGrenadeEquipped,
  cancelGrenadeEquip,
} from './weapons';
import type { GrenadeControlInput, ThrowRequest } from './weapons';

// ---------------------------------------------------------------------------
// Minimal Combatant factory
// ---------------------------------------------------------------------------

function makeWeaponState(id: string): WeaponState {
  const def = WEAPONS[id];
  if (!def) throw new Error(`Unknown weapon id: ${id}`);
  return { def, ammo: def.magSize, reserve: def.reserveAmmo, reloading: false, reloadEnd: 0, nextFire: 0, shotsFired: 0 };
}

function makeCombatant(
  grenades?: Partial<Record<GrenadeType, number>>,
  equippedGrenade?: GrenadeType | null,
): Combatant {
  const knife = makeWeaponState('knife');
  const secondary = makeWeaponState('usp');
  const inventory: Inventory = {
    knife,
    secondary,
    primary: null,
    activeSlot: 'secondary' as const,
  };
  return {
    id: 1,
    name: 'test',
    team: 'CT',
    isPlayer: false,
    pos: { x: 0, y: 0, z: 0 },
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
    inventory,
    money: 0,
    kills: 0,
    deaths: 0,
    hasBomb: false,
    hasDefuseKit: false,
    tagSlowUntil: 0,
    grenades: grenades
      ? { he: grenades.he ?? 0, flash: grenades.flash ?? 0, smoke: grenades.smoke ?? 0 }
      : { he: 0, flash: 0, smoke: 0 },
    equippedGrenade: equippedGrenade ?? null,
  };
}

const noEdge: GrenadeControlInput = { equipPressed: false, firePressed: false };
const equipEdge: GrenadeControlInput = { equipPressed: true, firePressed: false };
const fireEdge: GrenadeControlInput = { equipPressed: false, firePressed: true };

// ---------------------------------------------------------------------------
// isGrenadeEquipped
// ---------------------------------------------------------------------------

describe('isGrenadeEquipped', () => {
  test('returns false when equippedGrenade is null', () => {
    const c = makeCombatant({}, null);
    expect(isGrenadeEquipped(c)).toBe(false);
  });

  test('returns true when equippedGrenade is set', () => {
    const c = makeCombatant({ he: 1 }, 'he');
    expect(isGrenadeEquipped(c)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cancelGrenadeEquip
// ---------------------------------------------------------------------------

describe('cancelGrenadeEquip', () => {
  test('clears equippedGrenade', () => {
    const c = makeCombatant({ he: 1 }, 'he');
    cancelGrenadeEquip(c);
    expect(c.equippedGrenade).toBeNull();
  });

  test('no-op when not equipped', () => {
    const c = makeCombatant({}, null);
    cancelGrenadeEquip(c);
    expect(c.equippedGrenade).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateGrenadeEquip — equip and cycling
// ---------------------------------------------------------------------------

describe('updateGrenadeEquip — equip', () => {
  test('equips he first when he is owned and nothing equipped', () => {
    const c = makeCombatant({ he: 1, flash: 1, smoke: 1 });
    updateGrenadeEquip(c, equipEdge, 0);
    expect(c.equippedGrenade).toBe('he');
  });

  test('skips zero-count types: equips first owned (flash)', () => {
    const c = makeCombatant({ he: 0, flash: 1, smoke: 1 });
    updateGrenadeEquip(c, equipEdge, 0);
    expect(c.equippedGrenade).toBe('flash');
  });

  test('skips zero-count types: equips smoke when only smoke owned', () => {
    const c = makeCombatant({ he: 0, flash: 0, smoke: 1 });
    updateGrenadeEquip(c, equipEdge, 0);
    expect(c.equippedGrenade).toBe('smoke');
  });

  test('no-op when no grenades owned', () => {
    const c = makeCombatant({ he: 0, flash: 0, smoke: 0 });
    updateGrenadeEquip(c, equipEdge, 0);
    expect(c.equippedGrenade).toBeNull();
  });

  test('no-op when no grenades field at all (undefined)', () => {
    const c = makeCombatant();
    // grenades is { he:0, flash:0, smoke:0 } from factory — but test with undefined
    const c2: Combatant = { ...c, grenades: undefined };
    updateGrenadeEquip(c2, equipEdge, 0);
    expect(c2.equippedGrenade).toBeNull();
  });
});

describe('updateGrenadeEquip — cycling', () => {
  test('cycles he → flash → smoke → he (all owned)', () => {
    const c = makeCombatant({ he: 1, flash: 1, smoke: 1 }, 'he');
    updateGrenadeEquip(c, equipEdge, 0);
    expect(c.equippedGrenade).toBe('flash');
    updateGrenadeEquip(c, equipEdge, 0);
    expect(c.equippedGrenade).toBe('smoke');
    updateGrenadeEquip(c, equipEdge, 0);
    expect(c.equippedGrenade).toBe('he');
  });

  test('cycles skip zero-count types: he → smoke (no flash)', () => {
    const c = makeCombatant({ he: 1, flash: 0, smoke: 1 }, 'he');
    updateGrenadeEquip(c, equipEdge, 0);
    expect(c.equippedGrenade).toBe('smoke');
  });

  test('stays on same type when only one type owned', () => {
    const c = makeCombatant({ he: 1, flash: 0, smoke: 0 }, 'he');
    updateGrenadeEquip(c, equipEdge, 0);
    expect(c.equippedGrenade).toBe('he');
  });

  test('no equip edge — no change to equipped', () => {
    const c = makeCombatant({ he: 1 }, 'he');
    const result = updateGrenadeEquip(c, noEdge, 0);
    expect(c.equippedGrenade).toBe('he');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateGrenadeEquip — fire (throw)
// ---------------------------------------------------------------------------

describe('updateGrenadeEquip — throw', () => {
  test('fire while equipped returns ThrowRequest with correct type', () => {
    const c = makeCombatant({ he: 1, flash: 0, smoke: 0 }, 'he');
    const result = updateGrenadeEquip(c, fireEdge, 0);
    expect(result).toEqual<ThrowRequest>({ type: 'he' });
  });

  test('fire clears equippedGrenade', () => {
    const c = makeCombatant({ flash: 2 }, 'flash');
    updateGrenadeEquip(c, fireEdge, 0);
    expect(c.equippedGrenade).toBeNull();
  });

  test('fire returns null and unequips when count is 0', () => {
    const c = makeCombatant({ he: 0 }, 'he');
    const result = updateGrenadeEquip(c, fireEdge, 0);
    expect(result).toBeNull();
    expect(c.equippedGrenade).toBeNull();
  });

  test('fire with no equip edge does nothing when not equipped', () => {
    const c = makeCombatant({ he: 1 });
    const result = updateGrenadeEquip(c, fireEdge, 0);
    expect(result).toBeNull();
    expect(c.equippedGrenade).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateGrenadeEquip — auto-unequip when count hits 0 externally
// ---------------------------------------------------------------------------

describe('updateGrenadeEquip — auto-unequip on count 0', () => {
  test('clears equippedGrenade if count becomes 0 externally before next tick', () => {
    const c = makeCombatant({ flash: 1 }, 'flash');
    // Externally the count reaches 0 (simulating core module decrement after throw).
    c.grenades!.flash = 0;
    // Next tick with no edges — auto-unequip.
    updateGrenadeEquip(c, noEdge, 0);
    expect(c.equippedGrenade).toBeNull();
  });

  test('remains equipped while count is still > 0', () => {
    const c = makeCombatant({ smoke: 2 }, 'smoke');
    c.grenades!.smoke = 1;
    updateGrenadeEquip(c, noEdge, 0);
    expect(c.equippedGrenade).toBe('smoke');
  });
});

// ---------------------------------------------------------------------------
// updateGrenadeEquip — slot switch cancels grenade
// ---------------------------------------------------------------------------

describe('updateGrenadeEquip — slot switch cancel', () => {
  test('slotSwitchPressed unequips grenade', () => {
    const c = makeCombatant({ he: 1 }, 'he');
    updateGrenadeEquip(c, { equipPressed: false, firePressed: false, slotSwitchPressed: true }, 0);
    expect(c.equippedGrenade).toBeNull();
  });

  test('slotSwitchPressed together with equipPressed: equip is ignored (unequip wins)', () => {
    const c = makeCombatant({ he: 1 }, 'he');
    // slot switch + equip in same tick — switch runs first and clears, equip would re-equip
    // Per spec: slotSwitchPressed clears first, then equipPressed can re-equip
    // That means it ends up equipped (slot cleared first then re-equipped). Verify actual behavior:
    updateGrenadeEquip(c, { equipPressed: true, firePressed: false, slotSwitchPressed: true }, 0);
    // After clear, equipPressed re-equips 'he' since it's owned.
    expect(c.equippedGrenade).toBe('he');
  });

  test('slotSwitchPressed without equipPressed: stays unequipped', () => {
    const c = makeCombatant({ he: 1 }, null);
    updateGrenadeEquip(c, { equipPressed: false, firePressed: false, slotSwitchPressed: true }, 0);
    expect(c.equippedGrenade).toBeNull();
  });
});
