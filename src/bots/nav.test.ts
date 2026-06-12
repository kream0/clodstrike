import { describe, test, expect } from 'bun:test';
import { NavGrid } from './nav';
import { DUST2 } from '../maps/dust2';
import { MIRAGE } from '../maps/mirage';
import { MOVEMENT } from '../constants';
import type { MapData, Vec3 } from '../types';

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let nav: NavGrid;

function getNav(): NavGrid {
  if (!nav) nav = new NavGrid(DUST2);
  return nav;
}

// Convenience: center of a named area from DUST2.areas.
function areaCenter(name: string): { x: number; z: number } {
  const area = DUST2.areas.find(a => a.name === name)!;
  return {
    x: (area.min.x + area.max.x) / 2,
    z: (area.min.z + area.max.z) / 2,
  };
}

function v3(x: number, z: number, y = 0) {
  return { x, y, z };
}

// ---------------------------------------------------------------------------
// Builds + basic properties
// ---------------------------------------------------------------------------

describe('NavGrid.construction', () => {
  test('builds from DUST2 without throwing', () => {
    expect(() => getNav()).not.toThrow();
  });

  test('grid dimensions match map', () => {
    const n = getNav();
    expect(n.cols).toBe(DUST2.grid[0].length);
    expect(n.rows).toBe(DUST2.grid.length);
  });
});

// ---------------------------------------------------------------------------
// findPath — route validity
// ---------------------------------------------------------------------------

describe('findPath — T spawn to A site', () => {
  test('returns a non-null path', () => {
    const n = getNav();
    const tSpawn = DUST2.spawns.t[0];
    const aSite  = areaCenter('ASite');
    const path   = n.findPath(v3(tSpawn.x, tSpawn.z), v3(aSite.x, aSite.z));
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
  });

  test('all consecutive waypoints obey step/drop rules (floor heights)', () => {
    const n = getNav();
    const tSpawn = DUST2.spawns.t[0];
    const aSite  = areaCenter('ASite');
    const path   = n.findPath(v3(tSpawn.x, tSpawn.z), v3(aSite.x, aSite.z))!;
    expect(path).not.toBeNull();

    // After string-pull, segments can span many cells horizontally, but the
    // floor-height difference between any two consecutive waypoints must still
    // respect the original cell-edge rules (each intermediate cell is passable,
    // so the first/last floor difference is bounded by the segment length × STEP_HEIGHT).
    // We only assert that the raw floor-height jump is not a hard wall or impossible rise.
    for (let i = 1; i < path.length; i++) {
      const prev = path[i - 1];
      const curr = path[i];

      // Horizontal distance: smoothed segments may be long, but not infinity.
      const dx = curr.x - prev.x;
      const dz = curr.z - prev.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);
      expect(horizDist).toBeLessThanOrEqual(200); // entire map width

      // Floor-height difference. Consecutive waypoints can differ by at most
      // MAX_DROP (4.0 m) for a single A*-graph edge (e.g. a diagonal step off a
      // tall ramp), and for multi-cell string-pulled segments each intermediate
      // cell is capped at STEP_HEIGHT (0.5 m) per cell by _straightWalkable.
      // Rise is always ≤ 0.5 per cell; drop is capped at MAX_DROP per edge.
      const rise     = curr.y - prev.y;
      const maxRise  = Math.max(0.5, horizDist * 0.6);
      const maxDrop  = Math.max(4.0, horizDist * 0.6); // 4.0 = nav MAX_DROP
      expect(rise).toBeLessThanOrEqual(maxRise + 1e-3);
      expect(rise).toBeGreaterThanOrEqual(-maxDrop - 1e-3);
    }
  });

  test('path length < 400 waypoints', () => {
    const n = getNav();
    const tSpawn = DUST2.spawns.t[0];
    const aSite  = areaCenter('ASite');
    const path   = n.findPath(v3(tSpawn.x, tSpawn.z), v3(aSite.x, aSite.z))!;
    expect(path!.length).toBeLessThan(400);
  });

  test('smoothed path has fewer waypoints than unsmoothed (< 120 for T→A)', () => {
    const n = getNav();
    const tSpawn = DUST2.spawns.t[0];
    const aSite  = areaCenter('ASite');
    const path   = n.findPath(v3(tSpawn.x, tSpawn.z), v3(aSite.x, aSite.z))!;
    expect(path).not.toBeNull();
    // The smoothed path should be significantly shorter than raw cells.
    expect(path.length).toBeLessThan(120);
  });
});

describe('findPath — T spawn to B site', () => {
  test('returns a non-null path', () => {
    const n = getNav();
    const tSpawn = DUST2.spawns.t[0];
    const bSite  = areaCenter('BSite');
    const path   = n.findPath(v3(tSpawn.x, tSpawn.z), v3(bSite.x, bSite.z));
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
  });
});

