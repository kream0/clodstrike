import { describe, expect, test } from 'bun:test';
import type { CellLegend, MapData, NamedArea, Vec2 } from '../types';
import { DUST2 } from './dust2';

const map: MapData = DUST2;
const W = 96;
const H = 88;

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
  test('grid is 96x88 and every char is in the legend', () => {
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
  test('spawns, bombsite centers and area centers are on non-wall cells with floor < 3.5', () => {
    const points: { label: string; p: Vec2 }[] = [
      ...map.spawns.t.map((s, i) => ({ label: `t spawn ${i}`, p: { x: s.x, z: s.z } })),
      ...map.spawns.ct.map((s, i) => ({ label: `ct spawn ${i}`, p: { x: s.x, z: s.z } })),
      ...map.bombsites.map((b) => ({ label: `bombsite ${b.name}`, p: rectCenter(b.min, b.max) })),
      ...map.areas.map((a) => ({ label: `area ${a.name}`, p: rectCenter(a.min, a.max) })),
    ];
    for (const { label, p } of points) {
      const [c, r] = toCell(p.x, p.z);
      expect(isWallCell(c, r), `${label} is on a wall cell`).toBe(false);
      expect(legendAt(c, r).floor, `${label} floor too high`).toBeLessThan(3.5);
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
    assertForcedRoute(rectCenter(b.min, b.max), ['MidDoors', 'LongDoors', 'Catwalk'], 'UpperTunnels');
  });

  test('T spawn -> A site passes through LongDoors', () => {
    const a = map.bombsites.find((x) => x.name === 'A')!;
    assertForcedRoute(rectCenter(a.min, a.max), ['MidDoors', 'UpperTunnels', 'Catwalk'], 'LongDoors');
  });
});
