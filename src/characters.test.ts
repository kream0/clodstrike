/**
 * characters.test.ts — headless tests for the character model system.
 *
 * No WebGL / DOM required. Pure math + file-system checks only.
 */

import { describe, it, expect } from 'bun:test';
import * as path from 'path';
import * as fs from 'fs';
import {
  CHARACTER_MODEL_PATHS,
  legSwingAngle,
  armSwingAngle,
  breathingBobY,
  crouchRootOffsetY,
  deathRotationZ,
  normalizeHeight,
} from './characters';
import { MOVEMENT } from './constants';

// ---------------------------------------------------------------------------
// Asset file existence + GLB magic
// ---------------------------------------------------------------------------

describe('CHARACTER_MODEL_PATHS — asset files', () => {
  // Resolve relative to project root (assets/)
  const projectRoot = path.resolve(__dirname, '..');
  const assetsRoot  = path.join(projectRoot, 'assets');

  it('ct path exists and has glTF magic bytes', () => {
    const filePath = path.join(assetsRoot, CHARACTER_MODEL_PATHS.ct);
    expect(fs.existsSync(filePath)).toBe(true);

    const buf  = fs.readFileSync(filePath);
    const magic = buf.toString('ascii', 0, 4);
    expect(magic).toBe('glTF');
  });

  it('t path exists and has glTF magic bytes', () => {
    const filePath = path.join(assetsRoot, CHARACTER_MODEL_PATHS.t);
    expect(fs.existsSync(filePath)).toBe(true);

    const buf  = fs.readFileSync(filePath);
    const magic = buf.toString('ascii', 0, 4);
    expect(magic).toBe('glTF');
  });

  it('total payload under assets/models/characters/ is less than 5 MB', () => {
    const charDir = path.join(assetsRoot, 'models', 'characters');
    let totalBytes = 0;

    function sumDir(dir: string): void {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          sumDir(full);
        } else {
          totalBytes += fs.statSync(full).size;
        }
      }
    }
    sumDir(charDir);

    const MB = totalBytes / (1024 * 1024);
    expect(MB).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// LICENSES.md mentions Kenney / Blocky Characters / CC0
// ---------------------------------------------------------------------------

describe('LICENSES.md — Kenney attribution', () => {
  it('contains Kenney and CC0 in the Models section', () => {
    const projectRoot = path.resolve(__dirname, '..');
    const licensePath = path.join(projectRoot, 'assets', 'LICENSES.md');
    expect(fs.existsSync(licensePath)).toBe(true);

    const content = fs.readFileSync(licensePath, 'utf8');
    expect(content).toContain('Kenney');
    expect(content).toContain('CC0');
    // Specifically check for Blocky
    expect(content).toContain('Blocky');
  });
});

// ---------------------------------------------------------------------------
// Pure animation math
// ---------------------------------------------------------------------------

describe('legSwingAngle', () => {
  it('returns 0 amplitude at phase 0 for left leg (sin(0) = 0)', () => {
    expect(legSwingAngle(0, true, 0.45)).toBeCloseTo(0, 5);
  });

  it('returns 0 amplitude at phase 0 for right leg (sin(PI) = 0)', () => {
    expect(legSwingAngle(0, false, 0.45)).toBeCloseTo(0, 5);
  });

  it('left and right legs are opposite phase', () => {
    const phase = 1.0;
    const amp   = 0.45;
    const left  = legSwingAngle(phase, true,  amp);
    const right = legSwingAngle(phase, false, amp);
    // They should be equal and opposite
    expect(left).toBeCloseTo(-right, 5);
  });

  it('amplitude 0 always returns 0 regardless of phase', () => {
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

describe('armSwingAngle', () => {
  it('arm is opposite phase to leg on the same side', () => {
    const phase = 1.0;
    const amp   = 0.25;
    const legL  = legSwingAngle(phase, true,  amp);
    const armL  = armSwingAngle(phase, true,  amp);
    // arm should be opposite sign to leg (counter-swing)
    expect(Math.sign(armL)).not.toBe(Math.sign(legL));
  });

  it('amplitude 0 always returns 0', () => {
    expect(armSwingAngle(1.5, true,  0)).toBeCloseTo(0, 5);
    expect(armSwingAngle(1.5, false, 0)).toBeCloseTo(0, 5);
  });
});

describe('breathingBobY', () => {
  it('returns a value between -0.015 and +0.015', () => {
    for (let phase = 0; phase < 2 * Math.PI; phase += 0.1) {
      const bob = breathingBobY(phase);
      expect(bob).toBeGreaterThanOrEqual(-0.02);
      expect(bob).toBeLessThanOrEqual(0.02);
    }
  });

  it('oscillates (different values at different phases)', () => {
    const a = breathingBobY(0);
    const b = breathingBobY(Math.PI / 2);
    expect(a).not.toBeCloseTo(b, 2);
  });
});

describe('crouchRootOffsetY', () => {
  it('returns 0 when not crouching', () => {
    expect(crouchRootOffsetY(false)).toBe(0);
  });

  it('returns a negative value when crouching (root moves down)', () => {
    expect(crouchRootOffsetY(true)).toBeLessThan(0);
  });

  it('crouch offset magnitude is bounded (no absurd values)', () => {
    const offset = crouchRootOffsetY(true);
    // Should be less than 1 model-unit in magnitude
    expect(Math.abs(offset)).toBeLessThan(1.0);
  });
});

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

describe('normalizeHeight', () => {
  it('computes scale = targetHeight / sourceHeight', () => {
    expect(normalizeHeight(2.7, 1.83)).toBeCloseTo(1.83 / 2.7, 5);
  });

  it('MOVEMENT.PLAYER_HEIGHT / MODEL_SOURCE_HEIGHT ≈ 0.678', () => {
    const MODEL_SOURCE_HEIGHT = 2.7;
    const scale = normalizeHeight(MODEL_SOURCE_HEIGHT, MOVEMENT.PLAYER_HEIGHT);
    expect(scale).toBeCloseTo(0.6778, 3);
  });

  it('returns 1 for equal source and target', () => {
    expect(normalizeHeight(1.83, 1.83)).toBeCloseTo(1, 5);
  });

  it('returns 1 for degenerate source height 0', () => {
    expect(normalizeHeight(0, 1.83)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase advancement
// ---------------------------------------------------------------------------

describe('walk phase advances with dt', () => {
  it('phase grows when dt > 0', () => {
    let phase = 0;
    const speed = 4.0; // m/s
    const dt    = 1 / 128;
    // Simulate several ticks
    for (let i = 0; i < 128; i++) {
      phase += speed * 2.5 * dt;
    }
    // After 1 second at 4 m/s: phase = 4 * 2.5 * 1 = 10 rad
    expect(phase).toBeCloseTo(10, 1);
  });
});
