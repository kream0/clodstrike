import type { Combatant, WeaponDef, WeaponSlot, GrenadeType } from './types';
import type { World } from './world';
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
    s = { viewPunchPitch: 0, viewPunchYaw: 0, scoped: false, lastShotAt: -1, lastTriggerAt: -1 };
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

// ---------------------------------------------------------------------------
// Shared spread computation (used by both currentSpread() and updateWeapon)
// ---------------------------------------------------------------------------

/**
 * Compute the firing spread cone (radians) for a combatant given a weapon def
 * and the current shot count.
 *
 * Movement accuracy curve (CS2-like): below 34% of moveSpeed the movement
 * penalty is zero (counter-strafe / walk accuracy window).  Above that,
 * the penalty ramps quadratically up to def.spreadMove at full run speed.
 * Spray inaccuracy: def.spreadSpray × min(shotsFired, 10) added on top.
 */
function computeSpread(
  c: Combatant,
  def: WeaponDef,
  scoped: boolean,
  shotsFired: number,
): number {
  if (def.isKnife) return 0;
  if (def.scope && scoped) {
    // AWP scoped: minimal spread; moving keeps penalty via moveFrac logic.
    const horizSpeed = Math.sqrt(c.vel.x * c.vel.x + c.vel.z * c.vel.z);
    const moveFrac   = clamp(horizSpeed / def.moveSpeed, 0, 1);
    if (moveFrac > 0.34) {
      const t = (moveFrac - 0.34) / 0.66;
      return 0.0008 + def.spreadMove * 0.5 * t * t;
    }
    return 0.0008;
  }

  const horizSpeed = Math.sqrt(c.vel.x * c.vel.x + c.vel.z * c.vel.z);
  const moveFrac   = clamp(horizSpeed / def.moveSpeed, 0, 1);

  // Quadratic movement penalty: zero below 0.34, ramps to spreadMove at 1.0.
  let movePenalty = 0;
  if (moveFrac > 0.34) {
    const t = (moveFrac - 0.34) / 0.66;
    movePenalty = def.spreadMove * t * t;
  }

  let spread = def.spreadBase + movePenalty;
  if (!c.onGround) spread += def.spreadAir;
  if (c.crouching) spread *= 0.65;

  // Spray inaccuracy: capped at 10 consecutive shots.
  const sprayShots = Math.min(shotsFired, 10);
  spread += (def.spreadSpray ?? 0) * sprayShots;

  return spread;
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
  return computeSpread(c, def, aim.scoped, ws.shotsFired);
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
  s.lastShotAt     = -1;
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

  // ----- Recoil recovery (suppressed while spraying) -----
  // Suppress recovery during a spray burst so that pattern entries accumulate
  // correctly.  sprayWindow is 1.5× the inter-shot interval, capped at 0.3 s
  // so slow weapons (e.g. AWP bolt ~1.2 s) still recover between shots.
  const sprayWindow = Math.min((60 / def.rpm) * 1.5, 0.3);
  const activelySpraying = aim.lastShotAt >= 0 && (now - aim.lastShotAt) <= sprayWindow;
  if (!activelySpraying) {
    const recovery = def.recoilRecovery * dt;
    aim.viewPunchPitch = aim.viewPunchPitch > 0
      ? Math.max(0, aim.viewPunchPitch - recovery)
      : Math.min(0, aim.viewPunchPitch + recovery);
    aim.viewPunchYaw = aim.viewPunchYaw > 0
      ? Math.max(0, aim.viewPunchYaw - recovery)
      : Math.min(0, aim.viewPunchYaw + recovery);
  }

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
  // shotsFired was just incremented; pass it so spray inaccuracy accounts for
  // the current shot.  Spread function uses min(shotsFired, 10) internally.
  const baseYaw   = c.yaw   + aim.viewPunchYaw;
  const basePitch = c.pitch + aim.viewPunchPitch;

  const spread = def.isKnife ? 0 : computeSpread(c, def, aim.scoped, ws.shotsFired);

  const spreadYaw   = randSpread(spread);
  const spreadPitch = randSpread(spread);

  const shootDir = yawPitchToDir(baseYaw + spreadYaw, basePitch + spreadPitch);
  const normDir  = normalize(shootDir);

  // ----- Recoil application -----
  const pattern = def.recoilPattern;
  if (pattern !== undefined && pattern.length > 0) {
    // Pattern-based recoil: index = shotsFired-1, clamped to last entry.
    const idx   = Math.min(ws.shotsFired - 1, pattern.length - 1);
    const entry = pattern[idx]!;
    const DEG_TO_RAD = Math.PI / 180;
    const jitter     = 1 + randSpread(0.15);  // ±15% determinism noise
    aim.viewPunchPitch += entry[0] * DEG_TO_RAD * jitter;
    aim.viewPunchYaw   += entry[1] * DEG_TO_RAD * jitter;
  } else {
    // Legacy formula (deagle, awp, knife).
    aim.viewPunchPitch += def.recoilPitch * (1 + ws.shotsFired * 0.06);
    const yawPattern = Math.sin(ws.shotsFired * 0.7);
    aim.viewPunchYaw += def.recoilYaw * yawPattern;
  }
  aim.viewPunchPitch = Math.min(aim.viewPunchPitch, 0.35);

  // ----- Execute shot -----
  const result = def.isKnife
    ? knifeAttack(c, normDir, world, targets, now)
    : fireHitscan(c, normDir, world, targets, now);

  return result;
}