describe('findPath — CT spawn to B site', () => {
  test('returns a non-null path', () => {
    const n = getNav();
    const ctSpawn = DUST2.spawns.ct[0];
    const bSite   = areaCenter('BSite');
    const path    = n.findPath(v3(ctSpawn.x, ctSpawn.z), v3(bSite.x, bSite.z));
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// nearestWalkable
// ---------------------------------------------------------------------------

describe('nearestWalkable', () => {
  test('recovers from a point inside a wall', () => {
    const n = getNav();
    // Find a wall cell and query from its center.
    const map = DUST2;
    let wallX = 0, wallZ = 0;
    outer:
    for (let row = 0; row < map.grid.length; row++) {
      for (let col = 0; col < map.grid[row].length; col++) {
        const ch  = map.grid[row][col];
        const leg = map.legend[ch];
        if (leg?.wall) {
          wallX = map.origin.x + col * map.cellSize + map.cellSize * 0.5;
          wallZ = map.origin.z + row * map.cellSize + map.cellSize * 0.5;
          break outer;
        }
      }
    }

    const result = n.nearestWalkable({ x: wallX, y: 0, z: wallZ });
    expect(result).not.toBeNull();
    // The result should actually be walkable.
    const snap = n.nearestWalkable(result!);
    expect(snap).not.toBeNull();
  });

  test('returns the same cell for a point already in walkable cell', () => {
    const n = getNav();
    const ctSpawn = DUST2.spawns.ct[0];
    const result  = n.nearestWalkable({ x: ctSpawn.x, y: 0, z: ctSpawn.z });
    expect(result).not.toBeNull();
    // Should be near the query point.
    const dx = result!.x - ctSpawn.x;
    const dz = result!.z - ctSpawn.z;
    expect(Math.sqrt(dx * dx + dz * dz)).toBeLessThanOrEqual(2.0);
  });
});

// ---------------------------------------------------------------------------
// randomPointInRect
// ---------------------------------------------------------------------------

describe('randomPointInRect', () => {
  test('returns walkable points in ASite rect (50 samples)', () => {
    const n    = getNav();
    const area = DUST2.areas.find(a => a.name === 'ASite')!;
    let nullCount = 0;

    for (let i = 0; i < 50; i++) {
      const pt = n.randomPointInRect(area.min, area.max);
      if (pt === null) { nullCount++; continue; }

      // Point should be within the rect (cell center may be slightly outside by half a cell).
      expect(pt.x).toBeGreaterThanOrEqual(area.min.x - 1);
      expect(pt.x).toBeLessThanOrEqual(area.max.x + 1);
      expect(pt.z).toBeGreaterThanOrEqual(area.min.z - 1);
      expect(pt.z).toBeLessThanOrEqual(area.max.z + 1);

      // Should be walkable: nearestWalkable should return something close.
      const snap = n.nearestWalkable(pt);
      expect(snap).not.toBeNull();
      const dx = snap!.x - pt.x;
      const dz = snap!.z - pt.z;
      expect(Math.sqrt(dx * dx + dz * dz)).toBeLessThanOrEqual(1.5);
    }

    // Allow at most 5 null results for the whole rect.
    expect(nullCount).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

describe('findPath performance', () => {
  test('50× T spawn → A site < 250 ms total', () => {
    const n = getNav();
    const tSpawn = DUST2.spawns.t[0];
    const aSite  = areaCenter('ASite');
    const from   = v3(tSpawn.x, tSpawn.z);
    const to     = v3(aSite.x, aSite.z);

    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      const path = n.findPath(from, to);
      expect(path).not.toBeNull();
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(250);
  });
});

// ---------------------------------------------------------------------------
// Prop-aware navigation
//
// NavGrid builds collidable prop AABBs from map.props and refuses to route a bot
// into a prop it cannot traverse. These tests pin the behaviour on the MIRAGE
// A-site crate cluster (the original wedge bug) plus map-agnostic invariants.
// ---------------------------------------------------------------------------

const R       = MOVEMENT.PLAYER_RADIUS;
const STEP    = 0.5; // nav STEP_HEIGHT (kept in sync with nav.ts)

/** Build the collidable prop AABB list the same way World / NavGrid does. */
function collidableBoxes(map: MapData): Array<{
  minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number;
}> {
  const out = [];
  for (const p of map.props) {
    if (p.collide === false) continue;
    const [px, py, pz] = p.pos;
    const [sx, sy, sz] = p.size;
    out.push({
      minX: px - sx / 2, maxX: px + sx / 2,
      minZ: pz - sz / 2, maxZ: pz + sz / 2,
      minY: py,          maxY: py + sy,
    });
  }
  return out;
}

/** Local floor (cell legend) at a world XZ — mirrors World.floorAt for tests. */
function floorAtCell(map: MapData, x: number, z: number): number {
  const col = Math.floor((x - map.origin.x) / map.cellSize);
  const row = Math.floor((z - map.origin.z) / map.cellSize);
  const r = map.grid[row];
  if (r === undefined) return Infinity;
  const ch = r[col];
  if (ch === undefined) return Infinity;
  const leg = map.legend[ch];
  if (!leg || leg.wall) return Infinity;
  return leg.floor;
}

/** True if a standing footprint at (x,z) overlaps a non-traversable prop. */
function footprintHitsProp(map: MapData, x: number, z: number): boolean {
  const floor = floorAtCell(map, x, z);
  if (!isFinite(floor)) return false;
  const minX = x - R, maxX = x + R, minZ = z - R, maxZ = z + R;
  for (const b of collidableBoxes(map)) {
    if (b.maxX <= minX || b.minX >= maxX) continue;
    if (b.maxZ <= minZ || b.minZ >= maxZ) continue;
    if (b.maxY > floor + STEP) return true; // non-traversable (top too tall to step onto)
  }
  return false;
}

/** Sample a straight XZ segment; true if every sample is prop-clear. */
function segPropClear(map: MapData, a: Vec3, b: Vec3): boolean {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  const ux = len < 1e-6 ? 0 : dx / len;
  const uz = len < 1e-6 ? 0 : dz / len;
  for (let t = 0; t <= len + 1e-6; t += R) {
    if (footprintHitsProp(map, a.x + ux * t, a.z + uz * t)) return false;
  }
  return true;
}

describe('prop-aware: MIRAGE A-site crate cluster', () => {
  test('nearestWalkable never returns a cell occupied by a crate', () => {
    const n = new NavGrid(MIRAGE);
    // The big A-site crate is at world X[-2,2] Z[22,24] (floor 1.5). Query points
    // straight inside it: nearestWalkable must relocate to a prop-clear cell.
    for (const q of [
      { x: 0,   y: 1.5, z: 23 },
      { x: -1,  y: 1.5, z: 23 },
      { x: 1,   y: 1.5, z: 23 },
      { x: 3,   y: 1.5, z: 22 }, // small crate X[2.25,3.75] Z[21.25,22.75]
    ]) {
      const w = n.nearestWalkable(q);
      expect(w).not.toBeNull();
      expect(footprintHitsProp(MIRAGE, w!.x, w!.z)).toBe(false);
    }
  });

  test('randomPointInRect over A-site returns only prop-clear cells (100 samples)', () => {
    const n = new NavGrid(MIRAGE);
    const a = MIRAGE.areas.find(ar => ar.name === 'ASite')!;
    for (let i = 0; i < 100; i++) {
      const pt = n.randomPointInRect(a.min, a.max);
      if (pt === null) continue;
      expect(footprintHitsProp(MIRAGE, pt.x, pt.z)).toBe(false);
    }
  });

  test('findPath across the crate cluster never crosses a prop on any segment', () => {
    const n = new NavGrid(MIRAGE);
    // West side of the cluster → a clear cell east of it; the straight bot route
    // would clip the crates, so the path must detour and every segment stays clear.
    const path = n.findPath({ x: -16.5, y: 1.5, z: 22.5 }, { x: 6.5, y: 1.5, z: 24.5 });
    expect(path).not.toBeNull();
    for (let i = 1; i < path!.length; i++) {
      expect(segPropClear(MIRAGE, path![i - 1], path![i])).toBe(true);
    }
  });
});

describe('prop-aware: invariants on both maps', () => {
  for (const { label, map } of [
    { label: 'dust2',  map: DUST2 },
    { label: 'mirage', map: MIRAGE },
  ]) {
    test(`${label}: prop-awareness empties no named area and severs no area-pair route`, () => {
      const n = new NavGrid(map);
      // Every named area still has at least one walkable cell.
      for (const a of map.areas) {
        expect(n.randomPointInRect(a.min, a.max), `area ${a.name} has no walkable cell`).not.toBeNull();
      }
      // Every ordered area-centre pair is still reachable.
      for (const a of map.areas) {
        for (const b of map.areas) {
          if (a === b) continue;
          const from = { x: (a.min.x + a.max.x) / 2, y: 0, z: (a.min.z + a.max.z) / 2 };
          const to   = { x: (b.min.x + b.max.x) / 2, y: 0, z: (b.min.z + b.max.z) / 2 };
          expect(n.findPath(from, to), `${label}: ${a.name}→${b.name} unreachable`).not.toBeNull();
        }
      }
    });
  }

  test('every findPath waypoint sits on a prop-clear footprint (mirage T→A)', () => {
    const n = new NavGrid(MIRAGE);
    const t = MIRAGE.spawns.t[0];
    const a = MIRAGE.areas.find(ar => ar.name === 'ASite')!;
    const path = n.findPath(
      { x: t.x, y: 0, z: t.z },
      { x: (a.min.x + a.max.x) / 2, y: 0, z: (a.min.z + a.max.z) / 2 },
    );
    expect(path).not.toBeNull();
    for (const wp of path!) {
      expect(footprintHitsProp(MIRAGE, wp.x, wp.z)).toBe(false);
    }
  });
});
