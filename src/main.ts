import * as THREE from 'three';
import type { Combatant, Inventory, WeaponDef, WeaponState } from './types';
import type { Team } from './types';
import { WEAPONS, MOVEMENT, ECONOMY } from './constants';
import { DUST2 } from './maps/dust2';
import { MAPS, DEFAULT_MAP_ID, resolveMap, registerSessionMap } from './maps/index';
import { validateMapData } from './maps/validate';
import type { MapData } from './types';
import { World } from './world';
import { Input } from './input';
import { buildMapScene, setupEnvironment } from './builder';
import { simulateMovement } from './movement';
import type { MoveIntent } from './movement';
import { clamp, yawPitchToDir, normalize } from './math';
import { updateWeapon, getViewPunch, isScoped, switchSlot, updateGrenadeEquip, isGrenadeEquipped, cancelGrenadeEquip } from './weapons';
import type { GrenadeControlInput } from './weapons';
import { GrenadeManager } from './grenades';
import { gameEvents } from './combat';
import type { ShotResult } from './combat';
import { createCharacterMesh, updateCharacterMesh, CHARACTER_MODEL_PATHS, THIRD_PERSON_WEAPON_PATHS, setCharacterAssets, setThirdPersonWeaponModels } from './characters';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ViewModel } from './viewmodel';
import { Effects } from './effects';
import { audio } from './audio';
import { Game } from './game';
import type { MatchOptions } from './game';
import { HUD } from './hud';
import { NavGrid } from './bots/nav';
import { BotManager } from './bots/bot';
import {
  loadAllTextures,
  loadAllNormalTextures,
  loadGLB,
} from './assets';
import type { LoadedTextures, TextureSlot } from './assets';
import { makeMatchSeed } from './rng';
import { ReplayRecorder, ReplayCursor } from './replay';
import type { ReplayTickInput, ReplayLog } from './replay';

// ---------------------------------------------------------------------------
// Game-time clock (seconds) — advanced by fixed-step simulation.
// Imported by later agents.
// ---------------------------------------------------------------------------
export const clock = { now: 0 };

// ---------------------------------------------------------------------------
// Helpers (kept local; Game owns the real createCombatant for bots)
// ---------------------------------------------------------------------------

function makeWeaponState(def: WeaponDef): WeaponState {
  return {
    def,
    ammo:       def.magSize,
    reserve:    def.reserveAmmo,
    reloading:  false,
    reloadEnd:  0,
    nextFire:   0,
    shotsFired: 0,
  };
}

function createCombatant(id: number, name: string, team: Team, isPlayer: boolean): Combatant {
  const knife     = makeWeaponState(WEAPONS.knife);
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
    pos:       { x: 0, y: 0, z: 0 },
    vel:       { x: 0, y: 0, z: 0 },
    yaw:       0,
    pitch:     0,
    health:    100,
    armor:     0,
    helmet:    false,
    alive:     true,
    crouching: false,
    walking:   false,
    onGround:  false,
    inventory,
    money:        ECONOMY.START_MONEY,
    kills:        0,
    deaths:       0,
    hasBomb:      false,
    hasDefuseKit: false,
    tagSlowUntil: 0,
  };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Loading overlay helpers
// ---------------------------------------------------------------------------

const TOTAL_ASSETS = 28; // 8 color textures + 8 normals + 9 weapons_v2 GLBs (shared with viewmodel) + 2 rigged character GlTFs + 1 fp_arms GLB

function createLoadingOverlay(): {
  overlay: HTMLDivElement;
  setProgress: (loaded: number) => void;
  remove: () => void;
} {
  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position:       'fixed',
    inset:          '0',
    background:     '#0a0a0a',
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    zIndex:         '9999',
    fontFamily:     'sans-serif',
    transition:     'opacity 0.15s ease',
    opacity:        '1',
  });

  const title = document.createElement('div');
  title.textContent = 'CLODSTRIKE';
  Object.assign(title.style, {
    color:         '#c9a06a',
    fontSize:      '36px',
    fontWeight:    'bold',
    letterSpacing: '0.25em',
    marginBottom:  '16px',
  });

  const subtitle = document.createElement('div');
  subtitle.textContent = 'loading assets…';
  Object.assign(subtitle.style, {
    color:         '#888888',
    fontSize:      '14px',
    marginBottom:  '20px',
    letterSpacing: '0.05em',
  });

  const barWrap = document.createElement('div');
  Object.assign(barWrap.style, {
    width:           '260px',
    height:          '3px',
    background:      '#222222',
    borderRadius:    '2px',
    overflow:        'hidden',
    marginBottom:    '10px',
  });

  const barFill = document.createElement('div');
  Object.assign(barFill.style, {
    height:          '100%',
    width:           '0%',
    background:      '#c9a06a',
    borderRadius:    '2px',
    transition:      'width 0.1s linear',
  });
  barWrap.appendChild(barFill);

  const countLabel = document.createElement('div');
  countLabel.textContent = `0 / ${TOTAL_ASSETS}`;
  Object.assign(countLabel.style, {
    color:     '#666666',
    fontSize:  '12px',
  });

  overlay.appendChild(title);
  overlay.appendChild(subtitle);
  overlay.appendChild(barWrap);
  overlay.appendChild(countLabel);
  document.body.appendChild(overlay);

  function setProgress(loaded: number): void {
    const pct = Math.min(loaded / TOTAL_ASSETS, 1) * 100;
    barFill.style.width = `${pct}%`;
    countLabel.textContent = `${loaded} / ${TOTAL_ASSETS}`;
  }

  function remove(): void {
    overlay.style.opacity = '0';
    setTimeout(() => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 150);
  }

  return { overlay, setProgress, remove };
}

