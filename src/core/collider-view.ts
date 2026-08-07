import * as THREE from 'three';
import type { World } from './types';

/**
 * Collider visualiser for the console's /show-colliders.
 *
 * Two primitives, drawn as they actually are:
 *
 *   - TREES are cylinders. Green for the SOLID disc that blocks movement, blue
 *     for the wider disc that can only be GRABBED — the bole's reach and the
 *     crown's. Two colours because they are two different radii and a mismatch
 *     between either and the mesh is exactly what this exists to show.
 *   - STRUCTURES — huts, palisade spans, crates, carts, road furniture — are
 *     ORIENTED BOXES, and are drawn green. Drawing them as circles would hide
 *     the one thing worth checking about a building's collider, which is whether
 *     its corners line up with its walls.
 *   - ROOFS are cylinders lying on their sides along a ridge, drawn green as
 *     arches: the cross-section at intervals down the run, and lines along the
 *     length joining them. The whole question about one is whether the arch sits
 *     on the thatch, so what is drawn is the arch and not the box round it.
 *
 * GREEN DOES NOT MEAN "not climbable". Everything solid is climbable; blue marks
 * the surplus — the part of a tree you can hold that would not have stopped you
 * anyway. A box has no surplus, so it is green all over and still grabbable.
 *
 * Ground is not drawn. Terrain collision is the whole heightfield, so the honest
 * visualisation of it is the terrain itself; drawing a cage per column would cost
 * far more than the diagnostic is worth.
 *
 * Rebuilt on a timer rather than per frame — chunks stream in and out, and this
 * is a debug overlay, not something to pay for every frame.
 */

/** Segments around a collider ring. 16 reads as a circle without being costly. */
const RING_SEGMENTS = 16;
/**
 * How often the set is rebuilt while visible, in seconds.
 *
 * TWO RATES, BECAUSE THERE ARE TWO KINDS OF COLLIDER. Chunks stream in and out
 * over seconds, so half a second is plenty to keep up with the world and cheap
 * enough that the overlay costs nothing. A CARRIER moves every slice, and at
 * half a second its cages trail the island they belong to by up to half a
 * second of travel — near enough to look like the collision is in the wrong
 * place, which is the exact question this overlay exists to answer. So a world
 * with anything moving in it rebuilds every frame.
 *
 * It is a debug overlay either way: the cost is one rebuild of a few hundred
 * rings, and only while `/show-colliders` is up.
 */
const REFRESH_SECONDS = 0.5;
const REFRESH_MOVING = 0;
/** Rings up the height of a collider, so it reads as a volume not a footprint. */
const RINGS = 3;
/**
 * Numbers per roof in `World.debugRidges` — [cx, cz, yaw, hl, r, y, ry, fit].
 *
 * Named rather than written into the loop, because it is a stride agreed with
 * another file: reading it as 7 drew five roofs as six garbled ones, each one
 * plausible enough on its own that the tent whose arch had gone missing was the
 * only sign anything was wrong.
 */
const RIDGE_STRIDE = 8;

export class ColliderView {
  private group = new THREE.Group();
  private solidMat: THREE.LineBasicMaterial;
  private climbMat: THREE.LineBasicMaterial;
  private solid: THREE.LineSegments | null = null;
  private climb: THREE.LineSegments | null = null;
  private scratch: number[] = [];
  private boxScratch: number[] = [];
  private ridgeScratch: number[] = [];
  private timer = 0;
  private visible = false;
  private tallest = 0;
  private carried = 0;
  private tallSpot: { x: number; z: number; base: number; top: number } | null = null;

  constructor(private scene: THREE.Scene, private world: World) {
    this.group.visible = false;
    // Unlit and fog-free: this is an instrument, and it has to stay legible at
    // the far end of a chunk where haze has taken everything else.
    this.solidMat = new THREE.LineBasicMaterial({ color: 0x46ff7a, fog: false, depthTest: true });
    this.climbMat = new THREE.LineBasicMaterial({ color: 0x4aa8ff, fog: false, depthTest: true });
    this.scene.add(this.group);
  }

  /** Rebind to another zone's World (see world/zones.ts) and redraw. */
  setWorld(world: World): void {
    this.world = world;
    if (this.visible) this.rebuild();
  }

  get isVisible(): boolean { return this.visible; }

  setVisible(v: boolean): void {
    this.visible = v;
    this.group.visible = v;
    if (v) this.rebuild();
  }

  toggle(): boolean {
    this.setVisible(!this.visible);
    return this.visible;
  }

