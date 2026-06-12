/**
 * Custom map validator — pure library module; no game/main/hud imports.
 *
 * Grid dimensions decision (from engine code in world.ts):
 *   World reads `map.grid.length` and `map.grid[0]?.length ?? 0` — it does NOT
 *   enforce a fixed 96×96. We therefore allow square grids in the range 32–128.
 *   Dust2 and Mirage are both 96×96. Non-square grids are rejected (the engine
 *   and test helpers assume rows × cols are equal, and the nav grid is square).
 *
 * Validation is tiered, collecting ALL errors (not first-fail).
 * Tier 7 (reachability BFS) only runs when tiers 1–6 pass.
 */
import type { MapData, CellLegend, MapProp, SpawnPoint, Vec2 } from '../types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ValidateResult =
  | { ok: true; map: MapData }
  | { ok: false; errors: string[] };

export function validateMapData(raw: unknown): ValidateResult {
  const errors: string[] = [];

  // ── Tier 1: top-level shape ──────────────────────────────────────────────
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['root must be a JSON object'] };
  }
  const obj = raw as Record<string, unknown>;

  const name = obj['name'];
  if (typeof name !== 'string' || name.trim() === '') {
    errors.push('name must be a non-empty string');
  }

  const cellSize = obj['cellSize'];
  if (typeof cellSize !== 'number' || cellSize !== 1) {
    errors.push('cellSize must be exactly 1 (engine assumes 1 m cells)');
  }

  const origin = obj['origin'];
  if (!_isVec2(origin)) {
    errors.push('origin must be an object with finite x and z numbers');
  }

  const grid = obj['grid'];
  if (!Array.isArray(grid)) {
    errors.push('grid must be an array of strings');
  }

  const legend = obj['legend'];
  if (legend === null || typeof legend !== 'object' || Array.isArray(legend)) {
    errors.push('legend must be an object');
  }

  const props = obj['props'];
  if (!Array.isArray(props)) {
    errors.push('props must be an array');
  }

  const spawns = obj['spawns'];
  if (spawns === null || typeof spawns !== 'object' || Array.isArray(spawns)) {
    errors.push('spawns must be an object');
  }

  const bombsites = obj['bombsites'];
  if (!Array.isArray(bombsites)) {
    errors.push('bombsites must be an array');
  }

  const areas = obj['areas'];
  if (!Array.isArray(areas)) {
    errors.push('areas must be an array');
  }

  // If basic structure is completely broken, abort early.
  if (errors.length > 0) return { ok: false, errors };

  // ── Tier 2: grid dimensions ──────────────────────────────────────────────
  const gridArr = grid as unknown[];
  const rowCount = gridArr.length;
  const MIN_DIM = 32;
  const MAX_DIM = 128;

  if (rowCount < MIN_DIM || rowCount > MAX_DIM) {
    errors.push(`grid must have ${MIN_DIM}–${MAX_DIM} rows; got ${rowCount}`);
    return { ok: false, errors };
  }

  let colCount = 0;
  let rowsAreStrings = true;
  for (let r = 0; r < gridArr.length; r++) {
    const row = gridArr[r];
    if (typeof row !== 'string') {
      errors.push(`grid row ${r} must be a string`);
      rowsAreStrings = false;
      continue;
    }
    if (colCount === 0) {
      if (row.length === 0) {
        errors.push('grid rows must be non-empty strings of equal length');
        rowsAreStrings = false;
        continue;
      }
      colCount = row.length;
    } else if (row.length !== colCount) {
      errors.push(`grid row ${r} has length ${row.length}; expected ${colCount} (from row 0)`);
    }
  }

  if (rowsAreStrings && colCount > 0) {
    if (colCount < MIN_DIM || colCount > MAX_DIM) {
      errors.push(`grid columns must be ${MIN_DIM}–${MAX_DIM}; got ${colCount}`);
    }
    if (rowCount !== colCount) {
      errors.push(`grid must be square (rows=${rowCount}, cols=${colCount})`);
    }
  }

  // ── Tier 3: legend ───────────────────────────────────────────────────────
  const legendObj = legend as Record<string, unknown>;
  const HEIGHT_STEP = 0.375;
  const MIN_FLOOR = -6;
  const MAX_FLOOR = 15;
  const PARSED_LEGEND: Record<string, CellLegend> = {};

  for (const [ch, entry] of Object.entries(legendObj)) {
    if (ch.length !== 1) {
      errors.push(`legend key "${ch}" must be a single character`);
      continue;
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`legend["${ch}"] must be an object`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    const floor = e['floor'];
    if (typeof floor !== 'number' || !isFinite(floor)) {
      errors.push(`legend["${ch}"].floor must be a finite number`);
      continue;
    }
    if (floor < MIN_FLOOR || floor > MAX_FLOOR) {
      errors.push(`legend["${ch}"].floor=${floor} out of range [${MIN_FLOOR},${MAX_FLOOR}]`);
    }
    // Must be a multiple of HEIGHT_STEP (within float tolerance).
    const remainder = Math.abs(floor / HEIGHT_STEP - Math.round(floor / HEIGHT_STEP));
    if (remainder > 1e-4) {
      errors.push(`legend["${ch}"].floor=${floor} is not a multiple of ${HEIGHT_STEP}`);
    }

    const ceil = e['ceil'];
    if (ceil !== undefined) {
      if (typeof ceil !== 'number' || !isFinite(ceil)) {
        errors.push(`legend["${ch}"].ceil must be a finite number`);
      } else if (ceil <= floor) {
        errors.push(`legend["${ch}"].ceil=${ceil} must be > floor=${floor}`);
      }
    }

    const wall = e['wall'];
    if (wall !== undefined && typeof wall !== 'boolean') {
      errors.push(`legend["${ch}"].wall must be a boolean`);
    }

    const mat = e['mat'];
    if (mat !== undefined && typeof mat !== 'string') {
      errors.push(`legend["${ch}"].mat must be a string`);
    }

    PARSED_LEGEND[ch] = {
      floor: floor as number,
      ...(ceil !== undefined ? { ceil: ceil as number } : {}),
      ...(wall !== undefined ? { wall: wall as boolean } : {}),
      ...(mat !== undefined ? { mat: mat as string } : {}),
    };
  }

  // Every grid character must appear in the legend.
  if (rowsAreStrings && colCount > 0 && errors.filter(e => e.startsWith('legend')).length === 0) {
    const usedChars = new Set<string>();
    for (const rowStr of gridArr as string[]) {
      for (const ch of rowStr) usedChars.add(ch);
    }
    for (const ch of usedChars) {
      if (!(ch in legendObj)) {
        errors.push(`grid character '${ch}' not found in legend`);
      }
    }
  }

  // ── Tier 4: spawns ────────────────────────────────────────────────────────
  const spawnsObj = spawns as Record<string, unknown>;
  const ctSpawns = spawnsObj['ct'];
  const tSpawns = spawnsObj['t'];

  const PARSED_CT_SPAWNS: SpawnPoint[] = [];
  const PARSED_T_SPAWNS: SpawnPoint[] = [];

  const cs = _validateSpawns(ctSpawns, 'ct', errors, PARSED_LEGEND, colCount, rowCount,
    typeof cellSize === 'number' ? cellSize : 1,
    _isVec2(origin) ? (origin as Vec2) : { x: 0, z: 0 });
  PARSED_CT_SPAWNS.push(...cs);

  const ts = _validateSpawns(tSpawns, 't', errors, PARSED_LEGEND, colCount, rowCount,
    typeof cellSize === 'number' ? cellSize : 1,
    _isVec2(origin) ? (origin as Vec2) : { x: 0, z: 0 });
  PARSED_T_SPAWNS.push(...ts);

  // ── Tier 5: bombsites ────────────────────────────────────────────────────
  const bombsitesArr = bombsites as unknown[];
  const MIN_BOMBSITE_AREA = 20; // m² (relaxed for custom maps)
  interface ParsedBombsite { name: 'A' | 'B'; min: Vec2; max: Vec2 }
  const PARSED_BOMBSITES: ParsedBombsite[] = [];

  if (bombsitesArr.length !== 2) {
    errors.push(`bombsites must have exactly 2 entries (A and B); got ${bombsitesArr.length}`);
  } else {
    for (let i = 0; i < bombsitesArr.length; i++) {
      const site = bombsitesArr[i];
      if (site === null || typeof site !== 'object' || Array.isArray(site)) {
        errors.push(`bombsite[${i}] must be an object`);
        continue;
      }
      const s = site as Record<string, unknown>;
      const sname = s['name'];
      if (sname !== 'A' && sname !== 'B') {
        errors.push(`bombsite[${i}].name must be 'A' or 'B'`);
        continue;
      }
      const smin = s['min'];
      const smax = s['max'];
      if (!_isVec2(smin) || !_isVec2(smax)) {
        errors.push(`bombsite[${i}] (${sname}) min and max must be Vec2 with finite x and z`);
        continue;
      }
      const minV = smin as Vec2;
      const maxV = smax as Vec2;
      if (minV.x >= maxV.x || minV.z >= maxV.z) {
        errors.push(`bombsite[${i}] (${sname}) min must be less than max in both axes`);
        continue;
      }
      const area = (maxV.x - minV.x) * (maxV.z - minV.z);
      if (area < MIN_BOMBSITE_AREA) {
        errors.push(`bombsite ${sname} area=${area.toFixed(1)} m² is below minimum ${MIN_BOMBSITE_AREA} m²`);
      }

      // Check bounds — the center at least must be inside the grid.
      const cs2 = typeof cellSize === 'number' ? cellSize : 1;
      const orig = _isVec2(origin) ? (origin as Vec2) : { x: 0, z: 0 };
      const cx = (minV.x + maxV.x) / 2;
      const cz = (minV.z + maxV.z) / 2;
      const col = Math.floor((cx - orig.x) / cs2);
      const row = Math.floor((cz - orig.z) / cs2);
      if (col < 0 || col >= colCount || row < 0 || row >= rowCount) {
        errors.push(`bombsite ${sname} center (${cx}, ${cz}) is outside the grid`);
      }

      PARSED_BOMBSITES.push({ name: sname as 'A' | 'B', min: minV, max: maxV });
    }

    // Ensure we have both A and B.
    const names = PARSED_BOMBSITES.map(b => b.name);
    if (names.length === 2 && (!names.includes('A') || !names.includes('B'))) {
      errors.push('bombsites must include both A and B');
    }
  }

  // ── Tier 6: props ─────────────────────────────────────────────────────────
  const propsArr = props as unknown[];
  const MAX_PROPS = 200;
  const VALID_PROP_KINDS = new Set(['crate', 'door', 'barrel', 'plank', 'block', 'sandbag', 'car']);
  const PARSED_PROPS: MapProp[] = [];

  if (propsArr.length > MAX_PROPS) {
    errors.push(`props count ${propsArr.length} exceeds maximum ${MAX_PROPS}`);
  }

  const cs3 = typeof cellSize === 'number' ? cellSize : 1;
  const orig3 = _isVec2(origin) ? (origin as Vec2) : { x: 0, z: 0 };
  const gridWorldMinX = orig3.x;
  const gridWorldMaxX = orig3.x + colCount * cs3;
  const gridWorldMinZ = orig3.z;
  const gridWorldMaxZ = orig3.z + rowCount * cs3;

  for (let i = 0; i < Math.min(propsArr.length, MAX_PROPS + 1); i++) {
    const prop = propsArr[i];
    if (prop === null || typeof prop !== 'object' || Array.isArray(prop)) {
      errors.push(`prop[${i}] must be an object`);
      continue;
    }
    const p = prop as Record<string, unknown>;

    const kind = p['kind'];
    if (typeof kind !== 'string' || !VALID_PROP_KINDS.has(kind)) {
      errors.push(`prop[${i}].kind must be one of: ${[...VALID_PROP_KINDS].join(', ')}`);
      continue;
    }

    const pos = p['pos'];
    if (!Array.isArray(pos) || pos.length !== 3 ||
        !pos.every(v => typeof v === 'number' && isFinite(v as number))) {
      errors.push(`prop[${i}].pos must be [x, y, z] with finite numbers`);
      continue;
    }
    const pPos = pos as [number, number, number];

    const size = p['size'];
    if (!Array.isArray(size) || size.length !== 3 ||
        !size.every(v => typeof v === 'number' && isFinite(v as number) && (v as number) > 0)) {
      errors.push(`prop[${i}].size must be [sx, sy, sz] with positive finite numbers`);
      continue;
    }
    const pSize = size as [number, number, number];

    // Prop footprint must be inside grid bounds.
    const px = pPos[0]; const pz = pPos[2];
    const hx = pSize[0] / 2; const hz = pSize[2] / 2;
    if (px - hx < gridWorldMinX - 1 || px + hx > gridWorldMaxX + 1 ||
        pz - hz < gridWorldMinZ - 1 || pz + hz > gridWorldMaxZ + 1) {
      errors.push(`prop[${i}] (${kind}) footprint is outside grid bounds`);
    }

    PARSED_PROPS.push({
      kind: kind as MapProp['kind'],
      pos: pPos,
      size: pSize,
      ...(typeof p['mat'] === 'string' ? { mat: p['mat'] } : {}),
      ...(typeof p['collide'] === 'boolean' ? { collide: p['collide'] } : {}),
    });
  }

  // ── Tier 6b: areas ────────────────────────────────────────────────────────
  const areasArr = areas as unknown[];
  interface ParsedArea { name: string; min: Vec2; max: Vec2 }
  const PARSED_AREAS: ParsedArea[] = [];
  for (let i = 0; i < areasArr.length; i++) {
    const area = areasArr[i];
    if (area === null || typeof area !== 'object' || Array.isArray(area)) {
      errors.push(`areas[${i}] must be an object`);
      continue;
    }
    const a = area as Record<string, unknown>;
    if (typeof a['name'] !== 'string' || (a['name'] as string).trim() === '') {
      errors.push(`areas[${i}].name must be a non-empty string`);
    }
    if (!_isVec2(a['min']) || !_isVec2(a['max'])) {
      errors.push(`areas[${i}].min and max must be Vec2 with finite x and z`);
      continue;
    }
    PARSED_AREAS.push({
      name: a['name'] as string,
      min: a['min'] as Vec2,
      max: a['max'] as Vec2,
    });
  }

  // If tiers 1-6 have errors, stop here.
  if (errors.length > 0) return { ok: false, errors };

  // ── Tier 7: reachability (BFS) ────────────────────────────────────────────
  // Only runs when tiers 1–6 are clean.
  // Replicates the BFS/passable logic from dust2.test.ts inline (no test-file imports).
  const reachErrors = _checkReachability(
    PARSED_LEGEND,
    gridArr as string[],
    rowCount,
    colCount,
    cs3,
    orig3,
    PARSED_CT_SPAWNS,
    PARSED_T_SPAWNS,
    PARSED_BOMBSITES,
  );
  errors.push(...reachErrors);

  if (errors.length > 0) return { ok: false, errors };

  // Build and return the fully typed MapData.
  const mapData: MapData = {
    name: name as string,
    cellSize: cellSize as number,
    origin: origin as Vec2,
    grid: gridArr as string[],
    legend: PARSED_LEGEND,
    props: PARSED_PROPS,
    spawns: {
      ct: PARSED_CT_SPAWNS,
      t: PARSED_T_SPAWNS,
    },
    bombsites: PARSED_BOMBSITES,
    areas: PARSED_AREAS,
  };
  return { ok: true, map: mapData };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _isVec2(v: unknown): boolean {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>)['x'] === 'number' &&
    isFinite((v as Record<string, unknown>)['x'] as number) &&
    typeof (v as Record<string, unknown>)['z'] === 'number' &&
    isFinite((v as Record<string, unknown>)['z'] as number)
  );
}

