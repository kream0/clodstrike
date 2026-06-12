/**
 * constants.test.ts — Weapon roster data-integrity tests.
 * All assertions are non-tautological: they check computed invariants, not
 * the literal value that was just written into the table.
 */

import { describe, it, expect } from 'bun:test';
import { WEAPONS } from './constants';
import type { WeaponDef } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL = Object.values(WEAPONS) as WeaponDef[];
const NON_KNIFE = ALL.filter(w => !w.isKnife);

// ---------------------------------------------------------------------------
// 1. Per-entry structural invariants
// ---------------------------------------------------------------------------

describe('WEAPONS — per-entry structural invariants', () => {
  for (const def of ALL) {
    it(`${def.id}: key === def.id`, () => {
      expect(WEAPONS[def.id]).toBe(def);
    });

    it(`${def.id}: price ≥ 0 (knife may be 0)`, () => {
      expect(def.price).toBeGreaterThanOrEqual(0);
    });

    if (!def.isKnife) {
      it(`${def.id}: magSize > 0`, () => {
        expect(def.magSize).toBeGreaterThan(0);
      });
    }

    it(`${def.id}: rpm > 0`, () => {
      expect(def.rpm).toBeGreaterThan(0);
    });

    it(`${def.id}: reloadTime ≥ 0`, () => {
      expect(def.reloadTime).toBeGreaterThanOrEqual(0);
    });

    it(`${def.id}: moveSpeed > 0`, () => {
      expect(def.moveSpeed).toBeGreaterThan(0);
    });

    it(`${def.id}: killReward present and ≥ 0`, () => {
      expect(typeof def.killReward).toBe('number');
      expect(def.killReward).toBeGreaterThanOrEqual(0);
    });

    it(`${def.id}: slot is valid`, () => {
      expect(['primary', 'secondary', 'knife']).toContain(def.slot);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Category + teams consistency
// ---------------------------------------------------------------------------

describe('WEAPONS — category and teams consistency', () => {
  it('knife has no category (not shown in buy menu)', () => {
    expect(WEAPONS['knife']?.category).toBeUndefined();
  });

  for (const def of NON_KNIFE) {
    it(`${def.id}: has a category`, () => {
      expect(def.category).toBeDefined();
    });

    it(`${def.id}: category is valid enum value`, () => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(['pistol', 'smg', 'heavy', 'rifle']).toContain(def.category!);
    });

    it(`${def.id}: pistol category → secondary slot`, () => {
      if (def.category === 'pistol') {
        expect(def.slot).toBe('secondary');
      }
    });

    it(`${def.id}: smg/heavy/rifle category → primary slot`, () => {
      if (def.category === 'smg' || def.category === 'heavy' || def.category === 'rifle') {
        expect(def.slot).toBe('primary');
      }
    });

    if (def.teams !== undefined) {
      it(`${def.id}: teams array only contains 'CT' or 'T'`, () => {
        for (const t of def.teams!) {
          expect(['CT', 'T']).toContain(t);
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Team-exclusive sets match CS2 default loadout exactly
// ---------------------------------------------------------------------------

describe('WEAPONS — team-exclusive sets', () => {
  const CT_EXCLUSIVE = new Set(
    NON_KNIFE
      .filter(w => w.teams?.length === 1 && w.teams[0] === 'CT')
      .map(w => w.id)
  );
  const T_EXCLUSIVE = new Set(
    NON_KNIFE
      .filter(w => w.teams?.length === 1 && w.teams[0] === 'T')
      .map(w => w.id)
  );

  const EXPECTED_CT = new Set(['usp', 'fiveseven', 'mp9', 'mag7', 'famas', 'm4a4', 'aug', 'scar20']);
  const EXPECTED_T  = new Set(['glock', 'tec9', 'mac10', 'sawedoff', 'galil', 'ak47', 'sg553', 'g3sg1']);

  it('CT-exclusive set matches expected', () => {
    expect(CT_EXCLUSIVE).toEqual(EXPECTED_CT);
  });

  it('T-exclusive set matches expected', () => {
    expect(T_EXCLUSIVE).toEqual(EXPECTED_T);
  });
});

// ---------------------------------------------------------------------------
// 4. Full-auto weapons with rpm ≥ 500 must have a recoilPattern of ≥ 15 entries
// ---------------------------------------------------------------------------

describe('WEAPONS — recoilPattern for sprayable full-auto weapons', () => {
  const SPRAYABLE = ALL.filter(w => w.auto === true && w.rpm >= 500);

  for (const def of SPRAYABLE) {
    it(`${def.id}: has recoilPattern with ≥ 15 entries`, () => {
      expect(def.recoilPattern).toBeDefined();
      expect(def.recoilPattern!.length).toBeGreaterThanOrEqual(15);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Roster size = exactly 30
//    Breakdown: knife(1) + pistols(7: glock,usp,deagle,dualies,p250,fiveseven,tec9)
//    + SMGs(6) + heavy(6) + rifles(10: famas,galil,m4a4,ak47,aug,sg553,ssg08,awp,g3sg1,scar20)
// ---------------------------------------------------------------------------

describe('WEAPONS — roster size', () => {
  it('has exactly 30 entries', () => {
    expect(ALL.length).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// 6. Canonical CS2 price spot-checks (use EXISTING value for pre-existing weapons)
// ---------------------------------------------------------------------------

describe('WEAPONS — canonical price spot-checks', () => {
  const price = (id: string) => WEAPONS[id]?.price;

  it('ak47 = 2700', ()  => { expect(price('ak47')).toBe(2700); });
  it('m4a4 = 2900', ()  => { expect(price('m4a4')).toBe(2900); });
  it('awp = 4750', ()   => { expect(price('awp')).toBe(4750); });
  it('deagle = 700', () => { expect(price('deagle')).toBe(700); });
  it('p90 = 2350', ()   => { expect(price('p90')).toBe(2350); });
  it('scar20 = 5000', () => { expect(price('scar20')).toBe(5000); });
  it('g3sg1 = 5000', () => { expect(price('g3sg1')).toBe(5000); });
  it('m249 = 5200', ()  => { expect(price('m249')).toBe(5200); });
  it('negev = 1700', () => { expect(price('negev')).toBe(1700); });
  it('famas = 2050', () => { expect(price('famas')).toBe(2050); });
  it('galil = 1800', () => { expect(price('galil')).toBe(1800); });
  it('aug = 3300', ()   => { expect(price('aug')).toBe(3300); });
  it('sg553 = 3000', () => { expect(price('sg553')).toBe(3000); });
  it('ssg08 = 1700', () => { expect(price('ssg08')).toBe(1700); });
  it('mac10 = 1050', () => { expect(price('mac10')).toBe(1050); });
  it('mp9 = 1250', ()   => { expect(price('mp9')).toBe(1250); });
  it('mp7 = 1500', ()   => { expect(price('mp7')).toBe(1500); });
  it('ump45 = 1200', () => { expect(price('ump45')).toBe(1200); });
  it('bizon = 1400', () => { expect(price('bizon')).toBe(1400); });
  it('nova = 1050', ()  => { expect(price('nova')).toBe(1050); });
  it('xm1014 = 2000', () => { expect(price('xm1014')).toBe(2000); });
  it('sawedoff = 1100', () => { expect(price('sawedoff')).toBe(1100); });
  it('mag7 = 1300', ()  => { expect(price('mag7')).toBe(1300); });
  it('dualies = 300', () => { expect(price('dualies')).toBe(300); });
  it('p250 = 250', ()   => { expect(price('p250')).toBe(250); });
  it('fiveseven = 500', () => { expect(price('fiveseven')).toBe(500); });
  it('tec9 = 500', ()   => { expect(price('tec9')).toBe(500); });
});

// ---------------------------------------------------------------------------
// 7. recoilPattern entries are finite [pitch, yaw] pairs;
//    average pitch per entry < 1.5° (catches gross data-entry errors like
//    10.0 instead of 1.0, while allowing long MG patterns with high totals).
// ---------------------------------------------------------------------------

// (section 7 tests below, section 8 penetration tests after)

describe('WEAPONS — recoilPattern sanity', () => {
  for (const def of ALL) {
    if (!def.recoilPattern) continue;

    it(`${def.id}: all pattern entries are finite numbers`, () => {
      for (const [pitch, yaw] of def.recoilPattern!) {
        expect(Number.isFinite(pitch)).toBe(true);
        expect(Number.isFinite(yaw)).toBe(true);
      }
    });

    it(`${def.id}: average pitch per entry < 1.5°`, () => {
      const total = def.recoilPattern!.reduce((sum, [p]) => sum + p, 0);
      const avg = total / def.recoilPattern!.length;
      expect(avg).toBeLessThan(1.5);
    });
  }
});

// ---------------------------------------------------------------------------
// 8. Penetration field integrity
// ---------------------------------------------------------------------------

describe('WEAPONS — penetration field integrity', () => {
  // All weapons that have a penetration field must be in [0, 1].
  for (const def of ALL) {
    if (def.penetration !== undefined) {
      it(`${def.id}: penetration in [0, 1]`, () => {
        expect(def.penetration).toBeGreaterThanOrEqual(0);
        expect(def.penetration).toBeLessThanOrEqual(1);
      });
    }
  }

  it('knife has no penetration (undefined or 0)', () => {
    const k = WEAPONS['knife'];
    expect(k?.penetration ?? 0).toBe(0);
  });

  it('shotguns have penetration ≤ 0.30', () => {
    const shotgunIds = ['nova', 'xm1014', 'sawedoff', 'mag7'];
    for (const id of shotgunIds) {
      const def = WEAPONS[id];
      expect(def).toBeDefined();
      // penetration is optional; if absent treat as 0
      expect(def?.penetration ?? 0).toBeLessThanOrEqual(0.30);
    }
  });

  it('AWP and auto-snipers have penetration ≥ 0.75', () => {
    const sniperIds = ['awp', 'g3sg1', 'scar20'];
    for (const id of sniperIds) {
      const def = WEAPONS[id];
      expect(def).toBeDefined();
      expect(def?.penetration ?? 0).toBeGreaterThanOrEqual(0.75);
    }
  });

  it('SSG08 has penetration ≥ 0.70', () => {
    expect(WEAPONS['ssg08']?.penetration ?? 0).toBeGreaterThanOrEqual(0.70);
  });

  it('AK-47 and SG553 have penetration ≥ 0.80', () => {
    expect(WEAPONS['ak47']?.penetration ?? 0).toBeGreaterThanOrEqual(0.80);
    expect(WEAPONS['sg553']?.penetration ?? 0).toBeGreaterThanOrEqual(0.80);
  });
});