  /** Colliders currently drawn: tree cylinders, structure boxes and roofs. */
  get count(): number {
    return this.scratch.length / 5 + this.boxScratch.length / 6
      + this.ridgeScratch.length / RIDGE_STRIDE;
  }
  /** How many of those are settlement boxes. */
  get boxCount(): number { return this.boxScratch.length / 6; }
  /** ...and how many are roof cylinders. */
  get ridgeCount(): number { return this.ridgeScratch.length / RIDGE_STRIDE; }
  /**
   * The tallest cage currently drawn, base to top, in world units.
   *
   * THE ONE NUMBER THAT SAYS THE PICTURE IS RIGHT. A cage that reaches from a
   * flying deck to the ground is indistinguishable from a correct one in a
   * count, and obvious in this: nothing in the world is two hundred units tall.
   * See `baseUnder` and issue #112.
   */
  get tallestCage(): number { return this.tallest; }
  /**
   * ...and WHERE it is, so the number is a place to look rather than a verdict.
   * Null before the first rebuild.
   */
  get tallestAt(): { x: number; z: number; base: number; top: number } | null {
    return this.tallSpot;
  }
  /**
   * How many of the drawn boxes were floored on a carrier's DECK rather than on
   * the terrain — the other half of the pair `tallestCage` is one of. "No cage
   * is two hundred units tall" is also what an overlay that draws nothing on the
   * flying settlement reports.
   */
  get carriedCount(): number { return this.carried; }

