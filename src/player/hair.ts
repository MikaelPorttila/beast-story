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
 * THE GRAIN. Every edge in this file moves in steps of this many cells, and
 * every patch of colour is at least this wide.
 *
 * It is the difference between voxel hair that reads as a DESIGN and voxel hair
 * that reads as noise, and it was the thing missing from all eight styles. A
 * hem that picks a new height at every column, and a tone that picks a new
 * value at every column, give you a fringe of one-cell teeth and a coat of
 * static — busy at any distance and mush at gameplay distance. Hand-drawn voxel
 * hair does the opposite: a few LARGE chunks, each one flat, offset from its
 * neighbours by two or three cells so the step reads deliberately.
 *
 * Three cells at this scale is about 2.5 cm on the finished hero — big enough
 * to be a shape, small enough that a head still carries five or six of them
 * across its width.
 */
const CHUNK = 3;

/**
 * Which chunk a cell belongs to. The `+ 60` is only to keep the floor sensible
 * for negative coordinates — hair cells run either side of zero and
 * `Math.floor(-1 / 3)` would otherwise put -1 and 1 in different chunks from
 * their neighbours in an asymmetric way.
 */
const chunkOf = (n: number): number => Math.floor((n + 60) / CHUNK);

/**
 * The centre of a cell's chunk, in cell coordinates. Every SHAPE test in this
 * file runs through here rather than through the cell itself, which is what
 * makes an outline a wall of blocks instead of a rasterised curve.
 */
const chunkCentre = (n: number): number =>
  chunkOf(n) * CHUNK - 60 + (CHUNK - 1) / 2 + 0.5;

/**
 * The tone for one cell of a sheet of hair. Keyed on the CHUNK, not the column:
 * a colour that changes every cell is static, and the reference this was drawn
 * against holds one value across a whole slab and then steps. `tip` darkens the
 * lowest row of a fall, which is what makes a curtain read as hanging rather
 * than as painted on.
 */
function strand(p: Palette, x: number, z: number, tip = false): number {
  if (tip) return p.dark;
  const h = hash(chunkOf(x), 0, chunkOf(z));
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
  const lo = alongX ? x0 : z0;
  const hi = alongX ? x1 : z1;
  const span = Math.max(1, hi - lo);
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      const run = alongX ? x : z;
      const t = (run - lo) / span;
      // ROUNDED ENDS. The last two columns of a sheet stop short — two cells at
      // the very end, one at its neighbour — so a curtain finishes in a curve
      // instead of being cut off square. Every sheet in the file gets it from
      // here rather than from eight hand-placed exceptions, and it is the same
      // idea the head's own corners now use: a silhouette has no straight
      // vertical edges on a body drawn this small.
      const fromEnd = Math.min(run - lo, hi - run);
      const round = span < 3 ? 0 : fromEnd === 0 ? 2 : fromEnd === 1 ? 1 : 0;
      // THE RAGGED EDGE IS CHUNKED. One height per block of `CHUNK` columns,
      // stepping two cells at a time — a sheet of big square tabs rather than a
      // row of one-cell teeth. See the note on CHUNK.
      const block = chunkOf(run);
      const step = Math.floor(hash(block, 7, chunkOf(alongX ? z0 : x0)) * (jag + 1)) * 2;
      const end = Math.round(bottom - sweep * t + round + step);
      for (let y = end; y <= top; y++) v.set(x, y, z, strand(p, x, z, y === end));
    }
  }
}

/**
 * THE ROUNDED MASS — everything the cap is not allowed to be.
 *
 * The cap that hugs the skull is stepped and has to be: the plane rule at the
 * top of this file forbids an exposed hair face on x = ±8, z = ±8 or y = 12,
 * and a genuinely round outline steps across those planes constantly. That
 * constraint is REAL but it is also LOCAL — it applies only where hair sits
 * over the skull's own footprint. Behind the head, out past the ears, in front
 * of the face and above the crown there is no skull to fight with and the shape
 * is free.
 *
 * That free region is where a head of hair actually lives: the fall down the
 * back, the width past the ears, the depth over the brow. So it is painted as
 * an ELLIPSOID rather than as sheets — round in plan, round in section, and
 * with a hem that curves away instead of being cut off at one height. It is
 * what replaced the four-cell-thick slab across the back that made every style
 * look like a wig on a stand, and the flat side panels beside it.
 *
 * `hem` is the lowest row at the mass's DEEPEST point, and every column ends
 * higher than that in proportion to how far out from the axis it sits — which
 * is the whole of the rounding. `frontHem` is the same thing for the half in
 * front of the ears, where hair has to stop short of the eyes.
 */
