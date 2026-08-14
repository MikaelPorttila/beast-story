/**
 * STRUCTURE COLLISION — what a settlement stops you walking through.
 *
 * Until this file existed, a town was scenery: the hero walked through huts,
 * palisades, crates and the well, and only terrain and tree trunks were solid.
 * Four things had to be true of the fix, and they are what shaped everything
 * here.
 *
 * 1. BOXES, NOT CIRCLES. A hut is a rectangle. A disc drawn round one either
 *    admits the player to its corners or stops him a metre short of the wall,
 *    and a camp is thirty rectangles. So the primitive is an ORIENTED BOX —
 *    centre, half-extents, yaw — which is exactly the shape `Accum.add` already
 *    stamps the mesh with, so the collider rotates with the building for free.
 *
 * 2. ONE SOURCE OF TRUTH. A collider authored in a second place drifts away from
 *    its mesh the first time someone resizes a hut. So the footprint is MEASURED
 *    off the voxel model the builder just painted (`measureFootprint`, called
 *    from `bakeSolid`), rides on the `Template` (props.ts `SolidBox`), and is
 *    stamped by the SAME call that stamps the vertices (`SolidStamp.add`). There
 *    is no way to place a hut and forget its collider, and no number stating the
 *    hut's size that is not the hut.
 *
 *    That is the same argument `bake` makes in props.ts about a tree's crown:
 *    "restating the union of them as a bounding dome by hand is exactly the sort
 *    of duplicated constant that goes stale the first time a clump moves."
 *
 * 3. THE GATE MUST STAY PASSABLE. The Encampment has one road in, and walling it
 *    strands the player outside their own start town. This is what stops the
 *    footprint from being a plain bounding box: the gate's bounding box spans the
 *    opening, because a lintel and a banner hang across it five units up. What is
 *    measured instead is the material a BODY meets — see WALK_UNDER — so the
 *    opening measures as empty, the two posts and two doors measure as four
 *    separate obstacles, and the road runs between them without anyone having
 *    written down where the road is.
 *
 * 4. A ROOF IS NOT A BOX. Rule 1 holds for everything that meets the ground as a
 *    rectangle, and a thatched gable and a canvas ridge tent are not that: their
 *    whole character is a SLOPE, and the best a box can say about one is "a slab
 *    at the ridge". Issue #3 is a photograph of that slab — a cage floating a
 *    metre over the thatch, with no way to be ON a roof rather than above it.
 *
 *    So a roof gets the second primitive, a cylinder lying along its ridge
 *    (`SolidRidge` in props.ts). A hut is then a large box for the timber and
 *    one cylinder for the thatch, TWO colliders, and a ridge tent is the
 *    cylinder alone. Across the three settlements that is 191 boxes and 7 roofs,
 *    against 193 boxes before.
 *
 *    The alternative was tried first and is the reason those counts are worth
 *    stating: decomposing every roof into boxes that follow its steps took the
 *    world to 2326 of them, about forty per hut, and tripled the cost of the
 *    query inside a camp. It also could not do the one thing a roof needs, which
 *    is to be SMOOTH — a staircase of box lids is what you get, however many of
 *    them there are.
 *
 *    The builder brackets its roof with `VoxelModel.region` and every number is
 *    still measured off those cells — see `measureRidge`, and the note on
 *    `region` for why the bracket is the one thing a measurement cannot recover.
 *
 * The query is `World.structureTopAt`, deliberately the same shape as
 * `getHeight` and `trunkSolidTopAt`: every mover in the game already compares a
 * column's top against its feet plus MAX_STEP_UP, so a settlement becomes solid
 * by answering that question rather than by anyone growing a second kind of
 * collision. A low crate is walkable-onto and a chest-high one is a wall, by the
 * same rule that decides whether a terrace is a step or a cliff.
 *
 * It is also what makes a second primitive cheap to add: the query is a HEIGHT
 * FIELD, one number per column, so a shape only has to be able to answer "how
 * high are you over this point". A cylinder on its side answers that with a
 * square root.
 */
import { MAX_STEP_UP, type SiteClearance } from "../core/types";
import type { VoxelModel, VoxelRegion } from "../core/voxel";
import { Accum, bakeProp, type SolidBox, type SolidRidge, type Template } from "./props";

/**
 * How high above a model's base collision material is looked for, in world
 * units.
 *
 * This is the ONLY place head clearance can be expressed. The collision model
 * has no vertical body extent at all — `blockTop` compares a column's top
 * against the feet and nothing else — so "you can walk under that" cannot be
 * said at query time; it has to be said when the footprint is measured, by
 * leaving material that is entirely overhead out of the footprint.
 *
 * 2.0 is a standing body: the hero rig measures ~1.8 to the top of the hat.
 * The two things in the world that MUST be walked under both clear it by a wide
 * margin and neither is close to the line — the gate's lintel starts 5.04 units
 * up (18 voxels at V = 0.28) and a road lamp's bracket 3.64 — so the value is a
 * plateau rather than a tuned edge. Lower it under ~1.0 and a crouching-height
 * beam would stop reading as an obstacle; raise it past ~3.5 and the lamp
 * bracket leaning over the road becomes a wall across the carriageway.
 */
const WALK_UNDER = 2.0;

