// fidelity.test.ts — the automated dust2 fidelity GATE.
//
// Asserts the BUILT `DUST2` MapData against the ground-truth landmark table in
// `dust2_truth.ts`. No images, no file I/O — pure `bun test`, lives forever.
//
// WHAT IT CHECKS (landmark-driven, so it stays valid as the truth table grows):
//   - point landmarks   : the world coord is WALKABLE, and the floor height is
//                         within the landmark's tolerance (snapped-band aware).
//   - opening landmarks : the choke is walkable, and its measured walkable width
//                         (cells, scanned across the choke) is within +/-1 cell of
//                         widthCells.
//   - region landmarks  : the bbox contains a healthy fraction of walkable cells,
//                         those walkable cells are internally connected (one BFS
//                         component covers most of them), and the region's centre
//                         is walkable.
//
// EXPECTED TO FAIL against the CURRENT (pre-rebuild) dust2.ts — that is the whole
// point. The grid-rebuild agent (T3) makes it green. To keep the failure signal
// useful, every assertion names the landmark + expected-vs-actual, and a summary
// `console.log` prints the pass/fail tally (the "distance from truth" metric).
//
// HOW TOLERANCES WORK:
//   - Position: a point/opening is considered correctly placed if its exact world
//     coordinate lands on a walkable cell, OR a walkable cell exists within a small
//     search radius derived from its tolerance (tolerance metres / cellSize, min 1).
//     This mirrors the truth table's confidence-scaled tolerances (high=3m … low=8m).
//   - Floor:   |built floor - truth floorY| <= max(landmark.tolerance-derived band,
//     FLOOR_BAND). Truth floorY is a RELATIVE-height hint (see TRUTH_NOTES) — T3 owns
//     absolute floor assignment — so we allow a generous floor band but still flag
//     gross mismatches. We compare against the FLOOR_BAND quantum primarily and only
//     escalate to the metre tolerance for low-confidence rows.

import { describe, expect, test } from 'bun:test';
import { DUST2 } from './dust2';
import { World } from '../world';
import {
  DUST2_POINTS,
  DUST2_OPENINGS,
  DUST2_REGIONS,
  FLOOR_BAND,
  GRID,
  type Landmark,
} from './dust2_truth';

const map = DUST2;
const world = new World(map);
const ROWS = map.grid.length;
const COLS = map.grid[0]?.length ?? 0;

// ---------------------------------------------------------------------------
// Cell helpers (operate on the BUILT grid)
// ---------------------------------------------------------------------------
function cellChar(row: number, col: number): string | undefined {
  if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return undefined;
  return map.grid[row]?.[col];
}

function isWalkableCell(row: number, col: number): boolean {
  const ch = cellChar(row, col);
  if (ch === undefined) return false;
  const cell = map.legend[ch];
  if (cell === undefined) return false;
  return cell.wall !== true;
}

function cellFloor(row: number, col: number): number | null {
  const ch = cellChar(row, col);
  if (ch === undefined) return null;
  const cell = map.legend[ch];
  if (cell === undefined || cell.wall === true) return null;
  return cell.floor;
}

/** Landmark world coord -> our grid cell (same rounding as dust2_truth.worldToCell). */
function worldToCell(x: number, z: number): { row: number; col: number } {
  const col = Math.round(x - GRID.origin.x);
  const row = Math.round(z - GRID.origin.z);
  return { col, row };
}

/** Search radius in cells for a landmark, from its metre tolerance (min 1). */
function searchRadius(lm: Landmark): number {
  return Math.max(1, Math.round(lm.tolerance / GRID.cellSize));
}

/**
 * Find the nearest walkable cell to (row,col) within `radius` (Chebyshev).
 * Returns the cell + its floor, or null if none walkable in the window.
 */
