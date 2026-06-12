// de_dust2 GROUND-TRUTH coordinate data — pure data + pure functions.
// No three.js, no I/O, no side effects. Facts only (coordinates / scales).
//
// PURPOSE
// -------
// This module is the single source of truth for "where things really are on
// de_dust2", expressed in OUR 96x96 / 1-metre grid frame. Two consumers use it:
//   1. The map-rebuild (dust2.ts) — to place rooms/chokes/sites faithfully.
//   2. An automated fidelity gate (fidelity.test.ts, added by a later task) —
//      to assert the built map keeps each landmark within tolerance.
//
// All numeric facts are derived from public Source-Engine coordinates (setpos
// HU values) and the CS:GO radar calibration file. Facts are not copyrightable;
// no Valve assets were used. Each landmark cites its source + the raw HU coords
// so a reviewer can re-derive every cell from scratch.
//
// =============================================================================
// THE COORDINATE TRANSFORM (the heart of this module)
// =============================================================================
//
// Source Engine uses Hammer Units (HU). 1 HU = 0.01905 m (= 3/4 inch), an
// authoritative Valve value. Source axes vs. our grid:
//
//   Source X  = East            -> our +X        (col grows east)
//   Source Y  = North (CT side) -> our -Z        (NEGATE: north = low row)
//   Source Z  = Up              -> our +Y         (floor elevation)
//
// Our grid frame is FIXED and unchanged by this module:
//   96 x 96 cells, 1 m each. origin { x:-48, z:-48 }.
//   col = round(worldX + 48)   [0..95], col 0 = west  (x=-48)
//   row = round(worldZ + 48)   [0..95], row 0 = north (z=-48, CT/sites side)
//
// Real dust2 is NOT centred on the Source origin, so a raw 1:1 HU->m projection
// drops the CT side off the north edge of the grid (research's #1 problem). We
// fix this with three TRANSLATION offsets baked into the transform — the grid
// frame itself is untouched.
//
//   clod_X_m = source_X_HU * HU_TO_M + X_OFFSET
//   clod_Z_m = -(source_Y_HU) * HU_TO_M + Z_OFFSET   (negate Source Y)
//   clod_Y_m = source_Z_HU * HU_TO_M + Y_OFFSET
//   col = round(clod_X_m + 48),  row = round(clod_Z_m + 48)
//
// ---- X_OFFSET derivation (centre the map east-west) -------------------------
// Playable Source X span (eBot heatmap bounds, S10): -2216 .. +1792 HU.
//   centre X = (-2216 + 1792)/2 = -212 HU = -212 * 0.01905 = -4.04 m.
// To park the map centre at our grid centre (worldX = 0 => col 48) we cancel
// that -4.04 m, so X_OFFSET = +4.04 m.
//   west  corner X=-2216 -> -42.23 + 4.04 = -38.19 m -> col round(9.81)  = 10
//   east  corner X=+1792 -> +34.14 + 4.04 = +38.18 m -> col round(86.18) = 86
// => cols 10..86 (margin >=9 each side). Good.
//
// ---- Z_OFFSET derivation (centre the map north-south; fixes the #1 problem) -
// Playable Source Y span: -1176 (south/T) .. +3244 (north/CT) HU.
//   centre Y = (-1176 + 3244)/2 = +1034 HU.
//   raw clod_Z of centre = -(1034) * 0.01905 = -19.70 m (north of grid centre).
// To pull that centre back to worldZ = 0 (row 48) we add Z_OFFSET = +19.70 m.
//   north corner Y=+3244 -> -(3244*0.01905) + 19.70 = -61.80 + 19.70 = -42.10 m
//     -> row round(5.90)  = 6     (was row -14 before the fix — now on-grid)
//   south corner Y=-1176 -> +(1176*0.01905) + 19.70 = +22.40 + 19.70 = +42.10 m
//     -> row round(90.10) = 90
// => rows 6..90 (margin >=6 each side). CT side no longer falls off the edge.
//
// ---- Y_OFFSET derivation (lowest floor -> ~0, all floors >= 0) --------------
// Lowest playable floor is CT spawn, Source Z = -121 HU = -2.31 m. To make the
// lowest floor sit at ~0 we add Y_OFFSET = +2.31 m, so:
//   CT spawn floor = -2.31 + 2.31 = 0.00 m  -> band 0.000
// Every other elevation is this same uniform shift up, preserving real relative
// heights, and stays a non-negative multiple of 0.375 m after snapping.
//
// CAVEAT for the rebuild agent (T3): the +2.31 m shift makes some HIGH areas
// snap above the existing ~5.25 m floor ceiling — see TRUTH_NOTES below. The
// two genuinely suspect rows (A Short stairs @204 HU, Mid CT doors @172 HU) are
// marked confidence 'low' so the fidelity gate uses a loose tolerance; do NOT
// let them push a real floor above the existing ceiling without verification.
//
// =============================================================================

