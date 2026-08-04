/**
 * MOVING REFERENCE FRAMES — the generic half of "a town that flies".
 *
 * `CarrierInfo` in core/types.ts is the contract and argues the design; this
 * file is the machinery both sides of it need and nothing about any particular
 * moving thing. There is no island in here, no boat and no monster: a carrier
 * is a pose that changes, a local surface under it, and a volume that decides
 * who is riding.
 *
 * THREE PIECES, and the split is the one every registry in `world/` makes:
 *
 *   CarrierBody   what a moving thing EXTENDS. Owns the pose, computes the
 *                 per-slice delta from it, and converts between world and its
 *                 own local space. A subclass writes `steer()` and `localTop()`
 *                 and inherits everything else.
 *   CarrierField  the registry the World contract hands out.
 *   CarrierRide   what a MOVER owns — one field, two calls, no knowledge of
 *                 what it is standing on.
 *
 * THE LOCAL FRAME IS A WORLD OF ITS OWN, which is what keeps a carrier's
 * contents buildable with the tools that build a settlement. An island's deck
 * heightfield, the huts stamped on it and the people standing among them are
 * all authored around (0, 0) with no idea that the whole thing is a thousand
 * units away and moving; `toLocal`/`topAt` are the only places the two frames
 * meet. That is also why the meshes hang off `root`: three composes the matrix
 * once per frame and every vertex follows for free.
 *
 * THE ROTATION CONVENTION IS THE PROJECT'S. `yaw` is `atan2(dx, dz)` and local
 * -> world is the same map `Accum.add` and `StructureField.add` apply:
 *
 *   wx =  px * cos + pz * sin        px =  wx * cos - wz * sin
 *   wz = -px * sin + pz * cos        pz =  wx * sin + wz * cos
 *
 * A carrier that used three's own `Object3D.rotation.y` for the maths and this
 * for the stamps would be right at yaw 0 and wrong everywhere else, which is
 * exactly the class of bug that only shows up once something starts turning.
 */
import * as THREE from 'three';
import type { CarrierInfo, CarrierRegistry, World } from '../core/types';

/**
 * How far ABOVE a carrier's deck its airspace reaches, in world units.
 *
 * This is the height at which a body stops being "on the island" and becomes
 * "flying near it", and both ends of the range are real cases. It has to clear
 * a jump (the hero's apex is 1.61 units) with enough margin that a hop never
 * blinks the attachment, and it has to be generous enough that a flying mount
 * hovering over the deck — or one of the issue's flying mobs — travels with the
 * town rather than being left behind by it a metre off the ground.
 *
 * 22 is about the height of the island's own rock above its deck, so "inside
 * the town's airspace" reads the way it looks from the ground. Past it a flyer
 * is over the island the way an aeroplane is over a field.
 */
const RIDE_CEILING = 22;

/**
 * How far BELOW the deck a body still counts as riding, in world units.
 *
 * Small, and it is a landing tolerance rather than an airspace: a body is
 * clamped onto the deck by its own physics, so the only way to be under it and
 * still on it is to be mid-slice on the way down. Anything genuinely beneath
 * the island — walking the meadow it is passing over, flying under the keel —
 * is outside the volume and untouched by it, which is the guarantee
 * `CarrierInfo.contains` exists to make.
 */
const RIDE_FLOOR = 1.2;

/**
 * How far OUTSIDE a carrier's rim its raised flight ceiling still applies, in
 * world units. See `CarrierField.ceilingAt`.
 *
 * IT IS SIZED AGAINST THE CLIMB, and the climb got much longer when the island
 * moved above the weather. The deck cruises at 190 and a flyer's ordinary
 * ceiling is 78 over the ground, so there are ~90 units to gain; a galebird
 * climbs at 7 units/s and cruises at 12.4, which is thirteen seconds of climb
 * covering 160 units of ground. A 60-unit margin is crossed in five, so the
 * approach would run out of raised ceiling long before it ran out of climb and
 * the player would hit an invisible floor and coast under the island.
 *
 * 140 gives the climb more room than it needs. It costs nothing — the only
 * thing this number can do is let a player fly higher over an empty patch of
 * sky near the island.
 */
const CEILING_MARGIN = 140;

