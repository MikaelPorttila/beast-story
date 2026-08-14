/**
 * Terrain chunk mesher. Emits only exposed faces of the column heightfield, with
 * hue jitter, face shading and per-VERTEX corner AO baked into vertex colours.
 */
import * as THREE from "three";
import { hashCell } from "./noise";
import type { Terrain } from "./terrain";
import { CHUNK_SIZE, STONE, STONE_WARM, WATER_LEVEL, makeScratch } from "./terrain";

const S_TOP = 1.0;

// Side albedo by `dir`. Direction-neutral since issue #87: opposing faces must
// start equal or a midnight moon reveals a baked noon in the terrain colours.
const SIDE_SHADE = [0.78, 0.78, 0.78, 0.78];

/** Warm bounce per side dir, 0..1: a hueless shaded face reads as a hole. */
const SIDE_BOUNCE = [0.45, 0.45, 0.45, 0.45];

/**
 * Corner-AO per occlusion level (3 = open, 0 = boxed in). Steep, because the
 * crevice darkening IS the texture. Floor 0.42 — 0.30 bottomed out to black.
 */
const AO = [0.42, 0.6, 0.8, 1.0];

/** Classic voxel corner AO: two edge neighbours plus the diagonal. */
const aoLevel = (s1: boolean, s2: boolean, c: boolean): number =>
  s1 && s2 ? 0 : 3 - ((s1 ? 1 : 0) + (s2 ? 1 : 0) + (c ? 1 : 0));

/**
 * Submersion at world-y `y`, 0..1. Flattens face shading and AO toward neutral:
 * full terrace darkening showed through the water as hard blue bricks.
 */
const submerged = (y: number): number => {
  // 0.28 is SURFACE_Y's float above WATER_LEVEL (water.ts). Ramp is SHORT —
  // flat by 30cm — or the shallowest flooded terrace stays half-dark.
  const d = WATER_LEVEL + 0.28 - y;
  return d <= 0 ? 0 : d >= 0.3 ? 1 : d / 0.3;
};
/** Lerp a shading multiplier toward neutral by `t`. */
const flatten = (m: number, t: number): number => m + (1 - m) * t;

/**
 * Working buffers for one chunk's mesh, POOLED. Writing straight into typed
 * arrays skips the boxed `number[]` and its conversion pass — 1.71 ms to 1.56 ms
 * per chunk on V8, 1.43 ms to 1.28 ms on JSC — but the buffers outlive nothing,
 * so they are borrowed and handed back rather than allocated per chunk.
 *
 * The scratch is f32 even for the two attributes that ship as fp16, and that is
 * deliberate: JSC (Safari, and Bun) stores to a Float16Array element by element
 * ~16x slower than to a Float32Array — measured 1.48 ms against 24.1 ms over 3M
 * writes — while its BULK `new Float16Array(f32)` is as fast as the conversion
 * this replaced. Narrowing once at the end is therefore the only shape that is
 * faster on V8 without being much slower on JSC.
 */
interface MeshScratch {
  pos: Float32Array;
  nrm: Float32Array;
  col: Float32Array;
  idx: Uint32Array;
}

/**
 * Borrowed for the length of one build. A generator the streamer ABANDONS
 * mid-chunk never reaches its `finally`, so its scratch is simply collected with
 * it and the next build allocates — a pool that cannot corrupt two live builds
 * is worth more than one that never allocates.
 */
const SCRATCH_POOL: MeshScratch[] = [];

/** One chunk's ground, comfortably: ~5–15k vertices measured across seeds. */
const SCRATCH_VERTS = 8192;

const takeMeshScratch = (): MeshScratch =>
  SCRATCH_POOL.pop() ?? {
    pos: new Float32Array(SCRATCH_VERTS * 3),
    nrm: new Float32Array(SCRATCH_VERTS * 3),
    col: new Float32Array(SCRATCH_VERTS * 3),
    idx: new Uint32Array(SCRATCH_VERTS * 3),
  };

/** Double until both wants fit, preserving what is already written. */
const growMeshScratch = (sc: MeshScratch, comps: number, inds: number): void => {
  let n = sc.pos.length;
  while (n < comps) {
    n *= 2;
  }
  if (n > sc.pos.length) {
    const pos = new Float32Array(n);
    pos.set(sc.pos);
    sc.pos = pos;
    const nrm = new Float32Array(n);
    nrm.set(sc.nrm);
    sc.nrm = nrm;
    const col = new Float32Array(n);
    col.set(sc.col);
    sc.col = col;
  }
  let m = sc.idx.length;
  while (m < inds) {
    m *= 2;
  }
  if (m > sc.idx.length) {
    const idx = new Uint32Array(m);
    idx.set(sc.idx);
    sc.idx = idx;
  }
};