function _validateSpawns(
  raw: unknown,
  team: 'ct' | 't',
  errors: string[],
  legend: Record<string, CellLegend>,
  cols: number,
  rows: number,
  cellSize: number,
  origin: Vec2,
): SpawnPoint[] {
  const parsed: SpawnPoint[] = [];
  if (!Array.isArray(raw)) {
    errors.push(`spawns.${team} must be an array`);
    return parsed;
  }
  const arr = raw as unknown[];
  if (arr.length < 1) {
    errors.push(`spawns.${team} must have at least 1 spawn point`);
    return parsed;
  }
  if (arr.length > 8) {
    errors.push(`spawns.${team} must have at most 8 spawn points; got ${arr.length}`);
  }
  for (let i = 0; i < arr.length; i++) {
    const sp = arr[i];
    if (sp === null || typeof sp !== 'object' || Array.isArray(sp)) {
      errors.push(`spawns.${team}[${i}] must be an object`);
      continue;
    }
    const s = sp as Record<string, unknown>;
    const x = s['x']; const z = s['z']; const angle = s['angle'];
    if (typeof x !== 'number' || !isFinite(x) ||
        typeof z !== 'number' || !isFinite(z) ||
        typeof angle !== 'number' || !isFinite(angle)) {
      errors.push(`spawns.${team}[${i}] must have finite x, z, and angle (yaw radians)`);
      continue;
    }
    const col = Math.floor(((x as number) - origin.x) / cellSize);
    const row = Math.floor(((z as number) - origin.z) / cellSize);
    if (col < 0 || col >= cols || row < 0 || row >= rows) {
      errors.push(`spawns.${team}[${i}] (${x}, ${z}) is outside the grid`);
      continue;
    }
    // Wall-cell check is deferred to Tier 7 (_checkReachability) which has grid access.
    parsed.push({ x: x as number, z: z as number, angle: angle as number });
  }
  return parsed;
}

