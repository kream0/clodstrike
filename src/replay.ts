/**
 * replay.ts — Replay recorder, log format, and playback cursor.
 *
 * Pure library module: NO imports from game.ts, main.ts, or hud.ts.
 * All types are self-contained here; main.ts imports ReplayTickInput from this
 * module to feed the fixed-step loop.
 *
 * Memory budget:
 *   A 10-min match = 76,800 ticks. Each ReplayTickInput ~10 booleans/numbers.
 *   Approx. 76,800 × 60 bytes ≈ 4.6 MB — well within browser RAM.
 *   Hard cap: 30 min (230,400 ticks) with a console warning.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Every field the fixed-step sim loop reads from the player each tick. */
export interface ReplayTickInput {
  // Movement keys
  forward: number;    // +1 W, -1 S, 0
  strafe:  number;    // +1 D, -1 A, 0
  jump:    boolean;
  crouch:  boolean;
  walk:    boolean;
  eHeld:   boolean;   // E key (plant/defuse)
  // Weapon inputs (only valid on first tick of a frame — main enforces edgesConsumed)
  mouseDown:     boolean; // auto-fire held state
  mousePressed:  boolean; // rising edge this tick (or false after edgesConsumed)
  mouse2Pressed: boolean; // scope toggle rising edge
  reloadEdge:    boolean; // R key rising edge
  digit4Pressed: boolean; // grenade equip edge
  wheelDelta:    number;  // scroll wheel (slot switch)
  // Slot switch — recorded so grenade cancel / viewmodel sync replays exactly
  slotSwitchThisFrame: boolean;
}

/**
 * One render frame worth of inputs.
 * yaw/pitch are applied once per frame (before the tick burst) — stored here
 * rather than per-tick to match how main.ts applies mouse look.
 */
export interface ReplayFrame {
  yaw:   number;
  pitch: number;
  ticks: ReplayTickInput[];
}

/** Serializable subset of MatchOptions needed to reconstruct the match. */
export interface ReplayMatchOpts {
  playerTeam:   'CT' | 'T';
  difficulty:   'easy' | 'normal' | 'hard';
  botsPerTeam?: number;
  mapId?:       string;
}

/**
 * The complete replay log for one match.
 * version=1 so we can detect/reject stale logs in future format changes.
 */
