/**
 * THE SEAM — Act 4's finale arena, and the game's fourth ZONE (game-story.md §4).
 *
 * "Not a fourth region so much as the other three seen from inside the stitch":
 * one great brass-edged DISC floating in a void, cut into three 120° sectors —
 * a meadow (Act 1), a flooded tide bowl (Act 2), a raised cloud deck under an
 * open brass frame (Act 3) — with THE ENGINE at the centre and the red thread
 * running from it in grooves to an anchor pylon at the edge of each sector.
 *
 * Structurally it is the Sunken Hold's shape (world/dungeon.ts) again: a
 * bounded 160x160 heightfield that is a pure function of (x, z), streamed in
 * 32-unit chunks against the overworld's build budget and load/unload radii, at
 * a coordinate offset no other zone uses so it can be resident beside the
 * overworld while the gateway preloads it. What the hold does not have and this
 * does: half-unit terraces (the meadow rolls, the ramp and stair walk), a water
 * surface over the bowl, a structure field of colliders measured off the models
 * that stand here, and a sky of its own.
 */
import * as THREE from "three";
import {
  NO_CARRIERS,
  excludeFromAO,
  type CelestialState,
  type World,
} from "../core/types";
import { VoxelModel } from "../core/voxel";
import { CHUNK_SIZE, WATER_LEVEL } from "./terrain";
import { NO_SAFE_ZONES } from "./safe-zones";
import { Noise2D, hashCell, mulberry32 } from "./noise";
import { perf } from "../core/profiler";
import { Accum, bakeProp, grassTuft, oakTree, rock, swardTint, type Template } from "./props";
import { SolidStamp, StructureField, bakeSolid } from "./structures";
import { buildFence, type Fence, type FenceParts } from "./fences";
import { GLOW_PART, V, fenceKit } from "./town-parts";
import { skyPylon } from "./sky-parts";
import { SURFACE_Y, createWaterMaterial } from "./water";

/**
 * Where it lives. The corner none of the other worlds use: the hold is at
 * (+8192, +8192), the vent at (-8192, +8192), the overworld around the origin.
 * See DungeonSpec.originX for why 8192 is safe for float32 positions.
 */
export const SEAM_ORIGIN_X = 8192;
export const SEAM_ORIGIN_Z = -8192;

/** Footprint in columns, 5 chunks; the disc sits in the middle of it. */
const GRID = 160;
const C = 80;
/** The disc. 72 leaves 8 columns of void on every side of the footprint. */
const DISC_R = 72;
/** The walkway ring: from here out every sector is level, so the balustrade stands on one line. */
const RIM_R = 64;
/** Brass edging of the walkway; the balustrade stands just inside the drop. */
const BRASS_R = 70;
const BALUSTRADE_R = 70.6;
const FLOOR_Y = 12;
/** The disc's underside; its outer wall is drawn from here up. */
const SLAB_Y = 3;
/** Under the disc: never drawn, never stood on. */
const VOID_Y = -40;
/** The engine's plinth: one half-step up, so it is walked onto and read as a dais. */
const PLINTH_R = 5.5;
const PLINTH_Y = 12.5;

const RAD = Math.PI / 180;
/** Sector centres as bearings from the disc centre (atan2(z, x)). */
const MEADOW_B = -90 * RAD;
const SEA_B = 30 * RAD;
const SKY_B = 150 * RAD;

/** The tide bowl: a pool sunk into the sea sector, its rim clear of the walkway. */
const POOL_CX = C + 38 * Math.cos(SEA_B);
const POOL_CZ = C + 38 * Math.sin(SEA_B);
const POOL_R = 26;
/** Width of the bowl's wall band: 7.5 units of drop over 7 columns is terraces, not a walk. */
const POOL_WALL = 7;
/** Bed 4.5..6 under a surface at 8: 2 to 3.5 of water, which is a swim for the water mount. */
const BED_LO = 4.5;
const BED_RANGE = 1.5;
/** The shore ramp: a causeway cut from the meadow's side down to the bed at a walkable 0.44/column. */
const RAMP_LEN = 22;
const RAMP_DROP_LEN = 16;
const RAMP_BED = 5;
const RAMP_HALF = 3;

/** The cloud deck: a raised platform in the sky sector, and the frame stands on it. */
const DECK_CX = C + 40 * Math.cos(SKY_B);
const DECK_CZ = C + 40 * Math.sin(SKY_B);
const DECK_R = 22;
const DECK_Y = 17;
const LEDGE_R = 23.5;
const LEDGE_Y = 14.5;
/** The brass stair up to it, from the meadow: 12 flat, then 5 units over 12 columns. */
const STAIR_HALF = 2.2;
const STAIR_FLAT = 12;
const STAIR_RISE = 12;
/** Radius of the four pylons and the ring they carry, from the deck's centre. */
const FRAME_R = 15;
const FRAME_S = 1.2;

/** The gate spot: the meadow's outer edge, off the track's axis so the anchor beside it is clear. */
const GATE_X = C + Math.round(58 * Math.cos(-100 * RAD)) + 0.5;
const GATE_Z = C + Math.round(58 * Math.sin(-100 * RAD)) + 0.5;
/** Where the hero stands to pull the lever: on the plinth, facing +z into the machine. */
const STAND_X = C;
const STAND_Z = C - 5;
const TRACK_HALF = 1.4;
/**
 * The three thread anchors, one per sector, on the walkway ring — 30° off the
 * sector centres, so the meadow's thread runs clear of the standing spot and
 * the track, and the other two still cross the bowl and the deck.
 */
const ANCHOR_R = 67;
const ANCHOR_BEARINGS = [MEADOW_B + 30 * RAD, SEA_B + 30 * RAD, SKY_B + 30 * RAD] as const;

/** Same 3 ms per rendered frame the overworld streamer spends. See world/index.ts. */
const BUILD_BUDGET_MS = 3;
const SEED = 0x5ea3;

const THREAD_RED = 0xff3b3b;
const BRASS = 0xb08a3c;
const BRASS_D = 0x84652a;
const BRASS_L = 0xd8b45e;

// ---------------------------------------------------------------------------
// Geometry helpers — all in LOCAL columns; world = origin + local.
// ---------------------------------------------------------------------------
const quant = (v: number): number => Math.round(v * 2) / 2;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

interface Seg {
  x: number;
  z: number;
  ux: number;
  uz: number;
  len: number;
}
const seg = (ax: number, az: number, bx: number, bz: number): Seg => {
  const len = Math.hypot(bx - ax, bz - az);
  return { x: ax, z: az, ux: (bx - ax) / len, uz: (bz - az) / len, len };
};
/** Signed distance ALONG a segment from its start, and unsigned distance ACROSS it. */
const along = (s: Seg, x: number, z: number): number => (x - s.x) * s.ux + (z - s.z) * s.uz;
const across = (s: Seg, x: number, z: number): number =>
  Math.abs((x - s.x) * s.uz - (z - s.z) * s.ux);
const segDist = (s: Seg, x: number, z: number): number => {
  const a = along(s, x, z);
  if (a <= 0) {
    return Math.hypot(x - s.x, z - s.z);
  }
  if (a >= s.len) {
    return Math.hypot(x - (s.x + s.ux * s.len), z - (s.z + s.uz * s.len));
  }
  return across(s, x, z);
};

const TRACK = seg(GATE_X, GATE_Z, C, C - PLINTH_R + 0.5);
/** The ramp runs from outside the bowl toward its centre, from the side facing the gate. */
const RAMP = ((): Seg => {
  const dx = GATE_X - POOL_CX;
  const dz = GATE_Z - POOL_CZ;
  const l = Math.hypot(dx, dz);
  const sx = POOL_CX + (dx / l) * (POOL_R + 2);
  const sz = POOL_CZ + (dz / l) * (POOL_R + 2);
  return seg(sx, sz, POOL_CX, POOL_CZ);
})();
/** The stair sets off from the meadow's far corner and climbs onto the deck. */
const STAIR = seg(
  C + 48 * Math.cos(-145 * RAD),
  C + 48 * Math.sin(-145 * RAD),
  DECK_CX,
  DECK_CZ,
);
const THREADS: Seg[] = ANCHOR_BEARINGS.map((b) =>
  seg(C, C, C + ANCHOR_R * Math.cos(b), C + ANCHOR_R * Math.sin(b)),
);

