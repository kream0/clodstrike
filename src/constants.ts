import type { Team, WeaponDef, GrenadeType } from './types';

// ---------------------------------------------------------------------------
// Recoil pattern data
//
// Format: ReadonlyArray of [pitchDeg, yawDeg] per shot (index = shotsFired-1).
// pitchDeg > 0 = upward kick. yawDeg > 0 = kick right (from shooter's perspective).
// Clamped to last entry when shotsFired exceeds pattern length.
// deagle and awp have no pattern — they use the legacy formula.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// moveSpeed scale inference:
//   knife = 4.76 m/s (CS2 ≈ 250 u/s)
//   usp/glock = 4.57 (≈ 240 u/s pistol class)
//   deagle = 4.38 (≈ 230 u/s)
//   m4a4 = 4.29 (≈ 225 u/s CT rifle)
//   ak47 = 4.10 (≈ 215 u/s T rifle)
//   awp = 3.81 (≈ 200 u/s sniper)
//   → Scale factor ≈ 4.76/250 = 0.01904 m/s per CS2 u/s unit
//   m249 195 u/s → 3.71; negev 200 → 3.81 same as awp
//   SMGs (220-240 u/s) → ~4.19-4.57; shotguns similar to rifles
// ---------------------------------------------------------------------------

/** AK-47: 30-entry "7"-shape — strong vertical climb, drift right then left then right. */
const AK47_PATTERN: ReadonlyArray<readonly [number, number]> = [
  // Shots 1-9: strong vertical climb
  [1.6,  0.0],
  [1.8,  0.1],
  [2.0,  0.2],
  [2.1,  0.3],
  [2.1,  0.4],
  [2.2,  0.5],
  [2.2,  0.6],
  [2.2,  0.7],
  [2.0,  0.8],
  // Shots 10-13: drift right (yaw > 0), reduced pitch
  [0.4,  1.0],
  [0.3,  1.1],
  [0.3,  1.2],
  [0.3,  0.9],
  // Shots 14-20: drift left (yaw < 0)
  [0.4, -0.9],
  [0.4, -1.1],
  [0.4, -1.2],
  [0.4, -1.3],
  [0.4, -1.2],
  [0.4, -1.1],
  [0.4, -0.9],
  // Shots 21-30: drift right again
  [0.4,  0.8],
  [0.4,  0.9],
  [0.4,  1.0],
  [0.4,  1.1],
  [0.4,  1.0],
  [0.4,  0.9],
  [0.4,  0.8],
  [0.4,  0.7],
  [0.4,  0.6],
  [0.4,  0.5],
] as const;

/** M4A4: 30-entry same-family as AK, ~75% magnitude, smoother weave. */
const M4A4_PATTERN: ReadonlyArray<readonly [number, number]> = [
  // Shots 1-9: vertical climb
  [1.2,  0.0],
  [1.3,  0.1],
  [1.5,  0.15],
  [1.6,  0.2],
  [1.6,  0.3],
  [1.65, 0.35],
  [1.65, 0.45],
  [1.65, 0.5],
  [1.5,  0.6],
  // Shots 10-13: drift right
  [0.3,  0.75],
  [0.25, 0.82],
  [0.25, 0.9],
  [0.25, 0.7],
  // Shots 14-20: drift left
  [0.3, -0.7],
  [0.3, -0.82],
  [0.3, -0.9],
  [0.3, -1.0],
  [0.3, -0.9],
  [0.3, -0.82],
  [0.3, -0.7],
  // Shots 21-30: drift right again
  [0.3,  0.6],
  [0.3,  0.7],
  [0.3,  0.75],
  [0.3,  0.82],
  [0.3,  0.75],
  [0.3,  0.7],
  [0.3,  0.6],
  [0.3,  0.5],
  [0.3,  0.45],
  [0.3,  0.4],
] as const;

/** Glock-18: 12-entry gentle climb, slight alternating yaw. */
const GLOCK_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [0.5,  0.0],
  [0.55, 0.1],
  [0.6,  0.15],
  [0.65, -0.1],
  [0.65, 0.2],
  [0.7,  -0.15],
  [0.7,  0.2],
  [0.65, -0.15],
  [0.65, 0.15],
  [0.6,  -0.1],
  [0.55, 0.1],
  [0.5,  -0.1],
] as const;

/** USP-S: 12-entry gentle climb, slight alternating yaw. */
const USP_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [0.5,  0.0],
  [0.55, 0.08],
  [0.6,  0.12],
  [0.62, -0.08],
  [0.63, 0.12],
  [0.65, -0.1],
  [0.65, 0.12],
  [0.62, -0.1],
  [0.6,  0.1],
  [0.58, -0.08],
  [0.55, 0.08],
  [0.52, -0.06],
] as const;

// ---------------------------------------------------------------------------
// Pistol patterns (semi-auto; short, gentle, 8-12 entries)
// ---------------------------------------------------------------------------

/** Dual Berettas: 10-entry gentle climb with mild alternating yaw. */
const DUALIES_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [0.45,  0.0],
  [0.50,  0.1],
  [0.55,  0.15],
  [0.58, -0.1],
  [0.60,  0.2],
  [0.62, -0.15],
  [0.62,  0.2],
  [0.60, -0.15],
  [0.58,  0.1],
  [0.55, -0.1],
] as const;

/** P250: 10-entry gentle climb, slight yaw drift. */
const P250_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [0.55,  0.0],
  [0.60,  0.08],
  [0.65,  0.12],
  [0.68, -0.06],
  [0.70,  0.14],
  [0.70, -0.1],
  [0.68,  0.14],
  [0.65, -0.1],
  [0.62,  0.08],
  [0.58, -0.06],
] as const;

