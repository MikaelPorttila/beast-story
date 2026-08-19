/**
 * TOWN PARTS — voxel BUILDERS for settlements and roads; placement is towns.ts.
 *
 * NO NEW MATERIALS (a first-use shader link stalls the GPU process): solid pieces
 * bake to a `Template` on PropLib's `solidMat`, the ribbon to the terrain
 * material, every glow to one shared emissive material. NO POINT LIGHTS — three
 * keys a program on the visible light count. `bakeSolid` measures the collider
 * off the voxels just painted; `bakeProp` is for what a body passes through.
 */
import { VoxelModel, shade } from "../core/voxel";
import { bakeProp, type Template } from "./props";
import type { SolidStamp } from "./structures";
import { bakeSolid, measurePlatform } from "./structures";
import { buildFence, type Fence, type FenceParts } from "./fences";
import { builtDeck, type Junction, type Road, type RoadSample } from "./roads";
import { type PathProfile } from "./path-profile";
import { WATER_LEVEL } from "./terrain";
import { hashCell } from "./noise";

/** World units per voxel for everything in this file. */
export const V = 0.28;

/** The palisade template's unscaled length along its own +z, in world units. */
export const PALISADE_SPAN_LEN = 15 * V;

/** Fit whole palisade templates end to end; fitting the LENGTH keeps two runs'
 *  outer faces off one plane (issue #128). */
export function fitPalisadeRun(
  length: number,
  scale: number,
): {
  count: number;
  pitch: number;
  lengthScale: number;
} {
  const count = Math.max(1, Math.ceil(length / (PALISADE_SPAN_LEN * scale)));
  const pitch = length / count;
  return { count, pitch, lengthScale: pitch / PALISADE_SPAN_LEN };
}

const LOG = 0x6b4a2e;
const LOG_PALE = 0x8a6a42;
const PLANK = 0x9d7346;
const PLANK_DARK = 0x74532f;
const TIMBER = 0x5a3f26;
const CANVAS = 0xcfc0a0;
const CANVAS_DARK = 0xa8977a;
const CANVAS_RED = 0x9c4c3e;
const CANVAS_BLUE = 0x4c6a8c;
const THATCH = 0xb59a5c;
const THATCH_DARK = 0x8f7745;
/** The hut's straw: warmer than the well's pair, which went olive under the sky fill. */
const THATCH_GOLD = 0xd2a650;
const THATCH_SHADE = 0x8f6a34;
/** The hut's masonry: ROCK is a cool grey that reads as ice under a warm wall. */
const STONE = 0x7e705c;
const STONE_DARK = 0x5e5245;
/** Hut ironmongery: IRON goes slate-blue under the sky fill. */
const IRON_DARK = 0x3a3532;
const ROCK = 0x8b8c92;
const ROCK_DARK = 0x6c6d73;
const IRON = 0x4b4b53;
const ROPE = 0xb9a06a;
const SOOT = 0x33302c;
/** Glow albedos. These ride the emissive material — see towns.ts `glowMat`. */
const EMBER = 0xff7a24;
const FLAME = 0xffc247;
const FLAME_PALE = 0xffe9a8;

// A 3x5 bitmap font: voxel letters cost no material and no extra triangles.
const FONT: Record<string, readonly string[]> = {
  A: [".#.", "#.#", "###", "#.#", "#.#"],
  B: ["##.", "#.#", "##.", "#.#", "##."],
  C: [".##", "#..", "#..", "#..", ".##"],
  D: ["##.", "#.#", "#.#", "#.#", "##."],
  E: ["###", "#..", "##.", "#..", "###"],
  F: ["###", "#..", "##.", "#..", "#.."],
  G: [".##", "#..", "#.#", "#.#", ".##"],
  H: ["#.#", "#.#", "###", "#.#", "#.#"],
  I: ["###", ".#.", ".#.", ".#.", "###"],
  J: ["..#", "..#", "..#", "#.#", ".#."],
  K: ["#.#", "#.#", "##.", "#.#", "#.#"],
  L: ["#..", "#..", "#..", "#..", "###"],
  M: ["#.#", "###", "###", "#.#", "#.#"],
  N: ["#.#", "###", "###", "###", "#.#"],
  O: [".#.", "#.#", "#.#", "#.#", ".#."],
  P: ["##.", "#.#", "##.", "#..", "#.."],
  Q: [".#.", "#.#", "#.#", "##.", ".##"],
  R: ["##.", "#.#", "##.", "#.#", "#.#"],
  S: [".##", "#..", ".#.", "..#", "##."],
  T: ["###", ".#.", ".#.", ".#.", ".#."],
  U: ["#.#", "#.#", "#.#", "#.#", ".#."],
  V: ["#.#", "#.#", "#.#", "#.#", ".#."],
  W: ["#.#", "#.#", "###", "###", "#.#"],
  X: ["#.#", "#.#", ".#.", "#.#", "#.#"],
  Y: ["#.#", "#.#", ".#.", ".#.", ".#."],
  Z: ["###", "..#", ".#.", "#..", "###"],
  "0": [".#.", "#.#", "#.#", "#.#", ".#."],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["##.", "..#", ".#.", "#..", "###"],
  "3": ["##.", "..#", ".#.", "..#", "##."],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "##.", "..#", "##."],
  "6": [".##", "#..", "##.", "#.#", ".#."],
  "7": ["###", "..#", ".#.", ".#.", ".#."],
  "8": [".#.", "#.#", ".#.", "#.#", ".#."],
  "9": [".#.", "#.#", ".##", "..#", "##."],
  "-": ["...", "...", "###", "...", "..."],
  "'": [".#.", ".#.", "...", "...", "..."],
  " ": ["...", "...", "...", "...", "..."],
};
/** Glyph columns including the one-column gap that follows. */
const GLYPH_ADV = 4;

/** Fold to what FONT can carve. Unknown glyphs are dropped, not blanked — a hole
 *  mid-word reads as a rendering bug. */
export function signText(text: string): string {
  let out = "";
  const folded = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
  for (const ch of folded) {
    if (ch in FONT) {
      out += ch;
    }
  }
  return out;
}

export function labelWidth(text: string): number {
  return text.length * GLYPH_ADV - 1;
}

/** Repaint `text` in the y/z plane at x = `face`, top row `y0`, along +z from
 *  `z0`. `mirror` makes the board read from the other side. */
function letters(
  v: VoxelModel,
  text: string,
  face: number,
  y0: number,
  z0: number,
  color: number,
  mirror: boolean,
): void {
  const w = labelWidth(text);
  for (let ci = 0; ci < text.length; ci++) {
    const g = FONT[text[ci]] ?? FONT[" "];
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (g[row][col] !== "#") {
          continue;
        }
        const u = ci * GLYPH_ADV + col;
        v.set(face, y0 - row, z0 + (mirror ? w - 1 - u : u), color);
      }
    }
  }
}

/** Grid offset for every glow piece, in voxels. A glow cannot share a VoxelModel
 *  with its body (different material), so culling cannot run across the pair and
 *  both emit a face on every shared plane; yaw cannot part them (+Y stays +Y). */
export const GLOW_PART = 0.08;

/** Bake, then shift by (dx, dy, dz) WORLD units and off the body's face grid.
 *  `bake` re-bases each model on its OWN bounds, so a flame sitting in a bowl
 *  came out with its base at the ground. */
function bakeAt(model: VoxelModel, scale: number, dx: number, dy: number, dz: number): Template {
  const t = bakeProp(model, scale);
  const part = GLOW_PART * scale;
  for (let i = 0; i < t.pos.length; i += 3) {
    t.pos[i] += dx + part;
    t.pos[i + 1] += dy + part;
    t.pos[i + 2] += dz + part;
  }
  return t;
}

// Per-builder noise: its own stream each, so adding one never reshuffles the rest.
function rnd(seed: number): () => number {
  let n = seed >>> 0;
  return (): number => {
    n = (n * 1664525 + 1013904223) >>> 0;
    return ((n >>> 9) & 0xffff) / 0x10000;
  };
}

/** One 4.2-unit run of log palisade along +z, OUTSIDE at -x. Solid, not separate
 *  stakes: contiguous boxes cull the faces between them. */
function palisadeSpan(): Template {
  const v = new VoxelModel();
  const r = rnd(0x51a7);
  for (let z = 0; z < 15; z += 2) {
    const h = 9 + Math.floor(r() * 3);
    const c = shade(LOG, 0.8 + r() * 0.36);
    v.box(0, 0, z, 1, h, z + 1, c);
    v.set(0, h + 1, z, shade(c, 1.12));
    v.set(1, h + 1, z + 1, shade(c, 0.9));
    v.set(0, h + 2, z, shade(c, 1.2));
  }
  // SILL LOG outside so the wall grows out of the ground; geometric, not material.
  v.box(2, 5, 0, 2, 5, 14, shade(PLANK_DARK, 1.05));
  v.box(-1, 0, 0, -1, 1, 14, shade(LOG, 0.72));
  for (let z = 1; z < 14; z += 5) {
    v.set(2, 6, z, ROPE);
  }
  return bakeSolid(v, V);
}

/** The post a square wall turns on. Not structural — two runs meeting at a
 *  corner already overlap — but butt-jointed log ends read as two fences. */
function cornerPost(): Template {
  const v = new VoxelModel();
  const r = rnd(0x6c17);
  const H = 13;
  for (let y = 0; y <= H; y++) {
    const c = shade(LOG, 0.76 + r() * 0.3);
    v.box(-1, y, -1, 1, y, 1, c);
  }
  v.box(0, H + 1, -1, 0, H + 1, 1, shade(LOG, 1.14));
  v.box(-1, H + 1, 0, 1, H + 1, 0, shade(LOG, 1.14));
  v.set(0, H + 2, 0, shade(LOG, 1.22));
  return bakeSolid(v, V);
}

