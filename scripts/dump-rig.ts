#!/usr/bin/env bun
/**
 * dump-rig.ts — Skeletal rest-pose + mesh bounding-box inspector for GLB/glTF assets.
 * Usage: bun scripts/dump-rig.ts <file.glb|file.gltf>
 *
 * Output (human-readable, 4-decimal float precision, deterministic):
 *   - Full node tree with index, name, parent index, local TRS
 *   - FK world rest positions for every joint + every mesh node
 *   - Per-mesh and whole-scene world-space AABBs
 *
 * Handles: .glb (binary), .gltf + embedded base64 data: URI buffer.
 * Does NOT need an external HTTP client or Three.js — pure Buffer math only.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, extname, dirname, join } from "path";

// ---------------------------------------------------------------------------
// glTF 2.0 types (minimal but complete enough for TRS + accessors)
// ---------------------------------------------------------------------------

interface GltfNode {
  name?: string;
  children?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number]; // xyzw
  scale?: [number, number, number];
  matrix?: number[]; // col-major 4x4
  mesh?: number;
  skin?: number;
}

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number; // 5126 = FLOAT
  count: number;
  type: string; // "VEC3" etc.
  min?: number[];
  max?: number[];
}

interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
}

interface GltfBuffer {
  byteLength: number;
  uri?: string;
}

interface GltfMeshPrimitive {
  attributes: Record<string, number>;
}

interface GltfMesh {
  name?: string;
  primitives: GltfMeshPrimitive[];
}

interface GltfSkin {
  name?: string;
  joints: number[];
  skeleton?: number;
}

interface GltfScene {
  name?: string;
  nodes?: number[];
}

interface GltfDoc {
  asset?: { version?: string; generator?: string };
  scene?: number;
  scenes?: GltfScene[];
  nodes?: GltfNode[];
  meshes?: GltfMesh[];
  skins?: GltfSkin[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: GltfBuffer[];
}

// ---------------------------------------------------------------------------
// 4×4 column-major matrix type (matches glTF convention)
// Stored as flat 16-element array: m[col*4 + row]
// ---------------------------------------------------------------------------
type Mat4 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

function mat4Identity(): Mat4 {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
}

/** Compose M = T * R * S as a 4×4 column-major matrix. */
function mat4FromTRS(
  t: [number, number, number],
  q: [number, number, number, number], // xyzw
  s: [number, number, number],
): Mat4 {
  const [qx, qy, qz, qw] = q;
  const [sx, sy, sz] = s;

  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;

  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}

/** Multiply two column-major 4×4 matrices: A * B */
function mat4Mul(a: Mat4, b: Mat4): Mat4 {
  const out: number[] = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row] * b[col * 4 + k];
      }
      out[col * 4 + row] = sum;
    }
  }
  return out as Mat4;
}

/** Transform a point [x,y,z] by a column-major 4×4 matrix (w=1). */
function mat4TransformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  const wInv = w !== 0 ? 1 / w : 1;
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) * wInv,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) * wInv,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) * wInv,
  ];
}

/** Extract translation from a column-major 4×4 matrix. */
function mat4Translation(m: Mat4): [number, number, number] {
  return [m[12], m[13], m[14]];
}

/**
 * Decompose a glTF column-major 4×4 matrix into TRS.
 * glTF spec: matrix = T * R * S, column-major.
 * We extract T from column 3, S from column lengths, R from normalized rotation.
 */
