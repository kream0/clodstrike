import type { Combatant, HitGroup, Vec3, GameEvents } from './types';
import type { WeaponDef } from './types';
import type { World, RayHit } from './world';
import { Emitter } from './events';
import { RULES, ECONOMY } from './constants';
import { type AABB, rayAABB, v3 } from './math';

// Global event bus — imported by later agents.
export const gameEvents = new Emitter<GameEvents>();

// ---------------------------------------------------------------------------
// Hitboxes
// ---------------------------------------------------------------------------

export function getHitboxes(
  c: Combatant,
): { head: AABB; body: AABB; legs: AABB } {
  const scale = c.crouching ? 1.35 / 1.83 : 1;
  const px = c.pos.x;
  const py = c.pos.y;
  const pz = c.pos.z;

  // Standing heights: legs 0–0.85, body 0.85–1.50, head 1.50–1.83
  const legsTop  = 0.85  * scale;
  const bodyTop  = 1.50  * scale;
  const headTop  = 1.83  * scale;

  const legsHe = 0.22;
  const bodyHe = 0.26;
  const headHe = 0.14;

  return {
    legs: {
      min: v3(px - legsHe, py + 0,        pz - legsHe),
      max: v3(px + legsHe, py + legsTop,  pz + legsHe),
    },
    body: {
      min: v3(px - bodyHe, py + legsTop,  pz - bodyHe),
      max: v3(px + bodyHe, py + bodyTop,  pz + bodyHe),
    },
    head: {
      min: v3(px - headHe, py + bodyTop,  pz - headHe),
      max: v3(px + headHe, py + headTop,  pz + headHe),
    },
  };
}

// ---------------------------------------------------------------------------
// ShotResult
// ---------------------------------------------------------------------------

export interface ShotResult {
  endPoint: Vec3;
  target: Combatant | null;
  hitGroup: HitGroup | null;
  killed: boolean;
  headshot: boolean;
  surface: RayHit['kind'] | null;
  normal: Vec3 | null;
}

// ---------------------------------------------------------------------------
// applyDamage
// ---------------------------------------------------------------------------

export function applyDamage(
  victim: Combatant,
  attacker: Combatant | null,
  weapon: WeaponDef,
  distance: number,
  hitGroup: HitGroup,
  now: number,
): { amount: number; killed: boolean } {
  // Base damage with range falloff (knife: rangeModifier=1 so no-op).
  let dmg = weapon.damage * Math.pow(weapon.rangeModifier, distance / 15);

  // Hit group multiplier.
  if (hitGroup === 'head') {
    dmg *= weapon.headshotMult;
  } else if (hitGroup === 'legs') {
    dmg *= 0.75;
  }

  // Armor reduction — legs always skip armor.
  if (hitGroup !== 'legs' && victim.armor > 0) {
    // Head requires helmet.
    const armorApplies = hitGroup === 'body' || victim.helmet;
    if (armorApplies) {
      dmg *= RULES.ARMOR_DAMAGE_MULT;
      // Armor durability: absorb half the original damage.
      victim.armor = Math.max(0, victim.armor - dmg * 0.5);
    }
  }

  // Round up to at least 1.
  const amount = Math.max(1, Math.round(dmg));

  victim.health -= amount;
  victim.tagSlowUntil = now + 0.5; // MOVEMENT.TAG_SLOW_TIME

  const killed = victim.health <= 0;
  if (killed) {
    victim.health = 0;
    victim.alive  = false;
    victim.deaths++;

    if (attacker !== null && attacker !== victim) {
      attacker.kills++;
      attacker.money = Math.min(ECONOMY.MAX_MONEY, attacker.money + weapon.killReward);
    }
  }

  gameEvents.emit('damage', { attacker, victim, amount, hitGroup });
  if (killed) {
    gameEvents.emit('kill', {
      attacker,
      victim,
      weaponId: weapon.id,
      headshot: hitGroup === 'head',
    });
  }

  return { amount, killed };
}

// ---------------------------------------------------------------------------
// Internal: ray vs combatant hitboxes
// ---------------------------------------------------------------------------

