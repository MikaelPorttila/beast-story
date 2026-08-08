/**
 * Vegetation & decoration props. Voxel templates are baked once, then
 * stamped (rotated/scaled/tinted) into two merged meshes per chunk:
 * a shadow-casting "solid" mesh (trees, rocks, cacti, mushrooms) and a
 * "soft" mesh (grass tufts, flowers) that only receives shadows.
 */
import * as THREE from 'three';
import { VoxelModel, shade } from '../core/voxel';
import { hashCell, mulberry32 } from './noise';
import { CHUNK_SIZE, Terrain, WATER_LEVEL, makeScratch, type ColumnScratch } from './terrain';
import { DECK_EDGE, type RoadClearance } from './roads';
import { SWAY_BOUND_PAD } from './sway';
import { nature, natureCount } from './nature';
import { flags } from '../core/flags';

/**
 * One box of a template's SOLID FOOTPRINT, in TEMPLATE units — i.e. already
 * multiplied by the bake scale, exactly like `Template.trunk`, so a stamp only
 * has to apply its own girth (`s`) and height (`sy`) factors on top.
 *
 * An axis-aligned rectangle in the template's OWN frame; the stamp's yaw turns
 * it into an oriented box in the world. A rectangle rather than a disc because
 * the things in a settlement are rectangles — a disc around a hut either lets
 * the player into the corners or stops him a metre short of the wall, and a hut
 * is the one shape a camp has thirty of.
 *
 * A template carries a LIST because one model is often several obstacles: the
 * gate is two posts and two doors with a road through the middle, and a smithy
 * is a building plus an anvil three voxels clear of its door. See
 * `measureFootprint` in world/structures.ts, which derives them.
 */
export interface SolidBox {
  /** Centre, relative to the template origin, on the template's own x/z. */
  cx: number;
  cz: number;
  /** Half-extents along the same axes. */
  hx: number;
  hz: number;
  /** Top face, above the template's base (y = 0). */
  top: number;
}

/**
 * A ROOF: one cylinder lying on its side along a ridge, in the same template
 * units as `SolidBox`.
 *
 * The second collision primitive, and the only one this game needs beyond a box.
 * A box is right for anything that meets the ground as a rectangle and stops
 * being interesting above your head — a wall, a crate, a palisade span. It is
 * wrong for the two shapes a settlement has most of, a thatched gable and a
 * canvas ridge tent, because their whole character is a SLOPE and a box can only
 * say "a slab at the ridge", which is issue #3: a cage floating a metre over the
 * thatch, and no way to be on a roof rather than above it.
 *
 * A cylinder laid along the ridge says the slope in six numbers instead of the
 * forty boxes a stepped decomposition of the same roof costs, and it says it
 * smoothly — the surface a body stands on is continuous rather than a staircase
 * of collider lids.
 *
 * ELLIPTIC rather than circular, which costs one number and buys two things: a
 * roof is nearly always wider than it is tall, and `Accum` scales girth (`s`) and
 * height (`sy`) independently, so a single radius could not survive a stamp that
 * squashes a tent.
 */
export interface SolidRidge {
  /** Centre of the axis, relative to the template origin, on its own x/z. */
  cx: number;
  cz: number;
  /** Bearing of the axis in the template's frame; 0 runs along +z. */
  axis: number;
  /** Half-length along the axis — the roof's run, gable to gable. */
  hl: number;
  /** Horizontal semi-axis: half the span across the ridge, eaves to eaves. */
  r: number;
  /** Height of the cylinder's axis above the template base (y = 0). */
  y: number;
  /** Vertical semi-axis, so the crest stands at `y + ry`. */
  ry: number;
  /**
   * Worst distance between this cylinder and the roof it was fitted to, in
   * template units — how far the collider floats over the thatch at its worst
   * point, or sinks into it.
   *
   * Carried rather than discarded because it is the one number that says whether
   * a cylinder was the right shape for a given roof, and the only honest way to
   * answer that is to keep measuring it. `__dbgRidges()` reports it and
   * `measureRidge` explains what is being traded.
   */
  fitError: number;
}

/**
 * A baked, stampable voxel model.
 *
 * Exported because the TOWNS are built out of exactly the same machinery — bake
 * a tent or a barrel once, stamp it forty times into one merged mesh on the
 * shared prop material — and forking a second copy of `bake`/`Accum` into
 * world/town-parts.ts would have been two implementations of the vertex layout,
 * the relight correction and the yaw stamp to keep in step. See `bakeProp`.
 */
export interface Template {
  pos: Float32Array;
  nrm: Float32Array;
  col: Float32Array;
  idx: ArrayLike<number>;
  /**
   * The tree inside this template, if it is one, in TEMPLATE units — i.e.
   * already multiplied by the bake scale, so a stamp only has to apply its own
   * girth (`s`) and height (`sy`) factors on top.
   *
   *   r         half-width of the trunk shaft, from the model origin. This is
   *             the SOLID part of a tree and the only part of it that is.
   *   top       height of the shaft's top face above the model's base (y = 0)
   *   crownR    horizontal reach of the foliage, from the same axis
   *   crownCy   centre height of the foliage dome
   *   crownRy   vertical semi-axis of that dome, so the climbable surface over
   *             the crown is `crownCy + crownRy * sqrt(1 - d^2/crownR^2)`: a
   *             rounded canopy you can stand on rather than a flat lid at the
   *             tree's apex, which would leave a player who mantled onto the
   *             RIM of a crown hovering metres above the leaves.
   *
   * Templates carrying this bake UNCENTRED (see `bake`), which puts the shaft
   * axis exactly on the model origin. That matters twice over: the stamp yaws
   * about the trunk instead of swinging it around the crown's bounding-box
   * centre, and the world position recorded in the chunk's trunk registry is
   * the line the player actually climbs.
   */
  trunk?: { r: number; top: number; crownR: number; crownCy: number; crownRy: number };
  /**
   * What this template BLOCKS, if anything. Absent means "scenery you walk
   * through", which is what every chunk prop except a tree still is.
   *
   * Attached by `bakeSolid` (world/structures.ts) at the moment the mesh is
   * baked, so a part cannot be resized without its collider moving with it, and
   * travels WITH the template into `SolidStamp.add` — the same call that pushes
   * the vertices pushes the box. That is the whole design: the builder that
   * knows the hut's footprint is the thing that reports it.
   */
  solid?: readonly SolidBox[];
  /**
   * The ROOFS on this template, if it has any — see `SolidRidge`.
   *
   * A list rather than one, because a building with two wings has two ridges and
   * the fit is per bracketed region either way. Absent for everything that is not
   * a roof, which is most of a camp: a crate has no slope to follow.
   */
  ridge?: readonly SolidRidge[];
  /**
   * Height of this template's tallest vertex, in template units, marking it as
   * something that BENDS — grass and reeds. Absent means rigid, which is what
   * every other prop in this file still is: a fern rosette and a bush are stiff
   * enough on screen that bending them reads as a bug rather than as wind.
   *
   * `Accum` divides each vertex's own y by it and stores the ratio as the
   * `bsSwayH` attribute — 0 at the root, 1 at the tip — which is the only thing
   * world/sway.ts's vertex shader needs to know about a blade. See `withSway`,
   * and note that it is MEASURED off the baked vertices rather than authored.
   */
  swayHeight?: number;
}

/**
 * Undo VoxelModel's baked fake-sun face shading, and give shaded faces a warm
 * skylight/bounce term instead.
 *
 * `VoxelModel.build` multiplies every face by a fixed table — top 1.0, +/-X 0.88,
 * +/-Z 0.80, bottom 0.62 — which is a BAKED sun. This scene has a real
 * directional sun plus a deliberately cool HemisphereLight (sky 0xb8daff over
 * ground 0x8fa4bd), so the baked term stacks on top of N.L and darkens exactly
 * the faces that were already worst off: a face the sun cannot reach receives
 * nothing but the cool fill, and then gets multiplied by 0.8 or 0.62 on top. That
 * is the whole of "props float and are unlit", "almost pure black-grey with no
 * colour" and "an unlit slate monolith" — a boulder's shaded flank had roughly a
 * fifth of the light its top had and no hue left in it.
 *
 * The terrain mesher solved the same problem for terraces by inverting its own
 * side-shade table (see SIDE_SHADE in chunk.ts), but a prop cannot do that: every
 * instance is randomly yawed, so a direction-dependent bake would rotate away
 * from the sun. What a prop CAN have is an isotropic correction — lift the
 * non-top faces close to neutral so the real lighting is the only thing shading
 * them, and warm them slightly, because the bounce light arriving at a shaded
 * face has come off sunlit ground and because a shaded face that keeps a hue
 * reads as shade while a neutral-blue one reads as a hole.
 *
 * Bottom faces keep the most darkening (0.86/0.62): they are genuinely the least
 * lit surface on any prop, they are rarely visible, and a fully-lifted underside
 * makes a boulder look like it is glowing from below.
 */
export function relight(nrm: Float32Array, col: Float32Array): void {
  for (let i = 0; i < nrm.length; i += 3) {
    const ny = nrm[i + 1];
    let lift: number;
    if (ny > 0.5) lift = 1;                    // top: already 1.0, leave alone
    else if (ny < -0.5) lift = 0.86 / 0.62;    // bottom
    else if (Math.abs(nrm[i]) > 0.5) lift = 0.96 / 0.88; // +/-X
    else lift = 0.96 / 0.80;                   // +/-Z
    // Warm bounce, strongest on the faces with the least sky above them.
    const warm = ny > 0.5 ? 0 : 0.055;
    col[i] *= lift * (1 + warm);
    col[i + 1] *= lift;
    col[i + 2] *= lift * (1 - warm);
  }
}

/**
 * Bake a voxel model to a stampable template.
 *
 * `trunkR`/`trunkTop` are in VOXELS and turn the result into a climbable tree:
 * passing them also flips `build` to its uncentred mode, so the model origin is
 * voxel (0, ·, 0) — the axis every `trunk()` shaft is painted around — rather
 * than the centre of a bounding box that an offset crown lobe can drag a voxel
 * or two off the trunk. `build` puts y = 0 at the lowest voxel either way, and
 * every tree here starts its trunk at y = 0, so `trunkTop` needs no y fixup.
 */
function bake(
  model: VoxelModel, scale: number, trunkR?: number, trunkTop?: number,
): Template {
  const mesh = model.build(scale, trunkR === undefined);
  const g = mesh.geometry;
  const t: Template = {
    pos: (g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array,
    nrm: (g.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array,
    col: (g.getAttribute('color') as THREE.BufferAttribute).array as Float32Array,
    idx: g.getIndex()!.array,
  };
  if (trunkR !== undefined && trunkTop !== undefined) {
    // The foliage envelope is MEASURED off the baked vertices rather than
    // authored per species: every builder here already states its crown as a
    // handful of overlapping clumps, and restating the union of them as a
    // bounding dome by hand is exactly the sort of duplicated constant that
    // goes stale the first time a clump moves.
    //
    // "Foliage" is anything further from the axis than the widest the bole ever
    // gets (its root flare, `r + 1` voxels) AND above the halfway point of the
    // shaft. Both halves are needed: the radial test alone lets `trunk`'s root
    // buttresses in — they stick out two voxels at y = 0 — and that pinned every
    // measured crown floor to the ground, which turned the dome below into one
    // spanning the whole tree instead of just its head.
    // The CORNER of the flared shaft, not its face: a square column of
    // half-width w reaches w * sqrt(2) at its corners, and without that factor
    // the trunk's own corner vertices land a hair outside the threshold and get
    // counted as the lowest foliage in the tree.
    const bole = (trunkR + 1) * scale * Math.SQRT2;
    const foliageFloor = trunkTop * scale * 0.5;
    let crownR = 0;
    let crownLo = Infinity;
    let crownHi = -Infinity;
    for (let i = 0; i < t.pos.length; i += 3) {
      const y = t.pos[i + 1];
      if (y <= foliageFloor) continue;
      const d = Math.hypot(t.pos[i], t.pos[i + 2]);
      if (d <= bole) continue;
      if (d > crownR) crownR = d;
      if (y < crownLo) crownLo = y;
      if (y > crownHi) crownHi = y;
    }
    if (crownLo === Infinity) { crownLo = trunkTop * scale; crownHi = crownLo; }

    // The BOLE radius is measured off the baked vertices too, for the same
    // reason the crown is — and because the authored `trunkR` is the wrong
    // number to collide with.
    //
    // `trunkR` is the half-width of a SQUARE column, i.e. the distance to a
    // face. A disc of that radius is INSCRIBED in the trunk, so all four corners
    // of the mesh stand outside the collider and the hero walks visibly into the
    // bark before anything stops him — which is exactly the mismatch that got
    // filed. The circumscribing radius is what a cylinder has to use, and for a
    // square that is a factor of sqrt(2) larger.
    //
    // Measured rather than multiplied, because the shaft is not a clean square:
    // trunk() tapers it from root to crown and some species carry buttresses, so
    // the real extent is whatever the vertices say. The band starts above the
    // root flare — the flare is a one-voxel skirt in the bottom couple of voxels,
    // and letting it set the radius for the whole column would fatten the
    // collider by half again and stop the hero a stride short of the tree.
    let boleR = 0;
    // How high the flare reaches, in voxels, plus a hair.
    //
    // This was a flat `2 * scale`, which is a one-voxel skirt plus one voxel of
    // slack — correct only while `trunk()`'s own `flareTo` is 1. `flareTo` is
    // `round(h * 0.1)`, so any shaft 15 voxels or taller flares over TWO voxels,
    // and voxel 1's top vertices then sit at exactly `2 * scale`: whether they
    // clear a strict `<` depends on whether the product is exactly representable.
    // It is for the dead snag (scale 0.50) and is not for the big oak (0.52), so
    // the snag's registered bark radius measured 2.12 units against a shaft
    // 1.41 wide — the hero would have stopped a metre and a half short of it —
    // while the oak beside it measured correctly. Deriving the band floor from
    // the same `round(h * 0.1)` rule, plus a whole voxel of slack and an epsilon,
    // removes the coincidence. Verified template by template: every radius except
    // the two snags is unchanged to the last digit.
    const flareTop = (Math.max(2, Math.round(trunkTop * 0.1) + 1) + 0.01) * scale;
    for (let i = 0; i < t.pos.length; i += 3) {
      const y = t.pos[i + 1];
      if (y < flareTop || y > foliageFloor) continue;
      const d = Math.hypot(t.pos[i], t.pos[i + 2]);
      if (d > boleR) boleR = d;
    }
    // Degenerate shaft (a palm's bare stalk can sit entirely inside the band
    // test): fall back to the authored half-width, corrected to the corner.
    if (boleR <= 0) boleR = trunkR * scale * Math.SQRT2;

    t.trunk = {
      r: boleR,
      top: trunkTop * scale,
      // 0.84 of the measured reach: the outermost voxels of a canopy are the
      // eroded, ragged ones (see Canopy.clump), so a disc drawn on the extreme
      // is mostly air. Pulling it in keeps the walkable surface over foliage
      // that is actually there.
      crownR: crownR * 0.84,
      crownCy: (crownHi + crownLo) / 2,
      crownRy: (crownHi - crownLo) / 2,
    };
  }
  relight(t.nrm, t.col);
  (mesh.material as THREE.Material).dispose();
  return t;
}

/**
 * Bake a voxel model with no tree in it — the town builder's entry point.
 *
 * A named re-export rather than exporting `bake` directly, because `bake`'s
 * optional trunk arguments also flip it into its uncentred mode and nothing
 * outside this file should have to know that. A building, a barrel and a
 * signpost all want the plain centred bake.
 */
export function bakeProp(model: VoxelModel, scale: number): Template {
  return bake(model, scale);
}

/**
 * Mark a template as something that bends in the wind and under a passing body.
 *
 * The height is MEASURED off the baked vertices, not authored, for the same
 * reason `bake` measures the foliage envelope rather than taking it as an
 * argument: every builder here already states its own size, and restating it as
 * a second constant is exactly the sort of duplicate that goes stale the first
 * time somebody tunes it. `grassTuft`'s bake scale alone has moved four times
 * (0.12 -> 0.09 -> 0.19 -> 0.175 -> 0.21, and the reasoning for each is in the
 * comment there); a hand-written 0.63 beside it would already be wrong.
 *
 * `bake` puts y = 0 at the lowest voxel and `grassBillboard` emits its roots at
 * y = 0, so a vertex's own y IS its height above the root, and the ratio
 * survives the per-stamp height scale (`Accum.add`'s `sy`) because that scales
 * both terms.
 */
function withSway(t: Template): Template {
  let top = 0;
  for (let i = 1; i < t.pos.length; i += 3) if (t.pos[i] > top) top = t.pos[i];
  if (top > 0) t.swayHeight = top;
  return t;
}

/**
 * Vertex accumulator for a merged, multi-stamp mesh. See `add`.
 *
 * Exported for the town builder, which merges a whole encampment — palisade
 * spans, tents, carts, crates — into two meshes on the shared prop materials,
 * for the same reason a chunk merges its props into two: a camp built as forty
 * `THREE.Mesh`es would be forty draw calls and forty materials, and a new
 * material is a new shader program and a first-use stall.
 */
export class Accum {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  /**
   * Per-vertex blade height, 0..1, or null on an accumulator that will never
   * carry grass.
   *
   * Opt-in rather than always-on because it is a byte on every vertex and only
   * ONE of the merged meshes in this codebase needs it: the chunk's soft mesh,
   * which is the only user of `PropLib.softMat` and therefore the only mesh
   * world/sway.ts's shader runs on. The solid mesh and the town builder's four
   * accumulators emit onto other materials and pay nothing.
   */
  readonly sway: number[] | null;

  constructor(sway = false) {
    this.sway = sway ? [] : null;
  }

  /**
   * Stamp one template. `sy` scales height independently of `s` (girth), which
   * is the cheapest possible silhouette variety: a uniform scale just makes a
   * bigger copy of the same tree, while a squat-vs-lanky pair of the same
   * template read as two different trees at gameplay distance. Normals are NOT
   * rescaled — the anisotropy here stays inside about 0.8..1.25, where the
   * shading error is far below the per-voxel jitter and not worth a per-vertex
   * normalise on the chunk build path.
   *
   * `sz` scales the template's own +z, i.e. its LENGTH, independently of `s`,
   * which then only scales +x. Fence planks use it to span the exact gap between
   * two posts (world/fences.ts), and the Encampment palisade uses it to fit its
   * repeated templates end to end without overlapping coplanar outer faces
   * (world/towns.ts). Every other stamp remains uniform in x/z.
   */
  add(
    t: Template,
    x: number, y: number, z: number,
    yaw: number, s: number,
    tr: number, tg: number, tb: number,
    sy: number = s,
    sz: number = s,
  ): void {
    const base = this.pos.length / 3;
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const p = t.pos;
    const n = t.nrm;
    const cl = t.col;
    // Hoisted out of the loop: a rigid template on a sway-carrying accumulator
    // writes a column of zeroes, which is what keeps ferns, shells and driftwood
    // standing still for free.
    const sw = this.sway;
    const inv = t.swayHeight ? 1 / t.swayHeight : 0;
    for (let i = 0; i < p.length; i += 3) {
      const px = p[i] * s;
      const py = p[i + 1] * sy;
      const pz = p[i + 2] * sz;
      this.pos.push(x + px * c + pz * sn, y + py, z - px * sn + pz * c);
      const nx = n[i];
      const nz = n[i + 2];
      this.nrm.push(nx * c + nz * sn, n[i + 1], -nx * sn + nz * c);
      this.col.push(cl[i] * tr, cl[i + 1] * tg, cl[i + 2] * tb);
      if (sw) {
        const k = p[i + 1] * inv;
        sw.push(k >= 1 ? 255 : (k * 255) | 0);
      }
    }
    const ix = t.idx;
    for (let i = 0; i < ix.length; i++) this.idx.push(base + ix[i]);
  }

  toGeometry(): THREE.BufferGeometry | null {
    if (this.idx.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    if (this.sway) {
      // A NORMALISED BYTE, not a float. This is one more attribute on the
      // heaviest geometry in the world — about 30k vertices a chunk over 121
      // streamed chunks — so a float32 would be 15 MB of VRAM to express a
      // number that only ever needs to say "roughly how far up the blade", and
      // 1/255 of a blade is far below what a bend of a third of a unit can
      // show.
      geo.setAttribute('bsSwayH', new THREE.BufferAttribute(new Uint8Array(this.sway), 1, true));
      // The shader displaces vertices by up to SWAY_MAX_PUSH horizontally, and
      // the sphere computed above knows nothing about that. Grass at the rim of
      // a chunk would then be culled a frame before it left the screen, which
      // reads as a strip of meadow blinking at the edge of the view.
      if (geo.boundingSphere) geo.boundingSphere.radius += SWAY_BOUND_PAD;
    }
    return geo;
  }
}

// ---------------------------------------------------------------------------
// Foliage / trunk helpers
// ---------------------------------------------------------------------------

/**
 * Canopy painter that keeps a private copy of what it painted so a second pass
 * can re-shade the volume from top to bottom.
 *
 * VoxelModel is write-only, and that is the whole reason the trees read as flat
 * green blobs: an ellipsoid canopy has no light gradient anywhere in it, while
 * real foliage is bleached where the sky hits it and nearly black underneath.
 * `bake` adds that gradient, plus per-voxel leaf jitter, which together turn a
 * silhouette-only blob into something with a lit side and a shaded belly.
 */
class Canopy {
  private readonly cells = new Map<string, number>();
  private minX = Infinity;
  private maxX = -Infinity;
  private minZ = Infinity;
  private maxZ = -Infinity;
  private minY = Infinity;
  private maxY = -Infinity;
  private n: number;

  constructor(private readonly v: VoxelModel, seed: number) {
    this.n = (seed | 0) >>> 0;
  }

  private rnd(): number {
    this.n = (this.n * 1664525 + 1013904223) >>> 0;
    return ((this.n >>> 9) & 0xffff) / 0x10000;
  }

  private put(x: number, y: number, z: number, color: number): void {
    this.cells.set(`${x},${y},${z}`, color);
    this.v.set(x, y, z, color);
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (z < this.minZ) this.minZ = z;
    if (z > this.maxZ) this.maxZ = z;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
  }

  /**
   * A leaf clump. `ragged` erodes the rim probabilistically so the outline is
   * broken foliage rather than a machined sphere — the other half of why the old
   * canopies read as toy balls.
   */
  clump(
    cx: number, cy: number, cz: number,
    rx: number, ry: number, rz: number,
    color: number, ragged = 0.2,
  ): void {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++)
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
        for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++) {
          const dx = (x - cx) / rx, dy = (y - cy) / ry, dz = (z - cz) / rz;
          const d = dx * dx + dy * dy + dz * dz;
          if (d > 1.0) continue;
          // Erosion is GRADED by depth rather than a flat coin-flip on the
          // outermost shell. At a flat `ragged` over `d > 0.84` the rim came off
          // in a uniform speckle, which at the 2026-07 tree scale (a canopy voxel
          // is half a world unit) reads as a machined sphere with sandpaper on it
          // — measured in _veg-a-forest.png, a near oak crown was an unbroken
          // convex mass of flat green. Weighting the probability by how far out
          // the voxel is chews the extreme rim hard while barely touching the
          // shell under it, so the outline breaks into lobes instead of thinning
          // evenly. The 0.80 floor is still shallow enough that nothing detaches:
          // a voxel at d = 0.80 has its inboard neighbours at d < 0.8 kept.
          if (d > 0.80 && this.rnd() < ragged * ((d - 0.80) / 0.20) * 1.9) continue;
          // Leaf value jitter, in TWO frequencies.
          //
          // A flat ±10% per-voxel roll is white noise, and white noise on a
          // surface whose voxels are half a unit across averages out to nothing
          // the moment the tree is more than a few metres away — which is why a
          // canopy that has jitter in the data still rendered as large flat
          // facets of one green. Correlating the coarse term over 2x2x2 blocks
          // gives clumps of leaves that hold their tone over four or five voxels,
          // so the mass keeps internal structure at distance; the fine term then
          // breaks up each block so it does not read as a checkerboard.
          // Total spread is ~0.83..1.21 against the old 0.90..1.10.
          const cell = (((x >> 1) * 73856093) ^ ((y >> 1) * 19349663)
            ^ ((z >> 1) * 83492791)) >>> 0;
          const coarse = 0.88 + ((cell >>> 7) & 0xff) / 255 * 0.26;
          this.put(x, y, z, shade(color, coarse * (0.945 + this.rnd() * 0.11)));
        }
  }

  /**
   * A rectangular block, recorded the same way a clump is so the shading pass
   * sees it.
   *
   * `clump` is the only painter here and it is an ellipsoid, which is why every
   * boulder in this file came out as a rounded lump: stone fractures along
   * planes, and a stylised boulder needs at least one FLAT face and one hard
   * edge before it reads as rock rather than as a potato. Painting the slab
   * straight into the VoxelModel is not an option — the model is write-only, so
   * the top-to-bottom shading pass would not see the block and the block would
   * keep whatever flat tone it was painted with, which is the same defect from
   * the other end.
   */
  slab(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    color: number,
  ): void {
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++) {
          const cell = (((x >> 1) * 73856093) ^ ((y >> 1) * 19349663)
            ^ ((z >> 1) * 83492791)) >>> 0;
          this.put(x, y, z, shade(color, 0.9 + ((cell >>> 7) & 0xff) / 255 * 0.2));
        }
  }

  /**
   * Repaint the topmost recorded voxel of a PATCH of columns.
   *
   * Lichen and moss on a boulder: they grow on the sky-facing faces and they
   * grow in patches, never as an even sprinkle. The patch shape comes from a
   * coarse hash on `(x >> 1, z >> 1)` — 2x2 blocks of columns share a roll — so
   * the crust reads as two or three colonies rather than as salt-and-pepper
   * noise, which at a boulder's four-or-five-voxel scale is the difference
   * between "mossy rock" and "dithering artefact".
   *
   * Must run AFTER `bake()`: the shading pass rewrites every recorded voxel from
   * the stored albedo, so moss painted before it would be repainted as stone.
   * It writes straight to the model for the same reason.
   */
  speckleTop(color: number, prob: number, seed: number): void {
    for (let x = this.minX; x <= this.maxX; x++)
      for (let z = this.minZ; z <= this.maxZ; z++) {
        let hi = -Infinity;
        for (let y = this.minY; y <= this.maxY; y++) {
          if (this.cells.has(`${x},${y},${z}`)) hi = y;
        }
        if (hi === -Infinity) continue;
        const h = ((((x >> 1) * 374761393) ^ ((z >> 1) * 668265263) ^ seed) >>> 0);
        if (((h >>> 11) & 0xff) / 255 > prob) continue;
        this.v.set(x, hi, z, shade(color, 0.86 + ((h >>> 3) & 0x3f) / 63 * 0.28));
      }
  }

  /**
   * Vertical light gradient: sunlit crown, dark shaded underside.
   *
   * `k` scales the whole effect toward neutral. Anything only three or four
   * voxels tall (a bush, a fern) is ALL crown and ALL underside at once, so the
   * full-strength gradient turns it into a two-tone stack instead of a volume.
   */
  bake(k = 1): void {
    const scaled = (v: number): number => 1 + (v - 1) * k;
    for (let x = this.minX; x <= this.maxX; x++) {
      for (let z = this.minZ; z <= this.maxZ; z++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let y = this.minY; y <= this.maxY; y++) {
          if (!this.cells.has(`${x},${y},${z}`)) continue;
          if (y < lo) lo = y;
          hi = y;
        }
        if (lo === Infinity) continue;
        const at = (y: number, m: number): void => {
          const c = this.cells.get(`${x},${y},${z}`);
          if (c !== undefined) this.v.set(x, y, z, shade(c, m));
        };
        // The crown boost is graded by how high THIS column's top sits in the
        // whole volume, not applied flat at 1.18 to every column top.
        //
        // Flat, it bleaches the entire upper shell to one value, and since a
        // canopy is convex the upper shell is most of what you see: measured in
        // _veg-a-forest.png the top third of a near oak was a single flat green
        // with the per-voxel jitter invisible under it. Grading it puts a dome of
        // light on the tree — the apex is 1.28, the shoulders barely lifted at
        // 1.02 — which is both what actually happens (the highest leaves see the
        // whole sky, the shoulders see a slice of it) and the thing that tells the
        // eye the crown is a rounded volume rather than a painted lid.
        const rel = (hi - this.minY) / Math.max(1, this.maxY - this.minY);
        at(hi, scaled(1.02 + 0.26 * rel));
        if (hi - 1 > lo) at(hi - 1, scaled(0.98 + 0.16 * rel));
        at(lo, scaled(0.62));
        if (lo + 1 < hi) at(lo + 1, scaled(0.78));
        if (lo + 2 < hi) at(lo + 2, scaled(0.9));
      }
    }
  }
}

