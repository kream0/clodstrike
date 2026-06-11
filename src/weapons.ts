import type { Combatant, WeaponSlot } from './types';
import type { World } from './world';
import { MOVEMENT } from './constants';
import { clamp, randSpread, yawPitchToDir, normalize } from './math';
import { fireHitscan, knifeAttack } from './combat';
import type { ShotResult } from './combat';
import { gameEvents } from './combat';

// ---------------------------------------------------------------------------
// Per-combatant aim state (internal to this module)
// ---------------------------------------------------------------------------

interface AimState {
  viewPunchPitch: number;
  viewPunchYaw:   number;
  scoped:         boolean;
  lastShotAt:     number;   // clock.now of last shot
  lastTriggerAt:  number;   // clock.now when trigger was last released
}

const aimStates = new Map<number, AimState>();

function getAim(c: Combatant): AimState {
  let s = aimStates.get(c.id);
  if (!s) {
    s = { viewPunchPitch: 0, viewPunchYaw: 0, scoped: false, lastShotAt: 0, lastTriggerAt: -1 };
    aimStates.set(c.id, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function getViewPunch(c: Combatant): { pitch: number; yaw: number } {
  const s = getAim(c);
  return { pitch: s.viewPunchPitch, yaw: s.viewPunchYaw };
}

export function isScoped(c: Combatant): boolean {
  return getAim(c).scoped;
}

export function currentSpread(c: Combatant, now: number): number {
  const slot = c.inventory.activeSlot;
  const ws =
    slot === 'primary'   ? c.inventory.primary :
    slot === 'secondary' ? c.inventory.secondary :
    c.inventory.knife;
  if (!ws) return 0;
  const def = ws.def;
  if (def.isKnife) return 0;

  const aim = getAim(c);
  if (def.scope && aim.scoped) return 0.0008;

  const horizSpeed  = Math.sqrt(c.vel.x * c.vel.x + c.vel.z * c.vel.z);
  const moveFrac    = clamp(horizSpeed / def.moveSpeed, 0, 1);
  let spread = def.spreadBase + def.spreadMove * moveFrac;
  if (!c.onGround) spread += def.spreadAir;
  if (c.crouching) spread *= 0.65;
  return spread;
}

export function switchSlot(c: Combatant, slot: WeaponSlot, now: number): boolean {
  const inv = c.inventory;
  if (slot === 'primary' && !inv.primary) return false;
  if (slot === 'secondary' && !inv.secondary) return false;

  const ws =
    slot === 'primary'   ? inv.primary :
    slot === 'secondary' ? inv.secondary :
    inv.knife;
  if (!ws) return false;

  // Cancel reload on old weapon.
  const oldSlot = inv.activeSlot;
  const oldWs =
    oldSlot === 'primary'   ? inv.primary :
    oldSlot === 'secondary' ? inv.secondary :
    inv.knife;
  if (oldWs) {
    oldWs.reloading = false;
    oldWs.reloadEnd = 0;
  }

  inv.activeSlot = slot;

  // Switch delay: block fire for 0.45 s from now; nextFire = max(existing, now+0.45).
  ws.nextFire = Math.max(ws.nextFire, now + 0.45);
  ws.shotsFired = 0;

  // Unscope.
  const aim = getAim(c);
  aim.scoped = false;

  return true;
}

export function resetAim(c: Combatant): void {
  const s = getAim(c);
  s.viewPunchPitch = 0;
  s.viewPunchYaw   = 0;
  s.scoped         = false;
  s.lastShotAt     = 0;
  s.lastTriggerAt  = -1;
}

// ---------------------------------------------------------------------------
// Main update
// ---------------------------------------------------------------------------

export function updateWeapon(
  c: Combatant,
  world: World,
  targets: Combatant[],
  input: { trigger: boolean; reloadPressed: boolean; scopePressed: boolean },
  now: number,
  dt: number,
): ShotResult | null {
  const inv = c.inventory;
  const slot = inv.activeSlot;
  const ws =
    slot === 'primary'   ? inv.primary :
    slot === 'secondary' ? inv.secondary :
    inv.knife;

  if (!ws) return null;

  const def = ws.def;
  const aim = getAim(c);

  // ----- Reload completion -----
  if (ws.reloading && now >= ws.reloadEnd) {
    const needed  = def.magSize - ws.ammo;
    const fill    = Math.min(needed, ws.reserve);
    ws.ammo       += fill;
    ws.reserve    -= fill;
    ws.reloading   = false;
    ws.reloadEnd   = 0;
  }

  // ----- Reload start -----
  if (
    input.reloadPressed &&
    !def.isKnife &&
    !ws.reloading &&
    ws.ammo < def.magSize &&
    ws.reserve > 0
  ) {
    ws.reloading = true;
    ws.reloadEnd = now + def.reloadTime;
    ws.shotsFired = 0;
    gameEvents.emit('reload', { who: c });
  }

  // ----- Scope toggle -----
  if (input.scopePressed && def.scope) {
    aim.scoped = !aim.scoped;
  }

  // ----- Recoil recovery (always) -----
  const recovery = def.recoilRecovery * dt;
  aim.viewPunchPitch = aim.viewPunchPitch > 0
    ? Math.max(0, aim.viewPunchPitch - recovery)
    : Math.min(0, aim.viewPunchPitch + recovery);
  aim.viewPunchYaw = aim.viewPunchYaw > 0
    ? Math.max(0, aim.viewPunchYaw - recovery)
    : Math.min(0, aim.viewPunchYaw + recovery);

  // ----- Shot fired counter reset -----
  if (!input.trigger) {
    if (aim.lastTriggerAt >= 0 && (now - aim.lastTriggerAt) >= 0.4) {
      ws.shotsFired = 0;
    }
    aim.lastTriggerAt = now;
  }

  // ----- Fire gate -----
  const canFire =
    input.trigger &&
    !ws.reloading &&
    now >= ws.nextFire &&
    (def.isKnife || ws.ammo > 0);

  if (!canFire) return null;

  // ----- Consume ammo -----
  if (!def.isKnife) {
    ws.ammo--;
  }

  ws.nextFire  = now + 60 / def.rpm;
  ws.shotsFired++;
  aim.lastShotAt  = now;
  aim.lastTriggerAt = -1; // reset so the 0.4s reset doesn't fire mid-burst

  // ----- Compute direction with spread -----
  const baseYaw   = c.yaw   + aim.viewPunchYaw;
  const basePitch = c.pitch + aim.viewPunchPitch;

  let spread: number;
  if (def.isKnife) {
    spread = 0;
  } else if (def.scope && aim.scoped) {
    // AWP scoped: minimal spread, penalty if moving.
    const horizSpeed = Math.sqrt(c.vel.x * c.vel.x + c.vel.z * c.vel.z);
    spread = horizSpeed > 0.5 ? def.spreadMove * 0.5 : 0.0008;
  } else {
    const horizSpeed  = Math.sqrt(c.vel.x * c.vel.x + c.vel.z * c.vel.z);
    const moveFrac    = clamp(horizSpeed / def.moveSpeed, 0, 1);
    spread = def.spreadBase + def.spreadMove * moveFrac;
    if (!c.onGround) spread += def.spreadAir;
    if (c.crouching) spread *= 0.65;
  }

  const spreadYaw   = randSpread(spread);
  const spreadPitch = randSpread(spread);

  const shootDir = yawPitchToDir(baseYaw + spreadYaw, basePitch + spreadPitch);
  const normDir  = normalize(shootDir);

  // ----- Recoil application -----
  aim.viewPunchPitch += def.recoilPitch * (1 + ws.shotsFired * 0.06);
  aim.viewPunchPitch  = Math.min(aim.viewPunchPitch, 0.35);

  const yawPattern = Math.sin(ws.shotsFired * 0.7);
  aim.viewPunchYaw += def.recoilYaw * yawPattern;

  // ----- Execute shot -----
  const result = def.isKnife
    ? knifeAttack(c, normDir, world, targets, now)
    : fireHitscan(c, normDir, world, targets, now);

  return result;
}
