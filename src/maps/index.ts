/**
 * Map registry — single source of truth for all available maps.
 * Import this instead of individual map files when you need to enumerate maps.
 *
 * Library module: NEVER import game.ts or main.ts from here.
 */
import type { MapData } from '../types';
import { DUST2 } from './dust2';
import { MIRAGE } from './mirage';

// ---------------------------------------------------------------------------
// Internal mutable registry (built-ins are seeded at module load).
// Exported objects are the same references — mutations are visible to importers.
// ---------------------------------------------------------------------------

const _MAPS: Record<string, MapData> = {
  dust2:  DUST2,
  mirage: MIRAGE,
};

const _MAP_DISPLAY_NAMES: Record<string, string> = {
  dust2:  'Dust2',
  mirage: 'Mirage',
};

// Built-in ids — immutable sentinel set; registerSessionMap never overrides them.
const _BUILTIN_IDS = new Set<string>(['dust2', 'mirage']);

/** All available maps keyed by their internal id (includes session maps). */
export const MAPS: Record<string, MapData> = _MAPS;

/** Human-readable display names for each map id (includes session maps). */
export const MAP_DISPLAY_NAMES: Record<string, string> = _MAP_DISPLAY_NAMES;

/** The default map id — used when no selection has been made. */
export const DEFAULT_MAP_ID = 'dust2';

/**
 * Resolve a map id to its MapData, falling back to the default when the id is
 * unknown. This is the canonical lookup used everywhere map selection flows.
 */
export function resolveMap(mapId: string): MapData {
  return _MAPS[mapId] ?? _MAPS[DEFAULT_MAP_ID] ?? DUST2;
}

/**
 * Register a custom (session-only) map into the live registry.
 *
 * - Never overwrites built-in maps (dust2, mirage).
 * - If the desired id collides with an existing session entry, a numeric
 *   suffix is appended until the id is unique (e.g. 'mymap', 'mymap-2').
 * - Returns the id that was actually used (may differ from the input id).
 * - Session maps do NOT persist across page reloads.
 */
export function registerSessionMap(
  id: string,
  map: MapData,
  displayName: string,
): string {
  // Slugify: lowercase, replace non-alphanumeric runs with '-', trim dashes.
  let slug = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'custom';

  // Protect built-ins.
  if (_BUILTIN_IDS.has(slug)) {
    slug = `session-${slug}`;
  }

  // Uniquify: if the slug already exists (session or built-in), append suffix.
  let finalId = slug;
  if (finalId in _MAPS) {
    let n = 2;
    while (`${slug}-${n}` in _MAPS) n++;
    finalId = `${slug}-${n}`;
  }

  _MAPS[finalId] = map;
  _MAP_DISPLAY_NAMES[finalId] = displayName;
  return finalId;
}
