/**
 * Terrain chunk mesher. Emits only exposed faces of the column heightfield:
 * one top quad per column plus side quads down to each lower neighbor.
 * Per-voxel hue jitter + directional face shading baked into vertex colors.
 */
import * as THREE from 'three';
import { hashCell } from './noise';
import { CHUNK_SIZE, STONE, STONE_WARM, Terrain, makeScratch } from './terrain';

const S_TOP = 1.0;
const S_X = 0.86;
const S_Z = 0.78;

export function buildTerrainMesh(
  cx: number,
  cz: number,
  terrain: Terrain,
  material: THREE.Material,
): THREE.Mesh {
  const G = CHUNK_SIZE + 2;
  const n = G * G;
  const hA = new Float32Array(n);
  const hcA = new Float32Array(n);
  const topA = new Float32Array(n * 3);
  const dirtA = new Float32Array(n * 3);
  const warmA = new Float32Array(n);

  const sc = makeScratch();
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  for (let lz = -1; lz <= CHUNK_SIZE; lz++) {
    for (let lx = -1; lx <= CHUNK_SIZE; lx++) {
      const i = (lz + 1) * G + (lx + 1);
      terrain.columnInfo(ox + lx, oz + lz, sc);
      hA[i] = sc.h;
      hcA[i] = sc.hc;
      topA[i * 3] = sc.topR;
      topA[i * 3 + 1] = sc.topG;
      topA[i * 3 + 2] = sc.topB;
      dirtA[i * 3] = sc.dirtR;
      dirtA[i * 3 + 1] = sc.dirtG;
      dirtA[i * 3 + 2] = sc.dirtB;
      warmA[i] = sc.stoneWarm;
    }
  }

  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const seed = terrain.seed;
  const gn = terrain.groundN;

  const quad = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    qcx: number, qcy: number, qcz: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
    r: number, g: number, b: number,
  ): void => {
    const base = pos.length / 3;
    pos.push(ax, ay, az, bx, by, bz, qcx, qcy, qcz, dx, dy, dz);
    nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    col.push(r, g, b, r, g, b, r, g, b, r, g, b);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  // strata color for deep cliff cells (horizontal sedimentary bands)
  let str = 0;
  let stg = 0;
  let stb = 0;
  const strata = (y: number, warm: number): void => {
    const band = Math.floor(y / 3);
    const bm = 0.8 + hashCell(seed, band, 977, 0) * 0.32;
    str = (STONE.r + (STONE_WARM.r - STONE.r) * warm) * bm;
    stg = (STONE.g + (STONE_WARM.g - STONE.g) * warm) * bm;
    stb = (STONE.b + (STONE_WARM.b - STONE.b) * warm) * bm;
  };

  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const i = (lz + 1) * G + (lx + 1);
      const i3 = i * 3;
      const H = hA[i];
      const wx = ox + lx;
      const wz = oz + lz;
      const hE = hA[i + 1];
      const hW = hA[i - 1];
      const hS = hA[i + G];
      const hN = hA[i - G];

      // ---- top face -------------------------------------------------------
      const steep = Math.max(
        Math.abs(H - hE), Math.abs(H - hW), Math.abs(H - hS), Math.abs(H - hN),
      );
      // Slope shading: steeper continuous gradient darkens up to 12%.
      const gx = (hcA[i + 1] - hcA[i - 1]) * 0.5;
      const gz = (hcA[i + G] - hcA[i - G]) * 0.5;
      const slope = Math.sqrt(gx * gx + gz * gz);
      const slopeDark = 1 - Math.min(slope * 0.06, 0.12);
      // Contact AO: tops boxed in by higher neighbor columns sit in shadow.
      const occ =
        (hE > H ? 1 : 0) + (hW > H ? 1 : 0) + (hS > H ? 1 : 0) + (hN > H ? 1 : 0);
      const aoTop = occ > 0 ? 1 - Math.min(0.08 + occ * 0.03, 0.14) : 1;
      // Per-voxel value noise. NO integer division anywhere in here: hashing
      // `Math.floor(wx / 3)` IS a grid — it just moves the chequerboard from
      // 1m to 3m, and at ±10% it marched visibly across the plains and lit up
      // on bright sand. Instead two smooth value-noise samples at irrational
      // frequency pairs (0.19/0.23 and 0.061/0.071) that never phase-lock to
      // the cube lattice: a ~5-voxel blotch term plus a ~15-voxel drift, with
      // the per-cube hash (±0.045) on top to keep the chunky per-cube read.
      const jt = hashCell(seed, wx, H, wz);
      const pn = gn.sample(wx * 0.19 + 0.37, wz * 0.23);
      const bn = gn.sample(wx * 0.061, wz * 0.071);
      const mt =
        (1 + pn * 0.11 + bn * 0.07 + (jt - 0.5) * 0.09) * slopeDark * aoTop * S_TOP;
      let r = topA[i3] * mt;
      let g = topA[i3 + 1] * mt;
      let b = topA[i3 + 2] * mt;
      if (steep >= 3) {
        // steep crowns read as bare stone
        const cliffW = Math.min((steep - 2) / 3, 1) * 0.85;
        strata(H, warmA[i]);
        r += (str * mt - r) * cliffW;
        g += (stg * mt - g) * cliffW;
        b += (stb * mt - b) * cliffW;
      }
      quad(
        lx, H, lz, lx, H, lz + 1, lx + 1, H, lz + 1, lx + 1, H, lz,
        0, 1, 0, r, g, b,
      );

      // ---- side faces (down to each lower neighbor) -----------------------
      for (let dir = 0; dir < 4; dir++) {
        const nH = dir === 0 ? hE : dir === 1 ? hW : dir === 2 ? hS : hN;
        for (let y = nH + 1; y <= H; y++) {
          const depth = H - y;
          let br: number;
          let bg: number;
          let bb: number;
          if (depth <= 0) {
            br = topA[i3] * 0.96;
            bg = topA[i3 + 1] * 0.96;
            bb = topA[i3 + 2] * 0.96;
          } else if (depth <= 2) {
            br = dirtA[i3];
            bg = dirtA[i3 + 1];
            bb = dirtA[i3 + 2];
          } else {
            strata(y, warmA[i]);
            br = str;
            bg = stg;
            bb = stb;
          }
          const j = hashCell(seed, wx, y, wz);
          // Contact AO: side faces darken toward the base of the wall (the
          // seam with the neighbor's floor), grounding cliffs and steps.
          const contact = 1 - Math.min((y - nH - 1) * 0.45, 1);
          const aoSide = 1 - contact * 0.17;
          const shade = (dir < 2 ? S_X : S_Z) * (0.9 + j * 0.18) * aoSide;
          br *= shade;
          bg *= shade;
          bb *= shade;
          const y0 = y - 1;
          if (dir === 0) {
            quad(
              lx + 1, y0, lz, lx + 1, y, lz, lx + 1, y, lz + 1, lx + 1, y0, lz + 1,
              1, 0, 0, br, bg, bb,
            );
          } else if (dir === 1) {
            quad(
              lx, y0, lz + 1, lx, y, lz + 1, lx, y, lz, lx, y0, lz,
              -1, 0, 0, br, bg, bb,
            );
          } else if (dir === 2) {
            quad(
              lx, y0, lz + 1, lx + 1, y0, lz + 1, lx + 1, y, lz + 1, lx, y, lz + 1,
              0, 0, 1, br, bg, bb,
            );
          } else {
            quad(
              lx + 1, y0, lz, lx, y0, lz, lx, y, lz, lx + 1, y, lz,
              0, 0, -1, br, bg, bb,
            );
          }
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(ox, 0, oz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