function rayHitCombatant(
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  c: Combatant,
): { t: number; hitGroup: HitGroup } | null {
  const invDir = v3(
    dir.x === 0 ? Infinity : 1 / dir.x,
    dir.y === 0 ? Infinity : 1 / dir.y,
    dir.z === 0 ? Infinity : 1 / dir.z,
  );

  const boxes = getHitboxes(c);
  let best: { t: number; hitGroup: HitGroup } | null = null;

  for (const group of ['head', 'body', 'legs'] as HitGroup[]) {
    const t = rayAABB(origin, invDir, boxes[group]);
    if (t !== null && t <= maxDist) {
      if (best === null || t < best.t) {
        best = { t, hitGroup: group };
      }
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// fireHitscan
// ---------------------------------------------------------------------------

export function fireHitscan(
  shooter: Combatant,
  dir: Vec3,
  world: World,
  targets: Combatant[],
  now: number,
): ShotResult {
  const activeSlot = shooter.inventory.activeSlot;
  const ws =
    activeSlot === 'primary'   ? shooter.inventory.primary :
    activeSlot === 'secondary' ? shooter.inventory.secondary :
    shooter.inventory.knife;
  const weapon = ws?.def ?? shooter.inventory.knife.def;

  // Eye position.
  const eyeOff  = shooter.crouching ? 1.17 : 1.64; // MOVEMENT.EYE_STAND / EYE_CROUCH
  const origin: Vec3 = {
    x: shooter.pos.x,
    y: shooter.pos.y + eyeOff,
    z: shooter.pos.z,
  };

  const maxDist = 512;

  // World raycast.
  const worldHit = world.raycast(origin, dir, maxDist);
  const worldDist = worldHit ? worldHit.distance : maxDist;

  // Test all alive enemy combatants.
  let nearestTarget: { combatant: Combatant; t: number; hitGroup: HitGroup } | null = null;

  for (const target of targets) {
    if (!target.alive) continue;
    if (target === shooter) continue;
    if (target.team === shooter.team) continue; // friendly fire OFF

    const hit = rayHitCombatant(origin, dir, Math.min(worldDist, maxDist), target);
    if (hit !== null) {
      if (nearestTarget === null || hit.t < nearestTarget.t) {
        nearestTarget = { combatant: target, t: hit.t, hitGroup: hit.hitGroup };
      }
    }
  }

  gameEvents.emit('shot', { shooter, pos: origin, weaponId: weapon.id });

  if (nearestTarget !== null) {
    const tgt = nearestTarget.combatant;
    const dist = nearestTarget.t;
    const hitPt: Vec3 = {
      x: origin.x + dir.x * dist,
      y: origin.y + dir.y * dist,
      z: origin.z + dir.z * dist,
    };

    const { killed } = applyDamage(tgt, shooter, weapon, dist, nearestTarget.hitGroup, now);

    return {
      endPoint:  hitPt,
      target:    tgt,
      hitGroup:  nearestTarget.hitGroup,
      killed,
      headshot:  nearestTarget.hitGroup === 'head',
      surface:   null,
      normal:    null,
    };
  }

  // World surface hit.
  const endPoint: Vec3 = worldHit
    ? { ...worldHit.point }
    : {
        x: origin.x + dir.x * maxDist,
        y: origin.y + dir.y * maxDist,
        z: origin.z + dir.z * maxDist,
      };

  return {
    endPoint,
    target:   null,
    hitGroup: null,
    killed:   false,
    headshot: false,
    surface:  worldHit ? worldHit.kind : null,
    normal:   worldHit ? { ...worldHit.normal } : null,
  };
}

// ---------------------------------------------------------------------------
// knifeAttack
// ---------------------------------------------------------------------------

export function knifeAttack(
  shooter: Combatant,
  dir: Vec3,
  world: World,
  targets: Combatant[],
  now: number,
): ShotResult {
  const weapon = shooter.inventory.knife.def;
  const range = weapon.range ?? 1.6;

  const eyeOff = shooter.crouching ? 1.17 : 1.64;
  const origin: Vec3 = {
    x: shooter.pos.x,
    y: shooter.pos.y + eyeOff,
    z: shooter.pos.z,
  };

  const worldHit = world.raycast(origin, dir, range);
  const worldDist = worldHit ? worldHit.distance : range;

  let nearestTarget: { combatant: Combatant; t: number; hitGroup: HitGroup } | null = null;

  for (const target of targets) {
    if (!target.alive) continue;
    if (target === shooter) continue;
    if (target.team === shooter.team) continue;

    const hit = rayHitCombatant(origin, dir, Math.min(worldDist, range), target);
    if (hit !== null) {
      if (nearestTarget === null || hit.t < nearestTarget.t) {
        nearestTarget = { combatant: target, t: hit.t, hitGroup: hit.hitGroup };
      }
    }
  }

  gameEvents.emit('shot', { shooter, pos: origin, weaponId: weapon.id });

  if (nearestTarget !== null) {
    const tgt = nearestTarget.combatant;
    const dist = nearestTarget.t;
    const hitPt: Vec3 = {
      x: origin.x + dir.x * dist,
      y: origin.y + dir.y * dist,
      z: origin.z + dir.z * dist,
    };

    const { killed } = applyDamage(tgt, shooter, weapon, dist, nearestTarget.hitGroup, now);

    return {
      endPoint:  hitPt,
      target:    tgt,
      hitGroup:  nearestTarget.hitGroup,
      killed,
      headshot:  nearestTarget.hitGroup === 'head',
      surface:   null,
      normal:    null,
    };
  }

  const endPoint: Vec3 = worldHit
    ? { ...worldHit.point }
    : {
        x: origin.x + dir.x * range,
        y: origin.y + dir.y * range,
        z: origin.z + dir.z * range,
      };

  return {
    endPoint,
    target:   null,
    hitGroup: null,
    killed:   false,
    headshot: false,
    surface:  worldHit ? worldHit.kind : null,
    normal:   worldHit ? { ...worldHit.normal } : null,
  };
}
