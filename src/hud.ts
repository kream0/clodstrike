import type { Game, GamePhase, MatchOptions } from './game';
import { RULES, GRENADES, ECONOMY, WEAPONS } from './constants';
import { gameEvents } from './combat';
import { isScoped, currentSpread } from './weapons';
import { DUST2 } from './maps/dust2';
import { MAPS, MAP_DISPLAY_NAMES, DEFAULT_MAP_ID } from './maps/index';
import type { GrenadeType, MapData } from './types';

// ---------------------------------------------------------------------------
// CSS injected once
// ---------------------------------------------------------------------------

const HUD_CSS = `
/* ── Clodstrike HUD — CS2-flavored restyle ──────────────────── */
#hud-root * { box-sizing: border-box; margin: 0; padding: 0; }

#hud-root {
  position: fixed; inset: 0;
  pointer-events: none;
  font-family: "Segoe UI", Roboto, system-ui, sans-serif;
  font-size: 13px;
  color: #e8e6e1;
  z-index: 100;
}

/* ── Health / Armor plate ─────────────────────────────────────── */
#hud-health {
  position: absolute; bottom: 24px; left: 24px;
  display: flex; flex-direction: column; gap: 6px;
  background: rgba(8,10,12,0.65);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 5px;
  padding: 10px 14px;
  backdrop-filter: blur(4px);
  min-width: 140px;
}
#hud-health .hp-val {
  font-size: 38px; font-weight: 700; line-height: 1;
  letter-spacing: -1px;
  font-variant-numeric: tabular-nums;
  color: #e8e6e1;
}
#hud-health .hp-val.low-health { color: #e05b4b; }
#hud-health .bar-row { display: flex; align-items: center; gap: 8px; }
#hud-health .bar-label {
  font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em;
  opacity: 0.55; width: 34px; flex-shrink: 0;
}
#hud-health .bar-track {
  flex: 1; height: 4px; border-radius: 2px;
  background: rgba(255,255,255,0.1);
}
#hud-health .bar-fill { height: 100%; border-radius: 2px; transition: width 0.12s ease; }
#hud-health .bar-hp    { background: #54c87a; }
#hud-health .bar-armor { background: #6aa3c9; }

/* ── Ammo / Weapon plate ─────────────────────────────────────── */
#hud-ammo {
  position: absolute; bottom: 24px; right: 24px;
  text-align: right;
  background: rgba(8,10,12,0.65);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 5px;
  padding: 10px 14px;
  backdrop-filter: blur(4px);
  min-width: 130px;
}
#hud-ammo .ammo-count {
  font-size: 38px; font-weight: 700; line-height: 1;
  font-variant-numeric: tabular-nums;
  color: #e8e6e1;
}
#hud-ammo .ammo-reserve {
  font-size: 16px; opacity: 0.5; margin-left: 5px;
  font-variant-numeric: tabular-nums;
}
#hud-ammo .weapon-name {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em;
  opacity: 0.55; margin-top: 3px;
}
#hud-ammo .money {
  font-size: 17px; font-weight: 600; color: #c9a06a;
  margin-top: 6px; font-variant-numeric: tabular-nums;
}

/* ── Top-center score / timer ─────────────────────────────────── */
#hud-top {
  position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
  text-align: center; display: flex; flex-direction: column;
  align-items: center; gap: 0;
}

/* Score plate */
#hud-top .score-row {
  display: flex; gap: 0; align-items: stretch;
  border-radius: 5px 5px 0 0; overflow: hidden;
  border: 1px solid rgba(255,255,255,0.08);
  border-bottom: none;
}
#hud-top .score-ct {
  font-size: 22px; font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: #6aa3c9;
  background: rgba(8,14,22,0.72);
  padding: 4px 20px;
  min-width: 52px; text-align: center;
}
#hud-top .score-t {
  font-size: 22px; font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: #c9a06a;
  background: rgba(22,14,8,0.72);
  padding: 4px 20px;
  min-width: 52px; text-align: center;
}
#hud-top .score-sep {
  color: rgba(255,255,255,0.3); font-size: 18px; font-weight: 400;
  background: rgba(8,10,12,0.72);
  padding: 4px 6px; display: flex; align-items: center;
}

/* Timer plate */
#hud-top .timer {
  font-size: 26px; font-weight: 700; letter-spacing: 1px;
  min-width: 152px; text-align: center;
  font-variant-numeric: tabular-nums;
  background: rgba(8,10,12,0.72);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 0 0 5px 5px;
  padding: 3px 16px 4px;
  color: #e8e6e1;
}
#hud-top .timer.bomb-planted {
  color: #e05b4b;
  border-color: rgba(224,91,75,0.3);
}
#hud-top .round-num {
  font-size: 10px; opacity: 0.45; text-transform: uppercase;
  letter-spacing: 0.12em; margin-top: 4px;
}

/* ── Crosshair ─────────────────────────────────────────────────── */
#hud-crosshair {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
}

/* ── AWP scope overlay ─────────────────────────────────────────── */
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

/* ── Killfeed ──────────────────────────────────────────────────── */
#hud-killfeed {
  position: absolute; top: 64px; right: 16px;
  display: flex; flex-direction: column; gap: 3px;
  min-width: 230px; max-width: 340px;
}
.killfeed-entry {
  background: rgba(8,10,12,0.70);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 4px;
  padding: 4px 10px; font-size: 12px;
  animation: kf-fadein 0.12s ease-out;
  display: flex; align-items: center; gap: 5px;
}
@keyframes kf-fadein {
  from { opacity: 0; transform: translateX(14px); }
  to   { opacity: 1; transform: none; }
}
.kf-victim  { color: #e05b4b; }
.kf-hs      { color: #c9a06a; font-weight: 700; font-size: 11px; }
.kf-weapon  { opacity: 0.55; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; }

/* ── Damage vignette ───────────────────────────────────────────── */
#hud-dmg-vignette {
  position: fixed; inset: 0; pointer-events: none;
  background: radial-gradient(ellipse at 50% 50%, transparent 38%, rgba(160,20,20,0.6) 100%);
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

/* ── Radar ─────────────────────────────────────────────────────── */
#hud-radar {
  position: absolute; top: 16px; left: 16px;
  width: 168px; height: 168px;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(4,6,8,0.72);
  border-radius: 5px; overflow: hidden;
}
#hud-radar canvas { display: block; }

/* ── Scoreboard ────────────────────────────────────────────────── */
#hud-scoreboard {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.80);
  display: none; align-items: flex-start; justify-content: center;
  padding-top: 56px;
  pointer-events: auto;
}
#hud-scoreboard.visible { display: flex; }

.sb-panel {
  background: rgba(10,12,16,0.92);
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 6px;
  padding: 0; min-width: 340px; margin: 0 8px;
  overflow: hidden;
}
.sb-panel h3 {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em;
  padding: 10px 14px 9px;
  margin: 0;
  border-bottom: 1px solid rgba(255,255,255,0.07);
}
.sb-panel.ct h3 {
  color: #6aa3c9;
  background: rgba(8,16,28,0.60);
}
.sb-panel.t h3 {
  color: #c9a06a;
  background: rgba(28,16,8,0.60);
}

.sb-head.sb-row {
  font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em;
  opacity: 0.45; padding: 5px 14px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.sb-row {
  display: grid; grid-template-columns: 1fr 40px 40px 64px;
  gap: 4px; padding: 5px 14px;
  font-size: 12px; align-items: center;
  font-variant-numeric: tabular-nums;
}
.sb-row:not(.sb-head):nth-child(even) { background: rgba(255,255,255,0.03); }
.sb-row.dead { opacity: 0.35; }
.sb-row.player-row { background: rgba(201,160,106,0.09) !important; }
.sb-row span:not(:first-child) { text-align: right; }

/* ── Buy menu ──────────────────────────────────────────────────── */
#hud-buy {
  position: fixed; inset: 0;
  display: none; align-items: flex-end; justify-content: center;
  padding-bottom: 80px;
  pointer-events: none;
}
#hud-buy.visible { display: flex; pointer-events: auto; }

.buy-panel {
  background: rgba(8,10,14,0.88);
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 6px;
  padding: 12px 10px 10px; margin: 0 5px; min-width: 190px;
}
.buy-panel h3 {
  font-size: 9px; text-transform: uppercase; letter-spacing: 0.14em;
  opacity: 0.5; margin-bottom: 8px; padding: 0 4px;
}
.buy-item {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 8px; border-radius: 4px; cursor: pointer;
  font-size: 12px;
  transition: background 0.1s;
  gap: 6px;
}
.buy-item:hover { background: rgba(201,160,106,0.10); }
.buy-item:hover .buy-key { border-color: #c9a06a; color: #c9a06a; }
.buy-item.cant { opacity: 0.30; pointer-events: none; }
.buy-item.cant .buy-price { text-decoration: line-through; opacity: 0.6; }
.buy-item.flash-fail { animation: fail-flash 0.3s; }
@keyframes fail-flash {
  0%,100% { background: transparent; }
  50%     { background: rgba(224,91,75,0.30); }
}

.buy-price {
  color: #c9a06a; font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap; flex-shrink: 0;
}
.buy-money-label {
  text-align: center; font-size: 14px; color: #c9a06a;
  margin-top: 10px; padding-top: 8px;
  border-top: 1px solid rgba(255,255,255,0.07);
  font-weight: 600; font-variant-numeric: tabular-nums;
}
.buy-time-label {
  text-align: center; font-size: 11px; color: rgba(232,230,225,0.55);
  margin-bottom: 6px; padding-bottom: 6px;
  border-bottom: 1px solid rgba(255,255,255,0.07);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.06em;
}
.buy-key {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; border-radius: 3px; flex-shrink: 0;
  border: 1px solid rgba(255,255,255,0.28);
  background: rgba(255,255,255,0.06);
  font-size: 10px; font-weight: 700;
  color: rgba(255,255,255,0.6);
  font-family: "Segoe UI", system-ui, sans-serif;
}

/* ── Banners ────────────────────────────────────────────────────── */
#hud-banner {
  position: fixed; top: 28%; left: 50%; transform: translateX(-50%);
  background: rgba(6,8,12,0.80);
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 6px;
  padding: 14px 40px;
  font-size: 20px; font-weight: 700;
  letter-spacing: 0.12em; text-transform: uppercase;
  text-align: center; display: none; white-space: nowrap;
}
#hud-banner.visible { display: block; }
#hud-banner.ct {
  color: #6aa3c9;
  border-color: rgba(106,163,201,0.28);
  box-shadow: 0 0 28px rgba(106,163,201,0.10);
}
#hud-banner.t {
  color: #c9a06a;
  border-color: rgba(201,160,106,0.28);
  box-shadow: 0 0 28px rgba(201,160,106,0.10);
}

/* ── Plant / Defuse progress bar ──────────────────────────────── */
#hud-progress-bar {
  position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%);
  width: 280px;
  background: rgba(6,8,12,0.80);
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 5px;
  padding: 8px 14px; text-align: center; display: none;
}
#hud-progress-bar.visible { display: block; }
.progress-label {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em;
  opacity: 0.70; margin-bottom: 6px;
}
#hud-progress-track {
  width: 100%; height: 4px; background: rgba(255,255,255,0.12);
  border-radius: 2px;
}
#hud-progress-fill { height: 100%; border-radius: 2px; transition: width 0.05s linear; }
.plant-fill  { background: #e05b4b; }
.defuse-fill { background: #54c87a; }

/* ── Bomb warning ──────────────────────────────────────────────── */
#hud-bomb-warning {
  position: fixed; bottom: 88px; left: 50%; transform: translateX(-50%);
  background: rgba(180,24,24,0.65);
  border: 1px solid rgba(224,91,75,0.40);
  border-radius: 4px;
  padding: 4px 18px; font-size: 11px; font-weight: 700;
  letter-spacing: 0.14em; text-transform: uppercase;
  color: #fff; display: none;
  animation: bomb-pulse 0.5s infinite alternate;
}
@keyframes bomb-pulse { from { opacity: 0.80; } to { opacity: 1; } }
#hud-bomb-warning.visible { display: block; }

/* ── Spectating bar ────────────────────────────────────────────── */
#hud-spectating {
  position: fixed; bottom: 0; left: 0; right: 0;
  background: rgba(8,10,12,0.72);
  border-top: 1px solid rgba(255,255,255,0.07);
  text-align: center;
  padding: 5px 6px 4px; font-size: 12px;
  letter-spacing: 0.06em; color: rgba(232,230,225,0.55); display: none;
}
#hud-spectating.visible { display: block; }
#hud-spectating .spec-label {
  display: block;
}
#hud-spectating .spec-name {
  display: block;
  font-size: 13px; font-weight: 700; letter-spacing: 0.10em;
  color: #e8e6e1; text-transform: uppercase;
}
#hud-spectating .spec-hint {
  display: block;
  font-size: 10px; letter-spacing: 0.08em; opacity: 0.45; margin-top: 2px;
}

/* ── Start / Pause menus ────────────────────────────────────────── */
.hud-menu-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.82);
  display: none; align-items: center; justify-content: center;
  pointer-events: auto; z-index: 200;
}
.hud-menu-overlay.visible { display: flex; }

.hud-menu-box {
  background: rgba(10,12,18,0.95);
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 8px;
  padding: 36px 44px; min-width: 390px; max-width: 490px;
  color: #e8e6e1;
  backdrop-filter: blur(4px);
}

.hud-menu-box h1 {
  font-size: 26px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.22em;
  margin-bottom: 28px; color: #c9a06a;
  text-shadow: 0 0 24px rgba(201,160,106,0.30);
}
.hud-menu-box h2 {
  font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.14em;
  opacity: 0.55; margin-bottom: 10px; margin-top: 4px;
}

/* Team picker */
.team-cards { display: flex; gap: 10px; margin-bottom: 20px; }
.team-card {
  flex: 1; padding: 12px 10px; border-radius: 5px;
  border: 2px solid rgba(255,255,255,0.08);
  cursor: pointer; text-align: center; font-weight: 700;
  font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase;
  transition: border-color 0.12s, background 0.12s;
}
.team-card.ct {
  background: rgba(106,163,201,0.12); color: #6aa3c9;
}
.team-card.t {
  background: rgba(201,160,106,0.12); color: #c9a06a;
}
.team-card.selected.ct {
  border-color: #6aa3c9; background: rgba(106,163,201,0.22);
}
.team-card.selected.t {
  border-color: #c9a06a; background: rgba(201,160,106,0.22);
}

/* Difficulty segmented control */
.diff-btns { display: flex; gap: 0; margin-bottom: 20px; border-radius: 5px; overflow: hidden; border: 1px solid rgba(255,255,255,0.10); }
.diff-btn {
  flex: 1; padding: 8px 4px;
  border: none; border-right: 1px solid rgba(255,255,255,0.10);
  cursor: pointer; text-align: center; font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.08em;
  background: rgba(255,255,255,0.04); color: rgba(232,230,225,0.60);
  transition: background 0.12s, color 0.12s;
  font-family: "Segoe UI", Roboto, system-ui, sans-serif;
}
.diff-btn:last-child { border-right: none; }
.diff-btn.selected {
  background: rgba(201,160,106,0.20); color: #c9a06a;
}

/* Buttons */
.menu-btn {
  width: 100%; padding: 11px; border-radius: 5px; border: 1px solid transparent;
  cursor: pointer; font-size: 13px; text-transform: uppercase;
  letter-spacing: 0.10em; font-weight: 700; margin-bottom: 8px;
  transition: background 0.12s, border-color 0.12s, transform 0.08s;
  font-family: "Segoe UI", Roboto, system-ui, sans-serif;
}
.menu-btn:active { transform: translateY(1px); }
.menu-btn.primary {
  background: #c9a06a; color: #0d0f12;
  border-color: #c9a06a;
}
.menu-btn.primary:hover {
  background: #d9b07a; border-color: #d9b07a;
}
.menu-btn.secondary {
  background: rgba(255,255,255,0.07);
  color: rgba(232,230,225,0.75);
  border-color: rgba(255,255,255,0.10);
}
.menu-btn.secondary:hover {
  background: rgba(255,255,255,0.12);
  border-color: rgba(255,255,255,0.18);
}

/* Sensitivity slider */
.sens-row { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.sens-row label {
  font-size: 10px; text-transform: uppercase;
  letter-spacing: 0.10em; opacity: 0.55; min-width: 90px;
}
.sens-row input[type=range] {
  flex: 1; -webkit-appearance: none; appearance: none;
  height: 3px; border-radius: 2px;
  background: rgba(255,255,255,0.15); outline: none; cursor: pointer;
}
.sens-row input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 14px; height: 14px; border-radius: 50%;
  background: #c9a06a; cursor: pointer;
  border: 2px solid rgba(0,0,0,0.4);
}
.sens-row input[type=range]::-moz-range-thumb {
  width: 14px; height: 14px; border-radius: 50%;
  background: #c9a06a; cursor: pointer; border: 2px solid rgba(0,0,0,0.4);
}
.sens-val {
  font-size: 12px; font-weight: 600;
  font-variant-numeric: tabular-nums;
  min-width: 28px; text-align: right;
  color: #c9a06a;
}

/* Controls reference list */
.controls-list {
  font-size: 11px; opacity: 0.60; line-height: 2.0;
  border-top: 1px solid rgba(255,255,255,0.07);
  padding-top: 12px;
}
.controls-list span {
  display: inline-block; min-width: 130px;
  font-weight: 600; color: #c9a06a; opacity: 1;
}

/* ── Flash whiteout overlay ─────────────────────────────────────── */
#hud-flash {
  position: fixed; inset: 0;
  pointer-events: none;
  background: #ffffff;
  opacity: 0;
  z-index: 150;
}

/* ── Grenade pips (next to ammo plate) ─────────────────────────── */
#hud-grenades {
  position: absolute; bottom: 24px; right: 24px;
  display: flex; gap: 4px; align-items: flex-end;
  /* sits directly left of the ammo plate (margin-right = ammo plate width + gap) */
  margin-right: 158px;
}
.gren-pip {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 28px; height: 22px;
  border-radius: 3px;
  border: 1px solid rgba(255,255,255,0.18);
  background: rgba(8,10,12,0.65);
  backdrop-filter: blur(4px);
  font-size: 9px; font-weight: 700; letter-spacing: 0.06em;
  text-transform: uppercase; color: rgba(232,230,225,0.70);
  font-variant-numeric: tabular-nums;
  gap: 2px;
}
.gren-pip.equipped {
  border-color: #c9a06a;
  color: #c9a06a;
  background: rgba(201,160,106,0.12);
}

/* ── Match stats screen ────────────────────────────────────────── */
#hud-matchstats {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.55);
  display: none; align-items: center; justify-content: center;
  z-index: 250;
}
#hud-matchstats.visible { display: flex; pointer-events: none; }

.ms-panel {
  background: rgba(10,12,18,0.95);
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 8px;
  padding: 28px 36px 24px;
  min-width: 740px; max-width: 920px; width: 90vw;
  color: #e8e6e1;
  backdrop-filter: blur(6px);
  pointer-events: auto;
}

.ms-headline {
  font-size: 28px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.18em;
  text-align: center; margin-bottom: 6px;
}
.ms-headline.ct { color: #6aa3c9; text-shadow: 0 0 24px rgba(106,163,201,0.25); }
.ms-headline.t  { color: #c9a06a; text-shadow: 0 0 24px rgba(201,160,106,0.25); }

.ms-score {
  text-align: center; font-size: 18px; font-weight: 600;
  font-variant-numeric: tabular-nums;
  margin-bottom: 20px; opacity: 0.75;
}

.ms-team-label {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em;
  margin-bottom: 4px; padding: 0 2px;
}
.ms-team-label.ct { color: #6aa3c9; }
.ms-team-label.t  { color: #c9a06a; }

.ms-table {
  width: 100%; border-collapse: collapse;
  font-size: 12px; font-variant-numeric: tabular-nums;
  margin-bottom: 16px;
}
.ms-table th {
  font-size: 9px; text-transform: uppercase; letter-spacing: 0.10em;
  opacity: 0.45; padding: 5px 8px; text-align: right;
  border-bottom: 1px solid rgba(255,255,255,0.07);
}
.ms-table th:first-child { text-align: left; }
.ms-table td {
  padding: 5px 8px; text-align: right;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.ms-table td:first-child { text-align: left; }
.ms-table tr:nth-child(even) td { background: rgba(255,255,255,0.025); }
.ms-table tr.ms-player td { background: rgba(201,160,106,0.09) !important; }

.ms-play-again {
  width: 100%; margin-top: 8px;
}

/* ── Buy menu CS2 category layout ──────────────────────────────── */
.buy-layout {
  display: flex; align-items: flex-start; gap: 6px;
}
.buy-cat-rail {
  background: rgba(8,10,14,0.92);
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 6px;
  padding: 10px 6px;
  min-width: 168px;
  display: flex; flex-direction: column; gap: 2px;
}
.buy-cat-rail .buy-time-label {
  margin-bottom: 8px; padding-bottom: 8px;
}
.buy-cat-item {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 8px; border-radius: 4px;
  cursor: pointer; font-size: 12px;
  transition: background 0.1s;
}
.buy-cat-item:hover { background: rgba(201,160,106,0.10); }
.buy-cat-item:hover .buy-key { border-color: #c9a06a; color: #c9a06a; }
.buy-cat-item.active {
  background: rgba(201,160,106,0.16);
  color: #c9a06a;
}
.buy-cat-item.active .buy-key {
  border-color: #c9a06a; color: #c9a06a;
  background: rgba(201,160,106,0.20);
}
.buy-items-panel {
  background: rgba(8,10,14,0.92);
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 6px;
  padding: 10px 8px 8px;
  min-width: 210px;
  display: flex; flex-direction: column; gap: 0;
}
.buy-items-panel .buy-panel-title {
  font-size: 9px; text-transform: uppercase; letter-spacing: 0.14em;
  opacity: 0.5; margin-bottom: 6px; padding: 0 4px 6px;
  border-bottom: 1px solid rgba(255,255,255,0.07);
}
.buy-items-panel .buy-back-hint {
  font-size: 9px; text-transform: uppercase; letter-spacing: 0.10em;
  opacity: 0.38; margin-top: 6px; padding-top: 6px;
  border-top: 1px solid rgba(255,255,255,0.07);
  text-align: center;
}
`;




