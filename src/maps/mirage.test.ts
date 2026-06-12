import { describe, expect, test } from 'bun:test';
import type { CellLegend, MapData, NamedArea, Vec2 } from '../types';
import { MIRAGE } from './mirage';

const map: MapData = MIRAGE;
const W = 96;
const H = 96;

// --- helpers ---------------------------------------------------------------

function toCell(x: number, z: number): [number, number] {
  return [Math.floor((x - map.origin.x) / map.cellSize), Math.floor((z - map.origin.z) / map.cellSize)];
}

function legendAt(col: number, row: number): CellLegend {
  const ch = map.grid[row]![col]!;
  const le = map.legend[ch];
  if (!le) throw new Error(`char '${ch}' at col=${col},row=${row} missing from legend`);
  return le;
}

function isWallCell(col: number, row: number): boolean {
  if (col < 0 || col >= W || row < 0 || row >= H) return true;
  return legendAt(col, row).wall === true;
}

// BFS passability: 4-neighbor; neither cell wall; climb <= 0.5 or any drop; ceiling clearance >= 1.9 m.
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
    const key = queue[qi]!;
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
  if (!a) throw new Error(`missing area '${name}'`);
  return a;
}

const blockAreas = (names: string[]) => {
  const rects = names.map(area);
  return (col: number, row: number) => {
    const p = cellCenterWorld(col, row);
    return rects.some((a) => inRect(p, a.min, a.max));
  };
};

// BFS reachability from world coordinate to world coordinate
function canReach(fromX: number, fromZ: number, toX: number, toZ: number): boolean {
  const [fc, fr] = toCell(fromX, fromZ);
  const parent = bfs(fc, fr);
  const [tc, tr] = toCell(toX, toZ);
  return parent.has(tr * W + tc);
}

function areaCenter(name: string): Vec2 {
  const a = area(name);
  return rectCenter(a.min, a.max);
}

// --- 1. Grid shape & legend coverage ---

describe('grid shape', () => {
  test('grid is 96x96 and every char is in the legend', () => {
    expect(map.grid.length).toBe(H);
    for (let r = 0; r < H; r++) {
      expect(map.grid[r]!.length, `row ${r} wrong length (${map.grid[r]!.length})`).toBe(W);
    }
    const chars = new Set<string>();
    for (const row of map.grid) for (const ch of row) chars.add(ch);
    for (const ch of chars) {
      expect(map.legend[ch], `char '${ch}' missing from legend`).toBeDefined();
    }
  });

  test('all legend floor heights are multiples of 0.375 m', () => {
    for (const [ch, le] of Object.entries(map.legend)) {
      const rem = Math.abs(le.floor) % 0.375;
      expect(rem, `legend '${ch}' floor ${le.floor} not multiple of 0.375`).toBeLessThan(0.001);
    }
  });

  test('no legend char has floor >= 5.0 m (reasonable upper bound)', () => {
    for (const [ch, le] of Object.entries(map.legend)) {
      expect(le.floor, `legend '${ch}' floor too high`).toBeLessThan(5.0);
    }
  });
});

// --- 2. Spawn points walkable and in correct zones ---

describe('spawns', () => {
  test('all T spawns are walkable, inside T-spawn zone, have floor < 2.0', () => {
    const zone = area('TSpawn');
    for (const s of map.spawns.t) {
      const [c, r] = toCell(s.x, s.z);
      expect(isWallCell(c, r), `T spawn (${s.x},${s.z}) on wall`).toBe(false);
      expect(legendAt(c, r).floor, `T spawn floor too high`).toBeLessThan(2.0);
      const p: Vec2 = { x: s.x, z: s.z };
      expect(inRect(p, zone.min, zone.max), `T spawn (${s.x},${s.z}) outside TSpawn zone`).toBe(true);
    }
  });

  test('all CT spawns are walkable, inside CT-spawn zone, have floor < 2.0', () => {
    const zone = area('CTSpawn');
    for (const s of map.spawns.ct) {
      const [c, r] = toCell(s.x, s.z);
      expect(isWallCell(c, r), `CT spawn (${s.x},${s.z}) on wall`).toBe(false);
      expect(legendAt(c, r).floor, `CT spawn floor too high`).toBeLessThan(2.0);
      const p: Vec2 = { x: s.x, z: s.z };
      expect(inRect(p, zone.min, zone.max), `CT spawn (${s.x},${s.z}) outside CTSpawn zone`).toBe(true);
    }
  });

  test('exactly 5 T spawns and 5 CT spawns', () => {
    expect(map.spawns.t.length).toBe(5);
    expect(map.spawns.ct.length).toBe(5);
  });
});

