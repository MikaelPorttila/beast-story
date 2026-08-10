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
import { buildFence, type Fence, type FenceParts } from './fences';
import { builtDeck, SEG_LEN, type Junction, type Road, type RoadSample } from './roads';
import { type PathProfile } from './path-profile';
import { WATER_LEVEL } from './terrain';
import { hashCell } from './noise';

/** World units per voxel for everything in this file. See rule 3 above. */
export const V = 0.28;

/** The palisade template's unscaled length along its own +z, in world units. */
export const PALISADE_SPAN_LEN = 15 * V;

/**
 * Divide a wall run into whole palisade templates and fit every one end to end.
 *
 * `ceil` keeps the log rhythm at or denser than the authored template. The
 * independent length scale is the important half: the old fixed-length stamps
 * overlapped by 0.45 units on a full camp side and by about 1 unit beside the
 * gate. Their differently shaded outer faces then occupied the same plane,
 * producing issue #128's depth-buffer flicker. Fitting the length makes the
 * end faces touch without putting any two outward faces on top of each other.
 */
export function fitPalisadeRun(length: number, scale: number): {
  count: number;
  pitch: number;
  lengthScale: number;
} {
  const count = Math.max(1, Math.ceil(length / (PALISADE_SPAN_LEN * scale)));
  const pitch = length / count;
  return { count, pitch, lengthScale: pitch / PALISADE_SPAN_LEN };
}

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
 * How far off the body's voxel grid every glow piece is nudged, in voxels.
 *
 * A FLAME AND THE THING HOLDING IT ARE TWO MODELS PAINTED INTO ONE VOLUME, and
 * that is not an accident of any one builder — it is forced. `VoxelModel.build`
 * culls a face whose neighbouring cell is painted, but it can only see cells in
 * its OWN model, and a glow can never share a model with its body because the
 * two go into different accumulators on different materials (see below). So the
 * culling that keeps a single model free of internal surfaces is exactly what
 * cannot run across the pair, and every place a flame overlaps its logs, its
 * bowl or its cage, both models emit a face onto the same plane. The depth
 * buffer then picks between them per triangle, and the player sees a hard
 * diagonal seam swimming across a fire. Measured before this constant existed:
 * 0.0784 m2 on the campfire and the lamp — one WHOLE voxel face of glowing
 * orange flickering against a dark log — and 0.0154 on a brazier.
 *
 * TURNING THE PIECE CANNOT FIX IT, which is the part worth knowing before
 * reaching for a yaw instead. towns.ts stamps the campfire's body and flame at
 * two independent `rng() * 6.28` draws, and that genuinely does part the two
 * VERTICAL grids almost always — but a face whose normal is +Y is +Y at every
 * rotation, so the horizontal faces coincide at EVERY yaw, and `bakeAt` lands
 * the flame's voxel layers on precisely the body's own Y grid. The other two
 * pairs do not even get the vertical half: a lamp stamps body and lantern at
 * one shared yaw so the bracket points the same way, and a hamlet's braziers
 * are both stamped at 0.
 *
 * So the grid is parted here instead, in all three axes, which is the remedy
 * AGENTS.md prescribes for two parts of one body sharing a face plane (Gain's
 * `NECK_Z` is the same move on a rig). 0.08 of a voxel is 22 mm at V = 0.28:
 * about eighty times the depth buffer's resolution at the distance a camp is
 * read from, and a twelfth of a voxel on a model whose smallest feature is a
 * whole one. It has to be applied on ALL THREE axes rather than just Y — the
 * two aligned-yaw pairs above fight on their vertical faces too — and it works
 * whatever the relative yaw, because a translation that is not a multiple of
 * the voxel scale stays one after a rotation.
 *
 * `tools/test-zfight.mjs` is the guard, and its town section sweeps relative
 * yaw for exactly this reason.
 */
const GLOW_PART = 0.08;

/**
 * Bake, then shift the result by (dx, dy, dz) WORLD units — and off the body's
 * face grid by `GLOW_PART`.
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
 *
 * That same forced separation is what makes the parting necessary, and this is
 * the one function every glow piece in the file already passes through, so a
 * new one gets it without anyone having to remember. See `GLOW_PART`.
 */
