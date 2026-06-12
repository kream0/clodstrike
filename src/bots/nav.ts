/**
 * NavGrid — A* pathfinding over the DUST2 grid.
 *
 * Coordinate systems:
 *   - Cell (col, row): integer indices. col = floor((x - origin.x) / cellSize).
 *   - World Vec3: x/z are continuous, y is floor height from the cell legend.
 *
 * Walkability rules (match BFS used by World.moveAABB):
 *   - Cell is not a wall (cell.wall !== true).
 *   - For covered cells: ceil − floor >= 1.9 m (player height).
 *   - Climbing: floorB − floorA <= 0.5 m (STEP_HEIGHT).
 *   - Drops: floorA − floorB <= 4.0 m (one-way, from high to low).
 *   - Diagonals: both orthogonal neighbors must be passable (no corner-cutting).
 *
 * Prop awareness (added 2026-06: root-cause fix for path-through-prop wedging):
 *   The grid above is prop-blind, so A* used to route a bot straight through a
 *   crate/car AABB. World.moveAABB then rejects the swept move every tick (the
 *   prop top rises > STEP_HEIGHT above the feet) and the bot wedges. NavGrid now
 *   builds the collidable prop AABBs from map.props at construction (same rule
 *   as World) and marks any cell whose standing footprint is occupied by a
 *   non-traversable prop as NOT walkable — for A*, neighbor edges, string-pull,
 *   nearestWalkable, and randomPointInRect alike. An edge between two clear cells
 *   is additionally pruned when a prop straddling the shared boundary narrows the
 *   traversable gap below a bot width. All checks are precomputed at build time;
 *   the hot A* inner loop reads a boolean and never touches the prop list.
 *
 *   "Non-traversable" matches World.moveAABB / _maxSurface exactly: a prop blocks
 *   a footprint when its top rises more than STEP_HEIGHT above the local floor.
 *   moveAABB takes the raw max prop top and never inspects the prop's bottom, so
 *   it does NOT model walking UNDER a raised prop — and neither do we. Exempting a
 *   high overhang in nav would route the bot into a guaranteed wedge (mirage's
 *   A-site big crate sits 2 m above the floor, clearing standing height, yet
 *   collision still blocks it).
 */

import type { MapData, Vec2, Vec3, MapProp } from '../types';
import type { RngStream } from '../rng';
import { MOVEMENT } from '../constants';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STEP_HEIGHT     = 0.5;   // max upward climb
const MAX_DROP        = 4.0;   // max one-way downward drop
const MIN_HEADROOM    = 1.9;   // minimum ceil-floor for covered cells
const WALL_PENALTY    = 1.15;  // cost multiplier for cells adjacent to a wall
const DROP_COST_MULT  = 1.5;   // extra cost for drop edges

// Prop-occlusion tuning (meters). PLAYER_RADIUS is the AABB half-width used by
// simulateMovement / moveAABB; a prop within this distance of a standing bot's
// centre obstructs it.
const BOT_RADIUS      = MOVEMENT.PLAYER_RADIUS;  // 0.4 m half-width
const PROP_BLOCK_RISE = STEP_HEIGHT;             // top above floor that is too tall to step onto

// ---------------------------------------------------------------------------
// Internal AABB (XZ + Y range) for collidable props
// ---------------------------------------------------------------------------

interface PropAABB {
  minX: number; maxX: number;
  minZ: number; maxZ: number;
  minY: number; maxY: number;
}

// ---------------------------------------------------------------------------
// Internal cell descriptor
// ---------------------------------------------------------------------------

interface NavCell {
  col:       number;
  row:       number;
  floor:     number;
  walkable:  boolean;
  isWall:    boolean; // true = solid wall cell
}

// ---------------------------------------------------------------------------
// Binary min-heap (keyed by f-score) — inline to avoid allocations
// ---------------------------------------------------------------------------

class MinHeap {
  private _keys: Float64Array;
  private _vals: Int32Array;  // packed (row << 16 | col) node indices
  private _size = 0;