/**
 * Bake a town part AND measure what it blocks, in one call.
 *
 * The town builders use this instead of `bakeProp` wherever the piece is
 * something you cannot walk through. A builder that genuinely wants no collider
 * — a flame on the glow material, a bridge pier that lives under the deck, a
 * signpost arm hanging three metres up — keeps `bakeProp` and says why.
 *
 * `roofs` are the parts of this model that are ROOFS, each bracketed by the loop
 * that painted it (`VoxelModel.region`). Each becomes one cylinder lying along
 * its ridge, and none of its cells reach the box measurement — nor does anything
 * standing ABOVE a roof, which is the whole reason a hut with a chimney is still
 * two colliders and not three. A chimney is not something a body on the ground
 * can walk into; the thatch around it is what stops you, and that is the
 * cylinder's job.
 */
export function bakeSolid(model: VoxelModel, scale: number, ...roofs: VoxelRegion[]): Template {
  const t = bakeProp(model, scale);
  const solid = measureFootprint(model, scale, roofs);
  if (solid.length > 0) {
    t.solid = solid;
  }
  const ridges: SolidRidge[] = [];
  for (const roof of roofs) {
    const r = measureRidge(model, scale, roof);
    if (r) {
      ridges.push(r);
    }
  }
  if (ridges.length > 0) {
    t.ridge = ridges;
  }
  return t;
}

/**
 * A PLATFORM: material a builder brackets as the WALKABLE surface of an
 * elevated deck — a quay span, a pier (issue #228). `measureFootprint` cannot
 * see one: planking carried on piles starts above `WALK_UNDER`, which the body
 * band correctly reads as overhead. One box over the region's own bounds,
 * blocking from the template base to the plank top — a pier's underside is
 * deliberately not a route, the way you also cannot swim through its piles.
 */
export function measurePlatform(
  model: VoxelModel,
  scale: number,
  deck: VoxelRegion,
): SolidBox | null {
  const b = model.bounds(true);
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  let topY = -Infinity;
  model.forEachCell((x, y, z) => {
    if (!deck.has(x, y, z)) {
      return;
    }
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
    topY = Math.max(topY, y);
  });
  if (!Number.isFinite(topY)) {
    return null;
  }
  return {
    cx: ((x0 + x1 + 1) / 2 - b.ox) * scale,
    cz: ((z0 + z1 + 1) / 2 - b.oz) * scale,
    hx: ((x1 - x0 + 1) / 2) * scale,
    hz: ((z1 - z0 + 1) / 2) * scale,
    top: (topY - b.oy + 1) * scale,
  };
}

/**
 * How far a template's collision material reaches from its own origin.
 *
 * MEASURED off the boxes `bakeSolid` already measured off the model, for the
 * reason rule 2 at the top of this file gives: a second number describing how
 * big a lamp is would be a second number to keep in step with the lamp. The
 * corner rather than the face, so a run passing the piece cannot clip a corner
 * the radius did not know about.
 *
 * This is a PHYSICAL extent and not a placement radius, and the difference is
 * the whole reason it exists: `LAMP_CLEAR` (11, towns.ts) says how far apart two
 * lamps should stand, and a fence that kept 11 units off every lamp would lose a
 * 22-unit stretch of itself at each one. What a plank must not run through is
 * the timber — see `clearRun` in towns.ts.
 */
export function footprintRadius(t: Template): number {
  let r = 0;
  for (const b of t.solid ?? []) {
    r = Math.max(r, Math.hypot(Math.abs(b.cx) + b.hx, Math.abs(b.cz) + b.hz));
  }
  for (const g of t.ridge ?? []) {
    r = Math.max(r, Math.hypot(Math.abs(g.cx) + g.hl, Math.abs(g.cz) + g.r));
  }
  return r;
}

/**
 * A tree's bole as an oriented box, in TEMPLATE units — the third primitive's
 * worth of geometry this file did not need until a settlement had a wood in it.
 *
 * WHY A TREE NEEDS A CASE AT ALL. The overworld's canopies are solid, but not
 * through this file: `bake` (props.ts) measures the shaft and files it in the
 * per-chunk trunk registry, which `World.trunkSolidTopAt` answers from. That
 * registry is keyed by streamed chunk, so a tree stamped somewhere with no
 * chunk — the deck of a flying island — was drawn and blocked nothing. The
 * measurement it needs already exists and rides on the same `Template`; all
 * that was missing was a second consumer of it. See issue #80.
 *
 * WHY A BOX AND NOT THE REGISTRY'S DISC. Rule 1 at the top of this file: the
 * primitive here is an oriented box, and it is the RIGHT shape for a bole.
 * `trunk.r` is the CIRCUMSCRIBING radius, measured to the corner of a square
 * shaft (props.ts `bake` explains why a disc has to circumscribe: an inscribed
 * one lets the hero walk into the bark before it stops him). A box stamped at
 * the tree's own yaw has the shaft's own corners, so the half-width is that
 * radius brought back in by sqrt(2) and the collider IS the trunk — neither
 * inside the bark nor out in the air beside it.
 *
 * The TOP is the shaft's, not the crown's, which is the same rule the registry
 * applies (`World.trunkSolidTopAt` collides with the bole and leaves the
 * foliage to `climbTopAt`): a canopy you can walk under is most of what makes a
 * wood a place rather than a wall.
 */
function boleBox(trunk: { r: number; top: number }): SolidBox {
  const h = trunk.r * Math.SQRT1_2;
  return { cx: 0, cz: 0, hx: h, hz: h, top: trunk.top };
}