  update(dt: number): void {
    if (!this.visible) return;
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = this.world.carriers.all.length > 0 ? REFRESH_MOVING : REFRESH_SECONDS;
      this.rebuild();
    }
  }

  private rebuild(): void {
    this.tallest = 0;
    this.carried = 0;
    this.tallSpot = null;
    this.scratch.length = 0;
    this.world.debugColliders(this.scratch);

    const solidPts: number[] = [];
    const climbPts: number[] = [];
    for (let i = 0; i < this.scratch.length; i += 5) {
      const x = this.scratch[i];
      const z = this.scratch[i + 1];
      const solidR = this.scratch[i + 2];
      const climbR = this.scratch[i + 3];
      const top = this.scratch[i + 4];
      // The collider is a vertical cylinder standing on the ground under it.
      const base = this.world.getHeight(x, z);
      this.ring(solidPts, x, z, solidR, base, top);
      this.ring(climbPts, x, z, climbR, base, top);
    }

    this.boxScratch.length = 0;
    this.world.debugStructures(this.boxScratch);
    for (let i = 0; i < this.boxScratch.length; i += 6) {
      const top = this.boxScratch[i + 5];
      this.cage(
        solidPts,
        this.boxScratch[i], this.boxScratch[i + 1],
        this.boxScratch[i + 2], this.boxScratch[i + 3],
        this.boxScratch[i + 4],
        this.baseUnder(this.boxScratch[i], this.boxScratch[i + 1], top),
        top,
      );
    }

    this.ridgeScratch.length = 0;
    this.world.debugRidges(this.ridgeScratch);
    for (let i = 0; i < this.ridgeScratch.length; i += RIDGE_STRIDE) {
      this.arch(
        solidPts,
        this.ridgeScratch[i], this.ridgeScratch[i + 1], this.ridgeScratch[i + 2],
        this.ridgeScratch[i + 3], this.ridgeScratch[i + 4],
        this.ridgeScratch[i + 5], this.ridgeScratch[i + 6],
      );
    }
    this.replace('solid', solidPts);
    this.replace('climb', climbPts);
  }

  /** Keep the tallest cage of this rebuild. Both primitives report through it. */
  private note(x: number, z: number, base: number, top: number): void {
    const span = top - base;
    if (span <= this.tallest) return;
    this.tallest = span;
    this.tallSpot = { x, z, base, top };
  }

  /**
   * What a cage whose top is `top` stands ON at this column.
   *
   * THE GROUND IS NOT ALWAYS THE GROUND. A collider is a top and a footprint
   * with no skirt (see `cage`), so the base has to be inferred, and inferring it
   * from the terrain is right for everything that stands on terrain and wrong by
   * a hundred and ninety units for a settlement that is flying over it: every
   * hut, fence post and resident of the sky island drew a cage from the deck all
   * the way down to the meadow below (issue #112). The picture reads as collision
   * where there is none, and it is the overlay's whole vertex budget spent on
   * struts nobody wants — the island is ~200 boxes, each one a cage that was two
   * orders of magnitude taller than the thing it describes.
   *
   * So: if a carrier's body covers this column and the box sits at or above its
   * deck, the deck is the floor. `top >= deck` is what keeps a hut on the ground
   * UNDER a passing island from being lifted onto its deck — the island covers
   * that column too, and the honest answer for a box down there is still the
   * terrain.
   */
  private baseUnder(x: number, z: number, top: number): number {
    const c = this.world.carriers.bodyAt(x, z);
    if (c) {
      const deck = c.deckAt(x, z);
      if (deck > -Infinity && top >= deck) {
        this.carried++;
        return deck;
      }
    }
    // A palisade span on a slope draws a hair into or out of the bank; that is
    // honest, because the collider genuinely has no skirt.
    return this.world.getHeight(x, z);
  }

  /**
   * An oriented box as line-segment pairs: a rectangle at the base, one at the
   * top, and the four uprights joining them. Fewer rings than `ring` draws
   * because a box has no curve to approximate — four corners say the whole
   * shape, and the yaw is the point.
   */
  private cage(
    out: number[], x: number, z: number, hx: number, hz: number,
    yaw: number, base: number, top: number,
  ): void {
    this.note(x, z, base, top);
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    // Same mapping `Accum.add` stamps with: local (lx, lz) -> world offset
    // (lx*c + lz*s, -lx*s + lz*c).
    const cornerX: number[] = [];
    const cornerZ: number[] = [];
    for (const [lx, lz] of [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]] as const) {
      cornerX.push(x + lx * c + lz * s);
      cornerZ.push(z - lx * s + lz * c);
    }
    for (let k = 0; k < 4; k++) {
      const n = (k + 1) % 4;
      for (const y of [base, top]) {
        out.push(cornerX[k], y, cornerZ[k], cornerX[n], y, cornerZ[n]);
      }
      out.push(cornerX[k], base, cornerZ[k], cornerX[k], top, cornerZ[k]);
    }
  }

  /**
   * A roof: the top half of a cylinder lying along a ridge, as line-segment
   * pairs.
   *
   * Only the top half is drawn, and that is the honest picture rather than a
   * saving. `structureTopAt` is a height field — the collider IS the surface
   * over each column and has no underside to show — so an arch that closed
   * underneath would be drawing a volume the game never asks about.
   */
  private arch(
    out: number[], x: number, z: number, yaw: number,
    hl: number, r: number, y: number, ry: number,
  ): void {
    // Axis direction and the horizontal normal to it; the same bearing
    // convention as everything else (0 runs along +z).
    const ax = Math.sin(yaw);
    const az = Math.cos(yaw);
    const nx = Math.cos(yaw);
    const nz = -Math.sin(yaw);
    /** Steps across the arch. 8 reads as a curve at the size a hut roof is. */
    const ACROSS = 8;
    /** Cross-sections down the run, including both gable ends. */
    const SECTIONS = 5;
    const px = (t: number, u: number): [number, number, number] => {
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      return [
        x + ax * t * hl + nx * u * r,
        y + ry * s,
        z + az * t * hl + nz * u * r,
      ];
    };
    for (let sec = 0; sec < SECTIONS; sec++) {
      const t = -1 + (2 * sec) / (SECTIONS - 1);
      for (let k = 0; k < ACROSS; k++) {
        const a = px(t, -1 + (2 * k) / ACROSS);
        const b = px(t, -1 + (2 * (k + 1)) / ACROSS);
        out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      }
    }
    // Along the run, so the arch reads as a solid rather than as loose hoops.
    for (let k = 0; k <= ACROSS; k++) {
      const u = -1 + (2 * k) / ACROSS;
      const a = px(-1, u);
      const b = px(1, u);
      out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
  }

  /** Rings at several heights plus vertical struts, as line-segment pairs. */
  private ring(
    out: number[], x: number, z: number, r: number, base: number, top: number,
  ): void {
    const span = Math.max(0.01, top - base);
    this.note(x, z, base, top);
    for (let k = 0; k < RINGS; k++) {
      const y = base + (span * k) / (RINGS - 1);
      for (let s = 0; s < RING_SEGMENTS; s++) {
        const a0 = (s / RING_SEGMENTS) * Math.PI * 2;
        const a1 = ((s + 1) / RING_SEGMENTS) * Math.PI * 2;
        out.push(
          x + Math.cos(a0) * r, y, z + Math.sin(a0) * r,
          x + Math.cos(a1) * r, y, z + Math.sin(a1) * r,
        );
      }
    }
    // Four uprights, so the cylinder reads as a volume from any angle.
    for (let s = 0; s < 4; s++) {
      const a = (s / 4) * Math.PI * 2;
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      out.push(px, base, pz, px, top, pz);
    }
  }

  private replace(which: 'solid' | 'climb', pts: number[]): void {
    const existing = which === 'solid' ? this.solid : this.climb;
    if (existing) {
      this.group.remove(existing);
      existing.geometry.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const seg = new THREE.LineSegments(geo, which === 'solid' ? this.solidMat : this.climbMat);
    seg.frustumCulled = false;
    this.group.add(seg);
    if (which === 'solid') this.solid = seg;
    else this.climb = seg;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.solid?.geometry.dispose();
    this.climb?.geometry.dispose();
    this.solidMat.dispose();
    this.climbMat.dispose();
  }
}
