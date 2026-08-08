import * as THREE from 'three';
import { shade, VoxelModel } from '../core/voxel';
import type { StringKey } from '../i18n';

/**
 * THE HERO'S HAIR — a separate model, at TWICE the body's resolution.
 *
 * WHY IT IS NOT PART OF THE HEAD. Two reasons, and both are load-bearing:
 *
 *  - RESOLUTION. The body is painted at 0.1 per voxel, which is a 8x8 grid
 *    across the skull. A silhouette that has to read as "spikes swept back" or
 *    "one side shaved" cannot be drawn in eight cells — every style comes out
 *    the same chunky box with a different colour. Hair is painted at 0.05, so
 *    the same skull is 16 cells across and a spike can taper.
 *  - SWAPPING. Colour is baked into vertex colours (see `VoxelModel.build`), so
 *    changing either the style or the colour means rebuilding a mesh. Rebuilding
 *    the HAIR is one small model; rebuilding the head would take the face,
 *    the eyes and the ears with it for nothing.
 *
 * COORDINATES. Hair cells are the head's own cells, doubled: hair cell (2x,2y,2z)
 * is the near corner of skull cell (x,y,z). The mount sits exactly where the
 * skull mesh sits, so there is no offset to keep in step — see `HAIR_ORIGIN` in
 * hero-rig.ts. In hair cells the skull spans x -8..7, y 0..11, z -8..7, its top
 * face is the plane y=12 and its face is the plane z=8; the ears stick out to
 * x ±10 at y 4..5, z 0..1.
 *
 * THE ODD-BOUNDARY RULE, which is what keeps `test-zfight` clean. Two meshes
 * that put a face on the same plane fight, and the skull's own planes are at
 * EVEN hair-cell boundaries by construction (they are 0.1 apart, we are 0.05).
 * So an exposed hair face may not land on x = ±8 (the skull's sides), z = ±8
 * (its face and its back), y = 12 (its crown) or x = ±10 (the outside of an
 * ear): a cap either overhangs by an ODD number of half-cells or sinks in by
 * one, and a fringe that rises to the crown rises PAST it, to 13. Opposite-
 * facing pairs are fine — a curtain flush against the back of the skull has its
 * inner face pointing at the skull's outward one, and one of the two is always
 * back-face culled.
 *
 * The guard is what proves it, and it is a two-line run: `bun tools/test-zfight.mjs`
 * builds the hero in EVERY style (see its hero section) and fails on a seam.
 *
 * WHAT A STYLE IS: a paint function, a label and a colour it looks best in.
 * Nothing else in the game knows the list — the debug panel enumerates it, the
 * rig builds whichever id it is handed, and an unknown id falls back to the
 * first entry. Adding a style is one entry in `HAIR_STYLES` and one string.
 */

/** Half the body's voxel: 0.05 world units per hair cell. */
export const HAIR_SCALE = 0.05;

/** The three tones one hair colour is spread over. */
interface Palette {
  base: number;
  dark: number;
  light: number;
}

/**
 * One colour in, three out. The spread is wide enough to read as strands under
 * flat midday light (where `VoxelModel`'s own face shading is the only other
 * cue) and narrow enough that a dark brown does not go black in the shadows.
 */
function palette(hex: number): Palette {
  return { base: hex, dark: shade(hex, 0.74), light: shade(hex, 1.2) };
}

/**
 * Deterministic per-cell noise, 0..1. Not for variety between playthroughs —
 * the hero must look the same every time he is built — but for STRAND BREAKUP:
 * a slab of one colour reads as a helmet, and three tones scattered by position
 * read as hair. Keyed on the cell, so the same style always paints the same
 * pixels.
 */