function gateArch(): Template {
  const v = new VoxelModel();
  const r = rnd(0x77c3);
  const H = 17;
  for (const z of [0, 26]) {
    v.box(-2, 0, z, 2, H, z + 3, shade(TIMBER, 0.95));
    for (let y = 0; y <= H; y += 3) {
      v.box(-2, y, z, 2, y, z + 3, shade(TIMBER, 0.82 + r() * 0.3));
    }
    v.box(-3, H + 1, z - 1, 3, H + 2, z + 4, shade(LOG, 1.06));
  }
  v.box(-1, H + 1, 3, 1, H + 3, 25, shade(LOG, 0.98));
  v.box(-1, H - 2, 3, 1, H - 2, 6, shade(TIMBER, 0.9));
  v.box(-1, H - 2, 22, 1, H - 2, 25, shade(TIMBER, 0.9));
  for (let z = 9; z <= 19; z++) {
    for (let y = H - 6; y <= H; y++) {
      v.set(-2, y, z, shade(y === H ? CANVAS : CANVAS_RED, 0.9 + r() * 0.2));
    }
  }
  v.box(-2, H - 7, 11, -2, H - 7, 17, shade(CANVAS, 1.1));
  for (const [z0, z1] of [
    [4, 8],
    [21, 25],
  ]) {
    for (let z = z0; z <= z1; z++) {
      v.box(3, 0, z, 4, 13, z, shade(PLANK, 0.84 + r() * 0.3));
    }
    v.box(3, 4, z0, 4, 4, z1, IRON);
    v.box(3, 10, z0, 4, 10, z1, IRON);
  }
  return bakeSolid(v, V);
}

function watchPost(): Template {
  const v = new VoxelModel();
  const H = 16;
  for (const [x, z] of [
    [-2, -2],
    [1, -2],
    [-2, 1],
    [1, 1],
  ]) {
    v.box(x, 0, z, x + 1, H, z + 1, shade(TIMBER, 0.92));
  }
  v.box(-4, H + 1, -4, 3, H + 1, 3, shade(PLANK, 1.0));
  for (let k = -3; k <= 3; k += 2) {
    v.set(k, H + 2, -4, PLANK_DARK);
    v.set(k, H + 2, 3, PLANK_DARK);
    v.set(-4, H + 2, k, PLANK_DARK);
    v.set(3, H + 2, k, PLANK_DARK);
  }
  v.box(-4, H + 3, -4, 3, H + 3, -4, shade(LOG, 0.95));
  for (let y = 1; y < H; y += 2) {
    v.box(-3, y, 2, 0, y, 2, shade(ROPE, 0.9));
  }
  return bakeSolid(v, V);
}

/** A ridge tent, mouth on +z; `hue` picks the stripe. The canvas is a filled BAND
 *  per rib: the roof drops 1.3 voxels per voxel of width, so a one-cell sheet
 *  would have daylight through it. */
function ridgeTent(hue: number, len: number): Template {
  const v = new VoxelModel();
  const r = rnd(0x2f11 + hue * 977);
  const stripe = [CANVAS_RED, CANVAS_BLUE, CANVAS_DARK][hue % 3];
  const W = 7; // half-width at the eaves, voxels
  const A = 9; // apex height, voxels
  const prof = (k: number): number => Math.round(A * (1 - k / (W + 0.6)));
  // A tent is ALL ROOF: bracketed, so its collider is one cylinder along the pole
  // (see `measureRidge`). Pegs stay outside the bracket or they widen the span.
  const canvas = v.region(() => {
    for (let z = 0; z <= len; z++) {
      const sag = z > len - 3 ? 1 : 0;
      for (let k = 0; k <= W; k++) {
        const yTop = Math.max(0, prof(k) - sag);
        const yBot = k === W ? 0 : Math.max(0, prof(k + 1) - sag + 1);
        for (let y = Math.min(yBot, yTop); y <= yTop; y++) {
          const c = (z + k + y) % 8 === 0 ? stripe : CANVAS;
          v.set(-k, y, z, shade(c, 0.86 + r() * 0.26));
          v.set(k, y, z, shade(c, 0.86 + r() * 0.26));
        }
      }
      v.set(0, prof(0) - sag, z, shade(CANVAS, 1.14));
    }
    v.box(0, A + 1, -1, 0, A + 1, len + 1, shade(LOG, 0.95));
    for (let k = -3; k <= 3; k++) {
      for (let y = 0; y <= 4; y++) {
        v.set(k, y, len, shade(SOOT, 1.0));
      }
    }
  });
  for (const z of [0, len]) {
    v.set(-W - 1, 0, z, shade(IRON, 1.0));
    v.set(W + 1, 0, z, shade(IRON, 1.0));
  }
  return bakeSolid(v, V, canvas);
}

function bellTent(): Template {
  const v = new VoxelModel();
  const r = rnd(0x9c41);
  const R = 7;
  const H = 12;
  for (let y = 0; y <= H; y++) {
    const rr = R * (1 - y / (H + 1.5));
    const outer = (rr + 0.4) * (rr + 0.4);
    const inner = Math.max(0, rr - 1.1) * Math.max(0, rr - 1.1);
    for (let x = -R; x <= R; x++) {
      for (let z = -R; z <= R; z++) {
        const d2 = x * x + z * z;
        if (d2 > outer || (y > 0 && d2 < inner)) {
          continue;
        }
        const c = (x + z + y) % 9 === 0 ? CANVAS_DARK : CANVAS;
        v.set(x, y, z, shade(c, 0.84 + r() * 0.28));
      }
    }
  }
  v.box(0, H + 1, 0, 0, H + 3, 0, shade(LOG, 1.0));
  v.set(0, H + 4, 0, shade(CANVAS_RED, 1.15));
  for (let y = 0; y <= 5; y++) {
    for (let x = -2; x <= 2; x++) {
      v.set(x, y, R - 1, SOOT);
    }
  }
  return bakeSolid(v, V);
}

/** Thatch value by two-voxel straw column; `+45` keeps the modulo positive on the -x half. */
function strawStreak(x: number): number {
  return 0.86 + (((Math.floor(x / 2) * 7 + 45) % 5) / 5) * 0.22;
}

/** Where a hut's night pane goes, in world units from the template origin: along the
 *  hut's own +x, up from its base, and out along its +z to just inside the wall plane. */
export interface HutWindow {
  side: number;
  height: number;
  front: number;
}

/** Timber-framed hut with a thatch roof. `kind`: 0 stores, 1 quarters, 2 smithy
 *  (whose coals are a separate glow piece). */
