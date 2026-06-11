import type { Team, WeaponDef } from './types';

export const WEAPONS: Record<string, WeaponDef> = {
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
  glock: {
    id: 'glock', name: 'Glock-18', slot: 'secondary', price: 200,
    damage: 30, headshotMult: 4, rangeModifier: 0.90,
    rpm: 400, magSize: 20, reserveAmmo: 120, reloadTime: 2.3,
    moveSpeed: 4.57,
    spreadBase: 0.004, spreadMove: 0.02, spreadAir: 0.08,
    recoilPitch: 0.010, recoilYaw: 0.004, recoilRecovery: 0.5,
    auto: false, killReward: 300,
  },
  usp: {
    id: 'usp', name: 'USP-S', slot: 'secondary', price: 200,
    damage: 35, headshotMult: 4, rangeModifier: 0.88,
    rpm: 352, magSize: 12, reserveAmmo: 24, reloadTime: 2.2,
    moveSpeed: 4.57,
    spreadBase: 0.003, spreadMove: 0.018, spreadAir: 0.08,
    recoilPitch: 0.011, recoilYaw: 0.004, recoilRecovery: 0.5,
    auto: false, killReward: 300,
  },
  deagle: {
    id: 'deagle', name: 'Desert Eagle', slot: 'secondary', price: 700,
    damage: 53, headshotMult: 4, rangeModifier: 0.81,
    rpm: 267, magSize: 7, reserveAmmo: 35, reloadTime: 2.2,
    moveSpeed: 4.38,
    spreadBase: 0.006, spreadMove: 0.05, spreadAir: 0.12,
    recoilPitch: 0.035, recoilYaw: 0.012, recoilRecovery: 0.8,
    auto: false, killReward: 300,
  },
  ak47: {
    id: 'ak47', name: 'AK-47', slot: 'primary', price: 2700,
    damage: 36, headshotMult: 4, rangeModifier: 0.98,
    rpm: 600, magSize: 30, reserveAmmo: 90, reloadTime: 2.5,
    moveSpeed: 4.10,
    spreadBase: 0.0035, spreadMove: 0.035, spreadAir: 0.10,
    recoilPitch: 0.0125, recoilYaw: 0.006, recoilRecovery: 1.6,
    auto: true, killReward: 300,
  },
  m4a4: {
    id: 'm4a4', name: 'M4A4', slot: 'primary', price: 2900,
    damage: 33, headshotMult: 4, rangeModifier: 0.97,
    rpm: 666, magSize: 30, reserveAmmo: 90, reloadTime: 3.1,
    moveSpeed: 4.29,
    spreadBase: 0.003, spreadMove: 0.03, spreadAir: 0.09,
    recoilPitch: 0.0105, recoilYaw: 0.005, recoilRecovery: 1.7,
    auto: true, killReward: 300,
  },
  awp: {
    id: 'awp', name: 'AWP', slot: 'primary', price: 4750,
    damage: 115, headshotMult: 2.5, rangeModifier: 0.99,
    rpm: 41, magSize: 5, reserveAmmo: 30, reloadTime: 3.7,
    moveSpeed: 3.81,
    // Hip-fire spread; scoped accuracy is handled by the weapon system later.
    spreadBase: 0.05, spreadMove: 0.15, spreadAir: 0.2,
    recoilPitch: 0.06, recoilYaw: 0.01, recoilRecovery: 1.2,
    auto: false, scope: true, killReward: 100,
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
};

export const RULES = {
  FREEZE_TIME: 5,
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