/**
 * Tapered, bark-varied trunk. The shaft spans `[-r, r)` in x and z, so `r = 1`
 * is the 2-voxel column every tree here used to have and `r = 2` is a 4-voxel
 * bole; it tapers from `r0` at the root to `r1` under the crown, with a
 * one-voxel flare at the foot. Real trunks flare where they meet the ground and
 * every one of them has value variation up the bark; the old straight 2x2 prism
 * with two darker voxels read as a fence post.
 *
 * The shaft is centred on voxel 0 deliberately — see `Template.trunk`. Every
 * caller must therefore pass `trunkR`/`trunkTop` to `bake` so the model bakes
 * uncentred and the painted shaft ends up on the model origin.
 *
 * Trunks got MUCH longer with the 2026-07 tree rescale (oak shafts 7 -> 13-20
 * voxels), which is what carries the canopy clear of the hero and the camera;
 * the taper exists so a 20-voxel shaft does not read as scaffolding.
 */
function trunk(
  v: VoxelModel, h: number, base: number, seed: number, r0 = 1, r1 = r0,
): void {
  let n = seed >>> 0;
  const rnd = (): number => {
    n = (n * 1664525 + 1013904223) >>> 0;
    return ((n >>> 9) & 0xffff) / 0x10000;
  };
  const flareTo = Math.max(1, Math.round(h * 0.1));
  for (let y = 0; y <= h; y++) {
    // Taper is finished by ~70% of the way up: the last third of the shaft is a
    // clean column, so the crown sits on a trunk rather than on a spike.
    const t = Math.min(1, (y / h) / 0.7);
    let r = Math.max(1, Math.round(r0 + (r1 - r0) * t));
    if (y < flareTo) r += 1; // root flare
    const m = 0.84 + rnd() * 0.3;
    v.box(-r, y, -r, r - 1, y, r - 1, shade(base, m));
  }
  // A couple of root buttresses so the trunk grips the ground.
  const b = r0 + 1;
  v.set(-b - 1, 0, 0, shade(base, 0.78));
  v.set(b, 0, -1, shade(base, 0.86));
  v.set(0, 0, b, shade(base, 0.8));
}

// ---------------------------------------------------------------------------
// Template builders
// ---------------------------------------------------------------------------

/**
 * Broadleaf canopy palette.
 *
 * These used to be 0x3d9531..0x72cc55 — the same yellow-greens as the meadow
 * (0x54c832) at nearly the same value, so a tree standing in front of a grassy
 * hillside had no edge at all and simply dissolved into it. Foliage in life is a
 * clear step DARKER and COOLER than open grass (it is a canopy shading itself,
 * seen against a surface in full sun), and pushing it that way is what makes the
 * forest read as a separate layer of the landscape.
 *
 * The spread from CANOPY_DEEP to CANOPY_CROWN is deliberately wide: Canopy.bake
 * lays a further top-to-bottom gradient over whichever of these a clump uses, so
 * a finished canopy carries four or five distinguishable tones — sunlit crown,
 * two mids, shaded flank, dark belly — instead of one flat green.
 */
const CANOPY_DEEP = 0x22662f;
const CANOPY_MID = 0x2d7c36;
const CANOPY_SIDE = 0x35893a;
const CANOPY_LIT = 0x459a43;
const CANOPY_CROWN = 0x5cb251;
const BIRCH_DEEP = 0x3a8c3a;
const BIRCH_MID = 0x4aa044;
const BIRCH_CROWN = 0x6cbe55;

/**
 * TREE SCALE (2026-07 rescale).
 *
 * Every tree in this file used to be a shrub. Measured off the baked templates:
 * the standard oak stood 3.30 world units tall with a crown 2.8 units across,
 * the big oak 4.59 by 3.9, the birch 3.00 by 1.7. The hero is 2 units tall, so
 * the entire forest topped out at a bit over twice his height and the "canopy"
 * was level with his hat — filed as "trees are too small".
 *
 * Two constraints set the new numbers:
 *
 *  - TRUNK CLEARANCE. The third-person camera rides ~7.4 units back and a couple
 *    of units above the hero, so any foliage that starts below ~4 units fills
 *    the frame the moment he walks under it. Every broadleaf here now carries a
 *    bare shaft of 13-20 voxels (6-10 units), and the lowest crown voxel of the
 *    lowest variant (oakD, the deliberately squat one) still sits ~4 units up.
 *  - VERTEX COST. Props are ~78% of a chunk build against a 3 ms/frame budget
 *    (BUILD_BUDGET_MS, world/index.ts), and a canopy's cost goes with its
 *    SURFACE, so tripling a crown's radius in voxels would have been ~9x the
 *    triangles per tree. Roughly two thirds of the size increase is therefore
 *    bought with a bigger bake scale (0.22-0.27 -> 0.40-0.52 units per voxel,
 *    still finer than the 1-unit terrain step and squarely in the chunky Cube
 *    World register) and only one third with more voxels. The rest is paid for
 *    by the tree grid going from 6x6 cells of 5 units to 4x4 cells of 8 — see
 *    the tree pass in buildChunkProps.
 *
 * Trees land at 10-15.5 units before the per-instance 0.78-1.22 girth /
 * 0.86-1.30 height rolls, i.e. 5-8x the hero, which is the proportion a real
 * mature broadleaf has against a person.
 */

/** Tall, narrow oak with an offset lobe — breaks up the round-oak silhouette. */
function oakTreeTall(): Template {
  const v = new VoxelModel();
  // The tallest thing in a plains/forest skyline: a 20-voxel shaft under a
  // narrow crown, 15.5 units all in. 4.37 units before the rescale.
  const H = 20;
  trunk(v, H, 0x7a5233, 0x51f7, 2, 1);
  const c = new Canopy(v, 0x2731);
  c.clump(-0.5, H + 3.0, -0.5, 5.6, 6.4, 5.6, CANOPY_MID);
  c.clump(-0.5, H + 8.2, -0.5, 3.8, 3.2, 3.8, CANOPY_CROWN);
  c.clump(3.2, H - 0.5, 1.8, 3.6, 2.8, 3.6, CANOPY_SIDE);
  c.clump(-4.0, H + 4.2, 1.2, 3.2, 2.6, 3.2, CANOPY_LIT);
  c.bake();
  return bake(v, 0.48, 1, H + 1);
}

function oakTree(big: boolean): Template {
  const v = new VoxelModel();
  const h = big ? 15 : 13;
  trunk(v, h, 0x7a5233, big ? 0x91c3 : 0x4b12, 2, 1);
  const c = new Canopy(v, big ? 0x77ab : 0x1d0e);
  // Clumped, not one shell: a big shaded mass low and inboard, two mid clumps
  // pushed out to opposite sides, and a bright crown catching the sky. The
  // lobes are now expressed as fractions of the crown radius so the two
  // variants stay the same TREE at two sizes rather than drifting into two
  // different shapes.
  const R = big ? 8.2 : 6.8;
  c.clump(-0.6, h + 3.6, -0.6, R, R * 0.66, R, CANOPY_DEEP);
  c.clump(R * 0.42, h + 6.4, R * 0.2, R * 0.56, R * 0.45, R * 0.56, CANOPY_LIT);
  c.clump(-R * 0.46, h + 5.6, -R * 0.3, R * 0.52, R * 0.42, R * 0.52, CANOPY_MID);
  c.clump(R * 0.1, h + 4.8, R * 0.46, R * 0.42, R * 0.34, R * 0.42, CANOPY_SIDE);
  c.clump(-0.6, h + 8.6, -0.6, R * 0.46, R * 0.3, R * 0.46, CANOPY_CROWN);
  c.bake();
  return bake(v, big ? 0.52 : 0.46, 1.5, h + 1);
}

/**
 * A third broadleaf silhouette: a low, broad, spreading crown on a short trunk.
 * The other three oaks are all taller than they are wide, so every plains tree
 * repeated the same vertical proportion; this one is the opposite shape and
 * changes the horizon wherever it lands.
 *
 * It is the shortest tree in the set and therefore the one that decides the
 * camera clearance. Its measured foliage floor is the lowest of the eleven tree
 * templates: 5.50 units on a 12-voxel shaft, against 5.98 for the standard oak
 * and 4.40 for the short pine. The hero is 2 units and the camera rides a
 * couple above him, so even the 0.86 end of the height roll keeps the leaves
 * out of the lens. An 11-voxel shaft measured 5.00 and was the marginal case.
 */
function oakTreeBroad(): Template {
  const v = new VoxelModel();
  const H = 12;
  trunk(v, H, 0x744d31, 0x3ac1, 2, 2);
  const c = new Canopy(v, 0x6f22);
  c.clump(0, H + 3.0, 0, 9.0, 5.2, 8.6, CANOPY_DEEP);
  c.clump(-4.2, H + 5.0, 2.2, 4.6, 3.2, 4.4, CANOPY_MID);
  c.clump(4.6, H + 4.4, -2.6, 4.4, 3.0, 4.2, CANOPY_SIDE);
  c.clump(0.6, H + 6.6, 0.4, 4.2, 2.8, 4.0, CANOPY_LIT);
  c.clump(-1.2, H + 8.4, -1.0, 2.6, 1.8, 2.6, CANOPY_CROWN);
  c.bake();
  return bake(v, 0.50, 1.8, H + 1);
}

function birchTree(): Template {
  const v = new VoxelModel();
  // The bole is a 2x2 column now, not a single voxel: at the new heights a
  // 1-voxel stem was a 0.42-unit pole holding up an 11-unit tree, which is the
  // "spindly" failure mode. Still the slimmest trunk in the set, as a birch's is.
  // low-contrast tan bands (~15%) so the trunk doesn't read as a survey pole
  const H = 18;
  for (let y = 0; y <= H; y++) {
    v.box(-1, y, -1, 0, y, 0,
      y % 7 === 2 || y % 7 === 5 ? 0x8f7752 : y % 5 === 3 ? 0xb59d78 : 0xc9b184);
  }
  v.set(-2, 0, 0, 0xb59d78);
  v.set(0, 0, 1, 0xa89066);
  const c = new Canopy(v, 0xbb31);
  // Birch keeps the lightest, yellowest foliage of the broadleaves — it is the
  // one tree that is SUPPOSED to read as a pale accent in a dark wood — but even
  // it now sits below the meadow so its outline holds against a hillside.
  c.clump(-0.5, H + 3.4, -0.5, 5.4, 4.6, 5.4, BIRCH_MID);
  c.clump(2.0, H + 6.4, 1.0, 3.2, 2.4, 3.2, BIRCH_CROWN);
  c.clump(-2.6, H + 2.0, -1.4, 3.0, 2.4, 3.0, BIRCH_DEEP);
  c.bake();
  return bake(v, 0.42, 1, H + 1);
}

function pineTree(tall: boolean): Template {
  const v = new VoxelModel();
  const g1 = 0x2f8442;
  const g2 = 0x3f9c50;
  // 0xdcecf2 -> 0xd2e4ee: one step off blinding. It was the brightest albedo on
  // any prop in the world and it sat directly against the darkest green, which
  // is a contrast pairing nothing else in the palette comes near.
  const snow = 0xd2e4ee;
  // Conifers get a BARE SHAFT under the first tier now (8 voxels, 12 on the
  // tall variant) where they used to start branching 3 voxels off the ground.
  // Two reasons beyond scale: a snow forest whose foliage reaches the floor is
  // an opaque wall to walk through, and a pine with no bare bole has no trunk to
  // climb — climbTopAt would hand back a height barely off the ground.
  const bare = tall ? 12 : 10;
  trunk(v, bare, 0x6b4a2e, tall ? 0x3d71 : 0x71c4, 2, 1);
  // [radius, y0, y1] tiers, stacked from `bare` up. Deeper tiers (3 voxels, not
  // 2) so the cone stays a solid mass at the new size instead of a stack of
  // plates with daylight between them.
  const layers: Array<[number, number, number]> = tall
    ? [[6, 0, 3], [5, 4, 7], [4, 8, 11], [3, 12, 14], [2, 15, 17], [1, 18, 19]]
    : [[5, 0, 3], [4, 4, 6], [3, 7, 9], [2, 10, 12], [1, 13, 14]];
  let n = 0x9e11;
  for (let li = 0; li < layers.length; li++) {
    const [r, ly0, ly1] = layers[li];
    const y0 = bare + ly0;
    const y1 = bare + ly1;
    const base = li % 2 === 0 ? g1 : g2;
    // Each tier is brighter than the one under it, and each voxel is jittered:
    // a conifer's tiers self-shade heavily, and flat-coloured tiers were reading
    // as a stack of green plates.
    const tierM = 0.78 + (li / Math.max(1, layers.length - 1)) * 0.44;
    // ROUND tiers, not square ones.
    //
    // Each tier used to be a filled `v.box(-r..r, -r..r)`, i.e. a square slab,
    // and a conifer built of five square slabs is a ziggurat: from any bearing
    // off the diagonal it shows two long straight edges and a hard 90-degree
    // corner, which is why the distant conifers in _veg2c-meadow.png read as
    // drill bits rather than as trees. Clipping to a disc costs nothing (it
    // REMOVES about a fifth of the voxels in every tier, and pines are 60% of
    // the trees in a snow chunk) and gives the cone the stepped-circular plan a
    // spruce actually has.
    const r2 = (r + 0.45) * (r + 0.45);
    for (let x = -r; x <= r; x++)
      for (let z = -r; z <= r; z++) {
        const d2 = x * x + z * z;
        if (d2 > r2) continue;
        for (let y = y0; y <= y1; y++) {
          n = (n * 1664525 + 1013904223) >>> 0;
          const j = 0.9 + ((n >>> 12) & 0xff) / 255 * 0.2;
          // underside of each tier is the shaded one
          v.set(x, y, z, shade(base, tierM * j * (y === y0 ? 0.74 : 1)));
        }
        // Snow dusting, PATCHY and rim-weighted rather than a solid plate.
        //
        // `v.box(...y1...)` capped every tier with an unbroken near-white lid,
        // and since the tier above hides the middle of that lid, what actually
        // rendered was a continuous white RING at every tier — five of them up
        // the tree, evenly spaced, at maximum contrast against the darkest green
        // in the world. That is a barber pole, and at the distance a treeline is
        // read at it is the loudest thing in the frame. Weighting the roll by
        // how close the column is to the rim (0.2 on the axis, 0.8 at the edge)
        // keeps the dusting where snow would actually sit on a bough, and
        // leaving four columns in ten bare breaks the ring into drifts.
        n = (n * 1664525 + 1013904223) >>> 0;
        if (((n >>> 9) & 0xff) / 255 < 0.2 + (d2 / r2) * 0.6) {
          v.set(x, y1, z, shade(snow, 0.88 + ((n >>> 19) & 0x3f) / 63 * 0.22));
        }
      }
  }
  return bake(v, tall ? 0.50 : 0.44, 1, bare);
}

/** Asymmetric pine — tier offsets wobble so the cone silhouette isn't a stamp. */
function pineIrregular(): Template {
  const v = new VoxelModel();
  const bare = 10;
  trunk(v, bare, 0x6b4a2e, 0x1ac9, 2, 1);
  const g1 = 0x2f8244;
  const g2 = 0x3a9349;
  const snow = 0xd2e4ee;
  // [radius, y0, y1, xOffset, zOffset], y relative to the top of the bare shaft
  const layers: Array<[number, number, number, number, number]> = [
    [5, 0, 3, 1, 0], [5, 4, 6, -2, 1], [4, 7, 9, 0, -2], [3, 10, 12, 1, 0],
    [2, 13, 15, 0, 1], [1, 16, 17, -1, 0],
  ];
  // Round tiers and patchy rim snow, for the reasons documented at length in
  // `pineTree` — square slabs read as a ziggurat and a solid white lid on every
  // tier reads as a barber pole. This variant's tiers are also OFFSET from the
  // axis, so its discs overhang on one side, which is the whole point of it.
  let n = 0x51c7;
  for (let li = 0; li < layers.length; li++) {
    const [r, y0, y1, dx, dz] = layers[li];
    const base = li % 2 === 0 ? g1 : g2;
    const r2 = (r + 0.45) * (r + 0.45);
    for (let x = -r; x <= r; x++)
      for (let z = -r; z <= r; z++) {
        const d2 = x * x + z * z;
        if (d2 > r2) continue;
        for (let y = bare + y0; y <= bare + y1; y++) {
          n = (n * 1664525 + 1013904223) >>> 0;
          const j = 0.9 + ((n >>> 12) & 0xff) / 255 * 0.2;
          v.set(x + dx, y, z + dz, shade(base, j * (y === bare + y0 ? 0.78 : 1)));
        }
        n = (n * 1664525 + 1013904223) >>> 0;
        if (((n >>> 9) & 0xff) / 255 < 0.2 + (d2 / r2) * 0.6) {
          v.set(x + dx, bare + y1, z + dz, shade(snow, 0.88 + ((n >>> 19) & 0x3f) / 63 * 0.22));
        }
      }
  }
  return bake(v, 0.46, 1, bare);
}

