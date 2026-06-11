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
import { clamp, yawPitchToDir, normalize } from './math';
import { updateWeapon, getViewPunch, isScoped, switchSlot } from './weapons';
import { gameEvents } from './combat';
import { createCharacterMesh, updateCharacterMesh } from './characters';
import { ViewModel } from './viewmodel';
import { Effects } from './effects';
import { audio } from './audio';

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
// TEMP: dummy respawn state
// ---------------------------------------------------------------------------
interface DummyState {
  combatant: Combatant;
  mesh: THREE.Group;
  spawnPos: { x: number; y: number; z: number };
  respawnAt: number; // clock.now when to respawn, -1 = alive
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
  // Camera must be in scene so viewmodel (parented to camera) renders.
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

  // TEMP: give player knife + usp + ak47, activeSlot primary.
  player.inventory.primary    = makeWeaponState(WEAPONS.ak47);
  player.inventory.activeSlot = 'primary';

  // --- Eye height smooth ---
  let eyeY = player.pos.y + MOVEMENT.EYE_STAND;

  // --- Noclip (TEMP debug) ---
  let noclip = false;

  // --- Effects ---
  const effects = new Effects(scene);

  // --- ViewModel ---
  const viewmodel = new ViewModel(camera);
  {
    const initSlot = player.inventory.activeSlot;
    const initWs =
      initSlot === 'primary'   ? player.inventory.primary :
      initSlot === 'secondary' ? player.inventory.secondary :
      player.inventory.knife;
    viewmodel.setWeapon(initWs?.def.id ?? 'usp');
  }

  // --- Footstep accumulator ---
  let stepAccum = 0;

  // --- FOV scope state ---
  let currentFov = 73;

  // TEMP: subscribe to reload to trigger viewmodel animation.
  gameEvents.on('reload', (ev) => {
    if (ev.who === player) {
      const ws = player.inventory[player.inventory.activeSlot];
      viewmodel.onReloadStart(ws?.def.reloadTime ?? 2.5);
      audio.reload();
    }
  });

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
  lockHint.addEventListener('click', () => {
    input.requestLock();
    audio.unlock();
  });
  document.body.appendChild(lockHint);

