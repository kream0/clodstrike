# CS2 Clone — de_dust2

A Counter-Strike 2 style single-player FPS: you versus bots on a low-poly remake of de_dust2. Built with Bun, TypeScript, and three.js.

## Requirements

- [Bun](https://bun.sh) >= 1.2

## How to run

```sh
bun install
bun run dev
```

Then open http://localhost:3000 in your browser.

## Controls

| Key / Input | Action |
|:---|:---|
| W A S D | Move forward / left / back / right |
| Mouse | Look |
| Left Mouse Button | Fire |
| Right Mouse Button | Scope (AWP only) |
| R | Reload |
| Shift (hold) | Walk silently |
| Ctrl (hold) | Crouch |
| Space | Jump |
| E (hold) | Plant / defuse bomb |
| B | Open / close buy menu |
| 1–9 (in buy menu) | Buy item: 1 USP-S · 2 Glock-18 · 3 Desert Eagle · 4 AK-47 · 5 M4A4 · 6 AWP · 7 Vest · 8 Vest+Helmet · 9 Defuse Kit |
| 1 / 2 / 3 | Switch weapon slot: primary / secondary / knife |
| Mouse wheel | Cycle weapon slots |
| Tab (hold) | Scoreboard |
| Esc | Pause menu (Resume · Restart · Sensitivity) |
| F3 | Debug overlay (FPS, position, speed, phase) |
| N | Noclip (debug) |

## Gameplay

5v5 bomb-defusal against bots on a low-poly remake of **de_dust2**. First team to 13 rounds wins (MR12, 24 rounds max). There is no halftime side swap.

**Round flow**

- Freeze / buy time: 5 s freeze + first 10 s of each round (buy menu accessible while `canBuy` is true).
- Bomb timer: 40 s after plant; defuse takes 10 s (5 s with a defuse kit).
- Plant duration: ~3.2 s hold on a bomb site.
- Round end pause: 5 s before the next round starts.

**Economy**

| Event | Reward |
|:---|:---|
| Round win | $3 250 |
| Loss streak (1 / 2 / 3 / 4 / 5+) | $1 400 / $1 900 / $2 400 / $2 900 / $3 400 |
| Kill reward | weapon-dependent (typically $300) |
| Bomb plant — team bonus | $800 |
| Bomb plant — planter bonus | $300 |
| Starting money | $800 |
| Maximum money | $16 000 |

**Bot difficulties**

| Difficulty | Reaction | Aim error | Vision range |
|:---|:---|:---|:---|
| Easy | 550 ms | ±3.2° | 45 m |
| Normal | 350 ms | ±1.7° | 60 m |
| Hard | 220 ms | ±0.8° | 80 m |

## Scripts

- `bun run dev` — start the Bun fullstack dev server (http://localhost:3000)
- `bun run check` — typecheck with `tsc --noEmit`
- `bun run build` — bundle to `dist/`
- `bun run test` — run unit tests with `bun test`
