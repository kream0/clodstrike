/**
 * Asset module tests — runs under bun test WITHOUT DOM/WebGL.
 * Does NOT call loadAllTextures, loadAllNormalTextures, or loadGLB.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { TEXTURE_SLOTS, assetUrl, type TextureSlot } from './assets';

// Resolve repo root relative to this test file (src/assets.test.ts -> ../)
const repoRoot = join(import.meta.dir, '..');

// ---------------------------------------------------------------------------
// Texture file presence, size, and magic bytes
// ---------------------------------------------------------------------------

describe('assets/textures — color maps', () => {
  for (const slot of TEXTURE_SLOTS) {
    const filePath = join(repoRoot, 'assets', 'textures', `${slot}.jpg`);

    test(`${slot}.jpg exists`, () => {
      expect(existsSync(filePath)).toBe(true);
    });

    test(`${slot}.jpg is > 50 KB`, () => {
      const size = statSync(filePath).size;
      expect(size).toBeGreaterThan(50 * 1024);
    });

    test(`${slot}.jpg starts with JPEG magic bytes (0xFF 0xD8)`, () => {
      const buf = readFileSync(filePath);
      expect(buf[0]).toBe(0xff);
      expect(buf[1]).toBe(0xd8);
    });
  }
});

describe('assets/textures — normal maps', () => {
  for (const slot of TEXTURE_SLOTS) {
    const filePath = join(repoRoot, 'assets', 'textures', `${slot}_normal.jpg`);

    test(`${slot}_normal.jpg exists`, () => {
      expect(existsSync(filePath)).toBe(true);
    });

    test(`${slot}_normal.jpg is > 50 KB`, () => {
      const size = statSync(filePath).size;
      expect(size).toBeGreaterThan(50 * 1024);
    });

    test(`${slot}_normal.jpg starts with JPEG magic bytes (0xFF 0xD8)`, () => {
      const buf = readFileSync(filePath);
      expect(buf[0]).toBe(0xff);
      expect(buf[1]).toBe(0xd8);
    });
  }
});

// ---------------------------------------------------------------------------
// LICENSES.md — existence and content
// ---------------------------------------------------------------------------

describe('assets/LICENSES.md', () => {
  const licensePath = join(repoRoot, 'assets', 'LICENSES.md');

  test('LICENSES.md exists', () => {
    expect(existsSync(licensePath)).toBe(true);
  });

  test('LICENSES.md mentions CC0 for each slot asset ID', () => {
    const content = readFileSync(licensePath, 'utf-8');
    expect(content).toContain('CC0');
    // Each slot asset ID should appear
    const assetIds: Record<TextureSlot, string> = {
      ground_sand: 'Ground054',
      wall_sandstone: 'Bricks083',
      wall_plaster: 'Plaster001',
      floor_stone: 'PavingStones150',
      concrete: 'Concrete047A',
      wood: 'Wood039',
      metal: 'PaintedMetal013',
      fabric: 'fabric_pattern_05',
    };
    for (const slot of TEXTURE_SLOTS) {
      const id = assetIds[slot];
      expect(content).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// TEXTURE_SLOTS — registry shape
// ---------------------------------------------------------------------------

describe('TEXTURE_SLOTS', () => {
  test('has exactly 8 entries', () => {
    expect(TEXTURE_SLOTS).toHaveLength(8);
  });

  const expected: TextureSlot[] = [
    'ground_sand',
    'wall_sandstone',
    'wall_plaster',
    'floor_stone',
    'concrete',
    'wood',
    'metal',
    'fabric',
  ];

  test('contains all expected slot names', () => {
    for (const slot of expected) {
      expect(TEXTURE_SLOTS).toContain(slot);
    }
  });
});

// ---------------------------------------------------------------------------
// assetUrl — pure URL resolution (no DOM required)
// ---------------------------------------------------------------------------

describe('assetUrl — GH Pages subpath base', () => {
  const ghBase = 'https://kream0.github.io/clodstrike/';

  test('resolves a texture path to the full subpath URL', () => {
    const result = assetUrl('textures/x.jpg', ghBase);
    expect(result).toBe('https://kream0.github.io/clodstrike/assets/textures/x.jpg');
  });

  test('handles base without trailing slash', () => {
    const result = assetUrl('textures/x.jpg', 'https://kream0.github.io/clodstrike');
    expect(result).toBe('https://kream0.github.io/clodstrike/assets/textures/x.jpg');
  });

  test('no leading-slash bug — does not resolve to origin root', () => {
    const result = assetUrl('textures/ground_sand.jpg', ghBase);
    expect(result.startsWith('https://kream0.github.io/clodstrike/')).toBe(true);
    // Must NOT be https://kream0.github.io/assets/...
    expect(result).not.toBe('https://kream0.github.io/assets/textures/ground_sand.jpg');
  });
});

describe('assetUrl — localhost dev base', () => {
  const localBase = 'http://localhost:3000/';

  test('resolves correctly against localhost', () => {
    const result = assetUrl('textures/ground_sand.jpg', localBase);
    expect(result).toBe('http://localhost:3000/assets/textures/ground_sand.jpg');
  });

  test('works with GLB path', () => {
    const result = assetUrl('models/weapon.glb', localBase);
    expect(result).toBe('http://localhost:3000/assets/models/weapon.glb');
  });
});

describe('assetUrl — document-undefined safety', () => {
  test('does not throw when document is undefined and explicit base is passed', () => {
    // In bun test, document IS undefined — passing explicit base must not throw
    expect(() => {
      assetUrl('textures/ground_sand.jpg', 'http://localhost:3000/');
    }).not.toThrow();
  });
});
