/**
 * viewmodel.test.ts — headless bun test
 *
 * Tests pure math (normalizeWeaponModel) and disk/license checks.
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
  WEAPON_MODEL_PATHS,
  WEAPON_MODEL_ALIAS,
  VIEWMODEL_SCALE,
  resolveWeaponTuning,
  type WeaponId,
  type WeaponTuning,
} from './viewmodel';
import { WEAPONS } from './constants';

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
    // targetLength = 0.22, scaleMult = 1.0 (usp-like)
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
// WEAPON_MODEL_PATHS — shape and disk presence
// ---------------------------------------------------------------------------

describe('WEAPON_MODEL_PATHS', () => {
  const GUN_IDS: WeaponId[] = ['glock', 'usp', 'deagle', 'ak47', 'm4a4', 'awp'];

  test('contains exactly the 6 gun ids (knife absent)', () => {
    const keys = Object.keys(WEAPON_MODEL_PATHS) as WeaponId[];
    // Exactly 6
    expect(keys).toHaveLength(6);
    // All expected ids present
    for (const id of GUN_IDS) {
      expect(keys).toContain(id);
    }
    // knife must NOT be present
    expect(keys).not.toContain('knife' as WeaponId);
  });

  for (const id of GUN_IDS) {
    test(`${id}: path follows 'models/weapons/<id>.glb' convention`, () => {
      const path = WEAPON_MODEL_PATHS[id];
      expect(path).toBe(`models/weapons/${id}.glb`);
    });

    test(`${id}: GLB file exists on disk under assets/`, () => {
      const relPath = WEAPON_MODEL_PATHS[id];
      expect(relPath).toBeDefined();
      const filePath = join(repoRoot, 'assets', relPath as string);
      expect(existsSync(filePath)).toBe(true);
    });

    test(`${id}: GLB file starts with 'glTF' magic bytes`, () => {
      const relPath = WEAPON_MODEL_PATHS[id];
      expect(relPath).toBeDefined();
      const filePath = join(repoRoot, 'assets', relPath as string);
      const buf = readFileSync(filePath);
      const magic = String.fromCharCode(buf[0] ?? 0, buf[1] ?? 0, buf[2] ?? 0, buf[3] ?? 0);
      expect(magic).toBe('glTF');
    });

    test(`${id}: GLB file is > 5 KB`, () => {
      const relPath = WEAPON_MODEL_PATHS[id];
      expect(relPath).toBeDefined();
      const filePath = join(repoRoot, 'assets', relPath as string);
      const { size } = Bun.file(filePath);
      expect(size).toBeGreaterThan(5 * 1024);
    });
  }
});

// ---------------------------------------------------------------------------
// LICENSES.md — models section
// ---------------------------------------------------------------------------

describe('LICENSES.md — models section', () => {
  const licensePath = join(repoRoot, 'assets', 'LICENSES.md');

  test('mentions Flat Guns (West or East)', () => {
    const content = readFileSync(licensePath, 'utf-8');
    expect(content).toContain('Flat Guns');
  });

  test('mentions Pichuliru as author', () => {
    const content = readFileSync(licensePath, 'utf-8');
    expect(content).toContain('Pichuliru');
  });

  test('mentions CC0 1.0 for models', () => {
    const content = readFileSync(licensePath, 'utf-8');
    // Should contain a Models section with CC0
    expect(content).toContain('## Models');
    expect(content).toContain('CC0 1.0');
  });

  test('references OpenGameArt URLs for both packs', () => {
    const content = readFileSync(licensePath, 'utf-8');
    expect(content).toContain('opengameart.org/content/cc0-flat-guns-west');
    expect(content).toContain('opengameart.org/content/cc0-flat-guns-east');
  });

  test('lists all 6 gun GLB filenames in the models section', () => {
    const content = readFileSync(licensePath, 'utf-8');
    const expected = ['glock.glb', 'usp.glb', 'deagle.glb', 'ak47.glb', 'm4a4.glb', 'awp.glb'];
    for (const file of expected) {
      expect(content).toContain(file);
    }
  });
});

// ---------------------------------------------------------------------------
// SkeletonUtils.clone regression — skinned mesh deep copy
//
// Verifies the invariant that viewmodel.ts relies on: skeletonClone produces a
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

// ---------------------------------------------------------------------------
// WEAPON_MODEL_ALIAS — alias chain resolution for all 30 WEAPONS ids
// ---------------------------------------------------------------------------

describe('WEAPON_MODEL_ALIAS — every WEAPONS id resolves to a WEAPON_MODEL_PATHS entry', () => {
  const modelledIds = new Set(Object.keys(WEAPON_MODEL_PATHS));

  // Helper: walk alias chain, max 2 hops (no chain is longer than 1 hop in practice)
  function resolveToModelledId(id: string): string | undefined {
    if (modelledIds.has(id)) return id;
    const alias = WEAPON_MODEL_ALIAS[id];
    if (alias === undefined) return undefined;
    if (modelledIds.has(alias)) return alias;
    // Two-hop (not expected, but guard)
    const alias2 = WEAPON_MODEL_ALIAS[alias];
    if (alias2 !== undefined && modelledIds.has(alias2)) return alias2;
    return undefined;
  }

  test('data-driven: every WEAPONS id (excluding knife) resolves to a WEAPON_MODEL_PATHS entry or is modelled directly', () => {
    const failures: string[] = [];
    for (const id of Object.keys(WEAPONS)) {
      if (id === 'knife') continue; // knife is intentionally procedural
      const resolved = resolveToModelledId(id);
      if (resolved === undefined) failures.push(id);
    }
    if (failures.length > 0) {
      throw new Error(`Weapon ids with no GLB resolution: ${failures.join(', ')}`);
    }
  });

  test('knife is NOT in WEAPON_MODEL_ALIAS (stays procedural)', () => {
    expect(WEAPON_MODEL_ALIAS['knife']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveWeaponTuning — finite scale/offsets for every id (noUncheckedIndexedAccess safe)
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
});

// ---------------------------------------------------------------------------
// Spot checks
// ---------------------------------------------------------------------------

describe('WEAPON_MODEL_ALIAS spot checks', () => {
  test('mp9 resolves to m4a4 path', () => {
    const aliasId = WEAPON_MODEL_ALIAS['mp9'];
    expect(aliasId).toBe('m4a4');
    expect(WEAPON_MODEL_PATHS[aliasId as WeaponId]).toBe('models/weapons/m4a4.glb');
  });

  test('mp9 effective scaleMult is less than m4a4 scaleMult (SMG compact feel)', () => {
    const mp9Tuning   = resolveWeaponTuning('mp9');
    const m4a4Tuning  = resolveWeaponTuning('m4a4');
    expect(mp9Tuning.scaleMult).toBeLessThan(m4a4Tuning.scaleMult);
  });

  test('scar20 resolves to awp path', () => {
    const aliasId = WEAPON_MODEL_ALIAS['scar20'];
    expect(aliasId).toBe('awp');
    expect(WEAPON_MODEL_PATHS[aliasId as WeaponId]).toBe('models/weapons/awp.glb');
  });

  test('scar20 tuning is finite with scaleMult > 0', () => {
    const tuning = resolveWeaponTuning('scar20');
    expect(isFinite(tuning.scaleMult)).toBe(true);
    expect(tuning.scaleMult).toBeGreaterThan(0);
  });

  test('dualies resolves to deagle (single-gun stand-in)', () => {
    expect(WEAPON_MODEL_ALIAS['dualies']).toBe('deagle');
  });

  test('ssg08 resolves to awp with smaller targetLength than awp', () => {
    const ssg08Tuning = resolveWeaponTuning('ssg08');
    const awpTuning   = resolveWeaponTuning('awp');
    expect(WEAPON_MODEL_ALIAS['ssg08']).toBe('awp');
    expect(ssg08Tuning.targetLength).toBeLessThan(awpTuning.targetLength);
  });

  test('m249 and negev alias to m4a4 with enlarged scaleMult', () => {
    const m249Tuning  = resolveWeaponTuning('m249');
    const negevTuning = resolveWeaponTuning('negev');
    const m4a4Tuning  = resolveWeaponTuning('m4a4');
    expect(WEAPON_MODEL_ALIAS['m249']).toBe('m4a4');
    expect(WEAPON_MODEL_ALIAS['negev']).toBe('m4a4');
    expect(m249Tuning.scaleMult).toBeGreaterThan(m4a4Tuning.scaleMult);
    expect(negevTuning.scaleMult).toBeGreaterThan(m4a4Tuning.scaleMult);
  });
});