/**
 * How far over a carrier's ORIGIN its ceiling sits, in world units — enough to
 * clear anything standing on the deck. The island's tower is the tallest thing
 * on it, and a player has to be able to get above the roofs to land on them.
 */
const CEILING_RISE = 30;

/**
 * A moving frame. Extend it; do not instantiate it.
 *
 * The subclass owns exactly two things — where the frame WANTS to be next slice
 * (`steer`) and what its surface is in local space (`localTop`) — and this
 * class owns the bookkeeping every carrier would otherwise repeat: the delta,
 * the transform, the containment test and the scene root.
 */
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

  /** cos/sin of `yaw`, refreshed by `advance`. Read by the transforms. */
  protected cy = 1;
  protected sy = 0;

  constructor(readonly id: string, readonly radius: number) {
    // The carrier's matrix is written by `advance` and by nothing else, so
    // three has no reason to recompose it on traversal. The same reason every
    // merged town mesh sets this.
    this.root.matrixAutoUpdate = false;
  }

  /**
   * Where the frame should be after `dt` seconds. Write straight to `x/y/z/yaw`
   * — the delta is measured around this call, so a subclass never computes one.
   */
  protected abstract steer(dt: number): void;

  /**
   * Top of the surface at a point in the frame's OWN coordinates, or -Infinity
   * where the frame has nothing there. Local y = 0 is the frame's origin.
   */
  abstract localTop(lx: number, lz: number): number;

  /** One simulation slice: steer, publish the delta, and move the meshes. */
  advance(dt: number): void {
    const px = this.x;
    const py = this.y;
    const pz = this.z;
    const pyaw = this.yaw;
    this.steer(dt);
    this.dx = this.x - px;
    this.dy = this.y - py;
    this.dz = this.z - pz;
    // Shortest arc, so a frame whose heading crosses +/-PI publishes a small
    // turn rather than a full revolution its riders would be spun by.
    let d = this.yaw - pyaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.dyaw = d;
    this.cy = Math.cos(this.yaw);
    this.sy = Math.sin(this.yaw);
    this.root.position.set(this.x, this.y, this.z);
    // three's Euler-Y turns the opposite way from this project's bearing
    // convention (a bearing is measured from +Z toward +X), so the mesh takes
    // the yaw as-is and the arithmetic above takes it through the map in the
    // header. They agree: `Accum`'s stamp maps local +X to (cos, -sin), and
    // three's `rotation.y = yaw` maps local +X to (cos, -sin) as well.
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

  /** The frame's own coordinates -> world (x, z). Writes into `out`. */
  toWorld(lx: number, lz: number, out: { x: number; z: number }): void {
    out.x = this.x + lx * this.cy + lz * this.sy;
    out.z = this.z - lx * this.sy + lz * this.cy;
  }

  /** Scratch for `topAt`/`contains`, which run per mover per slice. */
  private readonly _l = { x: 0, z: 0 };

  topAt(x: number, z: number): number {
    const dx = x - this.x;
    const dz = z - this.z;
    // Broad phase first: one compare throws out every query in the world that
    // is not within the frame's own footprint, which is essentially all of them.
    if (dx * dx + dz * dz > this.radius * this.radius) return -Infinity;
    this.toLocal(x, z, this._l);
    const t = this.localTop(this._l.x, this._l.z);
    return t > -Infinity ? t + this.y : -Infinity;
  }

  contains(x: number, y: number, z: number): boolean {
    const top = this.topAt(x, z);
    if (top === -Infinity) return false;
    return y >= top - RIDE_FLOOR && y <= top + RIDE_CEILING;
  }
}

