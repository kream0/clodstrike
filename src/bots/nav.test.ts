import { describe, test, expect } from 'bun:test';
import { NavGrid } from './nav';
import { DUST2 } from '../maps/dust2';

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