function mass(
  v: VoxelModel, p: Palette,
  o: {
    rx: number; rz: number; top: number; hem: number;
    frontHem?: number; jag?: number;
    /**
     * Lowest x it may paint. THE ONE THING THAT MAKES IT ASYMMETRIC, and the
     * sidecut needs it: a mass that wraps the whole head buries the shaved side
     * under exactly the hair that is supposed to have been clipped off it.
     */
    from?: number;
  },
): void {
  const jag = o.jag ?? 2;
  const frontHem = o.frontHem ?? o.hem;
  const from = o.from ?? -Infinity;
  for (let x = -Math.ceil(o.rx) - 1; x <= Math.ceil(o.rx); x++) {
    for (let z = -Math.ceil(o.rz) - 1; z <= Math.ceil(o.rz); z++) {
      if (x < from) continue;
      const ax = Math.abs(x + 0.5);
      const az = Math.abs(z + 0.5);
      // Over the skull the cap owns the shape — see above. Skipping that
      // footprint is also what makes this SAFE by construction: every face it
      // can leave is either outside the skull entirely or pointing at it.
      if (ax <= SIDE + 0.5 && az <= SIDE + 0.5) continue;
      // THE EARS ARE PART OF THAT FOOTPRINT TOO. They stick out to x = ±10 in
      // a two-cell band of z, and a column of hair whose outer face lands on
      // ±10 is the same seam as one landing on the skull's own side. So in that
      // band the mass starts a cell further out: its inner face then meets the
      // ear's outward one, which is the harmless facing.
      if (az <= 1.5 && ax <= 9.5) continue;
      // BOTH THE OUTLINE AND THE HEM ARE MEASURED PER CHUNK, not per cell:
      // every cell in a block of three is in or out together and ends at one
      // height, so the skirt is a wall of broad tabs. Per cell, the rim is a
      // rasterised ellipse and the hem a row of teeth — the noise the reference
      // this was drawn against has none of.
      const cx = chunkCentre(x);
      const cz = chunkCentre(z);
      const qc = (Math.abs(cx) / o.rx) ** 2 + (Math.abs(cz) / o.rz) ** 2;
      if (qc > 1) continue;
      const reach = Math.sqrt(Math.max(0, 1 - qc));
      const floor = cz > 0 ? frontHem : o.hem;
      const end = Math.round(o.top - (o.top - floor) * reach)
        + Math.floor(hash(chunkOf(x), 5, chunkOf(z)) * (jag + 1)) * 2;
      for (let y = end; y <= o.top; y++) v.set(x, y, z, strand(p, x, z, y === end));
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
 * of that and the bases of its neighbours merge into one mass.
 *
 * IT ALSO HAS TO STAY FAT FOR LONGER. A linear taper spends half its length in
 * the last cell or two, which is a needle with a shoulder — so the width falls
 * off as the SQUARE ROOT of the distance left, which holds the mass out near
 * the tip and then closes it quickly. Same base, same length, twice the hair.
 *
 * The direction is normalised on its LARGEST component, so one step is one cell
 * along the axis the prong mostly runs down and the run can never leave a gap
 * in that axis; the cross-section is then the other two axes.
 */
function spike(
  v: VoxelModel, p: Palette,
  x: number, y: number, z: number,
  dx: number, dy: number, dz: number,
  len: number, thick = 5,
): void {
  const m = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) || 1;
  const ux = dx / m, uy = dy / m, uz = dz / m;
  const axis = Math.abs(uy) === 1 ? 'y' : Math.abs(ux) === 1 ? 'x' : 'z';
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
        if (axis === 'y') v.set(px + a, py, pz + b, tone);
        else if (axis === 'x') v.set(px, py + a, pz + b, tone);
        else v.set(px + a, py + b, pz, tone);
      }
    }
  }
}

