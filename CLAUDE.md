# Clodstrike — Project Guide for AI Agents

> A Bun + Three.js + TypeScript single-player FPS: 5v5 bomb defusal against bots on a low-poly de_dust2. This file is loaded automatically by Claude Code at the start of every session in this directory.

## Autonomy mandate (CRITICAL — do not wait to be told to continue)

**This is a self-driving development project. The user should NEVER have to say "continue", "next", or "keep going".** Once given a general directive to develop the game, run the full feature lifecycle on a loop, autonomously, until told to stop:

1. **Pick the next feature yourself** — consult the README "Upcoming features" roadmap and the shipped-features list; choose the highest-value, lowest-risk item that fits the existing architecture. The user has explicitly delegated this decision.
2. **Create tasks** (`TaskCreate`) — **ALWAYS, before any agent is spawned** — breaking the feature into the agent-workflow phases; keep statuses current with `TaskUpdate` as phases complete.
3. **Execute via agents only — the lead architects, plans, and splits; agents do ALL the work.** Follow the multi-agent workflow below (contract → implementers → integration → review → fix). Model assignment per agent: **opus for very complex tasks** (frozen-contract `types.ts` redesigns, nav/AI rewrites, multi-domain integration, asset-pipeline foundations, animation systems); **sonnet for well-scoped, narrower tasks** (single-module implementation, HUD work, web research, tests, review, fixes); **NEVER haiku, for anything**. Apart from planning/architecture/supervision, the lead NEVER does the work itself — every code change, web-research sweep, or asset hunt is delegated to an agent; the lead writes the specs, supervises, and verifies. (Lead-direct activities ARE allowed: git operations, CLAUDE.md/README edits, targeted file reads for spec-writing, running the validation gate, smoke testing.)
4. **Test** — run the validation gate (`bun run check && bun test && bun run build`), spawn a READ-ONLY sonnet reviewer, and smoke-test in browser where possible (state the pointer-lock caveat honestly when gameplay can't be driven).
5. **Commit + push** — commit the feature directly to `main`, then a separate `docs:` commit for README updates, and `git push origin main`. NEVER branch, NEVER open a PR.
6. **Update memory** — run the memorai session-end flow; derive 0–3 beliefs. NEVER stage `.memorai/`.
7. **Loop** — immediately pick the next feature and repeat. Do not stop to ask "what's next?" or "should I proceed?".

**Only pause for the user when:**
- There is genuine, implementation-blocking ambiguity where guessing would produce the wrong result, OR
- An action is irreversible/destructive or affects shared state beyond this repo (force-push, history rewrite, deleting remote data) and needs confirmation.

Routine work (picking features, creating tasks, spawning agents, committing to main, pushing, doc updates, memory writes) proceeds WITHOUT asking.

## Current long-term directive (user-issued 2026-06-11)

**The 2026-06-11 standing track is EXHAUSTED (both items shipped 2026-06-12):** (1) dust2 fidelity rebuild (task #28); (2) realistic characters & weapons with proper animations — rigged AnimationMixer characters, real weapon models third- and first-person incl. knife, first-person arms with grip poses (task #29, sub-cycles 29a/29b/29c). With no active user directive, fall back to the autonomy mandate: pick the highest-value, lowest-risk feature from the README "Upcoming features" roadmap each cycle. New user "task:" messages always preempt the roadmap.

**Standing ground rules (carry over to every cycle):**
- **Licenses**: CC0/public-domain strongly preferred; CC-BY only with attribution recorded in `assets/LICENSES.md`. Actual CS2/Valve assets are copyrighted — never use them; use closest open equivalents. Never commit Mixamo files.
- Every asset credited in `assets/LICENSES.md`; keep repo weight reasonable (< ~30 MB added per cycle, discuss if more needed); keep 128 Hz sim headroom and 60 fps render on mid hardware.

---

## Quick reference

- **Stack**: Bun 1.3, TypeScript strict (`tsc --noEmit` = `bun run check`), three@0.184. NO Vite.
- **Entry**: `index.html` → `src/main.ts` — fixed-step simulation at 128 Hz with accumulator loop; render at RAF. Exported `clock.now` (game-time seconds) is THE time source for all game logic.
- **Validation gate**: `bun run check && bun test && bun run build` — all three must pass before any commit. Tests baseline is **1414 tests green**; never let the suite shrink. (Two known intermittents — re-run once before treating as a regression: "F2: guard facing", "Flash blindness re-acquire".)
- **Sim randomness is SEEDED** (`src/rng.ts`): all sim-state randomness flows through `game.rng`'s five per-system streams (combat/botAim/botDecision/botNav/round) so same-seed runs replay identically (`determinism.test.ts` enforces this). NEVER add `Math.random()` to a sim path — use the right stream; cosmetic paths (effects/audio/builder tint) may keep `Math.random()`.
- **Dev server**: `bun run dev` → http://localhost:3000 (`scripts/dev.ts`, per-request Bun.build — works on Bun 1.1+)
- **Repo**: https://github.com/kream0/clodstrike

---

## Project layout

```
assets/             # CC0 textures (textures/) + GLB models (models/) + LICENSES.md — committed
scripts/
  copy-assets.ts    # build step: cpSync assets/ -> dist/assets/ (cross-platform)
  render-grid.ts    # headless top-down PNG rasterizer; optional radar-overlay walkable-mask IoU
src/
  assets.ts         # Async asset loader: loadAllTextures/loadAllNormalTextures/loadGLB,
                    #   assetUrl() resolves vs document.baseURI (GH Pages subpath-safe)
  types.ts          # FROZEN contract — all interfaces, constants, event types
  constants.ts      # WEAPONS, MOVEMENT, ECONOMY, RULES, BOT_DIFFICULTY values
  events.ts         # Tiny strongly-typed Emitter<E> (no deps)
  rng.ts            # Seeded PRNG streams (GameRng) — ALL sim randomness flows through these
  replay.ts         # Replay recorder + log format + playback cursor (pure library)
  math.ts           # clamp, normalize, yawPitchToDir, angleDiff, randSpread, DDA
  input.ts          # Pointer-lock, WASD, mouse delta, wheel, wasPressed edges
  world.ts          # Walkable world: floorAt, moveAABB (swept axis-sep.), raycast DDA
  movement.ts       # simulateMovement — CS-style ground friction / Quake air-accel
  combat.ts         # Hitscan raycast, hitgroup damage, armor, gameEvents bus (Emitter)
  weapons.ts        # updateWeapon — RPM gate, reload, spread, recoil, scope, switchSlot
                    #   + grenade equip/throw state machine (updateGrenadeEquip)
  grenades.ts       # GrenadeManager — HE/flash/smoke projectiles, bounce physics,
                    #   detonation, smoke LOS queries, blindness; pooled meshes
  viewmodel.ts      # First-person weapons_v2 GLBs for all 30 ids incl. knife + rigged arms w/ grip poses (procedural fallback) + bob/sway/kick/reload anims
  effects.ts        # Pooled tracers, impacts, blood, muzzle flash, decals, explosion
  audio.ts          # Web Audio positional synthesis (gunshots, steps, bomb, stings)
  characters.ts     # Rigged GLTF chars (Quaternius), AnimationMixer FSM, wrist weapons (procedural fallback)
  builder.ts        # buildMapScene — greedy row-merge boxes + props; setupEnvironment
  hud.ts            # All HUD: DOM + injected CSS, radar, buy menu, scoreboard, menus
  game.ts           # Game state machine: phases, economy, bomb lifecycle, combatants
  main.ts           # Boot, fixed-step loop, RAF render, player + camera wiring
  maps/
    index.ts        # Map registry: MAPS (dust2/mirage + session maps), DEFAULT_MAP_ID, resolveMap, registerSessionMap
    validate.ts     # 7-tier custom-map JSON validator (never throws; error accumulation)
    dust2.ts        # DUST2 MapData: programmatic carve-from-solid builder driven by dust2_truth.ts
    dust2_truth.ts  # GROUND-TRUTH landmark table: HU→world transform + all point/opening/region facts
    dust2.test.ts   # BFS connectivity suite (every route both directions)
    fidelity.test.ts # Automated fidelity gate: 77 landmark/geometry checks against dust2_truth.ts
    mirage.ts       # MIRAGE MapData: window room, palace balcony, apps/market routes
    mirage.test.ts  # Mirage BFS suite (routes, one-ways, chokes, sites)
  bots/
    nav.ts          # NavGrid — A* over the map grid (octile, binary heap, string-pull)
    nav.test.ts     # Nav unit tests
    bot.ts          # BotManager — per-bot FSM (objective/engage/hunt/plant/defuse/guard)
    bot.test.ts     # Bot behavior tests
    stuck.test.ts   # Deterministic stuck-repro harness: 3 seeds × 2 maps × 3 rounds = zero stuck allowed
```

---

## Architecture rules

1. **`src/types.ts` is the frozen contract.** All cross-module interfaces (`Combatant`, `MapData`, `WeaponDef`, `GameEvents`, etc.) live here. Changing it touches every downstream consumer — edit carefully and coordinate via the contract phase.
2. **No circular dependencies.** Library modules (`movement.ts`, `combat.ts`, `weapons.ts`, `world.ts`, `nav.ts`) NEVER import `main.ts` or `game.ts`. Time is passed in (never read from `clock`). `gameEvents` bus lives in `combat.ts` so combat emitters don't depend on the orchestrator.
3. **ALL game logic uses `clock.now` (game-time seconds), NEVER `performance.now()`.** Wall-clock time skips when the tab is paused and doesn't advance during the freeze phase — the buy-menu round-2 regression was exactly this class of bug. HUD gets game-time via the injected `hud.getNow = () => clock.now` hook.
4. **Fixed-step 128 Hz sim vs frame-rate render.** The accumulator loop advances `clock.now` by `FIXED_DT = 1/128` per tick. Input edges (`wasPressed`, `mousePressed`) must be captured once per frame before the inner loop and honoured only on the first tick (`edgesConsumed` flag). Semi-auto fire and scope toggle are edge-triggered — firing twice per frame from catch-up ticks was a P0 reviewer catch.
5. **Shared movement and weapon code for player and bots.** Both call `simulateMovement(combatant, intent, world, dt, now)` and `updateWeapon(combatant, world, targets, input, now, dt)` identically. Bot brains construct `MoveIntent` and weapon input structs the same way the player does. Do not fork these code paths.
6. **Pooled effects, no per-tick heap allocations in hot paths.** `Effects` pre-allocates tracer/impact/decal pools. `audio` reuses oscillator graphs. No `new THREE.Vector3()` inside the simulation loop.
7. **HUD styles injected from TypeScript.** There are no `.css` files for the HUD. All styles are in the `HUD_CSS` template literal in `hud.ts`, injected once via `<style>` on construction.
8. **Assets are optional everywhere.** `buildMapScene(map, textures?, normals?)` and `ViewModel.setWeaponModels(...)` take loaded assets as optional inputs with full procedural/colors fallback — NEVER remove a fallback path; a 404 must not brick the boot. All assets are CC0 (or CC-BY with recorded attribution), credited in `assets/LICENSES.md`, loaded through `src/assets.ts` only. World texturing relies on world-anchored planar UVs (`projectUV`) so greedy-merged boxes tile seamlessly — keep UVs world-space.

---

## Agent team workflow (USE THIS FOR ANY NON-TRIVIAL FEATURE)

### Phase order

1. **Contract phase** — _sequential, 1 implementer_
   Update `src/types.ts` with new interfaces and event types. Nothing downstream can start until this lands.

2. **Implementation phase** — _parallel, N implementers_
   Each agent owns a disjoint set of NEW or MODIFY files. Send all `Agent` calls in a **single message**. Agents MUST NOT edit files outside their ownership list — if they discover they need one, they stop and report back.

3. **Integration phase** — _sequential, 1 implementer_
   Wires everything together: modifies `main.ts`, `game.ts`, `hud.ts`, and any cross-cutting entry points. Runs the full validation gate.

4. **Review phase** — _sequential, 1 reviewer (READ-ONLY)_
   Audits all changed files. Reports HIGH/MED/LOW findings with `file:line` and concrete fixes. Never edits.

5. **Fix phase** — _sequential, 1 implementer_
   Applies reviewer findings, runs full validation gate, reports.

6. **Smoke test** — _the lead, directly_
   State the pointer-lock/loopback caveat (see Known gotchas). Where possible, use `claude-in-chrome` to click the golden path and failure paths flagged by the reviewer.

### Agent prompt template

Every agent prompt must include:
1. What you're trying to accomplish + why (the user-facing goal)
2. Files you own (exclusive write) — absolute paths, marked NEW / MODIFY / DELETE
3. Files to read first — contracts and patterns; don't make the agent explore
4. Detailed spec — function signatures, behavior, edge cases; no guessing
5. TS reminders: `strict` (note: `noUncheckedIndexedAccess` is NOT enabled in tsconfig.json — guard array accesses manually), no `any`
6. **Validation**: `bun run check && bun test && bun run build` — report stdout/stderr
7. **Report format**: files modified, exports, deviations from spec, validation result, concerns

### Validation gate (full)

1. `bun run check` — zero TypeScript errors
2. `bun test` — **1414 or more** tests green (never let the suite shrink)
3. `bun run build` — completes; warn if bundle grows past 1.5 MB (baseline ~1.1 MB)
4. Browser smoke where possible (pointer-lock caveat — see Known gotchas)

---

## Known gotchas (read this before debugging)

- **`clock.now` vs `performance.now()`.** This is the single most common bug class. Game-time `clock.now` does not advance during freeze, pause, or menu phases (it is monotonic across match restarts — never reset — but never assume that: guard any cached timestamp against going stale across phase/visibility transitions). Any timer set using `performance.now()` will drift by round 2. `hud.ts` gets game-time via the `hud.getNow` hook wired in `main.ts` — do not remove it.
- **Semi-auto / scope input edges must fire on ONE tick per frame.** `mousePressed` and `mouse2Pressed` are edge flags (rising edge this frame). They must be captured before the fixed-step loop and fed only to the first tick via the `edgesConsumed` flag. Catch-up ticks must not duplicate shots or scope toggles.
- **Pointer lock requires a user gesture.** `requestPointerLock()` only works inside a synchronous click/keypress handler. Don't `await` before calling it. Pointer-lock loss while in-game auto-pauses; re-locking unpauses.
- **WebAudio needs `audio.unlock()` on gesture.** Call it alongside `requestPointerLock()` on the first user interaction that starts the match.
- **ESM-only browser bundle.** `package.json` has `"type": "module"`. No `require()`, no CommonJS. Static imports only — no dynamic `import()` in hot paths.
- **claude-in-chrome is loopback-isolated on this machine.** The MCP browser cannot reach `localhost:3000`. Smoke tests are done by the human playtester. Be honest about this rather than claiming browser verification.
- **URL-parameter debug modes** (no pointer lock or match required): `?inspect=vm` — first-person viewmodel/arms inspector; keys N/P cycle weapons, F fires; optional `&team=T` and `&walk=1`. `?spectate=1` — auto-start all-bot match with orbit/follow camera; keys `[`/`]` follow prev/next combatant, `O` orbit; optional `&map=<id>` and `&seed=<n>`. `?photo=<station>` — teleports a free camera to 9 iconic dust2 vantage points (`longdoors-t`, `mid-from-ct`, `bwindow`, `catwalk`, `pit`, `tunnels-exit`, `a-site`, `mid-doors`, `goose`) for human fidelity comparison; keys N/P cycle stations, WASD move, arrows look, Q/E up/down.
- **Map grid conventions.** Units are meters. Cell size = 1 m. Grid is 96×96; origin = world `x −48, z −48` (rebuilt 2026-06 from real-map radar/setpos calibration, 1 HU = 0.01905 m). Row 0 is north (CT/sites side); rows grow south (+Z, T side). Columns grow east (+X). Y = up. Floor heights are multiples of 0.375 m — rebuilt ground-truth values: CT spawn 0.0 m (lowest, ground reference); mid/long/catwalk/B-site 3.75 m; upper tunnels 3.75 m floor (covered, ceil 6.0 m); B window platform 4.125 m; A site 4.5 m; T spawn 4.5 m. These come from the affine HU→grid transform in `dust2_truth.ts` (Y_OFFSET = +2.31 m so CT spawn lifts to 0; all other floors are the uniform-shifted real relative heights). Step-up ≤ 0.5 m — the one-way drops (catwalk→lower mid, B window→site, pit edges, T plat ledge) rely on this rule; don't "fix" them by adding steps. Covered cells (tunnels, doors) have explicit ceiling heights in the legend. **Dust2 is now ground-truth-first**: `dust2.ts` is a programmatic builder verified by `fidelity.test.ts` (77 checks) — keep both green when touching the grid.
- **`dust2.test.ts` BFS connectivity is the safety net.** If you touch `dust2.ts` or `world.ts`, keep the BFS suite green. It verifies that every named route (Long/Short/Mid/Tunnels) is traversable in both directions.
- **Props must stay axis-aligned AABBs.** `MapProp` sizes are full extents. The collision system and navgrid both assume no rotation on props.
- **Renderer assumes greedy-merged static world.** `buildMapScene` merges adjacent cells of the same material into row-merged box meshes (<10 static draw calls). Adding per-cell meshes will blow the draw call budget and break the prop-occlusion assumptions.
- **Local bun (npm shim) is 1.1.29 — three consequences.** (1) `bun ./index.html` dev server needs Bun ≥ 1.2 and fails locally; the human playtester runs a newer bun. (2) Local `bun run build` emits a 0.11 KB stub JS (HTML not really bundled) — the REAL bundling happens in CI (`oven-sh/setup-bun@v2` = latest). Local `dist/` is NOT deployable; verify deploys via the GitHub Actions run / the live site, not local dist. (3) `bun install` may drop a binary `bun.lockb` — it is gitignored; the text `bun.lock` is canonical.
- **Texture color spaces.** Color maps = `SRGBColorSpace`; normal maps = `NoColorSpace` (raw data). A cloned `THREE.Texture` needs `needsUpdate = true` or it renders black.
- **CRLF warnings on Windows are noise.** Git auto-converts on commit. Don't fight it.
- **Friendly fire is OFF and there is no halftime side swap.** Both are deliberate design decisions encoded in `RULES` and `Game`. Do not "fix" them.
- **`.memorai/` is the local memory store (gitignored).** The memorai session hook creates one in this directory (and another may exist in the parent `fable-bench/`). Never stage it. Never stage `_ref_*.md` reference files from the parent directory either — they are not part of this repo.

---

## Git conventions for this repo

> **This repo OVERRIDES the global `~/.claude/CLAUDE.md` branch/PR workflow.** This is a personal sandbox: **work directly on `main`.** Do NOT create `feature/`, `task/`, or `bugfix/` branches. Do NOT open pull requests. Commit straight to `main` and `git push origin main`. (The ADO ticket-to-PR flow in the global rules does not apply here.)

- Default branch: `main` — commit and push directly; never branch, never PR.
- Commit messages: short subject line + bullet/paragraph body. End every AI-assisted commit with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Don't `--amend` published commits. Don't `--no-verify` to skip hooks.
- `node_modules/`, `dist/`, `.env*` are gitignored; `bun.lock` (text lockfile) IS committed. `.memorai/` is gitignored — never stage it.