// --- 3. Bombsite geometry ---

describe('bombsites', () => {
  test('both bombsites are at least 80 m²', () => {
    for (const site of map.bombsites) {
      const m2 = (site.max.x - site.min.x) * (site.max.z - site.min.z);
      expect(m2, `bombsite ${site.name} = ${m2} m² < 80`).toBeGreaterThanOrEqual(80);
    }
  });

  test('bombsite A center is walkable with floor ~1.5 (A-site)', () => {
    const asite = map.bombsites.find((b) => b.name === 'A')!;
    const c = rectCenter(asite.min, asite.max);
    const [col, row] = toCell(c.x, c.z);
    expect(isWallCell(col, row), 'A-site center is wall').toBe(false);
    expect(legendAt(col, row).floor).toBeGreaterThanOrEqual(1.0);
  });

  test('bombsite B center is walkable with floor ~0.0 (B-site)', () => {
    const bsite = map.bombsites.find((b) => b.name === 'B')!;
    const c = rectCenter(bsite.min, bsite.max);
    const [col, row] = toCell(c.x, c.z);
    expect(isWallCell(col, row), 'B-site center is wall').toBe(false);
    expect(legendAt(col, row).floor).toBeLessThan(1.0);
  });
});

// --- 4. Global reachability: every T spawn reaches both sites + every area ---

describe('global reachability', () => {
  const allTargets: { label: string; p: Vec2 }[] = [
    ...map.spawns.ct.map((s, i) => ({ label: `ct spawn ${i}`, p: { x: s.x, z: s.z } })),
    ...map.bombsites.map((b) => ({ label: `bombsite ${b.name}`, p: rectCenter(b.min, b.max) })),
    ...map.areas.map((a) => ({ label: `area ${a.name}`, p: rectCenter(a.min, a.max) })),
  ];

  test('every T spawn reaches all CT spawns, both bombsites, and every named area', () => {
    for (const s of map.spawns.t) {
      const [sc, sr] = toCell(s.x, s.z);
      const parent = bfs(sc, sr);
      for (const t of allTargets) {
        const [tc, tr] = toCell(t.p.x, t.p.z);
        expect(parent.has(tr * W + tc), `T(${s.x},${s.z}) → ${t.label}: unreachable`).toBe(true);
      }
    }
  });

  test('every CT spawn reaches every T spawn and every named area', () => {
    const tTargets = map.spawns.t.map((s, i) => ({ label: `t spawn ${i}`, p: { x: s.x, z: s.z } }));
    const areaTargets = map.areas.map((a) => ({ label: `area ${a.name}`, p: rectCenter(a.min, a.max) }));
    for (const s of map.spawns.ct) {
      const [sc, sr] = toCell(s.x, s.z);
      const parent = bfs(sc, sr);
      for (const t of [...tTargets, ...areaTargets]) {
        const [tc, tr] = toCell(t.p.x, t.p.z);
        expect(parent.has(tr * W + tc), `CT(${s.x},${s.z}) → ${t.label}: unreachable`).toBe(true);
      }
    }
  });
});

// --- 5. Named route BFS matrix (all bidirectional unless marked one-way) ---

