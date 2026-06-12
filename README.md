# Clodstrike

A Counter-Strike 2–style single-player FPS — bots, bomb defusal, and a low-poly de_dust2 — built with **Bun + Three.js + TypeScript (strict)**.

> Built collaboratively with Claude Code using a multi-agent workflow (contract types.ts → scoped sequential/parallel sonnet implementers per domain → integration → read-only reviewer → fixer; reviewer caught 5 pre-runtime P0s). See [`CLAUDE.md`](./CLAUDE.md) for the full process.

**▶ Play it in your browser:** [kream0.github.io/clodstrike](https://kream0.github.io/clodstrike/)

---

## Current features

### Map — de_dust2

- **Geometry-faithful remake** of de_dust2 encoded as a 96×96 ASCII height grid — one character per square meter, each char mapping to floor height, optional ceiling, wall solidity, and material. The layout is calibrated against real-map reference data (radar overview + spawn coordinates, 1 unit = 0.01905 m): correct route proportions, chokepoint widths, site shapes and the real elevation profile (T spawn high plateau at +4.5 m, mid sloping down to CT-side ground at 0 m, A site plateau +4.5 m, B site +1.5 m).
- **All iconic areas reproduced**: LongA, Catwalk, UpperTunnels, CT Spawn, A Site, B Site, B Doors, Mid, Short, Pit, Goose, and more — 24+ named regions used by bot routing logic.
- **One-way drops like the real map**: catwalk → lower mid, B window → site, pit edges, and the T-spawn ledge are drop-only (the ≤ 0.5 m step-up rule makes them unclimbable), forcing real rotation routes.
- **Covered geometry**: tunnel and door cells carry explicit ceiling heights so players and bots move under realistic headroom rather than passing through flat ceilings.
- **25 axis-aligned props**: crates, B-site car, Xbox box, sandbags, planks, and the classic mid-door pair — the gap between them is the AWP mid-doors sightline. Props carry full AABB collision and are included in the navgrid as impassable obstacles.
- **5+5 spawns** with pre-aimed yaw angles; A and B bombsite rectangles used by the plant/defuse logic.
- **BFS connectivity suite** in `dust2.test.ts` guarantees every canonical route (Long, Short, Mid, Upper/Lower Tunnels) is traversable in both directions at the map cell level — the safety net whenever the grid changes.
- **Greedy row-merged renderer**: adjacent cells of the same material are merged into axis-aligned box meshes, producing fewer than 10 static draw calls for the entire map plus ~25 prop meshes. Lambert materials with per-box vertex-color tint; hemisphere + warm directional sun with 2048 PCF shadows; exponential fog; sand/stone palette.

### Visuals & assets

- **CC0-textured world**: 8 open-licensed tiling materials (ambientCG + Poly Haven — sand, sandstone brick, plaster, paving stone, concrete, wood, painted metal, fabric), color + normal maps, applied across the greedy-merged map geometry with **world-anchored planar UVs** so tiles continue seamlessly across merged boxes. Per-kind prop texturing (wood crates, metal car/doors/xbox, fabric sandbags). Colors-only fallback if textures fail to load.
- **CC0 GLB weapon viewmodels for all 30 weapons**: every roster weapon — including the knife — renders a real Quaternius CC0 model in first person, mapped through the same 9 model families used by third-person characters (loaded once, shared). Auto-normalized (longest-axis-to-barrel alignment + target-length scaling, per-stem tuning with per-id overrides) under the procedural animation anchor — bob/sway/kick/reload all still code-driven. Any model that fails to load falls back to the procedural box gun.
- **First-person arms**: rigged low-poly arms (J-Toastie, CC-BY 4.0) hold every weapon — per-family grip poses (two-handed long guns, pistol with support hand, blade-forward knife) with curled fingers, parented to the weapon anchor so bob/sway/kick/reload move hands and gun together. Sleeve tinted per team (CT blue-grey / T sand). Arms missing → gun-only viewmodel, no regression.
- **Async boot with loading screen**: 28-asset progress bar (8 color maps, 8 normal maps, 9 weapon GLBs, 2 rigged characters, first-person arms), parallel loading, per-asset graceful fallback — a 404 can never brick the boot.
- **Rigged characters with real animation clips**: Quaternius CC0 rigged characters (CT operator / T phoenix, shared 62-joint skeleton) driven by `THREE.AnimationMixer` — Idle_Gun, Walk, Run with directional Run_Left/Right/Back picked from velocity projected into model space, a real Death clip, 0.18 s crossfades, and playback speed synced to actual move speed (no foot-sliding). Crouch is a post-mixer hips-drop + abdomen tilt (the pack has no crouch clip). Characters hold real weapon models attached to the right wrist bone, mapped from all 30 roster ids and swapped live on weapon change. Visual-only: hitboxes and eye heights unchanged. Procedural box-bot fallback preserved.
- **Modernized HUD & menus**: translucent glass plates, tabular numerals, sand-gold accent, team-colored scoreplate/scoreboard, killfeed chips, buy-menu cards with keycap badges, segmented difficulty picker, low-health states — all still DOM + injected CSS, no images or fonts.
- **Full credits**: every asset's source + license in [`assets/LICENSES.md`](./assets/LICENSES.md).

### Movement & gunplay

- **CS-style movement** shared between player and bots: ground friction + acceleration, Quake air-strafe (air-accel cap 0.6 m/s wish-speed), jump velocity 5.75 m/s, gravity 15.24 m/s². Walk (×0.52) and crouch (×0.34) multipliers applied to the active weapon's base move speed.
- **Swept AABB collision** axis-separated (Y → X → Z) against the grid height field and prop AABBs; step-up ≤ 0.5 m so players and bots hop onto crates and ledges without getting stuck.
- **Tag-slow on hit**: taking damage cuts move speed to 50% for 0.5 s — penalises W-keying through gunfire.
- **2.5D DDA raycast** for hitscan: marches through grid cells first, then tests prop AABBs, returning surface normal, material, and hit distance.
- **Crouch** lowers eye height from 1.64 m to 1.17 m; player AABB shrinks accordingly; bots correctly clear low-ceiling tunnel cells only when crouching.

### Weapons

The full CS2 roster — 29 guns + knife across three slots, every entry with CS2-faithful price, damage, RPM, magazine, recoil pattern and movement-spread values:

| Category | Weapons |
|:---|:---|
| Pistols | Glock-18 (T) · USP-S (CT) · Dual Berettas · P250 · Five-SeveN (CT) · Tec-9 (T) · Desert Eagle |
| SMGs | MAC-10 (T) · MP9 (CT) · MP7 · UMP-45 · P90 · PP-Bizon |
| Heavy | Nova · XM1014 · Sawed-Off (T) · MAG-7 (CT) · M249 · Negev |
| Rifles | FAMAS (CT) · Galil AR (T) · M4A4 (CT) · AK-47 (T) · AUG (CT) · SG 553 (T) · SSG 08 · AWP · G3SG1 (T) · SCAR-20 (CT) |

Team-exclusive weapons are enforced at purchase time — a CT can never buy an AK, a T can never buy an M4, exactly like CS2. A ~500-case generated test suite pins every roster entry's category/slot/team/price/pattern integrity.

- **RPM gate, reload, recoil**: each weapon has an independent `nextFire` timer, a timed reload sequence, and a view-punch-and-recovery system (recovery in radians/second, suppressed while actively spraying so punch genuinely accumulates).
- **Learnable spray patterns**: per-weapon recoil patterns (±15% jitter) — the AK-47 climbs hard for ~9 bullets then weaves right/left/right in the classic "7"; the M4A4 runs the same family at ~75% magnitude; pistols have short climbs; Deagle/AWP keep heavy single-shot punch. Pull down and counter-weave to control it, exactly like the real thing.
- **Spread**: base accuracy + movement penalty + airborne penalty — all modelled as cone half-angles. Movement accuracy is thresholded CS2-style: accurate below ~34% of max speed (counter-strafing works), then a steep quadratic penalty — running rifle fire is unusable. Spray inaccuracy grows per consecutive shot. Crouching narrows the cone.
- **Range falloff**: `damage × rangeModifier^(distance / 15 m)`. The AWP barely falls off at range; the Glock degrades fast.
- **Hitgroups**: head (×4 damage, overridden to ×2.5 for AWP), body (×1), legs (×0.75, ignores armor). Armor absorbs to 0.775× for body shots (helmet required for head armor benefit). Armor durability tracked per combatant.
- **AWP scope**: right-click zooms FOV from 73° to 30° with an overlay; sensitivity scales 0.4× scoped; hip-fire spread is severe (0.05 rad base).
- **First-person viewmodel**: CC0 GLB gun models (procedural box fallback) with bob (speed-linked), sway (mouse-linked), kick (per-shot), reload animation, and weapon-switch blend — all animation transforms code-driven on a shared anchor.
- **Kill rewards**: most weapons give $300 per kill; knife gives $1 500; AWP gives $100.

### Grenades

- **HE grenade** ($300, carry 1): 1.6 s fuse, 98 max damage with 10 m falloff, line-of-sight attenuated through cover, self-damage on, team damage off. Kill credit + killfeed entry for the thrower.
- **Flashbang** ($200, carry 2): 1.5 s fuse; blindness scales with distance, facing angle, and line of sight — full-screen whiteout for the player, and bots genuinely lose their target (full blind drops target + holds fire; partial blind multiplies aim error). Tinnitus ring scales with intensity.
- **Smoke** ($300, carry 1): pops at rest, 3.5 m opaque cloud for 15 s — blocks bot vision per eye/chest sample exactly like world geometry.
- **Throwing**: key **4** equips / cycles owned grenades, left-click throws (gun fire is fully suppressed while a grenade is out), switching slots stows it. Projectiles bounce off world geometry with restitution + friction at full 128 Hz fidelity.

### Bots

- **A* pathfinding** over the same map grid used for collision: octile heuristic, binary min-heap open list, wall-hug penalty (×1.15 for wall-adjacent cells), drop-cost shaping (×1.5 for downward-drop edges), string-pull smoothing to collapse collinear waypoints. Paths compute in ~1.2 ms and are cached per bot with replanning every 2.5 s.
- **FSM states**: objective (route to site), engage (spotted enemy), hunt (last-known-position), plant (hold E at site), defuse (CT rushes dropped bomb), guard (static hold after site capture). State transitions driven by perception events and game phase.
- **T-side coordination**: carriers follow Long/Short/Tunnels routes with escort bots shadowing the bomb carrier; split pushes activate when teammates confirm an alternate route clear. CT side assigns bots to A or B with rotation triggers on intel (bomb drop heard, teammate death event).
- **Perception**: staggered FOV cone (100° full / 50° half) + LOS raycast check every 0.12 s per bot, offset by bot ID to spread CPU load. Hearing range: gunshots 30 m, teammate deaths 40 m. Enemies spotted near or heard firing appear on the player's radar.
- **Honest walls**: losing line of sight freezes the bot's aim on the last-seen corner point (no live tracking through geometry), and the trigger is hard-gated on current-tick LOS — bots never fire at a target they cannot actually see.
- **Difficulty tiers**: easy (550 ms reaction, ±3.2° aim error, 45 m vision), normal (350 ms, ±1.7°, 60 m), hard (220 ms, ±0.8°, 80 m). Aim error resamples every 0.25 s; locks in and shrinks after 1.2 s on the same target. Recoil control factor scales per difficulty.
- **Shared code**: bots run the exact same `simulateMovement` and `updateWeapon` calls as the player, driving identical physics and weapon state machines — no separate bot-movement shortcuts.
- **Stuck recovery**: horizontal speed below 0.3 m/s for 0.7 s triggers a jump; 1.5 s of stuck triggers a full A* replan; stuck escorts break formation permanently and route independently.
- **Mission persistence**: a dropped bomb is actively retrieved — the closest living T is designated sticky retriever (re-designated if pinned in a fight for 4 s+); site guards face the enemy approach instead of a default angle; kill/shot intel inside enemy spawn zones is ignored (no spawn-camping detours); bot-vs-bot separation impulses prevent stacked clumps.
- **Economy-aware buying**: per-round team strategy — eco (save), force-buy (loss streak / team-economy triggered), full-buy, and occasional AWP picks (max one fresh AWP per team per round). AWP bots scope in when engaging.
- **Tiered buy pools from the full roster**: ecos draw budget pistols (P250 / Dual Berettas / Tec-9 / Five-SeveN / Deagle), force-buys draw SMGs (~80%) or shotguns (~20%), full-buys pick budget rifles (Galil/FAMAS) when tight and standard rifles when funded, with rich bots (> $6 000) occasionally splashing on AUG/SG 553 — meme tier (M249, Negev, autosnipers) deliberately excluded. Armor is topped up from live money after the gun buy.

### Rounds & economy

- **5v5 bomb defusal, MR12, first to 13 wins** (24 rounds max). No halftime side swap — deliberate.
- **Phases**: `menu` → `freeze` (5 s) → `live` (1:55) → `planted` (40 s bomb timer) → `roundEnd` (5 s) → `matchEnd`.
- **Buy window**: 30 s from freeze start (CS2-style — outlasts the 5 s freeze into the live round). The buy menu shows the remaining window and force-closes when it expires. `canBuy` uses game-time `clock.now` — the source of the round-2 regression that was fixed after review.
- **Plant / defuse**: hold E for 3.2 s inside a bombsite to plant; 10 s to defuse (5 s with kit). Bomb drop/pickup on player death. Radial explosion damage.
- **Economy**:
  - Starting money: $800
  - Win reward: $3 250
  - Loss streak: $1 400 / $1 900 / $2 400 / $2 900 / $3 400 (rounds 1–5+)
  - Bomb plant — team bonus: $800; planter bonus: $300
  - Max money: $16 000
  - Prices: CS2-faithful across the whole roster (e.g. P250 $300, MAC-10 $1 050, Galil $1 800, AK $2 700, M4A4 $2 900, AWP $4 750), Vest $650, Vest+Helmet $1 000, Defuse Kit $400

### HUD & UX

- **Health / armor / ammo / money** bars in the classic CS corner layout. Timer and score at the top center.
- **Dynamic crosshair**: spread-reactive gap grows with move speed, airborne state, and recent shots. Hitmarker flash on confirmed hits; gold flash for headshots.
- **AWP scope overlay** with full-screen dark vignette and vertical/horizontal cross lines.
- **Damage vignette** + directional arc pointing at the attacker (bearing relative to player yaw).
- **Killfeed**: attacker → victim entries with weapon icons, auto-expire after 5 s.
- **Radar**: pre-rendered from the same ASCII grid as the world. Teammates always visible; enemies appear when within hearing range or near a recently heard shot. Bomb marker shown when dropped or planted. Player position + yaw arrow updates every frame.
- **Tab scoreboard**: kills / deaths / money per player, team totals.
- **Buy menu** (B key): CS2-style two-level navigation — a category rail (1 Pistols · 2 Mid-Tier · 3 Rifles · 4 Grenades · 5 Gear) opening data-driven item panels filtered to your team, sorted by price, with keycap digit shortcuts per item; 0/Backspace steps back to the rail. Items greyed out when unaffordable. All digit keys are consumed by the menu while open, so weapon switching is unaffected.
- **Start menu**: pick CT or T side, choose difficulty. **Pause menu**: resume, restart, sensitivity slider. **Banners** for round win/loss.
- **Match-end stats screen**: full-screen panel on match end with winner headline, final score, and per-team tables — kills, deaths, headshot %, damage dealt, MVP rounds (defuser > planter > top fragger), money spent — plus a Play Again button. Stats accumulate silently all match via the `gameEvents` bus.
- **Death spectate**: short death cam, then first-person spectate of living teammates until the round ends — click cycles targets, auto-advances when the spectated bot dies, HUD shows who you're watching.
- **Plant / defuse progress bar** overlaid on-screen while holding E.
- All HUD is DOM with CSS injected from `hud.ts` at construction — no external `.css` files.

### Audio

- **Fully synthesized** with the Web Audio API — no audio files anywhere in the project.
- **Per-weapon gunshots**: distinct oscillator + noise shapes per gun (AK crack vs M4 thud vs AWP boom vs pistol pop), positional attenuation from bot positions.
- **Footsteps**: triggered by distance-threshold accumulator; walk vs run threshold; positional for bot footsteps.
- **Hit / headshot dings**: separate tones for body-hit confirmation and headshot.
- **Bomb beeps**: accelerate as the timer counts down toward detonation. Positional — sound is louder near the bomb.
- **Bomb plant, defuse, explosion** cues; round-end win/loss stings.
- `audio.unlock()` called on the first user gesture to satisfy the Web Audio autoplay policy.

### Foundations (in place, not yet user-facing)

- **Shared `Combatant` model** ready for any team size — `botsPerTeam` is already a `MatchOptions` field; 5v5 is just the default.
- **Named-area system** (`NamedArea[]` in `MapData`) reusable for new maps; bot routing already references area names rather than hardcoded coordinates.
- **Difficulty params are data-driven** (`BOT_DIFFICULTY` in `constants.ts`); adding a fourth tier is a one-line entry.
- **`gameEvents` typed event bus** (`Emitter<GameEvents>` in `combat.ts`) ready for additional subscribers (stats tracking, replay recording, server sync).

---

## Upcoming features

### Active track — visual & UX overhaul (user-directed)

- **Open-licensed assets** — ✅ world textures · ✅ weapon models · ✅ character models (all shipped; credits in `assets/LICENSES.md`).
- **UI improvement** — ✅ HUD/menu visual overhaul shipped.
- **Performance** — ✅ shipped: tightened shadow frustum (104×96 m fit), high-performance GPU preference, 1.5× pixel-ratio cap, scoreboard/radar update gating, draw-call + triangle counters in the F3 overlay.

### Short term

- **Halftime side swap** — teams exchange CT/T at round 13; economy resets.

### Medium term

- **Wallbang penetration** — raycast continues through thin surfaces with reduced damage.
- **A second map** reusing the same ASCII grid format and `MapData` contract — the navgrid, renderer, and collision system all accept any conforming `MapData`.
- **Replay / demo** — serialize `clock.now`, player inputs, and bot FSM state per tick for round playback.

### Long term

- **Multiplayer via WebSocket / WebRTC** — the `gameEvents` bus and `Combatant` model are already structured for networked sync.
- **Workshop-style custom map loading** — load a `MapData`-shaped JSON at runtime; the same pipeline builds scene, navgrid, and spawns from it.
- **Competitive ranking vs bots** — Elo-style rating adjusted per match against each difficulty tier.

---

## Setup

Requires [Bun](https://bun.sh) ≥ 1.2 (the dev server and HTML bundling use Bun's HTML entrypoint; older Bun versions run checks/tests but emit a stub bundle — CI deploys build with the latest Bun).

```bash
bun install
```

## Commands

| Command | What it does |
|:---|:---|
| `bun run dev` | Dev server at http://localhost:3000 — fresh bundle on every reload (works on Bun 1.1+) |
| `bun run check` | TypeScript type-check only (`tsc --noEmit`) |
| `bun test` | Run the test suite (973 tests) |
| `bun run build` | Bundle for production into `dist/` (~1.1 MB) |

## Controls

| Key / Input | Action |
|:---|:---|
| **W A S D** | Move forward / left / back / right |
| **Mouse** | Look |
| **Left Mouse Button** | Fire |
| **Right Mouse Button** | Scope (AWP only) |
| **R** | Reload |
| **Shift (hold)** | Walk silently |
| **Ctrl (hold)** | Crouch |
| **Space** | Jump |
| **E (hold)** | Plant / defuse bomb |
| **B** | Open / close buy menu |
| **1–9 (buy menu)** | Navigate: pick category (1 Pistols · 2 Mid-Tier · 3 Rifles · 4 Grenades · 5 Gear), then digit buys the item; 0 / Backspace goes back |
| **1 / 2 / 3** | Switch weapon slot: primary / secondary / knife |
| **4** | Equip / cycle grenades (LMB throws) |
| **Mouse wheel** | Cycle weapon slots |
| **Tab (hold)** | Scoreboard |
| **Esc** | Pause menu (Resume · Restart · Sensitivity) |
| **F3** | Debug overlay (FPS, position, speed, phase) |
| **N** | Noclip (debug) |

---

## Architecture

See [`CLAUDE.md`](./CLAUDE.md) for the full project guide. Short module summary:

| Module | Role |
|:---|:---|
| `types.ts` | Frozen contract: `Combatant`, `MapData`, `WeaponDef`, `GameEvents` |
| `constants.ts` | All tunable values: weapons, movement, economy, rules, bot difficulty |
| `world.ts` | Grid-based collision (`moveAABB`) and DDA raycast |
| `movement.ts` | CS-style ground + Quake air movement, shared by player and bots |
| `combat.ts` | Hitscan, hitgroup damage, armor, `gameEvents` bus |
| `weapons.ts` | RPM gate, reload, spread, recoil, scope, slot switching |
| `game.ts` | Game state machine: phases, economy, bomb, spawn, combatant list |
| `bots/nav.ts` | A* over the map grid with binary heap and string-pull |
| `bots/bot.ts` | Per-bot FSM using shared movement + weapon code |
| `characters.ts` | Rigged GLTF characters, AnimationMixer locomotion FSM, wrist-bone weapons (procedural fallback) |
| `hud.ts` | All UI: health, ammo, radar, buy menu, scoreboard, menus |
| `builder.ts` | Scene construction: greedy-merged map geometry + props |
| `main.ts` | Boot, 128 Hz fixed-step loop, camera, player wiring |

---

## Tech stack

- **[Three.js](https://threejs.org/) 0.184** — WebGL rendering
- **[TypeScript](https://www.typescriptlang.org/)** (strict, `noUncheckedIndexedAccess`)
- **[Bun](https://bun.sh/) 1.3** — runtime, dev server (HTML entrypoint), bundler, test runner
- **Open-licensed assets** — CC0 textures (ambientCG, Poly Haven) and CC0 rigged characters + weapon models (Quaternius); map geometry still generated from an ASCII grid; audio 100% synthesized with the Web Audio API (no audio files). Credits: [`assets/LICENSES.md`](./assets/LICENSES.md)
