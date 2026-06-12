import { describe, expect, test } from 'bun:test';
import type { CellLegend, MapData, NamedArea, Vec2 } from '../types';
import { DUST2 } from './dust2';

const map: MapData = DUST2;
const W = 96;
const H = 96;

// --- helpers ---------------------------------------------------------------

function toCell(x: number, z: number): [number, number] {
  return [Math.floor((x - map.origin.x) / map.cellSize), Math.floor((z - map.origin.z) / map.cellSize)];
}

function legendAt(col: number, row: number): CellLegend {
  const ch = map.grid[row][col];
  const le = map.legend[ch];
  if (!le) throw new Error(`char '${ch}' at ${col},${row} missing from legend`);
  return le;
}

function isWallCell(col: number, row: number): boolean {
  if (col < 0 || col >= W || row < 0 || row >= H) return true;
  return legendAt(col, row).wall === true;
}

// Movement rule: 4-neighbor; neither cell wall; climb <= 0.5 or any drop;
// ceiling clearance (effective min of present ceils) - max floor >= 1.9.
function passable(c0: number, r0: number, c1: number, r1: number): boolean {
  if (isWallCell(c0, r0) || isWallCell(c1, r1)) return false;
  const a = legendAt(c0, r0);
  const b = legendAt(c1, r1);
  const climbOk = b.floor - a.floor <= 0.5 || b.floor < a.floor;
  if (!climbOk) return false;
  const ceil = Math.min(a.ceil ?? Infinity, b.ceil ?? Infinity);
  return ceil - Math.max(a.floor, b.floor) >= 1.9;
}

const DIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// BFS over the grid; returns parent map (key = row*W+col) for path reconstruction.
function bfs(
  startCol: number,
  startRow: number,
  blocked?: (col: number, row: number) => boolean,
): Map<number, number> {
  const parent = new Map<number, number>();
  if (isWallCell(startCol, startRow)) return parent;
  const startKey = startRow * W + startCol;
  parent.set(startKey, -1);
  const queue: number[] = [startKey];
  for (let qi = 0; qi < queue.length; qi++) {
    const key = queue[qi];
    const r = Math.floor(key / W);
    const c = key % W;
    for (const [dc, dr] of DIRS) {
      const cc = c + dc;
      const rr = r + dr;
      if (cc < 0 || cc >= W || rr < 0 || rr >= H) continue;
      const nk = rr * W + cc;
      if (parent.has(nk)) continue;
      if (blocked && blocked(cc, rr)) continue;
      if (!passable(c, r, cc, rr)) continue;
      parent.set(nk, key);
      queue.push(nk);
    }
  }
  return parent;
}

function pathTo(parent: Map<number, number>, col: number, row: number): [number, number][] | null {
  let key = row * W + col;
  if (!parent.has(key)) return null;
  const path: [number, number][] = [];
  while (key !== -1) {
    path.push([key % W, Math.floor(key / W)]);
    key = parent.get(key)!;
  }
  return path;
}

function cellCenterWorld(col: number, row: number): Vec2 {
  return { x: map.origin.x + (col + 0.5) * map.cellSize, z: map.origin.z + (row + 0.5) * map.cellSize };
}

function inRect(p: Vec2, min: Vec2, max: Vec2): boolean {
  return p.x >= min.x && p.x <= max.x && p.z >= min.z && p.z <= max.z;
}

function rectCenter(min: Vec2, max: Vec2): Vec2 {
  return { x: (min.x + max.x) / 2, z: (min.z + max.z) / 2 };
}

function area(name: string): NamedArea {
  const a = map.areas.find((x) => x.name === name);
  if (!a) throw new Error(`missing area ${name}`);
  return a;
}

const blockAreas = (names: string[]) => {
  const rects = names.map(area);
  return (col: number, row: number) => {
    const p = cellCenterWorld(col, row);
    return rects.some((a) => inRect(p, a.min, a.max));
  };
};

// --- 1. grid shape & legend coverage ---------------------------------------

describe('grid shape', () => {
  test('grid is 96x96 and every char is in the legend', () => {
    expect(map.grid.length).toBe(H);
    for (const row of map.grid) expect(row.length).toBe(W);
    const chars = new Set<string>();
    for (const row of map.grid) for (const ch of row) chars.add(ch);
    for (const ch of chars) expect(map.legend[ch], `char '${ch}' missing from legend`).toBeDefined();
  });
});

// --- 2. global walkability -------------------------------------------------

describe('walkability', () => {
  const targets: { label: string; p: Vec2 }[] = [
    ...map.spawns.ct.map((s, i) => ({ label: `ct spawn ${i}`, p: { x: s.x, z: s.z } })),
    ...map.bombsites.map((b) => ({ label: `bombsite ${b.name}`, p: rectCenter(b.min, b.max) })),
    ...map.areas.map((a) => ({ label: `area ${a.name}`, p: rectCenter(a.min, a.max) })),
  ];

  test('every T spawn reaches all CT spawns, both bombsites and every named area', () => {
    for (const s of map.spawns.t) {
      const [sc, sr] = toCell(s.x, s.z);
      const parent = bfs(sc, sr);
      for (const t of targets) {
        const [tc, tr] = toCell(t.p.x, t.p.z);
        expect(parent.has(tr * W + tc), `T(${s.x},${s.z}) cannot reach ${t.label}`).toBe(true);
      }
    }
  });

  test('reverse: every CT spawn reaches every T spawn and every named area', () => {
    for (const s of map.spawns.ct) {
      const [sc, sr] = toCell(s.x, s.z);
      const parent = bfs(sc, sr);
      for (const t of map.spawns.t) {
        const [tc, tr] = toCell(t.x, t.z);
        expect(parent.has(tr * W + tc), `CT(${s.x},${s.z}) cannot reach T(${t.x},${t.z})`).toBe(true);
      }
      for (const a of map.areas) {
        const c = rectCenter(a.min, a.max);
        const [tc, tr] = toCell(c.x, c.z);
        expect(parent.has(tr * W + tc), `CT(${s.x},${s.z}) cannot reach area ${a.name}`).toBe(true);
      }
    }
  });
});