/**
 * Dead standing snag: a bare, broken-topped bole with a few upswept limbs and
 * no foliage at all.
 *
 * Silhouette variety across a treeline is the hardest thing to buy in this file,
 * because every other lever (girth, height, yaw, tint, five broadleaf templates)
 * still produces a green blob on a brown stick, and at the distance a treeline is
 * read at, a green blob on a brown stick is one shape. A snag is the one tree
 * that is not that shape: it is all silhouette and no mass, so it punches a
 * ragged vertical hole in a canopy line and the eye immediately reads the line as
 * a collection of individual trees rather than as a hedge. It is also the
 * cheapest tree in the set by an order of magnitude — a few dozen voxels against
 * a canopy's few thousand — so raising the tree count with snags costs almost
 * nothing.
 *
 * Every limb starts ABOVE the halfway point of the shaft, and that is load
 * bearing rather than aesthetic: `bake` measures the solid trunk radius over the
 * band from the root flare up to `trunkTop * 0.5`, so a limb rooted below that
 * line would be counted as bole and inflate the climb/collide cylinder to the
 * limb's reach — the hero would stop walking a metre short of the trunk.
 */
function deadSnag(tall: boolean): Template {
  const v = new VoxelModel();
  // 15/20 voxels at 0.50/0.54 units, i.e. 7.5 and 10.8 units of bare bole before
  // the limbs. First captured at 12/17 at 0.42/0.46 (5.0 and 7.8 units) and it
  // was too short by a clear margin — _veg-e-snag1.png has one standing among
  // 10-15 unit broadleaves and it read as a stump, not as a dead tree. A snag is
  // one of the SAME trees with its leaves gone, so its bole has to reach roughly
  // where their crowns start or the silhouette gain is lost.
  const H = tall ? 20 : 15;
  const bark = 0x6f5c45;
  trunk(v, H, bark, tall ? 0x2c81 : 0x5f31, 2, 1);
  // Broken crown: a jagged stub, not a sawn end.
  v.set(0, H + 1, 0, shade(bark, 1.12));
  v.set(-1, H + 1, 0, shade(bark, 0.9));
  v.set(-1, H + 2, 0, shade(bark, 1.04));
  // [dx, dz, y0, length]; limbs rise as they reach out.
  const limbs: Array<[number, number, number, number]> = tall
    ? [[1, 0, 12, 5], [-1, 0, 14, 4], [0, 1, 16, 4], [0, -1, 17, 3]]
    : [[1, 0, 9, 4], [-1, 0, 11, 3], [0, 1, 12, 3]];
  for (const [dx, dz, y0, len] of limbs) {
    for (let k = 1; k <= len; k++) {
      const y = y0 + Math.floor(k * 0.7);
      v.set(dx * k, y, dz * k, shade(bark, k > len - 2 ? 1.14 : 0.94));
      // The limb's underside cell keeps the run face-connected wherever the
      // rise steps up; without it the limb is a dotted line of floating cubes.
      v.set(dx * k, y - 1, dz * k, shade(bark, 0.84));
    }
  }
  return bake(v, tall ? 0.54 : 0.50, 1, H);
}

/**
 * Parameterized palm: frond count, trunk lean slope and height multiplier
 * give visually distinct variants so beach lines don't read as a production run.
 */
function palmTree(fronds: number, lean: number, heightMul: number): Template {
  const v = new VoxelModel();
  const trunkC = 0x8a6238;
  // 22 voxels at 0.36 = a 7.9-unit bole, up from 11 at 0.20 (2.2 units). A palm
  // is the one tree that is ALL trunk, so this is where the rescale shows most.
  const H = Math.max(16, Math.round(22 * heightMul));
  let topX = 0;
  for (let y = 0; y <= H; y++) {
    const xo = Math.round(y * lean);
    // 2x2 bole. A 1-voxel stem held up a 2-unit palm well enough; at 8 units it
    // was a wire.
    v.box(xo - 1, y, -1, xo, y, 0, y % 3 === 0 ? 0x7a5530 : trunkC);
    topX = xo;
  }
  const topY = H + 1;
  const leaf = 0x3f9e45;
  const leafL = 0x55b858;
  // Fronds run to 8 voxels (was 5) so the crown still spreads wider than the
  // trunk is thick now that the trunk is twice as wide.
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + fronds * 0.73;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    // Width is laid out along the frond's own PERPENDICULAR, not always along
    // +z. With a fixed +z offset the fronds pointing along z got their extra
    // cell stacked in line with themselves and stayed one voxel wide, so a palm
    // crown had two fat fronds and four wires depending on bearing — visible in
    // _veg-e-snag1.png as a beach line of palms with sparse, spidery heads.
    const qx = Math.round(-dz);
    const qz = Math.round(dx);
    for (let k = 1; k <= 8; k++) {
      const y = topY + (k <= 2 ? 1 : k <= 5 ? 0 : -(k - 5));
      const cx = topX + Math.round(dx * k);
      const cz = Math.round(dz * k);
      v.set(cx, y, cz, k >= 6 ? leafL : leaf);
      // Two cells of width out to the shoulder and one to the tip: a frond that
      // is a 1-voxel wire for most of its length disappears at gameplay
      // distance, and the palm reads as a bare pole with a smudge on it.
      if (k <= 6) v.set(cx + qx, y, cz + qz, k >= 5 ? leafL : leaf);
      if (k >= 2 && k <= 5) v.set(cx - qx, y, cz - qz, leaf);
    }
  }
  v.box(topX - 1, topY, -1, topX, topY, 0, leaf);
  v.box(topX - 1, topY + 1, -1, topX, topY + 1, 0, leafL);
  v.set(topX - 2, topY - 1, 0, 0x5c3d24);
  v.set(topX + 1, topY - 1, 1, 0x5c3d24);
  return bake(v, 0.36, 1, H);
}

function cactus(small: boolean): Template {
  const v = new VoxelModel();
  const c = 0x3d9950;
  const cl = 0x54b862;
  v.box(-1, 0, 0, 0, small ? 5 : 9, 0, c);
  v.box(0, 1, 0, 0, small ? 4 : 8, 0, cl);
  if (!small) {
    v.set(1, 4, 0, c);
    v.box(2, 4, 0, 2, 7, 0, c);
    v.set(2, 7, 0, cl);
    v.set(-2, 5, 0, c);
    v.box(-3, 5, 0, -3, 8, 0, c);
    v.set(-3, 8, 0, cl);
    // Bloom chroma down ~30% into a dusty rose — the old 0xf47fb0 was a pure
    // magenta chip on an otherwise tan/green desert.
    v.set(0, (small ? 6 : 10), 0, 0xd08b9e);
  }
  return bake(v, small ? 0.16 : 0.18);
}

function rock(kind: 0 | 1 | 2, mossy = false): Template {
  const v = new VoxelModel();
  // A wider warm mineral range than before. Three near-identical greys spanning
  // only 0x7d..0x9a gave a boulder about 12% of internal contrast, which after
  // the tone curve is nothing: the clusters read as flat concrete lumps. This
  // spans 0x5c..0xb4, and the vertical shading pass below adds the lit-crown /
  // shaded-base read that terrain gets from its baked corner AO and that props
  // previously got from nowhere at all.
  // The dark end is UP and warmer. warmD used to be 0x5c554c, and once the
  // Canopy shading pass had taken another 23% off it and a shaded face received
  // only the cool hemisphere fill, the result measured as a near-black chip with
  // no hue in it at all — filed as "a cluster of near-black rock cubes" and "an
  // unlit slate monolith". A stylised boulder's darkest tone still has to be
  // recognisably STONE-coloured; the shading comes from the light, not from
  // painting the albedo black.
  const warmA = 0xbdb2a0;
  const warmB = 0x9c917f;
  const warmC = 0x847a6b;
  const warmD = 0x6f6558;
  // Canopy is misnamed for a boulder but it is precisely the right tool: it
  // records every voxel it paints (jittering each by ±10% on the way in), then
  // re-shades each column from its topmost voxel downward. Painting the whole
  // rock through it — rather than straight into the VoxelModel, which is
  // write-only and so invisible to the second pass — is what lets the crown
  // catch sky while the base sits in contact shade.
  // Every boulder now carries at least one FLAT, FRACTURED plane on top of its
  // rounded mass (see Canopy.slab). A pile of ellipsoids is a pile of potatoes;
  // captured in _veg-a-tree.png a mid-ground boulder read as a smooth grey lump
  // with no orientation to it at all. One slab cutting across the lump gives the
  // rock a bedding plane, a hard horizontal edge that catches the sun on its top
  // face, and a corner — which is the whole difference between "stone" and
  // "blob" at gameplay distance.
  const g = new Canopy(v, 0x51a3 + kind * 71);
  if (kind === 0) {
    g.clump(0, 0.8, 0, 3, 2, 2.4, warmB, 0.12);
    g.clump(0.8, 1.8, 0.2, 1.5, 1, 1.2, warmA, 0);
    // A darker shelf bedded low on one flank: real boulders sit in the ground.
    g.clump(-1.6, 0.2, -0.9, 1.9, 0.9, 1.6, warmD, 0.2);
    // Cleaved cap: a flat lid over the crown, offset so it overhangs one side.
    g.slab(-1, 2, -2, 2, 2, 1, warmA);
    // satellite pebbles break the lone-boulder silhouette
    v.set(4, -1, 1, shade(warmC, 0.96));
    v.box(-4, -1, -1, -4, 0, -1, shade(warmA, 0.9));
  } else if (kind === 1) {
    g.clump(0, 1, 0, 3.6, 2.6, 3, warmC, 0.12);
    g.clump(-1.4, 1.2, 0.8, 2, 1.6, 1.6, warmB, 0);
    g.clump(1.6, 2.4, -0.6, 1.4, 1, 1.2, warmA, 0);
    g.clump(1.2, 0.1, 1.8, 2.2, 1.0, 1.8, warmD, 0.2);
    // A whole tilted block sheared off the flank, plus a stratum of the darkest
    // mineral running through the middle of the mass.
    g.slab(-3, 1, -2, -1, 2, 1, warmB);
    g.slab(-3, 0, -1, 3, 0, 2, warmD);
    v.box(5, -1, 2, 5, 0, 2, shade(warmB, 0.92));
    v.set(-4, -1, -3, shade(warmA, 0.88));
  } else {
    g.clump(0, 0.8, 0, 3, 2, 2.4, warmC, 0.12);
    g.clump(-1.4, 0.2, 1.0, 1.8, 0.9, 1.5, warmD, 0.2);
    g.slab(-2, 1, -1, 1, 1, 2, warmB);
    v.set(4, -1, 0, shade(warmB, 0.94));
  }
  // 0.6 strength: a boulder is only four or five voxels tall, so the full ramp
  // (tuned for a tree canopy) would turn it into a two-tone stack.
  g.bake(0.6);
  // Lichen crust on the sky-facing faces, for the boulders that stand in grass.
  //
  // Every rock in the world was the same neutral mineral grey, and after the
  // 2026-07 slab pass gave each one flat cleaved planes and hard corners, a
  // mid-ground outcrop in _veg2a-forest.png read as poured CONCRETE steps — the
  // silhouette said "cut stone" and the palette had no hue to argue otherwise.
  // Grey is also the one colour in this world with no biome behind it. Two
  // greens on the crown fix both at once: they say weathered-and-outdoors rather
  // than freshly-cast, and they tie the boulder to the meadow it sits in, which
  // is exactly what Cube World's mossy rocks do. Placement picks the mossy
  // variants only in plains and forest, so nothing green appears on a dune.
  //
  // ~55% coverage over 2x2 column patches, in two tones so the crust itself has
  // internal variation. Deliberately DESATURATED against the sward (0x4a7a38 is
  // roughly a third of the meadow's chroma) — a boulder wearing meadow-green
  // stops reading as stone entirely.
  if (mossy) {
    g.speckleTop(0x4a7a38, 0.55, 0x51a3 + kind * 71);
    g.speckleTop(0x5c8a3c, 0.22, 0x9c17 + kind * 37);
  }
  // The snow cap goes on AFTER the shading pass, which rewrites every voxel the
  // Canopy recorded — painted before, the cap would be overwritten with shaded
  // rock wherever the two volumes overlap.
  if (kind === 2) v.ellipsoid(0, 2.1, 0, 2.4, 0.9, 1.9, 0xe9f2f7);
  return bake(v, kind === 1 ? 0.28 : 0.2);
}

/**
 * Chunky voxel tussock: a knot of 1-voxel stems of staggered height with pale
 * tips. This is the AO-safe half of the meadow — a solid volume, so a
 * screen-space occlusion pass reads it correctly, where a 2-pixel billboard
 * quad gets crushed. It is also the more Cube-World read of the two: actual
 * cubes of grass standing up out of the sward.
 */
/**
 * Four distinct tussock silhouettes, `variant` 0-3.
 *
 * There used to be ONE footprint, and it was a symmetric plus — which meant the
 * random yaw every instance already got did nothing at all to its outline, and a
 * meadow read as "the identical pale-green claw shape at the identical yaw"
 * repeated a hundred times. Rotational symmetry is the trap: a tuft has to be
 * ASYMMETRIC before yawing it buys any variety. Each of these leans, sprawls or
 * clusters differently, so four templates times a full circle of yaw times +/-20%
 * scale is enough that no two tufts in a frame match.
 */
function grassTuft(dry: boolean, variant = 0): Template {
  const v = new VoxelModel();
  // Anchored just off the ground's own value, same rule as the blade billboards:
  // the wet set sits a shade over the meadow green, the dry set a shade over the
  // sand. `0x4d9c34` used to be the mid tone and read as a dark knot on lit
  // grass; everything here is a step brighter and yellower now.
  // Pitched WELL above the ground colour, unlike the billboards, and for a
  // concrete reason: a tuft is a knot of 2x2 voxel columns, so most of its screen
  // area is vertical side faces, and the sun (170,160,113) leaves two of the four
  // side directions with no direct light at all. At the sward's own value that
  // made every tuft a dark olive smudge on lit grass. Overshooting the albedo is
  // what lands the *rendered* result inside the meadow's band.
  // Pulled DOWN toward the ground's own value, and the base is darker still.
  //
  // The old set (0x74c94d over 0x63b53f, tips 0x9ade67) sat clearly LIGHTER than
  // the meadow, and a light tuft on darker grass reads as something lying on top
  // of the surface rather than growing out of it — at gameplay distance a field of
  // them reads as fuzz or mould. The mid tone now sits just under the sward, only
  // the very tips are brighter than it, and `root` plants the bottom voxel in
  // contact shade so each tuft has a base instead of hovering. Note this is
  // authored against `relight` above, which lifts the vertical faces the sun
  // misses — the old palette was overshooting the albedo to compensate for
  // exactly that darkening, and no longer needs to.
  const a = dry ? 0xc4b473 : 0x58a83c;
  const b = dry ? 0xb2a066 : 0x4b9634;
  const c = dry ? 0xd8c88c : 0x86c95a;
  const root = dry ? 0x8b7d50 : 0x33682a;
  // A SOLID clump, not a knot of separated stems.
  //
  // This used to be eight 2x2 columns with 2-voxel gaps between them, and viewed
  // from anywhere near overhead those gaps read as a black core inside a bright
  // rim: a lattice of thin geometry with air behind it is the worst possible input
  // to a screen-space occlusion pass, which fills every gap and then blurs the
  // result into one dark mass. A contiguous mound has no gaps to fill, and a
  // chunky solid tussock is the more Cube-World read anyway.
  //
  // Heights are also cut by ~60% from the original: the old 5-voxel stems came to
  // 0.72 units after scale, three quarters of a terrain step, which is a reed bed.
  // The tallest cell here is 3 voxels ≈ 0.33 units, i.e. ground cover.
  //
  // [x, z, height] over face-connected 1x1 cells. Every set is asymmetric.
  //
  // ONE-voxel columns at roughly double the bake scale, not 2x2 columns — the
  // same silhouette at a third of the triangles. This matters far more than it
  // looks: the tussock is now the load-bearing ground cover and there are two of
  // them per meadow clump, and a 2x2 column of n layers shows 8n side faces
  // against a 1x1 column's 4n. Measured over 81 chunks, raising the tussock
  // count on the 2x2 shapes took the prop pass from 5.3 ms to 9.1 ms a chunk
  // against a 3 ms/frame build budget (soft-mesh vertices 31k -> 56.5k); the same
  // count on these shapes lands back near the original. Bigger cubes are also
  // the more Cube-World read of the two.
  const SHAPES: Array<Array<[number, number, number]>> = [
    // 0 — a knot leaning hard to +x, tallest on the lee side
    [[0, 0, 1], [1, 0, 2], [1, 1, 0], [0, -1, 0], [-1, 0, 0], [2, 0, 0]],
    // 1 — a low ridge running along z with one tall end
    [[0, -1, 0], [0, 0, 0], [0, 1, 2], [1, 1, 1], [0, 2, 0], [-1, 0, 0]],
    // 2 — two humps sharing a thin bridge
    [[0, 0, 2], [1, 0, 0], [2, 0, 1], [2, 1, 0], [0, 1, 0]],
    // 3 — a broad low mat with a single spike off-centre
    [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 2], [-1, 0, 0], [-1, 1, 0], [1, 2, 0]],
  ];
  const cells = SHAPES[variant % SHAPES.length];
  for (let s = 0; s < cells.length; s++) {
    const [x, z, h] = cells[s];
    for (let y = 0; y <= h; y++) {
      v.set(x, y, z, y === 0 ? root : (s % 3 === 0 ? a : b));
    }
    // Only the tallest cells get bright tips — capping every cell with the light
    // tone is what turned the old tuft into a pale claw.
    if (h >= 2) v.set(x, h, z, c);
  }
  // 0.19 units per voxel on 1x1 cells, i.e. the same WORLD size the shapes had at
  // 0.09-0.105 on 2x2 cells, at a third of the triangles. History: 0.12 -> 0.09
  // because a broad variant stamped at 1.2x came out nearly a full block wide and
  // a smooth rounded mass that size reads as a pillow, not a tussock; then back
  // up, because the solid tussock turned out to be the ONLY ground cover in this
  // file that survives to the screen — the billboards beside it are near-
  // invisible by construction (up normal, sward albedo) — and at 0.09 the tallest
  // cell stood 0.45 units and was barely readable from the 2-unit camera height
  // in _veg-a-grass.png. The tallest cell is now 3 voxels = 0.57 units, just over
  // half a terrain step at 1x and 0.77 at the top of the per-instance roll.
  // Trimmed to 0.175 after looking at _veg-g-ground.png: at 0.19 the top of the
  // scale roll put a metre-wide tussock in the near foreground and it read as a
  // small bush rather than as grass.
  //
  // Back up to 0.21, and this time with the placement numbers behind it. Around
  // the spawn (72, -5) the terrain is 58% plains, so the meadow pass accepts
  // 0.72 of its 115 candidates and plants ~83 clumps in every 32x32 chunk — one
  // per 3.5 units square. A frame of the near meadow (_veg2c-macro.png, camera
  // 3.4 units up) therefore contains roughly a dozen clumps, and it shows ONE
  // readable object: the blades are invisible by construction (up normal, sward
  // albedo, admitted above) and a 0.52-unit tussock four voxels across is a few
  // pixels at 10 metres. The count is not the problem and never was; the
  // per-clump readable MASS is. Scaling the tussock costs nothing at all in
  // triangles — it is the same 14 cells — where raising the count costs
  // linearly, so it is the first knob to turn. Tallest cell is now 0.63 units at
  // 1x, 0.76 at the top of the clump roll: still under a terrain step, still
  // ground cover, but it clears the meadow's own 1-unit relief instead of
  // hiding behind it.
  return withSway(bake(v, 0.21));
}

/**
 * The CARPET primitive: a two-or-three-voxel sprig, deliberately the cheapest
 * readable piece of ground cover in the file.
 *
 * "The terrain is largely bare polygon between sparse bushes. Cube World's ground
 * plane is densely carpeted; this reads as an untextured mesh by comparison."
 * That is a DENSITY finding, and every previous round answered it by making the
 * individual tussock bigger, because the tussock is expensive and raising its
 * count kept blowing the 3 ms chunk-build budget (the history at `grassTuft`'s
 * bake scale is three rounds of exactly that trade). A bigger tussock cannot
 * carpet anything; only more objects can.
 *
 * So this is a tussock with the mass taken out: one to three voxels on one or
 * two face-connected cells against the tussock's nine on six. Measured off the
 * baked templates, the four sprigs are 24 / 40 / 56 / 40 vertices against
 * `grassTuft`'s 144 / 144 / 136 / 136 — three and a half sprigs for the price of
 * one tussock — and the meadow pass now plants four to eight of them per clump
 * around the one to three tussocks that anchor it, with another ~70 a chunk
 * scattered between the clumps. The tussocks stay the readable objects; these
 * fill the bare polygon between them.
 *
 * They also cost nothing at the CALL site, which matters as much as the vertex
 * count: `addSprig` seats them on `columnHeight` (one `heightCont`) and inherits
 * the clump's already-sampled ground tint, where `addTuft` runs a full
 * `columnInfo` — two fbm(3) fields and the whole biome colour blend — per
 * instance. A carpet is hundreds of stamps a chunk; it cannot afford to ask the
 * terrain a question each time.
 *
 * Four silhouettes, and unusually they carry four DIFFERENT bake scales rather
 * than four different voxel counts at one scale. That is the whole economy of
 * the thing: at this size a voxel is pure cost and a bake scale is free, so the
 * cheapest variant is one cube blown up to 0.34 units (24 vertices) and the
 * dearest is three cubes at 0.22 (56), and stamped together at random they read
 * as a mixed sward rather than as one repeated object. Mean 40 vertices against
 * the tussock's 140.
 *
 * A lone cube is normally a trap here — `shells` documents it: on bright sand a
 * 1x1x1 prop shows one lit top over vertical faces the sun never reaches and
 * prints as a cream-topped black die. Grass gets away with it for two reasons
 * that do not hold on sand. `relight` (above) lifts every non-top face back to
 * ~0.96 of neutral, so the baked fake sun that caused most of that contrast is
 * gone; and the sward is a SATURATED surface, so a side face that keeps its hue
 * and loses some value reads as shade rather than as a hole.
 */
function grassSprig(dry: boolean, variant = 0): Template {
  const v = new VoxelModel();
  // Same band as `grassTuft`, one notch apart so a sprig standing beside a
  // tussock is not a shrunk copy of it: mid tone just under the sward, root in
  // contact shade, only the tip over the ground's own value.
  const a = dry ? 0xc0b070 : 0x54a339;
  const b = dry ? 0xaf9d63 : 0x4a9233;
  const c = dry ? 0xd6c68a : 0x83c657;
  const root = dry ? 0x8b7d50 : 0x33682a;
  /** [x, z, height] over face-connected 1x1 cells, and the bake scale. */
  const SHAPES: Array<{ cells: Array<[number, number, number]>; s: number }> = [
    // A single cube, big. 24 vertices — the cheapest readable ground cover in
    // the file by a factor of six.
    { cells: [[0, 0, 0]], s: 0.34 },
    // A two-voxel stalk. Rotationally symmetric, which normally cancels the
    // random yaw (see `grassTuft`), but a 0.26 x 0.52 pillar has no outline for
    // yaw to change anyway and it is the cheapest way to get a SECOND height
    // into the carpet.
    { cells: [[0, 0, 1]], s: 0.26 },
    // An L: a two-voxel stalk with a single cube leaning off it.
    { cells: [[0, 0, 1], [1, 0, 0]], s: 0.22 },
    // A flat pair, the low mat of the set.
    { cells: [[0, 0, 0], [0, 1, 0]], s: 0.28 },
  ];
  const sh = SHAPES[variant % SHAPES.length];
  for (let s = 0; s < sh.cells.length; s++) {
    const [x, z, h] = sh.cells[s];
    for (let y = 0; y <= h; y++) {
      // The dark contact-shade root only exists on cells that HAVE something
      // above it. A one-voxel sprig painted `root` would be a dark chip on lit
      // grass, which is the failure the tussock palette was rebuilt to avoid.
      v.set(x, y, z, h > 0 && y === 0 ? root : (s % 2 === 0 ? a : b));
    }
    if (h >= 1) v.set(x, h, z, c);
  }
  // Scales land every variant between 0.28 and 0.56 units tall before the
  // per-instance roll — under half a terrain step, squarely ground cover, and a
  // clear rung below the tussock's 0.63-0.91.
  return withSway(bake(v, sh.s));
}

