import * as THREE from "three";
import { shade, VoxelModel } from "../core/voxel";
import type { StringKey } from "../i18n";

/**
 * THE HERO'S HAIR — its own model at TWICE the body's resolution: eight cells across
 * a skull cannot draw a taper, and a swap rebuilds this mesh alone.
 *
 * COORDINATES: hair cells are the head's cells DOUBLED — hair cell (2x,2y,2z) is the
 * near corner of skull cell (x,y,z), and the mount sits where the skull mesh sits
 * (`HAIR_ORIGIN` in hero-rig.ts). The skull spans x -8..7, y 0..11, z -8..7; crown
 * is the plane y=12, face z=8, ears reach x ±10 at y 4..5, z 0..1.
 *
 * THE ODD-BOUNDARY RULE, which keeps `test-zfight` clean: the skull's planes are all
 * at EVEN hair-cell boundaries, so an exposed hair face may never land on x = ±8,
 * z = ±8, y = 12 or x = ±10. A cap overhangs by an ODD number of half-cells or sinks
 * in by one; a fringe rising to the crown rises PAST it, to 13. Opposite-facing pairs
 * are fine — one of the two is always back-face culled.
 */
export const HAIR_SCALE = 0.05;

interface Palette {
  base: number;
  dark: number;
  light: number;
}

/** Wide enough to read as strands under flat light, narrow enough not to go black. */
function palette(hex: number): Palette {
  return { base: hex, dark: shade(hex, 0.74), light: shade(hex, 1.2) };
}

/** Deterministic per-cell noise for strand breakup — the hero looks the same every build. */
function hash(x: number, y: number, z: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

/** THE GRAIN: every edge and colour patch is at least this wide, or hair is noise. */
const CHUNK = 3;

// The `+ 60` only keeps the floor sensible for the negative half of the grid.
const chunkOf = (n: number): number => Math.floor((n + 60) / CHUNK);

// Every SHAPE test goes through this, not the cell: outlines are walls of blocks.
const chunkCentre = (n: number): number => chunkOf(n) * CHUNK - 60 + (CHUNK - 1) / 2 + 0.5;

/** Tone for one cell, keyed on the CHUNK. `tip` darkens the lowest row of a fall. */
function strand(p: Palette, x: number, z: number, tip = false): number {
  if (tip) {
    return p.dark;
  }
  const h = hash(chunkOf(x), 0, chunkOf(z));
  return h < 0.3 ? p.dark : h > 0.74 ? p.light : p.base;
}

// The skull in hair cells: half-extent 8 in x and z, crown at 12.
const SIDE = 8;
const CROWN = 12;

/**
 * Plan-view cap outline. `grow` MUST BE ODD (or -1, to sink in), and the chamfer must
 * be bounded: dropping a corner cell exposes the face behind it, and one cell too far
 * stands the cap's edge on the skull's own side plane.
 */
function inOutline(x: number, z: number, grow: number, chamfer: number, free: boolean): boolean {
  const ax = Math.abs(x + 0.5);
  const az = Math.abs(z + 0.5);
  const lim = SIDE - 0.5 + grow;
  if (ax > lim || az > lim) {
    return false;
  }
  if (ax + az <= 2 * lim - chamfer) {
    return true;
  }
  // In the cut. Above the crown nothing is under this row, so the cut stands.
  if (free) {
    return false;
  }
  // Never bare the crown — that is scalp through the top of the hair.
  if (ax <= SIDE - 0.5 && az <= SIDE - 0.5) {
    return true;
  }
  // Never end ON a skull plane; `flush` catches the cell just outside one.
  const flush = (a: number, b: number): boolean => a === SIDE + 0.5 && b < SIDE + 0.5;
  return flush(ax, az) || flush(az, ax);
}

/**
 * A shell over the skull, `y0` to `y1`. SOLID always — a hole exposes the skull face
 * at the very plane the layer stands on. Stubble is a COLOUR (`tone`).
 */
function cap(
  v: VoxelModel,
  p: Palette,
  y0: number,
  y1: number,
  grow = 1,
  chamfer = 5,
  tone?: (x: number, y: number, z: number) => number,
): void {
  // A row above the crown has no skull under it, so its outline is free.
  const free = y0 > CROWN;
  for (let x = -SIDE - grow; x <= SIDE - 1 + grow; x++) {
    for (let z = -SIDE - grow; z <= SIDE - 1 + grow; z++) {
      if (!inOutline(x, z, grow, chamfer, free)) {
        continue;
      }
      for (let y = y0; y <= y1; y++) {
        v.set(x, y, z, tone ? tone(x, y, z) : strand(p, x, z));
      }
    }
  }
}

/**
 * A falling sheet. `jag` is the raggedness of the bottom edge, `sweep` biases length
 * across the run. THE JAG RUNS ALONG THE SHEET, NEVER THROUGH ITS THICKNESS: keyed on
 * the long axis, so every layer of a column ends together and an inner one cannot
 * hang below the outer onto the skull's or the ear's plane.
 */
function fall(
  v: VoxelModel,
  p: Palette,
  opts: {
    x0: number;
    x1: number;
    z0: number;
    z1: number;
    top: number;
    bottom: number;
    jag?: number;
    sweep?: number;
  },
): void {
  const { x0, x1, z0, z1, top, bottom } = opts;
  const jag = opts.jag ?? 2;
  const sweep = opts.sweep ?? 0;
  const alongX = x1 - x0 >= z1 - z0;
  const lo = alongX ? x0 : z0;
  const hi = alongX ? x1 : z1;
  const span = Math.max(1, hi - lo);
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      const run = alongX ? x : z;
      const t = (run - lo) / span;
      // The last two columns stop short, so a sheet finishes in a curve.
      const fromEnd = Math.min(run - lo, hi - run);
      const round = span < 3 ? 0 : fromEnd === 0 ? 2 : fromEnd === 1 ? 1 : 0;
      // Chunked: one height per block of `CHUNK` columns, stepping two cells.
      const block = chunkOf(run);
      const step = Math.floor(hash(block, 7, chunkOf(alongX ? z0 : x0)) * (jag + 1)) * 2;
      const end = Math.round(bottom - sweep * t + round + step);
      for (let y = end; y <= top; y++) {
        v.set(x, y, z, strand(p, x, z, y === end));
      }
    }
  }
}