function hash(x: number, y: number, z: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * The tone for one cell of a sheet of hair. Keyed on the COLUMN (x,z) rather
 * than the cell, so the variation runs top-to-bottom the way hair does instead
 * of speckling like static — with the lowest row of a fall darkened, which is
 * what makes a curtain read as hanging rather than as painted on.
 */
function strand(p: Palette, x: number, z: number, tip = false): number {
  if (tip) return p.dark;
  const h = hash(x, 0, z);
  return h < 0.3 ? p.dark : h > 0.74 ? p.light : p.base;
}

/** The skull, in hair cells: half-extent 8 in x and z, crown at 12. */
const SIDE = 8;
const CROWN = 12;

/**
 * The plan-view outline of a cap: the skull's square with its corners taken off
 * so the head is not a shoebox from above. `grow` is how far it stands off the
 * skull and MUST BE ODD (or -1, to sink in) — see the odd-boundary rule above.
 *
 * THE CORNER CUT IS BOUNDED BY THAT SAME RULE, which is worth spelling out
 * because it is the one place the rule is not obvious: dropping a cell exposes
 * the face of the cell BEHIND it, so a chamfer that eats one cell too far
 * leaves the cap's edge standing exactly on the skull's own side plane —
 * one plane, two surfaces, and the diagonal seam this file exists to avoid.
 * A cell in the corner is therefore kept when dropping it would do that, which
 * at `grow` 1 leaves a one-cell clip and at 3 a proper two-step round.
 */
function inOutline(x: number, z: number, grow: number, chamfer: number, free: boolean): boolean {
  const ax = Math.abs(x + 0.5);
  const az = Math.abs(z + 0.5);
  const lim = SIDE - 0.5 + grow;
  if (ax > lim || az > lim) return false;
  if (ax + az <= 2 * lim - chamfer) return true;
  // In the cut. Above the crown there is no head under this row and the cut
  // stands; over the skull it is bounded twice.
  if (free) return false;
  // Never bare the crown: a cut inside the skull's own footprint is a patch of
  // scalp showing through the top of the hair.
  if (ax <= SIDE - 0.5 && az <= SIDE - 0.5) return true;
  // And never end ON a skull plane: `flush` is true when this cell is the one
  // standing immediately outside a skull face still covered along the other axis.
  const flush = (a: number, b: number): boolean => a === SIDE + 0.5 && b < SIDE + 0.5;
  return flush(ax, az) || flush(az, ax);
}

/**
 * A shell of hair over the skull, `y0` to `y1` inclusive.
 *
 * SOLID, always. A shell one cell proud of the skull is tempting to stipple —
 * leave cells out and clipped hair shows the scalp through it — but a hole in
 * it exposes the skull face underneath at the very plane the layer is standing
 * on, which is the seam this file's plane rule is about. Stubble is a COLOUR,
 * which is what `tone` is for and what `paintMohawk` uses it for.
 */
function cap(
  v: VoxelModel, p: Palette, y0: number, y1: number,
  grow = 1, chamfer = 5,
  tone?: (x: number, y: number, z: number) => number,
): void {
  // A row that starts above the crown has no skull under it, so its outline is
  // shaped freely — which is the whole of what `dome` is doing.
  const free = y0 > CROWN;
  for (let x = -SIDE - grow; x <= SIDE - 1 + grow; x++) {
    for (let z = -SIDE - grow; z <= SIDE - 1 + grow; z++) {
      if (!inOutline(x, z, grow, chamfer, free)) continue;
      for (let y = y0; y <= y1; y++) v.set(x, y, z, tone ? tone(x, y, z) : strand(p, x, z));
    }
  }
}

/**
 * A falling sheet — a fringe, a curtain down the back, a sidelock.
 *
 * Every column ends at ITS OWN height: `jag` is how many cells of raggedness the
 * bottom edge has, and it is the difference between hair and a rectangle of
 * texture. `sweep` biases that length across the run, so a fringe can go from
 * long at one end to short at the other, which is what draws a side parting.
 *
 * THE JAG RUNS ALONG THE SHEET, NEVER THROUGH ITS THICKNESS, and that is a
 * correctness rule rather than a taste one: a sheet is two or three cells thick,
 * and if each of those layers ended at its own height then the INNER one would
 * sometimes hang below the outer and stand its own face out on the skull's or
 * the ear's plane (see the plane rule at the top). Keyed on the long axis, every
 * layer of one column ends together and only the outermost face is ever seen.
 */
function fall(
  v: VoxelModel, p: Palette,
  opts: {
    x0: number; x1: number; z0: number; z1: number;
    top: number; bottom: number; jag?: number;
    /** Extra length at the far end of the run, tapering linearly from the near. */
    sweep?: number;
  },
): void {
  const { x0, x1, z0, z1, top, bottom } = opts;
  const jag = opts.jag ?? 2;
  const sweep = opts.sweep ?? 0;
  const alongX = x1 - x0 >= z1 - z0;
  const span = Math.max(1, alongX ? x1 - x0 : z1 - z0);
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      const run = alongX ? x : z;
      const t = (run - (alongX ? x0 : z0)) / span;
      const end = Math.round(bottom - sweep * t + Math.floor(hash(run, 7, alongX ? z0 : x0) * (jag + 1)));
      for (let y = end; y <= top; y++) v.set(x, y, z, strand(p, x, z, y === end));
    }
  }
}