function hut(kind: 0 | 1 | 2): { part: Template; window: HutWindow } {
  const v = new VoxelModel();
  const r = rnd(0x1d77 + kind * 613);
  const W = 8; // half-width
  const D = 7; // half-depth
  const H = 9;
  const timber = (): number => shade(TIMBER, 0.9 + r() * 0.18);
  // Horizontal boards: three quantised shades per course, so the wall reads as
  // stacked planks at distance; per-voxel jitter only smears that.
  const BOARD = [0.84, 0.96, 1.08];
  const course: number[] = [];
  for (let y = 0; y <= H; y++) {
    course.push(y % 4 === 1 ? 0.76 : BOARD[Math.floor(r() * 3)]);
  }
  const doorHalf = kind === 2 ? 4 : 3; // the smithy's door is a workshop mouth
  for (let x = -W; x <= W; x++) {
    for (let z = -D; z <= D; z++) {
      if (x !== -W && x !== W && z !== -D && z !== D) {
        continue;
      }
      const corner = (x === -W || x === W) && (z === -D || z === D);
      const long = z === -D || z === D;
      const stud = (long && (x === -4 || x === 4)) || (!long && z === 0);
      const rail = long && Math.abs(x) < W && !(z === D && x >= -7 && x <= doorHalf);
      for (let y = 0; y <= H; y++) {
        // The door and window openings are left empty here; the leaf and the recess sit a
        // voxel behind them.
        const door = Math.abs(x) < doorHalf && y >= 1 && y <= 5;
        const win = x >= -6 && x <= -5 && y >= 3 && y <= 5;
        if (z === D && (door || win)) {
          continue;
        }
        if (y === 0 || (corner && y === 1)) {
          const block = y === 0 && Math.floor((x + z + 40) / 2) % 2 === 0;
          v.set(x, y, z, shade(block ? STONE : STONE_DARK, 0.86 + r() * 0.26));
        } else if (corner || stud || y === H || (rail && y === 5)) {
          v.set(x, y, z, timber());
        } else {
          v.set(x, y, z, shade(PLANK, course[y]));
        }
      }
    }
  }
  // Wall plate one course above the wall, so no slot shows between wall and eave.
  v.box(-W, H + 1, -D, W, H + 1, -D, shade(TIMBER, 0.95));
  v.box(-W, H + 1, D, W, H + 1, D, shade(TIMBER, 0.95));
  // Doorway: frame on the face, the leaf one voxel back so the opening has depth.
  v.box(-doorHalf, 1, D, -doorHalf, 6, D, shade(TIMBER, 1.0));
  v.box(doorHalf, 1, D, doorHalf, 6, D, shade(TIMBER, 1.0));
  v.box(-doorHalf, 6, D, doorHalf, 6, D, shade(TIMBER, 1.15));
  v.set(-doorHalf, 6, D, shade(LOG_PALE, 1.0));
  v.set(doorHalf, 6, D, shade(LOG_PALE, 1.0));
  v.box(-doorHalf, 0, D, doorHalf, 0, D, shade(STONE_DARK, 0.9));
  // The smithy's leaf is the dark of an open workshop mouth; the others a ledged door of
  // vertical boards, strapped on the hinge side.
  for (let x = -doorHalf + 1; x <= doorHalf - 1; x++) {
    const board = shade(PLANK_DARK, 0.88 + r() * 0.14);
    for (let y = 1; y <= 5; y++) {
      v.set(x, y, D - 1, kind === 2 ? SOOT : board);
    }
  }
  if (kind !== 2) {
    v.box(-doorHalf + 1, 2, D - 1, 0, 2, D - 1, IRON_DARK);
    v.box(-doorHalf + 1, 4, D - 1, 0, 4, D - 1, IRON_DARK);
    v.set(1, 3, D - 1, shade(LOG_PALE, 0.9));
  }
  // A window beside the door: sill and lintel, both shutters swung back flat against the
  // wall, the opening recessed on the dark. The night pane (`hutWindow`) sits in it.
  v.box(-7, 2, D, -4, 2, D, timber());
  v.box(-7, 6, D, -4, 6, D, timber());
  v.box(-7, 3, D, -7, 5, D, shade(PLANK, 1.05));
  v.box(-4, 3, D, -4, 5, D, shade(PLANK, 1.05));
  v.box(-6, 3, D - 1, -5, 5, D - 1, SOOT);
  // Gables: a tie beam, paired vertical boards, a king post with two struts — an A-truss
  // drawn on the wall — filling the triangle up to the roof's underside.
  for (const gx of [-W, W]) {
    for (let z = -D; z <= D; z++) {
      const pair = Math.floor((z + D) / 2);
      const boardShade = (pair % 2 === 0 ? 0.84 : 1.02) + r() * 0.06;
      const top = H + 1 + D - Math.abs(z);
      for (let y = H + 1; y <= top; y++) {
        const az = Math.abs(z);
        const strut = az >= 1 && az <= 3 && (y === H + 1 + az || y === H + 2 + az);
        const frame = z === 0 || az === D || strut;
        const c = y === H + 1 ? shade(LOG_PALE, 0.95) : frame ? timber() : shade(PLANK, boardShade);
        v.set(gx, y, z, c);
      }
    }
  }
  // What each gable carries tells the three kinds apart at distance: the stores' loft
  // hatch, the quarters' lit pane, and a louvre where smoke has to get out.
  const louvre = (gx: number): void => {
    v.box(gx, H + 4, -2, gx, H + 7, 2, timber());
    for (let y = H + 5; y <= H + 6; y++) {
      v.box(gx, y, -1, gx, y, 1, y === H + 5 ? SOOT : shade(PLANK_DARK, 0.8));
    }
  };
  if (kind === 0) {
    v.box(W, H + 2, -2, W, H + 5, 2, timber());
    v.box(W, H + 2, -1, W, H + 4, 1, shade(PLANK_DARK, 0.9));
    v.set(W, H + 3, -2, IRON_DARK);
    louvre(-W);
  } else if (kind === 1) {
    v.box(W, H + 2, -2, W, H + 5, 2, timber());
    v.box(W, H + 3, -1, W, H + 4, 1, shade(FLAME_PALE, 0.95));
  } else {
    louvre(W);
  }
  // Thatch bracketed: its collider is a ridge cylinder, not a box (`measureRidge`).
  // Each course is a filled two-voxel band: one cell per step had daylight through it.
  // Straw runs DOWN the slope, so value varies by column and never by course.
  const slope = (x: number, y: number, z: number, edge: boolean): void => {
    const s = strawStreak(x) * ((x * 5 + 43) % 7 === 0 ? 0.9 : 1.0);
    // Both cells one colour: the baked shade already parts tread from riser.
    const c = edge ? shade(THATCH_SHADE, 0.82 * s) : shade(THATCH_GOLD, s);
    v.set(x, y, z, c);
    v.set(x, y + 1, z, c);
  };
  const thatch = v.region(() => {
    for (let k = 0; k <= D + 1; k++) {
      for (let x = -W - 1; x <= W + 1; x++) {
        slope(x, H + 1 + k, -(D + 1 - k), false);
        slope(x, H + 1 + k, D + 1 - k, false);
      }
    }
    // A rolled ridge with its spars flush in it: upright spars read as crenellations,
    // dark ones on the golden slope read as holes, and a second course proud of the
    // slope costs the ridge cylinder its fit (`test-structures` roofFit).
    for (let x = -W - 1; x <= W + 1; x++) {
      v.set(x, H + D + 4, 0, shade(THATCH_SHADE, 0.96 + r() * 0.1));
    }
    for (let x = -W + 1; x <= W - 1; x += 4) {
      v.set(x, H + D + 4, 0, shade(LOG_PALE, 1.0));
    }
  });
  // The dark verge and the kicked eave course, one voxel proud of the bracket on every
  // side: the cue that says thatch rather than tile. Painted OUTSIDE the region so the
  // ridge cylinder keeps the extent it had, and with it every spot the camp's NPC ring
  // search settled on (test-content pins Gain); a 0.28 lip nobody can stand on is not
  // worth moving a character for.
  for (let k = 0; k <= D + 1; k++) {
    for (const gx of [-W - 2, W + 2]) {
      slope(gx, H + 1 + k, -(D + 1 - k), true);
      slope(gx, H + 1 + k, D + 1 - k, true);
    }
  }
  v.set(-W - 2, H + D + 4, 0, shade(THATCH_SHADE, 0.82));
  v.set(W + 2, H + D + 4, 0, shade(THATCH_SHADE, 0.82));
  for (let x = -W - 2; x <= W + 2; x++) {
    v.set(x, H + 1, -(D + 2), shade(THATCH_GOLD, 0.9 * strawStreak(x)));
    v.set(x, H + 1, D + 2, shade(THATCH_GOLD, 0.9 * strawStreak(x)));
  }
  if (kind === 0) {
    v.box(-6, 4, -D, -3, 6, -D, shade(PLANK_DARK, 1.0));
    v.box(3, 4, -D, 6, 6, -D, shade(PLANK_DARK, 1.0));
    // A firewood stack, one log per (y, z) as `woodpile` lays them, ragged on top, under
    // boards held down by a pole.
    for (let y = 0; y <= 2; y++) {
      for (let z = -3; z <= 3; z++) {
        if (y === 2 && (Math.abs(z) === 3 || r() < 0.25)) {
          continue;
        }
        v.box(W + 1, y, z, W + 3, y, z, shade(y % 2 === 0 ? LOG : LOG_PALE, 0.82 + r() * 0.36));
      }
    }
    v.box(W + 1, 3, -3, W + 3, 3, 3, shade(PLANK_DARK, 0.9));
    v.box(W + 4, 3, -3, W + 4, 3, 3, shade(LOG, 0.95));
  } else {
    // Chimney: a breast below the eave, a stack above, in running-bond stone (one shade
    // per stone, no jitter within one), damp at the foot, the smithy's blackened by its fire.
    for (let y = 0; y <= H + D + 4; y++) {
      const z1 = y > H + 1 ? 0 : 1;
      // The stack lives on the shade side, where the sky fill eats its value.
      const lift = y > H + 1 ? 1.15 : 1.0;
      let stoneShade = lift * (0.76 + r() * 0.44);
      let stoneId = -1;
      for (let z = -1; z <= z1; z++) {
        const id = Math.floor((z + 3 + (y % 2)) / 2);
        if (id !== stoneId) {
          stoneId = id;
          stoneShade = lift * (0.76 + r() * 0.44);
        }
        for (let x = -W - 2; x <= -W - 1; x++) {
          const soot = kind === 2 && y >= H + D + 2;
          const c = soot ? SOOT : y <= 1 ? STONE_DARK : STONE;
          v.set(x, y, z, shade(c, stoneShade));
        }
      }
    }
    v.box(-W - 3, H + D + 5, -2, -W, H + D + 5, 1, shade(kind === 2 ? SOOT : STONE, 1.2));
    v.box(-W - 2, H + D + 5, -1, -W - 1, H + D + 5, 0, SOOT);
  }
  if (kind === 2) {
    v.box(4, 0, D + 3, 6, 0, D + 5, shade(TIMBER, 0.9));
    v.box(4, 1, D + 3, 6, 2, D + 5, shade(IRON_DARK, 1.1));
    v.box(4, 3, D + 4, 7, 3, D + 4, shade(IRON_DARK, 1.3));
  }
  // The origin is the bounds' centre and each kind's bounds differ (lean-to, anvil), so
  // the pane's seat is measured here rather than guessed at the call site.
  const b = v.bounds();
  const window: HutWindow = {
    side: (-5 - b.ox) * V,
    height: 4.5 * V - 0.22,
    front: (D + 1 - b.oz) * V - 0.16,
  };
  return { part: bakeSolid(v, V, thatch), window };
}

function cart(hooded: boolean): Template {
  const v = new VoxelModel();
  const r = rnd(hooded ? 0x4411 : 0x8ac2);
  v.box(-4, 4, -7, 4, 5, 7, shade(PLANK, 0.92));
  for (let z = -7; z <= 7; z += 2) {
    v.box(-4, 6, z, 4, 6, z, shade(PLANK_DARK, 1.0));
  }
  v.box(-5, 4, -7, -5, 8, 7, shade(PLANK_DARK, 0.95));
  v.box(5, 4, -7, 5, 8, 7, shade(PLANK_DARK, 0.95));
  v.box(-4, 4, -8, 4, 9, -8, shade(PLANK, 0.88));
  for (const x of [-6, 5]) {
    for (let a = 0; a < 22; a++) {
      const ang = (a / 22) * Math.PI * 2;
      const wy = 4 + Math.round(Math.sin(ang) * 4);
      const wz = Math.round(Math.cos(ang) * 4);
      v.set(x, wy, wz, shade(TIMBER, 0.9));
      v.set(x + (x < 0 ? 1 : -1), wy, wz, shade(TIMBER, 0.82));
    }
    for (let k = -3; k <= 3; k++) {
      v.set(x, 4 + k, 0, shade(LOG_PALE, 0.95));
      v.set(x, 4, k, shade(LOG_PALE, 0.95));
    }
  }
  for (let k = 0; k <= 6; k++) {
    v.set(-3, 4 - Math.round(k * 0.62), 8 + k, shade(LOG, 0.95));
    v.set(3, 4 - Math.round(k * 0.62), 8 + k, shade(LOG, 0.95));
  }
  if (hooded) {
    for (let z = -6; z <= 6; z++) {
      for (let k = 0; k <= 5; k++) {
        const y = 9 + Math.round(Math.sin((k / 5) * Math.PI * 0.5) * 4);
        v.set(-5 + k, y, z, shade(CANVAS, 0.86 + r() * 0.26));
        v.set(5 - k, y, z, shade(CANVAS, 0.86 + r() * 0.26));
      }
    }
  } else {
    v.box(-3, 6, -5, -1, 8, -2, shade(ROPE, 0.9));
    v.box(0, 6, 1, 3, 8, 5, shade(PLANK_DARK, 1.0));
  }
  return bakeSolid(v, V);
}