/**
 * THE ROUNDED MASS — everything OUTSIDE the skull's footprint, where the plane rule
 * binds nothing, as an ellipsoid rather than sheets. `hem` is the lowest row at its
 * DEEPEST point; `frontHem` the same in front of the ears, clear of the eyes.
 */
function mass(
  v: VoxelModel,
  p: Palette,
  o: {
    rx: number;
    rz: number;
    top: number;
    hem: number;
    frontHem?: number;
    jag?: number;
    /** Lowest x it may paint — the sidecut, or the mass buries its own shaved side. */
    from?: number;
  },
): void {
  const jag = o.jag ?? 2;
  const frontHem = o.frontHem ?? o.hem;
  const from = o.from ?? -Infinity;
  for (let x = -Math.ceil(o.rx) - 1; x <= Math.ceil(o.rx); x++) {
    for (let z = -Math.ceil(o.rz) - 1; z <= Math.ceil(o.rz); z++) {
      if (x < from) {
        continue;
      }
      const ax = Math.abs(x + 0.5);
      const az = Math.abs(z + 0.5);
      // Over the skull the cap owns the shape, which makes this safe by
      // construction: every face left is outside the skull or pointing at it.
      if (ax <= SIDE + 0.5 && az <= SIDE + 0.5) {
        continue;
      }
      // THE EARS COUNT TOO: a face landing on x = ±10 is the same seam, so in the
      // ears' band of z the mass starts a cell further out.
      if (az <= 1.5 && ax <= 9.5) {
        continue;
      }
      // Outline AND hem per CHUNK, not per cell, or the rim staircases.
      const cx = chunkCentre(x);
      const cz = chunkCentre(z);
      const qc = (Math.abs(cx) / o.rx) ** 2 + (Math.abs(cz) / o.rz) ** 2;
      if (qc > 1) {
        continue;
      }
      const reach = Math.sqrt(Math.max(0, 1 - qc));
      const floor = cz > 0 ? frontHem : o.hem;
      const end =
        Math.round(o.top - (o.top - floor) * reach) +
        Math.floor(hash(chunkOf(x), 5, chunkOf(z)) * (jag + 1)) * 2;
      for (let y = end; y <= o.top; y++) {
        v.set(x, y, z, strand(p, x, z, y === end));
      }
    }
  }
}

