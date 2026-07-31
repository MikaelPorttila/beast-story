/**
 * TOWN PARTS — every piece a settlement or a road is assembled from.
 *
 * This file holds voxel BUILDERS and nothing else: no placement, no policy, no
 * scene objects. towns.ts decides where a tent goes; this decides what a tent
 * is. The split is the same one props.ts already draws between its template
 * builders and `buildChunkProps`.
 *
 * THREE RULES CONSTRAIN EVERYTHING HERE.
 *
 *  1. NO NEW MATERIALS, with one exception. A material is a shader program and a
 *     first-use link stalls the GPU process for several hundred milliseconds
 *     half a second later (see warmUpShaders in main.ts). So every solid piece
 *     bakes to a `Template` and is stamped into an `Accum` that ends up on
 *     PropLib's existing `solidMat`, and the road ribbon goes on the terrain
 *     material. The one exception is the GLOW material — campfire, braziers,
 *     lamp flames, forge coals — which needs an emissive term to reach the
 *     selective bloom, and it is a single shared material for all of them.
 *
 *  2. NO POINT LIGHTS. three keys a program on the scene's visible light count,
 *     so one more lamp is a recompile of every lit material in the game the
 *     first frame two of them are on screen together (see World.setVisible for
 *     the measurement). The camp is lit by emissive voxels and the bloom
 *     instead, which is why the glow palette is authored hot rather than merely
 *     bright.
 *
 *  3. VOXELS ARE COARSE. `V` is 0.28 world units — nearly twice the skill dens'
 *     0.15 — because a camp is thirty structures and a merged mesh's cost goes
 *     with the SURFACE voxel count, i.e. with 1/V^2. It also suits the subject:
 *     this is lashed timber and rough stone, not a lacquered pagoda.
 *
 * AND THE PIECES ARE SOLID. Everything you cannot walk through is baked with
 * `bakeSolid` rather than `bakeProp`, which measures the model's own voxels into
 * the oriented boxes that block movement (world/structures.ts) and hangs them on
 * the `Template`. Nothing here states a size twice: the collider is the shape the
 * builder just painted, so resizing a hut moves its walls. The handful of pieces
 * that stay `bakeProp` are the ones a body genuinely passes through — a flame, a
 * pier under a deck, a signboard three metres up — and each says so where it is
 * baked.
 */
import { VoxelModel, shade } from '../core/voxel';
import { bakeProp, type Template } from './props';
import { bakeSolid, SolidStamp } from './structures';
import { DECK_EDGE, DECK_HALF, type Road } from './roads';
import { WATER_LEVEL } from './terrain';
import { hashCell } from './noise';

/** World units per voxel for everything in this file. See rule 3 above. */
export const V = 0.28;

// -- palette ---------------------------------------------------------------
// Authored as sRGB hex the way props.ts and shops.ts are; VoxelModel converts.
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
const ROCK = 0x8b8c92;
const ROCK_DARK = 0x6c6d73;
const IRON = 0x4b4b53;
const ROPE = 0xb9a06a;
const SOOT = 0x33302c;
/** Glow albedos. These ride the emissive material — see towns.ts `glowMat`. */
const EMBER = 0xff7a24;
const FLAME = 0xffc247;
const FLAME_PALE = 0xffe9a8;