function barrel(): Template {
  const v = new VoxelModel();
  const r = rnd(0x6621);
  for (let y = 0; y <= 6; y++) {
    const rr = y === 0 || y === 6 ? 2 : 2.6;
    const r2 = (rr + 0.4) * (rr + 0.4);
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) {
        if (x * x + z * z > r2) {
          continue;
        }
        const band = y === 1 || y === 5;
        v.set(x, y, z, shade(band ? IRON : LOG_PALE, 0.86 + r() * 0.28));
      }
    }
  }
  return bakeSolid(v, V);
}

function crate(tall: boolean): Template {
  const v = new VoxelModel();
  const h = tall ? 7 : 4;
  v.box(-3, 0, -3, 3, h, 3, shade(PLANK, 0.95));
  for (const y of [0, h]) {
    v.box(-3, y, -3, 3, y, 3, shade(PLANK_DARK, 1.0));
  }
  for (const [x, z] of [
    [-3, -3],
    [3, -3],
    [-3, 3],
    [3, 3],
  ]) {
    v.box(x, 0, z, x, h, z, TIMBER);
  }
  return bakeSolid(v, V);
}

function woodpile(): Template {
  const v = new VoxelModel();
  const r = rnd(0xb1d3);
  for (let y = 0; y <= 5; y++) {
    const w = 7 - y;
    for (let z = -w; z <= w; z++) {
      if (r() < 0.12) {
        continue;
      }
      v.box(-2, y, z, 2, y, z, shade(y % 2 === 0 ? LOG : LOG_PALE, 0.82 + r() * 0.36));
    }
  }
  for (const [x, z] of [
    [-3, -8],
    [-3, 8],
    [3, -8],
    [3, 8],
  ]) {
    v.box(x, 0, z, x, 7, z, TIMBER);
  }
  return bakeSolid(v, V);
}

function weaponRack(): Template {
  const v = new VoxelModel();
  v.box(-6, 0, 0, -6, 8, 0, TIMBER);
  v.box(6, 0, 0, 6, 8, 0, TIMBER);
  v.box(-6, 8, 0, 6, 8, 0, shade(LOG, 1.0));
  for (let x = -5; x <= 5; x += 2) {
    for (let y = 0; y <= 11; y++) {
      v.set(x, y, 0, shade(LOG_PALE, 0.9));
    }
    v.set(x, 12, 0, IRON);
  }
  v.box(-4, 1, 2, -1, 5, 2, shade(CANVAS_RED, 0.95));
  v.box(1, 1, 2, 4, 5, 2, shade(CANVAS_BLUE, 0.95));
  return bakeSolid(v, V);
}

function well(): Template {
  const v = new VoxelModel();
  const r = rnd(0x2ee8);
  for (let y = 0; y <= 4; y++) {
    for (let x = -4; x <= 4; x++) {
      for (let z = -4; z <= 4; z++) {
        const d2 = x * x + z * z;
        if (d2 > 20 || d2 < 9) {
          continue;
        }
        v.set(x, y, z, shade(y === 4 ? ROCK : ROCK_DARK, 0.86 + r() * 0.3));
      }
    }
  }
  v.box(-4, 5, 0, -4, 12, 0, TIMBER);
  v.box(4, 5, 0, 4, 12, 0, TIMBER);
  v.box(-5, 13, -2, 5, 13, 2, shade(THATCH, 1.0));
  v.box(-4, 14, -1, 4, 14, 1, shade(THATCH_DARK, 1.0));
  v.box(0, 8, 0, 0, 11, 0, ROPE);
  v.box(-1, 7, -1, 1, 8, 1, shade(LOG_PALE, 0.95));
  return bakeSolid(v, V);
}

function campfireBody(): Template {
  const v = new VoxelModel();
  const r = rnd(0x7f31);
  v.box(-4, 0, -4, 4, 0, 4, shade(SOOT, 0.9));
  for (let a = 0; a < 26; a++) {
    const ang = (a / 26) * Math.PI * 2;
    const x = Math.round(Math.cos(ang) * 6);
    const z = Math.round(Math.sin(ang) * 6);
    const h = r() < 0.4 ? 1 : 0;
    v.box(x, 0, z, x, h, z, shade(ROCK, 0.82 + r() * 0.36));
  }
  for (const [dx, dz, y] of [
    [1, 0, 1],
    [0, 1, 2],
    [1, 0, 3],
  ] as const) {
    for (let k = -3; k <= 3; k++) {
      v.set(dx * k, y, dz * k, shade(k > 1 || k < -1 ? LOG : SOOT, 0.86 + r() * 0.3));
    }
  }
  return bakeSolid(v, V);
}

/** The flame, on the glow material. SIZED AGAINST THE HERO (1.8 units): 5 layers
 *  on radius 2.4 is 1.40 by 1.40, so it sits inside its stone ring, and bloom
 *  energy goes with the lit area. The palette bands move with the layer count, or
 *  five layers leave only embers. */
function campfireFlame(): Template {
  const v = new VoxelModel();
  const r = rnd(0x4d09);
  for (let y = 0; y <= 4; y++) {
    const rr = Math.max(0, 2.4 - y * 0.42);
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) {
        if (x * x + z * z > rr * rr) {
          continue;
        }
        if (r() < 0.16 + y * 0.07) {
          continue;
        }
        v.set(x, y + 1, z, y > 3 ? FLAME_PALE : y > 1 ? FLAME : EMBER);
      }
    }
  }
  // Lowest voxel is y = 1 in the fire's frame; see `bakeAt`.
  return bakeAt(v, V, 0, 1 * V, 0);
}

function brazierBody(): Template {
  const v = new VoxelModel();
  for (const [x, z] of [
    [-2, -2],
    [2, -2],
    [0, 3],
  ]) {
    for (let y = 0; y <= 7; y++) {
      v.set(Math.round(x * (1 - y / 12)), y, Math.round(z * (1 - y / 12)), shade(IRON, 0.9));
    }
  }
  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) {
      const d2 = x * x + z * z;
      if (d2 > 11) {
        continue;
      }
      v.set(x, 8, z, shade(IRON, 0.86));
      if (d2 > 5) {
        v.set(x, 9, z, shade(IRON, 1.05));
      }
    }
  }
  return bakeSolid(v, V);
}

function brazierFlame(): Template {
  const v = new VoxelModel();
  const r = rnd(0x1177);
  for (let y = 0; y <= 4; y++) {
    const rr = Math.max(0, 2.4 - y * 0.5);
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        if (x * x + z * z > rr * rr || r() < 0.12 + y * 0.08) {
          continue;
        }
        v.set(x, y + 9, z, y > 2 ? FLAME_PALE : y > 0 ? FLAME : EMBER);
      }
    }
  }
  // The bowl's rim is at y = 9 in the brazier's frame; see `bakeAt`.
  return bakeAt(v, V, 0, 9 * V, 0);
}

/** How high the lamp's bracket sits, in voxels. Shared by body and flame. */
const LAMP_H = 13;

/** A road lamp. Deliberately NOT a light source — see the point-light rule at
 *  the top of this file. */
function lampBody(): Template {
  const v = new VoxelModel();
  for (let y = 0; y <= LAMP_H; y++) {
    v.set(0, y, 0, shade(y % 3 === 0 ? LOG : TIMBER, 0.9));
  }
  v.box(0, LAMP_H, 1, 0, LAMP_H, 3, shade(TIMBER, 1.0));
  v.set(0, LAMP_H - 1, 1, shade(TIMBER, 0.9));
  for (const [x, z] of [
    [-1, 2],
    [1, 2],
    [-1, 4],
    [1, 4],
  ]) {
    v.box(x, LAMP_H - 5, z, x, LAMP_H - 1, z, IRON);
  }
  v.box(-1, LAMP_H - 1, 2, 1, LAMP_H - 1, 4, shade(IRON, 1.1));
  v.box(-1, LAMP_H - 6, 2, 1, LAMP_H - 6, 4, shade(IRON, 0.85));
  return bakeSolid(v, V);
}

function lampFlame(): Template {
  const v = new VoxelModel();
  for (let y = LAMP_H - 5; y <= LAMP_H - 2; y++) {
    v.set(0, y, 3, y > LAMP_H - 4 ? FLAME_PALE : FLAME);
    v.set(-1, y, 3, EMBER);
    v.set(1, y, 3, EMBER);
    v.set(0, y, 2, EMBER);
    v.set(0, y, 4, EMBER);
  }
  // Inside the cage: LAMP_H-5 up, and one voxel back along +z because the
  // lantern's own z extent (2..4) centres differently from the post's (0..4).
  return bakeAt(v, V, 0, (LAMP_H - 5) * V, 1 * V);
}

function forgeCoals(): Template {
  const v = new VoxelModel();
  const r = rnd(0x33b1);
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) {
      v.set(x, 0, z, r() < 0.4 ? FLAME : EMBER);
      if (r() < 0.3) {
        v.set(x, 1, z, FLAME_PALE);
      }
    }
  }
  return bakeProp(v, V);
}

/**
 * THE FENCE KIT — stake, plank, stake variants; placement is world/fences.ts.
 * That split is issue #105: fixed-length panels stamped at a caller's own
 * interval left planks hanging in the air. A post is one column at its origin; a
 * plank runs along +z with a LENGTH SCALE so a bay spans exactly its gap,
 * narrowed across x to stay off the stake's depth plane; `FENCE_RAIL_AT` and
 * `FENCE_POST_H` are the heights fences.ts derives from.
 */