/**
 * Check that every spawn point is on a walkable cell (not a wall cell).
 * Returns error strings for any failures.
 */
function _isWalkableInLegend(
  legend: Record<string, CellLegend>,
  gridArr: string[],
  col: number,
  row: number,
): boolean {
  const rowStr = gridArr[row];
  if (rowStr === undefined) return false;
  const ch = rowStr[col];
  if (ch === undefined) return false;
  const cell = legend[ch];
  if (!cell) return false;
  return cell.wall !== true;
}

// BFS passability (mirrors dust2.test.ts logic exactly).
function _passable(
  legend: Record<string, CellLegend>,
  gridArr: string[],
  rows: number,
  cols: number,
  c0: number, r0: number,
  c1: number, r1: number,
): boolean {
  if (c0 < 0 || c0 >= cols || r0 < 0 || r0 >= rows) return false;
  if (c1 < 0 || c1 >= cols || r1 < 0 || r1 >= rows) return false;
  const ch0 = gridArr[r0]?.[c0];
  const ch1 = gridArr[r1]?.[c1];
  if (!ch0 || !ch1) return false;
  const a = legend[ch0];
  const b = legend[ch1];
  if (!a || !b) return false;
  if (a.wall === true || b.wall === true) return false;
  const climbOk = b.floor - a.floor <= 0.5 || b.floor < a.floor;
  if (!climbOk) return false;
  const ceil = Math.min(a.ceil ?? Infinity, b.ceil ?? Infinity);
  return ceil - Math.max(a.floor, b.floor) >= 1.9;
}