/**
 * The footprint of a voxel model: one box per lump of it a body would walk into.
 *
 * A model COLUMN (one x/z cell of the grid) counts as blocking when it holds a
 * voxel in the band between MAX_STEP_UP and WALK_UNDER above the model's base —
 * i.e. material too tall to step over and too low to duck under. Both ends of
 * that band earn their keep:
 *
 *   - the FLOOR is the game's own step rule, so a signpost's ankle-high cairn
 *     of stones and a tent's pegs are not obstacles, they are things you walk
 *     over. Without it a fingerpost is a 2.8-unit invisible pillar.
 *   - the CEILING is what keeps the gate open, and the lamp brackets, and
 *     anything else the world hangs over a road.
 *
 * Blocking columns are then grouped into 8-CONNECTED components and each
 * component becomes one box. That is what turns a gate into four obstacles with
 * a gap in the middle rather than one wall, and a smithy into a building plus a
 * separate anvil; 8-connected rather than 4 because a voxel model is full of
 * diagonal chains — a brazier's tripod legs taper one cell inward every six
 * voxels — and 4-connectivity shatters each of them into a handful of splinters.
 *
 * A box's TOP is the tallest thing standing in its own columns, overhead
 * material included: the band decides what the footprint IS, not how high the
 * wall reaches. So a hut's box tops out at its eaves and blocks like a building,
 * while the columns under the gate's lintel are in no box at all.
 *
 * `roofs` are parts of the model this measurement is not about — see `bakeSolid`
 * and `measureRidge`. What they take out is not their own cells but EVERY cell
 * from the lowest of them upward: a roof is the line where a building stops
 * being a wall, and above it there is nothing a body standing on the ground can
 * reach except the roof. Skipping only the roof's own cells is not enough and
 * the hut says why — its chimney runs up the gable OUTSIDE the thatch, and its
 * cap overhangs the wall, so one column of stone at 6.16 would drag the whole
 * building's box to the height of the chimney and put the slab back over the
 * roof that this exists to remove.
 *
 * Runs once per template at boot, so it may allocate freely.
 */
export function measureFootprint(
  model: VoxelModel,
  scale: number,
  roofs: readonly VoxelRegion[] = [],
): SolidBox[] {
  const b = model.bounds(true);
  if (!Number.isFinite(b.minX)) {
    return [];
  }
  const w = b.maxX - b.minX + 1;
  const d = b.maxZ - b.minZ + 1;
  /** Tallest voxel top in each column, in units above the model's base. */
  const top = new Float32Array(w * d).fill(-Infinity);
  /** 1 where the column holds material in the body band. */
  const blocks = new Uint8Array(w * d);
  /** Lowest roof course, in cell indices. Nothing at or above it is measured. */
  let eave = Infinity;
  if (roofs.length > 0) {
    model.forEachCell((x, y, z) => {
      if (y < eave && roofs.some((r) => r.has(x, y, z))) {
        eave = y;
      }
    });
  }

  model.forEachCell((x, y, z) => {
    if (y >= eave) {
      return;
    }
    const i = x - b.minX + (z - b.minZ) * w;
    // The voxel's own faces, in units above the base: `build` puts y = 0 at the
    // lowest cell and a cell spans one `scale` upward from its own index.
    const lo = (y - b.oy) * scale;
    const hi = lo + scale;
    if (hi > top[i]) {
      top[i] = hi;
    }
    if (hi > MAX_STEP_UP && lo < WALK_UNDER) {
      blocks[i] = 1;
    }
  });

  const boxes: SolidBox[] = [];
  const stack: number[] = [];
  for (let seed = 0; seed < blocks.length; seed++) {
    if (blocks[seed] === 0) {
      continue;
    }
    // Flood the component, recording its cell bounds and its tallest column.
    let x0 = w,
      x1 = -1,
      z0 = d,
      z1 = -1,
      hiTop = -Infinity;
    blocks[seed] = 0;
    stack.push(seed);
    while (stack.length > 0) {
      const i = stack.pop()!;
      const cx = i % w;
      const cz = (i - cx) / w;
      if (cx < x0) {
        x0 = cx;
      }
      if (cx > x1) {
        x1 = cx;
      }
      if (cz < z0) {
        z0 = cz;
      }
      if (cz > z1) {
        z1 = cz;
      }
      if (top[i] > hiTop) {
        hiTop = top[i];
      }
      for (let oz = -1; oz <= 1; oz++) {
        const nz = cz + oz;
        if (nz < 0 || nz >= d) {
          continue;
        }
        for (let ox = -1; ox <= 1; ox++) {
          const nx = cx + ox;
          if (nx < 0 || nx >= w) {
            continue;
          }
          const n = nx + nz * w;
          if (blocks[n] === 0) {
            continue;
          }
          blocks[n] = 0;
          stack.push(n);
        }
      }
    }
    // Cell range -> the same frame the baked vertices landed in: subtract the
    // origin `build` re-based on, then apply the bake scale.
    boxes.push({
      cx: ((x0 + b.minX + (x1 + b.minX + 1)) / 2) * scale - b.ox * scale,
      cz: ((z0 + b.minZ + (z1 + b.minZ + 1)) / 2) * scale - b.oz * scale,
      hx: ((x1 - x0 + 1) / 2) * scale,
      hz: ((z1 - z0 + 1) / 2) * scale,
      top: hiTop,
    });
  }
  return boxes;
}