/**
 * A tapered prong. Every anime spike in this file is one of these: a run of
 * cells along a direction, its cross-section shrinking from `thick` cells to
 * one, with the tip in the light tone so the crest catches the light the way a
 * rim would.
 *
 * IT HAS TO START FAT. The first draft stepped a 2x2 block along the line and
 * every style built out of it came out the same way — a crown of birthday
 * candles standing on a slab, because a prong two cells wide is a stick and a
 * head is sixteen cells across. A spike reads as HAIR when its base is a third
 * of that and the bases of its neighbours merge into one mass, which is what
 * the wedge below does and what `thick` 3 to 5 is for.
 *
 * The direction is normalised on its LARGEST component, so one step is one cell
 * along the axis the prong mostly runs down and the run can never leave a gap
 * in that axis; the cross-section is then the other two axes.
 */
function spike(
  v: VoxelModel, p: Palette,
  x: number, y: number, z: number,
  dx: number, dy: number, dz: number,
  len: number, thick = 4,
): void {
  const m = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) || 1;
  const ux = dx / m, uy = dy / m, uz = dz / m;
  const axis = Math.abs(uy) === 1 ? 'y' : Math.abs(ux) === 1 ? 'x' : 'z';
  for (let t = 0; t <= len; t++) {
    const w = Math.max(1, Math.round(thick * (1 - t / len)));
    const lo = -Math.floor((w - 1) / 2);
    const hi = lo + w - 1;
    const px = Math.round(x + ux * t);
    const py = Math.round(y + uy * t);
    const pz = Math.round(z + uz * t);
    const k = t / len;
    const tone = k > 0.72 ? p.light : k < 0.3 ? p.dark : p.base;
    for (let a = lo; a <= hi; a++) {
      for (let b = lo; b <= hi; b++) {
        if (axis === 'y') v.set(px + a, py, pz + b, tone);
        else if (axis === 'x') v.set(px, py + a, pz + b, tone);
        else v.set(px + a, py + b, pz, tone);
      }
    }
  }
}

/**
 * The rounded top of a cap: two stepped rings above the skull's crown.
 *
 * ABOVE y = 12 THE PLANE RULE STOPS BITING — there is no head left up there for
 * a face to fight with — so the profile is free, and this is where it is spent.
 * A cap that just stops at its top row is the flat slab every first draft of
 * this file produced; two rings pulled in by a cell each turn it into a head of
 * hair, for about forty cells.
 */
function dome(v: VoxelModel, p: Palette, y: number, grow = FULL): void {
  cap(v, p, y, y, grow - 1, 6);
  cap(v, p, y + 1, y + 1, grow - 3, 8);
}

/**
 * HOW FAR A FULL HEAD OF HAIR STANDS OFF THE SKULL, and it is 3 rather than 1
 * for a reason worth keeping.
 *
 * Everything here shipped at 1 first — one half-cell, the thinnest shell the
 * plane rule allows — and every style read as THINNING HAIR at conversation
 * distance however different its silhouette was. Two things were doing it and
 * both are cheap to get wrong again:
 *
 *  - THE SHELL WAS TOO THIN. A half-cell of hair on a head eight cells wide is
 *    a skullcap. Real volume is the outline standing off by 3 (0.15, against
 *    the skull's own 0.8 across), which is the next ODD value up and so still
 *    legal — see the plane rule at the top.
 *  - THE HAIRLINE WAS TOO HIGH, which mattered more. A fringe that stops at
 *    y 8 leaves the whole forehead bare and reads as a receding one; hair
 *    starts just above the eyes, which is y 6 to 8, and a jag of 2 rather than
 *    3 keeps the raggedness from opening a bald column in the middle of it.
 *
 * A short cut is short by ending LOWER on the head, not by hugging it — `buzz`
 * still stands one cell proud and still comes down over the temples.
 */
const FULL = 3;
/**
 * Where hair stops on the front of the face: the brow, one cell into the top of
 * the eyes (which are y 4..7).
 *
 * IT IS THE FLOOR FOR THE CAP AS WELL AS FOR THE FRINGE, and that is the part
 * that is not obvious. A cap at `FULL` reaches z 10 — two cells IN FRONT of the
 * face plane — so it is not only a skullcap seen from above but a visor seen
 * from the front, and dropping its lowest row to cover the temples covered the
 * eyes with it. Everything below the brow at the FRONT belongs to a `fall`,
 * which can be jagged, swept and stopped per column; the cap is the mass above.
 */