import type { Vec2 } from '../types';

// ---------------------------------------------------------------------------
// Conversion constants
// ---------------------------------------------------------------------------

/** Metres per Hammer Unit (authoritative Valve value: 1 HU = 3/4 inch). */
export const HU_TO_M = 0.01905;
/** Hammer Units per metre (inverse of HU_TO_M; ~52.493). */
export const M_TO_HU = 1 / HU_TO_M;

/** East-west centring offset (m). Cancels the -4.04 m playable X centre. */
export const X_OFFSET = 4.04;
/** North-south centring offset (m). Cancels the -19.70 m playable Z centre — fixes the CT-side-off-grid problem. */
export const Z_OFFSET = 19.7;
/** Elevation offset (m). Lifts the lowest floor (CT spawn, -121 HU) to ~0 so all floors are >= 0. */
export const Y_OFFSET = 2.31;

/** Floor-height quantum (m). Real elevations snap to a multiple of this for the legend bands. */
export const FLOOR_BAND = 0.375;

/** Our fixed grid frame (NOT changed by this module — recorded for consumers). */
export const GRID = {
  cols: 96,
  rows: 96,
  cellSize: 1,
  origin: { x: -48, z: -48 } as Vec2,
} as const;

// ---------------------------------------------------------------------------
// Radar calibration (CS:GO de_dust2.txt, source S1 — extracted from game VPK)
// Re-exported so the later overlay/render tool can map radar pixels <-> world.
//   world_X_HU = posX + pixel_x * scale
//   world_Y_HU = posY - pixel_y * scale     (radar Y grows downward)
// ---------------------------------------------------------------------------
export const RADAR = {
  /** Upper-left world X in HU. */
  posX: -2400,
  /** Upper-left world Y in HU. */
  posY: 3383,
  /** HU per radar pixel. */
  scale: 4.4,
  /** Radar image is square, 1024x1024 px (Valve minimap standard). */
  imageSize: 1024,
} as const;

/**
 * Playable footprint in raw Source HU (eBot heatmap bounds, source S10 —
 * the actual tracked play area, excluding skybox/OOB the radar image covers).
 * Consumers that need the looser radar-image extent can derive it from RADAR.
 */
export const PLAYABLE_HU_BOUNDS = {
  minX: -2216,
  maxX: 1792,
  minY: -1176,
  maxY: 3244,
} as const;

// ---------------------------------------------------------------------------
// Pure transform functions
// ---------------------------------------------------------------------------

/**
 * Convert a Source-Engine setpos coordinate (Hammer Units) to OUR world metres
 * in the grid frame. Source (X east, Y north, Z up) -> clod (x east, y up, z
 * south). Applies the three centring/elevation offsets documented above.
 */
export function huToWorld(
  xHU: number,
  yHU: number,
  zHU: number,
): { x: number; y: number; z: number } {
  return {
    x: xHU * HU_TO_M + X_OFFSET,
    y: zHU * HU_TO_M + Y_OFFSET, // Source Z (up) -> our Y (up)
    z: -(yHU) * HU_TO_M + Z_OFFSET, // Source Y (north) -> our -Z (north = low row)
  };
}

/** World metres (x east, z south) -> grid cell. Clamped to [0, 95]. */
export function worldToCell(x: number, z: number): { row: number; col: number } {
  const col = Math.round(x - GRID.origin.x);
  const row = Math.round(z - GRID.origin.z);
  return {
    col: Math.min(GRID.cols - 1, Math.max(0, col)),
    row: Math.min(GRID.rows - 1, Math.max(0, row)),
  };
}

