#!/usr/bin/env bun
/**
 * inspect-glb.ts — Parse GLB/GLTF containers and print structure info.
 * Usage: bun scripts/inspect-glb.ts <file-or-glob...>
 * Output per file: size, mesh count, skin/bone names, animation clip names + track targets, material count.
 * No new npm deps — uses only Bun built-ins and the fs module.
 */

import { readFileSync, statSync, readdirSync } from "fs";
import { resolve, extname, basename } from "path";

// ---------------------------------------------------------------------------
// Types (minimal subset of glTF 2.0 spec)
// ---------------------------------------------------------------------------
interface GltfAsset {
  asset?: { version?: string; generator?: string };
  meshes?: Array<{ name?: string; primitives?: unknown[] }>;
  skins?: Array<{ name?: string; joints?: number[]; skeleton?: number }>;
  nodes?: Array<{ name?: string; children?: number[] }>;
  animations?: Array<{
    name?: string;
    channels?: Array<{ target?: { node?: number; path?: string } }>;
    samplers?: unknown[];
  }>;
  materials?: unknown[];
  textures?: unknown[];
  buffers?: Array<{ byteLength?: number; uri?: string }>;
  extensionsUsed?: string[];
}

// ---------------------------------------------------------------------------
// GLB parsing — extract the JSON chunk (chunk type 0x4E4F534A = "JSON")
// ---------------------------------------------------------------------------
function parseGlb(data: Buffer): GltfAsset {
  const magic = data.readUInt32LE(0);
  if (magic !== 0x46546c67) {
    throw new Error(`Not a GLB file (magic 0x${magic.toString(16).padStart(8, "0")})`);
  }
  // const version = data.readUInt32LE(4); // unused
  // const totalLength = data.readUInt32LE(8); // unused
  const chunkLength = data.readUInt32LE(12);
  const chunkType = data.readUInt32LE(16);
  if (chunkType !== 0x4e4f534a) {
    throw new Error(`First chunk is not JSON (type 0x${chunkType.toString(16)})`);
  }
  const jsonStr = data.toString("utf8", 20, 20 + chunkLength);
  return JSON.parse(jsonStr) as GltfAsset;
}

// ---------------------------------------------------------------------------
// GLTF parsing (JSON text file, possibly with base64 embedded buffers)
// ---------------------------------------------------------------------------
function parseGltfJson(data: Buffer): GltfAsset {
  const text = data.toString("utf8");
  const firstChar = text.trimStart()[0];
  if (firstChar !== "{") {
    throw new Error(`Not a JSON GLTF file (starts with '${firstChar}')`);
  }
  return JSON.parse(text) as GltfAsset;
}

// ---------------------------------------------------------------------------
// Main inspection logic
// ---------------------------------------------------------------------------
function inspect(filePath: string): void {
  const absPath = resolve(filePath);
  const stats = statSync(absPath);
  const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
  const ext = extname(absPath).toLowerCase();
  const name = basename(absPath);

  let gltf: GltfAsset;
  const data = readFileSync(absPath);

  try {
    if (ext === ".glb") {
      gltf = parseGlb(data);
    } else if (ext === ".gltf") {
      gltf = parseGltfJson(data);
    } else {
      console.log(`[SKIP] ${name} — unsupported extension '${ext}'`);
      return;
    }
  } catch (err) {
    console.log(`[ERROR] ${name}: ${(err as Error).message}`);
    return;
  }

  // ---- Meshes ----
  const meshCount = gltf.meshes?.length ?? 0;

  // ---- Skins / bones ----
  const skins = gltf.skins ?? [];
  const nodes = gltf.nodes ?? [];
  const skinLines: string[] = [];
  for (const skin of skins) {
    const boneNames = (skin.joints ?? []).map((i) => nodes[i]?.name ?? `node_${i}`);
    skinLines.push(
      `  skin "${skin.name ?? "unnamed"}" — ${boneNames.length} joints: [${boneNames.join(", ")}]`
    );
  }

  // ---- Animations ----
  const animations = gltf.animations ?? [];
  const animLines: string[] = [];
  for (const anim of animations) {
    const trackTargets = (anim.channels ?? []).map((ch) => {
      const nodeName = ch.target?.node !== undefined ? (nodes[ch.target.node]?.name ?? `node_${ch.target.node}`) : "?";
      return `${nodeName}/${ch.target?.path ?? "?"}`;
    });
    // Deduplicate target node names (ignore path for bone-name matching)
    const targetNodes = [...new Set((anim.channels ?? []).map((ch) => {
      const idx = ch.target?.node;
      return idx !== undefined ? (nodes[idx]?.name ?? `node_${idx}`) : "?";
    }))];
    animLines.push(
      `  clip "${anim.name ?? "unnamed"}" — ${(anim.channels ?? []).length} channels; targets: [${targetNodes.join(", ")}]`
    );
  }

  // ---- Materials / textures ----
  const matCount = gltf.materials?.length ?? 0;
  const texCount = gltf.textures?.length ?? 0;

  // ---- Print report ----
  console.log(`\n=== ${name} ===`);
  console.log(`  size: ${sizeMB} MB (${stats.size} bytes)`);
  console.log(`  meshes: ${meshCount}`);
  console.log(`  skins: ${skins.length}`);
  if (skinLines.length > 0) {
    skinLines.forEach((l) => console.log(l));
  }
  console.log(`  animations: ${animations.length}`);
  if (animLines.length > 0) {
    // For brevity, show first 40 clips (characters can have 24+)
    animLines.slice(0, 40).forEach((l) => console.log(l));
    if (animLines.length > 40) {
      console.log(`  ... (${animLines.length - 40} more clips)`);
    }
  }
  console.log(`  materials: ${matCount}  textures: ${texCount}`);
}

// ---------------------------------------------------------------------------
// Entry point — accept file paths or glob-like directory
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: bun scripts/inspect-glb.ts <file.glb|file.gltf|directory> ...");
  process.exit(1);
}

for (const arg of args) {
  const absArg = resolve(arg);
  let isDir = false;
  try {
    isDir = statSync(absArg).isDirectory();
  } catch {
    // not a dir or doesn't exist
  }

  if (isDir) {
    const files = readdirSync(absArg)
      .filter((f) => f.endsWith(".glb") || f.endsWith(".gltf"))
      .sort();
    for (const f of files) {
      inspect(`${absArg}/${f}`);
    }
  } else {
    inspect(absArg);
  }
}
