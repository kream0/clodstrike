import * as THREE from 'three';
import type { MapData, CellLegend } from './types';
import type { LoadedTextures, TextureSlot } from './assets';

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

// ---- Texture mapping --------------------------------------------------------

/** Tile sizes in meters per texture repeat (world-space planar UV scale). */
const TILE_SIZES: Record<TextureSlot, number> = {
  ground_sand:   3.5,
  wall_sandstone: 3.0,
  wall_plaster:   3.0,
  floor_stone:    1.8,
  concrete:       3.0,
  wood:           2.0,
  metal:          2.0,
  fabric:         1.5,
};

/** Surface kind for bucketing — determines UV axis and texture choice. */
type SurfaceKind = 'wall' | 'floor' | 'ceil';

/**
 * matKey × kind → TextureSlot mapping.
 * Wall/ceil distinction: walls get the vertical-surface texture;
 * floors/ceils get the horizontal-surface texture.
 */
const TEX_MAP: Record<string, Partial<Record<SurfaceKind, TextureSlot>>> = {
  sand:      { wall: 'wall_sandstone', floor: 'ground_sand',  ceil: 'concrete' },
  sandLight: { wall: 'wall_plaster',   floor: 'ground_sand',  ceil: 'concrete' },
  stone:     { wall: 'wall_sandstone', floor: 'floor_stone',  ceil: 'concrete' },
  floor:     { wall: 'concrete',       floor: 'concrete',     ceil: 'concrete' },
  dark:      { wall: 'concrete',       floor: 'concrete',     ceil: 'concrete' },
  wood:      { wall: 'wood',           floor: 'wood',         ceil: 'wood'     },
  metal:     { wall: 'metal',          floor: 'metal',        ceil: 'metal'    },
};

/**
 * Neutral per-slot tint colors (very light, so textures read correctly).
 * These replace the strong hex colors in textured path.
 */
const TEX_TINT: Partial<Record<TextureSlot, number>> = {
  ground_sand:   0xf0e8d8,
  wall_sandstone: 0xf5ede0,
  wall_plaster:   0xf8f0e8,
  floor_stone:    0xe8e4e0,
  concrete:       0xe0dcd8,
  wood:           0xf0ead8,
  metal:          0xe8ecf0,
  fabric:         0xf0e8e0,
};

// ---- UV projection ----------------------------------------------------------

/**
 * World-space planar UV projection.
 * Projects a world-space vertex (px,py,pz) onto a 2D UV plane based on the
 * dominant axis of the face normal (nx,ny,nz), then scales by 1/tile.
 *
 * Rules:
 *   |ny| dominant (top/bottom faces): uv = (x/tile, z/tile)
 *   |nx| dominant (±X faces):         uv = (z/tile, y/tile)
 *   else ±Z faces:                    uv = (x/tile, y/tile)
 *
 * This ensures tiling stays continuous across greedy-merged boxes at the
 * same world position — any two boxes sharing a face edge will produce
 * identical UV values at that shared world coordinate.
 *
 * @param px  vertex world X
 * @param py  vertex world Y
 * @param pz  vertex world Z
 * @param nx  face normal X
 * @param ny  face normal Y
 * @param nz  face normal Z
 * @param tile texture repeat in meters (meters per one full UV unit)
 * @returns [u, v]
 */
export function projectUV(
  px: number, py: number, pz: number,
  nx: number, ny: number, nz: number,
  tile: number,
): [number, number] {
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);

  if (ay >= ax && ay >= az) {
    // Top / bottom face
    return [px / tile, pz / tile];
  } else if (ax >= az) {
    // ±X side face
    return [pz / tile, py / tile];
  } else {
    // ±Z side face
    return [px / tile, py / tile];
  }
}

// ---- Vertex-color tint helpers ----------------------------------------------

/**
 * Add subtle per-box vertex-color tint (×0.94–1.06) to a BoxGeometry.
 * In the textured path, tints are already near-white so they act as
 * subtle AO variation without muddying the texture.
 */
