// de_dust2 -- pure map data. No three.js, no side effects.
//
//                 N (-Z, row 0, CT/sites side)
//             W (-X)  +  E (+X)    cell(col,row): x = col-48+0.5, z = row-48+0.5
//                 S (+Z, row 95, T side)
//
// Grid: 96 cols x 96 rows.  origin { x:-48, z:-48 }
// Col = worldX + 48   (col 0 = x -48, col 95 = x +47)
// Row = worldZ + 48   (row 0 = z -48 [NORTH/CT], row 95 = z +47 [SOUTH/T])
//
// HIGH-CONFIDENCE ANCHORS (world coords):
//   T-spawn center   (-14.5, +26)  -> col 33, row 74
//   CT-spawn center  (+5,   -35)   -> col 53, row 13
//   A-site center    (+23,  -36)   -> col 71, row 12
//   B-site center    (-29,  -41)   -> col 19, row  7
//
// Legend (heights in metres; covered cells have ceil property):
//   ' '  void/solid   '#' wall/boundary
//   'p' -0.75  'P' -0.375  (pit depths)
//   '0' 0.0  '1' 0.375  '2' 0.75  '3' 1.125  '4' 1.5
//   '5' 1.875  '6' 2.25  '7' 2.625  '8' 3.0  '9' 3.375
//   'q' 3.75  'r' 4.125  'f' 4.5
//   'M' 0.0 (mid-floor)  'm' 0.375  'n' 0.75  'o' 1.125
//   'v' 1.875  'w' 2.25  'x' 2.625  'y' 3.0  'z' 3.375
//   'c' 2.25 catwalk  'A' 4.5 A-site/short  'G' 4.5 GooseA
//   'B' 1.5 B-site  'b' 2.25 B-plat
//   'C' 0.0 CT-spawn  'S' 4.5 T-spawn plateau
//   Covered tunnels (floor/ceil):
//     'u' 1.5/4.5  'i' 1.875/4.5  'j' 2.25/4.5  'k' 2.625/4.5  'h' 3.0/4.5
//   'L' 0.375/3.5 lower-tunnels
//   'D' 0.0/4.0 mid-doors  'E' 1.5/4.5 B-doors  'F' 1.5/4.0 long-doors
//
// Map layout sketch (N=top, S=bottom):
//
//  [BPlat]        [BDoors][CTSpawn ][CTRamp][ASite][GooseA]   rows 2-21
//                         [CTMid   ]       [AShort][ARamp][Pit]rows 14-32
//  [BSite         ]       [TopMid/Catwalk  ][LongA         ]   rows 32-52
//  [UpperTunnels      ][LowerTunnels][LowerMid][LongDoors   ]  rows 46-65
//  [OutsideTunnels][TSpawn         ][OutsideLong            ]  rows 62-82
//
// Topology (bidirectional unless →):
//  TSpawn↔OutsideTunnels, TSpawn↔OutsideLong, TSpawn↔TopMid(via TPlat→Catwalk)
//  OutsideLong↔LongDoors↔LongA, LongA→Pit(drop)+Pit→LongA(east ramp)
//  LongA↔ARamp↔ASite, ASite↔AShort↔ShortStairs↔Catwalk↔TopMid
//  Catwalk→LowerMid(one-way drop), TopMid↔LowerMid(slope), TopMid↔MidDoors
//  LowerMid↔LowerTunnels↔UpperTunnels↔BSite
//  LowerMid↔MidDoors↔CTMid↔CTSpawn, CTMid↔MidToB↔BDoors↔BSite
//  CTSpawn↔CTRamp↔ASite, GooseA=dead-end off ASite

import type { MapData } from '../types';