// --- 3. key points stand on sane floors ------------------------------------

describe('key points', () => {
  test('spawns, bombsite centers and area centers are on non-wall cells with floor < 5.0', () => {
    const points: { label: string; p: Vec2 }[] = [
      ...map.spawns.t.map((s, i) => ({ label: `t spawn ${i}`, p: { x: s.x, z: s.z } })),
      ...map.spawns.ct.map((s, i) => ({ label: `ct spawn ${i}`, p: { x: s.x, z: s.z } })),
      ...map.bombsites.map((b) => ({ label: `bombsite ${b.name}`, p: rectCenter(b.min, b.max) })),
      ...map.areas.map((a) => ({ label: `area ${a.name}`, p: rectCenter(a.min, a.max) })),
    ];
    for (const { label, p } of points) {
      const [c, r] = toCell(p.x, p.z);
      expect(isWallCell(c, r), `${label} is on a wall cell`).toBe(false);
      expect(legendAt(c, r).floor, `${label} floor too high`).toBeLessThan(5.0);
    }
  });
});

// --- 4. props vs spawn points ----------------------------------------------

describe('props', () => {
  test('no prop within 0.6 m of a spawn point (XZ distance to prop footprint)', () => {
    const spawns = [...map.spawns.t, ...map.spawns.ct];
    for (const prop of map.props) {
      const [px, , pz] = prop.pos;
      const [sx, , sz] = prop.size;
      for (const s of spawns) {
        const dx = Math.max(Math.abs(s.x - px) - sx / 2, 0);
        const dz = Math.max(Math.abs(s.z - pz) - sz / 2, 0);
        const dist = Math.hypot(dx, dz);
        expect(dist, `prop ${prop.kind}@(${px},${pz}) too close to spawn (${s.x},${s.z})`).toBeGreaterThanOrEqual(0.6);
      }
    }
  });
});

// --- 5. forced routes through the three chokepoint systems ------------------

describe('chokepoint routes', () => {
  const tStart = map.spawns.t[0];
  const [tc, tr] = toCell(tStart.x, tStart.z);

  function assertForcedRoute(target: Vec2, blocked: string[], mustTouch: string) {
    const parent = bfs(tc, tr, blockAreas(blocked));
    const [gc, gr] = toCell(target.x, target.z);
    const path = pathTo(parent, gc, gr);
    expect(path, `no path to (${target.x},${target.z}) with ${blocked.join('+')} blocked`).not.toBeNull();
    const rect = area(mustTouch);
    const touches = path!.some(([c, r]) => inRect(cellCenterWorld(c, r), rect.min, rect.max));
    expect(touches, `path to (${target.x},${target.z}) does not pass through ${mustTouch}`).toBe(true);
  }

  test('T spawn -> B site via mid passes through MidDoors', () => {
    // Truth-rebuild: MidDoors gates the mid-spine -> mid-to-B branch (not the CT
    // mid spine). Block the UpperTunnels approach to B; the only remaining route
    // to B runs up mid and through MidDoors into B-doors.
    const b = map.bombsites.find((x) => x.name === 'B')!;
    assertForcedRoute(rectCenter(b.min, b.max), ['UpperTunnels'], 'MidDoors');
  });

  test('T spawn -> B site passes through UpperTunnels', () => {
    const b = map.bombsites.find((x) => x.name === 'B')!;
    assertForcedRoute(rectCenter(b.min, b.max), ['MidDoors', 'LongDoors', 'Catwalk', 'BDoors'], 'UpperTunnels');
  });

  test('T spawn -> A site passes through LongDoors', () => {
    const a = map.bombsites.find((x) => x.name === 'A')!;
    assertForcedRoute(rectCenter(a.min, a.max), ['MidDoors', 'UpperTunnels', 'Catwalk'], 'LongDoors');
  });
});

// --- 6. CT -> B site via BDoors --------------------------------------------

describe('CT to B via BDoors', () => {
  test('CT spawn reaches B site and path passes through BDoors', () => {
    const ctStart = map.spawns.ct[0]!;
    const [cc, cr] = toCell(ctStart.x, ctStart.z);
    const parent = bfs(cc, cr);
    const bsite = map.bombsites.find((x) => x.name === 'B')!;
    const [gc, gr] = toCell(rectCenter(bsite.min, bsite.max).x, rectCenter(bsite.min, bsite.max).z);
    const path = pathTo(parent, gc, gr);
    expect(path, 'CT spawn cannot reach B site').not.toBeNull();
    const bdoors = area('BDoors');
    const touches = path!.some(([c, r]) => inRect(cellCenterWorld(c, r), bdoors.min, bdoors.max));
    expect(touches, 'CT->B path does not touch BDoors').toBe(true);
  });
});

// --- 7. catwalk reachability + one-way pit drop ----------------------------
// NOTE (2026-06 ground-truth rebuild): the truth table puts the catwalk and the
// mid spine at the SAME 3.75 m floor, so the catwalk<->mid connections are flat
// and bidirectional (required by the SHORT_A route legs below). The genuine
// one-way HEIGHT drop in this layout is the PIT: long (3.75) -> pit (3.0) is a
// 0.75 m drop you fall INTO but cannot climb back, exiting via the pit ramp.
// The one-way assertions therefore target the pit (faithful + still exercised).