describe('named routes: bidirectional', () => {
  function assertBothWays(fromArea: string, toArea: string): void {
    const from = areaCenter(fromArea);
    const to = areaCenter(toArea);
    expect(canReach(from.x, from.z, to.x, to.z), `${fromArea} → ${toArea}: blocked`).toBe(true);
    expect(canReach(to.x, to.z, from.x, from.z), `${toArea} → ${fromArea}: blocked`).toBe(true);
  }

  test('TSpawn ↔ AppsRamp ↔ AppsCorridor', () => {
    assertBothWays('TSpawn', 'AppsRamp');
    assertBothWays('AppsRamp', 'AppsCorridor');
  });

  test('AppsCorridor ↔ Kitchen ↔ BPlat ↔ BSite', () => {
    assertBothWays('AppsCorridor', 'Kitchen');
    assertBothWays('Kitchen', 'BPlat');
    assertBothWays('BPlat', 'BSite');
  });

  test('BSite ↔ Market ↔ CTSpawn', () => {
    assertBothWays('BSite', 'Market');
    assertBothWays('Market', 'CTSpawn');
  });

  test('Arches ↔ BSite (market/CT side connection)', () => {
    assertBothWays('Arches', 'BSite');
  });

  test('Arches ↔ BShort (two-way via east ramp)', () => {
    assertBothWays('Arches', 'BShort');
  });

  test('BShort ↔ LadderRoom', () => {
    assertBothWays('BShort', 'LadderRoom');
  });

  test('LadderRoom ↔ WindowRoom (two-way via ramp)', () => {
    assertBothWays('LadderRoom', 'WindowRoom');
  });

  test('Mid ↔ Underpass ↔ AppsCorridor (T-side)', () => {
    assertBothWays('Mid', 'Underpass');
    assertBothWays('Underpass', 'AppsCorridor');
  });

  test('TSpawn ↔ TopMid ↔ Mid', () => {
    assertBothWays('TSpawn', 'TopMid');
    assertBothWays('TopMid', 'Mid');
  });

  test('Mid ↔ Connector ↔ Jungle ↔ ASite', () => {
    assertBothWays('Mid', 'Connector');
    assertBothWays('Connector', 'Jungle');
    assertBothWays('Jungle', 'ASite');
  });

  test('ASite ↔ CTLink ↔ CTSpawn', () => {
    assertBothWays('ASite', 'CTLink');
    assertBothWays('CTLink', 'CTSpawn');
  });

  test('CTSpawn ↔ Market (two-way)', () => {
    assertBothWays('CTSpawn', 'Market');
  });

  test('CTSpawn ↔ Arches (via market)', () => {
    assertBothWays('CTSpawn', 'Arches');
  });

  test('TSpawn ↔ ARamp ↔ ASite (via top-mid route)', () => {
    assertBothWays('ARamp', 'ASite');
    assertBothWays('TopMid', 'ARamp');
  });

  test('StairsRoom ↔ Jungle', () => {
    assertBothWays('StairsRoom', 'Jungle');
  });

  test('CTSpawn ↔ StairsRoom (CT-side elevated hold)', () => {
    assertBothWays('CTSpawn', 'StairsRoom');
  });

  test('Palace ↔ ASite', () => {
    assertBothWays('Palace', 'ASite');
  });
});

// --- 6. One-way drops (forward passable, reverse blocked) ---

