import type { Combatant, WeaponDef } from './types';
import { MOVEMENT, WEAPONS } from './constants';
import type { World } from './world';

export interface MoveIntent {
  forward: number;  // +1 = toward facing
  strafe:  number;  // +1 = right
  jump:    boolean;
  crouch:  boolean;
  walk:    boolean;
}

export interface MoveEvents {
  jumped:       boolean;
  landed:       boolean;
  stepDistance: number; // horizontal ground distance this tick
}

function getActiveWeaponDef(c: Combatant): WeaponDef {
  const slot = c.inventory.activeSlot;
  const ws =
    slot === 'primary'   ? c.inventory.primary :
    slot === 'secondary' ? c.inventory.secondary :
    c.inventory.knife;
  return ws?.def ?? WEAPONS.knife;
}

export function simulateMovement(
  c: Combatant,
  intent: MoveIntent,
  world: World,
  dt: number,
  nowSec: number,
): MoveEvents {
  const def = getActiveWeaponDef(c);

  // Max speed calculation.
  let maxSpeed = def.moveSpeed;
  if (intent.walk)   maxSpeed *= MOVEMENT.WALK_MULT;
  if (intent.crouch) maxSpeed *= MOVEMENT.CROUCH_MULT;
  if (nowSec < c.tagSlowUntil) maxSpeed *= MOVEMENT.TAG_SLOW_MULT;

  // Wish direction (XZ plane, from yaw).
  // yaw 0 = facing -Z. Forward = -Z at yaw 0. Strafe right = +X at yaw 0.
  // facing dir (yaw): { x: -sin(yaw), z: -cos(yaw) }
  // right dir (yaw):  { x: cos(yaw),  z: -sin(yaw) }
  const sinY = Math.sin(c.yaw);
  const cosY = Math.cos(c.yaw);

  const fwdX = -sinY;
  const fwdZ = -cosY;
  const rgtX = cosY;
  const rgtZ = -sinY;

  let wishX = fwdX * intent.forward + rgtX * intent.strafe;
  let wishZ = fwdZ * intent.forward + rgtZ * intent.strafe;
  const wishLen = Math.sqrt(wishX * wishX + wishZ * wishZ);
  if (wishLen > 1e-8) {
    wishX /= wishLen;
    wishZ /= wishLen;
  }

  // Separate horizontal and vertical velocity.
  let vx = c.vel.x;
  let vy = c.vel.y;
  let vz = c.vel.z;

  const wasOnGround = c.onGround;

  if (c.onGround) {
    // Ground friction.
    const horizSpeed = Math.sqrt(vx * vx + vz * vz);
    const friction = MOVEMENT.FRICTION;
    const newSpeed = Math.max(0, horizSpeed - friction * horizSpeed * dt);
    const scale = horizSpeed > 1e-8 ? newSpeed / horizSpeed : 0;
    vx *= scale;
    vz *= scale;

    // Ground acceleration.
    const accelRate = MOVEMENT.GROUND_ACCEL * maxSpeed;
    const proj = vx * wishX + vz * wishZ;
    const addSpeed = maxSpeed - proj;
    if (addSpeed > 0) {
      const accel = Math.min(accelRate * dt, addSpeed);
      vx += wishX * accel;
      vz += wishZ * accel;
    }

    // Cap horizontal speed.
    const speedAfter = Math.sqrt(vx * vx + vz * vz);
    if (speedAfter > maxSpeed) {
      const capScale = maxSpeed / speedAfter;
      vx *= capScale;
      vz *= capScale;
    }
  } else {
    // Air acceleration (Quake-style).
    const wishCapped = Math.min(MOVEMENT.AIR_WISHSPEED_CAP, maxSpeed);
    const proj = vx * wishX + vz * wishZ;
    const addSpeed = wishCapped - proj;
    if (addSpeed > 0) {
      const accel = Math.min(MOVEMENT.AIR_ACCEL * maxSpeed * dt, addSpeed);
      vx += wishX * accel;
      vz += wishZ * accel;
    }
  }

  // Gravity always.
  vy -= MOVEMENT.GRAVITY * dt;

  // Jump.
  let jumped = false;
  if (c.onGround && intent.jump) {
    vy = MOVEMENT.JUMP_VELOCITY;
    jumped = true;
    c.onGround = false;
  }

  // Crouch state & height.
  if (intent.crouch) {
    c.crouching = true;
  } else if (c.crouching) {
    // Try to un-crouch: need standing headroom.
    const ceilH = world.ceilingOver(c.pos.x, c.pos.z, MOVEMENT.PLAYER_RADIUS);
    const standFloor = world.groundHeight(c.pos.x, c.pos.z, MOVEMENT.PLAYER_RADIUS, c.pos.y + MOVEMENT.STEP_HEIGHT);
    if (ceilH - standFloor >= MOVEMENT.PLAYER_HEIGHT - 0.01) {
      c.crouching = false;
    }
  }
  const height = c.crouching ? MOVEMENT.PLAYER_HEIGHT_CROUCH : MOVEMENT.PLAYER_HEIGHT;

  c.walking = intent.walk && c.onGround;

  // Run moveAABB.
  const result = world.moveAABB(
    c.pos,
    { x: vx, y: vy, z: vz },
    dt,
    MOVEMENT.PLAYER_RADIUS,
    height,
  );

  // Write back.
  c.pos = result.pos;
  c.vel = result.vel;
  c.onGround = result.onGround;

  // Compute horizontal step distance (for footstep cadence).
  const stepDistance = c.onGround
    ? Math.sqrt(result.vel.x * result.vel.x + result.vel.z * result.vel.z) * dt
    : 0;

  const landed = wasOnGround === false && result.onGround === true;

  return { jumped, landed, stepDistance };
}
