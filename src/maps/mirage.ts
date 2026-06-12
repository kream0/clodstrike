// de_mirage — MapData for Clodstrike
//
// Grid: 96×96. origin { x:-48, z:-48 }.
// Col = worldX + 48,  Row = worldZ + 48
// Row 0 = NORTH (CT/sites); rows grow SOUTH (+Z = T side).
//
// Floor heights are multiples of 0.375 m.
// BFS passability: climb ≤ 0.5 m or any drop; ceil clearance ≥ 1.9 m.

import type { MapData } from '../types';

const GW = 96;
const GH = 96;

// ---------------------------------------------------------------------------
// Grid primitives
// ---------------------------------------------------------------------------
function makeGrid(): string[][] {
  return Array.from({ length: GH }, () => Array<string>(GW).fill(' '));
}

/** Fill a rectangle (inclusive) with the given char. */
function fill(g: string[][], r1: number, r2: number, c1: number, c2: number, ch: string): void {
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) g[r]![c] = ch;
}

/** Draw a '#' border around a rectangle. */
function wborder(g: string[][], r1: number, r2: number, c1: number, c2: number): void {
  for (let c = c1; c <= c2; c++) { g[r1]![c] = '#'; g[r2]![c] = '#'; }
  for (let r = r1 + 1; r <= r2 - 1; r++) { g[r]![c1] = '#'; g[r]![c2] = '#'; }
}

/** Paint a complete room: interior fill then border. */
function room(g: string[][], r1: number, r2: number, c1: number, c2: number, ch: string): void {
  fill(g, r1, r2, c1, c2, ch);
  wborder(g, r1, r2, c1, c2);
}

