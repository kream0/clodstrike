/**
 * Map registry — single source of truth for all available maps.
 * Import this instead of individual map files when you need to enumerate maps.
 *
 * Library module: NEVER import game.ts or main.ts from here.
 */
import type { MapData } from '../types';
import { DUST2 } from './dust2';
import { MIRAGE } from './mirage';

/** All available maps keyed by their internal id. */
export const MAPS: Record<string, MapData> = {
  dust2:  DUST2,
  mirage: MIRAGE,
};

/** Human-readable display names for each map id. */
export const MAP_DISPLAY_NAMES: Record<string, string> = {
  dust2:  'Dust2',
  mirage: 'Mirage',
};

/** The default map id — used when no selection has been made. */
export const DEFAULT_MAP_ID = 'dust2';

/**
 * Resolve a map id to its MapData, falling back to the default when the id is
 * unknown. This is the canonical lookup used everywhere map selection flows.
 */
export function resolveMap(mapId: string): MapData {
  return MAPS[mapId] ?? MAPS[DEFAULT_MAP_ID] ?? DUST2;
}