  constructor(capacity: number) {
    this._keys = new Float64Array(capacity);
    this._vals = new Int32Array(capacity);
  }

  get size(): number { return this._size; }

  push(key: number, val: number): void {
    let i = this._size++;
    this._keys[i] = key;
    this._vals[i] = val;
    // Bubble up.
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._keys[p] <= this._keys[i]) break;
      this._swap(p, i);
      i = p;
    }
  }

  pop(): number {
    const val = this._vals[0];
    const last = --this._size;
    this._keys[0] = this._keys[last];
    this._vals[0] = this._vals[last];
    // Bubble down.
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let smallest = i;
      if (l < this._size && this._keys[l] < this._keys[smallest]) smallest = l;
      if (r < this._size && this._keys[r] < this._keys[smallest]) smallest = r;
      if (smallest === i) break;
      this._swap(i, smallest);
      i = smallest;
    }
    return val;
  }

  clear(): void { this._size = 0; }

  private _swap(a: number, b: number): void {
    const tk = this._keys[a]; this._keys[a] = this._keys[b]; this._keys[b] = tk;
    const tv = this._vals[a]; this._vals[a] = this._vals[b]; this._vals[b] = tv;
  }
}

// ---------------------------------------------------------------------------
// Edge descriptor
// ---------------------------------------------------------------------------

interface Edge {
  col:   number;
  row:   number;
  cost:  number; // base movement cost (diagonal = sqrt(2))
  isDrop: boolean;
}

// ---------------------------------------------------------------------------
// NavGrid
// ---------------------------------------------------------------------------

export class NavGrid {
  private readonly _map: MapData;
  private readonly _cols: number;
  private readonly _rows: number;
  private readonly _cells: NavCell[];        // flat [row * cols + col]
  private readonly _neighbors: Edge[][];     // pre-built neighbor lists per cell
  private readonly _heap: MinHeap;
  private readonly _props: PropAABB[];       // collidable prop AABBs (from map.props)

  // Reusable A* arrays (reset each call via a generation counter).
  private readonly _gScore:   Float64Array;
  private readonly _fScore:   Float64Array;
  private readonly _parent:   Int32Array;    // -1 = none; packed index
  private readonly _visited:  Uint8Array;    // 1 = closed

  constructor(map: MapData) {
    this._map  = map;
    this._cols = map.grid[0]?.length ?? 0;
    this._rows = map.grid.length;

    const N = this._cols * this._rows;

    // Build collidable prop AABBs (same rule as World: skip collide===false,
    // pos = bottom-centre, size = full extents). Built BEFORE cells so cell
    // walkability can consult them.
    this._props = NavGrid._buildPropBoxes(map.props);

    // Build cell descriptors. A cell is walkable only if the grid says so AND
    // no non-traversable prop occupies the standing footprint there.
    this._cells = new Array(N);
    for (let row = 0; row < this._rows; row++) {
      for (let col = 0; col < this._cols; col++) {
        const ch   = map.grid[row][col];
        const leg  = map.legend[ch];
        const idx  = row * this._cols + col;

        let walkable = false;
        let floor    = 0;
        let isWall   = true;

        if (leg) {
          isWall = leg.wall === true;
          if (!isWall) {
            floor = leg.floor;
            const headroom = (leg.ceil !== undefined) ? (leg.ceil - leg.floor) : Infinity;
            walkable = headroom >= MIN_HEADROOM;
            // Prop occlusion: a non-traversable prop on this cell's footprint
            // makes the cell unwalkable (matches World.moveAABB rejection).
            if (walkable && this._footprintBlocked(col, row, floor)) {
              walkable = false;
            }
          }
        }
        this._cells[idx] = { col, row, floor, walkable, isWall };
      }
    }

    // Pre-build neighbor adjacency.
    this._neighbors = new Array(N);
    for (let idx = 0; idx < N; idx++) {
      this._neighbors[idx] = this._buildEdges(idx);
    }

    // A* work arrays.
    this._heap    = new MinHeap(N);
    this._gScore  = new Float64Array(N).fill(Infinity);
    this._fScore  = new Float64Array(N).fill(Infinity);
    this._parent  = new Int32Array(N).fill(-1);
    this._visited = new Uint8Array(N);
  }