async function boot(): Promise<void> {
  const { setProgress, remove: removeOverlay } = createLoadingOverlay();

  // --- Renderer (created early so anisotropy cap is available) ---
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const app = document.getElementById('app');
  if (!app) throw new Error('Missing #app element');
  app.appendChild(renderer.domElement);

  // ---------------------------------------------------------------------------
  // Asset loading — groups in parallel, each independent
  // Total progress units: 8 color + 8 normals + 9 weapons_v2 GLBs + 2 rigged GlTFs + 1 fp_arms = 28
  // weapons_v2 GLBs are shared between characters.ts (third-person wrist attachments)
  // and viewmodel.ts (first-person weapon models) — loaded once, consumed by both.
  // ---------------------------------------------------------------------------
  let loadedCount = 0;
  function onAssetLoaded(n: number): void {
    loadedCount += n;
    setProgress(loadedCount);
  }

  let textures: LoadedTextures | undefined;
  let normals: Partial<Record<TextureSlot, THREE.Texture>> | undefined;
  let sharedWeaponModels: Record<string, THREE.Object3D> = {};
  let ctGltfResult: GLTF | undefined;
  let tGltfResult:  GLTF | undefined;
  let fpArmsGltfResult: GLTF | undefined;

  try {
    const [texResult, normResult, wpnResults, ctResult, tResult, fpArmsResult] = await Promise.allSettled([
      // Group 1: 8 color textures — callback fires once per loaded texture
      loadAllTextures((_loaded, _total) => {
        onAssetLoaded(1);
      }),
      // Group 2: 8 normal textures
      loadAllNormalTextures((_loaded, _total) => {
        onAssetLoaded(1);
      }),
      // Group 3: 9 weapons_v2 GLBs (shared viewmodel + third-person)
      Promise.allSettled(
        Object.entries(THIRD_PERSON_WEAPON_PATHS).map(
          async ([stem, relPath]) => {
            const gltf = await loadGLB(relPath);
            onAssetLoaded(1);
            return [stem, gltf.scene] as [string, THREE.Object3D];
          },
        ),
      ),
      // Group 4: CT rigged character GlTF (1 progress unit)
      (async (): Promise<GLTF> => {
        const gltf = await loadGLB(CHARACTER_MODEL_PATHS.ct);
        onAssetLoaded(1);
        return gltf;
      })(),
      // Group 5: T rigged character GlTF (1 progress unit)
      (async (): Promise<GLTF> => {
        const gltf = await loadGLB(CHARACTER_MODEL_PATHS.t);
        onAssetLoaded(1);
        return gltf;
      })(),
      // Group 6: fp_arms rigged GLB (1 progress unit) — first-person arms viewmodel
      (async (): Promise<GLTF> => {
        const gltf = await loadGLB('models/rigged/fp_arms.glb');
        onAssetLoaded(1);
        return gltf;
      })(),
    ]);

    // --- Color textures ---
    if (texResult.status === 'fulfilled') {
      textures = texResult.value;
      // Apply anisotropy now that renderer exists (must happen before first render)
      const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      for (const tex of Object.values(textures)) {
        tex.anisotropy = aniso;
        tex.needsUpdate = true;
      }
    } else {
      console.warn('[boot] Color textures failed to load — using legacy colors:', texResult.reason);
    }

    // --- Normal textures ---
    if (normResult.status === 'fulfilled') {
      normals = normResult.value;
      const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      for (const tex of Object.values(normals)) {
        if (tex !== undefined) {
          tex.anisotropy = aniso;
          tex.needsUpdate = true;
        }
      }
    } else {
      console.warn('[boot] Normal textures failed to load — no normals:', normResult.reason);
    }

    // --- weapons_v2 GLBs — shared between third-person wrist attachments and first-person viewmodel ---
    if (wpnResults.status === 'fulfilled') {
      for (const entry of wpnResults.value) {
        if (entry.status === 'fulfilled') {
          const [stem, obj] = entry.value;
          sharedWeaponModels[stem] = obj;
        } else {
          console.warn('[boot] Weapon GLB failed to load:', entry.reason);
        }
      }
    }
    // Register with both consumers: characters.ts (third-person) + viewmodel (first-person)
    setThirdPersonWeaponModels(sharedWeaponModels);

    // --- Rigged character GlTFs ---
    if (ctResult.status === 'fulfilled') {
      ctGltfResult = ctResult.value;
    } else {
      console.warn('[boot] CT rigged character failed to load — using procedural mesh:', ctResult.reason);
    }
    if (tResult.status === 'fulfilled') {
      tGltfResult = tResult.value;
    } else {
      console.warn('[boot] T rigged character failed to load — using procedural mesh:', tResult.reason);
    }

    // --- fp_arms GLB (first-person arms viewmodel) ---
    if (fpArmsResult.status === 'fulfilled') {
      fpArmsGltfResult = fpArmsResult.value;
    } else {
      console.warn('[boot] fp_arms.glb failed to load — viewmodel will render without arms:', fpArmsResult.reason);
    }
  } finally {
    // Overlay is always removed — even on catastrophic failure
    removeOverlay();
  }

  // --- Scene + environment ---
  const scene = new THREE.Scene();
  setupEnvironment(scene);

  // --- Map (with optional textures + normals) ---
  // currentMapId / currentMap / currentGroup are mutable: updated on map swap.
  let currentMapId: string = DEFAULT_MAP_ID;
  let currentMap: MapData  = DUST2;
  let currentGroup = buildMapScene(DUST2, textures, normals).group;
  scene.add(currentGroup);

  // --- World (collision) ---
  let world = new World(DUST2);

  // --- NavGrid (built once at boot from DUST2, shared by all BotManagers) ---
  let navGrid = new NavGrid(DUST2);

  /**
   * Swap the active map scene in-place.
   * Removes the old group, disposes all geometries + materials inside it,
   * builds fresh scene content from newMap, and rebuilds World + NavGrid.
   * Textures/normals are already in memory — no re-download.
   * Called by hud.onStart when the selected map differs from the current one.
   */
  function swapMap(newMapId: string): void {
    if (newMapId === currentMapId) return;

    // Tear down old map scene group.
    scene.remove(currentGroup);
    currentGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) {
          for (const m of obj.material) (m as THREE.Material).dispose();
        } else {
          (obj.material as THREE.Material).dispose();
        }
      }
    });
    const cloned = (currentGroup.userData.clonedTextures as THREE.Texture[] | undefined);
    if (cloned) for (const t of cloned) t.dispose();

    // Build new map scene.
    const newMap = resolveMap(newMapId);
    const { group: newGroup } = buildMapScene(newMap, textures, normals);
    scene.add(newGroup);

    // Rebuild World + NavGrid.
    world   = new World(newMap);
    navGrid = new NavGrid(newMap);
    grenadeManager.setWorld(world);

    // Update game's world and map references (spawn positions + bombsite checks).
    game.setWorld(world);
    game.setMap(newMap);

    // Update HUD radar.
    hud.rerenderRadarBg(newMap);

    // Commit.
    currentGroup = newGroup;
    currentMap   = newMap;
    currentMapId = newMapId;
  }

  // --- Camera ---
  // FOV = 74°  (CS2 default 90° hor+ at 4:3 → 106.26° horiz at 16:9 → vertical ≈ 2·atan(tan(53.13°)/(16/9)) ≈ 73.74° → rounded to 74)
  const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 300);
  camera.rotation.order = 'YXZ';
  scene.add(camera);

  // --- Input ---
  const input = new Input(renderer.domElement);

  // --- Player combatant (owned by main; Game holds a reference) ---
  // Initial position comes from the default map's CT spawn; Game._startRound()
  // will re-position everyone at actual round start using the selected map spawns.
  const player = createCombatant(0, 'Player', 'CT', true);
  {
    const spawn = currentMap.spawns.ct[0];
    const floorY = world.floorAt(spawn.x, spawn.z);
    player.pos = { x: spawn.x, y: isFinite(floorY) ? floorY : 0, z: spawn.z };
    player.yaw = spawn.angle;
  }

  // --- Rigged character assets (must be set before Game so bot mesh creation picks them up) ---
  if (ctGltfResult !== undefined || tGltfResult !== undefined) {
    setCharacterAssets({ ct: ctGltfResult, t: tGltfResult });
  }

  // --- Game ---
  const game = new Game(world, scene);
  game.player = player;

  // --- HUD ---
  const hud = new HUD(document.body, game);

  // --- Effects ---
  const effects = new Effects(scene);

  // --- GrenadeManager ---
  const grenadeManager = new GrenadeManager(scene, world);

  // --- ViewModel ---
  // setWeaponModelsV2 shares the same weapons_v2 scenes already registered with
  // setThirdPersonWeaponModels — no second load; both consumers reference the same objects.
  // setArmsAssets registers fp_arms.glb for visible first-person hands (failure-tolerant:
  // only called when the load succeeded; missing arms degrade gracefully to gun-only).
  const viewmodel = new ViewModel(camera);
  viewmodel.setWeaponModelsV2(sharedWeaponModels);
  viewmodel.setArmsTeam(player.team);
  if (fpArmsGltfResult !== undefined) {
    viewmodel.setArmsAssets(fpArmsGltfResult);
  }
  viewmodel.setWeapon(player.inventory.secondary?.def.id ?? 'usp');

  // --- GrenadeManager callbacks ---
  grenadeManager.onBounce = (pos, speed) => {
    effects.grenadeBounceDust(pos);
    audio.grenadeBounce(pos, speed);
  };
  grenadeManager.onExplosionDamage = (victim, dmg, thrower) => {
    game.applyExplosionDamage(victim, dmg, thrower, 'he');
  };

  // --- BotManager (created/replaced on each match start) ---
  let botManager: BotManager | null = null;

  // Bot shot callback: render tracer + impact effects for bot shots.
  function onBotShot(bot: Combatant, result: ShotResult): void {
    // Cheap visibility cull: only render effects when player is within 80 m.
    const dx = player.pos.x - bot.pos.x;
    const dz = player.pos.z - bot.pos.z;
    const distSq = dx * dx + dz * dz;
    if (distSq > 80 * 80) return;

    // Muzzle position: bot eye + forward 0.4 m.
    const eyeOff   = bot.crouching ? 1.17 : 1.64;
    const sinY     = Math.sin(bot.yaw);
    const cosY     = Math.cos(bot.yaw);
    const muzzle   = {
      x: bot.pos.x - sinY * 0.4,
      y: bot.pos.y + eyeOff,
      z: bot.pos.z - cosY * 0.4,
    };
    effects.tracer(muzzle, result.endPoint);
    if (result.target !== null) {
      effects.blood(result.endPoint);
    } else if (result.surface !== null && result.normal !== null) {
      effects.impact(result.endPoint, result.normal, 'world');
      effects.addDecal(result.endPoint, result.normal);
    }
    audio.gunshot(bot.inventory[bot.inventory.activeSlot]?.def.id ?? 'usp', bot.pos);
  }

  // --- State ---
  let eyeY        = player.pos.y + MOVEMENT.EYE_STAND;
  let noclip      = false;
  let debugVisible = false;
  let paused       = false;
  let stepAccum   = 0;
  let currentFov  = 74; // base FOV matches camera construction (CS2-equivalent)
  let prevKeyR    = false;
  let lastMatchOpts: MatchOptions | null = null;
  // Track the previously equipped grenade type to detect changes for viewmodel sync.
  let prevEquippedGrenade: import('./types').GrenadeType | null = null;

  // --- Replay state ---
  const recorder = new ReplayRecorder();
  // Global tick counter (counts all sim ticks since the last startMatch/restart).
  let globalTick = 0;
  // Replay mode: null = live play; non-null = replaying a log.
  let replayLog: ReplayLog | null = null;
  let replayCursor: ReplayCursor | null = null;
  // Fast-forward state: tick target to reach before switching to real-time playback.
  let replayFfTarget = 0;
  let replayFfDone   = false;
  // Show "Replay finished" briefly before returning to menu.
  let replayFinishedAt = 0; // clock.now when replay ended; 0 = not finished
  const REPLAY_FINISH_DELAY = 2.0; // seconds to show "Replay finished" banner
  // Real-time replay: in-progress frame and tick index within it.
  // Held across RAF calls so we consume exactly one recorded tick per accumulator slot.
  let replayCurrentFrame: import('./replay').ReplayFrame | null = null;
  let replayTickIdx = 0;

  // Death cam state.
  let deathCamPos: THREE.Vector3 | null = null;
  let deathCamTilt = 0; // accumulated downward tilt

  // Spectate state (player-only; cleared on every round start / restart).
  let spectateTargetId: number | null = null;
  // Game-time (clock.now) when the player died and death cam began.
  let deathCamEnterAt  = 0;
  // Reusable vector for spectate camera — avoids per-frame allocations.
  const _specCamPos = new THREE.Vector3();

  // --- Lock / unlock handling ---
  input.onLockChange = (locked) => {
    const hint = document.getElementById('lock-hint');
    if (hint) hint.style.display = locked ? 'none' : 'flex';

    if (!locked && game.phase !== 'menu' && game.phase !== 'matchEnd') {
      // Pointer lost while in-game → pause.
      paused = true;
      hud.showMenu('pause');
    }
    if (locked && paused) {
      paused = false;
      hud.hideMenus();
    }
  };

  // --- HUD callbacks ---
  hud.onStart = (opts) => {
    // Exit any active replay before starting a fresh match.
    replayLog    = null;
    replayCursor = null;
    replayFfDone = false;
    replayFinishedAt = 0;
    hud.setReplayOverlay(false);
    hud.setReplayAvailable(false);

    lastMatchOpts = opts;
    // Resolve seed NOW so main.ts knows it before startMatch runs.
    const resolvedSeed = opts.seed ?? makeMatchSeed();
    const optsWithSeed: MatchOptions = { ...opts, seed: resolvedSeed };

    // Swap map if selection changed (builds new scene, world, navGrid, radar).
    swapMap(opts.mapId ?? DEFAULT_MAP_ID);
    // Reset player to chosen team default loadout (Game will reassign on round start).
    player.team = opts.playerTeam;
    viewmodel.setArmsTeam(opts.playerTeam);
    game.startMatch(optsWithSeed, clock.now);
    // Instantiate BotManager after startMatch so combatants exist.
    botManager?.dispose();
    botManager = new BotManager(game, world, navGrid, onBotShot, currentMap);
    botManager.attach();
    botManager.setSmokeQuery((a, b) => grenadeManager.isSegmentSmoked(a, b));
    grenadeManager.reset();
    prevEquippedGrenade = null;
    // Clear spectate state on new match.
    spectateTargetId = null;
    deathCamPos      = null;
    deathCamTilt     = 0;
    deathCamEnterAt  = 0;
    viewmodel.setVisible(true);
    hud.setSpectateInfo(null);
    hud.hideMenus();
    input.requestLock();
    audio.unlock();

    // Begin recording.
    globalTick = 0;
    recorder.beginMatch(resolvedSeed, {
      playerTeam:  opts.playerTeam,
      difficulty:  opts.difficulty,
      botsPerTeam: opts.botsPerTeam,
      mapId:       opts.mapId,
    });
  };

  hud.onResume = () => {
    paused = false;
    hud.hideMenus();
    input.requestLock();
  };

  hud.onRestart = () => {
    // Exit any active replay before restarting.
    replayLog    = null;
    replayCursor = null;
    replayFfDone = false;
    replayFinishedAt = 0;
    hud.setReplayOverlay(false);
    hud.setReplayAvailable(false);

    if (lastMatchOpts) {
      const resolvedSeed = makeMatchSeed();
      const optsWithSeed: MatchOptions = { ...lastMatchOpts, seed: resolvedSeed };
      game.restart(optsWithSeed, clock.now);
      // Reinstantiate BotManager after restart (map unchanged — lastMatchOpts keeps mapId).
      botManager?.dispose();
      botManager = new BotManager(game, world, navGrid, onBotShot, currentMap);
      botManager.attach();
      botManager.setSmokeQuery((a, b) => grenadeManager.isSegmentSmoked(a, b));
      grenadeManager.reset();
      prevEquippedGrenade = null;
      // Clear spectate state on restart.
      spectateTargetId = null;
      deathCamPos      = null;
      deathCamTilt     = 0;
      deathCamEnterAt  = 0;
      game.setSpectateHiddenBot(null);
      viewmodel.setVisible(true);
      hud.setSpectateInfo(null);
      paused = false;
      hud.hideMenus();
      input.requestLock();

      // Begin new recording.
      globalTick = 0;
      recorder.beginMatch(resolvedSeed, {
        playerTeam:  lastMatchOpts.playerTeam,
        difficulty:  lastMatchOpts.difficulty,
        botsPerTeam: lastMatchOpts.botsPerTeam,
        mapId:       lastMatchOpts.mapId,
      });
    }
  };

  /**
   * Enter replay mode for the given completed-round index (0-based).
   * Abandons the current live match state.
   * Reconstructs game + BotManager from the recorded log, then fast-forwards
   * headlessly to the round's start tick.
   */
  function enterReplay(roundIndex: number): void {
    const log = recorder.endMatch();
    if (log === null || log.frames.length === 0) {
      console.warn('[replay] No log available to replay.');
      return;
    }

    // Flush then grab the current log (endMatch already flushed and returned it).
    replayLog = log;

    // Reset globalTick FIRST so the FF loop starts from 0 and reaches replayFfTarget.
    globalTick = 0;
    noclip = false;

    // Determine the global tick to seek to (start of requested round).
    // roundStartTicks[0] = round 1 start, [1] = round 2, etc.
    // roundIndex 0 means "last/final completed round" → use the last roundStart tick.
    const clampedIdx = Math.max(0, Math.min(roundIndex, log.roundStartTicks.length - 1));
    const seekTick   = log.roundStartTicks[clampedIdx] ?? 0;
    replayFfTarget   = seekTick;
    replayFfDone     = false;
    replayFinishedAt = 0;

    // Release pointer lock (replay doesn't need it).
    document.exitPointerLock();
    paused = false;

    // Reconstruct game + BotManager with recorded seed.
    swapMap(log.opts.mapId ?? DEFAULT_MAP_ID);
    player.team = log.opts.playerTeam;
    viewmodel.setArmsTeam(log.opts.playerTeam);

    game.startMatch({
      playerTeam:  log.opts.playerTeam,
      difficulty:  log.opts.difficulty,
      botsPerTeam: log.opts.botsPerTeam,
      mapId:       log.opts.mapId,
      seed:        log.seed,
    }, 0);

    // Reset clock so the replay runs from time 0.
    clock.now = 0;

    botManager?.dispose();
    botManager = new BotManager(game, world, navGrid, onBotShot, currentMap);
    botManager.attach();
    botManager.setSmokeQuery((a, b) => grenadeManager.isSegmentSmoked(a, b));
    grenadeManager.reset();
    prevEquippedGrenade = null;
    spectateTargetId    = null;
    deathCamPos         = null;
    deathCamTilt        = 0;
    deathCamEnterAt     = 0;
    stepAccum           = 0;
    game.setSpectateHiddenBot(null);
    viewmodel.setVisible(true);
    hud.setSpectateInfo(null);
    hud.hideMenus();

    // Build cursor and seek to the round boundary.
    replayCursor = new ReplayCursor(log);
    replayCursor.seekTick(seekTick);

    // Show REPLAY badge.
    hud.setReplayOverlay(true);

    // Reset accumulator and in-progress frame state so the frame loop starts cleanly.
    accumulator         = 0;
    lastTime            = performance.now() / 1000;
    replayCurrentFrame  = null;
    replayTickIdx       = 0;
  }

  // Wire HUD replay callbacks.
  hud.onWatchReplay = (which) => {
    // 'last' = from pause menu: watch the most recently completed round.
    // 'final' = from match-end screen: watch the last round.
    // Both map to the last recorded roundStart index.
    const lastRoundIdx = recorder.lastCompletedRound - 1;
    if (lastRoundIdx < 0) return; // no completed round yet
    enterReplay(lastRoundIdx);
  };

  hud.onLoadCustomMap = (fileName: string, jsonText: string) => {
    // Parse JSON.
    let rawData: unknown;
    try {
      rawData = JSON.parse(jsonText) as unknown;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      hud.showCustomMapFeedback(`JSON parse error: ${msg}`, 'err');
      return;
    }

    // Validate.
    const result = validateMapData(rawData);
    if (!result.ok) {
      const shown = result.errors.slice(0, 3);
      const extra = result.errors.length - shown.length;
      const lines = shown.join('\n') + (extra > 0 ? `\n(${extra} more error${extra > 1 ? 's' : ''})` : '');
      hud.showCustomMapFeedback(lines, 'err');
      return;
    }

    // Register — derive display name from filename (strip extension).
    const displayName = fileName.replace(/\.[^.]+$/, '') || fileName;
    const mapId = registerSessionMap(displayName, result.map, displayName);

    // Refresh picker and select the new map.
    hud.refreshMapButtons(mapId);
    hud.showCustomMapFeedback(`Loaded: ${displayName} (id: ${mapId})`, 'ok');
  };

  hud.setSensitivityHook(
    () => input.sensitivity,
    (v) => { input.sensitivity = v; },
  );

  // Wire game-time provider so buy menu uses clock.now not wall time.
  hud.getNow = () => clock.now;

  // --- Audio buy events ---
  document.body.addEventListener('hud-buy-success', () => {
    audio.buyClick();
    const slot = player.inventory.activeSlot;
    const ws   = player.inventory[slot];
    viewmodel.setWeapon(ws?.def.id ?? 'usp');
  });
  document.body.addEventListener('hud-buy-fail', () => {
    audio.cantBuy();
  });

  // --- Reload event ---
  gameEvents.on('reload', (ev) => {
    if (ev.who === player) {
      const ws = player.inventory[player.inventory.activeSlot];
      viewmodel.onReloadStart(ws?.def.reloadTime ?? 2.5);
      audio.reload();
    }
  });

  // --- Wallbang penetration impacts ---
  // Both the entry and exit impacts of a penetrating shot are emitted as
  // wallImpact events by combat.ts. Non-penetrating wall hits are still
  // rendered by the existing ShotResult.surface branch below — this handler
  // only fires for penetrating shots to avoid double-rendering.
  gameEvents.on('wallImpact', (ev) => {
    effects.impact(ev.pos, ev.normal, 'world');
    effects.addDecal(ev.pos, ev.normal);
  });

  // --- Kill / damage events ---
  gameEvents.on('kill', (ev) => {
    if (ev.attacker === player) {
      hud.notifyHit(true, ev.headshot);
    }
    // Player death.
    if (ev.victim === player) {
      game.onPlayerDied();
      deathCamPos = new THREE.Vector3(player.pos.x, eyeY, player.pos.z);
      deathCamTilt = 0;
      deathCamEnterAt = clock.now;
      spectateTargetId = null;
      viewmodel.setVisible(false);
      viewmodel.setGrenadeView(null);
      prevEquippedGrenade = null;
      hud.setSpectateInfo(null);
    }
  });

  gameEvents.on('damage', (ev) => {
    if (ev.victim === player && ev.attacker !== null) {
      const attacker = ev.attacker;
      // Compute bearing from attacker to player (yaw delta).
      const dx = player.pos.x - attacker.pos.x;
      const dz = player.pos.z - attacker.pos.z;
      const attackerBearing = Math.atan2(-dx, -dz);
      const delta = attackerBearing - player.yaw;
      hud.notifyDamageFrom(delta);
      audio.hitmarker(); // damage feedback tick
    }
    if (ev.attacker === player && ev.victim !== player) {
      hud.notifyHit(false, ev.hitGroup === 'head');
    }
  });

  // --- Bot footstep positional audio ---
  gameEvents.on('footstep', (ev) => {
    if (ev.who !== player) {
      audio.footstep(ev.who.pos);
    }
  });

  // --- Bomb events ---
  // --- Grenade detonation effects ---
  gameEvents.on('grenadeDetonated', (ev) => {
    const pos = ev.pos;
    if (ev.type === 'he') {
      effects.heExplosion(pos);
      audio.heBoom(pos);
    } else if (ev.type === 'flash') {
      effects.flashBurst(pos);
      audio.flashPop(pos);
    } else {
      // smoke
      audio.smokePop(pos);
    }
  });

  // --- Flash effect on player ---
  gameEvents.on('combatantFlashed', (ev) => {
    if (ev.victim === player) {
      audio.flashRing(ev.intensity);
    }
  });

  gameEvents.on('bombPlanted', (_ev) => {
    audio.bombPlant();
  });

  gameEvents.on('bombDefused', (_ev) => {
    audio.bombDefused();
  });

  gameEvents.on('bombExploded', (_ev) => {
    const center = game.bomb.pos;
    audio.explosion(center);
    effects.explosion(center);
  });

  gameEvents.on('roundEnd', (ev) => {
    const win = (ev.winner === player.team);
    audio.roundEnd(win);
    // Notify recorder so lastCompletedRound increments.
    recorder.notifyRoundEnd();
    // Update HUD button availability.
    hud.setReplayAvailable(recorder.lastCompletedRound > 0);
  });

  // Record round-start tick boundary.
  gameEvents.on('roundStart', () => {
    recorder.markRoundStart(globalTick);
  });

  // Sync viewmodel to active weapon on round start (handles respawn weapon resets).
  gameEvents.on('roundStart', () => {
    const slot = player.inventory.activeSlot;
    const ws   = player.inventory[slot];
    viewmodel.setWeapon(ws?.def.id ?? 'usp');
    viewmodel.setVisible(true);
    viewmodel.setGrenadeView(null);
    prevEquippedGrenade = null;
    grenadeManager.reset();
    // Clear spectate state — player respawns alive next round.
    spectateTargetId = null;
    deathCamPos      = null;
    deathCamTilt     = 0;
    deathCamEnterAt  = 0;
    game.setSpectateHiddenBot(null);
    hud.setSpectateInfo(null);
  });

  // --- Lock hint ---
  const lockHint = document.createElement('div');
  lockHint.id = 'lock-hint';
  lockHint.textContent = 'Click to play';
  Object.assign(lockHint.style, {
    position:      'fixed',
    top:           '50%',
    left:          '50%',
    transform:     'translate(-50%, -50%)',
    color:         '#ffffff',
    fontSize:      '24px',
    fontFamily:    'sans-serif',
    background:    'rgba(0,0,0,0.5)',
    padding:       '16px 32px',
    borderRadius:  '8px',
    pointerEvents: 'auto',
    display:       'flex',
    cursor:        'pointer',
    zIndex:        '10',
  });
  document.body.appendChild(lockHint);

  renderer.domElement.addEventListener('click', () => {
    if (!input.locked && game.phase !== 'menu') {
      input.requestLock();
      audio.unlock();
    }
  });

  // --- Debug div (hidden by default; F3 to toggle) ---
  const debugDiv = document.createElement('div');
  debugDiv.id = 'debug';
  Object.assign(debugDiv.style, {
    position:      'fixed',
    top:           '8px',
    left:          '8px',
    color:         '#ffffff',
    fontSize:      '12px',
    fontFamily:    'monospace',
    background:    'rgba(0,0,0,0.4)',
    padding:       '6px 10px',
    borderRadius:  '4px',
    pointerEvents: 'none',
    zIndex:        '9',
    display:       'none', // hidden by default
  });
  document.body.appendChild(debugDiv);

  // --- Resize ---
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // --- Start with menu ---
  hud.showMenu('start');

  // ---------------------------------------------------------------------------
  // Replay sim tick helper — mirrors the live-play tick body but takes
  // pre-recorded inputs. No audio, no effects, no viewmodel during fast-forward.
  // `edgesConsumed` is true for ticks beyond the first in a frame.
  // NOTE: mirror changes here in the live tick body below (search "LIVE PLAY below").
  // ---------------------------------------------------------------------------
  function _replaySimTick(inp: ReplayTickInput, edgesConsumed: boolean): void {
    const isFreeze    = game.phase === 'freeze';
    const playerAlive = player.alive;

    if (playerAlive && !isFreeze && !noclip) {
      simulateMovement(player, {
        forward: inp.forward,
        strafe:  inp.strafe,
        jump:    inp.jump,
        crouch:  inp.crouch,
        walk:    inp.walk,
      }, world, FIXED_DT, clock.now);
    }

    if (playerAlive && !isFreeze) {
      game.useHeld(player, inp.eHeld, clock.now, FIXED_DT);
    }

    // --- Grenade equip / throw (first tick only, mirrors live path) ---
    if (playerAlive && !isFreeze && !edgesConsumed) {
      const grenadeEquipped = isGrenadeEquipped(player);
      const grenadeInp: GrenadeControlInput = {
        equipPressed:      inp.digit4Pressed,
        firePressed:       grenadeEquipped ? inp.mousePressed : false,
        slotSwitchPressed: inp.slotSwitchThisFrame,
      };
      const throwRequest = updateGrenadeEquip(player, grenadeInp, clock.now);
      if (throwRequest !== null) {
        const eyeHeight = player.crouching ? MOVEMENT.EYE_CROUCH : MOVEMENT.EYE_STAND;
        const throwDir = yawPitchToDir(player.yaw, player.pitch);
        const origin = {
          x: player.pos.x + throwDir.x * 0.3,
          y: player.pos.y + eyeHeight + throwDir.y * 0.3,
          z: player.pos.z + throwDir.z * 0.3,
        };
        grenadeManager.throwGrenade(player, throwRequest.type, origin, throwDir, clock.now);
      }
    }

    const reloadEdge = inp.reloadEdge;
    // Block gun trigger when a grenade is equipped (LMB routed to grenade machine above).
    const grenadeBlocked = isGrenadeEquipped(player);
    const trigger    = (!grenadeBlocked) && (
      player.inventory[player.inventory.activeSlot]?.def.auto
        ? inp.mouseDown
        : (!edgesConsumed && inp.mousePressed)
    );

    if (playerAlive && !isFreeze) {
      updateWeapon(player, world, game.combatants, {
        trigger,
        reloadPressed: reloadEdge,
        scopePressed:  !edgesConsumed && inp.mouse2Pressed,
      }, clock.now, FIXED_DT, game.rng.combat);
    }

    game.update(FIXED_DT, clock.now);
    grenadeManager.update(FIXED_DT, clock.now, game.combatants);
  }

  // --- Fixed timestep loop ---
  const FIXED_DT  = 1 / 128;
  let accumulator = 0;
  let lastTime    = performance.now() / 1000;
  let frameCount  = 0;
  let fpsTimer    = 0;
  let displayFps  = 0;
  let debugTimer  = 0;
  // Maximum replay ticks to simulate per RAF frame during fast-forward (keeps tab responsive).
  const REPLAY_FF_TICKS_PER_FRAME = 2000;

  function frame(): void {
    requestAnimationFrame(frame);

    const now = performance.now() / 1000;
    let frameDt = now - lastTime;
    lastTime = now;
    if (frameDt > 0.1) frameDt = 0.1;

    accumulator += frameDt;
    fpsTimer    += frameDt;
    debugTimer  += frameDt;
    frameCount++;

    if (fpsTimer >= 0.25) {
      displayFps = Math.round(frameCount / fpsTimer);
      frameCount = 0;
      fpsTimer   = 0;
    }

    // F3: debug toggle.
    if (input.wasPressed('F3')) {
      debugVisible = !debugVisible;
      debugDiv.style.display = debugVisible ? 'block' : 'none';
    }

    // Noclip (debug, N key) — disabled in replay.
    if (input.wasPressed('KeyN') && replayLog === null) noclip = !noclip;

    // Escape during replay: exit back to start menu.
    if (replayLog !== null && input.wasPressed('Escape')) {
      replayLog    = null;
      replayCursor = null;
      replayFfDone = false;
      replayFinishedAt = 0;
      hud.setReplayOverlay(false);
      accumulator = 0;
      hud.showMenu('start');
      input.endFrame();
      return; // Prevent live-path code from running with stale replay state this RAF call.
    }

    // --- REPLAY MODE ---
    if (replayLog !== null && replayCursor !== null) {
      // Consume the accumulator to keep real-time cadence but drive from cursor.
      const isFF = !replayFfDone;

      if (isFF) {
        // Fast-forward: batch-simulate up to REPLAY_FF_TICKS_PER_FRAME ticks per RAF frame.
        let ffTicksThisFrame = 0;
        while (globalTick < replayFfTarget && ffTicksThisFrame < REPLAY_FF_TICKS_PER_FRAME) {
          // Pull next frame from cursor if needed.
          if (replayCursor.done) {
            replayFfDone = true;
            break;
          }
          const rframe = replayCursor.nextFrame();
          if (rframe === null) { replayFfDone = true; break; }

          // Apply yaw/pitch for this frame.
          player.yaw   = rframe.yaw;
          player.pitch = rframe.pitch;

          for (let fi = 0; fi < rframe.ticks.length; fi++) {
            if (globalTick >= replayFfTarget || ffTicksThisFrame >= REPLAY_FF_TICKS_PER_FRAME) break;
            const rTick = rframe.ticks[fi]!;
            clock.now += FIXED_DT;
            globalTick++;
            ffTicksThisFrame++;

            // Simulate: movement + weapon + game update (mirrors live tick body).
            if (game.phase !== 'menu') {
              _replaySimTick(rTick, fi > 0);
            }
          }
        }
        if (globalTick >= replayFfTarget) {
          replayFfDone = true;
        }
      } else {
        // Real-time playback: consume EXACTLY one recorded tick per accumulator slot.
        // replayCurrentFrame / replayTickIdx persist across RAF calls so multi-tick
        // frames are spread over multiple accumulator slots at the correct cadence.
        while (accumulator >= FIXED_DT) {
          accumulator -= FIXED_DT;

          if (game.phase === 'menu') continue;

          // Advance to the next frame when the current one is exhausted.
          if (replayCurrentFrame === null || replayTickIdx >= replayCurrentFrame.ticks.length) {
            if (replayCursor.done) {
              // Replay finished.
              if (replayFinishedAt === 0) {
                replayFinishedAt = clock.now;
                hud.showReplayFinished();
              }
              // After the delay, go to start menu.
              if (clock.now - replayFinishedAt >= REPLAY_FINISH_DELAY) {
                replayLog          = null;
                replayCursor       = null;
                replayFfDone       = false;
                replayFinishedAt   = 0;
                replayCurrentFrame = null;
                replayTickIdx      = 0;
                hud.setReplayOverlay(false);
                hud.showMenu('start');
              }
              break;
            }
            const nextFrame = replayCursor.nextFrame();
            if (nextFrame === null) break;
            replayCurrentFrame = nextFrame;
            replayTickIdx      = 0;
            // Apply yaw/pitch when the FIRST tick of this frame is consumed.
            player.yaw   = replayCurrentFrame.yaw;
            player.pitch = replayCurrentFrame.pitch;
          }

          const rTick = replayCurrentFrame.ticks[replayTickIdx]!;
          const isFirstTickInFrame = (replayTickIdx === 0);
          replayTickIdx++;

          clock.now += FIXED_DT;
          globalTick++;
          _replaySimTick(rTick, !isFirstTickInFrame);
        }
      }

      // Render the scene at whatever state we reached.
      effects.update(frameDt);
      game.updateVisuals(frameDt, clock.now);
      hud.update(clock.now, frameDt);
      audio.updateListener(camera);

      // Camera follows recorded player first-person.
      const eyeHeightR = player.crouching ? MOVEMENT.EYE_CROUCH : MOVEMENT.EYE_STAND;
      eyeY = player.pos.y + eyeHeightR;
      camera.position.set(player.pos.x, eyeY, player.pos.z);
      camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');

      renderer.render(scene, camera);
      input.endFrame();
      return; // Skip live-play logic below.
    }

    // --- LIVE PLAY below this point ---

    // Slot switching — outside fixed step for responsiveness.
    // Digit1/2/3 are suppressed while the buy menu is open (HUD consumes them).
    // Track whether a slot switch fired this frame for grenade cancel logic.
    let slotSwitchThisFrame = false;
    if (game.phase !== 'menu' && player.alive) {
      let slotChanged = false;
      if (!hud.buyMenuOpen && input.wasPressed('Digit1') && player.inventory.primary) {
        slotChanged = switchSlot(player, 'primary', clock.now);
      } else if (!hud.buyMenuOpen && input.wasPressed('Digit2') && player.inventory.secondary) {
        slotChanged = switchSlot(player, 'secondary', clock.now);
      } else if (!hud.buyMenuOpen && input.wasPressed('Digit3')) {
        slotChanged = switchSlot(player, 'knife', clock.now);
      } else if (input.wheelDelta !== 0) {
        const order: Array<'primary' | 'secondary' | 'knife'> = ['primary', 'secondary', 'knife'];
        const cur  = order.indexOf(player.inventory.activeSlot);
        const next = ((cur + (input.wheelDelta > 0 ? 1 : -1)) + order.length) % order.length;
        const tgt  = order[next];
        if (
          (tgt === 'primary'   && player.inventory.primary)   ||
          (tgt === 'secondary' && player.inventory.secondary) ||
          tgt === 'knife'
        ) {
          slotChanged = switchSlot(player, tgt, clock.now);
        }
      }
      if (slotChanged) {
        slotSwitchThisFrame = true;
        cancelGrenadeEquip(player);
        viewmodel.setGrenadeView(null);
        const activeWs = player.inventory[player.inventory.activeSlot];
        viewmodel.setWeapon(activeWs?.def.id ?? player.inventory.activeSlot);
      }
    }

    // Mouse delta for viewmodel sway.
    const { dx: mouseDxRaw, dy: mouseDyRaw } = input.consumeMouseDelta();

    // Apply mouse look once per render frame (before fixed-step loop).
    // Must be outside the loop so catch-up ticks don't multiply rotation.
    if (input.locked && !paused && game.phase !== 'menu') {
      const scopedSensScale = isScoped(player) ? 0.4 : 1.0;
      player.yaw   -= mouseDxRaw * input.sensitivity * scopedSensScale;
      player.pitch  = clamp(
        player.pitch - mouseDyRaw * input.sensitivity * scopedSensScale,
        -Math.PI / 2 * 89 / 90,
        Math.PI / 2 * 89 / 90,
      );
      player.yaw = ((player.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    }

    // Capture edge flags before the loop; only honour them on the first tick.
    const mousePressed0  = input.mousePressed;
    const mouse2Pressed0 = input.mouse2Pressed;
    const digit4Pressed0 = input.wasPressed('Digit4');
    let edgesConsumed    = false;

    // When unpausing: clamp the accumulator to avoid a giant catch-up burst.
    // (The accumulator was not advanced while paused, so no burst on resume.)

    // Begin a new recorder frame for this render frame (live play only).
    if (!paused && game.phase !== 'menu') {
      recorder.beginFrame(player.yaw, player.pitch);
    }

    // Fixed-step ticks.
    let recorderFrameStarted = !paused && game.phase !== 'menu';
    while (accumulator >= FIXED_DT) {
      accumulator -= FIXED_DT;

      // While paused or in menu: do not advance clock, do not simulate.
      if (paused || game.phase === 'menu') {
        continue;
      }

      clock.now += FIXED_DT;
      globalTick++;

      const isFreeze   = game.phase === 'freeze';
      const playerAlive = player.alive;

      if (noclip && playerAlive) {
        const NOCLIP_SPEED = 12;
        const sinY = Math.sin(player.yaw);
        const cosY = Math.cos(player.yaw);
        let mx = 0, my = 0, mz = 0;
        if (input.isDown('KeyW')) { mx -= sinY; mz -= cosY; }
        if (input.isDown('KeyS')) { mx += sinY; mz += cosY; }
        if (input.isDown('KeyA')) { mx -= cosY; mz += sinY; }
        if (input.isDown('KeyD')) { mx += cosY; mz -= sinY; }
        if (input.isDown('Space'))       my += 1;
        if (input.isDown('ControlLeft')) my -= 1;
        const ml = Math.sqrt(mx * mx + my * my + mz * mz);
        if (ml > 1e-8) { mx /= ml; my /= ml; mz /= ml; }
        player.pos.x += mx * NOCLIP_SPEED * FIXED_DT;
        player.pos.y += my * NOCLIP_SPEED * FIXED_DT;
        player.pos.z += mz * NOCLIP_SPEED * FIXED_DT;
      } else if (playerAlive && !isFreeze) {
        // Normal movement (freeze: no movement, look only).
        const forward = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
        const strafe  = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0);
        const intent: MoveIntent = {
          forward,
          strafe,
          jump:   input.isDown('Space'),
          crouch: input.isDown('ControlLeft'),
          walk:   input.isDown('ShiftLeft'),
        };
        const moveEv = simulateMovement(player, intent, world, FIXED_DT, clock.now);

        // Footstep audio (player).
        if (!player.walking) {
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

      // E key: plant / defuse.
      const eHeld = input.isDown('KeyE');
      const bombInProgress =
        (game.bomb.state === 'carried' && game.bomb.plantProgress >= 0 && game.bomb.planter === player) ||
        (game.bomb.state === 'planted' && game.bomb.defuseProgress > 0  && game.bomb.defuser === player);

      if (playerAlive && !isFreeze) {
        game.useHeld(player, eHeld, clock.now, FIXED_DT);
      }

      // Weapon input.
      const activeSlot = player.inventory.activeSlot;
      const activeWs   = player.inventory[activeSlot];
      const def        = activeWs?.def;

      const keyRDown   = input.isDown('KeyR');
      const reloadEdge = keyRDown && !prevKeyR;
      prevKeyR = keyRDown;

      // Edge flags must only fire on the first tick of this frame.
      const scopeEdge = !edgesConsumed && mouse2Pressed0;

      // --- Grenade equip / throw (first tick only) ---
      let throwRequest = null;
      if (playerAlive && !isFreeze && !edgesConsumed) {
        const grenadeEquipped = isGrenadeEquipped(player);
        // LMB goes to grenade machine when equipped; gun trigger gets false in that case.
        const grenadeInp: GrenadeControlInput = {
          equipPressed:      digit4Pressed0,
          firePressed:       grenadeEquipped ? mousePressed0 : false,
          slotSwitchPressed: slotSwitchThisFrame,
        };
        throwRequest = updateGrenadeEquip(player, grenadeInp, clock.now);

        // Sync viewmodel grenade view on equip state change.
        const currentEquipped = player.equippedGrenade ?? null;
        if (currentEquipped !== prevEquippedGrenade) {
          viewmodel.setGrenadeView(currentEquipped);
          prevEquippedGrenade = currentEquipped;
        }

        if (throwRequest !== null) {
          // Compute eye position + throw origin nudged 0.3 m along view dir.
          const eyeHeight = player.crouching ? MOVEMENT.EYE_CROUCH : MOVEMENT.EYE_STAND;
          const throwDir = yawPitchToDir(player.yaw, player.pitch);
          const origin = {
            x: player.pos.x + throwDir.x * 0.3,
            y: player.pos.y + eyeHeight + throwDir.y * 0.3,
            z: player.pos.z + throwDir.z * 0.3,
          };
          grenadeManager.throwGrenade(player, throwRequest.type, origin, throwDir, clock.now);
          viewmodel.playThrowAnim(clock.now);
          viewmodel.setGrenadeView(null);
          prevEquippedGrenade = null;
          audio.grenadeThrowWhoosh();
        }
      }

      // ── Spectate logic (player dead only) ──────────────────────────
      if (!playerAlive) {
        const DEATH_CAM_DURATION = 1.2; // seconds of death-cam before auto-spectate

        // Helper: find living teammates (not the player), ordered by combatants array.
        const liveTeammates = game.combatants.filter(
          c => !c.isPlayer && c.team === player.team && c.alive,
        );

        // Transition: death cam → spectate after DEATH_CAM_DURATION.
        if (spectateTargetId === null && clock.now - deathCamEnterAt >= DEATH_CAM_DURATION) {
          if (liveTeammates.length > 0) {
            const first = liveTeammates[0]!;
            spectateTargetId = first.id;
            game.setSpectateHiddenBot(spectateTargetId);
            hud.setSpectateInfo(first.name);
          }
          // else: no teammates alive — stay in death cam (spectateTargetId remains null).
        }

        // Auto-advance: current target died.
        if (spectateTargetId !== null) {
          const currentTarget = game.combatants.find(c => c.id === spectateTargetId);
          if (currentTarget === undefined || !currentTarget.alive) {
            // Target died — advance to next living teammate.
            if (liveTeammates.length > 0) {
              const next = liveTeammates[0]!;
              spectateTargetId = next.id;
              game.setSpectateHiddenBot(spectateTargetId);
              hud.setSpectateInfo(next.name);
            } else {
              // No living teammates — fall back to death cam.
              spectateTargetId = null;
              game.setSpectateHiddenBot(null);
              hud.setSpectateInfo(null);
            }
          }
        }

        // Cycle: left-click while spectating → advance to next living teammate.
        if (spectateTargetId !== null && !edgesConsumed && mousePressed0) {
          // Find current target's position in the liveTeammates list.
          const idx = liveTeammates.findIndex(c => c.id === spectateTargetId);
          if (liveTeammates.length > 0) {
            const nextIdx = (idx + 1) % liveTeammates.length;
            const next = liveTeammates[nextIdx]!;
            spectateTargetId = next.id;
            game.setSpectateHiddenBot(spectateTargetId);
            hud.setSpectateInfo(next.name);
          }
          edgesConsumed = true;
        }
      }
      // ── End spectate logic ──────────────────────────────────────────

      let trigger: boolean;
      if (def && def.auto) {
        trigger = input.mouseDown;
      } else {
        trigger = !edgesConsumed && mousePressed0;
      }

      // Record this tick's effective inputs (before edgesConsumed is set, so we
      // capture the correct per-tick flags for the first tick).
      // Build the ReplayTickInput from the same values that will be fed to the sim.
      {
        const tickInp: ReplayTickInput = {
          forward:             playerAlive && !isFreeze ? (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0) : 0,
          strafe:              playerAlive && !isFreeze ? (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0) : 0,
          jump:                input.isDown('Space'),
          crouch:              input.isDown('ControlLeft'),
          walk:                input.isDown('ShiftLeft'),
          eHeld,
          mouseDown:           input.mouseDown,
          mousePressed:        !edgesConsumed && mousePressed0,
          mouse2Pressed:       !edgesConsumed && mouse2Pressed0,
          reloadEdge,
          digit4Pressed:       !edgesConsumed && digit4Pressed0,
          wheelDelta:          input.wheelDelta,
          slotSwitchThisFrame,
        };
        recorder.recordTick(tickInp);
      }

      edgesConsumed = true;

      // Block gun fire while grenade is equipped (LMB routed to grenade machine above).
      if (isGrenadeEquipped(player)) trigger = false;

      // Block firing while plant/defuse in progress.
      if (bombInProgress) trigger = false;

      const targets = game.combatants;

      let shotResult = null;
      if (playerAlive && !isFreeze) {
        shotResult = updateWeapon(player, world, targets, {
          trigger,
          reloadPressed: reloadEdge,
          scopePressed:  scopeEdge,
        }, clock.now, FIXED_DT, game.rng.combat);
      }

      if (shotResult !== null) {
        const muzzlePos = viewmodel.getMuzzleWorldPos();
        viewmodel.onFire();
        effects.muzzleFlash(muzzlePos);
        effects.tracer(muzzlePos, shotResult.endPoint);
        if (def) audio.gunshot(def.id);

        if (shotResult.target !== null) {
          effects.blood(shotResult.endPoint);
          audio.hitmarker();
          if (shotResult.headshot) audio.headshot();
        } else if (shotResult.surface !== null && shotResult.normal !== null) {
          effects.impact(shotResult.endPoint, shotResult.normal, 'world');
          effects.addDecal(shotResult.endPoint, shotResult.normal);
        }
      }

      // Game state machine.
      // NOTE: mirror changes here in _replaySimTick (replay).
      game.update(FIXED_DT, clock.now);

      // Grenade physics + detonation (after player + bot sim updates).
      grenadeManager.update(FIXED_DT, clock.now, game.combatants);

      // Bomb beep.
      if (game.shouldBeep(clock.now)) {
        audio.bombBeep(game.bomb.pos);
      }
    }
    // Flush the recorder frame at the end of each render frame (live play).
    if (recorderFrameStarted) {
      recorder.flushFrame();
    }

    // --- Smooth eye height ---
    let targetEyeY: number;
    if (!player.alive && spectateTargetId === null && deathCamPos) {
      // Death cam: fixed at death position, slight downward tilt.
      deathCamTilt = Math.min(deathCamTilt + frameDt * 0.3, 0.25);
    } else if (!player.alive && spectateTargetId !== null) {
      // Spectating: no death cam tilt needed.
      deathCamTilt = 0;
    } else {
      deathCamPos = null;
      deathCamTilt = 0;
      targetEyeY = player.pos.y + (player.crouching ? MOVEMENT.EYE_CROUCH : MOVEMENT.EYE_STAND);
      eyeY = eyeY + (targetEyeY - eyeY) * Math.min(1, 10 * frameDt);
    }

    // --- Scope FOV ---
    // Scope zoom (30°) keeps the same absolute value: the ratio 30/73 ≈ 41% of base
    // is deliberately kept as a fixed tight-zoom regardless of base FOV change.
    const scoped    = isScoped(player);
    const targetFov = scoped ? 30 : 74;
    currentFov += (targetFov - currentFov) * Math.min(1, 12 * frameDt);
    if (Math.abs(currentFov - targetFov) < 0.1) currentFov = targetFov;
    if (camera.fov !== currentFov) {
      camera.fov = currentFov;
      camera.updateProjectionMatrix();
    }

    // --- Camera placement ---
    const punch = getViewPunch(player);
    if (!player.alive && spectateTargetId !== null) {
      // First-person spectate: view from inside the target's head.
      const target = game.combatants.find(c => c.id === spectateTargetId);
      if (target !== undefined) {
        const eyeOff = target.crouching ? MOVEMENT.EYE_CROUCH : MOVEMENT.EYE_STAND;
        _specCamPos.set(target.pos.x, target.pos.y + eyeOff, target.pos.z);
        camera.position.copy(_specCamPos);
        camera.rotation.set(target.pitch, target.yaw, 0, 'YXZ');
      }
    } else if (!player.alive && deathCamPos) {
      camera.position.copy(deathCamPos);
      camera.rotation.set(-deathCamTilt + punch.pitch, player.yaw + punch.yaw, 0, 'YXZ');
    } else {
      camera.position.set(player.pos.x, eyeY, player.pos.z);
      camera.rotation.set(player.pitch + punch.pitch, player.yaw + punch.yaw, 0, 'YXZ');
    }

    // --- Update systems ---
    effects.update(frameDt);
    game.updateVisuals(frameDt, clock.now);
    hud.update(clock.now, frameDt);
    audio.updateListener(camera);

    // --- Update viewmodel ---
    viewmodel.update(frameDt, {
      speed:    Math.sqrt(player.vel.x ** 2 + player.vel.z ** 2),
      onGround: player.onGround,
      mouseDx:  mouseDxRaw,
      mouseDy:  mouseDyRaw,
      scoped,
    });

    renderer.render(scene, camera);

    // --- Debug readout (read renderer.info AFTER render so counts are current) ---
    if (debugVisible && debugTimer >= 0.25) {
      debugTimer = 0;
      const horizSpeed  = Math.sqrt(player.vel.x ** 2 + player.vel.z ** 2);
      const activeWsDbg = player.inventory[player.inventory.activeSlot];
      const ri = renderer.info;
      debugDiv.textContent =
        `FPS: ${displayFps}  ` +
        `pos: (${player.pos.x.toFixed(1)}, ${player.pos.y.toFixed(2)}, ${player.pos.z.toFixed(1)})  ` +
        `spd: ${horizSpeed.toFixed(2)} m/s  ` +
        `gnd: ${player.onGround}  ` +
        `wpn: ${activeWsDbg?.def.id ?? '—'}  ` +
        `ammo: ${activeWsDbg?.ammo ?? 0}/${activeWsDbg?.reserve ?? 0}  ` +
        `phase: ${game.phase}  ` +
        (noclip ? '[NOCLIP]  ' : '') +
        `dc: ${ri.render.calls}  tri: ${ri.render.triangles}  geo: ${ri.memory.geometries}  tex: ${ri.memory.textures}`;
    }
    input.endFrame();
  }

  requestAnimationFrame(frame);
}

// Boot after DOM ready.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void boot(); });
} else {
  void boot();
}