/**
 * A tapered prong, tip in the light tone. It has to START FAT (a third of the head's
 * width) and STAY fat, so the width falls off as the SQUARE ROOT of the distance
 * left. The direction is normalised on its LARGEST component, so one step is one cell
 * along the axis it mostly runs down and it can never leave a gap there.
 */
function spike(
  v: VoxelModel,
  p: Palette,
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
  len: number,
  thick = 5,
): void {
  const m = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) || 1;
  const ux = dx / m,
    uy = dy / m,
    uz = dz / m;
  const axis = Math.abs(uy) === 1 ? "y" : Math.abs(ux) === 1 ? "x" : "z";
  for (let t = 0; t <= len; t++) {
    const w = Math.max(1, Math.round(thick * Math.sqrt(1 - t / len)));
    const lo = -Math.floor((w - 1) / 2);
    const hi = lo + w - 1;
    const px = Math.round(x + ux * t);
    const py = Math.round(y + uy * t);
    const pz = Math.round(z + uz * t);
    const k = t / len;
    const tone = k > 0.72 ? p.light : k < 0.3 ? p.dark : p.base;
    for (let a = lo; a <= hi; a++) {
      for (let b = lo; b <= hi; b++) {
        if (axis === "y") {
          v.set(px + a, py, pz + b, tone);
        } else if (axis === "x") {
          v.set(px, py + a, pz + b, tone);
        } else {
          v.set(px + a, py + b, pz, tone);
        }
      }
    }
  }
}

/**
 * The dome over the crown. Above y = 12 no skull is left, so the plane rule binds
 * nothing and the radius follows `sqrt(1 - t^2)`. `lift` above 1 pushes the profile
 * OUT before it turns in: bouffant rather than conical.
 */
function crown(
  v: VoxelModel,
  p: Palette,
  o: { from: number; height: number; grow?: number; lift?: number },
): void {
  const grow = o.grow ?? FULL;
  const base = SIDE - 0.5 + grow; // the plan radius the cap ends on
  const lift = o.lift ?? 1; // >1 bulges the sides before it turns in
  for (let i = 0; i < o.height; i++) {
    const y = o.from + i;
    // Sampled in bands of two rows, so the dome terraces rather than shrinking.
    const band = Math.floor(i / 2) * 2 + 1;
    const t = band / o.height; // 0 at the base, 1 at the apex
    const r = base * Math.pow(Math.max(0, 1 - t * t), 0.5 / lift);
    const lim = Math.ceil(r);
    for (let x = -lim - 1; x <= lim; x++) {
      for (let z = -lim - 1; z <= lim; z++) {
        // An ELLIPSE sampled at the CHUNK's centre: whole blocks, no staircase.
        const ax = Math.abs(chunkCentre(x));
        const az = Math.abs(chunkCentre(z));
        if ((ax / r) ** 2 + (az / (r * 1.05)) ** 2 > 1) {
          continue;
        }
        v.set(x, y, z, strand(p, x, z));
      }
    }
  }
}

/**
 * How far a full head stands off the skull. 3, not 1: one half-cell is a skullcap and
 * 3 is the next ODD value the plane rule allows. A short cut ends LOWER, not tighter.
 */
