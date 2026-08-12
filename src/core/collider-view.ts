import * as THREE from "three";
import type { World } from "./types";

/**
 * Collider visualiser for the console's /show-colliders. Trees are cylinders
 * (green = the solid disc, blue = the wider grab-only disc), structures are
 * oriented boxes, roofs are arches. Green does NOT mean "not climbable".
 * Ground is not drawn — terrain collision is the heightfield itself.
 */

const RING_SEGMENTS = 16;
/** Rebuild rate, s. Anything moving rebuilds per frame or its cages trail it. */
const REFRESH_SECONDS = 0.5;
const REFRESH_MOVING = 0;
const RINGS = 3;
/** Stride of `World.debugRidges` — [cx, cz, yaw, hl, r, y, ry, fit]. */
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

  constructor(
    private scene: THREE.Scene,
    private world: World,
  ) {
    this.group.visible = false;
    // Fog-free so it stays legible through the haze at chunk range.
    this.solidMat = new THREE.LineBasicMaterial({ color: 0x46ff7a, fog: false, depthTest: true });
    this.climbMat = new THREE.LineBasicMaterial({ color: 0x4aa8ff, fog: false, depthTest: true });
    this.scene.add(this.group);
  }

  setWorld(world: World): void {
    this.world = world;
    if (this.visible) {
      this.rebuild();
    }
  }

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.group.visible = v;
    if (v) {
      this.rebuild();
    }
  }

  toggle(): boolean {
    this.setVisible(!this.visible);
    return this.visible;
  }

  get count(): number {
    return (
      this.scratch.length / 5 + this.boxScratch.length / 6 + this.ridgeScratch.length / RIDGE_STRIDE
    );
  }
  get boxCount(): number {
    return this.boxScratch.length / 6;
  }
  get ridgeCount(): number {
    return this.ridgeScratch.length / RIDGE_STRIDE;
  }
  /** Base-to-top span of the tallest cage: a deck-to-ground cage is only visible here (issue #112). */
  get tallestCage(): number {
    return this.tallest;
  }
  get tallestAt(): { x: number; z: number; base: number; top: number } | null {
    return this.tallSpot;
  }
  /** Boxes floored on a carrier DECK rather than terrain — pairs with `tallestCage`. */
  get carriedCount(): number {
    return this.carried;
  }

  update(dt: number): void {
    if (!this.visible) {
      return;
    }
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
        this.boxScratch[i],
        this.boxScratch[i + 1],
        this.boxScratch[i + 2],
        this.boxScratch[i + 3],
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
        this.ridgeScratch[i],
        this.ridgeScratch[i + 1],
        this.ridgeScratch[i + 2],
        this.ridgeScratch[i + 3],
        this.ridgeScratch[i + 4],
        this.ridgeScratch[i + 5],
        this.ridgeScratch[i + 6],
      );
    }
    this.replace("solid", solidPts);
    this.replace("climb", climbPts);
  }

  private note(x: number, z: number, base: number, top: number): void {
    const span = top - base;
    if (span <= this.tallest) {
      return;
    }
    this.tallest = span;
    this.tallSpot = { x, z, base, top };
  }

  /**
   * What a cage whose top is `top` stands ON: a carrier deck if one covers this
   * column, else terrain (issue #112). The `top >= deck` test keeps a hut on the
   * ground UNDER a passing island floored on the terrain.
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
    return this.world.getHeight(x, z);
  }

  /** An oriented box as line-segment pairs: base rect, top rect, four uprights. */
  private cage(
    out: number[],
    x: number,
    z: number,
    hx: number,
    hz: number,
    yaw: number,
    base: number,
    top: number,
  ): void {
    this.note(x, z, base, top);
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    // Same mapping `Accum.add` stamps with: (lx, lz) -> (lx*c + lz*s, -lx*s + lz*c).
    const cornerX: number[] = [];
    const cornerZ: number[] = [];
    for (const [lx, lz] of [
      [-hx, -hz],
      [hx, -hz],
      [hx, hz],
      [-hx, hz],
    ] as const) {
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
   * A roof: the TOP HALF of a cylinder along a ridge. `structureTopAt` is a height
   * field, so the collider has no underside to draw.
   */
  private arch(
    out: number[],
    x: number,
    z: number,
    yaw: number,
    hl: number,
    r: number,
    y: number,
    ry: number,
  ): void {
    // Axis and horizontal normal; bearing 0 runs along +z, as everywhere else.
    const ax = Math.sin(yaw);
    const az = Math.cos(yaw);
    const nx = Math.cos(yaw);
    const nz = -Math.sin(yaw);
    const ACROSS = 8;
    /** Cross-sections down the run, both gable ends included. */
    const SECTIONS = 5;
    const px = (t: number, u: number): [number, number, number] => {
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      return [x + ax * t * hl + nx * u * r, y + ry * s, z + az * t * hl + nz * u * r];
    };
    for (let sec = 0; sec < SECTIONS; sec++) {
      const t = -1 + (2 * sec) / (SECTIONS - 1);
      for (let k = 0; k < ACROSS; k++) {
        const a = px(t, -1 + (2 * k) / ACROSS);
        const b = px(t, -1 + (2 * (k + 1)) / ACROSS);
        out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      }
    }
    for (let k = 0; k <= ACROSS; k++) {
      const u = -1 + (2 * k) / ACROSS;
      const a = px(-1, u);
      const b = px(1, u);
      out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
  }

  private ring(out: number[], x: number, z: number, r: number, base: number, top: number): void {
    const span = Math.max(0.01, top - base);
    this.note(x, z, base, top);
    for (let k = 0; k < RINGS; k++) {
      const y = base + (span * k) / (RINGS - 1);
      for (let s = 0; s < RING_SEGMENTS; s++) {
        const a0 = (s / RING_SEGMENTS) * Math.PI * 2;
        const a1 = ((s + 1) / RING_SEGMENTS) * Math.PI * 2;
        out.push(
          x + Math.cos(a0) * r,
          y,
          z + Math.sin(a0) * r,
          x + Math.cos(a1) * r,
          y,
          z + Math.sin(a1) * r,
        );
      }
    }
    for (let s = 0; s < 4; s++) {
      const a = (s / 4) * Math.PI * 2;
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      out.push(px, base, pz, px, top, pz);
    }
  }

  private replace(which: "solid" | "climb", pts: number[]): void {
    const existing = which === "solid" ? this.solid : this.climb;
    if (existing) {
      this.group.remove(existing);
      existing.geometry.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const seg = new THREE.LineSegments(geo, which === "solid" ? this.solidMat : this.climbMat);
    seg.frustumCulled = false;
    this.group.add(seg);
    if (which === "solid") {
      this.solid = seg;
    } else {
      this.climb = seg;
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.solid?.geometry.dispose();
    this.climb?.geometry.dispose();
    this.solidMat.dispose();
    this.climbMat.dispose();
  }
}
