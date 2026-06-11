import type { Game, GamePhase, MatchOptions } from './game';
import { RULES } from './constants';
import { gameEvents } from './combat';
import { isScoped, currentSpread } from './weapons';
import { DUST2 } from './maps/dust2';

// ---------------------------------------------------------------------------
// CSS injected once
// ---------------------------------------------------------------------------

const HUD_CSS = `
/* ── CS2 HUD overlay ─────────────────────────────────────────── */
#hud-root * { box-sizing: border-box; margin: 0; padding: 0; }

#hud-root {
  position: fixed; inset: 0;
  pointer-events: none;
  font-family: 'Segoe UI', system-ui, sans-serif;
  font-size: 13px;
  color: #f0f0f0;
  z-index: 100;
}

/* ── Health / Armor ─── */
#hud-health {
  position: absolute; bottom: 56px; left: 18px;
  display: flex; flex-direction: column; gap: 4px;
}
#hud-health .hp-val { font-size: 28px; font-weight: 700; letter-spacing: -1px; }
#hud-health .bar-row { display: flex; align-items: center; gap: 6px; }
#hud-health .bar-label { font-size: 10px; text-transform: uppercase; opacity: 0.7; width: 36px; }
#hud-health .bar-track {
  width: 100px; height: 5px; border-radius: 2px;
  background: rgba(255,255,255,0.15);
}
#hud-health .bar-fill { height: 100%; border-radius: 2px; transition: width 0.1s; }
#hud-health .bar-hp   { background: #54e87a; }
#hud-health .bar-armor{ background: #5ba7e8; }

/* ── Ammo / Weapon ─── */
#hud-ammo {
  position: absolute; bottom: 56px; right: 18px;
  text-align: right;
}
#hud-ammo .ammo-count { font-size: 34px; font-weight: 700; letter-spacing: -1px; line-height: 1; }
#hud-ammo .ammo-reserve { font-size: 16px; opacity: 0.6; margin-left: 4px; }
#hud-ammo .weapon-name { font-size: 11px; text-transform: uppercase; opacity: 0.65; margin-top: 2px; }
#hud-ammo .money { font-size: 18px; font-weight: 600; color: #ffe277; margin-top: 6px; }

/* ── Top-center ─── */
#hud-top {
  position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
  text-align: center; display: flex; flex-direction: column; align-items: center; gap: 2px;
}
#hud-top .timer {
  font-size: 28px; font-weight: 700; letter-spacing: 1px; min-width: 80px;
  background: rgba(0,0,0,0.4); border-radius: 4px; padding: 2px 12px;
}
#hud-top .timer.bomb-planted { color: #ff4444; }
#hud-top .score-row { font-size: 22px; font-weight: 700; display: flex; gap: 10px; align-items: center; }
#hud-top .score-ct  { color: #7da8d8; }
#hud-top .score-t   { color: #d8b76a; }
#hud-top .score-sep { color: #aaa; font-size: 16px; }
#hud-top .round-num { font-size: 11px; opacity: 0.55; text-transform: uppercase; letter-spacing: 1px; }

/* ── Crosshair ─── */
#hud-crosshair {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
}

/* ── AWP scope overlay ─── */
#hud-scope {
  position: fixed; inset: 0;
  pointer-events: none;
  background: radial-gradient(circle 120px at 50% 50%, transparent 118px, rgba(0,0,0,0.97) 120px);
  display: none;
}
#hud-scope::before {
  content: '';
  position: absolute;
  top: 0; left: 50%; transform: translateX(-50%);
  width: 2px; height: 100%; background: rgba(0,0,0,0.8);
}
#hud-scope::after {
  content: '';
  position: absolute;
  left: 0; top: 50%; transform: translateY(-50%);
  height: 2px; width: 100%; background: rgba(0,0,0,0.8);
}

/* ── Killfeed ─── */
#hud-killfeed {
  position: absolute; top: 60px; right: 14px;
  display: flex; flex-direction: column; gap: 4px;
  min-width: 220px; max-width: 320px;
}
.killfeed-entry {
  background: rgba(0,0,0,0.55); border-radius: 3px;
  padding: 3px 8px; font-size: 12px;
  animation: kf-fadein 0.15s ease-out;
  display: flex; align-items: center; gap: 4px;
}
@keyframes kf-fadein { from { opacity: 0; transform: translateX(16px); } to { opacity:1; transform: none; } }
.kf-victim  { color: #ff6b6b; }
.kf-hs      { color: #ffcc44; font-weight: 700; }
.kf-weapon  { opacity: 0.7; font-size: 11px; }

/* ── Damage vignette ─── */
#hud-dmg-vignette {
  position: fixed; inset: 0; pointer-events: none;
  background: radial-gradient(ellipse at 50% 50%, transparent 40%, rgba(180,0,0,0.55) 100%);
  opacity: 0; transition: opacity 0.15s;
}
#hud-dmg-dir {
  position: fixed; inset: 0; pointer-events: none;
}
.dmg-arc {
  position: absolute; top: 50%; left: 50%;
  width: 40px; height: 40px; margin: -20px;
  border-radius: 50%;
  border: 3px solid rgba(200,40,40,0);
  border-top-color: rgba(200,40,40,0.85);
  opacity: 0;
}

/* ── Radar ─── */
#hud-radar {
  position: absolute; top: 14px; left: 14px;
  width: 168px; height: 168px;
  border: 1px solid rgba(255,255,255,0.2);
  background: rgba(0,0,0,0.5);
  border-radius: 3px; overflow: hidden;
}
#hud-radar canvas { display: block; }

/* ── Scoreboard ─── */
#hud-scoreboard {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.75);
  display: none; align-items: flex-start; justify-content: center;
  padding-top: 60px;
  pointer-events: auto;
}
#hud-scoreboard.visible { display: flex; }
.sb-panel {
  background: rgba(20,20,20,0.9); border-radius: 6px;
  padding: 14px; min-width: 320px; margin: 0 8px;
}
.sb-panel h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
.sb-panel.ct h3 { color: #7da8d8; }
.sb-panel.t  h3 { color: #d8b76a; }
.sb-row {
  display: grid; grid-template-columns: 1fr 36px 36px 60px;
  gap: 4px; padding: 3px 4px; border-radius: 3px; font-size: 12px;
}
.sb-row.dead { opacity: 0.4; }
.sb-row:nth-child(odd) { background: rgba(255,255,255,0.04); }
.sb-head { font-size: 10px; text-transform: uppercase; opacity: 0.55; margin-bottom: 2px; }

/* ── Buy menu ─── */
#hud-buy {
  position: fixed; inset: 0;
  display: none; align-items: flex-end; justify-content: center;
  padding-bottom: 90px;
  pointer-events: none;
}
#hud-buy.visible { display: flex; pointer-events: auto; }
.buy-panel {
  background: rgba(15,15,15,0.92); border-radius: 6px;
  padding: 14px; margin: 0 6px; min-width: 180px;
}
.buy-panel h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.65; margin-bottom: 8px; }
.buy-item {
  display: flex; justify-content: space-between; align-items: center;
  padding: 5px 8px; border-radius: 3px; cursor: pointer;
  font-size: 12px; transition: background 0.1s;
}
.buy-item:hover { background: rgba(255,255,255,0.1); }
.buy-item.cant  { opacity: 0.35; pointer-events: none; }
.buy-item.flash-fail { animation: fail-flash 0.3s; }
@keyframes fail-flash { 0%,100%{background:transparent} 50%{background:rgba(200,0,0,0.4)} }
.buy-price { color: #ffe277; font-size: 11px; }
.buy-money-label { text-align: center; font-size: 16px; color: #ffe277; margin-top: 12px; font-weight: 600; }

/* ── Banners / HUD overlays ─── */
#hud-banner {
  position: fixed; top: 30%; left: 50%; transform: translateX(-50%);
  background: rgba(0,0,0,0.7); border-radius: 6px;
  padding: 12px 32px; font-size: 22px; font-weight: 700; letter-spacing: 1px;
  text-align: center; display: none;
}
#hud-banner.visible { display: block; }
#hud-banner.ct { color: #7da8d8; }
#hud-banner.t  { color: #d8b76a; }

#hud-progress-bar {
  position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%);
  width: 300px; background: rgba(0,0,0,0.7); border-radius: 4px;
  padding: 6px 12px; text-align: center; display: none;
}
#hud-progress-bar.visible { display: block; }
#hud-progress-track {
  width: 100%; height: 6px; background: rgba(255,255,255,0.15);
  border-radius: 3px; margin-top: 4px;
}
#hud-progress-fill { height: 100%; border-radius: 3px; transition: width 0.05s; }
.plant-fill  { background: #ff4444; }
.defuse-fill { background: #54e87a; }

#hud-bomb-warning {
  position: fixed; bottom: 90px; left: 50%; transform: translateX(-50%);
  background: rgba(180,0,0,0.6); border-radius: 4px;
  padding: 4px 16px; font-size: 13px; font-weight: 700;
  letter-spacing: 1px; color: #fff; display: none;
  animation: bomb-pulse 0.5s infinite alternate;
}
@keyframes bomb-pulse { from { opacity: 0.8; } to { opacity: 1; } }
#hud-bomb-warning.visible { display: block; }

#hud-spectating {
  position: fixed; bottom: 0; left: 0; right: 0;
  background: rgba(50,50,50,0.7); text-align: center;
  padding: 6px; font-size: 13px; color: #aaa; display: none;
}
#hud-spectating.visible { display: block; }

/* ── Start / Pause menus ─── */
.hud-menu-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.78);
  display: none; align-items: center; justify-content: center;
  pointer-events: auto; z-index: 200;
}
.hud-menu-overlay.visible { display: flex; }
.hud-menu-box {
  background: rgba(20,22,28,0.95); border-radius: 8px;
  padding: 32px 40px; min-width: 380px; max-width: 480px;
  color: #f0f0f0;
}
.hud-menu-box h1 { font-size: 20px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 24px; color: #e8d07a; }
.hud-menu-box h2 { font-size: 15px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 16px; }

.team-cards { display: flex; gap: 12px; margin-bottom: 20px; }
.team-card {
  flex: 1; padding: 12px; border-radius: 6px; border: 2px solid transparent;
  cursor: pointer; text-align: center; font-weight: 700;
  font-size: 14px; letter-spacing: 1px; transition: border-color 0.15s, background 0.15s;
}
.team-card.ct { background: rgba(79,124,201,0.25); color: #7da8d8; }
.team-card.t  { background: rgba(201,162,63,0.25); color: #d8b76a; }
.team-card.selected.ct { border-color: #7da8d8; background: rgba(79,124,201,0.5); }
.team-card.selected.t  { border-color: #d8b76a; background: rgba(201,162,63,0.5); }

.diff-btns { display: flex; gap: 8px; margin-bottom: 20px; }
.diff-btn {
  flex: 1; padding: 8px; border-radius: 4px; border: 2px solid transparent;
  cursor: pointer; text-align: center; font-size: 12px; text-transform: uppercase;
  background: rgba(255,255,255,0.07); color: #ccc;
  transition: border-color 0.15s, background 0.15s;
}
.diff-btn.selected { border-color: #ffe277; background: rgba(255,226,119,0.15); color: #ffe277; }

.menu-btn {
  width: 100%; padding: 10px; border-radius: 4px; border: none; cursor: pointer;
  font-size: 14px; text-transform: uppercase; letter-spacing: 1px;
  font-weight: 700; margin-bottom: 8px; transition: background 0.15s;
}
.menu-btn.primary { background: #ffe277; color: #1a1a1a; }
.menu-btn.primary:hover { background: #f5c700; }
.menu-btn.secondary { background: rgba(255,255,255,0.1); color: #ccc; }
.menu-btn.secondary:hover { background: rgba(255,255,255,0.18); }

.sens-row { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.sens-row label { font-size: 12px; text-transform: uppercase; opacity: 0.65; min-width: 90px; }
.sens-row input[type=range] { flex: 1; }
.sens-val { font-size: 13px; font-weight: 600; min-width: 28px; text-align: right; }

.controls-list { font-size: 11px; opacity: 0.65; line-height: 1.9; }
.controls-list span { display: inline-block; min-width: 130px; font-weight: 600; color: #ffe277; opacity: 1; }
`;

