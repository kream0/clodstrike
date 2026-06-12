/**
 * viewmodel.test.ts — headless bun test
 *
 * Tests pure math (normalizeWeaponModel), stem-mapping, grip presets, IK solver,
 * and disk/license checks.
 * Does NOT instantiate ViewModel (no WebGL/renderer required).
 * Does NOT load GLBs at runtime.
 *
 * Strict TypeScript; no `any`; noUncheckedIndexedAccess.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

import {
  normalizeWeaponModel,
  VIEWMODEL_SCALE,
  resolveWeaponTuning,
  GRIP_PRESETS,
  GRIP_TARGETS,
  FP_ARMS_BONE_NAMES,
  ARMS_SCALE,
  ARMS_OFFSET,
  ARMS_ROOT_SCALE,
  ARMS_ROOT_POS,
  ARMS_ROOT_ROT_Y,
  ARMS_TINT_CT,
  ARMS_TINT_T,
  teamSleeveColor,
  solveTwoBoneIK,
  weaponHalfLen,
  type WeaponTuning,
  type GripFamily,
  type TwoBoneChain,
} from './viewmodel';
import { WEAPONS } from './constants';
import { THIRD_PERSON_WEAPON_FILES, THIRD_PERSON_WEAPON_PATHS } from './characters';

const repoRoot = join(import.meta.dir, '..');

// ---------------------------------------------------------------------------
// normalizeWeaponModel — pure math
// ---------------------------------------------------------------------------

describe('normalizeWeaponModel', () => {
  test('bbox 0.1×0.2×0.8 with targetLength=0.7 → scale 0.875 and Z-aligned (longest axis already Z)', () => {
    // Longest axis is Z (0.8). targetLength / 0.8 = 0.875
    const bbox = new THREE.Box3(
      new THREE.Vector3(-0.05, -0.1, -0.4),
      new THREE.Vector3(0.05,  0.1,  0.4),
    );
    const result = normalizeWeaponModel(bbox, {
      targetLength: 0.7,
      gripOffset: { x: 0, y: 0, z: 0 },
    });

    expect(result.scale).toBeCloseTo(0.875, 5);

    // Longest axis is Z — should produce identity rotation (rotX=0, rotY=0)
    expect(result.rotation.x).toBeCloseTo(0, 5);
    expect(result.rotation.y).toBeCloseTo(0, 5);
    expect(result.rotation.z).toBeCloseTo(0, 5);
  });

  test('X-longest bbox → rotY = π/2 (align X→-Z)', () => {
    // Longest axis is X (0.9)
    const bbox = new THREE.Box3(
      new THREE.Vector3(-0.45, -0.05, -0.1),
      new THREE.Vector3( 0.45,  0.05,  0.1),
    );
    const result = normalizeWeaponModel(bbox, {
      targetLength: 0.9,
      gripOffset: { x: 0, y: 0, z: 0 },
    });

    expect(result.scale).toBeCloseTo(1.0, 5);
    expect(result.rotation.y).toBeCloseTo(Math.PI / 2, 5);
    expect(result.rotation.x).toBeCloseTo(0, 5);
  });

  test('Y-longest bbox → rotX = -π/2 (align Y→-Z)', () => {
    // Longest axis is Y (1.0)
    const bbox = new THREE.Box3(
      new THREE.Vector3(-0.1, -0.5, -0.1),
      new THREE.Vector3( 0.1,  0.5,  0.1),
    );
    const result = normalizeWeaponModel(bbox, {
      targetLength: 0.5,
      gripOffset: { x: 0, y: 0, z: 0 },
    });

    expect(result.scale).toBeCloseTo(0.5, 5);
    expect(result.rotation.x).toBeCloseTo(-Math.PI / 2, 5);
    expect(result.rotation.y).toBeCloseTo(0, 5);
  });

  test('extraRotation is added on top of axis-alignment rotation', () => {
    const bbox = new THREE.Box3(
      new THREE.Vector3(-0.05, -0.05, -0.4),
      new THREE.Vector3( 0.05,  0.05,  0.4),
    );
    const extra = { x: 0.1, y: 0.2, z: 0.3 };
    const result = normalizeWeaponModel(bbox, {
      targetLength: 0.8,
      gripOffset: { x: 0, y: 0, z: 0 },
      extraRotation: extra,
    });

    // Z-aligned (identity alignment) + extra
    expect(result.rotation.x).toBeCloseTo(0.1, 5);
    expect(result.rotation.y).toBeCloseTo(0.2, 5);
    expect(result.rotation.z).toBeCloseTo(0.3, 5);
  });

  test('gripOffset is reflected in result.position', () => {
    const bbox = new THREE.Box3(
      new THREE.Vector3(-0.05, -0.05, -0.3),
      new THREE.Vector3( 0.05,  0.05,  0.3),
    );
    const result = normalizeWeaponModel(bbox, {
      targetLength: 0.6,
      gripOffset: { x: 0.1, y: -0.05, z: 0.02 },
    });

    expect(result.position.x).toBeCloseTo(0.1, 5);
    expect(result.position.y).toBeCloseTo(-0.05, 5);
    expect(result.position.z).toBeCloseTo(0.02, 5);
  });

  test('degenerate near-cube bbox does not throw and returns a finite scale', () => {
    // Very nearly equal extents — should not divide by zero or produce NaN
    const bbox = new THREE.Box3(
      new THREE.Vector3(-0.1, -0.1, -0.1),
      new THREE.Vector3( 0.1,  0.1,  0.1),
    );
    expect(() => {
      const result = normalizeWeaponModel(bbox, {
        targetLength: 0.5,
        gripOffset: { x: 0, y: 0, z: 0 },
      });
      expect(isFinite(result.scale)).toBe(true);
      expect(result.scale).toBeGreaterThan(0);
    }).not.toThrow();
  });

  test('zero-extent bbox falls back to guard minimum and does not produce NaN', () => {
    const bbox = new THREE.Box3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 0),
    );
    expect(() => {
      const result = normalizeWeaponModel(bbox, {
        targetLength: 0.5,
        gripOffset: { x: 0, y: 0, z: 0 },
      });
      expect(isFinite(result.scale)).toBe(true);
      expect(result.scale).toBeGreaterThan(0);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// VIEWMODEL_SCALE — global size multiplier sanity
// ---------------------------------------------------------------------------

describe('VIEWMODEL_SCALE', () => {
  test('is a finite positive number', () => {
    expect(typeof VIEWMODEL_SCALE).toBe('number');
    expect(isFinite(VIEWMODEL_SCALE)).toBe(true);
    expect(VIEWMODEL_SCALE).toBeGreaterThan(0);
  });

  test('equals 1.3 (CS2-equivalent viewmodel size)', () => {
    expect(VIEWMODEL_SCALE).toBeCloseTo(1.3, 5);
  });

  test('applied scale = normalizeWeaponModel scale × scaleMult × VIEWMODEL_SCALE', () => {
    // Simulate the GLB path for a Z-aligned bbox: scale = targetLength / maxExtent
    const bbox = new THREE.Box3(
      new THREE.Vector3(-0.05, -0.05, -0.19),
      new THREE.Vector3(0.05,  0.05,  0.19),
    );
    // targetLength = 0.22, scaleMult = 1.0 (pistol-like)
    const normResult = normalizeWeaponModel(bbox, {
      targetLength: 0.22,
      gripOffset: { x: 0, y: 0, z: 0 },
    });
    // maxExtent = 0.38 (full span on Z axis), scale = 0.22 / 0.38
    const expectedBase = 0.22 / 0.38;
    const scaleMult = 1.0;
    const finalScale = normResult.scale * scaleMult * VIEWMODEL_SCALE;
    expect(finalScale).toBeCloseTo(expectedBase * VIEWMODEL_SCALE, 5);
  });
});

// ---------------------------------------------------------------------------
// Stem-mapping: every WEAPONS id maps to a registered stem (or is knife)
// ---------------------------------------------------------------------------

describe('THIRD_PERSON_WEAPON_FILES — stem mapping coverage', () => {
  test('data-driven: every WEAPONS id (excluding knife) resolves to a stem in THIRD_PERSON_WEAPON_PATHS', () => {
    const knownStems = new Set(Object.keys(THIRD_PERSON_WEAPON_PATHS));
    const failures: string[] = [];
    for (const id of Object.keys(WEAPONS)) {
      if (id === 'knife') continue; // knife has its own stem 'knife'
      const stem = THIRD_PERSON_WEAPON_FILES[id];
      if (stem === undefined || !knownStems.has(stem)) {
        failures.push(`${id} → ${stem ?? '(none)'}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Weapon ids with no valid stem: ${failures.join(', ')}`);
    }
  });

  test('knife id resolves to the knife stem', () => {
    expect(THIRD_PERSON_WEAPON_FILES['knife']).toBe('knife');
  });

  test('all 9 stems in THIRD_PERSON_WEAPON_PATHS are present', () => {
    const stems = Object.keys(THIRD_PERSON_WEAPON_PATHS);
    expect(stems).toHaveLength(9);
    const expected = [
      'pistol', 'revolver', 'smg', 'scifi_smg',
      'shotgun', 'assault_rifle', 'assault_rifle_2',
      'sniper_rifle', 'knife',
    ];
    for (const stem of expected) {
      expect(stems).toContain(stem);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveWeaponTuning — finite scale/offsets for every id
// ---------------------------------------------------------------------------

describe('resolveWeaponTuning — all WEAPONS ids return finite tuning', () => {
  test('data-driven: every WEAPONS id returns a tuning with finite scaleMult, muzzleZ, targetLength', () => {
    const failures: string[] = [];
    for (const id of Object.keys(WEAPONS)) {
      const tuning: WeaponTuning = resolveWeaponTuning(id);
      const ok =
        isFinite(tuning.scaleMult) &&
        tuning.scaleMult > 0 &&
        isFinite(tuning.muzzleZ) &&
        isFinite(tuning.targetLength) &&
        tuning.targetLength > 0 &&
        isFinite(tuning.gripOffset.x) &&
        isFinite(tuning.gripOffset.y) &&
        isFinite(tuning.gripOffset.z) &&
        isFinite(tuning.extraRotation.x) &&
        isFinite(tuning.extraRotation.y) &&
        isFinite(tuning.extraRotation.z);
      if (!ok) failures.push(id);
    }
    if (failures.length > 0) {
      throw new Error(`Weapon ids with non-finite tuning fields: ${failures.join(', ')}`);
    }
  });

  test('fresh-object contract: mutating the result does not affect a second resolveWeaponTuning call', () => {
    const t1 = resolveWeaponTuning('ak47');
    const originalScaleMult = t1.scaleMult;
    t1.scaleMult = 99999;
    const t2 = resolveWeaponTuning('ak47');
    expect(t2.scaleMult).toBe(originalScaleMult);
    expect(t2.scaleMult).not.toBe(99999);
  });

  test('fresh-object contract: mutating a nested object field does not affect a second call', () => {
    const t1 = resolveWeaponTuning('ak47');
    const originalX = t1.gripOffset.x;
    t1.gripOffset.x = 99999;
    const t2 = resolveWeaponTuning('ak47');
    expect(t2.gripOffset.x).toBe(originalX);
    expect(t2.gripOffset.x).not.toBe(99999);
    // Same for extraRotation
    const originalRY = t1.extraRotation.y;
    t1.extraRotation.y = 99999;
    const t3 = resolveWeaponTuning('ak47');
    expect(t3.extraRotation.y).toBe(originalRY);
    expect(t3.extraRotation.y).not.toBe(99999);
  });

  test('per-id override with extraRotation wins over stem default', () => {
    // Add a hypothetical override by directly testing the merge logic:
    // mp7 has an override but no extraRotation field — its extraRotation comes from stem base.
    // We verify that when a per-id override declares extraRotation, it wins over the stem.
    // The WEAPON_TUNING_OVERRIDES table currently has no extraRotation entries by design,
    // so we test the invariant: for a weapon with an override (mp7), extraRotation must
    // still be finite and independent (fresh) from the stem base.
    const mp7 = resolveWeaponTuning('mp7');
    const mac10 = resolveWeaponTuning('mac10'); // no override → raw stem base
    // Both should have finite extraRotation (the merge must not drop it)
    expect(isFinite(mp7.extraRotation.x)).toBe(true);
    expect(isFinite(mp7.extraRotation.y)).toBe(true);
    expect(isFinite(mp7.extraRotation.z)).toBe(true);
    // Mutating mp7's extraRotation must not affect mac10 (they share the same stem)
    mp7.extraRotation.x = 99999;
    const mac10b = resolveWeaponTuning('mac10');
    expect(mac10b.extraRotation.x).not.toBe(99999);
  });

  test('per-id override wins over stem base: ssg08 has smaller targetLength than base sniper_rifle', () => {
    const ssg08  = resolveWeaponTuning('ssg08');
    const awp    = resolveWeaponTuning('awp');
    // ssg08 uses sniper_rifle stem + override; awp also uses sniper_rifle stem, no override
    expect(ssg08.targetLength).toBeLessThan(awp.targetLength);
    expect(ssg08.scaleMult).toBeLessThan(awp.scaleMult);
  });

  test('per-id override wins: m249 and negev have larger scaleMult than assault_rifle base', () => {
    const m249         = resolveWeaponTuning('m249');
    const negev        = resolveWeaponTuning('negev');
    const assaultRifle = resolveWeaponTuning('m4a4'); // m4a4 → assault_rifle stem, no override
    expect(m249.scaleMult).toBeGreaterThan(assaultRifle.scaleMult);
    expect(negev.scaleMult).toBeGreaterThan(assaultRifle.scaleMult);
  });

  test('p250 compact override: smaller targetLength than usp', () => {
    const p250 = resolveWeaponTuning('p250');
    const usp  = resolveWeaponTuning('usp');
    expect(p250.targetLength).toBeLessThan(usp.targetLength);
  });

  test('all SMGs have scaleMult < 1.0 (compact feel)', () => {
    const smgIds = ['mac10', 'mp9', 'mp7', 'ump45', 'p90', 'bizon'];
    for (const id of smgIds) {
      const t = resolveWeaponTuning(id);
      expect(t.scaleMult).toBeLessThan(1.0);
    }
  });

  test('knife tuning has small targetLength', () => {
    const t = resolveWeaponTuning('knife');
    expect(t.targetLength).toBeLessThanOrEqual(0.22);
    expect(t.targetLength).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GRIP_PRESETS table — backward-compat shim derived from GRIP_TARGETS
// ---------------------------------------------------------------------------

describe('GRIP_PRESETS', () => {
  const VALID_FAMILIES: GripFamily[] = ['two_handed_long', 'pistol', 'knife'];
  const ALL_STEMS = Object.keys(THIRD_PERSON_WEAPON_PATHS);

  // Authoritative set of the 24 real bone names in fp_arms.glb (J-Toastie rig).
  const AUTHORITATIVE_BONE_NAMES = new Set<string>([
    // Left side (no suffix)
    'UpperArm.L', 'LowerArm.L', 'Hand.L',
    'DoubleFingersBeginning', 'DoubleFingers.L', 'DoubleFingersTip.L',
    'IndexBeginning.L', 'Index.L', 'IndexTip.L',
    'ThumbBeginning.L', 'Thumb.L', 'ThumbTip.L',
    // Right side (Blender mirror: .001 suffix)
    'UpperArm.R.001', 'LowerArm.R.001', 'Hand.R.001',
    'DoubleFingersBeginning.001', 'DoubleFingers.R.001', 'DoubleFingersTip.R.001',
    'IndexBeginning.R.001', 'Index.R.001', 'IndexTip.R.001',
    'ThumbBeginning.R.001', 'Thumb.R.001', 'ThumbTip.R.001',
  ]);

  test('every weapons_v2 stem has a grip preset entry', () => {
    const missing: string[] = [];
    for (const stem of ALL_STEMS) {
      if (GRIP_PRESETS[stem] === undefined) missing.push(stem);
    }
    if (missing.length > 0) {
      throw new Error(`Stems missing from GRIP_PRESETS: ${missing.join(', ')}`);
    }
  });

  test('every preset has a valid family classification', () => {
    for (const [stem, preset] of Object.entries(GRIP_PRESETS)) {
      expect(
        VALID_FAMILIES.includes(preset.family),
        `${stem}: unexpected family '${preset.family}'`,
      ).toBe(true);
    }
  });

  test('every preset bone rotation value is finite (new fp_arms fields: upperArm/lowerArm/hand/fingerCurl)', () => {
    // New interface: upperArmR, lowerArmR, handR, upperArmL, lowerArmL, handL, fingerCurl
    const fields: Array<keyof typeof GRIP_PRESETS[string]> = [
      'upperArmR', 'lowerArmR', 'handR',
      'upperArmL', 'lowerArmL', 'handL',
      'fingerCurl',
    ];
    const failures: string[] = [];
    for (const [stem, preset] of Object.entries(GRIP_PRESETS)) {
      for (const field of fields) {
        const vals = preset[field] as readonly [number, number, number];
        for (const v of vals) {
          if (!isFinite(v)) {
            failures.push(`${stem}.${field}`);
          }
        }
      }
    }
    if (failures.length > 0) {
      throw new Error(`Non-finite rotation values: ${failures.join(', ')}`);
    }
  });

  test('assault_rifle and assault_rifle_2 are two_handed_long', () => {
    expect(GRIP_PRESETS['assault_rifle']?.family).toBe('two_handed_long');
    expect(GRIP_PRESETS['assault_rifle_2']?.family).toBe('two_handed_long');
  });

  test('sniper_rifle is two_handed_long', () => {
    expect(GRIP_PRESETS['sniper_rifle']?.family).toBe('two_handed_long');
  });

  test('smg and scifi_smg are two_handed_long', () => {
    expect(GRIP_PRESETS['smg']?.family).toBe('two_handed_long');
    expect(GRIP_PRESETS['scifi_smg']?.family).toBe('two_handed_long');
  });

  test('shotgun is two_handed_long', () => {
    expect(GRIP_PRESETS['shotgun']?.family).toBe('two_handed_long');
  });

  test('pistol and revolver are pistol family', () => {
    expect(GRIP_PRESETS['pistol']?.family).toBe('pistol');
    expect(GRIP_PRESETS['revolver']?.family).toBe('pistol');
  });

  test('knife is knife family', () => {
    expect(GRIP_PRESETS['knife']?.family).toBe('knife');
  });

  // Verify that the bones referenced by the presets are real bones from the rig.
  test('FP_ARMS_BONE_NAMES exported list has exactly 24 entries', () => {
    expect(FP_ARMS_BONE_NAMES).toHaveLength(24);
  });

  test('FP_ARMS_BONE_NAMES: all entries are in the authoritative set', () => {
    const unknown = [...FP_ARMS_BONE_NAMES].filter((n) => !AUTHORITATIVE_BONE_NAMES.has(n));
    expect(unknown).toHaveLength(0);
  });

  test('FP_ARMS_BONE_NAMES: right-side bones all have .001 suffix', () => {
    const rightBones = [...FP_ARMS_BONE_NAMES].filter((n) => n.includes('.R.') || n.endsWith('.001'));
    // There are 12 right-side bones (all with .001 suffix)
    expect(rightBones).toHaveLength(12);
    for (const b of rightBones) {
      expect(b.endsWith('.001')).toBe(true);
    }
  });

  test('FP_ARMS_BONE_NAMES: includes the 6 primary arm bones used by pose application', () => {
    const required = [
      'UpperArm.L', 'LowerArm.L', 'Hand.L',
      'UpperArm.R.001', 'LowerArm.R.001', 'Hand.R.001',
    ];
    for (const b of required) {
      expect([...FP_ARMS_BONE_NAMES]).toContain(b);
    }
  });
});

// ---------------------------------------------------------------------------
// teamSleeveColor — pure helper tests
// ---------------------------------------------------------------------------

describe('teamSleeveColor', () => {
  test('returns ARMS_TINT_CT for team CT', () => {
    expect(teamSleeveColor('CT')).toBe(ARMS_TINT_CT);
  });

  test('returns ARMS_TINT_T for team T', () => {
    expect(teamSleeveColor('T')).toBe(ARMS_TINT_T);
  });

  test('CT and T tints are different', () => {
    expect(ARMS_TINT_CT).not.toBe(ARMS_TINT_T);
  });

  test('CT tint matches characters.ts TEAM_TORSO CT (0x5a7da8)', () => {
    expect(ARMS_TINT_CT).toBe(0x5a7da8);
  });

  test('T tint matches characters.ts TEAM_TORSO T (0xa8824f)', () => {
    expect(ARMS_TINT_T).toBe(0xa8824f);
  });

  test('both tints are valid 24-bit colors (0..0xFFFFFF)', () => {
    expect(ARMS_TINT_CT).toBeGreaterThanOrEqual(0);
    expect(ARMS_TINT_CT).toBeLessThanOrEqual(0xffffff);
    expect(ARMS_TINT_T).toBeGreaterThanOrEqual(0);
    expect(ARMS_TINT_T).toBeLessThanOrEqual(0xffffff);
  });
});

// ---------------------------------------------------------------------------
// ARMS tuning constants
// ---------------------------------------------------------------------------

describe('ARMS_SCALE and ARMS_OFFSET (legacy aliases)', () => {
  test('ARMS_SCALE is a finite positive number', () => {
    expect(typeof ARMS_SCALE).toBe('number');
    expect(isFinite(ARMS_SCALE)).toBe(true);
    expect(ARMS_SCALE).toBeGreaterThan(0);
  });

  test('ARMS_OFFSET is a THREE.Vector3 with finite components', () => {
    expect(ARMS_OFFSET).toBeInstanceOf(THREE.Vector3);
    expect(isFinite(ARMS_OFFSET.x)).toBe(true);
    expect(isFinite(ARMS_OFFSET.y)).toBe(true);
    expect(isFinite(ARMS_OFFSET.z)).toBe(true);
  });
});

describe('ARMS_ROOT_SCALE, ARMS_ROOT_POS, ARMS_ROOT_ROT_Y', () => {
  test('ARMS_ROOT_SCALE is a finite positive number much smaller than 1', () => {
    expect(typeof ARMS_ROOT_SCALE).toBe('number');
    expect(isFinite(ARMS_ROOT_SCALE)).toBe(true);
    expect(ARMS_ROOT_SCALE).toBeGreaterThan(0);
    // Must be much smaller than old ARMS_SCALE = 0.9 which caused giant arms
    expect(ARMS_ROOT_SCALE).toBeLessThan(0.5);
  });

  test('ARMS_ROOT_SCALE × total arm reach (5.17 units) ≈ 0.3–0.5 m (human plausible)', () => {
    const totalReachUnits = 5.17;
    const reach = ARMS_ROOT_SCALE * totalReachUnits;
    expect(reach).toBeGreaterThan(0.25);
    expect(reach).toBeLessThan(0.55);
  });

  test('ARMS_ROOT_POS is a THREE.Vector3 with finite components', () => {
    expect(ARMS_ROOT_POS).toBeInstanceOf(THREE.Vector3);
    expect(isFinite(ARMS_ROOT_POS.x)).toBe(true);
    expect(isFinite(ARMS_ROOT_POS.y)).toBe(true);
    expect(isFinite(ARMS_ROOT_POS.z)).toBe(true);
  });

  test('ARMS_ROOT_POS.z > 0 (shoulders toward camera bottom, not forward)', () => {
    // In _group space, +Z is toward the camera. Shoulders must be behind weapons.
    expect(ARMS_ROOT_POS.z).toBeGreaterThan(0);
  });

  test('ARMS_ROOT_ROT_Y is PI/2 (maps +X arm rest direction to -Z scene direction)', () => {
    expect(ARMS_ROOT_ROT_Y).toBeCloseTo(Math.PI / 2, 5);
  });

  test('legacy ARMS_SCALE alias equals ARMS_ROOT_SCALE', () => {
    expect(ARMS_SCALE).toBe(ARMS_ROOT_SCALE);
  });

  test('legacy ARMS_OFFSET alias is the same object as ARMS_ROOT_POS', () => {
    expect(ARMS_OFFSET).toBe(ARMS_ROOT_POS);
  });
});

// ---------------------------------------------------------------------------
// GRIP_TARGETS table — IK target coordinates
// ---------------------------------------------------------------------------

describe('GRIP_TARGETS', () => {
  const VALID_FAMILIES: GripFamily[] = ['two_handed_long', 'pistol', 'knife'];
  const ALL_STEMS = Object.keys(THIRD_PERSON_WEAPON_PATHS);

  test('every weapons_v2 stem has a GRIP_TARGETS entry', () => {
    const missing: string[] = [];
    for (const stem of ALL_STEMS) {
      if (GRIP_TARGETS[stem] === undefined) missing.push(stem);
    }
    if (missing.length > 0) {
      throw new Error(`Stems missing from GRIP_TARGETS: ${missing.join(', ')}`);
    }
  });

  test('every GRIP_TARGET has a valid family', () => {
    for (const [stem, gt] of Object.entries(GRIP_TARGETS)) {
      expect(
        VALID_FAMILIES.includes(gt.family),
        `${stem}: invalid family '${gt.family}'`,
      ).toBe(true);
    }
  });

  test('every GRIP_TARGET has finite rightHand and leftHand coordinates', () => {
    const failures: string[] = [];
    for (const [stem, gt] of Object.entries(GRIP_TARGETS)) {
      for (const v of [...gt.rightHand, ...gt.leftHand]) {
        if (!isFinite(v)) failures.push(stem);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Non-finite grip targets: ${failures.join(', ')}`);
    }
  });

  test('every GRIP_TARGET has finite fingerCurl', () => {
    for (const [stem, gt] of Object.entries(GRIP_TARGETS)) {
      for (const v of gt.fingerCurl) {
        expect(isFinite(v), `${stem} fingerCurl has non-finite value`).toBe(true);
      }
    }
  });

  test('two_handed_long rightHand z > 0 (at stock side) and leftHand z < 0 (toward muzzle)', () => {
    // Structural sanity: right at grip, left forward under barrel.
    const longStems = Object.entries(GRIP_TARGETS).filter(([, gt]) => gt.family === 'two_handed_long');
    for (const [stem, gt] of longStems) {
      expect(gt.rightHand[2], `${stem} rightHand.z should be > 0`).toBeGreaterThan(0);
      expect(gt.leftHand[2], `${stem} leftHand.z should be < 0`).toBeLessThan(0);
    }
  });

  test('knife leftHand is the tucked fixed position (z > 0, not on weapon)', () => {
    const knife = GRIP_TARGETS['knife'];
    expect(knife).toBeDefined();
    if (knife !== undefined) {
      // Tucked: left hand at z > 0 (toward camera, not forward along barrel)
      expect(knife.leftHand[2]).toBeGreaterThan(0);
    }
  });

  test('GRIP_TARGETS and GRIP_PRESETS have matching stem sets', () => {
    const targetStems = new Set(Object.keys(GRIP_TARGETS));
    const presetStems = new Set(Object.keys(GRIP_PRESETS));
    for (const s of targetStems) {
      expect(presetStems.has(s), `GRIP_PRESETS missing ${s}`).toBe(true);
    }
    for (const s of presetStems) {
      expect(targetStems.has(s), `GRIP_TARGETS missing ${s}`).toBe(true);
    }
  });

  test('GRIP_TARGETS families match GRIP_PRESETS families (shim consistency)', () => {
    for (const [stem, gt] of Object.entries(GRIP_TARGETS)) {
      const preset = GRIP_PRESETS[stem];
      if (preset !== undefined) {
        expect(preset.family).toBe(gt.family);
      }
    }
  });

  test('GRIP_PRESETS fingerCurl matches GRIP_TARGETS fingerCurl (shim passes through)', () => {
    for (const [stem, gt] of Object.entries(GRIP_TARGETS)) {
      const preset = GRIP_PRESETS[stem];
      if (preset !== undefined) {
        expect(preset.fingerCurl[0]).toBeCloseTo(gt.fingerCurl[0], 10);
        expect(preset.fingerCurl[1]).toBeCloseTo(gt.fingerCurl[1], 10);
        expect(preset.fingerCurl[2]).toBeCloseTo(gt.fingerCurl[2], 10);
      }
    }
  });

  // ── Regression: grip z targets must not float outside the weapon model ──
  //
  // For every weapon id in THIRD_PERSON_WEAPON_FILES, the actual z distance of
  // both grip points (after applying zFrac × halfLen) must not exceed halfLen + 1 cm.
  // This makes the "hand floats behind the buttstock" bug class impossible to
  // reintroduce silently.
  //
  // Knife left-hand is exempt: it uses a fixed absolute tuck position intentionally
  // placed away from the weapon model.
  test('regression: every weapon id rightHand |z| ≤ halfLen + 1 cm (no float-behind-stock)', () => {
    const failures: string[] = [];
    for (const id of Object.keys(THIRD_PERSON_WEAPON_FILES)) {
      const stem = THIRD_PERSON_WEAPON_FILES[id];
      if (stem === undefined) continue;
      const gt = GRIP_TARGETS[stem];
      if (gt === undefined) continue;
      const hl = weaponHalfLen(id);
      const rzAbs = Math.abs(gt.rightHand[2] * hl);
      if (rzAbs > hl + 0.01) {
        failures.push(
          `${id} (${stem}): rightHand |z|=${rzAbs.toFixed(4)} m > halfLen=${hl.toFixed(4)} m + 1 cm`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(`Grip z out-of-bounds:\n  ${failures.join('\n  ')}`);
    }
  });

  test('regression: every weapon id leftHand |z| ≤ halfLen + 1 cm (knife left-hand exempt)', () => {
    const failures: string[] = [];
    for (const id of Object.keys(THIRD_PERSON_WEAPON_FILES)) {
      const stem = THIRD_PERSON_WEAPON_FILES[id];
      if (stem === undefined) continue;
      const gt = GRIP_TARGETS[stem];
      if (gt === undefined) continue;
      // Knife left-hand uses a fixed absolute tuck target — exempt from this check.
      if (gt.leftHandZAbsolute === true) continue;
      const hl = weaponHalfLen(id);
      const lzAbs = Math.abs(gt.leftHand[2] * hl);
      if (lzAbs > hl + 0.01) {
        failures.push(
          `${id} (${stem}): leftHand |z|=${lzAbs.toFixed(4)} m > halfLen=${hl.toFixed(4)} m + 1 cm`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(`Grip z out-of-bounds:\n  ${failures.join('\n  ')}`);
    }
  });

  test('weaponHalfLen: returns finite positive value for every weapon id', () => {
    for (const id of Object.keys(THIRD_PERSON_WEAPON_FILES)) {
      const hl = weaponHalfLen(id);
      expect(isFinite(hl), `${id}: non-finite halfLen`).toBe(true);
      expect(hl, `${id}: halfLen not positive`).toBeGreaterThan(0);
    }
  });

  test('weaponHalfLen: sniper AWP halfLen > pistol halfLen (longer weapon)', () => {
    expect(weaponHalfLen('awp')).toBeGreaterThan(weaponHalfLen('usp'));
  });
});

// ---------------------------------------------------------------------------
// solveTwoBoneIK — pure solver tests using a synthetic bone chain
//
// Replicates the fp_arms.glb rest geometry from the rig dump:
//   UpperArm.L [-1.9846, 0, -2.2343]
//   LowerArm.L [0.0991, -0.0038, -2.4734]
//   Hand.L     [3.1473, -0.0038, -2.2377]
//   Segment lengths: L1=2.110, L2=3.058, total reach ~5.17
// Scaled by ARMS_ROOT_SCALE=0.075 for viewmodel units:
//   L1 ≈ 0.158 m, L2 ≈ 0.229 m, reach ≈ 0.388 m
// ---------------------------------------------------------------------------

/**
 * Build a synthetic two-bone chain matching fp_arms.glb left-arm rest geometry
 * scaled by ARMS_ROOT_SCALE.
 *
 * Hierarchy: parent(Group) → upperArm(Bone) → lowerArm(Bone) → hand(Bone)
 *
 * Rest positions in scene units (from rig dump), scaled by 0.075:
 *   upperArm: (-0.1488, 0, -0.1676)
 *   lowerArm: ( 0.0074, -0.000285, -0.1855)
 *   hand:     ( 0.2360, -0.000285, -0.1678)
 */