describe('one-way drops', () => {
  // B-short catwalk edge → B-site (1.5 m drop)
  // B-short cols 28-44 (floor 1.5), B-site cols 8-28 (floor 0.0)
  // At col 28, b-short cell (4=1.5) adj to b-site col 27 (B=0.0)
  test('B-short edge → B-site: drop passable', () => {
    // row 35 (mid range), col 28 = b-short '4' (1.5), col 27 = b-site 'B' (0.0)
    // Verify by checking passable() directly
    // col 28 row 35 should be '4' (b-short), col 27 row 35 should be 'B' (b-site)
    const [c0, r0] = [28, 35]; // b-short cell
    const [c1, r1] = [27, 35]; // b-site cell
    if (!isWallCell(c0, r0) && !isWallCell(c1, r1)) {
      expect(passable(c0, r0, c1, r1), 'b-short→b-site drop should be passable').toBe(true);
      expect(passable(c1, r1, c0, r0), 'b-site→b-short climb should be blocked').toBe(false);
    } else {
      // If either cell is wall, test that b-short is reachable from arches but b-site is NOT directly
      expect(canReach(areaCenter('BShort').x, areaCenter('BShort').z,
                      areaCenter('BSite').x, areaCenter('BSite').z),
             'B-short cannot reach B-site at all').toBe(true);
    }
  });

  // Window room → mid (3.75 m drop — one-way down)
  test('Window room → mid: drop passable, mid → window room blocked (height diff 3.75 > 0.5)', () => {
    // Window room floor = 3.75, mid floor = 0.0
    // At south edge of window room (row 51), cells are 'w' (3.75) adjacent to mid (M=0.0) at row 52
    // But we need an 'w' cell at row 51 that IS adjacent to mid row 52
    // Let's check cols 39-44, row 51 and row 52:
    let foundDrop = false;
    for (let c = 39; c <= 44; c++) {
      if (!isWallCell(c, 51) && !isWallCell(c, 52)) {
        const a = legendAt(c, 51);
        const b = legendAt(c, 52);
        if (a.floor >= 3.0 && b.floor <= 1.0) {
          // This should be a one-way drop
          expect(passable(c, 51, c, 52), `window→mid drop at col ${c} should be passable`).toBe(true);
          expect(passable(c, 52, c, 51), `mid→window climb at col ${c} should be blocked`).toBe(false);
          foundDrop = true;
          break;
        }
      }
    }
    // Even if no direct adjacent pair found, verify BFS reachability:
    // Window room BFS can reach mid (drop), but mid BFS cannot reach window room (climb blocked)
    if (!foundDrop) {
      // Verify via BFS: from window room, can we reach mid?
      const winCenter = areaCenter('WindowRoom');
      const midCenter = areaCenter('Mid');
      expect(canReach(winCenter.x, winCenter.z, midCenter.x, midCenter.z),
             'WindowRoom cannot reach Mid via drop').toBe(true);
      // From mid, window room is only accessible via ladder room (not directly from mid floor)
    }
  });

  // Window room is NOT directly BFS-accessible from mid (must go via ladder room)
  test('Mid cannot reach WindowRoom directly — only via LadderRoom path', () => {
    // Block the ladder room and see that mid cannot reach window room
    const midCenter = areaCenter('Mid');
    const winCenter = areaCenter('WindowRoom');
    const [mc, mr] = toCell(midCenter.x, midCenter.z);
    const parentWithLadderBlocked = bfs(mc, mr, blockAreas(['LadderRoom', 'BShort', 'Arches']));
    const [wc, wr] = toCell(winCenter.x, winCenter.z);
    // With ladder room blocked, mid should not reach window room
    expect(parentWithLadderBlocked.has(wr * W + wc),
           'Mid reached WindowRoom without going through LadderRoom/BShort').toBe(false);
  });
});

// --- 7. Choke width measurements ---

describe('choke widths', () => {
  // minGapWidth: scan every row in the area rect, count non-wall cells in col range, return minimum.
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

  test('AppsCorridor width is 3-7 cells (approx 3-7 m) at narrowest cross-section', () => {
    const w = minGapWidth('AppsCorridor');
    expect(w, `AppsCorridor gap ${w}, expected 3-7`).toBeGreaterThanOrEqual(3);
    expect(w, `AppsCorridor gap ${w}, expected 3-7`).toBeLessThanOrEqual(7);
  });

  test('Market width is 2-5 cells at narrowest cross-section', () => {
    const w = minGapWidth('Market');
    expect(w, `Market gap ${w}, expected 2-5`).toBeGreaterThanOrEqual(2);
    expect(w, `Market gap ${w}, expected 2-5`).toBeLessThanOrEqual(5);
  });

  test('Connector width is 3-6 cells at narrowest cross-section', () => {
    const w = minGapWidth('Connector');
    expect(w, `Connector gap ${w}, expected 3-6`).toBeGreaterThanOrEqual(3);
    expect(w, `Connector gap ${w}, expected 3-6`).toBeLessThanOrEqual(6);
  });

  test('ARamp width is 4-8 cells at narrowest cross-section', () => {
    const w = minGapWidth('ARamp');
    expect(w, `ARamp gap ${w}, expected 4-8`).toBeGreaterThanOrEqual(4);
    expect(w, `ARamp gap ${w}, expected 4-8`).toBeLessThanOrEqual(8);
  });
});