/**
 * Fit one cylinder to a roof, lying along its ridge. Everything is measured off
 * the bracketed cells; the builder supplied no number but the bracket.
 *
 * Four of the six come straight out of the cells:
 *
 *   - the RIDGE LINE is the crest — the columns standing within one voxel of the
 *     roof's highest. Its longer side is the axis, which is what tells a hut's
 *     gable (a crest 19 cells long across one cell of width) from a ridge tent's
 *     (one cell wide and the length of the tent). Taking the longer side of the
 *     ROOF instead would be a coin toss on the hut, whose thatch is 19 by 17.
 *   - `hl` and `r` are half the roof's extent along that axis and across it, so
 *     the cylinder ends at the gables and reaches eaves to eaves.
 *
 * The remaining two, the axis height and the vertical semi-axis, are FITTED
 * rather than read, and that is the one part of this worth arguing about. The
 * obvious choice — hang the arc through the crest and the eaves — is the worst
 * one available: `sqrt(1 - u^2)` is flat where a gable is steepest, so an arc
 * through both ends of a straight-sided roof balloons over the middle of the
 * slope, and on a ridge tent that measured 1.21 units of collider floating over
 * the canvas. The same complaint as the slab it replaced, in a nicer shape.
 *
 * So the pair is chosen to MINIMISE THE WORST DEVIATION from the roof's own
 * measured cross-section instead, over a grid fine enough that the answer is
 * stable to a hundredth. The arc sits a little under the crest and a little over
 * the slope and the error is shared out rather than piled in the middle:
 *
 *                        through the eaves    minimax
 *     hut, thatch gable               0.945      0.394
 *     ridge tent, canvas              1.205      0.577
 *
 * `__dbgRidges()` reports it per stamped roof, which is the point of carrying it
 * on `SolidRidge` rather than throwing it away: a cylinder is not a prism, and
 * the number says how much that costs on a roof nobody has built yet. If it ever
 * has to be zero the answer is a wedge primitive, not a finer search — a
 * straight-sided roof is a shape no circle can be.
 */
export function measureRidge(
  model: VoxelModel,
  scale: number,
  roof: VoxelRegion,
): SolidRidge | null {
  if (roof.size === 0) {
    return null;
  }
  const b = model.bounds(true);
  const w = b.maxX - b.minX + 1;
  const d = b.maxZ - b.minZ + 1;
  /** Top of the roof over each of its columns, in units above the model base. */
  const top = new Float32Array(w * d).fill(-Infinity);
  let x0 = w,
    x1 = -1,
    z0 = d,
    z1 = -1,
    crest = -Infinity,
    eaveY = Infinity;
  model.forEachCell((x, y, z) => {
    if (!roof.has(x, y, z)) {
      return;
    }
    const cx = x - b.minX;
    const cz = z - b.minZ;
    const i = cx + cz * w;
    const hi = (y - b.oy) * scale + scale;
    if (hi > top[i]) {
      top[i] = hi;
    }
    if (hi > crest) {
      crest = hi;
    }
    const lo = hi - scale;
    if (lo < eaveY) {
      eaveY = lo;
    }
    if (cx < x0) {
      x0 = cx;
    }
    if (cx > x1) {
      x1 = cx;
    }
    if (cz < z0) {
      z0 = cz;
    }
    if (cz > z1) {
      z1 = cz;
    }
  });
  if (x1 < x0) {
    return null;
  }

  // The crest, and which way it runs.
  let cx0 = w,
    cx1 = -1,
    cz0 = d,
    cz1 = -1;
  for (let i = 0; i < top.length; i++) {
    if (top[i] < crest - scale * 1.5) {
      continue;
    }
    const cx = i % w;
    const cz = (i - cx) / w;
    if (cx < cx0) {
      cx0 = cx;
    }
    if (cx > cx1) {
      cx1 = cx;
    }
    if (cz < cz0) {
      cz0 = cz;
    }
    if (cz > cz1) {
      cz1 = cz;
    }
  }
  const alongX = cx1 - cx0 >= cz1 - cz0;
  const along0 = alongX ? x0 : z0;
  const along1 = alongX ? x1 : z1;
  const across0 = alongX ? z0 : x0;
  const across1 = alongX ? z1 : x1;

  // The cross-section: the roof's height at each step ACROSS the ridge, which is
  // the profile the cylinder has to be. Taking the max over the run means a
  // gable end, where the thatch is one course lower, cannot drag the fit down.
  const n = across1 - across0 + 1;
  const prof = new Float32Array(n).fill(-Infinity);
  for (let i = 0; i < top.length; i++) {
    if (top[i] === -Infinity) {
      continue;
    }
    const cx = i % w;
    const cz = (i - cx) / w;
    const k = (alongX ? cz : cx) - across0;
    if (top[i] > prof[k]) {
      prof[k] = top[i];
    }
  }
  const r = (n / 2) * scale;
  /** Offset of each profile step from the middle of the span, in units. */
  const perp = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    perp[k] = (k + 0.5 - n / 2) * scale;
  }

  // Minimax fit over (axis height, vertical semi-axis). 64 x 64 on ranges that
  // comfortably contain any sane answer puts the grid step under a hundredth of
  // a unit on a hut, which is finer than the deviation it is minimising.
  const span = crest - eaveY;
  let bestY = eaveY,
    bestRy = span,
    bestErr = Infinity;
  for (let a = 0; a <= 64; a++) {
    const y = eaveY - span + (a / 64) * 2 * span;
    for (let c = 1; c <= 64; c++) {
      const ry = (c / 64) * 2 * span;
      let err = 0;
      for (let k = 0; k < n; k++) {
        if (prof[k] === -Infinity) {
          continue;
        }
        const u = perp[k] / r;
        const h = y + ry * Math.sqrt(Math.max(0, 1 - u * u));
        const e = Math.abs(h - prof[k]);
        if (e > err) {
          err = e;
        }
      }
      if (err < bestErr) {
        bestErr = err;
        bestY = y;
        bestRy = ry;
      }
    }
  }

  // Cell ranges -> the frame the baked vertices landed in, exactly as the boxes
  // above do it.
  const midX = ((x0 + b.minX + (x1 + b.minX + 1)) / 2) * scale - b.ox * scale;
  const midZ = ((z0 + b.minZ + (z1 + b.minZ + 1)) / 2) * scale - b.oz * scale;
  return {
    cx: midX,
    cz: midZ,
    // Bearing 0 runs along +z, matching every other yaw in the game.
    axis: alongX ? Math.PI / 2 : 0,
    hl: ((along1 - along0 + 1) / 2) * scale,
    r,
    y: bestY,
    ry: bestRy,
    fitError: bestErr,
  };
}

