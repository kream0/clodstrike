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

  test('T spawn -> CT mid passes through MidDoors', () => {
    const a = area('CTMid');
    assertForcedRoute(rectCenter(a.min, a.max), ['UpperTunnels', 'LongDoors', 'Catwalk'], 'MidDoors');
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

// --- 7. one-way catwalk drop -----------------------------------------------

describe('one-way catwalk', () => {
  // Catwalk (c = 2.25) is accessible from TopMid (M = 0.0) via short stairs,
  // but not directly climbable from LowerMid (M = 0.0) into catwalk (diff 2.25 > 0.5).
  // Verify the climb is blocked and the drop works.
  test('catwalk cell is reachable from T spawn via short stairs', () => {
    const tStart = map.spawns.t[0]!;
    const [sc, sr] = toCell(tStart.x, tStart.z);
    const parent = bfs(sc, sr);
    const cat = area('Catwalk');
    const [cc, cr] = toCell(rectCenter(cat.min, cat.max).x, rectCenter(cat.min, cat.max).z);
    expect(parent.has(cr * W + cc), 'T spawn cannot reach catwalk').toBe(true);
  });

  test('direct climb from LowerMid floor into catwalk floor is blocked (height diff > 0.5)', () => {
    // Spot-check: a cell at height M(0.0) in TopMid cannot step directly UP into c(2.25)
    // at a known adjacent pair — col 45(M=0.0) row 40 adjacent to col 46(c=2.25) row 40
    const [c0, r0] = [45, 40]; // TopMid cell (floor 0.0)
    const [c1, r1] = [46, 40]; // first catwalk column (floor 2.25)
    // Only passable if climb <= 0.5; going from M(0) to c(2.25) = diff 2.25 -> blocked
    expect(passable(c0, r0, c1, r1), 'direct climb into catwalk should be blocked').toBe(false);
    // Drop direction (c(2.25) -> M(0.0)) is passable (any drop allowed)
    expect(passable(c1, r1, c0, r0), 'drop from catwalk should be passable').toBe(true);
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

  test('B site cells in legend have floor between 1.0 and 2.5 m', () => {
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
        if (le.floor >= 1.0 && le.floor <= 2.5) valid++;
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

  test('MidDoors gap line is 4-8 passable cells wide at its narrowest cross-section', () => {
    // MidDoors area: min x=-10, z=-8; max x=-2, z=4 (cols 38-46, rows 40-52).
    // The narrowest rows within the rect (rows 45-51) contain 6 D-floor cells,
    // which is the actual mid-corridor width.
    const width = minGapWidth('MidDoors');
    expect(width, `MidDoors gap width is ${width}, expected 4-8`).toBeGreaterThanOrEqual(4);
    expect(width, `MidDoors gap width is ${width}, expected 4-8`).toBeLessThanOrEqual(8);
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