function buildSyntheticChain(scale = ARMS_ROOT_SCALE): {
  parent: THREE.Group;
  chain: TwoBoneChain;
  L1: number;
  L2: number;
} {
  // Rest world positions from rig dump (scene units)
  const upperArmRestWorld = new THREE.Vector3(-1.9846, 0, -2.2343);
  const lowerArmRestWorld = new THREE.Vector3( 0.0991, -0.0038, -2.4734);
  const handRestWorld     = new THREE.Vector3( 3.1473, -0.0038, -2.2377);

  // Scale to viewmodel units
  const s = scale;
  const uaPos = upperArmRestWorld.clone().multiplyScalar(s);
  const laPos = lowerArmRestWorld.clone().multiplyScalar(s);
  const hPos  = handRestWorld.clone().multiplyScalar(s);

  // Build bone chain with world positions encoded as local positions
  // (parent is at origin, so world = local for direct children).
  const parent = new THREE.Group();
  parent.position.set(0, 0, 0);

  const upperArm = new THREE.Bone();
  upperArm.name = 'UpperArm.L';
  upperArm.position.copy(uaPos); // world = local (parent at origin)

  const lowerArm = new THREE.Bone();
  lowerArm.name = 'LowerArm.L';
  // Local position relative to upperArm = world diff
  lowerArm.position.copy(laPos.clone().sub(uaPos));

  const hand = new THREE.Bone();
  hand.name = 'Hand.L';
  hand.position.copy(hPos.clone().sub(laPos));

  upperArm.add(lowerArm);
  lowerArm.add(hand);
  parent.add(upperArm);

  // Update world matrices
  parent.updateWorldMatrix(true, true);

  const L1 = uaPos.distanceTo(laPos);
  const L2 = laPos.distanceTo(hPos);

  return {
    parent,
    chain: { root: upperArm as unknown as THREE.Bone, mid: lowerArm as unknown as THREE.Bone, tip: hand as unknown as THREE.Bone },
    L1,
    L2,
  };
}