describe('one-way pit drop', () => {
  test('catwalk cell is reachable from T spawn (via short/mid)', () => {
    const tStart = map.spawns.t[0]!;
    const [sc, sr] = toCell(tStart.x, tStart.z);
    const parent = bfs(sc, sr);
    const cat = area('Catwalk');
    const [cc, cr] = toCell(rectCenter(cat.min, cat.max).x, rectCenter(cat.min, cat.max).z);
    expect(parent.has(cr * W + cc), 'T spawn cannot reach catwalk').toBe(true);
  });

  test('direct climb from pit floor up into long is blocked (height diff > 0.5)', () => {
    // Long lane (L = 3.75) on the west edge of the pit drops into the pit
    // floor (8 = 3.0). Adjacent pair: long col 79 row 56 <-> pit col 80 row 56.
    const [c0, r0] = [79, 56]; // long ledge (floor 3.75)
    const [c1, r1] = [80, 56]; // pit floor (3.0)
    // Climb pit(3.0) -> long(3.75) = 0.75 > 0.5 -> blocked.
    expect(passable(c1, r1, c0, r0), 'direct climb out of pit should be blocked').toBe(false);
    // Drop long(3.75) -> pit(3.0) is passable (any drop allowed).
    expect(passable(c0, r0, c1, r1), 'drop into pit should be passable').toBe(true);
  });
});

// --- 8. pit round-trip -------------------------------------------------------

describe('pit round-trip', () => {
  test('Pit is reachable from CT spawn', () => {
    const ctStart = map.spawns.ct[0]!;
    const [sc, sr] = toCell(ctStart.x, ctStart.z);
    const parent = bfs(sc, sr);
    const pit = area('Pit');
    const [pc, pr] = toCell(rectCenter(pit.min, pit.max).x, rectCenter(pit.min, pit.max).z);
    expect(parent.has(pr * W + pc), 'CT spawn cannot reach Pit').toBe(true);
  });

  test('exit from Pit is possible (Pit reaches CT spawn)', () => {
    const pit = area('Pit');
    const [pc, pr] = toCell(rectCenter(pit.min, pit.max).x, rectCenter(pit.min, pit.max).z);
    const parent = bfs(pc, pr);
    const ctStart = map.spawns.ct[0]!;
    const [cc, cr] = toCell(ctStart.x, ctStart.z);
    expect(parent.has(cr * W + cc), 'cannot exit Pit to CT spawn').toBe(true);
  });
});

// --- 9. site sanity ----------------------------------------------------------

describe('site sanity', () => {
  test('A site cells in legend have floor >= 4.0 (elevated)', () => {
    const asite = area('ASite');
    let elevated = 0;
    let total = 0;
    for (let c = Math.floor((asite.min.x - map.origin.x) / map.cellSize);
        c <= Math.ceil((asite.max.x - map.origin.x) / map.cellSize); c++) {
      for (let r = Math.floor((asite.min.z - map.origin.z) / map.cellSize);
          r <= Math.ceil((asite.max.z - map.origin.z) / map.cellSize); r++) {
        if (c < 0 || c >= W || r < 0 || r >= H) continue;
        const le = map.legend[map.grid[r]![c]!];
        if (!le || le.wall) continue;
        total++;
        if (le.floor >= 4.0) elevated++;
      }
    }
    expect(total, 'no walkable cells inside ASite rect').toBeGreaterThan(0);
    // at least half the walkable cells on the A-site plateau are >= 4.0 m
    expect(elevated / total, 'too few elevated cells on A site').toBeGreaterThanOrEqual(0.5);
  });

  test('B site cells in legend have floor between 3.0 and 4.5 m', () => {
    // Truth-rebuild: B site sits at 3.75 m (BombBPlant/BCar truth floorY=3.75,
    // band 3.0-4.5), higher than the old legend's 1.5 m guess. Follow truth.
    const bsite = area('BSite');
    let valid = 0;
    let total = 0;
    for (let c = Math.floor((bsite.min.x - map.origin.x) / map.cellSize);
        c <= Math.ceil((bsite.max.x - map.origin.x) / map.cellSize); c++) {
      for (let r = Math.floor((bsite.min.z - map.origin.z) / map.cellSize);
          r <= Math.ceil((bsite.max.z - map.origin.z) / map.cellSize); r++) {
        if (c < 0 || c >= W || r < 0 || r >= H) continue;
        const le = map.legend[map.grid[r]![c]!];
        if (!le || le.wall) continue;
        total++;
        if (le.floor >= 3.0 && le.floor <= 4.5) valid++;
      }
    }
    expect(total, 'no walkable cells inside BSite rect').toBeGreaterThan(0);
    expect(valid / total, 'B site floor heights out of expected range').toBeGreaterThanOrEqual(0.5);
  });
});

// --- 10. GooseA isolation -----------------------------------------------------

describe('GooseA isolation', () => {
  // GooseA is a dead-end pocket — only accessible via A-site (not via CT-spawn directly
  // without going through A-site first).
  test('GooseA is reachable from A site', () => {
    const asite = area('ASite');
    const [ac, ar] = toCell(rectCenter(asite.min, asite.max).x, rectCenter(asite.min, asite.max).z);
    const parent = bfs(ac, ar);
    const goose = area('GooseA');
    const [gc, gr] = toCell(rectCenter(goose.min, goose.max).x, rectCenter(goose.min, goose.max).z);
    expect(parent.has(gr * W + gc), 'A-site BFS cannot reach GooseA').toBe(true);
  });

  test('GooseA is reachable from T spawn', () => {
    const tStart = map.spawns.t[0]!;
    const [sc, sr] = toCell(tStart.x, tStart.z);
    const parent = bfs(sc, sr);
    const goose = area('GooseA');
    const [gc, gr] = toCell(rectCenter(goose.min, goose.max).x, rectCenter(goose.min, goose.max).z);
    expect(parent.has(gr * W + gc), 'T spawn cannot reach GooseA').toBe(true);
  });
});