/** Five-SeveN: 10-entry light climb with gentle weave. */
const FIVESEVEN_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [0.48,  0.0],
  [0.52,  0.09],
  [0.56,  0.13],
  [0.58, -0.07],
  [0.60,  0.13],
  [0.62, -0.1],
  [0.62,  0.13],
  [0.60, -0.1],
  [0.57,  0.09],
  [0.54, -0.07],
] as const;

/** Tec-9: 12-entry fast climb with more yaw than other pistols (high firerate). */
const TEC9_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [0.50,  0.0],
  [0.55,  0.12],
  [0.60,  0.18],
  [0.65, -0.12],
  [0.68,  0.22],
  [0.70, -0.18],
  [0.70,  0.22],
  [0.68, -0.18],
  [0.65,  0.15],
  [0.62, -0.12],
  [0.58,  0.1],
  [0.55, -0.1],
] as const;

// ---------------------------------------------------------------------------
// SMG patterns (full-auto; 20-entry gentle climbs + weave, ~55-65% of AK mag)
// ---------------------------------------------------------------------------

/** MAC-10: 20-entry fast, lightweight climb with alternating yaw. */
const MAC10_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [0.85,  0.0],
  [0.95,  0.2],
  [1.05,  0.3],
  [1.10,  0.4],
  [1.10,  0.5],
  [1.10,  0.55],
  [1.05,  0.6],
  [0.90,  0.65],
  [0.75,  0.6],
  [0.55,  0.5],
  [0.40, -0.4],
  [0.40, -0.55],
  [0.40, -0.7],
  [0.40, -0.65],
  [0.40, -0.5],
  [0.40,  0.4],
  [0.40,  0.5],
  [0.40,  0.55],
  [0.40,  0.5],
  [0.40,  0.4],
] as const;

/** MP9: 20-entry gentle climb, CT-side SMG. */
const MP9_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [0.80,  0.0],
  [0.88,  0.15],
  [0.95,  0.25],
  [1.00,  0.35],
  [1.02,  0.42],
  [1.02,  0.48],
  [0.98,  0.52],
  [0.85,  0.55],
  [0.70,  0.50],
  [0.52,  0.42],
  [0.38, -0.35],
  [0.38, -0.48],
  [0.38, -0.60],
  [0.38, -0.55],
  [0.38, -0.42],
  [0.38,  0.35],
  [0.38,  0.45],
  [0.38,  0.50],
  [0.38,  0.45],
  [0.38,  0.35],
] as const;

/** MP7: 20-entry smooth, symmetrical. Both teams. */
const MP7_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [0.78,  0.0],
  [0.85,  0.14],
  [0.92,  0.22],
  [0.97,  0.30],
  [0.99,  0.37],
  [0.99,  0.42],
  [0.95,  0.47],
  [0.82,  0.50],
  [0.68,  0.45],
  [0.50,  0.38],
  [0.36, -0.30],
  [0.36, -0.42],
  [0.36, -0.55],
  [0.36, -0.50],
  [0.36, -0.38],
  [0.36,  0.30],
  [0.36,  0.42],
  [0.36,  0.47],
  [0.36,  0.42],
  [0.36,  0.32],
] as const;

/** UMP-45: 20-entry heavy SMG with more pitch than MP7. */
const UMP45_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [0.90,  0.0],
  [1.00,  0.18],
  [1.10,  0.28],
  [1.15,  0.38],
  [1.18,  0.46],
  [1.18,  0.52],
  [1.12,  0.58],
  [0.98,  0.62],
  [0.80,  0.56],
  [0.60,  0.47],
  [0.42, -0.38],
  [0.42, -0.52],
  [0.42, -0.65],
  [0.42, -0.60],
  [0.42, -0.46],
  [0.42,  0.38],
  [0.42,  0.50],
  [0.42,  0.56],
  [0.42,  0.50],
  [0.42,  0.38],
] as const;

/** P90: 20-entry fast & friendly, most accurate SMG. */
const P90_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [0.72,  0.0],
  [0.78,  0.12],
  [0.84,  0.20],
  [0.88,  0.27],
  [0.90,  0.32],
  [0.90,  0.37],
  [0.86,  0.40],
  [0.74,  0.42],
  [0.60,  0.38],
  [0.45,  0.32],
  [0.32, -0.25],
  [0.32, -0.36],
  [0.32, -0.46],
  [0.32, -0.42],
  [0.32, -0.32],
  [0.32,  0.25],
  [0.32,  0.36],
  [0.32,  0.40],
  [0.32,  0.36],
  [0.32,  0.28],
] as const;

/** PP-Bizon: 20-entry lowest-recoil SMG. */
const BIZON_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [0.68,  0.0],
  [0.74,  0.11],
  [0.80,  0.18],
  [0.84,  0.24],
  [0.86,  0.30],
  [0.86,  0.34],
  [0.82,  0.38],
  [0.70,  0.40],
  [0.57,  0.36],
  [0.42,  0.30],
  [0.30, -0.22],
  [0.30, -0.32],
  [0.30, -0.42],
  [0.30, -0.38],
  [0.30, -0.30],
  [0.30,  0.22],
  [0.30,  0.32],
  [0.30,  0.36],
  [0.30,  0.32],
  [0.30,  0.24],
] as const;

// ---------------------------------------------------------------------------
// Heavy (shotgun) patterns — pump/semi-auto; no spray pattern needed
// (single-pull trigger; spreadBase + rangeModifier handle the pellet spread)
// ---------------------------------------------------------------------------

// Note: Nova, XM1014, Sawed-Off, MAG-7 use no recoilPattern (semi/pump single-shot).
// Damage tuned as single-slug equivalent (~2-shot kill at close range as pellet-aggregate
// approximation). Low rangeModifier (0.45-0.55) models brutal per-pellet falloff.

// ---------------------------------------------------------------------------
// MG patterns (30-entry wild; Negev tapers after shot ~10 — CS2 accuracy gimmick)
// ---------------------------------------------------------------------------

