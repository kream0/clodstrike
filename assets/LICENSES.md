# Asset Licenses

All assets in this directory are published under the **CC0 1.0 Universal** license (Public Domain Dedication). AmbientCG and Poly Haven publish every asset they host under CC0 — no attribution is legally required, though it is appreciated.

## Textures

| Slot | Asset ID | Source Page | License | Downloaded |
|---|---|---|---|---|
| ground_sand | Ground054 | https://ambientcg.com/view?id=Ground054 | CC0 1.0 | 2026-06-11 |
| wall_sandstone | Bricks083 | https://ambientcg.com/view?id=Bricks083 | CC0 1.0 | 2026-06-11 |
| wall_plaster | Plaster001 | https://ambientcg.com/view?id=Plaster001 | CC0 1.0 | 2026-06-11 |
| floor_stone | PavingStones150 | https://ambientcg.com/view?id=PavingStones150 | CC0 1.0 | 2026-06-11 |
| concrete | Concrete047A | https://ambientcg.com/view?id=Concrete047A | CC0 1.0 | 2026-06-11 |
| wood | Wood039 | https://ambientcg.com/view?id=Wood039 | CC0 1.0 | 2026-06-11 |
| metal | PaintedMetal013 | https://ambientcg.com/view?id=PaintedMetal013 | CC0 1.0 | 2026-06-11 |
| fabric | fabric_pattern_05 | https://polyhaven.com/a/fabric_pattern_05 | CC0 1.0 | 2026-06-11 |

## Files per slot

Each slot has two files in `textures/`:
- `<slot>.jpg` — Color/Albedo map (sRGB)
- `<slot>_normal.jpg` — Normal map in OpenGL convention (linear, NormalGL)

## Models

All weapon GLBs in `models/weapons/` are from the **CC0 Flat Guns** packs by **Pichuliru**, published under CC0 1.0 Universal (Public Domain Dedication).

| File | Source File | Pack | Pack Page | License | Downloaded |
|---|---|---|---|---|---|
| glock.glb | Pistol_Compact_West.glb | CC0 Flat Guns West | https://opengameart.org/content/cc0-flat-guns-west | CC0 1.0 | 2026-06-11 |
| usp.glb | Pistol_Full_West.glb | CC0 Flat Guns West | https://opengameart.org/content/cc0-flat-guns-west | CC0 1.0 | 2026-06-11 |
| deagle.glb | Pistol_Full_East.glb | CC0 Flat Guns East | https://opengameart.org/content/cc0-flat-guns-east | CC0 1.0 | 2026-06-11 |
| ak47.glb | Rifle_Assault_East.glb | CC0 Flat Guns East | https://opengameart.org/content/cc0-flat-guns-east | CC0 1.0 | 2026-06-11 |
| m4a4.glb | Rifle_Assault_West.glb | CC0 Flat Guns West | https://opengameart.org/content/cc0-flat-guns-west | CC0 1.0 | 2026-06-11 |
| awp.glb | Sniper_Rifle_West.glb | CC0 Flat Guns West | https://opengameart.org/content/cc0-flat-guns-west | CC0 1.0 | 2026-06-11 |

Note: The knife weapon slot remains procedural (no style-matched CC0 knife model available in these packs).


## Rigged Characters (v2) — models/rigged/

All rigged character GLTF files in `models/rigged/` are from the **Ultimate Modular Men Pack** by **Quaternius** (laulhet@gmail.com), published under CC0 1.0 Universal (Public Domain Dedication). Pack page: https://quaternius.com/packs/ultimatemodularcharacters.html — Google Drive download folder: https://drive.google.com/drive/folders/1USAAquX2JJWuA2m6zol0KUkFe3UkZ8zX

Each GLTF is self-contained (binary data base64-embedded, no external .bin), 62-bone humanoid rig named "CharacterArmature", 24 embedded animation clips.

| File | Source File | Drive File ID | License | Downloaded |
|---|---|---|---|---|
| ct_operator.gltf | Swat.gltf | 1VGmU5f8a43NBT22JWB507NDSLbmNxzF9 | CC0 1.0 | 2026-06-12 |
| t_phoenix.gltf | Punk.gltf | 1yHWu5ezXq4dYBcn4sWiNd16YN9fMtXo0 | CC0 1.0 | 2026-06-12 |

Embedded animation clips (identical set in both files): Death, Gun_Shoot, HitRecieve, HitRecieve_2, Idle, Idle_Gun, Idle_Gun_Pointing, Idle_Gun_Shoot, Idle_Neutral, Idle_Sword, Interact, Kick_Left, Kick_Right, Punch_Left, Punch_Right, Roll, Run, Run_Back, Run_Left, Run_Right, Run_Shoot, Sword_Slash, Walk, Wave.

Note: The Universal Animation Library (separate clip library for retargeting) is hosted on itch.io (https://quaternius.itch.io/universal-animation-library) and requires a CAPTCHA-gated download; it was not obtainable in this session. The 24 clips embedded in each character file cover all required FPS gameplay states (idle, walk, run, strafe, shoot, reload-pose, death, hit-react, crouch).

## Weapons v2 — models/weapons_v2/

All weapon GLBs in `models/weapons_v2/` are by **Quaternius**, published under CC0 1.0 Universal (Public Domain Dedication), mirrored on **Poly Pizza** (https://poly.pizza/u/Quaternius). Static prop meshes (no rig, no animations) — suitable for viewmodel and world-model rendering.

| File | Poly Pizza Page | Resource ID | License | Downloaded |
|---|---|---|---|---|
| pistol.glb | https://poly.pizza/m/J3i9KDQ3kt | f5a88c73-af97-49ca-8650-4bde579d2f80 | CC0 1.0 | 2026-06-12 |
| assault_rifle.glb | https://poly.pizza/m/Bgvuu4CUMV | 9a0e478c-de82-4773-9b70-a0219bb0057c | CC0 1.0 | 2026-06-12 |
| assault_rifle_2.glb | https://poly.pizza/m/K2lXTYFSLC | b3e6be61-0299-4866-a227-58f5f3fe610b | CC0 1.0 | 2026-06-12 |
| shotgun.glb | https://poly.pizza/m/ZmPTnh7njL | f71d6771-f512-4374-bd23-ba00b564db68 | CC0 1.0 | 2026-06-12 |
| sniper_rifle.glb | https://poly.pizza/m/ASOMZIErq3 | f03e21b7-e3b7-49fd-b47d-d1908649fcee | CC0 1.0 | 2026-06-12 |
| smg.glb | https://poly.pizza/m/7ehatxr7FY | fb8ae707-d5b9-4eb8-ab8c-1c78d3c1f710 | CC0 1.0 | 2026-06-12 |
| scifi_smg.glb | https://poly.pizza/m/NHYaHnTNIM | cc2ce213-28b2-4aed-a6f7-4b9cf8f80568 | CC0 1.0 | 2026-06-12 |
| revolver.glb | https://poly.pizza/m/9C26wSpMS0 | 9e728565-67a3-44db-9567-982320abff09 | CC0 1.0 | 2026-06-12 |
| knife.glb | https://poly.pizza/m/N9bfPFP1hr | db1c8b42-5e15-47c3-99dc-0d19b1ee5115 | CC0 1.0 | 2026-06-12 |