// --- 11. Choke widths ----------------------------------------------------------

describe('choke widths', () => {
  // Count the minimum passable cross-section (E-W cols) within an area rect.
  // Scans every row in the area and returns the minimum non-zero count of
  // non-wall cells within the col bounds derived from the area rect.
  function minGapWidth(areaName: string): number {
    const a = area(areaName);
    const colMin = Math.floor((a.min.x - map.origin.x) / map.cellSize);
    const colMax = Math.ceil( (a.max.x - map.origin.x) / map.cellSize);
    const rowMin = Math.floor((a.min.z - map.origin.z) / map.cellSize);
    const rowMax = Math.ceil( (a.max.z - map.origin.z) / map.cellSize);
    let minWidth = Infinity;
    for (let r = rowMin; r <= rowMax; r++) {
      if (r < 0 || r >= H) continue;
      let count = 0;
      for (let c = colMin; c <= colMax; c++) {
        if (c < 0 || c >= W) continue;
        if (!isWallCell(c, r)) count++;
      }
      if (count > 0 && count < minWidth) minWidth = count;
    }
    return minWidth === Infinity ? 0 : minWidth;
  }

  test('LongDoors gap line is 2-4 passable cells wide at its narrowest cross-section', () => {
    // LongDoors area: min x=4, z=2; max x=14, z=16 (cols 52-62, rows 50-64).
    // The narrowest row within that rect is at z=2 (row 50, the LongA mouth)
    // where only 3 of the 11 area-cols are non-wall (the '4'-floor ramp cells).
    const width = minGapWidth('LongDoors');
    expect(width, `LongDoors gap width is ${width}, expected 2-4`).toBeGreaterThanOrEqual(2);
    expect(width, `LongDoors gap width is ${width}, expected 2-4`).toBeLessThanOrEqual(4);
  });

  test('MidDoors gap line is 1-3 passable cells wide at its narrowest cross-section', () => {
    // Truth-rebuild: MidDoors is the narrow 2-wide doorway (truth widthCells=2)
    // gating the mid spine <-> mid-to-B branch, not a wide corridor. The narrowest
    // cross-section within the MidDoors rect is the 1-2 cell door tube.
    const width = minGapWidth('MidDoors');
    expect(width, `MidDoors gap width is ${width}, expected 1-3`).toBeGreaterThanOrEqual(1);
    expect(width, `MidDoors gap width is ${width}, expected 1-3`).toBeLessThanOrEqual(3);
  });
});

// --- 12. Pit <-> LongA round-trip ---------------------------------------------

describe('Pit-LongA round-trip', () => {
  test('BFS from a LongA cell reaches Pit', () => {
    const longA = area('LongA');
    const [lc, lr] = toCell(rectCenter(longA.min, longA.max).x, rectCenter(longA.min, longA.max).z);
    const parent = bfs(lc, lr);
    const pit = area('Pit');
    const [pc, pr] = toCell(rectCenter(pit.min, pit.max).x, rectCenter(pit.min, pit.max).z);
    expect(parent.has(pr * W + pc), 'LongA BFS cannot reach Pit').toBe(true);
  });

  test('BFS from Pit reaches LongA (exit ramp works)', () => {
    const pit = area('Pit');
    const [pc, pr] = toCell(rectCenter(pit.min, pit.max).x, rectCenter(pit.min, pit.max).z);
    const parent = bfs(pc, pr);
    const longA = area('LongA');
    const [lc, lr] = toCell(rectCenter(longA.min, longA.max).x, rectCenter(longA.min, longA.max).z);
    expect(parent.has(lr * W + lc), 'Pit BFS cannot reach LongA (exit ramp broken)').toBe(true);
  });
});

// --- 13. GooseA dead-end (blocking ASite disconnects GooseA from T spawn) ----

describe('GooseA dead-end', () => {
  test('blocking ASite cells disconnects GooseA from T spawn', () => {
    const tStart = map.spawns.t[0]!;
    const [sc, sr] = toCell(tStart.x, tStart.z);
    // BFS from T spawn with all ASite cells blocked.
    const parent = bfs(sc, sr, blockAreas(['ASite']));
    const goose = area('GooseA');
    const [gc, gr] = toCell(rectCenter(goose.min, goose.max).x, rectCenter(goose.min, goose.max).z);
    // GooseA should NOT be reachable when ASite is fully blocked.
    expect(parent.has(gr * W + gc), 'GooseA reachable without going through ASite (not a dead-end)').toBe(false);
  });
});

// --- 14. Site rect areas >= 80 m² --------------------------------------------

describe('site rect areas', () => {
  test('both bombsite rects are at least 80 m²', () => {
    for (const site of map.bombsites) {
      const areaM2 = (site.max.x - site.min.x) * (site.max.z - site.min.z);
      expect(areaM2, `bombsite ${site.name} rect area ${areaM2} m² is below 80 m²`).toBeGreaterThanOrEqual(80);
    }
  });
});

// --- 15. T route LONG_A — every leg bidirectional ----------------------------