/** M249: 30-entry wild MG pattern, high magnitudes. */
const M249_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [1.50,  0.0],
  [1.70,  0.3],
  [1.90,  0.5],
  [2.00,  0.7],
  [2.10,  0.9],
  [2.10,  1.1],
  [2.00,  1.3],
  [1.80,  1.5],
  [1.60,  1.2],
  [1.40,  0.8],
  [0.80, -0.6],
  [0.80, -0.9],
  [0.80, -1.2],
  [0.80, -1.5],
  [0.80, -1.3],
  [0.80, -0.9],
  [0.80,  0.7],
  [0.80,  1.0],
  [0.80,  1.3],
  [0.80,  1.5],
  [0.80,  1.2],
  [0.80,  0.9],
  [0.80, -0.7],
  [0.80, -1.0],
  [0.80, -1.3],
  [0.80, -1.1],
  [0.80, -0.8],
  [0.80,  0.6],
  [0.80,  0.9],
  [0.80,  1.1],
] as const;

/** Negev: 30-entry; wild first 10 shots then tapers to near-accurate (CS2 gimmick). */
const NEGEV_PATTERN: ReadonlyArray<readonly [number, number]> = [
  // Shots 1-10: wild spray
  [1.80,  0.0],
  [2.00,  0.5],
  [2.20,  0.9],
  [2.30,  1.3],
  [2.30,  1.6],
  [2.20,  1.8],
  [2.00,  1.5],
  [1.70,  1.0],
  [1.30,  0.5],
  [0.90,  0.0],
  // Shots 11-30: tapers toward accurate (small residual weave)
  [0.20, -0.15],
  [0.18,  0.12],
  [0.16, -0.10],
  [0.15,  0.10],
  [0.14, -0.08],
  [0.14,  0.08],
  [0.13, -0.07],
  [0.13,  0.07],
  [0.12, -0.06],
  [0.12,  0.06],
  [0.11, -0.05],
  [0.11,  0.05],
  [0.10, -0.05],
  [0.10,  0.05],
  [0.10, -0.04],
  [0.10,  0.04],
  [0.09, -0.04],
  [0.09,  0.04],
  [0.09, -0.03],
  [0.09,  0.03],
] as const;

// ---------------------------------------------------------------------------
// Rifle patterns (full-auto rifles; ~80-95% of AK magnitudes)
// ---------------------------------------------------------------------------

/** FAMAS: 25-entry CT rifle, ~85% AK magnitude, fast burst-fire feel. */
const FAMAS_PATTERN: ReadonlyArray<readonly [number, number]> = [
  // Shots 1-8: climb
  [1.35,  0.0],
  [1.52,  0.08],
  [1.70,  0.17],
  [1.78,  0.26],
  [1.78,  0.34],
  [1.87,  0.43],
  [1.87,  0.51],
  [1.87,  0.60],
  // Shots 9-12: drift right
  [0.34,  0.85],
  [0.26,  0.94],
  [0.26,  1.02],
  [0.26,  0.77],
  // Shots 13-18: drift left
  [0.34, -0.77],
  [0.34, -0.94],
  [0.34, -1.02],
  [0.34, -1.11],
  [0.34, -1.02],
  [0.34, -0.94],
  // Shots 19-25: drift right
  [0.34,  0.68],
  [0.34,  0.77],
  [0.34,  0.85],
  [0.34,  0.94],
  [0.34,  0.85],
  [0.34,  0.77],
  [0.34,  0.60],
] as const;

/** Galil AR: 25-entry T rifle, ~88% AK magnitude. */
const GALIL_PATTERN: ReadonlyArray<readonly [number, number]> = [
  // Shots 1-8: climb
  [1.41,  0.0],
  [1.58,  0.09],
  [1.76,  0.18],
  [1.85,  0.27],
  [1.85,  0.35],
  [1.94,  0.44],
  [1.94,  0.53],
  [1.94,  0.62],
  // Shots 9-12: drift right
  [0.35,  0.88],
  [0.27,  0.97],
  [0.27,  1.06],
  [0.27,  0.80],
  // Shots 13-18: drift left
  [0.35, -0.79],
  [0.35, -0.97],
  [0.35, -1.06],
  [0.35, -1.14],
  [0.35, -1.06],
  [0.35, -0.97],
  // Shots 19-25: drift right
  [0.35,  0.71],
  [0.35,  0.79],
  [0.35,  0.88],
  [0.35,  0.97],
  [0.35,  0.88],
  [0.35,  0.79],
  [0.35,  0.62],
] as const;

/** AUG: 25-entry CT scoped rifle, ~90% M4A4 magnitude. */
const AUG_PATTERN: ReadonlyArray<readonly [number, number]> = [
  // Shots 1-8: climb
  [1.08,  0.0],
  [1.17,  0.09],
  [1.35,  0.14],
  [1.44,  0.18],
  [1.44,  0.27],
  [1.49,  0.32],
  [1.49,  0.41],
  [1.49,  0.45],
  // Shots 9-12: drift right
  [0.27,  0.68],
  [0.23,  0.74],
  [0.23,  0.81],
  [0.23,  0.63],
  // Shots 13-18: drift left
  [0.27, -0.63],
  [0.27, -0.74],
  [0.27, -0.81],
  [0.27, -0.90],
  [0.27, -0.81],
  [0.27, -0.74],
  // Shots 19-25: drift right
  [0.27,  0.54],
  [0.27,  0.63],
  [0.27,  0.68],
  [0.27,  0.74],
  [0.27,  0.68],
  [0.27,  0.63],
  [0.27,  0.54],
] as const;

