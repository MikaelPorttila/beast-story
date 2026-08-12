/**
 * Moving reference frames. `CarrierInfo` (core/types.ts) is the contract;
 * contents are authored around local (0, 0) and hang off `root`. `yaw` is
 * `atan2(dx, dz)` and local -> world is the map `Accum.add` applies — mixing it
 * with three's `Object3D.rotation.y` is right at yaw 0 and wrong elsewhere.
 *
 *   wx =  px * cos + pz * sin        px =  wx * cos - wz * sin
 *   wz = -px * sin + pz * cos        pz =  wx * sin + wz * cos
 */
import * as THREE from 'three';
import type { CarrierInfo, CarrierRegistry, World } from '../core/types';

/** Airspace above the deck, world units. Clears a jump (hero apex 1.61). */
const RIDE_CEILING = 22;

/** Landing tolerance below the deck, world units — not an airspace. */
const RIDE_FLOOR = 1.2;

/**
 * Raised-ceiling reach outside the rim, world units. Sized against the climb:
 * 60 ran out mid-approach and dropped the player under the island.
 */
const CEILING_MARGIN = 140;

/** Ceiling height over a carrier's origin — clears the tower, so roofs are landable. */
const CEILING_RISE = 30;

/** A moving frame. Extend it: a subclass owns `steer` and the three local faces. */
export abstract class CarrierBody implements CarrierInfo {
  readonly root = new THREE.Group();

  x = 0;
  y = 0;
  z = 0;
  yaw = 0;

  dx = 0;
  dy = 0;
  dz = 0;
  dyaw = 0;

  /** cos/sin of `yaw`, refreshed by `advance`. */
  protected cy = 1;
  protected sy = 0;

  constructor(readonly id: string, readonly radius: number) {
    // `advance` is the only writer of this matrix, so skip three's recompose.
    this.root.matrixAutoUpdate = false;
  }

  /** Where the frame should be after `dt`. Write `x/y/z/yaw`; the delta is ours. */
  protected abstract steer(dt: number): void;

  /** Surface top in LOCAL coords (y = 0 is the origin), -Infinity where empty. */
  abstract localTop(lx: number, lz: number): number;

  /**
   * The turf in LOCAL coords, not what stands on it. `[localDeck, localBottom]`
   * is the MASS no body may be inside; `localTop` maxes over huts and trees.
   */
  abstract localDeck(lx: number, lz: number): number;

  /**
   * Underside of the BODY in LOCAL coords (negative under the deck), +Infinity
   * where empty. Abstract: no honest default — issue #80, flying through it.
   */
  abstract localBottom(lx: number, lz: number): number;

  advance(dt: number): void {
    const px = this.x;
    const py = this.y;
    const pz = this.z;
    const pyaw = this.yaw;
    this.steer(dt);
    this.dx = this.x - px;
    this.dy = this.y - py;
    this.dz = this.z - pz;
    // Shortest arc: a heading crossing +/-PI must not spin the riders.
    let d = this.yaw - pyaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.dyaw = d;
    this.cy = Math.cos(this.yaw);
    this.sy = Math.sin(this.yaw);
    this.root.position.set(this.x, this.y, this.z);
    // Mesh takes yaw as-is: `rotation.y` and `Accum` both map +X to (cos, -sin).
    this.root.rotation.y = this.yaw;
    this.root.updateMatrix();
  }

  /** World (x, z) -> the frame's own coordinates. Writes into `out`. */
  toLocal(x: number, z: number, out: { x: number; z: number }): void {
    const wx = x - this.x;
    const wz = z - this.z;
    out.x = wx * this.cy - wz * this.sy;
    out.z = wx * this.sy + wz * this.cy;
  }

  toWorld(lx: number, lz: number, out: { x: number; z: number }): void {
    out.x = this.x + lx * this.cy + lz * this.sy;
    out.z = this.z - lx * this.sy + lz * this.cy;
  }

  private readonly _l = { x: 0, z: 0 };

  topAt(x: number, z: number): number {
    const dx = x - this.x;
    const dz = z - this.z;
    if (dx * dx + dz * dz > this.radius * this.radius) return -Infinity;
    this.toLocal(x, z, this._l);
    const t = this.localTop(this._l.x, this._l.z);
    return t > -Infinity ? t + this.y : -Infinity;
  }