/**
 * A low mat of flowering ground cover, ~1.5 units across and a third of a unit
 * tall, in a NON-GREEN hue.
 *
 * "Add at least one non-green ground-cover mass per biome patch at a scale
 * visible from distance — the existing flower voxels are far too small to
 * register." Measured: `flower` bakes at 0.11 units per voxel over a 3-voxel
 * head, so its whole blossom is a 0.33-unit object of which the coloured part is
 * two voxels — about 9 pixels at 40 units, which is under the threshold where a
 * hue reads as anything but noise. One blossom per clump therefore contributed
 * nothing to the meadow's colour at any distance a vista is read at.
 *
 * A MAT is the fix rather than a bigger blossom: real meadow colour arrives as
 * drifts of one species, not as scattered individual flowers, and a drift is
 * both the right art and the cheaper geometry (a flat mass of one-voxel cells
 * has almost no side faces to pay for). This is 12-16 cells laid out as an
 * eroded disc, mostly one voxel tall with a few two-voxel heads, so it reads as
 * a colour patch pressed into the sward rather than as a prop standing on it.
 *
 * `petal` is the crown tone and `rim` the shaded outer/lower one, exactly as in
 * `flower`, and both are pulled well off full chroma for the same reason: a
 * saturated chip in an otherwise green/tan world reads as a decal.
 */
function bloomMat(petal: number, rim: number, leaf: number): Template {
  const v = new VoxelModel();
  // An eroded disc of radius ~3.5 cells. [dx, dz] offsets, deliberately not
  // symmetric about either axis so the random yaw each stamp gets changes the
  // outline (the trap documented on `grassTuft`).
  const CELLS: Array<[number, number, number]> = [
    [0, 0, 1], [1, 0, 1], [2, 0, 0], [-1, 0, 0], [3, 1, 0],
    [0, 1, 1], [1, 1, 0], [-1, 1, 0], [2, 1, 1],
    [0, -1, 0], [1, -1, 1], [2, -1, 0], [0, 2, 0],
  ];
  for (let i = 0; i < CELLS.length; i++) {
    const [dx, dz, tall] = CELLS[i];
    // A leaf base under every cell so the mat has a green foot in the sward and
    // the colour sits on top of it, the way a flowering plant actually looks.
    v.set(dx, 0, dz, shade(leaf, 0.82 + ((i * 37) % 7) / 7 * 0.24));
    v.set(dx, 1, dz, i % 3 === 0 ? rim : petal);
    if (tall) v.set(dx, 2, dz, i % 4 === 0 ? rim : petal);
  }
  // 0.155 units per voxel: the disc spans 6 cells, i.e. ~0.93 units across and
  // 0.31-0.46 tall before the per-instance scale roll. At the 1.0-1.5x the
  // meadow pass stamps it at, a drift is 0.9-1.4 units wide — comfortably the
  // largest piece of ground cover in the file and the only one carrying a hue
  // the sward does not.
  return bake(v, 0.155);
}

/**
 * Crossed-quad grass billboard: two intersecting quads with a vertex-color
 * gradient (dark at the root, bright at the tip), slight tilt and taper baked
 * per variant. No textures — pure vertex color, rendered double-sided in the
 * soft (non-shadow-casting) mesh, so meadows read as actual grass carpets.
 */
/**
 * sRGB hex -> linear triple, for vertex colours written straight into a
 * BufferAttribute (three.js reads those as linear). Same conversion
 * THREE.Color.setHex performs, and the same one terrain.ts uses — without it
 * these blades sat on a different colour convention from the ground they grow
 * out of, which is why they read as pale paper slivers.
 */
const lin = (hex: number): [number, number, number] => {
  const f = (c: number): number =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return [f(((hex >> 16) & 255) / 255), f(((hex >> 8) & 255) / 255), f((hex & 255) / 255)];
};

/**
 * A tuft of crossed grass planes.
 *
 * Three things were wrong with this and each of them was individually enough to
 * make it the ugliest thing in the frame:
 *
 *  1. HEIGHT. Blades ran 0.42-0.95 world units against a 1-unit terrain step, so
 *     grass stood as tall as the ground it grew out of and every meadow read as
 *     a dead reed swamp. Ground cover has to be ground cover: the tallest blade
 *     here is now about a third of a step, the shortest a fifth.
 *  2. VALUE. The root was `0x3d7f28` — far darker than the `0x54c832` meadow —
 *     so a tussock printed as near-black spikes on lit grass and as acid olive
 *     on pale sand. The band is now anchored just off the ground colour: the
 *     root a shade darker and cooler than the sward, the tip a shade brighter
 *     and yellower. Both defects (black-on-grass and clashing-on-sand) come from
 *     the same uncontrolled band, and clamping it fixes both at once.
 *  3. NORMALS. A 50/50 face/up normal blend meant blades took only half the sun
 *     the surrounding ground did, dragging them below the meadow's value however
 *     the colours were authored. 0.78 up / 0.22 face keeps them inside the
 *     meadow's range from every bearing while still giving each plane a little
 *     of its own facing.
 *
 * Three planes at 0/60/120 degrees rather than two at 0/90: with two, there are
 * bearings where one plane is edge-on and the other is at 45 degrees, and a
 * short wide tuft then reads as a single leaning card. At 60-degree spacing the
 * worst case is 30 degrees off face-on for the best plane, so the tuft holds a
 * volume from every angle. The extra plane is free — the height cut more than
 * pays for it in fill.
 */
