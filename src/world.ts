import type { Vec3, MapData, CellLegend } from './types';
import { MOVEMENT } from './constants';
import { type AABB, rayAABBNormal, v3 } from './math';

export interface RayHit {
  point: Vec3;
  normal: Vec3;
  distance: number;
  kind: 'floor' | 'wall' | 'ceiling' | 'prop';
}


function makeAABB(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): AABB {
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

export class World {
  readonly map: MapData;
  readonly propBoxes: AABB[];

  private readonly _rows: number;
  private readonly _cols: number;

  constructor(map: MapData) {
    this.map = map;
    this._rows = map.grid.length;
    this._cols = map.grid[0]?.length ?? 0;

    // Build AABB list for collidable props only.
    this.propBoxes = [];
    for (const prop of map.props) {
      if (prop.collide === false) continue;
      const [px, py, pz] = prop.pos;
      const [sx, sy, sz] = prop.size;
      this.propBoxes.push(makeAABB(
        px - sx / 2, py,       pz - sz / 2,
        px + sx / 2, py + sy,  pz + sz / 2,
      ));
    }
  }

  /** Convert world (x,z) to grid (col, row). */
  private _toGrid(x: number, z: number): [number, number] {
    const col = Math.floor((x - this.map.origin.x) / this.map.cellSize);
    const row = Math.floor((z - this.map.origin.z) / this.map.cellSize);
    return [col, row];
  }

  cellAt(x: number, z: number): CellLegend {
    const [col, row] = this._toGrid(x, z);
    if (col < 0 || col >= this._cols || row < 0 || row >= this._rows) {
      return { floor: 0, wall: true };
    }
    const ch = this.map.grid[row][col];
    return this.map.legend[ch] ?? { floor: 0, wall: true };
  }

  floorAt(x: number, z: number): number {
    const cell = this.cellAt(x, z);
    if (cell.wall) return Infinity;
    return cell.floor;
  }

  ceilAt(x: number, z: number): number {
    const cell = this.cellAt(x, z);
    if (cell.wall) return Infinity;
    return cell.ceil ?? Infinity;
  }

  /**
   * Highest standable floor surface ≤ feetY + STEP_HEIGHT over the AABB footprint [x±r, z±r].
   * Prop tops count (standing on crates allowed).
   */
  groundHeight(x: number, z: number, r: number, feetY: number): number {
    const stepCeil = feetY + MOVEMENT.STEP_HEIGHT;

    // Gather cell floor heights over footprint.
    const xMin = x - r;
    const xMax = x + r;
    const zMin = z - r;
    const zMax = z + r;

    const colMin = Math.floor((xMin - this.map.origin.x) / this.map.cellSize);
    const colMax = Math.floor((xMax - this.map.origin.x) / this.map.cellSize);
    const rowMin = Math.floor((zMin - this.map.origin.z) / this.map.cellSize);
    const rowMax = Math.floor((zMax - this.map.origin.z) / this.map.cellSize);

    let best = -Infinity;

    for (let row = rowMin; row <= rowMax; row++) {
      for (let col = colMin; col <= colMax; col++) {
        let cell: CellLegend;
        if (col < 0 || col >= this._cols || row < 0 || row >= this._rows) {
          cell = { floor: 0, wall: true };
        } else {
          const ch = this.map.grid[row][col];
          cell = this.map.legend[ch] ?? { floor: 0, wall: true };
        }
        if (cell.wall) continue; // walls are not a floor surface to stand on
        const floorH = cell.floor;
        if (floorH <= stepCeil && floorH > best) {
          best = floorH;
        }
      }
    }

    // Check prop tops.
    const playerBox: AABB = { min: v3(xMin, -Infinity, zMin), max: v3(xMax, Infinity, zMax) };
    for (const box of this.propBoxes) {
      // XZ overlap?
      if (box.max.x <= playerBox.min.x || box.min.x >= playerBox.max.x) continue;
      if (box.max.z <= playerBox.min.z || box.min.z >= playerBox.max.z) continue;
      const topY = box.max.y;
      if (topY <= stepCeil && topY > best) {
        best = topY;
      }
    }

    return best === -Infinity ? 0 : best;
  }

  /**
   * Lowest ceiling over the AABB footprint [x±r, z±r].
   */
  ceilingOver(x: number, z: number, r: number): number {
    const xMin = x - r;
    const xMax = x + r;
    const zMin = z - r;
    const zMax = z + r;

    const colMin = Math.floor((xMin - this.map.origin.x) / this.map.cellSize);
    const colMax = Math.floor((xMax - this.map.origin.x) / this.map.cellSize);
    const rowMin = Math.floor((zMin - this.map.origin.z) / this.map.cellSize);
    const rowMax = Math.floor((zMax - this.map.origin.z) / this.map.cellSize);

    let best = Infinity;

    for (let row = rowMin; row <= rowMax; row++) {
      for (let col = colMin; col <= colMax; col++) {
        let cell: CellLegend;
        if (col < 0 || col >= this._cols || row < 0 || row >= this._rows) {
          cell = { floor: 0, wall: true };
        } else {
          const ch = this.map.grid[row][col];
          cell = this.map.legend[ch] ?? { floor: 0, wall: true };
        }
        // Wall cells block overhead (treat as solid).
        if (cell.wall) {
          best = 0; // definitely blocked
          continue;
        }
        const ceilH = cell.ceil ?? Infinity;
        if (ceilH < best) best = ceilH;
      }
    }

    return best;
  }

  /**
   * Returns true if ANY cell in the footprint [x±r, z±r] at the given Y-body-range is a wall or solid.
   * bodyFloor/bodyTop defines the Y slice we test walls for (walls extend from -1 to 7.5).
   */
  private _wallOverlap(x: number, z: number, r: number, bodyFloor: number, bodyTop: number): boolean {
    const xMin = x - r;
    const xMax = x + r;
    const zMin = z - r;
    const zMax = z + r;

    const colMin = Math.floor((xMin - this.map.origin.x) / this.map.cellSize);
    const colMax = Math.floor((xMax - this.map.origin.x) / this.map.cellSize);
    const rowMin = Math.floor((zMin - this.map.origin.z) / this.map.cellSize);
    const rowMax = Math.floor((zMax - this.map.origin.z) / this.map.cellSize);

    for (let row = rowMin; row <= rowMax; row++) {
      for (let col = colMin; col <= colMax; col++) {
        let cell: CellLegend;
        if (col < 0 || col >= this._cols || row < 0 || row >= this._rows) {
          return true; // out-of-bounds is always solid
        }
        const ch = this.map.grid[row][col];
        cell = this.map.legend[ch] ?? { floor: 0, wall: true };
        if (cell.wall) return true;
      }
    }

    // Check props for body-level collision.
    const playerBox: AABB = {
      min: { x: xMin, y: bodyFloor, z: zMin },
      max: { x: xMax, y: bodyTop,   z: zMax },
    };
    for (const box of this.propBoxes) {
      if (box.max.x <= playerBox.min.x || box.min.x >= playerBox.max.x) continue;
      if (box.max.y <= playerBox.min.y || box.min.y >= playerBox.max.y) continue;
      if (box.max.z <= playerBox.min.z || box.min.z >= playerBox.max.z) continue;
      return true;
    }

    return false;
  }

  /**
   * Returns the highest obstacle surface over footprint [x±r, z±r] without
   * applying the STEP_HEIGHT cap — raw maximum floor or prop top.
   * Used internally to determine if an obstacle is too tall to step over.
   */
  private _maxSurface(x: number, z: number, r: number): number {
    const xMin = x - r;
    const xMax = x + r;
    const zMin = z - r;
    const zMax = z + r;

    const colMin = Math.floor((xMin - this.map.origin.x) / this.map.cellSize);
    const colMax = Math.floor((xMax - this.map.origin.x) / this.map.cellSize);
    const rowMin = Math.floor((zMin - this.map.origin.z) / this.map.cellSize);
    const rowMax = Math.floor((zMax - this.map.origin.z) / this.map.cellSize);

    let best = -Infinity;
    for (let row = rowMin; row <= rowMax; row++) {
      for (let col = colMin; col <= colMax; col++) {
        let cell: CellLegend;
        if (col < 0 || col >= this._cols || row < 0 || row >= this._rows) {
          return Infinity; // out-of-bounds = impassable
        }
        const ch = this.map.grid[row][col];
        cell = this.map.legend[ch] ?? { floor: 0, wall: true };
        if (cell.wall) return Infinity; // walls are impassable
        if (cell.floor > best) best = cell.floor;
      }
    }
    // Also check prop tops.
    for (const box of this.propBoxes) {
      if (box.max.x <= xMin || box.min.x >= xMax) continue;
      if (box.max.z <= zMin || box.min.z >= zMax) continue;
      if (box.max.y > best) best = box.max.y;
    }
    return best === -Infinity ? 0 : best;
  }

  /**
   * Axis-separated swept AABB move with sliding + step-up.
   * Mutates nothing; returns result.
   */
  moveAABB(
    pos: Vec3,
    vel: Vec3,
    dt: number,
    r: number,
    height: number,
  ): { pos: Vec3; vel: Vec3; onGround: boolean; hitWall: boolean } {
    let { x, y, z } = pos;
    let { x: vx, y: vy, z: vz } = vel;
    let onGround = false;
    let hitWall = false;

    // Current feet Y (bottom of capsule).
    let feetY = y;

    /**
     * Check if moving the AABB to (nx, feetY, nz) is allowed.
     * Returns: 'free' | 'step' (can step-up) | 'blocked'
     * Also updates feetY if stepping up.
     */
    const tryHorizMove = (
      nx: number,
      nz: number,
    ): { ok: boolean; newFeetY: number } => {
      // Get the highest obstacle surface at the new footprint.
      const surf = this._maxSurface(nx, nz, r);
      if (!isFinite(surf)) return { ok: false, newFeetY: feetY }; // wall/OOB

      const rise = surf - feetY;
      if (rise > MOVEMENT.STEP_HEIGHT) {
        // Too tall to step over.
        return { ok: false, newFeetY: feetY };
      }

      // The new feet position after potential step-up.
      const newFeet = rise > 0 ? surf : feetY;

      // Check ceiling clearance at new position.
      const ceil = this.ceilingOver(nx, nz, r);
      if (ceil - newFeet < height - 0.01) {
        return { ok: false, newFeetY: feetY }; // not enough headroom
      }

      return { ok: true, newFeetY: newFeet };
    };

    // --- X axis ---
    if (vx !== 0) {
      const newX = x + vx * dt;
      const { ok, newFeetY } = tryHorizMove(newX, z);
      if (ok) {
        x = newX;
        feetY = newFeetY;
      } else {
        vx = 0;
        hitWall = true;
      }
    }

    // --- Z axis ---
    if (vz !== 0) {
      const newZ = z + vz * dt;
      const { ok, newFeetY } = tryHorizMove(x, newZ);
      if (ok) {
        z = newZ;
        feetY = newFeetY;
      } else {
        vz = 0;
        hitWall = true;
      }
    }

    // --- Y axis ---
    feetY += vy * dt;

    // Snap to ground: find highest surface at current XZ within a small lookahead.
    // We check with a slightly generous window to avoid floating just above the floor.
    const groundFinal = this.groundHeight(x, z, r, feetY + 0.1);
    if (feetY <= groundFinal + 1e-4 && vy <= 0) {
      feetY = groundFinal;
      vy = 0;
      onGround = true;
    }

    // Check ceiling.
    const ceilFinal = this.ceilingOver(x, z, r);
    if (feetY + height > ceilFinal) {
      feetY = ceilFinal - height;
      if (vy > 0) vy = 0;
    }

    return {
      pos: { x, y: feetY, z },
      vel: { x: vx, y: vy, z: vz },
      onGround,
      hitWall,
    };
  }

  /**
   * 2.5D DDA raycast over cells + rayAABB over props.
   * Returns nearest hit or null.
   */
  raycast(origin: Vec3, dir: Vec3, maxDist: number): RayHit | null {
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;
    const dx = dir.x;
    const dy = dir.y;
    const dz = dir.z;

    // Inverse dir for slab tests.
    const invX = dx === 0 ? Infinity : 1 / dx;
    const invY = dy === 0 ? Infinity : 1 / dy;
    const invZ = dz === 0 ? Infinity : 1 / dz;
    const invDir: Vec3 = { x: invX, y: invY, z: invZ };

    // --- DDA setup ---
    const cs = this.map.cellSize;
    const origX = this.map.origin.x;
    const origZ = this.map.origin.z;

    let col = Math.floor((ox - origX) / cs);
    let row = Math.floor((oz - origZ) / cs);

    const stepC = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepR = dz > 0 ? 1 : dz < 0 ? -1 : 0;

    // t values to reach first boundary.
    const tDeltaC = Math.abs(cs / (dx === 0 ? 1e-10 : dx));
    const tDeltaR = Math.abs(cs / (dz === 0 ? 1e-10 : dz));

    let tMaxC: number;
    let tMaxR: number;
    if (dx === 0) {
      tMaxC = Infinity;
    } else if (dx > 0) {
      tMaxC = ((origX + (col + 1) * cs) - ox) / dx;
    } else {
      tMaxC = ((origX + col * cs) - ox) / dx;
    }
    if (dz === 0) {
      tMaxR = Infinity;
    } else if (dz > 0) {
      tMaxR = ((origZ + (row + 1) * cs) - oz) / dz;
    } else {
      tMaxR = ((origZ + row * cs) - oz) / dz;
    }

    let bestDist = maxDist;
    let bestHit: RayHit | null = null;

    // DDA march.
    for (let step = 0; step < 512; step++) {
      const tEnter = Math.min(tMaxC - tDeltaC, tMaxR - tDeltaR);
      const tExit  = Math.min(tMaxC, tMaxR);
      const tStart = Math.max(0, tEnter < 0 ? 0 : tEnter);
      if (tStart >= bestDist) break;

      // Get cell legend.
      let cellLeg: CellLegend;
      if (col < 0 || col >= this._cols || row < 0 || row >= this._rows) {
        cellLeg = { floor: 0, wall: true };
      } else {
        const ch = this.map.grid[row][col];
        cellLeg = this.map.legend[ch] ?? { floor: 0, wall: true };
      }

      if (cellLeg.wall) {
        // Wall hit at tEnter.
        const t = Math.max(0, tEnter);
        if (t < bestDist) {
          // Determine normal from which axis we entered from.
          let nx = 0, ny = 0, nz = 0;
          if (tMaxC - tDeltaC < tMaxR - tDeltaR) {
            nx = -stepC;
          } else {
            nz = -stepR;
          }
          bestDist = t;
          bestHit = {
            point: { x: ox + dx * t, y: oy + dy * t, z: oz + dz * t },
            normal: { x: nx, y: ny, z: nz },
            distance: t,
            kind: 'wall',
          };
        }
        break;
      }

      // Non-wall cell: check floor and ceiling within [tStart, tExit].
      const floorY = cellLeg.floor;
      const ceilY  = cellLeg.ceil ?? Infinity;

      // Floor intersection: ray descending through y = floorY.
      if (dy !== 0) {
        const tFloor = (floorY - oy) * invY;
        if (tFloor >= tStart - 1e-5 && tFloor < tExit + 1e-5 && tFloor < bestDist) {
          // Make sure xz is inside this cell at that t.
          const fx = ox + dx * tFloor;
          const fz = oz + dz * tFloor;
          const fc = Math.floor((fx - origX) / cs);
          const fr = Math.floor((fz - origZ) / cs);
          if (fc === col && fr === row) {
            bestDist = tFloor;
            bestHit = {
              point: { x: fx, y: floorY, z: fz },
              normal: { x: 0, y: 1, z: 0 },
              distance: tFloor,
              kind: 'floor',
            };
          }
        }
      }

      // Ceiling intersection.
      if (ceilY < Infinity && dy !== 0) {
        const tCeil = (ceilY - oy) * invY;
        if (tCeil >= tStart - 1e-5 && tCeil < tExit + 1e-5 && tCeil < bestDist) {
          const cx2 = ox + dx * tCeil;
          const cz2 = oz + dz * tCeil;
          const cc2 = Math.floor((cx2 - origX) / cs);
          const cr2 = Math.floor((cz2 - origZ) / cs);
          if (cc2 === col && cr2 === row) {
            bestDist = tCeil;
            bestHit = {
              point: { x: cx2, y: ceilY, z: cz2 },
              normal: { x: 0, y: -1, z: 0 },
              distance: tCeil,
              kind: 'ceiling',
            };
          }
        }
      }

      // Advance DDA.
      if (tMaxC < tMaxR) {
        tMaxC += tDeltaC;
        col += stepC;
      } else {
        tMaxR += tDeltaR;
        row += stepR;
      }

      if (tMaxC > bestDist && tMaxR > bestDist) break;
      if (stepC === 0 && stepR === 0) break;
    }

    // --- Prop rayAABB ---
    for (const box of this.propBoxes) {
      const hit = rayAABBNormal(origin, invDir, box);
      if (hit !== null && hit.t < bestDist) {
        bestDist = hit.t;
        bestHit = {
          point: { x: ox + dx * hit.t, y: oy + dy * hit.t, z: oz + dz * hit.t },
          normal: hit.normal,
          distance: hit.t,
          kind: 'prop',
        };
      }
    }

    return bestHit;
  }

  lineOfSight(a: Vec3, b: Vec3): boolean {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-6) return true;
    const dir: Vec3 = { x: dx / dist, y: dy / dist, z: dz / dist };
    const hit = this.raycast(a, dir, dist - 0.01);
    return hit === null;
  }
}