  // ---------------------------------------------------------------------------
  // Prop-occlusion helpers (build-time only — never called in the hot A* loop)
  // ---------------------------------------------------------------------------

  /** Build the collidable prop AABB list from map.props (mirrors World). */
  private static _buildPropBoxes(props: ReadonlyArray<MapProp>): PropAABB[] {
    const out: PropAABB[] = [];
    for (const prop of props) {
      if (prop.collide === false) continue;
      const [px, py, pz] = prop.pos;
      const [sx, sy, sz] = prop.size;
      out.push({
        minX: px - sx / 2, maxX: px + sx / 2,
        minZ: pz - sz / 2, maxZ: pz + sz / 2,
        minY: py,          maxY: py + sy,
      });
    }
    return out;
  }

  /**
   * True if `box` is a non-traversable obstacle for a bot standing on `floor`.
   * Matches World.moveAABB / _maxSurface EXACTLY: that collision path takes the
   * raw maximum prop top over the footprint and blocks the swept move whenever
   * that top rises more than STEP_HEIGHT above the feet — it never inspects the
   * prop's bottom, so it does NOT model walking UNDER a raised prop. A prop low
   * enough to step onto (top ≤ floor+STEP) is the only traversable case.
   *
   * NOTE: we deliberately do NOT exempt high overhangs (bottom ≥ floor+height).
   * Geometrically a bot could duck under such a prop, but moveAABB still rejects
   * the move, so exempting it in nav would route the bot into a guaranteed wedge
   * (this was the mirage A-site crate-cluster bug: the big crate sits 2.0 m above
   * the floor, just clearing standing height, yet collision blocks it). The
   * BOT_HEIGHT constant is retained for documentation / future collision changes.
   */
  private _propIsObstacle(box: PropAABB, floor: number): boolean {
    return box.maxY > floor + PROP_BLOCK_RISE;
  }

  /**
   * True if a non-traversable prop overlaps the standing footprint centred at
   * cell (col,row) — i.e. the bot's AABB (centre ± BOT_RADIUS) intersects the
   * prop's XZ extent. Inclusive of the radius so a prop edge within BOT_RADIUS
   * of the cell centre counts as occupying it.
   */
  private _footprintBlocked(col: number, row: number, floor: number): boolean {
    if (this._props.length === 0) return false;
    const cx = this._map.origin.x + col * this._map.cellSize + this._map.cellSize * 0.5;
    const cz = this._map.origin.z + row * this._map.cellSize + this._map.cellSize * 0.5;
    const minX = cx - BOT_RADIUS, maxX = cx + BOT_RADIUS;
    const minZ = cz - BOT_RADIUS, maxZ = cz + BOT_RADIUS;
    for (const box of this._props) {
      if (box.maxX <= minX || box.minX >= maxX) continue;
      if (box.maxZ <= minZ || box.minZ >= maxZ) continue;
      if (this._propIsObstacle(box, floor)) return true;
    }
    return false;
  }

