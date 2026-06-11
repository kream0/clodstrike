import * as THREE from 'three';
import type { MapData, CellLegend } from './types';

// ---- Material palette -------------------------------------------------------

const MAT_COLORS: Record<string, number> = {
  sand:       0xc9a06a,
  sandLight:  0xd6b888,
  stone:      0xa59786,
  floor:      0xb89b66,
  wood:       0x8a6b46,
  metal:      0x5d6b78,
  dark:       0x6e6253,
};

function createMaterial(colorHex: number, vertexColors = false): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color: colorHex, vertexColors });
}

// ---- Vertex-color tint helpers ----------------------------------------------

/** Add subtle per-box vertex-color tint (×0.94–1.06) to a BoxGeometry. */
function tintGeometry(geo: THREE.BoxGeometry): THREE.BufferGeometry {
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  const t = 0.94 + Math.random() * 0.12; // 0.94 to 1.06
  for (let i = 0; i < count; i++) {
    colors[i * 3]     = t;
    colors[i * 3 + 1] = t;
    colors[i * 3 + 2] = t;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

// ---- Scene row-merge builder ------------------------------------------------

interface BoxSpec {
  cx: number; cy: number; cz: number;   // center
  sx: number; sy: number; sz: number;   // full extents
  matKey: string;
}

function buildBox(spec: BoxSpec): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(spec.sx, spec.sy, spec.sz);
  geo.translate(spec.cx, spec.cy, spec.cz);
  tintGeometry(geo);
  return geo;
}

export function buildMapScene(map: MapData): { group: THREE.Group } {
  const group = new THREE.Group();

  const rows = map.grid.length;
  const cols = map.grid[0]?.length ?? 0;
  const cs   = map.cellSize;
  const ox   = map.origin.x;
  const oz   = map.origin.z;

  const WALL_HEIGHT = 7.5; // uniform skyline
  const WALL_BOTTOM = -1.0;
  const FLOOR_SLAB  = 0.5;  // floor slab thickness
  const CEIL_THICK  = 0.4;  // covered-ceiling slab thickness

  // Collect BoxSpecs bucketed by material key.
  const specsByMat = new Map<string, BoxSpec[]>();

  function addSpec(s: BoxSpec): void {
    let arr = specsByMat.get(s.matKey);
    if (!arr) { arr = []; specsByMat.set(s.matKey, arr); }
    arr.push(s);
  }

  // Helper: world X of left edge of column c.
  function xLeft(c: number): number  { return ox + c * cs; }
  // Helper: world Z of top edge of row r.
  function zTop(r: number): number   { return oz + r * cs; }

  // Identify cells that are within 2 cells of a non-wall cell (for OOB wall rendering).
  function isNearFloor(col: number, row: number): boolean {
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const nc = col + dc;
        const nr = row + dr;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const ch = map.grid[nr][nc];
        const leg = map.legend[ch];
        if (leg && !leg.wall) return true;
      }
    }
    return false;
  }

  // Process rows: greedy merge along row for consecutive cells with the same char.
  for (let row = 0; row < rows; row++) {
    const gridRow = map.grid[row];
    let c = 0;
    while (c < cols) {
      const ch = gridRow[c];
      const leg: CellLegend | undefined = map.legend[ch];
      if (!leg) { c++; continue; }

      // Find run of same character.
      let runEnd = c + 1;
      while (runEnd < cols && gridRow[runEnd] === ch) runEnd++;

      const matKey = leg.mat ?? 'sand';
      const worldX  = xLeft(c);
      const worldZ  = zTop(row);
      const runW    = (runEnd - c) * cs;
      const centerX = worldX + runW / 2;
      const centerZ = worldZ + cs / 2;

      if (leg.wall) {
        // Out-of-bounds ' ' cells: only render if near a floor cell.
        if (ch === ' ') {
          // Render each cell individually, only if near floor.
          for (let cc = c; cc < runEnd; cc++) {
            if (!isNearFloor(cc, row)) continue;
            const cellX = ox + cc * cs + cs / 2;
            const cellZ = oz + row * cs + cs / 2;
            const h = WALL_HEIGHT - WALL_BOTTOM;
            addSpec({ cx: cellX, cy: (WALL_BOTTOM + WALL_HEIGHT) / 2, cz: cellZ, sx: cs, sy: h, sz: cs, matKey: 'sand' });
          }
        } else {
          // Normal wall cell '#'.
          const h = WALL_HEIGHT - WALL_BOTTOM;
          addSpec({ cx: centerX, cy: (WALL_BOTTOM + WALL_HEIGHT) / 2, cz: centerZ, sx: runW, sy: h, sz: cs, matKey });
        }
      } else {
        // Floor slab: top at leg.floor, thickness FLOOR_SLAB.
        addSpec({
          cx: centerX,
          cy: leg.floor - FLOOR_SLAB / 2,
          cz: centerZ,
          sx: runW,
          sy: FLOOR_SLAB,
          sz: cs,
          matKey,
        });

        // Covered ceiling slab.
        if (leg.ceil !== undefined) {
          addSpec({
            cx: centerX,
            cy: leg.ceil + CEIL_THICK / 2,
            cz: centerZ,
            sx: runW,
            sy: CEIL_THICK,
            sz: cs,
            matKey: 'dark',
          });
        }
      }

      c = runEnd;
    }
  }

  // Build merged meshes per material.
  for (const [matKey, specs] of specsByMat) {
    const color = MAT_COLORS[matKey] ?? 0xc9a06a;
    const mat = createMaterial(color, true);
    const geos = specs.map(buildBox);

    // Synchronous merge via manual combination if mergeGeometries is unavailable at this point.
    // We'll batch them into one using a simple loop approach.
    mergeAndAddMesh(group, geos, mat);
  }

  // --- Props ---
  for (const prop of map.props) {
    const [px, py, pz] = prop.pos;
    const [sx, sy, sz] = prop.size;
    const matKey = prop.mat ?? 'wood';
    const color  = MAT_COLORS[matKey] ?? MAT_COLORS.wood;
    const propMat = createMaterial(color, true);

    let geo: THREE.BufferGeometry;
    if (prop.kind === 'barrel') {
      geo = new THREE.CylinderGeometry(sx / 2, sx / 2, sy, 10);
    } else {
      geo = new THREE.BoxGeometry(sx, sy, sz);
    }
    tintGeometry(geo as THREE.BoxGeometry);

    const mesh = new THREE.Mesh(geo, propMat);
    mesh.position.set(px, py + sy / 2, pz);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // Override prop material colors for special kinds.
  // (Applied above but kept explicit here for clarity.)

  return { group };
}