function grassBillboard(
  tiltX: number, tiltZ: number, height: number, width: number,
  // Both ends pulled DOWN toward the sward. A blade card carries an up normal so
  // it takes exactly the same sun as the ground from every bearing (see the note
  // below) — which means an albedo brighter than the ground renders brighter than
  // the ground, and a field of pale lime cards on saturated grass reads as paper
  // scraps. Anchoring the root just under the meadow and the tip only just over it
  // is what makes a blade look like it grew there.
  //
  // The ROOT is now a full stop darker (0x479526 -> 0x2f6b1c) while the tip moves
  // barely at all. That correction had gone one step too far: a blade whose
  // albedo, normal AND light are all identical to the block it stands on is
  // literally invisible, and _veg-a-grass.png (camera 2 units up, standing in a
  // meadow) showed exactly that — a bare green plate with a flower and two solid
  // tussocks on it and not one readable blade, despite ~770 of them in the chunk.
  // Widening the root-to-tip gradient puts the contrast INSIDE the blade instead
  // of between the blade and the ground: each card now carries its own contact
  // shade at the base, which is what makes a tuft read as standing up out of the
  // sward, and the mean value of the card still sits under the meadow so a field
  // of them cannot go back to reading as paper scraps.
  rootC: [number, number, number] = lin(0x2f6b1c),
  tipC: [number, number, number] = lin(0x82c745),
): Template {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  /**
   * One blade quad, emitted with BOTH windings over the same four vertices.
   *
   * These used to be single-winding quads on a DoubleSide material, and that is
   * why half of every meadow rendered as black spikes: three.js negates the
   * shading normal on back faces, so the reverse side of an up-facing blade got
   * a normal pointing at the ground and received nothing but bounce light.
   * Two windings sharing one upward normal costs two extra triangles and no
   * extra vertices, and both sides of the blade then take the sun.
   */
  const quad = (ax: number, az: number, ox: number, oz: number, s: number): void => {
    const base = pos.length / 3;
    const w = width * s;
    const h = height * s;
    const taper = 0.62; // narrower at the tip, but not a needle
    pos.push(
      -ax * w + ox, 0, -az * w + oz,
      ax * w + ox, 0, az * w + oz,
      ax * w * taper + tiltX + ox, h, az * w * taper + tiltZ + oz,
      -ax * w * taper + tiltX + ox, h, -az * w * taper + tiltZ + oz,
    );
    // Straight UP, with none of the blade's own facing mixed in.
    //
    // Every variant that tilted the normal toward the quad's face put a black
    // blade in the frame somewhere. A pure face normal flickers black as the
    // camera orbits past the plane (the sun goes behind it). A part-face blend
    // still leaves the normal pointing AWAY from the camera on roughly half the
    // blades in any tuft, and while Lambert diffuse survives that, nothing else in
    // the pipeline does: measured in the real game, the away-facing quads rendered
    // near-black in full sun with shadows proven not to be the cause, while the
    // edge-on ones beside them were correctly lit.
    //
    // An up normal is what stylised grass cards want anyway: the blade takes the
    // same light as the ground it grows out of, from every bearing, so a tuft can
    // never fall outside the meadow's value band. The root-to-tip vertex gradient
    // carries the form instead of the normal.
    for (let i = 0; i < 4; i++) nrm.push(0, 1, 0);
    col.push(...rootC, ...rootC, ...tipC, ...tipC);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  const C60 = 0.5, S60 = 0.866;
  quad(1, 0, 0, 0, 1);
  quad(-C60, S60, 0, 0, 0.92);
  quad(-C60, -S60, 0, 0, 0.86);
  // One short offset blade breaks the perfect rosette so a clump of tufts does
  // not read as a stamped pattern.
  quad(C60, S60, 0.11, -0.08, 0.66);
  return withSway({
    pos: new Float32Array(pos),
    nrm: new Float32Array(nrm),
    col: new Float32Array(col),
    idx,
  });
}

/**
 * A blossom on a stem. `petal` is the lit face tone; `rim` the shaded outer
 * petals.
 *
 * Two tones, not one. A single-colour blossom is one flat chip of pure hue, and
 * at these saturations that is precisely what "neon and sit outside the palette
 * ... they punch out of an otherwise coherent green/tan world as pure hue chips"
 * describes. Giving the outer ring a darker, slightly desaturated version of the
 * same hue turns the chip into a small form with a lit centre and a shaded edge,
 * which is all it takes for the eye to accept it as an object in the scene.
 */
function flower(petal: number, rim: number): Template {
  const v = new VoxelModel();
  v.box(0, 0, 0, 0, 2, 0, 0x4a9a3c);
  v.set(1, 1, 0, 0x5cb44a);
  v.set(1, 3, 0, rim);
  v.set(-1, 3, 0, rim);
  v.set(0, 3, 1, rim);
  v.set(0, 3, -1, rim);
  v.set(0, 4, 0, petal);
  v.set(0, 3, 0, 0xf5e7bc);
  return bake(v, 0.11);
}

/**
 * Low rounded leaf bush — the anchor prop for meadow clumps.
 *
 * Shrub greens follow the same rule as the tree canopies: a clear step darker
 * and cooler than the meadow they sit in, or they dissolve into it. These are
 * lighter than a tree canopy (a knee-high bush really is closer to grass in
 * value than a canopy is) but no longer the same yellow-greens as the sward.
 */
function bush(): Template {
  const v = new VoxelModel();
  const c = new Canopy(v, 0x4a17);
  // No erosion at this size: the bush is barely three voxels tall, so its
  // "outer shell" is nearly the whole prop and any nibbling detaches voxels.
  // A step darker and cooler again (0x35872c -> 0x2d7325). Captured against the
  // 2026-07 meadow in _veg2e-meadow.png these sat at or just above the sward's
  // own value, so the "anchor" of a grass clump had no silhouette against the
  // grass it was supposed to anchor. A shrub is a mass of leaves shading itself;
  // it is always darker than the open lawn beside it.
  c.clump(0, 1.1, 0, 2.7, 1.5, 2.5, 0x2d7325, 0);
  c.clump(1.3, 1.6, 0.7, 1.6, 1.1, 1.5, 0x3f8e30, 0);
  c.clump(-1.4, 1.4, -0.6, 1.5, 1.0, 1.4, 0x25631f, 0);
  c.bake(0.45);
  v.set(1, 3, 0, 0x5aa843); // highlight sprig
  // 0.13 -> 0.155. The bush is the anchor of a meadow clump and at 0.13 it stood
  // 0.52 units tall against tussocks that now reach 0.63 — i.e. the "anchor" was
  // the SHORTEST thing in its own clump. 0.62 units at 1x puts it back on top of
  // the size ladder's bottom rung, still well under hedgeSmall's 0.85.
  return bake(v, 0.155);
}

/**
 * Fern: a low rosette of arched fronds. The forest floor and every damp hollow
 * needs something wider than a grass blade and shorter than a bush, and a fern's
 * splayed silhouette reads instantly as undergrowth at gameplay distance.
 */
function fern(variant: number): Template {
  const v = new VoxelModel();
  // A full step darker than it was (0x2f7a2a/0x3f9634/0x59b348). A fern grows on
  // a forest FLOOR, under a canopy, and the old set was brighter than the meadow
  // it stood on — which is backwards, and is half of why these read as decals
  // stuck on the grass rather than as plants growing in shade.
  const dark = 0x27661f;
  const mid = 0x35802a;
  const light = 0x4a9c39;
  // THE PLUS-SIGN FIX.
  //
  // The previous fern was a 3-voxel stalk with six arms of IDENTICAL length at
  // identical height, four of them on the cardinal axes — i.e. a symmetric plus
  // built from isolated cubes. Two consequences, both visible right across
  // _veg2b-forest.png, where roughly a dozen of them dot the mid-ground: the
  // shape reads as a map SYMBOL rather than as a plant, and (because it is
  // 4-fold symmetric about y) the random yaw every instance gets does nothing at
  // all to its outline, so a wood floor is the same green cross repeated. That
  // is the identical trap documented on `grassTuft` — rotational symmetry
  // cancels yaw variety — and it was never applied here.
  //
  // So: three variants, each with five to seven fronds drawn from the eight
  // compass directions, no variant using a symmetric subset, and every frond a
  // different length. Each frond carries a cell of WIDTH at its shoulder and a
  // cell UNDER its drooping tip, so it reads as a leaf with a spine rather than
  // as a row of dots — the same two corrections the palm frond needed.
  const DIRS: Array<[number, number]> = [
    [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
  ];
  /** [direction index, length] per variant. */
  const SETS: Array<Array<[number, number]>> = [
    [[0, 4], [1, 2], [2, 3], [4, 3], [5, 4], [6, 2]],
    [[0, 3], [2, 4], [3, 2], [4, 4], [6, 3], [7, 3], [1, 2]],
    [[1, 4], [2, 2], [3, 3], [5, 2], [6, 4], [7, 3]],
  ];
  v.box(0, 0, 0, 0, 3, 0, dark);
  v.set(0, 4, 0, light);
  for (const [d, len] of SETS[variant % SETS.length]) {
    const [dx, dz] = DIRS[d];
    // Perpendicular, for the shoulder cell — laid out along the frond's own
    // normal rather than a fixed axis, or the fronds pointing along z stack
    // their width cell in line with themselves and stay one voxel wide.
    const px = -dz;
    const pz = dx;
    for (let k = 1; k <= len; k++) {
      const tip = k === len;
      const y = tip ? 2 : 3;
      v.set(dx * k, y, dz * k, tip ? light : mid);
      // Width at the shoulder only — ONE cell, not two. Two put the fern at 600
      // vertices, which is more than a boulder (544) for a prop that is scattered
      // at 9% of 320 forest rolls, i.e. ~29 a chunk. The shoulder cell is the one
      // that does the work; the second just thickened a frond that is already
      // reading.
      if (k === 1) v.set(dx + px, y, dz + pz, mid);
      // Bridge under the step down to the tip, so the droop is face-connected
      // to the frond instead of hanging off its corner.
      if (tip && len >= 2) v.set(dx * (k - 1), y, dz * (k - 1), mid);
    }
  }
  // 0.19 -> 0.135 units per voxel. A frond now runs four cells instead of two,
  // so the same bake scale would have doubled the prop's world size; at 0.135 a
  // long-frond variant spans ~1.1 units against the old 0.76, i.e. a fern that
  // is now clearly WIDER than it is tall (0.68). Splayed and low is the read
  // that says undergrowth; the old proportions said shrub.
  return bake(v, 0.135);
}

/**
 * Reeds: a tight stand of tall thin stems with pale seed heads, for the very
 * edge of the water. Shorelines are the one place a stylised world cannot get
 * away with a bare colour seam — reeds break the waterline silhouette and read
 * as "this lake is alive" from right across the bay.
 */
function reeds(): Template {
  const v = new VoxelModel();
  // Stems are 2x1 voxels and a good deal shorter than they were. As 1x1 columns
  // eight voxels tall they were 1.4 units of hard-edged acid green — the tallest
  // thing for metres around, and the actual source of the "tall thin blades" and
  // "stepped cyan spikes in the bay" complaints, which read as grass but are not.
  // Widening them and dropping the height turns a picket fence into a bed.
  //
  // The colour comes down out of the acid range too: a 2-wide stem is thick
  // enough on screen that it no longer needs to be over-bright to survive
  // aliasing, so it can sit in a believable water-plant green.
  const stem = 0x5f9c46;
  const stemD = 0x4d843c;
  const head = 0xbda868;
  const offs: Array<[number, number, number]> = [
    [0, 0, 4], [2, 0, 3], [-2, 1, 4], [0, -2, 5], [2, 2, 2], [-2, -2, 3], [4, 0, 3],
  ];
  for (const [x, z, h] of offs) {
    for (let y = 0; y <= h; y++) v.box(x, y, z, x + 1, y, z, y % 3 === 0 ? stemD : stem);
    v.box(x, h + 1, z, x + 1, h + 1, z, head);
  }
  // Reeds bend with the grass. They are the one other stand of stems in the
  // file, they grow where the wind has nothing to break it, and a reed bed that
  // stayed rigid while the sward beside it waved would be the thing you notice.
  return withSway(bake(v, 0.17));
}

/**
 * Dead branch / broken stick — dry litter for forest floors and dune lines.
 * Deliberately tiny and desaturated: its job is to break up an empty patch of
 * ground, not to be looked at.
 */
function deadwood(): Template {
  const v = new VoxelModel();
  const w = 0x7d6b52;
  v.box(-2, 0, 0, 2, 0, 0, w);
  v.set(3, 0, 1, shade(w, 0.86));
  v.set(-1, 1, 0, shade(w, 1.08));
  v.set(1, 0, -1, shade(w, 0.92));
  return bake(v, 0.13);
}

/**
 * Weathered driftwood log for the beach transition band.
 *
 * Deliberately knobbly. The previous version was a smooth two-row prism, and a
 * bevelled box of one tone on flat sand reads as a bar of soap — which is what it
 * was filed as. Alternating bark values along the length, a split running down
 * one flank, and stubs sticking out at both ends give it the silhouette breaks and
 * the second tone it needs to read as wood.
 */
function driftwood(): Template {
  const v = new VoxelModel();
  const wood = 0x9b8468;
  const woodL = 0xb5a084;
  const woodD = 0x776350;
  for (let x = -3; x <= 3; x++) v.set(x, 0, 0, x % 2 === 0 ? wood : woodD);
  v.box(-2, 1, 0, 1, 1, 0, woodL);
  v.set(-1, 1, 1, woodD); // split down the flank
  v.set(2, 0, 1, wood);
  v.set(4, 0, 0, woodD); // broken tip
  v.set(-4, 1, 0, woodL); // upturned root end
  v.set(-4, 0, -1, woodD);
  v.set(1, 1, 1, shade(woodL, 0.9)); // branch stub
  return bake(v, 0.16);
}

/**
 * Fallen log — the driftwood silhouette scaled up into a real mid-scale
 * occluder: a 2-wide mossy trunk lying on its side, ~3m long, waist high.
 */
function fallenLog(): Template {
  const v = new VoxelModel();
  const bark = 0x6b4f33;
  const barkL = 0x7d5e3d;
  const moss = 0x5aa845;
  for (let x = -5; x <= 5; x++) {
    v.box(x, 0, 0, x, 1, 1, x % 3 === 0 ? bark : barkL);
  }
  v.set(6, 0, 0, shade(bark, 0.82)); // splintered end
  v.set(6, 1, 1, shade(bark, 0.9));
  v.set(-6, 1, 1, shade(barkL, 0.88)); // torn root end
  v.set(-3, 2, 0, moss);
  v.set(0, 2, 1, shade(moss, 1.08));
  v.set(2, 2, 0, moss);
  v.set(3, 2, 1, shade(moss, 0.92));
  v.set(1, 1, 2, bark); // branch stubs
  v.set(-2, 1, -1, barkL);
  return bake(v, 0.22);
}

/**
 * Waist-high hedge/bush clump — the missing size class between grass and tree.
 *
 * RASTERISED AT ROUGHLY 1.6x THE VOXEL COUNT IT USED TO BE, at the same world
 * size. This is the fix for the loudest defect in the near field: an ellipsoid
 * of radius 1.8 voxels does not rasterise to a rounded mass, it rasterises to a
 * PLUS SIGN — the axial cells are inside the radius and the diagonal ones are
 * not — and _veg2a-ground.png is full of them, waist-high green crosses sitting
 * on the meadow like map symbols. Nothing about voxel chunkiness requires that;
 * Cube World's shrubs are chunky AND rounded, which needs about five voxels
 * across the short axis before the rasteriser has enough cells to describe a
 * curve. Radii are up ~1.6x and the bake scale down by the same factor, so
 * every stamp in the world keeps the size it had.
 *
 * They also now paint through `Canopy` rather than straight into the
 * `VoxelModel`. Raw `v.ellipsoid` writes one flat colour per lobe, so a hedge
 * was three flat green patches; `Canopy` jitters each voxel on the way in and
 * then runs the crown-to-belly ramp over the finished volume, which is the same
 * treatment every tree canopy in this file gets and the reason those read as
 * volumes while these read as decals.
 *
 * Greens are a step DARKER and cooler than they were (0x347f2a -> 0x2c6f24 for
 * the body). A shrub standing on lit meadow has to be darker than the sward or
 * it has no silhouette; the old set sat at or above the grass's own value and
 * the crosses read as bright green rather than as shade.
 */
function hedgeClump(): Template {
  const v = new VoxelModel();
  v.box(0, 0, 0, 0, 2, 0, 0x6a5233);
  const c = new Canopy(v, 0x7c31);
  c.clump(0, 3.5, 0, 5.4, 3.8, 4.5, 0x2c6f24, 0.34);
  c.clump(4.1, 4.1, -1.6, 3.5, 3.0, 3.2, 0x387f2c, 0.34);
  c.clump(-3.8, 3.2, 1.9, 3.2, 2.7, 3.0, 0x235c1e, 0.30);
  c.clump(0.6, 6.6, 0.3, 2.6, 1.9, 2.4, 0x428a33, 0.38);
  // 0.85, not the canopy's full 1.0: a hedge is about a third of a tree crown's
  // height, so the ramp's five rows cover proportionally more of it.
  c.bake(0.85);
  v.set(-2, 8, 2, 0x5fb542); // stray sprig breaks the dome
  return bake(v, 0.152);
}

/**
 * Knee-high hedge — the fourth rung on the size ladder. The world previously
 * jumped grass (~0.4) -> hedgeClump (~1.7) -> tree (~5) with nothing between
 * the first two, so every mid-ground bush repeated at one height. This one is
 * deliberately ~60% of hedgeClump and rounder, and it reads as a different
 * plant rather than a shrunk copy.
 *
 * Same rasterisation and shading rebuild as `hedgeClump` above, and the same
 * reason: at radius 1.8 voxels this was the worst plus-sign in the file, and it
 * is also the most numerous mid-ground prop (2-4 per knot, ~1.5 knots a chunk).
 */
function hedgeSmall(): Template {
  const v = new VoxelModel();
  const c = new Canopy(v, 0x91f7);
  c.clump(0, 2.1, 0, 3.1, 2.1, 2.8, 0x316f26, 0.32);
  c.clump(2.1, 1.9, 1.0, 1.9, 1.6, 1.7, 0x3d8530, 0.32);
  c.clump(-1.9, 1.7, -0.9, 1.7, 1.4, 1.5, 0x275c1e, 0.28);
  c.bake(0.8);
  v.set(0, 5, 0, 0x51a13a); // sprig off the crown
  v.set(-2, 4, 2, 0x4a9835);
  return bake(v, 0.14);
}

/**
 * Tiny shell/pebble dots scattered on the sand.
 *
 * These were three isolated 1x1x1 cubes of near-white, which is the worst
 * possible shape for a sunlit beach prop: a lone cube shows one lit top and
 * three or four vertical faces that catch almost no sun, so on bright sand they
 * read as cream-topped BLACK dice at maximum contrast. Two changes fix it
 * without losing the scatter — each dot is now 2x1 in plan and only one voxel
 * tall (so the lit top dominates its own silhouette), and the palette drops to a
 * shell tone that is barely off the sand's own value instead of near-white, so
 * even a badly-lit face cannot open a hole in the beach.
 */
function shells(): Template {
  const v = new VoxelModel();
  // Each dot is a 2x1 pale top with a DARKER cell butted against it, so the prop
  // is a two-tone flake rather than a single-value slab. Flat, uniform, rounded
  // 2x1 blocks with one bright top and one dark side were filed — accurately — as
  // "bars of soap on the beach"; the second tone plus the deliberately uneven
  // outline is what turns each one into a shell chip or a pebble.
  // Barely off the sand. Squashing these to 45% height (see the stamp) made their
  // lit tops the whole prop, and at the old near-white values that turned each dot
  // into a bright plate lying on the beach — dominoes rather than shell grit. A
  // scatter prop whose only job is to break up an empty surface must stay inside
  // that surface's own value band.
  const pale = 0xd9c9a8;
  const mid = 0xc9b997;
  const dark = 0xb7a685;
  v.box(0, 0, 0, 1, 0, 0, pale);
  v.set(2, 0, 0, dark);
  v.box(3, 0, 2, 4, 0, 2, mid);
  v.set(3, 0, 3, dark);
  v.box(-2, 0, 3, -1, 0, 3, pale);
  v.set(-2, 0, 4, dark);
  v.set(1, 0, 5, mid);
  return bake(v, 0.085);
}

function mushroom(): Template {
  const v = new VoxelModel();
  v.box(0, 0, 0, 0, 2, 0, 0xdcd4c2);
  // Cap chroma is down ~30% and pushed toward brick/terracotta: 0xd5483e was a
  // pure hue chip that punched a hole in the forest palette. The crown is the
  // lit tone, the skirt a step darker, so the cap has two tones like a real one.
  v.box(-1, 3, -1, 1, 3, 1, 0xa8564a);
  v.set(0, 4, 0, 0xc26a58);
  v.set(-1, 3, 0, 0xe0d8c8);
  v.set(1, 3, -1, 0xe0d8c8);
  return bake(v, 0.14);
}

// ---------------------------------------------------------------------------

interface FoliageFadeUniforms {
  bsFoliageFocus: { value: THREE.Vector2 };
  bsFoliageFadeStart: { value: number };
  bsFoliageFadeEnd: { value: number };
}

/**
 * The camera→hero segment, shared by BOTH prop materials. One object, assigned
 * into each compiled shader, so the per-frame update is two number writes and a
 * vector copy rather than a walk over materials.
 */
interface OcclusionUniforms {
  /** Camera position, world space. */
  bsOccludeEye: { value: THREE.Vector3 };
  /** Eye→pivot, NOT normalised: its length is the segment the cut-away covers. */
  bsOccludeAxis: { value: THREE.Vector3 };
  /** Radius of the erased tube around that segment, world units. */
  bsOccludeRadius: { value: number };
  /** 0 disables the whole thing (`?occlude=0`, and every zone with no camera). */
  bsOccludeStrength: { value: number };
}

/**
 * Fade a shared prop material by WORLD distance with real alpha coverage.
 *
 * Screen-door opacity left visible stipple on a blue horizon, and fading toward
 * the sky colour painted blue ghost trees over nearer terrain. Soft chunks
 * render far-to-near. Solid chunks use explicit alpha blending in the opaque
 * list so GTAO still sees trees and rocks; depth writes stay on, so the nearest
 * voxel face supplies one stable translucent silhouette. The outer chunk is
 * fully clear before its whole mesh is culled.
 *
 * ...and CUT AWAY whatever stands between the camera and the hero (issue #135),
 * which is the same injection point and the opposite technique, for a reason
 * worth writing down.
 *
 * The distance fade lowers `gl_FragColor.a` and lets blending do the work. That
 * cannot solve occlusion, because DEPTH IS THE PROBLEM. Both prop materials
 * write depth and sit in the opaque list, which three sorts front-to-back — so
 * a hut in front of the hero is drawn FIRST, stamps the depth buffer, and the
 * hero is rejected behind it. A wall at alpha 0.05 hides the player exactly as
 * well as one at 1.0. The only fragment operation that frees the depth buffer
 * is `discard`, and a discard is binary, so the softness has to come from
 * WHICH fragments are discarded: a stipple, driven by a per-pixel hash against
 * the cut strength. That is the screen-door the horizon fade rejected, used
 * here because the tradeoff inverts — at two metres the pattern reads as a
 * deliberate cut-away, and there is no alternative that keeps the hero drawn.
 *
 * One tube, not a per-object test. Nothing here knows or cares whether the
 * fragment belongs to an oak, a palisade or a market stall — settlements are
 * stamped onto `solidMat` too (see world/towns.ts) — so "trees or other world
 * structures" is one uniform rather than an occluder registry.
 */
function installFoliageFade(
  mat: THREE.Material,
  uniforms: FoliageFadeUniforms,
  occlude: OcclusionUniforms,
  key: string,
): void {
  const previousCompile = mat.onBeforeCompile;
  const previousKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = (): string => `${previousKey()}|bsFoliageFade:${key}`;
  mat.onBeforeCompile = (shader, renderer): void => {
    previousCompile.call(mat, shader, renderer);
    Object.assign(shader.uniforms, uniforms, occlude);
    shader.vertexShader = shader.vertexShader
      // The occlusion cut-away needs all three components; the distance fade
      // takes `.xz` off the same varying rather than paying for a second one.
      .replace('#include <common>', '#include <common>\nvarying vec3 bsFoliageWorld;')
      // After sway has changed `transformed`, so bent grass fades where it is
      // drawn rather than where the unbent template happened to be authored.
      .replace('#include <project_vertex>',
        'bsFoliageWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#include <project_vertex>');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 bsFoliageWorld;
uniform vec2 bsFoliageFocus;
uniform float bsFoliageFadeStart;
uniform float bsFoliageFadeEnd;
uniform vec3 bsOccludeEye;
uniform vec3 bsOccludeAxis;
uniform float bsOccludeRadius;
uniform float bsOccludeStrength;`)
      // BEFORE any shading work, and before the depth write that is the whole
      // point — see the block comment on this function.
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
if (bsOccludeStrength > 0.0) {
  vec3 bsRel = bsFoliageWorld - bsOccludeEye;
  float bsLen2 = max(dot(bsOccludeAxis, bsOccludeAxis), 1e-4);
  float bsT = clamp(dot(bsRel, bsOccludeAxis) / bsLen2, 0.0, 1.0);
  float bsRadial = length(bsRel - bsOccludeAxis * bsT);
  // NO TAPER ALONG THE SEGMENT, at either end, and both ends were tried:
  //
  //   far   0.86, then 0.94, to spare the bush the hero is standing in. But the
  //         segment already STOPS at his chest — nothing behind him is in the
  //         tube at all — so all a far taper spares is the leaves he is standing
  //         AMONG, and a partial cut is a stipple. Photographed inside an oak,
  //         his face and arms came back checkered.
  //   near  0.06 of the arm, to keep the frame from flickering as the damped
  //         arm crossed a surface. Wrong for a worse reason: when the camera is
  //         INSIDE a crown, the leaf it has its nose in is the whole screen and
  //         sits at t ~ 0, so the taper spared exactly the fragments that were
  //         hiding everything. That is what the checkered hero actually was —
  //         a half-cut leaf a hand's width from the lens, not foliage near him.
  //
  // So the cut is flat over the whole segment, and the only softness left is
  // radial. Fragments behind the eye clamp to t = 0 and are measured from it,
  // which costs nothing: they are behind the camera.
  float bsCut = bsOccludeStrength
    // 0.8, so four fifths of the tube is a CLEAN hole and only its rim
    // stipples — the transition should read as a soft edge to the hole, not as
    // a haze the character is standing behind.
    * (1.0 - smoothstep(bsOccludeRadius * 0.8, bsOccludeRadius, bsRadial));
  // Interleaved gradient noise: one line, no texture, and stable under a still
  // camera, so the stipple reads as a screen-door rather than as crawling snow.
  float bsNoise = fract(52.9829189 * fract(dot(gl_FragCoord.xy,
    vec2(0.06711056, 0.00583715))));
  if (bsCut > bsNoise) discard;
}`)
      .replace('#include <opaque_fragment>', `
float bsFoliageAlpha = 1.0 - smoothstep(
  bsFoliageFadeStart, bsFoliageFadeEnd,
  distance(bsFoliageWorld.xz, bsFoliageFocus)
);
#include <opaque_fragment>
gl_FragColor.a *= bsFoliageAlpha;`);
  };
}

export class PropLib {
  readonly solidMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.9, metalness: 0,
    // Keep solid props in GTAO. Explicit factors bypass three's opaque
    // NormalBlending shortcut, the same subtle split water.ts relies on.
    transparent: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  // Front-side: the grass billboards carry both windings themselves (see
  // grassBillboard), and every other soft prop is a closed voxel volume. Using
  // DoubleSide here instead inverted the shading normal on every blade's reverse
  // face and turned half the meadow black.
  readonly softMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1.0, metalness: 0, transparent: true,
  });
  private readonly fadeFocus = new THREE.Vector2();
  private readonly solidFade: FoliageFadeUniforms = {
    bsFoliageFocus: { value: this.fadeFocus },
    bsFoliageFadeStart: { value: 128 },
    bsFoliageFadeEnd: { value: 160 },
  };
  private readonly softFade: FoliageFadeUniforms = {
    bsFoliageFocus: { value: this.fadeFocus },
    bsFoliageFadeStart: { value: 96 },
    bsFoliageFadeEnd: { value: 128 },
  };
  /**
   * Shared by both materials, so a tree's trunk and the grass at its foot are
   * cut by one tube and cannot disagree at their seam.
   *
   * RADIUS 1.5 is the hero's silhouette plus room to read it: he is ~0.55 m
   * across the shoulders and the tube has to clear the sword arc and the
   * mounted framing too. Wider erases half a hut for one trunk; narrower and
   * the stipple hole is smaller than the character standing in it.
   * STRENGTH starts at 0 — a zone with no camera feeding it, or `?occlude=0`,
   * must compile the branch and take it never.
   */
  private readonly occlude: OcclusionUniforms = {
    bsOccludeEye: { value: new THREE.Vector3() },
    bsOccludeAxis: { value: new THREE.Vector3() },
    bsOccludeRadius: { value: 1.5 },
    bsOccludeStrength: { value: 0 },
  };

  readonly oakA = oakTree(false);
  readonly oakB = oakTree(true);
  readonly oakC = oakTreeTall();
  readonly oakD = oakTreeBroad();
  readonly birch = birchTree();
  readonly pine = pineTree(false);
  readonly pineTall = pineTree(true);
  readonly pineIrr = pineIrregular();
  readonly snag = deadSnag(false);
  readonly snagTall = deadSnag(true);
  // Leans are HALVED from 0.25/0.1/0.34. Lean is a slope, so it costs
  // `height * lean` of horizontal drift, and once the bole went from 11 voxels
  // to 22 the old slopes threw the crown 5+ voxels sideways — a palm bent
  // almost flat, and one whose registered climbable trunk (recorded at the base,
  // see the tree pass) no longer had much to do with where its head was.
  readonly palm = palmTree(6, 0.12, 1.0);
  readonly palmB = palmTree(5, 0.05, 0.82);
  readonly palmC = palmTree(7, 0.17, 1.2);
  readonly cactusBig = cactus(false);
  readonly cactusSmall = cactus(true);
  readonly rockA = rock(0);
  readonly rockB = rock(1);
  readonly rockSnow = rock(2);
  /** Same two boulders wearing a lichen crust — see `rock`. Grass biomes only. */
  readonly rockAMoss = rock(0, true);
  readonly rockBMoss = rock(1, true);
  /** Four asymmetric wet-meadow tussocks, and four dune ones. */
  readonly tufts = [0, 1, 2, 3].map((k) => grassTuft(false, k));
  readonly tuftsDry = [0, 1, 2, 3].map((k) => grassTuft(true, k));
  /** The carpet: the same two palettes at a third of the tussock's vertices. */
  readonly sprigs = [0, 1, 2, 3].map((k) => grassSprig(false, k));
  readonly sprigsDry = [0, 1, 2, 3].map((k) => grassSprig(true, k));
  /**
   * Non-green ground-cover drifts. Five hues, each a step off full chroma: two
   * that a temperate meadow really carries (heather and buttercup), a clover
   * red, a chalk-white yarrow and a rust for dry ground. Placement picks one per
   * clump-cluster and holds it over the whole drift, so a hillside shows
   * PATCHES of one colour rather than a confetti of five.
   */
  readonly bloomHeather = bloomMat(0x9b82c4, 0x77619c, 0x3f7a35);
  readonly bloomButter = bloomMat(0xe3c95e, 0xbfa544, 0x437f37);
  readonly bloomClover = bloomMat(0xcf7f76, 0xa85f58, 0x3d7a33);
  readonly bloomYarrow = bloomMat(0xe4dcc6, 0xbdb39c, 0x467f38);
  readonly bloomRust = bloomMat(0xc98a55, 0xa16a3e, 0x6e7a3a);
  // Width is the HALF-width of a quad. Heights are all a fraction of the 1-unit
  // terrain step (see grassBillboard) and the tufts are correspondingly WIDER
  // relative to their height than before: short and broad reads as ground cover,
  // tall and thin reads as reeds.
  // Heights up ~30% (0.30/0.36/0.22 -> 0.39/0.46/0.29) and widths ~15%. The old
  // set was tuned down from a 0.42-0.95 range that read as a reed swamp, and the
  // correction overshot: at 0.22-0.36 units against a 1-unit terrain step a blade
  // was shorter than the ground's own relief and never broke the silhouette of
  // the terrace behind it, so nothing in a meadow registered as grass at all. The
  // tallest ordinary blade is still under half a step, which is the line that
  // separates ground cover from reeds.
  readonly grassA = grassBillboard(0.03, 0.02, 0.39, 0.115);
  readonly grassB = grassBillboard(-0.05, 0.03, 0.46, 0.132);
  readonly grassC = grassBillboard(0.02, -0.04, 0.29, 0.098);
  // A slightly taller, yellower tussock for the odd anchor in a meadow — still
  // barely half a step, so it adds a second height without adding reeds.
  readonly grassTall = grassBillboard(-0.03, 0.05, 0.62, 0.12, lin(0x35701c), lin(0x93c14a));
  // Dune grass for the grass/sand transition band. Sits just off the sand's own
  // value the way the meadow blades sit just off the sward's — the old pair were
  // a fixed khaki that clashed wherever the sand ran light.
  // Narrower and darker than they were: a dune blade's whole failure mode is
  // reading as a broad pale sheet, and both halves of that are fixed by taking
  // width out and pulling the tip down toward the sand's own value.
  readonly grassDuneA = grassBillboard(0.04, 0.02, 0.30, 0.062, lin(0x8a8049), lin(0xb0a468));
  readonly grassDuneB = grassBillboard(-0.04, -0.03, 0.23, 0.055, lin(0x8a8049), lin(0xb0a468));
  readonly bushT = bush();
  /** Three asymmetric fern rosettes — see `fern` for why one was not enough. */
  readonly ferns = [0, 1, 2].map((k) => fern(k));
  readonly reedsT = reeds();
  readonly deadwoodT = deadwood();
  readonly driftwoodT = driftwood();
  readonly logT = fallenLog();
  readonly hedgeT = hedgeClump();
  readonly hedgeSmallT = hedgeSmall();
  readonly shellT = shells();
  // Chroma pulled down roughly 30% and every hue shifted into the world's light:
  // the red is now a warm coral rather than a fire-engine chip, the magenta a
  // dusty rose, the yellow a butter rather than a highlighter. Each has a
  // darker, slightly greyer rim tone (see `flower`).
  readonly flowerR = flower(0xdd7a68, 0xb85a4e);
  readonly flowerY = flower(0xe8c765, 0xc6a34a);
  readonly flowerP = flower(0xd292b0, 0xb0708f);
  readonly flowerW = flower(0xefe9dc, 0xcdc5b6);
  readonly flowerO = flower(0xe09b5e, 0xbc7a44);

  /** Install after the optional sway patch so both shader edits compose. */
  installDistanceFade(): void {
    installFoliageFade(this.solidMat, this.solidFade, this.occlude, 'solid');
    installFoliageFade(this.softMat, this.softFade, this.occlude, 'soft');
  }

  /**
   * Point the cut-away tube at the camera→hero segment for this frame.
   *
   * `strength` is the switch AND the ramp: the caller hands over 0 when the
   * hero is not on screen to protect (a cutscene, a zone with no third-person
   * camera, `?occlude=0`) and 1 in normal play. Nothing here smooths it — the
   * segment moves with the camera, which is already damped.
   */
  updateOcclusion(eye: THREE.Vector3, pivot: THREE.Vector3, strength: number): void {
    this.occlude.bsOccludeEye.value.copy(eye);
    this.occlude.bsOccludeAxis.value.copy(pivot).sub(eye);
    this.occlude.bsOccludeStrength.value = strength;
  }

  /** The live cut-away tube, for `__dbgOcclusion`. */
  debugOcclusion(): { strength: number; radius: number; length: number } {
    return {
      strength: this.occlude.bsOccludeStrength.value,
      radius: this.occlude.bsOccludeRadius.value,
      length: this.occlude.bsOccludeAxis.value.length(),
    };
  }

  /** Update the shared shader once per rendered frame; no per-chunk uniforms. */
  updateDistanceFade(x: number, z: number): void {
    this.fadeFocus.set(x, z);
  }

  /**
   * Grass uses the player's choice. Tall silhouettes keep one extra 32m chunk,
   * capped at the terrain streamer's 160m cardinal reach.
   */
  setDistanceFade(grassEnd: number): void {
    const solidEnd = Math.min(grassEnd + 32, 160);
    this.softFade.bsFoliageFadeStart.value = Math.max(0, grassEnd - 32);
    this.softFade.bsFoliageFadeEnd.value = grassEnd;
    this.solidFade.bsFoliageFadeStart.value = Math.max(0, solidEnd - 32);
    this.solidFade.bsFoliageFadeEnd.value = solidEnd;
  }

  dispose(): void {
    this.solidMat.dispose();
    this.softMat.dispose();
  }
}

const mushroomT = mushroom();

/**
 * The linear colours the two tussock palettes are authored around.
 *
 * Used to blend each stamped tuft toward the ground under it: `Accum.add`
 * MULTIPLIES the template's colours by the tint, so dividing the sampled ground
 * colour by the template's own reference colour yields the factor that would turn
 * the tuft exactly into that ground colour, and lerping the tint from 1 toward
 * that factor is a partial blend. A tuft that shares its host's hue plants into
 * the sward; one authored at a fixed green sits on top of it as a pale claw,
 * which is what "reads as mould" describes.
 */
const TUFT_REF = lin(0x58a83c);
const TUFT_REF_DRY = lin(0xc4b473);
/** Clamp a ground-blend tint so a snow or lake-bed sample cannot blow one out. */
const clampTint = (v: number): number => (v < 0.5 ? 0.5 : v > 1.7 ? 1.7 : v);

export interface ChunkProps {
  solid: THREE.Mesh | null;
  soft: THREE.Mesh | null;
  /**
   * Trees placed in this chunk, flat, stride `TREE_STRIDE`:
   * `[worldX, worldZ, solidR^2, climbR^2, trunkTopY, crownR^2, crownCy, crownRy]`.
   *
   * Flat because this is read by `World.climbTopAt` and `trunkSolidTopAt` from
   * the player's per-frame update — a short linear scan over one chunk's
   * numbers, with no objects to chase and nothing allocated at the call site.
   * The chunk that built it owns it; `world/index.ts` buckets it by chunk key
   * and drops it on unload.
   */
  trunks: number[];
}

/** Numbers per tree in `ChunkProps.trunks`. */
export const TREE_STRIDE = 8;

/**
 * Extra reach around a trunk's own half-width before it counts as CLIMBABLE, in
 * world units. Roughly the hero's BODY_RADIUS (0.32): he grabs the bark when his
 * shoulder is against it, not when his centre is inside it.
 *
 * Deliberately not applied to the solid radius, which stays the geometric bark:
 * the player controller does its own body-width probing, and inflating the
 * cylinder here as well would stop him a third of a unit short of the tree.
 */
const TRUNK_GRAB = 0.34;

/**
 * World-space points props must keep clear of (spawn + shop dens).
 *
 * `kind` splits the exclusion by prop class, which matters enormously:
 *  - 'solid' (default) only holds back shadow-casting occluders — trees,
 *    boulders, hedges, logs, cacti, mushrooms, driftwood. Grass billboards,
 *    flowers, tufts and shells still grow right up to the pagoda deck.
 *  - 'all' clears every class (use sparingly — a bare disc reads as a bug).
 *
 * The old code applied ONE 7.5m radius to every class around spawn AND each
 * of the four dens, which merged into a single ~20m bald plane exactly where
 * the camera lives. Soft props are the cheapest thing in the world and the
 * only thing that makes the near ground read as ground, so they get no disc.
 */
