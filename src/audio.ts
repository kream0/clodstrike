import * as THREE from 'three';
import type { Vec3 } from './types';

// ---------------------------------------------------------------------------
// Synthesized WebAudio — no asset files.
// ---------------------------------------------------------------------------

type AudioCtxType = AudioContext;
declare const AudioContext: { new(): AudioCtxType };

// Per-weapon tuning: [bandpassFreq, lowpassFreq, duration, subOscFreq|0]
interface WeaponTone {
  bpFreq:   number;
  lpFreq:   number;
  duration: number;
  subFreq:  number;  // 0 = no sub
  gain:     number;
}

const WEAPON_TONES: Record<string, WeaponTone> = {
  usp:    { bpFreq: 1200, lpFreq: 3000, duration: 0.12, subFreq: 0,   gain: 0.7 },
  glock:  { bpFreq: 1200, lpFreq: 3500, duration: 0.10, subFreq: 0,   gain: 0.65 },
  deagle: { bpFreq:  500, lpFreq: 1800, duration: 0.22, subFreq: 80,  gain: 1.0 },
  ak47:   { bpFreq:  700, lpFreq: 2200, duration: 0.18, subFreq: 90,  gain: 0.9 },
  m4a4:   { bpFreq:  850, lpFreq: 2600, duration: 0.14, subFreq: 0,   gain: 0.8 },
  awp:    { bpFreq:  320, lpFreq: 1200, duration: 0.35, subFreq: 60,  gain: 1.1 },
  knife:  { bpFreq: 2400, lpFreq: 5000, duration: 0.08, subFreq: 0,   gain: 0.4 },
};

