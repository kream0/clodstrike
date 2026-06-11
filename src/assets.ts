/**
 * Asset loader module — CC0 texture and GLB pipeline foundation.
 *
 * Rules:
 *  - Library module: may import 'three' and GLTFLoader; NO game-logic imports.
 *  - NO `any`. Strict TypeScript, noUncheckedIndexedAccess.
 *  - Does NOT read clock, game state, or DOM beyond document.baseURI.
 */

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

// ---------------------------------------------------------------------------
// Texture slot registry
// ---------------------------------------------------------------------------

export type TextureSlot =
  | 'ground_sand'
  | 'wall_sandstone'
  | 'wall_plaster'
  | 'floor_stone'
  | 'concrete'
  | 'wood'
  | 'metal'
  | 'fabric';

export const TEXTURE_SLOTS: readonly TextureSlot[] = [
  'ground_sand',
  'wall_sandstone',
  'wall_plaster',
  'floor_stone',
  'concrete',
  'wood',
  'metal',
  'fabric',
] as const;

// ---------------------------------------------------------------------------
// URL resolution — subpath-safe for GH Pages (/clodstrike/) and localhost
// ---------------------------------------------------------------------------

/**
 * Resolve a path relative to the asset root into an absolute URL.
 *
 * @param relPath - path relative to `assets/`, e.g. `'textures/ground_sand.jpg'`
 * @param base    - explicit base URL; defaults to `document.baseURI` (omit in
 *                  browser; pass explicitly in tests where `document` is undefined)
 *
 * The function joins `assets/<relPath>` onto `base` using the URL constructor so
 * the GH Pages subpath (`/clodstrike/`) is always respected.
 */
export function assetUrl(relPath: string, base?: string): string {
  const resolvedBase =
    base ?? (typeof document !== 'undefined' ? document.baseURI : 'http://localhost:3000/');
  // Ensure base ends with a slash so relative segments join correctly
  const normalizedBase = resolvedBase.endsWith('/') ? resolvedBase : resolvedBase + '/';
  return new URL('assets/' + relPath, normalizedBase).href;
}

// ---------------------------------------------------------------------------
// Color texture loading
// ---------------------------------------------------------------------------

export type LoadedTextures = {
  readonly [K in TextureSlot]: THREE.Texture;
};

/**
 * Load all 8 color textures in parallel.
 * Each texture is configured for sRGB color space and repeat wrapping.
 * Rejects with a descriptive Error naming the failing slot/URL.
 */
export async function loadAllTextures(
  onProgress?: (loaded: number, total: number) => void,
): Promise<LoadedTextures> {
  const loader = new THREE.TextureLoader();
  const total = TEXTURE_SLOTS.length;
  let loaded = 0;

  const pairs = await Promise.all(
    TEXTURE_SLOTS.map(async (slot) => {
      const url = assetUrl(`textures/${slot}.jpg`);
      let tex: THREE.Texture;
      try {
        tex = await loader.loadAsync(url);
      } catch (err) {
        throw new Error(
          `[assets] Failed to load texture slot "${slot}" from "${url}": ${String(err)}`,
        );
      }
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      loaded += 1;
      onProgress?.(loaded, total);
      return [slot, tex] as const;
    }),
  );

  return Object.fromEntries(pairs) as LoadedTextures;
}

// ---------------------------------------------------------------------------
// Normal texture loading (OpenGL convention, linear color space)
// ---------------------------------------------------------------------------

/**
 * Load all available normal maps in parallel.
 * Returns a Partial record — callers must guard for missing slots.
 * Each normal map uses NoColorSpace (raw data, no color management — correct for normal/data textures) and repeat wrapping.
 */
export async function loadAllNormalTextures(
  onProgress?: (loaded: number, total: number) => void,
): Promise<Partial<Record<TextureSlot, THREE.Texture>>> {
  const loader = new THREE.TextureLoader();
  const total = TEXTURE_SLOTS.length;
  let loaded = 0;

  const results: Partial<Record<TextureSlot, THREE.Texture>> = {};

  await Promise.all(
    TEXTURE_SLOTS.map(async (slot) => {
      const url = assetUrl(`textures/${slot}_normal.jpg`);
      try {
        const tex = await loader.loadAsync(url);
        tex.colorSpace = THREE.NoColorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        results[slot] = tex;
      } catch {
        // Normal maps are optional — log and continue
        console.warn(`[assets] Normal map not found for slot "${slot}", skipping.`);
      }
      loaded += 1;
      onProgress?.(loaded, total);
    }),
  );

  return results;
}

// ---------------------------------------------------------------------------
// GLB model loading
// ---------------------------------------------------------------------------

/**
 * Thin wrapper around GLTFLoader for upcoming model cycles.
 * @param relPath - path relative to `assets/`, e.g. `'models/weapon_ak47.glb'`
 */
export async function loadGLB(relPath: string): Promise<GLTF> {
  const loader = new GLTFLoader();
  const url = assetUrl(relPath);
  try {
    return await loader.loadAsync(url);
  } catch (err) {
    throw new Error(
      `[assets] Failed to load GLB "${relPath}" from "${url}": ${String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Dispose all textures in a LoadedTextures record to free GPU memory.
 */
export function disposeTextures(t: LoadedTextures): void {
  for (const slot of TEXTURE_SLOTS) {
    t[slot].dispose();
  }
}