const FULL = 3;
/**
 * Where hair stops on the face: the brow, one cell into the eyes (y 4..7). The floor
 * for the CAP as well as the fringe — a cap at `FULL` reaches z 10, in front of the
 * face plane, so its lowest row would cover the eyes. Below the brow is a `fall`.
 */
const BROW = 7;

function paintClassic(v: VoxelModel, p: Palette): void {
  cap(v, p, BROW, 12, FULL, 7);
  crown(v, p, { from: 13, height: 8, lift: 1.5 });
  mass(v, p, { rx: 12, rz: 13, top: 10, hem: -3, frontHem: 5, jag: 2 });
  // z 7..8 straddles the face plane, so the tufts stand proud of it.
  fall(v, p, { x0: -11, x1: 10, z0: 7, z1: 8, top: 12, bottom: BROW, jag: 2 });
  spike(v, p, -2, 14, -3, -0.2, 0.7, -1, 7, 5);
}

function paintBuzz(v: VoxelModel, p: Palette): void {
  // ONE CELL PROUD, not sunk: at `grow` -1 the shell is inside the skull.
  cap(v, p, BROW, 12, 1, 4);
  crown(v, p, { from: 13, height: 4, grow: 1, lift: 1.3 });
  mass(v, p, { rx: 10, rz: 11, top: 9, hem: 3, frontHem: 6, jag: 1 });
  // z 7..8 straddles the face plane; a layer at 6..7 would be INSIDE the skull.
  fall(v, p, { x0: -8, x1: 7, z0: 7, z1: 8, top: 10, bottom: BROW, jag: 2 });
  for (const x of [-2, -1, 0]) {
    v.set(x, BROW, 8, p.dark);
  }
  // sideburns, clear of the ear (y 4..5)
  for (const x of [-8, -7, 6, 7]) {
    for (const y of [6, 7]) {
      v.set(x, y, 8, p.dark);
    }
  }
}

function paintBowl(v: VoxelModel, p: Palette): void {
  cap(v, p, BROW, 12, FULL, 7);
  crown(v, p, { from: 13, height: 9, lift: 2.0 });
  fall(v, p, { x0: -11, x1: 10, z0: 7, z1: 8, top: 11, bottom: BROW, jag: 2 });
  mass(v, p, { rx: 13, rz: 14, top: 9, hem: -6, frontHem: 4, jag: 2 });
}

/**
 * THE SIDECUT: his right clipped, his left a heavy sweep over the eye. His right is
 * -x (hero-rig.ts). Asymmetric, which is why hair is its own model — `build` centres
 * on its own bounds and would drag the HEAD sideways.
 */
function paintEmo(v: VoxelModel, p: Palette): void {
  // Below this line on his right is clipped. A sidecut IS one line.
  const PART = -3;
  // The WHOLE top is full and swept over; only the side BELOW the parting is shaved.
  cap(v, p, 9, 12, FULL, 7);
  crown(v, p, { from: 13, height: 8, lift: 1.6 });
  for (let x = PART; x <= 10; x++) {
    for (let z = -11; z <= 10; z++) {
      if (!inOutline(x, z, FULL, 7, false)) {
        continue;
      }
      for (let y = BROW; y < 9; y++) {
        v.set(x, y, z, strand(p, x, z));
      }
    }
  }
  // THE SHAVED SIDE IS BARE — a shell over the head is a hat whatever value it is
  // painted. One cell of fade under the clipper line at 9, so it is not a decal.
  for (let z = -6; z <= 5; z++) {
    if ((z + 12) % 3 === 0) {
      continue;
    }
    v.set(-9, 8, z, shade(p.dark, 0.8));
  }
  // `sweep` POSITIVE gets longer along the run: a parting, not a full curtain.
  fall(v, p, { x0: -4, x1: 10, z0: 7, z1: 8, top: 13, bottom: 10, jag: 1, sweep: 8 });
  fall(v, p, { x0: 9, x1: 11, z0: 3, z1: 6, top: 10, bottom: -3, jag: 2 });
  // The long side ONLY — symmetric, it wraps the shaved side back in (`from`).
  mass(v, p, { rx: 12, rz: 13, top: 10, hem: -4, frontHem: 4, jag: 3, from: PART });
  for (let y = 2; y <= 13; y++) {
    v.set(5, y, 9, p.light);
    v.set(6, y, 9, p.light);
  }
}

