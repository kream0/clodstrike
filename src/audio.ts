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

// ---------------------------------------------------------------------------
// Reverb / spatial-depth tuning constants (kept local — don't export)
// ---------------------------------------------------------------------------

/** Wet level sent to the reverb bus from positional sounds (neutral baseline). */
const REVERB_WET_BASE  = 0.18;

// Wall-occlusion lowpass constants.
/** LP cutoff (Hz) for a fully occluded (wall-blocked) positional gunshot. */
const OCCLUDE_CUTOFF_HZ = 480;
/** Minimum LP cutoff floor — even occluded shots stay audible. */
const OCCLUDE_CUTOFF_FLOOR = 200;
/** Gain attenuation multiplier at full occlusion (occlusion = 1). */
const OCCLUDE_GAIN_MUL = 0.65;  // ×(1 - 0.35×1) = 0.65

/** Distance (metres) at which LP cutoff is fully open (~16 kHz). */
const DIST_NEAR        = 6;
/** Distance (metres) at which LP cutoff is at its floor. */
const DIST_FAR         = 90;
/** LP cutoff (Hz) for a sound at or beyond DIST_FAR. */
const DIST_CUTOFF_FLOOR = 900;
/** LP cutoff (Hz) for a sound at or below DIST_NEAR. */
const DIST_CUTOFF_OPEN  = 16000;

// ---------------------------------------------------------------------------
// Helper: map distance → lowpass cutoff
// ---------------------------------------------------------------------------
function distanceCutoff(dist: number): number {
  if (dist <= DIST_NEAR)  return DIST_CUTOFF_OPEN;
  if (dist >= DIST_FAR)   return DIST_CUTOFF_FLOOR;
  // Exponential falloff between near and far.
  const t = (dist - DIST_NEAR) / (DIST_FAR - DIST_NEAR); // 0..1
  return DIST_CUTOFF_OPEN * Math.pow(DIST_CUTOFF_FLOOR / DIST_CUTOFF_OPEN, t);
}

// Per-surface footstep timbre parameters.
interface FootstepTimbre {
  /** Lowpass cutoff Hz — controls overall brightness of the step. */
  lpFreq:   number;
  /** Peak gain at start of envelope. */
  gain:     number;
  /** Decay duration in seconds. */
  decay:    number;
  /** Optional tonal component: frequency (Hz) of a sine/triangle blip (0 = none). */
  toneFreq: number;
  /** Gain of the tonal component (0 = none). */
  toneGain: number;
}

const FOOTSTEP_TIMBRES: Record<string, FootstepTimbre> = {
  // Soft desert sand — muffled low thud, fast decay, pure noise (no tone).
  sand:      { lpFreq: 240,  gain: 0.10, decay: 0.055, toneFreq: 0,   toneGain: 0 },
  sandLight: { lpFreq: 300,  gain: 0.10, decay: 0.055, toneFreq: 0,   toneGain: 0 },
  // Harder stone surface — snappier, brighter.
  stone:     { lpFreq: 800,  gain: 0.13, decay: 0.045, toneFreq: 0,   toneGain: 0 },
  // Concrete floor — mid between sand and stone.
  floor:     { lpFreq: 500,  gain: 0.12, decay: 0.050, toneFreq: 0,   toneGain: 0 },
  // Dark tunnel concrete — same as floor (reverb gives it the extra space).
  dark:      { lpFreq: 500,  gain: 0.12, decay: 0.050, toneFreq: 0,   toneGain: 0 },
  // Hollow wood — add a low-mid resonance blip.
  wood:      { lpFreq: 600,  gain: 0.11, decay: 0.060, toneFreq: 180, toneGain: 0.06 },
  // Metal — bright clang + high detuned partials.
  metal:     { lpFreq: 3200, gain: 0.09, decay: 0.035, toneFreq: 820, toneGain: 0.07 },
};

export class GameAudio {
  private _ctx: AudioCtxType | null = null;
  private _master: GainNode | null  = null;
  private _masterVol = 0.35;
  private _unlocked  = false;

  // Reverb bus (built lazily in unlock())
  private _reverbSend: GainNode | null    = null;
  private _convolver: ConvolverNode | null = null;

  // Ambient wind bed (created once, deferred after unlock).
  // _windSrc / _windLfoOsc are intentionally page-lifetime: started once and
  // never stopped. unlock() is idempotent (`if (this._unlocked) return`) and
  // _windStarted guards _startWind, so there is no recreate/duplicate path.
  private _windStarted = false;
  private _windSrc:     AudioBufferSourceNode | null = null;
  private _windGain:    GainNode | null              = null;
  private _windLfoOsc:  OscillatorNode | null        = null;
  private _windLfoGain: GainNode | null              = null;

  // Cached listener position for distance LP (updated every frame by updateListener).
  // null until the first updateListener — distance LP stays fully open meanwhile.
  private _listenerPos: { x: number; y: number; z: number } | null = null;

  // Pre-allocated scratch vectors for updateListener (no per-frame allocation).
  private readonly _scratchPos = new THREE.Vector3();
  private readonly _scratchFwd = new THREE.Vector3();
  private readonly _scratchUp  = new THREE.Vector3();

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

