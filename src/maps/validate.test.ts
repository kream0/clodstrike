import { describe, expect, test } from 'bun:test';
import { validateMapData } from './validate';
import { MAPS, MAP_DISPLAY_NAMES, DEFAULT_MAP_ID, resolveMap, registerSessionMap } from './index';
import { DUST2 } from './dust2';
import { MIRAGE } from './mirage';

// ---------------------------------------------------------------------------
// Minimal valid fixture (32×32 grid, two spawns, two bombsites reachable).
// Heights use 0.375 multiples.  Chars: ' '=void/wall, '0'=floor 0.0, 'C'=ct floor, 'T'=t floor, 'A'=A-site, 'B'=B-site
// Grid sketch (32×32):
//   Rows 0-1:  all void (' ')
//   Rows 2-29: interior corridor — wall borders ('#') + floor cells ('0')
//   Rows 30-31: all void
//
// CT spawns around col 8-9, row 14 (floor 0.0)
// T  spawns around col 22-23, row 14 (floor 0.0)
// A  site: cols 5-10, rows 4-10   (floor 0.0)
// B  site: cols 20-26, rows 4-10  (floor 0.0)
//
// Everything is at floor=0.0 ('0'), walls '#', void ' '.
// The corridor connects T and CT sides directly so BFS reachability passes.
// ---------------------------------------------------------------------------

function makeMinimalGrid(): string[] {
  const ROWS = 32;
  const COLS = 32;
  const rows: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    let row = '';
    for (let c = 0; c < COLS; c++) {
      const isEdge = r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1;
      if (isEdge) {
        row += ' ';
      } else {
        row += '0';
      }
    }
    rows.push(row);
  }
  return rows;
}

const VALID_MAP = {
  name: 'test_map',
  cellSize: 1,
  origin: { x: -16, z: -16 },
  grid: makeMinimalGrid(),
  legend: {
    ' ': { floor: 0, wall: true },
    '0': { floor: 0.0 },
  },
  props: [],
  spawns: {
    ct: [{ x: -7.5, z: -1.5, angle: 0 }],
    t:  [{ x:  7.5, z: -1.5, angle: Math.PI }],
  },
  bombsites: [
    // A: 5m × 4m = 20 m² (meets minimum)
    { name: 'A', min: { x: -11, z: -12 }, max: { x: -6,  z: -8 } },
    // B: 5m × 4m = 20 m²
    { name: 'B', min: { x:  6,  z: -12 }, max: { x: 11,  z: -8 } },
  ],
  areas: [],
};

// ---------------------------------------------------------------------------
// 1. Valid fixture
// ---------------------------------------------------------------------------

