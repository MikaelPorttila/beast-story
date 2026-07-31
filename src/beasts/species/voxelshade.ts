import type { VoxelModel } from '../../core/voxel';

// ---------------------------------------------------------------------------
// Shared voxel-painting helpers for the beast species.
//
// Two problems these solve, both diagnosed from real-game portraits:
//
// 1. VALUE STRUCTURE. build() bakes a fixed per-face shade (top 1.0, sides
//    0.88, front/back 0.8, bottom 0.62) which reads as flat plastic on a solid
//    ellipsoid. Real Cube World creatures have a bright sunlit crest and a
//    genuinely dark underside, so the volume reads even when the creature is
//    backlit. rimTop() and shadeUnder() paint those two bands *into the palette*
//    by recolouring the topmost / lowest existing voxel of each column, which
//    costs no extra cells and cannot change build()'s y-anchor (it only ever
//    repaints cells that are already there).
//
// 2. FACES. Every head in this project independently reinvented the eye and every
//    one of them failed differently. eyes2x2() is now the single eye and all ten
//    species call it; the shapes that did not work are documented on the function
//    itself so nobody re-derives them.
//
//    Note there is no corner/ambient AO in build() — only a fixed per-face
//    directional shade. Anything that should look recessed has to be PAINTED
//    recessed (a lid row at half value, a proud ridge beside it). Do not assume a
//    geometric notch will darken itself; it will not.
// ---------------------------------------------------------------------------

/**
 * Recolour the topmost filled voxel of every column inside the box, giving the
 * model a one-cell sunlit crest. Scan the whole plausible y range of the part —
 * columns with nothing in them are skipped.
 */
export function rimTop(
  m: VoxelModel, color: number,
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
): void {
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      for (let y = y1; y >= y0; y--) {
        if (m.has(x, y, z)) { m.set(x, y, z, color); break; }
      }
    }
  }
}

/**
 * Recolour the lowest filled voxel of every column inside the box: the
 * creature's own contact shadow, so the underside never matches the back.
 */
export function shadeUnder(
  m: VoxelModel, color: number,
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
): void {
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        if (m.has(x, y, z)) { m.set(x, y, z, color); break; }
      }
    }
  }
}

export interface EyeSpec {
  /** |x| of the inner eye column. The eye spans inner..inner+width-1 outward, and
   *  the nose bridge fills the whole gap between the pair, x = -(inner-1)..(inner-1).
   *  So `inner` is really "how far apart are the eyes": at 2 on a seven-cell face the
   *  bridge is three cells wide, which is the ratio that finally stopped the pair
   *  reading as one dark band. */
  inner: number;
  /** Eye columns per side. 2 on a seven-cell face, 1 on a five-cell face — the
   *  target is an eye roughly a fifth of the head's width. */
  width?: 1 | 2;
  /** Bottom of the two iris rows. */
  y: number;
  /** z of the flat face plane. Iris and lids sit flush in it; the lid ledge and
   *  the nose bridge stand one cell proud at z + 1. */
  faceZ: number;
  /** The glossy eye mass, 2x2 minus the catchlight cell. A very dark TINT OF THE
   *  COAT HUE — never 0x000000. Pure black punches a hole in the silhouette;
   *  a dark plum on a violet cat or a dark rust on an orange fox reads as a wet
   *  eye instead. */
  iris: number;
  /** Catchlight. Exactly ONE near-white cell, top of the OUTER column. */
  shine: number;
  /** Lid / socket tone: the coat at roughly half value. Painted as a full-width
   *  row above the iris (and below, if `lowerLid`), which is what turns four dark
   *  cells from a sticker into an eye set into a face. */
  lid?: number;
  /** Hang the upper lid one cell PROUD at z + 1 as well, so it also throws a real
   *  shadow down over the iris. Only where the face has a row above to carry it. */
  browProud?: boolean;
  /** Paint the lid row below the iris too. Skip it where the row below the eye is
   *  already a muzzle or a chest colour that shouldn't darken. */
  lowerLid?: boolean;
  /** Lit coat tone for a nose bridge at x = 0, one cell PROUD, spanning the iris
   *  rows. THIS is what stops a close-set pair reading as sunglasses: a bright
   *  vertical ridge between the eyes with a hard shaded edge on both sides. */
  bridge?: number;
  /** Emissive intensity for the iris (spectral / elemental eyes). Keep it LOW —
   *  0.5-0.9 — a bloom pass amplifies it, and a blown iris is a headlamp. */
  glow?: number;
  /** Optional 1-cell cheek mark below the outer eye column (blush / marking). */
  cheek?: number;
}