/** SG 553: 25-entry T scoped rifle, ~88% AK magnitude. */
const SG553_PATTERN: ReadonlyArray<readonly [number, number]> = [
  // Shots 1-8: climb
  [1.41,  0.0],
  [1.58,  0.09],
  [1.76,  0.18],
  [1.85,  0.26],
  [1.85,  0.35],
  [1.94,  0.44],
  [1.94,  0.53],
  [1.85,  0.62],
  // Shots 9-12: drift right
  [0.35,  0.88],
  [0.26,  0.97],
  [0.26,  1.06],
  [0.26,  0.79],
  // Shots 13-18: drift left
  [0.35, -0.79],
  [0.35, -0.97],
  [0.35, -1.06],
  [0.35, -1.15],
  [0.35, -1.06],
  [0.35, -0.97],
  // Shots 19-25: drift right
  [0.35,  0.70],
  [0.35,  0.79],
  [0.35,  0.88],
  [0.35,  0.97],
  [0.35,  0.88],
  [0.35,  0.79],
  [0.35,  0.62],
] as const;

// ---------------------------------------------------------------------------
// Auto-sniper patterns (10-entry small; auto:true but slow rpm)
// ---------------------------------------------------------------------------

/** G3SG1: 10-entry small auto-sniper pattern. */
const G3SG1_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [0.80,  0.0],
  [0.90,  0.15],
  [1.00,  0.25],
  [1.05,  0.30],
  [1.05,  0.35],
  [0.95,  0.30],
  [0.85,  0.20],
  [0.80, -0.15],
  [0.80, -0.20],
  [0.80, -0.15],
] as const;

/** SCAR-20: 10-entry small auto-sniper pattern (CT mirror of G3SG1). */
const SCAR20_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [0.78,  0.0],
  [0.88,  0.13],
  [0.98,  0.22],
  [1.03,  0.28],
  [1.03,  0.32],
  [0.93,  0.28],
  [0.83,  0.18],
  [0.78, -0.13],
  [0.78, -0.18],
  [0.78, -0.13],
] as const;