describe('T route LONG_A', () => {
  const legs: [string, string][] = [
    ['TSpawn',      'OutsideLong'],
    ['OutsideLong', 'LongDoors'],
    ['LongDoors',   'LongA'],
    ['LongA',       'ARamp'],
    ['ARamp',       'ASite'],
  ];

  for (const [from, to] of legs) {
    test(`${from} → ${to}`, () => {
      const a = area(from);
      const [fc, fr] = toCell(rectCenter(a.min, a.max).x, rectCenter(a.min, a.max).z);
      const parent = bfs(fc, fr);
      const b = area(to);
      const [tc, tr] = toCell(rectCenter(b.min, b.max).x, rectCenter(b.min, b.max).z);
      expect(parent.has(tr * W + tc), `${from} BFS cannot reach ${to}`).toBe(true);
    });

    test(`${to} → ${from}`, () => {
      const b = area(to);
      const [fc, fr] = toCell(rectCenter(b.min, b.max).x, rectCenter(b.min, b.max).z);
      const parent = bfs(fc, fr);
      const a = area(from);
      const [tc, tr] = toCell(rectCenter(a.min, a.max).x, rectCenter(a.min, a.max).z);
      expect(parent.has(tr * W + tc), `${to} BFS cannot reach ${from}`).toBe(true);
    });
  }
});

// --- 16. T route SHORT_A — every leg bidirectional ---------------------------

describe('T route SHORT_A', () => {
  const legs: [string, string][] = [
    ['TSpawn',    'LowerMid'],
    ['LowerMid',  'Catwalk'],
    ['Catwalk',   'AShort'],
    ['AShort',    'ASite'],
  ];

  for (const [from, to] of legs) {
    test(`${from} → ${to}`, () => {
      const a = area(from);
      const [fc, fr] = toCell(rectCenter(a.min, a.max).x, rectCenter(a.min, a.max).z);
      const parent = bfs(fc, fr);
      const b = area(to);
      const [tc, tr] = toCell(rectCenter(b.min, b.max).x, rectCenter(b.min, b.max).z);
      expect(parent.has(tr * W + tc), `${from} BFS cannot reach ${to}`).toBe(true);
    });

    test(`${to} → ${from}`, () => {
      const b = area(to);
      const [fc, fr] = toCell(rectCenter(b.min, b.max).x, rectCenter(b.min, b.max).z);
      const parent = bfs(fc, fr);
      const a = area(from);
      const [tc, tr] = toCell(rectCenter(a.min, a.max).x, rectCenter(a.min, a.max).z);
      expect(parent.has(tr * W + tc), `${to} BFS cannot reach ${from}`).toBe(true);
    });
  }
});

// --- 17. T route TUNNELS_B — every leg bidirectional ------------------------

describe('T route TUNNELS_B', () => {
  const legs: [string, string][] = [
    ['TSpawn',          'OutsideTunnels'],
    ['OutsideTunnels',  'UpperTunnels'],
    ['UpperTunnels',    'BSite'],
  ];

  for (const [from, to] of legs) {
    test(`${from} → ${to}`, () => {
      const a = area(from);
      const [fc, fr] = toCell(rectCenter(a.min, a.max).x, rectCenter(a.min, a.max).z);
      const parent = bfs(fc, fr);
      const b = area(to);
      const [tc, tr] = toCell(rectCenter(b.min, b.max).x, rectCenter(b.min, b.max).z);
      expect(parent.has(tr * W + tc), `${from} BFS cannot reach ${to}`).toBe(true);
    });

    test(`${to} → ${from}`, () => {
      const b = area(to);
      const [fc, fr] = toCell(rectCenter(b.min, b.max).x, rectCenter(b.min, b.max).z);
      const parent = bfs(fc, fr);
      const a = area(from);
      const [tc, tr] = toCell(rectCenter(a.min, a.max).x, rectCenter(a.min, a.max).z);
      expect(parent.has(tr * W + tc), `${to} BFS cannot reach ${from}`).toBe(true);
    });
  }
});

// --- 18. CT routes — every leg bidirectional ---------------------------------

describe('CT routes', () => {
  const legs: [string, string][] = [
    ['CTSpawn',  'CTRamp'],
    ['CTRamp',   'ASite'],
    ['CTSpawn',  'CTMid'],
    ['CTMid',    'TopMid'],
    ['TopMid',   'MidDoors'],
    ['MidDoors', 'LowerMid'],
    ['CTSpawn',  'MidToB'],
    ['MidToB',   'BDoors'],
    ['BDoors',   'BSite'],
  ];

  for (const [from, to] of legs) {
    test(`${from} → ${to}`, () => {
      const a = area(from);
      const [fc, fr] = toCell(rectCenter(a.min, a.max).x, rectCenter(a.min, a.max).z);
      const parent = bfs(fc, fr);
      const b = area(to);
      const [tc, tr] = toCell(rectCenter(b.min, b.max).x, rectCenter(b.min, b.max).z);
      expect(parent.has(tr * W + tc), `CT ${from} BFS cannot reach ${to}`).toBe(true);
    });

    test(`${to} → ${from}`, () => {
      const b = area(to);
      const [fc, fr] = toCell(rectCenter(b.min, b.max).x, rectCenter(b.min, b.max).z);
      const parent = bfs(fc, fr);
      const a = area(from);
      const [tc, tr] = toCell(rectCenter(a.min, a.max).x, rectCenter(a.min, a.max).z);
      expect(parent.has(tr * W + tc), `CT ${to} BFS cannot reach ${from}`).toBe(true);
    });
  }
});

// --- 19. All T spawns reach both bombsites ------------------------------------