  deckAt(x: number, z: number): number {
    const dx = x - this.x;
    const dz = z - this.z;
    if (dx * dx + dz * dz > this.radius * this.radius) return -Infinity;
    this.toLocal(x, z, this._l);
    const d = this.localDeck(this._l.x, this._l.z);
    return d > -Infinity ? d + this.y : -Infinity;
  }

  bottomAt(x: number, z: number): number {
    const dx = x - this.x;
    const dz = z - this.z;
    if (dx * dx + dz * dz > this.radius * this.radius) return Infinity;
    this.toLocal(x, z, this._l);
    const b = this.localBottom(this._l.x, this._l.z);
    return b < Infinity ? b + this.y : Infinity;
  }

  contains(x: number, y: number, z: number): boolean {
    const top = this.topAt(x, z);
    if (top === -Infinity) return false;
    return y >= top - RIDE_FLOOR && y <= top + RIDE_CEILING;
  }
}

export class CarrierField implements CarrierRegistry {
  readonly all: CarrierBody[] = [];

  add(c: CarrierBody): void {
    this.all.push(c);
  }

  get(id: string): CarrierInfo | undefined {
    for (const c of this.all) if (c.id === id) return c;
    return undefined;
  }

  at(x: number, y: number, z: number): CarrierInfo | null {
    for (const c of this.all) if (c.contains(x, y, z)) return c;
    return null;
  }

  bodyAt(x: number, z: number): CarrierInfo | null {
    for (const c of this.all) if (c.topAt(x, z) > -Infinity) return c;
    return null;
  }

  ceilingAt(x: number, z: number): number {
    let top = -Infinity;
    for (const c of this.all) {
      const dx = x - c.x;
      const dz = z - c.z;
      // The APPROACH, not the footprint: `topAt` answers only over the deck, so
      // a climbing flyer met the terrain ceiling and then lost it at the rim.
      if (dx * dx + dz * dz > (c.radius + CEILING_MARGIN) ** 2) continue;
      // Deck height, not the queried column: outside the footprint there is none.
      const t = c.y + CEILING_RISE;
      if (t > top) top = t;
    }
    return top;
  }

  advance(dt: number): void {
    for (const c of this.all) c.advance(dt);
  }
}

/** What a mover owns. `carry` BEFORE its physics, `support` after; apply `dyaw`. */
export class CarrierRide {
  carrier: CarrierInfo | null = null;
  /** Radians the frame turned this slice; 0 when not riding. Add to headings. */
  dyaw = 0;

  private id: string | null = null;

  /** Move `pos` with its frame, then re-resolve AFTER the move (same-slice release). */
  carry(world: World, pos: THREE.Vector3): void {
    const reg = world.carriers;
    this.dyaw = 0;
    let c = this.id !== null ? reg.get(this.id) ?? null : null;
    if (c) {
      // Rotate about the origin BEFORE this slice, or a rider on a turn slides.
      const ox = c.x - c.dx;
      const oz = c.z - c.dz;
      let px = pos.x - ox;
      let pz = pos.z - oz;
      if (c.dyaw !== 0) {
        const cs = Math.cos(c.dyaw);
        const sn = Math.sin(c.dyaw);
        const rx = px * cs + pz * sn;
        pz = -px * sn + pz * cs;
        px = rx;
      }
      pos.x = ox + px + c.dx;
      pos.z = oz + pz + c.dz;
      pos.y += c.dy;
      this.dyaw = c.dyaw;
      if (!c.contains(pos.x, pos.y, pos.z)) {
        c = null;
        this.id = null;
        this.dyaw = 0;
      }
    } else if (this.id !== null) {
      this.id = null;
    }
    if (!c) {
      c = reg.at(pos.x, pos.y, pos.z);
      this.id = c ? c.id : null;
    }
    this.carrier = c;
  }

  /**
   * Deck top here, -Infinity when not riding. Gated on attachment: an (x, z)-only
   * registry query would put a walker on a deck passing overhead.
   */
  support(x: number, z: number): number {
    return this.carrier ? this.carrier.topAt(x, z) : -Infinity;
  }

  clear(): void {
    this.carrier = null;
    this.id = null;
    this.dyaw = 0;
  }
}