export type Exclusion = {
  x: number;
  z: number;
  kind?: 'solid' | 'all';
  /**
   * Clearance radius override, world units. Absent means the default pair below
   * (4.5m for occluders, 9.5m for trees), which is sized for a single building.
   *
   * A TOWN needs its own number and cannot use a scaled default: the Encampment
   * is a 19-unit footprint, so a 4.5m disc would leave oaks growing through the
   * tents and boulders inside the palisade. Given explicitly, this radius is
   * used for BOTH classes plus the tree margin, so a town keeps its own ground
   * and the treeline starts a few metres outside the wall.
   */
  r?: number;
};

/**
 * How far a solid prop, and a tree, must stay from a road centreline.
 *
 * The road is 5.6 units wide and its earthworks reach 13, so these are not about
 * the carriageway being blocked — nothing collides with a tree's crown — but
 * about what a road LOOKS like. A boulder half-buried in the verge reads as a
 * bug, and an oak rooted 7 metres out puts a ten-metre canopy directly over the
 * road, which is the same "the near crown fills the frame" problem TREE_CLEAR_R2
 * was raised for. Beyond these the forest closes back in, which is what makes
 * the corridor read as cut.
 */
const ROAD_SOLID_CLEAR = 7.5;
const ROAD_TREE_CLEAR = 12;
/**
 * Soft props — grass, flowers, sprigs — stop at the ribbon's rim.
 *
 * The one place in this world where a blanket soft exclusion is right. Soft
 * props are otherwise never held back (see Exclusion: a bare disc reads as a
 * bug), but a carriageway with meadow tussocks growing out of it is not a road,
 * and the ribbon covers the ground here anyway so there is no bald patch to
 * leave behind. DECK_EDGE + 0.4, so the sward closes right up to the verge.
 *
 * Derived from DECK_EDGE rather than written out as 5.4, because "the rim of
 * the drawn road" is the fact this number is about and the two must not drift.
 */
const ROAD_SOFT_CLEAR = DECK_EDGE + 0.4;

/**
 * How far a meadow clump throws its members from its own centre.
 *
 * The sprig carpet's disc is the widest of them (2.2 units — see the clump
 * pass), so a clump centred further than `ROAD_SOFT_CLEAR + CLUMP_REACH` from a
 * carriageway cannot put anything on one, and pays for no per-stamp road query
 * at all. Every clump nearer than that tests each stamp individually.
 *
 * That split is the whole cost story of this fix, and it holds: measured by
 * walking the trunk road with `?perf=1&fps=0` — the worst case, since every
 * chunk streamed on that route carries the corridor — the `world` section over
 * chunk-building frames is 12.5 ms mean before and 12.4 after, three
 * interleaved runs each, against a run-to-run spread of about a millisecond.
 * The per-stamp query is free at this resolution because it never fires
 * anywhere but beside a road.
 */
const CLUMP_REACH = 2.2;

/** Squared clearance radius for solid occluders (~4.5m). */
const SOLID_CLEAR_R2 = 20;
/**
 * Squared clearance radius for TREES specifically (~9.5m).
 *
 * Trees need their own, much wider disc than boulders and hedges do, and the
 * reason is the crown rather than the trunk: a canopy is 7-10 units across and
 * starts 4-6 units up, so a tree rooted at the 4.5m occluder radius has its
 * foliage hanging directly over the spawn point and the den decks. Captured at
 * the old radius right after the tree rescale, the spawn frame was a third
 * black — near crown voxels, each one now half a unit across, filling the
 * screen between the camera and the hero.
 *
 * 9.5m is the crown radius (~5) plus the camera's arm (7.4) with the pitch
 * taken out of it, i.e. the distance at which the nearest branch clears the
 * lens. Boulders, hedges, logs and mushrooms still come right up to 4.5m, so
 * the clearing reads as a glade rather than as a bald disc.
 */
const TREE_CLEAR_R2 = 90;