export const WEAPONS: Record<string, WeaponDef> = {
  // -------------------------------------------------------------------------
  // Knife — no buy-menu category, no teams restriction
  // -------------------------------------------------------------------------
  knife: {
    id: 'knife', name: 'Knife', slot: 'knife', price: 0,
    damage: 55, headshotMult: 1, rangeModifier: 1,
    rpm: 60, magSize: 0, reserveAmmo: 0, reloadTime: 0,
    moveSpeed: 4.76,
    spreadBase: 0, spreadMove: 0, spreadAir: 0,
    recoilPitch: 0, recoilYaw: 0, recoilRecovery: 0,
    auto: false, killReward: 1500,
    isKnife: true, range: 1.6,
  },

  // -------------------------------------------------------------------------
  // Pistols
  // -------------------------------------------------------------------------

  // NOTE: P2000 (CT) and CZ75 (T) are loadout alternates, NOT default buy-menu items — excluded.
  glock: {
    id: 'glock', name: 'Glock-18', slot: 'secondary', price: 200,
    damage: 30, headshotMult: 4, rangeModifier: 0.90,
    rpm: 400, magSize: 20, reserveAmmo: 120, reloadTime: 2.3,
    moveSpeed: 4.57,
    // spreadMove: 0.02 -> 0.026 (+1.3x)
    spreadBase: 0.004, spreadMove: 0.026, spreadAir: 0.08,
    recoilPitch: 0.010, recoilYaw: 0.004, recoilRecovery: 0.5,
    auto: false, killReward: 300,
    category: 'pistol', teams: ['T'],
    recoilPattern: GLOCK_PATTERN,
    spreadSpray: 0.002,
  },
  usp: {
    id: 'usp', name: 'USP-S', slot: 'secondary', price: 200,
    damage: 35, headshotMult: 4, rangeModifier: 0.88,
    rpm: 352, magSize: 12, reserveAmmo: 24, reloadTime: 2.2,
    moveSpeed: 4.57,
    // spreadMove: 0.018 -> 0.0234 (+1.3x)
    spreadBase: 0.003, spreadMove: 0.0234, spreadAir: 0.08,
    recoilPitch: 0.011, recoilYaw: 0.004, recoilRecovery: 0.5,
    auto: false, killReward: 300,
    category: 'pistol', teams: ['CT'],
    recoilPattern: USP_PATTERN,
    spreadSpray: 0.0015,
  },
  deagle: {
    id: 'deagle', name: 'Desert Eagle', slot: 'secondary', price: 700,
    damage: 53, headshotMult: 4, rangeModifier: 0.81,
    rpm: 267, magSize: 7, reserveAmmo: 35, reloadTime: 2.2,
    moveSpeed: 4.38,
    spreadBase: 0.006, spreadMove: 0.05, spreadAir: 0.12,
    recoilPitch: 0.035, recoilYaw: 0.012, recoilRecovery: 0.8,
    auto: false, killReward: 300,
    category: 'pistol',
    // No pattern: legacy formula (heavy single-shot punch)
    spreadSpray: 0.006,
  },
  dualies: {
    id: 'dualies', name: 'Dual Berettas', slot: 'secondary', price: 300,
    damage: 38, headshotMult: 4, rangeModifier: 0.86,
    rpm: 500, magSize: 30, reserveAmmo: 120, reloadTime: 3.7,
    moveSpeed: 4.57,
    spreadBase: 0.005, spreadMove: 0.032, spreadAir: 0.09,
    recoilPitch: 0.009, recoilYaw: 0.005, recoilRecovery: 0.5,
    auto: false, killReward: 300,
    category: 'pistol',
    recoilPattern: DUALIES_PATTERN,
    spreadSpray: 0.002,
  },
  p250: {
    id: 'p250', name: 'P250', slot: 'secondary', price: 250,
    damage: 38, headshotMult: 4, rangeModifier: 0.86,
    rpm: 360, magSize: 13, reserveAmmo: 26, reloadTime: 2.2,
    moveSpeed: 4.57,
    spreadBase: 0.004, spreadMove: 0.028, spreadAir: 0.08,
    recoilPitch: 0.012, recoilYaw: 0.005, recoilRecovery: 0.5,
    auto: false, killReward: 300,
    category: 'pistol',
    recoilPattern: P250_PATTERN,
    spreadSpray: 0.002,
  },
  fiveseven: {
    id: 'fiveseven', name: 'Five-SeveN', slot: 'secondary', price: 500,
    damage: 32, headshotMult: 4, rangeModifier: 0.89,
    rpm: 400, magSize: 20, reserveAmmo: 100, reloadTime: 2.3,
    moveSpeed: 4.57,
    spreadBase: 0.003, spreadMove: 0.026, spreadAir: 0.08,
    recoilPitch: 0.010, recoilYaw: 0.004, recoilRecovery: 0.5,
    auto: false, killReward: 300,
    category: 'pistol', teams: ['CT'],
    recoilPattern: FIVESEVEN_PATTERN,
    spreadSpray: 0.0018,
  },
  tec9: {
    id: 'tec9', name: 'Tec-9', slot: 'secondary', price: 500,
    damage: 33, headshotMult: 4, rangeModifier: 0.89,
    rpm: 500, magSize: 18, reserveAmmo: 90, reloadTime: 2.7,
    moveSpeed: 4.57,
    spreadBase: 0.006, spreadMove: 0.038, spreadAir: 0.10,
    recoilPitch: 0.012, recoilYaw: 0.006, recoilRecovery: 0.5,
    auto: false, killReward: 300,
    category: 'pistol', teams: ['T'],
    recoilPattern: TEC9_PATTERN,
    spreadSpray: 0.003,
  },

  // -------------------------------------------------------------------------
  // SMGs
  // -------------------------------------------------------------------------

  // NOTE: MP5-SD is a loadout alternate for MP7 — excluded.
  mac10: {
    id: 'mac10', name: 'MAC-10', slot: 'primary', price: 1050,
    damage: 29, headshotMult: 4, rangeModifier: 0.85,
    rpm: 800, magSize: 30, reserveAmmo: 120, reloadTime: 2.1,
    moveSpeed: 4.38,
    spreadBase: 0.006, spreadMove: 0.038, spreadAir: 0.10,
    recoilPitch: 0.008, recoilYaw: 0.005, recoilRecovery: 1.2,
    auto: true, killReward: 600,
    category: 'smg', teams: ['T'],
    recoilPattern: MAC10_PATTERN,
    spreadSpray: 0.003,
  },
  mp9: {
    id: 'mp9', name: 'MP9', slot: 'primary', price: 1250,
    damage: 26, headshotMult: 4, rangeModifier: 0.85,
    rpm: 857, magSize: 30, reserveAmmo: 120, reloadTime: 2.1,
    moveSpeed: 4.38,
    spreadBase: 0.005, spreadMove: 0.034, spreadAir: 0.09,
    recoilPitch: 0.007, recoilYaw: 0.004, recoilRecovery: 1.2,
    auto: true, killReward: 600,
    category: 'smg', teams: ['CT'],
    recoilPattern: MP9_PATTERN,
    spreadSpray: 0.003,
  },
  mp7: {
    id: 'mp7', name: 'MP7', slot: 'primary', price: 1500,
    damage: 29, headshotMult: 4, rangeModifier: 0.86,
    rpm: 800, magSize: 30, reserveAmmo: 120, reloadTime: 2.3,
    moveSpeed: 4.38,
    spreadBase: 0.005, spreadMove: 0.032, spreadAir: 0.09,
    recoilPitch: 0.007, recoilYaw: 0.004, recoilRecovery: 1.2,
    auto: true, killReward: 600,
    category: 'smg',
    recoilPattern: MP7_PATTERN,
    spreadSpray: 0.003,
  },
  ump45: {
    id: 'ump45', name: 'UMP-45', slot: 'primary', price: 1200,
    damage: 35, headshotMult: 4, rangeModifier: 0.82,
    rpm: 600, magSize: 25, reserveAmmo: 100, reloadTime: 2.5,
    moveSpeed: 4.38,
    spreadBase: 0.007, spreadMove: 0.040, spreadAir: 0.10,
    recoilPitch: 0.010, recoilYaw: 0.006, recoilRecovery: 1.1,
    auto: true, killReward: 600,
    category: 'smg',
    recoilPattern: UMP45_PATTERN,
    spreadSpray: 0.003,
  },
  p90: {
    id: 'p90', name: 'P90', slot: 'primary', price: 2350,
    damage: 26, headshotMult: 4, rangeModifier: 0.86,
    rpm: 857, magSize: 50, reserveAmmo: 100, reloadTime: 3.3,
    moveSpeed: 4.29,
    spreadBase: 0.004, spreadMove: 0.028, spreadAir: 0.09,
    recoilPitch: 0.006, recoilYaw: 0.003, recoilRecovery: 1.3,
    auto: true, killReward: 600,
    category: 'smg',
    recoilPattern: P90_PATTERN,
    spreadSpray: 0.003,
  },
  bizon: {
    id: 'bizon', name: 'PP-Bizon', slot: 'primary', price: 1400,
    damage: 27, headshotMult: 4, rangeModifier: 0.84,
    rpm: 750, magSize: 64, reserveAmmo: 128, reloadTime: 2.4,
    moveSpeed: 4.38,
    spreadBase: 0.005, spreadMove: 0.030, spreadAir: 0.09,
    recoilPitch: 0.007, recoilYaw: 0.004, recoilRecovery: 1.2,
    auto: true, killReward: 600,
    category: 'smg',
    recoilPattern: BIZON_PATTERN,
    spreadSpray: 0.003,
  },

  // -------------------------------------------------------------------------
  // Heavy (shotguns + MGs)
  // Note: Damage tuned as single-slug equivalent for 2-shot kill at close range
  // as a pellet-aggregate approximation. No pellet system — engine fires 1 hitscan
  // per shot; low rangeModifier (0.45-0.55) models brutal pellet falloff.
  // Reload times are full-magazine times; shell-by-shell reloading is not modelled.
  // -------------------------------------------------------------------------

  nova: {
    id: 'nova', name: 'Nova', slot: 'primary', price: 1050,
    damage: 130, headshotMult: 4, rangeModifier: 0.50,
    rpm: 68, magSize: 8, reserveAmmo: 32, reloadTime: 4.6,
    moveSpeed: 4.10,
    spreadBase: 0.055, spreadMove: 0.080, spreadAir: 0.20,
    recoilPitch: 0.040, recoilYaw: 0.018, recoilRecovery: 0.8,
    auto: false, killReward: 900,
    category: 'heavy',
    // No recoilPattern: pump single-shot; spreadBase covers pellet spread proxy
    spreadSpray: 0.008,
  },
  xm1014: {
    id: 'xm1014', name: 'XM1014', slot: 'primary', price: 2000,
    damage: 120, headshotMult: 4, rangeModifier: 0.48,
    rpm: 171, magSize: 7, reserveAmmo: 32, reloadTime: 4.5,
    moveSpeed: 4.10,
    spreadBase: 0.060, spreadMove: 0.085, spreadAir: 0.20,
    recoilPitch: 0.035, recoilYaw: 0.016, recoilRecovery: 0.8,
    auto: false, killReward: 900,
    category: 'heavy',
    spreadSpray: 0.008,
  },
  sawedoff: {
    id: 'sawedoff', name: 'Sawed-Off', slot: 'primary', price: 1100,
    damage: 180, headshotMult: 4, rangeModifier: 0.45,
    rpm: 68, magSize: 7, reserveAmmo: 32, reloadTime: 5.0,
    moveSpeed: 4.10,
    spreadBase: 0.070, spreadMove: 0.095, spreadAir: 0.25,
    recoilPitch: 0.045, recoilYaw: 0.020, recoilRecovery: 0.8,
    auto: false, killReward: 900,
    category: 'heavy', teams: ['T'],
    spreadSpray: 0.008,
  },
  mag7: {
    id: 'mag7', name: 'MAG-7', slot: 'primary', price: 1300,
    damage: 145, headshotMult: 4, rangeModifier: 0.52,
    rpm: 68, magSize: 5, reserveAmmo: 32, reloadTime: 4.8,
    moveSpeed: 4.10,
    spreadBase: 0.058, spreadMove: 0.082, spreadAir: 0.20,
    recoilPitch: 0.042, recoilYaw: 0.018, recoilRecovery: 0.8,
    auto: false, killReward: 900,
    category: 'heavy', teams: ['CT'],
    spreadSpray: 0.008,
  },
  m249: {
    id: 'm249', name: 'M249', slot: 'primary', price: 5200,
    damage: 32, headshotMult: 4, rangeModifier: 0.97,
    rpm: 750, magSize: 100, reserveAmmo: 200, reloadTime: 5.7,
    moveSpeed: 3.71,   // 195 CS2 u/s
    spreadBase: 0.010, spreadMove: 0.090, spreadAir: 0.15,
    recoilPitch: 0.016, recoilYaw: 0.009, recoilRecovery: 1.0,
    auto: true, killReward: 300,
    category: 'heavy',
    recoilPattern: M249_PATTERN,
    spreadSpray: 0.005,
  },
  negev: {
    id: 'negev', name: 'Negev', slot: 'primary', price: 1700,
    damage: 35, headshotMult: 4, rangeModifier: 0.97,
    rpm: 1000, magSize: 150, reserveAmmo: 300, reloadTime: 5.6,
    moveSpeed: 3.81,   // 200 CS2 u/s (same bracket as AWP)
    spreadBase: 0.012, spreadMove: 0.095, spreadAir: 0.15,
    recoilPitch: 0.018, recoilYaw: 0.010, recoilRecovery: 0.9,
    auto: true, killReward: 300,
    category: 'heavy',
    recoilPattern: NEGEV_PATTERN,   // wild first 10; settles after (CS2 gimmick)
    spreadSpray: 0.005,
  },

  // -------------------------------------------------------------------------
  // Rifles
  // -------------------------------------------------------------------------

  famas: {
    id: 'famas', name: 'FAMAS', slot: 'primary', price: 2050,
    damage: 25, headshotMult: 4, rangeModifier: 0.96,
    rpm: 666, magSize: 25, reserveAmmo: 90, reloadTime: 2.9,
    moveSpeed: 4.29,
    spreadBase: 0.0035, spreadMove: 0.065, spreadAir: 0.09,
    recoilPitch: 0.0110, recoilYaw: 0.005, recoilRecovery: 1.6,
    auto: true, killReward: 300,
    category: 'rifle', teams: ['CT'],
    recoilPattern: FAMAS_PATTERN,
    spreadSpray: 0.004,
  },
  galil: {
    id: 'galil', name: 'Galil AR', slot: 'primary', price: 1800,
    damage: 30, headshotMult: 4, rangeModifier: 0.97,
    rpm: 600, magSize: 35, reserveAmmo: 90, reloadTime: 2.7,
    moveSpeed: 4.10,
    spreadBase: 0.0038, spreadMove: 0.068, spreadAir: 0.10,
    recoilPitch: 0.0118, recoilYaw: 0.006, recoilRecovery: 1.5,
    auto: true, killReward: 300,
    category: 'rifle', teams: ['T'],
    recoilPattern: GALIL_PATTERN,
    spreadSpray: 0.004,
  },
  // NOTE: M4A1-S is a loadout alternate for M4A4 — excluded.
  m4a4: {
    id: 'm4a4', name: 'M4A4', slot: 'primary', price: 2900,
    damage: 33, headshotMult: 4, rangeModifier: 0.97,
    rpm: 666, magSize: 30, reserveAmmo: 90, reloadTime: 3.1,
    moveSpeed: 4.29,
    // spreadMove: 0.030 -> 0.060 (+2x)
    spreadBase: 0.003, spreadMove: 0.060, spreadAir: 0.09,
    recoilPitch: 0.0105, recoilYaw: 0.005, recoilRecovery: 1.7,
    auto: true, killReward: 300,
    category: 'rifle', teams: ['CT'],
    recoilPattern: M4A4_PATTERN,
    spreadSpray: 0.004,
  },
  ak47: {
    id: 'ak47', name: 'AK-47', slot: 'primary', price: 2700,
    damage: 36, headshotMult: 4, rangeModifier: 0.98,
    rpm: 600, magSize: 30, reserveAmmo: 90, reloadTime: 2.5,
    moveSpeed: 4.10,
    // spreadMove: 0.035 -> 0.070 (+2x)
    spreadBase: 0.0035, spreadMove: 0.070, spreadAir: 0.10,
    recoilPitch: 0.0125, recoilYaw: 0.006, recoilRecovery: 1.6,
    auto: true, killReward: 300,
    category: 'rifle', teams: ['T'],
    recoilPattern: AK47_PATTERN,
    spreadSpray: 0.004,
  },
  aug: {
    id: 'aug', name: 'AUG', slot: 'primary', price: 3300,
    damage: 28, headshotMult: 4, rangeModifier: 0.97,
    rpm: 666, magSize: 30, reserveAmmo: 90, reloadTime: 3.1,
    moveSpeed: 4.29,
    spreadBase: 0.003, spreadMove: 0.062, spreadAir: 0.09,
    recoilPitch: 0.0100, recoilYaw: 0.005, recoilRecovery: 1.7,
    auto: true, scope: true, killReward: 300,
    category: 'rifle', teams: ['CT'],
    recoilPattern: AUG_PATTERN,
    spreadSpray: 0.004,
  },
  sg553: {
    id: 'sg553', name: 'SG 553', slot: 'primary', price: 3000,
    damage: 30, headshotMult: 4, rangeModifier: 0.97,
    rpm: 666, magSize: 30, reserveAmmo: 90, reloadTime: 2.8,
    moveSpeed: 4.10,
    spreadBase: 0.0038, spreadMove: 0.068, spreadAir: 0.10,
    recoilPitch: 0.0115, recoilYaw: 0.006, recoilRecovery: 1.6,
    auto: true, scope: true, killReward: 300,
    category: 'rifle', teams: ['T'],
    recoilPattern: SG553_PATTERN,
    spreadSpray: 0.004,
  },
  // Bolt-action sniper — scope:true; rpm 48 ≈ bolt cycle; no recoilPattern (single shot)
  // headshot check: 88 * 4 (headshotMult) = 352 dmg — OHKO through helmet (100 HP).
  // Kept headshotMult: 4 consistent with pistol/rifle convention; raw 88 dmg is enough
  // for a body shot against unarmored (100 HP). With armor (~0.775 mult) = ~68 — not
  // a guaranteed body-shot kill, matching CS2 SSG08 2-tap-body behaviour.
  ssg08: {
    id: 'ssg08', name: 'SSG 08', slot: 'primary', price: 1700,
    damage: 88, headshotMult: 4, rangeModifier: 0.99,
    rpm: 48, magSize: 10, reserveAmmo: 30, reloadTime: 3.7,
    moveSpeed: 4.29,
    spreadBase: 0.002, spreadMove: 0.200, spreadAir: 0.20,
    recoilPitch: 0.050, recoilYaw: 0.008, recoilRecovery: 1.2,
    auto: false, scope: true, killReward: 300,
    category: 'rifle',
    // No recoilPattern: bolt-action single-pull like AWP
    spreadSpray: 0,
  },
  awp: {
    id: 'awp', name: 'AWP', slot: 'primary', price: 4750,
    damage: 115, headshotMult: 2.5, rangeModifier: 0.99,
    rpm: 41, magSize: 5, reserveAmmo: 30, reloadTime: 3.7,
    moveSpeed: 3.81,
    // Hip-fire spreadMove: 0.15 -> 0.30 (+2x); scoped accuracy is handled by the weapon system later.
    spreadBase: 0.05, spreadMove: 0.30, spreadAir: 0.2,
    recoilPitch: 0.06, recoilYaw: 0.01, recoilRecovery: 1.2,
    auto: false, scope: true, killReward: 100,
    category: 'rifle',
    // No pattern: legacy formula
    spreadSpray: 0,
  },
  // Auto-snipers — scope:true, auto:true; heavy spreadMove like AWP when moving
  // NOTE: R8 Revolver is a loadout alternate for Deagle — excluded.
  g3sg1: {
    id: 'g3sg1', name: 'G3SG1', slot: 'primary', price: 5000,
    damage: 80, headshotMult: 4, rangeModifier: 0.99,
    rpm: 240, magSize: 20, reserveAmmo: 90, reloadTime: 4.7,
    moveSpeed: 3.81,
    spreadBase: 0.003, spreadMove: 0.28, spreadAir: 0.20,
    recoilPitch: 0.045, recoilYaw: 0.009, recoilRecovery: 1.2,
    auto: true, scope: true, killReward: 300,
    category: 'rifle', teams: ['T'],
    recoilPattern: G3SG1_PATTERN,
    spreadSpray: 0,
  },
  scar20: {
    id: 'scar20', name: 'SCAR-20', slot: 'primary', price: 5000,
    damage: 80, headshotMult: 4, rangeModifier: 0.99,
    rpm: 240, magSize: 20, reserveAmmo: 90, reloadTime: 4.7,
    moveSpeed: 3.81,
    spreadBase: 0.003, spreadMove: 0.28, spreadAir: 0.20,
    recoilPitch: 0.043, recoilYaw: 0.009, recoilRecovery: 1.2,
    auto: true, scope: true, killReward: 300,
    category: 'rifle', teams: ['CT'],
    recoilPattern: SCAR20_PATTERN,
    spreadSpray: 0,
  },
};