function tintGeometry(geo: THREE.BufferGeometry, attenuate = false): THREE.BufferGeometry {
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  // Raw tint in [0.94, 1.06]
  let t = 0.94 + Math.random() * 0.12;
  if (attenuate) {
    // In textured path: lerp strongly toward 1.0 so texture reads clearly.
    // Result is in [0.988, 1.003] — virtually invisible, just mild AO haze.
    t = 0.8 * 1.0 + 0.2 * t; // 0.8 * 1 + 0.2 * [0.94..1.06] = [0.988..1.012]
  }
  for (let i = 0; i < count; i++) {
    colors[i * 3]     = t;
    colors[i * 3 + 1] = t;
    colors[i * 3 + 2] = t;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

// ---- World-space UV application ---------------------------------------------

/**
 * Rewrite the `uv` attribute of a geometry that has already been translated
 * to world position (via geo.translate), using world-space planar projection.
 * Must be called AFTER geo.translate() so vertex positions are in world space.
 */
function applyWorldUVs(geo: THREE.BufferGeometry, slot: TextureSlot): void {
  const tile = TILE_SIZES[slot];
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal   as THREE.BufferAttribute;
  const count = pos.count;
  const uvs = new Float32Array(count * 2);

  for (let i = 0; i < count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    const nx = nor.getX(i);
    const ny = nor.getY(i);
    const nz = nor.getZ(i);
    const [u, v] = projectUV(px, py, pz, nx, ny, nz, tile);
    uvs[i * 2]     = u;
    uvs[i * 2 + 1] = v;
  }

  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
}

// ---- Scene row-merge builder ------------------------------------------------

interface BoxSpec {
  cx: number; cy: number; cz: number;   // center
  sx: number; sy: number; sz: number;   // full extents
  matKey: string;
  kind: SurfaceKind;
}

function buildBox(spec: BoxSpec, applyUVSlot?: TextureSlot): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(spec.sx, spec.sy, spec.sz);
  // Translate to world position BEFORE UV projection so vertex positions are world-space.
  geo.translate(spec.cx, spec.cy, spec.cz);
  if (applyUVSlot !== undefined) {
    applyWorldUVs(geo, applyUVSlot);
  }
  tintGeometry(geo, applyUVSlot !== undefined);
  return geo;
}

/**
 * Build the map scene geometry and materials.
 *
 * @param map     MapData to render (e.g. DUST2)
 * @param textures Optional LoadedTextures. When provided, meshes use tiling world-UV textures.
 *                 When omitted, falls back to existing vertex-color-only behavior (no textures).
 * @param normals  Optional normal maps per slot. Requires textures to be provided.
 */
export function buildMapScene(
  map: MapData,
  textures?: LoadedTextures,
  normals?: Partial<Record<TextureSlot, THREE.Texture>>,
): { group: THREE.Group } {
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

  // Textured path: bucket by `${matKey}|${kind}` for surface-aware texture selection.
  // No-texture path: bucket by `${matKey}` (original behavior).
  const specsByBucket = new Map<string, BoxSpec[]>();

  function bucketKey(matKey: string, kind: SurfaceKind): string {
    return textures ? `${matKey}|${kind}` : matKey;
  }

  function addSpec(s: BoxSpec): void {
    const key = bucketKey(s.matKey, s.kind);
    let arr = specsByBucket.get(key);
    if (!arr) { arr = []; specsByBucket.set(key, arr); }
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
        const ch = map.grid[nr]?.[nc];
        if (ch === undefined) continue;
        const leg = map.legend[ch];
        if (leg && !leg.wall) return true;
      }
    }
    return false;
  }

  // Process rows: greedy merge along row for consecutive cells with the same char.
  for (let row = 0; row < rows; row++) {
    const gridRow = map.grid[row];
    if (gridRow === undefined) continue;
    let c = 0;
    while (c < cols) {
      const ch = gridRow[c];
      if (ch === undefined) { c++; continue; }
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
            addSpec({ cx: cellX, cy: (WALL_BOTTOM + WALL_HEIGHT) / 2, cz: cellZ, sx: cs, sy: h, sz: cs, matKey: 'sand', kind: 'wall' });
          }
        } else {
          // Normal wall cell '#'.
          const h = WALL_HEIGHT - WALL_BOTTOM;
          addSpec({ cx: centerX, cy: (WALL_BOTTOM + WALL_HEIGHT) / 2, cz: centerZ, sx: runW, sy: h, sz: cs, matKey, kind: 'wall' });
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
          kind: 'floor',
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
            kind: 'ceil',
          });
        }
      }

      c = runEnd;
    }
  }

  // Build merged meshes per bucket.
  for (const [bucketKey, specs] of specsByBucket) {
    // Derive matKey from bucket key (either 'mat' or 'mat|kind').
    const matKey = bucketKey.split('|')[0] ?? bucketKey;

    let mat: THREE.MeshLambertMaterial;
    let applyUVSlot: TextureSlot | undefined;

    if (textures) {
      // kind is only meaningful in the textured path where bucketKey is 'mat|kind'.
      const kind = (bucketKey.split('|')[1] ?? 'floor') as SurfaceKind;
      const slot: TextureSlot = TEX_MAP[matKey]?.[kind] ?? 'concrete';
      applyUVSlot = slot;
      const tex = textures[slot];
      const tintHex = TEX_TINT[slot] ?? 0xffffff;
      mat = new THREE.MeshLambertMaterial({
        map: tex,
        vertexColors: true,
        color: tintHex,
      });
      // Apply normal map if available.
      const normalTex = normals?.[slot];
      if (normalTex !== undefined) {
        mat.normalMap = normalTex;
      }
    } else {
      const color = MAT_COLORS[matKey] ?? 0xc9a06a;
      mat = createMaterial(color, true);
    }

    const geos = specs.map(s => buildBox(s, applyUVSlot));
    mergeAndAddMesh(group, geos, mat);
  }

  // --- Props ---
  const clonedTextures: THREE.Texture[] = [];
  for (const prop of map.props) {
    const [px, py, pz] = prop.pos;
    const [sx, sy, sz] = prop.size;
    const matKey = prop.mat ?? 'wood';
    let propMat: THREE.MeshLambertMaterial;

    if (textures) {
      // Map prop kind/mat to a texture slot.
      const slot = resolvePropSlot(prop.kind, matKey);
      // Clone texture so we can set a different repeat independently.
      const tex = textures[slot].clone();
      tex.needsUpdate = true;
      clonedTextures.push(tex);
      const tile = TILE_SIZES[slot];
      // For box props use world repeat; for cylinders use a fixed repeat.
      if (prop.kind === 'barrel') {
        tex.repeat.set(sx / tile, sy / tile);
      } else {
        // Box props: world-UV repeat handled in geometry; set repeat (1,1) and
        // let UVs do the work — but props are NOT merged, so we bake UVs directly.
        tex.repeat.set(1, 1);
      }
      const tintHex = TEX_TINT[slot] ?? 0xffffff;
      propMat = new THREE.MeshLambertMaterial({
        map: tex,
        vertexColors: true,
        color: tintHex,
      });
      const normalTex = normals?.[slot];
      if (normalTex !== undefined) {
        const normalClone = normalTex.clone();
        normalClone.needsUpdate = true;
        clonedTextures.push(normalClone);
        propMat.normalMap = normalClone;
      }
    } else {
      const color  = MAT_COLORS[matKey] ?? MAT_COLORS['wood'] ?? 0x8a6b46;
      propMat = createMaterial(color, true);
    }

    let geo: THREE.BufferGeometry;
    if (prop.kind === 'barrel') {
      geo = new THREE.CylinderGeometry(sx / 2, sx / 2, sy, 10);
    } else {
      const boxGeo = new THREE.BoxGeometry(sx, sy, sz);
      // For textured props, apply world-space UVs using the prop's world center.
      if (textures) {
        const slot = resolvePropSlot(prop.kind, matKey);
        // Translate to world position first for accurate UV projection.
        boxGeo.translate(px, py + sy / 2, pz);
        applyWorldUVs(boxGeo, slot);
        // Geometry is now at world pos; mesh.position stays at origin.
        const mesh = new THREE.Mesh(boxGeo, propMat);
        mesh.castShadow    = true;
        mesh.receiveShadow = true;
        tintGeometry(boxGeo, true);
        group.add(mesh);
        continue;
      }
      geo = boxGeo;
    }
    tintGeometry(geo, textures !== undefined);

    const mesh = new THREE.Mesh(geo, propMat);
    mesh.position.set(px, py + sy / 2, pz);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  group.userData.clonedTextures = clonedTextures;
  return { group };
}