const BROW = 7;

// -- the styles -------------------------------------------------------------

/**
 * The hair the hero shipped with, redrawn at the finer grid: a chunky cap with
 * a jagged fringe, strands falling to the nape, and one cowlick.
 */
function paintClassic(v: VoxelModel, p: Palette): void {
  cap(v, p, BROW, 12, FULL, 7);
  dome(v, p, 13);
  // the fall down the back of the neck, four cells of it
  fall(v, p, { x0: -11, x1: 10, z0: -12, z1: -9, top: 9, bottom: 1, jag: 3 });
  // The ragged edge over the ears. Three cells thick, and all of them are ONE
  // call: a sheet's layers have to end together (see `fall`).
  fall(v, p, { x0: -11, x1: -9, z0: -9, z1: 6, top: 9, bottom: 6, jag: 2 });
  fall(v, p, { x0: 8, x1: 10, z0: -9, z1: 6, top: 9, bottom: 6, jag: 2 });
  // Jagged fringe over the brow. z 7..9 straddles the face plane, so the tufts
  // stand two cells proud of it rather than being painted onto it, and it rises
  // to 12 rather than stopping level with the crown (see the plane rule).
  fall(v, p, { x0: -11, x1: 10, z0: 7, z1: 8, top: 12, bottom: BROW, jag: 2 });
  // the cowlick, raked back rather than standing up like a chimney
  spike(v, p, -2, 14, -3, -0.2, 0.7, -1, 5, 4);
}

/**
 * Cropped to the scalp — the "I cut it myself before setting out" head, and the
 * one style that lets the face be looked at with nothing over it.
 */
function paintBuzz(v: VoxelModel, p: Palette): void {
  // ONE CELL PROUD, not sunk, and it comes DOWN to the temples. At `grow` -1
  // the shell is inside the skull and the only part of it anybody can see is
  // the row above the crown — a lid, not a haircut. Short hair is short by
  // ending low on the head with nothing standing off it, which is this.
  cap(v, p, BROW, 12, 1, 4);
  dome(v, p, 13, 1);
  fall(v, p, { x0: -9, x1: 8, z0: -10, z1: -9, top: 9, bottom: 5, jag: 1 });
  fall(v, p, { x0: -9, x1: -8, z0: -9, z1: 6, top: 8, bottom: 6, jag: 1 });
  fall(v, p, { x0: 7, x1: 8, z0: -9, z1: 6, top: 8, bottom: 6, jag: 1 });
  // A hairline that steps rather than rules a line: temples cut back, a shallow
  // widow's peak in the middle. z 7..8, straddling the face plane — a layer at
  // 6..7 would be INSIDE the skull and invisible, which is the other half of
  // the plane rule and the easier half to get wrong.
  fall(v, p, { x0: -8, x1: 7, z0: 7, z1: 8, top: 10, bottom: BROW, jag: 2 });
  for (const x of [-2, -1, 0]) v.set(x, BROW, 8, p.dark);
  // sideburns, in front of the ear and clear of it (the ear is y 4..5)
  for (const x of [-8, -7, 6, 7]) for (const y of [6, 7]) v.set(x, y, 8, p.dark);
}

/**
 * The shaggy bowl: heavy, even, and long enough to hide the ears. The oldest
 * hero cut there is, and the one that reads best at a distance because the
 * silhouette is a single mass.
 */
function paintBowl(v: VoxelModel, p: Palette): void {
  cap(v, p, BROW, 12, FULL, 7);
  dome(v, p, 13);
  // the skirt: all the way round, ending below the ears at the sides and
  // shorter at the front so the eyes stay clear
  fall(v, p, { x0: -11, x1: 10, z0: 7, z1: 8, top: 11, bottom: BROW, jag: 2 });
  fall(v, p, { x0: -11, x1: 10, z0: -12, z1: -9, top: 8, bottom: 2, jag: 2 });
  // The two side falls, over the ears and out past them. Each is ONE call two
  // cells thick, so both layers of a column end together and the outer one is
  // what the ear sees — the ear's own outer face is the plane x = ±10, and a
  // layer stopping there is two surfaces at one depth (see the plane rule).
  fall(v, p, { x0: -12, x1: -10, z0: -9, z1: 8, top: 7, bottom: 2, jag: 2 });
  fall(v, p, { x0: 9, x1: 11, z0: -9, z1: 8, top: 7, bottom: 2, jag: 2 });
}