export function* buildChunkPropsSteps(
  cx: number,
  cz: number,
  terrain: Terrain,
  lib: PropLib,
  exclusions: readonly Exclusion[],
  roads: RoadClearance | null = null,
): Generator<void, ChunkProps, void> {
  const rng = mulberry32(Math.floor(hashCell(terrain.seed, cx, 91, cz) * 0xffffffff));
  const solid = new Accum();
  // The soft mesh is the one that bends: it is the only user of `softMat`, and
  // therefore the only mesh world/sway.ts's shader ever runs on. Gated on the
  // flag so `?sway=0` prices the WHOLE feature — the attribute's byte a vertex
  // and the bounding-sphere pad included — rather than just the shader.
  const soft = new Accum(flags.sway);
  const trunks: number[] = [];
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  const ci: ColumnScratch = makeScratch();

  /**
   * Distance from (x, z) to the nearest carriageway centreline, Infinity in a
   * world with no roads — and the number is also left in `roadDist` for the
   * callers that want it after an exclusion test has already paid for it.
   *
   * The one place in this file that talks to the road network. See
   * `RoadClearance` in roads.ts for why every placer has to.
   */
  let roadDist = Infinity;
  const roadDistAt = (wx: number, wz: number): number => {
    roadDist = roads === null ? Infinity : roads.distanceTo(wx, wz);
    return roadDist;
  };

  /** Occluders (trees/rocks/hedges/logs/cacti) keep a small disc clear. */
  const exSolid = (wx: number, wz: number): boolean => {
    for (let i = 0; i < exclusions.length; i++) {
      const e = exclusions[i];
      const dx = wx - e.x;
      const dz = wz - e.z;
      const r2 = e.r === undefined ? SOLID_CLEAR_R2 : e.r * e.r;
      if (dx * dx + dz * dz < r2) return true;
    }
    return roadDistAt(wx, wz) < ROAD_SOLID_CLEAR;
  };

  /** Trees keep a far wider disc than any other occluder — see TREE_CLEAR_R2. */
  const exTree = (wx: number, wz: number): boolean => {
    for (let i = 0; i < exclusions.length; i++) {
      const e = exclusions[i];
      const dx = wx - e.x;
      const dz = wz - e.z;
      // A town's own radius plus a CROWN's reach, not a trunk's. Measured at
      // +4 (_town-camp-in2.png): oaks rooted 25 units from the Encampment's
      // centre hung their canopies four metres inside the palisade, so the camp
      // was roofed over by a forest that was technically outside it. A crown is
      // 7-10 units across, hence +9.
      const r = e.r === undefined ? 0 : e.r + 9;
      const r2 = e.r === undefined ? TREE_CLEAR_R2 : r * r;
      if (dx * dx + dz * dz < r2) return true;
    }
    return roadDistAt(wx, wz) < ROAD_TREE_CLEAR;
  };

  /**
   * Is this point on the road surface? — the ONE road question this file asks,
   * and it is asked about the point a thing is actually STAMPED at.
   *
   * That last clause is the whole of the "grass grows through the road floor"
   * fix. Every pass below used to test the road at the CENTRE of a clump or at
   * the centre of a column and then scatter its members up to 2.2 units away
   * from it, so a clump centred 5.5 units off a carriageway — comfortably clear
   * by its own test — planted sprigs 3.3 units off it, which is inside the
   * ribbon. There they were seated on the floored terrain column, and the
   * column beside a road is levelled to `round(deck)`: up to half a unit ABOVE
   * the ramped surface the ribbon is drawn on (roads.ts, `carveAt`). Grass
   * standing half a unit proud of a road it is not supposed to be on is exactly
   * what a player sees as blades poking through the floor.
   */
  const onRoad = (wx: number, wz: number): boolean =>
    roadDistAt(wx, wz) < ROAD_SOFT_CLEAR;

  /** Grass/flowers/shells: only 'all' discs stop them. */
  const exSoft = (wx: number, wz: number): boolean => {
    for (let i = 0; i < exclusions.length; i++) {
      if (exclusions[i].kind !== 'all') continue;
      const dx = wx - exclusions[i].x;
      const dz = wz - exclusions[i].z;
      if (dx * dx + dz * dz < SOLID_CLEAR_R2) return true;
    }
    return onRoad(wx, wz);
  };

  /**
   * Has a settlement worn the grass off this column? — the SOFT half of the
   * trodden-ground treatment (terrain.ts `GroundPatch` is the colour half).
   *
   * Two things about how this is written matter more than the rule itself.
   *
   * A PURE HASH, not `rng()`. Drawing here would advance the per-chunk stream,
   * and that stream places every tree, boulder and tussock in the world — a
   * single extra draw in one branch re-scatters the vegetation of every chunk
   * on the map. `hashCell` on the column is deterministic, costs the same, and
   * is bit-for-bit inert where there are no settlements.
   *
   * 1/0.6, not 1. `ci.trample` ramps down over the several metres at the edge
   * of a town, and `columnInfo` flips `biome` to 'trampled' — which every pass
   * here rejects outright — at 0.6. So the cull has to have taken everything by
   * the time it gets there, or the sward would drop from 40% to nothing on a
   * circle. Scaled this way the two meet at zero and the grass thins smoothly
   * from the meadow to the bare yard, which is what a camp edge looks like.
   */
  const trodden = (wx: number, wz: number, wear: number): boolean =>
    hashCell(terrain.seed, wx, 313, wz) < wear * (1 / 0.6);

  /**
   * Should this ONE stamp be dropped to honour a nature density of `f`?
   * True means drop it. See world/nature.ts.
   *
   * A PURE HASH, for exactly the reason `trodden` above gives: drawing here
   * would advance the per-chunk stream and re-scatter the vegetation of every
   * chunk in the world, so a density knob would change the placement of things
   * it does not govern. `salt` separates the decisions — the same column must
   * not lose its rock and its sprig together, or thinning would carve visible
   * bald patches instead of thinning evenly.
   *
   * `f >= 1` returns false WITHOUT hashing, which is what makes the shipped
   * world bit-for-bit what it was: at the baseline this function is inert.
   *
   * It only ever REMOVES. Placements that come in groups (a clump's tussocks, a
   * boulder outcrop, a reed stand) scale their COUNT instead and so grow past 1;
   * a lone stamp on a ladder band has nowhere to put a second one, and saying so
   * is better than inventing a position for it.
   */
  const thin = (wx: number, wz: number, salt: number, f: number): boolean =>
    f < 1 && hashCell(terrain.seed, wx, salt, wz) >= f;

  /**
   * The height a SOFT prop sits at, given the column height a caller already
   * paid for.
   *
   * Near a road the column is run through the road field's `surfaceAt` — the
   * same rule `Terrain.getHeight` uses and the same one the ribbon mesh is
   * drawn on, so a soft prop stands on the DECK rather than on the terrace
   * beside it. That matters because the floored column next to a carriageway is
   * levelled to `round(deck)` and can sit half a unit ABOVE the surface the
   * ribbon draws (roads.ts, `carveAt`).
   *
   * `rf.surfaceAt(x, z, column)` and not `terrain.getHeight(x, z)`, which would
   * be the obvious call: `getHeight` re-derives the column from a fresh
   * `heightCont`, and `heightCont` is the dominant cost in this whole file, so
   * the obvious call pays for the same column twice. Handing it the one the
   * caller already has makes the whole branch a single `nearest`. (Both
   * versions measured the same on a road walk — 12.4 ms mean on the `world`
   * section over chunk-building frames — because the branch only ever runs on
   * stamps beside a carriageway. Doubling a chunk's dominant query on a path
   * that could widen later is still not a thing to leave lying about.)
   *
   * With `ROAD_SOFT_CLEAR` at DECK_EDGE + 0.4 the two answers AGREE for every
   * stamp that survives `onRoad`, because `surfaceAt` hands back the plain
   * ground outside the rim; the sward is bit-identical with and without this.
   * It is here so that stays true BY CONSTRUCTION rather than by the exclusion
   * radius happening to exceed the ribbon's — shrink the clearance and the
   * grass at the rim rides the deck instead of poking through it.
   */
  const softSeat = (x: number, z: number, column: number, nearRoad: boolean): number => {
    const rf = terrain.roads;
    return nearRoad && rf !== null ? rf.surfaceAt(ox + x, oz + z, column) : column;
  };

  const flatEnough = (wx: number, wz: number, h: number, tol: number): boolean =>
    Math.abs(terrain.getHeight(wx + 1, wz) - h) <= tol &&
    Math.abs(terrain.getHeight(wx - 1, wz) - h) <= tol &&
    Math.abs(terrain.getHeight(wx, wz + 1) - h) <= tol &&
    Math.abs(terrain.getHeight(wx, wz - 1) - h) <= tol;

  /**
   * Stamp one tussock: a random one of the four silhouettes, a full circle of
   * yaw, and a tint blended 45% toward the ground colour sampled beneath it.
   * Sunk 0.07 so the dark root row is half buried and the tuft has a contact
   * shadow of its own rather than resting on the surface.
   *
   * NOTE: clobbers `ci`. Every caller reads what it needs from `ci` first.
   *
   * `nearRoad` is the caller saying "this stamp is close enough to a
   * carriageway that it has to be checked one by one" — see `softSeat`.
   */
  const addTuft = (
    dry: boolean, x: number, z: number, yaw: number, scl: number, vmul: number,
    nearRoad = false,
  ): void => {
    if (nearRoad && onRoad(ox + x, oz + z)) return;
    terrain.columnInfo(ox + Math.floor(x), oz + Math.floor(z), ci);
    if (ci.h < WATER_LEVEL + 1) return;
    const ref = dry ? TUFT_REF_DRY : TUFT_REF;
    const tpl = (dry ? lib.tuftsDry : lib.tufts)[Math.floor(rng() * 3.999)];
    const B = 0.45;
    soft.add(
      tpl, x, softSeat(x, z, ci.h, nearRoad) - 0.07, z, yaw, scl,
      clampTint(1 - B + B * (ci.topR / ref[0])) * vmul,
      clampTint(1 - B + B * (ci.topG / ref[1])) * vmul,
      clampTint(1 - B + B * (ci.topB / ref[2])) * vmul,
    );
  };

  /**
   * Stamp one carpet sprig. Deliberately NOT a cheaper `addTuft`: it takes the
   * tint already computed for the clump and asks the terrain only for a column
   * height, where `addTuft` runs a full `columnInfo` (two fbm(3) fields plus the
   * whole biome colour blend) for every single instance.
   *
   * That difference is what makes a carpet affordable. `columnInfo` is the
   * dominant cost in this whole file: the terrain mesher spends 1.9 ms a chunk
   * doing almost nothing BUT calling it 1156 times, so at ~500 sprigs a chunk a
   * per-instance call would have been most of a millisecond on its own — the
   * same order as the vertices they cost. The ground colour does not
   * meaningfully vary across the two metres of one clump, so there is nothing
   * to buy by re-sampling it.
   *
   * Whole-pass cost with the carpet in, measured best-of-4 over the 81 chunks
   * around the spawn: prop build 5.98 -> 6.85 ms a chunk mean and 11.99 ->
   * 13.7 ms worst, soft vertices 28.1k -> 34.7k. In the running game
   * (`?perf=1`, walking a loop), the `world` section's worst frame goes from
   * ~23 ms to ~24-26 ms against a 3 ms/frame build budget it already overshoots.
   */
  const addSprig = (
    dry: boolean, x: number, z: number, yaw: number, scl: number,
    tr: number, tg: number, tb: number, nearRoad = false,
  ): void => {
    if (nearRoad && onRoad(ox + x, oz + z)) return;
    const h = terrain.columnHeight(ox + Math.floor(x), oz + Math.floor(z));
    if (h < WATER_LEVEL + 1) return;
    const tpl = (dry ? lib.sprigsDry : lib.sprigs)[Math.floor(rng() * 3.999)];
    soft.add(tpl, x, softSeat(x, z, h, nearRoad) - 0.06, z, yaw, scl, tr, tg, tb);
  };

  /**
   * Lowest rendered column height anywhere under a footprint of radius `r`.
   *
   * Every solid prop used to be seated on the height of the ONE column at its
   * centre, and any prop wider than a voxel therefore hovered as soon as the
   * ground stepped down under its skirt: "a cluster of near-black rock cubes
   * hovers with visible air gaps beneath", "flat grey discs hovering above the
   * grass", "a brown dirt slab overhanging nothing". Seating on the MINIMUM of the
   * footprint instead means the prop can only ever be buried, never floating —
   * and buried is invisible while floating is a bug the eye finds instantly.
   * Callers additionally sink the base (see the `-` offsets at each stamp).
   *
   * Now that the terrain carries fine relief (see heightCont), the ground steps
   * far more often than it used to, so this matters much more than it did.
   */
  const groundMin = (wx: number, wz: number, r: number): number => {
    const k = Math.max(1, Math.round(r));
    let m = terrain.getHeight(wx, wz);
    let v = terrain.getHeight(wx + k, wz); if (v < m) m = v;
    v = terrain.getHeight(wx - k, wz); if (v < m) m = v;
    v = terrain.getHeight(wx, wz + k); if (v < m) m = v;
    v = terrain.getHeight(wx, wz - k); if (v < m) m = v;
    v = terrain.getHeight(wx + k, wz + k); if (v < m) m = v;
    v = terrain.getHeight(wx - k, wz - k); if (v < m) m = v;
    v = terrain.getHeight(wx + k, wz - k); if (v < m) m = v;
    v = terrain.getHeight(wx - k, wz + k); if (v < m) m = v;
    return m;
  };

  // ---- tree pass: jittered grid keeps organic spacing ----------------------
  // The lattice went from 6x6 cells of 5 units to 4x4 cells of 8 with the 2026-07
  // tree rescale, and the biome acceptance rates went UP to partly compensate.
  // Both halves are forced by the same thing: a crown is now 7-10 units across
  // instead of 2.8-3.9, so 36 candidates on a 5-unit lattice would have merged
  // into one continuous green ceiling with no individual trees readable in it —
  // and cost about 2.5x the vertices a chunk spends today.
  //
  // Measured over a 17x17 block of chunks with the numbers below: forest 11.6
  // trees a chunk at 46% canopy cover, snow 8.6 / 35%, plains 5.6 / 21%, beach
  // 5.9 / 23%. (Cover is summed crown discs against the chunk's 1024 square
  // units, using the deliberately conservative crown radius from `bake`, so the
  // painted foliage covers rather more than those figures.) A forest is a wood
  // whose crowns touch and overlap in places; plains stay meadow with specimen
  // trees on it, which is why plains is the one biome that ends up with FEWER
  // trees than before the rescale.
  for (let gx = 0; gx < 4; gx++) {
    // Four tree candidates are a useful scheduling grain: small enough to stay
    // below the streamer's frame budget without yielding for every stamp.
    if (gx > 0) yield;
    for (let gz = 0; gz < 4; gz++) {
      const lx = gx * 8 + Math.floor(rng() * 8);
      const lz = gz * 8 + Math.floor(rng() * 8);
      const roll = rng();
      const yaw = rng() * Math.PI * 2;
      // Girth and height vary INDEPENDENTLY and over a much wider range than the
      // old single 0.85-1.25 factor: adjacent trees came out as scaled copies of
      // one silhouette, which is what made whole hillsides read as two or three
      // repeated stamps. 0.78-1.22 girth against 0.80-1.30 height gives squat
      // spreading trees and lanky ones from the same template.
      const scl = 0.78 + rng() * 0.44;
      const sclY = scl * (0.86 + rng() * 0.32);
      const tintRoll = rng();
      const hueRoll = rng(); // foliage hue, decoupled from foliage VALUE
      const vroll = rng(); // variant pick, decoupled from density roll
      const jx = (rng() - 0.5) * 1.3;
      const jz = (rng() - 0.5) * 1.3;
      const wx = ox + lx;
      const wz = oz + lz;
      terrain.columnInfo(wx, wz, ci);
      const h = ci.h;

      // Acceptance is per CANDIDATE, and there are 16 candidates a chunk now
      // instead of 36, so every rate here is up on what it was (forest
      // 0.82 -> 0.80 of a much coarser lattice, snow 0.5 -> 0.62, beach
      // 0.3 -> 0.5, desert 0.14 -> 0.3). Plains alone is effectively down —
      // 0.34 of 36 candidates would have been a dozen huge oaks in a chunk,
      // which is a wood rather than a meadow. Cacti and palms also pick up the
      // 2.2x placement jitter, or a coarse lattice makes a desert read as a
      // planted orchard.
      let tpl: Template | null = null;
      let jitterMul = 1;
      // The nature baseline for THIS candidate's area, scaling every acceptance
      // rate below (world/nature.ts). At 1 — the shipped value — each product
      // is the literal that was there before, so the measured figures in the
      // comment above still describe the world. `roll` is drawn either way, so
      // no factor can move a tree it did not remove.
      const nTrees = nature.for(ci.biome).trees;
      // Roughly one tree in eleven is a dead snag (one in fourteen on plains,
      // where a lone dead tree in open meadow is a strong enough silhouette that
      // more of them would read as blight). See `deadSnag` for why: it is the
      // only template in the set whose outline is not a blob on a stick, and a
      // treeline needs one every few trees before it stops reading as a hedge.
      if (ci.biome === 'forest' && roll < 0.80 * nTrees) {
        tpl = vroll < 0.22 ? lib.oakA : vroll < 0.41 ? lib.oakB
          : vroll < 0.58 ? lib.oakC : vroll < 0.75 ? lib.oakD
          : vroll < 0.91 ? lib.birch : vroll < 0.96 ? lib.snag : lib.snagTall;
      } else if (ci.biome === 'plains' && roll < 0.30 * nTrees) {
        tpl = vroll < 0.30 ? lib.oakA : vroll < 0.51 ? lib.oakC
          : vroll < 0.74 ? lib.oakD : vroll < 0.93 ? lib.birch : lib.snag;
      } else if (ci.biome === 'snow' && roll < 0.62 * nTrees) {
        tpl = vroll < 0.34 ? lib.pine : vroll < 0.64 ? lib.pineTall
          : vroll < 0.9 ? lib.pineIrr : lib.snagTall;
      } else if (ci.biome === 'beach' && roll < 0.5 * nTrees && ci.hc >= 8.6 && ci.hc <= 11.5) {
        // three distinct palms + extra scatter so beach lines feel organic
        tpl = vroll < 0.34 ? lib.palm : vroll < 0.67 ? lib.palmB : lib.palmC;
        jitterMul = 2.2;
      } else if (ci.biome === 'desert' && roll < 0.3 * nTrees) {
        tpl = lib.cactusBig;
        jitterMul = 2.2;
      }
      if (!tpl) continue;
      if (h < WATER_LEVEL + (ci.biome === 'beach' ? 0 : 1)) continue;
      if (!flatEnough(wx, wz, h, 2)) continue;

      // Per-instance tint: VALUE and HUE on independent rolls.
      //
      // The spread went ±8% -> ±13% with "the green channel sliding
      // independently", but it was not independent — the green multiplier was
      // driven by the same `tintRoll` as the value, so a bright tree was always
      // the greenest tree and the whole family lay on one line through colour
      // space. Measured off _veg-d-treeline.png, two dozen broadleaves in one
      // frame still read as a single green.
      //
      // `hw` runs -1 (cool blue-green: red down, blue up) to +1 (warm
      // yellow-green), at ±11% red against ∓13% blue, which is about the spread
      // between a lime and a spruce and is applied on top of a ±15% value roll.
      // Two independent axes is what puts a dozen distinguishable trees in a
      // treeline instead of a dozen exposures of one.
      const t = 0.85 + tintRoll * 0.30;
      const hw = hueRoll * 2 - 1;
      // Trunk footprints are ~1.5-3 units wide at the flare after the rescale
      // (they were ~1.5 VOXELS), so the seating probe widens from r=1 to r=2 and
      // the sink from 0.3 to 0.45: the root flare and buttress voxels have to
      // bed into the ground instead of resting on it, and a bigger footprint
      // spans more terrain steps.
      const px = lx + 0.5 + jx * jitterMul;
      const pz = lz + 0.5 + jz * jitterMul;
      // THE EXCLUSION TEST GOES ON THE TRUNK, not on the column the candidate
      // was rolled in. `jitterMul` reaches 2.2 on beaches and deserts, so the
      // stamp lands up to 2 units off the tested centre — a fifth of the
      // clearance ROAD_TREE_CLEAR was tuned to, and the same fraction of a
      // den's or a town's disc. Moved down here rather than widened, because
      // widening a radius to cover a jitter makes the clearing bigger
      // everywhere; this makes it right where the tree is. No `rng()` is drawn
      // between the old position and this one, so every tree the test still
      // accepts is stamped exactly where it was before.
      if (exTree(ox + px, oz + pz)) continue;
      const baseY = groundMin(wx, wz, 2) - 0.45;
      solid.add(tpl, px, baseY, pz, yaw, scl,
        t * (1 + hw * 0.11), t * (1 + hw * 0.02), t * (1 - hw * 0.13), sclY);
      // Register the tree. `scl` is girth and `sclY` height, exactly as the
      // stamp applied them, so the registry describes the instance that was
      // actually placed rather than the template. Keep the field order in step
      // with ChunkProps.trunks / TREE_STRIDE.
      if (tpl.trunk) {
        const sr = tpl.trunk.r * scl;
        const cr = tpl.trunk.crownR * scl;
        const gr = sr + TRUNK_GRAB;
        trunks.push(
          ox + px, oz + pz,
          sr * sr, gr * gr,
          baseY + tpl.trunk.top * sclY,
          cr * cr,
          baseY + tpl.trunk.crownCy * sclY,
          tpl.trunk.crownRy * sclY,
        );
      }
    }
  }

  // ---- mid-scale silhouette pass -------------------------------------------
  // The size class between "grass blade" and "tree" was missing entirely,
  // which is why the plains read as a bald lawn: nothing broke the horizon
  // between ankle height and 8m. 4-6 stamps per chunk — boulder clusters,
  // fallen logs, waist-high hedge clumps. Cheap (all reuse baked templates
  // merged into the existing two per-chunk meshes, no new draw calls).
  // Stamps `n` copies of one template in a loose knot around (mlx, mlz),
  // re-grounding each on its own column. Defined once per chunk build.
  const stampKnot = (
    tpl: Template,
    mlx: number, mlz: number,
    n: number, spread: number,
    sMin: number, sSpan: number, yOff: number,
    t: number, nearRoad: boolean,
  ): void => {
    for (let b = 0; b < n; b++) {
      const ang = rng() * Math.PI * 2;
      const rad = b === 0 ? 0 : spread * (0.45 + rng());
      const bx = mlx + Math.cos(ang) * rad;
      const bz = mlz + Math.sin(ang) * rad;
      if (bx < 0 || bz < 0 || bx >= CHUNK_SIZE || bz >= CHUNK_SIZE) continue;
      if (nearRoad && roadDistAt(ox + bx, oz + bz) < ROAD_SOLID_CLEAR) continue;
      terrain.columnInfo(ox + Math.floor(bx), oz + Math.floor(bz), ci);
      if (ci.h < WATER_LEVEL + 1) continue;
      const bt = t * (0.93 + rng() * 0.14);
      const gy = groundMin(ox + Math.floor(bx), oz + Math.floor(bz), 2);
      solid.add(tpl, bx, gy + yOff, bz, rng() * Math.PI * 2,
        sMin + rng() * sSpan, bt, bt * 1.02, bt * 0.95);
    }
  };

  const midCount = 5 + Math.floor(rng() * 4);
  for (let m = 0; m < midCount; m++) {
    if (m > 0 && m % 2 === 0) yield;
    const mlx = 2 + rng() * (CHUNK_SIZE - 4);
    const mlz = 2 + rng() * (CHUNK_SIZE - 4);
    const kind = rng();
    const yaw = rng() * Math.PI * 2;
    const wx = ox + Math.floor(mlx);
    const wz = oz + Math.floor(mlz);
    terrain.columnInfo(wx, wz, ci);
    const h = ci.h;
    const biome = ci.biome;
    if (h < WATER_LEVEL + 1) continue;
    if (biome === 'underwater') continue;
    if (exSolid(wx + 0.5, wz + 0.5)) continue;
    // Every shape below is a KNOT scattered around the candidate, not a stamp
    // on it: the boulder cluster reaches 2.9 units, the paired log 2.3, a hedge
    // knot 2.2. Against ROAD_SOLID_CLEAR's 7.5 that puts a boulder as close as
    // 4.6 to a centreline — inside the ribbon's 5.0 rim, i.e. a rock sitting in
    // the road. `exSolid` has just left the measured distance in `roadDist`, so
    // deciding whether the satellites need testing individually is free.
    const nearRoad = roadDist < ROAD_SOLID_CLEAR + 3;
    if (!flatEnough(wx, wz, h, 2)) continue;
    const t = 0.92 + rng() * 0.16;
    const green = biome === 'plains' || biome === 'forest';
    // Nature densities for this candidate's area (world/nature.ts). The band
    // BOUNDARIES of the ladder below are deliberately left alone — they are a
    // size ladder, and scaling one boundary would hand the width it gave up to
    // whatever kind sits after it, so "fewer rocks" would silently mean "more
    // hedges". Only the counts inside a branch and the one band that has
    // nothing after it (`!green`, boulders and then the end of the ladder) are
    // scaled; a lone stamp in the middle of the ladder is thinned by hash.
    const nf = nature.for(biome);

    // Size ladder for the mid ground, shortest to tallest: knee-high hedge
    // knot (~1) -> lone log (~0.8 but long and low) -> tall hedge clump (~1.7)
    // -> rock+log pair (~2) -> boulder outcrop (~2.5-3.5) -> tree (~4-6).
    // Before this there was exactly ONE hedge size, so every bush-shaped
    // silhouette in the mid ground repeated at the same height.
    if (!green) {
      // Desert/snow/beach: boulders only, at the old rate.
      if (kind >= 0.42 * nf.rocks) continue;
    } else if (kind >= 0.36) {
      if (kind < 0.5) {
        // Rock + log pair: a boulder with a trunk fetched up against it —
        // one readable ~2m mass rather than two lone pebbles.
        // `green` is true in this branch, so these are always the mossy pair.
        const rk = rng() < 0.5 ? lib.rockAMoss : lib.rockBMoss;
        // Capped at 1.95 (was 2.6). rock(1) bakes at 0.28 units/voxel with a
        // 3.6-voxel radius, so 2.6x produced a boulder over 5 units across, and one
        // of those a few units from a photo-mode camera filled a third of the frame
        // as a single unlit slab — the "slate monolith". A mid-ground silhouette
        // prop must stay smaller than the hero is tall by a clear margin.
        const rs = 1.45 + rng() * 0.5;
        const rw = 0.94 + rng() * 0.13;
        // Drawn, then possibly dropped: the rolls above must happen either way
        // or a rock density would re-scatter the log beside it. See `thin`.
        if (!thin(wx, wz, 617, nf.rocks)) {
          solid.add(rk, mlx, groundMin(wx, wz, 2) - 0.45, mlz, yaw, rs,
            t * rw, t, t * (1.94 - rw));
        }
        const lang = yaw + 1.1 + rng() * 1.2;
        const lx2 = mlx + Math.cos(lang) * (1.4 + rng() * 0.9);
        const lz2 = mlz + Math.sin(lang) * (1.4 + rng() * 0.9);
        if (lx2 >= 0 && lz2 >= 0 && lx2 < CHUNK_SIZE && lz2 < CHUNK_SIZE
          && !(nearRoad && roadDistAt(ox + lx2, oz + lz2) < ROAD_SOLID_CLEAR)) {
          terrain.columnInfo(ox + Math.floor(lx2), oz + Math.floor(lz2), ci);
          if (ci.h >= WATER_LEVEL + 1) {
            const lt = t * (0.95 + rng() * 0.1);
            solid.add(lib.logT, lx2,
              groundMin(ox + Math.floor(lx2), oz + Math.floor(lz2), 2) - 0.2,
              lz2, lang + Math.PI * 0.5,
              1.4 + rng() * 0.5, lt, lt * 0.98, lt * 0.92);
          }
        }
      } else if (kind < 0.64) {
        solid.add(lib.logT, mlx, groundMin(wx, wz, 2) - 0.2, mlz, yaw,
          0.9 + rng() * 0.5, t, t * 0.98, t * 0.94);
      } else if (kind < 0.84) {
        // knee-high hedges: the rung between grass and the tall clump
        stampKnot(lib.hedgeSmallT, mlx, mlz,
          natureCount(2 + Math.floor(rng() * 3), nf.bushes), 1.5,
          0.85 + rng() * 0.2, 0.35, -0.25, t, nearRoad);
      } else {
        stampKnot(lib.hedgeT, mlx, mlz,
          natureCount(1 + Math.floor(rng() * 3), nf.bushes), 1.5,
          0.95, 0.45, -0.3, t, nearRoad);
      }
      continue;
    }

    {
      // Boulder cluster: 2-3 existing rock templates at 1.4-2.2x, stamped
      // around a shared center so they read as one outcrop, not lone pebbles.
      const n = natureCount(2 + Math.floor(rng() * 2), nf.rocks);
      for (let b = 0; b < n; b++) {
        const ang = rng() * Math.PI * 2;
        const rad = b === 0 ? 0 : 0.9 + rng() * 2;
        const bx = mlx + Math.cos(ang) * rad;
        const bz = mlz + Math.sin(ang) * rad;
        if (bx < 0 || bz < 0 || bx >= CHUNK_SIZE || bz >= CHUNK_SIZE) continue;
        if (nearRoad && roadDistAt(ox + bx, oz + bz) < ROAD_SOLID_CLEAR) continue;
        terrain.columnInfo(ox + Math.floor(bx), oz + Math.floor(bz), ci);
        if (ci.h < WATER_LEVEL + 1) continue;
        const tpl = biome === 'snow' ? lib.rockSnow
          : green ? (rng() < 0.5 ? lib.rockAMoss : lib.rockBMoss)
            : rng() < 0.5 ? lib.rockA : lib.rockB;
        const bt = t * (0.94 + rng() * 0.12);
        const gy = groundMin(ox + Math.floor(bx), oz + Math.floor(bz), 2);
        // Per-boulder warm/cool tint. Stamped with a flat neutral tint (bt,bt,bt)
        // an outcrop of two or three rocks was three copies of the same grey, and
        // grey with no hue in it is the colour the eye reads as "untextured
        // placeholder". Real rock in one outcrop still varies in mineral warmth.
        const bw = 0.94 + rng() * 0.13;
        // Same cap and same sink as the rock+log pair above.
        solid.add(tpl, bx, gy - 0.45, bz, rng() * Math.PI * 2,
          1.25 + rng() * 0.6, bt * bw, bt, bt * (1.94 - bw));
      }
    }
  }

  // ---- meadow cluster pass -------------------------------------------------
  // Poisson-ish clumps instead of a uniform sprinkle: ~90 candidate centers,
  // each accepted one stamps 5-9 grass billboards in a tight disc, usually a
  // flower, occasionally a bush. Total instance counts stay close to the old
  // even scatter, but meadows gain rhythm — dense pockets with breathing room.
  const flowers = [lib.flowerR, lib.flowerY, lib.flowerP, lib.flowerW, lib.flowerO];
  const grasses = [lib.grassA, lib.grassB, lib.grassC];
  const blooms = [
    lib.bloomHeather, lib.bloomButter, lib.bloomClover, lib.bloomYarrow, lib.bloomRust,
  ];
  for (let k = 0; k < 115; k++) {
    // One candidate can stamp a carpet of several templates. Four at a time
    // measured below 1 ms where the old whole prop pass reached 12-20 ms.
    if (k > 0 && k % 4 === 0) yield;
    const clx = 1 + rng() * (CHUNK_SIZE - 2);
    const clz = 1 + rng() * (CHUNK_SIZE - 2);
    const accept = rng();
    const wcx = ox + Math.floor(clx);
    const wcz = oz + Math.floor(clz);
    terrain.columnInfo(wcx, wcz, ci);
    const cb = ci.biome;
    if (cb !== 'plains' && cb !== 'forest') continue;
    // Acceptance went 0.80/0.42 -> 0.56/0.30 to stop the meadow reading as a
    // continuous carpet (a continuous carpet of anything reads as texture, not as
    // vegetation — bare ground between clumps is what makes the clumps read), and
    // is now back up to 0.72/0.44. The carpet risk was real but it was measured
    // against blades that RENDERED, and these mostly do not: with the billboards
    // sitting invisibly at the sward's own value the accepted clumps only ever
    // show their tussocks and their one flower, so 0.56 of 115 candidates put
    // roughly one readable object every 4 metres on open plains. _veg-a-ground.png
    // is the evidence — the whole foreground third of the frame is bare terrace.
    //
    // And now DOWN again to 0.58/0.36, in exchange for the fatter clumps below
    // (2-4 tussocks in a 2.1-unit disc instead of 1-3 in a 2.6-unit one, at a
    // 20% larger bake scale). This is a trade, and it was measured:
    // `buildChunkProps` over the 16 chunks around the spawn cost 7.32 ms and
    // 26.3k soft vertices a chunk with the old clump contents and 9.13 ms /
    // 29.5k with the new ones — the same regime that got the 2x2 tussock
    // reverted last round, against a ~3 ms/frame build budget. Cutting the clump
    // COUNT by a fifth pays for the extra mass inside each one. It is also the
    // better art: the same total cover gathered into fewer, denser patches is
    // what the "thickets and clearings, not Poisson spread" note asks for, and
    // one patch that reads is worth three that do not.
    //
    // 0.58/0.36 -> 0.88/0.64, and this time the extra mass inside each clump is
    // paid for in a different currency rather than in clump count. Every round
    // above traded density against per-clump readability because the only ground
    // cover available was the 232-vertex tussock and the 3 ms build budget could
    // not carry more of them. `grassSprig` breaks that trade: at 96 vertices and
    // no `columnInfo` per stamp it is the first piece of ground cover in this
    // file cheap enough to CARPET with, which is what the finding actually asks
    // for — "the terrain is largely bare polygon between sparse bushes ... Cube
    // World's ground plane is densely carpeted". At 0.82 of 115 candidates a
    // plains chunk plants ~94 clumps, one per 3.3 units square, and each one is
    // now a metre-and-a-half patch rather than a pom-pom, so the patches touch.
    // A CLUMP IS THE MEADOW'S UNIT, so `grass` scales the acceptance rate and
    // everything inside a clump both — a field is made thicker by having more
    // patches AND fuller ones, which is what a designer means by "more grass".
    // The consequence is worth stating: `grass 0` in an area clears the clumps,
    // and with them the flower and the bush a clump carries. That is the right
    // reading of an area with no sward in it, and the mid-scale pass above still
    // plants hedges there, so `bushes` is not lost with it.
    const nm = nature.for(cb);
    if (accept > (cb === 'plains' ? 0.82 : 0.46) * nm.grass) continue;
    if (ci.h < WATER_LEVEL + 1) continue;
    if (ci.trample > 0 && trodden(wcx, wcz, ci.trample)) continue;
    // Grass and flowers are welcome on the doorstep — only the bush below,
    // which casts shadows and blocks the path, respects the den discs.
    if (exSoft(wcx + 0.5, wcz + 0.5)) continue;
    // THE CLUMP CENTRE CLEARING A ROAD SAYS NOTHING ABOUT ITS MEMBERS, which
    // scatter up to CLUMP_REACH from it. `exSoft` has already thrown out a
    // clump whose own centre is on the road; this decides whether the stamps
    // below are tested one by one, which is the only way the sward can stop
    // exactly at the ribbon's rim rather than 2.2 units short of it — or 2.2
    // units into it, which is the bug. No second query: `exSoft` just left the
    // measured distance in `roadDist`, and a duplicate `distanceTo` here would
    // land on all 115 clump candidates of every chunk in the world.
    const nearRoad = roadDist < ROAD_SOFT_CLEAR + CLUMP_REACH;
    const isForest = cb === 'forest';
    // +-8% per-cluster value jitter so whole clumps read lighter or darker.
    const cj = 0.92 + rng() * 0.16;
    // 8-14 blades in a TIGHT disc (see the radius below). Screen coverage, not
    // instance count, is what makes a meadow read: the same blades spread over a
    // 2.7-unit disc vanished into the ground, gathered into a 1.7-unit tussock
    // they occlude each other and register as grass.
    // 9-16 -> 7-12. These are the billboard blades, and this file has now
    // admitted twice that they barely render; they are also the single biggest
    // vertex consumer in the meadow (four quads, eight triangles each). Trimming
    // them buys back the triangles the extra tussocks below spend, so the meadow
    // pass stays within its build budget while what a player actually SEES goes
    // up. See the tussock bake scale for the measurement behind that.
    //
    // 7-12 -> 4-7, a third time and for the last time. The billboards are now
    // the ONLY thing in a clump that does not survive to the screen (this file
    // has admitted it twice and measured it once), and with the clump count up
    // by half they were about to become the meadow's largest vertex line item
    // again. What they still buy is the soft fringe between the solid props —
    // four of them under a tussock reads as the grass the tussock stands in —
    // so they are trimmed rather than removed.
    const members = natureCount(3 + Math.floor(rng() * 4), nm.grass);
    const grass = grasses[Math.floor(rng() * 2.999)];
    // The clump's ground tint, resolved ONCE. `addTuft` re-derives this per
    // instance because it re-samples the column; the sprig carpet below is far
    // too numerous to pay for that and the ground colour does not meaningfully
    // move across two metres. Same blend and the same clamp as `addTuft`.
    const B = 0.45;
    const sprR = clampTint(1 - B + B * (ci.topR / TUFT_REF[0])) * cj;
    const sprG = clampTint(1 - B + B * (ci.topG / TUFT_REF[1])) * cj;
    const sprB = clampTint(1 - B + B * (ci.topB / TUFT_REF[2])) * cj;
    // One knee-high tussock anchors roughly a fifth of the clumps, so the
    // meadow has a second height in it instead of one uniform nap.
    if (rng() < 0.22 * nm.grass) {
      soft.add(lib.grassTall, clx, ci.h - 0.03, clz, rng() * Math.PI * 2,
        0.8 + rng() * 0.4, cj * 0.98, cj, cj * 0.92);
    }
    // 0-2 solid tussocks INSIDE the clump. Moving the tufts here from the even
    // sparse sprinkle is the clustering half of the "reads as mould" fix: the same
    // total count, gathered into the same pockets as the blades, so a tufted patch
    // is genuinely a patch with clear ground around it. Scale spans +/-20% and yaw
    // the full circle, which now changes the outline because the four silhouettes
    // are asymmetric.
    // 1-3 per clump, never zero (was 0-2, zero 45% of the time). The tussock is
    // the load-bearing piece of ground cover — see the note on its bake scale —
    // so a clump that rolled none of them contributed a flower and nothing else.
    // Now 2-4, inside a TIGHTER disc (1.3 -> 1.05). Both halves matter: with a
    // mean of two spread over a 2.6-unit circle a "clump" was two isolated
    // specks three metres apart, which is a sprinkle by another name. Three
    // tussocks inside a 2-unit circle overlap each other's silhouettes and the
    // group reads as one patch of grass, which is the unit Cube World's meadows
    // are actually built from.
    // THE CARPET. 7-12 sprigs in a 2.2-unit disc around the clump's two or
    // three tussocks — the same footprint, filled in rather than dotted.
    //
    // The radius is deliberately WIDER than the tussocks' 1.05: the tussocks are
    // the readable objects and want to overlap each other, while the sprigs' job
    // is to close the gap between one clump and the next. At ~100 clumps a
    // plains chunk on a 3.2-unit pitch, a 2.2-unit sprig disc means neighbouring
    // clumps' carpets touch and the ground plane stops being bare polygon
    // anywhere, which is the finding. They are stamped BEFORE the tussocks so
    // `ci` still holds the cluster's own column.
    const sprigN = natureCount(4 + Math.floor(rng() * 5), nm.grass);
    for (let m = 0; m < sprigN; m++) {
      const ang = rng() * Math.PI * 2;
      // sqrt so the sample is uniform over the DISC rather than piled at the
      // centre — a carpet with a hot spot in the middle of every clump is a
      // pom-pom, which is the shape three rounds of tuning have been trying to
      // get away from.
      const rad = Math.sqrt(rng()) * 2.2;
      const sx = clx + Math.cos(ang) * rad;
      const sz = clz + Math.sin(ang) * rad;
      if (sx < 0 || sz < 0 || sx >= CHUNK_SIZE || sz >= CHUNK_SIZE) continue;
      addSprig(false, sx, sz, rng() * Math.PI * 2, 0.85 + rng() * 0.6,
        sprR * (isForest ? 0.93 : 1), sprG, sprB * (isForest ? 0.9 : 1), nearRoad);
    }
    // 2-4 -> 1-3. The tussock is still the readable OBJECT in a clump, but it is
    // no longer the thing carrying coverage — the sprigs are — and at 140
    // vertices against a sprig's 40 it is the wrong place to spend the meadow's
    // budget now that there is a cheaper way to fill ground.
    const tuftN = natureCount(1 + Math.floor(rng() * 3), nm.grass);
    for (let m = 0; m < tuftN; m++) {
      const ang = rng() * Math.PI * 2;
      const rad = rng() * 1.05;
      const tx = clx + Math.cos(ang) * rad;
      const tz = clz + Math.sin(ang) * rad;
      if (tx < 0 || tz < 0 || tx >= CHUNK_SIZE || tz >= CHUNK_SIZE) continue;
      // Scale roll 0.85-1.20 -> 1.00-1.45. Free — a tussock is 144 vertices at
      // any size — and it is the only remaining lever on the meadow's read that
      // costs nothing: measured off _veg2f-macro.png, a clump's tussocks at
      // 0.85x subtend about 25 px from a 3.4-unit camera 10 metres away, which
      // is a speck. At 1.45x the tallest reaches 0.91 units, just under a
      // terrain step, which is where Cube World's grass tufts actually sit.
      addTuft(false, tx, tz, rng() * Math.PI * 2, 1.0 + rng() * 0.45,
        cj * (isForest ? 0.94 : 1), nearRoad);
    }
    terrain.columnInfo(wcx, wcz, ci); // addTuft clobbers ci; restore the cluster's
    for (let m = 0; m < members; m++) {
      const ang = rng() * Math.PI * 2;
      const rad = 0.3 + rng() * 1.4;
      const mx = clx + Math.cos(ang) * rad;
      const mz = clz + Math.sin(ang) * rad;
      if (mx < 0 || mz < 0 || mx >= CHUNK_SIZE || mz >= CHUNK_SIZE) continue;
      if (nearRoad && onRoad(ox + mx, oz + mz)) continue;
      terrain.columnInfo(ox + Math.floor(mx), oz + Math.floor(mz), ci);
      if (ci.h < WATER_LEVEL + 1) continue;
      if (ci.biome !== 'plains' && ci.biome !== 'forest') continue;
      const t = cj * (0.96 + rng() * 0.08);
      soft.add(grass, mx, softSeat(mx, mz, ci.h, nearRoad) - 0.03, mz,
        rng() * Math.PI * 2, 0.65 + rng() * 0.5,
        isForest ? t * 0.9 : t * 0.97, t, isForest ? t * 0.86 : t * 0.9);
    }
    // ---- non-green drift --------------------------------------------------
    // "Add at least one non-green ground-cover mass per biome patch at a scale
    // visible from distance — the existing flower voxels are far too small to
    // register." See `bloomMat` for why a mat rather than a bigger blossom.
    //
    // Which hue and whether there is one at all are decided by a hash of the
    // 32-unit REGION, not by this clump's rng, and that is the whole design: a
    // per-clump roll scatters five colours evenly and the meadow reads as
    // confetti, while a per-region one puts a heather bank on this hillside and
    // a buttercup bank on the next. Roughly two regions in five carry a drift,
    // and inside one it lands on a third of the clumps — so a drift is a
    // recognisable patch of ten or fifteen mats, and the meadow between drifts
    // stays green.
    const reg = hashCell(terrain.seed, wcx >> 5, 401, wcz >> 5);
    if (reg < 0.42 && rng() < 0.24 * nm.flowers) {
      const bl = blooms[Math.floor(
        hashCell(terrain.seed, (wcx >> 5) + 77, 907, (wcz >> 5) - 31) * 4.999,
      )];
      const mats = natureCount(1 + Math.floor(rng() * 2), nm.flowers);
      for (let m = 0; m < mats; m++) {
        const ang = rng() * Math.PI * 2;
        const rad = m === 0 ? 0 : 0.6 + rng() * 1.6;
        const mx = clx + Math.cos(ang) * rad;
        const mz = clz + Math.sin(ang) * rad;
        if (mx < 0 || mz < 0 || mx >= CHUNK_SIZE || mz >= CHUNK_SIZE) continue;
        if (nearRoad && onRoad(ox + mx, oz + mz)) continue;
        const mh = terrain.columnHeight(ox + Math.floor(mx), oz + Math.floor(mz));
        if (mh < WATER_LEVEL + 1) continue;
        const bt = cj * (0.94 + rng() * 0.12);
        soft.add(bl, mx, softSeat(mx, mz, mh, nearRoad) - 0.06, mz,
          rng() * Math.PI * 2, 1.0 + rng() * 0.5, bt, bt, bt);
      }
    }
    // 0.7 -> 0.38. The single blossom was the meadow's only non-green note and
    // it never registered (168 vertices for two coloured voxels 0.33 units off
    // the ground); the drift above now does that job at a scale a vista can
    // resolve, so the lone flower goes back to being an occasional grace note.
    if (rng() < 0.38 * nm.flowers) { // a flower in about a third of the clumps
      const fx = clx + (rng() - 0.5) * 1.4;
      const fz = clz + (rng() - 0.5) * 1.4;
      terrain.columnInfo(ox + Math.floor(fx), oz + Math.floor(fz), ci);
      if (ci.h >= WATER_LEVEL + 1 && !(nearRoad && onRoad(ox + fx, oz + fz))) {
        const ft = cj * (0.94 + rng() * 0.12);
        soft.add(flowers[Math.floor(rng() * 4.999)], fx,
          softSeat(fx, fz, ci.h, nearRoad) - 0.04, fz,
          rng() * Math.PI * 2, 0.8 + rng() * 0.4, ft, ft, ft);
      }
    }
    // 0.16 -> 0.28. With the clump count cut a fifth, the bush is the only thing
    // in a meadow patch that reads as a MASS rather than as detail, and at 0.16
    // only one patch in six had one — so five patches in six were a scatter of
    // small pale things with no anchor. It is also the one piece of ground cover
    // in the meadow that lands in the shadow-casting `solid` bucket, which is
    // where the "canopy shadows are the dominant ground pattern" note applies at
    // knee height.
    if (rng() < 0.28 * nm.bushes) { // bush anchoring the clump
      const bx = clx + (rng() - 0.5) * 2;
      const bz = clz + (rng() - 0.5) * 2;
      terrain.columnInfo(ox + Math.floor(bx), oz + Math.floor(bz), ci);
      // The BUSH's own position, not its column's centre — same reason as the
      // grass above, and it strays a full unit from the clump centre.
      if (ci.h >= WATER_LEVEL + 1 && !exSolid(ox + bx, oz + bz)) {
        solid.add(lib.bushT, bx, ci.h - 0.05, bz, rng() * Math.PI * 2,
          0.8 + rng() * 0.5, cj, cj, cj);
      }
    }
  }

  // ---- sparse scatter pass --------------------------------------------------
  // Lone props between the clumps: singles of grass, rocks, mushrooms, tufts,
  // cacti. 320 rolls with thresholds scaled ~3x vs the old 950-roll loop so
  // per-chunk solid-prop counts stay roughly unchanged.
  for (let i = 0; i < 320; i++) {
    if (i > 0 && i % 16 === 0) yield;
    const lx = Math.floor(rng() * CHUNK_SIZE);
    const lz = Math.floor(rng() * CHUNK_SIZE);
    const roll = rng();
    const yaw = rng() * Math.PI * 2;
    const scl = 0.8 + rng() * 0.5;
    const pick = rng();
    const jx = (rng() - 0.5) * 0.8;
    const jz = (rng() - 0.5) * 0.8;
    const wx = ox + lx;
    const wz = oz + lz;
    // The JITTERED stamp position, resolved before the exclusion tests rather
    // than after them. `jx`/`jz` carry a stamp up to 0.57 units off its own
    // column's centre, so a roll tested at the centre and cleared could still
    // land inside the ribbon — the same off-by-a-footprint that put grass
    // through the road in the clump pass above.
    const x = lx + 0.5 + jx;
    const z = lz + 0.5 + jz;
    terrain.columnInfo(wx, wz, ci);
    const h = ci.h;
    if (h < WATER_LEVEL + 1) continue;
    if (exSoft(ox + x, oz + z)) continue;
    // `exSoft` has just left the measured road distance in `roadDist`.
    const nearRoad = roadDist < ROAD_SOFT_CLEAR + 1;
    if (ci.trample > 0 && trodden(wx, wz, ci.trample)) continue;
    // Mixed pass: soft singles ignore the den discs, solid ones don't.
    const noSolid = exSolid(ox + x, oz + z);

    const t = 0.9 + pick * 0.2;
    const ft = 0.9 + pick * 0.18; // subtle per-instance flower tint variety
    const grass = grasses[Math.floor(pick * 2.999)];
    // Nature densities for this column's area. Every branch below is a band on
    // one shared `roll` ladder, so a density THINS a band's stamps by hash (see
    // `thin`) rather than moving the band — a boundary moved here would hand
    // the width it gave up to whichever prop is next in the ladder. The bodies
    // are braced for the same reason: an extra condition on the `else if` would
    // fall THROUGH to the next band, so thinning grass would plant deadwood.
    const ns = nature.for(ci.biome);
    switch (ci.biome) {
      case 'plains':
        if (roll < 0.22) { if (!thin(wx, wz, 701, ns.grass)) soft.add(grass, x, h - 0.03, z, yaw, 0.6 + scl * 0.45, t * 0.96, t, t * 0.9); }
        // Solid tussocks at ~7% of rolls: enough that the meadow still reads as
        // grazed grass even where the billboard blades wash out.
        // Lone tussocks are DOWN from 7% of rolls to 4%: the meadow pass below now
        // plants them in clumps, and an even sprinkle on top of that is what made
        // the field read as uniform fuzz with no bare ground anywhere.
        // Scale roll narrowed from 1.20-1.45 to 1.04-1.24: this was the widest
        // tussock stamp in the file and the one that produced the near-foreground
        // "small bush" in _veg-g-ground.png.
        // The lone mossy boulder is FIRST in the ladder now. It used to sit
        // after the tussock band on `roll < 0.257`, which is below that band's
        // own `roll < 0.262` ceiling, so the branch was unreachable and open
        // plains have been getting no lone boulders at all. Bands are otherwise
        // unchanged: rock 0.5%, tussock 4.2%, tall blade 0.9%, stick 1.0%.
        else if (roll < 0.225 && !noSolid) { if (!thin(wx, wz, 617, ns.rocks)) solid.add(lib.rockAMoss, x, h - 0.1, z, yaw, scl, t, t, t); }
        else if (roll < 0.267) { if (!thin(wx, wz, 701, ns.grass)) addTuft(false, x, z, yaw, 0.72 + scl * 0.4, t, nearRoad); }
        else if (roll < 0.276) { if (!thin(wx, wz, 701, ns.grass)) soft.add(lib.grassTall, x, h - 0.03, z, yaw, 0.8 + scl * 0.3, t, t, t * 0.94); }
        else if (roll < 0.286) soft.add(lib.deadwoodT, x, h - 0.02, z, yaw, scl, t, t, t);
        // Carpet BETWEEN the clumps. The meadow pass fills its own 2.2-unit
        // discs; without this the ground between two discs is still the bare
        // polygon the finding is about, just in smaller pieces. 22% of 320 rolls
        // is ~70 sprigs a chunk on top of the ~500 the clumps plant, and this
        // loop has already paid for the `columnInfo` these need.
        else if (roll < 0.50) { if (!thin(wx, wz, 701, ns.grass)) addSprig(false, x, z, yaw, 0.8 + scl * 0.4,
          t * 0.98, t, t * 0.94, nearRoad); }
        break;
      case 'forest':
        if (roll < 0.1) { if (!thin(wx, wz, 701, ns.grass)) soft.add(grass, x, h - 0.03, z, yaw, 0.5 + scl * 0.45, t * 0.86, t, t * 0.84); }
        else if (roll < 0.127 && !noSolid) solid.add(mushroomT, x, h - 0.04, z, yaw, scl, t, t, t);
        else if (roll < 0.151 && !noSolid) { if (!thin(wx, wz, 617, ns.rocks)) solid.add(pick < 0.5 ? lib.rockAMoss : lib.rockBMoss, x, h - 0.1, z, yaw, scl, t, t, t); }
        else if (roll < 0.211) { if (!thin(wx, wz, 701, ns.grass)) addTuft(false, x, z, yaw, 0.8 + scl * 0.5, t * 0.95, nearRoad); }
        // Undergrowth: ferns and fallen sticks are what makes a wood read as a
        // wood floor rather than a lawn with trunks standing on it.
        else if (roll < 0.30) { if (!thin(wx, wz, 701, ns.grass)) soft.add(lib.ferns[Math.floor(pick * 2.999)], x, h - 0.04, z, yaw, 0.85 + scl * 0.35, t * 0.9, t, t * 0.88); }
        else if (roll < 0.325) soft.add(lib.deadwoodT, x, h - 0.02, z, yaw, scl, t, t, t);
        // Same carpet as plains, a shade darker and cooler: a wood floor is the
        // one surface where "bare polygon between sparse bushes" was most
        // literally true, because the canopy shadow over it hides everything
        // that is not a mass.
        else if (roll < 0.50) { if (!thin(wx, wz, 701, ns.grass)) addSprig(false, x, z, yaw, 0.75 + scl * 0.4,
          t * 0.88, t, t * 0.86, nearRoad); }
        break;
      case 'beach':
        if (roll < 0.064) { if (!thin(wx, wz, 701, ns.grass)) addTuft(true, x, z, yaw, scl, t, nearRoad); }
        else if (roll < 0.086 && !noSolid) { if (!thin(wx, wz, 617, ns.rocks)) solid.add(lib.rockA, x, h - 0.1, z, yaw, scl, t, t, t); }
        break;
      case 'desert':
        if (roll < 0.031 && !noSolid) { if (!thin(wx, wz, 617, ns.rocks)) solid.add(lib.rockA, x, h - 0.1, z, yaw, scl, t * 1.05, t, t * 0.9); }
        else if (roll < 0.082) { if (!thin(wx, wz, 701, ns.grass)) addTuft(true, x, z, yaw, scl, t, nearRoad); }
        else if (roll < 0.095 && !noSolid) solid.add(lib.cactusSmall, x, h - 0.04, z, yaw, scl, t, t, t);
        break;
      case 'snow':
        if (roll < 0.031 && !noSolid) { if (!thin(wx, wz, 617, ns.rocks)) solid.add(lib.rockSnow, x, h - 0.1, z, yaw, scl, t, t, t); }
        break;
      case 'underwater':
      case 'deepwater':
        // Both lake beds grow nothing here. The reed stand in the shallows is
        // the waterline pass below, which straddles the surface and never
        // consults this switch; four units down there is nothing to straddle.
        break;
      case 'trampled':
        // A camp yard grows nothing, and this empty case is the whole of how
        // that is enforced in this file. See terrain.ts `GroundPatch`.
        break;
    }
  }

  // ---- waterline pass -------------------------------------------------------
  // Reed stands in the shallows and right at the tide line. This is the one
  // scatter that has to straddle the water surface, so it gets its own loop
  // instead of a biome case: every other pass rejects columns below
  // WATER_LEVEL + 1 outright, which is exactly where reeds belong.
  for (let i = 0; i < 90; i++) {
    if (i > 0 && i % 12 === 0) yield;
    const lx = Math.floor(rng() * CHUNK_SIZE);
    const lz = Math.floor(rng() * CHUNK_SIZE);
    const roll = rng();
    const wx = ox + lx;
    const wz = oz + lz;
    terrain.columnInfo(wx, wz, ci);
    // A TIGHT band around the surface: reeds must have their feet wet. The old
    // window ran to WATER_LEVEL + 0.5, which put whole stands on dry beach where
    // they read as bright green spikes stuck in the sand, and reached 1.3 units
    // down, where they stood in open water like posts. -0.9 .. +0.1 is the strip
    // that is genuinely shoreline.
    // The window is pulled UP to straddle the waterline instead of reaching a
    // metre below it. Now that the water surface is opaque past the tide line
    // (see water.ts), a reed rooted well under it has its whole stem hidden and
    // only its pale seed head showing — which reads as a scrap of debris floating
    // in the bay, not as a plant. Rooted within ~35cm of the line, the stem clears
    // the surface and the stand reads as reeds.
    if (ci.hc < WATER_LEVEL - 0.35 || ci.hc > WATER_LEVEL + 0.6) continue;
    if (ci.biome === 'desert' || ci.biome === 'snow') continue;
    // Few candidates, but each accepted one plants a whole STAND. Reeds grow in
    // beds with long clear beaches between them; one stem per candidate ringed
    // every lake in an even sprinkle that read as stubble, not vegetation.
    // Resolved BEFORE the stand loop below, which re-samples `ci` per stem.
    const nr = nature.for(ci.biome).reeds;
    if (roll > 0.055 * nr) continue;
    if (exSoft(wx + 0.5, wz + 0.5)) continue;
    // A STAND strays up to 3 units from the candidate `exSoft` just cleared,
    // which is further than any other clump in this file — and a road crosses
    // exactly this ground wherever it bridges. `roadDist` is what `exSoft` left.
    const nearRoad = roadDist < ROAD_SOFT_CLEAR + 3;
    const stand = natureCount(3 + Math.floor(rng() * 4), nr);
    for (let s = 0; s < stand; s++) {
      const ang = rng() * Math.PI * 2;
      const rad = s === 0 ? 0 : 0.8 + rng() * 2.2;
      const sx = lx + 0.5 + Math.cos(ang) * rad;
      const sz = lz + 0.5 + Math.sin(ang) * rad;
      if (sx < 0 || sz < 0 || sx >= CHUNK_SIZE || sz >= CHUNK_SIZE) continue;
      if (nearRoad && onRoad(ox + sx, oz + sz)) continue;
      terrain.columnInfo(ox + Math.floor(sx), oz + Math.floor(sz), ci);
      if (ci.hc < WATER_LEVEL - 0.5 || ci.hc > WATER_LEVEL + 0.9) continue;
      const t = 0.9 + rng() * 0.2;
      soft.add(lib.reedsT, sx, ci.h - 0.05, sz, rng() * Math.PI * 2,
        0.75 + rng() * 0.55, t * 0.96, t, t * 0.88);
    }
  }

  // ---- sand dressing pass ----------------------------------------------------
  // The beaches were the emptiest surfaces in the world by a wide margin — a
  // shoreline could fill a third of a frame with nothing on it at all — because
  // this pass only reached a ~2-unit strip (hc 9.8..11.6) around the grass/sand
  // boundary and skipped the desert entirely. It now covers the whole dry beach
  // from the tide line up (8.6..13.0) and dresses desert sand from the same
  // roll table, at 200 candidates instead of 120. Everything here merges into the
  // chunk's two existing meshes, so the extra scatter costs triangles, not draw
  // calls.
  for (let i = 0; i < 200; i++) {
    if (i > 0 && i % 16 === 0) yield;
    const lx = Math.floor(rng() * CHUNK_SIZE);
    const lz = Math.floor(rng() * CHUNK_SIZE);
    const roll = rng();
    const wx = ox + lx;
    const wz = oz + lz;
    terrain.columnInfo(wx, wz, ci);
    if (ci.h < WATER_LEVEL + 1) continue;
    const sandy = ci.biome === 'beach' || ci.biome === 'desert';
    if (!sandy) continue;
    if (ci.biome === 'beach' && (ci.hc < 8.6 || ci.hc > 13.0)) continue;
    if (exSoft(wx + 0.5, wz + 0.5)) continue;
    // Same off-by-a-footprint as the scatter pass: the stamp is jittered off
    // the column `exSoft` tested. The draws stay where they are — moving them
    // above the rejections would re-roll every beach in the world — so the
    // stamp is re-tested instead, and only where a road is actually in reach.
    const nearRoad = roadDist < ROAD_SOFT_CLEAR + 1;
    const x = lx + 0.5 + (rng() - 0.5) * 0.8;
    const z = lz + 0.5 + (rng() - 0.5) * 0.8;
    if (nearRoad && onRoad(ox + x, oz + z)) continue;
    const yaw = rng() * Math.PI * 2;
    const t = 0.92 + rng() * 0.16;
    // The roll ladder is re-cut to make room for the dry sprig carpet, and it is
    // very nearly free. Bands, in points of the roll: dune blade 17 -> 14, dry
    // TUSSOCK 25 -> 18, shell grit 18 -> 14, bleached stick 8 -> 7, driftwood 6
    // unchanged, and the 28 points recovered go to the sprig. Per 200
    // candidates that is -6 blades (16 vertices each) and -14 tussocks (140)
    // against +56 sprigs (40) — a wash on the vertex budget for roughly twice
    // as many objects on an empty dune.
    // Same ladder rule as the scatter pass: the bands stay put and a density
    // thins what lands in one. Only the three vegetation bands are governed —
    // shells, sticks and driftwood are mineral debris, not nature's growth.
    //
    // These three `continue` rather than wrapping their body, unlike the scatter
    // pass, because each band draws INSIDE itself (`addTuft` and `addSprig` roll
    // their own variation) and there is nothing to wrap without hoisting a tuned
    // line out of its comment. The difference is only that a thinned candidate
    // here also skips its own draws, so the stream past it moves — which is
    // already true of any density below 1, and `thin` is inert at the baseline.
    const nd = nature.for(ci.biome);
    if (roll < 0.14) {
      if (thin(wx, wz, 701, nd.grass)) continue;
      // Dune blades are HALVED in rate. An upright card with an up-facing normal
      // takes full sun on both sides, so on bright sand a khaki blade renders as a
      // pale flat sheet — at close range they read as scraps of paper stuck in the
      // beach, which is the one place billboards lose to solid voxels outright.
      // The dry tussock below now carries most of the dune cover.
      const dune = rng() < 0.5 ? lib.grassDuneA : lib.grassDuneB;
      soft.add(dune, x, ci.h - 0.03, z, yaw, 0.7 + rng() * 0.4, t, t, t * 0.95);
    } else if (roll < 0.32) {
      if (thin(wx, wz, 701, nd.grass)) continue;
      addTuft(true, x, z, yaw, 0.75 + rng() * 0.45, t, nearRoad);
    } else if (roll < 0.60) {
      if (thin(wx, wz, 701, nd.grass)) continue;
      addSprig(true, x, z, yaw, 0.8 + rng() * 0.5, t, t, t * 0.96, nearRoad);
    } else if (roll < 0.74) {
      // Squashed to 45% height. A shell dot is one voxel tall, and a CUBE that
      // small still shows four vertical faces as tall as it is wide — faces the
      // sun barely reaches, which on bright sand print as black dashes with a
      // cream cap. Independent height scaling is the cheap fix: half-height
      // flakes are almost all lit top face, which is what a shell chip lying on a
      // beach actually looks like.
      const ss = 0.5 + rng() * 0.32;
      soft.add(lib.shellT, x, ci.h - 0.02, z, yaw, ss, t, t, t, ss * 0.45);
    } else if (roll < 0.81) {
      // Bleached sticks: the dry-land equivalent of shell grit, and the cheapest
      // thing that puts a shadow on an empty dune.
      const ds = 0.9 + rng() * 0.5;
      soft.add(lib.deadwoodT, x, ci.h - 0.02, z, yaw, ds, t, t, t * 0.94, ds * 0.7);
    } else if (roll < 0.87 && !exSolid(ox + x, oz + z)
      && flatEnough(wx, wz, ci.h, 1)) {
      solid.add(lib.driftwoodT, x, ci.h - 0.02, z, yaw, 0.9 + rng() * 0.4, t, t, t);
    }
  }

  // Typed-array conversion and bounds calculation touch every accumulated
  // vertex. Keep the two meshes in separate slices so their costs cannot land
  // on the same rendered frame.
  yield;
  const solidGeo = solid.toGeometry();
  yield;
  const softGeo = soft.toGeometry();
  let solidMesh: THREE.Mesh | null = null;
  let softMesh: THREE.Mesh | null = null;
  if (solidGeo) {
    solidMesh = new THREE.Mesh(solidGeo, lib.solidMat);
    solidMesh.position.set(ox, 0, oz);
    solidMesh.castShadow = true;
    solidMesh.receiveShadow = true;
    solidMesh.matrixAutoUpdate = false;
    solidMesh.updateMatrix();
  }
  if (softGeo) {
    softMesh = new THREE.Mesh(softGeo, lib.softMat);
    softMesh.position.set(ox, 0, oz);
    softMesh.castShadow = false;
    softMesh.receiveShadow = true;
    softMesh.matrixAutoUpdate = false;
    softMesh.updateMatrix();
  }
  return { solid: solidMesh, soft: softMesh, trunks };
}

/** Complete-now wrapper for boot and headless model guards. */
export function buildChunkProps(
  cx: number,
  cz: number,
  terrain: Terrain,
  lib: PropLib,
  exclusions: readonly Exclusion[],
  roads: RoadClearance | null = null,
): ChunkProps {
  const steps = buildChunkPropsSteps(cx, cz, terrain, lib, exclusions, roads);
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}