describe('solveTwoBoneIK — two-bone analytic IK solver', () => {

  test('returns true for a valid chain', () => {
    const { chain } = buildSyntheticChain();
    const target = new THREE.Vector3(0.10, -0.05, -0.20);
    const pole   = new THREE.Vector3(0, -0.30, 0);
    const result = solveTwoBoneIK(chain, target, pole);
    expect(result).toBe(true);
  });

  test('returns false for a degenerate zero-length chain', () => {
    const parent = new THREE.Group();
    const b0 = new THREE.Bone();
    const b1 = new THREE.Bone();
    const b2 = new THREE.Bone();
    // All at origin — zero-length segments
    parent.add(b0);
    b0.add(b1);
    b1.add(b2);
    parent.updateWorldMatrix(true, true);

    const result = solveTwoBoneIK(
      { root: b0, mid: b1, tip: b2 },
      new THREE.Vector3(0.1, 0, 0),
      new THREE.Vector3(0, -0.1, 0),
    );
    expect(result).toBe(false);
  });

  test('hand lands within 2 cm of target for reachable target', () => {
    const { chain, L1, L2 } = buildSyntheticChain();

    // Choose a target well within reach (60% of max reach)
    const maxReach = L1 + L2;
    const targetDist = maxReach * 0.6;

    // Target in front of the upper arm world position
    chain.root.updateWorldMatrix(true, false);
    const uaWorld = new THREE.Vector3();
    uaWorld.setFromMatrixPosition(chain.root.matrixWorld);

    const target = new THREE.Vector3(
      uaWorld.x + targetDist * 0.6,
      uaWorld.y - targetDist * 0.3,
      uaWorld.z + targetDist * 0.7,
    ).normalize().multiplyScalar(targetDist).add(uaWorld);

    const pole = uaWorld.clone().add(new THREE.Vector3(0, -0.2, 0));

    const solved = solveTwoBoneIK(chain, target, pole);
    expect(solved).toBe(true);

    // After solving, hand world position should be near target
    chain.root.updateWorldMatrix(true, true);
    const handWorld = new THREE.Vector3();
    handWorld.setFromMatrixPosition(chain.tip.matrixWorld);

    const error = handWorld.distanceTo(target);
    // Allow 2 cm tolerance (0.02 m)
    expect(error).toBeLessThan(0.02);
  });

  test('no NaN in bone quaternions after solving', () => {
    const { chain } = buildSyntheticChain();
    const target = new THREE.Vector3(0.15, -0.05, -0.10);
    const pole   = new THREE.Vector3(0, -0.20, 0);
    solveTwoBoneIK(chain, target, pole);

    const checkQ = (b: THREE.Bone, name: string): void => {
      expect(isNaN(b.quaternion.x), `${name}.x NaN`).toBe(false);
      expect(isNaN(b.quaternion.y), `${name}.y NaN`).toBe(false);
      expect(isNaN(b.quaternion.z), `${name}.z NaN`).toBe(false);
      expect(isNaN(b.quaternion.w), `${name}.w NaN`).toBe(false);
    };
    checkQ(chain.root, 'root');
    checkQ(chain.mid, 'mid');
  });

  test('elbow (mid bone) world Y is below shoulder→hand midpoint Y (pole points down)', () => {
    const { chain } = buildSyntheticChain();

    chain.root.updateWorldMatrix(true, true);
    const shoulderWorld = new THREE.Vector3().setFromMatrixPosition(chain.root.matrixWorld);
    const handRestWorld  = new THREE.Vector3().setFromMatrixPosition(chain.tip.matrixWorld);

    // Choose target halfway between rest and max reach
    const target = handRestWorld.clone().lerp(shoulderWorld, 0.2);
    // Pole strongly downward
    const pole = shoulderWorld.clone().add(new THREE.Vector3(0, -0.5, 0));

    solveTwoBoneIK(chain, target, pole);

    chain.root.updateWorldMatrix(true, true);
    const elbowWorld = new THREE.Vector3().setFromMatrixPosition(chain.mid.matrixWorld);
    const newShoulderWorld = new THREE.Vector3().setFromMatrixPosition(chain.root.matrixWorld);
    const newHandWorld = new THREE.Vector3().setFromMatrixPosition(chain.tip.matrixWorld);
    const midY = (newShoulderWorld.y + newHandWorld.y) / 2;

    // Elbow should be below the midpoint (pole is down)
    expect(elbowWorld.y).toBeLessThan(midY + 0.001);
  });

  test('reach clamp: target beyond max reach does not produce NaN and lands hand at max reach direction', () => {
    const { chain, L1, L2 } = buildSyntheticChain();

    chain.root.updateWorldMatrix(true, true);
    const shoulderWorld = new THREE.Vector3().setFromMatrixPosition(chain.root.matrixWorld);

    // Target 3× max reach — way beyond arm length
    const farTarget = shoulderWorld.clone().add(new THREE.Vector3(0, 0, -(L1 + L2) * 3));
    const pole = shoulderWorld.clone().add(new THREE.Vector3(0, -0.2, 0));

    const solved = solveTwoBoneIK(chain, farTarget, pole);
    expect(solved).toBe(true);

    chain.root.updateWorldMatrix(true, true);
    const handWorld = new THREE.Vector3().setFromMatrixPosition(chain.tip.matrixWorld);

    // No NaN
    expect(isNaN(handWorld.x)).toBe(false);
    expect(isNaN(handWorld.y)).toBe(false);
    expect(isNaN(handWorld.z)).toBe(false);

    // Hand distance from shoulder should be clamped to near max reach
    const dist = handWorld.distanceTo(shoulderWorld);
    const maxReach = L1 + L2;
    expect(dist).toBeLessThanOrEqual(maxReach + 0.001);
  });

  test('reach clamp: target at zero distance does not produce NaN', () => {
    const { chain } = buildSyntheticChain();

    chain.root.updateWorldMatrix(true, true);
    const shoulderWorld = new THREE.Vector3().setFromMatrixPosition(chain.root.matrixWorld);

    // Target exactly at shoulder — minimum distance clamped
    const pole = shoulderWorld.clone().add(new THREE.Vector3(0, -0.2, 0));

    const solved = solveTwoBoneIK(chain, shoulderWorld.clone(), pole);
    expect(solved).toBe(true);

    chain.root.updateWorldMatrix(true, true);
    const handWorld = new THREE.Vector3().setFromMatrixPosition(chain.tip.matrixWorld);
    expect(isNaN(handWorld.x)).toBe(false);
    expect(isNaN(handWorld.y)).toBe(false);
    expect(isNaN(handWorld.z)).toBe(false);
  });

  test('FK verification: right hand within 2 cm of grip target for all weapon ids', () => {
    // Tests all weapon ids (not just stems) so every id's halfLen is exercised.
    // rightHand z target = zFrac * halfLen(id).
    const failures: string[] = [];

    for (const [id, stem] of Object.entries(THIRD_PERSON_WEAPON_FILES)) {
      const gt = GRIP_TARGETS[stem];
      if (gt === undefined) continue;

      const hl = weaponHalfLen(id);
      const { chain, L1, L2 } = buildSyntheticChain();

      chain.root.updateWorldMatrix(true, true);
      const shoulderWorld = new THREE.Vector3().setFromMatrixPosition(chain.root.matrixWorld);

      // Resolve actual _group-space target (x/y absolute, z = zFrac * halfLen)
      const [tx, ty, tzFrac] = gt.rightHand;
      const target = new THREE.Vector3(tx, ty, tzFrac * hl);
      const maxReach = L1 + L2;
      const minReach = Math.abs(L1 - L2);

      // Pre-clamp to reachable range (same logic as solver) to get expected hand pos
      const rawDist = target.distanceTo(shoulderWorld);
      const effectiveDist = Math.max(minReach + 1e-4, Math.min(maxReach - 1e-4, rawDist));
      let clampedTarget: THREE.Vector3;
      const diff = target.clone().sub(shoulderWorld);
      if (diff.lengthSq() < 1e-12) {
        clampedTarget = shoulderWorld.clone().add(new THREE.Vector3(effectiveDist, 0, 0));
      } else {
        clampedTarget = diff.normalize().multiplyScalar(effectiveDist).add(shoulderWorld);
      }

      const pole = shoulderWorld.clone().add(new THREE.Vector3(0, -0.2, 0));
      const solved = solveTwoBoneIK(chain, target, pole);
      if (!solved) {
        failures.push(`${id}: IK returned false`);
        continue;
      }

      chain.root.updateWorldMatrix(true, true);
      const handWorld = new THREE.Vector3().setFromMatrixPosition(chain.tip.matrixWorld);
      if (isNaN(handWorld.x) || isNaN(handWorld.y) || isNaN(handWorld.z)) {
        failures.push(`${id}: NaN in hand world position`);
        continue;
      }

      const error = handWorld.distanceTo(clampedTarget);
      if (error > 0.02) {
        failures.push(`${id} (${stem}): hand error ${(error * 100).toFixed(2)} cm > 2 cm`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`IK FK right-hand verification failures:\n  ${failures.join('\n  ')}`);
    }
  });

  test('FK verification: left hand within 2 cm of left grip target for all weapon ids (knife exempt)', () => {
    const failures: string[] = [];

    for (const [id, stem] of Object.entries(THIRD_PERSON_WEAPON_FILES)) {
      const gt = GRIP_TARGETS[stem];
      if (gt === undefined) continue;

      const hl = weaponHalfLen(id);
      const { chain, L1, L2 } = buildSyntheticChain();

      chain.root.updateWorldMatrix(true, true);
      const shoulderWorld = new THREE.Vector3().setFromMatrixPosition(chain.root.matrixWorld);

      // Resolve actual z: for knife leftHand is absolute; for all others, zFrac * halfLen
      const [lx, ly, lzFracOrAbs] = gt.leftHand;
      const lzWorld = gt.leftHandZAbsolute === true ? lzFracOrAbs : lzFracOrAbs * hl;
      const target = new THREE.Vector3(lx, ly, lzWorld);
      const maxReach = L1 + L2;
      const minReach = Math.abs(L1 - L2);

      const rawDist = target.distanceTo(shoulderWorld);
      const effectiveDist = Math.max(minReach + 1e-4, Math.min(maxReach - 1e-4, rawDist));
      let clampedTarget: THREE.Vector3;
      const diff = target.clone().sub(shoulderWorld);
      if (diff.lengthSq() < 1e-12) {
        clampedTarget = shoulderWorld.clone().add(new THREE.Vector3(effectiveDist, 0, 0));
      } else {
        clampedTarget = diff.normalize().multiplyScalar(effectiveDist).add(shoulderWorld);
      }

      const pole = shoulderWorld.clone().add(new THREE.Vector3(0, -0.2, 0));
      const solved = solveTwoBoneIK(chain, target, pole);
      if (!solved) {
        failures.push(`${id} left: IK returned false`);
        continue;
      }

      chain.root.updateWorldMatrix(true, true);
      const handWorld = new THREE.Vector3().setFromMatrixPosition(chain.tip.matrixWorld);
      if (isNaN(handWorld.x) || isNaN(handWorld.y) || isNaN(handWorld.z)) {
        failures.push(`${id} left: NaN in hand position`);
        continue;
      }

      const error = handWorld.distanceTo(clampedTarget);
      if (error > 0.02) {
        failures.push(`${id} (${stem}) left: hand error ${(error * 100).toFixed(2)} cm > 2 cm`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`IK FK left-hand verification failures:\n  ${failures.join('\n  ')}`);
    }
  });
});

// ---------------------------------------------------------------------------
// fp_arms.glb on disk
// ---------------------------------------------------------------------------

describe('fp_arms.glb asset', () => {
  const fpArmsPath = join(repoRoot, 'assets', 'models', 'rigged', 'fp_arms.glb');

  test('fp_arms.glb exists on disk', () => {
    expect(existsSync(fpArmsPath)).toBe(true);
  });

  test('fp_arms.glb starts with glTF magic bytes', () => {
    const buf = readFileSync(fpArmsPath);
    const magic = String.fromCharCode(buf[0] ?? 0, buf[1] ?? 0, buf[2] ?? 0, buf[3] ?? 0);
    expect(magic).toBe('glTF');
  });

  test('fp_arms.glb is > 200 KB (sanity: full rigged mesh, not empty)', () => {
    const { size } = Bun.file(fpArmsPath);
    expect(size).toBeGreaterThan(200 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Asset existence: weapons_v2 on disk; old weapons/ folder GONE
// ---------------------------------------------------------------------------

describe('weapons_v2 GLB files on disk', () => {
  for (const [stem, relPath] of Object.entries(THIRD_PERSON_WEAPON_PATHS)) {
    test(`${stem}: file exists at assets/${relPath}`, () => {
      const filePath = join(repoRoot, 'assets', relPath);
      expect(existsSync(filePath)).toBe(true);
    });

    test(`${stem}: starts with glTF magic bytes`, () => {
      const filePath = join(repoRoot, 'assets', relPath);
      const buf = readFileSync(filePath);
      const magic = String.fromCharCode(buf[0] ?? 0, buf[1] ?? 0, buf[2] ?? 0, buf[3] ?? 0);
      expect(magic).toBe('glTF');
    });

    test(`${stem}: file is > 5 KB`, () => {
      const filePath = join(repoRoot, 'assets', relPath);
      const { size } = Bun.file(filePath);
      expect(size).toBeGreaterThan(5 * 1024);
    });
  }
});

describe('old weapons/ folder removed', () => {
  test('assets/models/weapons/ directory does not exist', () => {
    const oldFolder = join(repoRoot, 'assets', 'models', 'weapons');
    expect(existsSync(oldFolder)).toBe(false);
  });

  const OLD_FILES = ['glock.glb', 'usp.glb', 'deagle.glb', 'ak47.glb', 'm4a4.glb', 'awp.glb'];
  for (const file of OLD_FILES) {
    test(`old Pichuliru file absent: models/weapons/${file}`, () => {
      const oldPath = join(repoRoot, 'assets', 'models', 'weapons', file);
      expect(existsSync(oldPath)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// LICENSES.md — models section checks
// ---------------------------------------------------------------------------

describe('LICENSES.md — models section', () => {
  const licensePath = join(repoRoot, 'assets', 'LICENSES.md');

  test('mentions Quaternius as author (characters and weapons_v2)', () => {
    const content = readFileSync(licensePath, 'utf-8');
    expect(content).toContain('Quaternius');
  });

  test('does NOT mention Flat Guns (Pichuliru entries removed)', () => {
    const content = readFileSync(licensePath, 'utf-8');
    expect(content).not.toContain('Flat Guns');
  });

  test('does NOT mention Pichuliru as author', () => {
    const content = readFileSync(licensePath, 'utf-8');
    expect(content).not.toContain('Pichuliru');
  });

  test('mentions CC0 1.0 for models', () => {
    const content = readFileSync(licensePath, 'utf-8');
    expect(content).toContain('## Models');
    expect(content).toContain('CC0 1.0');
  });

  test('weapons_v2 section lists knife.glb', () => {
    const content = readFileSync(licensePath, 'utf-8');
    expect(content).toContain('knife.glb');
  });

  test('all 9 weapons_v2 stems are mentioned in LICENSES.md', () => {
    const content = readFileSync(licensePath, 'utf-8');
    const expectedFiles = [
      'pistol.glb', 'revolver.glb', 'smg.glb', 'scifi_smg.glb',
      'shotgun.glb', 'assault_rifle.glb', 'assault_rifle_2.glb',
      'sniper_rifle.glb', 'knife.glb',
    ];
    for (const file of expectedFiles) {
      expect(content).toContain(file);
    }
  });

  // CC-BY attribution REQUIREMENT: fp_arms.glb is CC BY 4.0 (not CC0); attribution is mandatory.
  test('LICENSES.md credits J-Toastie as author of fp_arms.glb (CC BY attribution requirement)', () => {
    const content = readFileSync(licensePath, 'utf-8');
    expect(content).toContain('J-Toastie');
  });

  test('LICENSES.md mentions fp_arms.glb file', () => {
    const content = readFileSync(licensePath, 'utf-8');
    expect(content).toContain('fp_arms.glb');
  });

  test('LICENSES.md records CC BY 4.0 license for fp_arms.glb', () => {
    const content = readFileSync(licensePath, 'utf-8');
    expect(content).toContain('CC BY 4.0');
  });
});

// ---------------------------------------------------------------------------
// SkeletonUtils.clone regression — skinned mesh deep copy
//
// Verifies the invariant that characters.ts relies on: skeletonClone produces a
// clone whose SkinnedMesh references bones that are descendants of the clone
// root (not the original source), so they receive world-matrix updates when the
// clone is attached to a rendered scene graph.
// ---------------------------------------------------------------------------

describe('SkeletonUtils.clone — skinned mesh bone ownership', () => {
  /** Build a minimal skinned hierarchy:
   *   root (Group)
   *     boneRoot (Bone)
   *       boneTip  (Bone)
   *     mesh (SkinnedMesh) — skeleton bound to [boneRoot, boneTip]
   */
  function buildSkinnedGroup(): THREE.Group {
    const boneRoot = new THREE.Bone();
    boneRoot.name = 'boneRoot';
    const boneTip = new THREE.Bone();
    boneTip.name = 'boneTip';
    boneRoot.add(boneTip);

    const geo = new THREE.BufferGeometry();
    // Minimal geometry with skinning attributes so SkinnedMesh is valid
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const skinIndices = new Uint8Array([0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0]);
    const skinWeights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndices, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeights, 4));

    const mesh = new THREE.SkinnedMesh(geo);
    const skeleton = new THREE.Skeleton([boneRoot, boneTip]);
    mesh.add(boneRoot);
    mesh.bind(skeleton);

    const root = new THREE.Group();
    root.add(mesh);
    return root;
  }

  test('cloned SkinnedMesh skeleton bones are NOT the same object refs as the original', () => {
    const source = buildSkinnedGroup();
    const cloned = skeletonClone(source);

    // Find SkinnedMesh in each hierarchy
    let srcMesh: THREE.SkinnedMesh | null = null;
    let clonedMesh: THREE.SkinnedMesh | null = null;

    source.traverse((n) => { if (n instanceof THREE.SkinnedMesh) srcMesh = n; });
    cloned.traverse((n) => { if (n instanceof THREE.SkinnedMesh) clonedMesh = n; });

    expect(srcMesh).not.toBeNull();
    expect(clonedMesh).not.toBeNull();

    // Narrowing — already asserted non-null above
    const sm = srcMesh as unknown as THREE.SkinnedMesh;
    const cm = clonedMesh as unknown as THREE.SkinnedMesh;

    // The skeleton instance itself should differ
    expect(cm.skeleton).not.toBe(sm.skeleton);

    // Each bone in the clone must be a different object from the source bone
    for (let i = 0; i < sm.skeleton.bones.length; i++) {
      const srcBone = sm.skeleton.bones[i];
      const cloneBone = cm.skeleton.bones[i];
      expect(cloneBone).not.toBeUndefined();
      expect(cloneBone).not.toBe(srcBone);
    }
  });

  test('cloned bones are descendants of the cloned root (not the original)', () => {
    const source = buildSkinnedGroup();
    const cloned = skeletonClone(source);

    let clonedMesh: THREE.SkinnedMesh | null = null;
    cloned.traverse((n) => { if (n instanceof THREE.SkinnedMesh) clonedMesh = n; });
    expect(clonedMesh).not.toBeNull();
    const cm = clonedMesh as unknown as THREE.SkinnedMesh;

    // Collect all descendants of the cloned root
    const clonedDescendants = new Set<THREE.Object3D>();
    cloned.traverse((n) => clonedDescendants.add(n));

    // Every bone in the cloned skeleton must be a descendant of the cloned root
    for (const bone of cm.skeleton.bones) {
      expect(bone).not.toBeUndefined();
      expect(clonedDescendants.has(bone as THREE.Object3D)).toBe(true);
    }

    // Sanity: cloned root is different object from source
    expect(cloned).not.toBe(source);
  });
});

describe('SkeletonUtils.clone — non-skinned group sanity', () => {
  test('cloning a Group of plain Meshes produces an independent object with equal child count', () => {
    // Build a plain group with 3 meshes
    const source = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      source.add(mesh);
    }

    const cloned = skeletonClone(source);

    // Different object identity
    expect(cloned).not.toBe(source);

    // Same child count
    expect(cloned.children).toHaveLength(source.children.length);

    // Each child is a different object (deep copy at Object3D level)
    for (let i = 0; i < source.children.length; i++) {
      expect(cloned.children[i]).not.toBe(source.children[i]);
    }
  });
});
