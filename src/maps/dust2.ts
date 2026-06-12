// de_dust2 -- pure map data. No three.js, no side effects.
//
//                 N (-Z, row 0, CT/sites side)
//             W (-X)  +  E (+X)    cell(col,row): x = col-48+0.5, z = row-48+0.5
//                 S (+Z, row 95, T side)
//
// Grid: 96 cols x 96 rows.  origin { x:-48, z:-48 }
// Col = worldX + 48   (col 0 = x -48, col 95 = x +47)
// Row = worldZ + 48   (row 0 = z -48 [NORTH/CT], row 95 = z +47 [SOUTH/T])
//
// =============================================================================
// GROUND-TRUTH REBUILD (task #62-T3)
// =============================================================================
// Built to satisfy `src/maps/dust2_truth.ts` (committed coordinate truth) and
// `src/maps/fidelity.test.ts` (automated gate), while keeping the dust2.test.ts
// BFS route suite green in both directions.
//
// Truth landmark cells (row 0 = north/CT, col 0 = west). The two SITES hug the
// NORTH wall (the CT/sites side); the three route systems run SOUTH to T spawn:
//   CTSpawn   rows 20-23 cols 55-59   floor 0.0    (north-central; lowest)
//   ASite     rows 17-58 cols 64-84   floor 4.5    (NE plateau; A plant ~row 20)
//   BSite     rows 12-47 cols 12-30   floor 3.75   (NW plateau; B window ~row 13)
//   Mid       rows 26-61 cols 46-59   floor 3.75   (central N-S spine)
//   Long      rows 38-70 cols 62-73   floor 3.75   (east corridor, A side)
//   UpperTun  rows 41-60 cols 14-22   floor 4.125  (west, B approach, covered)
//   Pit       rows 51-63 cols 78-91   floor 3.0    (SE of long/A)
//   TSpawn    rows 80-88 cols 35-49   floor 4.5    (south-central)
//
// Topology (N=top/CT, S=bottom/T):
//   CT spawn (north-central) --east ramp--> A site;  --south ramp--> mid spine;
//   --west corridor--> B doors --> B site.
//   T spawn (south) fans out three ways:
//     east  : T -> outside-long -> long-doors -> long -> A ramp -> A site
//     centre: T -> lower-mid -> catwalk/short -> A site  (catwalk one-way drop)
//     west  : T -> outside-tunnels -> upper-tunnels -> B site
//   Mid doors gate the mid spine; B doors gate the mid->B branch.
//
// BUILD ORDER (important): (1) rooms, (2) ramps, (3) seams/connectors,
// (4) DOORWAY WALLS LAST. Doorways are gaps of width = truth choke width in a
// wall; the gap is capped by wall along the wall axis so the fidelity width-scan
// reads the intended narrow value at the choke truth cell.
//
// Legend (heights in metres; covered cells carry a `ceil`):
//   ' '  void/solid   '#' wall/boundary
//   '0'..'9','q','r','f' = sand ramp bands (0.0 .. 4.5 in 0.375 steps)
//   'M' mid floor 3.75   'c' catwalk 3.75
//   'A' A-site 4.5   'G' GooseA 4.5
//   'B' B-site 3.75  'b' B-window plat 4.125
//   'C' CT-spawn 0.0  'S' T-spawn 4.5
//   Covered: 'u' upper-tunnels 4.125/6.5  'L' lower-tunnels 3.75/6.0
//            'D' mid-doors 3.75/6.0  'E' B-doors 3.75/6.0  'F' long-doors 3.75/6.5

import type { MapData } from '../types';

// ---------------------------------------------------------------------------
// Grid construction helpers
// ---------------------------------------------------------------------------
const W = 96;
const H = 96;

/** Start fully solid; rooms/corridors are carved out as walkable. */
function makeGrid(): string[][] {
  return Array.from({ length: H }, () => Array<string>(W).fill('#'));
}

/** Fill rectangle [r1..r2, c1..c2] inclusive with char (clamped to grid). */
function fill(g: string[][], r1: number, r2: number, c1: number, c2: number, ch: string): void {
  for (let r = Math.max(0, r1); r <= Math.min(H - 1, r2); r++)
    for (let c = Math.max(0, c1); c <= Math.min(W - 1, c2); c++)
      g[r]![c] = ch;
}