// ---------------------------------------------------------------------------
// A 3x5 bitmap font, for the signposts.
//
// The fingerposts have to be LABELLED, and every other way of putting a word in
// this world costs a shader program: a canvas texture on a plane is a new
// material, and a sprite faces the camera instead of the board. Voxel letters
// cost NOTHING — they repaint cells the plank already owns, so the merged mesh
// has exactly the same triangle count whether a board is blank or reads
// STONEWATCH. They also stay in the game's own idiom: carved, chunky, and lit by
// the same sun as the post holding them up.
//
// 3x5 is the smallest grid the whole alphabet is legible in. At `V` a glyph is
// 0.84 x 1.4 units, on a board a player reads from the middle of the road.
// ---------------------------------------------------------------------------
const FONT: Record<string, readonly string[]> = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#.#', '###', '###', '#.#', '#.#'],
  N: ['#.#', '###', '###', '###', '#.#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '##.', '.##'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#.#', '#.#', '###', '###', '#.#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
  '0': ['.#.', '#.#', '#.#', '#.#', '.#.'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['##.', '..#', '.#.', '#..', '###'],
  '3': ['##.', '..#', '.#.', '..#', '##.'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '##.', '..#', '##.'],
  '6': ['.##', '#..', '##.', '#.#', '.#.'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['.#.', '#.#', '.#.', '#.#', '.#.'],
  '9': ['.#.', '#.#', '.##', '..#', '##.'],
  '-': ['...', '...', '###', '...', '...'],
  "'": ['.#.', '.#.', '...', '...', '...'],
  ' ': ['...', '...', '...', '...', '...'],
};
/** Glyph columns including the one-column gap that follows. */
const GLYPH_ADV = 4;

/**
 * Fold an arbitrary display string down to what the font above can actually
 * carve, and say so out loud.
 *
 * The FONT is the hard limit on this world's signage: A-Z, 0-9, '-', an
 * apostrophe and a space. Now that sign text comes out of the string table
 * (`town.<id>.sign`), a Swedish or German translation is one edit away from
 * handing a fingerpost an "Ö" — and `letters()` renders an unknown glyph as a
 * blank, so the first translated town would have quietly read "R DBRIAR".
 *
 * The fold is NFD + strip-combining, which is exactly right for the Latin
 * languages this game is plausibly translated into: Å/Ä -> A, Ö -> O, É -> E,
 * Ç -> C. Anything still outside the set after that (kanji, Cyrillic) is
 * dropped rather than drawn as a hole, because a board with a gap in the middle
 * of a word reads as a rendering bug and a shorter board reads as a short name.
 * The rest of that argument, and the character budget, is in src/i18n/en.ts.
 */
export function signText(text: string): string {
  let out = '';
  const folded = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  for (const ch of folded) if (ch in FONT) out += ch;
  return out;
}

/** Width in voxels a label occupies. */
export function labelWidth(text: string): number {
  return text.length * GLYPH_ADV - 1;
}

/**
 * Repaint `text` into the y/z plane at x = `face`, top row at `y0`, running
 * along +z from `z0`. `mirror` reverses it so the board reads correctly from
 * the other side too.
 */
function letters(
  v: VoxelModel, text: string, face: number, y0: number, z0: number,
  color: number, mirror: boolean,
): void {
  const w = labelWidth(text);
  for (let ci = 0; ci < text.length; ci++) {
    const g = FONT[text[ci]] ?? FONT[' '];
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (g[row][col] !== '#') continue;
        const u = ci * GLYPH_ADV + col;
        v.set(face, y0 - row, z0 + (mirror ? w - 1 - u : u), color);
      }
    }
  }
}

/**
 * Bake, then shift the result by (dx, dy, dz) WORLD units.
 *
 * Every glow piece needs this and none of the solid ones do, because `bake`
 * re-bases each model on its OWN bounding box: x/z centred, and y zeroed at the
 * lowest voxel it contains. A brazier's bowl and the flame in it are separate
 * models, so the flame — whose lowest voxel is nine up, in the bowl — came out
 * with its base at the ground. Captured in _town-camp-in2.png as a bright blob
 * sitting in the grass with an unlit iron tripod standing over it, and again as
 * a lantern glowing two and a half units below its own cage.
 *
 * The alternative was pairing every glow with its body in one VoxelModel, which
 * cannot work: the two go into different accumulators on different materials.
 * So the offset is stated where the pairing is known — in the builder.
 */