function nearestWalkable(
  row: number,
  col: number,
  radius: number,
): { row: number; col: number; floor: number; dist: number } | null {
  let best: { row: number; col: number; floor: number; dist: number } | null = null;
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      const r = row + dr, c = col + dc;
      if (!isWalkableCell(r, c)) continue;
      const f = cellFloor(r, c);
      if (f === null) continue;
      const dist = Math.max(Math.abs(dr), Math.abs(dc));
      if (best === null || dist < best.dist) best = { row: r, col: c, floor: f, dist };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Baseline tally — counts how many landmark assertions PASS vs FAIL today.
// This is the "distance from truth" signal for T3. Printed once at the end.
// ---------------------------------------------------------------------------
interface Tally { pass: number; fail: number; details: string[] }
const tally: Tally = { pass: 0, fail: 0, details: [] };
function record(ok: boolean, label: string): boolean {
  if (ok) tally.pass++;
  else { tally.fail++; tally.details.push(label); }
  return ok;
}

// ===========================================================================
// POINT landmarks
// ===========================================================================
describe('fidelity: point landmarks', () => {
  for (const lm of DUST2_POINTS) {
    test(`${lm.name} (${lm.confidence}) is placed + on a sane floor`, () => {
      const cell = worldToCell(lm.x, lm.z);
      const radius = searchRadius(lm);
      const hit = nearestWalkable(cell.row, cell.col, radius);

      // (1) Walkability: the truth point should resolve to a walkable cell within tolerance.
      const placed = hit !== null;
      record(placed, `POINT ${lm.name}: no walkable cell within ${radius} cells of (row ${cell.row}, col ${cell.col})`);
      expect(
        placed,
        `${lm.name}: expected a WALKABLE cell within ${radius} cells of truth (row ${cell.row}, col ${cell.col}) [world x=${lm.x}, z=${lm.z}] — found none. Built grid does not match ground truth here.`,
      ).toBe(true);
      if (hit === null) return;

      // (2) Floor height: built floor must be near the truth floorY hint.
      // floorY is a relative-height hint (see TRUTH_NOTES); allow a band scaled by
      // confidence (low rows get a wide band), but never tighter than one FLOOR_BAND.
      const floorBand = Math.max(FLOOR_BAND, lm.confidence === 'low' ? lm.tolerance : FLOOR_BAND * 2);
      const dy = Math.abs(hit.floor - lm.floorY);
      const floorOk = dy <= floorBand;
      record(floorOk, `POINT ${lm.name}: floor ${hit.floor} vs truth ${lm.floorY} (delta ${dy.toFixed(3)} > band ${floorBand.toFixed(3)})`);
      expect(
        floorOk,
        `${lm.name}: built floor ${hit.floor} m differs from truth ${lm.floorY} m by ${dy.toFixed(3)} m (allowed band ${floorBand.toFixed(3)} m).`,
      ).toBe(true);
    });
  }
});

// ===========================================================================
// OPENING landmarks (chokes)
// ===========================================================================
/**
 * Measure the walkable width of a choke at (row,col) by scanning the run of
 * consecutive walkable cells through the centre, taking the SHORTER of the
 * horizontal and vertical runs (a choke is narrow along one axis).
 */
function chokeWidthCells(row: number, col: number): number {
  if (!isWalkableCell(row, col)) return 0;
  // Horizontal run.
  let hRun = 1;
  for (let c = col - 1; c >= 0 && isWalkableCell(row, c); c--) hRun++;
  for (let c = col + 1; c < COLS && isWalkableCell(row, c); c++) hRun++;
  // Vertical run.
  let vRun = 1;
  for (let r = row - 1; r >= 0 && isWalkableCell(r, col); r--) vRun++;
  for (let r = row + 1; r < ROWS && isWalkableCell(r, col); r++) vRun++;
  return Math.min(hRun, vRun);
}

describe('fidelity: opening (choke) landmarks', () => {
  for (const lm of DUST2_OPENINGS) {
    test(`${lm.name} (${lm.confidence}) is a walkable choke of ~${lm.widthCells ?? '?'} cells`, () => {
      const cell = worldToCell(lm.x, lm.z);
      const radius = searchRadius(lm);
      const hit = nearestWalkable(cell.row, cell.col, radius);

      const placed = hit !== null;
      record(placed, `OPENING ${lm.name}: no walkable cell within ${radius} cells of (row ${cell.row}, col ${cell.col})`);
      expect(
        placed,
        `${lm.name}: expected a WALKABLE choke within ${radius} cells of truth (row ${cell.row}, col ${cell.col}) — found none.`,
      ).toBe(true);
      if (hit === null) return;

      // Width: scanned walkable run at the choke, within +/-1 cell of the spec.
      const want = lm.widthCells ?? 1;
      const got = chokeWidthCells(hit.row, hit.col);
      const widthOk = Math.abs(got - want) <= 1;
      record(widthOk, `OPENING ${lm.name}: width ${got} cells vs spec ${want} (+/-1)`);
      expect(
        widthOk,
        `${lm.name}: measured choke width ${got} cells at (row ${hit.row}, col ${hit.col}) differs from spec ${want} cells by more than 1.`,
      ).toBe(true);
    });
  }
});

// ===========================================================================
// REGION landmarks (bbox connectivity)
// ===========================================================================
/** BFS the largest connected walkable component inside a bbox. Returns its size. */
function largestWalkableComponent(bbox: { row0: number; col0: number; row1: number; col1: number }): {
  total: number;
  largest: number;
} {
  const seen = new Set<number>();
  let total = 0;
  for (let r = bbox.row0; r <= bbox.row1; r++)
    for (let c = bbox.col0; c <= bbox.col1; c++)
      if (isWalkableCell(r, c)) total++;

  let largest = 0;
  for (let r0 = bbox.row0; r0 <= bbox.row1; r0++) {
    for (let c0 = bbox.col0; c0 <= bbox.col1; c0++) {
      const key0 = r0 * COLS + c0;
      if (!isWalkableCell(r0, c0) || seen.has(key0)) continue;
      // BFS this component (bounded to the bbox).
      let size = 0;
      const stack: Array<[number, number]> = [[r0, c0]];
      seen.add(key0);
      while (stack.length > 0) {
        const next = stack.pop();
        if (next === undefined) break;
        const [r, c] = next;
        size++;
        const nbrs: Array<[number, number]> = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
        for (const [nr, nc] of nbrs) {
          if (nr < bbox.row0 || nr > bbox.row1 || nc < bbox.col0 || nc > bbox.col1) continue;
          const k = nr * COLS + nc;
          if (seen.has(k) || !isWalkableCell(nr, nc)) continue;
          seen.add(k);
          stack.push([nr, nc]);
        }
      }
      if (size > largest) largest = size;
    }
  }
  return { total, largest };
}

describe('fidelity: region landmarks (bbox connectivity)', () => {
  for (const lm of DUST2_REGIONS) {
    test(`${lm.name} (${lm.confidence}) bbox is walkable + connected`, () => {
      const bbox = lm.bbox;
      expect(bbox, `${lm.name}: region landmark is missing a bbox`).toBeDefined();
      if (bbox === undefined) return;

      const area = (bbox.row1 - bbox.row0 + 1) * (bbox.col1 - bbox.col0 + 1);
      const { total, largest } = largestWalkableComponent(bbox);

      // (1) A healthy fraction of the bbox should be walkable (areas aren't solid).
      const walkFrac = area > 0 ? total / area : 0;
      const fracOk = walkFrac >= 0.4;
      record(fracOk, `REGION ${lm.name}: only ${(walkFrac * 100).toFixed(0)}% of bbox walkable (want >=40%)`);
      expect(
        fracOk,
        `${lm.name}: bbox rows ${bbox.row0}-${bbox.row1}, cols ${bbox.col0}-${bbox.col1} is only ${(walkFrac * 100).toFixed(0)}% walkable (want >=40%). Region is mostly wall/void — grid does not match truth.`,
      ).toBe(true);

      // (2) The walkable cells should form one dominant connected component
      // (an area shouldn't be split into disconnected islands).
      const connFrac = total > 0 ? largest / total : 0;
      const connOk = connFrac >= 0.6;
      record(connOk, `REGION ${lm.name}: largest connected component is only ${(connFrac * 100).toFixed(0)}% of walkable cells (want >=60%)`);
      expect(
        connOk,
        `${lm.name}: largest connected walkable component covers ${(connFrac * 100).toFixed(0)}% of the ${total} walkable cells (want >=60%) — region is fragmented.`,
      ).toBe(true);

      // (3) The region centre itself should be walkable (within tolerance radius).
      const radius = searchRadius(lm);
      const centreHit = nearestWalkable(lm.row, lm.col, radius);
      const centreOk = centreHit !== null;
      record(centreOk, `REGION ${lm.name}: centre (row ${lm.row}, col ${lm.col}) not walkable within ${radius} cells`);
      expect(
        centreOk,
        `${lm.name}: region centre (row ${lm.row}, col ${lm.col}) has no walkable cell within ${radius} cells.`,
      ).toBe(true);
    });
  }
});

// ===========================================================================
// BASELINE SUMMARY — the "distance from truth" signal for T3.
// Runs last (registered after the per-landmark tests). Always passes; it only
// reports the tally so a human / agent can read it from the test output.
// ===========================================================================
describe('fidelity: baseline summary', () => {
  test('print landmark pass/fail tally (always passes)', () => {
    const totalLandmarks = DUST2_POINTS.length + DUST2_OPENINGS.length + DUST2_REGIONS.length;
    const totalChecks = tally.pass + tally.fail;
    // eslint-disable-next-line no-console
    console.log(
      `\n[fidelity baseline] landmarks=${totalLandmarks} ` +
      `(points=${DUST2_POINTS.length}, openings=${DUST2_OPENINGS.length}, regions=${DUST2_REGIONS.length})\n` +
      `[fidelity baseline] assertion checks: ${tally.pass}/${totalChecks} PASS, ${tally.fail} FAIL\n` +
      (tally.fail > 0
        ? `[fidelity baseline] failing checks (distance-from-truth for T3):\n  - ${tally.details.join('\n  - ')}\n`
        : `[fidelity baseline] ALL CHECKS PASS — grid matches ground truth.\n`),
    );
    expect(totalChecks).toBeGreaterThan(0);
  });
});