const enum Mat {
  Void,
  Turf,
  Earth,
  Sand,
  Bed,
  Cloud,
  Glass,
  Brass,
  Groove,
  Stone,
}
const enum Sector {
  Meadow,
  Sea,
  Sky,
}

const rollNoise = new Noise2D(SEED ^ 0x0e11);
const bedNoise = new Noise2D(SEED ^ 0xbed);
const swardNoise = new Noise2D(SEED ^ 0x5a4d);

interface Column {
  h: number;
  m: Mat;
}

const sectorAt = (th: number): Sector =>
  th < -150 * RAD
    ? Sector.Sky
    : th < -30 * RAD
      ? Sector.Meadow
      : th < 90 * RAD
        ? Sector.Sea
        : Sector.Sky;

/**
 * THE WHOLE HEIGHT AND MATERIAL AUTHORITY OF THE ZONE, for one local column.
 * Every terrace is a multiple of 0.5 and every walkable slope changes by at most
 * 0.5 per column, so `MAX_STEP_UP` decides what is a route and what is a wall.
 */
function column(lx: number, lz: number, out: Column): void {
  const x = lx + 0.5;
  const z = lz + 0.5;
  const dx = x - C;
  const dz = z - C;
  const d = Math.hypot(dx, dz);
  if (d > DISC_R) {
    out.h = VOID_Y;
    out.m = Mat.Void;
    return;
  }
  // The sector line is dithered a few degrees so turf meets sand on a ragged edge.
  const th = Math.atan2(dz, dx) + (hashCell(SEED, lx, 3, lz) - 0.5) * 0.1;
  const sector = sectorAt(th);
  let h = FLOOR_Y;
  let m = sector === Sector.Meadow ? Mat.Turf : sector === Sector.Sea ? Mat.Sand : Mat.Cloud;

  const dTrack = segDist(TRACK, x, z);
  const dStair = segDist(STAIR, x, z);
  if (d < PLINTH_R) {
    h = PLINTH_Y;
    m = d > PLINTH_R - 1.2 ? Mat.Brass : Mat.Stone;
  } else if (sector === Sector.Meadow && d < RIM_R) {
    // Gentle rolling steps, damped to flat along the track, at the stair foot,
    // around the plinth and toward the walkway. See the gradient note in the commit.
    const n = (rollNoise.fbm(x * 0.045, z * 0.045, 2) + 1) * 0.5;
    const amp =
      smooth(TRACK_HALF + 0.6, 6.5, dTrack) *
      smooth(STAIR_HALF + 0.4, 6, dStair) *
      (1 - smooth(56, 61, d)) *
      smooth(PLINTH_R + 1, PLINTH_R + 7, d);
    h = FLOOR_Y + quant(n * amp);
  }
  if (d >= PLINTH_R && sector === Sector.Meadow) {
    if (dTrack < TRACK_HALF) {
      h = FLOOR_Y;
      m = Mat.Earth;
    } else if (
      dTrack < TRACK_HALF + 1.6 &&
      hashCell(SEED, lx, 5, lz) < (TRACK_HALF + 1.6 - dTrack) * 0.5
    ) {
      m = Mat.Earth;
    }
  }

  const dp = Math.hypot(x - POOL_CX, z - POOL_CZ);
  let wet = false;
  if (dp < POOL_R) {
    const bed = BED_LO + BED_RANGE * (bedNoise.fbm(x * 0.09, z * 0.09, 2) + 1) * 0.5;
    const t = clamp01((POOL_R - dp) / POOL_WALL);
    h = quant(FLOOR_Y - (FLOOR_Y - bed) * t * t * (3 - 2 * t));
    wet = true;
  }
  const ra = along(RAMP, x, z);
  if (ra >= 0 && ra <= RAMP_LEN && across(RAMP, x, z) < RAMP_HALF) {
    h = quant(FLOOR_Y - (FLOOR_Y - RAMP_BED) * clamp01(ra / RAMP_DROP_LEN));
    wet = true;
  }
  if (wet) {
    m = h < WATER_LEVEL + 0.5 ? Mat.Bed : Mat.Sand;
  }

  const dd = Math.hypot(x - DECK_CX, z - DECK_CZ);
  if (dd < DECK_R) {
    h = DECK_Y;
    m = Mat.Glass;
  } else if (dd < LEDGE_R) {
    h = LEDGE_Y;
    m = Mat.Stone;
  }
  const sa = along(STAIR, x, z);
  if (sa >= STAIR_FLAT && dd > DECK_R - 1 && across(STAIR, x, z) < STAIR_HALF) {
    h = quant(FLOOR_Y + (DECK_Y - FLOOR_Y) * clamp01((sa - STAIR_FLAT) / STAIR_RISE));
    m = h > FLOOR_Y ? Mat.Brass : m;
  }

  if (d >= RIM_R) {
    h = FLOOR_Y;
    if (d >= BRASS_R) {
      m = Mat.Brass;
    }
  }
  // The thread's grooves: a dark channel from the plinth to each anchor.
  if (d > PLINTH_R + 0.5 && d < ANCHOR_R - 1) {
    for (const t of THREADS) {
      if (across(t, x, z) < 0.55) {
        m = Mat.Groove;
        break;
      }
    }
  }
  out.h = h;
  out.m = m;
}

const _col: Column = { h: 0, m: Mat.Void };
/** Column top in LOCAL coordinates. */
function localHeight(lx: number, lz: number): number {
  column(lx, lz, _col);
  return _col.h;
}

/**
 * THE PLACES OF THE SEAM in world coordinates, derived from the same constants
 * the geometry is built from — the `mawsRest()` pattern: never stored, so a
 * quest and the world cannot disagree about where the engine is. `y` is the
 * walking surface; the sea's is the BED under 8 units of water (`waterLevel`).
 */
export function seamSites(): {
  engine: { x: number; y: number; z: number };
  land: { x: number; y: number; z: number };
  sea: { x: number; y: number; z: number };
  sky: { x: number; y: number; z: number };
  gate: { x: number; y: number; z: number };
} {
  const at = (lx: number, lz: number): { x: number; y: number; z: number } => ({
    x: SEAM_ORIGIN_X + lx,
    y: localHeight(Math.floor(lx), Math.floor(lz)),
    z: SEAM_ORIGIN_Z + lz,
  });
  return {
    engine: at(STAND_X, STAND_Z),
    land: at(C + 0.5, C + 36 * Math.sin(MEADOW_B) + 0.5),
    sea: at(Math.floor(POOL_CX) + 0.5, Math.floor(POOL_CZ) + 0.5),
    sky: at(Math.floor(DECK_CX) + 0.5, Math.floor(DECK_CZ) + 0.5),
    gate: at(GATE_X, GATE_Z),
  };
}

// ---------------------------------------------------------------------------
// Palette. Linear radiance, converted once — see the note in world/dungeon.ts.
// ---------------------------------------------------------------------------
const s2l = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lin = (hex: number): [number, number, number] => [
  s2l(((hex >> 16) & 255) / 255),
  s2l(((hex >> 8) & 255) / 255),
  s2l((hex & 255) / 255),
];
type RGB = [number, number, number];
/** [top, side] per material, indexed by `Mat`. */
const PALETTE: Array<[RGB, RGB]> = [
  [lin(0x000000), lin(0x000000)],
  [lin(0x5c9a3a), lin(0x6b4e33)], // turf over earth
  [lin(0x8a6a45), lin(0x5c4330)], // beaten earth
  [lin(0xd6c493), lin(0xa08c66)], // coral sand
  [lin(0x3f8078), lin(0x2c5652)], // verdigris bed
  [lin(0xb9c2d4), lin(0x7c8798)], // pale cloud-stone
  [lin(0xdde6f4), lin(0x8f9db4)], // cloud-glass
  [lin(BRASS), lin(BRASS_D)],
  [lin(0x3a2a2a), lin(0x2a1f1f)], // the thread's groove
  [lin(0x6d6a66), lin(0x4f4c48)], // dressed stone
];
const TURF_LIGHT = lin(0x79b04a);
/** The disc's outer wall: indigo-grey rock the void colours, banded. */
const RIM_ROCK = lin(0x3d3a44);