/**
 * THE SIDECUT. One side clipped to the scalp, the other long: a heavy sweep
 * that crosses the brow and covers his LEFT eye, and a lock reaching past the
 * jaw beside it.
 *
 * Asymmetric on purpose, and it is the reason the hair is its own model rather
 * than more cells in `buildHead` — `VoxelModel.build` centres a model on its own
 * bounds, so hair that hangs further one way than the other would have dragged
 * the whole HEAD sideways with it. Here it only moves the hair, which is what
 * it is meant to move.
 *
 * His right is -x (see the note at the top of hero-rig.ts), so the shaved side
 * is his right and the sweep falls over his left eye.
 */
function paintEmo(v: VoxelModel, p: Palette): void {
  // the scalp, everywhere
  cap(v, p, 8, 12, -1, 3);
  // Shaved right side: a single layer standing one cell proud of the skull
  // (cells -9 and -8 span -9..-7, so the outer face is the plane -9), clipped
  // with a stepped pattern so it reads as stubble and not as a painted patch.
  //
  // It stops at 10, so its top face is the plane 11 — ODD, like every other
  // exposed face here. It used to stop at 9, which was a top face on the plane
  // 10; that was free until the skull's corners were stepped back and 10 became
  // one of ITS planes too (see SKULL_PLAN in hero-rig.ts).
  for (let z = -7; z <= 6; z++) {
    for (let y = 6; y <= 10; y++) {
      const clipped = (z + y) % 3 === 0;
      v.set(-9, y, z, clipped ? shade(p.dark, 0.7) : y > 7 ? p.dark : shade(p.dark, 0.85));
      v.set(-8, y, z, p.dark);
    }
  }
  // The long half: a cap that only exists on his left, standing a FULL three
  // cells proud. The step at the parting is the whole cut — a thin shell on
  // this side and a shaved one on the other is two flat halves, not a sidecut.
  for (let x = -3; x <= 10; x++) {
    for (let z = -11; z <= 10; z++) {
      if (!inOutline(x, z, FULL, 7, false)) continue;
      for (let y = 7; y <= 13; y++) v.set(x, y, z, strand(p, x, z));
    }
  }
  // The sweep: short at the parting over his right eye, growing across the brow
  // and hanging past his left one. `sweep` is POSITIVE to get longer along the
  // run — it is subtracted from the bottom, and the sign is the difference
  // between a parting and a curtain over the whole face.
  fall(v, p, { x0: -4, x1: 10, z0: 7, z1: 8, top: 13, bottom: 10, jag: 1, sweep: 8 });
  // the lock beside it, past the jaw — outboard of the ear, ending at x 12
  fall(v, p, { x0: 9, x1: 11, z0: 3, z1: 6, top: 10, bottom: -3, jag: 2 });
  // a longer tail at the back on the same side, and a short one on the shaved one
  fall(v, p, { x0: -2, x1: 10, z0: -12, z1: -9, top: 9, bottom: 0, jag: 3 });
  fall(v, p, { x0: -8, x1: -3, z0: -11, z1: -9, top: 8, bottom: 4, jag: 2 });
  // one bleached streak through the sweep — the whole point of the cut
  for (let y = 2; y <= 13; y++) { v.set(5, y, 9, p.light); v.set(6, y, 9, p.light); }
}

/**
 * SWEPT-BACK SPIKES — the mercenary's head: a shallow cap with a fan of long
 * prongs going up and back off the crown, and three heavy bangs hanging forward
 * over the brow. The mass is at the back, which is what stops a spiky head
 * reading as a startled one.
 */