/** Swept-back spikes. The mass is at the BACK, or a spiky head reads as startled. */
function paintCloud(v: VoxelModel, p: Palette): void {
  cap(v, p, BROW, 12, FULL, 7);
  // Low: the fan supplies the height, this is only a mass to grow out of.
  crown(v, p, { from: 13, height: 4, lift: 1.8 });
  mass(v, p, { rx: 12, rz: 13, top: 10, hem: -1, frontHem: 5, jag: 2 });
  fall(v, p, { x0: -11, x1: 10, z0: 7, z1: 8, top: 12, bottom: BROW + 1, jag: 2 });
  // Prongs off the FRONT of the crown, fat enough at the base to merge.
  const fan: Array<[number, number, number, number, number]> = [
    // x, z, sideways lean, length, base width
    [-9, 4, -0.5, 9, 6],
    [-6, 7, -0.25, 13, 7],
    [-2, 8, 0, 14, 7],
    [2, 7, 0.25, 13, 7],
    [6, 4, 0.5, 9, 6],
  ];
  for (const [x, z, lean, len, w] of fan) {
    spike(v, p, x, 12, z, lean, 1, -0.8, len, w);
  }
  for (const x of [-6, 2]) {
    spike(v, p, x, 12, -1, 0, 1, -1, 8, 6);
  }
  // The lean stays under 1, so the run steps down in y and clears the face.
  for (const x of [-7, -2, 4]) {
    spike(v, p, x, 12, 8, 0, -1, 0.2, 6, 4);
  }
}

/** The battle flare: a flame narrowing to a crest, two bangs left over the face. */
function paintSaiyan(v: VoxelModel, p: Palette): void {
  cap(v, p, BROW, 12, FULL, 7);
  crown(v, p, { from: 13, height: 3, lift: 1.8 });
  mass(v, p, { rx: 12, rz: 13, top: 10, hem: 0, frontHem: 5, jag: 2 });
  fall(v, p, { x0: -11, x1: 10, z0: 7, z1: 8, top: 12, bottom: BROW + 1, jag: 2 });
  // One mass that FORKS, not a ring of thin spikes — that reads as a crown.
  const ring: Array<[number, number, number, number, number, number]> = [
    // x, z, lean x, lean z, length, base width
    [-7, 3, -0.55, 0.3, 10, 6],
    [-7, -5, -0.55, -0.3, 12, 6],
    [-2, 5, 0, 0.35, 14, 7],
    [-2, -7, 0, -0.4, 15, 7],
    [3, 3, 0.55, 0.3, 10, 6],
    [3, -5, 0.55, -0.3, 12, 6],
  ];
  for (const [x, z, lx, lz, len, w] of ring) {
    spike(v, p, x, 12, z, lx, 1, lz, len, w);
  }
  spike(v, p, -2, 14, -1, 0, 1, -0.15, 15, 7);
  spike(v, p, -6, 15, -1, -0.2, 1, -0.2, 11, 5);
  spike(v, p, 2, 15, -1, 0.2, 1, -0.2, 11, 5);
  spike(v, p, -7, 12, 8, -0.2, -1, 0.2, 7, 4);
  spike(v, p, 4, 12, 8, 0.2, -1, 0.2, 7, 4);
}

/**
 * The curtain fringe. THE PARTING IS A HOLE, NOT A LINE: the cap starts two rows
 * higher and the front is drawn entirely by the two curtains, so the bare forehead
 * between them is the parting. `sweep`'s two signs are mirrored.
 */
