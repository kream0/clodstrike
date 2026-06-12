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
// HIGH-CONFIDENCE ANCHORS (world coords):
//   T-spawn center   (-5, +30)   -> col 43, row 78
//   CT-spawn center  (+2, -40)   -> col 50, row  8
//   A-site center    (+25, -40)  -> col 73, row  8
//   B-site center    (-28, -40)  -> col 20, row  8
//
// Legend (heights in metres; covered cells have ceil property):
//   ' '  void/solid   '#' wall/boundary
//   'p' -0.75  'P' -0.375  (pit depths)
//   '0' 0.0  '1' 0.375  '2' 0.75  '3' 1.125  '4' 1.5
//   '5' 1.875  '6' 2.25  '7' 2.625  '8' 3.0  '9' 3.375
//   'q' 3.75  'r' 4.125  'f' 4.5
//   'M' 0.0 (mid-floor)  'm' 0.375  'n' 0.75  'o' 1.125
//   'v' 1.875  'w' 2.25  'x' 2.625  'y' 3.0  'z' 3.375
//   'c' 2.25 catwalk  'A' 4.5 A-site/short  'G' 4.5 GooseA
//   'B' 1.5 B-site  'b' 2.25 B-plat
//   'C' 0.0 CT-spawn  'S' 4.5 T-spawn plateau
//   Covered tunnels (floor/ceil):
//     'u' 1.5/4.5  'i' 1.875/4.5  'j' 2.25/4.5  'k' 2.625/4.5  'h' 3.0/4.5
//   'L' 0.375/3.5 lower-tunnels
//   'D' 0.0/4.0 mid-doors  'E' 1.5/4.5 B-doors  'F' 1.5/4.0 long-doors
//
// Map layout (N=top/CT, S=bottom/T):
//
//  Row 0-1:   void borders
//  Row 2-17:  [BSite][BDoors][CTSpawn][CTRamp][ASite][GooseA]
//  Row 15-68: [UpperTunnels]
//  Row 18-44: [MidToB][CTMid][TopMid][Catwalk][ARamp]
//  Row 18-72: [LongA] (4.5m elevated)
//  Row 18-32: [Pit]
//  Row 44-60: [MidDoors]
//  Row 56-68: [LowerTunnels]
//  Row 55-75: [OutsideLong] (outdoor ramp up to LongA from south)
//  Row 61-68: [LowerMid]
//  Row 68-78: [OutsideTunnels]
//  Row 68-82: [TSpawn]
//
// Topology (bidirectional unless →):
//  TSpawn↔OutsideTunnels(ramp), TSpawn↔EastRamp↔OutsideLong
//  OutsideLong↔OutsideLongRamp→LongA(one-way up), LongA→Pit(drop), Pit↔LongA(east ramp)
//  LongA↔ASite, ASite↔ARamp/AShort↔Catwalk(bottom=2.25m), Catwalk↔CTMid
//  Catwalk→Mid(one-way drop col48→col47), TopMid↔MidDoors↔LowerMid
//  LowerMid↔LowerTunnels↔UpperTunnels↔BSite
//  CTMid↔MidToB↔BDoors↔BSite, CTSpawn↔CTRamp↔ASite
//  GooseA=dead-end off ASite

import type { MapData } from '../types';

// ---------------------------------------------------------------------------
// Grid construction helpers
// ---------------------------------------------------------------------------
const W = 96;
const H = 96;

function makeGrid(): string[][] {
  return Array.from({ length: H }, () => Array<string>(W).fill(' '));
}

/** Fill rectangle [r1..r2, c1..c2] inclusive with char. */
function fill(g: string[][], r1: number, r2: number, c1: number, c2: number, ch: string): void {
  for (let r = r1; r <= r2; r++)
    for (let c = c1; c <= c2; c++)
      g[r]![c] = ch;
}

/** Draw '#' horizontal wall row. */
function hwall(g: string[][], row: number, c1: number, c2: number): void {
  for (let c = c1; c <= c2; c++) g[row]![c] = '#';
}