/** Resolve a TextureSlot for a prop given its kind and matKey. */
function resolvePropSlot(kind: MapPropKind, matKey: string): TextureSlot {
  // Explicit kind overrides.
  if (kind === 'sandbag') return 'fabric';
  if (kind === 'car')     return 'metal';
  // matKey fallback.
  if (matKey === 'wood')  return 'wood';
  if (matKey === 'metal') return 'metal';
  return 'wood';
}

// Narrow prop kind type for internal use (mirrors MapProp.kind).
type MapPropKind = 'crate' | 'door' | 'barrel' | 'plank' | 'block' | 'sandbag' | 'car';

function createMaterial(colorHex: number, vertexColors = false): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color: colorHex, vertexColors });
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

// ---------------------------------------------------------------------------
// Skydome shader — gradient sky with a painted sun disc + glow halo.
// Rendered BackSide on a large sphere so it sits behind all world geometry.
// ---------------------------------------------------------------------------

const SKY_VERT = /* glsl */`
varying vec3 vWorldDir;
void main() {
  // Transform vertex to world space and pass normalized direction to fragment.
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldDir = normalize(worldPos.xyz);
  // Expand to clip-space, then force z = w. This is the standard skybox/skydome
  // trick (cf. three.js examples/jsm/objects/Sky.js): it pins the dome to the far
  // plane AND defeats far-plane clipping, because GPU primitive clipping tests the
  // shader's OUTPUT gl_Position (z <= w holds by construction). Consequently the
  // dome radius and the camera position are irrelevant — do NOT "fix" this by
  // attaching the dome to the camera or shrinking the radius; it is not a bug.
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w;
}
`;