function bakeAt(
  model: VoxelModel, scale: number, dx: number, dy: number, dz: number,
): Template {
  const t = bakeProp(model, scale);
  for (let i = 0; i < t.pos.length; i += 3) {
    t.pos[i] += dx;
    t.pos[i + 1] += dy;
    t.pos[i + 2] += dz;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Deterministic per-builder noise. Each builder gets its own stream so adding
// one never reshuffles the others.
// ---------------------------------------------------------------------------
function rnd(seed: number): () => number {
  let n = seed >>> 0;
  return (): number => {
    n = (n * 1664525 + 1013904223) >>> 0;
    return ((n >>> 9) & 0xffff) / 0x10000;
  };
}

// ---------------------------------------------------------------------------
// Perimeter
// ---------------------------------------------------------------------------

/**
 * One 4.2-unit run of log palisade, laid along +z with its OUTSIDE at -x.
 *
 * Solid rather than a row of free-standing stakes, and that is a vertex-count
 * decision as much as a look: contiguous boxes cull the faces between them, so a
 * 15x2x11 wall is ~430 exterior faces where fifteen separate stakes would be
 * nearly nine hundred. The character comes from the RAGGED TOP — every pair of
 * columns has its own height and its own point — which costs a couple of dozen
 * faces and is the only part of a palisade read at distance.
 */
function palisadeSpan(): Template {
  const v = new VoxelModel();
  const r = rnd(0x51a7);
  for (let z = 0; z < 15; z += 2) {
    const h = 9 + Math.floor(r() * 3);
    const c = shade(LOG, 0.80 + r() * 0.36);
    v.box(0, 0, z, 1, h, z + 1, c);
    v.set(0, h + 1, z, shade(c, 1.12));
    v.set(1, h + 1, z + 1, shade(c, 0.9));
    v.set(0, h + 2, z, shade(c, 1.2));
  }
  // Lashed rail on the inside, and a stone footing course on the outside so the
  // wall grows out of the ground instead of resting on it.
  v.box(2, 5, 0, 2, 5, 14, shade(PLANK_DARK, 1.05));
  v.box(-1, 0, 0, -1, 1, 14, ROCK_DARK);
  for (let z = 1; z < 14; z += 5) v.set(2, 6, z, ROPE);
  return bakeSolid(v, V);
}

/** A low stone wall run, same 4.2 units, for the stretches without timber. */
function stoneWallSpan(): Template {
  const v = new VoxelModel();
  const r = rnd(0x3ba9);
  for (let z = 0; z < 15; z++) {
    const h = 4 + (r() < 0.35 ? 1 : 0);
    for (let y = 0; y <= h; y++) {
      v.box(-1, y, z, 1, y, z, shade(y === h ? ROCK : ROCK_DARK, 0.86 + r() * 0.3));
    }
  }
  return bakeSolid(v, V);
}

/**
 * The gate: two heavy posts, a lintel, a hanging banner and a pair of braced
 * doors thrown open. Spans ~8 units along +z with the road running through it.
 */
function gateArch(): Template {
  const v = new VoxelModel();
  const r = rnd(0x77c3);
  const H = 17;
  for (const z of [0, 26]) {
    v.box(-2, 0, z, 2, H, z + 3, shade(TIMBER, 0.95));
    for (let y = 0; y <= H; y += 3) v.box(-2, y, z, 2, y, z + 3, shade(TIMBER, 0.82 + r() * 0.3));
    v.box(-3, H + 1, z - 1, 3, H + 2, z + 4, shade(LOG, 1.06));
  }
  // Lintel and its brackets.
  v.box(-1, H + 1, 3, 1, H + 3, 25, shade(LOG, 0.98));
  v.box(-1, H - 2, 3, 1, H - 2, 6, shade(TIMBER, 0.9));
  v.box(-1, H - 2, 22, 1, H - 2, 25, shade(TIMBER, 0.9));
  // Banner slung under the lintel.
  for (let z = 9; z <= 19; z++) {
    for (let y = H - 6; y <= H; y++) {
      v.set(-2, y, z, shade(y === H ? CANVAS : CANVAS_RED, 0.9 + r() * 0.2));
    }
  }
  v.box(-2, H - 7, 11, -2, H - 7, 17, shade(CANVAS, 1.1));
  // Doors, open and folded back against the inside of the posts.
  for (const [z0, z1] of [[4, 8], [21, 25]]) {
    for (let z = z0; z <= z1; z++) {
      v.box(3, 0, z, 4, 13, z, shade(PLANK, 0.84 + r() * 0.3));
    }
    v.box(3, 4, z0, 4, 4, z1, IRON);
    v.box(3, 10, z0, 4, 10, z1, IRON);
  }
  return bakeSolid(v, V);
}

/** A watch platform on stilts — the only thing in camp taller than the wall. */
function watchPost(): Template {
  const v = new VoxelModel();
  const H = 16;
  for (const [x, z] of [[-2, -2], [1, -2], [-2, 1], [1, 1]]) {
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
  // Ladder up one leg.
  for (let y = 1; y < H; y += 2) v.box(-3, y, 2, 0, y, 2, shade(ROPE, 0.9));
  return bakeSolid(v, V);
}

// ---------------------------------------------------------------------------
// Shelter
// ---------------------------------------------------------------------------

/**
 * A ridge tent: canvas over a ridge pole, pegged out, mouth on +z. `hue` picks
 * the stripe, so a camp reads as a collection of tents rather than a production
 * run.
 *
 * The canvas is painted as a filled BAND per rib rather than one cell per rib,
 * which matters: the roof drops 1.3 voxels of height per voxel of width, so a
 * one-cell-thick sheet would be a dotted diagonal with daylight through it.
 */
function ridgeTent(hue: number, len: number): Template {
  const v = new VoxelModel();
  const r = rnd(0x2f11 + hue * 977);
  const stripe = [CANVAS_RED, CANVAS_BLUE, CANVAS_DARK][hue % 3];
  const W = 7;   // half-width at the eaves, voxels
  const A = 9;   // apex height, voxels
  const prof = (k: number): number => Math.round(A * (1 - k / (W + 0.6)));
  for (let z = 0; z <= len; z++) {
    // The canvas sags toward the mouth, which is what stops the tent reading as
    // an extruded triangle.
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
  // Ridge pole ends and pegs.
  v.box(0, A + 1, -1, 0, A + 1, len + 1, shade(LOG, 0.95));
  for (const z of [0, len]) {
    v.set(-W - 1, 0, z, shade(IRON, 1.0));
    v.set(W + 1, 0, z, shade(IRON, 1.0));
  }
  // Dark mouth, so the tent has a way in.
  for (let k = -3; k <= 3; k++) {
    for (let y = 0; y <= 4; y++) v.set(k, y, len, shade(SOOT, 1.0));
  }
  return bakeSolid(v, V);
}

/** A conical bell tent — a second silhouette on the same skyline. */
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
        if (d2 > outer || (y > 0 && d2 < inner)) continue;
        const c = (x + z + y) % 9 === 0 ? CANVAS_DARK : CANVAS;
        v.set(x, y, z, shade(c, 0.84 + r() * 0.28));
      }
    }
  }
  v.box(0, H + 1, 0, 0, H + 3, 0, shade(LOG, 1.0));
  v.set(0, H + 4, 0, shade(CANVAS_RED, 1.15));
  // Doorway.
  for (let y = 0; y <= 5; y++) for (let x = -2; x <= 2; x++) v.set(x, y, R - 1, SOOT);
  return bakeSolid(v, V);
}