describe('valid fixture', () => {
  test('minimal valid map returns ok:true with a typed MapData', () => {
    const result = validateMapData(VALID_MAP);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.map.name).toBe('test_map');
      expect(result.map.cellSize).toBe(1);
      expect(result.map.grid.length).toBe(32);
    }
  });

  test('dust2 passes validation', () => {
    const result = validateMapData(DUST2);
    expect(result.ok, result.ok ? '' : JSON.stringify((result as { ok: false; errors: string[] }).errors)).toBe(true);
  });

  test('mirage passes validation', () => {
    const result = validateMapData(MIRAGE);
    expect(result.ok, result.ok ? '' : JSON.stringify((result as { ok: false; errors: string[] }).errors)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Non-object inputs
// ---------------------------------------------------------------------------

describe('root shape tier', () => {
  test('null input returns error', () => {
    const r = validateMapData(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/root must be a JSON object/);
  });

  test('array input returns error', () => {
    const r = validateMapData([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/root must be a JSON object/);
  });

  test('missing required fields error-accumulates', () => {
    const r = validateMapData({});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Should have errors for name, cellSize, origin, grid, legend, props, spawns, bombsites, areas
      expect(r.errors.length).toBeGreaterThanOrEqual(5);
    }
  });
});

// ---------------------------------------------------------------------------
// 2b. cellSize must be exactly 1
// ---------------------------------------------------------------------------

describe('cellSize tier', () => {
  test('cellSize: 2 returns "cellSize must be exactly 1" error', () => {
    const m = { ...VALID_MAP, cellSize: 2 };
    const r = validateMapData(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.includes('cellSize must be exactly 1'))).toBe(true);
  });

  test('cellSize: 0.5 returns error', () => {
    const m = { ...VALID_MAP, cellSize: 0.5 };
    const r = validateMapData(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.includes('cellSize must be exactly 1'))).toBe(true);
  });

  test('cellSize: 1 is accepted', () => {
    const r = validateMapData(VALID_MAP);
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Grid dimension errors
// ---------------------------------------------------------------------------

describe('grid dimension tier', () => {
  test('grid with too few rows returns error', () => {
    const m = { ...VALID_MAP, grid: ['01', '01', '01'] };
    const r = validateMapData(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.includes('rows'))).toBe(true);
  });

  test('grid with non-equal row lengths returns error', () => {
    const badGrid = [...makeMinimalGrid()];
    badGrid[5] = badGrid[5]!.slice(0, 10); // shorter row
    const m = { ...VALID_MAP, grid: badGrid };
    const r = validateMapData(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.includes('row 5') && e.includes('length'))).toBe(true);
  });

  test('non-square grid returns error', () => {
    // 32 rows of 20 cols each
    const g = Array.from({ length: 32 }, () => '0'.repeat(20));
    const m = { ...VALID_MAP, grid: g };
    const r = validateMapData(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.includes('square'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Unknown grid character
// ---------------------------------------------------------------------------

describe('legend coverage tier', () => {
  test('grid character absent from legend returns error', () => {
    const badGrid = makeMinimalGrid();
    // Replace a walkable cell with an undeclared char 'X'
    badGrid[16] = badGrid[16]!.substring(0, 16) + 'X' + badGrid[16]!.substring(17);
    const m = { ...VALID_MAP, grid: badGrid };
    const r = validateMapData(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.includes("'X'") && e.includes('legend'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Bad height multiple in legend
// ---------------------------------------------------------------------------

describe('legend height tier', () => {
  test('floor that is not a multiple of 0.375 returns error', () => {
    const m = {
      ...VALID_MAP,
      legend: {
        ' ': { floor: 0, wall: true },
        '0': { floor: 0.4 }, // not a multiple of 0.375
      },
    };
    const r = validateMapData(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.includes('multiple of 0.375'))).toBe(true);
  });

  test('ceiling at or below floor returns error', () => {
    const m = {
      ...VALID_MAP,
      legend: {
        ' ': { floor: 0, wall: true },
        '0': { floor: 0.375, ceil: 0.375 }, // ceil == floor → invalid
      },
    };
    const r = validateMapData(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.includes('ceil') && e.includes('floor'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Spawn on wall cell
// ---------------------------------------------------------------------------

describe('spawn tier', () => {
  test('spawn on a wall cell returns a reachability error', () => {
    // Place a ct spawn at world (-15.5, -15.5) which maps to col=0,row=0 — a void/wall cell
    const m = {
      ...VALID_MAP,
      spawns: {
        ct: [{ x: -15.5, z: -15.5, angle: 0 }], // col 0, row 0 — wall=' '
        t:  VALID_MAP.spawns.t,
      },
    };
    const r = validateMapData(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.includes('wall') || e.includes('void'))).toBe(true);
  });

  test('missing t spawns returns error', () => {
    const m = { ...VALID_MAP, spawns: { ct: VALID_MAP.spawns.ct, t: [] } };
    const r = validateMapData(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.includes('spawns.t') && e.includes('at least'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Bombsite count / area too small
// ---------------------------------------------------------------------------

describe('bombsite tier', () => {
  test('only one bombsite returns error', () => {
    const m = { ...VALID_MAP, bombsites: [VALID_MAP.bombsites[0]] };
    const r = validateMapData(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.includes('exactly 2'))).toBe(true);
  });

  test('bombsite area below 20 m² returns error', () => {
    const m = {
      ...VALID_MAP,
      bombsites: [
        { name: 'A' as const, min: { x: -11, z: -12 }, max: { x: -9, z: -11 } }, // 2×1 = 2 m²
        VALID_MAP.bombsites[1]!,
      ],
    };
    const r = validateMapData(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.includes('20 m²') || e.includes('below minimum'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Prop out of bounds
// ---------------------------------------------------------------------------

describe('prop tier', () => {
  test('prop far outside grid bounds returns error', () => {
    const m = {
      ...VALID_MAP,
      props: [{
        kind: 'crate' as const,
        pos: [9999, 0, 9999] as [number, number, number],
        size: [1, 1, 1] as [number, number, number],
      }],
    };
    const r = validateMapData(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.includes('outside grid bounds'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Unreachable bombsite — uses a map with an interior wall column that
//    isolates one bombsite from the spawns.
// ---------------------------------------------------------------------------

/**
 * Build a 32×32 grid where column 16 is a solid wall barrier, splitting the
 * map into a left half (cols 1-15) and a right half (cols 17-30).
 * CT and T spawns are both on the LEFT side.
 * A bombsite is on the LEFT side (reachable).
 * B bombsite center is on the RIGHT side (unreachable from both spawns).
 */
function makeIsolatedGrid(): string[] {
  const ROWS = 32;
  const COLS = 32;
  const rows: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    let row = '';
    for (let c = 0; c < COLS; c++) {
      const isEdge    = r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1;
      const isBarrier = c === 16; // wall column splitting left/right halves
      if (isEdge || isBarrier) {
        row += '#';
      } else {
        row += '0';
      }
    }
    rows.push(row);
  }
  return rows;
}

const ISOLATED_MAP = {
  name: 'isolated_map',
  cellSize: 1,
  origin: { x: -16, z: -16 },
  grid: makeIsolatedGrid(),
  legend: {
    '#': { floor: 0, wall: true },
    '0': { floor: 0.0 },
  },
  props: [],
  spawns: {
    // Both spawns on the LEFT side (cols 1-15)
    ct: [{ x: -11.5, z: -1.5, angle: 0 }],   // col 4, row 14 — left side
    t:  [{ x:  -2.5, z: -1.5, angle: Math.PI }], // col 13, row 14 — left side
  },
  bombsites: [
    // A on left side (reachable from both spawns)
    { name: 'A' as const, min: { x: -14, z: -12 }, max: { x: -9, z: -7 } },
    // B center on RIGHT side (col 20-25, row 4-10) — unreachable from left-side spawns
    { name: 'B' as const, min: { x:  4,  z: -12 }, max: { x: 10,  z: -7 } },
  ],
  areas: [],
};

describe('reachability tier', () => {
  test('bombsite unreachable from all spawns returns error', () => {
    const r = validateMapData(ISOLATED_MAP);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some(e => e.includes('reachability') && e.includes('B'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Error accumulation
// ---------------------------------------------------------------------------

describe('error accumulation', () => {
  test('fixture with 3 independent errors reports >= 3 errors', () => {
    const m = {
      ...VALID_MAP,
      // Error 1: name is empty
      name: '',
      // Error 2: cellSize is negative
      cellSize: -1,
      // Error 3: props has too many entries (trigger > 200 check only after basic pass, so use another error)
      // Use origin with non-finite values instead
      origin: { x: NaN, z: 0 },
    };
    const r = validateMapData(m);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Registry: registerSessionMap
// ---------------------------------------------------------------------------

describe('registry', () => {
  test('built-in maps are unaffected after registration', () => {
    registerSessionMap('test-isolation', DUST2, 'Test');
    expect(MAPS['dust2']).toBe(DUST2);
    expect(MAPS['mirage']).toBe(MIRAGE);
    expect(MAP_DISPLAY_NAMES['dust2']).toBe('Dust2');
    expect(MAP_DISPLAY_NAMES['mirage']).toBe('Mirage');
    expect(DEFAULT_MAP_ID).toBe('dust2');
  });

  test('registerSessionMap returns a unique non-empty id', () => {
    const id = registerSessionMap('my custom map', DUST2, 'My Custom Map');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(MAPS[id]).toBe(DUST2);
    expect(MAP_DISPLAY_NAMES[id]).toBe('My Custom Map');
  });

  test('resolveMap finds a registered session map', () => {
    const id = registerSessionMap('session-lookup-test', DUST2, 'Lookup Test');
    const found = resolveMap(id);
    expect(found).toBe(DUST2);
  });

  test('id collision produces a unique suffix', () => {
    const slug = 'collision-test-map';
    const id1 = registerSessionMap(slug, DUST2, 'Collision 1');
    const id2 = registerSessionMap(slug, MIRAGE, 'Collision 2');
    expect(id1).not.toBe(id2);
    expect(MAPS[id1]).toBe(DUST2);
    expect(MAPS[id2]).toBe(MIRAGE);
  });

  test('trying to register with a built-in name gets a non-colliding id', () => {
    const id = registerSessionMap('dust2', MIRAGE, 'My Dust2');
    // Built-in 'dust2' must still point to DUST2
    expect(MAPS['dust2']).toBe(DUST2);
    // The returned id is different
    expect(id).not.toBe('dust2');
    expect(MAPS[id]).toBe(MIRAGE);
  });

  test('resolveMap falls back to default for unknown ids', () => {
    const found = resolveMap('this-id-does-not-exist-at-all');
    expect(found).toBe(DUST2);
  });
});
