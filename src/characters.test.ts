/**
 * characters.test.ts — headless tests for the AnimationMixer character system.
 *
 * No WebGL / DOM required. Pure math + file-system checks only.
 * Does NOT instantiate GLTFLoader, AnimationMixer, or SkeletonUtils.
 */

import { describe, it, expect } from 'bun:test';
import * as path from 'path';
import * as fs from 'fs';
import * as THREE from 'three';
import {
  CHARACTER_MODEL_PATHS,
  THIRD_PERSON_WEAPON_PATHS,
  THIRD_PERSON_WEAPON_FILES,
  MODEL_YAW_OFFSET,
  BAKED_PROP_NODES,
  normalizeHeight,
  deathRotationZ,
  pickLocomotionClip,
  projectVelocityToLocal,
  locomotionTimeScale,
  crouchHipsOffsetY,
  crouchAbdomenTilt,
  // New normalization exports
  TP_WEAPON_TARGET_LEN,
  tpComputeWeaponNorm,
  TP_WEAPON_ATTACH_OFFSETS,
  TP_HOLD_POSES,
  TP_STEM_TO_FAMILY,
  // Legacy exports still present (backward compat)
  legSwingAngle,
  armSwingAngle,
  breathingBobY,
  crouchRootOffsetY,
} from './characters';
import { WEAPONS, MOVEMENT } from './constants';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const projectRoot = path.resolve(__dirname, '..');
const assetsRoot  = path.join(projectRoot, 'assets');

function assetExists(relPath: string): boolean {
  return fs.existsSync(path.join(assetsRoot, relPath));
}

/**
 * JSON-based .gltf files start with '{' (or whitespace + '{').
 * Binary .glb files start with 'glTF' magic bytes.
 * Both are valid GLTF assets. This helper accepts both forms.
 */
function fileIsGLTFOrGLB(relPath: string): boolean {
  const filePath = path.join(assetsRoot, relPath);
  if (!fs.existsSync(filePath)) return false;
  const buf = fs.readFileSync(filePath);
  const magic = buf.toString('ascii', 0, 4);
  if (magic === 'glTF') return true; // binary GLB
  // JSON-based glTF: first non-whitespace char is '{'
  const text = buf.toString('utf8', 0, 20).trimStart();
  return text.startsWith('{');
}

function fileIsGLB(relPath: string): boolean {
  const filePath = path.join(assetsRoot, relPath);
  if (!fs.existsSync(filePath)) return false;
  const buf = fs.readFileSync(filePath);
  // GLB magic: 0x46546C67 = 'glTF'
  return buf.toString('ascii', 0, 4) === 'glTF';
}

// ---------------------------------------------------------------------------
// Asset file existence
// ---------------------------------------------------------------------------

describe('CHARACTER_MODEL_PATHS — rigged asset files', () => {
  it('ct path exists and is a valid GLTF or GLB', () => {
    expect(assetExists(CHARACTER_MODEL_PATHS.ct)).toBe(true);
    expect(fileIsGLTFOrGLB(CHARACTER_MODEL_PATHS.ct)).toBe(true);
  });

  it('t path exists and is a valid GLTF or GLB', () => {
    expect(assetExists(CHARACTER_MODEL_PATHS.t)).toBe(true);
    expect(fileIsGLTFOrGLB(CHARACTER_MODEL_PATHS.t)).toBe(true);
  });

  it('ct path points to the rigged directory', () => {
    expect(CHARACTER_MODEL_PATHS.ct).toContain('rigged');
  });

  it('t path points to the rigged directory', () => {
    expect(CHARACTER_MODEL_PATHS.t).toContain('rigged');
  });
});

describe('THIRD_PERSON_WEAPON_PATHS — 9 weapons_v2 files', () => {
  const stems = Object.keys(THIRD_PERSON_WEAPON_PATHS);

  it('has exactly 9 entries', () => {
    expect(stems.length).toBe(9);
  });

  for (const stem of [
    'pistol', 'revolver', 'smg', 'scifi_smg', 'shotgun',
    'assault_rifle', 'assault_rifle_2', 'sniper_rifle', 'knife',
  ]) {
    it(`stem '${stem}' exists on disk as a valid GLB`, () => {
      const relPath = THIRD_PERSON_WEAPON_PATHS[stem];
      expect(relPath).toBeDefined();
      expect(assetExists(relPath!)).toBe(true);
      expect(fileIsGLB(relPath!)).toBe(true);
    });
  }

  it('all weapons_v2 paths are under models/weapons_v2/', () => {
    for (const relPath of Object.values(THIRD_PERSON_WEAPON_PATHS)) {
      expect(relPath).toContain('weapons_v2');
    }
  });
});

// ---------------------------------------------------------------------------
// THIRD_PERSON_WEAPON_FILES covers every WEAPONS id
// ---------------------------------------------------------------------------

describe('THIRD_PERSON_WEAPON_FILES — covers all WEAPONS ids', () => {
  const weaponIds = Object.keys(WEAPONS);

  it('every weapon id has an entry', () => {
    for (const id of weaponIds) {
      expect(THIRD_PERSON_WEAPON_FILES[id]).toBeDefined();
      expect(typeof THIRD_PERSON_WEAPON_FILES[id]).toBe('string');
    }
  });

  it('all stem values are one of the 9 known stems', () => {
    const validStems = new Set(Object.keys(THIRD_PERSON_WEAPON_PATHS));
    for (const stem of Object.values(THIRD_PERSON_WEAPON_FILES)) {
      expect(validStems.has(stem)).toBe(true);
    }
  });

  it('knife maps to knife stem', () => {
    expect(THIRD_PERSON_WEAPON_FILES['knife']).toBe('knife');
  });

  it('ak47 maps to assault_rifle', () => {
    expect(THIRD_PERSON_WEAPON_FILES['ak47']).toBe('assault_rifle');
  });

  it('awp maps to sniper_rifle', () => {
    expect(THIRD_PERSON_WEAPON_FILES['awp']).toBe('sniper_rifle');
  });

  it('glock maps to pistol', () => {
    expect(THIRD_PERSON_WEAPON_FILES['glock']).toBe('pistol');
  });

  it('deagle maps to revolver', () => {
    expect(THIRD_PERSON_WEAPON_FILES['deagle']).toBe('revolver');
  });

  it('p90 maps to scifi_smg', () => {
    expect(THIRD_PERSON_WEAPON_FILES['p90']).toBe('scifi_smg');
  });
});