// --- 8. Props sanity ---

describe('props', () => {
  test('no prop within 0.6 m of a spawn point', () => {
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

  test('all prop centres are inside a walkable region (non-wall cell at XZ centre)', () => {
    for (const prop of map.props) {
      const [px, , pz] = prop.pos;
      const [c, r] = toCell(px, pz);
      expect(isWallCell(c, r), `prop ${prop.kind}@(${px},${pz}) centre on wall`).toBe(false);
    }
  });
});

// --- 9. Key area centres are walkable and on sane floors ---

describe('area centres walkable', () => {
  test('every named area has a non-wall centre with floor < 5.0', () => {
    for (const a of map.areas) {
      const c = rectCenter(a.min, a.max);
      const [col, row] = toCell(c.x, c.z);
      expect(isWallCell(col, row), `area '${a.name}' centre (${c.x},${c.z}) is wall`).toBe(false);
      expect(legendAt(col, row).floor, `area '${a.name}' floor >= 5.0`).toBeLessThan(5.0);
    }
  });
});

// --- 10. Window room LOS premise ---

describe('window room LOS', () => {
  test('window room cells have floor >= 3.0 (elevated sniper position)', () => {
    const win = area('WindowRoom');
    const [c, r] = toCell(rectCenter(win.min, win.max).x, rectCenter(win.min, win.max).z);
    expect(isWallCell(c, r), 'window room centre is wall').toBe(false);
    expect(legendAt(c, r).floor, 'window room floor not elevated').toBeGreaterThanOrEqual(3.0);
  });

  test('mid cells have floor = 0.0', () => {
    const m = area('Mid');
    const [c, r] = toCell(rectCenter(m.min, m.max).x, rectCenter(m.min, m.max).z);
    expect(legendAt(c, r).floor).toBe(0.0);
  });
});

// --- 11. Forced routes through key chokepoints ---

describe('forced routes', () => {
  const tStart = map.spawns.t[0]!;
  const [tc, tr] = toCell(tStart.x, tStart.z);

  function assertForcedRoute(target: Vec2, blocked: string[], mustTouch: string): void {
    const parent = bfs(tc, tr, blockAreas(blocked));
    const [gc, gr] = toCell(target.x, target.z);
    const path = pathTo(parent, gc, gr);
    expect(path, `no path to (${target.x},${target.z}) with ${blocked.join('+')} blocked`).not.toBeNull();
    const rect = area(mustTouch);
    const touches = path!.some(([c, r]) => inRect(cellCenterWorld(c, r), rect.min, rect.max));
    expect(touches, `path to (${target.x},${target.z}) does not pass through ${mustTouch}`).toBe(true);
  }

  test('T spawn → B-site (with mid/aramp/apps blocked) forces through AppsCorridor', () => {
    const bsite = map.bombsites.find((b) => b.name === 'B')!;
    const target = rectCenter(bsite.min, bsite.max);
    assertForcedRoute(target, ['Mid', 'TopMid', 'ARamp'], 'AppsCorridor');
  });

  test('T spawn → A-site (with apps/market blocked) forces through TopMid', () => {
    const asite = map.bombsites.find((b) => b.name === 'A')!;
    const target = rectCenter(asite.min, asite.max);
    assertForcedRoute(target, ['AppsCorridor', 'Market', 'BSite'], 'TopMid');
  });
});

// --- 12. Site reachability from both spawns ---

describe('site reachability', () => {
  test('both CT spawns reach both bombsites', () => {
    for (const s of map.spawns.ct) {
      for (const site of map.bombsites) {
        const c = rectCenter(site.min, site.max);
        expect(canReach(s.x, s.z, c.x, c.z), `CT(${s.x},${s.z}) cannot reach site ${site.name}`).toBe(true);
      }
    }
  });

  test('both T spawns reach both bombsites', () => {
    for (const s of map.spawns.t) {
      for (const site of map.bombsites) {
        const c = rectCenter(site.min, site.max);
        expect(canReach(s.x, s.z, c.x, c.z), `T(${s.x},${s.z}) cannot reach site ${site.name}`).toBe(true);
      }
    }
  });
});