describe('T spawns to bombsites', () => {
  for (let i = 0; i < map.spawns.t.length; i++) {
    const sp = map.spawns.t[i]!;
    test(`T spawn ${i} (${sp.x},${sp.z}) reaches A site`, () => {
      const [sc, sr] = toCell(sp.x, sp.z);
      const parent = bfs(sc, sr);
      const asite = map.bombsites.find(b => b.name === 'A')!;
      const [tc, tr] = toCell(rectCenter(asite.min, asite.max).x, rectCenter(asite.min, asite.max).z);
      expect(parent.has(tr * W + tc), `T spawn ${i} cannot reach A site`).toBe(true);
    });

    test(`T spawn ${i} (${sp.x},${sp.z}) reaches B site`, () => {
      const [sc, sr] = toCell(sp.x, sp.z);
      const parent = bfs(sc, sr);
      const bsite = map.bombsites.find(b => b.name === 'B')!;
      const [tc, tr] = toCell(rectCenter(bsite.min, bsite.max).x, rectCenter(bsite.min, bsite.max).z);
      expect(parent.has(tr * W + tc), `T spawn ${i} cannot reach B site`).toBe(true);
    });
  }
});

// --- 20. All CT spawns reach both bombsites -----------------------------------

describe('CT spawns to bombsites', () => {
  for (let i = 0; i < map.spawns.ct.length; i++) {
    const sp = map.spawns.ct[i]!;
    test(`CT spawn ${i} (${sp.x},${sp.z}) reaches A site`, () => {
      const [sc, sr] = toCell(sp.x, sp.z);
      const parent = bfs(sc, sr);
      const asite = map.bombsites.find(b => b.name === 'A')!;
      const [tc, tr] = toCell(rectCenter(asite.min, asite.max).x, rectCenter(asite.min, asite.max).z);
      expect(parent.has(tr * W + tc), `CT spawn ${i} cannot reach A site`).toBe(true);
    });

    test(`CT spawn ${i} (${sp.x},${sp.z}) reaches B site`, () => {
      const [sc, sr] = toCell(sp.x, sp.z);
      const parent = bfs(sc, sr);
      const bsite = map.bombsites.find(b => b.name === 'B')!;
      const [tc, tr] = toCell(rectCenter(bsite.min, bsite.max).x, rectCenter(bsite.min, bsite.max).z);
      expect(parent.has(tr * W + tc), `CT spawn ${i} cannot reach B site`).toBe(true);
    });
  }
});

// --- 21. Plantable cells in bomb sites ----------------------------------------

describe('plantable cells', () => {
  function countWalkableInRect(areaMin: { x: number; z: number }, areaMax: { x: number; z: number }): number {
    const colMin = Math.floor((areaMin.x - map.origin.x) / map.cellSize);
    const colMax = Math.ceil( (areaMax.x - map.origin.x) / map.cellSize);
    const rowMin = Math.floor((areaMin.z - map.origin.z) / map.cellSize);
    const rowMax = Math.ceil( (areaMax.z - map.origin.z) / map.cellSize);
    let count = 0;
    for (let r = rowMin; r <= rowMax; r++) {
      if (r < 0 || r >= H) continue;
      for (let c = colMin; c <= colMax; c++) {
        if (c < 0 || c >= W) continue;
        const le = map.legend[map.grid[r]![c]!];
        if (le && !le.wall) count++;
      }
    }
    return count;
  }

  test('A site has at least 25 walkable (plantable) cells', () => {
    const asite = map.bombsites.find(b => b.name === 'A')!;
    const count = countWalkableInRect(asite.min, asite.max);
    expect(count, `A site only has ${count} walkable cells`).toBeGreaterThanOrEqual(25);
  });

  test('B site has at least 25 walkable (plantable) cells', () => {
    const bsite = map.bombsites.find(b => b.name === 'B')!;
    const count = countWalkableInRect(bsite.min, bsite.max);
    expect(count, `B site only has ${count} walkable cells`).toBeGreaterThanOrEqual(25);
  });

  test('all cells inside A site rect that are walkable are reachable from T spawn 0', () => {
    const sp = map.spawns.t[0]!;
    const [sc, sr] = toCell(sp.x, sp.z);
    const parent = bfs(sc, sr);
    const asite = map.bombsites.find(b => b.name === 'A')!;
    const colMin = Math.floor((asite.min.x - map.origin.x) / map.cellSize);
    const colMax = Math.ceil( (asite.max.x - map.origin.x) / map.cellSize);
    const rowMin = Math.floor((asite.min.z - map.origin.z) / map.cellSize);
    const rowMax = Math.ceil( (asite.max.z - map.origin.z) / map.cellSize);
    let unreachable = 0;
    for (let r = rowMin; r <= rowMax; r++) {
      if (r < 0 || r >= H) continue;
      for (let c = colMin; c <= colMax; c++) {
        if (c < 0 || c >= W) continue;
        const le = map.legend[map.grid[r]![c]!];
        if (!le || le.wall) continue;
        if (!parent.has(r * W + c)) unreachable++;
      }
    }
    expect(unreachable, `${unreachable} walkable A site cells unreachable from T spawn`).toBe(0);
  });

  test('all cells inside B site rect that are walkable are reachable from T spawn 0', () => {
    const sp = map.spawns.t[0]!;
    const [sc, sr] = toCell(sp.x, sp.z);
    const parent = bfs(sc, sr);
    const bsite = map.bombsites.find(b => b.name === 'B')!;
    const colMin = Math.floor((bsite.min.x - map.origin.x) / map.cellSize);
    const colMax = Math.ceil( (bsite.max.x - map.origin.x) / map.cellSize);
    const rowMin = Math.floor((bsite.min.z - map.origin.z) / map.cellSize);
    const rowMax = Math.ceil( (bsite.max.z - map.origin.z) / map.cellSize);
    let unreachable = 0;
    for (let r = rowMin; r <= rowMax; r++) {
      if (r < 0 || r >= H) continue;
      for (let c = colMin; c <= colMax; c++) {
        if (c < 0 || c >= W) continue;
        const le = map.legend[map.grid[r]![c]!];
        if (!le || le.wall) continue;
        if (!parent.has(r * W + c)) unreachable++;
      }
    }
    expect(unreachable, `${unreachable} walkable B site cells unreachable from T spawn`).toBe(0);
  });
});