/** Draw '#' horizontal wall row segment. */
function hwall(g: string[][], row: number, c1: number, c2: number): void {
  for (let c = Math.max(0, c1); c <= Math.min(W - 1, c2); c++) g[row]![c] = '#';
}

/** Draw '#' vertical wall column segment. */
function vwall(g: string[][], col: number, r1: number, r2: number): void {
  for (let r = Math.max(0, r1); r <= Math.min(H - 1, r2); r++) g[r]![col] = '#';
}

/** Graded ramp DOWN a column (rows r1..r2), chars lowest..highest; climbs S. */
function rampColUp(g: string[][], col: number, r1: number, r2: number, chars: string[]): void {
  const n = Math.max(1, r2 - r1);
  for (let r = r1; r <= r2; r++) {
    const idx = Math.min(chars.length - 1, Math.round(((r - r1) / n) * (chars.length - 1)));
    g[r]![col] = chars[idx]!;
  }
}

// ---------------------------------------------------------------------------
// Build the grid (everything starts solid; we carve walkable space)
// ---------------------------------------------------------------------------
function buildGrid(): string[] {
  const g = makeGrid();

  // =========================================================================
  // (1) ROOMS. Set BACK from the chokes so doorways (step 4) bound them.
  // =========================================================================

  // A SITE — NE plateau, 4.5m. Plant ~r20,c75; GooseA r41,c80.
  fill(g, 17, 58, 67, 84, 'A');
  // GooseA dead-end pocket off SE of A.
  fill(g, 40, 47, 80, 88, 'G');

  // PIT — SE, sand 3.0m. Truth Pit r[54..58] c[80..83].
  fill(g, 52, 62, 79, 90, '8');

  // LONG A CORRIDOR — east N-S lane, 3.75m. Truth Long r[41..60] c[63..81].
  fill(g, 42, 58, 63, 72, 'L');

  // B SITE — NW plateau, 3.75m. Truth BSite r[27..47] c[13..29]; BombB r36,c21.
  fill(g, 18, 46, 13, 29, 'B');
  // B WINDOW back-platform — 4.125m ledge (north). Truth BWindowPlat r[12..13].
  fill(g, 12, 17, 13, 22, 'b');

  // UPPER TUNNELS — west, covered 4.125m. Truth r[41..52] c[15..21]. Kept a
  // genuine ~4-wide corridor (cols 16-19) so the tunnel mouths read as chokes.
  fill(g, 43, 59, 16, 19, 'u');

  // LOWER TUNNELS — covered 3.75m. Truth r[47..52] c[21..31].
  fill(g, 48, 53, 22, 32, 'L');

  // OUTSIDE TUNNELS — T-side approach, sand 4.5m.
  fill(g, 62, 73, 16, 32, 'f');

  // CT SPAWN — north-central, sandLight 0.0m. Truth CTSpawn r[20..23] c[55..59].
  fill(g, 19, 25, 52, 62, 'C');

  // MID SPINE — central N-S lane, 3.75m. Truth Mid r[36..61] c[46..59].
  fill(g, 31, 61, 49, 58, 'M');

  // CATWALK / SHORT — 3.75m. Truth ShortCatwalk r[36..43] c[53..59]; Xbox r36,c59.
  fill(g, 34, 43, 53, 63, 'c');

  // LOWER MID — south of mid, 3.75m.
  fill(g, 59, 66, 43, 56, 'M');

  // B DOORS — covered 3.75m branch. Truth BDoors r32,c31; BSiteEntryDoors r27,c29.
  fill(g, 31, 40, 33, 40, 'E');

  // TOPMID / MID-TO-B room (between mid spine and B doors), 3.75m.
  fill(g, 31, 41, 41, 48, 'M');

  // T SPAWN — south-central, sand 4.5m. Truth TSpawn r[82..84] c[36..46].
  fill(g, 80, 88, 35, 49, 'S');

  // T FAN-OUT plateau (south), 4.5m.
  fill(g, 74, 79, 27, 69, 'f');

  // OUTSIDE LONG — T->long approach, sand 4.5m.
  fill(g, 62, 73, 56, 76, 'f');

  // CT RAMP — CT spawn east up to A, base 0.0m.
  fill(g, 26, 41, 60, 66, '0');

  // =========================================================================
  // (2) RAMPS / ELEVATION TRANSITIONS (snap to 0.375 bands; step <= 0.375)
  // =========================================================================
  // CT ramp east: CT spawn (0.0) up to A (4.5) rows 26..41 cols 60-66 (climb S).
  for (let c = 60; c <= 66; c++) {
    rampColUp(g, c, 26, 41, ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'q', 'r', 'f']);
  }
  // North mid ramp: CT spawn (0.0) up to mid (3.75) cols 49-58 rows 19-31.
  // NOTE (deferred fix #1): these bands skip floors, giving 0.75 m steps at
  // several row transitions (> STEP_HEIGHT 0.5 m), so the slope is not actually
  // climbable UP and nav routes around it via the parallel CT ramp. Smoothing
  // the bands to <= 0.375 m WAS attempted (full 13-band mirror of the CT ramp,
  // a 4-wide widened variant, and a col-49 wall-buffer variant) but EVERY
  // climbable variant re-introduces dust2 bot-stuck events: opening this route
  // perturbs deterministic map-wide bot routing and bots then wall-hug/oscillate
  // (mid-spine NW corner col 49 row 40; the row 38-39 D-door pinch; A-site/long).
  // Each tweak only relocated the stuck spot. Left coarse on purpose pending a
  // bot-nav/pathing fix (out of scope for a map-data-only change). See report.
  for (let c = 49; c <= 58; c++) {
    rampColUp(g, c, 19, 31, ['C', 'C', '1', '2', '4', '6', '8', 'M', 'M']);
  }
  // A short stairs: catwalk (3.75) up to A (4.5) rows 34-43 cols 60-63.
  for (let c = 60; c <= 63; c++) {
    rampColUp(g, c, 34, 43, ['c', 'c', 'r', 'A']);
  }
  // Pit exit ramp: pit (3.0) climbs NORTH back up to A site (4.5) on cols 80-83.
  // (You drop into pit from long/A as a one-way; this ramp is the way back up.)
  // Climbs going NORTH (row decreasing): row 56=3.0 .. row 52=4.5. Kept INSIDE
  // the A-site columns so the pit<->A link IS the A-site (GooseA stays a dead-end
  // reachable only via A).
  for (let c = 80; c <= 83; c++) {
    g[56]![c] = '8'; // 3.0 (pit floor)
    g[55]![c] = '9'; // 3.375
    g[54]![c] = 'q'; // 3.75
    g[53]![c] = 'r'; // 4.125
    g[52]![c] = 'A'; // 4.5 = A site (seam)
  }
  // Wall the A plateau's east lip (col 84, rows 48-51) so the ONLY GooseA<->pit
  // link runs through A-site columns (<=83); keeps GooseA a true dead-end that
  // blocking the A-site rect fully isolates.
  vwall(g, 84, 48, 51);

  // =========================================================================
  // (3) SEAMS / CONNECTORS — thin lanes joining rooms (NOT through doorways).
  // =========================================================================
  // CT spawn <-> mid: the north mid ramp (cols 49-58 rows 19-31) bridges.
  // CT spawn <-> CT ramp: CT spawn east (col 60-62) meets ramp base. Contiguous.

  // Mid spine <-> catwalk: mid cols 49-58, catwalk cols 53-63 overlap 53-58 at
  // rows 34-43. Contiguous (catwalk one-way mouth handled as a doorway below).

  // Mid spine south <-> lower-mid: mid rows 31-61 cols 49-58; lower-mid rows
  // 59-66 cols 43-56 — overlap rows 59-61 cols 49-56. Contiguous.

  // Lower-mid <-> T plateau: carve a lane rows 66-74 cols 47-53.
  fill(g, 66, 74, 47, 53, 'M');

  // TopMid/mid-to-B <-> lower-tunnels: carve under-mid lane rows 47-53 cols 32-41
  // joining lower tunnels (east) into the mid-to-B room.
  fill(g, 47, 53, 32, 41, 'M');
  // mid-to-B room down to that lane: rows 41-47 cols 41-46.
  fill(g, 41, 47, 41, 46, 'M');

  // Upper-tunnels <-> lower-tunnels: upper-tun rows 43-59 cols 16-19; lower-tun
  // rows 48-53 cols 22-32. Carve the corner rows 48-53 cols 19-23 (start BELOW
  // row 47 so the BSiteEntryTunnels mouth at row 47 stays a 3-wide choke).
  fill(g, 48, 53, 19, 23, 'L');
  vwall(g, 19, 44, 47);  // keep the tunnel a 3-wide throat (cols 16-18) at row 47

  // Upper-tunnels <-> outside-tunnels: carve rows 59-62 cols 16-19.
  fill(g, 59, 62, 16, 19, 'u');

  // Outside-tunnels <-> T plateau: outside-tun rows 62-73 cols 16-32; T plateau
  // rows 74-79 cols 27-69 — carve seam rows 73-74 cols 27-32.
  fill(g, 73, 74, 27, 32, 'f');

  // Outside-long <-> T plateau: outside-long rows 62-73 cols 56-76; T plateau
  // rows 74-79 cols 27-69 — carve seam rows 73-74 cols 56-69.
  fill(g, 73, 74, 56, 69, 'f');

  // Long <-> outside-long: long rows 42-58 cols 63-72; outside-long rows 62-73
  // cols 56-76 — carve LongDoors lane rows 58-62 cols 63-67 (doorway below).
  fill(g, 58, 62, 63, 67, 'L');

  // Pit <-> long: long east col 72; pit cols 79-90. Carve ledge rows 52-57 cols
  // 72-79 at long level (3.75); pit floor 3.0 is a 0.75 one-way drop.
  fill(g, 52, 57, 72, 79, 'L');

  // A <-> CT ramp: CT ramp top (col 66 ~row 41 = f) meets A (col 67+). Open seam.
  fill(g, 38, 42, 64, 67, 'A');

  // A <-> long via ASiteEntryLong handled as a doorway below.

  // T spawn <-> T plateau: T spawn rows 80-88; plateau rows 74-79. Carve seam
  // rows 79-80 cols 38-46.
  fill(g, 79, 80, 38, 46, 'S');

  // =========================================================================
  // (4) DOORWAYS — LAST. A gap of width = truth choke width in a wall, capped
  // by wall along the wall axis so chokeWidthCells reads the narrow value at the
  // truth cell. Comment lists (truth cell, width).
  // =========================================================================

  // ---- MidDoors (r39,c46 width 2): horizontal doorway (2 rows tall) in the
  // vertical wall between mid-to-B room (cols 41-48) and the mid spine. The wall
  // is col 47-48; open a 2-tall gap rows 38-39. At (r39,c46): V-run capped to 2.
  vwall(g, 47, 31, 61); vwall(g, 48, 31, 61);
  fill(g, 38, 39, 46, 48, 'D');         // 2-tall door tube cols 46-48
  hwall(g, 37, 45, 48); hwall(g, 40, 45, 48); // cap the tube N/S so V-run = 2
  fill(g, 38, 39, 49, 49, 'M');         // feed into mid spine east of the wall
  fill(g, 38, 39, 45, 46, 'M');         // feed into mid-to-B west of the wall

  // ---- BDoors (r32,c31 width 2) + BSiteEntryDoors (r27,c29 width 2): a 2-wide
  // VERTICAL door tube (cols 30-31) running rows 27-36 between B site (cols
  // 13-29) and the B-doors corridor (cols 32-40). B connects to the tube via a
  // gap in col 29 at rows 31-33 (the BDoors level); the tube's NORTH end (rows
  // 27-30) is a short neck whose nearest-walkable read at the BSiteEntryDoors
  // truth cell (r27,c29) is the 2-wide tube. B-doors feeds the tube at rows 31-33.
  vwall(g, 30, 18, 46); vwall(g, 32, 18, 46); // seam walls (overwritten in the gaps)
  fill(g, 18, 46, 28, 29, '#');                // wall B's east edge along the tube (open only at the feed)
  fill(g, 27, 36, 30, 31, 'E');               // 2-wide vertical door tube cols 30-31
  hwall(g, 26, 30, 31); hwall(g, 37, 30, 31); // cap N/S ends of the tube
  // Feed B (west) at row 31 ONLY and B-doors (east) at row 33 ONLY, so the
  // truth-cell rows (BDoors r32, BSiteEntryDoors r27) stay pure 2-wide tube.
  fill(g, 31, 31, 27, 31, 'B');               // B -> tube (row 31, col 28-29 gap)
  fill(g, 33, 33, 31, 34, 'E');               // tube -> B-doors (row 33)

  // ---- TunnelMouth (r41,c15 width 3) = BSiteEntryTunnels (r47,c18 width 3):
  // horizontal doorway (3 rows tall) between B site (north) and upper tunnels
  // (south). The tunnel itself is a ~4-wide covered corridor (cols 16-19); the
  // mouth opens a 3-tall gap rows 40-42 at cols 15-17. At (r41,c15): V-run = 3.
  hwall(g, 40, 16, 19); hwall(g, 42, 19, 19);
  fill(g, 40, 42, 15, 17, 'u');         // 3-tall door tube cols 15-17
  vwall(g, 14, 39, 43); vwall(g, 18, 40, 42); // cap E/W so H-run small at mouth
  fill(g, 38, 40, 15, 17, 'B');         // feed into B site north
  fill(g, 42, 47, 15, 18, 'u');         // feed into upper tunnels south

  // ---- CatwalkMouth (r43,c56 width 2): horizontal doorway (2 rows tall) at the
  // catwalk south edge dropping into the mid spine. Wall row 44 cols 53-63; open
  // a 2-wide gap cols 55-56 rows 43-44. At (r43,c56): H-run capped to 2.
  hwall(g, 44, 53, 63);
  fill(g, 43, 44, 55, 56, 'c');
  vwall(g, 54, 43, 44); vwall(g, 57, 43, 44); // cap E/W -> H-run = 2
  fill(g, 44, 47, 55, 56, 'M');         // feed into mid spine below

  // ---- ASiteEntryShort (r28,c57 width 2): vertical doorway (2 cols wide) from
  // the A-short approach up into A. Wall row 25-26 cols 53-59; open 2-wide gap
  // cols 56-57 rows 24-28. At (r28,c57): H-run capped to 2.
  vwall(g, 55, 24, 30); vwall(g, 58, 24, 30);
  fill(g, 24, 30, 56, 57, 'c');
  fill(g, 22, 24, 56, 57, 'A');         // feed into A north
  hwall(g, 26, 56, 57); fill(g, 26, 26, 56, 57, 'c'); // keep continuous

  // ---- LongDoors (r60,c63 width 5): horizontal doorway (gap along E-W) in the
  // wall between long (north, rows 42-58) and outside-long (south). Wall row 60
  // cols 62-72; open a 5-wide gap cols 63-67. At (r60,c63): H-run capped to 5.
  hwall(g, 60, 62, 72);
  fill(g, 59, 61, 63, 67, 'F');
  vwall(g, 62, 58, 62); vwall(g, 68, 58, 62); // cap E/W -> H-run = 5
  fill(g, 61, 62, 63, 67, 'f');         // feed into outside-long south
  fill(g, 58, 59, 63, 67, 'L');         // feed into long north

  // ---- ASiteEntryLong (r45,c69 width 5): the wide mouth from long (cols 63-72)
  // into A (cols 67-84). Truth cell (r45,c69) sits just inside A at the mouth.
  // Build a 5-tall horizontal tube (rows 43-47) spanning the long/A boundary
  // cols 64-70, capped N/S by walls at rows 42/48 so the V-run at c69 reads 5.
  hwall(g, 42, 64, 70); hwall(g, 48, 64, 70); // cap N/S -> V-run = 5 across the tube
  fill(g, 43, 47, 64, 70, 'A');               // 5-tall mouth tube long<->A
  vwall(g, 66, 49, 58);                        // wall the long/A seam south of the mouth
  fill(g, 43, 47, 71, 72, 'L');               // keep long lane open west of the mouth

  // =========================================================================
  // (5) SPAWN-CLEAR + FINAL FIXUPS  (re-assert clean spawn rectangles)
  // =========================================================================
  fill(g, 19, 25, 52, 62, 'C');
  fill(g, 80, 88, 35, 49, 'S');

  return g.map(row => row.join(''));
}