/**
 * A timber-framed hut with a thatch roof. `kind` swaps the fittings so the three
 * functional buildings in a camp are recognisably different jobs: 0 stores
 * (shutters and a lean-to of boards), 1 quarters (chimney), 2 smithy (chimney
 * and an anvil; the coals are a separate glow piece).
 */
function hut(kind: 0 | 1 | 2): Template {
  const v = new VoxelModel();
  const r = rnd(0x1d77 + kind * 613);
  const W = 8;  // half-width
  const D = 7;  // half-depth
  const H = 9;
  for (let x = -W; x <= W; x++) {
    for (let z = -D; z <= D; z++) {
      if (x !== -W && x !== W && z !== -D && z !== D) continue;
      for (let y = 0; y <= H; y++) {
        const corner = (x === -W || x === W) && (z === -D || z === D);
        const c = corner || y === 0 || y === H ? TIMBER : PLANK;
        v.set(x, y, z, shade(c, 0.84 + r() * 0.3));
      }
    }
  }
  // Doorway on +z.
  for (let x = -2; x <= 2; x++) for (let y = 0; y <= 5; y++) v.set(x, y, D, SOOT);
  v.box(-3, 6, D, 3, 6, D, shade(LOG, 1.05));
  // Thatch: a gable running along x, laid in courses so it is not a smooth wedge.
  for (let k = 0; k <= D + 1; k++) {
    const y = H + 1 + k;
    const c = k % 2 === 0 ? THATCH : THATCH_DARK;
    for (let x = -W - 1; x <= W + 1; x++) {
      v.set(x, y, -(D + 1 - k), shade(c, 0.86 + r() * 0.28));
      v.set(x, y, D + 1 - k, shade(c, 0.86 + r() * 0.28));
    }
  }
  for (let x = -W - 1; x <= W + 1; x++) v.set(x, H + D + 2, 0, shade(THATCH, 1.12));
  if (kind === 0) {
    v.box(-6, 4, -D, -3, 6, -D, shade(PLANK_DARK, 1.0));
    v.box(3, 4, -D, 6, 6, -D, shade(PLANK_DARK, 1.0));
    v.box(W + 1, 0, -3, W + 3, 2, 3, shade(LOG_PALE, 0.95));
    v.box(W + 1, 3, -3, W + 4, 3, 3, shade(PLANK, 1.05));
  } else {
    // Stone chimney up the -x gable.
    for (let y = 0; y <= H + D + 4; y++) {
      v.box(-W - 2, y, -2, -W - 1, y, 1, shade(y > H ? ROCK : ROCK_DARK, 0.86 + r() * 0.3));
    }
    v.box(-W - 3, H + D + 5, -3, -W, H + D + 5, 2, shade(ROCK, 1.05));
  }
  if (kind === 2) {
    // Anvil and stock outside the door.
    v.box(4, 0, D + 3, 6, 1, D + 5, shade(TIMBER, 0.9));
    v.box(4, 2, D + 3, 6, 2, D + 5, shade(IRON, 1.0));
    v.box(4, 3, D + 4, 7, 3, D + 4, shade(IRON, 1.15));
  }
  return bakeSolid(v, V);
}