function paintCloud(v: VoxelModel, p: Palette): void {
  cap(v, p, BROW, 12, FULL, 7);
  fall(v, p, { x0: -11, x1: 10, z0: -12, z1: -9, top: 9, bottom: 4, jag: 2 });
  fall(v, p, { x0: -11, x1: -9, z0: -9, z1: 6, top: 9, bottom: 6, jag: 2 });
  fall(v, p, { x0: 8, x1: 10, z0: -9, z1: 6, top: 9, bottom: 6, jag: 2 });
  // the hair the spikes are swept UP from — without it the fan stands on a bare
  // brow and the swept look becomes a fringe of horns
  fall(v, p, { x0: -11, x1: 10, z0: 7, z1: 8, top: 12, bottom: BROW + 1, jag: 2 });
  // The fan: heavy prongs off the FRONT of the crown, every one raking up and
  // back over the skull. They start fat enough to merge into one another, which
  // is what makes this a swept mass rather than a row of horns.
  const fan: Array<[number, number, number, number, number]> = [
    // x, z, sideways lean, length, base width
    [-9, 4, -0.5, 7, 5],
    [-6, 7, -0.25, 10, 6],
    [-2, 8, 0, 11, 6],
    [2, 7, 0.25, 10, 6],
    [6, 4, 0.5, 7, 5],
  ];
  for (const [x, z, lean, len, w] of fan) spike(v, p, x, 12, z, lean, 1, -0.8, len, w);
  // Two shorter ones behind them, filling the trough the fan leaves over the
  // crown so the mass reads as continuous from the side.
  for (const x of [-6, 2]) spike(v, p, x, 12, -1, 0, 1, -1, 6, 5);
  // The bangs: three heavy tufts hanging over the brow, leaning out as they
  // fall. The lean is well under 1, so the run steps down in y and the tips end
  // a cell clear of the face rather than a hand's width in front of it.
  for (const x of [-7, -2, 4]) spike(v, p, x, 12, 8, 0, -1, 0.2, 5, 3);
}

/**
 * THE BATTLE FLARE — hair standing straight up in a flame, wide at the temples,
 * narrowing to a crest well above the crown, with two bangs left hanging at the
 * front so there is still a face under it.
 *
 * Gold by default (`suggested`), because that is the shape's whole reference —
 * but it is only a default, and the picker overrides it like any other.
 */
function paintSaiyan(v: VoxelModel, p: Palette): void {
  cap(v, p, BROW, 12, FULL, 7);
  fall(v, p, { x0: -11, x1: 10, z0: -12, z1: -9, top: 9, bottom: 5, jag: 2 });
  fall(v, p, { x0: -11, x1: -9, z0: -9, z1: 6, top: 9, bottom: 6, jag: 2 });
  fall(v, p, { x0: 8, x1: 10, z0: -9, z1: 6, top: 9, bottom: 6, jag: 2 });
  fall(v, p, { x0: -11, x1: 10, z0: 7, z1: 8, top: 12, bottom: BROW + 1, jag: 2 });
  // THE FLAME. A solid block of hair carried a long way above the crown, cut
  // into prongs at the top rather than assembled out of them — a ring of thin
  // spikes reads as a crown, and the difference is that the mass here is one
  // thing that FORKS. The first course is short and fat, and the crest goes up
  // out of the middle of it.
  const ring: Array<[number, number, number, number, number, number]> = [
    // x, z, lean x, lean z, length, base width
    [-7, 3, -0.55, 0.3, 8, 5],
    [-7, -5, -0.55, -0.3, 9, 5],
    [-2, 5, 0, 0.35, 11, 6],
    [-2, -7, 0, -0.4, 12, 6],
    [3, 3, 0.55, 0.3, 8, 5],
    [3, -5, 0.55, -0.3, 9, 5],
  ];
  for (const [x, z, lx, lz, len, w] of ring) spike(v, p, x, 12, z, lx, 1, lz, len, w);
  // the crest, out of the middle of that and taller than any of it
  spike(v, p, -2, 14, -1, 0, 1, -0.15, 12, 6);
  spike(v, p, -6, 15, -1, -0.2, 1, -0.2, 9, 4);
  spike(v, p, 2, 15, -1, 0.2, 1, -0.2, 9, 4);
  // two bangs left hanging at the front, so there is a face under all this
  spike(v, p, -7, 12, 8, -0.2, -1, 0.2, 6, 3);
  spike(v, p, 4, 12, 8, 0.2, -1, 0.2, 6, 3);
}

/**
 * Swept back into a tail — the swordsman's head. The scalp is smoothed back
 * rather than fringed, gathered at the nape, and the tail hangs BACK and DOWN
 * at an angle rather than straight down: straight down puts it through the
 * stowed weapon's diagonal (see HOLSTER_POS in hero-rig.ts).
 */