  /**
   * True if a non-traversable prop straddles the boundary between two adjacent
   * cell centres such that the remaining sideways gap a bot could squeeze
   * through is narrower than a full bot width (2 × BOT_RADIUS). This prunes the
   * edge even when neither cell centre is itself footprint-blocked (a crate
   * sitting just off-centre between two cells, leaving a sub-bot-width slot).
   *
   * We sample the midpoint of the segment between the two cell centres and test
   * a bot-width footprint there: if a prop obstacle overlaps that swept slot,
   * the transition cannot be taken cleanly.
   */
  private _edgeBlocked(
    fromCol: number, fromRow: number, toCol: number, toRow: number, floor: number,
  ): boolean {
    if (this._props.length === 0) return false;
    const cs = this._map.cellSize;
    const ox = this._map.origin.x;
    const oz = this._map.origin.z;
    const ax = ox + fromCol * cs + cs * 0.5;
    const az = oz + fromRow * cs + cs * 0.5;
    const bx = ox + toCol * cs + cs * 0.5;
    const bz = oz + toRow * cs + cs * 0.5;
    const mx = (ax + bx) * 0.5;
    const mz = (az + bz) * 0.5;
    const minX = mx - BOT_RADIUS, maxX = mx + BOT_RADIUS;
    const minZ = mz - BOT_RADIUS, maxZ = mz + BOT_RADIUS;
    for (const box of this._props) {
      if (box.maxX <= minX || box.minX >= maxX) continue;
      if (box.maxZ <= minZ || box.minZ >= maxZ) continue;
      if (this._propIsObstacle(box, floor)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Public: isWalkableStep
  // ---------------------------------------------------------------------------

  isWalkableStep(fromIdx: number, toIdx: number): boolean {
    const from = this._cells[fromIdx];
    const to   = this._cells[toIdx];
    if (!from || !to) return false;
    if (!from.walkable || !to.walkable) return false;
    const rise = to.floor - from.floor;
    if (rise > STEP_HEIGHT) return false;
    if (rise < -MAX_DROP) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Public: nearestWalkable
  // ---------------------------------------------------------------------------

  nearestWalkable(p: Vec3): Vec3 | null {
    const { col, row } = this._worldToCell(p.x, p.z);
    // BFS outward.
    const maxR = 20;
    for (let r = 0; r <= maxR; r++) {
      for (let dc = -r; dc <= r; dc++) {
        for (let dr = -r; dr <= r; dr++) {
          if (Math.abs(dc) !== r && Math.abs(dr) !== r) continue;
          const c2 = col + dc;
          const r2 = row + dr;
          if (c2 < 0 || c2 >= this._cols || r2 < 0 || r2 >= this._rows) continue;
          const cell = this._cells[r2 * this._cols + c2];
          if (cell.walkable) {
            return this._cellCenter(c2, r2, cell.floor);
          }
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Public: randomPointInRect
  // ---------------------------------------------------------------------------

  /**
   * Pick a uniformly random walkable cell inside the given rectangle.
   *
   * @param min  - min corner (x/z) of the query rect in world coords.
   * @param max  - max corner (x/z) of the query rect in world coords.
   * @param rng  - Seeded stream for deterministic selection.
   *               Defaults to Math.random() when omitted (legacy callers / tests).
   */
  randomPointInRect(min: Vec2, max: Vec2, rng?: RngStream): Vec3 | null {
    const colMin = Math.max(0, Math.floor((min.x - this._map.origin.x) / this._map.cellSize));
    const colMax = Math.min(this._cols - 1, Math.floor((max.x - this._map.origin.x) / this._map.cellSize));
    const rowMin = Math.max(0, Math.floor((min.z - this._map.origin.z) / this._map.cellSize));
    const rowMax = Math.min(this._rows - 1, Math.floor((max.z - this._map.origin.z) / this._map.cellSize));

    // Collect walkable candidates.
    const candidates: [number, number][] = [];
    for (let r = rowMin; r <= rowMax; r++) {
      for (let c = colMin; c <= colMax; c++) {
        const cell = this._cells[r * this._cols + c];
        if (cell.walkable) candidates.push([c, r]);
      }
    }
    if (candidates.length === 0) return null;

    const pick = rng !== undefined
      ? Math.floor(rng.next() * candidates.length)
      : Math.floor(Math.random() * candidates.length);
    const [cc, cr] = candidates[pick]!;
    const cell = this._cells[cr * this._cols + cc]!;
    return this._cellCenter(cc, cr, cell.floor);
  }

  // ---------------------------------------------------------------------------
  // Public: findPath  (A* + string-pull)
  // ---------------------------------------------------------------------------

  findPath(from: Vec3, to: Vec3): Vec3[] | null {
    const startCell = this._snapToWalkable(from);
    const goalCell  = this._snapToWalkable(to);
    if (!startCell || !goalCell) return null;

    const startIdx = startCell.row * this._cols + startCell.col;
    const goalIdx  = goalCell.row  * this._cols + goalCell.col;

    if (startIdx === goalIdx) {
      return [this._cellCenter(goalCell.col, goalCell.row, goalCell.floor)];
    }

    const N = this._cols * this._rows;

    // Reset work arrays by filling (cheaper than full fill on large maps: mark only dirty set).
    const dirty: number[] = [];

    const resetDirty = (): void => {
      for (const idx of dirty) {
        this._gScore[idx]  = Infinity;
        this._fScore[idx]  = Infinity;
        this._parent[idx]  = -1;
        this._visited[idx] = 0;
      }
    };

    this._heap.clear();

    const h = (idx: number): number => {
      const c = this._cells[idx];
      const dc = Math.abs(c.col - goalCell.col);
      const dr = Math.abs(c.row - goalCell.row);
      // Octile heuristic.
      return (dc + dr - 0.5858 * Math.min(dc, dr));
    };

    this._gScore[startIdx]  = 0;
    this._fScore[startIdx]  = h(startIdx);
    dirty.push(startIdx);
    this._heap.push(this._fScore[startIdx], startIdx);

    let found = false;

    while (this._heap.size > 0) {
      const current = this._heap.pop();

      if (this._visited[current]) continue;
      this._visited[current] = 1;

      if (current === goalIdx) { found = true; break; }

      for (const edge of this._neighbors[current]) {
        const nIdx = edge.row * this._cols + edge.col;
        if (this._visited[nIdx]) continue;

        const tentativeG = this._gScore[current] + edge.cost;
        if (this._gScore[nIdx] === Infinity) {
          dirty.push(nIdx);
        }
        if (tentativeG < this._gScore[nIdx]) {
          this._parent[nIdx]  = current;
          this._gScore[nIdx]  = tentativeG;
          this._fScore[nIdx]  = tentativeG + h(nIdx);
          this._heap.push(this._fScore[nIdx], nIdx);
        }
      }
    }

    if (!found) {
      resetDirty();
      return null;
    }

    // Reconstruct raw cell path.
    const rawPath: number[] = [];
    let cur = goalIdx;
    while (cur !== -1) {
      rawPath.push(cur);
      cur = this._parent[cur];
    }
    rawPath.reverse();

    resetDirty();

    // String-pull smoothing.
    const smoothed = this._stringPull(rawPath);

    // Convert to world Vec3.
    return smoothed.map(idx => {
      const cell = this._cells[idx];
      return this._cellCenter(cell.col, cell.row, cell.floor);
    });
  }

  // ---------------------------------------------------------------------------
  // Private: _buildEdges
  // ---------------------------------------------------------------------------

  private _buildEdges(idx: number): Edge[] {
    const cell = this._cells[idx];
    if (!cell.walkable) return [];

    const edges: Edge[] = [];
    const { col, row } = cell;

    // 8 directions: 4 cardinal + 4 diagonal.
    const dirs = [
      { dc: 0,  dr: -1, diag: false },
      { dc: 0,  dr:  1, diag: false },
      { dc: -1, dr:  0, diag: false },
      { dc:  1, dr:  0, diag: false },
      { dc: -1, dr: -1, diag: true  },
      { dc:  1, dr: -1, diag: true  },
      { dc: -1, dr:  1, diag: true  },
      { dc:  1, dr:  1, diag: true  },
    ];

    for (const d of dirs) {
      const nc = col + d.dc;
      const nr = row + d.dr;
      if (nc < 0 || nc >= this._cols || nr < 0 || nr >= this._rows) continue;

      const nIdx = nr * this._cols + nc;
      const neighbor = this._cells[nIdx];
      if (!neighbor.walkable) continue;

      const rise = neighbor.floor - cell.floor;
      if (rise > STEP_HEIGHT) continue;       // too steep to climb
      if (rise < -MAX_DROP)   continue;       // drop too deep
      const isDrop = rise < -STEP_HEIGHT;     // significant downward drop

      // Diagonal: both orthogonal neighbors must be passable (no corner-cutting).
      if (d.diag) {
        const n1 = (row        ) * this._cols + (col + d.dc);
        const n2 = (row + d.dr ) * this._cols + (col       );
        const c1 = this._cells[n1];
        const c2 = this._cells[n2];
        if (!c1 || !c1.walkable) continue;
        if (!c2 || !c2.walkable) continue;
      }

      // Prop boundary gap: prune the edge when a non-traversable prop straddles
      // the cell boundary, leaving a sub-bot-width slot (both cell centres are
      // clear but the bot cannot fit between). Use the lower of the two floors
      // so the obstacle test is conservative (a prop tall above the lower floor
      // still blocks even when the higher cell could step over it).
      const edgeFloor = Math.min(cell.floor, neighbor.floor);
      if (this._edgeBlocked(col, row, nc, nr, edgeFloor)) continue;

      // Base movement cost.
      let cost = d.diag ? Math.SQRT2 : 1.0;
      if (isDrop) cost *= DROP_COST_MULT;

      // Wall-proximity penalty: check if neighbor is adjacent to any wall.
      if (this._hasAdjacentWall(nc, nr)) cost *= WALL_PENALTY;

      edges.push({ col: nc, row: nr, cost, isDrop });
    }

    return edges;
  }

  private _hasAdjacentWall(col: number, row: number): boolean {
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (dc === 0 && dr === 0) continue;
        const nc = col + dc;
        const nr = row + dr;
        if (nc < 0 || nc >= this._cols || nr < 0 || nr >= this._rows) return true;
        const c = this._cells[nr * this._cols + nc];
        if (c.isWall) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Private: _stringPull — greedy string-pull over raw cell index path.
  // ---------------------------------------------------------------------------

  private _stringPull(rawPath: number[]): number[] {
    if (rawPath.length <= 2) return rawPath;

    const result: number[] = [rawPath[0]];
    let anchor = 0;

    while (anchor < rawPath.length - 1) {
      // Try to advance the lookahead as far as possible.
      let reach = anchor + 1;
      for (let j = anchor + 2; j < rawPath.length; j++) {
        if (this._straightWalkable(rawPath[anchor], rawPath[j])) {
          reach = j;
        } else {
          break;
        }
      }
      result.push(rawPath[reach]);
      anchor = reach;
    }

    return result;
  }

  /**
   * Check if a straight line between two cell indices is walkable via
   * Bresenham cell walk. Drops mid-segment are only allowed when monotonic
   * (height strictly decreasing throughout). Additionally rejects the segment
   * when the swept bot footprint grazes a non-traversable prop — so a
   * string-pulled segment between two clear cell centres can never clip a crate
   * corner that lives in an adjacent cell (the bot follows these straight lines
   * literally; a clipped corner is exactly where it would wedge).
   */
  private _straightWalkable(fromIdx: number, toIdx: number): boolean {
    if (fromIdx === toIdx) return true;

    const fc = this._cells[fromIdx];
    const tc = this._cells[toIdx];

    let x0 = fc.col;
    let y0 = fc.row;
    const x1 = tc.col;
    const y1 = tc.row;

    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x1 > x0 ? 1 : -1;
    const sy = y1 > y0 ? 1 : -1;
    let err = dx - dy;

    let prevIdx = fromIdx;
    let prevFloor = fc.floor;

    for (let step = 0; step < dx + dy + 1; step++) {
      const curIdx = y0 * this._cols + x0;
      const cur    = this._cells[curIdx];

      if (!cur.walkable) return false;

      if (curIdx !== fromIdx) {
        const rise = cur.floor - prevFloor;
        if (rise > STEP_HEIGHT) return false;
        // No drops allowed mid-segment for string pull (conservative).
        if (rise < -STEP_HEIGHT) return false;
      }

      if (x0 === x1 && y0 === y1) break;

      prevIdx   = curIdx;
      prevFloor = cur.floor;

      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 <  dx) { err += dx; y0 += sy; }
    }

    // Continuous swept-footprint prop test along the straight segment (only when
    // the map has collidable props). The cell walk above already rejects any
    // blocked cell centre; this catches the corner-clip case where both endpoints
    // and every visited cell centre are clear but the bot body would graze a prop
    // mid-segment.
    if (this._props.length > 0 && !this._segPropClear(fc, tc)) return false;

    return true;
  }

  /**
   * True when a bot footprint swept along the straight XZ segment between two
   * cell centres never overlaps a non-traversable prop. Samples every BOT_RADIUS
   * along the segment; the obstacle floor reference is the lower of the two cell
   * floors (conservative). Build-time only (string-pull) — not on the A* hot path.
   */
  private _segPropClear(fc: NavCell, tc: NavCell): boolean {
    const cs = this._map.cellSize;
    const ox = this._map.origin.x;
    const oz = this._map.origin.z;
    const ax = ox + fc.col * cs + cs * 0.5;
    const az = oz + fc.row * cs + cs * 0.5;
    const bx = ox + tc.col * cs + cs * 0.5;
    const bz = oz + tc.row * cs + cs * 0.5;
    const floor = Math.min(fc.floor, tc.floor);

    const ddx = bx - ax, ddz = bz - az;
    const len = Math.sqrt(ddx * ddx + ddz * ddz);
    const ux = len < 1e-6 ? 0 : ddx / len;
    const uz = len < 1e-6 ? 0 : ddz / len;
    const stepLen = BOT_RADIUS; // sample at half the footprint width

    for (let t = 0; t <= len + 1e-6; t += stepLen) {
      const sx = ax + ux * t, sz = az + uz * t;
      const minX = sx - BOT_RADIUS, maxX = sx + BOT_RADIUS;
      const minZ = sz - BOT_RADIUS, maxZ = sz + BOT_RADIUS;
      for (const box of this._props) {
        if (box.maxX <= minX || box.minX >= maxX) continue;
        if (box.maxZ <= minZ || box.minZ >= maxZ) continue;
        if (this._propIsObstacle(box, floor)) return false;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Private: coordinate helpers
  // ---------------------------------------------------------------------------

  private _worldToCell(x: number, z: number): { col: number; row: number } {
    const col = Math.floor((x - this._map.origin.x) / this._map.cellSize);
    const row = Math.floor((z - this._map.origin.z) / this._map.cellSize);
    return { col, row };
  }

  private _cellCenter(col: number, row: number, floor: number): Vec3 {
    return {
      x: this._map.origin.x + col * this._map.cellSize + this._map.cellSize * 0.5,
      y: floor,
      z: this._map.origin.z + row * this._map.cellSize + this._map.cellSize * 0.5,
    };
  }

  private _snapToWalkable(p: Vec3): NavCell | null {
    const { col, row } = this._worldToCell(p.x, p.z);

    // Try exact cell first.
    if (col >= 0 && col < this._cols && row >= 0 && row < this._rows) {
      const cell = this._cells[row * this._cols + col];
      if (cell.walkable) return cell;
    }

    // BFS outward to find nearest walkable.
    for (let r = 1; r <= 20; r++) {
      for (let dc = -r; dc <= r; dc++) {
        for (let dr = -r; dr <= r; dr++) {
          if (Math.abs(dc) !== r && Math.abs(dr) !== r) continue;
          const c2 = col + dc;
          const r2 = row + dr;
          if (c2 < 0 || c2 >= this._cols || r2 < 0 || r2 >= this._rows) continue;
          const cell = this._cells[r2 * this._cols + c2];
          if (cell.walkable) return cell;
        }
      }
    }
    return null;
  }

  // Expose for tests.
  get cols(): number { return this._cols; }
  get rows(): number { return this._rows; }
}