// ---------------------------------------------------------------------------
// Radar constants
// ---------------------------------------------------------------------------

const RADAR_SIZE = 168; // px

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
  private _flashOverlay!: HTMLElement;
  private _grenPips!:     HTMLElement;
  private _matchStats!:   HTMLElement;

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
  private _menuTeam:  'CT' | 'T' = 'CT';
  private _menuDiff:  'easy' | 'normal' | 'hard' = 'normal';
  private _menuMapId: string = DEFAULT_MAP_ID;

  // Radar: current map used for background prerender and blip placement.
  private _radarMap: MapData = DUST2;

  // Match-end stats screen.
  private _statsVisible = false;

  // Tab scoreboard.
  private _sbVisible = false;
  // Last game-time at which the scoreboard DOM was rebuilt (for 0.25 s rate-limit).
  private _sbLastRenderTime = -1;

  // Buy menu.
  private _buyVisible  = false;
  // Cached team used to build current buy menu DOM (detects team change for rebuild).
  private _buyMenuTeam: 'CT' | 'T' | null = null;
  // Active category tab (1-5) or null = category overview shown.
  private _buyCategory: number | null = null;

  // Callbacks.
  onStart?:   (opts: MatchOptions) => void;
  onResume?:  () => void;
  onRestart?: () => void;

  // Game-time provider — set by main.ts to use clock.now instead of wall time.
  getNow: () => number = () => performance.now() / 1000;

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
    if (hp < 30) {
      this._hpVal.classList.add('low-health');
    } else {
      this._hpVal.classList.remove('low-health');
    }
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

    // Radar — skip when fully obscured by the start/pause menu overlay.
    if (game.phase !== 'menu') {
      this._drawRadar(now);
    }

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
      // Stats panel carries the match-over message; hide the banner.
      this._hideBanner();
    } else {
      if (phase === 'live' || phase === 'planted') {
        this._hideBanner();
      }
    }

    // Hide stats panel if a restart has occurred and we're no longer in matchEnd.
    if (this._statsVisible && phase !== 'matchEnd') {
      this._hideMatchStats();
    }

    // Suppress Tab scoreboard while stats panel is open.
    if (this._statsVisible && this._sbVisible) {
      this._sbVisible = false;
      this._scoreboard.classList.remove('visible');
    }

    // Buy menu auto-close when window ends.
    if (this._buyVisible && !game.canBuy(now)) {
      this._setBuyVisible(false);
    }

    // Update buy menu affordability display each frame while open.
    if (this._buyVisible) {
      this._refreshBuyAffordability();
    }

    // ── Grenade pips ──
    this._updateGrenPips(player.grenades, player.equippedGrenade ?? null);

    // ── Flash whiteout overlay ──
    const blindUntil    = player.blindUntil    ?? 0;
    const blindIntensity = player.blindIntensity ?? 1;
    if (blindUntil > now) {
      const FULL_DURATION = 4.0; // max blindness = 0.6 + 3.4*1.0 = 4.0 s
      const remaining    = blindUntil - now;
      const holdThresh   = FULL_DURATION * 0.60;
      let opacity: number;
      if (remaining >= holdThresh) {
        opacity = blindIntensity;
      } else {
        opacity = (remaining / holdThresh) * blindIntensity;
      }
      // clamp 0..1
      opacity = Math.min(1, Math.max(0, opacity));
      this._flashOverlay.style.opacity = String(opacity);
      this._flashOverlay.style.display = '';
    } else {
      this._flashOverlay.style.display = 'none';
      this._flashOverlay.style.opacity = '0';
    }

    // Scoreboard — rebuild DOM at most once per 0.25 s of game time.
    if (this._sbVisible && now - this._sbLastRenderTime >= 0.25) {
      this._sbLastRenderTime = now;
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
    this._setBuyVisible(false);
  }

  setSensitivityHook(get: () => number, set: (v: number) => void): void {
    this._getSens = get;
    this._setSens = set;
    this._updateSensDisplay();
  }

  /**
   * Switch the radar to render a different map. Call this after a map swap
   * (before startMatch) so the radar background and coordinate transforms
   * reflect the new map's grid and origin.
   */
  rerenderRadarBg(map: MapData): void {
    this._radarMap = map;
    this._prerenderRadarBg();
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

  /**
   * Update the spectating bar content.
   * - name non-null: show "SPECTATING — <NAME>" with a cycle hint line.
   * - name null: show plain death-cam text.
   * Visibility (show/hide) is still controlled by the existing logic in update().
   */
  setSpectateInfo(name: string | null): void {
    if (name !== null) {
      this._spectating.innerHTML =
        `<span class="spec-name">SPECTATING — ${name}</span>` +
        `<span class="spec-hint">CLICK · NEXT PLAYER</span>`;
    } else {
      this._spectating.innerHTML = '<span class="spec-label">You are dead</span>';
    }
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
    root.appendChild(buy);
    this._buyMenu = buy;
    // DOM content built lazily on first open via _rebuildBuyMenu().

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
    spec.innerHTML = '<span class="spec-label">You are dead</span>';
    root.appendChild(spec);
    this._spectating = spec;

    // ── Flash whiteout overlay ──
    const flashDiv = document.createElement('div');
    flashDiv.id = 'hud-flash';
    root.appendChild(flashDiv);
    this._flashOverlay = flashDiv;

    // ── Grenade pips ──
    const grenDiv = document.createElement('div');
    grenDiv.id = 'hud-grenades';
    root.appendChild(grenDiv);
    this._grenPips = grenDiv;

    // ── Match stats screen ──
    const msDiv = document.createElement('div');
    msDiv.id = 'hud-matchstats';
    root.appendChild(msDiv);
    this._matchStats = msDiv;
    this._wireMatchStats();

    // ── Start menu ──
    const startMenu = document.createElement('div');
    startMenu.id = 'hud-start-menu';
    startMenu.className = 'hud-menu-overlay';
    // Build map picker buttons from the registry (order: dust2 first, then rest).
    const mapPickerHtml = Object.entries(MAP_DISPLAY_NAMES)
      .map(([id, label]) => {
        const sel = id === DEFAULT_MAP_ID ? ' selected' : '';
        return `<div class="diff-btn${sel}" data-map-id="${id}">${label}</div>`;
      })
      .join('');

    startMenu.innerHTML = `
      <div class="hud-menu-box">
        <h1>Clodstrike</h1>
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
        <h2>Map</h2>
        <div class="diff-btns map-btns">
          ${mapPickerHtml}
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

    // Difficulty buttons (inside .diff-btns but NOT inside .map-btns).
    const diffContainer = menu.querySelector<HTMLElement>('.diff-btns:not(.map-btns)');
    diffContainer?.querySelectorAll<HTMLElement>('.diff-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        diffContainer.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        this._menuDiff = btn.dataset.diff as 'easy' | 'normal' | 'hard';
      });
    });

    // Map picker buttons (inside .map-btns).
    const mapContainer = menu.querySelector<HTMLElement>('.map-btns');
    mapContainer?.querySelectorAll<HTMLElement>('.diff-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        mapContainer.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        this._menuMapId = btn.dataset.mapId ?? DEFAULT_MAP_ID;
      });
    });

    // Start button.
    menu.querySelector('#hud-start-btn')!.addEventListener('click', () => {
      this.onStart?.({
        playerTeam: this._menuTeam,
        difficulty:  this._menuDiff,
        mapId:       this._menuMapId,
      });
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
    // Use event delegation so the listener survives buy menu DOM rebuilds.
    this._buyMenu.addEventListener('click', (e) => {
      // Category tab click.
      const catItem = (e.target as HTMLElement).closest<HTMLElement>('.buy-cat-item');
      if (catItem) {
        const catKey = parseInt(catItem.dataset.catKey ?? '0', 10);
        if (catKey >= 1 && catKey <= 5) {
          // Toggle: clicking the already-active tab goes back to overview.
          this._setBuyCategory(this._buyCategory === catKey ? null : catKey);
        }
        return;
      }

      // Buy item click.
      const item = (e.target as HTMLElement).closest<HTMLElement>('.buy-item');
      if (!item) return;
      const id   = item.dataset.id!;
      const game = this._game;
      const now  = this.getNow();
      const ok   = game.buy(game.player, id, now);
      if (ok) {
        item.dispatchEvent(new CustomEvent('hud-buy-success', { bubbles: true, detail: { id } }));
        // Rebuild and refresh after purchase (owned states change).
        this._rebuildBuyMenu();
        this._refreshBuyAffordability();
      } else {
        item.classList.add('flash-fail');
        setTimeout(() => item.classList.remove('flash-fail'), 300);
        item.dispatchEvent(new CustomEvent('hud-buy-fail', { bubbles: true }));
      }
    });
  }

  private _wireMatchStats(): void {
    // Use event delegation so the Play Again button click is handled once.
    this._matchStats.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.ms-play-again');
      if (!btn) return;
      this._hideMatchStats();
      this.onRestart?.();
    });
  }

  private _showMatchStats(winner: 'CT' | 'T'): void {
    this._statsVisible = true;
    const game = this._game;
    const teamClass = winner === 'CT' ? 'ct' : 't';
    const teamName  = winner === 'CT' ? 'COUNTER-TERRORISTS WIN' : 'TERRORISTS WIN';

    // Sort combatants per team: kills desc, deaths asc, id asc.
    function sortedTeam(team: 'CT' | 'T') {
      return [...game.combatants]
        .filter(c => c.team === team)
        .sort((a, b) => {
          if (b.kills !== a.kills) return b.kills - a.kills;
          if (a.deaths !== b.deaths) return a.deaths - b.deaths;
          return a.id - b.id;
        });
    }

    function buildTable(team: 'CT' | 'T'): string {
      const rows = sortedTeam(team).map(c => {
        const stats = game.statsFor(c);
        const hsPercent = c.kills > 0
          ? Math.round(100 * stats.headshotKills / c.kills) + '%'
          : '—';
        const dmg = Math.round(stats.damageDealt);
        const playerCls = c.isPlayer ? ' ms-player' : '';
        const nameSuffix = c.isPlayer ? ' &#9733;' : '';
        return `<tr class="${playerCls}">
          <td>${c.name}${nameSuffix}</td>
          <td>${c.kills}</td>
          <td>${c.deaths}</td>
          <td>${hsPercent}</td>
          <td>${dmg}</td>
          <td>${stats.mvps}</td>
          <td>$${stats.moneySpent}</td>
        </tr>`;
      }).join('');
      return `<table class="ms-table">
        <thead><tr>
          <th>Name</th><th>K</th><th>D</th><th>HS%</th><th>DMG</th><th>MVP</th><th>$ Spent</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    }

    this._matchStats.innerHTML = `
      <div class="ms-panel">
        <div class="ms-headline ${teamClass}">${teamName}</div>
        <div class="ms-score">CT ${game.score.CT} &mdash; ${game.score.T} T</div>
        <div class="ms-team-label ct">Counter-Terrorists</div>
        ${buildTable('CT')}
        <div class="ms-team-label t">Terrorists</div>
        ${buildTable('T')}
        <button class="menu-btn primary ms-play-again">Play Again</button>
      </div>
    `;
    this._matchStats.classList.add('visible');
  }

  private _hideMatchStats(): void {
    this._statsVisible = false;
    this._matchStats.classList.remove('visible');
  }

  /**
   * Build or rebuild the buy menu inner HTML for the given player team.
   * Renders CS2-style: left category rail (tabs 1–5) + right item panel.
   * Called on open, team change, and after each purchase.
   * Does NOT re-attach the delegated listener (wired once in _wireBuyMenu).
   */
  private _rebuildBuyMenu(): void {
    const player = this._game.player;
    if (!player) return;
    const team = player.team;
    this._buyMenuTeam = team;
    const isCT = team === 'CT';

    // Category names for the rail.
    const CAT_LABELS = ['PISTOLS', 'MID-TIER', 'RIFLES', 'GRENADES', 'GEAR'] as const;

    // Category rail rows (data-cat-key="1"–"5").
    const railRows = CAT_LABELS.map((label, i) => {
      const n = i + 1;
      const isActive = this._buyCategory === n;
      return `<div class="buy-cat-item${isActive ? ' active' : ''}" data-cat-key="${n}">
        <span class="buy-key">${n}</span>${label}
      </div>`;
    }).join('');

    // Item panel HTML — depends on active category.
    let itemsHtml = '';
    if (this._buyCategory === null) {
      itemsHtml = '';
    } else if (this._buyCategory === 1) {
      // PISTOLS: filter WEAPONS by category='pistol', team-eligible, sort by price asc.
      const eligible = _eligibleWeapons('pistol', team);
      itemsHtml = _weaponItemsHtml('PISTOLS', eligible);
    } else if (this._buyCategory === 2) {
      // MID-TIER: smg then heavy, team-eligible, sort by price asc, cap at 9.
      const smgs   = _eligibleWeapons('smg',   team);
      const heavy  = _eligibleWeapons('heavy', team);
      // Combine and sort by price; cap at 9.
      const combined = [...smgs, ...heavy].sort((a, b) => a.price - b.price).slice(0, 9);
      itemsHtml = _weaponItemsHtml('MID-TIER', combined);
    } else if (this._buyCategory === 3) {
      // RIFLES: filter WEAPONS by category='rifle', team-eligible, sort by price asc.
      const eligible = _eligibleWeapons('rifle', team);
      itemsHtml = _weaponItemsHtml('RIFLES', eligible);
    } else if (this._buyCategory === 4) {
      // GRENADES.
      const grens = player.grenades ?? { he: 0, flash: 0, smoke: 0 };
      const heDisabled = grens.he  >= GRENADES.he.maxCarry;
      const fbDisabled = grens.flash >= GRENADES.flash.maxCarry;
      const smDisabled = grens.smoke >= GRENADES.smoke.maxCarry;
      const fbLabel    = `Flashbang (${grens.flash}/${GRENADES.flash.maxCarry})`;
      itemsHtml = `<div class="buy-items-panel">
        <div class="buy-panel-title">GRENADES</div>
        ${_buyRow('he',    'HE Grenade', GRENADES.he.price,    1, heDisabled)}
        ${_buyRow('flash', fbLabel,      GRENADES.flash.price, 2, fbDisabled)}
        ${_buyRow('smoke', 'Smoke',      GRENADES.smoke.price, 3, smDisabled)}
        <div class="buy-money-label">$—</div>
        <div class="buy-back-hint">[0] BACK</div>
      </div>`;
    } else if (this._buyCategory === 5) {
      // GEAR.
      const hasArmor  = player.armor > 0;
      const hasHelmet = player.helmet;
      let armorId: string;
      let armorLabel: string;
      let armorPrice: number;
      let armorDisabled = false;
      if (!hasArmor) {
        armorId    = 'armor';
        armorLabel = 'Vest';
        armorPrice = ECONOMY.ARMOR_PRICE;
      } else if (!hasHelmet) {
        armorId    = 'armorHelmet';
        armorLabel = 'Helmet upgrade';
        armorPrice = ECONOMY.ARMOR_UPGRADE_PRICE;
      } else {
        armorId       = 'armorHelmet';
        armorLabel    = 'Armored';
        armorPrice    = 0;
        armorDisabled = true;
      }
      const kitDisabledForT = !isCT;
      itemsHtml = `<div class="buy-items-panel">
        <div class="buy-panel-title">GEAR</div>
        ${_buyRow(armorId, armorLabel,    armorPrice,               1, armorDisabled)}
        ${_buyRow('kit',   'Defuse Kit',  ECONOMY.DEFUSE_KIT_PRICE, 2, kitDisabledForT)}
        <div class="buy-money-label">$—</div>
        <div class="buy-back-hint">[0] BACK</div>
      </div>`;
    }

    this._buyMenu.innerHTML = `
      <div class="buy-layout">
        <div class="buy-cat-rail">
          <div class="buy-time-label">BUY TIME: —</div>
          ${railRows}
          <div class="buy-money-label">$—</div>
        </div>
        ${itemsHtml}
      </div>
    `;
  }

  /** Refresh .cant class on all buy items based on current money + grenade maxCarry. */
  private _refreshBuyAffordability(): void {
    const player = this._game.player;
    if (!player) return;
    const grens = player.grenades ?? { he: 0, flash: 0, smoke: 0 };
    const items = this._buyMenu.querySelectorAll<HTMLElement>('.buy-item');
    for (const item of items) {
      if (item.dataset.staticDisabled === '1') continue; // permanently disabled items
      const price     = parseInt(item.dataset.price ?? '0', 10);
      const grenType  = item.dataset.grenType as GrenadeType | undefined;
      const maxCarry  = grenType ? GRENADES[grenType].maxCarry : undefined;
      const ownedCount = grenType ? (grens[grenType] ?? 0) : 0;
      const tooMany   = maxCarry !== undefined && ownedCount >= maxCarry;
      const cantAfford = price > player.money;
      if (cantAfford || tooMany) {
        item.classList.add('cant');
      } else {
        item.classList.remove('cant');
      }
    }
    // Refresh money display.
    const moneyLabels = this._buyMenu.querySelectorAll<HTMLElement>('.buy-money-label');
    for (const el of moneyLabels) {
      el.textContent = `$${player.money}`;
    }
    // Refresh buy-time countdown.
    const now = this.getNow();
    const timeLeft = this._game.buyTimeLeft(now);
    const timeEl = this._buyMenu.querySelector<HTMLElement>('.buy-time-label');
    if (timeEl) {
      timeEl.textContent = `BUY TIME: ${_formatTime(timeLeft)}`;
    }
  }

  private _updateGrenPips(
    grenades: Partial<Record<GrenadeType, number>> | undefined,
    equipped: GrenadeType | null,
  ): void {
    const g = grenades ?? {};
    const he    = g['he']    ?? 0;
    const flash = g['flash'] ?? 0;
    const smoke = g['smoke'] ?? 0;

    let html = '';
    if (he > 0) {
      const cls = equipped === 'he' ? 'gren-pip equipped' : 'gren-pip';
      html += `<span class="${cls}">HE${he > 1 ? ` \xD7${he}` : ''}</span>`;
    }
    if (flash > 0) {
      const cls = equipped === 'flash' ? 'gren-pip equipped' : 'gren-pip';
      html += `<span class="${cls}">FB${flash > 1 ? ` \xD7${flash}` : ''}</span>`;
    }
    if (smoke > 0) {
      const cls = equipped === 'smoke' ? 'gren-pip equipped' : 'gren-pip';
      html += `<span class="${cls}">SM${smoke > 1 ? ` \xD7${smoke}` : ''}</span>`;
    }
    this._grenPips.innerHTML = html;
  }

  private _setBuyVisible(v: boolean): void {
    this._buyVisible = v;
    if (v) {
      // Always reset to category overview on each open.
      this._buyCategory = null;
      // Rebuild menu (always on open — category reset requires fresh DOM).
      this._rebuildBuyMenu();
      this._buyMenu.classList.add('visible');
      this._refreshBuyAffordability();
    } else {
      this._buyMenu.classList.remove('visible');
    }
  }

  /** Navigate to a buy category tab (1–5) or back to overview (null). */
  private _setBuyCategory(cat: number | null): void {
    this._buyCategory = cat;
    this._rebuildBuyMenu();
    this._refreshBuyAffordability();
  }

  // Public getter so main.ts can suppress slot switching while buy menu is open.
  get buyMenuOpen(): boolean {
    return this._buyVisible;
  }

  private _bindInput(): void {
    window.addEventListener('keydown', (e) => {
      // Tab: scoreboard.
      if (e.code === 'Tab') {
        e.preventDefault();
        // Stats panel takes over the screen during matchEnd — don't flicker the
        // scoreboard over it.  Let update() keep _sbVisible=false for us.
        if (this._statsVisible) return;
        this._sbLastRenderTime = -Infinity;
        this._sbVisible = true;
        this._scoreboard.classList.add('visible');
      }
      // B: buy menu toggle.
      if (e.code === 'KeyB' && this._game.canBuy(this.getNow())) {
        this._setBuyVisible(!this._buyVisible);
      }
      // Escape: close buy menu (pointer-lock exit / pause handled by main.ts separately).
      if (e.code === 'Escape' && this._buyVisible) {
        this._setBuyVisible(false);
      }
      // All digits 0–9 are consumed by the buy menu when it is open.
      if (this._buyVisible) {
        // Digit0 / Numpad0 / Backspace: return to category overview.
        if (e.code === 'Digit0' || e.code === 'Numpad0' || e.code === 'Backspace') {
          if (this._buyCategory !== null) {
            e.preventDefault();
            this._setBuyCategory(null);
          }
          return;
        }
        // Digit1–9 / Numpad1–9.
        const digitMatch = e.code.match(/^(?:Digit|Numpad)([1-9])$/);
        if (digitMatch) {
          e.preventDefault();
          const key = parseInt(digitMatch[1], 10);
          if (this._buyCategory === null) {
            // Category level: keys 1–5 select a tab.
            if (key >= 1 && key <= 5) {
              this._setBuyCategory(key);
            }
          } else {
            // Item level: click the matching buy-item.
            const item = this._buyMenu.querySelector<HTMLElement>(`.buy-item[data-key="${key}"]`);
            if (item) {
              item.click();
            }
          }
        }
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Tab') {
        // Mirror the keydown guard: if stats panel is open Tab never opened the
        // scoreboard, so there is nothing to close here.
        if (this._statsVisible) return;
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

    const gap     = Math.min(4 + spread * 300, 56); // scale spread to pixel gap; capped so arms stay inside 120px canvas
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
    const map    = this._radarMap;
    const canvas = this._radarBg;
    const ctx    = canvas.getContext('2d')!;
    const cols   = map.grid[0]?.length ?? 96;
    const rows   = map.grid.length;
    const cellPx = RADAR_SIZE / Math.max(cols, rows);

    ctx.fillStyle = '#1a1008';
    ctx.fillRect(0, 0, RADAR_SIZE, RADAR_SIZE);

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const ch   = map.grid[row]?.[col] ?? ' ';
        const cell = map.legend[ch];
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
    const originX = map.origin.x;
    const originZ = map.origin.z;
    for (const site of map.bombsites) {
      const wx = (site.min.x + site.max.x) / 2;
      const wz = (site.min.z + site.max.z) / 2;
      const px = (wx - originX) / cols * RADAR_SIZE;
      const pz = (wz - originZ) / rows * RADAR_SIZE;
      ctx.fillText(site.name, px, pz);
    }
  }

  private _drawRadar(now: number): void {
    const ctx     = this._radarCtx;
    const game    = this._game;
    const map     = this._radarMap;
    const cols    = map.grid[0]?.length ?? 96;
    const rows    = map.grid.length;
    const originX = map.origin.x;
    const originZ = map.origin.z;

    // Draw pre-rendered background.
    ctx.drawImage(this._radarBg, 0, 0);

    const toRadarX = (wx: number) => (wx - originX) / cols * RADAR_SIZE;
    const toRadarY = (wz: number) => (wz - originZ) / rows * RADAR_SIZE;

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
      const playerCls = c.isPlayer ? ' player-row' : '';
      row.className = `sb-row${c.alive ? '' : ' dead'}${playerCls}`;
      row.innerHTML = `
        <span>${c.name}${c.isPlayer ? ' ★' : ''}</span>
        <span>${c.kills}</span>
        <span>${c.deaths}</span>
        <span style="color:#c9a06a">$${c.money}</span>
      `;
      (c.team === 'CT' ? ctList : tList).appendChild(row);
    }
  }

  // ---------------------------------------------------------------------------
  // Banner
  // ---------------------------------------------------------------------------

  private _showBanner(text: string, team: 'ct' | 't' | 'neutral'): void {
    this._banner.textContent = text;
    this._banner.className   = team !== 'neutral' ? `visible ${team}` : 'visible';
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
      const now = this.getNow();
      const entry = document.createElement('div');
      entry.className = 'killfeed-entry';
      const attackerName = ev.attacker?.name ?? '[Bomb]';
      const victimClass  = ev.victim === this._game?.player ? 'kf-victim' : '';
      const hs = ev.headshot ? '<span class="kf-hs">⦿</span>' : '';
      const wLabel = KILLFEED_WEAPON_LABELS[ev.weaponId] ?? ev.weaponId.toUpperCase();
      entry.innerHTML = `
        <span>${attackerName}</span>
        <span class="kf-weapon">[${wLabel}]</span>
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
      this._shotTimestamps.set(ev.shooter.id, this.getNow());
    });

    gameEvents.on('roundEnd', (ev) => {
      const teamClass = ev.winner === 'CT' ? 'ct' : 't';
      const teamName  = ev.winner === 'CT' ? 'Counter-Terrorists' : 'Terrorists';
      this._showBanner(`${teamName} Win — ${ev.reason}`, teamClass);
    });

    gameEvents.on('matchEnd', (ev) => {
      this._showMatchStats(ev.winner);
      document.exitPointerLock();
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

/**
 * Grenade weapon IDs that carry a `data-gren-type` attribute so
 * `_refreshBuyAffordability` can check maxCarry constraints.
 */
const GRENADE_BUY_IDS: Readonly<Record<string, 'he' | 'flash' | 'smoke'>> = {
  he: 'he',
  flash: 'flash',
  smoke: 'smoke',
};

/**
 * Human-readable killfeed labels for weapon IDs that aren't in WEAPONS.
 * Grenade kills arrive with weaponId = grenade type string ('he', 'flash', 'smoke').
 * Unknown IDs fall through to the raw id display — no crash.
 */
const KILLFEED_WEAPON_LABELS: Readonly<Record<string, string>> = {
  he:    'HE',
  flash: 'FLASH',
  smoke: 'SMOKE',
  bomb:  'BOMB',
};

function _buyRow(
  id: string,
  label: string,
  price: number,
  key: number,
  staticDisabled = false,
): string {
  const grenType    = GRENADE_BUY_IDS[id];
  const grenAttr    = grenType ? ` data-gren-type="${grenType}"` : '';
  const disabledAttr = staticDisabled ? ' data-static-disabled="1"' : '';
  const cantClass   = staticDisabled ? ' cant' : '';
  const priceDisplay = price > 0 ? `$${price}` : '';
  return `<div class="buy-item${cantClass}" data-id="${id}" data-price="${price}" data-key="${key}"${grenAttr}${disabledAttr}>
    <span><span class="buy-key">${key}</span>${label}</span>
    <span class="buy-price">${priceDisplay}</span>
  </div>`;
}

/**
 * Return weapon definitions eligible for `team` in the given category,
 * sorted ascending by price. Max 9 entries (spec cap).
 */
function _eligibleWeapons(
  category: 'pistol' | 'smg' | 'heavy' | 'rifle',
  team: 'CT' | 'T',
): Array<{ id: string; name: string; price: number }> {
  const out: Array<{ id: string; name: string; price: number }> = [];
  for (const def of Object.values(WEAPONS)) {
    if (def.category !== category) continue;
    if (def.teams && !def.teams.includes(team)) continue;
    out.push({ id: def.id, name: def.name, price: def.price });
  }
  out.sort((a, b) => a.price - b.price);
  return out.slice(0, 9);
}

/**
 * Render a weapon list item panel with title, up to 9 rows, money label and
 * back hint.
 */
function _weaponItemsHtml(
  title: string,
  items: Array<{ id: string; name: string; price: number }>,
): string {
  const rows = items
    .map((it, i) => _buyRow(it.id, it.name, it.price, i + 1))
    .join('');
  return `<div class="buy-items-panel">
    <div class="buy-panel-title">${title}</div>
    ${rows}
    <div class="buy-money-label">$—</div>
    <div class="buy-back-hint">[0] BACK</div>
  </div>`;
}
