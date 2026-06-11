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

import {
  normalizeWeaponModel,
  WEAPON_MODEL_PATHS,
  type WeaponId,
} from './viewmodel';

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
