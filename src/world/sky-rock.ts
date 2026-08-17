/**
 * WHAT A FLOATING ROCK IS MADE OF — the cell gauge, the shell profile constants and
 * the column painter Skyhaven's rock was built with (world/sky-island.ts), pulled
 * out so a shard cluster (world/sky-shards.ts) is the same stone. Nothing here knows
 * an outline: a caller says how deep a column is and how deep its neighbours are.
 */
import type { VoxelModel } from "../core/voxel";

export const CELL = 1.2;


/** Courses of SHEER cliff before the keel tapers. Without the band it reads as a lily pad. */
export const CLIFF = 16;


/** Taper quantisation, in courses. Noise must move whole shelves or it erases them. */
export const LEDGE = 5;


/** Turf overhang over the stone, in cells. It prints the shadow line under the grass. */
export const LIP = 1;


/** Courses in a LIP column: turf and two of dirt, no stone. `localBottom` reads it too. */
export const LIP_COURSES = 3;


export const RIM_STONE = 4;


// Read off the reference art: warm, not very saturated olive turf, cool
// desaturated stone, and a narrow warm dirt band between them.
/** Exported so a shard's sward is tinted toward the turf it grows on. */
export const GRASS = 0x7ea83c;
const GRASS_D = 0x668a30;
const GRASS_L = 0x93bd4c;
const DIRT = 0x6b5334;
const DIRT_D = 0x54401f;
// Stone albedo is picked BACKWARDS through the pipeline: sun plus a warm grade move
// R-B about +25 and cut blue to ~0.7, so stone sits near R-B -23 in to land neutral.
const STONE = 0x3b4754;
const STONE_D = 0x36414e;
const STONE_DEEP = 0x76838d;
const STONE_ROOT = 0x717e8a;
/**
 * Stone for a face that is NOTHING BUT A SOFFIT: a -Y face takes 0.62 face shade and
 * no sun, so it needs its own sky-picked albedo. A multiplier clips and spills.
 */
const STONE_SOFFIT = 0xa8b6bd;

/**
 * The collar's TOP FACE. A +Y face has the same sun relationship on every bearing and
 * takes the full face shade, so the cliff's flank walk would lie about it.
 */
const RIM_TOP = 0x5e6b7d;

/** Multiplier on a column facing dead into the sun, and on one facing away. Issue #87:
 * facing itself is direction-neutral, and the live key light owns the lit side. */
const SUN_LIT = 1.24;
const SUN_AWAY = 0.86;
/**
 * A SECOND multiplier on the away side: what a tint cannot say is OCCLUSION. A KNEE,
 * not a ramp — full strength at `SUN_KNEE`, then back up toward `SUN_BOUNCE`, since
 * past the terminator the direct term is already gone and what is left is bounce.
 */
const SUN_SHADE_K = 0.8;
const SUN_KNEE = 0.45;
const SUN_BOUNCE = 2.3;
/** The hue the two ends walk toward. Warm noon stone, cold sky bounce — a grey, not a tan. */
const ROCK_WARM = 0xb8a88e;
const ROCK_COOL = 0x2e4666;
/**
 * How far toward each a fully-facing column goes. ASYMMETRIC: the pipeline's warm
 * offset scales with light. The cool target is dark because the value walk is
 * `SUN_LIT`/`SUN_AWAY`, and a bright one would undo the shaded flank.
 */
const SUN_WARM_MIX = 0.16;
const SUN_COOL_MIX = 0.4;

/**
 * How much BRIGHTER the albedo gets with depth — it used to get darker. The keel is
 * mostly riser wall facing away from the sun, not a hole, so light falls off with
 * facing. Small, because the ramp, the shelf lift and the sun term all MULTIPLY.
 */
const DEPTH_LIFT = 0.12;
/** Ivy down the cliff face. Darker than the turf, or it reads as spilt grass. */
const VINE = 0x466f2d;
const VINE_D = 0x33501f;
const PATH = 0xb9b2a2;
const PATH_D = 0x9e9787;
const TILL = 0x6a4a2c;
const TILL_D = 0x513716;
/** The stream BED — gravel, not water. Issue #89: the water is `buildStream`'s surface. */
const BED = 0x8a8471;
const BED_D = 0x767061;

/** Per-voxel value jitter, so a face is not one flat colour. */
export function shade(hex: number, k: number): number {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return (r << 16) | (g << 8) | b;
}

