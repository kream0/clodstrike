import * as THREE from 'three';
import type { Combatant, Team } from './types';
import { TEAM_COLORS, MOVEMENT } from './constants';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKIN_COLOR       = 0xc9a182;
const HELMET_COLOR     = 0x3a3a3a;
const GUN_COLOR        = 0x222222;

// CT: slightly bluer than base; T: sandy-brown
const TEAM_TORSO: Record<Team, number> = {
  CT: 0x5a7da8,
  T:  0xa8824f,
};

const FALL_DURATION = 0.25;

// State stored on the group for updateCharacterMesh.
interface MeshState {
  prevAlive: boolean;
  deadTimer: number;  // seconds since death, -1 if still alive
  team: Team;
}

// ---------------------------------------------------------------------------
// createCharacterMesh
// ---------------------------------------------------------------------------

export function createCharacterMesh(team: Team): THREE.Group {
  const group = new THREE.Group();

  const torsoColor = TEAM_TORSO[team];
  const teamBase   = TEAM_COLORS[team]; // not used for materials but available

  function box(
    sx: number,
    sy: number,
    sz: number,
    color: number,
    cx = 0,
    cy = 0,
    cz = 0,
  ): THREE.Mesh {
    const geo  = new THREE.BoxGeometry(sx, sy, sz);
    const mat  = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx, cy, cz);
    mesh.castShadow    = true;
    mesh.receiveShadow = false;
    return mesh;
  }

  // --- Legs (two boxes, side by side) ---
  // y 0–0.85
  const legH = 0.85;
  const legW = 0.18;
  const legD = 0.20;
  const leftLeg  = box(legW, legH, legD, torsoColor, -0.11, legH / 2, 0);
  const rightLeg = box(legW, legH, legD, torsoColor,  0.11, legH / 2, 0);

  // --- Torso --- y 0.85–1.50
  const torsoH = 0.65;
  const torsoY = 0.85 + torsoH / 2;
  const torso  = box(0.44, torsoH, 0.26, torsoColor, 0, torsoY, 0);

  // --- Arms (two thin boxes) ---
  // Shoulder at torso top (y≈1.175 center), extending sideways and slightly forward.
  const armH = 0.55;
  const armW = 0.14;
  const armD = 0.14;
  const armY = 0.85 + 0.45;
  const leftArm  = box(armW, armH, armD, torsoColor, -0.29, armY - armH / 2 + 0.1, 0.02);
  const rightArm = box(armW, armH, armD, torsoColor,  0.29, armY - armH / 2 + 0.1, 0.02);

  // --- Head (skin) --- y 1.50–1.72
  const headH = 0.22;
  const headY = 1.50 + headH / 2;
  const head  = box(0.24, headH, 0.26, SKIN_COLOR, 0, headY, 0);

  // --- Helmet (darker box over head) --- y 1.72–1.83 (to match hitbox top)
  const helmetH = 0.11;
  const helmetY = 1.50 + headH + helmetH / 2;
  const helmet  = box(0.27, helmetH, 0.28, HELMET_COLOR, 0, helmetY, 0.0);

  // --- Gun (dark box held in front-right) ---
  const gun = box(0.06, 0.12, 0.38, GUN_COLOR, 0.20, 1.05, -0.22);

  group.add(leftLeg, rightLeg, torso, leftArm, rightArm, head, helmet, gun);

  // Tag with state.
  const state: MeshState = { prevAlive: true, deadTimer: -1, team };
  (group as THREE.Group & { _cs2State: MeshState })._cs2State = state;

  return group;
}

// ---------------------------------------------------------------------------
// updateCharacterMesh
// ---------------------------------------------------------------------------

export function updateCharacterMesh(
  group: THREE.Group,
  c: Combatant,
  dt: number,
  now: number = performance.now() / 1000,
): void {
  const state = (group as THREE.Group & { _cs2State?: MeshState })._cs2State;
  if (!state) return;

  // Position (feet-anchored).
  group.position.set(c.pos.x, c.pos.y, c.pos.z);
  // Mesh faces −Z at yaw 0, matching the convention in math.ts.
  group.rotation.y = c.yaw;

  // Crouch: scale Y toward crouched ratio, keeping feet on ground by
  // translating up by half the lost height (group origin = feet).
  const targetScaleY = c.crouching
    ? MOVEMENT.PLAYER_HEIGHT_CROUCH / MOVEMENT.PLAYER_HEIGHT
    : 1.0;
  group.scale.y += (targetScaleY - group.scale.y) * Math.min(1, 14 * dt);

  // Death animation.
  if (state.prevAlive && !c.alive) {
    state.deadTimer = 0;
  }
  state.prevAlive = c.alive;

  if (!c.alive) {
    if (state.deadTimer >= 0) {
      state.deadTimer += dt;
    }
    const t = state.deadTimer < 0 ? 1 : Math.min(1, state.deadTimer / FALL_DURATION);
    // Fall sideways (rotate around local Z), sink slightly.
    group.rotation.z = (Math.PI / 2) * t;
    group.position.y = c.pos.y - 0.1 * t;
  } else {
    // Ensure reset if respawned.
    if (state.deadTimer >= 0) {
      state.deadTimer = -1;
      group.rotation.z = 0;
    }
    group.rotation.z = 0;

    // Walk leg swing (cheap sin oscillation of the leg children).
    const horizSpeed = Math.sqrt(c.vel.x * c.vel.x + c.vel.z * c.vel.z);
    if (c.onGround && horizSpeed > 0.3) {
      const amp  = 0.25;                           // radians
      const freq = horizSpeed * 2.5;               // cycles per meter ≈ per second at 4 m/s
      const t2   = now;
      const swing = Math.sin(t2 * freq) * amp;
      const leftLeg  = group.children[0] as THREE.Mesh;
      const rightLeg = group.children[1] as THREE.Mesh;
      leftLeg.rotation.x  =  swing;
      rightLeg.rotation.x = -swing;
    } else {
      const leftLeg  = group.children[0] as THREE.Mesh;
      const rightLeg = group.children[1] as THREE.Mesh;
      leftLeg.rotation.x  = 0;
      rightLeg.rotation.x = 0;
    }
  }
}