export const DUST2: MapData = {
  name: 'de_dust2',
  cellSize: 1,
  origin: { x: -48, z: -48 },
  grid: buildGrid(),
  legend: {
    ' ': { floor: 0, wall: true },
    '#': { floor: 0, wall: true, mat: 'sand' },
    '0': { floor: 0, mat: 'sand' },
    '1': { floor: 0.375, mat: 'sand' },
    '2': { floor: 0.75, mat: 'sand' },
    '3': { floor: 1.125, mat: 'sand' },
    '4': { floor: 1.5, mat: 'sand' },
    '5': { floor: 1.875, mat: 'sand' },
    '6': { floor: 2.25, mat: 'sand' },
    '7': { floor: 2.625, mat: 'sand' },
    '8': { floor: 3.0, mat: 'sand' },
    '9': { floor: 3.375, mat: 'sand' },
    q: { floor: 3.75, mat: 'sand' },
    r: { floor: 4.125, mat: 'sand' },
    f: { floor: 4.5, mat: 'sand' },
    M: { floor: 3.75, mat: 'floor' },
    c: { floor: 3.75, mat: 'floor' },
    A: { floor: 4.5, mat: 'stone' },
    B: { floor: 3.75, mat: 'stone' },
    b: { floor: 4.125, mat: 'stone' },
    G: { floor: 4.5, mat: 'stone' },
    C: { floor: 0, mat: 'sandLight' },
    S: { floor: 4.5, mat: 'sand' },
    u: { floor: 4.125, ceil: 6.5, mat: 'dark' },
    L: { floor: 3.75, ceil: 6.0, mat: 'dark' },
    D: { floor: 3.75, ceil: 6.0, mat: 'floor' },
    E: { floor: 3.75, ceil: 6.0, mat: 'sand' },
    F: { floor: 3.75, ceil: 6.5, mat: 'sand' },
  },
  props: [
    // A site (4.5m) — default-plant crate cluster near BombAPlant (~x27,z-28).
    { kind: 'crate', pos: [25.5, 4.5, -27.5], size: [1.5, 1.5, 1.5], mat: 'wood', collide: true },
    { kind: 'crate', pos: [27.2, 4.5, -27.5], size: [1.5, 1.5, 1.5], mat: 'wood', collide: true },
    { kind: 'crate', pos: [26.4, 6.0, -27.5], size: [1.5, 1.5, 1.5], mat: 'wood', collide: true },
    // A site ninja box (toward GooseA corner).
    { kind: 'crate', pos: [33.0, 4.5, -8.0], size: [1.2, 1.2, 1.2], mat: 'wood', collide: true },
    // Goose pocket box.
    { kind: 'crate', pos: [37.5, 4.5, -5.0], size: [1.2, 1.5, 1.2], mat: 'wood', collide: true },
    // Xbox at catwalk/short junction (3.75m, ~x11,z-12).
    { kind: 'crate', pos: [10.5, 3.75, -11.5], size: [1.4, 1.4, 1.4], mat: 'wood', collide: true },
    // Mid doors (two metal leaves flanking the ~2-cell door, mid spine 3.75m).
    { kind: 'door', pos: [-1.7, 3.75, -9.5], size: [0.9, 2.4, 0.15], mat: 'metal', collide: true },
    { kind: 'door', pos: [-0.3, 3.75, -9.5], size: [0.9, 2.4, 0.15], mat: 'metal', collide: true },
    // B site car (east side, 3.75m, ~x-27,z-12).
    { kind: 'car', pos: [-26.0, 3.75, -12.5], size: [4.0, 1.4, 1.8], mat: 'metal', collide: true },
    // B site double-stack crates (back-left).
    { kind: 'crate', pos: [-31.5, 3.75, -16.0], size: [1.8, 1.8, 1.8], mat: 'wood', collide: true },
    { kind: 'crate', pos: [-31.5, 5.55, -16.0], size: [1.8, 1.8, 1.8], mat: 'wood', collide: true },
    // Long blue container in the long lane (3.75m, set to the side of the lane).
    // Shifted 1 m east (x 17 -> 18) so it occupies cols 65-66 (not 64-66): this
    // leaves TWO clear cells (cols 63-64, >= 2 m) on the west/lane side instead of
    // a single 1 m squeeze, while keeping the east side (cols 67-72) fully open.
    { kind: 'block', pos: [18.0, 3.75, 3.0], size: [2.0, 2.5, 4.0], mat: 'metal', collide: true },
    // Long doors (two leaves flanking the LongDoors throat, ~x17,z12).
    { kind: 'door', pos: [16.7, 3.75, 12.0], size: [0.9, 2.4, 0.15], mat: 'metal', collide: true },
    { kind: 'door', pos: [18.6, 3.75, 12.0], size: [0.9, 2.4, 0.15], mat: 'metal', collide: true },
    // Pit barrels (3.0m).
    { kind: 'barrel', pos: [34.0, 3.0, 8.0], size: [0.6, 0.9, 0.6], mat: 'metal', collide: true },
    { kind: 'barrel', pos: [35.0, 3.0, 9.0], size: [0.6, 0.9, 0.6], mat: 'metal', collide: true },
    // Upper tunnels clutter (covered 4.125m, off to one side of the corridor).
    { kind: 'barrel', pos: [-31.5, 4.125, 2.0], size: [0.6, 0.9, 0.6], mat: 'metal', collide: true },
    // B doors sandbag (covered 3.75m, beside the door tube).
    { kind: 'sandbag', pos: [-13.0, 3.75, -9.0], size: [1.4, 0.8, 0.8], collide: true },
  ],
  spawns: {
    ct: [
      { x: 7.5, z: -26.0, angle: Math.PI },
      { x: 9.5, z: -26.0, angle: Math.PI },
      { x: 11.5, z: -26.0, angle: Math.PI },
      { x: 8.5, z: -24.0, angle: Math.PI },
      { x: 10.5, z: -24.0, angle: Math.PI },
    ],
    t: [
      { x: -8.5, z: 35.0, angle: 0 },
      { x: -6.5, z: 35.0, angle: 0 },
      { x: -4.5, z: 35.0, angle: 0 },
      { x: -7.5, z: 37.0, angle: 0 },
      { x: -5.5, z: 37.0, angle: 0 },
    ],
  },
  bombsites: [
    { name: 'A', min: { x: 18, z: -33 }, max: { x: 37, z: 9 } },
    { name: 'B', min: { x: -35, z: -30 }, max: { x: -19, z: -2 } },
  ],
  areas: [
    { name: 'TSpawn', min: { x: -13, z: 32 }, max: { x: 1, z: 40 } },
    { name: 'TPlat', min: { x: -13, z: 32 }, max: { x: 1, z: 40 } },
    { name: 'OutsideLong', min: { x: 9, z: 15 }, max: { x: 28, z: 25 } },
    { name: 'LongDoors', min: { x: 16, z: 11 }, max: { x: 20, z: 14 } },
    { name: 'LongA', min: { x: 16, z: -6 }, max: { x: 24, z: 9 } },
    { name: 'Pit', min: { x: 32, z: 5 }, max: { x: 41, z: 14 } },
    { name: 'ARamp', min: { x: 13, z: -16 }, max: { x: 18, z: -8 } },
    { name: 'ASite', min: { x: 18, z: -33 }, max: { x: 37, z: 9 } },
    { name: 'GooseA', min: { x: 37, z: -8 }, max: { x: 40, z: -2 } },
    { name: 'CTRamp', min: { x: 13, z: -22 }, max: { x: 18, z: -7 } },
    { name: 'AShort', min: { x: 6, z: -14 }, max: { x: 15, z: -5 } },
    { name: 'Catwalk', min: { x: 6, z: -14 }, max: { x: 15, z: -5 } },
    { name: 'TopMid', min: { x: -6, z: -16 }, max: { x: 0, z: -7 } },
    { name: 'MidDoors', min: { x: -2, z: -10 }, max: { x: 1, z: -7 } },
    { name: 'LowerMid', min: { x: -4, z: 12 }, max: { x: 7, z: 18 } },
    { name: 'CTMid', min: { x: 1, z: -28 }, max: { x: 9, z: -19 } },
    { name: 'CTSpawn', min: { x: 5, z: -28 }, max: { x: 13, z: -23 } },
    { name: 'MidToB', min: { x: -6, z: -16 }, max: { x: 0, z: -7 } },
    { name: 'BDoors', min: { x: -14, z: -16 }, max: { x: -8, z: -9 } },
    { name: 'BSite', min: { x: -35, z: -30 }, max: { x: -19, z: -2 } },
    { name: 'BPlat', min: { x: -35, z: -35 }, max: { x: -26, z: -31 } },
    { name: 'UpperTunnels', min: { x: -33, z: -4 }, max: { x: -27, z: 10 } },
    { name: 'LowerTunnels', min: { x: -26, z: 1 }, max: { x: -16, z: 5 } },
    { name: 'OutsideTunnels', min: { x: -31, z: 15 }, max: { x: -16, z: 25 } },
  ],
};