// ---------------------------------------------------------------------------
// Clutter — the part that makes a camp read as lived in
// ---------------------------------------------------------------------------

/** A two-wheeled cart, tipped forward onto its shafts, with a load. */
function cart(hooded: boolean): Template {
  const v = new VoxelModel();
  const r = rnd(hooded ? 0x4411 : 0x8ac2);
  v.box(-4, 4, -7, 4, 5, 7, shade(PLANK, 0.92));
  for (let z = -7; z <= 7; z += 2) v.box(-4, 6, z, 4, 6, z, shade(PLANK_DARK, 1.0));
  v.box(-5, 4, -7, -5, 8, 7, shade(PLANK_DARK, 0.95));
  v.box(5, 4, -7, 5, 8, 7, shade(PLANK_DARK, 0.95));
  v.box(-4, 4, -8, 4, 9, -8, shade(PLANK, 0.88));
  // Wheels: rims and spokes, so they are wheels and not discs.
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
  // Shafts down to the ground at the +z end.
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
        if (x * x + z * z > r2) continue;
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
  for (const y of [0, h]) v.box(-3, y, -3, 3, y, 3, shade(PLANK_DARK, 1.0));
  for (const [x, z] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {
    v.box(x, 0, z, x, h, z, TIMBER);
  }
  return bakeSolid(v, V);
}

/** A stack of split logs in a rack. */
function woodpile(): Template {
  const v = new VoxelModel();
  const r = rnd(0xb1d3);
  for (let y = 0; y <= 5; y++) {
    const w = 7 - y;
    for (let z = -w; z <= w; z++) {
      if (r() < 0.12) continue;
      v.box(-2, y, z, 2, y, z, shade(y % 2 === 0 ? LOG : LOG_PALE, 0.82 + r() * 0.36));
    }
  }
  for (const [x, z] of [[-3, -8], [-3, 8], [3, -8], [3, 8]]) v.box(x, 0, z, x, 7, z, TIMBER);
  return bakeSolid(v, V);
}

/** A rack of spears and shields — a camp is a garrison, not a market. */
function weaponRack(): Template {
  const v = new VoxelModel();
  v.box(-6, 0, 0, -6, 8, 0, TIMBER);
  v.box(6, 0, 0, 6, 8, 0, TIMBER);
  v.box(-6, 8, 0, 6, 8, 0, shade(LOG, 1.0));
  for (let x = -5; x <= 5; x += 2) {
    for (let y = 0; y <= 11; y++) v.set(x, y, 0, shade(LOG_PALE, 0.9));
    v.set(x, 12, 0, IRON);
  }
  v.box(-4, 1, 2, -1, 5, 2, shade(CANVAS_RED, 0.95));
  v.box(1, 1, 2, 4, 5, 2, shade(CANVAS_BLUE, 0.95));
  return bakeSolid(v, V);
}

/** The village well, for the settlements. */
function well(): Template {
  const v = new VoxelModel();
  const r = rnd(0x2ee8);
  for (let y = 0; y <= 4; y++) {
    for (let x = -4; x <= 4; x++) {
      for (let z = -4; z <= 4; z++) {
        const d2 = x * x + z * z;
        if (d2 > 20 || d2 < 9) continue;
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

// ---------------------------------------------------------------------------
// Fire, and the things that hold it
// ---------------------------------------------------------------------------

/** Stone ring, ash bed and cross-stacked logs — the camp's social anchor. */
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
  for (const [dx, dz, y] of [[1, 0, 1], [0, 1, 2], [1, 0, 3]] as const) {
    for (let k = -3; k <= 3; k++) {
      v.set(dx * k, y, dz * k, shade(k > 1 || k < -1 ? LOG : SOOT, 0.86 + r() * 0.3));
    }
  }
  return bakeSolid(v, V);
}

/** The flame itself. Goes on the glow material. */
function campfireFlame(): Template {
  const v = new VoxelModel();
  const r = rnd(0x4d09);
  for (let y = 0; y <= 7; y++) {
    const rr = Math.max(0, 3.2 - y * 0.42);
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) {
        if (x * x + z * z > rr * rr) continue;
        if (r() < 0.16 + y * 0.05) continue;
        v.set(x, y + 1, z, y > 4 ? FLAME_PALE : y > 2 ? FLAME : EMBER);
      }
    }
  }
  // Lowest voxel is y = 1 in the fire's frame; see `bakeAt`.
  return bakeAt(v, V, 0, 1 * V, 0);
}

/** An iron brazier on a tripod. */
function brazierBody(): Template {
  const v = new VoxelModel();
  for (const [x, z] of [[-2, -2], [2, -2], [0, 3]]) {
    for (let y = 0; y <= 7; y++) {
      v.set(Math.round(x * (1 - y / 12)), y, Math.round(z * (1 - y / 12)), shade(IRON, 0.9));
    }
  }
  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) {
      const d2 = x * x + z * z;
      if (d2 > 11) continue;
      v.set(x, 8, z, shade(IRON, 0.86));
      if (d2 > 5) v.set(x, 9, z, shade(IRON, 1.05));
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
        if (x * x + z * z > rr * rr || r() < 0.12 + y * 0.08) continue;
        v.set(x, y + 9, z, y > 2 ? FLAME_PALE : y > 0 ? FLAME : EMBER);
      }
    }
  }
  // The bowl's rim is at y = 9 in the brazier's frame; see `bakeAt`.
  return bakeAt(v, V, 0, 9 * V, 0);
}