// ---------------------------------------------------------------------------
// Radar constants
// ---------------------------------------------------------------------------

const RADAR_SIZE    = 168;   // px
const MAP_WORLD_W   = 96;    // DUST2 grid cols (96 cols * 1 m)
const MAP_WORLD_H   = 115;   // DUST2 grid rows (see grid length)
const MAP_ORIGIN_X  = -48;
const MAP_ORIGIN_Z  = -44;

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

export class HUD {
  private _root: HTMLElement;
  private _game: Game;
  private _style: HTMLStyleElement;

  // DOM refs.
  private _hpVal!:        HTMLElement;
  private _hpBar!:        HTMLElement;
  private _armorBar!:     HTMLElement;
  private _ammoCount!:    HTMLElement;
  private _ammoReserve!:  HTMLElement;
  private _weaponName!:   HTMLElement;
  private _money!:        HTMLElement;
  private _timer!:        HTMLElement;
  private _scoreCT!:      HTMLElement;
  private _scoreT!:       HTMLElement;
  private _roundNum!:     HTMLElement;
  private _crossCanvas!:  HTMLCanvasElement;
  private _crossCtx!:     CanvasRenderingContext2D;
  private _scopeDiv!:     HTMLElement;
  private _killfeed!:     HTMLElement;
  private _dmgVignette!:  HTMLElement;
  private _dmgDirDiv!:    HTMLElement;
  private _radarCanvas!:  HTMLCanvasElement;
  private _radarCtx!:     CanvasRenderingContext2D;
  private _radarBg!:      HTMLCanvasElement; // pre-rendered map background
  private _scoreboard!:   HTMLElement;
  private _buyMenu!:      HTMLElement;
  private _banner!:       HTMLElement;
  private _progressBar!:  HTMLElement;
  private _progressFill!: HTMLElement;
  private _progressLabel!:HTMLElement;
  private _bombWarning!:  HTMLElement;
  private _spectating!:   HTMLElement;
  private _startMenu!:    HTMLElement;
  private _pauseMenu!:    HTMLElement;