// ---------------------------------------------------------------------------
// The world-space field
// ---------------------------------------------------------------------------

/**
 * Spatial grid cell, world units.
 *
 * The same 8 `RoadNetwork` uses, and for the same reason: a settlement's pieces
 * are one to five units across, so a cell holds a handful of them and the scan
 * is over that handful rather than over the world.
 *
 * MEASURED, because a couple of hundred colliders is few enough that a linear
 * scan is not obviously wrong (`__dbgBenchStructures`, 200k calls, seed 1337,
 * hardware-accelerated Brave):
 *
 *                                      boxes only   with roofs
 *     in the middle of the Encampment    30.5 ns      47.0 ns
 *     open country, 900 units out         7.5 ns       8.5 ns
 *
 * The wilderness figure is the bounds test and nothing else, and it is what
 * almost every call in a session costs — seven roof cylinders in the world are
 * worth one nanosecond of it, and see `topAt` for the one arrangement of the
 * same code that made it 15. The camp figure is a bucket of five-ish boxes plus
 * a second bucket lookup for the roofs over them; scanning everything instead
 * would be roughly forty times that inner loop. Everything that moves asks this
 * two or three times per axis per simulation slice — the hero, the saddle, two
 * beasts, ten wild spawns, call it 30 queries — so the grid costs ~1.4 us of a
 * 7.8 ms frame in the one place in the world where it costs anything, where the
 * flat scan would cost ~50 us. Neither would have dropped a frame today; the
 * grid is fifteen lines and does not stop being true when a fourth town lands.
 */
const CELL = 8;
/** Numbers per box in `data`. See `add`. */
const STRIDE = 7;
/** Numbers per roof cylinder in `rdata`. See `add`. */
const RSTRIDE = 9;

const cellKey = (cx: number, cz: number): number => cx * 4194304 + cz;

/**
 * Every solid a settlement stamped, in world space, behind one query.
 *
 * Built once at world creation alongside the town meshes and then never
 * touched: towns are not streamed (see towns.ts), so neither is this.
 *
 * `topAt` runs from the player's per-frame update and from every beast and enemy
 * that moves, so it allocates nothing, chases no objects and does no trig — the
 * yaw is stored as its cosine and sine at stamp time.
 *
 * The two primitives are held in two SEPARATE indexed sets rather than one
 * tagged set, and the reason is the shape of the common call. Almost every query
 * in a session is made somewhere that is not a town, and answering it is a
 * bounds test that fails; a merged array would put a branch on every entry of
 * the one loop that has to stay tight, to serve about forty roofs in the whole
 * world. Two sets cost the wilderness case a second failed bounds test and cost
 * a settlement nothing it would not have paid anyway, and models with no roof at
 * all — every NPC, every crate — skip the second set on a count of zero.
 */
export class StructureField implements SiteClearance {
  /** [cx, cz, hx, hz, cos yaw, sin yaw, top] per box. */
  private data: number[] = [];
  private box = new Float32Array(0);
  private grid = new Map<number, Int32Array>();
  /** [cx, cz, sin axis, cos axis, hl, r, y, ry, fit] per roof. See `SolidRidge`. */
  private rdata: number[] = [];
  private roof = new Float32Array(0);
  private rgrid = new Map<number, Int32Array>();
  /** World bounds of EVERYTHING stamped, boxes and roofs together. */
  private minX = Infinity;
  private maxX = -Infinity;
  private minZ = Infinity;
  private maxZ = -Infinity;
  private built = false;

  get count(): number {
    return this.box.length / STRIDE;
  }
  /** How many of the stamps are roof cylinders rather than boxes. */
  get roofCount(): number {
    return this.roof.length / RSTRIDE;
  }