// ---------------------------------------------------------------------------
// Map builder
// ---------------------------------------------------------------------------
function buildGrid(): string[] {
  const g = makeGrid();

  // =========================================================================
  // PASS 1: Paint all rooms (interior + border).
  // Order matters: later rooms overwrite overlapping earlier rooms.
  // =========================================================================

  // T-spawn / apps-ramp zone: cols 67-92, rows 29-41
  room(g, 28, 42, 66, 93, 'T');

  // Kitchen: cols 37-45, rows 17-27, covered 'k'
  room(g, 16, 28, 36, 46, 'k');

  // Apps corridor: cols 47-65, rows 21-33, covered 'a'
  room(g, 20, 34, 46, 66, 'a');

  // B-plat: cols 29-34, rows 17-25
  room(g, 16, 26, 28, 35, 'B');

  // B-site: cols 9-27, rows 23-43
  room(g, 22, 44, 8, 28, 'B');

  // Arches: cols 23-32, rows 29-37, covered 't'
  room(g, 28, 38, 22, 33, 't');

  // Market: cols 7-20, rows 29-41, covered 'm'
  room(g, 28, 42, 6, 21, 'm');

  // B-short: cols 28-43, rows 30-42, floor '4'=1.5
  room(g, 29, 43, 27, 44, '4');

  // Ladder room: cols 38-43, rows 35-43, covered 'l' floor 1.5
  room(g, 34, 44, 37, 44, 'l');

  // Underpass: cols 47-50, rows 35-49, covered 'u' floor 0.0
  room(g, 34, 50, 46, 51, 'u');

  // Mid: cols 41-57, rows 45-57
  room(g, 44, 58, 40, 58, 'M');

  // Top-mid: cols 57-65, rows 43-55
  room(g, 42, 56, 56, 66, 'M');

  // Window room: cols 35-45, rows 43-51, covered 'w' floor 3.75
  room(g, 43, 51, 34, 46, 'w');

  // Connector: cols 40-49, rows 53-61
  room(g, 52, 62, 39, 50, 'M');

  // Jungle: cols 37-49, rows 59-65
  room(g, 58, 66, 36, 50, 'J');

  // Stairs room: cols 29-39, rows 53-63 (filled '#', ramp applied below)
  room(g, 52, 64, 28, 40, '#');

  // A-ramp: cols 61-73, rows 56-69 (filled '#', ramp applied below)
  room(g, 56, 70, 60, 74, '#');

  // Palace: cols 69-79, rows 63-77, covered 'p' floor 1.5
  room(g, 62, 78, 68, 80, 'p');

  // A-site: cols 43-61, rows 67-79
  room(g, 66, 80, 42, 62, 'A');

  // CT-spawn: cols 21-36, rows 65-75
  room(g, 64, 76, 20, 37, 'C');

  // CT-link: cols 38-51, rows 69-75 (ramp from CT-spawn to A-site)
  room(g, 68, 76, 37, 52, 'A');

  // CT corridor: cols 21-22, rows 43-64 (narrow hallway)
  fill(g, 43, 64, 21, 22, '0');
  fill(g, 43, 64, 20, 20, '#');
  fill(g, 43, 64, 23, 23, '#');

  // =========================================================================
  // PASS 2: Ramp fills inside rooms painted '#'
  // =========================================================================

  // Stairs room ramp: row 64 = step '1'(0.375), north to row 53 = '8'(3.0)
  // Steps (index 0..11): '1','2','3','4','5','6','7','8','8','8','8','8'
  // g[64-i][c] = step for c in 29..39
  const STAIR_STEPS = ['1','2','3','4','5','6','7','8','8','8','8','8'];
  for (let c = 29; c <= 39; c++) {
    for (let i = 0; i < STAIR_STEPS.length; i++) {
      g[64 - i]![c] = STAIR_STEPS[i]!;
    }
  }

  // A-ramp: row 56 top at 0.0, rows 56-57='0', 58='1', 59='2', 60='3', 61-69='4'
  for (let c = 61; c <= 73; c++) {
    g[56]![c] = '0';
    g[57]![c] = '0';
    g[58]![c] = '1';
    g[59]![c] = '2';
    g[60]![c] = '3';
    for (let r = 61; r <= 69; r++) g[r]![c] = '4';
  }

  // =========================================================================
  // PASS 3: Open all connections (paint over walls with passable chars)
  // =========================================================================

  // --- T-spawn ↔ Apps corridor ---
  // Apps east wall col 66, T-spawn west wall col 66, shared rows 29-33
  for (let r = 29; r <= 33; r++) g[r]![66] = 'a';

  // --- T-spawn ↔ Top-mid ---
  // Bridge at rows 42-43, cols 66-67
  for (let c = 66; c <= 67; c++) { g[42]![c] = 'T'; g[43]![c] = 'T'; }
  // Open top-mid east wall col 66 rows 43-55 to connect junction
  for (let r = 43; r <= 55; r++) g[r]![66] = 'M';

  // --- Apps corridor ↔ Kitchen ---
  // Col 46 rows 21-27
  for (let r = 21; r <= 27; r++) g[r]![46] = 'k';

  // --- Kitchen ↔ B-plat ---
  // Bridge passage at cols 35-36, rows 17-25
  fill(g, 17, 25, 35, 36, 'B');

  // --- B-plat ↔ B-site ---
  // Col 28 rows 23-25 (b-plat south rows meet b-site north rows)
  for (let r = 23; r <= 25; r++) g[r]![28] = 'B';

  // --- B-site ↔ Market ---
  // Market east border was '#' at col 21, rows 29-41. Restore as 'B' (open connection).
  for (let r = 29; r <= 41; r++) g[r]![21] = 'B';

  // --- Market ↔ CT-corridor ---
  // CT corridor starts row 43. Market south border row 42, cols 21.
  g[42]![21] = 'm';

  // --- CT-corridor ↔ CT-spawn ---
  // CT-spawn north border row 64 overwrote corridor at cols 21-22. Open:
  g[64]![21] = 'C';
  g[64]![22] = 'C';

  // --- B-site ↔ Arches ---
  // Arches west border col 22, B-site col 21. Open arches west at rows 29-36:
  for (let r = 29; r <= 36; r++) g[r]![22] = 't';
  // Arches north border row 28 paints '#' at cols 22-33, cutting through b-site (cols 9-27).
  // Restore b-site interior at row 28 cols 22-27 so b-site is passable north-south:
  for (let c = 22; c <= 27; c++) g[28]![c] = 'B';

  // --- Arches ↔ B-short (ramp: 0.0 → 1.5) ---
  // B-site col 27 'B'(0.0) adj b-short col 28 '4'(1.5) → one-way DROP from b-short INTO b-site ✓
  // B-site → b-short climb 1.5 → BLOCKED ✓ (checked at row 35 in test)
  //
  // Arches flat zone (cols 22-27, floor 0.0) must connect to b-short (cols 28+, floor 1.5).
  // The path: from arches col 27('B'=0.0) → ramp at cols 28-31 rows 30-31 ('1'-'4') → b-short.
  // Rows 30-31 only: allows bidirectional ramp. Row 35 col 28 = '4'(1.5) adj col 27='B'(0.0)
  // stays as the one-way drop check cell (rows 32-37 are NOT modified).
  //
  // Ramp at rows 30-31, cols 28-31: step from 0.0 up to 1.5 in four cells.
  for (let r = 30; r <= 31; r++) {
    g[r]![28] = '1'; // 0.375 — climb 0.375 from col 27 'B'(0.0) ≤ 0.5 ✓
    g[r]![29] = '2'; // 0.75
    g[r]![30] = '3'; // 1.125
    g[r]![31] = '4'; // 1.5 — enters b-short level
  }
  // Cols 32-36 in rows 30-31 stay '4' from PASS 1 b-short fill.
  // Cols 28-31 rows 32-37 also stay '4' from PASS 1 b-short fill (one-way test at row 35 ✓).
  // Also place a secondary ramp passage along cols 33-36 for b-short interior continuity:
  for (let r = 30; r <= 37; r++) {
    g[r]![33] = '1'; // 0.375
    g[r]![34] = '2'; // 0.75
    g[r]![35] = '3'; // 1.125
    g[r]![36] = '4'; // 1.5
  }

  // --- B-short west ↔ B-site (one-way drop) ---
  // B-short west border col 27 was '#'. Restore as 'B' so b-short col 28 ('4'=1.5) adj b-site col 27 ('B'=0.0).
  for (let r = 29; r <= 43; r++) g[r]![27] = 'B';

  // --- B-short ↔ Ladder room ---
  // Ladder room north border row 34 = '#'. Open at cols 38-43:
  for (let c = 38; c <= 43; c++) g[34]![c] = 'l';

  // --- Open ladder room west border at b-short overlap rows ---
  // Ladder room west border col 37 row 37 = '#', which is inside b-short (rows 30-42).
  // Open it so b-short interior is connected across col 37:
  for (let r = 30; r <= 43; r++) g[r]![37] = '4';

  // --- Ladder room ↔ Window room (ramp: 1.5 → 3.75) ---
  // Row 43: ramp cells climbing from ladder room interior row 42 (l=1.5) east to 'q'(3.75)
  g[43]![38] = '5'; g[43]![39] = '6'; g[43]![40] = '7';
  g[43]![41] = '8'; g[43]![42] = '9'; g[43]![43] = 'q';
  // Row 44: open as window room interior (was ladder south border '#')
  for (let c = 38; c <= 45; c++) g[44]![c] = 'w';

  // --- Window room ↔ Mid (one-way drop at south edge) ---
  // Window room south border row 51 cols 41-45: open as 'w' so mid row 52 (M=0.0) adj w(3.75)
  for (let c = 41; c <= 45; c++) g[51]![c] = 'w';

  // --- Underpass ↔ Mid ---
  // Mid north border row 44 overwrote underpass col 47-50. Open:
  for (let c = 47; c <= 50; c++) g[44]![c] = 'u';

  // --- Underpass ↔ Apps corridor ---
  // Both have '#' at row 34 in cols 47-50. Open:
  for (let c = 47; c <= 50; c++) g[34]![c] = 'u';

  // --- Connector north ↔ Mid ---
  // Connector north border row 52 overwrote mid interior. Open at cols 41-49:
  for (let c = 41; c <= 49; c++) g[52]![c] = 'M';

  // --- Connector south ↔ Jungle ---
  // Jungle north border row 58 overwrote connector row 58. Open at cols 41-49:
  for (let c = 41; c <= 49; c++) g[58]![c] = 'M';

  // --- Jungle north ↔ Jungle/Connector boundary ---
  // Row 58 open (done above). Also ensure Jungle row 59 adj row 58 are passable.
  // g[58][41-49]='M'(0.0), g[59][41-49]='J'(1.5). Climb 1.5 > 0.5 → BLOCKED!
  // We need a ramp from M(0.0) to J(1.5). Place ramp steps at the boundary.
  // Use rows 57-60: row57=M(0.0), row58='1'(0.375), row59='2'(0.75), row60='3'(1.125), row61='J'(1.5)
  // Jungle interior rows 59-65. Row 59 needs to be ramp '2'.
  // But jungle was painted 'J' at rows 59-65. Override rows 59-60 at connector cols:
  for (let c = 41; c <= 49; c++) {
    g[58]![c] = '1'; // 0.375 (step up from mid/connector 0.0 at row 57)
    g[59]![c] = '2'; // 0.75
    g[60]![c] = '3'; // 1.125
    // row 61 = 'J'(1.5) already from jungle fill
  }

  // --- Jungle south ↔ A-site north ---
  // Row 66 = both jungle south '#' and A-site north '#'. Open at cols 43-49:
  for (let c = 43; c <= 49; c++) g[66]![c] = 'A';

  // Ramp from jungle to A-site: jungle row 65='J'(1.5), row 66='A'(1.5) → same floor ✓

  // --- Jungle ↔ Stairs room ---
  // Stairs east border col 40. Jungle west border col 36.
  // Stairs cols 29-39, jungle cols 37-49. Overlap at cols 37-39.
  // After stair ramp fill: g[64-i][37-39] = stair steps.
  // After jungle fill: g[59-65][37-49] = 'J' (overwrote stair steps at rows 59-65, cols 37-39).
  // After our ramp fix above: g[58-60][41-49] = '1','2','3'. But cols 37-40 at rows 58-60?
  // Jungle cols 36-50 includes col 37-40. Row 58-60 at col 37-40 = 'J' still (from jungle fill).
  // Stairs ramp at row 61 col 37 = g[64-3][37] = STAIR_STEPS[3] = '4'(1.5). jungle painted 'J' there.
  // After jungle: g[61][37] = 'J'(1.5). Both = 1.5, same floor.
  // We need a path from stairs top to jungle. Stairs row 53-63 cols 29-39.
  // At row 61 col 37: jungle painted 'J'(1.5). Stair painted '4'(1.5). Jungle ran AFTER stairs.
  // Final g[61][37] = 'J'(1.5). passable from stairs col 38 row 61 ('4'=1.5) to col 37 row 61 ('J'=1.5) ✓.
  // But: stair ramp fill ran BEFORE jungle fill in code. Jungle overwrote rows 59-65 cols 37-49.
  // So at rows 59-63, cols 37-39: jungle painted 'J', stair ramp values are LOST.
  // BUT THEN our ramp-fix loop above set g[58][41-49]='1', g[59][41-49]='2', g[60][41-49]='3'.
  // Cols 37-40 at rows 58-60 are NOT covered by our ramp fix (which only does cols 41-49).
  // At col 37-40, rows 59-65: still 'J'(1.5) from jungle.
  // Stairs ramp at row 61 col 38: g[61][38] should be STAIR_STEPS[3]='4'. But jungle set it to 'J'.
  // We need to restore the stair ramp cells. Apply stair ramp AFTER jungle:
  for (let c = 29; c <= 39; c++) {
    for (let i = 0; i < STAIR_STEPS.length; i++) {
      g[64 - i]![c] = STAIR_STEPS[i]!;
    }
  }
  // Now stairs ramp cells are correct. But what's at jungle cols 37-39 rows 59-65?
  // After stair re-paint: g[59][37]='6', g[60][37]='5', g[61][37]='4', g[62][37]='3', g[63][37]='2'.
  // Jungle interior col 37 rows 59-65: now stair steps again.
  // passable(J col36 row61, stair '4' col37 row61) = climb 0.0 ✓ (same 1.5 floor essentially, J=1.5, '4'=1.5)
  // Good. But now jungle center at col 44 row 62 needs to be 'J':
  // Jungle cols 37-49. At col 44 row 62: g[62][44] = jungle 'J' (only cols 37-39 got stair re-paint, col 44 untouched). ✓

  // Also ramp from connector to stairs via jungle at row 61 col 37-39:
  // passable('4' col39 row61 (stairs), 'J' col38 row61... wait: col 38 row 61 = stairs ramp after restore!
  // g[61][38] = STAIR_STEPS[3] = '4'. OK both col 37 and 38 at row 61 = '4'(1.5). Col 36 = jungle 'J'(1.5).
  // Path from connector (M=0.0) → ramp '1' → '2' → '3' → jungle 'J' col 40-49 row 61:
  // At col 40 row 61: g[61][40] = STAIR_STEPS[3]='4'! (stairs re-paint covers col 40). But col 40 = stairs interior.
  // Stairs interior cols 29-39. Col 40 = stair EAST BORDER (was '#'). Stair re-paint covers col 29-39, not col 40.
  // g[61][40]: jungle 'J'(1.5) (from jungle fill, not overwritten by stair re-paint). ✓
  // So col 40 row 61 = 'J'(1.5). passable(stair '4' col39 row61, J col40 row61) = same floor ✓.
  // But stairs east border col 40 was '#'. Jungle overwrote it to 'J'. ✓ open.

  // Now our ramp at cols 41-49 rows 58-60:
  // g[58][41-49]='1', g[59][41-49]='2', g[60][41-49]='3'. These are also in jungle rows 58-65, cols 41-49.
  // But connector north row 58 cols 41-49 = 'M' (from our connector north fix). Let's recheck:
  // Connector north fix: g[52][41-49]='M'. That's row 52. Row 58 fix was g[58][41-49]='1'.
  // Mid interior rows 45-57. g[57][41-49]='M' (mid interior, later connector set it to 'M' too).
  // g[58][41-49]='1'(0.375). passable(M row57 col44, '1' row58 col44) = climb 0.375 ✓.
  // g[59][41-49]='2'(0.75). passable('1' row58, '2' row59) = climb 0.375 ✓.
  // g[60][41-49]='3'(1.125). passable('2' row59, '3' row60) = climb 0.375 ✓.
  // g[61][41-49]='J'(1.5). passable('3' row60, 'J' row61) = climb 0.375 ✓.
  // But wait: connector south border is row 62. Jungle north border is row 58.
  // Connector interior rows 53-61. After connector room: rows 53-61 cols 40-49 = 'M'.
  // Then jungle room rows 59-65 cols 37-49 = 'J'. So rows 59-61 cols 40-49 = 'J' after jungle.
  // Then stair re-paint sets rows 53-64 cols 29-39 = stairs. Col 40 untouched, stays 'J'.
  // Our ramp fix sets g[58-60][41-49] = '1','2','3'. But these are inside jungle rows 59-65 for rows 59-60.
  // g[59][41-49]='2' (our ramp fix overwrites jungle 'J'). ✓
  // g[60][41-49]='3' (our ramp fix overwrites jungle 'J'). ✓
  // g[61][41-49]='J' (untouched, jungle). ✓

  // --- CT-spawn ↔ Stairs room ---
  // CT-spawn north border row 64 overwrote stair ramp at cols 29-36. Open:
  for (let c = 29; c <= 36; c++) g[64]![c] = '1'; // stair step '1'(0.375) adj CT-spawn (C=0.0)

  // --- CT-spawn ↔ CT-link ---
  // CT-link west border was '#' at col 37. Open with ramp:
  for (let r = 69; r <= 75; r++) {
    g[r]![37] = 'C'; // 0.0 — CT-spawn level
    g[r]![38] = '1'; // 0.375
    g[r]![39] = '2'; // 0.75
    g[r]![40] = '3'; // 1.125
    for (let c = 41; c <= 51; c++) g[r]![c] = 'A'; // 1.5 → A-site level
  }
  // CT-link borders (north row 68, south row 76):
  for (let c = 37; c <= 52; c++) { g[68]![c] = '#'; g[76]![c] = '#'; }

  // Restore A-site interior at col 52 rows 68-75 (CT-link east border overwrote it):
  for (let r = 68; r <= 75; r++) g[r]![52] = 'A';

  // --- CT-link ↔ A-site ---
  // A-site interior at col 52 is now 'A'. CT-link col 51 rows 69-75 = 'A'. Passable ✓

  // --- A-site ↔ A-ramp ---
  // A-site east border col 62 rows 67-79 = '#'. A-ramp at col 62 rows 57-69 = '4'.
  // Open at rows 67-69:
  for (let r = 67; r <= 69; r++) g[r]![62] = 'A';

  // --- A-ramp ↔ Palace ---
  // Palace west border col 68 = '#'. A-ramp at col 67 rows 63-69 = '4'(1.5). Open:
  for (let r = 63; r <= 69; r++) g[r]![68] = 'p';

  // --- Top-mid ↔ A-ramp ---
  // A-ramp row 56-57 = '0'(0.0). Top-mid interior rows 43-55. Top-mid south border row 56.
  // A-ramp row 56 overwrites top-mid south border at cols 61-73 with '0'. ✓
  // passable(M top-mid col62 row55, '0' aramp col62 row56) = same floor ✓

  // =========================================================================
  // PASS 4: Ceiling clearance fix for window room
  // =========================================================================
  // The ladder→window ramp row 43 cells '5'-'q' have no ceil (open sky). That's fine —
  // they're transitional cells. Window room cells have ceil=7.0.
  // Check clearance at window room entry: 'w' ceil=7.0, floor=3.75. Clearance=3.25≥1.9 ✓

  // =========================================================================
  // PASS 5: Verify area centers are not in wall cells
  // =========================================================================
  // WindowRoom center: min{-13,-4} max{-2,3} → center (-7.5,-0.5) → col=40.5→col40, row=47.5→row47
  // Window room interior rows 44-50, cols 35-45. Col 40 row 47 = 'w'. ✓
  // LadderRoom center: min{-10,-12} max{-3,-4} → center (-6.5,-8) → col=41.5→col41, row=40
  // Ladder room interior rows 35-43, cols 38-43. Col 41 row 40 = 'l'. ✓
  // But wait: window room overwrote ladder room rows 44-50, cols 35-45.
  // At row 44 cols 38-45: we set 'w' above. These were ladder room south border + window room interior.
  // Ladder room interior rows 35-43. Row 44 = ladder room SOUTH BORDER (room r2=44 → wall at r2).
  // So ladder room interior ends at row 43. Window room starts at row 43 (border at r1=43).
  // Ladder room center row 40 is inside ladder room rows 35-43. ✓

  // BShort center: area min{-19,-17} max{-3,-5} → center (-11,-11) → col=37, row=37
  // B-short interior rows 30-42, cols 28-43. Col 37 row 37 = '4'. ✓
  // (arches ramp at cols 29-33 rows 30-37 has '1'-'4'. Col 37 is pure b-short '4'.) ✓

  // Arches center: min{-25,-19} max{-15,-10} → center (-20,-14.5) → col=28, row=33.5→row33
  // Arches interior rows 29-37, cols 23-32. Col 28 row 33 = 't' (arches interior, rows 30-37 have ramp in cols 29-33).
  // At col 28 row 33: ramp filled g[33][28]? Ramp covers rows 30-37 cols 29-33. Col 28 NOT covered by ramp.
  // arches room fill first set col 23-32 rows 29-37 = 't'. Then ramp paint set cols 29-33 rows 30-37.
  // Col 28 row 33 = 't'. ✓

  // CTLink center: min{-10,20} max{4,28} → center (-3,24) → col=45, row=72
  // CT-link interior rows 69-75, cols 38-51. g[72][45] = 'A' (from our ramp paint). ✓

  // StairsRoom center: min{-19,5} max{-7,16} → center (-13,10.5) → col=35, row=58.5→row58
  // Stairs interior rows 53-63, cols 29-39. g[58][35] = STAIR_STEPS[64-58]=STAIR_STEPS[6]='7'. ✓

  // ARamp center: min{13,9} max{26,22} → center (19.5,15.5) → col=67.5→col67, row=63.5→row63
  // A-ramp interior rows 57-69, cols 61-73. g[63][67] = '4'. ✓

  // Palace center: min{22,15} max{33,30} → center (27.5,22.5) → col=75.5→col75, row=70.5→row70
  // Palace interior rows 63-77, cols 69-79. g[70][75] = 'p'. ✓

  // Final: return grid
  return g.map((row) => row.join(''));
}