      // Build the reverb bus OFF the pointer-lock gesture handler: the IR fill
      // loop can exceed the synchronous gesture budget on exotic high-sample-rate
      // devices and break pointer-lock. The ctx is already created/resumed here,
      // so building the bus async is safe — `_reverbSend` stays null until ready
      // and positional sounds fall back to dry cleanly in the meantime.
      setTimeout(() => this._buildReverb(ctx, master), 0);
      // Start ambient wind after the gesture handler to keep pointer-lock budget.
      setTimeout(() => this._startWind(ctx, master), 0);
    } catch {
      // WebAudio not available (e.g. test environment) — silently no-op.
    }
  }

  /**
   * Create convolver + reverb send, synthesize an impulse response, wire up.
   * Wrapped in try/catch so any failure leaves audio working DRY.
   */
  private _buildReverb(ctx: AudioCtxType, master: GainNode): void {
    try {
      const sr      = ctx.sampleRate;
      const irLen   = Math.ceil(sr * 1.3);   // ~1.3 s impulse response
      const ir      = ctx.createBuffer(2, irLen, sr);
      const decayExp = 3.0;

      for (let ch = 0; ch < 2; ch++) {
        const data = ir.getChannelData(ch);
        let prev = 0;
        for (let i = 0; i < irLen; i++) {
          const envelope = Math.pow(1 - i / irLen, decayExp);
          // White noise sample.
          const raw = (Math.random() * 2 - 1) * envelope;
          // One-pole lowpass blend to darken the tail (α = 0.25 → each sample
          // is 75% current + 25% previous, softening harsh HF content).
          const smoothed = raw * 0.75 + prev * 0.25;
          data[i] = smoothed;
          prev = smoothed;
        }
      }

      const convolver = ctx.createConvolver();
      convolver.buffer = ir;

      // Reverb send gain = global wet level.
      const reverbSend = ctx.createGain();
      reverbSend.gain.value = REVERB_WET_BASE;

      reverbSend.connect(convolver);
      convolver.connect(master);

      this._convolver  = convolver;
      this._reverbSend = reverbSend;
    } catch {
      // Reverb unavailable — fall back to DRY (no-op).
      this._reverbSend = null;
      this._convolver  = null;
    }
  }

  /**
   * Build and start the ambient desert-wind bed. Called once, deferred after
   * unlock(). Synthesized looping noise → gentle lowpass → very-low-gain node
   * → master. An LFO slowly modulates the gain for a subtle swell effect.
   * Wrapped in try/catch — failure leaves everything else working.
   */
  private _startWind(ctx: AudioCtxType, master: GainNode): void {
    if (this._windStarted) return;  // guard against double-start
    this._windStarted = true;
    try {
      const sr = ctx.sampleRate;
      // 4-second noise loop buffer — long enough to avoid obvious periodicity.
      const loopSec = 4;
      const bufLen  = Math.ceil(sr * loopSec);
      const buf     = ctx.createBuffer(1, bufLen, sr);
      const data    = buf.getChannelData(0);
      // Fill with white noise, apply a simple fade-loop crossfade so the
      // loop point is seamless (last ~10 ms cross-fades to start).
      const xfSamples = Math.ceil(sr * 0.01);
      for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
      for (let i = 0; i < xfSamples; i++) {
        const t = i / xfSamples;
        data[bufLen - xfSamples + i] = data[bufLen - xfSamples + i] * (1 - t) + data[i] * t;
      }

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop   = true;

      // Gentle lowpass: desert wind is a low rumble/hiss, nothing bright.
      const lp = ctx.createBiquadFilter();
      lp.type            = 'lowpass';
      lp.frequency.value = 550;
      lp.Q.value         = 0.5;

      // Master wind gain — very subtle bed.
      const windGain = ctx.createGain();
      windGain.gain.value = 0.055;

      // Slow LFO (~0.08 Hz = one swell every ~12 s) modulates gain ±0.02 around centre.
      const lfoOsc  = ctx.createOscillator();
      lfoOsc.type            = 'sine';
      lfoOsc.frequency.value = 0.08;

      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.02;

      lfoOsc.connect(lfoGain);
      lfoGain.connect(windGain.gain);  // AudioParam as connection target

      src.connect(lp);
      lp.connect(windGain);
      windGain.connect(master);  // NOT through reverb — ambient, non-positional

      src.start();
      lfoOsc.start();

      // Store refs to avoid GC / duplicate allocation.
      this._windSrc     = src;
      this._windGain    = windGain;
      this._windLfoOsc  = lfoOsc;
      this._windLfoGain = lfoGain;
    } catch {
      // Wind unavailable — silent fallback, nothing breaks.
    }
  }

  setMaster(v: number): void {
    this._masterVol = v;
    if (this._master) this._master.gain.value = v;
  }

  updateListener(camera: THREE.Camera): void {
    if (!this._ctx || !this._unlocked) return;
    const listener = this._ctx.listener;
    const pos = this._scratchPos;
    camera.getWorldPosition(pos);
    const fwd = this._scratchFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const up  = this._scratchUp.set(0, 1,  0).applyQuaternion(camera.quaternion);

    // Cache listener world position for distance-based LP in positional sounds.
    if (this._listenerPos) {
      this._listenerPos.x = pos.x;
      this._listenerPos.y = pos.y;
      this._listenerPos.z = pos.z;
    } else {
      this._listenerPos = { x: pos.x, y: pos.y, z: pos.z };
    }

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
  // Internal: attach a positional panner (with reverb send + distance LP)
  // ---------------------------------------------------------------------------

  /**
   * Given a terminal node in a chain that should be spatialized, appends:
   *   terminalNode → panner → master
   *   panner → (reverbScaled) → reverbSend   [if reverb available]
   * Also sets `distLp.frequency` to the distance-based cutoff if provided.
   *
   * @param ctx         AudioContext
   * @param terminal    Last AudioNode in the dry chain (e.g. the gain/lp node)
   * @param pos         World position of the sound
   * @param pannerCfg   distanceModel / refDistance / maxDistance / rolloffFactor
   * @param reverbMul   Multiplier on the reverb send (0 = no reverb, 1 = full)
   * @param distLp      Optional existing lowpass node whose frequency to override
   */
  private _attachPanner(
    ctx: AudioCtxType,
    terminal: AudioNode,
    pos: Vec3,
    pannerCfg: { distanceModel: DistanceModelType; refDistance: number; maxDistance: number; rolloffFactor?: number },
    reverbMul: number,
    distLp?: BiquadFilterNode,
  ): PannerNode {
    const now = ctx.currentTime;

    // Distance-based LP cutoff. Only apply the override once we have a real
    // listener position; before the first updateListener leave the cutoff fully
    // OPEN (its default) rather than risk muffling a sound placed far from origin.
    const lp = this._listenerPos;
    if (distLp && lp) {
      const dx = pos.x - lp.x;
      const dy = pos.y - lp.y;
      const dz = pos.z - lp.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      distLp.frequency.setValueAtTime(distanceCutoff(dist), now);
    }

    const panner = ctx.createPanner();
    panner.panningModel  = 'HRTF';
    panner.distanceModel = pannerCfg.distanceModel;
    panner.refDistance   = pannerCfg.refDistance;
    panner.maxDistance   = pannerCfg.maxDistance;
    panner.rolloffFactor = pannerCfg.rolloffFactor ?? 1;
    panner.positionX.setValueAtTime(pos.x, now);
    panner.positionY.setValueAtTime(pos.y, now);
    panner.positionZ.setValueAtTime(pos.z, now);

    const master = this._master!; // caller already checked master != null
    terminal.connect(panner);
    panner.connect(master);

    // Route to reverb send when available and reverbMul > 0.
    const reverbSend = this._reverbSend;
    if (reverbSend && reverbMul > 0) {
      if (reverbMul === 1) {
        panner.connect(reverbSend);
      } else {
        // Scale the wet contribution per-sound without touching the global send gain.
        // Clamp to ≤ 1.0: a >1 send (explosion 1.3, heBoom 1.2) can clip the
        // convolver bus at point-blank range on some browsers. The "explosions
        // sound wetter" effect comes from their larger signal amplitude into the
        // bus, not from a >1 send — so this is purely a safety clamp.
        const wetScale = ctx.createGain();
        wetScale.gain.value = Math.min(reverbMul, 1.0);
        panner.connect(wetScale);
        wetScale.connect(reverbSend);
      }
    }

    return panner;
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
    reverbMul = 1.0,
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
      lp.connect(gain);
      this._attachPanner(ctx, gain, pos,
        { distanceModel: 'inverse', refDistance: 6, maxDistance: 90 },
        reverbMul,
        lp,  // pass the lp so its cutoff gets set from distance
      );
    } else {
      lp.connect(gain);
      gain.connect(master);
    }

    src.start(now);
    src.stop(now + duration + 0.02);
  }

  /**
   * Variant of `_noise` for occluded positional shots.
   * The LP cutoff is set to `lpFreq` (already the combined distance+occlusion value)
   * and `_attachPanner` is called WITHOUT a distLp argument so the override is skipped —
   * the caller is responsible for pre-computing the correct combined cutoff.
   * Only called from `gunshot` when `pos` is defined and `occlusion > 0`.
   */
  private _noiseOccluded(
    duration: number,
    bpFreq: number,
    lpFreq: number,
    gainVal: number,
    pos: Vec3,
    reverbMul: number,
  ): void {
    const ctx = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const now    = ctx.currentTime;
    const bufLen = Math.ceil(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const bp = ctx.createBiquadFilter();
    bp.type            = 'bandpass';
    bp.frequency.value = bpFreq;
    bp.Q.value         = 1.5;

    const lp = ctx.createBiquadFilter();
    lp.type            = 'lowpass';
    lp.frequency.value = lpFreq;   // pre-computed combined cutoff — no further override

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainVal, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    src.connect(bp);
    bp.connect(lp);
    lp.connect(gain);

    // Pass undefined for distLp → _attachPanner will NOT touch the LP frequency.
    this._attachPanner(ctx, gain, pos,
      { distanceModel: 'inverse', refDistance: 6, maxDistance: 90 },
      reverbMul,
      undefined,
    );

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

  /**
   * Play a gunshot, optionally spatialized at `pos`.
   *
   * @param weaponId  Weapon id (matches WEAPON_TONES key; falls back to 'usp').
   * @param pos       World position of the shooter.  Omit for the player's
   *                  own gun (mono, no distance LP, no panner).
   * @param occlusion 0 = clear line-of-sight (default, back-compat);
   *                  1 = fully wall-blocked.  Values in between interpolate.
   *                  Has no effect on non-positional (pos === undefined) calls.
   */
  gunshot(weaponId: string, pos?: Vec3, occlusion = 0): void {
    const tone = WEAPON_TONES[weaponId] ?? WEAPON_TONES['usp']!;

    // --- Occlusion: only for positional bot shots (pos defined, occlusion > 0). ---
    if (pos !== undefined && occlusion > 0) {
      const occ = Math.max(0, Math.min(1, occlusion));

      // Distance-based cutoff (computed now to combine with occlusion cutoff).
      let distCutoff = DIST_CUTOFF_OPEN;
      const lp = this._listenerPos;
      if (lp) {
        const dx = pos.x - lp.x;
        const dy = pos.y - lp.y;
        const dz = pos.z - lp.z;
        distCutoff = distanceCutoff(Math.sqrt(dx * dx + dy * dy + dz * dz));
      }

      // Occluded cutoff: lerp from fully-open toward the occlusion floor.
      const occCutoff = DIST_CUTOFF_OPEN + occ * (OCCLUDE_CUTOFF_HZ - DIST_CUTOFF_OPEN);
      // Take the more-muffled (lower) of distance vs occlusion cutoff; clamp to floor.
      const finalCutoff = Math.max(
        OCCLUDE_CUTOFF_FLOOR,
        Math.min(distCutoff, occCutoff),
      );

      // Slightly reduced gain for occluded shots (less level through walls).
      const gainMul = 1 - (1 - OCCLUDE_GAIN_MUL) * occ;
      const occludedGain = tone.gain * gainMul;

      // Use _noiseOccluded: sets the LP to finalCutoff and skips _attachPanner's
      // distance-LP override (passes distLp undefined) so the pre-computed combined
      // cutoff isn't clobbered.
      this._noiseOccluded(tone.duration, tone.bpFreq, finalCutoff, occludedGain, pos, 1.0);
    } else {
      // Normal path — fully back-compat (occlusion 0 or non-positional).
      // Gunshots are loud — full reverb (mul=1.0).
      this._noise(tone.duration, tone.bpFreq, tone.lpFreq, tone.gain, pos, 1.0);
    }

    // Sub-oscillator (deagle/awp/ak47 body thud) — dry, always unchanged.
    if (tone.subFreq > 0) {
      this._tone(tone.subFreq, tone.duration * 0.6, 0.25);
    }
  }

  dryFire(): void {
    this._click(0);
  }

  /**
   * Per-weapon-class synthesized reload foley.
   * Cosmetic only — Math.random() allowed; zero sim/determinism impact.
   *
   * @param weaponClass  WeaponDef.category — 'pistol' | 'smg' | 'heavy' | 'rifle'
   *                     Omit (or pass undefined) for the generic enriched reload.
   */
  reload(weaponClass?: string): void {
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const now = ctx.currentTime;

    /**
     * _reloadClick — a shaped noise burst used as mag/bolt click foley.
     * Purpose-built inline (NOT a wrapper around _click/_noise): the reload
     * stages need independent HP+LP shaping and per-stage gain/timing that the
     * fixed-shape _click helper doesn't expose, so the chain is inlined here.
     * hpFreq: highpass cutoff (higher = brighter / lighter click)
     * lpFreq: lowpass  cutoff (lower  = duller  / heavier thunk)
     * dur:    burst duration (seconds)
     * gain:   peak gain
     * delay:  seconds from now
     */
    const _reloadClick = (
      hpFreq: number,
      lpFreq: number,
      dur: number,
      gain: number,
      delay: number,
    ): void => {
      const t      = now + delay;
      const bufLen = Math.ceil(ctx.sampleRate * dur);
      const buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      const data   = buf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

      const src = ctx.createBufferSource();
      src.buffer = buf;

      const hp = ctx.createBiquadFilter();
      hp.type            = 'highpass';
      hp.frequency.value = hpFreq;

      const lp = ctx.createBiquadFilter();
      lp.type            = 'lowpass';
      lp.frequency.value = lpFreq;

      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);

      src.connect(hp);
      hp.connect(lp);
      lp.connect(g);
      g.connect(master);
      src.start(t);
      src.stop(t + dur + 0.01);
    };

    /**
     * _reloadTone — a brief metallic triangle blip for charging-handle snaps.
     * Purpose-built inline (NOT a wrapper around _tone, which is sine-only):
     * the metallic snap wants a triangle wave, so the chain is inlined here.
     * freq:  oscillator frequency (Hz)
     * dur:   tone duration
     * gain:  peak gain
     * delay: seconds from now
     */
    const _reloadTone = (
      freq: number,
      dur: number,
      gain: number,
      delay: number,
    ): void => {
      const t   = now + delay;
      const osc = ctx.createOscillator();
      osc.type            = 'triangle';
      osc.frequency.value = freq;

      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);

      osc.connect(g);
      g.connect(master);
      osc.start(t);
      osc.stop(t + dur + 0.01);
    };

    // Small random variation for each call so repeated reloads don't sound identical.
    const jitter = () => (Math.random() - 0.5) * 0.012; // ±6 ms timing jitter

    switch (weaponClass) {

      case 'pistol': {
        // Quick + light, two-stage, ~0.35–0.4 s total.
        // mag-out: bright, thin click (high HP, short burst).
        _reloadClick(2200, 7000, 0.018 + Math.random() * 0.006, 0.12 + Math.random() * 0.04, 0 + jitter());
        // mag-in: slightly lower/heavier but still light.
        _reloadClick(1400, 5000, 0.022 + Math.random() * 0.006, 0.15 + Math.random() * 0.04, 0.17 + jitter());
        // Slide snap (pistol slide forward after mag seat) — quick bright transient.
        _reloadClick(2600, 9000, 0.012, 0.11 + Math.random() * 0.03, 0.31 + jitter());
        break;
      }

      case 'smg': {
        // Mid-weight, mag out/in + a light bolt, ~0.55 s.
        // mag-out: mid click.
        _reloadClick(1800, 6000, 0.022 + Math.random() * 0.006, 0.14 + Math.random() * 0.03, 0 + jitter());
        // mag-in: heavier thunk.
        _reloadClick(900, 3500, 0.030 + Math.random() * 0.008, 0.18 + Math.random() * 0.04, 0.20 + jitter());
        // Bolt clack + subtle metallic tone — co-scheduled, so share ONE jittered
        // time (separate jitter() calls would flam them ±12 ms apart).
        const boltT = 0.42 + jitter();
        _reloadClick(1500, 5500, 0.016 + Math.random() * 0.004, 0.10 + Math.random() * 0.03, boltT);
        _reloadTone(1100 + Math.random() * 200, 0.025, 0.04 + Math.random() * 0.02, boltT);
        break;
      }

      case 'rifle': {
        // Heavier mag + charging-handle snap, ~0.65–0.8 s.
        // NOTE: bolt-action snipers (awp/ssg08/scar20/g3sg1 — all category 'rifle')
        // share this charging-handle foley. A deliberate, acceptable approximation:
        // one representative magazine-reload sound covers the whole class.
        // mag-out: solid mid-low click.
        _reloadClick(1200, 4500, 0.028 + Math.random() * 0.008, 0.16 + Math.random() * 0.04, 0 + jitter());
        // mag-in: heavy thunk with lower LP — the "snap" of the mag seating.
        _reloadClick(700, 2800, 0.038 + Math.random() * 0.010, 0.22 + Math.random() * 0.04, 0.22 + jitter());
        // Charging handle pull-back: brief mid-high.
        _reloadClick(1600, 5000, 0.020 + Math.random() * 0.006, 0.13 + Math.random() * 0.03, 0.48 + jitter());
        // Charging handle release: the distinctive metallic snap (click + pitched
        // tone). Co-scheduled, so share ONE jittered time to fuse into one transient.
        const chargeT = 0.60 + jitter();
        _reloadClick(1800, 6500, 0.024 + Math.random() * 0.006, 0.16 + Math.random() * 0.04, chargeT);
        _reloadTone(900 + Math.random() * 150, 0.035, 0.06 + Math.random() * 0.02, chargeT);
        break;
      }

      case 'heavy': {
        // Heaviest/chunkiest — low shell thunk + pump/bolt clack, ~0.5 s.
        // Primary impact (low-LP high-gain chunk) + layered sub-tone rumble are
        // co-scheduled, so share ONE jittered time to fuse into one heavy thunk.
        const thunkT = jitter();
        _reloadClick(300, 1400, 0.045 + Math.random() * 0.012, 0.28 + Math.random() * 0.05, thunkT);
        _reloadTone(280 + Math.random() * 80, 0.050, 0.08 + Math.random() * 0.03, thunkT);
        // Pump/bolt clack: shorter, slightly brighter (the action cycling).
        _reloadClick(1000, 3800, 0.028 + Math.random() * 0.008, 0.18 + Math.random() * 0.04, 0.32 + jitter());
        // Final metallic clank — bolt fully seated.
        _reloadClick(1400, 4800, 0.018 + Math.random() * 0.006, 0.12 + Math.random() * 0.03, 0.46 + jitter());
        break;
      }

      default: {
        // Generic enriched reload (back-compat for undefined / unknown class).
        // Three-stage: mag-out → mag-in → charge snap (better than original two bare clicks).
        _reloadClick(1600, 5000, 0.022 + Math.random() * 0.006, 0.14 + Math.random() * 0.04, 0 + jitter());
        _reloadClick(1000, 3500, 0.032 + Math.random() * 0.008, 0.18 + Math.random() * 0.04, 0.18 + jitter());
        _reloadClick(1800, 6000, 0.018 + Math.random() * 0.006, 0.12 + Math.random() * 0.03, 0.40 + jitter());
        break;
      }
    }
  }

  headshot(): void {
    this._tone(2200, 0.08, 0.35);
  }

  hitmarker(): void {
    this._tone(1400, 0.03, 0.25);
  }

  /**
   * Play a footstep sound, optionally spatialized at `pos`.
   * `surface` is the `CellLegend.mat` string from `world.cellAt(x,z).mat`; when
   * undefined or unrecognized the generic concrete timbre is used (back-compat).
   */
  footstep(pos?: Vec3, surface?: string): void {
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    // Resolve per-surface timbre; fall back to generic concrete parameters.
    // hasOwnProperty (not `in`) so a stray mat like "constructor"/"toString"
    // can't resolve to a prototype method and break the non-null assertion.
    const tmb: FootstepTimbre = (surface !== undefined &&
        Object.prototype.hasOwnProperty.call(FOOTSTEP_TIMBRES, surface))
      ? FOOTSTEP_TIMBRES[surface]!
      : { lpFreq: 400, gain: 0.12, decay: 0.06, toneFreq: 0, toneGain: 0 };

    const now    = ctx.currentTime;
    const bufLen = Math.ceil(ctx.sampleRate * tmb.decay);
    const buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const lp = ctx.createBiquadFilter();
    lp.type            = 'lowpass';
    lp.frequency.value = tmb.lpFreq;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(tmb.gain, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + tmb.decay);

    src.connect(lp);
    lp.connect(gain);

    // When positional, all components of the step (noise burst + tonal partials)
    // share ONE panner so the whole sound arrives from the same direction.
    let panner: PannerNode | null = null;
    if (pos) {
      // Footsteps: subtle reverb (mul=0.45), distance LP overrides the existing lp.
      panner = this._attachPanner(ctx, gain, pos,
        { distanceModel: 'inverse', refDistance: 4, maxDistance: 30 },
        0.45,
        lp,
      );
    } else {
      gain.connect(master);
    }

    src.start(now);
    src.stop(now + tmb.decay + 0.01);

    // Tonal component for wood (hollow resonance) and metal (ring/clang).
    // Route each tonal gain node into the shared panner when positional, else to
    // master — the tonal must come from the same direction as the noise burst.
    if (tmb.toneFreq > 0 && tmb.toneGain > 0) {
      const toneDest: AudioNode = panner ?? master;

      const osc = ctx.createOscillator();
      // Wood gets a low triangle blip; metal gets a sine partial.
      osc.type            = (surface === 'metal') ? 'sine' : 'triangle';
      osc.frequency.value = tmb.toneFreq;

      const toneGainNode = ctx.createGain();
      toneGainNode.gain.setValueAtTime(tmb.toneGain, now);
      toneGainNode.gain.exponentialRampToValueAtTime(0.001, now + tmb.decay * 1.4);

      osc.connect(toneGainNode);
      toneGainNode.connect(toneDest);
      osc.start(now);
      osc.stop(now + tmb.decay * 1.4 + 0.01);

      // For metal, add a detuned upper partial for the characteristic clang shimmer.
      if (surface === 'metal') {
        const osc2 = ctx.createOscillator();
        osc2.type            = 'sine';
        osc2.frequency.value = tmb.toneFreq * 1.87;  // inharmonic partial

        const toneGain2 = ctx.createGain();
        toneGain2.gain.setValueAtTime(tmb.toneGain * 0.5, now);
        toneGain2.gain.exponentialRampToValueAtTime(0.001, now + tmb.decay * 1.2);
        osc2.connect(toneGain2);
        toneGain2.connect(toneDest);
        osc2.start(now);
        osc2.stop(now + tmb.decay * 1.2 + 0.01);
      }
    }
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

    if (pos) {
      // Land thud: moderate reverb (mul=0.6), with distance LP.
      this._attachPanner(ctx, gain, pos,
        { distanceModel: 'inverse', refDistance: 5, maxDistance: 40 },
        0.6,
        lp,
      );
    } else {
      gain.connect(master);
    }

    src.start(now);
    src.stop(now + 0.14);
  }

  // ---------------------------------------------------------------------------
  // Bomb / round-end / buy audio (appended — existing code untouched above)
  // ---------------------------------------------------------------------------

  /** Short 1.05 kHz square blip for bomb beep. */
  bombBeep(pos?: Vec3): void {
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type            = 'square';
    osc.frequency.value = 1050;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.setValueAtTime(0.18, now + 0.055);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

    osc.connect(gain);

    if (pos) {
      // Bomb beep: subtle reverb (mul=0.5). Add distance LP via a fresh filter.
      const distLp = ctx.createBiquadFilter();
      distLp.type = 'lowpass';
      // Default open; _attachPanner will override from distance.
      distLp.frequency.value = DIST_CUTOFF_OPEN;

      gain.connect(distLp);
      this._attachPanner(ctx, distLp, pos,
        { distanceModel: 'inverse', refDistance: 8, maxDistance: 80 },
        0.5,
        distLp,
      );
    } else {
      gain.connect(master);
    }

    osc.start(now);
    osc.stop(now + 0.09);
  }

  /** Rising-pitch zip for bomb plant confirmation. */
  bombPlant(): void {
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(400, now);
    osc.frequency.exponentialRampToValueAtTime(1200, now + 0.22);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

    osc.connect(gain);
    gain.connect(master);
    osc.start(now);
    osc.stop(now + 0.27);
  }

  /** Descending-pitch resolve for bomb defuse. */
  bombDefused(): void {
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const now = ctx.currentTime;
    // Two tones descending.
    const freqs = [880, 660];
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type            = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.22, now + i * 0.14);
      g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.14 + 0.18);
      osc.connect(g);
      g.connect(master);
      osc.start(now + i * 0.14);
      osc.stop(now + i * 0.14 + 0.2);
    });
  }

  /** Loud low-noise boom with sub-sine drop for explosion. */
  explosion(pos?: Vec3): void {
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const now = ctx.currentTime;
    const dur = 1.6;

    // Noise burst (long, low).
    const bufLen = Math.ceil(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const lp = ctx.createBiquadFilter();
    lp.type            = 'lowpass';
    lp.frequency.value = 350;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(1.4, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(lp);
    lp.connect(gain);

    if (pos) {
      // Explosions: high reverb (mul=1.3 — the biggest impact sounds get most space).
      this._attachPanner(ctx, gain, pos,
        { distanceModel: 'inverse', refDistance: 20, maxDistance: 200 },
        1.3,
        lp,
      );
    } else {
      gain.connect(master);
    }
    src.start(now);
    src.stop(now + dur + 0.05);

    // Sub-sine drop — dry, non-positional.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(90, now);
    sub.frequency.exponentialRampToValueAtTime(25, now + 0.8);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.7, now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
    sub.connect(subGain);
    subGain.connect(master);
    sub.start(now);
    sub.stop(now + 0.95);
  }

  /** Two-note sting for round end. */
  roundEnd(win: boolean): void {
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const now   = ctx.currentTime;
    const notes = win
      ? [440, 660]   // up — win
      : [440, 330];  // down — loss

    notes.forEach((f, i) => {
      const osc  = ctx.createOscillator();
      osc.type            = 'triangle';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.3, now + i * 0.2);
      g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.2 + 0.3);
      osc.connect(g);
      g.connect(master);
      osc.start(now + i * 0.2);
      osc.stop(now + i * 0.2 + 0.35);
    });
  }

  /**
   * Weapon deploy / draw foley — played when the player switches weapon slots.
   * Non-positional (player's own action → straight to master, no panner).
   * Cosmetic only — Math.random() allowed; zero sim/determinism impact.
   *
   * Sound design:
   *  - All classes: a quick metallic snap (shaped noise) + a short soft whoosh.
   *  - 'pistol': lighter/higher (brighter HP cutoff, shorter duration).
   *  - 'rifle' / 'heavy': heavier/lower (deeper LP cutoff, slightly longer duration).
   *  - 'knife': very light high tick.
   *  - Default (smg / unknown): mid weight.
   *
   * @param weaponClass  WeaponDef.category ('pistol' | 'smg' | 'heavy' | 'rifle')
   *                     or undefined for the generic deploy sound.
   */
  weaponDraw(weaponClass?: string): void {
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const now = ctx.currentTime;

    // Per-class tuning: [snapHpHz, snapLpHz, snapDur, snapGain, whooshBpHz, whooshDur, whooshGain]
    // snap  = shaped noise burst (the "click/clack" of the weapon coming up)
    // whoosh = brief filtered noise tail (the "swish" of the weapon moving)
    let snapHp     = 1600;
    let snapLp     = 6000;
    let snapDur    = 0.025;
    let snapGain   = 0.16;
    let whooshBp   = 800;
    let whooshDur  = 0.18;
    let whooshGain = 0.06;

    switch (weaponClass) {
      case 'pistol':
        // Lighter, higher frequency — pistol comes up quick.
        snapHp     = 2200;
        snapLp     = 9000;
        snapDur    = 0.018;
        snapGain   = 0.12;
        whooshBp   = 1100;
        whooshDur  = 0.13;
        whooshGain = 0.045;
        break;
      case 'rifle':
        // Heavier, mid-low — solid rifle raise.
        snapHp     = 1100;
        snapLp     = 4200;
        snapDur    = 0.032;
        snapGain   = 0.20;
        whooshBp   = 600;
        whooshDur  = 0.22;
        whooshGain = 0.07;
        break;
      case 'heavy':
        // Deepest / chunkiest — shotgun/machinegun weight.
        snapHp     = 700;
        snapLp     = 2800;
        snapDur    = 0.040;
        snapGain   = 0.24;
        whooshBp   = 450;
        whooshDur  = 0.25;
        whooshGain = 0.08;
        break;
      case 'knife':
        // Very light high tick.
        snapHp     = 3000;
        snapLp     = 12000;
        snapDur    = 0.012;
        snapGain   = 0.08;
        whooshBp   = 1400;
        whooshDur  = 0.10;
        whooshGain = 0.03;
        break;
      // 'smg' and default: use the baseline values above.
    }

    // Small random jitter so repeated draws never sound identical.
    const jitter = () => (Math.random() - 0.5) * 0.008; // ±4 ms

    // --- Metallic snap (noise + HP + LP) ---
    {
      const t      = now + jitter();
      const bufLen = Math.ceil(ctx.sampleRate * snapDur);
      const buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      const data   = buf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

      const src = ctx.createBufferSource();
      src.buffer = buf;

      const hp = ctx.createBiquadFilter();
      hp.type            = 'highpass';
      hp.frequency.value = snapHp;

      const lp = ctx.createBiquadFilter();
      lp.type            = 'lowpass';
      lp.frequency.value = snapLp + Math.random() * snapLp * 0.15;

      const g = ctx.createGain();
      g.gain.setValueAtTime(snapGain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + snapDur);

      src.connect(hp);
      hp.connect(lp);
      lp.connect(g);
      g.connect(master);
      src.start(t);
      src.stop(t + snapDur + 0.01);
    }

    // --- Soft whoosh (bandpass noise, ramp-up/down) ---
    {
      const delay  = snapDur * 0.4 + jitter();  // starts slightly after the snap
      const t      = now + delay;
      const bufLen = Math.ceil(ctx.sampleRate * whooshDur);
      const buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      const data   = buf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

      const src = ctx.createBufferSource();
      src.buffer = buf;

      const bp = ctx.createBiquadFilter();
      bp.type            = 'bandpass';
      bp.frequency.value = whooshBp * (0.9 + Math.random() * 0.2);
      bp.Q.value         = 0.7;

      const lp2 = ctx.createBiquadFilter();
      lp2.type            = 'lowpass';
      lp2.frequency.value = whooshBp * 2.2;

      const g = ctx.createGain();
      const peakAt = t + whooshDur * 0.25;
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(whooshGain, peakAt);
      g.gain.exponentialRampToValueAtTime(0.001, t + whooshDur);

      src.connect(bp);
      bp.connect(lp2);
      lp2.connect(g);
      g.connect(master);
      src.start(t);
      src.stop(t + whooshDur + 0.02);
    }
  }

  /**
   * Scope toggle click — a soft, very short click when scoping in or out.
   * Non-positional (player-local UI sound → straight to master).
   * Cosmetic only — Math.random() allowed; zero sim/determinism impact.
   *
   * Sound design:
   *  - scopingIn = true:  slightly higher-pitched, brighter (lens clicking into place).
   *  - scopingIn = false: lower/duller (lens releasing).
   *  Both are very quiet (~0.08–0.12 s); subtle enough not to obscure game audio.
   *
   * @param scopingIn  true = player just scoped in; false = just un-scoped.
   */
  scopeToggle(scopingIn: boolean): void {
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const now = ctx.currentTime;
    const dur = 0.020 + Math.random() * 0.008; // 20–28 ms

    // Scope in: brighter (HP=2400, LP=8000); scope out: duller (HP=800, LP=3000).
    const hpFreq   = scopingIn ? 2400 : 800;
    const lpFreq   = scopingIn ? 8000 : 3000;
    const gainPeak = scopingIn ? 0.13  : 0.10;

    const bufLen = Math.ceil(ctx.sampleRate * dur);
    const buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const hp = ctx.createBiquadFilter();
    hp.type            = 'highpass';
    hp.frequency.value = hpFreq;

    const lp = ctx.createBiquadFilter();
    lp.type            = 'lowpass';
    lp.frequency.value = lpFreq;

    const g = ctx.createGain();
    g.gain.setValueAtTime(gainPeak, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(hp);
    hp.connect(lp);
    lp.connect(g);
    g.connect(master);
    src.start(now);
    src.stop(now + dur + 0.01);
  }

  /** Quick click for buy success. */
  buyClick(): void {
    this._click(0);
    this._click(0.06);
  }

  /** Dull thud for buy failure / can't buy. */
  cantBuy(): void {
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const now    = ctx.currentTime;
    const bufLen = Math.ceil(ctx.sampleRate * 0.08);
    const buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const lp = ctx.createBiquadFilter();
    lp.type            = 'lowpass';
    lp.frequency.value = 200;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

    src.connect(lp);
    lp.connect(gain);
    gain.connect(master);  // DRY — UI sound, no reverb
    src.start(now);
    src.stop(now + 0.1);
  }

  // ---------------------------------------------------------------------------
  // Grenade audio (appended — existing code untouched above)
  // ---------------------------------------------------------------------------

  /**
   * Short metallic tick on grenade bounce.  Volume is scaled by impact speed
   * (speed ≥ 10 m/s → full gain; linear below that).
   */
  grenadeBounce(pos: Vec3, speed: number): void {
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const vol = Math.min(1, speed / 10) * 0.22;
    if (vol < 0.005) return;

    const now    = ctx.currentTime;
    const dur    = 0.06;
    const bufLen = Math.ceil(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    // Bandpass in the metallic clank range.
    const bp = ctx.createBiquadFilter();
    bp.type            = 'bandpass';
    bp.frequency.value = 2200;
    bp.Q.value         = 4;

    // Short high-pass to cut low rumble.
    const hp = ctx.createBiquadFilter();
    hp.type            = 'highpass';
    hp.frequency.value = 1400;

    // Distance LP on the output of the hp chain.
    const distLp = ctx.createBiquadFilter();
    distLp.type            = 'lowpass';
    distLp.frequency.value = DIST_CUTOFF_OPEN;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(bp);
    bp.connect(hp);
    hp.connect(distLp);
    distLp.connect(gain);

    // Grenade bounce: light reverb (mul=0.55) — small metallic tick.
    this._attachPanner(ctx, gain, pos,
      { distanceModel: 'inverse', refDistance: 5, maxDistance: 40 },
      0.55,
      distLp,
    );
    src.start(now);
    src.stop(now + dur + 0.02);
  }

  /**
   * Player-local soft whoosh on throw.  No positional panning — the sound
   * belongs to the player's own action.
   */
  grenadeThrowWhoosh(): void {
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const now = ctx.currentTime;
    const dur = 0.18;

    const bufLen = Math.ceil(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const bp = ctx.createBiquadFilter();
    bp.type            = 'bandpass';
    bp.frequency.value = 800;
    bp.Q.value         = 0.6;

    const lp = ctx.createBiquadFilter();
    lp.type            = 'lowpass';
    lp.frequency.value = 1200;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(bp);
    bp.connect(lp);
    lp.connect(gain);
    gain.connect(master);  // DRY — player-local action sound
    src.start(now);
    src.stop(now + dur + 0.02);
  }

  /**
   * HE grenade explosion — variant of bomb explosion, smaller/sharper
   * (shorter dur, higher LP cutoff, lighter sub drop).
   */
  heBoom(pos: Vec3): void {
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const now = ctx.currentTime;
    const dur = 0.9;

    const bufLen = Math.ceil(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const lp = ctx.createBiquadFilter();
    lp.type            = 'lowpass';
    lp.frequency.value = 600;   // sharper than bomb (350 Hz)

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.85, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(lp);
    lp.connect(gain);

    // HE boom: high reverb (mul=1.2) — impactful explosion.
    this._attachPanner(ctx, gain, pos,
      { distanceModel: 'inverse', refDistance: 12, maxDistance: 120 },
      1.2,
      lp,
    );
    src.start(now);
    src.stop(now + dur + 0.05);

    // Sub-sine drop — lighter than bomb, stays dry.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(70, now);
    sub.frequency.exponentialRampToValueAtTime(22, now + 0.45);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.35, now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    sub.connect(subGain);
    subGain.connect(master);
    sub.start(now);
    sub.stop(now + 0.55);
  }

  /**
   * Flash-bang detonation pop — positional crack.
   */
  flashPop(pos: Vec3): void {
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const now = ctx.currentTime;
    const dur = 0.08;

    const bufLen = Math.ceil(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const hp = ctx.createBiquadFilter();
    hp.type            = 'highpass';
    hp.frequency.value = 2500;

    const lp = ctx.createBiquadFilter();
    lp.type            = 'lowpass';
    lp.frequency.value = 8000;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.55, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(hp);
    hp.connect(lp);
    lp.connect(gain);

    // Flash pop: moderate reverb (mul=0.9) — crisp crack with some space.
    this._attachPanner(ctx, gain, pos,
      { distanceModel: 'inverse', refDistance: 8, maxDistance: 60 },
      0.9,
      lp,
    );
    src.start(now);
    src.stop(now + dur + 0.02);
  }

  /**
   * Flash-bang tinnitus ring — local player-only high sine fading over
   * (1 + 2*intensity) seconds.  Safe to call repeatedly; each call
   * schedules its own independent envelope node and restarts naturally.
   */
  flashRing(intensity: number): void {
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const dur = 1 + 2 * Math.max(0, Math.min(1, intensity));
    const now = ctx.currentTime;

    // Tinnitus sine.
    const osc = ctx.createOscillator();
    osc.type            = 'sine';
    osc.frequency.value = 3200;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.35 * intensity, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    osc.connect(gain);

    // Cheap ambience duck: low-pass the master bus side-chain — keep simple,
    // just add a short-lived LP on the master output path.
    if (intensity > 0.3) {
      const duck = ctx.createBiquadFilter();
      duck.type            = 'lowpass';
      duck.frequency.value = 600;
      duck.frequency.setValueAtTime(600, now);
      duck.frequency.exponentialRampToValueAtTime(20000, now + Math.min(dur, 1.5));

      // Route tinnitus → duck → master; this creates an additive node not
      // affecting existing audio routing — no global state mutation.
      gain.connect(duck);
      duck.connect(master);
    } else {
      gain.connect(master);
    }

    osc.start(now);
    osc.stop(now + dur + 0.05);
  }

  /**
   * Bullet near-miss crack — a short (~40–55 ms) supersonic snap played at the
   * closest point on the bullet's flight path.  Two layered components:
   *
   *  1. Noise transient: white noise through a bandpass (centred ~3–4 kHz,
   *     slight random variation) + lowpass at ~6 kHz → very fast exponential
   *     decay.  Gives the sharp "crack" character.
   *  2. Descending-pitch zip: a sawtooth oscillator sweeping from ~3.5 kHz
   *     down to ~400 Hz over ~45 ms.  Adds the Doppler-ish "zip" tail.
   *
   * Both components share ONE panner at `pos` so the crack pans correctly to
   * the side the bullet passed.  Moderate gain — audible but not overwhelming.
   * All randomness via Math.random() (cosmetic; never on sim paths).
   */
  bulletWhiz(pos: Vec3): void {
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const now = ctx.currentTime;

    // Slight random variation in duration (40–55 ms) and bandpass center.
    const dur      = 0.040 + Math.random() * 0.015;
    const bpCenter = 3000 + Math.random() * 1200;  // 3000–4200 Hz

    // --- Component 1: noise transient ---
    const bufLen = Math.ceil(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = buffer;

    const bp = ctx.createBiquadFilter();
    bp.type            = 'bandpass';
    bp.frequency.value = bpCenter;
    bp.Q.value         = 2.0;

    const noiseLp = ctx.createBiquadFilter();
    noiseLp.type            = 'lowpass';
    noiseLp.frequency.value = 6000;

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.28, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    noiseSrc.connect(bp);
    bp.connect(noiseLp);
    noiseLp.connect(noiseGain);

    // --- Component 2: descending-pitch zip ---
    const zipStartFreq = 3200 + Math.random() * 500;   // ~3200–3700 Hz
    const zipEndFreq   = 350  + Math.random() * 100;   // ~350–450 Hz
    const zipDur       = dur + 0.005;                  // slightly longer tail

    const zipOsc = ctx.createOscillator();
    zipOsc.type = 'sawtooth';
    zipOsc.frequency.setValueAtTime(zipStartFreq, now);
    zipOsc.frequency.exponentialRampToValueAtTime(zipEndFreq, now + zipDur);

    const zipGain = ctx.createGain();
    zipGain.gain.setValueAtTime(0.10, now);
    zipGain.gain.exponentialRampToValueAtTime(0.001, now + zipDur);

    zipOsc.connect(zipGain);

    // --- Shared panner: HRTF, short-to-medium range ---
    // Build the panner manually (rather than using _attachPanner which expects
    // a single terminal AudioNode) so we can fan two sources into it.
    const distLp = ctx.createBiquadFilter();
    distLp.type            = 'lowpass';
    distLp.frequency.value = DIST_CUTOFF_OPEN;  // overridden by distance below

    // Mix both components through the shared distLp → panner chain.
    noiseGain.connect(distLp);
    zipGain.connect(distLp);

    // Use _attachPanner on distLp as the terminal node; it sets the distance LP
    // frequency and routes panner → master (+ reverb send when available).
    this._attachPanner(ctx, distLp, pos,
      { distanceModel: 'inverse', refDistance: 3, maxDistance: 60, rolloffFactor: 1 },
      0.35,   // light reverb — it's a transient crack, not a sustained explosion
      distLp,
    );

    // Schedule sources.
    noiseSrc.start(now);
    noiseSrc.stop(now + dur + 0.02);
    zipOsc.start(now);
    zipOsc.stop(now + zipDur + 0.02);
  }

  /**
   * Smoke grenade pop — soft hiss burst ~0.8 s, positional.
   */
  smokePop(pos: Vec3): void {
    const ctx    = this._ctx;
    const master = this._master;
    if (!ctx || !master || !this._unlocked) return;

    const now = ctx.currentTime;
    const dur = 0.8;

    const bufLen = Math.ceil(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    // Narrow bandpass for a hiss character.
    const bp = ctx.createBiquadFilter();
    bp.type            = 'bandpass';
    bp.frequency.value = 3000;
    bp.Q.value         = 0.5;

    const lp = ctx.createBiquadFilter();
    lp.type            = 'lowpass';
    lp.frequency.value = 5000;

    const gain = ctx.createGain();
    // Soft attack then slow fade.
    gain.gain.setValueAtTime(0.0, now);
    gain.gain.linearRampToValueAtTime(0.28, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(bp);
    bp.connect(lp);
    lp.connect(gain);

    // Smoke pop: light reverb (mul=0.6) — soft hiss stays subtle.
    this._attachPanner(ctx, gain, pos,
      { distanceModel: 'inverse', refDistance: 6, maxDistance: 50 },
      0.6,
      lp,
    );
    src.start(now);
    src.stop(now + dur + 0.05);
  }
}

export const audio = new GameAudio();