/** Draw '#' vertical wall column. */
function vwall(g: string[][], col: number, r1: number, r2: number): void {
  for (let r = r1; r <= r2; r++) g[r]![col] = '#';
}

// ---------------------------------------------------------------------------
// Build the grid
// ---------------------------------------------------------------------------
function buildGrid(): string[] {
  const g = makeGrid();

  // =========================================================================
  // OUTER NORTH WALL
  // =========================================================================
  hwall(g, 1, 3, 93);

  // =========================================================================
  // B SITE  (cols 4-22, rows 2-17)  -- stone 1.5m
  // East open rows 7-13 (B site <-> B doors passage)
  // =========================================================================
  fill(g, 2, 17, 4, 22, 'B');
  hwall(g, 2, 4, 22);       // N outer
  vwall(g, 4, 2, 17);       // W outer
  hwall(g, 17, 4, 22);      // S outer
  vwall(g, 22, 2, 6);       // E outer north
  vwall(g, 22, 14, 17);     // E outer south (open rows 7-13 for B site <-> B doors)
  // Open B site S wall at tunnel cols 5-13:
  fill(g, 17, 17, 5, 13, 'B');

  // =========================================================================
  // B DOORS  (cols 23-35, rows 2-17)  -- covered sand 1.5m
  // =========================================================================
  fill(g, 2, 17, 23, 35, 'E');
  hwall(g, 2, 23, 35);      // N outer
  vwall(g, 35, 2, 17);      // E outer
  // Bridge rows 17-18 connecting B doors to MidToB:
  // Cols 23-34: ramp stepping down from E(1.5m) to 0(0.0m) going west
  // (east end = B doors level, west end = MidToB level)
  fill(g, 17, 18, 23, 35, 'E');  // bridge at E level east portion
  fill(g, 17, 18, 24, 24, '4');  // 1.5m
  fill(g, 17, 18, 25, 25, '3');  // 1.125m
  fill(g, 17, 18, 26, 26, '2');  // 0.75m
  fill(g, 17, 18, 27, 27, '1');  // 0.375m
  fill(g, 17, 18, 28, 34, '0');  // 0.0m = MidToB level

  // =========================================================================
  // CT SPAWN  (cols 36-53, rows 2-17)  -- sandLight 0.0m
  // Spawns at cols 48,50,52 row8 and cols 49,51 row10 -- all interior
  // =========================================================================
  fill(g, 2, 17, 36, 53, 'C');
  hwall(g, 2, 36, 53);      // N outer
  vwall(g, 36, 2, 17);      // W outer
  vwall(g, 53, 2, 17);      // E outer
  hwall(g, 17, 36, 53);     // S outer (open cols 37-38 for CT mid below)
  fill(g, 17, 17, 37, 38, 'C'); // open CT spawn S wall -> CT mid passage

  // =========================================================================
  // CT RAMP  (cols 53-63, rows 4-17)  -- stepping 0.0m -> 4.5m going east
  // col53 = CT spawn E wall open; col63 = A site entry (f=4.5)
  // =========================================================================
  fill(g, 4, 17, 54, 63, '0');   // base fill
  fill(g, 4, 17, 55, 56, '1');
  fill(g, 4, 17, 57, 58, '2');
  fill(g, 4, 17, 59, 60, '3');
  fill(g, 4, 17, 61, 62, 'r');
  fill(g, 4, 17, 63, 63, 'f');
  hwall(g, 3, 54, 63);           // N outer
  fill(g, 4, 17, 53, 53, '0');   // open CT spawn E wall (0.0m bridge)

  // =========================================================================
  // A SITE  (cols 64-88, rows 2-17)  -- stone 4.5m
  // No south wall; A ramp/catwalk access from below (row18+)
  // West: CT ramp top col63=f(4.5) adjacent to A site col64=A(4.5) -- same height ✓
  // =========================================================================
  fill(g, 2, 17, 64, 88, 'A');
  hwall(g, 2, 64, 88);      // N outer
  vwall(g, 88, 2, 17);      // E outer
  // No S wall (allow A ramp / short stairs to enter from south)

  // GOOSE A  (cols 87-93, rows 2-9)  -- stone 4.5m (dead-end pocket)
  fill(g, 2, 9, 87, 93, 'G');
  hwall(g, 1, 87, 93);
  hwall(g, 10, 87, 93);
  vwall(g, 93, 2, 9);

  // =========================================================================
  // CT MID  (cols 36-39, rows 18-44)  -- sandLight 0.0m
  // Connects CT spawn (south exit cols 37-38) to mid corridor (col40+)
  // =========================================================================
  fill(g, 18, 44, 36, 39, 'C');
  vwall(g, 36, 18, 44);     // W outer
  hwall(g, 44, 36, 39);     // S boundary

  // =========================================================================
  // MID CORRIDOR  (cols 40-47, rows 18-60)  -- floor 0.0m
  // col47=M at row40 (catwalk one-way boundary), col48=c (catwalk)
  // =========================================================================
  fill(g, 18, 60, 40, 47, 'M');
  hwall(g, 18, 40, 47);     // N outer
  // E wall: col47 except at row40 (catwalk one-way junction)
  vwall(g, 47, 18, 39);     // E wall above catwalk junction
  vwall(g, 47, 41, 60);     // E wall below catwalk junction
  // row40 col47=M (open), col48=c (catwalk) -- one-way drop from catwalk
  hwall(g, 60, 40, 47);     // S boundary (open at 41-47 for lower mid bridge below)
  fill(g, 60, 60, 41, 47, 'M'); // override S wall at bridge zone
  fill(g, 60, 61, 41, 47, 'M'); // bridge rows 60-61 to lower mid
  // Mid doors section (covered):
  fill(g, 44, 55, 41, 46, 'D');

  // =========================================================================
  // MID-TO-B CORRIDOR  (cols 14-36, rows 18-28)  -- floor 0.0m
  // Ramp at west end (cols 14-17) connects to UpperTunnels (1.5m) at col13
  // =========================================================================
  fill(g, 18, 28, 14, 36, 'M');
  hwall(g, 28, 14, 36);     // S outer
  vwall(g, 14, 18, 28);     // W outer (ramp overrides at cols 14-17 below)
  // W ramp: step from tunnels level (1.5m) down to mid level (0.0m):
  fill(g, 19, 27, 14, 14, '4'); // 1.5m (same as upper tunnels)
  fill(g, 19, 27, 15, 15, '3'); // 1.125m
  fill(g, 19, 27, 16, 16, '2'); // 0.75m
  fill(g, 19, 27, 17, 17, '1'); // 0.375m
  // col18 onward = 'M' (0.0m) -- covered by main fill

  // =========================================================================
  // CATWALK  (cols 48-63, rows 18-44)  -- floor 2.25m
  // East side connects to A ramp/short stairs at col64 (same height ✓)
  // West side: one-way drop to mid at col47/48 junction (row40)
  // =========================================================================
  fill(g, 18, 44, 48, 63, 'c');
  hwall(g, 18, 48, 63);     // N outer
  hwall(g, 44, 48, 63);     // S outer
  // No full east wall at col63: catwalk east col63=c(2.25) connects to A ramp west col64=6(2.25)
  // Only put east wall south of short stairs (rows 34-44 where short stairs end at row33):
  vwall(g, 63, 34, 44);

  // =========================================================================
  // A RAMP / SHORT STAIRS  (cols 64-72, rows 18-33)
  // Steps from catwalk level (col64=6, 2.25m) up to A site level (col70-72=f, 4.5m)
  // North connects to A site (row17=A(4.5), row18=f(4.5): same height, no wall)
  // =========================================================================
  fill(g, 18, 33, 64, 72, 'f');   // base fill f(4.5m)
  fill(g, 19, 32, 64, 64, '6');   // 2.25m = catwalk level
  fill(g, 19, 32, 65, 65, '7');   // 2.625m
  fill(g, 19, 32, 66, 66, '8');   // 3.0m
  fill(g, 19, 32, 67, 67, '9');   // 3.375m
  fill(g, 19, 32, 68, 68, 'q');   // 3.75m
  fill(g, 19, 32, 69, 69, 'r');   // 4.125m
  // cols 70-72: f(4.5) -- already set by base fill
  hwall(g, 33, 64, 72);    // S outer
  fill(g, 18, 18, 64, 72, 'f'); // ensure row18 is f not '#' (open to A site above)

  // =========================================================================
  // LONG A CORRIDOR  (cols 72-79, rows 18-72)  -- floor 4.5m (same as A site)
  // Long A is an elevated corridor at A site level; OutsideLong is 1.5m below.
  // =========================================================================
  fill(g, 18, 72, 72, 79, 'f');
  vwall(g, 79, 18, 72);     // E outer
  fill(g, 18, 18, 72, 79, 'f'); // ensure row18 is open (connects to A site above)
  fill(g, 72, 72, 73, 79, 'f'); // open S wall (connects to OutsideLong ramp)
  // Long doors narrow choke (rows 45-54): 4-cell wide passage (cols 74-77)
  fill(g, 45, 54, 72, 73, '#'); // W wall narrows
  fill(g, 45, 54, 78, 79, '#'); // E wall narrows
  fill(g, 45, 54, 74, 77, 'f'); // 4-cell passage ✓

  // =========================================================================
  // PIT  (cols 80-94, rows 18-32)  -- sand 0.0m
  // West edge: Long A col79=f(4.5) → Pit col80: 4.5m DROP ✓
  // Exit ramp: col80=r(4.125) ... col92=f connects back to Long A at col79
  // =========================================================================
  fill(g, 18, 32, 80, 94, '0');
  hwall(g, 18, 80, 94);     // N outer
  hwall(g, 32, 80, 94);     // S outer
  vwall(g, 94, 18, 32);     // E outer
  fill(g, 19, 31, 79, 79, 'f'); // open Long A E wall (passage at Long A level)
  // Ramp from pit floor (0.0m) back up to Long A level (4.5m):
  fill(g, 19, 31, 80, 80, 'r'); // 4.125m
  fill(g, 19, 31, 81, 81, 'q'); // 3.75m
  fill(g, 19, 31, 82, 82, '9'); // 3.375m
  fill(g, 19, 31, 83, 83, '8'); // 3.0m
  fill(g, 19, 31, 84, 84, '7'); // 2.625m
  fill(g, 19, 31, 85, 85, '6'); // 2.25m
  fill(g, 19, 31, 86, 86, '5'); // 1.875m
  fill(g, 19, 31, 87, 87, '4'); // 1.5m
  fill(g, 19, 31, 88, 88, '3'); // 1.125m
  fill(g, 19, 31, 89, 89, '2'); // 0.75m
  fill(g, 19, 31, 90, 90, '1'); // 0.375m
  fill(g, 19, 31, 91, 94, '0'); // 0.0m pit floor (BFS Pit area center at col91,row25)

  // =========================================================================
  // OUTSIDE LONG  (cols 57-79, rows 58-75)  -- sand 1.5m
  // Outdoor approach area south of Long A; T spawn drops 3m down here.
  // Ramp at rows 55-63, cols 73-79: steps from 4.5m (f) down to 1.5m ('4')
  // This is the "outdoor ramp going north" that connects OutsideLong to LongA.
  // =========================================================================
  fill(g, 58, 75, 57, 79, '4');  // base fill 1.5m
  hwall(g, 75, 57, 79);   // S outer
  // N ramp cols 73-79: stepping up from '4'(1.5m) at row63 to f(4.5m) at row55
  fill(g, 63, 67, 72, 79, '4'); // 1.5m at south end of ramp
  fill(g, 62, 62, 73, 79, '5'); // 1.875m
  fill(g, 61, 61, 73, 79, '6'); // 2.25m
  fill(g, 60, 60, 73, 79, '7'); // 2.625m
  fill(g, 59, 59, 73, 79, '8'); // 3.0m
  fill(g, 58, 58, 73, 79, '9'); // 3.375m
  fill(g, 57, 57, 73, 79, 'q'); // 3.75m
  fill(g, 56, 56, 73, 79, 'r'); // 4.125m
  fill(g, 55, 55, 73, 79, 'f'); // 4.5m = Long A level ✓

  // =========================================================================
  // UPPER TUNNELS  (cols 5-13, rows 15-64)  -- covered 1.5m
  // N: connects to B site S wall at row17 (same height B=1.5m, u=1.5m ✓)
  // S exit ramp rows 65-68: steps down to 0.375m to connect OutsideTunnels
  // =========================================================================
  fill(g, 15, 64, 5, 13, 'u');
  vwall(g, 5, 15, 64);     // W outer
  vwall(g, 13, 15, 64);    // E outer
  // S exit ramp (steps from u=1.5m down to '1'=0.375m at row68):
  fill(g, 65, 68, 5, 13, '4');  // 1.5m (same as tunnels)
  fill(g, 66, 68, 6, 12, '3');  // 1.125m
  fill(g, 67, 68, 6, 12, '2');  // 0.75m
  fill(g, 68, 68, 6, 12, '1');  // 0.375m -> outside tunnels 0.0m at row69: 0.375m drop ✓
  // N passage: B site S wall at row17 cols 5-13 was '#'; open it:
  fill(g, 17, 17, 5, 13, 'B');  // B(1.5m) cells at row17 cols 5-13 -> tunnels connect ✓

  // =========================================================================
  // LOWER TUNNELS  (cols 14-34, rows 56-68)  -- covered 0.375m
  // W: ramp connecting to upper tunnels at col13 (rows 57-63, stepping 1.5->0.375m)
  // E: connects to lower mid at col34/35 boundary (L=0.375m -> M=0.0m: 0.375m drop ✓)
  // =========================================================================
  fill(g, 56, 68, 14, 34, 'L');
  hwall(g, 56, 14, 34);    // N outer
  hwall(g, 68, 14, 34);    // S outer
  vwall(g, 34, 56, 68);    // E wall (open at rows 57-67 for lower mid connection)
  // W ramp from upper tunnels (1.5m) down to lower tunnels (0.375m):
  fill(g, 57, 63, 13, 13, 'u'); // open upper tunnels E wall at rows 57-63
  fill(g, 57, 57, 14, 14, '4'); // 1.5m top
  fill(g, 58, 58, 14, 14, '3'); // 1.125m
  fill(g, 59, 59, 14, 14, '2'); // 0.75m
  fill(g, 60, 60, 14, 14, '1'); // 0.375m = L level
  fill(g, 61, 63, 14, 14, 'L'); // lower tunnels level
  // E passage: open lower tunnels E wall at rows 57-67
  fill(g, 57, 67, 34, 34, 'L'); // override E wall with L floor

  // =========================================================================
  // LOWER MID  (cols 35-49, rows 61-68)  -- floor 0.0m
  // W: adjacent to lower tunnels col34=L(0.375m): 0.375m drop/climb ✓
  // N: bridge rows 60-61 to mid corridor (already opened in mid corridor S wall)
  // =========================================================================
  fill(g, 61, 68, 35, 49, 'M');
  hwall(g, 68, 35, 49);    // S outer
  vwall(g, 49, 61, 68);    // E outer

  // =========================================================================
  // OUTSIDE TUNNELS  (cols 5-35, rows 69-78)  -- sand 0.0m
  // N: ramp from upper tunnels exit (row68 = '1' = 0.375m) to outside (0.0m): 0.375m drop ✓
  // E ramp (cols 23-35): connects to T spawn (S=4.5m) via 12-step ramp
  // =========================================================================
  fill(g, 69, 78, 5, 35, '0');
  vwall(g, 5, 69, 78);     // W outer
  hwall(g, 78, 5, 35);     // S outer
  // E ramp from outside tunnels 0.0m up to T spawn 4.5m (12 steps, each 0.375m):
  fill(g, 70, 77, 22, 22, '0');
  fill(g, 70, 77, 23, 23, '1');
  fill(g, 70, 77, 24, 24, '2');
  fill(g, 70, 77, 25, 25, '3');
  fill(g, 70, 77, 26, 26, '4');
  fill(g, 70, 77, 27, 27, '5');
  fill(g, 70, 77, 28, 28, '6');
  fill(g, 70, 77, 29, 29, '7');
  fill(g, 70, 77, 30, 30, '8');
  fill(g, 70, 77, 31, 31, '9');
  fill(g, 70, 77, 32, 32, 'q');
  fill(g, 70, 77, 33, 33, 'r');  // 4.125m
  fill(g, 70, 77, 34, 34, 'r');  // 4.125m (step at T spawn W boundary)
  fill(g, 70, 77, 35, 35, 'r');  // open col35: r(4.125) adj to T spawn col36=S(4.5): 0.375m ✓

  // =========================================================================
  // T SPAWN  (cols 36-57, rows 68-82)  -- sand 4.5m
  // T spawn positions: x=-12,-8,-4,0,4 -> cols 36,40,44,48,52; z=30 -> row78
  // W: col35=r(4.125) ramp cell → S(4.5): 0.375m climb ✓
  // E: T spawn col57=S(4.5) connects to east ramp col58=f(4.5)
  // =========================================================================
  fill(g, 68, 82, 36, 57, 'S');
  hwall(g, 68, 36, 57);    // N wall
  hwall(g, 82, 36, 57);    // S outer

  // =========================================================================
  // T EAST RAMP  (cols 58-70, rows 68-76)
  // Connects T spawn (4.5m) down to OutsideLong (1.5m) via 9-step descent
  // =========================================================================
  fill(g, 68, 76, 58, 70, '4');  // base fill
  fill(g, 69, 75, 58, 58, 'f');  // 4.5m = T spawn E exit (same level ✓)
  fill(g, 69, 75, 59, 59, 'r');  // 4.125m
  fill(g, 69, 75, 60, 60, 'q');  // 3.75m
  fill(g, 69, 75, 61, 61, '9');  // 3.375m
  fill(g, 69, 75, 62, 62, '8');  // 3.0m
  fill(g, 69, 75, 63, 63, '7');  // 2.625m
  fill(g, 69, 75, 64, 64, '6');  // 2.25m
  fill(g, 69, 75, 65, 65, '5');  // 1.875m
  fill(g, 69, 75, 66, 70, '4');  // 1.5m = connects to OutsideLong '4'(1.5m) ✓
  hwall(g, 67, 57, 70);   // N boundary of east ramp
  hwall(g, 76, 58, 70);   // S boundary of east ramp

  // =========================================================================
  // OUTER BOUNDARY CLEANUP
  // =========================================================================
  vwall(g, 4, 2, 17);          // B site W outer (reinforce)
  vwall(g, 5, 69, 78);         // OutsideTunnels W outer (reinforce)
  hwall(g, 83, 36, 57);        // T spawn S outer wall

  // =========================================================================
  // Convert 2D array to strings
  // =========================================================================
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
    p: { floor: -0.75, mat: 'sand' },
    P: { floor: -0.375, mat: 'sand' },
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
    M: { floor: 0, mat: 'floor' },
    m: { floor: 0.375, mat: 'floor' },
    n: { floor: 0.75, mat: 'floor' },
    o: { floor: 1.125, mat: 'floor' },
    v: { floor: 1.875, mat: 'floor' },
    w: { floor: 2.25, mat: 'floor' },
    x: { floor: 2.625, mat: 'floor' },
    y: { floor: 3.0, mat: 'floor' },
    z: { floor: 3.375, mat: 'floor' },
    c: { floor: 2.25, mat: 'floor' },
    A: { floor: 4.5, mat: 'stone' },
    B: { floor: 1.5, mat: 'stone' },
    b: { floor: 2.25, mat: 'stone' },
    G: { floor: 4.5, mat: 'stone' },
    C: { floor: 0, mat: 'sandLight' },
    S: { floor: 4.5, mat: 'sand' },
    u: { floor: 1.5, ceil: 4.5, mat: 'dark' },
    i: { floor: 1.875, ceil: 4.5, mat: 'dark' },
    j: { floor: 2.25, ceil: 4.5, mat: 'dark' },
    k: { floor: 2.625, ceil: 4.5, mat: 'dark' },
    h: { floor: 3.0, ceil: 4.5, mat: 'dark' },
    L: { floor: 0.375, ceil: 3.5, mat: 'dark' },
    D: { floor: 0, ceil: 4.0, mat: 'floor' },
    E: { floor: 1.5, ceil: 4.5, mat: 'sand' },
    F: { floor: 1.5, ceil: 4.0, mat: 'sand' },
  },
  props: [
    // A site: default-plant crate cluster
    { kind: 'crate', pos: [24.5, 4.5, -40.5], size: [1.5, 1.5, 1.5], mat: 'wood', collide: true },
    { kind: 'crate', pos: [26.2, 4.5, -40.5], size: [1.5, 1.5, 1.5], mat: 'wood', collide: true },
    { kind: 'crate', pos: [25.4, 6.0, -40.5], size: [1.5, 1.5, 1.5], mat: 'wood', collide: true },
    // A site ninja box (back-east wall)
    { kind: 'crate', pos: [34.5, 4.5, -45.0], size: [1.2, 1.2, 1.2], mat: 'wood', collide: true },
    // Goose pocket box
    { kind: 'crate', pos: [39.5, 4.5, -45.0], size: [1.2, 1.5, 1.2], mat: 'wood', collide: true },
    { kind: 'crate', pos: [39.5, 6.0, -45.0], size: [1.2, 1.5, 1.2], mat: 'wood', collide: true },
    // Xbox at top-mid / catwalk junction
    { kind: 'crate', pos: [-3.5, 2.25, -14.5], size: [1.5, 1.5, 1.5], mat: 'wood', collide: true },
    // Mid doors (two metal leaves, ~1.2m gap)
    { kind: 'door', pos: [-4.5, 0, -2.0], size: [1.8, 2.6, 0.15], mat: 'metal', collide: true },
    { kind: 'door', pos: [-1.5, 0, -2.0], size: [1.8, 2.6, 0.15], mat: 'metal', collide: true },
    // B site: car (east side)
    { kind: 'car',    pos: [-25.5, 2.25, -41.5], size: [4.2, 1.4, 1.9], mat: 'metal', collide: true },
    // B site: double-stack crates (back-left)
    { kind: 'crate',  pos: [-30.5, 2.25, -43.5], size: [2.0, 2.0, 2.0], mat: 'wood', collide: true },
    { kind: 'crate',  pos: [-30.5, 4.25, -43.5], size: [2.0, 2.0, 2.0], mat: 'wood', collide: true },
    // B doors sandbag
    { kind: 'sandbag', pos: [-17.5, 1.5, -30.0], size: [1.6, 0.9, 0.8], collide: true },
    // Long: blue container in LongA alley
    { kind: 'block',  pos: [27.5, 4.5, -12.0], size: [2.5, 2.5, 5.0], mat: 'metal', collide: true },
    // Long doors (two metal leaves)
    { kind: 'door', pos: [26.5, 4.5, -3.0], size: [1.8, 2.6, 0.15], mat: 'metal', collide: true },
    { kind: 'door', pos: [25.5, 4.5, -3.0], size: [1.8, 2.6, 0.15], mat: 'metal', collide: true },
    // Pit barrels
    { kind: 'barrel', pos: [41.5, 1.5, -25.0], size: [0.6, 0.9, 0.6], mat: 'metal', collide: true },
    { kind: 'barrel', pos: [42.5, 1.5, -24.0], size: [0.6, 0.9, 0.6], mat: 'metal', collide: true },
    // Upper tunnels clutter
    { kind: 'crate',  pos: [-36.0, 1.5, 8.0],  size: [1.2, 1.2, 1.2], mat: 'wood', collide: true },
    { kind: 'barrel', pos: [-34.0, 1.5, 4.0], size: [0.6, 0.9, 0.6], mat: 'metal', collide: true },
    // T spawn crate (well away from spawns)
    { kind: 'crate', pos: [-2.5, 4.5, 26.5], size: [1.2, 1.2, 1.2], mat: 'wood', collide: true },
    // CT mid sandbag
    { kind: 'sandbag', pos: [-8.5, 0, -26.0], size: [1.6, 0.9, 0.8], collide: true },
  ],
  spawns: {
    ct: [
      { x:  0.5, z: -40.0, angle: Math.PI },
      { x:  2.5, z: -40.0, angle: Math.PI },
      { x:  4.5, z: -40.0, angle: Math.PI },
      { x:  1.5, z: -38.0, angle: Math.PI },
      { x:  3.5, z: -38.0, angle: Math.PI },
    ],
    t: [
      { x: -12.0, z: 30.0, angle: 0 },
      { x:  -8.0, z: 30.0, angle: 0 },
      { x:  -4.0, z: 30.0, angle: 0 },
      { x:   0.0, z: 30.0, angle: 0 },
      { x:   4.0, z: 30.0, angle: 0 },
    ],
  },
  bombsites: [
    { name: 'A', min: { x: 14, z: -46 }, max: { x: 39, z: -31 } },
    { name: 'B', min: { x: -44, z: -46 }, max: { x: -26, z: -31 } },
  ],
  areas: [
    { name: 'TSpawn',         min: { x: -18, z:  19 }, max: { x:   8, z:  34 } },
    { name: 'TPlat',          min: { x: -18, z:  19 }, max: { x:   8, z:  34 } },
    { name: 'OutsideLong',    min: { x:   9, z:  15 }, max: { x:  30, z:  27 } },
    { name: 'LongDoors',      min: { x:  24, z:   4 }, max: { x:  30, z:  14 } },
    { name: 'LongA',          min: { x:  24, z: -28 }, max: { x:  30, z:   4 } },
    { name: 'Pit',            min: { x:  41, z: -28 }, max: { x:  45, z: -18 } },
    { name: 'ARamp',          min: { x:  14, z: -29 }, max: { x:  24, z: -17 } },
    { name: 'ASite',          min: { x:  14, z: -46 }, max: { x:  39, z: -31 } },
    { name: 'GooseA',         min: { x:  37, z: -46 }, max: { x:  43, z: -39 } },
    { name: 'CTRamp',         min: { x:   4, z: -43 }, max: { x:  14, z: -30 } },
    { name: 'AShort',         min: { x:  14, z: -30 }, max: { x:  22, z: -15 } },
    { name: 'Catwalk',        min: { x:  -6, z: -30 }, max: { x:  14, z: -15 } },
    { name: 'TopMid',         min: { x:  -8, z: -20 }, max: { x:   0, z:  -4 } },
    { name: 'MidDoors',       min: { x:  -8, z:  -4 }, max: { x:   0, z:   8 } },
    { name: 'LowerMid',       min: { x: -14, z:   8 }, max: { x:   3, z:  18 } },
    { name: 'CTMid',          min: { x: -12, z: -32 }, max: { x:  -6, z:  -5 } },
    { name: 'CTSpawn',        min: { x: -12, z: -46 }, max: { x:   4, z: -33 } },
    { name: 'MidToB',         min: { x: -33, z: -30 }, max: { x: -13, z: -21 } },
    { name: 'BDoors',         min: { x: -24, z: -46 }, max: { x: -13, z: -30 } },
    { name: 'BSite',          min: { x: -44, z: -46 }, max: { x: -26, z: -31 } },
    { name: 'BPlat',          min: { x: -44, z: -46 }, max: { x: -39, z: -38 } },
    { name: 'UpperTunnels',   min: { x: -40, z: -26 }, max: { x: -35, z:  17 } },
    { name: 'LowerTunnels',   min: { x: -33, z:   8 }, max: { x: -15, z:  17 } },
    { name: 'OutsideTunnels', min: { x: -40, z:  19 }, max: { x: -16, z:  28 } },
  ],
};
