import { describe, expect, test } from 'bun:test';
import type { MapData } from '../types';
import { MAPS, MAP_DISPLAY_NAMES, DEFAULT_MAP_ID, resolveMap } from './index';

// ---------------------------------------------------------------------------
// Registry sanity
// ---------------------------------------------------------------------------

describe('Map registry', () => {
  test('dust2 and mirage are present', () => {
    expect(MAPS['dust2']).toBeDefined();
    expect(MAPS['mirage']).toBeDefined();
  });

  test('default map id is valid', () => {
    expect(MAPS[DEFAULT_MAP_ID]).toBeDefined();
  });

  test('every registry key has a display name', () => {
    for (const id of Object.keys(MAPS)) {
      expect(MAP_DISPLAY_NAMES[id]).toBeDefined();
      expect(MAP_DISPLAY_NAMES[id]!.length).toBeGreaterThan(0);
    }
  });

  // Basic MapData sanity for every registered entry.
  test.each(Object.entries(MAPS))('map "%s" has valid MapData structure', (_id, map: MapData) => {
    // Grid must be non-empty rows of equal length.
    expect(map.grid.length).toBeGreaterThan(0);
    const firstRowLen = map.grid[0]!.length;
    expect(firstRowLen).toBeGreaterThan(0);
    for (const row of map.grid) {
      expect(row.length).toBe(firstRowLen);
    }

    // Every char in the grid must be in the legend.
    const legendChars = new Set(Object.keys(map.legend));
    for (let r = 0; r < map.grid.length; r++) {
      const row = map.grid[r]!;
      for (let c = 0; c < row.length; c++) {
        const ch = row[c]!;
        expect(legendChars.has(ch)).toBe(true);
      }
    }

    // cellSize is positive.
    expect(map.cellSize).toBeGreaterThan(0);

    // Both spawn arrays are non-empty.
    expect(map.spawns.ct.length).toBeGreaterThan(0);
    expect(map.spawns.t.length).toBeGreaterThan(0);

    // At least 2 bomb sites.
    expect(map.bombsites.length).toBeGreaterThanOrEqual(2);
    for (const site of map.bombsites) {
      expect(site.name === 'A' || site.name === 'B').toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveMap — pure helper
// ---------------------------------------------------------------------------

describe('resolveMap', () => {
  test('known id returns the correct map', () => {
    expect(resolveMap('dust2')).toBe(MAPS['dust2']);
    expect(resolveMap('mirage')).toBe(MAPS['mirage']);
  });

  test('unknown id falls back to the default map', () => {
    const fallback = resolveMap('nonexistent_map_xyz');
    expect(fallback).toBe(MAPS[DEFAULT_MAP_ID]);
  });

  test('empty string falls back to the default map', () => {
    const fallback = resolveMap('');
    expect(fallback).toBe(MAPS[DEFAULT_MAP_ID]);
  });

  test('resolveMap is idempotent: resolving the same id twice returns equal objects', () => {
    expect(resolveMap('dust2')).toBe(resolveMap('dust2'));
    expect(resolveMap('mirage')).toBe(resolveMap('mirage'));
  });
});

// ---------------------------------------------------------------------------
// resolveMap — swap contract (same map = same reference, different map = different)
// ---------------------------------------------------------------------------

describe('resolveMap swap contract', () => {
  test('resolving same id is a no-op (same reference)', () => {
    const m1 = resolveMap('dust2');
    const m2 = resolveMap('dust2');
    expect(m1).toBe(m2);
  });

  test('resolving different ids returns different references', () => {
    const d2 = resolveMap('dust2');
    const mr = resolveMap('mirage');
    expect(d2).not.toBe(mr);
  });
});
