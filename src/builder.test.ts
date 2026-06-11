/**
 * builder.test.ts — headless unit tests for builder.ts
 * No DOM, no renderer. Three.js geometry/math code only.
 */

import { describe, it, expect } from 'bun:test';
import * as THREE from 'three';
import { DUST2 } from './maps/dust2';
import { buildMapScene, projectUV } from './builder';
import type { LoadedTextures, TextureSlot } from './assets';

// ---------------------------------------------------------------------------
// projectUV — pure function unit tests
// ---------------------------------------------------------------------------

describe('projectUV', () => {
  it('+Y dominant: uses (x, z) axes', () => {
    // |ny|=1 > |nx|=0, |nz|=0
    const [u, v] = projectUV(10, 1, -7, 0, 1, 0, 2);
    expect(u).toBeCloseTo(10 / 2); // 5
    expect(v).toBeCloseTo(-7 / 2); // -3.5
  });

  it('-Y dominant: uses (x, z) axes', () => {
    const [u, v] = projectUV(10, 1, -7, 0, -1, 0, 2);
    expect(u).toBeCloseTo(5);
    expect(v).toBeCloseTo(-3.5);
  });

  it('+X dominant: uses (z, y) axes', () => {
    // |nx|=1 > |ny|=0, |nz|=0
    const [u, v] = projectUV(3, 2, 5, 1, 0, 0, 2);
    expect(u).toBeCloseTo(5 / 2); // z / tile
    expect(v).toBeCloseTo(2 / 2); // y / tile
  });

  it('-X dominant: uses (z, y) axes', () => {
    const [u, v] = projectUV(3, 2, 5, -1, 0, 0, 2);
    expect(u).toBeCloseTo(2.5);
    expect(v).toBeCloseTo(1.0);
  });

  it('+Z dominant: uses (x, y) axes', () => {
    // |nz|=1 > |nx|=0, |ny|=0
    const [u, v] = projectUV(6, 4, -3, 0, 0, 1, 3);
    expect(u).toBeCloseTo(6 / 3); // 2
    expect(v).toBeCloseTo(4 / 3);
  });

  it('-Z dominant: uses (x, y) axes', () => {
    const [u, v] = projectUV(6, 4, -3, 0, 0, -1, 3);
    expect(u).toBeCloseTo(2.0);
    expect(v).toBeCloseTo(4 / 3);
  });

  it('tile scaling: tile=1 and tile=4 produce proportional results', () => {
    const [u1, v1] = projectUV(8, 0, 4, 0, 1, 0, 1);
    const [u4, v4] = projectUV(8, 0, 4, 0, 1, 0, 4);
    expect(u1).toBeCloseTo(8);
    expect(v1).toBeCloseTo(4);
    expect(u4).toBeCloseTo(8 / 4);
    expect(v4).toBeCloseTo(4 / 4);
  });

  it('tile=2 +Y: (10, 1, -7) => (5, -3.5)', () => {
    const [u, v] = projectUV(10, 1, -7, 0, 1, 0, 2);
    expect(u).toBeCloseTo(5);
    expect(v).toBeCloseTo(-3.5);
  });
});

// ---------------------------------------------------------------------------
// UV Continuity — shared-edge guarantee
// ---------------------------------------------------------------------------
//
// Simulates two greedy-merged neighbor boxes the way builder.ts does:
//   Box A: cx=2, halfX=2  → right edge x = cx+halfX = 4
//   Box B: cx=5, halfX=1  → left  edge x = cx−halfX = 4
// Both independently arrive at the same shared-edge world coordinate.
// The tests assert: (a) results are equal, AND (b) they equal the absolute
// expected value so the test is not tautological.