// Meters and seconds.
export const MOVEMENT = {
  GRAVITY: 15.24,
  JUMP_VELOCITY: 5.75,
  WALK_MULT: 0.52,
  CROUCH_MULT: 0.34,
  GROUND_ACCEL: 10,
  FRICTION: 6,
  AIR_ACCEL: 12,
  AIR_WISHSPEED_CAP: 0.6,
  STEP_HEIGHT: 0.5,
  PLAYER_RADIUS: 0.4,
  PLAYER_HEIGHT: 1.83,
  PLAYER_HEIGHT_CROUCH: 1.35,
  EYE_STAND: 1.64,
  EYE_CROUCH: 1.17,
  TAG_SLOW_MULT: 0.5,
  TAG_SLOW_TIME: 0.5,
};

export const ECONOMY = {
  START_MONEY: 800,
  MAX_MONEY: 16000,
  WIN_REWARD: 3250,
  LOSS_BONUS: [1400, 1900, 2400, 2900, 3400],
  PLANT_BONUS_TEAM: 800,
  PLANT_BONUS_PLANTER: 300,
  ARMOR_PRICE: 650,
  ARMOR_HELMET_PRICE: 1000,
  DEFUSE_KIT_PRICE: 400,
  /** Cost to upgrade vest-only armor to vest+helmet (650 already paid → pay 350 more). */
  ARMOR_UPGRADE_PRICE: 350,
};