  renderer.domElement.addEventListener('click', () => {
    if (!input.locked) {
      input.requestLock();
      audio.unlock();
    }
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

  // --- TEMP: Dummy combatants (CT opponents) ---
  // Three static CT dummies at known Dust2 positions. Feet snapped to floor.
  const DUMMY_SPAWNS: Array<{ x: number; z: number }> = [
    { x: -1,  z: 8  }, // mid
    { x: 26,  z: -10 }, // top of long
    { x: -30, z: -34 }, // B site
  ];

  const dummies: DummyState[] = DUMMY_SPAWNS.map((sp, i) => {
    const floorY = world.floorAt(sp.x, sp.z);
    const y = isFinite(floorY) ? floorY : 0;

    const c = createCombatant(100 + i, `Bot${i}`, 'CT', false);
    c.pos = { x: sp.x, y, z: sp.z };
    c.onGround = true;

    const mesh = createCharacterMesh('CT');
    scene.add(mesh);

    return {
      combatant: c,
      mesh,
      spawnPos: { x: sp.x, y, z: sp.z },
      respawnAt: -1,
    };
  });

  // --- Fixed timestep loop ---
  const FIXED_DT = 1 / 128;
  let accumulator = 0;
  let lastTime    = performance.now() / 1000;
  let frameCount  = 0;
  let fpsTimer    = 0;
  let displayFps  = 0;
  let debugTimer  = 0;

  // Edge tracking for reload key.
  let prevKeyR = false;

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

    // --- Slot switching (outside fixed step for responsiveness) ---
    {
      let slotChanged = false;
      if (input.wasPressed('Digit1') && player.inventory.primary) {
        slotChanged = switchSlot(player, 'primary', clock.now);
      } else if (input.wasPressed('Digit2') && player.inventory.secondary) {
        slotChanged = switchSlot(player, 'secondary', clock.now);
      } else if (input.wasPressed('Digit3')) {
        slotChanged = switchSlot(player, 'knife', clock.now);
      } else if (input.wheelDelta !== 0) {
        // Cycle slots.
        const order: Array<'primary' | 'secondary' | 'knife'> = ['primary', 'secondary', 'knife'];
        const cur  = order.indexOf(player.inventory.activeSlot);
        const next = ((cur + (input.wheelDelta > 0 ? 1 : -1)) + order.length) % order.length;
        const tgt  = order[next];
        if ((tgt === 'primary' && player.inventory.primary) ||
            (tgt === 'secondary' && player.inventory.secondary) ||
            tgt === 'knife') {
          slotChanged = switchSlot(player, tgt, clock.now);
        }
      }

      if (slotChanged) {
        const activeWs = player.inventory[player.inventory.activeSlot];
        viewmodel.setWeapon(activeWs?.def.id ?? player.inventory.activeSlot);
      }
    }

    // Mouse delta for viewmodel sway (accumulated before fixed step).
    const { dx: mouseDxRaw, dy: mouseDyRaw } = input.consumeMouseDelta();

    // Fixed-step ticks.
    while (accumulator >= FIXED_DT) {
      accumulator -= FIXED_DT;
      clock.now += FIXED_DT;

      // Mouse look.
      if (input.locked) {
        const scopedSensScale = isScoped(player) ? 0.4 : 1.0;
        player.yaw   -= mouseDxRaw * input.sensitivity * scopedSensScale;
        player.pitch  = clamp(
          player.pitch - mouseDyRaw * input.sensitivity * scopedSensScale,
          -Math.PI / 2 * 89 / 90,
          Math.PI / 2 * 89 / 90,
        );
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
        const moveEv = simulateMovement(player, intent, world, FIXED_DT, clock.now);

        // --- Footstep audio ---
        if (!player.walking) { // silent walking if walk key held
          stepAccum += moveEv.stepDistance;
          const stepThreshold = Math.sqrt(player.vel.x ** 2 + player.vel.z ** 2) > 3.5 ? 1.7 : 2.4;
          if (stepAccum >= stepThreshold) {
            stepAccum = 0;
            audio.footstep();
          }
        }

        if (moveEv.landed) {
          audio.land();
          stepAccum = 0;
        }
      }

      // --- Weapon input ---
      const activeSlot = player.inventory.activeSlot;
      const activeWs   = player.inventory[activeSlot];
      const def        = activeWs?.def;

      // Trigger: autos — hold LMB; semi — edge only.
      const keyRDown   = input.isDown('KeyR');
      const reloadEdge = keyRDown && !prevKeyR;
      prevKeyR = keyRDown;

      const scopeEdge = input.mouse2Pressed; // RMB edge from Input

      let trigger: boolean;
      if (def && def.auto) {
        trigger = input.mouseDown;
      } else {
        // Semi: use mousePressed (edge) from Input.
        trigger = input.mousePressed;
      }

      const weapInput = {
        trigger,
        reloadPressed: reloadEdge,
        scopePressed:  scopeEdge,
      };

      // TEMP: collect alive dummies as targets.
      const aliveTargets = dummies.map(d => d.combatant);

      const shotResult = updateWeapon(player, world, aliveTargets, weapInput, clock.now, FIXED_DT);

      if (shotResult !== null) {
        const muzzlePos = viewmodel.getMuzzleWorldPos();

        // Viewmodel fire kick.
        viewmodel.onFire();

        // Muzzle flash.
        effects.muzzleFlash(muzzlePos);

        // Tracer.
        effects.tracer(muzzlePos, shotResult.endPoint);

        // Gunshot audio (non-positional for self).
        if (def) audio.gunshot(def.id);

        if (shotResult.target !== null) {
          // Blood + hit effects.
          effects.blood(shotResult.endPoint);
          audio.hitmarker();
          if (shotResult.headshot) audio.headshot();
        } else if (shotResult.surface !== null && shotResult.normal !== null) {
          // World impact + decal.
          effects.impact(shotResult.endPoint, shotResult.normal, 'world');
          effects.addDecal(shotResult.endPoint, shotResult.normal);
        }
      }

      // TEMP: respawn dummies after 3 s.
      for (const ds of dummies) {
        if (!ds.combatant.alive && ds.respawnAt < 0) {
          ds.respawnAt = clock.now + 3;
        }
        if (ds.respawnAt > 0 && clock.now >= ds.respawnAt) {
          ds.respawnAt = -1;
          ds.combatant.alive   = true;
          ds.combatant.health  = 100;
          ds.combatant.deaths  = ds.combatant.deaths; // keep
          ds.combatant.pos     = { ...ds.spawnPos };
          ds.combatant.vel     = { x: 0, y: 0, z: 0 };
        }
      }
    }

    // --- Smooth eye height ---
    const targetEyeY = player.pos.y + (player.crouching ? MOVEMENT.EYE_CROUCH : MOVEMENT.EYE_STAND);
    const eyeSpeed = 10;
    eyeY = eyeY + (targetEyeY - eyeY) * Math.min(1, eyeSpeed * frameDt);

    // --- Scope FOV lerp ---
    const scoped     = isScoped(player);
    const targetFov  = scoped ? 30 : 73;
    currentFov += (targetFov - currentFov) * Math.min(1, 12 * frameDt);
    if (Math.abs(currentFov - targetFov) < 0.1) currentFov = targetFov;
    if (camera.fov !== currentFov) {
      camera.fov = currentFov;
      camera.updateProjectionMatrix();
    }

    // --- Camera placement: yaw/pitch from player + view punch ---
    const punch = getViewPunch(player);
    camera.position.set(player.pos.x, eyeY, player.pos.z);
    camera.rotation.set(player.pitch + punch.pitch, player.yaw + punch.yaw, 0, 'YXZ');

    // --- Update effects ---
    effects.update(frameDt);

    // --- Update dummy character meshes ---
    for (const ds of dummies) {
      updateCharacterMesh(ds.mesh, ds.combatant, frameDt);
    }

    // --- Update viewmodel ---
    viewmodel.update(frameDt, {
      speed:    Math.sqrt(player.vel.x ** 2 + player.vel.z ** 2),
      onGround: player.onGround,
      mouseDx:  mouseDxRaw,
      mouseDy:  mouseDyRaw,
      scoped,
    });

    // --- Audio listener ---
    audio.updateListener(camera);

    // --- Debug readout every 250ms ---
    if (debugTimer >= 0.25) {
      debugTimer = 0;
      const horizSpeed = Math.sqrt(player.vel.x ** 2 + player.vel.z ** 2);
      const activeWsDbg = player.inventory[player.inventory.activeSlot];
      const spreadDeg   = activeWsDbg
        ? (activeWsDbg.def.spreadBase * (180 / Math.PI)).toFixed(2)
        : '—';
      debugDiv.textContent =
        `FPS: ${displayFps}  ` +
        `pos: (${player.pos.x.toFixed(1)}, ${player.pos.y.toFixed(2)}, ${player.pos.z.toFixed(1)})  ` +
        `spd: ${horizSpeed.toFixed(2)} m/s  ` +
        `gnd: ${player.onGround}  ` +
        `wpn: ${activeWsDbg?.def.id ?? '—'}  ` +
        `ammo: ${activeWsDbg?.ammo ?? 0}/${activeWsDbg?.reserve ?? 0}  ` +
        `spread: ${spreadDeg}°` +
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