/** How high the lamp's bracket sits, in voxels. Shared by body and flame. */
const LAMP_H = 13;

/**
 * A road lamp: a leaning post with an iron lantern hung off a bracket.
 *
 * Deliberately NOT a light source. One real point light per lamp would change
 * NUM_POINT_LIGHTS and recompile every lit material in the game the first frame
 * two of them share the screen. The lantern is an emissive voxel cluster feeding
 * the selective bloom instead, which costs one shared material for every lamp,
 * fire and forge in the world.
 */
function lampBody(): Template {
  const v = new VoxelModel();
  for (let y = 0; y <= LAMP_H; y++) {
    v.set(0, y, 0, shade(y % 3 === 0 ? LOG : TIMBER, 0.9));
  }
  v.box(0, LAMP_H, 1, 0, LAMP_H, 3, shade(TIMBER, 1.0));
  v.set(0, LAMP_H - 1, 1, shade(TIMBER, 0.9));
  for (const [x, z] of [[-1, 2], [1, 2], [-1, 4], [1, 4]]) {
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

/** Forge coals, for the smithy. */
function forgeCoals(): Template {
  const v = new VoxelModel();
  const r = rnd(0x33b1);
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) {
      v.set(x, 0, z, r() < 0.4 ? FLAME : EMBER);
      if (r() < 0.3) v.set(x, 1, z, FLAME_PALE);
    }
  }
  return bakeProp(v, V);
}

// ---------------------------------------------------------------------------
// Road furniture
// ---------------------------------------------------------------------------

/**
 * A rough tree fence: unsquared branches lashed between forked stakes, running
 * along +z for 4.2 units. What a road is flanked with where it runs past
 * pasture — not a garden fence.
 */
function roughFence(): Template {
  const v = new VoxelModel();
  const r = rnd(0x9143);
  for (const z of [0, 7, 14]) {
    const h = 5 + Math.floor(r() * 2);
    v.box(0, 0, z, 0, h, z, shade(LOG, 0.84 + r() * 0.32));
    v.set(-1, h, z, shade(LOG, 1.1));
    v.set(1, h, z, shade(LOG, 0.9));
  }
  for (const y of [2, 4]) {
    for (let z = 0; z <= 14; z++) {
      // A branch sags between its stakes and is never straight.
      const sag = (z > 2 && z < 5) || (z > 9 && z < 12) ? -1 : 0;
      v.set(r() < 0.5 ? 0 : -1, y + sag, z, shade(LOG_PALE, 0.82 + r() * 0.34));
    }
  }
  return bakeSolid(v, V);
}

/** The post half of a fingerpost. Arms are stamped onto it separately. */
function signPost(): Template {
  const v = new VoxelModel();
  for (let y = 0; y <= 16; y++) v.box(-1, y, -1, 0, y, 0, shade(TIMBER, 0.88 + (y % 3) * 0.08));
  v.box(-2, 17, -2, 1, 17, 1, shade(LOG, 1.05));
  v.box(-2, 18, -2, 1, 18, 1, shade(LOG, 0.9));
  // A cairn at the foot, so the post reads as placed rather than dropped.
  for (const [x, z] of [[-4, 0], [2, -3], [1, 3], [-3, 2]]) {
    v.box(x, 0, z, x + 1, 0, z + 1, shade(ROCK, 0.9));
  }
  return bakeSolid(v, V);
}