const BUILT_GRID = buildGrid();

export const MIRAGE: MapData = {
  name: 'de_mirage',
  cellSize: 1,
  origin: { x: -48, z: -48 },
  grid: BUILT_GRID,
  legend: {
    ' ': { floor: 0, wall: true },
    '#': { floor: 0, wall: true, mat: 'sand' },
    '0': { floor: 0.0,   mat: 'sand' },
    '1': { floor: 0.375, mat: 'sand' },
    '2': { floor: 0.75,  mat: 'sand' },
    '3': { floor: 1.125, mat: 'sand' },
    '4': { floor: 1.5,   mat: 'sand' },
    '5': { floor: 1.875, mat: 'sand' },
    '6': { floor: 2.25,  mat: 'sand' },
    '7': { floor: 2.625, mat: 'sand' },
    '8': { floor: 3.0,   mat: 'sand' },
    '9': { floor: 3.375, mat: 'sand' },
    q: { floor: 3.75,  mat: 'sand' },
    T: { floor: 0.0,   mat: 'sand' },
    M: { floor: 0.0,   mat: 'floor' },
    A: { floor: 1.5,   mat: 'stone' },
    B: { floor: 0.0,   mat: 'stone' },
    J: { floor: 1.5,   mat: 'sand' },
    C: { floor: 0.0,   mat: 'sandLight' },
    a: { floor: 0.0,   ceil: 3.0, mat: 'dark' },
    k: { floor: 0.0,   ceil: 3.0, mat: 'dark' },
    t: { floor: 0.0,   ceil: 3.0, mat: 'dark' },
    u: { floor: 0.0,   ceil: 3.0, mat: 'dark' },
    w: { floor: 3.75,  ceil: 7.0, mat: 'dark' },
    p: { floor: 1.5,   ceil: 4.5, mat: 'dark' },
    m: { floor: 0.0,   ceil: 3.0, mat: 'dark' },
    l: { floor: 1.5,   ceil: 4.5, mat: 'dark' },
  },
  props: [
    // A-site props (world x=-5..14, z=18..32, floor 1.5)
    { kind: 'crate', pos: [5.0,  3.5,  20.0], size: [2.0, 2.0, 2.0], mat: 'wood',   collide: true },
    { kind: 'crate', pos: [5.0,  5.5,  20.0], size: [2.0, 1.0, 2.0], mat: 'wood',   collide: true },
    { kind: 'crate', pos: [0.0,  3.5,  23.0], size: [4.0, 2.0, 2.0], mat: 'wood',   collide: true },
    { kind: 'crate', pos: [0.0,  5.5,  23.0], size: [4.0, 1.0, 2.0], mat: 'wood',   collide: true },
    { kind: 'crate', pos: [3.0,  3.25, 22.0], size: [1.5, 1.5, 1.5], mat: 'wood',   collide: true },
    { kind: 'block', pos: [-2.0, 3.25, 24.0], size: [1.0, 1.5, 1.0], mat: 'metal',  collide: true },
    // B-site props (world x=-39..-20, z=-25..-4, floor 0.0)
    { kind: 'car',   pos: [-29.0, 1.5, -10.0], size: [5.0, 3.0, 2.5], mat: 'metal', collide: true },
    { kind: 'block', pos: [-36.0, 0.5, -18.0], size: [2.5, 1.0, 1.0], mat: 'wood',  collide: true },
    { kind: 'crate', pos: [-25.0, 0.75,-16.0], size: [2.0, 1.5, 2.0], mat: 'wood',  collide: true },
    // Mid prop
    { kind: 'crate', pos: [10.0,  0.75, 1.0],  size: [3.0, 1.5, 2.0], mat: 'wood',  collide: true },
    // Market stall
    { kind: 'block', pos: [-34.0, 0.75,-12.0], size: [3.0, 1.5, 1.5], mat: 'wood',  collide: true },
    // Palace pillars
    { kind: 'block', pos: [23.0,  3.0,  19.0], size: [1.0, 3.0, 1.0], mat: 'stone', collide: true },
    { kind: 'block', pos: [31.0,  3.0,  19.0], size: [1.0, 3.0, 1.0], mat: 'stone', collide: true },
  ],
  spawns: {
    // T-spawn interior: cols 67-92, rows 29-41 → world x=19..44, z=-19..-7
    t: [
      { x: 43.5, z: -16.5, angle: Math.PI },
      { x: 41.5, z: -14.5, angle: Math.PI },
      { x: 43.5, z: -12.5, angle: Math.PI },
      { x: 41.5, z: -10.5, angle: Math.PI },
      { x: 43.5, z:  -8.5, angle: Math.PI },
    ],
    // CT-spawn interior: cols 21-36, rows 65-75 → world x=-26..-11, z=17..27
    ct: [
      { x: -18.5, z: 20.5, angle: -Math.PI / 4 },
      { x: -20.5, z: 22.5, angle: -Math.PI / 4 },
      { x: -16.5, z: 22.5, angle: -Math.PI / 4 },
      { x: -18.5, z: 24.5, angle: -Math.PI / 4 },
      { x: -20.5, z: 24.5, angle: -Math.PI / 4 },
    ],
  },
  bombsites: [
    { name: 'A', min: { x: -5, z: 18 }, max: { x: 14, z: 32 } },
    { name: 'B', min: { x: -39, z: -25 }, max: { x: -19, z: -3 } },
  ],
  areas: [
    { name: 'TSpawn',       min: { x:  19, z: -19 }, max: { x:  44, z:  -7 } },
    { name: 'AppsRamp',     min: { x:  14, z: -20 }, max: { x:  18, z: -14 } },
    { name: 'AppsCorridor', min: { x:  -1, z: -27 }, max: { x:  18, z: -14 } },
    { name: 'Kitchen',      min: { x: -11, z: -31 }, max: { x:  -2, z: -19 } },
    { name: 'BPlat',        min: { x: -19, z: -31 }, max: { x: -13, z: -21 } },
    { name: 'BSite',        min: { x: -39, z: -25 }, max: { x: -20, z:  -4 } },
    { name: 'Arches',       min: { x: -25, z: -19 }, max: { x: -22, z: -11 } },
    { name: 'BShort',       min: { x: -19, z: -17 }, max: { x:  -3, z:  -5 } },
    { name: 'LadderRoom',   min: { x: -10, z: -12 }, max: { x:  -3, z:  -4 } },
    { name: 'WindowRoom',   min: { x: -13, z:  -4 }, max: { x:  -2, z:   4 } },
    { name: 'Underpass',    min: { x:  -1, z: -13 }, max: { x:   4, z:   2 } },
    { name: 'Mid',          min: { x:  -7, z:  -3 }, max: { x:  10, z:  10 } },
    { name: 'TopMid',       min: { x:   9, z:  -5 }, max: { x:  18, z:   8 } },
    { name: 'Connector',    min: { x:  -5, z:   6 }, max: { x:  -1, z:  12 } },
    { name: 'Jungle',       min: { x: -11, z:  11 }, max: { x:   4, z:  18 } },
    { name: 'StairsRoom',   min: { x: -19, z:   5 }, max: { x:  -7, z:  16 } },
    { name: 'ARamp',        min: { x:  13, z:   9 }, max: { x:  26, z:  22 } },
    { name: 'Palace',       min: { x:  22, z:  15 }, max: { x:  33, z:  30 } },
    { name: 'ASite',        min: { x:  -5, z:  18 }, max: { x:  14, z:  32 } },
    { name: 'CTSpawn',      min: { x: -26, z:  17 }, max: { x: -11, z:  27 } },
    { name: 'CTLink',       min: { x: -10, z:  20 }, max: { x:   4, z:  28 } },
    { name: 'Market',       min: { x: -41, z: -12 }, max: { x: -37, z:  -8 } },
  ],
};