export const RULES = {
  FREEZE_TIME: 5,
  /** Seconds from freeze start during which buying is allowed (CS2-style: buy window outlasts freeze). */
  BUY_TIME: 30,
  ROUND_TIME: 115,
  BOMB_TIME: 40,
  DEFUSE_TIME: 10,
  DEFUSE_TIME_KIT: 5,
  PLANT_TIME: 3.2,
  ROUND_END_PAUSE: 5,
  ROUNDS_TO_WIN: 13,
  MAX_ROUNDS: 24,
  ARMOR_DAMAGE_MULT: 0.775,
  HEAD_ARMOR_NEEDS_HELMET: true,
};

export const TEAM_COLORS: Record<Team, number> = {
  CT: 0x4f7cc9,
  T: 0xc9a23f,
};

export const BOT_NAMES: string[] = [
  'Phoenix', 'Blaze', 'Viper', 'Rock', 'Hawk', 'Storm',
  'Wolf', 'Cobra', 'Falcon', 'Dust', 'Smoke', 'Flash',
];

export const BOT_DIFFICULTY: Record<
  'easy' | 'normal' | 'hard',
  { reactionMs: number; aimErrorDeg: number; recoilControl: number; visionRange: number }
> = {
  easy: { reactionMs: 550, aimErrorDeg: 3.2, recoilControl: 0.3, visionRange: 45 },
  normal: { reactionMs: 350, aimErrorDeg: 1.7, recoilControl: 0.6, visionRange: 60 },
  hard: { reactionMs: 220, aimErrorDeg: 0.8, recoilControl: 0.85, visionRange: 80 },
};