function paintPonytail(v: VoxelModel, p: Palette): void {
  cap(v, p, BROW, 12, FULL, 7);
  dome(v, p, 13);
  // Swept back: no fringe, but the hairline still comes down to the brow —
  // "swept back" is hair going somewhere, not hair that stops at the crown.
  fall(v, p, { x0: -11, x1: 10, z0: 7, z1: 8, top: 12, bottom: BROW + 1, jag: 1 });
  fall(v, p, { x0: -11, x1: -9, z0: -9, z1: 6, top: 9, bottom: 6, jag: 1 });
  fall(v, p, { x0: 8, x1: 10, z0: -9, z1: 6, top: 9, bottom: 6, jag: 1 });
  // gathered at the nape, and drawn in to the width of the band
  fall(v, p, { x0: -8, x1: 7, z0: -12, z1: -9, top: 9, bottom: 4, jag: 1 });
  for (let x = -5; x <= 4; x++) for (let y = 5; y <= 8; y++) v.set(x, y, -10, p.dark);
  // the band, two cells of a darker tone — the one place a tie can read at this
  // size is as a value change, so it is drawn rather than modelled
  for (let x = -5; x <= 4; x++) for (const z of [-11, -10]) v.set(x, 4, z, shade(p.dark, 0.55));
  // ONE rope out of it, raked back and down. Two thin spikes side by side read
  // as two tails; one fat one that tapers reads as hair gathered in a tie.
  // Mostly DOWN, a little back. The other way round — a run whose long axis is
  // z — is a broom handle sticking out of the back of his head, and from behind
  // (the view a player has of him) it foreshortens into a blob.
  spike(v, p, -1, 3, -11, 0, -1, -0.45, 10, 5);
  // sideburns in front of the ears, standing proud of the face plane
  for (const x of [-7, 6]) for (let y = 6; y <= 8; y++) v.set(x, y, 8, p.dark);
}

/**
 * A crest down the middle and NOTHING either side of it — the sides are the
 * hero's own scalp, drawn by not drawing.
 *
 * The first version put a dark shell over them, on the theory that shaved hair
 * is stubble rather than skin. It read as a knitted hat in every colour, and no
 * amount of darkening fixed it: a shell that covers the head IS a hat, whatever
 * value it is painted. The head is already skin-coloured, and leaving it alone
 * is both the cheapest thing this file does and the only one that looks shaved.
 * All that is left is a strip of stubble flanking the crest, which is what roots
 * it to the head instead of standing it on top like a comb.
 */
function paintMohawk(v: VoxelModel, p: Palette): void {
  const stubble = shade(p.dark, 0.35);
  for (let z = -9; z <= 8; z++) {
    for (const x of [-5, -4, 1, 2]) v.set(x, 12, z, stubble);
  }
  // THE CREST IS A WALL, NOT A ROW OF PRONGS. Built out of `spike` it was a
  // cone: each prong tapers over ITS OWN length, so the short ones at the front
  // and back of the run were needles and the fin pinched to nothing at both
  // ends. A fin is one solid arch — full length at the base, narrowing with
  // HEIGHT rather than with position, jagged along the top.
  //
  // Every cell of it is at y 12 or above, standing ON the crown and never one
  // row inside it: a prong that starts at 11 has its own top face land on the
  // skull's crown plane as soon as the taper narrows above it (the plane rule).
  for (let z = -11; z <= 8; z++) {
    const t = (z + 11) / 19;                      // 0 at the nape, 1 at the brow
    const ridge = 12 + Math.round(4 + 8 * Math.sin(t * Math.PI)) - Math.floor(hash(0, 0, z) * 2);
    for (let y = 12; y <= ridge; y++) {
      const k = (y - 12) / Math.max(1, ridge - 12);
      const half = k > 0.78 ? 0 : k > 0.42 ? 1 : 2;   // five cells wide at the root
      for (let x = -1 - half; x <= -1 + half; x++) {
        v.set(x, y, z, k > 0.7 ? p.light : k < 0.25 ? p.dark : strand(p, x, z));
      }
    }
  }
  // the neck strip, so the crest continues past the skull instead of stopping
  fall(v, p, { x0: -4, x1: 1, z0: -11, z1: -9, top: 11, bottom: 3, jag: 2 });
}

export interface HairStyle {
  id: string;
  labelKey: StringKey;
  /** The colour the shape was designed in, used until a colour is picked. */
  suggested: number;
  paint: (v: VoxelModel, p: Palette) => void;
}