// ---------------------------------------------------------------------------
// Grenade equip state machine
// ---------------------------------------------------------------------------

/** Single-tick edge inputs for grenade equip/throw control. */
export interface GrenadeControlInput {
  /** Rising edge: key 4 was pressed this tick (equip / cycle). */
  equipPressed: boolean;
  /** Rising edge: primary fire was pressed this tick (throw). */
  firePressed: boolean;
  /**
   * True if the player switched to a weapon slot (1/2/3/wheel) this tick.
   * Integration MUST pass true whenever switchSlot was called or wheel-scroll
   * triggered a slot change, so the grenade is unequipped immediately.
   */
  slotSwitchPressed?: boolean;
}

/** Returned when the player commits a grenade throw.
 *  Integration routes this to GrenadeManager.throwGrenade(player, request.type). */
export interface ThrowRequest {
  type: GrenadeType;
}

/** Canonical equip order — he → flash → smoke. */
const GRENADE_ORDER: readonly GrenadeType[] = ['he', 'flash', 'smoke'] as const;

/**
 * Return true when the combatant has a grenade equipped (i.e. overlay mode is
 * active and the gun fire path must be suppressed).
 *
 * Integration in main.ts MUST check this before passing `trigger` to
 * updateWeapon — if isGrenadeEquipped(player) is true, pass trigger: false.
 */
export function isGrenadeEquipped(c: Combatant): boolean {
  return (c.equippedGrenade ?? null) !== null;
}

/**
 * Immediately clear the equipped grenade (e.g. called when 1/2/3 or wheel
 * switches weapon slot).  Integration MUST call this alongside switchSlot.
 */
export function cancelGrenadeEquip(c: Combatant): void {
  c.equippedGrenade = null;
}

/**
 * Advance the grenade equip / throw state machine for one fixed-step tick.
 *
 * ### Integration contract (what main.ts must do each tick, in order):
 * 1. Determine `slotSwitchPressed` — true if Digit1/2/3 or wheel fired a
 *    switchSlot call this frame (capture before the fixed-step loop, like
 *    other edge flags).
 * 2. Build `GrenadeControlInput`:
 *    - `equipPressed`     = Digit4 wasPressed edge (captured before loop, honoured first tick only)
 *    - `firePressed`      = mousePressed0 edge (same as gun trigger — honour first tick only)
 *    - `slotSwitchPressed`= as above
 * 3. Call `updateGrenadeEquip(player, inp, clock.now)` **before** calling
 *    `updateWeapon` on the same tick.
 * 4. If a ThrowRequest is returned, call
 *    `GrenadeManager.throwGrenade(player, request.type, eyePos, eyeDir)`.
 * 5. After this call, check `isGrenadeEquipped(player)` to decide whether to
 *    suppress gun firing: pass `trigger: false` to `updateWeapon` while true.
 * 6. `cancelGrenadeEquip` is provided for direct slot-switch paths; you may
 *    alternatively rely on the `slotSwitchPressed` param alone.
 *
 * @param c   - The combatant whose grenade state is updated (mutated in place).
 * @param inp - Edge inputs for this tick.
 * @param _now - Game-time seconds (reserved for future timed animations; unused now).
 * @returns ThrowRequest when the player fires while equipped, null otherwise.
 */
export function updateGrenadeEquip(
  c: Combatant,
  inp: GrenadeControlInput,
  _now: number,
): ThrowRequest | null {
  const grenades = c.grenades;

  // --- Auto-unequip: slot switch input ---
  if (inp.slotSwitchPressed) {
    c.equippedGrenade = null;
  }

  // --- Auto-unequip: equipped type's count hit zero externally ---
  if (c.equippedGrenade != null) {
    const count = grenades?.[c.equippedGrenade] ?? 0;
    if (count <= 0) {
      c.equippedGrenade = null;
    }
  }

  // --- Equip / cycle on key 4 ---
  if (inp.equipPressed) {
    if (grenades == null || GRENADE_ORDER.every(t => (grenades[t] ?? 0) <= 0)) {
      // No grenades owned — no-op.
    } else if (c.equippedGrenade == null) {
      // Equip the first owned type in canonical order.
      for (const type of GRENADE_ORDER) {
        if ((grenades[type] ?? 0) > 0) {
          c.equippedGrenade = type;
          break;
        }
      }
    } else {
      // Cycle to next owned type (wrap around).
      const cur = GRENADE_ORDER.indexOf(c.equippedGrenade);
      let found = false;
      for (let i = 1; i <= GRENADE_ORDER.length; i++) {
        const next = GRENADE_ORDER[(cur + i) % GRENADE_ORDER.length];
        if (next !== undefined && (grenades[next] ?? 0) > 0) {
          c.equippedGrenade = next;
          found = true;
          break;
        }
      }
      if (!found) {
        // Only one type with count > 0 — stays equipped (no change needed).
      }
    }
  }

  // --- Throw on fire while equipped ---
  if (c.equippedGrenade != null && inp.firePressed) {
    const type = c.equippedGrenade;
    c.equippedGrenade = null;
    const count = grenades?.[type] ?? 0;
    if (count > 0) {
      // The core grenade module decrements inventory on actual throw.
      return { type };
    }
    // count somehow 0 — just unequip, no throw.
    return null;
  }

  return null;
}