/**
 * One arm-board of a fingerpost, pointing along +z with `text` on both faces and
 * a spear-point tip.
 *
 * Baked per label — there are half a dozen in the world, and the alternative
 * (one board template plus a texture) is a new material. The letters repaint
 * cells the board already has, so a labelled board and a blank one are the same
 * number of triangles.
 */
export function signArm(label: string, scale: number): Template {
  const v = new VoxelModel();
  // Folded HERE rather than at the call site, so there is exactly one place a
  // board can be handed a character the font does not have. See signText.
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
  // Baked at its OWN scale, far finer than the camp's `V`: a 3x5 glyph at 0.28
  // units a voxel would make ENCAMPMENT an eleven-unit board, longer than the
  // post is tall. At ~0.095 the arm is 4.2 units — a fingerpost — and a glyph is
  // 0.29 x 0.48, which measures ~58 px on a 1280-wide frame from six units away.
  //
  // `bakeProp`, NOT `bakeSolid`: an arm is stamped 2.1-3.6 units up the post it
  // hangs off, and a footprint measured from the board's own base would be a
  // four-unit invisible slab at ankle height beside every fingerpost. The POST
  // is what you walk into, and it carries the collider.
  return bakeProp(v, scale);
}

/**
 * A bridge pier: a stone stack rising out of the water to the deck.
 *
 * `bakeProp`, NOT `bakeSolid`. A pier is stamped from the lake bed and stretched
 * so its top lands exactly ON the carriageway (see `addBridgeFurniture`), which
 * is the one height a collider must not be: it stands on the road centreline, so
 * a box topping out at deck level is a wall down the middle of the bridge that
 * the hero's feet clear or fail to clear on a floating-point coin toss. The
 * railings are what keep you on the deck, and they are solid.
 */
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

/** One railing post-and-rail unit for a bridge, laid along +z. */
function bridgeRail(): Template {
  const v = new VoxelModel();
  v.box(0, 0, 0, 0, 5, 0, shade(TIMBER, 0.95));
  v.box(0, 3, 0, 0, 3, 10, shade(LOG_PALE, 0.95));
  v.box(0, 5, 0, 0, 5, 10, shade(LOG, 1.0));
  v.box(-1, 5, 0, 1, 5, 0, shade(LOG, 1.08));
  return bakeSolid(v, V);
}

// ---------------------------------------------------------------------------

/** Every baked piece, built once. towns.ts stamps from here. */
export class TownParts {
  readonly palisade = palisadeSpan();
  readonly stoneWall = stoneWallSpan();
  readonly gate = gateArch();
  readonly watch = watchPost();
  readonly tents = [ridgeTent(0, 16), ridgeTent(1, 13), ridgeTent(2, 18)];
  readonly bell = bellTent();
  readonly huts = [hut(0), hut(1), hut(2)];
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
  readonly fence = roughFence();
  readonly post = signPost();
  readonly pier = bridgePier();
  readonly rail = bridgeRail();
}

// ---------------------------------------------------------------------------
// The road ribbon
// ---------------------------------------------------------------------------

/**
 * How far the ribbon floats over the surface it represents.
 *
 * At the verge the ribbon's height IS the carved column top, so the two are
 * coplanar and would z-fight over a strip several hundred units long. A fortieth
 * of a unit is a quarter the thickness of a blade of grass and well inside the
 * half-unit slack the step test allows between where you stand (`getHeight`, the
 * deck) and what you see.
 */
const RIBBON_LIFT = 0.025;
/** How far the ribbon's outer edge skirts down, hiding the ground's steps. */
const RIBBON_SKIRT = 1.1;

/** Cross-section offsets, in units from the centreline. */
const XS = [
  -DECK_EDGE, -DECK_HALF, -DECK_HALF * 0.45, 0, DECK_HALF * 0.45, DECK_HALF, DECK_EDGE,
];

const s2l = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
/** sRGB hex -> the linear triple the terrain material's vertex colours are in. */
const lin = (hex: number): [number, number, number] => [
  s2l(((hex >> 16) & 255) / 255), s2l(((hex >> 8) & 255) / 255), s2l((hex & 255) / 255),
];
const RUT = lin(0x6b5843);
const EARTH = lin(0x8a7a60);
const GRAVEL = lin(0x9a8f79);
const DECK_PLANK = lin(0x7d6142);