/**
 * THE TOP OF THE HEAD OF HAIR — a real dome, built row by row off a circle.
 *
 * THIS IS WHERE ALL THE VOLUME WAS BEING LEFT ON THE TABLE, and the reason is
 * worth writing down because it was a rule applied where it does not hold.
 * Above y = 12 there is no skull left to share a plane with, so the plane rule
 * at the top of this file binds NOTHING up here. The shape is completely free.
 *
 * What was here instead: three stacked discs of radius 9.5, 7.5 and 5.5, one
 * cell tall each. Three flat plates in a ziggurat, the top one eleven cells
 * across — which is a flat top, and no amount of "more height" fixes a flat top
 * because a fourth plate is just a flatter one. It looked like a cube because
 * it was three cubes.
 *
 * Now the radius follows `sqrt(1 - t^2)`, a quarter-circle from the cap's own
 * outline at the base to nothing at the apex, over as many rows as `height`
 * asks for. Eight rows is a hand's depth of hair standing over the crown with a
 * round top on it; four is a close cut. `lift` pushes the profile OUT before it
 * turns in — above 1 the sides stay full for longer and the whole mass reads
 * bouffant rather than conical, which is what separates a bowl cut from a
 * wizard's hat.
 */
function crown(
  v: VoxelModel, p: Palette,
  o: { from: number; height: number; grow?: number; lift?: number },
): void {
  const grow = o.grow ?? FULL;
  const base = SIDE - 0.5 + grow;          // the plan radius the cap ends on
  const lift = o.lift ?? 1;                // >1 bulges the sides before it turns in
  for (let i = 0; i < o.height; i++) {
    const y = o.from + i;
    // THE PROFILE IS SAMPLED IN BANDS OF TWO ROWS, so the dome comes down in a
    // few broad terraces rather than shrinking by a cell every row. The curve
    // is the same one; what changes is that the steps in it are big enough to
    // read as chunks, which is the grain the whole file works to.
    const band = Math.floor(i / 2) * 2 + 1;
    const t = band / o.height;                             // 0 at the base, 1 at the apex
    const r = base * Math.pow(Math.max(0, 1 - t * t), 0.5 / lift);
    const lim = Math.ceil(r);
    for (let x = -lim - 1; x <= lim; x++) {
      for (let z = -lim - 1; z <= lim; z++) {
        // An ELLIPSE, not the cap's chamfered square — above the crown nothing
        // of the head is left to share a plane with, so the outline owes the
        // plane rule nothing. And it is sampled at the CHUNK's centre, so the
        // disc is built out of whole blocks: a rasterised circle tested per
        // cell has a one-cell staircase all round its rim, which is the exact
        // fizz this file is trying to get rid of.
        const ax = Math.abs(chunkCentre(x));
        const az = Math.abs(chunkCentre(z));
        if ((ax / r) ** 2 + (az / (r * 1.05)) ** 2 > 1) continue;
        v.set(x, y, z, strand(p, x, z));
      }
    }
  }
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
  crown(v, p, { from: 13, height: 8, lift: 1.5 });
  // the fall down the back of the neck, four cells of it
  // Everything outside the skull — the fall down the back, the width past the
  // ears — as one rounded mass. It used to be a slab across the back and two
  // flat panels beside it; see the note on `mass`.
  mass(v, p, { rx: 12, rz: 13, top: 10, hem: -3, frontHem: 5, jag: 2 });
  // Jagged fringe over the brow. z 7..9 straddles the face plane, so the tufts
  // stand two cells proud of it rather than being painted onto it, and it rises
  // to 12 rather than stopping level with the crown (see the plane rule).
  fall(v, p, { x0: -11, x1: 10, z0: 7, z1: 8, top: 12, bottom: BROW, jag: 2 });
  // the cowlick, raked back rather than standing up like a chimney
  spike(v, p, -2, 14, -3, -0.2, 0.7, -1, 7, 5);
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
  crown(v, p, { from: 13, height: 4, grow: 1, lift: 1.3 });
  mass(v, p, { rx: 10, rz: 11, top: 9, hem: 3, frontHem: 6, jag: 1 });
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
  crown(v, p, { from: 13, height: 9, lift: 2.0 });
  // the skirt: all the way round, ending below the ears at the sides and
  // shorter at the front so the eyes stay clear
  fall(v, p, { x0: -11, x1: 10, z0: 7, z1: 8, top: 11, bottom: BROW, jag: 2 });
  mass(v, p, { rx: 13, rz: 14, top: 9, hem: -6, frontHem: 4, jag: 2 });
  // The two side falls, over the ears and out past them. Each is ONE call two
  // cells thick, so both layers of a column end together and the outer one is
  // what the ear sees — the ear's own outer face is the plane x = ±10, and a
  // layer stopping there is two surfaces at one depth (see the plane rule).

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
  // THE PARTING. Everything below this line on his right is clipped; everything
  // left of it is long. One number, because a sidecut IS one line.
  const PART = -3;
  // Hair on top of the WHOLE head, both sides of the parting, with the same
  // domed crown every other style gets. A sidecut is not a half-bald head: the
  // top is full and swept over, and what is shaved is the side BELOW the
  // parting. Drawing it as two halves — long slab one side, stubble the other —
  // is what made this read as a lopsided blob rather than a haircut.
  cap(v, p, 9, 12, FULL, 7);
  crown(v, p, { from: 13, height: 8, lift: 1.6 });
  // The long side carries on DOWN past the parting, where the shaved one stops.
  for (let x = PART; x <= 10; x++) {
    for (let z = -11; z <= 10; z++) {
      if (!inOutline(x, z, FULL, 7, false)) continue;
      for (let y = BROW; y < 9; y++) v.set(x, y, z, strand(p, x, z));
    }
  }
  // THE SHAVED SIDE IS BARE, and that is the whole of it. It used to be two
  // cells of dark stubble, and on a style whose own colour is near-black that
  // is not a shaved head — it is more hair. `paintMohawk` learned the same
  // thing: a shell that covers the head IS a hat, whatever value it is painted.
  // The head is already skin-coloured, so the clipped side is drawn by not
  // drawing, and the cap's bottom edge at 9 is the clipper line.
  //
  // One cell of fade under that line keeps the edge from being a decal: the
  // tone is the hair's own, so it reads as the last of it rather than as a
  // border drawn round the cut.
  for (let z = -6; z <= 5; z++) {
    if ((z + 12) % 3 === 0) continue;
    v.set(-9, 8, z, shade(p.dark, 0.8));
  }
  // The sweep: short at the parting over his right eye, growing across the brow
  // and hanging past his left one. `sweep` is POSITIVE to get longer along the
  // run — it is subtracted from the bottom, and the sign is the difference
  // between a parting and a curtain over the whole face.
  fall(v, p, { x0: -4, x1: 10, z0: 7, z1: 8, top: 13, bottom: 10, jag: 1, sweep: 8 });
  // the lock beside it, past the jaw — outboard of the ear, ending at x 12
  fall(v, p, { x0: 9, x1: 11, z0: 3, z1: 6, top: 10, bottom: -3, jag: 2 });
  // The fall down the back and round the long side ONLY. Symmetric, it wrapped
  // the shaved side in exactly the hair that was supposed to have been clipped
  // off it — which is what `from` exists for.
  mass(v, p, { rx: 12, rz: 13, top: 10, hem: -4, frontHem: 4, jag: 3, from: PART });
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
  // Low, because the fan above supplies the height — but a mass for it to grow
  // out of, rather than a plate for it to stand on.
  crown(v, p, { from: 13, height: 4, lift: 1.8 });
  mass(v, p, { rx: 12, rz: 13, top: 10, hem: -1, frontHem: 5, jag: 2 });
  // the hair the spikes are swept UP from — without it the fan stands on a bare
  // brow and the swept look becomes a fringe of horns
  fall(v, p, { x0: -11, x1: 10, z0: 7, z1: 8, top: 12, bottom: BROW + 1, jag: 2 });
  // The fan: heavy prongs off the FRONT of the crown, every one raking up and
  // back over the skull. They start fat enough to merge into one another, which
  // is what makes this a swept mass rather than a row of horns.
  const fan: Array<[number, number, number, number, number]> = [
    // x, z, sideways lean, length, base width
    [-9, 4, -0.5, 9, 6],
    [-6, 7, -0.25, 13, 7],
    [-2, 8, 0, 14, 7],
    [2, 7, 0.25, 13, 7],
    [6, 4, 0.5, 9, 6],
  ];
  for (const [x, z, lean, len, w] of fan) spike(v, p, x, 12, z, lean, 1, -0.8, len, w);
  // Two shorter ones behind them, filling the trough the fan leaves over the
  // crown so the mass reads as continuous from the side.
  for (const x of [-6, 2]) spike(v, p, x, 12, -1, 0, 1, -1, 8, 6);
  // The bangs: three heavy tufts hanging over the brow, leaning out as they
  // fall. The lean is well under 1, so the run steps down in y and the tips end
  // a cell clear of the face rather than a hand's width in front of it.
  for (const x of [-7, -2, 4]) spike(v, p, x, 12, 8, 0, -1, 0.2, 6, 4);
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
  crown(v, p, { from: 13, height: 3, lift: 1.8 });
  mass(v, p, { rx: 12, rz: 13, top: 10, hem: 0, frontHem: 5, jag: 2 });
  fall(v, p, { x0: -11, x1: 10, z0: 7, z1: 8, top: 12, bottom: BROW + 1, jag: 2 });
  // THE FLAME. A solid block of hair carried a long way above the crown, cut
  // into prongs at the top rather than assembled out of them — a ring of thin
  // spikes reads as a crown, and the difference is that the mass here is one
  // thing that FORKS. The first course is short and fat, and the crest goes up
  // out of the middle of it.
  const ring: Array<[number, number, number, number, number, number]> = [
    // x, z, lean x, lean z, length, base width
    [-7, 3, -0.55, 0.3, 10, 6],
    [-7, -5, -0.55, -0.3, 12, 6],
    [-2, 5, 0, 0.35, 14, 7],
    [-2, -7, 0, -0.4, 15, 7],
    [3, 3, 0.55, 0.3, 10, 6],
    [3, -5, 0.55, -0.3, 12, 6],
  ];
  for (const [x, z, lx, lz, len, w] of ring) spike(v, p, x, 12, z, lx, 1, lz, len, w);
  // the crest, out of the middle of that and taller than any of it
  spike(v, p, -2, 14, -1, 0, 1, -0.15, 15, 7);
  spike(v, p, -6, 15, -1, -0.2, 1, -0.2, 11, 5);
  spike(v, p, 2, 15, -1, 0.2, 1, -0.2, 11, 5);
  // two bangs left hanging at the front, so there is a face under all this
  spike(v, p, -7, 12, 8, -0.2, -1, 0.2, 7, 4);
  spike(v, p, 4, 12, 8, 0.2, -1, 0.2, 7, 4);
}