function decomposeMatrix(m: number[]): {
  t: [number, number, number];
  q: [number, number, number, number];
  s: [number, number, number];
} {
  const tx = m[12] ?? 0, ty = m[13] ?? 0, tz = m[14] ?? 0;

  const c0x = m[0] ?? 0, c0y = m[1] ?? 0, c0z = m[2] ?? 0;
  const c1x = m[4] ?? 0, c1y = m[5] ?? 0, c1z = m[6] ?? 0;
  const c2x = m[8] ?? 0, c2y = m[9] ?? 0, c2z = m[10] ?? 0;

  const sx = Math.sqrt(c0x * c0x + c0y * c0y + c0z * c0z);
  const sy = Math.sqrt(c1x * c1x + c1y * c1y + c1z * c1z);
  const sz = Math.sqrt(c2x * c2x + c2y * c2y + c2z * c2z);

  const sxInv = sx !== 0 ? 1 / sx : 1;
  const syInv = sy !== 0 ? 1 / sy : 1;
  const szInv = sz !== 0 ? 1 / sz : 1;

  // Build pure rotation matrix (3×3, col-major)
  const r = [
    c0x * sxInv, c0y * sxInv, c0z * sxInv,
    c1x * syInv, c1y * syInv, c1z * syInv,
    c2x * szInv, c2y * szInv, c2z * szInv,
  ];

  // Rotation matrix to quaternion (Shepperd's method)
  const trace = (r[0] ?? 0) + (r[4] ?? 0) + (r[8] ?? 0);
  let qx: number, qy: number, qz: number, qw: number;

  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    qw = 0.25 / s;
    qx = ((r[7] ?? 0) - (r[5] ?? 0)) * s;
    qy = ((r[2] ?? 0) - (r[6] ?? 0)) * s;
    qz = ((r[3] ?? 0) - (r[1] ?? 0)) * s;
  } else if ((r[0] ?? 0) > (r[4] ?? 0) && (r[0] ?? 0) > (r[8] ?? 0)) {
    const s = 2 * Math.sqrt(1 + (r[0] ?? 0) - (r[4] ?? 0) - (r[8] ?? 0));
    qw = ((r[7] ?? 0) - (r[5] ?? 0)) / s;
    qx = 0.25 * s;
    qy = ((r[1] ?? 0) + (r[3] ?? 0)) / s;
    qz = ((r[2] ?? 0) + (r[6] ?? 0)) / s;
  } else if ((r[4] ?? 0) > (r[8] ?? 0)) {
    const s = 2 * Math.sqrt(1 + (r[4] ?? 0) - (r[0] ?? 0) - (r[8] ?? 0));
    qw = ((r[2] ?? 0) - (r[6] ?? 0)) / s;
    qx = ((r[1] ?? 0) + (r[3] ?? 0)) / s;
    qy = 0.25 * s;
    qz = ((r[5] ?? 0) + (r[7] ?? 0)) / s;
  } else {
    const s = 2 * Math.sqrt(1 + (r[8] ?? 0) - (r[0] ?? 0) - (r[4] ?? 0));
    qw = ((r[3] ?? 0) - (r[1] ?? 0)) / s;
    qx = ((r[2] ?? 0) + (r[6] ?? 0)) / s;
    qy = ((r[5] ?? 0) + (r[7] ?? 0)) / s;
    qz = 0.25 * s;
  }

  return {
    t: [tx, ty, tz],
    q: [qx, qy, qz, qw],
    s: [sx, sy, sz],
  };
}

// ---------------------------------------------------------------------------
// GLB / glTF parsing
// ---------------------------------------------------------------------------

interface ParsedAsset {
  gltf: GltfDoc;
  /** Resolved binary buffer (chunk 1 of GLB, or decoded base64, or file). */
  binaryBuffer: Buffer | null;
  baseDir: string;
}