/** Walk a colour toward another — the hue half of the sun term; `shade` moves value only. */
export function tintTo(hex: number, target: number, t: number): number {
  const r = ((hex >> 16) & 255) + (((target >> 16) & 255) - ((hex >> 16) & 255)) * t;
  const g = ((hex >> 8) & 255) + (((target >> 8) & 255) - ((hex >> 8) & 255)) * t;
  const b = (hex & 255) + ((target & 255) - (hex & 255)) * t;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

/** Deterministic 0..1 hash of a cell. No allocation, no rng stream to advance. */
export function hash2(x: number, z: number, salt: number): number {
  let h = (x * 374761393 + z * 668265263 + salt * 2246822519) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}


/**
 * Turf overhang at a column, in cells: `LIP`, and a cell more on a third of the rim so
 * the collar is ragged. Hashed at HALF resolution, so a notch is two cells wide.
 */
export function lipAt(gx: number, gz: number): number {
  return LIP + (hash2(Math.floor(gx / 2), Math.floor(gz / 2), 83) < 0.3 ? 1 : 0);
}

export type ShellSurface = "turf" | "paved" | "tilled" | "streambed" | "rimstone" | "track";

/**
 * Paint one column of a floating rock's SHELL into `v`: turf (or what replaces it),
 * a dirt line, then stone strata down to `depth`, with a cell painted only where a
 * face of it can be seen — near the top, at the bottom, or beside a shallower
 * neighbour (`depthOf`). `maxDepth` scales the strata bands; `depth` is this column.
 */
export function paintShellColumn(
v: VoxelModel,
gx: number,
gz: number,
depth: number,
stone: boolean,
surface: ShellSurface,
maxDepth: number,
depthOf: (gx: number, gz: number) => number,
): void {
  const j = hash2(gx, gz, 7);
  // Direction-neutral base: the live key light owns azimuth (issue #87).
  const facing = 0;
  // -1 (dead away) .. +1 (dead into it). The DIRECT term, which dies out with depth.
  const sunBase = SUN_AWAY + (facing * 0.5 + 0.5) * (SUN_LIT - SUN_AWAY);
  // ...and the occlusion half: down to `SUN_SHADE_K` across the terminator, then up
  // toward `SUN_BOUNCE`. Not faded with depth — the root has the most bounce.
  const away = Math.max(0, -facing);
  const sunShade =
    away <= SUN_KNEE
      ? 1 - (1 - SUN_SHADE_K) * (away / SUN_KNEE)
      : SUN_SHADE_K + (SUN_BOUNCE - SUN_SHADE_K) * ((away - SUN_KNEE) / (1 - SUN_KNEE));
  const sunTint = facing >= 0 ? ROCK_WARM : ROCK_COOL;
  // THE COOL TINT PEAKS AT THE TERMINATOR AND IS GONE BY THE BACK: full shade is lit
  // by skylight and the ambient is already sky-coloured, so a cool albedo there
  // double-counts and reads as navy. The warm half needs no such treatment.
  const coolFall =
    away <= SUN_KNEE ? away / SUN_KNEE : Math.max(0, 1 - (away - SUN_KNEE) / (1 - SUN_KNEE));
  const sunMix = facing >= 0 ? facing * SUN_WARM_MIX : coolFall * SUN_COOL_MIX;
  // FOUR GROUND MATERIALS, one per column: flagstone, tilled rows, gravel, turf.
  let topC: number;
  // The bed is SEEN THROUGH the water, so its jitter is wider. See BED.
  if (surface === "streambed") {
    topC = shade(j < 0.45 ? BED : BED_D, 0.9 + j * 0.22);
  }
  // THE COLLAR IS THE CLIFF SEEN END-ON, so it takes the cliff's stops — except its
  // top face, which takes only a token 0.15 of the tint. See `RIM_TOP`.
  else if (surface === "rimstone") {
    topC = tintTo(shade(RIM_TOP, 0.92 + j * 0.18), sunTint, sunMix * 0.15);
  } else if (surface === "paved") {
    topC = shade(j < 0.5 ? PATH : PATH_D, 0.94 + j * 0.14);
  }
  // A worn track is bare earth, not stone: the meadow's own dirt, trodden.
  else if (surface === "track") {
    topC = shade(j < 0.5 ? DIRT : DIRT_D, 1.02 + j * 0.16);
  }
  // Tilled soil runs in ROWS: one cell of furrow shadow every third.
  else if (surface === "tilled") {
    topC = shade(gz % 3 === 0 ? TILL_D : TILL, 0.94 + j * 0.14);
  } else {
    // A second salt on a different lattice, or the lawn wears a checkerboard.
    const g = hash2(gx * 3, gz * 7, 17);
    topC = shade(g < 0.18 ? GRASS_L : g < 0.68 ? GRASS : GRASS_D, 0.94 + j * 0.14);
  }
  v.set(gx, -1, gz, topC);
  // ...EXCEPT UNDER THE COLLAR, where it is stone too: the collar IS the cliff's top,
  // so there is no soil in it. The dirt line still runs where the turf reaches the edge.
  v.set(
    gx,
    -2,
    gz,
    surface === "rimstone"
      ? tintTo(shade(STONE_D, (0.92 + j * 0.2) * sunBase * sunShade), sunTint, sunMix)
      : shade(j < 0.5 ? DIRT : DIRT_D, 0.92 + j * 0.2),
  );
  if (!stone) {
    // An overhanging lip is soil all the way down.
    v.set(
      gx,
      -3,
      gz,
      surface === "rimstone"
        ? tintTo(shade(STONE_D, (0.9 + j * 0.2) * sunBase * sunShade), sunTint, sunMix)
        : shade(DIRT_D, 0.9 + j * 0.2),
    );
    return;
  }

  // A cell is painted when a face of it can be seen: near the top, at the bottom of
  // its own column, or where a neighbour is shallower.
  const nb = [depthOf(gx + 1, gz), depthOf(gx - 1, gz), depthOf(gx, gz + 1), depthOf(gx, gz - 1)];
  // THE STRATA ARE HORIZONTAL: keyed on ABSOLUTE depth, not on a fraction of a
  // column's own depth, which put neighbours of different depth in different bands and
  // painted the keel in one-cell vertical corduroy. `MAXD` is the total drop.
  const MAXD = maxDepth;
  // ...but not DEAD level, or the island wears four contour rings. A slow hash at 9
  // cells shifts the boundaries by up to three courses.
  const bed = (hash2(Math.floor(gx / 9), Math.floor(gz / 9), 23) - 0.5) * 6;
  for (let k = 3; k <= depth; k++) {
    const bottom = k === depth;
    // Whether any SIDE face is open — the question the soffit lift turns on.
    const sideOpen = nb.some((n) => n < k);
    const exposed = bottom || k <= 4 || sideOpen;
    if (!exposed) {
      continue;
    }
    const u = Math.min(1, Math.max(0, (k + bed - 3) / (MAXD - 3)));
    // FOUR STOPS; `CLIFF` is 16 of 74 courses, i.e. u < 0.18, which is why the light
    // stop reaches that far. A cell only ever seen as a soffit gets `STONE_SOFFIT`.
    const band = u > 0.72 ? STONE_ROOT : u > 0.46 ? STONE_DEEP : u > 0.2 ? STONE_D : STONE;
    // Every bottom cell is a soffit; only some are nothing else. One with an open side
    // face shows a lit face too, so it goes half way — one voxel, two cameras.
    const c = !bottom ? band : sideOpen ? tintTo(band, STONE_SOFFIT, 0.45) : STONE_SOFFIT;
    const jj = hash2(gx, gz - k * 31, 13);
    // A ledge's TOP face catches the sky. `drop` is how far below the shelf's lip a
    // cell sits: lip, then the course catching its bounce, then wall — three values.
    const drop = k - Math.min(nb[0], nb[1], nb[2], nb[3]);
    const shelf = !sideOpen ? 1 : drop <= 1 ? 1.26 : drop <= 2 ? 1.12 : 1;
    // THE FLANK WALK IS A CLIFF TERM AND DIES OUT WITH DEPTH: `sunBase` describes a
    // vertical wall's bearing, less true down a keel lit by bounce from every side and
    // already stripped of its direct term. A claim removed, not a brightening.
    const dir = (1 + (sunBase - 1) * (1 - 0.85 * u)) * sunShade;
    // Nothing is left of the old soffit lift — `STONE_SOFFIT` carries that read now,
    // where it cannot clip or spill onto a sunlit face.
    const under = 1;
    // COURSING, in the sheer band only: `ref-hero.png` draws block courses on the part
    // sheer enough to show them. Below it the shelves' own lips do the job.
    const course = u < 0.3 ? (k % 4 === 0 ? 0.76 : k % 4 === 2 ? 1.18 : 1) : 1;
    // THE DEPTH RAMP RUNS THE OTHER WAY NOW — see `DEPTH_LIFT`.
    // The jitter is the other half of the flat-flank fix: ±0.21 about 0.99 doubles the
    // grain without moving the mean.
    v.set(
      gx,
      -k,
      gz,
      tintTo(
        shade(c, (0.66 + jj * 0.7) * (1 + DEPTH_LIFT * u) * shelf * course * under * dir),
        sunTint,
        sunMix,
      ),
    );
  }

  // Vines, rim columns only — a strand mid-island would be inside the rock. AN ACCENT,
  // NOT A COAT: about a fifth of the face, and it is the RANGE of lengths that says
  // something is growing (the squared hash holds the median at 2-3 while `* 15` opens
  // the tail). Capped at `CLIFF`: green on the terraces reads as spilt grass.
  if (nb.some((n) => n === 0) && hash2(gx, gz, 53) < 0.28) {
    const len = 2 + Math.floor(hash2(gx, gz, 59) ** 2 * 15);
    for (let k = 3; k < 3 + len && k <= Math.min(depth, CLIFF); k++) {
      v.set(gx, -k, gz, shade(hash2(gx, gz - k, 61) < 0.5 ? VINE : VINE_D, 0.9 + j * 0.2));
    }
  }
}