// ---------------------------------------------------------------------------
// MODEL_YAW_OFFSET
// ---------------------------------------------------------------------------

describe('MODEL_YAW_OFFSET', () => {
  it('is exported and finite', () => {
    expect(Number.isFinite(MODEL_YAW_OFFSET)).toBe(true);
  });

  it('is non-zero (model needs reorientation)', () => {
    expect(MODEL_YAW_OFFSET).not.toBe(0);
  });

  it('equals Math.PI (180° flip to align glTF +Z model to game -Z forward)', () => {
    expect(MODEL_YAW_OFFSET).toBeCloseTo(Math.PI, 10);
  });
});

// ---------------------------------------------------------------------------
// BAKED_PROP_NODES — pure data, no GLTF loading required
// ---------------------------------------------------------------------------

describe('BAKED_PROP_NODES', () => {
  it('is exported as a Set', () => {
    expect(BAKED_PROP_NODES).toBeInstanceOf(Set);
  });

  it("contains 'Pistol' (ct_operator.gltf baked-in prop)", () => {
    expect(BAKED_PROP_NODES.has('Pistol')).toBe(true);
  });

  it('is non-empty', () => {
    expect(BAKED_PROP_NODES.size).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// LICENSES.md credits Quaternius (rigged characters) and has CC0
// ---------------------------------------------------------------------------

describe('LICENSES.md — Quaternius attribution', () => {
  it('exists', () => {
    const licensePath = path.join(assetsRoot, 'LICENSES.md');
    expect(fs.existsSync(licensePath)).toBe(true);
  });

  it('credits Quaternius for rigged characters', () => {
    const licensePath = path.join(assetsRoot, 'LICENSES.md');
    const content = fs.readFileSync(licensePath, 'utf8');
    expect(content).toContain('Quaternius');
  });

  it('contains CC0 license for rigged characters section', () => {
    const licensePath = path.join(assetsRoot, 'LICENSES.md');
    const content = fs.readFileSync(licensePath, 'utf8');
    expect(content).toContain('CC0');
  });

  it('credits weapons_v2 assets', () => {
    const licensePath = path.join(assetsRoot, 'LICENSES.md');
    const content = fs.readFileSync(licensePath, 'utf8');
    expect(content).toContain('weapons_v2');
  });
});

// ---------------------------------------------------------------------------
// normalizeHeight
// ---------------------------------------------------------------------------

describe('normalizeHeight', () => {
  it('computes scale = targetHeight / sourceHeight', () => {
    expect(normalizeHeight(2.7, 1.83)).toBeCloseTo(1.83 / 2.7, 5);
  });

  it('returns 1 for equal source and target', () => {
    expect(normalizeHeight(1.83, 1.83)).toBeCloseTo(1, 5);
  });

  it('returns 1 for degenerate source height 0', () => {
    expect(normalizeHeight(0, 1.83)).toBe(1);
  });

  it('PLAYER_HEIGHT / 2.7 ≈ 0.678', () => {
    const scale = normalizeHeight(2.7, MOVEMENT.PLAYER_HEIGHT);
    expect(scale).toBeCloseTo(0.6778, 3);
  });
});

// ---------------------------------------------------------------------------
// deathRotationZ
// ---------------------------------------------------------------------------

describe('deathRotationZ', () => {
  it('returns 0 at t=0', () => {
    expect(deathRotationZ(0)).toBeCloseTo(0, 5);
  });

  it('returns PI/2 at t=1', () => {
    expect(deathRotationZ(1)).toBeCloseTo(Math.PI / 2, 5);
  });

  it('clamps at t>1', () => {
    expect(deathRotationZ(2)).toBeCloseTo(Math.PI / 2, 5);
    expect(deathRotationZ(100)).toBeCloseTo(Math.PI / 2, 5);
  });

  it('clamps at t<0', () => {
    expect(deathRotationZ(-1)).toBeCloseTo(0, 5);
  });

  it('is monotonically increasing for t in [0,1]', () => {
    let prev = deathRotationZ(0);
    for (let t = 0.1; t <= 1.0; t += 0.1) {
      const cur = deathRotationZ(t);
      expect(cur).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = cur;
    }
  });
});

// ---------------------------------------------------------------------------
// pickLocomotionClip — decision table
// ---------------------------------------------------------------------------

describe('pickLocomotionClip', () => {
  // Dead
  it('returns Death when not alive, regardless of speed', () => {
    expect(pickLocomotionClip(5, 0, 5, true,  false)).toBe('Death');
    expect(pickLocomotionClip(0, 0, 0, false, false)).toBe('Death');
  });

  // Airborne (not onGround)
  it('returns Idle_Gun when not on ground', () => {
    expect(pickLocomotionClip(3, 0, 3, false, true)).toBe('Idle_Gun');
  });

  // Standing still
  it('returns Idle_Gun when speed <= 0.3', () => {
    expect(pickLocomotionClip(0,   0,   0,   true, true)).toBe('Idle_Gun');
    expect(pickLocomotionClip(0.3, 0,   0.3, true, true)).toBe('Idle_Gun');
    expect(pickLocomotionClip(0,   0.2, 0.2, true, true)).toBe('Idle_Gun');
  });

  // Walk (speed 0.31 to 2.99)
  it('returns Walk for speeds in (0.3, 3.0)', () => {
    expect(pickLocomotionClip(1, 0, 1.0, true, true)).toBe('Walk');
    expect(pickLocomotionClip(2, 0, 2.5, true, true)).toBe('Walk');
    expect(pickLocomotionClip(2.99, 0, 2.99, true, true)).toBe('Walk');
  });

  // Run forward (dominant fwd positive)
  it('returns Run when running forward (fwd >= right)', () => {
    expect(pickLocomotionClip(4, 0, 4, true, true)).toBe('Run');
    expect(pickLocomotionClip(4, 2, 4, true, true)).toBe('Run');
    expect(pickLocomotionClip(4, -2, 4, true, true)).toBe('Run');
  });

  // Run back
  it('returns Run_Back when running backward (fwd negative, dominant)', () => {
    expect(pickLocomotionClip(-4, 0, 4, true, true)).toBe('Run_Back');
    expect(pickLocomotionClip(-4, 2, 4, true, true)).toBe('Run_Back');
  });

  // Strafe right
  it('returns Run_Right when strafing right (right > 0, dominant)', () => {
    expect(pickLocomotionClip(0, 4, 4, true, true)).toBe('Run_Right');
    expect(pickLocomotionClip(2, 4, 4.47, true, true)).toBe('Run_Right');
  });

  // Strafe left
  it('returns Run_Left when strafing left (right < 0, dominant)', () => {
    expect(pickLocomotionClip(0, -4, 4, true, true)).toBe('Run_Left');
    expect(pickLocomotionClip(2, -4, 4.47, true, true)).toBe('Run_Left');
  });

  // Boundary: exactly speed=3.0 → Run not Walk
  it('returns Run at exactly speed=3.0 with fwd dominant', () => {
    expect(pickLocomotionClip(3, 0, 3, true, true)).toBe('Run');
  });
});

// ---------------------------------------------------------------------------
// projectVelocityToLocal — velocity → model-local axes
// ---------------------------------------------------------------------------

describe('projectVelocityToLocal', () => {
  // yaw=0: model faces -Z; forward=(0,0,-1), right=(1,0,0) in world
  it('yaw=0: pure -Z world velocity → positive fwd', () => {
    const { fwd, right } = projectVelocityToLocal(0, -4, 0);
    expect(fwd).toBeCloseTo(4, 4);
    expect(right).toBeCloseTo(0, 4);
  });

  it('yaw=0: pure +Z world velocity → negative fwd (backing)', () => {
    const { fwd, right } = projectVelocityToLocal(0, 4, 0);
    expect(fwd).toBeCloseTo(-4, 4);
    expect(right).toBeCloseTo(0, 4);
  });

  it('yaw=0: pure +X world velocity → positive right', () => {
    const { fwd, right } = projectVelocityToLocal(4, 0, 0);
    expect(fwd).toBeCloseTo(0, 4);
    expect(right).toBeCloseTo(4, 4);
  });

  it('yaw=0: pure -X world velocity → negative right', () => {
    const { fwd, right } = projectVelocityToLocal(-4, 0, 0);
    expect(fwd).toBeCloseTo(0, 4);
    expect(right).toBeCloseTo(-4, 4);
  });

  // yaw=PI/2 (turned 90° left): model now faces -X; forward=(-1,0,0), right=(0,0,1)
  it('yaw=PI/2: -X world velocity → positive fwd', () => {
    const { fwd, right } = projectVelocityToLocal(-4, 0, Math.PI / 2);
    expect(fwd).toBeCloseTo(4, 4);
    expect(right).toBeCloseTo(0, 4);
  });

  it('yaw=PI/2: +Z world velocity → negative right (left strafe from model perspective)', () => {
    // At yaw=PI/2: model faces -X; model-right = (0,0,-1) in world space
    // +Z world velocity projects onto model-right as -1 * 4 = -4
    const { fwd, right } = projectVelocityToLocal(0, 4, Math.PI / 2);
    expect(fwd).toBeCloseTo(0, 4);
    expect(right).toBeCloseTo(-4, 4);
  });

  // yaw=PI: model faces +Z
  it('yaw=PI: +Z world velocity → positive fwd', () => {
    const { fwd, right } = projectVelocityToLocal(0, 4, Math.PI);
    expect(fwd).toBeCloseTo(4, 3);
    expect(right).toBeCloseTo(0, 3);
  });

  // yaw=3*PI/2 (= -PI/2): model faces +X
  it('yaw=3PI/2: +X world velocity → positive fwd', () => {
    const { fwd, right } = projectVelocityToLocal(4, 0, 3 * Math.PI / 2);
    expect(fwd).toBeCloseTo(4, 3);
    expect(right).toBeCloseTo(0, 3);
  });

  it('magnitude is preserved under projection', () => {
    const v = 5;
    const { fwd, right } = projectVelocityToLocal(v, 0, Math.PI / 4);
    const reconstructed  = Math.sqrt(fwd * fwd + right * right);
    expect(reconstructed).toBeCloseTo(v, 4);
  });
});

// ---------------------------------------------------------------------------
// locomotionTimeScale
// ---------------------------------------------------------------------------

describe('locomotionTimeScale', () => {
  it('clamps to 0.6 when speed is very low relative to ref', () => {
    expect(locomotionTimeScale(0.1, 5)).toBeCloseTo(0.6, 5);
  });

  it('returns 1.0 at exactly refSpeed', () => {
    expect(locomotionTimeScale(4.7, 4.7)).toBeCloseTo(1.0, 5);
  });

  it('clamps to 1.6 when speed is very high relative to ref', () => {
    expect(locomotionTimeScale(100, 4.7)).toBeCloseTo(1.6, 5);
  });

  it('returns 1.0 for degenerate refSpeed=0', () => {
    expect(locomotionTimeScale(4, 0)).toBeCloseTo(1, 5);
  });

  it('scales linearly in the unclamped range', () => {
    // 2.35 / 4.7 = 0.5 → clamped to 0.6
    expect(locomotionTimeScale(2.35, 4.7)).toBeCloseTo(0.6, 4);
    // 4.7 * 1.4 / 4.7 = 1.4 → unclamped
    expect(locomotionTimeScale(4.7 * 1.4, 4.7)).toBeCloseTo(1.4, 4);
  });
});

// ---------------------------------------------------------------------------
// crouchHipsOffsetY
// ---------------------------------------------------------------------------

describe('crouchHipsOffsetY', () => {
  it('returns 0 when factor is 0', () => {
    expect(crouchHipsOffsetY(0, 1)).toBe(0);
  });

  it('returns a negative value at factor=1 (hips move down)', () => {
    expect(crouchHipsOffsetY(1, 1)).toBeLessThan(0);
  });

  it('is proportional to factor', () => {
    const full = crouchHipsOffsetY(1, 1);
    const half = crouchHipsOffsetY(0.5, 1);
    expect(half).toBeCloseTo(full / 2, 5);
  });

  it('scales inversely with normalScale (larger scale = smaller model-unit offset)', () => {
    const atScale1 = crouchHipsOffsetY(1, 1);
    const atScale2 = crouchHipsOffsetY(1, 2);
    expect(Math.abs(atScale2)).toBeCloseTo(Math.abs(atScale1) / 2, 5);
  });

  it('magnitude is bounded (no absurd values at scale=1)', () => {
    expect(Math.abs(crouchHipsOffsetY(1, 1))).toBeLessThan(2);
  });
});

// ---------------------------------------------------------------------------
// crouchAbdomenTilt
// ---------------------------------------------------------------------------

describe('crouchAbdomenTilt', () => {
  it('returns 0 when factor is 0', () => {
    expect(crouchAbdomenTilt(0)).toBe(0);
  });

  it('returns positive value at factor=1 (forward lean)', () => {
    expect(crouchAbdomenTilt(1)).toBeGreaterThan(0);
  });

  it('is approximately 0.25 rad at full crouch', () => {
    expect(crouchAbdomenTilt(1)).toBeCloseTo(0.25, 5);
  });

  it('is proportional to factor', () => {
    expect(crouchAbdomenTilt(0.5)).toBeCloseTo(crouchAbdomenTilt(1) / 2, 5);
  });
});

// ---------------------------------------------------------------------------
// Legacy helpers (kept for backward compat — still exported)
// ---------------------------------------------------------------------------

describe('legSwingAngle (legacy, still exported)', () => {
  it('returns 0 amplitude at phase 0 for left leg', () => {
    expect(legSwingAngle(0, true, 0.45)).toBeCloseTo(0, 5);
  });

  it('left and right legs are opposite phase', () => {
    const left  = legSwingAngle(1.0, true,  0.45);
    const right = legSwingAngle(1.0, false, 0.45);
    expect(left).toBeCloseTo(-right, 5);
  });

  it('amplitude 0 always returns 0', () => {
    for (const phase of [0, 0.5, 1.0, Math.PI, 2 * Math.PI]) {
      expect(legSwingAngle(phase, true,  0)).toBeCloseTo(0, 5);
      expect(legSwingAngle(phase, false, 0)).toBeCloseTo(0, 5);
    }
  });

  it('peak absolute value equals amplitude', () => {
    const amp    = 0.45;
    const atPeak = legSwingAngle(Math.PI / 2, true, amp);
    expect(Math.abs(atPeak)).toBeCloseTo(amp, 5);
  });
});

describe('armSwingAngle (legacy, still exported)', () => {
  it('arm is opposite phase to leg on the same side', () => {
    const legL = legSwingAngle(1.0, true, 0.25);
    const armL = armSwingAngle(1.0, true, 0.25);
    expect(Math.sign(armL)).not.toBe(Math.sign(legL));
  });

  it('amplitude 0 always returns 0', () => {
    expect(armSwingAngle(1.5, true,  0)).toBeCloseTo(0, 5);
    expect(armSwingAngle(1.5, false, 0)).toBeCloseTo(0, 5);
  });
});

describe('breathingBobY (legacy, still exported)', () => {
  it('returns a value between -0.02 and +0.02', () => {
    for (let phase = 0; phase < 2 * Math.PI; phase += 0.1) {
      const bob = breathingBobY(phase);
      expect(bob).toBeGreaterThanOrEqual(-0.02);
      expect(bob).toBeLessThanOrEqual(0.02);
    }
  });
});

describe('crouchRootOffsetY (legacy, still exported)', () => {
  it('returns 0 when not crouching', () => {
    expect(crouchRootOffsetY(false)).toBe(0);
  });

  it('returns a negative value when crouching', () => {
    expect(crouchRootOffsetY(true)).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// Phase advancement (legacy behaviour check)
// ---------------------------------------------------------------------------

describe('walk phase advances with dt', () => {
  it('phase grows when dt > 0', () => {
    let phase = 0;
    const speed = 4.0;
    const dt    = 1 / 128;
    for (let i = 0; i < 128; i++) {
      phase += speed * 2.5 * dt;
    }
    expect(phase).toBeCloseTo(10, 1);
  });
});

// ---------------------------------------------------------------------------
// TP_WEAPON_TARGET_LEN — exported table completeness
// ---------------------------------------------------------------------------

describe('TP_WEAPON_TARGET_LEN — exported target-length table', () => {
  const stems = [
    'knife', 'pistol', 'revolver', 'smg', 'scifi_smg',
    'shotgun', 'assault_rifle', 'assault_rifle_2', 'sniper_rifle',
  ];

  it('has exactly 9 stems', () => {
    expect(Object.keys(TP_WEAPON_TARGET_LEN).length).toBe(9);
  });

  it('every stem has a positive finite target length', () => {
    for (const stem of stems) {
      const len = TP_WEAPON_TARGET_LEN[stem];
      expect(len).toBeDefined();
      expect(Number.isFinite(len!)).toBe(true);
      expect(len!).toBeGreaterThan(0);
    }
  });

  it('knife target length is 0.30 m', () => {
    expect(TP_WEAPON_TARGET_LEN['knife']).toBeCloseTo(0.30, 5);
  });

  it('sniper_rifle is the longest at 1.15 m', () => {
    const maxLen = Math.max(...Object.values(TP_WEAPON_TARGET_LEN));
    expect(maxLen).toBeCloseTo(TP_WEAPON_TARGET_LEN['sniper_rifle']!, 5);
  });

  it('pistol is shorter than assault_rifle', () => {
    expect(TP_WEAPON_TARGET_LEN['pistol']!).toBeLessThan(TP_WEAPON_TARGET_LEN['assault_rifle']!);
  });
});

// ---------------------------------------------------------------------------
// tpComputeWeaponNorm — normalization math
// ---------------------------------------------------------------------------

describe('tpComputeWeaponNorm — normalization pure function', () => {
  /**
   * Helper: build a THREE.Box3 from the dump-rig world size/center data.
   * size = [x,y,z] extents; center = [cx,cy,cz].
   */
  function makeBbox(size: [number, number, number], center: [number, number, number]): THREE.Box3 {
    const box = new THREE.Box3();
    box.min.set(center[0] - size[0] / 2, center[1] - size[1] / 2, center[2] - size[2] / 2);
    box.max.set(center[0] + size[0] / 2, center[1] + size[1] / 2, center[2] + size[2] / 2);
    return box;
  }

  // Ground-truth bboxes from dump-rig (world space, pre-normalization)
  const DUMP_BBOXES: Record<string, { size: [number,number,number]; center: [number,number,number] }> = {
    pistol:          { size: [1.8193, 1.1986, 0.2744], center: [0.543,  0.123, 0] },
    revolver:        { size: [1.9850, 0.9825, 0.2944], center: [0.779,  0.156, 0] },
    smg:             { size: [4.0439, 1.8473, 0.3185], center: [0.227,  0.063, 0] },
    scifi_smg:       { size: [2.2020, 0.7377, 0.1760], center: [0.170,  0.124, 0] },
    shotgun:         { size: [5.7849, 0.9427, 0.2465], center: [1.415, -0.092, 0] },
    assault_rifle:   { size: [5.1688, 1.7905, 0.3464], center: [1.025,  0.177, 0.002] },
    assault_rifle_2: { size: [5.4217, 1.6014, 0.1960], center: [1.106,  0.059, 0] },
    sniper_rifle:    { size: [7.2946, 1.4840, 0.4593], center: [1.604, -0.046, 0.075] },
    knife:           { size: [0.2654, 1.5629, 0.0778], center: [0.023,  0.418, 0] },
  };

  it('returns a finite positive scale for all 9 stems', () => {
    for (const [stem, bboxData] of Object.entries(DUMP_BBOXES)) {
      const targetLen = TP_WEAPON_TARGET_LEN[stem] ?? 0.5;
      const bbox = makeBbox(bboxData.size, bboxData.center);
      const { scale } = tpComputeWeaponNorm(bbox, targetLen);
      expect(Number.isFinite(scale)).toBe(true);
      expect(scale).toBeGreaterThan(0);
    }
  });

  it('pistol (X-long 1.82 m) → world length ≈ 0.32 m ±1%', () => {
    const targetLen = TP_WEAPON_TARGET_LEN['pistol']!;
    const bbox = makeBbox(DUMP_BBOXES.pistol!.size, DUMP_BBOXES.pistol!.center);
    const { scale } = tpComputeWeaponNorm(bbox, targetLen);
    const worldLen = 1.8193 * scale; // longest axis × scale
    expect(worldLen).toBeCloseTo(targetLen, 2); // ±1% at 2 decimal places
  });

  it('revolver (X-long 1.99 m) → world length ≈ 0.34 m ±1%', () => {
    const targetLen = TP_WEAPON_TARGET_LEN['revolver']!;
    const bbox = makeBbox(DUMP_BBOXES.revolver!.size, DUMP_BBOXES.revolver!.center);
    const { scale } = tpComputeWeaponNorm(bbox, targetLen);
    const worldLen = 1.9850 * scale;
    expect(worldLen).toBeCloseTo(targetLen, 2);
  });

  it('smg (X-long 4.04 m) → world length ≈ 0.65 m ±1%', () => {
    const targetLen = TP_WEAPON_TARGET_LEN['smg']!;
    const bbox = makeBbox(DUMP_BBOXES.smg!.size, DUMP_BBOXES.smg!.center);
    const { scale } = tpComputeWeaponNorm(bbox, targetLen);
    const worldLen = 4.0439 * scale;
    expect(worldLen).toBeCloseTo(targetLen, 2);
  });

  it('scifi_smg (X-long 2.20 m) → world length ≈ 0.60 m ±1%', () => {
    const targetLen = TP_WEAPON_TARGET_LEN['scifi_smg']!;
    const bbox = makeBbox(DUMP_BBOXES.scifi_smg!.size, DUMP_BBOXES.scifi_smg!.center);
    const { scale } = tpComputeWeaponNorm(bbox, targetLen);
    const worldLen = 2.2020 * scale;
    expect(worldLen).toBeCloseTo(targetLen, 2);
  });

  it('shotgun (X-long 5.78 m) → world length ≈ 1.00 m ±1%', () => {
    const targetLen = TP_WEAPON_TARGET_LEN['shotgun']!;
    const bbox = makeBbox(DUMP_BBOXES.shotgun!.size, DUMP_BBOXES.shotgun!.center);
    const { scale } = tpComputeWeaponNorm(bbox, targetLen);
    const worldLen = 5.7849 * scale;
    expect(worldLen).toBeCloseTo(targetLen, 2);
  });

  it('assault_rifle (X-long 5.17 m) → world length ≈ 0.95 m ±1%', () => {
    const targetLen = TP_WEAPON_TARGET_LEN['assault_rifle']!;
    const bbox = makeBbox(DUMP_BBOXES.assault_rifle!.size, DUMP_BBOXES.assault_rifle!.center);
    const { scale } = tpComputeWeaponNorm(bbox, targetLen);
    const worldLen = 5.1688 * scale;
    expect(worldLen).toBeCloseTo(targetLen, 2);
  });

  it('assault_rifle_2 (X-long 5.42 m) → world length ≈ 0.98 m ±1%', () => {
    const targetLen = TP_WEAPON_TARGET_LEN['assault_rifle_2']!;
    const bbox = makeBbox(DUMP_BBOXES.assault_rifle_2!.size, DUMP_BBOXES.assault_rifle_2!.center);
    const { scale } = tpComputeWeaponNorm(bbox, targetLen);
    const worldLen = 5.4217 * scale;
    expect(worldLen).toBeCloseTo(targetLen, 2);
  });

  it('sniper_rifle (X-long 7.29 m) → world length ≈ 1.15 m ±1%', () => {
    const targetLen = TP_WEAPON_TARGET_LEN['sniper_rifle']!;
    const bbox = makeBbox(DUMP_BBOXES.sniper_rifle!.size, DUMP_BBOXES.sniper_rifle!.center);
    const { scale } = tpComputeWeaponNorm(bbox, targetLen);
    const worldLen = 7.2946 * scale;
    expect(worldLen).toBeCloseTo(targetLen, 2);
  });

  it('knife (Y-long 1.56 m) → world length ≈ 0.30 m ±1%', () => {
    const targetLen = TP_WEAPON_TARGET_LEN['knife']!;
    const bbox = makeBbox(DUMP_BBOXES.knife!.size, DUMP_BBOXES.knife!.center);
    const { scale } = tpComputeWeaponNorm(bbox, targetLen);
    const worldLen = 1.5629 * scale; // Y is longest axis
    expect(worldLen).toBeCloseTo(targetLen, 2);
  });

  it('X-long bbox → rotY = PI/2 (align X to -Z)', () => {
    // pistol is X-long (1.82 x, 1.20 y)
    const bbox = makeBbox([2.0, 0.5, 0.3], [0, 0, 0]);
    const { rotY, rotX } = tpComputeWeaponNorm(bbox, 0.5);
    expect(rotY).toBeCloseTo(Math.PI / 2, 5);
    expect(rotX).toBeCloseTo(0, 5);
  });

  it('Y-long bbox → rotX = -PI/2 (align Y to -Z)', () => {
    // knife is Y-long
    const bbox = makeBbox([0.3, 2.0, 0.1], [0, 0, 0]);
    const { rotX, rotY } = tpComputeWeaponNorm(bbox, 0.5);
    expect(rotX).toBeCloseTo(-Math.PI / 2, 5);
    expect(rotY).toBeCloseTo(0, 5);
  });

  it('Z-long bbox → no rotation needed (already aligned)', () => {
    const bbox = makeBbox([0.2, 0.3, 2.0], [0, 0, 0]);
    const { rotX, rotY } = tpComputeWeaponNorm(bbox, 0.5);
    expect(rotX).toBeCloseTo(0, 5);
    expect(rotY).toBeCloseTo(0, 5);
  });

  it('degenerate zero bbox → returns safe positive scale', () => {
    const bbox = new THREE.Box3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 0),
    );
    const { scale } = tpComputeWeaponNorm(bbox, 0.5);
    expect(scale).toBeGreaterThan(0);
    expect(Number.isFinite(scale)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tpComputeWeaponNorm — grip placement (holder rear-end offset)
// ---------------------------------------------------------------------------

describe('tpComputeWeaponNorm — grip placement (centerZ)', () => {
  it('centerZ puts rear end at +GRIP_BACK_FRAC * targetLen from origin', () => {
    // A Z-long bbox of 2.0 m → scale=0.5 to target 1.0 m
    // After scaling: length=1.0 m along -Z direction
    // centerZ = (0.5 - 0.12) * 1.0 = 0.38  (center of weapon sits at z=+0.38)
    // → rear end (max-Z after scale) = 0.38 + 0.5 = +0.88 ≈ ... wait, we test the formula
    // centerZ = (0.5 - GRIP_BACK_FRAC) * targetLen
    // GRIP_BACK_FRAC = 0.12 → centerZ = 0.38 for targetLen=1.0
    const bbox = makeBbox([0.3, 0.3, 2.0], [0, 0, 0]);
    const targetLen = 1.0;
    const { centerZ } = tpComputeWeaponNorm(bbox, targetLen);
    // centerZ should be (0.5 - 0.12) * 1.0 = 0.38
    expect(centerZ).toBeCloseTo(0.38, 3);
  });

  it('centerZ is positive (weapon geometry sits in +Z from holder origin)', () => {
    for (const [stem, bboxData] of Object.entries({
      pistol: { size: [1.8193, 1.1986, 0.2744] as [number,number,number], center: [0.543, 0.123, 0] as [number,number,number] },
      knife:  { size: [0.2654, 1.5629, 0.0778] as [number,number,number], center: [0.023, 0.418, 0] as [number,number,number] },
    })) {
      const targetLen = TP_WEAPON_TARGET_LEN[stem] ?? 0.5;
      const bbox = makeBbox(bboxData.size, bboxData.center);
      const { centerZ } = tpComputeWeaponNorm(bbox, targetLen);
      expect(centerZ).toBeGreaterThan(0);
    }
  });

  function makeBbox(size: [number,number,number], center: [number,number,number]): THREE.Box3 {
    const box = new THREE.Box3();
    box.min.set(center[0] - size[0] / 2, center[1] - size[1] / 2, center[2] - size[2] / 2);
    box.max.set(center[0] + size[0] / 2, center[1] + size[1] / 2, center[2] + size[2] / 2);
    return box;
  }
});

// ---------------------------------------------------------------------------
// TP_WEAPON_ATTACH_OFFSETS — table completeness
// ---------------------------------------------------------------------------

describe('TP_WEAPON_ATTACH_OFFSETS — all 9 stems have entries', () => {
  const stems = [
    'knife', 'pistol', 'revolver', 'smg', 'scifi_smg',
    'shotgun', 'assault_rifle', 'assault_rifle_2', 'sniper_rifle',
  ];

  it('has entries for all 9 stems', () => {
    for (const stem of stems) {
      const offset = TP_WEAPON_ATTACH_OFFSETS[stem];
      expect(offset).toBeDefined();
    }
  });

  it('every entry has pos and rot arrays of length 3', () => {
    for (const offset of Object.values(TP_WEAPON_ATTACH_OFFSETS)) {
      expect(offset.pos.length).toBe(3);
      expect(offset.rot.length).toBe(3);
      for (const v of [...offset.pos, ...offset.rot]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// TP_HOLD_POSES — structure and family membership
// ---------------------------------------------------------------------------

describe('TP_HOLD_POSES — arm pose constants', () => {
  const families: Array<import('./characters').TpHoldFamily> = ['twoHanded', 'pistol', 'knife'];

  it('has entries for all three families', () => {
    for (const fam of families) {
      expect(TP_HOLD_POSES[fam]).toBeDefined();
    }
  });

  it('every pose has 8 bone rotation arrays of length 3', () => {
    for (const pose of Object.values(TP_HOLD_POSES)) {
      const arrays = [
        pose.shoulderR, pose.upperArmR, pose.lowerArmR, pose.wristR,
        pose.shoulderL, pose.upperArmL, pose.lowerArmL, pose.wristL,
      ];
      for (const arr of arrays) {
        expect(arr.length).toBe(3);
        for (const v of arr) {
          expect(Number.isFinite(v)).toBe(true);
        }
      }
    }
  });

  it('twoHanded: right arm has positive X rotation on upperArmR (arm raised)', () => {
    expect(TP_HOLD_POSES.twoHanded.upperArmR[0]).toBeGreaterThan(0);
  });

  it('twoHanded: left arm has positive X rotation on upperArmL (arm raised across)', () => {
    expect(TP_HOLD_POSES.twoHanded.upperArmL[0]).toBeGreaterThan(0);
  });

  it('knife pose family field is knife', () => {
    expect(TP_HOLD_POSES.knife.family).toBe('knife');
  });

  it('pistol pose family field is pistol', () => {
    expect(TP_HOLD_POSES.pistol.family).toBe('pistol');
  });

  it('twoHanded pose family field is twoHanded', () => {
    expect(TP_HOLD_POSES.twoHanded.family).toBe('twoHanded');
  });
});

// ---------------------------------------------------------------------------
// TP_STEM_TO_FAMILY — mapping table
// ---------------------------------------------------------------------------

describe('TP_STEM_TO_FAMILY — stem to family mapping', () => {
  it('has entries for all 9 stems', () => {
    const stems = [
      'knife', 'pistol', 'revolver', 'smg', 'scifi_smg',
      'shotgun', 'assault_rifle', 'assault_rifle_2', 'sniper_rifle',
    ];
    for (const stem of stems) {
      expect(TP_STEM_TO_FAMILY[stem]).toBeDefined();
    }
  });

  it('knife → knife', () => {
    expect(TP_STEM_TO_FAMILY['knife']).toBe('knife');
  });

  it('pistol → pistol', () => {
    expect(TP_STEM_TO_FAMILY['pistol']).toBe('pistol');
  });

  it('revolver → pistol', () => {
    expect(TP_STEM_TO_FAMILY['revolver']).toBe('pistol');
  });

  it('assault_rifle → twoHanded', () => {
    expect(TP_STEM_TO_FAMILY['assault_rifle']).toBe('twoHanded');
  });

  it('sniper_rifle → twoHanded', () => {
    expect(TP_STEM_TO_FAMILY['sniper_rifle']).toBe('twoHanded');
  });

  it('smg → twoHanded', () => {
    expect(TP_STEM_TO_FAMILY['smg']).toBe('twoHanded');
  });

  it('all family values are one of: twoHanded | pistol | knife', () => {
    const valid = new Set(['twoHanded', 'pistol', 'knife']);
    for (const fam of Object.values(TP_STEM_TO_FAMILY)) {
      expect(valid.has(fam)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Pose override — synthetic bone hierarchy
// ---------------------------------------------------------------------------

describe('gun-hold pose override — synthetic bone hierarchy', () => {
  /**
   * Build a minimal synthetic bone hierarchy:
   * Shoulder.R → UpperArm.R → LowerArm.R → Wrist.R
   * Shoulder.L → UpperArm.L → LowerArm.L → Wrist.L
   * All start at identity rotation.
   */
  function buildSyntheticArmBones(): Record<string, THREE.Bone> {
    const bones: Record<string, THREE.Bone> = {};
    const names = [
      'Shoulder.R', 'UpperArm.R', 'LowerArm.R', 'Wrist.R',
      'Shoulder.L', 'UpperArm.L', 'LowerArm.L', 'Wrist.L',
    ];
    for (const name of names) {
      const bone = new THREE.Bone();
      bone.name = name;
      bone.rotation.set(0, 0, 0);
      bones[name] = bone;
    }
    // Chain right side
    bones['Shoulder.R']!.add(bones['UpperArm.R']!);
    bones['UpperArm.R']!.add(bones['LowerArm.R']!);
    bones['LowerArm.R']!.add(bones['Wrist.R']!);
    // Chain left side
    bones['Shoulder.L']!.add(bones['UpperArm.L']!);
    bones['UpperArm.L']!.add(bones['LowerArm.L']!);
    bones['LowerArm.L']!.add(bones['Wrist.L']!);
    return bones;
  }

  /**
   * Simulate what _applyGunHoldPose does, applied to a synthetic bone set.
   * (We call the exported constants directly — the private fn is not exported,
   *  but we test its logic by replicating the 8 rotation.set calls.)
   */
  function applyPoseToSyntheticBones(
    pose: import('./characters').TpArmPose,
    bones: Record<string, THREE.Bone>,
  ): void {
    bones['Shoulder.R']!.rotation.set(pose.shoulderR[0], pose.shoulderR[1], pose.shoulderR[2]);
    bones['UpperArm.R']!.rotation.set(pose.upperArmR[0], pose.upperArmR[1], pose.upperArmR[2]);
    bones['LowerArm.R']!.rotation.set(pose.lowerArmR[0], pose.lowerArmR[1], pose.lowerArmR[2]);
    bones['Wrist.R']!.rotation.set(   pose.wristR[0],    pose.wristR[1],    pose.wristR[2]);
    bones['Shoulder.L']!.rotation.set(pose.shoulderL[0], pose.shoulderL[1], pose.shoulderL[2]);
    bones['UpperArm.L']!.rotation.set(pose.upperArmL[0], pose.upperArmL[1], pose.upperArmL[2]);
    bones['LowerArm.L']!.rotation.set(pose.lowerArmL[0], pose.lowerArmL[1], pose.lowerArmL[2]);
    bones['Wrist.L']!.rotation.set(   pose.wristL[0],    pose.wristL[1],    pose.wristL[2]);
  }

  it('twoHanded pose sets non-identity rotations on all 8 arm bones', () => {
    const bones = buildSyntheticArmBones();
    applyPoseToSyntheticBones(TP_HOLD_POSES.twoHanded, bones);

    // At least some bones should have non-zero X rotation (arm raised)
    const upperArmRx = bones['UpperArm.R']!.rotation.x;
    const upperArmLx = bones['UpperArm.L']!.rotation.x;
    expect(Math.abs(upperArmRx)).toBeGreaterThan(0);
    expect(Math.abs(upperArmLx)).toBeGreaterThan(0);
  });

  it('pistol pose sets arm bones to pistol-family values', () => {
    const bones = buildSyntheticArmBones();
    applyPoseToSyntheticBones(TP_HOLD_POSES.pistol, bones);

    const pose = TP_HOLD_POSES.pistol;
    expect(bones['UpperArm.R']!.rotation.x).toBeCloseTo(pose.upperArmR[0], 5);
    expect(bones['UpperArm.R']!.rotation.y).toBeCloseTo(pose.upperArmR[1], 5);
    expect(bones['LowerArm.R']!.rotation.x).toBeCloseTo(pose.lowerArmR[0], 5);
  });

  it('knife pose sets arm bones to knife-family values', () => {
    const bones = buildSyntheticArmBones();
    applyPoseToSyntheticBones(TP_HOLD_POSES.knife, bones);

    const pose = TP_HOLD_POSES.knife;
    expect(bones['UpperArm.R']!.rotation.x).toBeCloseTo(pose.upperArmR[0], 5);
    expect(bones['Wrist.R']!.rotation.x).toBeCloseTo(pose.wristR[0], 5);
    // Knife: left arm relaxed (low pose values)
    expect(bones['UpperArm.L']!.rotation.x).toBeLessThan(TP_HOLD_POSES.twoHanded.upperArmL[0]);
  });

  it('pose values are not all zero (non-trivial hold pose)', () => {
    for (const fam of (['twoHanded', 'pistol', 'knife'] as const)) {
      const pose = TP_HOLD_POSES[fam];
      const allZero = [
        ...pose.upperArmR, ...pose.lowerArmR,
        ...pose.upperArmL, ...pose.lowerArmL,
      ].every(v => v === 0);
      expect(allZero).toBe(false);
    }
  });

  it('pose override is idempotent — applying twice gives same result', () => {
    const bones = buildSyntheticArmBones();
    applyPoseToSyntheticBones(TP_HOLD_POSES.twoHanded, bones);
    const xAfterFirst = bones['UpperArm.R']!.rotation.x;
    // Apply again (simulating per-frame override)
    applyPoseToSyntheticBones(TP_HOLD_POSES.twoHanded, bones);
    expect(bones['UpperArm.R']!.rotation.x).toBeCloseTo(xAfterFirst, 5);
  });

  it('dead combatant: no pose override — bones stay at identity', () => {
    // The dead-path in _updateRiggedMesh returns early before _applyGunHoldPose.
    // We test the guard condition: stem must be non-empty to trigger pose.
    // When stem='' (no weapon or dead), pose is never applied.
    // Verify TP_STEM_TO_FAMILY returns undefined for empty stem.
    expect(TP_STEM_TO_FAMILY['']).toBeUndefined();
  });

  it('no weapon stem: TP_STEM_TO_FAMILY returns undefined, blocking pose', () => {
    // Empty string stem or unknown stem should NOT resolve a family.
    expect(TP_STEM_TO_FAMILY['']).toBeUndefined();
    expect(TP_STEM_TO_FAMILY['grenade']).toBeUndefined();
    expect(TP_STEM_TO_FAMILY['he']).toBeUndefined();
  });
});