  // State.
  private _hitmarkerTimer   = 0;
  private _hitmarkerKill    = false;
  private _dmgVigTimer      = 0;
  private _killFeedEntries: { el: HTMLElement; expireAt: number }[] = [];
  private _shotTimestamps   = new Map<number, number>(); // combatant.id → game-time

  // Sensitivity hooks.
  private _getSens: (() => number) | null = null;
  private _setSens: ((v: number) => void) | null = null;

  // Menu selections.
  private _menuTeam: 'CT' | 'T' = 'CT';
  private _menuDiff: 'easy' | 'normal' | 'hard' = 'normal';

  // Tab scoreboard.
  private _sbVisible = false;

  // Buy menu.
  private _buyVisible = false;

  // Callbacks.
  onStart?:   (opts: MatchOptions) => void;
  onResume?:  () => void;
  onRestart?: () => void;

  constructor(root: HTMLElement, game: Game) {
    this._root = root;
    this._game = game;

    // Inject CSS.
    this._style = document.createElement('style');
    this._style.textContent = HUD_CSS;
    document.head.appendChild(this._style);

    this._buildDOM();
    this._prerenderRadarBg();
    this._subscribeEvents();
    this._bindInput();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  update(now: number, frameDt: number): void {
    const game = this._game;
    const player = game.player;
    if (!player) return;

    // Health / armor.
    const hp    = Math.max(0, player.health);
    const armor = Math.max(0, player.armor);
    this._hpVal.textContent = String(hp);
    (this._hpBar as HTMLElement).style.width = `${hp}%`;
    (this._armorBar as HTMLElement).style.width = `${armor}%`;

    // Ammo.
    const slot  = player.inventory.activeSlot;
    const ws    =
      slot === 'primary'   ? player.inventory.primary :
      slot === 'secondary' ? player.inventory.secondary :
      player.inventory.knife;
    if (ws && !ws.def.isKnife) {
      this._ammoCount.textContent   = String(ws.ammo);
      this._ammoReserve.textContent = `/ ${ws.reserve}`;
      this._weaponName.textContent  = ws.def.name.toUpperCase();
    } else {
      this._ammoCount.textContent   = '—';
      this._ammoReserve.textContent = '';
      this._weaponName.textContent  = ws?.def.name.toUpperCase() ?? '';
    }
    this._money.textContent = `$${player.money}`;

    // Timer.
    let timerText = '';
    const phase = game.phase;
    if (phase === 'planted') {
      const t = game.bombTimeLeft(now);
      timerText = _formatTime(t);
      this._timer.classList.add('bomb-planted');
    } else if (phase === 'live') {
      const t = game.roundTimeLeft(now);
      timerText = _formatTime(t);
      this._timer.classList.remove('bomb-planted');
    } else if (phase === 'freeze') {
      const t = game.freezeTimeLeft(now);
      timerText = _formatTime(t);
      this._timer.classList.remove('bomb-planted');
    } else {
      timerText = '0:00';
      this._timer.classList.remove('bomb-planted');
    }
    this._timer.textContent = timerText;

    this._scoreCT.textContent  = String(game.score.CT);
    this._scoreT.textContent   = String(game.score.T);
    this._roundNum.textContent = `Round ${game.roundNumber}`;

    // Crosshair.
    const scoped = isScoped(player);
    this._crossCanvas.style.display  = scoped ? 'none' : 'block';
    this._scopeDiv.style.display     = scoped ? 'block' : 'none';
    if (!scoped) {
      this._drawCrosshair(currentSpread(player, now));
    }

    // Hit-marker fade.
    if (this._hitmarkerTimer > 0) {
      this._hitmarkerTimer = Math.max(0, this._hitmarkerTimer - frameDt);
    }

    // Damage vignette fade.
    if (this._dmgVigTimer > 0) {
      this._dmgVigTimer = Math.max(0, this._dmgVigTimer - frameDt);
      this._dmgVignette.style.opacity = String(this._dmgVigTimer / 0.6);
    } else {
      this._dmgVignette.style.opacity = '0';
    }

    // Killfeed expiry.
    const expired = this._killFeedEntries.filter(e => now > e.expireAt);
    for (const e of expired) {
      e.el.remove();
    }
    this._killFeedEntries = this._killFeedEntries.filter(e => now <= e.expireAt);

    // Radar.
    this._drawRadar(now);

    // Plant / defuse progress bar.
    const bomb = game.bomb;
    let progressVisible = false;
    let progressValue   = 0;
    let progressLabel   = '';
    let progressClass   = 'plant-fill';
    if (bomb.state === 'carried' && bomb.plantProgress > 0) {
      progressVisible = true;
      progressValue   = bomb.plantProgress;
      progressLabel   = 'PLANTING...';
      progressClass   = 'plant-fill';
    } else if (bomb.state === 'planted' && bomb.defuseProgress > 0) {
      progressVisible = true;
      progressValue   = bomb.defuseProgress;
      progressLabel   = 'DEFUSING...';
      progressClass   = 'defuse-fill';
    }
    if (progressVisible) {
      this._progressBar.classList.add('visible');
      this._progressLabel.textContent = progressLabel;
      this._progressFill.style.width  = `${Math.min(1, progressValue) * 100}%`;
      this._progressFill.className    = `bar-fill ${progressClass}`;
    } else {
      this._progressBar.classList.remove('visible');
    }

    // Bomb warning.
    if (phase === 'planted') {
      this._bombWarning.classList.add('visible');
    } else {
      this._bombWarning.classList.remove('visible');
    }

    // Spectating bar.
    if (player && !player.alive && phase !== 'menu') {
      this._spectating.classList.add('visible');
    } else {
      this._spectating.classList.remove('visible');
    }

    // Banner.
    if (phase === 'freeze') {
      this._showBanner('BUY PHASE', 'neutral');
    } else if (phase === 'roundEnd') {
      // Keep existing banner (set by roundEnd event).
    } else if (phase === 'matchEnd') {
      // Keep existing banner (set by matchEnd event).
    } else {
      if (phase === 'live' || phase === 'planted') {
        this._hideBanner();
      }
    }

    // Buy menu auto-close when window ends.
    if (this._buyVisible && !game.canBuy(now)) {
      this._setBuyVisible(false);
    }

    // Update buy menu money display.
    if (this._buyVisible) {
      const moneyLabels = this._buyMenu.querySelectorAll<HTMLElement>('.buy-money-label');
      for (const el of moneyLabels) {
        el.textContent = `$${player.money}`;
      }
      // Refresh can-afford state.
      const buyItems = this._buyMenu.querySelectorAll<HTMLElement>('.buy-item');
      for (const item of buyItems) {
        const price = parseInt(item.dataset.price ?? '0', 10);
        if (price > player.money) {
          item.classList.add('cant');
        } else {
          item.classList.remove('cant');
        }
      }
    }

    // Scoreboard.
    if (this._sbVisible) {
      this._renderScoreboard();
    }
  }

  showMenu(kind: 'start' | 'pause'): void {
    if (kind === 'start') {
      this._startMenu.classList.add('visible');
      this._pauseMenu.classList.remove('visible');
    } else {
      this._pauseMenu.classList.add('visible');
      this._startMenu.classList.remove('visible');
    }
  }

  hideMenus(): void {
    this._startMenu.classList.remove('visible');
    this._pauseMenu.classList.remove('visible');
  }

  setSensitivityHook(get: () => number, set: (v: number) => void): void {
    this._getSens = get;
    this._setSens = set;
    this._updateSensDisplay();
  }

  notifyHit(killed: boolean, _headshot: boolean): void {
    this._hitmarkerTimer = killed ? 0.35 : 0.22;
    this._hitmarkerKill  = killed;
  }

  notifyDamageFrom(dirYawDelta: number): void {
    this._dmgVigTimer = 0.6;
    // Show directional arc.
    const arc = document.createElement('div');
    arc.className = 'dmg-arc';
    arc.style.transform = `translate(-50%, -50%) rotate(${dirYawDelta * (180 / Math.PI)}deg) translateY(-60px)`;
    arc.style.opacity   = '0.9';
    this._dmgDirDiv.appendChild(arc);
    setTimeout(() => arc.remove(), 600);
  }

  // ---------------------------------------------------------------------------
  // DOM builder
  // ---------------------------------------------------------------------------

  private _buildDOM(): void {
    // Root wrapper.
    const root = document.createElement('div');
    root.id = 'hud-root';
    this._root.appendChild(root);

    // ── Health ──
    const health = document.createElement('div');
    health.id = 'hud-health';
    health.innerHTML = `
      <div class="hp-val">100</div>
      <div class="bar-row">
        <span class="bar-label">HP</span>
        <div class="bar-track"><div class="bar-fill bar-hp" style="width:100%"></div></div>
      </div>
      <div class="bar-row">
        <span class="bar-label">ARMOR</span>
        <div class="bar-track"><div class="bar-fill bar-armor" style="width:0%"></div></div>
      </div>
    `;
    root.appendChild(health);
    this._hpVal    = health.querySelector('.hp-val')!;
    this._hpBar    = health.querySelector('.bar-hp')!;
    this._armorBar = health.querySelector('.bar-armor')!;

    // ── Ammo ──
    const ammoDiv = document.createElement('div');
    ammoDiv.id = 'hud-ammo';
    ammoDiv.innerHTML = `
      <div><span class="ammo-count">—</span><span class="ammo-reserve"></span></div>
      <div class="weapon-name">PISTOL</div>
      <div class="money">$800</div>
    `;
    root.appendChild(ammoDiv);
    this._ammoCount   = ammoDiv.querySelector('.ammo-count')!;
    this._ammoReserve = ammoDiv.querySelector('.ammo-reserve')!;
    this._weaponName  = ammoDiv.querySelector('.weapon-name')!;
    this._money       = ammoDiv.querySelector('.money')!;

    // ── Top center ──
    const topDiv = document.createElement('div');
    topDiv.id = 'hud-top';
    topDiv.innerHTML = `
      <div class="score-row">
        <span class="score-ct">0</span>
        <span class="score-sep">—</span>
        <span class="score-t">0</span>
      </div>
      <div class="timer">2:00</div>
      <div class="round-num">Round 1</div>
    `;
    root.appendChild(topDiv);
    this._scoreCT  = topDiv.querySelector('.score-ct')!;
    this._scoreT   = topDiv.querySelector('.score-t')!;
    this._timer    = topDiv.querySelector('.timer')!;
    this._roundNum = topDiv.querySelector('.round-num')!;

    // ── Crosshair ──
    const crossCanvas = document.createElement('canvas');
    crossCanvas.id     = 'hud-crosshair';
    crossCanvas.width  = 120;
    crossCanvas.height = 120;
    root.appendChild(crossCanvas);
    this._crossCanvas = crossCanvas;
    this._crossCtx    = crossCanvas.getContext('2d')!;

    // ── Scope overlay ──
    const scopeDiv = document.createElement('div');
    scopeDiv.id = 'hud-scope';
    scopeDiv.style.display = 'none';
    root.appendChild(scopeDiv);
    this._scopeDiv = scopeDiv;

    // ── Killfeed ──
    const kfDiv = document.createElement('div');
    kfDiv.id = 'hud-killfeed';
    root.appendChild(kfDiv);
    this._killfeed = kfDiv;

    // ── Damage vignette ──
    const vigDiv = document.createElement('div');
    vigDiv.id = 'hud-dmg-vignette';
    root.appendChild(vigDiv);
    this._dmgVignette = vigDiv;

    const dirDiv = document.createElement('div');
    dirDiv.id = 'hud-dmg-dir';
    root.appendChild(dirDiv);
    this._dmgDirDiv = dirDiv;

    // ── Radar ──
    const radarDiv = document.createElement('div');
    radarDiv.id = 'hud-radar';
    const radarCanvas = document.createElement('canvas');
    radarCanvas.width  = RADAR_SIZE;
    radarCanvas.height = RADAR_SIZE;
    radarDiv.appendChild(radarCanvas);
    root.appendChild(radarDiv);
    this._radarCanvas = radarCanvas;
    this._radarCtx    = radarCanvas.getContext('2d')!;
    this._radarBg     = document.createElement('canvas');
    this._radarBg.width  = RADAR_SIZE;
    this._radarBg.height = RADAR_SIZE;

    // ── Scoreboard ──
    const sb = document.createElement('div');
    sb.id = 'hud-scoreboard';
    sb.innerHTML = `
      <div class="sb-panel ct">
        <h3>Counter-Terrorists</h3>
        <div class="sb-head sb-row">
          <span>Name</span><span>K</span><span>D</span><span>Money</span>
        </div>
        <div class="sb-ct-list"></div>
      </div>
      <div class="sb-panel t">
        <h3>Terrorists</h3>
        <div class="sb-head sb-row">
          <span>Name</span><span>K</span><span>D</span><span>Money</span>
        </div>
        <div class="sb-t-list"></div>
      </div>
    `;
    root.appendChild(sb);
    this._scoreboard = sb;

    // ── Buy menu ──
    const buy = document.createElement('div');
    buy.id = 'hud-buy';
    buy.innerHTML = `
      <div class="buy-panel">
        <h3>Pistols</h3>
        ${_buyRow('usp',    'USP-S',         200)}
        ${_buyRow('glock',  'Glock-18',       200)}
        ${_buyRow('deagle', 'Desert Eagle',   700)}
        <div class="buy-money-label">$—</div>
      </div>
      <div class="buy-panel">
        <h3>Rifles</h3>
        ${_buyRow('ak47',  'AK-47',  2700)}
        ${_buyRow('m4a4',  'M4A4',   2900)}
        ${_buyRow('awp',   'AWP',    4750)}
        <div class="buy-money-label">$—</div>
      </div>
      <div class="buy-panel">
        <h3>Gear</h3>
        ${_buyRow('armor',       'Vest',          650)}
        ${_buyRow('armorHelmet', 'Vest + Helmet', 1000)}
        ${_buyRow('kit',         'Defuse Kit',     400)}
        <div class="buy-money-label">$—</div>
      </div>
    `;
    root.appendChild(buy);
    this._buyMenu = buy;

    // ── Banner ──
    const banner = document.createElement('div');
    banner.id = 'hud-banner';
    root.appendChild(banner);
    this._banner = banner;

    // ── Progress bar ──
    const prog = document.createElement('div');
    prog.id = 'hud-progress-bar';
    prog.innerHTML = `
      <div class="progress-label">PLANTING...</div>
      <div id="hud-progress-track">
        <div id="hud-progress-fill" class="bar-fill plant-fill" style="width:0%"></div>
      </div>
    `;
    root.appendChild(prog);
    this._progressBar   = prog;
    this._progressLabel = prog.querySelector('.progress-label')!;
    this._progressFill  = prog.querySelector('#hud-progress-fill')!;

    // ── Bomb warning ──
    const bw = document.createElement('div');
    bw.id = 'hud-bomb-warning';
    bw.textContent = '⚠ BOMB PLANTED';
    root.appendChild(bw);
    this._bombWarning = bw;

    // ── Spectating ──
    const spec = document.createElement('div');
    spec.id = 'hud-spectating';
    spec.textContent = 'You are dead — spectating';
    root.appendChild(spec);
    this._spectating = spec;

    // ── Start menu ──
    const startMenu = document.createElement('div');
    startMenu.id = 'hud-start-menu';
    startMenu.className = 'hud-menu-overlay';
    startMenu.innerHTML = `
      <div class="hud-menu-box">
        <h1>CS2 Clone — de_dust2</h1>
        <h2>Choose Team</h2>
        <div class="team-cards">
          <div class="team-card ct selected" data-team="CT">Counter-Terrorists</div>
          <div class="team-card t" data-team="T">Terrorists</div>
        </div>
        <h2>Difficulty</h2>
        <div class="diff-btns">
          <div class="diff-btn" data-diff="easy">Easy</div>
          <div class="diff-btn selected" data-diff="normal">Normal</div>
          <div class="diff-btn" data-diff="hard">Hard</div>
        </div>
        <button class="menu-btn primary" id="hud-start-btn">Start Match</button>
      </div>
    `;
    root.appendChild(startMenu);
    this._startMenu = startMenu;

    // ── Pause menu ──
    const pauseMenu = document.createElement('div');
    pauseMenu.id = 'hud-pause-menu';
    pauseMenu.className = 'hud-menu-overlay';
    pauseMenu.innerHTML = `
      <div class="hud-menu-box">
        <h1>Paused</h1>
        <button class="menu-btn primary" id="hud-resume-btn">Resume</button>
        <button class="menu-btn secondary" id="hud-restart-btn">Restart Match</button>
        <div class="sens-row">
          <label>Sensitivity</label>
          <input type="range" id="hud-sens-slider" min="1" max="10" step="0.1" value="5">
          <span class="sens-val" id="hud-sens-val">5.0</span>
        </div>
        <h2 style="margin-top:16px;">Controls</h2>
        <div class="controls-list">
          <span>W/A/S/D</span> Move<br>
          <span>Shift</span> Walk silently<br>
          <span>Ctrl</span> Crouch<br>
          <span>Space</span> Jump<br>
          <span>LMB</span> Shoot<br>
          <span>RMB</span> Scope / Aim<br>
          <span>R</span> Reload<br>
          <span>1 / 2 / 3</span> Switch weapon<br>
          <span>Scroll</span> Cycle weapons<br>
          <span>E</span> Plant / Defuse bomb<br>
          <span>B</span> Buy menu<br>
          <span>Tab</span> Scoreboard<br>
          <span>Esc</span> Menu<br>
        </div>
      </div>
    `;
    root.appendChild(pauseMenu);
    this._pauseMenu = pauseMenu;

    // Wire start menu interactions.
    this._wireStartMenu();
    this._wirePauseMenu();
    this._wireBuyMenu();
  }

  private _wireStartMenu(): void {
    const menu = this._startMenu;

    // Team cards.
    menu.querySelectorAll<HTMLElement>('.team-card').forEach(card => {
      card.addEventListener('click', () => {
        menu.querySelectorAll('.team-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        this._menuTeam = card.dataset.team as 'CT' | 'T';
      });
    });

    // Difficulty buttons.
    menu.querySelectorAll<HTMLElement>('.diff-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        menu.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        this._menuDiff = btn.dataset.diff as 'easy' | 'normal' | 'hard';
      });
    });