function paintCurtain(v: VoxelModel, p: Palette): void {
  cap(v, p, BROW + 2, 12, FULL, 7);
  crown(v, p, { from: 13, height: 8, lift: 1.4 });
  // `frontHem` is high: a skirt hanging into the front fills the parting back in.
  mass(v, p, { rx: 12, rz: 13, top: 10, hem: -3, frontHem: 8, jag: 2 });
  // THE EYE LINE IS THE CONSTRAINT: the eyes are rows 4..7 at x -6..-3 and 2..5, so
  // ending at 4 out at the temples and 10 at the parting clears them.
  fall(v, p, { x0: -11, x1: -1, z0: 7, z1: 9, top: 12, bottom: 4, jag: 1, sweep: -6 });
  fall(v, p, { x0: 0, x1: 10, z0: 7, z1: 9, top: 12, bottom: 10, jag: 1, sweep: 6 });
  fall(v, p, { x0: -12, x1: -10, z0: 2, z1: 6, top: 8, bottom: 1, jag: 1 });
  fall(v, p, { x0: 9, x1: 11, z0: 2, z1: 6, top: 8, bottom: 1, jag: 1 });
}

// The tail hangs BACK and down: straight down crosses the stowed weapon's diagonal
// (HOLSTER_POS in hero-rig.ts).
function paintPonytail(v: VoxelModel, p: Palette): void {
  cap(v, p, BROW, 12, FULL, 7);
  crown(v, p, { from: 13, height: 8, lift: 1.4 });
  fall(v, p, { x0: -11, x1: 10, z0: 7, z1: 8, top: 12, bottom: BROW + 1, jag: 1 });
  mass(v, p, { rx: 11, rz: 12, top: 10, hem: 0, frontHem: 5, jag: 1 });
  fall(v, p, { x0: -8, x1: 7, z0: -12, z1: -9, top: 9, bottom: 4, jag: 1 });
  for (let x = -5; x <= 4; x++) {
    for (let y = 5; y <= 8; y++) {
      v.set(x, y, -10, p.dark);
    }
  }
  // The band is a value change, not geometry — the only way a tie reads at this size.
  for (let x = -5; x <= 4; x++) {
    for (const z of [-11, -10]) {
      v.set(x, 4, z, shade(p.dark, 0.55));
    }
  }
  // Mostly DOWN: a long axis in z foreshortens into a blob from behind. Rooted at
  // z -12, or its base reaches the skull's inset back plane (SKULL_SHELL).
  spike(v, p, -1, 3, -12, 0, -1, -0.45, 12, 6);
  for (const x of [-7, 6]) {
    for (let y = 6; y <= 8; y++) {
      v.set(x, y, 8, p.dark);
    }
  }
}

/**
 * A crest down the middle, the sides drawn by NOT drawing — a shell over the head is
 * a hat whatever value it is painted. A strip of stubble roots the crest.
 */
function paintMohawk(v: VoxelModel, p: Palette): void {
  const stubble = shade(p.dark, 0.35);
  for (let z = -9; z <= 8; z++) {
    for (const x of [-5, -4, 1, 2]) {
      v.set(x, 12, z, stubble);
    }
  }
  // A WALL, NOT A ROW OF PRONGS: one arch narrowing with HEIGHT, not position. Every
  // cell is at y 12 or above, or the taper lands a top face on the crown plane.
  for (let z = -11; z <= 8; z++) {
    const t = (z + 11) / 19; // 0 at the nape, 1 at the brow
    // sqrt(sin) rises fast and holds: a fin. A plain sine peaks once — a cone.
    const ridge =
      12 + Math.round(5 + 10 * Math.sqrt(Math.sin(t * Math.PI))) - Math.floor(hash(0, 0, z) * 2);
    for (let y = 12; y <= ridge; y++) {
      const k = (y - 12) / Math.max(1, ridge - 12);
      const half = k > 0.86 ? 0 : k > 0.55 ? 1 : 2; // five cells wide at the root
      for (let x = -1 - half; x <= -1 + half; x++) {
        v.set(x, y, z, k > 0.7 ? p.light : k < 0.25 ? p.dark : strand(p, x, z));
      }
    }
  }
  fall(v, p, { x0: -4, x1: 1, z0: -11, z1: -9, top: 11, bottom: 3, jag: 2 });
}