const FENCE_POST_VOX = 6;
const FENCE_TALL_VOX = 9;
/** Where the lantern's cage sits on the lantern stake, in voxels. */
const FENCE_LAMP_VOX = 10;
const FENCE_RAIL_VOX = 10;

/** How far a plain stake stands above the line the fence is laid on. */
export const FENCE_POST_H = FENCE_POST_VOX * V;
const FENCE_TALL_H = FENCE_TALL_VOX * V;
const FENCE_LANTERN_H = (FENCE_LAMP_VOX + 5) * V;
/** Plank BOTTOMS above the fence line, lower first. The upper course stops 0.14
 *  units below a post cap, so the top faces stay distinct (issue #127). */
export const FENCE_RAIL_AT = [1.5 * V, 3.5 * V] as const;
/** How long one plank template is, i.e. what a bay's `sz` is measured against. */
export const FENCE_RAIL_LEN = FENCE_RAIL_VOX * V;
export const FENCE_RAIL_HEIGHT = 2 * V;
/** The authored stake and rail are each one voxel wide before stamp scaling. */
export const FENCE_POST_WIDTH = V;
/** Finished plank width. 60% leaves 0.056 units of post face visible each side
 *  — clear of a depth coincidence, still a branch and not a slat (issue #127). */
export const FENCE_RAIL_WIDTH = FENCE_POST_WIDTH * 0.6;
/** Half-width of a stake, for "does this post stand on the road" tests. */
export const FENCE_POST_R = V;

function fenceStake(vox: number, seed: number): VoxelModel {
  const v = new VoxelModel();
  const r = rnd(seed);
  for (let y = 0; y < vox; y++) {
    v.set(0, y, 0, shade(LOG, 0.84 + r() * 0.32));
  }
  // The fork opens ALONG the run (+/-z), the direction the planks arrive from.
  v.set(0, vox - 1, -1, shade(LOG, 1.1));
  v.set(0, vox - 1, 1, shade(LOG, 0.9));
  return v;
}

/** `bakeProp`, not `bakeSolid`: a fence is made solid by its PLANKS, which span
 *  every bay end to end, so a post collider would sit inside one of theirs. */
function fencePost(): Template {
  return bakeProp(fenceStake(FENCE_POST_VOX, 0x9143), V);
}

function fencePostTall(): Template {
  return bakeProp(fenceStake(FENCE_TALL_VOX, 0x51c7), V);
}

/** A stake with a caged lantern — emissive voxels, not a point light. */
function fenceLanternPost(): Template {
  const v = fenceStake(FENCE_LAMP_VOX, 0x2ba9);
  v.box(-1, FENCE_LAMP_VOX, -1, 1, FENCE_LAMP_VOX, 1, shade(IRON, 1.1));
  for (const [x, z] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    v.box(x, FENCE_LAMP_VOX + 1, z, x, FENCE_LAMP_VOX + 3, z, IRON);
  }
  v.box(-1, FENCE_LAMP_VOX + 4, -1, 1, FENCE_LAMP_VOX + 4, 1, shade(IRON, 0.85));
  return bakeProp(v, V);
}

function fenceLanternGlow(): Template {
  const v = new VoxelModel();
  for (let y = FENCE_LAMP_VOX + 1; y <= FENCE_LAMP_VOX + 3; y++) {
    v.set(0, y, 0, y > FENCE_LAMP_VOX + 2 ? FLAME_PALE : FLAME);
  }
  // No lateral correction, unlike `lampFlame`: cage and column centre alike.
  return bakeAt(v, V, 0, (FENCE_LAMP_VOX + 1) * V, 0);
}

/** One plank along +z, `FENCE_RAIL_LEN` long — the length a bay divides by.
 *  `bakeSolid`: the planks are the barrier, one collider per bay. */
function fenceRail(): Template {
  const v = new VoxelModel();
  const r = rnd(0x7d31);
  for (let z = 0; z < FENCE_RAIL_VOX; z++) {
    v.set(0, 0, z, shade(LOG_PALE, 0.82 + r() * 0.34));
    v.set(0, 1, z, shade(LOG_PALE, 0.82 + r() * 0.34));
  }
  return bakeSolid(v, V);
}

function fenceRailProp(): Template {
  const v = new VoxelModel();
  const r = rnd(0x11a5);
  for (let z = 0; z < FENCE_RAIL_VOX; z++) {
    v.set(0, 0, z, shade(LOG_PALE, 0.8 + r() * 0.36));
    v.set(0, 1, z, shade(LOG_PALE, 0.8 + r() * 0.36));
  }
  return bakeProp(v, V);
}

function signPost(): Template {
  const v = new VoxelModel();
  for (let y = 0; y <= 16; y++) {
    v.box(-1, y, -1, 0, y, 0, shade(TIMBER, 0.88 + (y % 3) * 0.08));
  }
  v.box(-2, 17, -2, 1, 17, 1, shade(LOG, 1.05));
  v.box(-2, 18, -2, 1, 18, 1, shade(LOG, 0.9));
  for (const [x, z] of [
    [-4, 0],
    [2, -3],
    [1, 3],
    [-3, 2],
  ]) {
    v.box(x, 0, z, x + 1, 0, z + 1, shade(ROCK, 0.9));
  }
  return bakeSolid(v, V);
}

/** One arm-board of a fingerpost along +z, `text` on both faces. Baked per
 *  label — one board plus a texture would be a new material. */
export function signArm(label: string, scale: number): Template {
  const v = new VoxelModel();
  // Folded HERE, so one place can be handed a character the font lacks.
  const text = signText(label);
  const w = labelWidth(text);
  const len = w + 5;
  for (let z = 0; z <= len; z++) {
    const over = Math.max(0, z - (len - 3));
    for (let y = over; y <= 4 - over; y++) {
      v.box(-1, y, z, 0, y, z, shade(PLANK, 0.88 + (z % 3) * 0.07));
    }
  }
  v.box(-1, 0, 0, 0, 4, 0, shade(PLANK_DARK, 1.0));
  const ink = shade(SOOT, 1.0);
  letters(v, text, -1, 4, 2, ink, false);
  letters(v, text, 0, 4, 2, ink, true);
  // Its OWN scale, far finer than the camp's `V`: at 0.28 a glyph would make an
  // eleven-unit board. `bakeProp` — the POST carries the collider, not the arm.
  return bakeProp(v, scale);
}

/** A bridge pier. `bakeProp`: it is stretched so its top lands exactly ON the
 *  carriageway and stands on the centreline — a collider there would be a wall
 *  down the middle of the bridge. */
function bridgePier(): Template {
  const v = new VoxelModel();
  const r = rnd(0x5c27);
  for (let y = 0; y <= 10; y++) {
    const rr = 3 - Math.floor(y / 6);
    for (let x = -rr; x <= rr; x++) {
      for (let z = -rr; z <= rr; z++) {
        v.set(x, y, z, shade(y > 8 ? ROCK : ROCK_DARK, 0.84 + r() * 0.32));
      }
    }
  }
  return bakeProp(v, V);
}
/** Voxel height of the pier template, for the vertical scale in `addBridgeFurniture`. */
const PIER_VOX = 11;

/** Every baked piece, built once. towns.ts stamps from here. */
// ---------------------------------------------------------------------------
// The harbour kit (issue #228): quays on piles, the steps down to them, a
// working ship, and the bollards she ties to. Deck TOPS are the walkable
// surface — `bakeSolid` measures the colliders off the same voxels, so what
// you see is what you stand on, by construction.
// ---------------------------------------------------------------------------

/** How many voxels of pile hang under a deck span: 20 × V = 5.6 units, enough
 *  to bury the feet in any bed the quay band allows (>= 4). */
const DECK_PILE_H = 20;
/** One quay span: DECK_SPAN_U × V units of planking per stamp. */
const DECK_SPAN_VOX = 10;
export const DECK_SPAN_U = DECK_SPAN_VOX * 2 * V;
/** A span's width across the walk, rub rails included: 11 voxels. */
export const DECK_SPAN_W = 11 * V;

/** A quay span: two piles and their cap, planked over. Stamped end to end along
 *  the walk; the planks run ACROSS it, the way a wharf is actually laid. */
function deckSpan(): Template {
  const v = new VoxelModel();
  const r = rnd(0x5ea1);
  // BRACKETED: the planks are the walkable platform. The body band cannot see
  // them (they ride 5.6 up on the piles), so they are measured by region —
  // `measurePlatform` — or a hero walking the pier falls through it (#228).
  const walk = v.region(() => {
    for (let x = -DECK_SPAN_VOX; x < DECK_SPAN_VOX; x++) {
      for (let z = -5; z <= 5; z++) {
        // Per-plank weathering, banded across the walk so the boards read.
        v.set(x, DECK_PILE_H, z, shade(x % 2 === 0 ? PLANK : PLANK_DARK, 0.82 + r() * 0.3));
      }
    }
  });
  // The rub rail along both edges, half a step proud so the edge reads.
  for (let x = -DECK_SPAN_VOX; x < DECK_SPAN_VOX; x++) {
    v.set(x, DECK_PILE_H + 1, -5, TIMBER);
    v.set(x, DECK_PILE_H + 1, 5, TIMBER);
  }
  // Two pile bents under the span ends.
  for (const px of [-DECK_SPAN_VOX + 1, DECK_SPAN_VOX - 2]) {
    for (const pz of [-4, 4]) {
      v.box(px, 0, pz, px + 1, DECK_PILE_H - 1, pz + 1, shade(TIMBER, 0.9));
    }
    // The cross brace, one voxel of it showing under the lip.
    v.box(px, DECK_PILE_H - 2, -4, px + 1, DECK_PILE_H - 2, 4, LOG);
  }
  const t = bakeSolid(v, V);
  const deck = measurePlatform(v, V, walk);
  if (deck) {
    t.solid = [...(t.solid ?? []), deck];
  }
  return t;
}