const BFS_DIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function _bfsReachable(
  legend: Record<string, CellLegend>,
  gridArr: string[],
  rows: number,
  cols: number,
  startCol: number,
  startRow: number,
): Set<number> {
  const visited = new Set<number>();
  if (!_isWalkableInLegend(legend, gridArr, startCol, startRow)) return visited;
  const startKey = startRow * cols + startCol;
  visited.add(startKey);
  const queue: number[] = [startKey];
  for (let qi = 0; qi < queue.length; qi++) {
    const key = queue[qi]!;
    const r = Math.floor(key / cols);
    const c = key % cols;
    for (const [dc, dr] of BFS_DIRS) {
      const cc = c + dc;
      const rr = r + dr;
      if (cc < 0 || cc >= cols || rr < 0 || rr >= rows) continue;
      const nk = rr * cols + cc;
      if (visited.has(nk)) continue;
      if (!_passable(legend, gridArr, rows, cols, c, r, cc, rr)) continue;
      visited.add(nk);
      queue.push(nk);
    }
  }
  return visited;
}

function _worldToCell(
  x: number, z: number, cellSize: number, origin: Vec2,
): [number, number] {
  return [
    Math.floor((x - origin.x) / cellSize),
    Math.floor((z - origin.z) / cellSize),
  ];
}