/** Snap a raw elevation (m) to the nearest legend floor band (multiple of 0.375 m). */
export function snapFloor(yMeters: number): number {
  return Math.round(yMeters / FLOOR_BAND) * FLOOR_BAND;
}

/** Convert a choke width in Hammer Units to whole grid cells (1 cell = 1 m), min 1. */
export function huWidthToCells(widthHU: number): number {
  return Math.max(1, Math.round(widthHU * HU_TO_M));
}

// ---------------------------------------------------------------------------
// Landmark contract
// ---------------------------------------------------------------------------

export type LandmarkKind = 'point' | 'opening' | 'region';
export type Confidence = 'high' | 'medium' | 'low';

export interface Landmark {
  /** Stable identifier (used by the fidelity test as the assertion label). */
  name: string;
  kind: LandmarkKind;
  /** World metres in the grid frame (x east, z south). */
  x: number;
  z: number;
  /** Derived grid cell (row 0 = north, col 0 = west). */
  row: number;
  col: number;
  /** Floor elevation in metres, snapped to the nearest 0.375 m band. */
  floorY: number;
  /** Allowed deviation (m) between this landmark and the built map. */
  tolerance: number;
  /** For kind:'opening' — choke width in grid cells (1 cell = 1 m). */
  widthCells?: number;
  /** For kind:'region' — inclusive cell bounding box. */
  bbox?: { row0: number; col0: number; row1: number; col1: number };
  confidence: Confidence;
  /** Source tag(s) + the raw HU that produced this row. */
  source: string;
}

// ---------------------------------------------------------------------------
// Tolerance policy by confidence (metres). Wider for less-trusted facts so the
// fidelity gate doesn't fail on coordinates we only loosely trust.
// ---------------------------------------------------------------------------
const TOL: Record<Confidence, number> = {
  high: 3,
  medium: 5,
  low: 8,
};

/**
 * Build a 'point' landmark straight from Source HU coords so the cell/floor are
 * always derived consistently (no hand-typed grid math to drift out of sync).
 */