/** Corner-AO ramp and side shades, the overworld mesher's. See world/chunk.ts. */
const AO = [0.42, 0.6, 0.8, 1.0];
const aoLevel = (s1: boolean, s2: boolean, c: boolean): number =>
  s1 && s2 ? 0 : 3 - ((s1 ? 1 : 0) + (s2 ? 1 : 0) + (c ? 1 : 0));
const SIDE_SHADE = [0.82, 1.22, 0.9, 1.18];
const SIDE_BOUNCE = [0, 1, 0.4, 0.9];

/** Two of these per chunk: the lit body and the glass that glows. */
class MeshAcc {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  idx: number[] = [];

  quad(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    qx: number,
    qy: number,
    qz: number,
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
  ): void {
    const base = this.pos.length / 3;
    this.pos.push(ax, ay, az, bx, by, bz, qx, qy, qz, dx, dy, dz);
    this.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.col.push(
      r * a0,
      g * a0,
      b * a0,
      r * a1,
      g * a1,
      b * a1,
      r * a2,
      g * a2,
      b * a2,
      r * a3,
      g * a3,
      b * a3,
    );
    if (a0 === a1 && a1 === a2 && a2 === a3) {
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      return;
    }
    // Centre vertex against the diagonal crease — same fix as the other meshers.
    const am = (a0 + a1 + a2 + a3) * 0.25;
    this.pos.push((ax + qx) * 0.5, (ay + qy) * 0.5, (az + qz) * 0.5);
    this.nrm.push(nx, ny, nz);
    this.col.push(r * am, g * am, b * am);
    const m = base + 4;
    this.idx.push(base, base + 1, m, base + 1, base + 2, m);
    this.idx.push(base + 2, base + 3, m, base + 3, base, m);
  }

  toMesh(material: THREE.Material, x: number, z: number): THREE.Mesh | null {
    if (this.idx.length === 0) {
      return null;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, 0, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }
}

/**
 * Chunk mesher: exposed faces of a half-unit heightfield. The hold's mesher with
 * two changes — heights are floats, so a side face is cut into whole-unit bands
 * from a fractional base, and the deck's top faces go to a second, emissive mesh.
 */
function buildSeamChunk(
  cx: number,
  cz: number,
  bodyMat: THREE.Material,
  glassMat: THREE.Material,
): { body: THREE.Mesh | null; glass: THREE.Mesh | null } {
  const G = CHUNK_SIZE + 2;
  const hA = new Float32Array(G * G);
  const mA = new Uint8Array(G * G);
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  const c: Column = { h: 0, m: Mat.Void };
  for (let lz = -1; lz <= CHUNK_SIZE; lz++) {
    for (let lx = -1; lx <= CHUNK_SIZE; lx++) {
      column(ox + lx, oz + lz, c);
      hA[(lz + 1) * G + (lx + 1)] = c.h;
      mA[(lz + 1) * G + (lx + 1)] = c.m;
    }
  }
  const body = new MeshAcc();
  const glass = new MeshAcc();
  const jitter = (x: number, y: number, z: number): number =>
    hashCell(SEED, x, y, z) + hashCell(SEED, x + 8191, y, z + 5077) - 1;
  const EPS = 1e-3;

  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const i = (lz + 1) * G + (lx + 1);
      const H = hA[i];
      if (H <= VOID_Y + 1) {
        continue;
      }
      const wx = ox + lx;
      const wz = oz + lz;
      const m = mA[i] as Mat;
      const [top, side] = PALETTE[m];
      let r = top[0];
      let g = top[1];
      let b = top[2];
      if (m === Mat.Turf) {
        // Two greens blended by a slow field, so the meadow has patches rather than a tint.
        const w = clamp01(swardNoise.fbm(wx * 0.07, wz * 0.07, 2) * 0.9 + 0.5);
        r += (TURF_LIGHT[0] - r) * w;
        g += (TURF_LIGHT[1] - g) * w;
        b += (TURF_LIGHT[2] - b) * w;
      }
      const jt = jitter(wx, Math.round(H * 2), wz);
      const hw = jitter(wx, 31, wz) * 0.05;
      const mt = 1 + jt * (m === Mat.Glass ? 0.02 : 0.05);
      r *= mt * (1 + hw);
      g *= mt;
      b *= mt * (1 - hw);

      const hE = hA[i + 1];
      const hW = hA[i - 1];
      const hS = hA[i + G];
      const hN = hA[i - G];
      const oE = hE > H + EPS;
      const oW = hW > H + EPS;
      const oS = hS > H + EPS;
      const oN = hN > H + EPS;
      const oSE = hA[i + 1 + G] > H + EPS;
      const oSW = hA[i - 1 + G] > H + EPS;
      const oNE = hA[i + 1 - G] > H + EPS;
      const oNW = hA[i - 1 - G] > H + EPS;
      (m === Mat.Glass ? glass : body).quad(
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
        AO[aoLevel(oW, oN, oNW)],
        AO[aoLevel(oW, oS, oSW)],
        AO[aoLevel(oE, oS, oSE)],
        AO[aoLevel(oE, oN, oNE)],
      );

      for (let dir = 0; dir < 4; dir++) {
        const nH = dir === 0 ? hE : dir === 1 ? hW : dir === 2 ? hS : hN;
        if (nH >= H - EPS) {
          continue;
        }
        const toVoid = nH <= VOID_Y + 1;
        const base = toVoid ? SLAB_Y : nH;
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
        const wall = toVoid ? RIM_ROCK : side;
        let y0 = base;
        while (y0 < H - EPS) {
          const y1 = Math.min(H, Math.floor(y0 + EPS) + 1);
          const yi = Math.floor(y0 + EPS);
          // Strata on the tall drops — the disc's wall and the bowl's — every 3 units.
          const band = toVoid ? 0.8 + hashCell(SEED, Math.floor(yi / 3), 977, 0) * 0.32 : 1;
          const j = jitter(wx, yi, wz);
          const shade = SIDE_SHADE[dir] * (1 + j * 0.09) * band;
          const jw = jitter(wx, yi + 31, wz) * 0.05 + SIDE_BOUNCE[dir] * 0.06;
          // The wall's brass lip: the top unit of the drop into the void.
          const lip = toVoid && y1 >= H - EPS;
          const wc = lip ? PALETTE[Mat.Brass][1] : wall;
          const br = wc[0] * shade * (1 + jw);
          const bg = wc[1] * shade;
          const bb = wc[2] * shade * (1 - jw);
          const upA = AO[aoLevel(hTA >= y1 - EPS, false, hTA >= y1 + 1 - EPS)];
          const upB = AO[aoLevel(hTB >= y1 - EPS, false, hTB >= y1 + 1 - EPS)];
          const loA = AO[aoLevel(hTA >= y1 - EPS, nH >= y0 - EPS, hTA >= y0 - EPS)];
          const loB = AO[aoLevel(hTB >= y1 - EPS, nH >= y0 - EPS, hTB >= y0 - EPS)];
          const ao: [number, number, number, number] = [loA, upA, upB, loB];
          const x0 = lx;
          const x1 = lx + 1;
          const z0 = lz;
          const z1 = lz + 1;
          if (dir === 0) {
            body.quad(x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1, 1, 0, 0, br, bg, bb, ...ao);
          } else if (dir === 1) {
            body.quad(x0, y0, z1, x0, y1, z1, x0, y1, z0, x0, y0, z0, -1, 0, 0, br, bg, bb, ...ao);
          } else if (dir === 2) {
            body.quad(x1, y0, z1, x1, y1, z1, x0, y1, z1, x0, y0, z1, 0, 0, 1, br, bg, bb, ...ao);
          } else {
            body.quad(x0, y0, z0, x0, y1, z0, x1, y1, z0, x1, y0, z0, 0, 0, -1, br, bg, bb, ...ao);
          }
          y0 = y1;
        }
      }
    }
  }
  const px = SEAM_ORIGIN_X + ox;
  const pz = SEAM_ORIGIN_Z + oz;
  return { body: body.toMesh(bodyMat, px, pz), glass: glass.toMesh(glassMat, px, pz) };
}

// ---------------------------------------------------------------------------
// The things that stand here. Voxel models, colliders measured off them.
// ---------------------------------------------------------------------------
const shadeHex = (hex: number, k: number): number => {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return (r << 16) | (g << 8) | b;
};

/** Voxel scale of the engine and the anchors. */
const EV = 0.4;

