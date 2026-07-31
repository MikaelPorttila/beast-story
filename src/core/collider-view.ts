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
/** How often the set is rebuilt while visible, in seconds. */
const REFRESH_SECONDS = 0.5;
/** Rings up the height of a collider, so it reads as a volume not a footprint. */
const RINGS = 3;

export class ColliderView {
  private group = new THREE.Group();
  private solidMat: THREE.LineBasicMaterial;
  private climbMat: THREE.LineBasicMaterial;
  private solid: THREE.LineSegments | null = null;
  private climb: THREE.LineSegments | null = null;
  private scratch: number[] = [];
  private boxScratch: number[] = [];
  private timer = 0;
  private visible = false;

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

  /** Number of colliders currently drawn: tree cylinders plus structure boxes. */
  get count(): number { return this.scratch.length / 5 + this.boxScratch.length / 6; }
  /** How many of those are settlement boxes. */
  get boxCount(): number { return this.boxScratch.length / 6; }

  update(dt: number): void {
    if (!this.visible) return;
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = REFRESH_SECONDS;
      this.rebuild();
    }
  }

  private rebuild(): void {
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
      this.cage(
        solidPts,
        this.boxScratch[i], this.boxScratch[i + 1],
        this.boxScratch[i + 2], this.boxScratch[i + 3],
        this.boxScratch[i + 4],
        // The box's own base is the ground under its centre. A palisade span on
        // a slope draws a hair into or out of the bank; that is honest, because
        // the collider genuinely is a top and a footprint and has no skirt.
        this.world.getHeight(this.boxScratch[i], this.boxScratch[i + 1]),
        this.boxScratch[i + 5],
      );
    }
    this.replace('solid', solidPts);
    this.replace('climb', climbPts);
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

  /** Rings at several heights plus vertical struts, as line-segment pairs. */
  private ring(
    out: number[], x: number, z: number, r: number, base: number, top: number,
  ): void {
    const span = Math.max(0.01, top - base);
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