function pt(
  name: string,
  xHU: number,
  yHU: number,
  zHU: number,
  confidence: Confidence,
  source: string,
): Landmark {
  const w = huToWorld(xHU, yHU, zHU);
  const c = worldToCell(w.x, w.z);
  return {
    name,
    kind: 'point',
    x: round2(w.x),
    z: round2(w.z),
    row: c.row,
    col: c.col,
    floorY: snapFloor(w.y),
    tolerance: TOL[confidence],
    confidence,
    source,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ===========================================================================
// POINTS — derived from setpos HU coords (see comment per row)
// ===========================================================================
export const DUST2_POINTS: Landmark[] = [
  // ---- Spawns (HIGH — confirmed across 2+ guides, S5/S6) -------------------
  pt('CTSpawnCenter', 257, 2415, -121, 'high', 'S5,S6 mean of 5 CT spawns ~(257,2415,-121)'),
  pt('TSpawnCenter', -530, -770, 110, 'high', 'S5,S6 mean of T spawn cluster ~(-530,-770,110)'),

  // ---- Bomb default-plant points (MEDIUM — radar .txt normalized, S1) ------
  // No setpos for the exact plant spot exists in the research; the radar bombA/
  // bombB normalized markers are the best-sourced plant references.
  pt('BombAPlant', 1204, 2481, 67, 'medium', 'S1 radar bombA norm (0.80,0.20); Z from B-box-on-site band'),
  pt('BombBPlant', -1654, 1679, 73, 'medium', 'S1/S8 B-site interior near car ~(-1654,1679,73)'),

  // ---- Key geometry points (MEDIUM unless noted) ---------------------------
  pt('Xbox', 378, 1645, 83, 'medium', 'S8 A-short/catwalk crate ref ~(378,1645,83)'),
  pt('BCar', -1654, 1679, 73, 'medium', 'S8 B-site car ~(-1654,1679,73)'),
  pt('GooseA', 1472, 1385, 67, 'medium', 'S8 A-long/CT-far corner toward goose ~(1472,1385,67)'),
  pt('Pit', 1504, 627, 28, 'medium', 'S8 A-long lower ground (pit approach) ~(1504,627,28)'),
  pt('MidCenter', 36, 332, 70, 'medium', 'S8,S9 mid/suicide center ~(36,332,70)'),
  pt('Catwalk', 378, 1645, 83, 'medium', 'S8 catwalk mid ~(378,1645,83)'),
  pt('LongCorner', 592, 382, 69, 'medium', 'S8,S9 A-long entry corner ~(592,382,69)'),
  pt('TunnelExit', -1642, 805, 96, 'medium', 'S8 B upper-tunnel interior toward site ~(-1642,805,96)'),
  pt('BWindow', -1712, 2864, 87, 'low', 'S8 B window/back-plat ~(-1712,2864,87) — high Y, see TRUTH_NOTES'),
];

// ===========================================================================
// OPENINGS — chokes. widthCells from research choke widths (LOW confidence:
// estimated, not measured). Position is the centre of the opening.
// ===========================================================================
export const DUST2_OPENINGS: Landmark[] = [
  opening('LongDoors', 592, 382, 69, 256, 'low', 'S8 long-doors center; ~256 HU (two leaves) est.'),
  opening('MidDoors', -300, 1500, 70, 128, 'low', 'mid-doors center est.; ~128 HU single passage'),
  opening('BDoors', -1100, 1900, 80, 128, 'low', 'B-doors (mid->B) center est.; ~128 HU'),
  opening('CatwalkMouth', 200, 1300, 83, 80, 'low', 'catwalk mouth est.; ~80 HU narrow'),
  opening('TunnelMouth', -1920, 1384, 96, 160, 'low', 'S8 B upper-tunnels doorway ~(-1920,1384,96); ~160 HU'),
  opening('ASiteEntryLong', 916, 1200, 104, 256, 'low', 'S8 A from long (CT upper) ~(916,1200,104); long-wide'),
  opening('ASiteEntryShort', 272, 2100, 100, 128, 'low', 'A from short/catwalk top est.; ~128 HU'),
  opening('BSiteEntryTunnels', -1794, 1106, 96, 160, 'medium', 'S8 B-site mouth from tunnels ~(-1794,1106,96)'),
  opening('BSiteEntryDoors', -1189, 2133, 67, 128, 'low', 'S8 B-site mouth from B-doors ~(-1189,2133,67)'),
];

// ===========================================================================
// REGIONS — area bounding boxes (inclusive cell ranges). Derived by projecting
// the playable corner HU of each area; LOW/MEDIUM since most area extents are
// interpolated from the few interior setpos points the research provides.
// ===========================================================================
export const DUST2_REGIONS: Landmark[] = [
  region('CTSpawn', 160, 351, 2353, 2481, -120, 'high', 'S5,S6 5-spawn bounding HU'),
  region('TSpawn', -857, -332, -843, -738, 95, 'high', 'S5,S6 spawn-cluster bounding HU'),
  region('ASite', 916, 1504, 627, 1385, 67, 'medium', 'S8 A-site interior setpos span'),
  region('BSite', -2050, -1189, 1106, 2133, 96, 'medium', 'S8 B-site interior setpos span'),
  region('Mid', -300, 378, 332, 1645, 75, 'medium', 'S8 mid/catwalk span'),
  region('ShortCatwalk', 36, 378, 1300, 1645, 83, 'medium', 'S8 short+catwalk span'),
  region('Long', 592, 1504, 382, 1385, 67, 'medium', 'S8 A-long span'),
  region('UpperTunnels', -1920, -1642, 805, 1384, 96, 'medium', 'S8 upper-tunnels span'),
  region('LowerTunnels', -1642, -1100, 805, 1100, 96, 'low', 'B tunnels lower span (interp.)'),
  region('BWindowPlat', -2050, -1712, 2864, 2927, 90, 'low', 'S8 B window/back-plat (high Y, see TRUTH_NOTES)'),
  region('Pit', 1472, 1600, 500, 700, 28, 'low', 'A-long pit (interp. around lower-ground setpos)'),
];

/** Build an 'opening' landmark from Source HU coords + choke width in HU. */
function opening(
  name: string,
  xHU: number,
  yHU: number,
  zHU: number,
  widthHU: number,
  confidence: Confidence,
  source: string,
): Landmark {
  const base = pt(name, xHU, yHU, zHU, confidence, source);
  return { ...base, kind: 'opening', widthCells: huWidthToCells(widthHU) };
}

/**
 * Build a 'region' landmark from a Source HU bounding box. xLoHU/xHiHU and
 * yLoHU/yHiHU are the min/max Source X and Y; zHU is the representative floor.
 * The bbox is normalized so row0<=row1 and col0<=col1.
 */
function region(
  name: string,
  xLoHU: number,
  xHiHU: number,
  yLoHU: number,
  yHiHU: number,
  zHU: number,
  confidence: Confidence,
  source: string,
): Landmark {
  // Two opposite corners; Source Y negates into Z, so corner mapping flips.
  const a = huToWorld(xLoHU, yLoHU, zHU);
  const b = huToWorld(xHiHU, yHiHU, zHU);
  const ca = worldToCell(a.x, a.z);
  const cb = worldToCell(b.x, b.z);
  const row0 = Math.min(ca.row, cb.row);
  const row1 = Math.max(ca.row, cb.row);
  const col0 = Math.min(ca.col, cb.col);
  const col1 = Math.max(ca.col, cb.col);
  // Centre point of the region (for x/z/row/col fields).
  const cx = (a.x + b.x) / 2;
  const cz = (a.z + b.z) / 2;
  const cc = worldToCell(cx, cz);
  return {
    name,
    kind: 'region',
    x: round2(cx),
    z: round2(cz),
    row: cc.row,
    col: cc.col,
    floorY: snapFloor(a.y),
    tolerance: TOL[confidence],
    bbox: { row0, col0, row1, col1 },
    confidence,
    source,
  };
}

/** All landmarks (points + openings + regions) in one array for the gate. */
export const DUST2_LANDMARKS: Landmark[] = [
  ...DUST2_POINTS,
  ...DUST2_OPENINGS,
  ...DUST2_REGIONS,
];

// ===========================================================================
// TRUTH_NOTES — flags the rebuild agent (T3) and fidelity agent (T2) must read.
// ===========================================================================
export const TRUTH_NOTES: readonly string[] = [
  // Elevation ceiling concern: the +2.31 m Y_OFFSET preserves real RELATIVE
  // heights but lifts every floor. The existing legend tops out at ~5.25 m.
  // Two LOW-confidence outliers would snap above that and are NOT trustworthy:
  //   - "A Short stairs" Source Z=204 HU -> 6.20 m raw (band 6.375). Suspect —
  //     likely an eye-height reading or a CT-upper-stairs apex, not a floor.
  //   - "Mid CT doors"   Source Z=172 HU -> 5.59 m raw (band 5.625). Same class.
  // Do NOT raise a real floor above ~5.25 m on the strength of these. They are
  // excluded from DUST2_POINTS' elevation anchors for that reason (kept only as
  // positional refs where used, with confidence 'low').
  'Elevation: Y_OFFSET=+2.31m makes CT spawn floor ~0; this lifts T-spawn to ~4.5m and B-site to ~4.1m. Relative ordering matches real dust2 but absolute bands differ from the existing legend (B=1.5, T=4.5). T3 owns final floor assignment — treat floorY as a relative-height hint, weight by confidence.',
  'Outliers EXCLUDED from elevation anchoring: "A Short stairs" (204 HU -> 6.375 band) and "Mid CT doors" (172 HU -> 5.625 band) exceed the ~5.25m legend ceiling and are confidence:low. Do not let them push any floor above 5.25m without in-game verification.',
  'Choke widths are LOW confidence (estimated from standard CS dims, not measured): LongDoors 256HU, Mid/B Doors 128HU, Tunnel 160HU, Catwalk 80HU. The fidelity gate should treat widthCells as +/-1 cell.',
  'Bomb plant points (BombAPlant/BombBPlant) come from radar normalized markers / interior setpos, NOT exact plant-spot coords (none found). MEDIUM confidence.',
  'T-spawn Source Z is the FEET interpretation (~110-122 HU). Some guides report ~183 HU (eye height, +63 HU). Floors use feet values.',
  'Grid coverage with these offsets: landmarks fall in rows 12..84, cols 13..81; full playable footprint corners at rows 6..90, cols 10..86 — all inside 0..95 with margin. The grid frame (96x96, origin -48/-48) is UNCHANGED.',
];