const SKY_FRAG = /* glsl */`
uniform vec3 uZenith;       // zenith sky colour
uniform vec3 uHorizon;      // horizon/haze colour (matches scene fog)
uniform vec3 uSunDir;       // normalised sun direction (world space)
uniform vec3 uSunColor;     // sun disc + inner halo colour (HDR, > 1 ok)
uniform vec3 uGlowColor;    // outer glow colour
varying vec3 vWorldDir;

void main() {
  vec3 dir = normalize(vWorldDir);

  // --- Gradient (vertical) ---
  // t = 0 at horizon (dir.y = 0), 1 at zenith (dir.y = 1).
  // Use a slightly compressed curve so the transition looks natural.
  float t = clamp(dir.y * 1.8, 0.0, 1.0);
  float tc = t * t * (3.0 - 2.0 * t); // smoothstep-like S-curve
  vec3 skyColor = mix(uHorizon, uZenith, tc);

  // --- Sun disc + glow ---
  float cosAngle = dot(dir, uSunDir);
  // Inner disc: full brightness within ~0.5 deg half-angle  (cos threshold ~0.9999)
  float disc     = smoothstep(0.9996, 0.9999, cosAngle);
  // Soft inner halo: falloff from ~0.5 deg to ~4 deg
  float halo     = smoothstep(0.993,  0.9996, cosAngle) * (1.0 - disc);
  // Outer atmospheric glow: very wide falloff (~4 to ~25 deg)
  float glow     = pow(max(cosAngle, 0.0), 6.0) * (1.0 - disc - halo);

  vec3 sunContrib = uSunColor * (disc + halo * 0.55) + uGlowColor * glow * 0.35;

  // Clamp sun contribution to zero below the horizon so it doesn't light the
  // lower hemisphere (the sun is above horizon for the dust2 sun position).
  float aboveHorizon = clamp(dir.y * 10.0, 0.0, 1.0);
  sunContrib *= aboveHorizon;

  gl_FragColor = vec4(skyColor + sunContrib, 1.0);
}
`;