/**
 * Merge an array of BufferGeometries into a single Mesh and add to group.
 * Falls back to individual meshes if mergeGeometries is not yet available.
 */
function mergeAndAddMesh(
  group: THREE.Group,
  geos: THREE.BufferGeometry[],
  mat: THREE.MeshLambertMaterial,
): void {
  if (geos.length === 0) return;

  // Manual merge using THREE.BufferGeometryUtils-style attribute concatenation.
  // This avoids async import issues entirely by doing it inline.
  try {
    const merged = manualMerge(geos);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  } catch {
    // Fallback: individual meshes.
    for (const geo of geos) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow    = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
}

/** Manual geometry merge: concatenate position, normal, uv, color attributes. */
function manualMerge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let totalVerts = 0;
  let totalIndices = 0;

  for (const g of geos) {
    totalVerts   += g.attributes.position.count;
    if (g.index) totalIndices += g.index.count;
    else         totalIndices += g.attributes.position.count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals   = new Float32Array(totalVerts * 3);
  const uvs       = new Float32Array(totalVerts * 2);
  const colors    = new Float32Array(totalVerts * 3);
  const indices   = new Uint32Array(totalIndices);

  let vOffset = 0;
  let iOffset = 0;

  for (const g of geos) {
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nor = g.attributes.normal   as THREE.BufferAttribute;
    const uv  = g.attributes.uv       as THREE.BufferAttribute | undefined;
    const col = g.attributes.color    as THREE.BufferAttribute | undefined;
    const cnt = pos.count;

    for (let i = 0; i < cnt; i++) {
      positions[(vOffset + i) * 3]     = pos.getX(i);
      positions[(vOffset + i) * 3 + 1] = pos.getY(i);
      positions[(vOffset + i) * 3 + 2] = pos.getZ(i);
      normals[(vOffset + i) * 3]     = nor.getX(i);
      normals[(vOffset + i) * 3 + 1] = nor.getY(i);
      normals[(vOffset + i) * 3 + 2] = nor.getZ(i);
      if (uv) {
        uvs[(vOffset + i) * 2]     = uv.getX(i);
        uvs[(vOffset + i) * 2 + 1] = uv.getY(i);
      }
      colors[(vOffset + i) * 3]     = col ? col.getX(i) : 1;
      colors[(vOffset + i) * 3 + 1] = col ? col.getY(i) : 1;
      colors[(vOffset + i) * 3 + 2] = col ? col.getZ(i) : 1;
    }

    if (g.index) {
      const idx = g.index;
      for (let i = 0; i < idx.count; i++) {
        indices[iOffset + i] = idx.getX(i) + vOffset;
      }
      iOffset += idx.count;
    } else {
      for (let i = 0; i < cnt; i++) {
        indices[iOffset + i] = vOffset + i;
      }
      iOffset += cnt;
    }

    vOffset += cnt;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal',   new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
  merged.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));

  return merged;
}

export function setupEnvironment(scene: THREE.Scene): void {
  scene.background = new THREE.Color(0x9fc3e8);
  scene.fog = new THREE.Fog(0xcfc1a0, 60, 160);

  const hemi = new THREE.HemisphereLight(0xbdd7f0, 0x8a7a5a, 0.9);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff1d6, 1.4);
  sun.position.set(40, 70, 30);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.width  = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far  = 200;
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left   = -60;
  sc.right  =  60;
  sc.top    =  60;
  sc.bottom = -60;
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  scene.add(sun.target);
}