/** The steps from the town pad down onto the quay: rises the way the hero can
 *  walk (each tread is under MAX_STEP_UP at V scale), descending toward +z. */
function harbourStairs(): Template {
  const v = new VoxelModel();
  const treads = 6;
  for (let i = 0; i < treads; i++) {
    const y = (treads - 1 - i) * 2;
    v.box(-4, y, i * 2, 4, y + 1, i * 2 + 1, shade(i % 2 === 0 ? PLANK : PLANK_DARK, 0.95));
  }
  // Stringers down both sides, so the flight reads as carpentry, not floating boards.
  for (const sx of [-4, 4] as const) {
    for (let i = 0; i < treads; i++) {
      v.box(sx, (treads - 1 - i) * 2 - 1, i * 2, sx, (treads - 1 - i) * 2, i * 2 + 1, TIMBER);
    }
  }
  return bakeSolid(v, V);
}

/** A bollard: what she ties to, and what a boot finds in the dark. */
function bollard(): Template {
  const v = new VoxelModel();
  v.box(-1, 0, -1, 1, 3, 1, shade(TIMBER, 0.85));
  v.box(-1, 4, -1, 1, 4, 1, IRON);
  return bakeSolid(v, V);
}

/**
 * THE SHIP (issue #228) — a working coaster, moored: clinker hull, one mast,
 * the sail furled on its boom because she is HOME. Painted with the bow toward
 * +z; the stamp yaw lays her along the quay. Solid, with her colliders measured
 * off the hull like every other stamped thing — walking on deck is standing on
 * what you see.
 */
function ship(): Template {
  const v = new VoxelModel();
  const r = rnd(0xb0a7);
  const LEN = 16;
  const HULL_H = 6;
  for (let z = -LEN; z <= LEN; z++) {
    // The hull narrows to stem and stern; the sheer rises a strake at the ends.
    const t = Math.abs(z) / LEN;
    const half = Math.max(1, Math.round(5 * (1 - t * t * 0.8)));
    const sheer = t > 0.75 ? 1 : 0;
    for (let y = 0; y <= HULL_H + sheer; y++) {
      for (let x = -half; x <= half; x++) {
        const skin = Math.abs(x) === half || y === 0 || Math.abs(z) === LEN;
        if (!skin && y < HULL_H) {
          continue;
        }
        const strake = y % 2 === 0 ? PLANK_DARK : PLANK;
        v.set(x, y, z, shade(y >= HULL_H ? PLANK : strake, 0.84 + r() * 0.26));
      }
    }
  }
  // The wale, one dark band proud at the waterline sheer.
  for (let z = -LEN + 1; z < LEN; z++) {
    const half = Math.max(1, Math.round(5 * (1 - (Math.abs(z) / LEN) ** 2 * 0.8)));
    v.set(-half, HULL_H - 2, z, TIMBER);
    v.set(half, HULL_H - 2, z, TIMBER);
  }
  // Mast, boom, and the furled sail lashed along it.
  v.box(0, HULL_H, 2, 0, HULL_H + 22, 2, TIMBER);
  v.box(-6, HULL_H + 16, 2, 6, HULL_H + 16, 2, LOG);
  for (let x = -5; x <= 5; x++) {
    v.set(x, HULL_H + 15, 2, shade(0xd8d2c0, 0.88 + r() * 0.2));
  }
  // Bowsprit and the stern tiller.
  v.box(0, HULL_H + 1, LEN, 0, HULL_H + 2, LEN + 4, TIMBER);
  v.box(0, HULL_H + 1, -LEN - 1, 0, HULL_H + 1, -LEN + 1, LOG);
  // Deck cargo: two lashed casks, so she reads as WORKING.
  v.box(-2, HULL_H + 1, -6, -1, HULL_H + 3, -5, LOG_PALE);
  v.box(1, HULL_H + 1, -9, 2, HULL_H + 3, -8, LOG_PALE);
  return bakeSolid(v, V);
}

export class TownParts {
  readonly palisade = palisadeSpan();
  readonly cornerPost = cornerPost();
  readonly gate = gateArch();
  readonly watch = watchPost();
  readonly tents = [ridgeTent(0, 16), ridgeTent(1, 13), ridgeTent(2, 18)];
  readonly bell = bellTent();
  private readonly hutKit = [hut(0), hut(1), hut(2)];
  readonly huts = this.hutKit.map((h) => h.part);
  readonly hutWindows = this.hutKit.map((h) => h.window);
  readonly cartOpen = cart(false);
  readonly cartHood = cart(true);
  readonly barrel = barrel();
  readonly crateS = crate(false);
  readonly crateL = crate(true);
  readonly woodpile = woodpile();
  readonly rack = weaponRack();
  readonly well = well();
  readonly fire = campfireBody();
  readonly fireGlow = campfireFlame();
  readonly brazier = brazierBody();
  readonly brazierGlow = brazierFlame();
  readonly lamp = lampBody();
  readonly lampGlow = lampFlame();
  readonly forgeGlow = forgeCoals();
  readonly post = signPost();
  readonly pier = bridgePier();
  // The harbour kit (issue #228).
  readonly deckSpan = deckSpan();
  readonly harbourStairs = harbourStairs();
  readonly bollard = bollard();
  readonly ship = ship();
  /** The fence kit in the shape world/fences.ts stamps from. */
  readonly fence: FenceParts = fenceKit();
}

/** The camp's fence on its own: the Seam (world/seam.ts) lays a run of it without the rest of the kit. */
export function fenceKit(): FenceParts {
  return {
    post: fencePost(),
    tall: fencePostTall(),
    lantern: fenceLanternPost(),
    lanternGlow: fenceLanternGlow(),
    rail: fenceRail(),
    railProp: fenceRailProp(),
    railLen: FENCE_RAIL_LEN,
    railWidth: FENCE_RAIL_WIDTH,
    railHeight: FENCE_RAIL_HEIGHT,
    postWidth: FENCE_POST_WIDTH,
    railAt: FENCE_RAIL_AT,
    postH: FENCE_POST_H,
    tallH: FENCE_TALL_H,
    lanternH: FENCE_LANTERN_H,
    postR: FENCE_POST_R,
  };
}

/** Ribbon float over the surface it represents: at the verge the two are
 *  coplanar and would z-fight over hundreds of units. */
const RIBBON_LIFT = 0.025;
/** How far the ribbon's outer edge skirts down, hiding the ground's steps. */
const RIBBON_SKIRT = 1.1;
/** Ring spacing of the drawn ribbon, world units. See `subdivide`. */
const RING_LEN = 1;

/** ONE CROSS-SECTION VERTEX — the ribbon's and the apron's, whose rim IS the
 *  ribbon's first ring, so both must arrive at the same number. */
function sectionAt(
  surfaceAt: (x: number, z: number) => number,
  prof: PathProfile,
  p: RoadSample,
  px: number,
  pz: number,
  tx: number,
  tz: number,
  d: number,
): { x: number; y: number; z: number } {
  const ad = Math.abs(d);
  // A span is flat to its edge with water under it; else read the walking surface.
  const sd = Math.sign(d) * Math.min(ad, prof.deckEdge - 0.02);
  let y = p.bridge ? p.y : surfaceAt(p.x + px * sd, p.z + pz * sd);
  // NOTHING IS LIFTED HERE: the ribbon IS the walking surface, so a lifted rim is a
  // hero inside the road. Columns are clipped by `Terrain.columnTopAtCell` instead.
  return { x: p.x + px * d, y, z: p.z + pz * d };
}

function sectionColour(
  seed: number,
  prof: PathProfile,
  p: RoadSample,
  k: number,
  d: number,
): [number, number, number] {
  const ad = Math.abs(d);
  const pal = prof.palette;
  const base = p.bridge
    ? pal.plank
    : ad > prof.deckHalf
      ? pal.gravel
      : ad < prof.deckHalf * 0.5
        ? pal.rut
        : pal.earth;
  const m = p.bridge
    ? Math.round(p.x * 0.7 + p.z * 0.7) % 2 === 0
      ? 1.1
      : 0.88
    : 0.86 + hashCell(seed, Math.round(p.x), k, Math.round(p.z)) * 0.3;
  return [base[0] * m, base[1] * m, base[2] * m];
}

/** Re-space a clipped deck at RING_LEN. The router's `SEG_LEN` 3 is right for a
 *  ROUTE, wrong for the DRAWING: the shoulder is `round(deck)` and flips by a
 *  whole unit, which a three-unit chord straddles. */
function subdivide(pts: RoadSample[]): RoadSample[] {
  if (pts.length < 2) {
    return pts;
  }
  const out: RoadSample[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.z - a.z) / RING_LEN));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        y: a.y + (b.y - a.y) * t,
        // A ring inherits the span flag, as `builtDeck` does: half a bridge is not a thing.
        bridge: a.bridge || b.bridge,
      });
    }
  }
  return out;
}

/** The deck polyline clipped out of a fork's apron, with a terminal sample on the
 *  rim. ONE function for ribbon and apron, so both agree to the last bit where
 *  the arm starts. Only the ENDS are trimmed. */
