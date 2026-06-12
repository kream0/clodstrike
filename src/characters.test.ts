/**
 * characters.test.ts — headless tests for the AnimationMixer character system.
 *
 * No WebGL / DOM required. Pure math + file-system checks only.
 * Does NOT instantiate GLTFLoader, AnimationMixer, or SkeletonUtils.
 */

import { describe, it, expect } from 'bun:test';
import * as path from 'path';
import * as fs from 'fs';
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