export interface GrenadeDef {
  /** Buy-menu price in dollars. */
  price: number;
  /** Maximum number of this type a combatant can carry simultaneously. */
  maxCarry: number;
  /**
   * Fuse duration in seconds from throw to detonation.
   * Smoke grenades use 0 (pop immediately on coming to rest);
   * the projectile system should treat fuse=0 as "detonate on bounce-rest".
   */
  fuseSeconds: number;
  /** Initial speed of the projectile along the throw vector (m/s). */
  throwSpeed: number;
  /** Additive upward velocity component applied at throw time (m/s). */
  upwardBoost: number;
  /**
   * Effect radius in meters:
   * - he: damage falloff radius (0 damage at edge, heMaxDamage at center).
   * - flash: maximum range at which full-blind can be applied.
   * - smoke: visual / LOS blocking radius of the smoke cloud.
   */
  radius: number;
  /** HE only: maximum damage at point-blank (center of explosion). */
  heMaxDamage?: number;
  /** Smoke only: how many seconds the smoke cloud persists before dissipating. */
  smokeDurationSeconds?: number;
  /** Coefficient of restitution for bouncing off walls/floor (0 = no bounce, 1 = perfect). */
  restitution: number;
  /** Per-bounce friction multiplier applied to lateral velocity on floor contact. */
  groundFriction: number;
  /** Collision sphere radius of the projectile itself (meters). */
  projectileRadius: number;
  /** Gravity scale relative to MOVEMENT.GRAVITY (1 = full gravity). */
  gravityScale: number;
}

export const GRENADES: Record<GrenadeType, GrenadeDef> = {
  he: {
    price: 300,
    maxCarry: 1,
    fuseSeconds: 1.6,
    throwSpeed: 18,
    upwardBoost: 2.5,
    radius: 10,
    heMaxDamage: 98,
    restitution: 0.45,
    groundFriction: 0.7,
    projectileRadius: 0.07,
    gravityScale: 1,
  },
  flash: {
    price: 200,
    maxCarry: 2,
    fuseSeconds: 1.5,
    throwSpeed: 18,
    upwardBoost: 2.5,
    radius: 22,
    restitution: 0.45,
    groundFriction: 0.7,
    projectileRadius: 0.07,
    gravityScale: 1,
  },
  smoke: {
    price: 300,
    maxCarry: 1,
    fuseSeconds: 0,
    throwSpeed: 17,
    upwardBoost: 2.5,
    radius: 3.5,
    smokeDurationSeconds: 15,
    restitution: 0.45,
    groundFriction: 0.7,
    projectileRadius: 0.07,
    gravityScale: 1,
  },
};