function clipToApron(pts: RoadSample[], aprons: readonly Junction[]): RoadSample[] {
  if (aprons.length === 0 || pts.length < 2) {
    return pts;
  }
  const inside = (p: RoadSample): boolean =>
    aprons.some((a) => Math.hypot(p.x - a.x, p.z - a.z) < a.profile.apronR);
  /** Where the segment a->b crosses out of the apron b is outside of. */
  const rim = (a: RoadSample, b: RoadSample): RoadSample => {
    let lo = 0;
    let hi = 1;
    // Bisection, not the quadratic's root: a dozen halvings land inside RIBBON_LIFT.
    for (let i = 0; i < 24; i++) {
      const t = (lo + hi) / 2;
      const p = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
      if (aprons.some((q) => Math.hypot(p.x - q.x, p.z - q.z) < q.profile.apronR)) {
        lo = t;
      } else {
        hi = t;
      }
    }
    return {
      x: a.x + (b.x - a.x) * hi,
      z: a.z + (b.z - a.z) * hi,
      y: a.y + (b.y - a.y) * hi,
      // A cut end inherits the span flag, as `builtDeck`'s does.
      bridge: a.bridge || b.bridge,
    };
  };
  let lead = 0;
  while (lead < pts.length && inside(pts[lead])) {
    lead++;
  }
  let tail = pts.length - 1;
  while (tail > lead && inside(pts[tail])) {
    tail--;
  }
  if (tail - lead < 1) {
    return [];
  }
  const out = pts.slice(lead, tail + 1);
  if (lead > 0) {
    out.unshift(rim(pts[lead - 1], pts[lead]));
  }
  if (tail < pts.length - 1) {
    out.push(rim(pts[tail + 1], pts[tail]));
  }
  return out;
}

/**
 * The gravel ribbon for one road, on the TERRAIN material. Built once at world
 * creation, not per chunk — the network is a fiftieth of ONE terrain chunk.
 *
 * `surfaceAt` MUST be the walking-surface query the player resolves against, or
 * the ribbon is drawn over the hero's legs near a fork (measured 0.82). A bridge
 * deck is flat over water, and the rim sample is pulled inside `deckEdge`.
 */
export function buildRoadRibbon(
  roads: readonly Road[],
  seed: number,
  surfaceAt: (x: number, z: number) => number,
  /** Per-road nudge, so two ribbons resolved onto one surface cannot z-fight. */
  liftBias = 0,
  /** Forks this arm must not draw over. See `buildJunctionApron`. */
  aprons: readonly Junction[] = [],
): {
  pos: number[];
  nrm: number[];
  col: number[];
  idx: number[];
} {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];

  for (const road of roads) {
    // The BUILT deck, not the route (Road.trim), minus anybody else's junction: an
    // arm GROWS FROM THE APRON rim, which is the whole of issue #45.
    const pts = subdivide(clipToApron(builtDeck(road), aprons));
    if (pts.length < 2) {
      continue;
    }
    const prof = road.profile;
    const XS = prof.xs;
    const RUT = prof.palette.rut;
    const DECK_PLANK = prof.palette.plank;
    let ring0 = -1;
    let ringFirst = -1;
    let pxF = 0;
    let pzF = 0;
    let px0 = 0;
    let pz0 = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      let tx = b.x - a.x;
      let tz = b.z - a.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const px = -tz;
      const pz = tx;
      const ring = pos.length / 3;
      for (let k = 0; k < XS.length; k++) {
        const d = XS[k];
        const v = sectionAt(surfaceAt, prof, p, px, pz, tx, tz, d);
        pos.push(v.x, v.y + RIBBON_LIFT + liftBias, v.z);
        nrm.push(0, 1, 0);
        const c = sectionColour(seed, prof, p, k, d);
        col.push(c[0], c[1], c[2]);
      }
      if (ring0 >= 0) {
        // WINDING: the perpendicular is (-tz, tx), so the obvious (a0, b0, b0+1) order
        // gives a downward normal and the whole road is front-face culled.
        for (let k = 0; k < XS.length - 1; k++) {
          const a0 = ring0 + k;
          const b0 = ring + k;
          idx.push(a0, b0 + 1, b0, a0, a0 + 1, b0 + 1);
        }
        // Skirts on both rims, so a step in the ground cannot open a hole under it.
        for (const [k, sx] of [
          [0, -1],
          [XS.length - 1, 1],
        ] as const) {
          const a0 = ring0 + k;
          const b0 = ring + k;
          const base = pos.length / 3;
          for (const src of [a0, b0]) {
            const sxp = pos[src * 3];
            const syp = pos[src * 3 + 1];
            const szp = pos[src * 3 + 2];
            pos.push(sxp, syp, szp, sxp, syp - RIBBON_SKIRT, szp);
            const nx = src === a0 ? px0 * sx : px * sx;
            const nz = src === a0 ? pz0 * sx : pz * sx;
            nrm.push(nx, 0, nz, nx, 0, nz);
            for (let q = 0; q < 2; q++) {
              col.push(RUT[0] * 0.7, RUT[1] * 0.7, RUT[2] * 0.7);
            }
          }
          // Both windings: a skirt swaps outboard side as the road turns; one is culled.
          idx.push(base, base + 1, base + 3, base, base + 3, base + 2);
          idx.push(base, base + 3, base + 1, base, base + 2, base + 3);
        }
        // THE SOFFIT: a bridge has only water under it and its deck quads face up, so you
        // looked through it (issue #105). A floor at RIBBON_SKIRT closes it as one box.
        if (p.bridge && pts[i - 1].bridge) {
          const soffit = pos.length / 3;
          for (const r of [ring0, ring]) {
            for (let k = 0; k < XS.length; k++) {
              const src = (r + k) * 3;
              pos.push(pos[src], pos[src + 1] - RIBBON_SKIRT, pos[src + 2]);
              nrm.push(0, -1, 0);
              col.push(DECK_PLANK[0] * 0.55, DECK_PLANK[1] * 0.55, DECK_PLANK[2] * 0.55);
            }
          }
          for (let k = 0; k < XS.length - 1; k++) {
            const a0 = soffit + k;
            const b0 = soffit + XS.length + k;
            idx.push(a0, b0, b0 + 1, a0, b0 + 1, a0 + 1);
          }
        }
      }
      if (ringFirst < 0) {
        ringFirst = ring;
        pxF = px;
        pzF = pz;
      }
      ring0 = ring;
      px0 = px;
      pz0 = pz;
    }

    /**
     * A skirt ACROSS an end: the ground under a terminus is carved below the deck.
     * Outward is the road's own tangent, (pz, -px).
     */
    const endSkirt = (ring: number, pxr: number, pzr: number, sign: number): void => {
      if (ring < 0) {
        return;
      }
      const nx = pzr * sign;
      const nz = -pxr * sign;
      const base = pos.length / 3;
      for (let k = 0; k < XS.length; k++) {
        const src = (ring + k) * 3;
        pos.push(pos[src], pos[src + 1], pos[src + 2]);
        pos.push(pos[src], pos[src + 1] - RIBBON_SKIRT, pos[src + 2]);
        nrm.push(nx, 0, nz, nx, 0, nz);
        for (let q = 0; q < 2; q++) {
          col.push(RUT[0] * 0.7, RUT[1] * 0.7, RUT[2] * 0.7);
        }
      }
      // Both windings, for the reason the rim skirts give above.
      for (let k = 0; k < XS.length - 1; k++) {
        const a0 = base + k * 2;
        idx.push(a0, a0 + 1, a0 + 3, a0, a0 + 3, a0 + 2);
        idx.push(a0, a0 + 3, a0 + 1, a0, a0 + 2, a0 + 3);
      }
    };
    endSkirt(ringFirst, pxF, pzF, -1);
    endSkirt(ring0, px0, pz0, 1);
  }
  return { pos, nrm, col, idx };
}

/** Radial sampling, as fractions of each direction's rim radius. ELEVEN levels ~1
 *  unit apart, set by the MOTTLE: further apart, a per-cell value smears down a
 *  fan triangle and reads as a starburst of spokes. */
const APRON_T = [0.12, 0.24, 0.36, 0.48, 0.6, 0.71, 0.8, 0.875, 0.935, 0.975, 1];
/** Rim pitch between two arms. ~5.7 degrees, so the arc reads as an arc. */
const APRON_ARC = 0.1;

/** Shortest signed arc, so an arm's bearing compares across the -pi seam. */
const wrap = (a: number): number => {
  let v = a;
  while (v <= -Math.PI) {
    v += Math.PI * 2;
  }
  while (v > Math.PI) {
    v -= Math.PI * 2;
  }
  return v;
};

/**
 * THE FORK, DRAWN AS ONE PIECE, arms growing out of its rim (issue #45): three
 * ribbons drawn to one node stacked square ends across a bend.
 *
 * A fan to a rim whose radius VARIES WITH ANGLE. Where an arm leaves, the rim IS
 * that arm's first ring — same `sectionAt`, same `clipToApron` deck — so the
 * seam is a shared edge. Between arms it is their own outer edges run on until
 * they meet, not a circle, which would pave meadow behind the fork.
 */