// --- 22. One-way drops verified -----------------------------------------------

describe('one-way drops', () => {
  // Long → pit drop: long ledge (L = 3.75) to pit floor (8 = 3.0) col79→col80 is
  // a 0.75 m drop (ok); the reverse climb is blocked by the height difference.
  // (Truth-rebuild: catwalk/mid are co-planar at 3.75, so the pit is the genuine
  //  one-way height drop — see block 7.)
  test('long→pit drop (col79→col80, row56): drop direction passes', () => {
    const [c0, r0] = [79, 56]; // long ledge (floor 3.75)
    const [c1, r1] = [80, 56]; // pit floor (3.0)
    expect(passable(c0, r0, c1, r1), 'drop long→pit should be passable').toBe(true);
  });

  test('pit→long climb (col80→col79, row56): climb 0.75m is blocked', () => {
    const [c0, r0] = [80, 56]; // pit floor (3.0)
    const [c1, r1] = [79, 56]; // long ledge (3.75)
    expect(passable(c0, r0, c1, r1), 'climb pit→long should be blocked (diff 0.75 > 0.5)').toBe(false);
  });

  test('T spawn plateau→fan-out: bot can leave T spawn toward the routes', () => {
    // T spawn (S=4.5 rows 80-88) opens north onto the fan-out plateau (f=4.5):
    // same height, both walkable, at the spawn exit gap.
    expect(passable(42, 80, 42, 79), 'T spawn north exit should be passable').toBe(true);
  });

  test('LongA→Pit drop: BFS from LongA reaches Pit via the one-way drop', () => {
    // Pit is accessible via a drop from LongA; exact boundary cells vary by row.
    // The Pit area starts at col 89, row 19 (approx). Verify BFS from LongA can reach Pit.
    const longA = area('LongA');
    const [lc, lr] = toCell(rectCenter(longA.min, longA.max).x, rectCenter(longA.min, longA.max).z);
    const parent = bfs(lc, lr);
    const pit = area('Pit');
    const [pc, pr] = toCell(rectCenter(pit.min, pit.max).x, rectCenter(pit.min, pit.max).z);
    expect(parent.has(pr * W + pc), 'LongA cannot reach Pit via drop').toBe(true);
  });
});

// --- 23. Additional choke widths ----------------------------------------------

describe('additional choke widths', () => {
  // UpperTunnels corridor must be at least 5 cells wide (generous — covers u cells).
  test('UpperTunnels corridor is at least 5 passable cells wide in NS direction', () => {
    const ut = area('UpperTunnels');
    // Count non-wall cells in a column through the middle of UpperTunnels.
    const midCol = Math.floor((rectCenter(ut.min, ut.max).x - map.origin.x) / map.cellSize);
    const rowMin = Math.floor((ut.min.z - map.origin.z) / map.cellSize);
    const rowMax = Math.ceil( (ut.max.z - map.origin.z) / map.cellSize);
    let count = 0;
    for (let r = rowMin; r <= rowMax; r++) {
      if (r < 0 || r >= H) continue;
      if (!isWallCell(midCol, r)) count++;
    }
    expect(count, `UpperTunnels NS depth is only ${count} cells`).toBeGreaterThanOrEqual(5);
  });

  // T spawn plateau must be at least 10 cells wide EW.
  test('T spawn plateau is at least 10 cells wide (EW)', () => {
    const tSpawn = area('TSpawn');
    const midRow = Math.floor((rectCenter(tSpawn.min, tSpawn.max).z - map.origin.z) / map.cellSize);
    const colMin = Math.floor((tSpawn.min.x - map.origin.x) / map.cellSize);
    const colMax = Math.ceil( (tSpawn.max.x - map.origin.x) / map.cellSize);
    let count = 0;
    for (let c = colMin; c <= colMax; c++) {
      if (c < 0 || c >= W) continue;
      if (!isWallCell(c, midRow)) count++;
    }
    expect(count, `T spawn EW width is only ${count} cells`).toBeGreaterThanOrEqual(10);
  });

  // B site must be at least 8 cells wide EW and 8 NS (solid site footprint).
  test('B site is at least 8x8 cells of walkable terrain', () => {
    const bsite = area('BSite');
    const colMin = Math.floor((bsite.min.x - map.origin.x) / map.cellSize);
    const colMax = Math.ceil( (bsite.max.x - map.origin.x) / map.cellSize);
    const rowMin = Math.floor((bsite.min.z - map.origin.z) / map.cellSize);
    const rowMax = Math.ceil( (bsite.max.z - map.origin.z) / map.cellSize);
    const ewWidth = colMax - colMin;
    const nsDepth = rowMax - rowMin;
    expect(ewWidth, `B site EW span too narrow: ${ewWidth}`).toBeGreaterThanOrEqual(8);
    expect(nsDepth, `B site NS depth too shallow: ${nsDepth}`).toBeGreaterThanOrEqual(8);
  });

  // A site must be at least 15 cells wide EW (it spans cols ~62-88 = 26 cells).
  test('A site is at least 15 cells wide (EW)', () => {
    const asite = area('ASite');
    const colMin = Math.floor((asite.min.x - map.origin.x) / map.cellSize);
    const colMax = Math.ceil( (asite.max.x - map.origin.x) / map.cellSize);
    const ewWidth = colMax - colMin;
    expect(ewWidth, `A site EW span too narrow: ${ewWidth}`).toBeGreaterThanOrEqual(15);
  });
});

// --- 24. Forced cross-team routes (CT side access validation) -----------------