/**
 * THE CURTAIN FRINGE — parted down the middle, both halves sweeping out and
 * down past the cheekbones.
 *
 * THE PARTING IS A HOLE, NOT A LINE, and that is the one structural thing this
 * style needs that no other one does. Every other style starts its cap at
 * `BROW` and so carries hair across the whole forehead; a curtain fringe is
 * defined by the forehead it leaves BARE in the middle. So the cap starts two
 * rows higher and the front is drawn entirely by the two curtains, which meet
 * at the centre line short and reach their longest out at the temples. The gap
 * between them is the parting.
 *
 * `sweep` carries the length across each half and the two signs are mirrored:
 * the left curtain gets longer along its run (out from the parting), the right
 * one gets shorter along its run (in towards it). Same shape, opposite
 * direction of travel.
 */
function paintCurtain(v: VoxelModel, p: Palette): void {
  // Two rows higher than every other style. See above — this gap is the style.
  cap(v, p, BROW + 2, 12, FULL, 7);
  crown(v, p, { from: 13, height: 8, lift: 1.4 });
  // Back and sides. `frontHem` is high because the curtains own the front and
  // a skirt hanging into them would fill the parting back in.
  mass(v, p, { rx: 12, rz: 13, top: 10, hem: -3, frontHem: 8, jag: 2 });
  // The curtains themselves, three cells deep so each one is a mass rather than
  // a sheet stuck on the face.
  // THE EYE LINE IS THE CONSTRAINT. The eyes sit on rows 4..7 between x -6..-3
  // and 2..5, so a curtain that reaches row 4 anywhere over that span is a bob
  // with a slot in it. Ending at 4 out at the temples and 10 at the parting
  // puts the sweep at row 7 by the time it crosses the outer corner of an eye
  // and clear of the face entirely by the inner one — long at the sides,
  // nothing over the eyes, which is the whole shape.
  fall(v, p, { x0: -11, x1: -1, z0: 7, z1: 9, top: 12, bottom: 4, jag: 1, sweep: -6 });
  fall(v, p, { x0: 0, x1: 10, z0: 7, z1: 9, top: 12, bottom: 10, jag: 1, sweep: 6 });
  // A lock in front of each ear, carrying the curtain to the jaw — the layer
  // that makes this read as grown out rather than as a bowl with a slot in it.
  fall(v, p, { x0: -12, x1: -10, z0: 2, z1: 6, top: 8, bottom: 1, jag: 1 });
  fall(v, p, { x0: 9, x1: 11, z0: 2, z1: 6, top: 8, bottom: 1, jag: 1 });
}