export function buildJunctionApron(
  apron: Junction,
  roads: readonly Road[],
  seed: number,
  surfaceAt: (x: number, z: number) => number,
  liftBias = 0,
): {
  pos: number[];
  nrm: number[];
  col: number[];
  idx: number[];
} {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];

  // The APRON'S OWN PROFILE, not each arm's: one radius every arm is clipped back
  // to. Where two profiles meet, the wider owns the node (issue #142, §14).
  const prof = apron.profile;
  const APRON_R = prof.apronR;
  const XS = prof.xs;
  const { rut: RUT, earth: EARTH, gravel: GRAVEL } = prof.palette;
  const RIM_GUARD = prof.rimGuard;

  const ang = (x: number, z: number): number => Math.atan2(x - apron.x, z - apron.z);
  // Purely spatial, on the cell the ribbon's centre vertex hashes, so arm and
  // apron are the same dirt. A per-ring or per-direction term reads as a starburst.
  const mottle = (x: number, z: number): number =>
    0.86 + hashCell(seed, Math.round(x), 4, Math.round(z)) * 0.3;

  type Dir = { x: number; z: number; y: number; a: number; c: [number, number, number] };
  type Edge = { x: number; z: number; tx: number; tz: number; a: number };
  const dirs: Dir[] = [];
  const arms: Array<{ lo: Edge; hi: Edge }> = [];

  for (const road of roads) {
    const pts = clipToApron(builtDeck(road), [apron]);
    if (pts.length < 2) {
      continue;
    }
    // Which end is ours, if any — a road can pass a junction it does not join.
    const head =
      Math.hypot(pts[0].x - apron.x, pts[0].z - apron.z) <=
      Math.hypot(pts[pts.length - 1].x - apron.x, pts[pts.length - 1].z - apron.z);
    const p = head ? pts[0] : pts[pts.length - 1];
    if (Math.abs(Math.hypot(p.x - apron.x, p.z - apron.z) - APRON_R) > 0.05) {
      continue;
    }
    // The tangent the ribbon uses at that ring, or `k` runs the other way round.
    const q = head ? pts[1] : pts[pts.length - 2];
    let tx = head ? q.x - p.x : p.x - q.x;
    let tz = head ? q.z - p.z : p.z - q.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    const px = -tz;
    const pz = tx;
    const ends: Edge[] = [];
    for (let k = 0; k < XS.length; k++) {
      const v = sectionAt(surfaceAt, road.profile, p, px, pz, tx, tz, XS[k]);
      const a = ang(v.x, v.z);
      dirs.push({
        x: v.x,
        z: v.z,
        y: v.y,
        a,
        c: sectionColour(seed, road.profile, p, k, XS[k]),
      });
      // Angle runs monotonically along the ring, so its ends are its extremes.
      if (k === 0 || k === XS.length - 1) {
        ends.push({ x: v.x, z: v.z, tx, tz, a });
      }
    }
    const rel = wrap(ends[1].a - ends[0].a);
    arms.push(rel >= 0 ? { lo: ends[0], hi: ends[1] } : { lo: ends[1], hi: ends[0] });
  }
  if (arms.length === 0) {
    return { pos, nrm, col, idx };
  }
  arms.sort((u, v) => u.lo.a - v.lo.a);

  /** Where the ray at `th` crosses the kerb line through `e`, or 0. */
  const rimHit = (e: Edge, th: number): number => {
    const s = Math.sin(th);
    const c = Math.cos(th);
    const den = s * e.tz - c * e.tx;
    if (Math.abs(den) < 1e-6) {
      return 0;
    }
    const r = ((e.x - apron.x) * e.tz - (e.z - apron.z) * e.tx) / den;
    return r > prof.deckHalf ? r : 0;
  };
  let cornerR = 0;
  for (const a of arms) {
    for (const e of [a.lo, a.hi]) {
      const r = Math.hypot(e.x - apron.x, e.z - apron.z);
      if (r > cornerR) {
        cornerR = r;
      }
    }
  }

  // The gaps. Height read a hair INSIDE the rim, as the ribbon pulls its own in.
  for (let i = 0; i < arms.length; i++) {
    const from = arms[i].hi;
    const to = arms[(i + 1) % arms.length].lo;
    const span = wrap(to.a - from.a);
    if (span <= 0) {
      continue;
    } // arms whose rings overlap in angle: no gap
    const steps = Math.max(2, Math.ceil(span / APRON_ARC));
    for (let k = 1; k < steps; k++) {
      const a = from.a + (span * k) / steps;
      // THE FARTHER KERB, NOT THE NEARER ONE: two arms' kerb lines cross inside the
      // junction, so the nearer cuts the apron back to a star.
      const hit = Math.max(rimHit(from, a), rimHit(to, a));
      const r = hit > 0 ? Math.min(hit, cornerR) : APRON_R;
      const sx = Math.sin(a);
      const sz = Math.cos(a);
      const qx = apron.x + sx * (r - 0.02);
      const qz = apron.z + sz * (r - 0.02);
      // The ribbon's rim guard: the column a rim hides sits up to half a cell away.
      let y = surfaceAt(qx, qz);
      for (const [gx, gz] of [
        [sx * RIM_GUARD, sz * RIM_GUARD],
        [sz * RIM_GUARD, -sx * RIM_GUARD],
        [-sz * RIM_GUARD, sx * RIM_GUARD],
      ] as const) {
        const g = surfaceAt(qx + gx, qz + gz);
        if (g > y) {
          y = g;
        }
      }
      const m = mottle(qx, qz);
      dirs.push({
        x: apron.x + sx * r,
        z: apron.z + sz * r,
        y,
        a,
        c: [GRAVEL[0] * m, GRAVEL[1] * m, GRAVEL[2] * m],
      });
    }
  }

  // Counter-clockwise seen from above, which makes both fan windings face up.
  dirs.sort((u, v) => u.a - v.a);

  /**
   * Rut in the middle wearing to gravel at the rim. Banded on ABSOLUTE distance:
   * the rim radius varies with angle, so fractions band into wedges.
   */
  const ground = (x: number, z: number): [number, number, number] => {
    const u = Math.hypot(x - apron.x, z - apron.z) / APRON_R;
    // The same PROPORTIONS an arm's cross-section has, so the two read as one road.
    const base = u < 0.28 ? RUT : u < 0.6 ? EARTH : GRAVEL;
    const m = mottle(x, z);
    return [base[0] * m, base[1] * m, base[2] * m];
  };

  const cy = surfaceAt(apron.x, apron.z);
  const c0 = ground(apron.x, apron.z);
  pos.push(apron.x, cy + RIBBON_LIFT + liftBias, apron.z);
  nrm.push(0, 1, 0);
  col.push(c0[0], c0[1], c0[2]);

  const n = dirs.length;
  for (let l = 0; l < APRON_T.length; l++) {
    const t = APRON_T[l];
    for (const d of dirs) {
      const x = apron.x + (d.x - apron.x) * t;
      const z = apron.z + (d.z - apron.z) * t;
      // The rim keeps the height its arm's ring gave it — that shared vertex is the point.
      const y = t >= 1 ? d.y : surfaceAt(x, z);
      pos.push(x, y + RIBBON_LIFT + liftBias, z);
      nrm.push(0, 1, 0);
      // The rim must reach the ARM's colour or the seam shows; inward it would spoke.
      const own = ground(x, z);
      const w = t <= 0.8 ? 0 : (t - 0.8) / 0.2;
      for (let c = 0; c < 3; c++) {
        col.push(own[c] + (d.c[c] - own[c]) * w * w);
      }
    }
  }

  const ring = (l: number, i: number): number => 1 + l * n + (i % n);
  for (let i = 0; i < n; i++) {
    idx.push(0, ring(0, i), ring(0, i + 1));
  }
  for (let l = 0; l + 1 < APRON_T.length; l++) {
    for (let i = 0; i < n; i++) {
      const a0 = ring(l, i);
      const a1 = ring(l, i + 1);
      const b0 = ring(l + 1, i);
      const b1 = ring(l + 1, i + 1);
      idx.push(a0, b0, b1, a0, b1, a1);
    }
  }

  // A skirt all round, hiding the carved lip outside the rim; where an arm is it
  // doubles that arm's end skirt exactly.
  const skirt = pos.length / 3;
  for (const d of dirs) {
    pos.push(d.x, d.y + RIBBON_LIFT + liftBias, d.z, d.x, d.y - RIBBON_SKIRT, d.z);
    const nx = (d.x - apron.x) / APRON_R;
    const nz = (d.z - apron.z) / APRON_R;
    nrm.push(nx, 0, nz, nx, 0, nz);
    for (let q = 0; q < 2; q++) {
      col.push(RUT[0] * 0.7, RUT[1] * 0.7, RUT[2] * 0.7);
    }
  }
  for (let i = 0; i < n; i++) {
    const a0 = skirt + i * 2;
    const b0 = skirt + ((i + 1) % n) * 2;
    idx.push(a0, a0 + 1, b0 + 1, a0, b0 + 1, b0);
    idx.push(a0, b0 + 1, a0 + 1, a0, b0, b0 + 1);
  }

  return { pos, nrm, col, idx };
}

/** How far outboard a bridge railing stands: `deckHalf` plus the stake's
 *  half-width plus a hair, so its feet are on the deck (issue #142, §14). */
const railOffset = (prof: PathProfile): number => prof.deckHalf + FENCE_POST_R + 0.1;

/** Stamp piers and railings along every wet span. The railings go through
 *  `buildFence`, so each plank is measured against the gap it spans (issue #105);
 *  `groundAt` keeps an abutment stake planted in the bank. */
export function addBridgeFurniture(
  solid: SolidStamp,
  parts: TownParts,
  road: Road,
  groundAt: (x: number, z: number) => number,
): Fence[] {
  const pts = road.pts;
  const off = railOffset(road.profile);
  for (let i = 0; i < pts.length; i++) {
    if (!pts[i].bridge || i % 4 !== 0) {
      continue;
    }
    // A pier every fourth sample (12 units), stretched from the bed to the deck.
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const yaw = Math.atan2(b.x - a.x, b.z - a.z);
    const foot = WATER_LEVEL - 1.6;
    solid.add(parts.pier, p.x, foot, p.z, yaw, 1.25, Math.max(0.4, (p.y - foot) / (PIER_VOX * V)));
  }

  // One fence per SPAN and per side: one chain over two channels would railing
  // across the island between. Returned only for tools/test-fence.mjs.
  const built: Fence[] = [];
  for (const span of bridgeSpans(pts)) {
    for (const side of [-1, 1] as const) {
      const path = span.map((k) => {
        const p = pts[k];
        const a = pts[Math.max(0, k - 1)];
        const b = pts[Math.min(pts.length - 1, k + 1)];
        const tl = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const px = (-(b.z - a.z) / tl) * side * off;
        const pz = ((b.x - a.x) / tl) * side * off;
        return { x: p.x + px, y: p.y, z: p.z + pz };
      });
      built.push(...buildFence(solid, parts.fence, path, { groundAt }));
    }
  }
  return built;
}

function bridgeSpans(pts: readonly RoadSample[]): number[][] {
  const spans: number[][] = [];
  let run: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].bridge) {
      run.push(i);
      continue;
    }
    if (run.length > 1) {
      spans.push(run);
    }
    run = [];
  }
  if (run.length > 1) {
    spans.push(run);
  }
  return spans;
}