export interface ReplayLog {
  version:         1;
  seed:            number;
  opts:            ReplayMatchOpts;
  frames:          ReplayFrame[];
  /** Global tick index (across frames) at which each round began (roundStart event). */
  roundStartTicks: number[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum ticks recorded before we stop and warn. ~30 min at 128 Hz. */
const MAX_RECORD_TICKS = 230_400;

// ---------------------------------------------------------------------------
// ReplayRecorder
// ---------------------------------------------------------------------------

/**
 * Always-on recorder: call beginMatch at every match start, then per frame
 * call beginFrame + recordTick (once per sim tick), markRoundStart on roundStart
 * events, and endMatch when the match finishes.
 *
 * Thread safety: single-threaded JS — no concerns.
 */
export class ReplayRecorder {
  private _log:         ReplayLog | null = null;
  private _currentFrame: ReplayFrame | null = null;
  private _globalTick   = 0;
  private _capped       = false;

  // Number of fully completed rounds (rounds that ended) so the caller can
  // enable the "Watch last round" button once at least one has finished.
  private _completedRounds = 0;

  /** Start a fresh log. Discards any previous recording. */
  beginMatch(seed: number, opts: ReplayMatchOpts): void {
    this._log = {
      version: 1,
      seed,
      opts,
      frames:          [],
      roundStartTicks: [],
    };
    this._currentFrame   = null;
    this._globalTick     = 0;
    this._capped         = false;
    this._completedRounds = 0;
  }

  /**
   * Begin a new render frame. Call this ONCE per render frame, after mouse-look
   * has been applied to the player (yaw/pitch are current) but before the
   * fixed-step tick burst.
   */
  beginFrame(yaw: number, pitch: number): void {
    if (this._log === null || this._capped) return;
    this._currentFrame = { yaw, pitch, ticks: [] };
  }

  /**
   * Record one sim tick's input values. Call inside the fixed-step loop,
   * after the edgesConsumed gate has been applied (so the recorded values
   * exactly match what the sim received).
   *
   * Returns false if the cap has been reached (caller can ignore).
   */
  recordTick(input: ReplayTickInput): boolean {
    if (this._log === null || this._capped) return false;
    if (this._currentFrame === null) return false;

    if (this._globalTick >= MAX_RECORD_TICKS) {
      if (!this._capped) {
        console.warn('[ReplayRecorder] 30-minute cap reached — recording stopped.');
        this._capped = true;
        // Flush the partial current frame so the log stays consistent.
        this._flushFrame();
      }
      return false;
    }

    // Copy to avoid aliasing (the caller reuses these fields each tick).
    this._currentFrame.ticks.push({ ...input });
    this._globalTick++;
    return true;
  }

  /**
   * Mark the current global tick as a round-start boundary.
   * Call when the roundStart event fires.
   */
  markRoundStart(globalTick: number): void {
    if (this._log === null) return;
    this._log.roundStartTicks.push(globalTick);
  }

  /** Call when the round ends to increment the completed-round counter. */
  notifyRoundEnd(): void {
    this._completedRounds++;
  }

  /** Flush the current frame into the log. Call at end of each render frame. */
  flushFrame(): void {
    this._flushFrame();
  }

  private _flushFrame(): void {
    if (this._log === null || this._currentFrame === null) return;
    if (this._currentFrame.ticks.length > 0) {
      this._log.frames.push(this._currentFrame);
    }
    this._currentFrame = null;
  }

  /** Signal match end. Flushes any open frame. Returns the completed log and nulls the internal reference so post-endMatch writes are no-ops. */
  endMatch(): ReplayLog | null {
    this._flushFrame();
    const completed = this._log;
    this._log = null;
    return completed;
  }

  /** The completed log, or null if no match has been started/finished yet. */
  get log(): ReplayLog | null {
    return this._log;
  }

  /** How many rounds have been completed (roundEnd events) in the current match. */
  get lastCompletedRound(): number {
    return this._completedRounds;
  }

  /** Current global tick count (total sim ticks recorded so far). */
  get globalTick(): number {
    return this._globalTick;
  }
}

// ---------------------------------------------------------------------------
// ReplayCursor
// ---------------------------------------------------------------------------

/**
 * Playback cursor over a ReplayLog.
 * Iterate frame-by-frame with nextFrame(), or seek to a global tick boundary
 * with seekTick() before starting playback.
 */
export class ReplayCursor {
  private readonly _log: ReplayLog;
  private _frameIdx = 0;

  constructor(log: ReplayLog) {
    if (log.version !== 1) {
      throw new Error(`[ReplayCursor] Unsupported replay version: ${log.version}`);
    }
    this._log = log;
  }

  /**
   * Seek to the frame that contains the given global tick index.
   * After seeking, the next nextFrame() call returns that frame.
   * If globalTick is beyond the log, cursor is set to done.
   */
  seekTick(globalTick: number): void {
    if (globalTick <= 0) {
      this._frameIdx = 0;
      return;
    }

    let accumTicks = 0;
    for (let i = 0; i < this._log.frames.length; i++) {
      const frame = this._log.frames[i]!;
      const nextAccum = accumTicks + frame.ticks.length;
      if (nextAccum > globalTick) {
        // The target tick is inside this frame.
        this._frameIdx = i;
        return;
      }
      accumTicks = nextAccum;
    }
    // Beyond end.
    this._frameIdx = this._log.frames.length;
  }

  /**
   * Return the next frame and advance the cursor, or null if done.
   */
  nextFrame(): ReplayFrame | null {
    if (this._frameIdx >= this._log.frames.length) return null;
    const frame = this._log.frames[this._frameIdx]!;
    this._frameIdx++;
    return frame;
  }

  /** True when all frames have been consumed. */
  get done(): boolean {
    return this._frameIdx >= this._log.frames.length;
  }

  /** The underlying log (read-only). */
  get log(): ReplayLog {
    return this._log;
  }

  /** Current frame index. */
  get frameIndex(): number {
    return this._frameIdx;
  }
}