/** One step samples or emits one 32-column row, for the streamer's budget. */
export function* buildTerrainMeshSteps(
  cx: number,
  cz: number,
  terrain: Terrain,
  material: THREE.Material,
): Generator<void, THREE.Mesh, void> {
  const G = CHUNK_SIZE + 2;
  const n = G * G;
  const hA = new Float32Array(n);
  const hcA = new Float32Array(n);
  const topA = new Float32Array(n * 3);
  const dirtA = new Float32Array(n * 3);
  const warmA = new Float32Array(n);
  const grassA = new Float32Array(n);

  const sc = makeScratch();
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  for (let lz = -1; lz <= CHUNK_SIZE; lz++) {
    for (let lx = -1; lx <= CHUNK_SIZE; lx++) {
      const i = (lz + 1) * G + (lx + 1);
      terrain.columnInfo(ox + lx, oz + lz, sc);
      // The DRAWN top: fractional under a road, where it hugs the ribbon.
      hA[i] = sc.hDraw;
      hcA[i] = sc.hc;
      topA[i * 3] = sc.topR;
      topA[i * 3 + 1] = sc.topG;
      topA[i * 3 + 2] = sc.topB;
      dirtA[i * 3] = sc.dirtR;
      dirtA[i * 3 + 1] = sc.dirtG;
      dirtA[i * 3 + 2] = sc.dirtB;
      warmA[i] = sc.stoneWarm;
      grassA[i] = sc.grass;
    }
    yield;
  }

  const ms = takeMeshScratch();
  let pos = ms.pos;
  let nrm = ms.nrm;
  let col = ms.col;
  let idx = ms.idx;
  /** Floats written to pos/nrm/col; `vert` is that over three. */
  let comp = 0;
  let vert = 0;
  let ind = 0;
  const seed = terrain.seed;
  const gw2 = terrain.groundW;

  /**
   * Per-cube tonal jitter in [-1, 1], TRIANGULAR (two hashes averaged): one
   * uniform hash puts as many cubes at the extremes as the mean, reading as tile.
   */
  const jitter = (x: number, y: number, z: number): number =>
    hashCell(seed, x, y, z) + hashCell(seed, x + 8191, y, z + 5077) - 1;

  /**
   * Emit one quad with per-vertex AO; `a0..a3` follow the push order. Corners
   * that disagree get a centre vertex and a fan — two triangles cannot carry a
   * bilinear gradient and the diagonal shows as a crease.
   */
  const quad = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    qcx: number,
    qcy: number,
    qcz: number,
    dx: number,
    dy: number,
    dz: number,
    nx: number,
    ny: number,
    nz: number,
    r: number,
    g: number,
    b: number,
    a0: number,
    a1: number,
    a2: number,
    a3: number,
  ): void => {
    // ONE capacity test per quad rather than one per component: a quad writes at
    // most five vertices and twelve indices, so this is the whole bounds check.
    if (comp + 15 > pos.length || ind + 12 > idx.length) {
      growMeshScratch(ms, comp + 15, ind + 12);
      pos = ms.pos;
      nrm = ms.nrm;
      col = ms.col;
      idx = ms.idx;
    }
    const base = vert;
    let p = comp;
    pos[p] = ax;
    pos[p + 1] = ay;
    pos[p + 2] = az;
    pos[p + 3] = bx;
    pos[p + 4] = by;
    pos[p + 5] = bz;
    pos[p + 6] = qcx;
    pos[p + 7] = qcy;
    pos[p + 8] = qcz;
    pos[p + 9] = dx;
    pos[p + 10] = dy;
    pos[p + 11] = dz;
    for (let k = 0; k < 12; k += 3) {
      nrm[p + k] = nx;
      nrm[p + k + 1] = ny;
      nrm[p + k + 2] = nz;
    }
    col[p] = r * a0;
    col[p + 1] = g * a0;
    col[p + 2] = b * a0;
    col[p + 3] = r * a1;
    col[p + 4] = g * a1;
    col[p + 5] = b * a1;
    col[p + 6] = r * a2;
    col[p + 7] = g * a2;
    col[p + 8] = b * a2;
    col[p + 9] = r * a3;
    col[p + 10] = g * a3;
    col[p + 11] = b * a3;
    comp = p + 12;
    vert = base + 4;
    if (a0 === a1 && a1 === a2 && a2 === a3) {
      idx[ind] = base;
      idx[ind + 1] = base + 1;
      idx[ind + 2] = base + 2;
      idx[ind + 3] = base;
      idx[ind + 4] = base + 2;
      idx[ind + 5] = base + 3;
      ind += 6;
      return;
    }
    const am = (a0 + a1 + a2 + a3) * 0.25;
    p = comp;
    pos[p] = (ax + qcx) * 0.5;
    pos[p + 1] = (ay + qcy) * 0.5;
    pos[p + 2] = (az + qcz) * 0.5;
    nrm[p] = nx;
    nrm[p + 1] = ny;
    nrm[p + 2] = nz;
    col[p] = r * am;
    col[p + 1] = g * am;
    col[p + 2] = b * am;
    comp = p + 3;
    const m = vert;
    vert = m + 1;
    idx[ind] = base;
    idx[ind + 1] = base + 1;
    idx[ind + 2] = m;
    idx[ind + 3] = base + 1;
    idx[ind + 4] = base + 2;
    idx[ind + 5] = m;
    idx[ind + 6] = base + 2;
    idx[ind + 7] = base + 3;
    idx[ind + 8] = m;
    idx[ind + 9] = base + 3;
    idx[ind + 10] = base;
    idx[ind + 11] = m;
    ind += 12;
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

      const steep = Math.max(
        Math.abs(H - hE),
        Math.abs(H - hW),
        Math.abs(H - hS),
        Math.abs(H - hN),
      );
      // Hash inputs stay integers: a road-capped top is fractional now.
      const Hi = Math.floor(H);
      const gx = (hcA[i + 1] - hcA[i - 1]) * 0.5;
      const gz = (hcA[i + G] - hcA[i - G]) * 0.5;
      const slope = Math.sqrt(gx * gx + gz * gz);
      const slopeDark = 1 - Math.min(slope * 0.06, 0.12);
      const jt = jitter(wx, Hi, wz);
      const gw = grassA[i];
      // Warmth carries the per-cube read; pure value resolves as a grid.
      const hw = jitter(wx, Hi + 31, wz) * (0.075 + gw * 0.045);
      // ~22-unit wash. WaveField has no lattice, so it cannot form a chequer.
      const drift = gw2.sample(wx, wz) * 0.07;
      // Per-cube VALUE share stays small; higher was a visible chequerboard.
      const mt = (1 + drift + jt * (0.026 + gw * 0.032)) * slopeDark * S_TOP;

      // Free curvature signal: the discrete Laplacian of the CONTINUOUS height
      // (the border ring is already meshed). Positive = hollow, negative = ridge.
      const lap = (hcA[i + 1] + hcA[i - 1] + hcA[i + G] + hcA[i - G]) * 0.25 - hcA[i];
      const hollow = Math.min(Math.max(lap * 2.4, 0), 1) * gw;
      const crown = Math.min(Math.max(-lap * 2.4, 0), 1) * gw;

      let r = topA[i3];
      let g = topA[i3 + 1];
      let b = topA[i3 + 2];
      // Hollows: -14% value and pushed toward blue-green (deep moss).
      // Crowns: +9% value and pushed toward yellow (bleached, dusty).
      const hm = 1 - hollow * 0.14;
      r *= hm * (1 - hollow * 0.1);
      g *= hm;
      b *= hm * (1 + hollow * 0.16);
      const cm = 1 + crown * 0.09;
      r *= cm * (1 + crown * 0.13);
      g *= cm;
      b *= cm * (1 - crown * 0.14);

      // Dirt on tipping ground. Gated on `slope` (scale-free), not `steep`,
      // which is 1 on every grass terrace and would smear dirt over the map.
      const dirtW = Math.min(Math.max((slope - 1.05) / 2.1, 0), 1) * 0.5 * gw;
      if (dirtW > 0) {
        r += (dirtA[i3] - r) * dirtW;
        g += (dirtA[i3 + 1] - g) * dirtW;
        b += (dirtA[i3 + 2] - b) * dirtW;
      }

      // Ground litter: a rare per-cube hash pick, so it scatters with no grid.
      const sp = hashCell(seed, wx, Hi + 7, wz);
      if (gw > 0.35) {
        if (sp > 0.94) {
          r *= 0.72;
          g *= 0.88;
          b *= 0.82; // clover: deeper, bluer green
        } else if (sp > 0.895) {
          r *= 1.18;
          g *= 1.05;
          b *= 0.84; // dry straw tuft
        } else if (sp > 0.855) {
          r *= 0.8;
          g *= 1.06;
          b *= 0.72; // deep lush blade clump
        } else if (sp < 0.02) {
          // MOSSY, not pale: mid grey on grass read as a missing texture.
          const pw = 0.55;
          r += (0.105 - r) * pw;
          g += (0.115 - g) * pw;
          b += (0.09 - b) * pw;
        }
      } else {
        // Sand/snow/bed. Bright sand sits high on the tone curve where the
        // multiplicative jitter fades, so grains carry the texture instead.
        if (sp > 0.945) {
          r *= 1.09;
          g *= 1.07;
          b *= 1.02; // sun-bleached grain
        } else if (sp < 0.11) {
          r *= 0.87;
          g *= 0.9;
          b *= 0.96; // damp / shaded grain, cooler
        } else if (sp > 0.905 && sp < 0.938) {
          const pw = 0.5; // shell grit / a dark pebble
          r += (0.2 - r) * pw;
          g += (0.19 - g) * pw;
          b += (0.17 - b) * pw;
        }
      }

      r *= mt * (1 + hw);
      g *= mt;
      b *= mt * (1 - hw);
      // Saturation link, grass only: bright=bleached reads as clumps, not tiles.
      if (gw > 0) {
        // ASYMMETRIC: pushing chroma OUT past ~0.20 drove grass red to zero
        // (clamped below), leaving a surface that cannot take the warm sun key.
        const sat = jt >= 0 ? 1 - jt * 0.28 * gw : 1 - jt * 0.2 * gw;
        const lum = (r + g + b) * 0.3333;
        r = lum + (r - lum) * sat;
        g = lum + (g - lum) * sat;
        b = lum + (b - lum) * sat;
        if (r < 0) {
          r = 0;
        }
        if (g < 0) {
          g = 0;
        }
        if (b < 0) {
          b = 0;
        }
      }
      if (steep >= 3) {
        // steep crowns read as bare stone
        const cliffW = Math.min((steep - 2) / 3, 1) * 0.85;
        strata(H, warmA[i]);
        r += (str * mt - r) * cliffW;
        g += (stg * mt - g) * cliffW;
        b += (stb * mt - b) * cliffW;
      }

      // Top-face corner AO: each of the eight neighbours occludes when above H.
      // HALF A UNIT above, not merely above: two road-capped columns differ by
      // centimetres, and an exact compare veined the corridor with AO seams.
      const oE = hE > H + 0.5,
        oW = hW > H + 0.5,
        oS = hS > H + 0.5,
        oN = hN > H + 0.5;
      const oSE = hA[i + 1 + G] > H + 0.5,
        oSW = hA[i - 1 + G] > H + 0.5;
      const oNE = hA[i + 1 - G] > H + 0.5,
        oNW = hA[i - 1 - G] > H + 0.5;
      const subT = submerged(H) * 0.94;
      quad(
        lx,
        H,
        lz,
        lx,
        H,
        lz + 1,
        lx + 1,
        H,
        lz + 1,
        lx + 1,
        H,
        lz,
        0,
        1,
        0,
        r,
        g,
        b,
        flatten(AO[aoLevel(oW, oN, oNW)], subT),
        flatten(AO[aoLevel(oW, oS, oSW)], subT),
        flatten(AO[aoLevel(oE, oS, oSE)], subT),
        flatten(AO[aoLevel(oE, oN, oNE)], subT),
      );

      for (let dir = 0; dir < 4; dir++) {
        const nH = dir === 0 ? hE : dir === 1 ? hW : dir === 2 ? hS : hN;
        // Flanking column heights in the face's tangential order, matching the
        // vertex order v0=lowA, v1=highA, v2=highB, v3=lowB used below.
        let hTA: number;
        let hTB: number;
        if (dir === 0) {
          hTA = hA[i + 1 - G];
          hTB = hA[i + 1 + G];
        } else if (dir === 1) {
          hTA = hA[i - 1 + G];
          hTB = hA[i - 1 - G];
        } else if (dir === 2) {
          hTA = hA[i + G + 1];
          hTB = hA[i + G - 1];
        } else {
          hTA = hA[i - G - 1];
          hTB = hA[i - G + 1];
        }

        // Walk the span (nH, H] along integer boundaries with partial first and
        // last quads: a road-capped top is fractional, and whole-unit quads
        // either tore a slit under it or overshot through the ribbon.
        let yb = nH;
        while (yb < H - 1e-3) {
          const y = Math.min(H, Math.floor(yb + 1e-3) + 1);
          const yi = Math.ceil(y - 1e-3);
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
            strata(yi, warmA[i]);
            br = str;
            bg = stg;
            bb = stb;
          }
          // Same treatment as the tops, so a cliff reads as stacked rock.
          const j = jitter(wx, yi, wz);
          const jw = jitter(wx, yi + 31, wz) * 0.05 + SIDE_BOUNCE[dir] * 0.055;
          const sub = submerged((yb + y) * 0.5);
          const shade = flatten(SIDE_SHADE[dir] * (1 + j * 0.09), sub * 0.9);
          br *= shade * (1 + jw);
          bg *= shade;
          bb *= shade * (1 - jw);
          const subA = sub * 0.88;
          // In-plane corner AO. The lower corners' vertical neighbour is the
          // neighbour column, so contact darkening falls out for free.
          const upA = flatten(AO[aoLevel(hTA >= y, false, hTA >= y + 1)], subA);
          const upB = flatten(AO[aoLevel(hTB >= y, false, hTB >= y + 1)], subA);
          const loA = flatten(AO[aoLevel(hTA >= y, nH >= yb, hTA >= yb)], subA);
          const loB = flatten(AO[aoLevel(hTB >= y, nH >= yb, hTB >= yb)], subA);
          const y0 = yb;
          // Submerged walls rotate their SHADING NORMAL up, so a terraced bed
          // takes the same N.L light as its tops and prints no contour stripes.
          const nb = 1 - sub;
          const ny = sub;
          // Normalise, or a half-submerged wall is lit with a 1.4-long normal.
          const nl = 1 / Math.sqrt(nb * nb + ny * ny);
          const nh = nb * nl;
          const nv = ny * nl;
          if (dir === 0) {
            quad(
              lx + 1,
              y0,
              lz,
              lx + 1,
              y,
              lz,
              lx + 1,
              y,
              lz + 1,
              lx + 1,
              y0,
              lz + 1,
              nh,
              nv,
              0,
              br,
              bg,
              bb,
              loA,
              upA,
              upB,
              loB,
            );
          } else if (dir === 1) {
            quad(
              lx,
              y0,
              lz + 1,
              lx,
              y,
              lz + 1,
              lx,
              y,
              lz,
              lx,
              y0,
              lz,
              -nh,
              nv,
              0,
              br,
              bg,
              bb,
              loA,
              upA,
              upB,
              loB,
            );
          } else if (dir === 2) {
            quad(
              lx + 1,
              y0,
              lz + 1,
              lx + 1,
              y,
              lz + 1,
              lx,
              y,
              lz + 1,
              lx,
              y0,
              lz + 1,
              0,
              nv,
              nh,
              br,
              bg,
              bb,
              loA,
              upA,
              upB,
              loB,
            );
          } else {
            quad(
              lx,
              y0,
              lz,
              lx,
              y,
              lz,
              lx + 1,
              y,
              lz,
              lx + 1,
              y0,
              lz,
              0,
              nv,
              -nh,
              br,
              bg,
              bb,
              loA,
              upA,
              upB,
              loB,
            );
          }
          yb = y;
        }
      }
    }
    yield;
  }

  // Exact copies out of the scratch: what the geometry keeps is the size the
  // chunk actually needed, and the borrowed buffers go back to the pool.
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos.slice(0, comp), 3));
  // Half precision: cube normals are exactly 0/±1 and colours stay low enough that
  // the fp16 gap is 4x finer than a display step — both asserted by test-f16. The cast
  // is @types/three's TypedArray union predating Float16Array; three uploads HALF_FLOAT.
  geo.setAttribute(
    "normal",
    new THREE.BufferAttribute(
      new Float16Array(nrm.subarray(0, comp)) as unknown as THREE.TypedArray,
      3,
    ),
  );
  geo.setAttribute(
    "color",
    new THREE.BufferAttribute(
      new Float16Array(col.subarray(0, comp)) as unknown as THREE.TypedArray,
      3,
    ),
  );
  // Narrowed the way `setIndex` narrows a plain array, so a chunk's indices stay
  // two bytes: they are only ever wide enough to need four past 65535 vertices.
  geo.setIndex(
    new THREE.BufferAttribute(
      vert > 65535 ? idx.slice(0, ind) : new Uint16Array(idx.subarray(0, ind)),
      1,
    ),
  );
  SCRATCH_POOL.push(ms);
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, material);
  // Named for `__dbgSurfaceY` in main.ts, which reports what it raycast.
  mesh.name = `terrain:${ox},${oz}`;
  mesh.position.set(ox, 0, oz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

/** Synchronous boot/test convenience; live streaming uses the steps above. */
export function buildTerrainMesh(
  cx: number,
  cz: number,
  terrain: Terrain,
  material: THREE.Material,
): THREE.Mesh {
  const steps = buildTerrainMeshSteps(cx, cz, terrain, material);
  let result = steps.next();
  while (!result.done) {
    result = steps.next();
  }
  return result.value;
}