/**
 * Swept back into a tail — the swordsman's head. The scalp is smoothed back
 * rather than fringed, gathered at the nape, and the tail hangs BACK and DOWN
 * at an angle rather than straight down: straight down puts it through the
 * stowed weapon's diagonal (see HOLSTER_POS in hero-rig.ts).
 */
function paintPonytail(v: VoxelModel, p: Palette): void {
  cap(v, p, BROW, 12, FULL, 7);
  crown(v, p, { from: 13, height: 8, lift: 1.4 });
  // Swept back: no fringe, but the hairline still comes down to the brow —
  // "swept back" is hair going somewhere, not hair that stops at the crown.
  fall(v, p, { x0: -11, x1: 10, z0: 7, z1: 8, top: 12, bottom: BROW + 1, jag: 1 });
  mass(v, p, { rx: 11, rz: 12, top: 10, hem: 0, frontHem: 5, jag: 1 });
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
  // Rooted at z -12, not -11. Fattening it to six cells widened its base until
  // the front of it reached the skull's back plane, where the skull now has a
  // step of its own (row 0 is inset — see SKULL_SHELL in hero-rig.ts) and two
  // exposed faces met on one plane. Behind the head entirely, it cannot.
  spike(v, p, -1, 3, -12, 0, -1, -0.45, 12, 6);
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
    // A PLATEAU, NOT AN ARCH. A plain sine peaks at one z and falls away from
    // it either side, so the taller it got the more it read as a cone — a
    // wizard's hat rather than a crest. Its square root rises fast and then
    // holds, which is a fin: full height down most of the run, rounded off at
    // the brow and the nape.
    const ridge = 12 + Math.round(5 + 10 * Math.sqrt(Math.sin(t * Math.PI)))
      - Math.floor(hash(0, 0, z) * 2);
    for (let y = 12; y <= ridge; y++) {
      const k = (y - 12) / Math.max(1, ridge - 12);
      const half = k > 0.86 ? 0 : k > 0.55 ? 1 : 2;   // five cells wide at the root
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
  { id: 'curtain', labelKey: 'hair.curtain', suggested: 0x6a4a32, paint: paintCurtain },
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
