/**
 * STRUCTURE COLLISION — what a settlement stops you walking through.
 *
 * Until this file existed, a town was scenery: the hero walked through huts,
 * palisades, crates and the well, and only terrain and tree trunks were solid.
 * Three things had to be true of the fix, and they are what shaped everything
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
 * The query is `World.structureTopAt`, deliberately the same shape as
 * `getHeight` and `trunkSolidTopAt`: every mover in the game already compares a
 * column's top against its feet plus MAX_STEP_UP, so a settlement becomes solid
 * by answering that question rather than by anyone growing a second kind of
 * collision. A low crate is walkable-onto and a chest-high one is a wall, by the
 * same rule that decides whether a terrace is a step or a cliff.
 */
import { MAX_STEP_UP } from '../core/types';
import type { VoxelModel } from '../core/voxel';
import { Accum, bakeProp, type SolidBox, type Template } from './props';

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
 */
export function bakeSolid(model: VoxelModel, scale: number): Template {
  const t = bakeProp(model, scale);
  const solid = measureFootprint(model, scale);
  if (solid.length > 0) t.solid = solid;
  return t;
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
 * wall reaches. So a hut's box tops out at the thatch ridge and blocks like a
 * building, while the columns under the gate's lintel are in no box at all.
 *
 * Runs once per template at boot, so it may allocate freely.
 */
export function measureFootprint(model: VoxelModel, scale: number): SolidBox[] {
  const b = model.bounds(true);
  if (!Number.isFinite(b.minX)) return [];
  const w = b.maxX - b.minX + 1;
  const d = b.maxZ - b.minZ + 1;
  /** Tallest voxel top in each column, in units above the model's base. */
  const top = new Float32Array(w * d).fill(-Infinity);
  /** 1 where the column holds material in the body band. */
  const blocks = new Uint8Array(w * d);

  model.forEachCell((x, y, z) => {
    const i = (x - b.minX) + (z - b.minZ) * w;
    // The voxel's own faces, in units above the base: `build` puts y = 0 at the
    // lowest cell and a cell spans one `scale` upward from its own index.
    const lo = (y - b.oy) * scale;
    const hi = lo + scale;
    if (hi > top[i]) top[i] = hi;
    if (hi > MAX_STEP_UP && lo < WALK_UNDER) blocks[i] = 1;
  });

  const boxes: SolidBox[] = [];
  const stack: number[] = [];
  for (let seed = 0; seed < blocks.length; seed++) {
    if (blocks[seed] === 0) continue;
    // Flood the component, recording its cell bounds and its tallest column.
    let x0 = w, x1 = -1, z0 = d, z1 = -1, hiTop = -Infinity;
    blocks[seed] = 0;
    stack.push(seed);
    while (stack.length > 0) {
      const i = stack.pop()!;
      const cx = i % w;
      const cz = (i - cx) / w;
      if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
      if (cz < z0) z0 = cz; if (cz > z1) z1 = cz;
      if (top[i] > hiTop) hiTop = top[i];
      for (let oz = -1; oz <= 1; oz++) {
        const nz = cz + oz;
        if (nz < 0 || nz >= d) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const nx = cx + ox;
          if (nx < 0 || nx >= w) continue;
          const n = nx + nz * w;
          if (blocks[n] === 0) continue;
          blocks[n] = 0;
          stack.push(n);
        }
      }
    }
    // Cell range -> the same frame the baked vertices landed in: subtract the
    // origin `build` re-based on, then apply the bake scale.
    boxes.push({
      cx: ((x0 + b.minX) + (x1 + b.minX + 1)) / 2 * scale - b.ox * scale,
      cz: ((z0 + b.minZ) + (z1 + b.minZ + 1)) / 2 * scale - b.oz * scale,
      hx: (x1 - x0 + 1) / 2 * scale,
      hz: (z1 - z0 + 1) / 2 * scale,
      top: hiTop,
    });
  }
  return boxes;
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
 * MEASURED, because the whole world is only 199 boxes and a linear scan over
 * that is not obviously wrong (`__dbgBenchStructures`, 200k calls, seed 1337,
 * hardware-accelerated Brave):
 *
 *     in the middle of the Encampment   40.5 ns/call
 *     open country, 900 units out        6.5 ns/call
 *
 * The wilderness figure is the bounds test plus one failed `Map.get`, and it is
 * what almost every call in a session costs. The camp figure is a bucket of
 * five-ish boxes; scanning all 199 instead would be roughly forty times that
 * inner loop. Everything that moves asks this two or three times per axis per
 * simulation slice — the hero, the saddle, two pals, ten wild spawns, call it
 * 30 queries — so the grid costs ~1.2 us of a 7.8 ms frame where the flat scan
 * would cost ~50 us. Neither would have dropped a frame today; the grid is
 * fifteen lines and does not stop being true when a fourth town lands.
 */
const CELL = 8;
/** Numbers per box in `data`. See `add`. */
const STRIDE = 7;

const cellKey = (cx: number, cz: number): number => cx * 4194304 + cz;

/**
 * Every solid box a settlement stamped, in world space, behind one query.
 *
 * Built once at world creation alongside the town meshes and then never
 * touched: towns are not streamed (see towns.ts), so neither is this.
 *
 * `topAt` runs from the player's per-frame update and from every pal and enemy
 * that moves, so it allocates nothing, chases no objects and does no trig — the
 * yaw is stored as its cosine and sine at stamp time.
 */
export class StructureField {
  /** [cx, cz, hx, hz, cos yaw, sin yaw, top] per box. */
  private data: number[] = [];
  private box = new Float32Array(0);
  private grid = new Map<number, Int32Array>();
  private minX = Infinity;
  private maxX = -Infinity;
  private minZ = Infinity;
  private maxZ = -Infinity;
  private built = false;

  get count(): number { return this.box.length / STRIDE; }

  /**
   * Stamp a template's footprint at the same place, yaw and scale its mesh was
   * stamped at. Templates with no footprint are silently nothing to do.
   *
   * `s` is girth and `sy` height, exactly as `Accum.add` applies them, so the
   * box describes the INSTANCE rather than the template — the log seats round
   * the camp fire are the woodpile at 0.55 girth and 0.4 height, and their
   * colliders are that shape too.
   */
  add(
    t: Template, x: number, y: number, z: number,
    yaw: number, s: number, sy: number,
  ): void {
    if (!t.solid) return;
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    for (const f of t.solid) {
      // `Accum.add` maps local (px, pz) to (px*c + pz*sn, -px*sn + pz*c).
      const lx = f.cx * s;
      const lz = f.cz * s;
      this.data.push(
        x + lx * c + lz * sn,
        z - lx * sn + lz * c,
        f.hx * s, f.hz * s, c, sn,
        y + f.top * sy,
      );
    }
    this.built = false;
  }

  /** Freeze the stamps and index them. Call once, after the last `add`. */
  build(): void {
    if (this.built) return;
    this.built = true;
    this.box = new Float32Array(this.data);
    this.grid.clear();
    this.minX = this.minZ = Infinity;
    this.maxX = this.maxZ = -Infinity;
    const lists = new Map<number, number[]>();
    const n = this.box.length / STRIDE;
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      // World AABB of the rotated rectangle.
      const ex = Math.abs(this.box[o + 2] * this.box[o + 4])
        + Math.abs(this.box[o + 3] * this.box[o + 5]);
      const ez = Math.abs(this.box[o + 2] * this.box[o + 5])
        + Math.abs(this.box[o + 3] * this.box[o + 4]);
      const x0 = this.box[o] - ex;
      const x1 = this.box[o] + ex;
      const z0 = this.box[o + 1] - ez;
      const z1 = this.box[o + 1] + ez;
      if (x0 < this.minX) this.minX = x0;
      if (x1 > this.maxX) this.maxX = x1;
      if (z0 < this.minZ) this.minZ = z0;
      if (z1 > this.maxZ) this.maxZ = z1;
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
        for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
          const key = cellKey(cx, cz);
          let l = lists.get(key);
          if (l === undefined) { l = []; lists.set(key, l); }
          l.push(i);
        }
      }
    }
    for (const [key, l] of lists) this.grid.set(key, Int32Array.from(l));
  }

  /**
   * Top of the tallest structure covering this column, or -Infinity.
   *
   * A bounds test and one failed `Map.get` answer the common case — almost
   * everywhere in the world is not a town — and inside a settlement the scan is
   * over one cell's handful of boxes.
   */
  topAt(x: number, z: number): number {
    if (x < this.minX || x > this.maxX || z < this.minZ || z > this.maxZ) return -Infinity;
    const bucket = this.grid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (bucket === undefined) return -Infinity;
    const b = this.box;
    let best = -Infinity;
    for (let k = 0; k < bucket.length; k++) {
      const o = bucket[k] * STRIDE;
      // Cheapest rejection first: a top already beaten cannot win, and inside a
      // camp most of a bucket is shorter than whatever is nearest.
      if (b[o + 6] <= best) continue;
      const dx = x - b[o];
      const dz = z - b[o + 1];
      const c = b[o + 4];
      const sn = b[o + 5];
      // Inverse of the stamp's rotation; see `add`.
      const lx = dx * c - dz * sn;
      if (lx < -b[o + 2] || lx > b[o + 2]) continue;
      const lz = dx * sn + dz * c;
      if (lz < -b[o + 3] || lz > b[o + 3]) continue;
      best = b[o + 6];
    }
    return best;
  }

  /** Append every box as [cx, cz, hx, hz, yaw, top]. See World.debugStructures. */
  debugBoxes(out: number[]): void {
    const b = this.box;
    for (let o = 0; o < b.length; o += STRIDE) {
      out.push(b[o], b[o + 1], b[o + 2], b[o + 3], Math.atan2(b[o + 5], b[o + 4]), b[o + 6]);
    }
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
    t: Template, x: number, y: number, z: number,
    yaw: number, s = 1, sy: number = s,
  ): void {
    this.acc.add(t, x, y, z, yaw, s, 1, 1, 1, sy);
    this.field.add(t, x, y, z, yaw, s, sy);
  }
}