/** The registry, and the one thing `World.carriers` is. */
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

  ceilingAt(x: number, z: number): number {
    let top = -Infinity;
    for (const c of this.all) {
      const dx = x - c.x;
      const dz = z - c.z;
      // THE APPROACH, NOT THE FOOTPRINT, and that is the fix for the defect
      // this query was added for rather than a widening of it. Asking `topAt`
      // gives an answer only where the deck actually is, so a flyer climbing
      // alongside the island hit the ordinary terrain ceiling (a wall in open
      // sky, twenty units under the rim) and then found it gone the moment he
      // crossed the rim — "some max height which can get bypassed once I'm
      // within the sky island", which is exactly what a step function in a
      // ceiling feels like. The margin lifts the ceiling while the island is
      // still ahead of you, so there is no wall to meet in the first place.
      if (dx * dx + dz * dz > (c.radius + CEILING_MARGIN) ** 2) continue;
      // The deck's own height rather than the column under the query, because
      // outside the footprint there IS no column — and a ceiling is a bound, so
      // the useful answer is the highest thing the frame has, not the nearest.
      const t = c.y + CEILING_RISE;
      if (t > top) top = t;
    }
    return top;
  }

  advance(dt: number): void {
    for (const c of this.all) c.advance(dt);
  }
}

/**
 * WHAT A MOVER OWNS. One field, and two calls per simulation slice.
 *
 * `carry(world, position)` first, before the mover's own physics: it applies
 * whatever the frame did this slice to the body's world position, then decides
 * whether the body is still on it. `support(x, z)` afterwards, folded into
 * whatever max the mover already takes for its column top.
 *
 * IT IS DELIBERATELY NOT A BASE CLASS AND NOT AN INTERFACE THE MOVERS
 * IMPLEMENT. There are four physics loops in this codebase and they agree about
 * almost nothing: the hero has a step test, a canopy platform and a climb
 * state; the saddle has a flight ceiling; a beast walks through walls it can
 * see over; an enemy has a leash. What they DO have in common is a
 * `THREE.Vector3` they integrate and a heading they damp, so this asks for
 * exactly those and stays out of the rest.
 *
 * THE HEADING IS THE CALLER'S JOB, and `dyaw` is why this returns something. A
 * frame that turns must turn what is standing on it, or a hero riding a
 * banking island slowly ends up facing sideways across a deck he never turned
 * on — and the caller is the only one that knows whether its heading lives in
 * `this.heading`, `this.yaw`, a camera arm, or all three.
 */
export class CarrierRide {
  /** The frame currently under this body, or null. Read-only to callers. */
  carrier: CarrierInfo | null = null;
  /**
   * Radians the frame turned this slice. Add it to every heading the body
   * keeps; 0 whenever the body is not riding anything.
   */
  dyaw = 0;

  private id: string | null = null;

  /**
   * Move `pos` with the frame under it, and re-decide which frame that is.
   *
   * The attachment is resolved from the body's position AFTER the frame moved,
   * so a body that has just been carried off the rim by a turning island is
   * released on the same slice rather than one later.
   */
  carry(world: World, pos: THREE.Vector3): void {
    const reg = world.carriers;
    this.dyaw = 0;
    let c = this.id !== null ? reg.get(this.id) ?? null : null;
    if (c) {
      // The frame's origin BEFORE this slice: the offset has to be rotated
      // about where the frame was, not where it has arrived, or a body far out
      // on a turning deck is swung about the wrong centre and slides.
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
      // Left it — walked off the edge, jumped clear, or the deck moved out from
      // under a body that stood still. Nothing to undo: the body is already in
      // world space and always was.
      if (!c.contains(pos.x, pos.y, pos.z)) {
        c = null;
        this.id = null;
        this.dyaw = 0;
      }
    } else if (this.id !== null) {
      // The frame itself is gone — a zone change, or a carrier that was
      // disposed under a body standing on it. Same answer as leaving it.
      this.id = null;
    }
    if (!c) {
      c = reg.at(pos.x, pos.y, pos.z);
      this.id = c ? c.id : null;
    }
    this.carrier = c;
  }

  /**
   * Top of the deck under this column, or -Infinity when the body is not on a
   * frame.
   *
   * GATED ON BEING ATTACHED, which is what makes it safe to fold into a step
   * test that only takes (x, z). The vertical question was already asked by
   * `contains` on this slice; asking the registry again here — with no `y` to
   * ask it about — is what would put a walker on the meadow onto the deck of an
   * island passing overhead.
   */
  support(x: number, z: number): number {
    return this.carrier ? this.carrier.topAt(x, z) : -Infinity;
  }

  /** Forget the frame. For a reset, a zone change or a teleport. */
  clear(): void {
    this.carrier = null;
    this.id = null;
    this.dyaw = 0;
  }
}