/**
 * Stamp the house eye pair. Mirrored automatically; the caller only supplies the
 * right-hand geometry — deliberately, so a bilateral feature cannot drift in
 * colour or position between sides.
 *
 * Three earlier shapes failed and are worth recording, because each looked fine
 * in code:
 *
 *   1. a solid 2x2 near-black block — four of a head's ~35 front cells in pure
 *      black. Welding goggles, every time.
 *   2. a 2x2 bright iris with a two-cell dark pupil column — the outer column sits
 *      near the widest point of the skull, so the iris hid round the side and only
 *      the pupil presented to camera: two black bars.
 *   3. a 2x3 BRIGHT iris with one dark pupil cell — the version this replaces. Its
 *      failure is subtler: the bright iris was within a few percent of the cream
 *      muzzle beside it, so it dissolved into the face and left exactly one dark
 *      cell floating in a pale band. A critic reading it at portrait distance saw
 *      "two solid black rectangles with no iris and no highlight", and was right —
 *      that is all that survived.
 *
 * What works is the opposite polarity: the eye is the DARK mass and the face is
 * light, which is how nearly every readable cartoon creature is drawn.
 *
 * The other half of it is SPACING, and getting that right cost two real-game capture
 * rounds. The obvious move is to push the pair apart so the gap between the eyes is
 * as wide as an eye — inner: 2 on a seven-cell face gives a three-cell bridge. It
 * photographs badly: the eyes land on |x| = 2..3, hard against the edge of the plate,
 * so each one wraps round the silhouette while the three-cell bridge becomes a pale
 * block that reads as the whole face. inner: 1 wins on every species tested. It
 * leaves ONE cell of coat outboard of each eye, which is what actually keeps both
 * eyes presented at three-quarter bearings, and the single proud bridge cell plus a
 * catchlight inside each eye is enough to stop the pair merging.
 *
 * Where the face is only five cells (aquaxol, galebird, boulderpup) the same layout
 * is bought with `width: 1` — a one-cell eye, coat / eye / bridge / eye / coat. That
 * is also about the fifth-of-head-width proportion this whole macro aims at.
 *
 * The catchlight goes on the OUTER column. It was on the inner column for one
 * capture round, and the result was that the two catchlights sat immediately either
 * side of the bridge and merged with it into one three-cell pale block in the middle
 * of the face — so the face read as a big pale nose with two dark patches beside it
 * rather than as two eyes. On the outer column each glint stays inside its own eye.
 * (The reason to fear the outer column — that it hides round the curve of the skull —
 * only applies at inner: 2, where there is no coat margin outboard of the eye. At
 * inner: 1 there is one, and both glints survive every bearing.)
 *
 *   layout, inner: 1, width: 2, x grows outward    # = iris
 *     y+2    =   lid  lid   (proud at z+1)         * = catchlight
 *     y+1    |    #    *                           | = proud nose bridge
 *     y+0    |    #    #                           = = lid row
 *     y-1        lid  lid   (lowerLid)
 */
export function eyes2x2(m: VoxelModel, s: EyeSpec): void {
  const z = s.faceZ;
  const w = s.width ?? 2;
  const paint = (x: number, y: number, zz: number, c: number): void => {
    if (s.glow !== undefined && c === s.iris) m.setEmissive(x, y, zz, c, s.glow);
    else m.set(x, y, zz, c);
  };
  if (s.bridge !== undefined) {
    // Fills the WHOLE gap between the eyes and stands one cell proud, so the pair is
    // separated by a lit ridge with a hard shaded edge down each side. Painted first
    // so a lid row stamped later can still overwrite its top.
    for (let x = -(s.inner - 1); x <= s.inner - 1; x++) {
      for (let r = 0; r < 2; r++) {
        m.set(x, s.y + r, z, s.bridge);
        m.set(x, s.y + r, z + 1, s.bridge);
      }
    }
  }
  for (const sx of [1, -1]) {
    const cols: number[] = [];
    for (let d = 0; d < w; d++) cols.push(sx * (s.inner + d));
    for (const x of cols) {
      paint(x, s.y, z, s.iris);
      paint(x, s.y + 1, z, s.iris);
    }
    // Outer column, top cell. Never emissive: a glowing catchlight blooms into a
    // star and eats the iris around it.
    m.set(cols[cols.length - 1], s.y + 1, z, s.shine);
    if (s.lid !== undefined) {
      for (const x of cols) {
        m.set(x, s.y + 2, z, s.lid);
        if (s.browProud) m.set(x, s.y + 2, z + 1, s.lid);
        if (s.lowerLid) m.set(x, s.y - 1, z, s.lid);
      }
    }
    if (s.cheek !== undefined) m.set(cols[cols.length - 1], s.y - 1, z, s.cheek);
  }
}