function bakeAt(
  model: VoxelModel, scale: number, dx: number, dy: number, dz: number,
): Template {
  const t = bakeProp(model, scale);
  const part = GLOW_PART * scale;
  for (let i = 0; i < t.pos.length; i += 3) {
    t.pos[i] += dx + part;
    t.pos[i + 1] += dy + part;
    t.pos[i + 2] += dz + part;
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
  // Lashed rail on the inside, and a SILL LOG along the outside so the wall
  // grows out of the ground instead of resting on it. That course was rock
  // until the camp went all-timber; it is the same box in a dark log colour,
  // because deleting it flattens the outer face and drops the base into the
  // grass — the job it does is geometric, not material.
  v.box(2, 5, 0, 2, 5, 14, shade(PLANK_DARK, 1.05));
  v.box(-1, 0, 0, -1, 1, 14, shade(LOG, 0.72));
  for (let z = 1; z < 14; z += 5) v.set(2, 6, z, ROPE);
  return bakeSolid(v, V);
}

/**
 * The post a square wall turns on.
 *
 * Three voxels square and taller than the logs beside it, with a chamfered cap.
 * Not structural — two runs meeting at a corner already overlap in that cell,
 * so there is no hole to plug — but butt-jointed log ends read as two fences
 * that happen to meet, where a post with walls hung off it reads as a stockade.
 */
function cornerPost(): Template {
  const v = new VoxelModel();
  const r = rnd(0x6c17);
  const H = 13;
  for (let y = 0; y <= H; y++) {
    const c = shade(LOG, 0.76 + r() * 0.3);
    v.box(-1, y, -1, 1, y, 1, c);
  }
  // Chamfer: the top course loses its corners, the one above is a single cap.
  v.box(0, H + 1, -1, 0, H + 1, 1, shade(LOG, 1.14));
  v.box(-1, H + 1, 0, 1, H + 1, 0, shade(LOG, 1.14));
  v.set(0, H + 2, 0, shade(LOG, 1.22));
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
  // A TENT IS ALL ROOF — canvas, ridge pole and mouth alike — so the whole model
  // is bracketed and its collider is one cylinder lying along the pole. See
  // `measureRidge`. The pegs are outside it because they are not the tent: at a
  // quarter of a unit they are under the step rule and measure as nothing at
  // all, and inside the bracket they would widen the span by two cells.
  const canvas = v.region(() => {
    for (let z = 0; z <= len; z++) {
      // The canvas sags toward the mouth, which is what stops the tent reading
      // as an extruded triangle.
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
    // Dark mouth, so the tent has a way in.
    for (let k = -3; k <= 3; k++) {
      for (let y = 0; y <= 4; y++) v.set(k, y, len, shade(SOOT, 1.0));
    }
  });
  for (const z of [0, len]) {
    v.set(-W - 1, 0, z, shade(IRON, 1.0));
    v.set(W + 1, 0, z, shade(IRON, 1.0));
  }
  return bakeSolid(v, V, canvas);
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
  // BRACKETED, so the collider for it is a cylinder along the ridge rather than
  // a box at the height of it — see `measureRidge`. Everything at or above the
  // lowest course here is out of the box measurement too, which is what leaves
  // the hut two colliders with a chimney standing up the side of it.
  const thatch = v.region(() => {
    for (let k = 0; k <= D + 1; k++) {
      const y = H + 1 + k;
      const c = k % 2 === 0 ? THATCH : THATCH_DARK;
      for (let x = -W - 1; x <= W + 1; x++) {
        v.set(x, y, -(D + 1 - k), shade(c, 0.86 + r() * 0.28));
        v.set(x, y, D + 1 - k, shade(c, 0.86 + r() * 0.28));
      }
    }
    for (let x = -W - 1; x <= W + 1; x++) v.set(x, H + D + 2, 0, shade(THATCH, 1.12));
  });
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
  return bakeSolid(v, V, thatch);
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

/**
 * The flame itself. Goes on the glow material.
 *
 * SIZED AGAINST THE HERO, who is 1.8 units. It was 8 layers on a base radius
 * of 3.2 voxels — 2.24 units tall and 1.96 wide, taller than the player and
 * filling more than half the diameter of its own 3.64-unit stone ring, which is
 * a bonfire and not a campfire. 5 layers on 2.4 is 1.40 by 1.40: it sits down
 * inside the ring the way a fire that people cook on does.
 *
 * The size is also most of the brightness complaint, and this is why it is the
 * first lever rather than the emissive: bloom energy goes with the LIT AREA, and
 * that change takes the flame's silhouette from ~104 candidate cells to ~37, so
 * roughly two thirds of the wash leaves with the volume. The other third is the
 * emissive, which now has a material of its own — see `fireGlow` in towns.ts.
 *
 * The palette bands move with the layer count, or the whole thing goes pale:
 * the old `y > 4` put FLAME_PALE on the top three of eight, and on five layers
 * the same test would leave only embers.
 */
function campfireFlame(): Template {
  const v = new VoxelModel();
  const r = rnd(0x4d09);
  for (let y = 0; y <= 4; y++) {
    const rr = Math.max(0, 2.4 - y * 0.42);
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) {
        if (x * x + z * z > rr * rr) continue;
        if (r() < 0.16 + y * 0.07) continue;
        v.set(x, y + 1, z, y > 3 ? FLAME_PALE : y > 1 ? FLAME : EMBER);
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
 * THE FENCE KIT — one stake, one plank, and the two variants of the stake.
 *
 * Everything here is a PIECE. Where the pieces go is world/fences.ts's job, and
 * the split is the whole of issue #105: the fences this replaces were stamped as
 * fixed-length PANELS at whatever interval the caller felt like, so a run laid
 * at 4.2 units on a bend, or along a bridge sampled every 3, left planks joined
 * to one stake and hanging in the air at the other end. A panel cannot know how
 * far its neighbour is; a chain of posts with a plank measured between each
 * adjacent pair cannot get it wrong.
 *
 * The pieces are therefore authored to a CONTRACT rather than to a length:
 *
 *  - a post is a single column at its own origin, so the point it is stamped at
 *    is the point the planks meet;
 *  - a plank runs along +z and is stamped with a LENGTH SCALE (`Accum.add`'s
 *    `sz`), so a bay is exactly as long as the gap it spans;
 *  - that plank is narrowed across x before it is stamped, so the part buried
 *    in a stake is behind its face and the visible timber grows out from the
 *    middle of the post side instead of drawing on the same depth plane;
 *  - `FENCE_RAIL_AT` is where the planks sit and `FENCE_POST_H` how far the
 *    stake reaches, both in units above the line the fence is laid on, and
 *    fences.ts derives every height it stamps from those two.
 *
 * The look is the rough tree fence this had before — unsquared branches lashed
 * between forked stakes, not a garden fence.
 */

/** Voxel height of the plain stake. The taller one is `FENCE_TALL_VOX`. */
const FENCE_POST_VOX = 6;
const FENCE_TALL_VOX = 9;
/** Where the lantern's cage sits on the lantern stake, in voxels. */
const FENCE_LAMP_VOX = 10;
/** Voxel length of one plank template, the unit `sz` stretches. */
const FENCE_RAIL_VOX = 10;

/** How far a plain stake stands above the line the fence is laid on. */
export const FENCE_POST_H = FENCE_POST_VOX * V;
/** The taller stake's own height, and the lantern stake's, cage included. */
const FENCE_TALL_H = FENCE_TALL_VOX * V;
const FENCE_LANTERN_H = (FENCE_LAMP_VOX + 5) * V;
/**
 * Plank BOTTOMS, in units above that same line. Lower one first.
 *
 * The upper course sits half a voxel below its old position. Its 0.56-unit
 * height now stops 0.14 units below a plain post's cap, enough to keep the two
 * top faces distinct when the fence is viewed from overhead (issue #127).
 */
export const FENCE_RAIL_AT = [1.5 * V, 3.5 * V] as const;
/** How long one plank template is, i.e. what a bay's `sz` is measured against. */
export const FENCE_RAIL_LEN = FENCE_RAIL_VOX * V;
/** Finished height of the two-voxel plank template. */
export const FENCE_RAIL_HEIGHT = 2 * V;
/** The authored stake and rail are each one voxel wide before stamp scaling. */
export const FENCE_POST_WIDTH = V;
/**
 * Finished plank width across the run.
 *
 * 60% leaves 0.056 units of post face visible on each side of a 0.28-unit
 * stake: comfortably beyond a depth-buffer coincidence while keeping the
 * branch substantial rather than turning it into a flat slat (issue #127).
 */
export const FENCE_RAIL_WIDTH = FENCE_POST_WIDTH * 0.6;
/** Half-width of a stake, for "does this post stand on the road" tests. */
export const FENCE_POST_R = V;

/** One stake: a column with a fork at the top for the planks to sit in. */
function fenceStake(vox: number, seed: number): VoxelModel {
  const v = new VoxelModel();
  const r = rnd(seed);
  for (let y = 0; y < vox; y++) v.set(0, y, 0, shade(LOG, 0.84 + r() * 0.32));
  // The fork opens ALONG the run (+/-z), which is the direction the planks
  // arrive from — fences.ts stamps a post at the bearing of its own bays.
  v.set(0, vox - 1, -1, shade(LOG, 1.1));
  v.set(0, vox - 1, 1, shade(LOG, 0.9));
  return v;
}

/**
 * The plain stake and the taller one.
 *
 * `bakeProp`, NOT `bakeSolid`, and this is the one place in the kit where that
 * needs saying: a fence is made solid by its PLANKS, which span every bay end to
 * end, so a post collider would be a second box inside one that already covers
 * it. Posts carry the look; the rails carry the wall. See `fenceRail`.
 */
function fencePost(): Template {
  return bakeProp(fenceStake(FENCE_POST_VOX, 0x9143), V);
}

function fencePostTall(): Template {
  return bakeProp(fenceStake(FENCE_TALL_VOX, 0x51c7), V);
}

/**
 * A stake with a lantern hung in a cage on top — the same emissive-voxel trick
 * `lampBody` uses, and for the same reason: a real point light per lantern would
 * recompile every lit material in the game (see rule 2 at the top of this file).
 */
function fenceLanternPost(): Template {
  const v = fenceStake(FENCE_LAMP_VOX, 0x2ba9);
  v.box(-1, FENCE_LAMP_VOX, -1, 1, FENCE_LAMP_VOX, 1, shade(IRON, 1.1));
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    v.box(x, FENCE_LAMP_VOX + 1, z, x, FENCE_LAMP_VOX + 3, z, IRON);
  }
  v.box(-1, FENCE_LAMP_VOX + 4, -1, 1, FENCE_LAMP_VOX + 4, 1, shade(IRON, 0.85));
  return bakeProp(v, V);
}

/** The flame inside that cage, on the glow material. */
function fenceLanternGlow(): Template {
  const v = new VoxelModel();
  for (let y = FENCE_LAMP_VOX + 1; y <= FENCE_LAMP_VOX + 3; y++) {
    v.set(0, y, 0, y > FENCE_LAMP_VOX + 2 ? FLAME_PALE : FLAME);
  }
  // The cage's own x/z extent is -1..1 and this column is 0..0, which `bounds`
  // centres to the same place — so unlike `lampFlame` there is no lateral
  // correction, only the height the cage starts at. See `bakeAt`.
  return bakeAt(v, V, 0, (FENCE_LAMP_VOX + 1) * V, 0);
}

/**
 * One plank, along +z, `FENCE_RAIL_LEN` long — the length a bay divides by.
 *
 * `bakeSolid`: this is what makes a fence a barrier. A bay's plank spans its two
 * posts end to end, so a run of them is a continuous wall with no gap between
 * bays and exactly one collider per bay. The lower plank is stamped from the
 * same template through `bakeProp`'s twin below, because a second box inside the
 * first blocks nothing and costs a query.
 */
function fenceRail(): Template {
  const v = new VoxelModel();
  const r = rnd(0x7d31);
  for (let z = 0; z < FENCE_RAIL_VOX; z++) {
    v.set(0, 0, z, shade(LOG_PALE, 0.82 + r() * 0.34));
    v.set(0, 1, z, shade(LOG_PALE, 0.82 + r() * 0.34));
  }
  return bakeSolid(v, V);
}

/** The same plank with no collider, for every course below the top one. */
function fenceRailProp(): Template {
  const v = new VoxelModel();
  const r = rnd(0x11a5);
  for (let z = 0; z < FENCE_RAIL_VOX; z++) {
    v.set(0, 0, z, shade(LOG_PALE, 0.8 + r() * 0.36));
    v.set(0, 1, z, shade(LOG_PALE, 0.8 + r() * 0.36));
  }
  return bakeProp(v, V);
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

// ---------------------------------------------------------------------------

/** Every baked piece, built once. towns.ts stamps from here. */
export class TownParts {
  readonly palisade = palisadeSpan();
  readonly cornerPost = cornerPost();
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
  readonly post = signPost();
  readonly pier = bridgePier();
  /**
   * The fence kit, in the shape world/fences.ts stamps from. One object rather
   * than four fields on `TownParts`, so a second world that grows fences — the
   * sky island already has its own — hands the chain builder its own kit and
   * nothing else changes.
   */
  readonly fence: FenceParts = {
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
/** Ring spacing of the drawn ribbon, world units. See `subdivide`. */
const RING_LEN = 1;

/**
 * WHERE `RIM_GUARD` AND `XS` WENT — `PathProfile.rimGuard` and
 * `PathProfile.xs`, derived with the rest of the band (path-profile.ts, issue
 * #142). The notes on both are worth keeping, because they are the measurements
 * the derivation has to keep reproducing.
 *
 * RIM GUARD — how far around a rim vertex the ribbon looks for ground it has to
 * cover. Half a cell diagonal, rounded up, and the same 0.707 that sets
 * `carveInset`: a terrain column is a 1-unit cell sampled at its centre, so the
 * ground a rim vertex is responsible for hiding can be that far from it. It does
 * NOT scale with the path — the grid is the grid.
 *
 * CROSS-SECTION — nine offsets, at the router's own ring spacing, and both
 * numbers are load-bearing for how the road LOOKS rather than for where it is.
 *
 * The two at `deckEdge - shoulderIn` are not refinement — they are the corner
 * the cross-section actually has. Outside `deckHalf` the walking surface ramps
 * from the deck to `round(deck)` and REACHES it there, holding it out to the
 * rim so that it matches the floored terrain column beside it (roads.ts,
 * `shoulderIn`). Without a vertex on that corner the ribbon draws one straight
 * chord from the deck to the rim and passes UNDER the shoulder for the whole
 * 1.4 units between: measured on seed 1337, 178 of 5267 cross-road samples had
 * terrain drawn over the ribbon by up to 0.622 — the "ground clipping through
 * on to the road" of issue #15, all of it in that band.
 *

 * A ribbon is a smooth band laid over stepped ground — that is its whole job.
 * The rim sits at `round(deck)`, an integer that flips by a whole unit as the
 * deck passes each half, and at the router's ~3.4-unit spacing that flip is a
 * chord across 3.4 units: a gentle slope you cannot pick out. A pass that
 * subdivided the rings to 1.4 and the section to 0.7, chasing the last tenth of
 * a unit of ribbon float at the fork, turned every one of those flips into a
 * 1-unit crease over 1.4 units — and where a deck hovers near `n + 0.5`,
 * `round` oscillates between consecutive rings and the rim zigzags. Captured
 * side by side, the road stopped reading as one mass of earth and started
 * reading as torn paper. It bought 0.64 -> 0.49 at one spot.
 *
 * So the tessellation stays coarse and the ribbon goes on smoothing the ground
 * instead of reproducing it. Correctness is `surfaceAt`'s job, and the residue
 * this was chasing turned out to be the junction's rather than the ribbon's —
 * see `buildJunctionApron`.
 */

/**
 * ONE CROSS-SECTION VERTEX, height and all — the ribbon's and the apron's.
 *
 * Shared rather than duplicated because the apron's rim IS the ribbon's first
 * ring: the same nine offsets on the same sample, and the seam between them is
 * invisible only while both arrive at the same number. Two copies of this
 * arithmetic would agree on the day they were written.
 */
function sectionAt(
  surfaceAt: (x: number, z: number) => number,
  prof: PathProfile,
  p: RoadSample, px: number, pz: number, tx: number, tz: number, d: number,
): { x: number; y: number; z: number } {
  const ad = Math.abs(d);
  // A span is flat to its edge and has water under it; everything else reads
  // the walking surface at the vertex, rim pulled just inside.
  const sd = Math.sign(d) * Math.min(ad, prof.deckEdge - 0.02);
  let y = p.bridge ? p.y : surfaceAt(p.x + px * sd, p.z + pz * sd);
  // AND THE RIM COVERS THE COLUMN IT IS THERE TO HIDE.
  //
  // Outside `deckHalf` the walking surface is `round(deck)` — an INTEGER, so
  // that it matches the floored terrain column beside it (roads.ts, `carveAt`)
  // — and `round` flips by a whole unit as the deck passes each half. The rim
  // vertex and the cell it covers are up to half a cell diagonal apart, and on
  // a bend they can project onto different road segments, so the two can land
  // either side of that flip: measured on seed 1337, a ring whose deck was
  // 16.479 on one side and 16.501 on the other drew both rims at shoulder 16
  // with the ground at 17 under one of them, and 0.898 units of grass stood up
  // through the gravel. 193 of 5267 cross-road samples were poking that way.
  //
  // So a rim takes the HIGHEST surface within half a cell of itself. It can
  // only rise, never sink, and it rises exactly where the ground it covers does
  // — the outer 0.8 of verge banks up with the shoulder instead of cutting
  // through it. Interior vertices are deliberately left alone: the deck is
  // smooth and continuous, there is nothing there to cover, and a max taken at
  // `deckHalf` would pull the carriageway's edge up onto the verge ramp and bury
  // the player's feet in it.
  //
  // BOTH shoulder vertices, not only the rim. Between the shoulder corner and
  // the rim the ribbon is a chord between the two, so guarding the rim
  // alone left the inner end of that chord free to drop under a flipped column
  // — 57 of 5267 samples, every one of them in that 0.8-unit band, and 36 with
  // both guarded.
  //
  // 22 SURVIVED THIS, AND EVERY ONE OF THEM WAS AT THE FORK. A ring is ~3 units
  // long and the ribbon between two rings is a chord; where two arms overlapped
  // near the junction, `nearest` handed two points a unit apart to different
  // roads, and a chord between two correctly-guarded rings still passed under a
  // column the other arm's shoulder had rounded the other way. Subdividing the
  // rings would have closed it and is the change that made the road read as
  // torn paper (see XS above); what actually closed it was removing the overlap
  // — an arm now starts at the junction's rim and the apron draws the middle
  // (`buildJunctionApron`). It is 0 of 5295 today; `tools/test-road.mjs`
  // reports the count and the fork is the place to look if it moves.
  // NOTHING IS LIFTED HERE ANY MORE, AND THAT IS THE FIX FOR WALKING ON IT.
  //
  // This used to raise a rim vertex to the highest walking surface within half
  // a cell of itself, on the argument that it "can only rise, never sink".
  // Rising is not free. The ribbon IS the walking surface — the founding rule
  // of the whole corridor — so a ribbon drawn above it is a hero standing
  // INSIDE the road. Measured at the rim: 1.031, with 161 samples over 0.2 on
  // one stretch. The centreline sink pass never saw it, because it samples the
  // middle of the carriageway where the deck and the ribbon agree by
  // construction; it took a screenshot of the hero buried to the waist.
  //
  // The thing the lift existed to hide — a terrain cube standing through the
  // gravel — is taken from the other end now, by lowering the GROUND.
  // `Terrain.columnTopAtCell` clips a column to the lowest walking surface its
  // own cell touches. That direction is safe where lifting was not: outside a
  // rim `getHeight` IS the drawn column, so collision follows the drawing down
  // instead of being left behind above it.
  return { x: p.x + px * d, y, z: p.z + pz * d };
}

/** The colour of that vertex: rut down the middle, gravel at the verge. */
function sectionColour(
  seed: number, prof: PathProfile, p: RoadSample, k: number, d: number,
): [number, number, number] {
  const ad = Math.abs(d);
  const pal = prof.palette;
  const base = p.bridge ? pal.plank
    : ad > prof.deckHalf ? pal.gravel
      : ad < prof.deckHalf * 0.5 ? pal.rut : pal.earth;
  // Planks band ACROSS a bridge deck; packed earth gets a mottle instead.
  const m = p.bridge
    ? (Math.round(p.x * 0.7 + p.z * 0.7) % 2 === 0 ? 1.1 : 0.88)
    : 0.86 + hashCell(seed, Math.round(p.x), k, Math.round(p.z)) * 0.3;
  // NO WEAR PATCH ON TOP OF THIS. One was built and captured and removed: at
  // nine vertices per ring and rings ~3 units apart, a per-cell darkening is
  // interpolated over six units of road and arrives as a gradient the mottle
  // above already covers. See the note where `disrepair` would have been, in
  // path-profile.ts.
  return [base[0] * m, base[1] * m, base[2] * m];
}

/**
 * Re-space a clipped deck at RING_LEN, so the ribbon's chords are a cell long.
 *
 * The router works at `SEG_LEN` 3, which is the right spacing for a ROUTE — it
 * is what keeps the spatial grid's buckets small and the plan view smooth. It
 * is the wrong spacing for the DRAWING, and every reading in this file that
 * refuses to go to zero says so: the shoulder a ribbon is laid over is
 * `round(deck)`, an integer that flips by a whole unit as the deck passes each
 * half, and a chord three units long over a surface that steps by one either
 * passes under a cube (the ground shows through) or over the walking surface
 * (the hero is buried in the road). Measured on seed 1337 at 3 units, both at
 * once: 45 columns with ground through the gravel at worst 0.899, and 250 with
 * the ribbon above the hero's feet at worst 0.737.
 *
 * A cell is one unit, so rings a cell apart cannot straddle a flip.
 */
function subdivide(pts: RoadSample[]): RoadSample[] {
  if (pts.length < 2) return pts;
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
        // A ring between two samples inherits the span flag, the same argument
        // `builtDeck` makes: half a bridge is not a thing.
        bridge: a.bridge || b.bridge,
      });
    }
  }
  return out;
}

/**
 * The deck polyline with everything inside a fork's apron removed, and a
 * terminal sample interpolated exactly onto the rim.
 *
 * ONE function for the ribbon and for the apron, for the same reason `builtDeck`
 * is one function: the arm's first ring and the apron's rim in that direction
 * are the same nine vertices, and they can only be the same nine vertices if
 * both sides agree to the last bit about where the arm starts.
 *
 * Only the ENDS are trimmed. A road that dived into an apron and came out again
 * would be a road that passes through its own junction, which the router cannot
 * produce and which a mid-polyline clip would answer wrongly anyway (it would
 * keep the far side and silently drop the near one).
 */
function clipToApron(pts: RoadSample[], aprons: readonly Junction[]): RoadSample[] {
  if (aprons.length === 0 || pts.length < 2) return pts;
  // Each apron's own radius: a fork of footpaths is a smaller fork.
  const inside = (p: RoadSample): boolean =>
    aprons.some((a) => Math.hypot(p.x - a.x, p.z - a.z) < a.profile.apronR);
  /** Where the segment a->b crosses out of the apron b is outside of. */
  const rim = (a: RoadSample, b: RoadSample): RoadSample => {
    let lo = 0;
    let hi = 1;
    // Bisection rather than the quadratic's root: the polyline is resampled at
    // SEG_LEN and a dozen halvings put the crossing inside a tenth of a
    // millimetre, which is far under RIBBON_LIFT.
    for (let i = 0; i < 24; i++) {
      const t = (lo + hi) / 2;
      const p = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
      if (aprons.some((q) => Math.hypot(p.x - q.x, p.z - q.z) < q.profile.apronR)) lo = t;
      else hi = t;
    }
    return {
      x: a.x + (b.x - a.x) * hi,
      z: a.z + (b.z - a.z) * hi,
      y: a.y + (b.y - a.y) * hi,
      // A cut end inherits the span flag, exactly as `builtDeck`'s does.
      bridge: a.bridge || b.bridge,
    };
  };
  let lead = 0;
  while (lead < pts.length && inside(pts[lead])) lead++;
  let tail = pts.length - 1;
  while (tail > lead && inside(pts[tail])) tail--;
  if (tail - lead < 1) return [];
  const out = pts.slice(lead, tail + 1);
  if (lead > 0) out.unshift(rim(pts[lead - 1], pts[lead]));
  if (tail < pts.length - 1) out.push(rim(pts[tail + 1], pts[tail]));
  return out;
}

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
/**
 * The gravel ribbon for one road.
 *
 * `surfaceAt` MUST be the same walking-surface query the player resolves
 * against — `Terrain.getHeight` — and every vertex takes its height from it.
 * That is not a refinement, it is the fix for a real bug: this used to build
 * the cross-section from the road's OWN deck profile (`p.y` ramping to
 * `round(p.y)`), which is right only while one road owns the column. Near the
 * fork, where three carriageways overlap, each ribbon was drawn on its own
 * deck while the surface underfoot is whichever road is NEAREST — measured at
 * the spawn, `road:junction-stonewatch` was drawn 0.43 above the ground the
 * hero stands on, and further along the same road 0.82. The hero is exactly
 * where the physics puts him and looks buried to the chest, because the road
 * in front of him is drawn over his legs.
 *
 * Sampling the authority per vertex makes "what you see is what you stand on"
 * true by construction rather than by two formulas agreeing, which is the same
 * argument `builtDeck` already makes about where a road STOPS.
 *
 * Two things deliberately do not go through it. A BRIDGE deck is flat to its
 * own edge over open water, and the surface under it is the riverbed. And the
 * rim sample is pulled a hair inside `DECK_EDGE`, because at exactly the edge
 * the query has already handed back to the natural ground and would drop the
 * ribbon's outer edge onto whatever the terrain does there.
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
  pos: number[]; nrm: number[]; col: number[]; idx: number[];
} {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];

  for (const road of roads) {
    // The BUILT deck, not the route. A road may be surfaced over less than it
    // is routed over — the Encampment's is — and drawing the route would put
    // gravel where no carriageway was carved. See Road.trim in roads.ts.
    // ...and then the part of it that is not somebody else's junction. An arm
    // GROWS FROM THE APRON: it starts on the rim and the apron covers the rest,
    // which is the whole of issue #45 — three ribbons all drawn to the node,
    // each ending in a square cross-section on top of the other two.
    const pts = subdivide(clipToApron(builtDeck(road), aprons));
    if (pts.length < 2) continue;
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
      tx /= tl; tz /= tl;
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
        // THE SOFFIT — the one face a road on the ground never needs.
        //
        // Everywhere else the ribbon is a lid on the terrain: the ground closes
        // it from below and the rim skirts hide the join. A BRIDGE has nothing
        // under it but water, and the deck's top quads face up — so from the
        // riverbank, from a boat, from anywhere the camera drops below deck
        // level, you looked straight through the bridge and out the other side.
        // That is the first screenshot in issue #105, and it is not a
        // transparency bug: there was no surface there at all.
        //
        // So a wet section gets a floor, at exactly `RIBBON_SKIRT` below the
        // deck — the same depth the rim skirts already hang to, so the three
        // meet as one closed box rather than as three pieces that nearly touch.
        // Reversed winding and a downward normal, i.e. the top strip's mirror.
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
      if (ringFirst < 0) { ringFirst = ring; pxF = px; pzF = pz; }
      ring0 = ring;
      px0 = px;
      pz0 = pz;
    }

    /**
     * A skirt ACROSS an end, which the length rims above cannot supply.
     *
     * Without it the strip stops with an open edge and you see under the last
     * ring — the ground beneath a terminus is carved lower than the deck by
     * construction (roads.ts, `carveAt`), so there is always a lip there to
     * hide, even now that the corridor ends flat instead of in a dome. The
     * outward direction is the road's own tangent: `px = -tz, pz = tx`, so
     * `t = (pz, -px)`, negated at the start.
     */
    const endSkirt = (ring: number, pxr: number, pzr: number, sign: number): void => {
      if (ring < 0) return;
      const nx = pzr * sign;
      const nz = -pxr * sign;
      const base = pos.length / 3;
      for (let k = 0; k < XS.length; k++) {
        const src = (ring + k) * 3;
        pos.push(pos[src], pos[src + 1], pos[src + 2]);
        pos.push(pos[src], pos[src + 1] - RIBBON_SKIRT, pos[src + 2]);
        nrm.push(nx, 0, nz, nx, 0, nz);
        for (let q = 0; q < 2; q++) col.push(RUT[0] * 0.7, RUT[1] * 0.7, RUT[2] * 0.7);
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

/**
 * Radial sampling of the apron, as fractions of each direction's rim radius.
 *
 * ELEVEN, and the count is set by the MOTTLE rather than by the shape. The
 * surface only bends in the outer fifth — the disc is flat until the verge ramp
 * — so three or four levels reproduce the geometry to within 0.06, and the
 * first version used six. It looked wrong in a way the heights could not
 * explain: a starburst of soft spokes radiating out of the node. A fan's
 * triangles run from the middle to the rim, so with the levels far apart every
 * ring vertex's own mottle — a per-cell value, the same noise the ribbon carries
 * — is smeared along a triangle several units long and the noise stops being
 * noise and becomes a ray. Levels roughly one unit apart, which is also the
 * spacing between neighbouring directions at the rim, make the tessellation
 * isotropic and the mottle reads as dirt again. It is 500-odd vertices for the
 * whole junction either way.
 */
const APRON_T = [0.12, 0.24, 0.36, 0.48, 0.6, 0.71, 0.8, 0.875, 0.935, 0.975, 1];
/** Rim pitch between two arms. ~5.7 degrees, so the arc reads as an arc. */
const APRON_ARC = 0.1;

/**
 * THE FORK, DRAWN AS ONE PIECE, with the arms growing out of its rim.
 *
 * Issue #45. Three roads ended on one node and each drew its own ribbon all the
 * way to it, so the middle of the junction was two or three ten-unit gravel
 * slabs stacked on each other — and because a road end is a square
 * cross-section, what you actually saw was a rectangle with two right-angled
 * corners lying across a bend. No amount of z-fighting bias fixes that; the
 * geometry is genuinely wrong, and the fix is to stop drawing three roads over
 * one another and draw the junction instead.
 *
 * The apron is a fan from the node out to a rim whose radius VARIES WITH ANGLE,
 * and that is the one non-obvious part. In the three directions an arm leaves
 * on, the rim is that arm's own first ring — the same nine cross-section
 * vertices `buildRoadRibbon` starts from, computed by the same `sectionAt` on
 * the same `clipToApron` deck, so the seam is a shared edge rather than two
 * edges that nearly meet. The ribbon and the apron therefore tile the ground
 * exactly once: no overlap to fight, no gap to fall through.
 *
 * BETWEEN two arms the rim is NOT the circle of radius `APRON_R`, and the first
 * version that made it one is why this is spelled out. A disc reaching eleven
 * units in every direction paves a lobe of open meadow behind the fork that no
 * road has any business on — captured, the junction read as a roundabout with a
 * bite of grass missing beside it. The rim in a gap is instead the two arms' OWN
 * OUTER EDGES, run on until they meet: `rimHit` intersects the ray from the node
 * with the edge line through each neighbouring arm's rim corner, and the nearer
 * of the two wins. That is the shape a junction actually has — one road's kerb
 * running into the next one's — and it costs nothing to say, because the corner
 * it starts from is already a vertex of the arm's first ring. It pinches to
 * `DECK_EDGE / cos((pi - gap) / 2)`: 7.3 units between arms a right angle apart,
 * 5.0 between two that are nearly one straight road.
 *
 * `surfaceAt` is the same walking-surface query the ribbon and the player use,
 * and `RoadNetwork` now answers it for the disc as well (`JUNCTION_FLAT`) — so
 * this is a drawing of the collision surface here exactly as the ribbon is one
 * along an arm.
 */
export function buildJunctionApron(
  apron: Junction,
  roads: readonly Road[],
  seed: number,
  surfaceAt: (x: number, z: number) => number,
  liftBias = 0,
): {
  pos: number[]; nrm: number[]; col: number[]; idx: number[];
} {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];

  // THE APRON'S OWN PROFILE, not each arm's. `apronR` sizes the disc every arm
  // is clipped back to, so it has to be one number for the node — the arms are
  // clipped against it by `clipToApron` and their first rings have to land on
  // it. A node where two profiles MEET is a transition, and the wider of the
  // two owns the apron (issue #142, §14: precedence).
  const prof = apron.profile;
  const APRON_R = prof.apronR;
  const XS = prof.xs;
  const { rut: RUT, earth: EARTH, gravel: GRAVEL } = prof.palette;
  const RIM_GUARD = prof.rimGuard;

  const ang = (x: number, z: number): number => Math.atan2(x - apron.x, z - apron.z);
  const wrap = (a: number): number => {
    let v = a;
    while (v <= -Math.PI) v += Math.PI * 2;
    while (v > Math.PI) v -= Math.PI * 2;
    return v;
  };
  // PURELY SPATIAL, and on the same cell the ribbon's own centre vertex hashes,
  // so the packed earth of an arm and the packed earth of the apron are the
  // same dirt where they meet. A mottle that took the ring index as well —
  // which the ribbon's does, because along a road that index IS a position —
  // banded the apron in rings and streaked it in spokes: the fan's triangles
  // run from the middle to the rim, so any per-direction or per-level term is
  // interpolated the whole way down them and reads as a starburst.
  const mottle = (x: number, z: number): number =>
    0.86 + hashCell(seed, Math.round(x), 4, Math.round(z)) * 0.3;

  type Dir = { x: number; z: number; y: number; a: number; c: [number, number, number] };
  /** A rim corner and the direction its arm's outer edge runs off in. */
  type Edge = { x: number; z: number; tx: number; tz: number; a: number };
  const dirs: Dir[] = [];
  /** Each arm's angular claim, and the two edges bounding it. */
  const arms: Array<{ lo: Edge; hi: Edge }> = [];

  for (const road of roads) {
    const pts = clipToApron(builtDeck(road), [apron]);
    if (pts.length < 2) continue;
    // WHICH END IS OURS, and is it ours at all — a road can pass a junction it
    // does not join, and one that was clipped by a DIFFERENT apron has a
    // terminal ring that is nothing to do with this one. Only an end sitting on
    // this rim counts.
    const head = Math.hypot(pts[0].x - apron.x, pts[0].z - apron.z)
      <= Math.hypot(pts[pts.length - 1].x - apron.x, pts[pts.length - 1].z - apron.z);
    const p = head ? pts[0] : pts[pts.length - 1];
    if (Math.abs(Math.hypot(p.x - apron.x, p.z - apron.z) - APRON_R) > 0.05) continue;
    // The tangent the ribbon uses at that ring, to the letter: its first ring
    // looks forward and its last looks back, and `k` has to run the same way
    // round or the two sides mottle differently across a shared edge.
    const q = head ? pts[1] : pts[pts.length - 2];
    let tx = head ? q.x - p.x : p.x - q.x;
    let tz = head ? q.z - p.z : p.z - q.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    const px = -tz;
    const pz = tx;
    const ends: Edge[] = [];
    for (let k = 0; k < XS.length; k++) {
      const v = sectionAt(surfaceAt, road.profile, p, px, pz, tx, tz, XS[k]);
      const a = ang(v.x, v.z);
      dirs.push({
        x: v.x, z: v.z, y: v.y, a, c: sectionColour(seed, road.profile, p, k, XS[k]),
      });
      // The two rim corners are the ends of the ring, and the angle around the
      // node runs monotonically along it — so they are also its angular extremes
      // and there is nothing to search for.
      if (k === 0 || k === XS.length - 1) ends.push({ x: v.x, z: v.z, tx, tz, a });
    }
    const rel = wrap(ends[1].a - ends[0].a);
    arms.push(rel >= 0 ? { lo: ends[0], hi: ends[1] } : { lo: ends[1], hi: ends[0] });
  }
  if (arms.length === 0) return { pos, nrm, col, idx };
  arms.sort((u, v) => u.lo.a - v.lo.a);

  /** Where the ray at `th` crosses the kerb line through `e`, or 0. */
  const rimHit = (e: Edge, th: number): number => {
    const s = Math.sin(th);
    const c = Math.cos(th);
    const den = s * e.tz - c * e.tx;
    if (Math.abs(den) < 1e-6) return 0;
    const r = ((e.x - apron.x) * e.tz - (e.z - apron.z) * e.tx) / den;
    return r > prof.deckHalf ? r : 0;
  };
  /** No corner of the apron reaches past an arm's own ring corner. */
  let cornerR = 0;
  for (const a of arms) {
    for (const e of [a.lo, a.hi]) {
      const r = Math.hypot(e.x - apron.x, e.z - apron.z);
      if (r > cornerR) cornerR = r;
    }
  }

  // The gaps. Each runs from one arm's outer corner round to the next arm's,
  // and the height is read a hair INSIDE the rim, for the reason the ribbon
  // pulls its own rim sample in: at exactly DECK_EDGE the corridor query has
  // already handed back to the natural ground.
  for (let i = 0; i < arms.length; i++) {
    const from = arms[i].hi;
    const to = arms[(i + 1) % arms.length].lo;
    const span = wrap(to.a - from.a);
    if (span <= 0) continue;   // arms whose rings overlap in angle: no gap
    const steps = Math.max(2, Math.ceil(span / APRON_ARC));
    for (let k = 1; k < steps; k++) {
      const a = from.a + (span * k) / steps;
      // THE FARTHER KERB, NOT THE NEARER ONE, and getting that backwards is
      // worth a sentence because the render looks deliberate either way. Two
      // arms' kerb lines CROSS inside the junction — B's kerb, produced back
      // past the node, runs straight over the middle of A's carriageway — so
      // the nearer of the two is a line through the fork, and taking it cut the
      // apron back to a five-unit star with the arms' ribbons hanging over the
      // points of it. The boundary follows A's kerb outward from where the two
      // cross to A's own ring corner, and that is the MAX. It pinches to
      // `DECK_EDGE / cos((pi - gap) / 2)` where they cross: 7.3 units between
      // arms a right angle apart, 5.0 between two that are nearly one straight
      // road, which is where a kerb really would meet the next one.
      const hit = Math.max(rimHit(from, a), rimHit(to, a));
      const r = hit > 0 ? Math.min(hit, cornerR) : APRON_R;
      const sx = Math.sin(a);
      const sz = Math.cos(a);
      const qx = apron.x + sx * (r - 0.02);
      const qz = apron.z + sz * (r - 0.02);
      // The same guard the ribbon's rim carries, for the same reason: the column
      // a rim vertex is responsible for hiding sits up to half a cell away, and
      // `round(deck)` flips by a whole unit between two of them.
      let y = surfaceAt(qx, qz);
      for (const [gx, gz] of [
        [sx * RIM_GUARD, sz * RIM_GUARD],
        [sz * RIM_GUARD, -sx * RIM_GUARD],
        [-sz * RIM_GUARD, sx * RIM_GUARD],
      ] as const) {
        const g = surfaceAt(qx + gx, qz + gz);
        if (g > y) y = g;
      }
      const m = mottle(qx, qz);
      dirs.push({
        x: apron.x + sx * r, z: apron.z + sz * r, y, a,
        c: [GRAVEL[0] * m, GRAVEL[1] * m, GRAVEL[2] * m],
      });
    }
  }

  // Counter-clockwise seen from above, which is what makes (centre, i, i+1)
  // and (i, i+1) between two levels both face up — see the winding note in
  // buildRoadRibbon for what the wrong answer looks like.
  dirs.sort((u, v) => u.a - v.a);

  /**
   * The apron's own colour at a point: rut in the middle wearing to gravel at
   * the edge, which is the road's own banding turned inside out. An arm is worn
   * down its LENGTH; a junction is worn in its MIDDLE, because that is the one
   * patch every route through the world crosses.
   *
   * Banded on the ABSOLUTE distance from the node, not on the fraction of the
   * way to the rim. The rim radius varies with angle — that is the whole of the
   * fillet — so a fraction puts each band's edge at a different distance in
   * every direction, and the fan's triangles run from the middle to the rim: the
   * bands stopped being rings and became a starburst of wedges radiating out of
   * the centre. Concentric is also simply what a worn junction looks like.
   */
  const ground = (x: number, z: number): [number, number, number] => {
    const u = Math.hypot(x - apron.x, z - apron.z) / APRON_R;
    // The same PROPORTIONS an arm's cross-section has — rut over the middle
    // 28% of the half-width, packed earth to 56%, gravel past it — so the two
    // read as the same road rather than as a road with a stain on it.
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
      // The rim keeps the height its arm's ring gave it — that shared vertex is
      // the whole point — and everything inboard reads the surface where it is.
      const y = t >= 1 ? d.y : surfaceAt(x, z);
      pos.push(x, y + RIBBON_LIFT + liftBias, z);
      nrm.push(0, 1, 0);
      // The rim has to arrive at the ARM's colour or the shared edge is a seam
      // — an arm's rut stripe would meet apron gravel across the join — but the
      // direction's colour must not bleed inward, or every one of them paints a
      // spoke. So it is the apron's own ground everywhere except the outer
      // fifth, where it crosses over.
      const own = ground(x, z);
      const w = t <= 0.8 ? 0 : (t - 0.8) / 0.2;
      for (let c = 0; c < 3; c++) col.push(own[c] + (d.c[c] - own[c]) * w * w);
    }
  }

  const ring = (l: number, i: number): number => 1 + l * n + (i % n);
  for (let i = 0; i < n; i++) idx.push(0, ring(0, i), ring(0, i + 1));
  for (let l = 0; l + 1 < APRON_T.length; l++) {
    for (let i = 0; i < n; i++) {
      const a0 = ring(l, i);
      const a1 = ring(l, i + 1);
      const b0 = ring(l + 1, i);
      const b1 = ring(l + 1, i + 1);
      idx.push(a0, b0, b1, a0, b1, a1);
    }
  }

  // A skirt all the way round, so the carved lip outside the rim cannot show
  // under it. Where an arm is, this sits behind that arm's own end skirt at the
  // same line, the same depth and the same colour, so the pair is invisible
  // whichever of them the depth buffer picks.
  const skirt = pos.length / 3;
  for (const d of dirs) {
    pos.push(d.x, d.y + RIBBON_LIFT + liftBias, d.z, d.x, d.y - RIBBON_SKIRT, d.z);
    const nx = (d.x - apron.x) / APRON_R;
    const nz = (d.z - apron.z) / APRON_R;
    nrm.push(nx, 0, nz, nx, 0, nz);
    for (let q = 0; q < 2; q++) col.push(RUT[0] * 0.7, RUT[1] * 0.7, RUT[2] * 0.7);
  }
  for (let i = 0; i < n; i++) {
    const a0 = skirt + i * 2;
    const b0 = skirt + ((i + 1) % n) * 2;
    idx.push(a0, a0 + 1, b0 + 1, a0, b0 + 1, b0);
    idx.push(a0, b0 + 1, a0 + 1, a0, b0, b0 + 1);
  }

  return { pos, nrm, col, idx };
}

/**
 * How far outboard of the centreline a bridge railing stands.
 *
 * The path's own `deckHalf` plus the stake's own half-width plus a hair, so the
 * timber stands ON the deck's outer planks rather than half over the edge — the
 * deck is flat to `deckEdge` and a railing further out would have its feet in
 * the air.
 *
 * Bridges are a ROAD feature today (issue #142, §14): nothing else in the world
 * spans water. This scales with the profile so that stays an authoring decision
 * rather than a hardcoded width.
 */
const railOffset = (prof: PathProfile): number => prof.deckHalf + FENCE_POST_R + 0.1;

/**
 * Stamp piers and railings along every wet span of a road.
 *
 * The railings go through `buildFence` (world/fences.ts) like every other fence
 * in the world, and that is the fix for two thirds of issue #105. What was here
 * before stamped one whole railing unit — a post and a 2.8-unit plank — at EVERY
 * deck sample, and deck samples are ~3 units apart on a straight and closer on a
 * bend: so on a straight every plank stopped short of the next post, and on a
 * bend they overlapped and splayed. A chain measures each plank against the gap
 * it actually spans, and both cases come out right without either being a case.
 *
 * `groundAt` is the walking surface beside the deck, and it is what stops a
 * stake at the abutment hanging over the bank it should be planted in.
 */
export function addBridgeFurniture(
  solid: SolidStamp, parts: TownParts, road: Road,
  groundAt: (x: number, z: number) => number,
): Fence[] {
  const pts = road.pts;
  const off = railOffset(road.profile);
  for (let i = 0; i < pts.length; i++) {
    if (!pts[i].bridge || i % 4 !== 0) continue;
    // A pier every fourth sample (12 units), stretched from the bed to the deck.
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const yaw = Math.atan2(b.x - a.x, b.z - a.z);
    const foot = WATER_LEVEL - 1.6;
    solid.add(
      parts.pier, p.x, foot, p.z, yaw, 1.25,
      Math.max(0.4, (p.y - foot) / (PIER_VOX * V)),
    );
  }

  // One fence per SPAN and per side. A road that crosses two channels has two
  // bridges, and running one chain over both would put a railing across the
  // island between them.
  //
  // The chains are HANDED BACK rather than only stamped, because a railing is
  // the fence in this world hardest to look at — it is over water, in one place
  // per seed — and `tools/test-fence.mjs` asserts the same invariant over it
  // that it asserts over a pasture fence. Nothing in the game reads the return.
  const built: Fence[] = [];
  for (const span of bridgeSpans(pts)) {
    for (const side of [-1, 1] as const) {
      const path = span.map((k) => {
        const p = pts[k];
        const a = pts[Math.max(0, k - 1)];
        const b = pts[Math.min(pts.length - 1, k + 1)];
        const tl = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const px = -(b.z - a.z) / tl * side * off;
        const pz = (b.x - a.x) / tl * side * off;
        return { x: p.x + px, y: p.y, z: p.z + pz };
      });
      built.push(...buildFence(solid, parts.fence, path, { groundAt }));
    }
  }
  return built;
}

/** The runs of consecutive wet samples in a deck — one per bridge. */
function bridgeSpans(pts: readonly RoadSample[]): number[][] {
  const spans: number[][] = [];
  let run: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].bridge) { run.push(i); continue; }
    if (run.length > 1) spans.push(run);
    run = [];
  }
  if (run.length > 1) spans.push(run);
  return spans;
}