/**
 * The carriageway surface, as one merged geometry on the TERRAIN material.
 *
 * Built once at world creation rather than per chunk, and that is a deliberate
 * budget decision: props are already ~78% of a chunk build against a 3 ms frame
 * budget, and a road that streamed would add work to exactly the chunks the
 * player is walking into. The whole network is a few thousand vertices — a
 * fiftieth of ONE chunk of terrain — so paying for it at boot and keeping it
 * resident costs a draw call and nothing else.
 *
 * Every vertex height comes from the same rule `RoadNetwork.surfaceAt` uses, so
 * this is not a decoration laid near the road: it is a drawing of the collision
 * surface.
 */
export function buildRoadRibbon(roads: readonly Road[], seed: number): {
  pos: number[]; nrm: number[]; col: number[]; idx: number[];
} {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];

  for (const road of roads) {
    const pts = road.pts;
    let ring0 = -1;
    let px0 = 0;
    let pz0 = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      let tx = b.x - a.x;
      let tz = b.z - a.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const px = -tz;
      const pz = tx;
      const shoulder = Math.round(p.y);
      const ring = pos.length / 3;
      for (let k = 0; k < XS.length; k++) {
        const d = XS[k];
        const ad = Math.abs(d);
        const y = p.bridge || ad <= DECK_HALF
          ? p.y
          : p.y + (shoulder - p.y) * ((ad - DECK_HALF) / (DECK_EDGE - DECK_HALF));
        pos.push(p.x + px * d, y + RIBBON_LIFT, p.z + pz * d);
        nrm.push(0, 1, 0);
        const base = p.bridge ? DECK_PLANK
          : ad > DECK_HALF ? GRAVEL
            : ad < DECK_HALF * 0.5 ? RUT : EARTH;
        // Planks band ACROSS a bridge deck; packed earth gets a mottle instead.
        const m = p.bridge
          ? (Math.round(p.x * 0.7 + p.z * 0.7) % 2 === 0 ? 1.1 : 0.88)
          : 0.86 + hashCell(seed, Math.round(p.x), k, Math.round(p.z)) * 0.3;
        col.push(base[0] * m, base[1] * m, base[2] * m);
      }
      if (ring0 >= 0) {
        // WINDING: the perpendicular runs (-tz, tx), so advancing k moves in the
        // NEGATIVE screen-x sense relative to the direction of travel, and the
        // obvious (a0, b0, b0+1) order produces a downward normal. Captured that
        // way the whole road was invisible — front-face culled — with only the
        // skirt showing as a hairline in the grass (_town-road.png, first pass).
        for (let k = 0; k < XS.length - 1; k++) {
          const a0 = ring0 + k;
          const b0 = ring + k;
          idx.push(a0, b0 + 1, b0, a0, a0 + 1, b0 + 1);
        }
        // Skirts on both rims, so a step in the ground beside the road cannot
        // open a hole under the ribbon.
        for (const [k, sx] of [[0, -1], [XS.length - 1, 1]] as const) {
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
            for (let q = 0; q < 2; q++) col.push(RUT[0] * 0.7, RUT[1] * 0.7, RUT[2] * 0.7);
          }
          // Both windings. A skirt is four triangles at the rim of a strip that
          // bends, climbs and swaps which side is outboard as the road turns, so
          // deriving the correct facing per quad is more fiddly than it is worth;
          // one of each is always right, the other is culled, and the whole
          // network's skirts are under a thousand triangles.
          idx.push(base, base + 1, base + 3, base, base + 3, base + 2);
          idx.push(base, base + 3, base + 1, base, base + 2, base + 3);
        }
      }
      ring0 = ring;
      px0 = px;
      pz0 = pz;
    }
  }
  return { pos, nrm, col, idx };
}

/** Stamp piers and railings along every wet span of a road. */
export function addBridgeFurniture(solid: SolidStamp, parts: TownParts, road: Road): void {
  const pts = road.pts;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p.bridge) continue;
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b.x - a.x;
    let tz = b.z - a.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    const yaw = Math.atan2(tx, tz);
    const px = -tz;
    const pz = tx;
    for (const sx of [-1, 1]) {
      solid.add(
        parts.rail,
        p.x + px * sx * (DECK_HALF + 0.15), p.y, p.z + pz * sx * (DECK_HALF + 0.15),
        yaw,
      );
    }
    // A pier every fourth sample (12 units), stretched from the bed to the deck.
    if (i % 4 !== 0) continue;
    const foot = WATER_LEVEL - 1.6;
    solid.add(
      parts.pier, p.x, foot, p.z, yaw, 1.25,
      Math.max(0.4, (p.y - foot) / (PIER_VOX * V)),
    );
  }
}