  /**
   * Stamp a template's footprint at the same place, yaw and scale its mesh was
   * stamped at. Templates with no footprint are silently nothing to do.
   *
   * `s` is girth and `sy` height, exactly as `Accum.add` applies them, so the
   * box describes the INSTANCE rather than the template — the log seats round
   * the camp fire are the woodpile at 0.55 girth and 0.4 height, and their
   * colliders are that shape too. A roof cylinder takes the same two factors on
   * its two semi-axes, which is the whole reason it is an ellipse.
   *
   * The argument is "anything carrying a footprint" rather than a `Template`,
   * because a `Template` is a stampable MESH and not everything solid is one:
   * an NPC (world/npc.ts) is an animated rig whose body was measured with
   * `measureFootprint` like everything else here, but whose vertices never go
   * through an `Accum`. Every `Template` still satisfies it, so no caller moved.
   *
   * A `trunk` counts as a footprint too — see `boleBox`. That is what makes a
   * tree stamped into a settlement block like everything else stamped into one,
   * which before it was written the sky island's wood did not (issue #80).
   */
  add(
    t: {
      solid?: readonly SolidBox[];
      ridge?: readonly SolidRidge[];
      trunk?: { r: number; top: number };
    },
    x: number,
    y: number,
    z: number,
    yaw: number,
    s: number,
    sy: number,
    /** Length scale along the template's own +z. See `Accum.add`. */
    sz: number = s,
  ): void {
    if (!t.solid && !t.ridge && !t.trunk) {
      return;
    }
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    if (t.trunk) {
      const b = boleBox(t.trunk);
      this.data.push(x, z, b.hx * s, b.hz * s, c, sn, y + b.top * sy);
    }
    for (const f of t.solid ?? []) {
      // `Accum.add` maps local (px, pz) to (px*c + pz*sn, -px*sn + pz*c).
      const lx = f.cx * s;
      const lz = f.cz * sz;
      this.data.push(
        x + lx * c + lz * sn,
        z - lx * sn + lz * c,
        f.hx * s,
        f.hz * sz,
        c,
        sn,
        y + f.top * sy,
      );
    }
    for (const f of t.ridge ?? []) {
      const lx = f.cx * s;
      const lz = f.cz * s;
      // The same mapping applied to a DIRECTION: a local bearing `a` comes out
      // as `a + yaw`, because (sin a, cos a) maps to (sin(a+yaw), cos(a+yaw)).
      const a = f.axis + yaw;
      this.rdata.push(
        x + lx * c + lz * sn,
        z - lx * sn + lz * c,
        Math.sin(a),
        Math.cos(a),
        f.hl * s,
        f.r * s,
        y + f.y * sy,
        f.ry * sy,
        f.fitError * sy,
      );
    }
    this.built = false;
  }

  /** Empty every stamp so a field can be re-stamped — an NPC crew whose stations
   *  change (an escort re-stationing, issue #234) adds everyone again and rebuilds. */
  reset(): void {
    this.data.length = 0;
    this.rdata.length = 0;
    this.built = false;
  }

