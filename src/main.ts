import * as THREE from 'three';
import type { Combatant, Inventory, WeaponDef, WeaponState } from './types';
import type { Team } from './types';
import { WEAPONS, MOVEMENT, ECONOMY } from './constants';
import { DUST2 } from './maps/dust2';
import { World } from './world';
import { Input } from './input';
import { buildMapScene, setupEnvironment } from './builder';
import { simulateMovement } from './movement';
import type { MoveIntent } from './movement';
import { clamp } from './math';

// ---------------------------------------------------------------------------
// Game-time clock (seconds) — advanced by fixed-step simulation.
// Imported by later agents.
// ---------------------------------------------------------------------------
export const clock = { now: 0 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWeaponState(def: WeaponDef): WeaponState {
  return {
    def,
    ammo:      def.magSize,
    reserve:   def.reserveAmmo,
    reloading: false,
    reloadEnd: 0,
    nextFire:  0,
    shotsFired: 0,
  };
}

function createCombatant(id: number, name: string, team: Team, isPlayer: boolean): Combatant {
  const knife = makeWeaponState(WEAPONS.knife);
  const secondary = makeWeaponState(team === 'CT' ? WEAPONS.usp : WEAPONS.glock);

  const inventory: Inventory = {
    knife,
    secondary,
    primary: null,
    activeSlot: 'secondary',
  };

  return {
    id,
    name,
    team,
    isPlayer,
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    health: 100,
    armor: 0,
    helmet: false,
    alive: true,
    crouching: false,
    walking: false,
    onGround: false,
    inventory,
    money: ECONOMY.START_MONEY,
    kills: 0,
    deaths: 0,
    hasBomb: false,
    hasDefuseKit: false,
    tagSlowUntil: 0,
  };
}

// ---------------------------------------------------------------------------
// Bootstrap (after DOM ready)
// ---------------------------------------------------------------------------

function boot(): void {
  // --- Renderer ---
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const app = document.getElementById('app');
  if (!app) throw new Error('Missing #app element');
  app.appendChild(renderer.domElement);

  // --- Scene + environment ---
  const scene = new THREE.Scene();
  setupEnvironment(scene);

  // --- Map ---
  const { group } = buildMapScene(DUST2);
  scene.add(group);

  // --- World (collision) ---
  const world = new World(DUST2);

  // --- Camera ---
  const camera = new THREE.PerspectiveCamera(73, window.innerWidth / window.innerHeight, 0.05, 300);
  camera.rotation.order = 'YXZ';
  scene.add(camera);

  // --- Input ---
  const input = new Input(renderer.domElement);
  input.onLockChange = (locked) => {
    const hint = document.getElementById('lock-hint');
    if (hint) hint.style.display = locked ? 'none' : 'flex';
  };

  // --- Player ---
  const spawn = DUST2.spawns.t[0];
  const player = createCombatant(0, 'Player', 'T', true);
  player.pos = {
    x: spawn.x,
    y: DUST2.legend[DUST2.grid[
      Math.floor((spawn.z - DUST2.origin.z) / DUST2.cellSize)
    ][Math.floor((spawn.x - DUST2.origin.x) / DUST2.cellSize)]]?.floor ?? 1.5,
    z: spawn.z,
  };
  player.yaw = spawn.angle;

  // --- Eye height smooth ---
  let eyeY = player.pos.y + MOVEMENT.EYE_STAND;

  // --- Noclip (TEMP debug) ---
  let noclip = false;

  // --- UI: lock hint ---
  const lockHint = document.createElement('div');
  lockHint.id = 'lock-hint';
  lockHint.textContent = 'Click to play';
  Object.assign(lockHint.style, {
    position:       'fixed',
    top:            '50%',
    left:           '50%',
    transform:      'translate(-50%, -50%)',
    color:          '#ffffff',
    fontSize:       '24px',
    fontFamily:     'sans-serif',
    background:     'rgba(0,0,0,0.5)',
    padding:        '16px 32px',
    borderRadius:   '8px',
    pointerEvents:  'auto',
    display:        'flex',
    cursor:         'pointer',
    zIndex:         '10',
  });
  lockHint.addEventListener('click', () => input.requestLock());
  document.body.appendChild(lockHint);

  renderer.domElement.addEventListener('click', () => {
    if (!input.locked) input.requestLock();
  });

  // --- Debug div ---
  const debugDiv = document.createElement('div');
  debugDiv.id = 'debug';
  Object.assign(debugDiv.style, {
    position:   'fixed',
    top:        '8px',
    left:       '8px',
    color:      '#ffffff',
    fontSize:   '12px',
    fontFamily: 'monospace',
    background: 'rgba(0,0,0,0.4)',
    padding:    '6px 10px',
    borderRadius: '4px',
    pointerEvents: 'none',
    zIndex:     '9',
  });
  document.body.appendChild(debugDiv);

  // --- Resize ---
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // --- Fixed timestep loop ---
  const FIXED_DT = 1 / 128;
  let accumulator = 0;
  let lastTime    = performance.now() / 1000;
  let frameCount  = 0;
  let fpsTimer    = 0;
  let displayFps  = 0;
  let debugTimer  = 0;

  function frame(): void {
    requestAnimationFrame(frame);

    const now = performance.now() / 1000;
    let frameDt = now - lastTime;
    lastTime = now;
    if (frameDt > 0.1) frameDt = 0.1; // clamp

    accumulator += frameDt;
    fpsTimer    += frameDt;
    debugTimer  += frameDt;
    frameCount++;

    if (fpsTimer >= 0.25) {
      displayFps = Math.round(frameCount / fpsTimer);
      frameCount = 0;
      fpsTimer   = 0;
    }

    // --- Noclip toggle (TEMP) ---
    if (input.wasPressed('KeyN')) noclip = !noclip;

    // Fixed-step ticks.
    while (accumulator >= FIXED_DT) {
      accumulator -= FIXED_DT;
      clock.now += FIXED_DT;

      // Mouse look.
      if (input.locked) {
        const { dx, dy } = input.consumeMouseDelta();
        player.yaw   -= dx * input.sensitivity;
        player.pitch  = clamp(player.pitch - dy * input.sensitivity, -Math.PI / 2 * 89 / 90, Math.PI / 2 * 89 / 90);
        // Normalize yaw to [-PI, PI].
        player.yaw = ((player.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      }

      if (noclip) {
        // TEMP: fly mode — move along view dir at 12 m/s.
        const NOCLIP_SPEED = 12;
        const sinY = Math.sin(player.yaw);
        const cosY = Math.cos(player.yaw);
        const fwdX = -sinY;
        const fwdZ = -cosY;
        const upY  = 1;

        let mx = 0, my = 0, mz = 0;
        if (input.isDown('KeyW')) { mx += fwdX; mz += fwdZ; }
        if (input.isDown('KeyS')) { mx -= fwdX; mz -= fwdZ; }
        if (input.isDown('KeyA')) { mx -= cosY; mz += sinY; }
        if (input.isDown('KeyD')) { mx += cosY; mz -= sinY; }
        if (input.isDown('Space'))        my += 1;
        if (input.isDown('ControlLeft'))  my -= 1;
        const ml = Math.sqrt(mx * mx + my * my + mz * mz);
        if (ml > 1e-8) { mx /= ml; my /= ml; mz /= ml; }
        player.pos.x += mx * NOCLIP_SPEED * FIXED_DT;
        player.pos.y += my * NOCLIP_SPEED * FIXED_DT;
        player.pos.z += mz * NOCLIP_SPEED * FIXED_DT;
      } else {
        // Normal movement.
        const forward = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
        const strafe  = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0);
        const intent: MoveIntent = {
          forward,
          strafe,
          jump:    input.isDown('Space'),
          crouch:  input.isDown('ControlLeft'),
          walk:    input.isDown('ShiftLeft'),
        };
        simulateMovement(player, intent, world, FIXED_DT, clock.now);
      }
    }

    // Smooth eye height.
    const targetEyeY = player.pos.y + (player.crouching ? MOVEMENT.EYE_CROUCH : MOVEMENT.EYE_STAND);
    const eyeSpeed = 10;
    eyeY = eyeY + (targetEyeY - eyeY) * Math.min(1, eyeSpeed * frameDt);

    // Camera placement.
    camera.position.set(player.pos.x, eyeY, player.pos.z);
    camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');

    // Debug readout every 250ms.
    if (debugTimer >= 0.25) {
      debugTimer = 0;
      const horizSpeed = Math.sqrt(player.vel.x ** 2 + player.vel.z ** 2);
      debugDiv.textContent =
        `FPS: ${displayFps}  ` +
        `pos: (${player.pos.x.toFixed(1)}, ${player.pos.y.toFixed(2)}, ${player.pos.z.toFixed(1)})  ` +
        `spd: ${horizSpeed.toFixed(2)} m/s  ` +
        `gnd: ${player.onGround}` +
        (noclip ? '  [NOCLIP]' : '');
    }

    renderer.render(scene, camera);
    input.endFrame();
  }

  requestAnimationFrame(frame);
}

// Boot after DOM ready.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