// Precomputed normalised sun direction (matches DirectionalLight position below).
// sun.position = (40, 70, 30), |v| = sqrt(1600 + 4900 + 900) = sqrt(7400) ≈ 86.02
// MUST stay in sync with the DirectionalLight.position (40, 70, 30) set in
// setupEnvironment — if that vector changes, update these three constants so the
// painted sun disc keeps matching the shadow-casting light direction.
const _sunLen = Math.sqrt(40 * 40 + 70 * 70 + 30 * 30);
const SUN_DIR_X = 40 / _sunLen;
const SUN_DIR_Y = 70 / _sunLen;
const SUN_DIR_Z = 30 / _sunLen;

export function setupEnvironment(scene: THREE.Scene): void {
  // Graceful fallback background colour (horizon haze) — shown if the skydome
  // shader ever fails to compile or is not yet rendered.
  scene.background = new THREE.Color(0xcfc1a0);
  scene.fog = new THREE.Fog(0xcfc1a0, 60, 160);

  // --- Skydome ---
  // Radius 270 m = 0.9 × camera far (300). Static, origin-centred.
  // BackSide + depthWrite:false + frustumCulled:false so it always renders.
  const skyGeo = new THREE.SphereGeometry(270, 32, 16);
  const skyMat = new THREE.ShaderMaterial({
    vertexShader:   SKY_VERT,
    fragmentShader: SKY_FRAG,
    uniforms: {
      uZenith:   { value: new THREE.Color(0x5a8fc8) },
      uHorizon:  { value: new THREE.Color(0xcfc1a0) },
      uSunDir:   { value: new THREE.Vector3(SUN_DIR_X, SUN_DIR_Y, SUN_DIR_Z) },
      uSunColor: { value: new THREE.Color(2.8, 2.6, 2.0) },  // HDR warm white — blooms
      uGlowColor:{ value: new THREE.Color(1.2, 1.0, 0.6) },  // warm golden glow
    },
    side:        THREE.BackSide,
    depthWrite:  false,
    fog:         false,
  });
  const skyDome = new THREE.Mesh(skyGeo, skyMat);
  skyDome.frustumCulled = false;
  // Draw the dome first; with depthWrite:false + default LessEqualDepth either
  // order already works, this just makes draw order deterministic and robust
  // against any future depthFunc change.
  skyDome.renderOrder    = -1;
  skyDome.castShadow    = false;
  skyDome.receiveShadow = false;
  scene.add(skyDome);

  // --- Lights ---
  const hemi = new THREE.HemisphereLight(0xbdd7f0, 0x8a7a5a, 0.9);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff1d6, 1.4);
  sun.position.set(40, 70, 30);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.width  = 2048;
  sun.shadow.mapSize.height = 2048;
  // Shadow camera tightly covers playable map bounds: x −48..48, z −44..44,
  // plus 4 m margin and up to ~10 m height. Map origin x −48 z −44, size 96×88 m.
  // Before: left/right ±60, top/bottom ±60 (generic 120×120 m box).
  // After:  left/right ±52, top/bottom ±48 (~4 m margin; saves ~25% shadow texel area).
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far  = 160;
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left   = -52;
  sc.right  =  52;
  sc.top    =  52;
  sc.bottom = -52;
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  scene.add(sun.target);
}