/**
 * ORDERED FROM THE SHORTEST TO THE LOUDEST, because that is the order somebody
 * flicking through them with one arrow key wants: the everyday heads first, the
 * silhouettes that change the character last.
 */
export const HAIR_STYLES: readonly HairStyle[] = [
  { id: 'classic', labelKey: 'hair.classic', suggested: 0xa5622a, paint: paintClassic },
  { id: 'buzz', labelKey: 'hair.buzz', suggested: 0x4a3524, paint: paintBuzz },
  { id: 'bowl', labelKey: 'hair.bowl', suggested: 0x6f4a24, paint: paintBowl },
  { id: 'ponytail', labelKey: 'hair.ponytail', suggested: 0x2f2b33, paint: paintPonytail },
  { id: 'emo', labelKey: 'hair.emo', suggested: 0x241f28, paint: paintEmo },
  { id: 'cloud', labelKey: 'hair.cloud', suggested: 0xe8c66a, paint: paintCloud },
  { id: 'mohawk', labelKey: 'hair.mohawk', suggested: 0xc4453a, paint: paintMohawk },
  { id: 'saiyan', labelKey: 'hair.saiyan', suggested: 0xf5d548, paint: paintSaiyan },
];

/**
 * The colours offered as a strip beside the picker.
 *
 * A free colour well answers "any colour at all" and answers it badly for the
 * common case: eight naturals plus four dye jobs is one keypress each, and the
 * well is there for the thirteenth.
 */
export const HAIR_SWATCHES: readonly number[] = [
  0x2b2620, 0x4a3524, 0x6f4a24, 0xa5622a, 0xc98f4a, 0xe8c66a, 0xf0e0b8, 0xb0b6bd,
  0x8e2f2f, 0xc4453a, 0x3f6fb0, 0x6d4f9c, 0x2f8f6a, 0xd06fa8,
];

export function hairStyle(id: string): HairStyle {
  return HAIR_STYLES.find((s) => s.id === id) ?? HAIR_STYLES[0];
}

/**
 * Build one hairstyle in one colour.
 *
 * `build(scale, false)` — NOT centred: a style is drawn in the skull's own
 * doubled grid and an asymmetric one (the sidecut) must stay where it was
 * drawn. `build` still re-bases y on the lowest painted cell whatever `center`
 * says, so the mount's offset is read back off the model rather than written
 * down: a style whose tail hangs lower than the last one moves nothing.
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

// -- what the player picked --------------------------------------------------

/**
 * Stored the way every other setting is: one key each, under
 * `game.settings.<group>.<name>`, validated on read, and THE DEFAULT IS THE
 * ABSENCE OF A KEY (see the note at the top of core/prefs.ts).
 *
 * That last rule is what lets a style carry a `suggested` colour without any
 * extra state: no stored colour means the player has not chosen one, so each
 * style is shown in the colour it was designed in. The moment one is picked it
 * outranks every style's suggestion, and clearing it hands the styles their own
 * colours back.
 *
 * It is NOT in `Prefs`. That record is the fixed set of rows ui/settings.ts
 * renders by hand; this is a debug-panel control today (see the note in
 * ui/perf-panel.ts) and moving it into the character creator this is a rehearsal
 * for should not have to move the storage with it.
 */
const STYLE_KEY = 'game.settings.appearance.hairStyle';
const COLOUR_KEY = 'game.settings.appearance.hairColour';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // storage denied: the defaults are a complete answer
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch { /* storage denied — the session still honours the choice */ }
}

export function storedHairStyle(): string {
  const raw = read(STYLE_KEY);
  return HAIR_STYLES.some((s) => s.id === raw) ? raw as string : HAIR_STYLES[0].id;
}

export function storeHairStyle(id: string): void {
  write(STYLE_KEY, id === HAIR_STYLES[0].id ? null : id);
}

/** The picked colour, or null when the style's own suggestion should stand. */
export function storedHairColour(): number | null {
  const raw = read(COLOUR_KEY);
  if (raw === null || !/^[0-9a-fA-F]{6}$/.test(raw)) return null;
  return parseInt(raw, 16);
}

export function storeHairColour(hex: number | null): void {
  write(COLOUR_KEY, hex === null ? null : hex.toString(16).padStart(6, '0'));
}

/** The colour a style is actually drawn in right now. */
export function hairColourFor(styleId: string): number {
  return storedHairColour() ?? hairStyle(styleId).suggested;
}