export const DUST2: MapData = {
  name: 'de_dust2',
  cellSize: 1,
  origin: { x: -48, z: -48 },
  grid: [
    '                                                                                                ', // row  0  z=-48
    '                                                                                                ', // row  1  z=-47
    '    ###############################                           ###########################       ', // row  2  z=-46
    '    #bbbbbvBBBBBBBBBBBBBBBBBBBBBBB#                           #AAAAAAAAAAAAAAAAAAAAGGGGG#       ', // row  3  z=-45
    '    #bbbbbvBBBBBBBBBBBBBBBBBBBBBBB#               #############AAAAAAAAAAAAAAAAAAAAGGGGG#       ', // row  4  z=-44
    '    #bbbbbvBBBBBBBBBBBBBBBBBBBBBBB#               #CCCCCCCCCCC#AAAAAAAAAAAAAAAAAAAAGGGGG#       ', // row  5  z=-43
    '    #bbbbbvBBBBBBBBBBBBBBB#########               #CCCCCCCCCCC#AAAAAAAAAAAAAAAAAAAAGGGGG#       ', // row  6  z=-42
    '    #bbbbbvBBBBBBBBBBBBBBB#EEEEEEBB               #CCCCCCCCCCC#AAAAAAAAAAAAAAAAAAA#######       ', // row  7  z=-41
    '    #BBBBBBBBBBBBBBBBBBBBB#EEEEEEBB               #CCCCCCCCCCC#AAAAAAAAAAAAAAAAAAAAAAA#         ', // row  8  z=-40
    '    #BBBBBBBBBBBBBBBBBBBBB#EEEEEEBB               #CCCCCCCCCCC#AAAAAAAAAAAAAAAAAAAAAAA#         ', // row  9  z=-39
    '    #BBBBBBBBBBBBBBBBBBBBB#EEEEEEBB               #CCCCCCCCC##fffffffffAAAAAAAAAAAAAAA#         ', // row 10  z=-38
    '    #BBBBBBBBBBBBBBBBBBBBB#EEEEEEBB               #CCCCCCCCC#ffffffffffAAAAAAAAAAAAAAA#         ', // row 11  z=-37
    '    #BBBBBBBBBBBBBBBBBBBBB#EEEEEEBB               #CCCCCCCCC#ffffffffffAAAAAAAAAAAAAAA#         ', // row 12  z=-36
    '    #BBBBBBBBBBBBBBBBBBBBBEEEEEEEEEEE             #CCCCCCCCC#rfffffffffAAAAAAAAAAAAAAA#         ', // row 13  z=-35
    '    ###BBBBB##############EEEEEEEEEEE#MMM########MMCCCCCCCCC#qqqqqqqqq#AAAAAAAAAAAAAAA#         ', // row 14  z=-34
    '      #uuuuu#             33333333333MMMMMMMMMMMMMMCCCCCCCCC#999999999#AAAAAAAAAAAAAAA#         ', // row 15  z=-33
    '      #uuuuu#             22222222222MMMMMMMMMMMMMMCCCCCCCCC#888888888#AAAAAAAAAAAAAAA#         ', // row 16  z=-32
    '      #uuuuu#             111111111111MMMMMMMMMMMMMCCCCCCCCC#777777777#AAAAAAAAAAAAAAA#         ', // row 17  z=-31
    '      #uuuuu#             MMMMMMMMMMMMMMMMMMMMMMMM###########666666666#AAAAAAAAAAAAAAA#         ', // row 18  z=-30
    '      #uuuuu#             #E#MMMMMMMMMMMMMMMMMMMMM#         #555555555#AAAAAAAAAAAAAAA#         ', // row 19  z=-29
    '      #uuuuu#             ###MMMMMMMMMMMMMMMMMMMMM#         #42222AAAAAAAAAAAAAAAAAAAAA         ', // row 20  z=-28
    '      #uuuuu#               #MMMMMMMMMMMMMMMMMMMMM#         #31111AAAAAAAAAAAAAAAAAAAAA         ', // row 21  z=-27
    '      #uuuuu#               #MMMMMMMMMMMMMMMMMMMMM#     6789q00000AAAAAAAAAAAAAAAAAAAAA         ', // row 22  z=-26
    '      #uuuuu#               #MMMMMMMMMMMMMMMMMMMMM#     6789qrAAAAAA#fffffffff#                 ', // row 23  z=-25
    '      #uuuuu#               #MMMMMMMMMMMMMMMMMMMMM#     6789qrAAAAAA#fffffffff#                 ', // row 24  z=-24
    '      #uuuuu#               #MMMMMMMMMMMMMMMMMMMMM#     6789qrAAAAAA#rrrrrrrrr#                 ', // row 25  z=-23
    '      #uuuuu#               #MMMMMMMMMMMMMMMMMMMMM#     6789qrAAAAAA#qqqqqqqqq#                 ', // row 26  z=-22
    '      #uuuuu#               #MMMMMMMMMMMMMMMMMMMMM#     6789qrAAAAAA#999999999#                 ', // row 27  z=-21
    '      #uuuuu#               #MMMMMMMMMMMMMMMM #ccccccccc6c#9qrAAAAAA#888888888#   #44########   ', // row 28  z=-20
    '      #uuuuu#               #MMMMMMMMMMMMMMMM #ccccccccccc#9qrAAAAAA#777777777#   #000000000#   ', // row 29  z=-19
    '      #uuuuu#               ##########MMMMMMM #ccccccccccc#9qrAAAAAA#666666666#   #000000000#   ', // row 30  z=-18
    '      #uuuuu#                         #MMMMMM #ccccccccccc#9qrAAAAAA#555555555#   #110000000#   ', // row 31  z=-17
    '      #uuuuu#                         #MMMMMM #ccccccccccc#9qr444444444444444444444220000000#   ', // row 32  z=-16
    '      #uuuuu#                         #MMMMMM #ccccccccccc#   444444444444444444444330000000#   ', // row 33  z=-15
    '      #uuuuu#                         #MMMMMMMcccccccccccc# ##444444444444444444444440000000#   ', // row 34  z=-14
    '      #uuuuu#                         #MMMMMMMcccccccccccc# #4444444444444444444444000000000#   ', // row 35  z=-13
    '      #uuuuu#                         #MMMMMMMcccccccccccc# #4444444444444444444444000000000#   ', // row 36  z=-12
    '      #uuuuu#                         #MMMMMMMcccccccccccc# #4444444444444444444444000000000#   ', // row 37  z=-11
    '      #uuuuu#                         #MMMMMMMcccccccccccc# #4444444444444444444444##########   ', // row 38  z=-10
    '      #uuuuu#                         #MMMMMMMcccccccccccc# #444444444444444444444#             ', // row 39  z=-9
    '      #uuuuu#                         #MMMMMMMcccccccccccc# #444444444444444444444#             ', // row 40  z=-8
    '      #uuuuu#                         #DDDDDDMcccccccccccc# #444444444444444444444#             ', // row 41  z=-7
    '      #uuuuu#                         #DDDDDDMcccccccccccc# #444444444444444444444#             ', // row 42  z=-6
    '      #uuuuu#                         #DDDDDDMcccccccccccc# #444444444444444444444#             ', // row 43  z=-5
    '      #uuuuu#                         #DDDDDDMcccccccccccc# #444444444444444444444#             ', // row 44  z=-4
    '      #uuuuu#                         #DDDDDD #ccccccccccc# #444444444444444444444#             ', // row 45  z=-3
    '      #uuuuu######################### #DDDDDD #ccccccccccc# #444444444444444444444#             ', // row 46  z=-2
    '        #uuuuuuuuuuuuuuuuuuuuuuuuuuu# #DDDDDD #ccccccccccc# #444444444444444444444#             ', // row 47  z=-1
    '        #uuuuuuuuuuuuuuuuuuuuuuuuuuu# #DDDDDD #ccccccccccc# #444444444444444444444#             ', // row 48  z=+0
    '        #uuuuuuuuuuuuuuuuuuuuuuuuuuu# #DDDDDD #ccccccccccc# #444444444444444444444#             ', // row 49  z=+1
    '        #uuuuuuuuuuuuuuuuuuuuuuuuuuu# #DDDDDD ##############4444444444444444444444#             ', // row 50  z=+2
    '        #uuuuuuuuuuuuuuuuuuuuuuuuuuu# #DDDDDD # DDDD#FFFFFFF4444444444444444444444#             ', // row 51  z=+3
    '        #uuuuuuuuuuuuu################MMMMMMMMMMMMMMMMMMFFFF444####################             ', // row 52  z=+4
    '        #uuuuuuuuuuuuu#MMMMMMMMMMMMMMMLLLLLLLMMMMMMM#FFFFFFFFF#                                 ', // row 53  z=+5
    '        #uuuuuuuuuuuuu#MMMMMMMMMMMMMMMLLLLLLLMMMMMMM#FFFFFFFFF#                                 ', // row 54  z=+6
    '        #uuuuuuuuuuuuu#MMMMMMMMMMMMMMMLLLLLLLMMMMMMM#FFFFFFFFF#                                 ', // row 55  z=+7
    '        #uuuuuuuuuuuuu#MMMMMMMMMMMMMMMLLLLLLLMMMMMMM#FFFFFFFFF#                                 ', // row 56  z=+8
    '        #uuuuuuuuuuuuu#111111111111111LLLLLLLMMMMMMM#FFFFFFFFF#                                 ', // row 57  z=+9
    '        #uuuuuuuuuuuuu#222222222222222LLLLLLLMMMMMMM#FFFFFFFFF#                                 ', // row 58  z=+10
    '        #uuuuuuuuuuuuu#333333333333333LLLLLLLMMMMMMM#FFFFFFFFF#                                 ', // row 59  z=+11
    '        #uuuuuuuuuuuuu#444444444444444LLLLLLLMMMMMMM#FFFFFFFFF#                                 ', // row 60  z=+12
    '        #uuuuuuuuuuuuu#555555555555555LLLLLLLMMMMMMM#FFFFFFFFF#                                 ', // row 61  z=+13
    '        #uuuuuuuuuuuuuuu66666666666666666666#########FFFFFFFFF###                               ', // row 62  z=+14
    '        #uuuuuuuuuuuuu#777777777777777777777#44444444FFFFFFFFF44#                               ', // row 63  z=+15
    '        #uuuuuuuuuuuuu#888888888888888888888#44444444FFFFFFFFF44#                               ', // row 64  z=+16
    '        #uuuuuuuuuuuuu#999999999999999999999#4444444444444444444#                               ', // row 65  z=+17
    '        #uuuuuuuuuuuuu#qqqqqqqqqqqqqqqqqqqqq#4444444444444444444#                               ', // row 66  z=+18
    '        #uuuuuuuuu#####rrrrrrrrrrrrrrrrrrrrr#4444444444444444444#                               ', // row 67  z=+19
    '        #uuuuuuuuu#rrrrSuSSSSSSSSSSSSSSSSSSSrrrrrrrrrrr444444444#                               ', // row 68  z=+20
    '        #uuuuuuuuu#qqqrSuSSSSSSSSSSSSSSSSSSSrqqqqqqqqqq444444444#                               ', // row 69  z=+21
    '        #uuuuuuuuu#999rSuSSSSSSSSSSSSSSSSSSSr9999999999444444444#                               ', // row 70  z=+22
    '        #uuuuuuuuu#888rSuSSSSSSSSSSSSSSSSSSSr8888888888444444444#                               ', // row 71  z=+23
    '        #uuuuuuuuu#777rSuSSSSSSSSSSSSSSSSSSSr7777777777444444444#                               ', // row 72  z=+24
    '        #uuuuuuuuu#666rSuSSSSSSSSSSSSSSSSSSSr6666666666444444444#                               ', // row 73  z=+25
    '        ###########555rSuSSSSSSSSSSSSSSSSSSSr5555555555444444444#                               ', // row 74  z=+26
    '                  #444rSSSSSSSSSSSSSSSSSSSSSr4444444444444444444#                               ', // row 75  z=+27
    '                  #uuurSSSSSSSSSSSSSSSSSSSSSr####################                               ', // row 76  z=+28
    '                      #SSSSSSSSSSSSSSSSSSSSS#                                                   ', // row 77  z=+29
    '                      #SSSSSSSSSSSSSSSSSSSSS#                                                   ', // row 78  z=+30
    '                      #SSSSSSSSSSSSSSSSSSSSS#                                                   ', // row 79  z=+31
    '                      #######################                                                   ', // row 80  z=+32
    '                                                                                                ', // row 81  z=+33
    '                                                                                                ', // row 82  z=+34
    '                                                                                                ', // row 83  z=+35
    '                                                                                                ', // row 84  z=+36
    '                                                                                                ', // row 85  z=+37
    '                                                                                                ', // row 86  z=+38
    '                                                                                                ', // row 87  z=+39
    '                                                                                                ', // row 88  z=+40
    '                                                                                                ', // row 89  z=+41
    '                                                                                                ', // row 90  z=+42
    '                                                                                                ', // row 91  z=+43
    '                                                                                                ', // row 92  z=+44
    '                                                                                                ', // row 93  z=+45
    '                                                                                                ', // row 94  z=+46
    '                                                                                                ', // row 95  z=+47
  ],
  legend: {
    ' ': { floor: 0, wall: true },
    '#': { floor: 0, wall: true, mat: 'sand' },
    p: { floor: -0.75, mat: 'sand' },
    P: { floor: -0.375, mat: 'sand' },
    '0': { floor: 0, mat: 'sand' },
    '1': { floor: 0.375, mat: 'sand' },
    '2': { floor: 0.75, mat: 'sand' },
    '3': { floor: 1.125, mat: 'sand' },
    '4': { floor: 1.5, mat: 'sand' },
    '5': { floor: 1.875, mat: 'sand' },
    '6': { floor: 2.25, mat: 'sand' },
    '7': { floor: 2.625, mat: 'sand' },
    '8': { floor: 3.0, mat: 'sand' },
    '9': { floor: 3.375, mat: 'sand' },
    q: { floor: 3.75, mat: 'sand' },
    r: { floor: 4.125, mat: 'sand' },
    f: { floor: 4.5, mat: 'sand' },
    M: { floor: 0, mat: 'floor' },
    m: { floor: 0.375, mat: 'floor' },
    n: { floor: 0.75, mat: 'floor' },
    o: { floor: 1.125, mat: 'floor' },
    v: { floor: 1.875, mat: 'floor' },
    w: { floor: 2.25, mat: 'floor' },
    x: { floor: 2.625, mat: 'floor' },
    y: { floor: 3.0, mat: 'floor' },
    z: { floor: 3.375, mat: 'floor' },
    c: { floor: 2.25, mat: 'floor' },
    A: { floor: 4.5, mat: 'stone' },
    B: { floor: 1.5, mat: 'stone' },
    b: { floor: 2.25, mat: 'stone' },
    G: { floor: 4.5, mat: 'stone' },
    C: { floor: 0, mat: 'sandLight' },
    S: { floor: 4.5, mat: 'sand' },
    u: { floor: 1.5, ceil: 4.5, mat: 'dark' },
    i: { floor: 1.875, ceil: 4.5, mat: 'dark' },
    j: { floor: 2.25, ceil: 4.5, mat: 'dark' },
    k: { floor: 2.625, ceil: 4.5, mat: 'dark' },
    h: { floor: 3.0, ceil: 4.5, mat: 'dark' },
    L: { floor: 0.375, ceil: 3.5, mat: 'dark' },
    D: { floor: 0, ceil: 4.0, mat: 'floor' },
    E: { floor: 1.5, ceil: 4.5, mat: 'sand' },
    F: { floor: 1.5, ceil: 4.0, mat: 'sand' },
  },
  props: [
    // A site: two default crates + stacked
    { kind: 'crate', pos: [23.5, 4.5, -37.5], size: [1.5, 1.5, 1.5], mat: 'wood', collide: true },
    { kind: 'crate', pos: [25.2, 4.5, -37.5], size: [1.5, 1.5, 1.5], mat: 'wood', collide: true },
    { kind: 'crate', pos: [24.4, 6.0, -37.5], size: [1.5, 1.5, 1.5], mat: 'wood', collide: true },
    // A back-wall ninja box
    { kind: 'crate', pos: [32.0, 4.5, -43.0], size: [1.2, 1.2, 1.2], mat: 'wood', collide: true },
    // A-triple near CT ramp mouth
    { kind: 'crate', pos: [17.5, 4.5, -32.0], size: [1.2, 1.2, 1.2], mat: 'wood', collide: true },
    { kind: 'crate', pos: [17.5, 5.7, -32.0], size: [1.2, 1.2, 1.2], mat: 'wood', collide: true },
    // Goose pocket box stack (in GooseA cols 82-88, rows 2-7, z=-46 to -41)
    { kind: 'crate', pos: [36.5, 4.5, -44.0], size: [1.2, 1.5, 1.2], mat: 'wood', collide: true },
    { kind: 'crate', pos: [36.5, 6.0, -44.0], size: [1.2, 1.5, 1.2], mat: 'wood', collide: true },
    // Xbox at catwalk/top-mid junction
    { kind: 'crate', pos: [-1.5, 2.25, -9.5], size: [1.5, 1.5, 1.5], mat: 'wood', collide: true },
    // Mid doors (two metal leaves, ~1.2 m gap) - centered around col 48 row 47 (z=-1)
    { kind: 'door', pos: [-3.0, 0, -1.5], size: [1.8, 2.6, 0.15], mat: 'metal', collide: true },
    { kind: 'door', pos: [0.5, 0, -1.5], size: [1.8, 2.6, 0.15], mat: 'metal', collide: true },
    // Short dumpster near short-stairs base (AShort area, ~col 64, row 27)
    { kind: 'block', pos: [16.5, 2.25, -21.0], size: [2.0, 1.5, 1.0], mat: 'metal', collide: true },
    // B site: car (east side of B-site)
    { kind: 'car',    pos: [-21.5, 2.25, -41.5], size: [4.2, 1.4, 1.9], mat: 'metal', collide: true },
    // B site: double-stack crates (back-left of site)
    { kind: 'crate',  pos: [-29.5, 2.25, -42.5], size: [2.0, 2.0, 2.0], mat: 'wood', collide: true },
    { kind: 'crate',  pos: [-29.5, 4.25, -42.5], size: [2.0, 2.0, 2.0], mat: 'wood', collide: true },
    // B site: loose crate
    { kind: 'crate',  pos: [-27.0, 2.25, -40.5], size: [1.5, 1.5, 1.5], mat: 'wood', collide: true },
    // B-plat back barrel
    { kind: 'barrel', pos: [-22.0, 2.25, -44.5], size: [0.6, 0.9, 0.6], mat: 'metal', collide: true },
    // B doors sandbag
    { kind: 'sandbag', pos: [-18.0, 1.5, -34.0], size: [1.6, 0.9, 0.8], collide: true },
    // B window boxes (under sill, on BSite floor side at UpperTunnels/BSite boundary)
    { kind: 'crate', pos: [-16.0, 1.5, -31.0], size: [1.2, 2.25, 1.2], mat: 'wood', collide: true },
    // Long: blue container (in LongA area near LongDoors, ~col 57, row 51)
    { kind: 'block',  pos: [10.5, 1.5, 3.0],  size: [2.5, 2.5, 5.0], mat: 'metal', collide: true },
    // Long car (OutsideLong, ~col 54, row 68)
    { kind: 'car',    pos: [6.5, 4.125, 20.0], size: [4.2, 1.4, 1.9], mat: 'metal', collide: true },
    // Long doors (two metal leaves, long corridor)
    { kind: 'door', pos: [6.5, 1.5, 11.5], size: [1.8, 2.6, 0.15], mat: 'metal', collide: true },
    { kind: 'door', pos: [9.5, 1.5, 11.5], size: [1.8, 2.6, 0.15], mat: 'metal', collide: true },
    // Pit barrels (Pit area ~col 86, row 26)
    { kind: 'barrel', pos: [38.5, 1.5, -22.0], size: [0.6, 0.9, 0.6], mat: 'metal', collide: true },
    { kind: 'barrel', pos: [39.5, 1.5, -21.0], size: [0.6, 0.9, 0.6], mat: 'metal', collide: true },
    // CT mid sandbags (CTMid area)
    { kind: 'sandbag', pos: [-3.5, 0, -28.0], size: [1.6, 0.9, 0.8], collide: true },
    // Upper tunnels clutter (UpperTunnels ~col 21, row 54)
    { kind: 'crate',  pos: [-26.0, 1.5, 6.5],  size: [1.2, 1.2, 1.2], mat: 'wood', collide: true },
    { kind: 'barrel', pos: [-20.0, 1.5, 2.0], size: [0.6, 0.9, 0.6], mat: 'metal', collide: true },
    // T spawn crate (>0.6 m from nearest spawn, in TSpawn area)
    { kind: 'crate', pos: [-5.5, 4.5, 27.5], size: [1.2, 1.2, 1.2], mat: 'wood', collide: true },
  ],
  spawns: {
    ct: [
      { x:  3.5, z: -35.0, angle: Math.PI },
      { x:  5.5, z: -36.0, angle: Math.PI },
      { x:  7.5, z: -35.0, angle: Math.PI },
      { x:  4.5, z: -34.0, angle: Math.PI },
      { x:  6.5, z: -34.0, angle: Math.PI },
    ],
    t: [
      { x: -22.0, z: 26.0, angle: 0 },
      { x: -18.0, z: 26.0, angle: 0 },
      { x: -14.0, z: 26.0, angle: 0 },
      { x: -10.0, z: 26.0, angle: 0 },
      { x:  -6.0, z: 26.0, angle: 0 },
    ],
  },
  bombsites: [
    { name: 'A', min: { x: 18, z: -46 }, max: { x: 38, z: -27 } },
    { name: 'B', min: { x: -38, z: -46 }, max: { x: -14, z: -36 } },
  ],
  areas: [
    { name: 'TSpawn',         min: { x: -26, z:  20 }, max: { x:  -4, z:  30 } },
    { name: 'TPlat',          min: { x: -26, z:  12 }, max: { x:  -4, z:  24 } },
    { name: 'OutsideLong',    min: { x:  -4, z:  14 }, max: { x:  16, z:  28 } },
    { name: 'LongDoors',      min: { x:   4, z:   2 }, max: { x:  14, z:  16 } },
    { name: 'LongA',          min: { x:  12, z: -14 }, max: { x:  34, z:   4 } },
    { name: 'Pit',            min: { x:  35, z: -19 }, max: { x:  44, z: -10 } },
    { name: 'ARamp',          min: { x:  20, z: -28 }, max: { x:  30, z: -18 } },
    { name: 'ASite',          min: { x:  14, z: -46 }, max: { x:  38, z: -27 } },
    { name: 'GooseA',         min: { x:  34, z: -46 }, max: { x:  40, z: -41 } },
    { name: 'CTRamp',         min: { x:  12, z: -38 }, max: { x:  22, z: -26 } },
    { name: 'AShort',         min: { x:  10, z: -26 }, max: { x:  24, z: -16 } },
    { name: 'Catwalk',        min: { x:  -6, z: -18 }, max: { x:  10, z:   2 } },
    { name: 'TopMid',         min: { x: -10, z: -20 }, max: { x:   2, z:   4 } },
    { name: 'MidDoors',       min: { x: -10, z:  -8 }, max: { x:  -2, z:   4 } },
    { name: 'LowerMid',       min: { x: -10, z:   4 }, max: { x:   8, z:  16 } },
    { name: 'CTMid',          min: { x: -10, z: -34 }, max: { x:   2, z: -20 } },
    { name: 'CTSpawn',        min: { x:   2, z: -44 }, max: { x:  14, z: -30 } },
    { name: 'MidToB',         min: { x: -18, z: -30 }, max: { x:  -8, z: -18 } },
    { name: 'BDoors',         min: { x: -22, z: -42 }, max: { x: -12, z: -33 } },
    { name: 'BSite',          min: { x: -38, z: -46 }, max: { x: -14, z: -36 } },
    { name: 'BPlat',          min: { x: -44, z: -46 }, max: { x: -20, z: -36 } },
    { name: 'UpperTunnels',   min: { x: -40, z:  -2 }, max: { x: -14, z:  14 } },
    { name: 'LowerTunnels',   min: { x: -18, z:   4 }, max: { x:  -6, z:  14 } },
    { name: 'OutsideTunnels', min: { x: -40, z:  14 }, max: { x: -22, z:  26 } },
  ],
};