/**
 * THE ENGINE: a brass drum on an iron footing, a crown and a spire above it, the
 * lever and a glass lens on the meadow face. Symmetric about cell (0, 0) in x and
 * z, and so is every glow piece, so all of them bake to the same axis.
 */
function engineBody(): Template {
  const v = new VoxelModel();
  const rng = mulberry32(0xe961);
  const IRON = 0x3c3a40;
  const IRON_L = 0x55535b;
  const GLASS_C = 0x8fd8e8;
  for (let x = -6; x <= 6; x++) {
    for (let z = -6; z <= 6; z++) {
      if (x * x + z * z <= 36) {
        v.set(x, 0, z, shadeHex((x + z) & 1 ? IRON : IRON_L, 0.94 + rng() * 0.12));
      }
    }
  }
  for (let y = 1; y <= 14; y++) {
    const band = y % 4 === 0;
    for (let x = -5; x <= 5; x++) {
      for (let z = -5; z <= 5; z++) {
        const rr = x * x + z * z;
        if (rr > 25 || rr < 12) {
          continue;
        }
        // A glass window band on the meadow (-z) face, iron-framed.
        const win = y >= 6 && y <= 8 && z < 0 && Math.abs(x) <= 2;
        const c = win ? GLASS_C : band ? BRASS_D : BRASS;
        v.set(x, y, z, shadeHex(c, 0.92 + rng() * 0.16));
      }
    }
  }
  // Fill the drum's core so nothing sees through the window into air.
  for (let y = 1; y <= 14; y++) {
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) {
        if (x * x + z * z < 12) {
          v.set(x, y, z, shadeHex(IRON, 0.9 + rng() * 0.1));
        }
      }
    }
  }
  // Crown, spire.
  for (let y = 15; y <= 20; y++) {
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) {
        if (x * x + z * z <= 9) {
          v.set(x, y, z, shadeHex(y === 15 || y === 20 ? BRASS_L : BRASS, 0.92 + rng() * 0.16));
        }
      }
    }
  }
  for (let y = 21; y <= 24; y++) {
    v.set(0, y, 0, shadeHex(y === 24 ? BRASS_L : IRON_L, 1));
  }
  // The lever on the meadow face: a rod out of the drum with a grip across it.
  v.box(0, 9, -7, 0, 9, -6, IRON_L);
  v.box(0, 10, -8, 0, 11, -8, IRON_L);
  v.box(-1, 12, -8, 1, 12, -8, BRASS_L);
  // The lens: a brass ring on the crown's meadow face.
  for (const [x, y] of [
    [-1, 17],
    [1, 17],
    [0, 16],
    [0, 18],
  ]) {
    v.set(x, y, -4, BRASS_L);
  }
  v.set(0, 17, -4, GLASS_C);
  return bakeSolid(v, EV);
}

/** Bake a glow piece off the body's face grid — `bakeAt`'s trick, without its origin shift. */
function bakeGlow(v: VoxelModel, scale: number): { t: Template; baseY: number } {
  const t = bakeProp(v, scale);
  const part = GLOW_PART * scale;
  for (let i = 0; i < t.pos.length; i += 3) {
    t.pos[i] += part;
    t.pos[i + 1] += part;
    t.pos[i + 2] += part;
  }
  return { t, baseY: v.bounds(true).minY * scale };
}

/** The red thread wound round the drum, and the spire's tip. Symmetric about the axis. */
function engineGlow(): { t: Template; baseY: number } {
  const v = new VoxelModel();
  // A helix of beads just OUTSIDE the drum's shell (every cell past rr = 25, so
  // none shares a face plane with the body): one per 20 degrees, up a cell every 3.
  for (let k = 0; k < 42; k++) {
    const a = k * 20 * RAD;
    const x = Math.round(6 * Math.cos(a));
    const z = Math.round(6 * Math.sin(a));
    v.set(x, 1 + Math.floor(k / 3), z, THREAD_RED);
  }
  // Ring at the crown's foot, and the tip.
  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) {
      const rr = x * x + z * z;
      if (rr <= 13 && rr > 9) {
        v.set(x, 15, z, THREAD_RED);
      }
    }
  }
  v.set(0, 25, 0, THREAD_RED);
  // Symmetry pins: the helix rounds to an asymmetric footprint; these do not draw
  // (buried in the drum) but keep the bake centred on the axis.
  v.set(-6, 3, 0, THREAD_RED);
  v.set(6, 3, 0, THREAD_RED);
  v.set(0, 3, -6, THREAD_RED);
  v.set(0, 3, 6, THREAD_RED);
  return bakeGlow(v, EV);
}

/** An anchor pylon: brass column on a stone footing, a cage at the top for the thread's knot. */
function anchorBody(): Template {
  const v = new VoxelModel();
  const rng = mulberry32(0xa9c4);
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) {
      v.set(x, 0, z, shadeHex((x + z) & 1 ? 0x6d6a66 : 0x5a5753, 0.94 + rng() * 0.12));
    }
  }
  for (let y = 1; y <= 13; y++) {
    for (let x = -1; x <= 1; x++) {
      for (let z = -1; z <= 1; z++) {
        v.set(x, y, z, shadeHex(y % 4 === 0 ? BRASS_D : BRASS, 0.92 + rng() * 0.16));
      }
    }
  }
  for (const [x, z] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    v.box(x, 14, z, x, 16, z, BRASS_L);
  }
  v.box(-1, 17, -1, 1, 17, 1, BRASS_D);
  return bakeSolid(v, EV);
}

function anchorGlow(): { t: Template; baseY: number } {
  const v = new VoxelModel();
  v.box(0, 14, 0, 0, 16, 0, THREAD_RED);
  return bakeGlow(v, EV);
}

/** A standing stone of the meadow, tapering, lichened. */
function menhir(seed: number): Template {
  const v = new VoxelModel();
  const rng = mulberry32(seed);
  const H = 7 + Math.floor(rng() * 3);
  for (let y = 0; y < H; y++) {
    const w = y < 2 ? 1 : y > H - 3 ? 0 : 1;
    for (let x = -w; x <= w; x++) {
      for (let z = -1; z <= 0; z++) {
        if (w === 1 && Math.abs(x) === 1 && rng() < 0.25) {
          continue;
        }
        const moss = y < 3 && rng() < 0.3;
        v.set(x, y, z, shadeHex(moss ? 0x5a7a3c : 0x8b8478, 0.86 + rng() * 0.28));
      }
    }
  }
  return bakeSolid(v, 0.5);
}

/** A kelp stalk of the bowl. `bakeProp`: a swimmer passes through weed. */
function kelp(seed: number): Template {
  const v = new VoxelModel();
  const rng = mulberry32(seed);
  const H = 8 + Math.floor(rng() * 6);
  let x = 0;
  let z = 0;
  for (let y = 0; y < H; y++) {
    v.set(x, y, z, shadeHex(y % 3 === 0 ? 0x2f7a5a : 0x3f9a6a, 0.9 + rng() * 0.2));
    if (y % 2 === 1) {
      const side = rng() < 0.5 ? 1 : -1;
      v.set(x + side, y, z, shadeHex(0x4faa72, 0.9 + rng() * 0.2));
      v.set(x + side * 2, y + 1, z, shadeHex(0x5cbb7c, 0.9 + rng() * 0.2));
    }
    if (rng() < 0.3) {
      x += rng() < 0.5 ? 1 : -1;
    }
    if (rng() < 0.3) {
      z += rng() < 0.5 ? 1 : -1;
    }
  }
  return bakeProp(v, 0.36);
}

/** A coral head: three lobes, pink and orange, on a verdigris base. */
function coral(seed: number): Template {
  const v = new VoxelModel();
  const rng = mulberry32(seed);
  v.ellipsoid(0, 1, 0, 3, 1.4, 2.6, 0x3f8078);
  v.ellipsoid(-1.2, 2.4, 0.4, 1.8, 1.6, 1.6, shadeHex(0xd97a8a, 0.9 + rng() * 0.2));
  v.ellipsoid(1.4, 2.8, -0.6, 1.5, 2.0, 1.4, shadeHex(0xe08a4a, 0.9 + rng() * 0.2));
  v.ellipsoid(0.2, 3.6, 1.2, 1.1, 1.3, 1.1, shadeHex(0xf0a0b0, 0.9 + rng() * 0.2));
  return bakeProp(v, 0.36);
}

