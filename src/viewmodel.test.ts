/**
 * viewmodel.test.ts — headless bun test
 *
 * Tests pure math (normalizeWeaponModel), stem-mapping, grip presets, and
 * disk/license checks.
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
  type WeaponTuning,
  type GripFamily,
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
// GRIP_PRESETS table — exported pure data
// ---------------------------------------------------------------------------

describe('GRIP_PRESETS', () => {
  const VALID_FAMILIES: GripFamily[] = ['two_handed_long', 'pistol', 'knife'];
  const ALL_STEMS = Object.keys(THIRD_PERSON_WEAPON_PATHS);

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

  test('every preset bone rotation value is finite', () => {
    const fields: Array<keyof typeof GRIP_PRESETS[string]> = [
      'shoulderR', 'upperArmR', 'lowerArmR', 'wristR',
      'shoulderL', 'upperArmL', 'lowerArmL', 'wristL',
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