export interface HairStyle {
  id: string;
  labelKey: StringKey;
  /** The colour the shape was designed in, used until a colour is picked. */
  suggested: number;
  paint: (v: VoxelModel, p: Palette) => void;
}

export const HAIR_STYLES: readonly HairStyle[] = [
  { id: "classic", labelKey: "hair.classic", suggested: 0xa5622a, paint: paintClassic },
  { id: "buzz", labelKey: "hair.buzz", suggested: 0x4a3524, paint: paintBuzz },
  { id: "bowl", labelKey: "hair.bowl", suggested: 0x6f4a24, paint: paintBowl },
  { id: "curtain", labelKey: "hair.curtain", suggested: 0x6a4a32, paint: paintCurtain },
  { id: "ponytail", labelKey: "hair.ponytail", suggested: 0x2f2b33, paint: paintPonytail },
  { id: "emo", labelKey: "hair.emo", suggested: 0x241f28, paint: paintEmo },
  { id: "cloud", labelKey: "hair.cloud", suggested: 0xe8c66a, paint: paintCloud },
  { id: "mohawk", labelKey: "hair.mohawk", suggested: 0xc4453a, paint: paintMohawk },
  { id: "saiyan", labelKey: "hair.saiyan", suggested: 0xf5d548, paint: paintSaiyan },
];

export const HAIR_SWATCHES: readonly number[] = [
  0x2b2620, 0x4a3524, 0x6f4a24, 0xa5622a, 0xc98f4a, 0xe8c66a, 0xf0e0b8, 0xb0b6bd, 0x8e2f2f,
  0xc4453a, 0x3f6fb0, 0x6d4f9c, 0x2f8f6a, 0xd06fa8,
];

export function hairStyle(id: string): HairStyle {
  return HAIR_STYLES.find((s) => s.id === id) ?? HAIR_STYLES[0];
}

/**
 * `build(scale, false)` is NOT centred: an asymmetric style must stay where it was
 * drawn. It still re-bases y on the lowest painted cell, so the mount's offset is
 * read off the model rather than written down.
 */
export function buildHair(styleId: string, colour: number): THREE.Mesh {
  const style = hairStyle(styleId);
  const v = new VoxelModel();
  style.paint(v, palette(colour));
  const minY = v.bounds(false).minY;
  const mesh = v.build(HAIR_SCALE, false);
  mesh.position.y = minY * HAIR_SCALE;
  return mesh;
}

/**
 * One key each, and THE DEFAULT IS THE ABSENCE OF A KEY (core/prefs.ts) — which is
 * what lets a style carry a `suggested` colour with no extra state. NOT in `Prefs`:
 * that is the fixed row set ui/settings.ts renders; this is a debug control today.
 */
const STYLE_KEY = "game.settings.appearance.hairStyle";
const COLOUR_KEY = "game.settings.appearance.hairColour";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // storage denied: the defaults are a complete answer
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    /* storage denied — the session still honours the choice */
  }
}

export function storedHairStyle(): string {
  const raw = read(STYLE_KEY);
  return HAIR_STYLES.some((s) => s.id === raw) ? (raw as string) : HAIR_STYLES[0].id;
}

export function storeHairStyle(id: string): void {
  write(STYLE_KEY, id === HAIR_STYLES[0].id ? null : id);
}

/** null when the style's own suggestion should stand. */
export function storedHairColour(): number | null {
  const raw = read(COLOUR_KEY);
  if (raw === null || !/^[0-9a-fA-F]{6}$/.test(raw)) {
    return null;
  }
  return parseInt(raw, 16);
}

export function storeHairColour(hex: number | null): void {
  write(COLOUR_KEY, hex === null ? null : hex.toString(16).padStart(6, "0"));
}

export function hairColourFor(styleId: string): number {
  return storedHairColour() ?? hairStyle(styleId).suggested;
}