/** The frame's ring, at the height and radius the pylons' arcs spring to. See `skyPylon`. */
function frameRing(radiusCells: number): Template {
  const v = new VoxelModel();
  const steps = Math.ceil(radiusCells * 2 * Math.PI * 1.5);
  for (let k = 0; k < steps; k++) {
    const a = (k / steps) * Math.PI * 2;
    const x = Math.round(radiusCells * Math.cos(a));
    const z = Math.round(radiusCells * Math.sin(a));
    v.set(x, 0, z, k % 9 === 0 ? BRASS_L : BRASS);
    v.set(x, 1, z, k % 9 === 0 ? BRASS_L : BRASS_D);
  }
  return bakeProp(v, 0.6);
}

/** A deck lamp: brass post with an open cage, and the flame as its own glow piece. */
function seamLamp(): Template {
  const v = new VoxelModel();
  for (let y = 0; y <= 8; y++) {
    v.set(0, y, 0, y < 2 ? 0x5a5753 : y % 3 === 0 ? BRASS_D : BRASS);
  }
  for (const [x, z] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    v.box(x, 9, z, x, 10, z, BRASS_L);
  }
  v.box(-1, 11, -1, 1, 11, 1, BRASS_D);
  return bakeSolid(v, 0.6);
}

function seamLampGlow(): { t: Template; baseY: number } {
  const v = new VoxelModel();
  v.box(0, 9, 0, 0, 10, 0, 0xffc561);
  return bakeGlow(v, 0.6);
}

/**
 * The balustrade's kit: brass, chest-high, and its top course measures 2.52 units
 * above the walkway. That is above the hero's jump apex plus his step allowance
 * (1.61 + 0.5, player/index.ts), so it is a rail he cannot hop — the reason it
 * exists. Same shape as the camp's `fenceKit`, so `buildFence` lays it.
 */
function balustradeKit(): FenceParts {
  const POST_VOX = 10;
  const RAIL_VOX = 10;
  const post = new VoxelModel();
  for (let y = 0; y < POST_VOX; y++) {
    post.box(-1, y, -1, 0, y, 0, y === POST_VOX - 1 ? BRASS_L : y % 3 === 0 ? BRASS_D : BRASS);
  }
  post.box(-1, POST_VOX, -1, 0, POST_VOX, 0, BRASS_L);
  const rail = new VoxelModel();
  for (let z = 0; z < RAIL_VOX; z++) {
    rail.box(-1, 0, z, 0, 2, z, z % 5 === 0 ? BRASS_L : BRASS);
  }
  const railProp = new VoxelModel();
  for (let z = 0; z < RAIL_VOX; z++) {
    railProp.box(-1, 0, z, 0, 1, z, BRASS_D);
  }
  const postT = bakeProp(post, V);
  return {
    post: postT,
    tall: postT,
    lantern: postT,
    lanternGlow: postT,
    rail: bakeSolid(rail, V),
    railProp: bakeProp(railProp, V),
    railLen: RAIL_VOX * V,
    railWidth: 1.5 * V,
    railHeight: 3 * V,
    postWidth: 2 * V,
    railAt: [2 * V, 6 * V],
    postH: (POST_VOX + 1) * V,
    tallH: (POST_VOX + 1) * V,
    lanternH: (POST_VOX + 1) * V,
    postR: V,
  };
}

/** Axis-aligned box into a plain accumulator: the thread's grooves are built from these. */
function pushBox(
  acc: MeshAcc,
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
  c: RGB,
): void {
  const x0 = cx - hx;
  const x1 = cx + hx;
  const y0 = cy - hy;
  const y1 = cy + hy;
  const z0 = cz - hz;
  const z1 = cz + hz;
  const [r, g, b] = c;
  acc.quad(x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0, 0, 1, 0, r, g, b, 1, 1, 1, 1);
  acc.quad(x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1, 1, 0, 0, r, g, b, 1, 1, 1, 1);
  acc.quad(x0, y0, z1, x0, y1, z1, x0, y1, z0, x0, y0, z0, -1, 0, 0, r, g, b, 1, 1, 1, 1);
  acc.quad(x1, y0, z1, x1, y1, z1, x0, y1, z1, x0, y0, z1, 0, 0, 1, r, g, b, 1, 1, 1, 1);
  acc.quad(x0, y0, z0, x0, y1, z0, x1, y1, z0, x1, y0, z0, 0, 0, -1, r, g, b, 1, 1, 1, 1);
}

// ---------------------------------------------------------------------------

interface SeamChunk {
  cx: number;
  cz: number;
  body: THREE.Mesh | null;
  glass: THREE.Mesh | null;
}

const key = (cx: number, cz: number): number => cx * 64 + cz;

/**
 * Build the Seam as a `World`. Nothing outside ZoneManager should call this: it
 * adds to the scene, and only the zone's owner knows when to take it out again.
 */