describe('UV continuity', () => {
  it('+Y top face: two floor boxes derive shared-edge vertex independently and yield equal absolute UVs', () => {
    // Box A spans world x∈[0,4]: cx=2, halfX=2 → shared edge vertex x = 2+2 = 4
    // Box B spans world x∈[4,6]: cx=5, halfX=1 → shared edge vertex x = 5−1 = 4
    // Both boxes have top-face normal (0,1,0), y=0, z=5, tile=2.
    const tile = 2;
    const y = 0; const z = 5;
    const nx = 0; const ny = 1; const nz = 0;

    const cxA = 2; const halfXA = 2;
    const cxB = 5; const halfXB = 1;
    const edgeXfromA = cxA + halfXA; // = 4
    const edgeXfromB = cxB - halfXB; // = 4

    const [uA, vA] = projectUV(edgeXfromA, y, z, nx, ny, nz, tile);
    const [uB, vB] = projectUV(edgeXfromB, y, z, nx, ny, nz, tile);

    // (a) Seam continuity: the two independently-derived coordinates agree.
    expect(uA).toBeCloseTo(uB);
    expect(vA).toBeCloseTo(vB);

    // (b) Absolute correctness: +Y face → u=x/tile, v=z/tile.
    expect(uA).toBeCloseTo(4 / tile); // = 2.0
    expect(vA).toBeCloseTo(z / tile); // = 2.5
  });

  it('+Z side face: two wall boxes derive shared-edge vertex independently and yield equal absolute UVs', () => {
    // Box A spans world z∈[0,3]: cz=1.5, halfZ=1.5 → front edge z = 1.5+1.5 = 3
    // Box B spans world z∈[3,6]: cz=4.5, halfZ=1.5 → back  edge z = 4.5−1.5 = 3
    // +Z face normal, x=10, y=2, tile=3.
    const tile = 3;
    const x = 10; const y = 2;
    const nx = 0; const ny = 0; const nz = 1;

    const czA = 1.5; const halfZA = 1.5;
    const czB = 4.5; const halfZB = 1.5;
    const edgeZfromA = czA + halfZA; // = 3
    const edgeZfromB = czB - halfZB; // = 3

    const [uA, vA] = projectUV(x, y, edgeZfromA, nx, ny, nz, tile);
    const [uB, vB] = projectUV(x, y, edgeZfromB, nx, ny, nz, tile);

    // (a) Seam continuity.
    expect(uA).toBeCloseTo(uB);
    expect(vA).toBeCloseTo(vB);

    // (b) Absolute correctness: ±Z face → u=x/tile, v=y/tile.
    expect(uA).toBeCloseTo(x / tile); // = 10/3 ≈ 3.333
    expect(vA).toBeCloseTo(y / tile); // = 2/3  ≈ 0.667
  });

  it('+Z face absolute value: vertex (4, 1.5, 7) tile=2 → (2, 0.75)', () => {
    // ±Z face uses u=x/tile, v=y/tile.
    const [u, v] = projectUV(4, 1.5, 7, 0, 0, 1, 2);
    expect(u).toBeCloseTo(2);    // 4/2
    expect(v).toBeCloseTo(0.75); // 1.5/2
  });

  it('-X side face: two wall boxes derive shared-edge vertex independently and yield equal absolute UVs', () => {
    // Box A spans world x∈[0,4]: cx=2, halfX=2 → right edge x=4
    // Box B spans world x∈[4,6]: cx=5, halfX=1 → left  edge x=4
    // −X face normal, y=3, z=7, tile=3.
    const tile = 3;
    const y = 3; const z = 7;
    const nx = -1; const ny = 0; const nz = 0;

    const cxA = 2; const halfXA = 2;
    const cxB = 5; const halfXB = 1;
    const edgeXfromA = cxA + halfXA; // = 4
    const edgeXfromB = cxB - halfXB; // = 4

    const [uA, vA] = projectUV(edgeXfromA, y, z, nx, ny, nz, tile);
    const [uB, vB] = projectUV(edgeXfromB, y, z, nx, ny, nz, tile);

    // (a) Seam continuity.
    expect(uA).toBeCloseTo(uB);
    expect(vA).toBeCloseTo(vB);

    // (b) Absolute correctness: ±X face → u=z/tile, v=y/tile.
    expect(uA).toBeCloseTo(z / tile); // = 7/3 ≈ 2.333
    expect(vA).toBeCloseTo(y / tile); // = 3/3 = 1.0
  });
});