function parseGlb(data: Buffer, filePath: string): ParsedAsset {
  const magic = data.readUInt32LE(0);
  if (magic !== 0x46546c67) {
    throw new Error(`Not a GLB (magic 0x${magic.toString(16).padStart(8, "0")})`);
  }
  const chunk0Len = data.readUInt32LE(12);
  const chunk0Type = data.readUInt32LE(16);
  if (chunk0Type !== 0x4e4f534a) {
    throw new Error(`GLB chunk0 not JSON (type 0x${chunk0Type.toString(16)})`);
  }
  const jsonStr = data.toString("utf8", 20, 20 + chunk0Len);
  const gltf = JSON.parse(jsonStr) as GltfDoc;

  // Optional chunk 1 (BIN)
  let binaryBuffer: Buffer | null = null;
  const c1Off = 20 + chunk0Len;
  if (c1Off + 8 <= data.length) {
    const c1Len = data.readUInt32LE(c1Off);
    const c1Type = data.readUInt32LE(c1Off + 4);
    if (c1Type === 0x004e4942) {
      binaryBuffer = data.subarray(c1Off + 8, c1Off + 8 + c1Len) as Buffer;
    }
  }

  return { gltf, binaryBuffer, baseDir: dirname(resolve(filePath)) };
}

function parseGltfJson(data: Buffer, filePath: string): ParsedAsset {
  const gltf = JSON.parse(data.toString("utf8")) as GltfDoc;
  return { gltf, binaryBuffer: null, baseDir: dirname(resolve(filePath)) };
}

/**
 * Resolve buffer data for a given buffer index.
 * Handles: GLB embedded (chunk1), data: URI base64, external .bin file.
 */
function resolveBuffer(asset: ParsedAsset, bufIdx: number): Buffer {
  const buf = asset.gltf.buffers?.[bufIdx];
  if (!buf) throw new Error(`Buffer index ${bufIdx} not found`);

  if (!buf.uri) {
    // GLB embedded buffer
    if (!asset.binaryBuffer) throw new Error("No binary buffer in GLB for uri-less buffer");
    return asset.binaryBuffer;
  }

  if (buf.uri.startsWith("data:")) {
    // data: URI — find the base64 part after the comma
    const comma = buf.uri.indexOf(",");
    if (comma < 0) throw new Error("Malformed data URI — no comma");
    const b64 = buf.uri.slice(comma + 1);
    return Buffer.from(b64, "base64");
  }

  // External file
  const externalPath = join(asset.baseDir, buf.uri);
  if (!existsSync(externalPath)) {
    throw new Error(`External buffer file not found: ${externalPath}`);
  }
  return readFileSync(externalPath);
}

// ---------------------------------------------------------------------------
// Utility: format numbers
// ---------------------------------------------------------------------------
function f4(v: number): string {
  return v.toFixed(4);
}

function fmtVec3(v: [number, number, number]): string {
  return `[${f4(v[0])}, ${f4(v[1])}, ${f4(v[2])}]`;
}

function fmtQuat(q: [number, number, number, number]): string {
  return `[${f4(q[0])}, ${f4(q[1])}, ${f4(q[2])}, ${f4(q[3])}]`;
}