export class GameAudio {
  private _ctx: AudioCtxType | null = null;
  private _master: GainNode | null  = null;
  private _masterVol = 0.35;
  private _unlocked  = false;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  unlock(): void {
    if (this._unlocked) return;
    try {
      const ctx = new AudioContext();
      this._ctx = ctx;
      const master = ctx.createGain();
      master.gain.value = this._masterVol;
      master.connect(ctx.destination);
      this._master = master;
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }
      this._unlocked = true;
    } catch {
      // WebAudio not available (e.g. test environment) — silently no-op.
    }
  }

  setMaster(v: number): void {
    this._masterVol = v;
    if (this._master) this._master.gain.value = v;
  }

  updateListener(camera: THREE.Camera): void {
    if (!this._ctx || !this._unlocked) return;
    const listener = this._ctx.listener;
    const pos = new THREE.Vector3();
    camera.getWorldPosition(pos);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const up  = new THREE.Vector3(0, 1,  0).applyQuaternion(camera.quaternion);

    if (listener.positionX !== undefined) {
      listener.positionX.setValueAtTime(pos.x, this._ctx.currentTime);
      listener.positionY.setValueAtTime(pos.y, this._ctx.currentTime);
      listener.positionZ.setValueAtTime(pos.z, this._ctx.currentTime);
      listener.forwardX.setValueAtTime(fwd.x, this._ctx.currentTime);
      listener.forwardY.setValueAtTime(fwd.y, this._ctx.currentTime);
      listener.forwardZ.setValueAtTime(fwd.z, this._ctx.currentTime);
      listener.upX.setValueAtTime(up.x, this._ctx.currentTime);
      listener.upY.setValueAtTime(up.y, this._ctx.currentTime);
      listener.upZ.setValueAtTime(up.z, this._ctx.currentTime);
    } else {
      listener.setPosition(pos.x, pos.y, pos.z);
      listener.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  // ---------------------------------------------------------------------------
  // Noise burst synthesis
  // ---------------------------------------------------------------------------

  private _noise(
    duration: number,
    bpFreq: number,
    lpFreq: number,
    gainVal: number,
    pos?: Vec3,
  ): void {
    const ctx = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const now     = ctx.currentTime;
    const bufLen  = Math.ceil(ctx.sampleRate * duration);
    const buffer  = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data    = buffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const bp = ctx.createBiquadFilter();
    bp.type            = 'bandpass';
    bp.frequency.value = bpFreq;
    bp.Q.value         = 1.5;

    const lp = ctx.createBiquadFilter();
    lp.type            = 'lowpass';
    lp.frequency.value = lpFreq;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainVal, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    src.connect(bp);
    bp.connect(lp);

    if (pos) {
      const panner = ctx.createPanner();
      panner.panningModel    = 'HRTF';
      panner.distanceModel   = 'inverse';
      panner.refDistance     = 6;
      panner.maxDistance     = 90;
      panner.rolloffFactor   = 1;
      panner.positionX.setValueAtTime(pos.x, now);
      panner.positionY.setValueAtTime(pos.y, now);
      panner.positionZ.setValueAtTime(pos.z, now);
      lp.connect(gain);
      gain.connect(panner);
      panner.connect(master);
    } else {
      lp.connect(gain);
      gain.connect(master);
    }

    src.start(now);
    src.stop(now + duration + 0.02);
  }

  private _tone(freq: number, duration: number, gainVal: number): void {
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type            = 'sine';
    osc.frequency.value = freq;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainVal, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.connect(gain);
    gain.connect(master);
    osc.start(now);
    osc.stop(now + duration + 0.01);
  }

  private _click(delay = 0): void {
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const now = ctx.currentTime + delay;
    const bufLen = Math.ceil(ctx.sampleRate * 0.015);
    const buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const hp = ctx.createBiquadFilter();
    hp.type            = 'highpass';
    hp.frequency.value = 1800;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.015);

    src.connect(hp);
    hp.connect(gain);
    gain.connect(master);
    src.start(now);
    src.stop(now + 0.02);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  gunshot(weaponId: string, pos?: Vec3): void {
    const tone = WEAPON_TONES[weaponId] ?? WEAPON_TONES['usp'];
    this._noise(tone.duration, tone.bpFreq, tone.lpFreq, tone.gain, pos);

    if (tone.subFreq > 0) {
      this._tone(tone.subFreq, tone.duration * 0.6, 0.25);
    }
  }

  dryFire(): void {
    this._click(0);
  }

  reload(): void {
    this._click(0);
    this._click(0.12);
  }

  headshot(): void {
    this._tone(2200, 0.08, 0.35);
  }

  hitmarker(): void {
    this._tone(1400, 0.03, 0.25);
  }

  footstep(pos?: Vec3): void {
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const now    = ctx.currentTime;
    const bufLen = Math.ceil(ctx.sampleRate * 0.06);
    const buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const lp = ctx.createBiquadFilter();
    lp.type            = 'lowpass';
    lp.frequency.value = 400;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

    src.connect(lp);

    if (pos) {
      const panner = ctx.createPanner();
      panner.distanceModel = 'inverse';
      panner.refDistance   = 4;
      panner.maxDistance   = 30;
      panner.positionX.setValueAtTime(pos.x, now);
      panner.positionY.setValueAtTime(pos.y, now);
      panner.positionZ.setValueAtTime(pos.z, now);
      lp.connect(gain);
      gain.connect(panner);
      panner.connect(master);
    } else {
      lp.connect(gain);
      gain.connect(master);
    }

    src.start(now);
    src.stop(now + 0.07);
  }

  land(pos?: Vec3): void {
    // Heavier thud.
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const now    = ctx.currentTime;
    const bufLen = Math.ceil(ctx.sampleRate * 0.12);
    const buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const lp = ctx.createBiquadFilter();
    lp.type            = 'lowpass';
    lp.frequency.value = 300;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    src.connect(lp);
    lp.connect(gain);
    gain.connect(master);
    src.start(now);
    src.stop(now + 0.14);

    if (pos) {
      // positional version replaces the above connection (re-do with panner)
      const panner = ctx.createPanner();
      panner.distanceModel = 'inverse';
      panner.refDistance   = 5;
      panner.maxDistance   = 40;
      panner.positionX.setValueAtTime(pos.x, now);
      panner.positionY.setValueAtTime(pos.y, now);
      panner.positionZ.setValueAtTime(pos.z, now);
      gain.disconnect();
      gain.connect(panner);
      panner.connect(master);
    }
  }
}

export const audio = new GameAudio();