describe('CT side forced routes', () => {
  function ctBfs(spawnIdx: number): Map<number, number> {
    const sp = map.spawns.ct[spawnIdx]!;
    const [sc, sr] = toCell(sp.x, sp.z);
    return bfs(sc, sr);
  }

  test('CT spawn 0 can reach UpperTunnels (via MidToB)', () => {
    const parent = ctBfs(0);
    const ut = area('UpperTunnels');
    const [tc, tr] = toCell(rectCenter(ut.min, ut.max).x, rectCenter(ut.min, ut.max).z);
    expect(parent.has(tr * W + tc), 'CT spawn cannot reach UpperTunnels').toBe(true);
  });

  test('CT spawn 0 can reach LongA (via CT ramp or A site)', () => {
    const parent = ctBfs(0);
    const la = area('LongA');
    const [tc, tr] = toCell(rectCenter(la.min, la.max).x, rectCenter(la.min, la.max).z);
    expect(parent.has(tr * W + tc), 'CT spawn cannot reach LongA').toBe(true);
  });

  test('CT spawn 0 can reach Catwalk', () => {
    const parent = ctBfs(0);
    const cat = area('Catwalk');
    const [tc, tr] = toCell(rectCenter(cat.min, cat.max).x, rectCenter(cat.min, cat.max).z);
    expect(parent.has(tr * W + tc), 'CT spawn cannot reach Catwalk').toBe(true);
  });

  test('CT spawn 0 can reach OutsideTunnels', () => {
    const parent = ctBfs(0);
    const ot = area('OutsideTunnels');
    const [tc, tr] = toCell(rectCenter(ot.min, ot.max).x, rectCenter(ot.min, ot.max).z);
    expect(parent.has(tr * W + tc), 'CT spawn cannot reach OutsideTunnels').toBe(true);
  });

  test('CT spawn 0 can reach OutsideLong', () => {
    const parent = ctBfs(0);
    const ol = area('OutsideLong');
    const [tc, tr] = toCell(rectCenter(ol.min, ol.max).x, rectCenter(ol.min, ol.max).z);
    expect(parent.has(tr * W + tc), 'CT spawn cannot reach OutsideLong').toBe(true);
  });
});

// --- 25. Cross-route connectivity (mid ↔ tunnels ↔ long) ----------------------

describe('cross-route connectivity', () => {
  test('MidDoors ↔ LowerTunnels connected (mid-to-B passage)', () => {
    const md = area('MidDoors');
    const [mc, mr] = toCell(rectCenter(md.min, md.max).x, rectCenter(md.min, md.max).z);
    const parent = bfs(mc, mr);
    const lt = area('LowerTunnels');
    const [tc, tr] = toCell(rectCenter(lt.min, lt.max).x, rectCenter(lt.min, lt.max).z);
    expect(parent.has(tr * W + tc), 'MidDoors BFS cannot reach LowerTunnels').toBe(true);
  });

  test('LowerTunnels ↔ UpperTunnels connected (tunnels passage)', () => {
    const lt = area('LowerTunnels');
    const [lc, lr] = toCell(rectCenter(lt.min, lt.max).x, rectCenter(lt.min, lt.max).z);
    const parent = bfs(lc, lr);
    const ut = area('UpperTunnels');
    const [tc, tr] = toCell(rectCenter(ut.min, ut.max).x, rectCenter(ut.min, ut.max).z);
    expect(parent.has(tr * W + tc), 'LowerTunnels BFS cannot reach UpperTunnels').toBe(true);
  });

  test('reverse: UpperTunnels ↔ LowerTunnels (both directions)', () => {
    const ut = area('UpperTunnels');
    const [uc, ur] = toCell(rectCenter(ut.min, ut.max).x, rectCenter(ut.min, ut.max).z);
    const parent = bfs(uc, ur);
    const lt = area('LowerTunnels');
    const [tc, tr] = toCell(rectCenter(lt.min, lt.max).x, rectCenter(lt.min, lt.max).z);
    expect(parent.has(tr * W + tc), 'UpperTunnels BFS cannot reach LowerTunnels').toBe(true);
  });

  test('TopMid ↔ Catwalk connected', () => {
    const tm = area('TopMid');
    const [tc2, tr2] = toCell(rectCenter(tm.min, tm.max).x, rectCenter(tm.min, tm.max).z);
    const parent = bfs(tc2, tr2);
    const cat = area('Catwalk');
    const [cc, cr] = toCell(rectCenter(cat.min, cat.max).x, rectCenter(cat.min, cat.max).z);
    expect(parent.has(cr * W + cc), 'TopMid BFS cannot reach Catwalk').toBe(true);
  });

  test('AShort ↔ ASite connected', () => {
    const ash = area('AShort');
    const [ac, ar] = toCell(rectCenter(ash.min, ash.max).x, rectCenter(ash.min, ash.max).z);
    const parent = bfs(ac, ar);
    const asite = area('ASite');
    const [tc, tr] = toCell(rectCenter(asite.min, asite.max).x, rectCenter(asite.min, asite.max).z);
    expect(parent.has(tr * W + tc), 'AShort BFS cannot reach ASite').toBe(true);
  });

  test('CTRamp ↔ ASite connected (CT route to A)', () => {
    const ramp = area('CTRamp');
    const [rc, rr] = toCell(rectCenter(ramp.min, ramp.max).x, rectCenter(ramp.min, ramp.max).z);
    const parent = bfs(rc, rr);
    const asite = area('ASite');
    const [tc, tr] = toCell(rectCenter(asite.min, asite.max).x, rectCenter(asite.min, asite.max).z);
    expect(parent.has(tr * W + tc), 'CTRamp BFS cannot reach ASite').toBe(true);
  });
});