function dist3(a: [number, number, number], b: [number, number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ---------------------------------------------------------------------------
// Build local TRS matrix for a node
// ---------------------------------------------------------------------------
function nodeLocalMatrix(node: GltfNode): Mat4 {
  if (node.matrix && node.matrix.length === 16) {
    const { t, q, s } = decomposeMatrix(node.matrix);
    return mat4FromTRS(t, q, s);
  }
  const t: [number, number, number] = node.translation ?? [0, 0, 0];
  const q: [number, number, number, number] = node.rotation ?? [0, 0, 0, 1];
  const s: [number, number, number] = node.scale ?? [1, 1, 1];
  return mat4FromTRS(t, q, s);
}

// ---------------------------------------------------------------------------
// Compute world matrices via DFS from scene roots
// ---------------------------------------------------------------------------
function computeWorldMatrices(gltf: GltfDoc): Map<number, Mat4> {
  const nodes = gltf.nodes ?? [];
  const worldMats = new Map<number, Mat4>();

  function visit(nodeIdx: number, parentWorld: Mat4): void {
    const node = nodes[nodeIdx];
    if (!node) return;
    const local = nodeLocalMatrix(node);
    const world = mat4Mul(parentWorld, local);
    worldMats.set(nodeIdx, world);
    for (const child of node.children ?? []) {
      visit(child, world);
    }
  }

  // Find scene roots
  const sceneIdx = gltf.scene ?? 0;
  const scene = gltf.scenes?.[sceneIdx];
  const roots = scene?.nodes ?? [];

  // Also find any top-level nodes not reachable via scene (defensive)
  const reachable = new Set<number>();
  function markReachable(idx: number): void {
    if (reachable.has(idx)) return;
    reachable.add(idx);
    for (const child of nodes[idx]?.children ?? []) markReachable(child);
  }

  const identity = mat4Identity();
  for (const root of roots) {
    markReachable(root);
    visit(root, identity);
  }

  // Orphan nodes (not in any scene) get identity world (shouldn't happen in valid glTF)
  for (let i = 0; i < nodes.length; i++) {
    if (!reachable.has(i) && !worldMats.has(i)) {
      worldMats.set(i, identity);
    }
  }

  return worldMats;
}

// ---------------------------------------------------------------------------
// Build parent map
// ---------------------------------------------------------------------------
function buildParentMap(gltf: GltfDoc): Map<number, number> {
  const parentOf = new Map<number, number>();
  const nodes = gltf.nodes ?? [];
  for (let i = 0; i < nodes.length; i++) {
    for (const child of nodes[i]?.children ?? []) {
      parentOf.set(child, i);
    }
  }
  return parentOf;
}

// ---------------------------------------------------------------------------
// AABB helpers
// ---------------------------------------------------------------------------
interface Aabb {
  min: [number, number, number];
  max: [number, number, number];
}

function aabbEmpty(): Aabb {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
}

function aabbAddPoint(aabb: Aabb, p: [number, number, number]): void {
  aabb.min[0] = Math.min(aabb.min[0], p[0]);
  aabb.min[1] = Math.min(aabb.min[1], p[1]);
  aabb.min[2] = Math.min(aabb.min[2], p[2]);
  aabb.max[0] = Math.max(aabb.max[0], p[0]);
  aabb.max[1] = Math.max(aabb.max[1], p[1]);
  aabb.max[2] = Math.max(aabb.max[2], p[2]);
}

function aabbUnion(a: Aabb, b: Aabb): Aabb {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

function aabbSize(a: Aabb): [number, number, number] {
  return [a.max[0] - a.min[0], a.max[1] - a.min[1], a.max[2] - a.min[2]];
}

function aabbCenter(a: Aabb): [number, number, number] {
  return [
    (a.min[0] + a.max[0]) * 0.5,
    (a.min[1] + a.max[1]) * 0.5,
    (a.min[2] + a.max[2]) * 0.5,
  ];
}

/**
 * Compute world-space AABB for a primitive by transforming its 8 local corners
 * (derived from POSITION accessor min/max) by the node's world matrix.
 */
function primWorldAabb(
  acc: GltfAccessor,
  worldMat: Mat4,
): Aabb | null {
  if (!acc.min || !acc.max || acc.min.length < 3 || acc.max.length < 3) return null;
  const lx0 = acc.min[0] ?? 0, ly0 = acc.min[1] ?? 0, lz0 = acc.min[2] ?? 0;
  const lx1 = acc.max[0] ?? 0, ly1 = acc.max[1] ?? 0, lz1 = acc.max[2] ?? 0;

  const corners: Array<[number, number, number]> = [
    [lx0, ly0, lz0], [lx1, ly0, lz0], [lx0, ly1, lz0], [lx1, ly1, lz0],
    [lx0, ly0, lz1], [lx1, ly0, lz1], [lx0, ly1, lz1], [lx1, ly1, lz1],
  ];

  const aabb = aabbEmpty();
  for (const c of corners) {
    aabbAddPoint(aabb, mat4TransformPoint(worldMat, c[0], c[1], c[2]));
  }
  return aabb;
}

// ---------------------------------------------------------------------------
// Main dump function
// ---------------------------------------------------------------------------
function dumpRig(filePath: string): void {
  const absPath = resolve(filePath);
  const ext = extname(absPath).toLowerCase();
  const data = readFileSync(absPath);

  let asset: ParsedAsset;
  if (ext === ".glb") {
    asset = parseGlb(data, absPath);
  } else if (ext === ".gltf") {
    asset = parseGltfJson(data, absPath);
  } else {
    throw new Error(`Unsupported extension '${ext}' — use .glb or .gltf`);
  }

  const { gltf } = asset;
  const nodes = gltf.nodes ?? [];
  const meshes = gltf.meshes ?? [];
  const accessors = gltf.accessors ?? [];
  const skins = gltf.skins ?? [];

  const parentMap = buildParentMap(gltf);
  const worldMats = computeWorldMatrices(gltf);

  // Build set of joint node indices
  const jointSet = new Set<number>();
  for (const skin of skins) {
    for (const j of skin.joints) jointSet.add(j);
  }

  // ---------------------------------------------------------------------------
  // Section 1: NODE TREE
  // ---------------------------------------------------------------------------
  console.log(`\n${"=".repeat(72)}`);
  console.log(`FILE: ${absPath}`);
  console.log("=".repeat(72));

  console.log(`\n--- NODE TREE (${nodes.length} nodes) ---`);
  console.log(
    "idx  name                             parent  local-T [x,y,z]               local-R [x,y,z,w]                     local-S [x,y,z]"
  );
  console.log("-".repeat(160));

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node) continue;

    let lt: [number, number, number];
    let lq: [number, number, number, number];
    let ls: [number, number, number];

    if (node.matrix && node.matrix.length === 16) {
      const { t, q, s } = decomposeMatrix(node.matrix);
      lt = t; lq = q; ls = s;
    } else {
      lt = node.translation ?? [0, 0, 0];
      lq = node.rotation ?? [0, 0, 0, 1];
      ls = node.scale ?? [1, 1, 1];
    }

    const parentIdx = parentMap.get(i) ?? -1;
    const parentName = parentIdx >= 0 ? (nodes[parentIdx]?.name ?? `node_${parentIdx}`) : "(root)";
    const name = node.name ?? `node_${i}`;
    const flags: string[] = [];
    if (node.mesh !== undefined) flags.push(`mesh:${node.mesh}`);
    if (node.skin !== undefined) flags.push(`skin:${node.skin}`);
    if (jointSet.has(i)) flags.push("JOINT");

    const flagStr = flags.length > 0 ? `  [${flags.join(" ")}]` : "";

    console.log(
      `${String(i).padStart(3)}  ${name.padEnd(32)} ${String(parentIdx).padStart(3)} ${parentName.padEnd(28)}  T:${fmtVec3(lt).padEnd(32)} R:${fmtQuat(lq).padEnd(40)} S:${fmtVec3(ls)}${flagStr}`
    );
  }

  // ---------------------------------------------------------------------------
  // Section 2: FK WORLD REST POSITIONS
  // ---------------------------------------------------------------------------
  console.log(`\n--- FK WORLD REST POSITIONS (joints + mesh nodes) ---`);
  console.log("idx  name                             world-pos [x,y,z]");
  console.log("-".repeat(80));

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node) continue;
    const isMeshNode = node.mesh !== undefined;
    if (!jointSet.has(i) && !isMeshNode) continue;

    const wm = worldMats.get(i);
    if (!wm) continue;
    const wp = mat4Translation(wm);
    const name = node.name ?? `node_${i}`;
    const tag = isMeshNode ? " [MESH]" : "";
    console.log(`${String(i).padStart(3)}  ${name.padEnd(32)} ${fmtVec3(wp)}${tag}`);
  }

  // ---------------------------------------------------------------------------
  // Section 3: MESH BOUNDING BOXES
  // ---------------------------------------------------------------------------
  console.log(`\n--- MESH BOUNDING BOXES (world-space) ---`);

  let sceneBbox = aabbEmpty();

  for (let ni = 0; ni < nodes.length; ni++) {
    const node = nodes[ni];
    if (!node || node.mesh === undefined) continue;

    const mesh = meshes[node.mesh];
    if (!mesh) continue;

    const wm = worldMats.get(ni) ?? mat4Identity();
    let meshBbox = aabbEmpty();
    let hasBbox = false;

    for (const prim of mesh.primitives) {
      const posAccIdx = prim.attributes["POSITION"];
      if (posAccIdx === undefined) continue;
      const acc = accessors[posAccIdx];
      if (!acc) continue;

      const aabb = primWorldAabb(acc, wm);
      if (!aabb) continue;

      meshBbox = hasBbox ? aabbUnion(meshBbox, aabb) : aabb;
      hasBbox = true;
    }

    if (!hasBbox) continue;

    const meshName = mesh.name ?? (node.name ?? `mesh_${node.mesh}`);
    const size = aabbSize(meshBbox);
    const center = aabbCenter(meshBbox);
    const axes = ["X", "Y", "Z"];
    const longestAxis = axes[size.indexOf(Math.max(...size))] ?? "?";

    console.log(`\n  mesh: "${meshName}" (node ${ni}: "${node.name ?? `node_${ni}`}")`);
    console.log(`    min:    ${fmtVec3(meshBbox.min)}`);
    console.log(`    max:    ${fmtVec3(meshBbox.max)}`);
    console.log(`    size:   ${fmtVec3(size)}  (longest: ${longestAxis})`);
    console.log(`    center: ${fmtVec3(center)}`);

    sceneBbox = hasBbox ? aabbUnion(sceneBbox, meshBbox) : meshBbox;
  }

  // ---------------------------------------------------------------------------
  // Section 4: SCENE BBOX
  // ---------------------------------------------------------------------------
  const sceneIsEmpty =
    sceneBbox.min[0] === Infinity || sceneBbox.max[0] === -Infinity;

  console.log(`\n--- SCENE BBOX (world-space, all mesh nodes unioned) ---`);
  if (sceneIsEmpty) {
    console.log("  (no meshes found)");
  } else {
    const size = aabbSize(sceneBbox);
    const center = aabbCenter(sceneBbox);
    const axes = ["X", "Y", "Z"];
    const longestAxis = axes[size.indexOf(Math.max(...size))] ?? "?";
    console.log(`  min:    ${fmtVec3(sceneBbox.min)}`);
    console.log(`  max:    ${fmtVec3(sceneBbox.max)}`);
    console.log(`  size:   ${fmtVec3(size)}  (longest: ${longestAxis})`);
    console.log(`  center: ${fmtVec3(center)}`);
  }

  // ---------------------------------------------------------------------------
  // Section 5: SKINS SUMMARY
  // ---------------------------------------------------------------------------
  console.log(`\n--- SKINS (${skins.length} skin(s)) ---`);
  for (let si = 0; si < skins.length; si++) {
    const skin = skins[si];
    if (!skin) continue;
    console.log(`  skin ${si}: "${skin.name ?? "unnamed"}"  joints: ${skin.joints.length}  skeleton root: ${skin.skeleton ?? "(none)"}`);
    const jNames = skin.joints.map((j) => nodes[j]?.name ?? `node_${j}`);
    console.log(`  joints: [${jNames.join(", ")}]`);
  }

  console.log();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: bun scripts/dump-rig.ts <file.glb|file.gltf>");
  process.exit(1);
}

for (const arg of args) {
  try {
    dumpRig(arg);
  } catch (err) {
    console.error(`[ERROR] ${arg}: ${(err as Error).message}`);
    process.exit(1);
  }
}