function _checkReachability(
  legend: Record<string, CellLegend>,
  gridArr: string[],
  rows: number,
  cols: number,
  cellSize: number,
  origin: Vec2,
  ctSpawns: SpawnPoint[],
  tSpawns: SpawnPoint[],
  bombsites: Array<{ name: 'A' | 'B'; min: Vec2; max: Vec2 }>,
): string[] {
  const errors: string[] = [];

  // Bombsite centers.
  const siteCenters = bombsites.map(b => ({
    name: b.name,
    x: (b.min.x + b.max.x) / 2,
    z: (b.min.z + b.max.z) / 2,
  }));

  // Check spawns on walkable cells.
  for (let i = 0; i < ctSpawns.length; i++) {
    const sp = ctSpawns[i]!;
    const [c, r] = _worldToCell(sp.x, sp.z, cellSize, origin);
    if (!_isWalkableInLegend(legend, gridArr, c, r)) {
      errors.push(`spawns.ct[${i}] (${sp.x}, ${sp.z}) is on a wall or void cell`);
    }
  }
  for (let i = 0; i < tSpawns.length; i++) {
    const sp = tSpawns[i]!;
    const [c, r] = _worldToCell(sp.x, sp.z, cellSize, origin);
    if (!_isWalkableInLegend(legend, gridArr, c, r)) {
      errors.push(`spawns.t[${i}] (${sp.x}, ${sp.z}) is on a wall or void cell`);
    }
  }

  // From every spawn point, every site center must be BFS-reachable.
  const allSpawns = [
    ...ctSpawns.map((s, i) => ({ label: `spawns.ct[${i}]`, sp: s })),
    ...tSpawns.map((s, i) => ({ label: `spawns.t[${i}]`, sp: s })),
  ];

  for (const { label, sp } of allSpawns) {
    const [sc, sr] = _worldToCell(sp.x, sp.z, cellSize, origin);
    const reachable = _bfsReachable(legend, gridArr, rows, cols, sc, sr);
    for (const site of siteCenters) {
      const [tc, tr] = _worldToCell(site.x, site.z, cellSize, origin);
      const key = tr * cols + tc;
      if (!reachable.has(key)) {
        errors.push(
          `reachability: ${label} (${sp.x}, ${sp.z}) cannot reach bombsite ${site.name} center (${site.x.toFixed(1)}, ${site.z.toFixed(1)})`,
        );
      }
    }
  }

  return errors;
}