  /** Freeze the stamps and index them. Call once, after the last `add`. */
  build(): void {
    if (this.built) {
      return;
    }
    this.built = true;
    this.box = new Float32Array(this.data);
    this.roof = new Float32Array(this.rdata);
    this.grid.clear();
    this.rgrid.clear();
    this.minX = this.minZ = Infinity;
    this.maxX = this.maxZ = -Infinity;
    const lists = new Map<number, number[]>();
    const n = this.box.length / STRIDE;
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      // World AABB of the rotated rectangle.
      const ex =
        Math.abs(this.box[o + 2] * this.box[o + 4]) + Math.abs(this.box[o + 3] * this.box[o + 5]);
      const ez =
        Math.abs(this.box[o + 2] * this.box[o + 5]) + Math.abs(this.box[o + 3] * this.box[o + 4]);
      const x0 = this.box[o] - ex;
      const x1 = this.box[o] + ex;
      const z0 = this.box[o + 1] - ez;
      const z1 = this.box[o + 1] + ez;
      if (x0 < this.minX) {
        this.minX = x0;
      }
      if (x1 > this.maxX) {
        this.maxX = x1;
      }
      if (z0 < this.minZ) {
        this.minZ = z0;
      }
      if (z1 > this.maxZ) {
        this.maxZ = z1;
      }
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
        for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
          const key = cellKey(cx, cz);
          let l = lists.get(key);
          if (l === undefined) {
            l = [];
            lists.set(key, l);
          }
          l.push(i);
        }
      }
    }
    for (const [key, l] of lists) {
      this.grid.set(key, Int32Array.from(l));
    }

    // The roofs, into their own buckets. A cylinder's world AABB is the same sum
    // of projected half-extents a rotated rectangle's is, with the length along
    // the axis and the span across it standing in for the two sides.
    const rlists = new Map<number, number[]>();
    const rn = this.roof.length / RSTRIDE;
    for (let i = 0; i < rn; i++) {
      const o = i * RSTRIDE;
      const ex =
        Math.abs(this.roof[o + 4] * this.roof[o + 2]) +
        Math.abs(this.roof[o + 5] * this.roof[o + 3]);
      const ez =
        Math.abs(this.roof[o + 4] * this.roof[o + 3]) +
        Math.abs(this.roof[o + 5] * this.roof[o + 2]);
      const x0 = this.roof[o] - ex;
      const x1 = this.roof[o] + ex;
      const z0 = this.roof[o + 1] - ez;
      const z1 = this.roof[o + 1] + ez;
      if (x0 < this.minX) {
        this.minX = x0;
      }
      if (x1 > this.maxX) {
        this.maxX = x1;
      }
      if (z0 < this.minZ) {
        this.minZ = z0;
      }
      if (z1 > this.maxZ) {
        this.maxZ = z1;
      }
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
        for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
          const key = cellKey(cx, cz);
          let l = rlists.get(key);
          if (l === undefined) {
            l = [];
            rlists.set(key, l);
          }
          l.push(i);
        }
      }
    }
    for (const [key, l] of rlists) {
      this.rgrid.set(key, Int32Array.from(l));
    }
  }

  /**
   * Top of the tallest structure covering this column, or -Infinity.
   *
   * A bounds test and one failed `Map.get` answer the common case — almost
   * everywhere in the world is not a town — and inside a settlement the scan is
   * over one cell's handful of boxes, and then over its roofs.
   */
  topAt(x: number, z: number): number {
    // NOTHING BUT THE BOUNDS TEST LIVES HERE, and that is a measurement rather
    // than a style. Almost every call in a session is made somewhere that is not
    // a town, so the miss path is the hot one; written as one function with the
    // scans inline it grew past whatever V8 will inline and the MISS went
    // 7.5 -> 15 ns, for work it never executes. Four compares and a call it
    // hardly ever makes puts it back at 7.5.
    if (x < this.minX || x > this.maxX || z < this.minZ || z > this.maxZ) {
      return -Infinity;
    }
    return this.scan(x, z);
  }

  /** The part of `topAt` that only runs inside a settlement. */
  private scan(x: number, z: number): number {
    const key = cellKey(Math.floor(x / CELL), Math.floor(z / CELL));
    let best = -Infinity;
    const bucket = this.grid.get(key);
    if (bucket !== undefined) {
      const b = this.box;
      for (let k = 0; k < bucket.length; k++) {
        const o = bucket[k] * STRIDE;
        // Cheapest rejection first: a top already beaten cannot win, and inside
        // a camp most of a bucket is shorter than whatever is nearest.
        if (b[o + 6] <= best) {
          continue;
        }
        const dx = x - b[o];
        const dz = z - b[o + 1];
        const c = b[o + 4];
        const sn = b[o + 5];
        // Inverse of the stamp's rotation; see `add`.
        const lx = dx * c - dz * sn;
        if (lx < -b[o + 2] || lx > b[o + 2]) {
          continue;
        }
        const lz = dx * sn + dz * c;
        if (lz < -b[o + 3] || lz > b[o + 3]) {
          continue;
        }
        best = b[o + 6];
      }
    }
    if (this.roof.length === 0) {
      return best;
    }
    const rbucket = this.rgrid.get(key);
    return rbucket === undefined ? best : this.roofTop(rbucket, x, z, best);
  }

  /**
   * The roof half of `scan`, out of line for the same reason `scan` itself is:
   * the box loop above is what almost every call inside a camp needs, and forty
   * roofs in the whole world do not get to make it bigger.
   */
  private roofTop(bucket: Int32Array, x: number, z: number, from: number): number {
    let best = from;
    const r = this.roof;
    for (let k = 0; k < bucket.length; k++) {
      const o = bucket[k] * RSTRIDE;
      // A crest already beaten cannot win, and the arc is only ever below it.
      if (r[o + 6] + r[o + 7] <= best) {
        continue;
      }
      const dx = x - r[o];
      const dz = z - r[o + 1];
      const sa = r[o + 2];
      const ca = r[o + 3];
      // Along the ridge first: it is the cheap half and a roof is long.
      const along = dx * sa + dz * ca;
      if (along < -r[o + 4] || along > r[o + 4]) {
        continue;
      }
      const u = (dx * ca - dz * sa) / r[o + 5];
      if (u <= -1 || u >= 1) {
        continue;
      }
      const h = r[o + 6] + r[o + 7] * Math.sqrt(1 - u * u);
      if (h > best) {
        best = h;
      }
    }
    return best;
  }

  /** Is anything at all stamped inside this rectangle? See `SiteClearance`. */
  anyIn(x0: number, z0: number, x1: number, z1: number): boolean {
    return x1 >= this.minX && x0 <= this.maxX && z1 >= this.minZ && z0 <= this.maxZ;
  }

  /**
   * Does built material intersect this upright cylinder? See `SiteClearance`.
   *
   * The bounds test first and alone, for the reason `topAt` states at length:
   * the miss is the hot path and it must stay four compares and a return.
   *
   * The cylinder is the PROP's extent, so what this reports is "the thing you
   * are about to stamp would be inside a wall" and not "the thing you are about
   * to stamp is near a town". That distinction is the whole of issue #131: a
   * tussock may grow against a palisade and around a fence post, and only the
   * one that would pass through the timber is refused.
   */
  hits(x: number, z: number, r: number, y0: number, _y1: number): boolean {
    if (x + r < this.minX || x - r > this.maxX || z + r < this.minZ || z - r > this.maxZ) {
      return false;
    }
    const roofs = this.roof.length > 0;
    const r2 = r * r;
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
      for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
        const key = cellKey(cx, cz);
        const bucket = this.grid.get(key);
        if (bucket !== undefined && this.boxHit(bucket, x, z, r2, y0)) {
          return true;
        }
        if (!roofs) {
          continue;
        }
        const rbucket = this.rgrid.get(key);
        if (rbucket !== undefined && this.roofHit(rbucket, x, z, r2, y0)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * The box half of `hits`: nearest point of each rectangle to the cylinder's
   * axis, in the rectangle's own frame, against the radius.
   *
   * `top <= y0` is the one vertical test a box needs, and it is exact rather
   * than conservative: `measureFootprint` builds these from the model's base
   * upward, so a box is material from the ground to its top and a prop rooted
   * above that top cannot be inside it. It is also what lets a sprig sit on a
   * flagstone rather than be culled by it.
   */
  private boxHit(bucket: Int32Array, x: number, z: number, r2: number, y0: number): boolean {
    const b = this.box;
    for (let k = 0; k < bucket.length; k++) {
      const o = bucket[k] * STRIDE;
      if (b[o + 6] <= y0) {
        continue;
      }
      const dx = x - b[o];
      const dz = z - b[o + 1];
      const c = b[o + 4];
      const sn = b[o + 5];
      // Inverse of the stamp's rotation; see `add`. Then the classic
      // rectangle-to-point distance: fold to one quadrant, subtract the extent,
      // clamp the negatives away, and what is left is the gap.
      let lx = Math.abs(dx * c - dz * sn) - b[o + 2];
      let lz = Math.abs(dx * sn + dz * c) - b[o + 3];
      if (lx < 0) {
        lx = 0;
      }
      if (lz < 0) {
        lz = 0;
      }
      // `<=`, NOT `<`, and it is load-bearing at one radius: a point INSIDE the
      // rectangle clamps to a gap of exactly zero, so a strict compare answers
      // "no" to `r = 0` — the query a probe makes about a single drawn vertex.
      if (lx * lx + lz * lz <= r2) {
        return true;
      }
    }
    return false;
  }

  /**
   * The roof half of `hits`, and the one place here that is deliberately
   * COARSER than the shape it stands for.
   *
   * A ridge is treated as filled from the ground to its crest over its whole
   * footprint — the same reading `topAt` gives it, a height field — rather than
   * as the shell of a cylinder. Under a ridge TENT, whose canvas comes down to
   * the ground, that is exact. Under a hut's thatch it culls the band of grass
   * beneath the EAVE, which overhangs by a few tenths of a unit and stands over
   * a wall box that has already refused everything there. So the coarse reading
   * costs a strip that was empty anyway, and buys not having to decide whether
   * a blade under an overhang counts as inside the roof.
   */
  private roofHit(bucket: Int32Array, x: number, z: number, r2: number, y0: number): boolean {
    const r = this.roof;
    for (let k = 0; k < bucket.length; k++) {
      const o = bucket[k] * RSTRIDE;
      if (r[o + 6] + r[o + 7] <= y0) {
        continue;
      }
      const dx = x - r[o];
      const dz = z - r[o + 1];
      const sa = r[o + 2];
      const ca = r[o + 3];
      let along = Math.abs(dx * sa + dz * ca) - r[o + 4];
      let across = Math.abs(dx * ca - dz * sa) - r[o + 5];
      if (along < 0) {
        along = 0;
      }
      if (across < 0) {
        across = 0;
      }
      // `<=` for the reason `boxHit` gives: inside is a gap of zero.
      if (along * along + across * across <= r2) {
        return true;
      }
    }
    return false;
  }

  /** Append every box as [cx, cz, hx, hz, yaw, top]. See World.debugStructures. */
  debugBoxes(out: number[]): void {
    const b = this.box;
    for (let o = 0; o < b.length; o += STRIDE) {
      out.push(b[o], b[o + 1], b[o + 2], b[o + 3], Math.atan2(b[o + 5], b[o + 4]), b[o + 6]);
    }
  }

  /**
   * Append every roof as [cx, cz, axis yaw, hl, r, y, ry, fit]. See
   * World.debugRidges, and `debugBoxes` above for why it is a second list with
   * its own stride rather than a widening of the first.
   */
  debugRidges(out: number[]): void {
    const r = this.roof;
    for (let o = 0; o < r.length; o += RSTRIDE) {
      out.push(
        r[o],
        r[o + 1],
        Math.atan2(r[o + 2], r[o + 3]),
        r[o + 4],
        r[o + 5],
        r[o + 6],
        r[o + 7],
        r[o + 8],
      );
    }
  }
}

/**
 * Several fields as one clearance query.
 *
 * The same "THREE FIELDS, one query" arrangement `World.structureTopAt` makes
 * (world/index.ts): a `StructureField` is frozen by its owner at the end of its
 * own constructor, so the settlement, the skill dens and anything else built
 * before the first chunk streams each keep their own and the union is taken
 * here. Absent owners are dropped at construction, so `towns=0` costs the
 * placer a shorter loop rather than a null test per stamp.
 */
export class SiteFields implements SiteClearance {
  private readonly fields: readonly SiteClearance[];

  constructor(fields: readonly (SiteClearance | null | undefined)[]) {
    this.fields = fields.filter((f): f is SiteClearance => f !== null && f !== undefined);
  }

  anyIn(x0: number, z0: number, x1: number, z1: number): boolean {
    for (const f of this.fields) {
      if (f.anyIn(x0, z0, x1, z1)) {
        return true;
      }
    }
    return false;
  }

  hits(x: number, z: number, r: number, y0: number, y1: number): boolean {
    for (const f of this.fields) {
      if (f.hits(x, z, r, y0, y1)) {
        return true;
      }
    }
    return false;
  }
}

/**
 * One call stamps a part into the merged mesh AND into the collision field.
 *
 * This is the structural half of "one source of truth". The town layout code
 * never sees the `Accum` or the `StructureField` separately, so there is no
 * call site at which a building can be drawn without also being made solid —
 * which is the failure mode a hand-maintained collider list has, and the shape
 * of the last four bugs this project shipped.
 *
 * The tint arguments `Accum.add` takes are gone because no town stamp uses
 * them: every piece here is painted by its builder and stamped neutral.
 */
export class SolidStamp {
  readonly acc = new Accum();

  constructor(private field: StructureField) {}

  add(
    t: Template,
    x: number,
    y: number,
    z: number,
    yaw: number,
    s = 1,
    sy: number = s,
    sz: number = s,
  ): void {
    this.acc.add(t, x, y, z, yaw, s, 1, 1, 1, sy, sz);
    this.field.add(t, x, y, z, yaw, s, sy, sz);
  }
}