export function createSeam(scene: THREE.Scene): World {
  const OX = SEAM_ORIGIN_X;
  const OZ = SEAM_ORIGIN_Z;
  const heightAt = (x: number, z: number): number =>
    localHeight(Math.floor(x - OX), Math.floor(z - OZ));

  // `vertexColors` alone, `vertexColors` + `emissive`: the two define sets the
  // hold and every beast already use, so the zone introduces no program of its own
  // except the water (the lakes') and the sky. See the note on buildCrystals.
  const bodyMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.35,
    metalness: 0,
    emissive: 0xdfe8ff,
    emissiveIntensity: 0.28,
  });
  const propMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0,
  });
  const redMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.4,
    metalness: 0,
    emissive: THREAD_RED,
    emissiveIntensity: 2.2,
  });
  const lampMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.6,
    metalness: 0,
    emissive: 0xffc561,
    emissiveIntensity: 2.0,
  });
  const materials: THREE.Material[] = [bodyMat, glassMat, propMat, redMat, lampMat];
  const geometries: THREE.BufferGeometry[] = [];
  const fixtures = new THREE.Group();

  // ---- the solids: one merged mesh, one collision field ------------------
  const solids = new StructureField();
  const stamp = new SolidStamp(solids);
  const glow = new Accum();
  const flames = new Accum();
  const fences: Fence[] = [];

  const engineT = engineBody();
  const engineG = engineGlow();
  stamp.add(engineT, OX + C, PLINTH_Y, OZ + C, 0, 1);
  glow.add(engineG.t, OX + C, PLINTH_Y + engineG.baseY, OZ + C, 0, 1, 1, 1, 1);
  const anchorT = anchorBody();
  const anchorG = anchorGlow();
  for (const b of ANCHOR_BEARINGS) {
    const ax = OX + C + ANCHOR_R * Math.cos(b);
    const az = OZ + C + ANCHOR_R * Math.sin(b);
    stamp.add(anchorT, ax, FLOOR_Y, az, 0, 1);
    glow.add(anchorG.t, ax, FLOOR_Y + anchorG.baseY, az, 0, 1, 1, 1, 1);
  }

  // The meadow: oaks, a stone ring, a broken fence, tussocks.
  const oaks = [oakTree(false), oakTree(true)];
  const OAKS: Array<[number, number, number]> = [
    [-128, 40, 0],
    [-118, 55, 1],
    [-70, 44, 1],
    [-48, 57, 0],
    [-140, 24, 0],
    [-105, 36, 1],
    [-52, 30, 0],
  ];
  for (let k = 0; k < OAKS.length; k++) {
    const [deg, r, v] = OAKS[k];
    const lx = C + r * Math.cos(deg * RAD);
    const lz = C + r * Math.sin(deg * RAD);
    const y = localHeight(Math.floor(lx), Math.floor(lz));
    stamp.add(oaks[v], OX + lx, y, OZ + lz, k * 1.7, 0.95 + (k % 3) * 0.05);
  }
  const stones = [menhir(0x51), menhir(0x52), menhir(0x53)];
  for (let k = 0; k < 5; k++) {
    const a = -80 * RAD + (k / 5) * Math.PI * 2;
    const lx = C + 40 * Math.cos(-80 * RAD) + 5.5 * Math.cos(a);
    const lz = C + 40 * Math.sin(-80 * RAD) + 5.5 * Math.sin(a);
    const y = localHeight(Math.floor(lx), Math.floor(lz));
    stamp.add(stones[k % 3], OX + lx, y, OZ + lz, a + 0.4, 1);
  }
  const rocks = [rock(0, true), rock(1, true)];
  for (let k = 0; k < 4; k++) {
    const deg = -135 + k * 9;
    const r = 30 + (k % 2) * 14;
    const lx = C + r * Math.cos(deg * RAD);
    const lz = C + r * Math.sin(deg * RAD);
    const y = localHeight(Math.floor(lx), Math.floor(lz));
    stamp.add(rocks[k % 2], OX + lx, y, OZ + lz, k * 2.1, 1);
  }
  {
    // A run of the camp's fence along the meadow's outer arc, two bays fallen.
    const path: Array<{ x: number; z: number; y: number }> = [];
    for (let k = 0; k <= 6; k++) {
      const deg = -140 + k * 5;
      const r = 50 + Math.sin(k * 1.9) * 1.5;
      const x = OX + C + r * Math.cos(deg * RAD);
      const z = OZ + C + r * Math.sin(deg * RAD);
      path.push({ x, z, y: heightAt(x, z) });
    }
    const gapX = OX + C + 50 * Math.cos(-125 * RAD);
    const gapZ = OZ + C + 50 * Math.sin(-125 * RAD);
    fences.push(
      ...buildFence(stamp, fenceKit(), path, {
        groundAt: heightAt,
        accept: (ax, az, bx, bz) => Math.hypot((ax + bx) / 2 - gapX, (az + bz) / 2 - gapZ) > 3.4,
      }),
    );
  }

  // The bowl: kelp and coral on the bed.
  const weeds = [kelp(0x11), kelp(0x12), coral(0x21), coral(0x22)];
  for (let k = 0; k < 10; k++) {
    const a = k * 2.4;
    const r = 6 + (k % 4) * 3.5;
    const lx = POOL_CX + r * Math.cos(a);
    const lz = POOL_CZ + r * Math.sin(a);
    const y = localHeight(Math.floor(lx), Math.floor(lz));
    if (y >= WATER_LEVEL - 0.5) {
      continue;
    }
    stamp.acc.add(weeds[k % 4], OX + lx, y, OZ + lz, a, 1, 1, 1, 1);
  }

  // The cloud deck: four pylons and their ring, four lamps between them, nothing in the middle.
  const pylon = skyPylon();
  const lamp = seamLamp();
  const flame = seamLampGlow();
  for (let k = 0; k < 4; k++) {
    const b = SKY_B + Math.PI / 4 + (k / 4) * Math.PI * 2;
    const px = OX + DECK_CX + FRAME_R * Math.cos(b);
    const pz = OZ + DECK_CZ + FRAME_R * Math.sin(b);
    // The arc springs along the template's -z; this yaw points it at the deck's centre.
    stamp.add(pylon, px, DECK_Y, pz, Math.PI / 2 - b, FRAME_S);
    const lb = b + Math.PI / 4;
    const lx = OX + DECK_CX + (DECK_R - 3.5) * Math.cos(lb);
    const lz = OZ + DECK_CZ + (DECK_R - 3.5) * Math.sin(lb);
    stamp.add(lamp, lx, DECK_Y, lz, 0, 1);
    flames.add(flame.t, lx, DECK_Y + flame.baseY, lz, 0, 1, 1, 1, 1);
  }
  // The ring: at the arcs' end — 15 cells up and 5 in, at the pylon's scale.
  const ringR = FRAME_R - 5 * 0.6 * FRAME_S;
  const ring = frameRing(ringR / 0.6);
  stamp.acc.add(ring, OX + DECK_CX, DECK_Y + 15 * 0.6 * FRAME_S, OZ + DECK_CZ, 0, 1, 1, 1, 1);

  // The balustrade: a closed ring on the walkway, laid by the fence system.
  {
    const path: Array<{ x: number; z: number; y: number }> = [];
    const N = 96;
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2;
      path.push({
        x: OX + C + BALUSTRADE_R * Math.cos(a),
        z: OZ + C + BALUSTRADE_R * Math.sin(a),
        y: FLOOR_Y,
      });
    }
    const opts = { closed: true, maxGap: 3.6, minGap: 3 };
    fences.push(...buildFence(stamp, balustradeKit(), path, opts));
  }
  solids.build();

  // Tussocks last, refused by the field where they would stand in timber (issue #131).
  const tuftAcc = new Accum();
  tuftAcc.site = solids;
  const tufts = [0, 1, 2, 3].map((k) => grassTuft(false, k));
  const [tr, tg, tb] = swardTint(0x5c9a3a);
  const trng = mulberry32(SEED ^ 0x7f7);
  for (let k = 0; k < 220; k++) {
    const a = (-150 + trng() * 120) * RAD;
    const r = 8 + trng() * 52;
    const lx = C + r * Math.cos(a);
    const lz = C + r * Math.sin(a);
    const c: Column = { h: 0, m: Mat.Void };
    column(Math.floor(lx), Math.floor(lz), c);
    if (c.m !== Mat.Turf) {
      continue;
    }
    tuftAcc.add(tufts[k & 3], OX + lx, c.h, OZ + lz, trng() * 6.28, 0.9 + trng() * 0.5, tr, tg, tb);
  }

  const addAcc = (acc: Accum, mat: THREE.Material, shadow: boolean): void => {
    const geo = acc.toGeometry();
    if (!geo) {
      return;
    }
    geometries.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = shadow;
    mesh.receiveShadow = shadow;
    mesh.matrixAutoUpdate = false;
    fixtures.add(mesh);
  };
  addAcc(stamp.acc, propMat, true);
  addAcc(tuftAcc, propMat, false);
  addAcc(glow, redMat, false);
  addAcc(flames, lampMat, false);

  // ---- the thread: emissive strips laid in the grooves, following the ground --
  {
    const acc = new MeshAcc();
    const red = lin(THREAD_RED);
    for (const t of THREADS) {
      let prevY = PLINTH_Y;
      for (let s = PLINTH_R + 0.5; s < ANCHOR_R - 1.2; s += 1) {
        const lx = t.x + t.ux * s;
        const lz = t.z + t.uz * s;
        const y = localHeight(Math.floor(lx), Math.floor(lz));
        pushBox(acc, OX + lx, y + 0.05, OZ + lz, 0.42, 0.05, 0.42, red);
        // A riser where the ground steps, so the thread climbs a terrace rather than tunnels it.
        if (Math.abs(y - prevY) > 0.3) {
          const lo = Math.min(y, prevY);
          const hi = Math.max(y, prevY);
          const rx = OX + lx - t.ux * 0.5;
          const rz = OZ + lz - t.uz * 0.5;
          pushBox(acc, rx, (lo + hi) / 2 + 0.05, rz, 0.2, (hi - lo) / 2, 0.2, red);
        }
        prevY = y;
      }
    }
    const mesh = acc.toMesh(redMat, 0, 0);
    if (mesh) {
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      geometries.push(mesh.geometry);
      fixtures.add(mesh);
    }
  }

  // ---- the water over the bowl -----------------------------------------------
  const waterMat = createWaterMaterial();
  // No coarse far sheet here: the surface must never dissolve.
  (waterMat.uniforms["uDetailFade"].value as THREE.Vector2).set(1e7, 1e7 + 1);
  materials.push(waterMat);
  {
    const x0 = Math.floor(POOL_CX - POOL_R) - 2;
    const z0 = Math.floor(POOL_CZ - POOL_R) - 2;
    const W = Math.ceil(POOL_R * 2) + 5;
    const hh = new Float32Array((W + 1) * (W + 1));
    const dry = new Uint8Array((W + 1) * (W + 1));
    for (let iz = 0; iz <= W; iz++) {
      for (let ix = 0; ix <= W; ix++) {
        const h = localHeight(x0 + ix, z0 + iz);
        hh[iz * (W + 1) + ix] = h;
        dry[iz * (W + 1) + ix] = h >= WATER_LEVEL ? 1 : 0;
      }
    }
    // Cells to the nearest dry column, chamfered both ways then tent-blurred once —
    // the lake mesher's own recipe, on a grid small enough to do plainly.
    const SHORE_MAX = 5;
    const dist = new Float32Array((W + 1) * (W + 1));
    for (let i = 0; i < dist.length; i++) {
      dist[i] = dry[i] ? 0 : SHORE_MAX;
    }
    const S = W + 1;
    const relax = (i: number, from: number, w: number): void => {
      if (dist[from] + w < dist[i]) {
        dist[i] = dist[from] + w;
      }
    };
    for (let iz = 1; iz < S; iz++) {
      for (let ix = 1; ix < S - 1; ix++) {
        const i = iz * S + ix;
        relax(i, i - S, 1);
        relax(i, i - 1, 1);
        relax(i, i - S - 1, 1.4142);
        relax(i, i - S + 1, 1.4142);
      }
    }
    for (let iz = S - 2; iz >= 0; iz--) {
      for (let ix = S - 2; ix >= 1; ix--) {
        const i = iz * S + ix;
        relax(i, i + S, 1);
        relax(i, i + 1, 1);
        relax(i, i + S + 1, 1.4142);
        relax(i, i + S - 1, 1.4142);
      }
    }
    const tmp = new Float32Array(dist.length);
    for (let iz = 0; iz < S; iz++) {
      for (let ix = 1; ix < S - 1; ix++) {
        const i = iz * S + ix;
        tmp[i] = (dist[i - 1] + dist[i] * 2 + dist[i + 1]) * 0.25;
      }
    }
    for (let iz = 1; iz < S - 1; iz++) {
      for (let ix = 1; ix < S - 1; ix++) {
        const i = iz * S + ix;
        dist[i] = (tmp[i - S] + tmp[i] * 2 + tmp[i + S]) * 0.25;
      }
    }
    // One vertex per grid corner; depth and shore are the mean of the four columns round it.
    const pos: number[] = [];
    const nor: number[] = [];
    const dep: number[] = [];
    const sho: number[] = [];
    const lnd: number[] = [];
    const idx: number[] = [];
    const corner = (ix: number, iz: number): number => {
      const at = (jx: number, jz: number): number => {
        const cx = Math.min(S - 1, Math.max(0, jx));
        const cz = Math.min(S - 1, Math.max(0, jz));
        return cz * S + cx;
      };
      const ids = [at(ix - 1, iz - 1), at(ix, iz - 1), at(ix - 1, iz), at(ix, iz)];
      let h = 0;
      let d = 0;
      for (const j of ids) {
        h += hh[j];
        d += dist[j];
      }
      pos.push(OX + x0 + ix, 0, OZ + z0 + iz);
      nor.push(0, 1, 0);
      dep.push(SURFACE_Y - h / 4);
      sho.push(Math.min(SHORE_MAX, d / 4));
      lnd.push(0);
      return pos.length / 3 - 1;
    };
    const vid = new Int32Array(S * S).fill(-1);
    const vertex = (ix: number, iz: number): number => {
      const k = iz * S + ix;
      if (vid[k] < 0) {
        vid[k] = corner(ix, iz);
      }
      return vid[k];
    };
    for (let iz = 0; iz < W; iz++) {
      for (let ix = 0; ix < W; ix++) {
        if (dry[iz * S + ix]) {
          continue;
        }
        const a = vertex(ix, iz);
        const b = vertex(ix + 1, iz);
        const c = vertex(ix, iz + 1);
        const d = vertex(ix + 1, iz + 1);
        idx.push(a, c, d, a, d, b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute("aDepth", new THREE.Float32BufferAttribute(dep, 1));
    geo.setAttribute("aShore", new THREE.Float32BufferAttribute(sho, 1));
    geo.setAttribute("aLand", new THREE.Float32BufferAttribute(lnd, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    geometries.push(geo);
    const mesh = new THREE.Mesh(geo, waterMat);
    mesh.position.y = SURFACE_Y;
    mesh.renderOrder = 2;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.name = "seam:water";
    fixtures.add(mesh);
  }

  // ---- the sky: three lit at once ---------------------------------------------
  {
    // Inside the engine's dome (450 about the camera) from anywhere on the disc, and
    // depth-writing so the sun disc and the stars stay behind it. Vertex-coloured:
    // a deep indigo void with a warm lobe over the meadow, a teal one over the sea,
    // a pale one over the deck, and a thin bright horizon where all three meet.
    const geo = new THREE.SphereGeometry(360, 32, 16);
    const p = geo.getAttribute("position");
    const cols = new Float32Array(p.count * 3);
    const base = lin(0x1a1433);
    const under = lin(0x08070f);
    const zenith = lin(0x5f6aa8);
    const rim = lin(0xf2d7b0);
    const lobes: Array<[number, RGB]> = [
      [MEADOW_B, lin(0xe08a3a)],
      [SEA_B, lin(0x2f9aa6)],
      [SKY_B, lin(0xa79ee0)],
    ];
    for (let i = 0; i < p.count; i++) {
      const nx = p.getX(i) / 360;
      const ny = p.getY(i) / 360;
      const nz = p.getZ(i) / 360;
      const flat = Math.max(1e-4, Math.hypot(nx, nz));
      let r = base[0];
      let g = base[1];
      let b = base[2];
      const mix = (c: RGB, w: number): void => {
        r += (c[0] - r) * w;
        g += (c[1] - g) * w;
        b += (c[2] - b) * w;
      };
      for (const [bearing, c] of lobes) {
        const dot = (nx / flat) * Math.cos(bearing) + (nz / flat) * Math.sin(bearing);
        const flatness = Math.pow(1 - Math.min(1, Math.abs(ny) * 1.6), 1.6);
        const w = Math.pow(Math.max(0, dot), 2.2) * flatness * 0.9;
        mix(c, w);
      }
      mix(rim, Math.pow(1 - Math.min(1, Math.abs(ny) * 4), 6) * 0.22);
      if (ny > 0) {
        mix(zenith, Math.pow(ny, 1.4) * 0.55);
      } else {
        mix(under, Math.pow(-ny, 0.8) * 0.9);
      }
      cols[i * 3] = r;
      cols[i * 3 + 1] = g;
      cols[i * 3 + 2] = b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    geometries.push(geo);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      fog: false,
    });
    materials.push(mat);
    const sky = excludeFromAO(new THREE.Mesh(geo, mat));
    sky.position.set(OX + C, FLOOR_Y, OZ + C);
    sky.frustumCulled = false;
    sky.castShadow = false;
    sky.receiveShadow = false;
    sky.name = "seam:sky";
    fixtures.add(sky);
  }

  /**
   * FOUR point lights, the hold's count for the hold's reason (see the note on
   * its lamps: three keys a program on the visible light count, and four is the
   * count boot warmed). Here they are also the "three lit at once": a warm one
   * over the meadow, a cool one over the tide, a pale one in the frame, and the
   * thread's red at the engine. None cast a shadow.
   */
  const lights: Array<[number, number, number, number, number, number]> = [
    [0xffb066, 420, 95, C + 34 * Math.cos(MEADOW_B), FLOOR_Y + 15, C + 34 * Math.sin(MEADOW_B)],
    [0x4fd6d0, 420, 95, POOL_CX, WATER_LEVEL + 15, POOL_CZ],
    [0xdfe4ff, 320, 85, DECK_CX, DECK_Y + 13, DECK_CZ],
    [THREAD_RED, 90, 40, C, PLINTH_Y + 8, C],
  ];
  for (const [hex, intensity, distance, lx, y, lz] of lights) {
    const light = new THREE.PointLight(hex, intensity, distance, 2);
    light.position.set(OX + lx, y, OZ + lz);
    light.castShadow = false;
    fixtures.add(light);
  }
  scene.add(fixtures);

  // ---- streaming, the hold's mechanism ---------------------------------------
  const chunks = new Map<number, SeamChunk>();
  const queue: Array<{ cx: number; cz: number; d: number }> = [];
  const SPAN = GRID / CHUNK_SIZE;
  const VIEW_RADIUS = 5;
  const UNLOAD_RADIUS = VIEW_RADIUS + 1.5;
  let lastCX = Infinity;
  let lastCZ = Infinity;
  let building: SeamChunk | null = null;
  let buildBudgetLeft = 0;
  let disposed = false;
  let time = 0;

  const spawnPoint = new THREE.Vector3(OX + GATE_X, FLOOR_Y, OZ + GATE_Z);
  const playerStart = { position: spawnPoint, yaw: Math.atan2(C - GATE_X, C - GATE_Z) };

  const buildChunk = (rec: SeamChunk): void => {
    const built = buildSeamChunk(rec.cx, rec.cz, bodyMat, glassMat);
    rec.body = built.body;
    rec.glass = built.glass;
    if (rec.body) {
      scene.add(rec.body);
    }
    if (rec.glass) {
      scene.add(rec.glass);
    }
    perf.count("chunks");
  };
  const disposeChunk = (rec: SeamChunk): void => {
    for (const m of [rec.body, rec.glass]) {
      if (m) {
        scene.remove(m);
        m.geometry.dispose();
      }
    }
    rec.body = null;
    rec.glass = null;
  };
  const refreshQueue = (fcx: number, fcz: number): void => {
    queue.length = 0;
    const lim = (VIEW_RADIUS + 0.35) * (VIEW_RADIUS + 0.35);
    for (let dz = -VIEW_RADIUS; dz <= VIEW_RADIUS; dz++) {
      for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
        const d = dx * dx + dz * dz;
        if (d > lim) {
          continue;
        }
        const cx = fcx + dx;
        const cz = fcz + dz;
        if (cx < 0 || cz < 0 || cx >= SPAN || cz >= SPAN) {
          continue;
        }
        if (!chunks.has(key(cx, cz))) {
          queue.push({ cx, cz, d });
        }
      }
    }
    queue.sort((a, b) => a.d - b.d);
  };
  const unloadFar = (fcx: number, fcz: number): void => {
    const lim = UNLOAD_RADIUS * UNLOAD_RADIUS;
    for (const [k, rec] of chunks) {
      const dx = rec.cx - fcx;
      const dz = rec.cz - fcz;
      if (dx * dx + dz * dz > lim) {
        if (building === rec) {
          building = null;
        }
        disposeChunk(rec);
        chunks.delete(k);
      }
    }
  };
  const structureTop = (x: number, z: number): number => solids.topAt(x, z);
  const inDisc = (x: number, z: number): boolean => Math.hypot(x - OX - C, z - OZ - C) <= DISC_R;

  return {
    waterLevel: WATER_LEVEL,
    spawnPoint,
    playerStart,
    waypoints: null,
    lamps: null,
    tamingPen: null,
    portOf: () => null,
    mooringOf: () => null,
    descents: [],
    shopPositions: [],
    towns: { all: [], roads: [], get: () => undefined, nearest: () => null },
    safeZones: NO_SAFE_ZONES,
    npcs: null,
    carriers: NO_CARRIERS,
    debugSpawn: null,
    get chunksLoaded(): number {
      return chunks.size;
    },
    get streaming(): boolean {
      return building !== null || queue.length > 0;
    },
    get pendingChunks(): number {
      return queue.length + (building !== null ? 1 : 0);
    },

    getHeight: heightAt,
    /** Everything solid is climbable, as the contract says — the terraces, the machine, the rail. */
    climbTopAt(x: number, z: number): number {
      const g = heightAt(x, z);
      const s = structureTop(x, z);
      return s > g ? s : g;
    },
    /** The oaks' boles are in the structure field (issue #80's rule), so nothing is here. */
    trunkSolidTopAt(): number {
      return -Infinity;
    },
    structureTopAt: structureTop,
    foliageSite: solids,
    crownContactAt(): boolean {
      return false;
    },
    isWater(x: number, z: number): boolean {
      return inDisc(x, z) && heightAt(x, z) < WATER_LEVEL;
    },
    /** A bowl two to three units deep has no deep sea in it. */
    isDeepWater(): boolean {
      return false;
    },
    snowCoverAt(): number {
      return 0;
    },
    /** No biome, so no wild population: what stands here is what the finale stages. */
    biomeAt(): string {
      return "";
    },
    disturb(): void {
      /* the tussocks here are rigid */
    },
    debugColliders(): void {
      /* the boles are boxes in the structure field */
    },
    debugStructures(out: number[]): void {
      solids.debugBoxes(out);
    },
    debugWear: () => 0,
    debugColumn: heightAt,
    pathRunCrosses: () => false,
    pathRunHitsBuilt: () => false,
    debugPaths: () => ({ paths: [], at: null }),
    debugPathRibbons: () => false,
    debugCarriedStreets: () => ({ count: 0, paved: 0, clear: [] }),
    addPath: () => ({
      id: "",
      length: 0,
      samples: 0,
      note: null,
      nodes: [],
      refused: [],
      crossings: 0,
      error: "this zone has no path network",
    }),
    debugRidges(out: number[]): void {
      solids.debugRidges(out);
    },
    debugFurniture(): Array<{ kind: string; x: number; z: number }> {
      return [];
    },
    /** The balustrade and the meadow's broken run, in the fence system's own shape. */
    debugFences(): ReturnType<World["debugFences"]> {
      return fences.map((f) => ({
        posts: f.posts.map((p) => ({ x: p.x, z: p.z, y: p.y, base: p.base, kind: p.kind })),
        closed: f.closed,
        bays: f.bays.map((b) => ({ ...b })),
      }));
    },
    debugCarriedTrees(): Array<{ x: number; z: number }> {
      return [];
    },

    /**
     * A FIXED twilight. The sun still moves the key light (the engine owns that,
     * and a light count or direction of this zone's own would key new programs
     * — see the lamps above), so what is pinned is the water's glint and the fog:
     * the engine writes `fog.color` from the celestial filter every frame, and
     * this runs after it and writes the void's indigo over it. It is an
     * ABSORPTION multiplier on the sky ramp (core/engine.ts), so the far rim
     * hazes to deep indigo and the void reads as depth.
     */
    applyCelestial(state: Readonly<CelestialState>): void {
      waterMat.uniforms["uSunDir"].value.copy(state.keyDirection);
      waterMat.uniforms["uSunColor"].value.copy(state.keyColor);
      waterMat.uniforms["uSunStrength"].value = state.keyIntensity / 3.05;
      scene.fog?.color.setRGB(0.2, 0.13, 0.4);
    },

    update(focus: THREE.Vector3, dt: number, newFrame = true): void {
      if (disposed) {
        return;
      }
      time += dt;
      waterMat.uniforms["uTime"].value = time;
      (waterMat.uniforms["uFocus"].value as THREE.Vector2).set(focus.x, focus.z);
      if (newFrame) {
        buildBudgetLeft = BUILD_BUDGET_MS;
      }
      const fcx = Math.floor((focus.x - OX) / CHUNK_SIZE);
      const fcz = Math.floor((focus.z - OZ) / CHUNK_SIZE);
      if (fcx !== lastCX || fcz !== lastCZ) {
        lastCX = fcx;
        lastCZ = fcz;
        refreshQueue(fcx, fcz);
        unloadFar(fcx, fcz);
      }
      while (buildBudgetLeft > 0 && queue.length > 0) {
        const t0 = performance.now();
        const q = queue.shift()!;
        const k = key(q.cx, q.cz);
        if (chunks.has(k)) {
          continue;
        }
        const rec: SeamChunk = { cx: q.cx, cz: q.cz, body: null, glass: null };
        chunks.set(k, rec);
        building = rec;
        buildChunk(rec);
        building = null;
        buildBudgetLeft -= performance.now() - t0;
      }
    },

    setLayerVisible(): void {
      /* no streamed layers */
    },
    setFoliageDistance(): void {
      /* the tussocks are fixtures */
    },
    setTerrainDistance(): void {
      /* a disc has no far landscape */
    },
    debugDistantTerrain(): null {
      return null;
    },
    warmUpEffects(): void {
      /* the seam owns no effect the boot sweep does not already draw */
    },
    debugSkyFall(): null {
      return null;
    },
    rebuildProps(): void {
      /* nothing grows here */
    },

    setVisible(v: boolean): void {
      for (const rec of chunks.values()) {
        if (rec.body) {
          rec.body.visible = v;
        }
        if (rec.glass) {
          rec.glass.visible = v;
        }
      }
      // The four lights live under `fixtures`: this is what takes them out of the count.
      fixtures.visible = v;
    },

    disposeStep(): boolean {
      if (disposed) {
        return true;
      }
      let n = 6;
      for (const [k, rec] of chunks) {
        if (n <= 0) {
          return false;
        }
        n--;
        if (building === rec) {
          building = null;
        }
        disposeChunk(rec);
        chunks.delete(k);
      }
      this.dispose();
      return true;
    },

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const rec of chunks.values()) {
        disposeChunk(rec);
      }
      chunks.clear();
      queue.length = 0;
      scene.remove(fixtures);
      for (const g of geometries) {
        g.dispose();
      }
      for (const m of materials) {
        m.dispose();
      }
    },
  };
}