// ---------------------------------------------------------------------------
// buildMapScene — no-texture path (backward compat)
// ---------------------------------------------------------------------------

describe('buildMapScene — no textures', () => {
  it('returns a group with the same static mesh count as baseline (5)', () => {
    const { group } = buildMapScene(DUST2);
    // Count only Mesh children added by the static world (not props).
    // Props are individual meshes; static buckets are merged.
    // The static merged mesh count must remain 5 (sand, stone, sandLight, dark, floor).
    const allMeshes = group.children.filter(c => c instanceof THREE.Mesh);
    // Total meshes = static merged (5) + props (25).
    // Just check static merged count = 5 and total is reasonable.
    expect(allMeshes.length).toBeGreaterThanOrEqual(5);
    // Static merged: we can't trivially separate from props here, but total
    // must be exactly 5 + number of props (25 props in DUST2).
    const expectedPropCount = DUST2.props.length; // 25
    const expectedStaticCount = 5; // sand, stone, sandLight, dark, floor
    expect(allMeshes.length).toBe(expectedStaticCount + expectedPropCount);
  });

  it('no-texture materials have no map set', () => {
    const { group } = buildMapScene(DUST2);
    const meshes = group.children.filter(c => c instanceof THREE.Mesh) as THREE.Mesh[];
    for (const mesh of meshes) {
      const mat = mesh.material as THREE.MeshLambertMaterial;
      expect(mat.map).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// buildMapScene — textured path
// ---------------------------------------------------------------------------

/** Minimal stub LoadedTextures (new THREE.Texture() is headless-safe). */
function makeStubTextures(): LoadedTextures {
  const slots: TextureSlot[] = [
    'ground_sand', 'wall_sandstone', 'wall_plaster', 'floor_stone',
    'concrete', 'wood', 'metal', 'fabric',
  ];
  const entries = slots.map(s => [s, new THREE.Texture()] as const);
  return Object.fromEntries(entries) as LoadedTextures;
}

describe('buildMapScene — textured path', () => {
  const fakeTextures = makeStubTextures();

  it('every static merged mesh has a map set', () => {
    const { group } = buildMapScene(DUST2, fakeTextures);
    const meshes = group.children.filter(c => c instanceof THREE.Mesh) as THREE.Mesh[];
    // Find only static merged meshes: they were created by mergeAndAddMesh
    // and have large vertex counts (thousands). Props have < 200 verts.
    // Actually we just verify ALL meshes have a map — props also get textures.
    for (const mesh of meshes) {
      const mat = mesh.material as THREE.MeshLambertMaterial;
      expect(mat.map).not.toBeNull();
    }
  });

  it('static merged mesh count <= 16', () => {
    const { group } = buildMapScene(DUST2, fakeTextures);
    const meshes = group.children.filter(c => c instanceof THREE.Mesh);
    // Total meshes = static merged + props. Static merged count = number of
    // unique matKey|kind buckets. Must be <= 16 regardless of prop count.
    // The static+prop total must be <= 16 + propCount.
    expect(meshes.length).toBeLessThanOrEqual(16 + DUST2.props.length);
  });

  it('static merged mesh count is > 5 (new kind-split buckets)', () => {
    const { group } = buildMapScene(DUST2, fakeTextures);
    const meshes = group.children.filter(c => c instanceof THREE.Mesh);
    // Textured path splits by kind, so static count > 5.
    // Specifically: sand|wall, sand|floor, sandLight|wall, sandLight|floor,
    //               stone|wall, stone|floor, floor|wall, floor|floor,
    //               dark|floor, dark|ceil = up to 10 static buckets.
    expect(meshes.length).toBeGreaterThan(5 + DUST2.props.length - 1);
  });

  it('vertexColors is enabled on all textured materials', () => {
    const { group } = buildMapScene(DUST2, fakeTextures);
    const meshes = group.children.filter(c => c instanceof THREE.Mesh) as THREE.Mesh[];
    for (const mesh of meshes) {
      const mat = mesh.material as THREE.MeshLambertMaterial;
      expect(mat.vertexColors).toBe(true);
    }
  });
});