    // Start button.
    menu.querySelector('#hud-start-btn')!.addEventListener('click', () => {
      this.onStart?.({ playerTeam: this._menuTeam, difficulty: this._menuDiff });
    });
  }

  private _wirePauseMenu(): void {
    const menu = this._pauseMenu;

    menu.querySelector('#hud-resume-btn')!.addEventListener('click', () => {
      this.onResume?.();
    });

    menu.querySelector('#hud-restart-btn')!.addEventListener('click', () => {
      this.onRestart?.();
    });

    const slider = menu.querySelector<HTMLInputElement>('#hud-sens-slider')!;
    const valEl  = menu.querySelector<HTMLElement>('#hud-sens-val')!;

    slider.addEventListener('input', () => {
      const uiVal = parseFloat(slider.value);
      valEl.textContent = uiVal.toFixed(1);
      // Map UI 1–10 to actual 0.0008–0.006.
      const actual = 0.0008 + (uiVal - 1) / 9 * (0.006 - 0.0008);
      this._setSens?.(actual);
    });
  }

  private _wireBuyMenu(): void {
    const menu = this._buyMenu;
    menu.querySelectorAll<HTMLElement>('.buy-item').forEach(item => {
      item.addEventListener('click', () => {
        const id    = item.dataset.id!;
        const game  = this._game;
        const now   = performance.now() / 1000;
        const ok    = game.buy(game.player, id, now);
        if (ok) {
          // Buy click handled by main.ts audio hook (notified via buyClick callback).
          // Emit a small DOM event that main.ts can listen to.
          item.dispatchEvent(new CustomEvent('hud-buy-success', { bubbles: true, detail: { id } }));
        } else {
          item.classList.add('flash-fail');
          setTimeout(() => item.classList.remove('flash-fail'), 300);
          item.dispatchEvent(new CustomEvent('hud-buy-fail', { bubbles: true }));
        }
      });
    });
  }

  private _setBuyVisible(v: boolean): void {
    this._buyVisible = v;
    if (v) {
      this._buyMenu.classList.add('visible');
    } else {
      this._buyMenu.classList.remove('visible');
    }
  }

  private _bindInput(): void {
    window.addEventListener('keydown', (e) => {
      // Tab: scoreboard.
      if (e.code === 'Tab') {
        e.preventDefault();
        this._sbVisible = true;
        this._scoreboard.classList.add('visible');
      }
      // B: buy menu.
      if (e.code === 'KeyB' && this._game.canBuy(performance.now() / 1000)) {
        this._setBuyVisible(!this._buyVisible);
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Tab') {
        this._sbVisible = false;
        this._scoreboard.classList.remove('visible');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Crosshair
  // ---------------------------------------------------------------------------

  private _drawCrosshair(spread: number): void {
    const ctx    = this._crossCtx;
    const size   = 120;
    const center = size / 2;
    ctx.clearRect(0, 0, size, size);

    const gap     = 4 + spread * 300; // scale spread to pixel gap
    const length  = this._hitmarkerTimer > 0 && this._hitmarkerKill ? 10 : 7;

    if (this._hitmarkerTimer > 0) {
      // Hitmarker: red X.
      ctx.strokeStyle = this._hitmarkerKill ? '#ffcc44' : '#ff4444';
      ctx.lineWidth   = 2;
      const s = this._hitmarkerKill ? 8 : 5;
      ctx.beginPath();
      ctx.moveTo(center - s, center - s); ctx.lineTo(center + s, center + s);
      ctx.moveTo(center + s, center - s); ctx.lineTo(center - s, center + s);
      ctx.stroke();
      return;
    }

    ctx.strokeStyle = 'rgba(0,255,120,0.9)';
    ctx.lineWidth   = 1.5;

    // Top.
    ctx.beginPath();
    ctx.moveTo(center, center - gap);
    ctx.lineTo(center, center - gap - length);
    ctx.stroke();
    // Bottom.
    ctx.beginPath();
    ctx.moveTo(center, center + gap);
    ctx.lineTo(center, center + gap + length);
    ctx.stroke();
    // Left.
    ctx.beginPath();
    ctx.moveTo(center - gap, center);
    ctx.lineTo(center - gap - length, center);
    ctx.stroke();
    // Right.
    ctx.beginPath();
    ctx.moveTo(center + gap, center);
    ctx.lineTo(center + gap + length, center);
    ctx.stroke();
    // Dot.
    ctx.fillStyle = 'rgba(0,255,120,0.6)';
    ctx.beginPath();
    ctx.arc(center, center, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---------------------------------------------------------------------------
  // Radar
  // ---------------------------------------------------------------------------

  private _prerenderRadarBg(): void {
    const canvas = this._radarBg;
    const ctx    = canvas.getContext('2d')!;
    const cols   = MAP_WORLD_W;
    const rows   = DUST2.grid.length;
    const cellPx = RADAR_SIZE / Math.max(cols, rows);

    ctx.fillStyle = '#1a1008';
    ctx.fillRect(0, 0, RADAR_SIZE, RADAR_SIZE);

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const ch   = DUST2.grid[row]?.[col] ?? ' ';
        const cell = DUST2.legend[ch];
        if (!cell || cell.wall) continue;

        const px = col * cellPx;
        const py = row * cellPx;
        const pw = cellPx + 0.5;
        const ph = cellPx + 0.5;

        const f = cell.floor;
        const covered = cell.ceil !== undefined;
        let r = 180, g = 150, b = 100;
        if (covered) { r -= 30; g -= 30; b -= 20; }
        r = Math.min(255, r + f * 5);
        g = Math.min(255, g + f * 4);
        ctx.fillStyle = `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
        ctx.fillRect(px, py, pw, ph);
      }
    }

    // Bombsite labels.
    ctx.font      = `bold ${Math.round(cellPx * 4)}px sans-serif`;
    ctx.fillStyle = 'rgba(255,200,80,0.8)';
    ctx.textAlign = 'center';
    for (const site of DUST2.bombsites) {
      const wx = (site.min.x + site.max.x) / 2;
      const wz = (site.min.z + site.max.z) / 2;
      const px = (wx - MAP_ORIGIN_X) / MAP_WORLD_W * RADAR_SIZE;
      const pz = (wz - MAP_ORIGIN_Z) / DUST2.grid.length * RADAR_SIZE;
      ctx.fillText(site.name, px, pz);
    }
  }

  private _drawRadar(now: number): void {
    const ctx   = this._radarCtx;
    const game  = this._game;
    const cols  = MAP_WORLD_W;
    const rows  = DUST2.grid.length;

    // Draw pre-rendered background.
    ctx.drawImage(this._radarBg, 0, 0);

    const toRadarX = (wx: number) => (wx - MAP_ORIGIN_X) / cols * RADAR_SIZE;
    const toRadarY = (wz: number) => (wz - MAP_ORIGIN_Z) / rows * RADAR_SIZE;

    const player = game.player;
    if (!player) return;

    // Track shot timestamps (updated by event subscription).
    // Enemies visible if near any CT/friendly OR shot within 2 s.
    const allies = game.combatants.filter(c =>
      c.team === player.team && c.alive
    );

    for (const c of game.combatants) {
      if (c.isPlayer) continue;
      if (!c.alive && game.phase !== 'roundEnd') continue;

      const rx = toRadarX(c.pos.x);
      const ry = toRadarY(c.pos.z);

      let color: string;
      let radius = 4;

      if (c.team === player.team) {
        color = '#44dd88';
      } else {
        // Enemy: only show if visible condition.
        const shotAt = this._shotTimestamps.get(c.id) ?? 0;
        const recentShot = (now - shotAt) < 2;

        let nearAlly = false;
        if (!nearAlly) {
          const dx = c.pos.x - player.pos.x;
          const dz = c.pos.z - player.pos.z;
          if (Math.sqrt(dx * dx + dz * dz) < 24) nearAlly = true;
        }
        for (const ally of allies) {
          const dx = c.pos.x - ally.pos.x;
          const dz = c.pos.z - ally.pos.z;
          if (Math.sqrt(dx * dx + dz * dz) < 24) { nearAlly = true; break; }
        }

        if (!nearAlly && !recentShot) continue;
        color = '#dd4444';
      }

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(rx, ry, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    // Bomb.
    const bomb = game.bomb;
    if (bomb.state !== 'exploded' && bomb.state !== 'defused') {
      const bx = toRadarX(bomb.pos.x);
      const by = toRadarY(bomb.pos.z);
      ctx.fillStyle = bomb.state === 'planted'
        ? (Math.sin(now * 8) > 0 ? '#ff9900' : '#ff4400')
        : '#ff9900';
      ctx.fillRect(bx - 4, by - 4, 8, 8);
    }

    // Player arrow.
    const px = toRadarX(player.pos.x);
    const py = toRadarY(player.pos.z);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-player.yaw);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4, 4);
    ctx.lineTo(0, 2);
    ctx.lineTo(-4, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Scoreboard
  // ---------------------------------------------------------------------------

  private _renderScoreboard(): void {
    const ctList = this._scoreboard.querySelector('.sb-ct-list')!;
    const tList  = this._scoreboard.querySelector('.sb-t-list')!;
    ctList.innerHTML = '';
    tList.innerHTML  = '';

    for (const c of this._game.combatants) {
      const row = document.createElement('div');
      row.className = `sb-row${c.alive ? '' : ' dead'}`;
      row.innerHTML = `
        <span>${c.name}${c.isPlayer ? ' ★' : ''}</span>
        <span>${c.kills}</span>
        <span>${c.deaths}</span>
        <span style="color:#ffe277">$${c.money}</span>
      `;
      (c.team === 'CT' ? ctList : tList).appendChild(row);
    }
  }

  // ---------------------------------------------------------------------------
  // Banner
  // ---------------------------------------------------------------------------

  private _showBanner(text: string, team: 'ct' | 't' | 'neutral'): void {
    this._banner.textContent = text;
    this._banner.className   = 'visible ' + (team === 'neutral' ? '' : team);
    this._banner.classList.add('visible');
  }

  private _hideBanner(): void {
    this._banner.classList.remove('visible');
  }

  // ---------------------------------------------------------------------------
  // Sensitivity display
  // ---------------------------------------------------------------------------

  private _updateSensDisplay(): void {
    if (!this._getSens) return;
    const actual = this._getSens();
    // Map 0.0008–0.006 → 1–10.
    const uiVal = 1 + (actual - 0.0008) / (0.006 - 0.0008) * 9;
    const slider = this._pauseMenu.querySelector<HTMLInputElement>('#hud-sens-slider');
    const valEl  = this._pauseMenu.querySelector<HTMLElement>('#hud-sens-val');
    if (slider) slider.value = String(uiVal.toFixed(1));
    if (valEl)  valEl.textContent = uiVal.toFixed(1);
  }

  // ---------------------------------------------------------------------------
  // Event subscriptions
  // ---------------------------------------------------------------------------

  private _subscribeEvents(): void {
    gameEvents.on('kill', (ev) => {
      const now = performance.now() / 1000;
      const entry = document.createElement('div');
      entry.className = 'killfeed-entry';
      const attackerName = ev.attacker?.name ?? '[Bomb]';
      const victimClass  = ev.victim === this._game?.player ? 'kf-victim' : '';
      const hs = ev.headshot ? '<span class="kf-hs">⦿</span>' : '';
      entry.innerHTML = `
        <span>${attackerName}</span>
        <span class="kf-weapon">[${ev.weaponId}]</span>
        ${hs}
        <span class="${victimClass}">${ev.victim.name}</span>
      `;
      this._killfeed.insertBefore(entry, this._killfeed.firstChild);
      this._killFeedEntries.push({ el: entry, expireAt: now + 5 });
      // Max 5 rows.
      while (this._killfeed.children.length > 5) {
        this._killfeed.removeChild(this._killfeed.lastChild!);
        this._killFeedEntries.shift();
      }
    });

    gameEvents.on('shot', (ev) => {
      this._shotTimestamps.set(ev.shooter.id, performance.now() / 1000);
    });

    gameEvents.on('roundEnd', (ev) => {
      const teamClass = ev.winner === 'CT' ? 'ct' : 't';
      const teamName  = ev.winner === 'CT' ? 'Counter-Terrorists' : 'Terrorists';
      this._showBanner(`${teamName} Win — ${ev.reason}`, teamClass);
    });

    gameEvents.on('matchEnd', (ev) => {
      const teamClass = ev.winner === 'CT' ? 'ct' : 't';
      const teamName  = ev.winner === 'CT' ? 'Counter-Terrorists' : 'Terrorists';
      this._showBanner(`Match Over — ${teamName} Win`, teamClass);
    });
  }
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function _formatTime(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function _buyRow(id: string, label: string, price: number): string {
  return `<div class="buy-item" data-id="${id}" data-price="${price}">
    <span>${label}</span>
    <span class="buy-price">$${price}</span>
  </div>`;
}
