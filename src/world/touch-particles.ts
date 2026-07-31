/**
 * CONTACT PARTICLES — what the world throws off when you brush against it.
 *
 * ONE element is implemented: leaves knocked out of a tree crown. The system
 * itself knows nothing about trees. It owns four things:
 *
 *   - a FIXED POOL drawn as one InstancedMesh. One draw call, one shader
 *     program, one geometry, per-instance colour, and no allocation in any
 *     update path;
 *   - the RECYCLING POLICY, which is the part that earns the file (see
 *     `acquire`): a particle is never taken back while it is in the air;
 *   - a list of `ContactSource`s — "a thing you can brush against" — each a
 *     cheap contact test plus a `ParticleKind`, the look and physics of what it
 *     sheds;
 *   - the SNOW OVERLAY (see `snowShare`), which is a KIND rather than a source:
 *     it does not decide when a burst happens, it takes a share of one that was
 *     already going to happen because the thing being brushed is under snow.
 *
 * ADDING A SECOND ELEMENT is a `ParticleKind` (how it looks and falls), a
 * `ContactSource` (when it fires and where), and one entry in `SOURCES`. It
 * needs no change to the pool, the policy, the draw call or the warm-up. What
 * the three obvious next ones would need, concretely:
 *
 *   grass    probe: `world.getHeight` under the feet plus a biome/density
 *            query — the terrain module already answers both, but nothing
 *            exposes "is there sward at this column" yet, so that is the one
 *            new World query it would want. Kind: a short blade shard, high
 *            drag, ~0.4 s of air, and a much SHORTER rest than a leaf, because
 *            the ground is where it came from and a carpet of settled blades
 *            reads as litter.
 *   splash   probe: `world.isWater(x, z)` and the feet within a hand of
 *            `world.waterLevel` — both already on World, so this one is a
 *            source and a kind and nothing else. Kind: a droplet, high gravity,
 *            no tumble, and `sinks: true` so it ends at the surface instead of
 *            resting on it. `settleY` already returns the water surface, so
 *            that is a flag on the kind, not new physics.
 *   dust     probe: the MOUNT's grounded speed over a threshold. The mover is
 *            the mount rather than the hero, which is why `ContactMover` is an
 *            interface and not `Player` — pass `mount.pal` and it works.
 *
 * All three of those compose with SNOW for free: a source fills `ContactPoint.
 * snow` from `world.snowCoverAt` in its probe (`snowShare` does the curve) and
 * the split in `pickKind` does the rest. Snowy sward and a mount kicking up
 * powder instead of dust are three lines each, not new elements.
 *
 * Cost, measured (RTX 3070 Ti, `?perf=1`, numbers in `__dbgTouchFx()`): a full
 * 64-particle pool in flight updates in ~0.03 ms a simulation slice, against a
 * ~7.8 ms frame. The dominant term is one `world.getHeight` per FALLING
 * particle per slice (~305 ns each, terrain.ts), which is why the ground query
 * is skipped while a particle is still rising. The snow overlay adds one
 * `world.snowCoverAt` per BURST — not per particle — which is one `heightCont`
 * and one fbm on the slice a contact begins and on each slice it continues,
 * i.e. at most 60 a second and only while the hero is actually inside a crown.
 * It adds NOTHING per particle: a snow flake and a leaf run the same loop over
 * the same arrays and differ only in which `KINDS` entry they read.
 *
 * Re-measured after the overlay, same GPU, `?perf=1`, three sites driven to a
 * full pool ~90 times each (0%, 70% and 100% snow): `msMax` 0.3 ms at all
 * three, against the 0.6 ms worst recorded above before the change, and
 * IDENTICAL at every mix — which is the point. The `world` profiler section
 * (which contains this) stayed at 4.0-4.6 ms, unchanged and dominated by chunk
 * streaming.
 */
import * as THREE from 'three';
import type { CrownContact, World, WorldBound } from '../core/types';
import { perf } from '../core/profiler';

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

/**
 * Pool size. Fixed forever: this is the whole point of the system.
 *
 * Sized off the worst honest case rather than a round number — walking the
 * length of a crown at a sprint is ~1.5 s of contact at LEAF.rate (18/s), so 64
 * covers one full traverse plus the tail of the previous one still lying on the
 * ground for LEAF.restMin seconds. Past that the policy in `acquire` takes over,
 * which is a feature, not a fallback: it is what a walk through a whole forest
 * exercises.
 */
const MAX = 64;

/** Particle states. Order matters only in that FREE is 0, so `fill(0)` clears. */
const FREE = 0;
const AIR = 1;
const SETTLED = 2;
const SHRINK = 3;

const TAU = Math.PI * 2;

// Module scratch — see the no-per-frame-allocation rule in AGENTS.md.
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _col = new THREE.Color();

/**
 * Anything that can brush against the world. `Player` satisfies it structurally,
 * and so does a `PalActor` — which is how a mount's gallop dust would get in
 * without this file learning what a pal is.
 */
export interface ContactMover {
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  /** Horizontal half-width of the body, in world units. */
  readonly radius: number;
}

/**
 * Where a burst happens and what it looks like. A SCRATCH owned by the system:
 * a source fills it during `probe` and it is dead the moment the burst is
 * spawned. Never retained, never allocated per contact.
 */
interface ContactPoint {
  x: number;
  y: number;
  z: number;
  /** Radius of the patch particles are scattered over. */
  spread: number;
  /** Unit horizontal push direction — normally the way the mover was moving. */
  dirX: number;
  dirZ: number;
  /** Tint, in the renderer's working colour space. */
  color: THREE.Color;
  /**
   * SNOW OVERLAY, 0..1: the share of this burst that comes off as snow instead
   * of as the source's own element.
   *
   * A probability per particle, not a second burst — see `pickKind`. Filled by
   * the source's `probe` because only the source knows which COLUMN is the
   * right one to ask about (a tree's snowiness is its trunk's, not the hero's,
   * and a grass source would want the hero's feet); `snowShare` is the shared
   * curve so no source has to invent one.
   */
  snow: number;
}

/**
 * How one kind of particle looks and falls. Every constant a leaf needs to be a
 * leaf rather than a spark is here, so a second element is data.
 */
interface ParticleKind {
  /** Short name, for the per-kind spawn counters in `stats()`. */
  id: string;
  /**
   * Fixed colour, for a kind whose look is its own rather than the thing it
   * came off. Snow is white wherever it fell from; a leaf is the colour of its
   * tree, so LEAF leaves this undefined and takes `ContactPoint.color`.
   */
  tint?: THREE.Color;
  /** Longest / thickest / widest, in world units, before the per-particle roll. */
  long: number;
  thick: number;
  wide: number;
  /** Multiplies the three above, per particle. */
  sizeMin: number;
  sizeSpan: number;
  /** Horizontal launch speed and the upward kick, both rolled per particle. */
  launch: number;
  launchUp: number;
  /** Horizontal drag, in the house `exp(-k*dt)` form. */
  drag: number;
  /**
   * Vertical motion is an exponential approach to `fall` at rate `fallLambda`,
   * NOT a parabola. A leaf has enormous drag for its mass: it does not
   * accelerate, it reaches a drift speed almost at once and holds it. Modelling
   * that directly is both truer and cheaper than gravity plus a clamp, and it is
   * dt-correct by construction.
   */
  fall: number;
  fallLambda: number;
  /** Lateral flutter: amplitude in units/s, and cycles per second. */
  sway: number;
  swayHz: number;
  /** Tumble rate, rad/s, rolled per particle. */
  spin: number;
  /** Seconds lying on the ground before the shrink starts. */
  restMin: number;
  restSpan: number;
  /** Seconds to scale out of existence once the rest is over. */
  shrink: number;
  /** Faster shrink used when the pool is exhausted — see `acquire`. */
  shrinkFast: number;
  /**
   * Watchdog: a particle that has been airborne this long is retired anyway.
   * Only reachable if it falls somewhere with no ground under it (off the edge
   * of a loaded chunk, or into a hole), and a shrink at 10 s in open air is
   * still better than a leaf that hangs there forever.
   */
  maxAir: number;
}

/**
 * One thing in the world you can brush against.
 *
 * The contact test is the source's business and the pool is not: a source never
 * touches particle state, it answers "am I touching, and if so where and what
 * colour" and the system does the rest.
 */
interface ContactSource {
  readonly id: string;
  /** Index into `KINDS` — what this source sheds when there is no snow on it. */
  readonly kind: number;
  /**
   * Snow-cover response, as the two ends of a smoothstep and a ceiling. See
   * `snowShare`. `snowMax` 0 opts a source out entirely (a splash off a lake is
   * not snowier at altitude; it is a lake).
   */
  readonly snowFrom: number;
  readonly snowTo: number;
  readonly snowMax: number;
  /** Particles per second of continuous brushing, at full brushing speed. */
  readonly rate: number;
  /** Extra particles on the slice contact BEGINS — the shove of walking in. */
  readonly onset: number;
  /**
   * Speed, in units/s, at which brushing counts as full-rate. Below it the rate
   * scales down and at a standstill it is zero: standing inside a crown must
   * not strip the tree, because contact is not the same as disturbance.
   */
  readonly brushSpeed: number;
  /** Cheap, allocation-free. Fills `out` and returns true when touching. */
  probe(mover: ContactMover, world: World, out: ContactPoint): boolean;
}

// ---------------------------------------------------------------------------
// Element 1 of 1: leaves off a tree crown, plus the snow that was sitting on it
// ---------------------------------------------------------------------------

const LEAF: ParticleKind = {
  id: 'leaf',
  // A canopy VOXEL is 0.40-0.52 world units at the 2026-07 tree scale (see the
  // bake-scale note in props.ts), and a canopy voxel is a clump of foliage, not
  // a leaf. So a leaf is a good deal smaller than one: 0.19-0.31 long after the
  // size roll, and thin enough that a tumble shows its edge.
  long: 1,
  thick: 0.14,
  wide: 0.72,
  sizeMin: 0.24,
  sizeSpan: 0.16,
  launch: 1.6,
  launchUp: 1.5,
  drag: 1.7,
  /**
   * Drift speed, 2.1 u/s. One world unit is about a metre (the hero is 1.6),
   * so this is roughly double a real leaf's ~1 m/s — and it was 1.35 first,
   * which is the honest figure. Measured against the tree the capture run
   * picked (crown 24 units up, ground at 10): at 1.35 a leaf hung in the air
   * for a bit over ten seconds and NOTHING in the pool had settled 3.5 s into a
   * climb, so every burst after the first was fighting the exhaustion policy.
   * 2.1 gets the same leaf down in about seven, which is still a long, floaty
   * fall and leaves the pool room to turn over.
   */
  fall: 2.1,
  fallLambda: 2.4,
  sway: 0.85,
  swayHz: 0.75,
  spin: 3.4,
  restMin: 4,
  restSpan: 4,
  shrink: 0.5,
  shrinkFast: 0.22,
  maxAir: 14,
};

/**
 * SNOW knocked off a snow-laden bough. An OVERLAY kind: no source of its own,
 * no rate of its own, no contact test of its own — it takes a share of whatever
 * burst the thing under the snow was already producing (`snowShare`).
 *
 * Every number here exists to make a flake read as NOT a pale leaf, which is
 * the whole risk in reusing one geometry and one material for both:
 *
 *  - SHAPE. A leaf is a plate (1 x 0.14 x 0.72 — a 7:1 aspect) that flashes
 *    edge-on as it tumbles. Powder is a lump, so the three axes are within 25%
 *    of each other and the tumble shows no silhouette change at all. `sizeSpan`
 *    is 0.26 against a leaf's 0.16 on purpose: a bough dumps fine dust AND
 *    knuckles of packed snow, and the range is what sells "powder" over
 *    "confetti". 0.13-0.32 units across, versus a leaf's 0.19-0.31 long.
 *  - FALL. Slower and driftier: 1.55 u/s against the leaf's 2.1, reached faster
 *    (fallLambda 3.4 vs 2.4 — snow has no lift to fight with, it just goes), a
 *    wider and slower swing (sway 1.15 at 0.42 Hz vs 0.85 at 0.75), and a third
 *    of the tumble rate. Launch is HALF the leaf's: snow is not flicked off a
 *    springy twig, it slumps off a branch and falls more or less where it was.
 *  - REST. 1.6-3.4 s against a leaf's 4-8. Two reasons, one aesthetic and one
 *    structural. Aesthetic: fallen powder belongs to the snowpack it landed on
 *    within a second or two, whereas a leaf lying on the ground is litter that
 *    should stay a while. Structural: it is what pays for the longer air time.
 *    On the arithmetic, a snow particle holds a slot for at most ~12.4 s (9 s
 *    of fall from a crown 14 units up, plus the rest) against a leaf's ~15 (7 +
 *    8), so mixing snow in can only ever LOWER pressure on the pool; measured,
 *    30 x 30 forced spawns against a deliberately exhausted pool dropped 281 /
 *    retired 286 at 0% snow, 319 / 261 at 44%, 317 / 263 at 68% — the same pool
 *    behaviour at every mix. See `pickKind`.
 *
 * No new material and no new geometry — this is the same instanced box under a
 * different non-uniform scale and a different instance colour, so it adds not
 * one shader program and needs no warm-up entry of its own.
 */
const SNOW: ParticleKind = {
  id: 'snow',
  // 0xe8f2fa: the pine cap colour from props.ts (0xd2e4ee) opened up about a
  // stop. The cap is a large flat albedo that had to be pulled back "one step
  // off blinding" because it sits against the darkest green in the world; a
  // 0.2-unit flake is a handful of pixels, half of them turned away from the
  // sun. Captured at 0xd2e4ee first (_snow-alt-max1-dark.png): every flake on
  // the shaded side of the burst came out a grey lump against snow-lit ground,
  // which is ash, not snow. Slightly BLUE rather than neutral for the same
  // reason the terrain's SNOW is (0xf2f7fd, terrain.ts) — shadowed snow is blue.
  tint: new THREE.Color().setHex(0xe8f2fa),
  long: 0.62,
  thick: 0.5,
  wide: 0.58,
  sizeMin: 0.26,
  sizeSpan: 0.26,
  launch: 0.85,
  launchUp: 0.55,
  drag: 2.8,
  fall: 1.55,
  fallLambda: 3.4,
  sway: 1.15,
  swayHz: 0.42,
  spin: 1.1,
  restMin: 1.6,
  restSpan: 1.8,
  // Longer than a leaf's 0.5: a leaf is whisked away, snow melts into the
  // ground it landed on, and the extra quarter second is what reads as the
  // difference at no cost (a SHRINK particle is not holding anyone up — the
  // exhaustion policy retires SETTLED ones, and this is already past that).
  shrink: 0.8,
  shrinkFast: 0.22,
  maxAir: 14,
};

/**
 * Every kind, indexed by the `knd` array. A particle carries a KIND, not a
 * source: snow comes out of the leaf source but falls by its own rules, and
 * decoupling the two is the whole mechanism behind the overlay.
 */
const KINDS: ParticleKind[] = [LEAF, SNOW];
const K_LEAF = 0;
const K_SNOW = 1;

/**
 * Base foliage green, straight off the broadleaf palette in props.ts
 * (CANOPY_LIT 0x459a43 .. CANOPY_CROWN 0x5cb251). A detached leaf is lit from
 * every side rather than shaded by the clump around it, so it is picked from the
 * bright half of the canopy's range and then tinted per tree below.
 */
const LEAF_BASE = 0x4c9e45;

/**
 * Conifer needle green (props.ts pines are 0x2f8442 / 0x3f9c50 before their
 * per-tier multiplier). The leaf tint is lerped toward this by snow cover,
 * because the world swaps the tree TEMPLATE at the same threshold the snow mix
 * ramps through: above cover 0.5 every tree is a pine, and shedding bright
 * broadleaf green off a near-black spruce was a mismatch that predates the snow
 * work. Two lines here, and the non-snow half of a snowy burst now matches the
 * tree it came out of.
 */
const NEEDLE_COL = new THREE.Color().setHex(0x347f43);

/** Local, so the particle system keeps depending on `World` and nothing else. */
function smoothstep(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * What share of a burst at this column should come off as snow.
 *
 * A BLEND, not a switch, because the thing it reads is a blend: the overworld's
 * snow line is a 5-unit smoothstep around an altitude that itself wanders 6
 * units with the temperature field (terrain.ts), so `snowCoverAt` spends real
 * area at every value between 0 and 1 and a treeline should hand back a burst
 * that is mostly leaves with a little powder in it.
 *
 * The ramp does NOT start at 0. Snow on the GROUND fades in from cover 0, but
 * what a tree sheds is the snow on the TREE, and the world only puts a
 * snow-capped pine in a chunk once the column crosses 0.5 (`BiomeId` cuts
 * there, and props.ts picks its template off the biome). Ramping from below
 * that would shake powder out of a bare oak standing on pale ground.
 *
 * Measured in the real game at three columns of the seed-1337 overworld, ~320
 * forced spawns each: cover 0.00 (temperate oak at spawn) -> 0 of 333 snow;
 * cover 0.70 (a treeline column at -88,-96) -> 142 of 320, 0.444; cover 1.00 (a
 * snow plateau at 416,48) -> 217 of 320, 0.678. Predicted 0 / 0.43 / 0.70.
 *
 * Takes the COVER rather than a column, so the source can spend its one
 * `world.snowCoverAt` on the column it chose and use the answer twice.
 */
function snowShare(cover: number, s: ContactSource): number {
  if (s.snowMax <= 0) return 0;
  return s.snowMax * smoothstep(s.snowFrom, s.snowTo, cover);
}

/** Contact probe: how far up the hero's body the sphere sits, and how big. */
const CHEST_Y = 1.0;
const CHEST_PAD = 0.33;

/**
 * Deterministic 0..1 from a tree's world position. Two independent rolls from
 * two constant pairs, which is exactly what `buildChunkProps` does with its
 * per-chunk RNG — see the "VALUE and HUE on independent rolls" note there.
 */
function hash01(x: number, z: number, salt: number): number {
  const h = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * Leaves, and the only implemented element.
 *
 * The contact test is a sphere at the hero's chest against the canopy DOME the
 * world already keeps per tree (`crownContactAt`, world/index.ts). Deliberately
 * the same dome `climbTopAt` stands him on, so the leaves come off exactly the
 * surface he can feel — walk into a crown while climbing a trunk and the two
 * agree about where the foliage is.
 */
const LEAVES: ContactSource = {
  id: 'leaves',
  kind: K_LEAF,
  // Ramp start is the threshold props.ts swaps oaks for snow-capped pines at;
  // see `snowShare`. Full effect by 0.85 rather than 1.0 because cover reaches
  // a flat 1.0 a long way before the treeline ends — measured over the seed
  // 1337 map, of 5061 sampled snow columns almost all sit at exactly 1.0 — so a
  // ramp that only topped out there would give the deep-snow forest a mix that
  // never reached its own maximum.
  snowFrom: 0.5,
  snowTo: 0.85,
  // 0.7, not 1.0. A snow-laden bough is still a bough: shake it and needles
  // come down with the powder, and the dark green is what gives the white
  // something to read against. Captured at 1.0 first
  // (_snow-alt-max1-dark.png): over snow-lit ground the burst went to one pale
  // cloud with no internal contrast and no individual flakes readable in it. At
  // 0.7 (_snow-deepsnow.png, measured share 0.678 over 320 spawns) the same
  // burst has a dozen dark needle plates threaded through it and every white
  // clump has an edge. 7 flakes to 3 needles.
  snowMax: 0.7,
  rate: 18,
  onset: 5,
  brushSpeed: 2.2,
  probe(mover, world, out): boolean {
    const p = mover.position;
    const y = p.y + CHEST_Y;
    if (!world.crownContactAt(p.x, y, p.z, mover.radius + CHEST_PAD, _hit)) return false;
    out.x = p.x;
    out.y = y;
    out.z = p.z;
    out.spread = 0.45;
    // Outward from the trunk axis, so leaves spill away from the tree rather
    // than into it; falls back to the mover's heading right at the axis.
    const dx = p.x - _hit.treeX;
    const dz = p.z - _hit.treeZ;
    const d = Math.hypot(dx, dz);
    if (d > 0.2) {
      out.dirX = dx / d;
      out.dirZ = dz / d;
    } else {
      const s = Math.hypot(mover.velocity.x, mover.velocity.z);
      out.dirX = s > 0.1 ? mover.velocity.x / s : 1;
      out.dirZ = s > 0.1 ? mover.velocity.z / s : 0;
    }
    // Per-TREE tint. The registry does not carry the tree's colour (that would
    // widen TREE_STRIDE for every tree in the world to serve a handful of
    // leaves), so it is reconstructed from the tree's position with the same
    // algebra props.ts tints the canopy with: a ±15% VALUE roll and an
    // independent warm/cool HUE roll at ±11% red against ∓13% blue. Leaves off
    // one tree therefore always match each other and differ from the tree next
    // to it, which is the property that matters. Widening the registry by one
    // packed colour would make it exact.
    const t = 0.85 + hash01(_hit.treeX, _hit.treeZ, 1) * 0.3;
    const hw = hash01(_hit.treeX, _hit.treeZ, 2) * 2 - 1;
    out.color.setHex(LEAF_BASE);
    // Snow is sampled at the TRUNK, not at the hero: it is the tree that is or
    // is not under snow, and the trunk axis is also the column props.ts asked
    // about when it chose between an oak and a snow-capped pine. Sampling at
    // the hero would disagree with the tree he is standing in by up to a crown
    // radius, which on a treeline is a visible mix either side of one trunk.
    const cover = world.snowCoverAt(_hit.treeX, _hit.treeZ);
    out.snow = snowShare(cover, LEAVES);
    out.color.lerp(NEEDLE_COL, cover);
    out.color.r *= t * (1 + hw * 0.11);
    out.color.g *= t * (1 + hw * 0.02);
    out.color.b *= t * (1 - hw * 0.13);
    return true;
  },
};

/** Every element, in probe order. One today; see the file header for the rest. */
const SOURCES: ContactSource[] = [LEAVES];

const _hit: CrownContact = {
  treeX: 0, treeZ: 0, crownR: 0, crownCy: 0, crownRy: 0,
};
const _point: ContactPoint = {
  x: 0, y: 0, z: 0, spread: 0, dirX: 0, dirZ: 0, color: new THREE.Color(), snow: 0,
};

// ---------------------------------------------------------------------------

/**
 * The pool, the policy and the draw call.
 *
 * WorldBound because settled particles belong to the zone they fell in: a leaf
 * resting on overworld grass has no business hanging in the air of a dungeon,
 * and its ground height would be a different world's anyway. `setWorld` clears
 * the pool outright — that is the one place a particle is taken back mid-air,
 * and it happens on the frame the hero is somewhere else entirely.
 */
export class TouchParticles implements WorldBound {
  readonly mesh: THREE.InstancedMesh;

  // ---- packed particle state, all preallocated ----
  private px = new Float32Array(MAX);
  private py = new Float32Array(MAX);
  private pz = new Float32Array(MAX);
  private vx = new Float32Array(MAX);
  private vy = new Float32Array(MAX);
  private vz = new Float32Array(MAX);
  /** Euler, applied XYZ. y is the leaf's thin axis, so rx/rz at 0 is lying flat. */
  private rx = new Float32Array(MAX);
  private ry = new Float32Array(MAX);
  private rz = new Float32Array(MAX);
  private spinX = new Float32Array(MAX);
  private spinY = new Float32Array(MAX);
  private spinZ = new Float32Array(MAX);
  /** Flutter: unit lateral direction, phase, and this particle's amplitude. */
  private swayX = new Float32Array(MAX);
  private swayZ = new Float32Array(MAX);
  private swayPh = new Float32Array(MAX);
  private swayAmp = new Float32Array(MAX);
  private size = new Float32Array(MAX);
  private state = new Uint8Array(MAX);
  /** Meaning depends on the state: age (AIR), rest left (SETTLED), fade left (SHRINK). */
  private timer = new Float32Array(MAX);
  /** SHRINK only: the fade's full duration, so the scale ramp is a ratio. */
  private fade = new Float32Array(MAX);
  /**
   * Which KINDS entry this particle is. Not which SOURCE threw it: the leaf
   * source throws both leaves and snow, and once a particle is in the air the
   * only thing the simulation needs is how it falls.
   */
  private knd = new Uint8Array(MAX);
  /**
   * Settle order. A monotonic counter stamped when a particle lands, so "the
   * oldest settled one" is a comparison and not a timestamp subtraction.
   */
  private seq = new Float32Array(MAX);
  private seqNext = 1;

  /** Free slots, as a stack. Pop to acquire, push to release. O(1) either way. */
  private freeList = new Int16Array(MAX);
  private freeCount = MAX;
  /** Non-FREE particles. When it is 0 there is nothing to integrate or upload. */
  private live = 0;

  /** Per-source emission accumulators and contact latches. */
  private acc = new Float32Array(SOURCES.length);
  private wasTouching = new Uint8Array(SOURCES.length);

  private dirty = false;
  private colorDirty = false;

  /** Instrumentation. Read through `stats()`; see __dbgTouchFx in main.ts. */
  private st = {
    spawned: 0,
    /** Bursts refused because every particle was in the air. */
    dropped: 0,
    /** Settled particles retired early to make room. Never one in flight. */
    retired: 0,
    /**
     * THE INVARIANT. Incremented if a slot is ever released while its particle
     * is airborne. It must stay 0 for the life of the process — it is the
     * assertion that recycling is invisible, in a number rather than in prose.
     */
    recycledAirborne: 0,
    /** Lifetime landings. `settled` in `stats()` is the live count, not this. */
    settledTotal: 0,
    maxAirborne: 0,
    maxLive: 0,
    /** Milliseconds in the last update, and the worst seen. `?perf=1` only. */
    ms: 0,
    msMax: 0,
  };

  /**
   * Lifetime spawns per KIND, surfaced by `stats()` as `spawned_leaf` /
   * `spawned_snow`. The mix is a per-particle coin flip, so the only honest way
   * to state its proportion is to count what actually came out.
   */
  private kindSpawned = new Float64Array(KINDS.length);

  constructor(private scene: THREE.Scene, private world: World) {
    // ONE geometry for every element. A leaf is a flat plate, a dust puff is a
    // cube and a droplet is a small one — all of them are this box under a
    // different non-uniform scale, and one geometry means one draw call for the
    // whole system however many elements it grows.
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Never culled: it is one small mesh, the particles are scattered over tens
    // of units so a single bounding sphere would be meaningless, and — the real
    // reason — the shader warm-up in main.ts only links a program for something
    // that is actually DRAWN. A culled mesh at boot is a 400 ms stall the first
    // time the hero brushes a tree. See warmUpShaders().
    this.mesh.frustumCulled = false;
    // Receives shadow, casts none: 64 tiny casters would add a whole depth pass
    // of work for shapes nobody can see the shadow of, but a leaf that ignores
    // the canopy shadow it fell out of glows against the ground under the tree.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;

    _mat4.makeScale(0, 0, 0);
    _col.setHex(LEAF_BASE);
    for (let i = 0; i < MAX; i++) {
      this.mesh.setMatrixAt(i, _mat4);
      // Every instance gets a colour NOW, at construction. Not cosmetic: the
      // instanceColor attribute is part of the program's cache key, so a pool
      // that acquired one on its first spawn would link a second program in the
      // middle of gameplay — exactly the stall the warm-up exists to prevent.
      this.mesh.setColorAt(i, _col);
      this.freeList[i] = MAX - 1 - i;
    }
    scene.add(this.mesh);
  }

  // ---- pool ---------------------------------------------------------------

  /**
   * A slot for a new particle, or -1.
   *
   * THE RECYCLING POLICY, and the reason this is a class rather than a loop:
   *
   *  1. A FREE slot, if there is one. The common case, and O(1).
   *  2. Otherwise the OLDEST SETTLED particle is retired — but it is NOT handed
   *     over. It is put into a fast shrink and this spawn is REFUSED. Stealing
   *     the slot outright would teleport a leaf resting in full view up into a
   *     canopy, which is the same visible pop as recycling one in mid-air; a
   *     leaf that shrinks out over shrinkFast and comes back a fifth of a second
   *     later is the same policy with the pop taken out. Under sustained contact
   *     the effect is a spawn rate throttled by the shrink, and a ground carpet
   *     that turns over oldest-first.
   *  3. Nothing settled either — every particle is in the air. The spawn is
   *     DROPPED. An airborne particle is never interrupted, at any pressure.
   *
   * The scan in (2) is O(MAX) and only runs on a spawn attempt against a full
   * pool, which is 64 comparisons at most a couple of dozen times a second in
   * the worst case the game can produce.
   */
  private acquire(): number {
    if (this.freeCount > 0) {
      const i = this.freeList[--this.freeCount];
      this.live++;
      if (this.live > this.st.maxLive) this.st.maxLive = this.live;
      return i;
    }
    let oldest = -1;
    let oldestSeq = Infinity;
    for (let i = 0; i < MAX; i++) {
      if (this.state[i] === SETTLED && this.seq[i] < oldestSeq) {
        oldestSeq = this.seq[i];
        oldest = i;
      }
    }
    if (oldest >= 0) {
      const k = KINDS[this.knd[oldest]];
      this.state[oldest] = SHRINK;
      this.timer[oldest] = k.shrinkFast;
      this.fade[oldest] = k.shrinkFast;
      this.st.retired++;
    } else {
      this.st.dropped++;
    }
    return -1;
  }

  /** Give a slot back. Never called on an airborne particle — see `st`. */
  private release(i: number): void {
    if (this.state[i] === AIR) this.st.recycledAirborne++;
    this.state[i] = FREE;
    this.freeList[this.freeCount++] = i;
    this.live--;
    _mat4.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(i, _mat4);
    this.dirty = true;
  }

  // ---- emission -----------------------------------------------------------

  /**
   * Which kind this particle of `s` comes out as: the source's own element, or
   * SNOW off the snow that was sitting on it.
   *
   * A COIN FLIP PER PARTICLE against `pt.snow`, and that choice is the whole
   * reason the mix is safe. The alternative — a second emitter running its own
   * accumulator alongside the first — would have doubled the spawn rate on a
   * snowy tree, and the pool cannot absorb that: at LEAF.rate 18/s a full-rate
   * brush already turns the whole 64-slot pool over in three and a half
   * seconds, so 36/s would spend the walk in the exhaustion policy, retiring
   * settled particles a few frames after they land and dropping bursts
   * outright. Splitting one budget instead means a snowy burst costs the pool
   * EXACTLY what a bare one costs — same `spawned`, same `dropped`, same
   * `retired` — and, because a snow particle's shorter rest more than pays for
   * its slower fall, slightly less residency than the leaf it replaced.
   *
   * The visible consequence is the right one too: a snow-laden bough does not
   * shed MORE than a bare one, it sheds the same shower with powder in it.
   */
  private pickKind(s: number, pt: ContactPoint): number {
    return pt.snow > 0 && Math.random() < pt.snow ? K_SNOW : SOURCES[s].kind;
  }

  /** One particle of kind `kn` at `pt`. False when the pool refused it. */
  private spawn(kn: number, pt: ContactPoint): boolean {
    const i = this.acquire();
    if (i < 0) return false;
    const k = KINDS[kn];

    // Scattered over the contact patch, sqrt-weighted so the disc fills evenly
    // rather than crowding the centre.
    const a = Math.random() * TAU;
    const r = Math.sqrt(Math.random()) * pt.spread;
    this.px[i] = pt.x + Math.cos(a) * r;
    this.py[i] = pt.y + (Math.random() - 0.5) * pt.spread;
    this.pz[i] = pt.z + Math.sin(a) * r;

    // Away from the element, plus a radial fan so a burst opens out instead of
    // travelling as a clump.
    const sp = k.launch * (0.45 + Math.random() * 0.9);
    this.vx[i] = (pt.dirX * 0.8 + Math.cos(a) * 0.7) * sp;
    this.vz[i] = (pt.dirZ * 0.8 + Math.sin(a) * 0.7) * sp;
    this.vy[i] = k.launchUp * (0.25 + Math.random() * 0.9);

    this.rx[i] = Math.random() * TAU;
    this.ry[i] = Math.random() * TAU;
    this.rz[i] = Math.random() * TAU;
    this.spinX[i] = (Math.random() - 0.5) * 2 * k.spin;
    this.spinY[i] = (Math.random() - 0.5) * k.spin;
    this.spinZ[i] = (Math.random() - 0.5) * 2 * k.spin;

    const sa = Math.random() * TAU;
    this.swayX[i] = Math.cos(sa);
    this.swayZ[i] = Math.sin(sa);
    this.swayPh[i] = Math.random() * TAU;
    this.swayAmp[i] = k.sway * (0.55 + Math.random() * 0.9);

    this.size[i] = k.sizeMin + Math.random() * k.sizeSpan;
    this.state[i] = AIR;
    this.timer[i] = 0;
    this.knd[i] = kn;
    this.seq[i] = 0;

    // Per-particle value jitter on top of the source's per-tree tint, so one
    // tree's leaves are a family rather than 64 copies of one swatch. A kind
    // with a tint of its own uses that instead: snow off a tree is the colour
    // of snow, not of the tree — and it still takes the value jitter, which on
    // a near-white is what stops a shower reading as a solid slab of paper.
    const v = 0.86 + Math.random() * 0.28;
    _col.copy(k.tint ?? pt.color).multiplyScalar(v);
    this.mesh.setColorAt(i, _col);
    this.colorDirty = true;
    this.st.spawned++;
    this.kindSpawned[kn]++;
    return true;
  }

  /**
   * Test every element against the mover and emit on contact.
   *
   * The onset burst and the continuous rate are separate on purpose: walking
   * into a crown should shove a handful of leaves loose at once (that is the
   * impact), and pushing on through should keep shedding at a rate set by how
   * fast you are moving (that is the brushing). Standing still inside one sheds
   * nothing at all.
   */
  private probeContacts(dt: number, mover: ContactMover): void {
    const speed = Math.hypot(mover.velocity.x, mover.velocity.y, mover.velocity.z);
    for (let s = 0; s < SOURCES.length; s++) {
      const src = SOURCES[s];
      if (!src.probe(mover, this.world, _point)) {
        this.wasTouching[s] = 0;
        this.acc[s] = 0;
        continue;
      }
      if (this.wasTouching[s] === 0) {
        this.wasTouching[s] = 1;
        for (let n = 0; n < src.onset; n++) {
          if (!this.spawn(this.pickKind(s, _point), _point)) break;
        }
      }
      const brush = Math.min(1, speed / src.brushSpeed);
      this.acc[s] += src.rate * brush * dt;
      while (this.acc[s] >= 1) {
        this.acc[s] -= 1;
        if (!this.spawn(this.pickKind(s, _point), _point)) break;
      }
      // A refused spawn must not bank credit: without this the accumulator runs
      // away while the pool is full and then dumps its whole backlog the moment
      // one slot frees.
      if (this.acc[s] > 1) this.acc[s] = 1;
    }
  }

  // ---- simulation ---------------------------------------------------------

  /**
   * Where a particle comes to rest at this column. Terrain, or the water
   * surface where the terrain is under it — a leaf floats, it does not sink to
   * the riverbed. The `+ 0.05` lifts it clear of z-fighting with the ground,
   * with room for the residual tilt a settled leaf keeps (see `integrate`).
   */
  private settleY(x: number, z: number): number {
    const g = this.world.getHeight(x, z);
    return (g < this.world.waterLevel ? this.world.waterLevel : g) + 0.05;
  }

  /**
   * One slice, for every non-free particle.
   *
   * Everything here is `1 - exp(-lambda*dt)` or `exp(-k*dt)`: the simulation
   * runs at a fixed 60 Hz today and may drain several slices in one rendered
   * frame, and this has to give the same trajectory either way.
   */
  private integrate(dt: number): void {
    if (this.live === 0) return;
    let airborne = 0;
    for (let i = 0; i < MAX; i++) {
      const st = this.state[i];
      if (st === FREE) continue;
      const k = KINDS[this.knd[i]];
      let s = this.size[i];

      if (st === AIR) {
        airborne++;
        this.timer[i] += dt;
        // Horizontal drag, and vertical approach to the drift speed.
        const d = Math.exp(-k.drag * dt);
        this.vx[i] *= d;
        this.vz[i] *= d;
        this.vy[i] += (-k.fall - this.vy[i]) * (1 - Math.exp(-k.fallLambda * dt));
        // Flutter is added to POSITION, not to velocity: drag would eat it, and
        // what a falling leaf actually does is swing across its own fall line.
        this.swayPh[i] += k.swayHz * TAU * dt;
        const sw = Math.sin(this.swayPh[i]) * this.swayAmp[i];
        this.px[i] += (this.vx[i] + this.swayX[i] * sw) * dt;
        this.py[i] += this.vy[i] * dt;
        this.pz[i] += (this.vz[i] + this.swayZ[i] * sw) * dt;
        this.rx[i] += this.spinX[i] * dt;
        this.ry[i] += this.spinY[i] * dt;
        this.rz[i] += this.spinZ[i] * dt;

        // The ground query is the most expensive thing in this loop, so it only
        // runs on a particle that is actually descending.
        if (this.vy[i] < 0) {
          const gy = this.settleY(this.px[i], this.pz[i]);
          if (this.py[i] <= gy) {
            this.py[i] = gy;
            this.state[i] = SETTLED;
            this.timer[i] = k.restMin + Math.random() * k.restSpan;
            this.seq[i] = this.seqNext++;
            this.st.settledTotal++;
            airborne--;
          }
        }
        if (this.state[i] === AIR && this.timer[i] > k.maxAir) {
          this.state[i] = SHRINK;
          this.timer[i] = k.shrink;
          this.fade[i] = k.shrink;
          airborne--;
        }
      } else if (st === SETTLED) {
        // Lie down: the thin axis is y, so damping rx/rz toward zero settles the
        // leaf onto the ground over about a fifth of a second instead of
        // snapping it flat the instant it lands.
        //
        // Toward a RESIDUAL TILT rather than dead flat, reusing the two flutter
        // components (both already random in -1..1) as up to ±0.3 rad of lean.
        // Captured perfectly flat first: from the third-person camera, which
        // looks down a shallow slope at the ground, forty settled leaves were
        // invisible — a 0.3 x 0.2 unit plate seen edge-on is a couple of pixels
        // with no lit face pointing anywhere. A leaf on the ground is curled and
        // propped on whatever it landed on, and a bit of lean is what gives it a
        // face to catch the sun with.
        const lay = 1 - Math.exp(-14 * dt);
        this.rx[i] += (this.swayX[i] * 0.3 - this.rx[i]) * lay;
        this.rz[i] += (this.swayZ[i] * 0.3 - this.rz[i]) * lay;
        this.timer[i] -= dt;
        if (this.timer[i] <= 0) {
          this.state[i] = SHRINK;
          this.timer[i] = k.shrink;
          this.fade[i] = k.shrink;
        }
      } else {
        this.timer[i] -= dt;
        if (this.timer[i] <= 0) {
          this.release(i);
          continue;
        }
        s *= this.timer[i] / this.fade[i];
      }

      _pos.set(this.px[i], this.py[i], this.pz[i]);
      _euler.set(this.rx[i], this.ry[i], this.rz[i]);
      _quat.setFromEuler(_euler);
      _scale.set(k.long * s, k.thick * s, k.wide * s);
      _mat4.compose(_pos, _quat, _scale);
      this.mesh.setMatrixAt(i, _mat4);
    }
    this.dirty = true;
    if (airborne > this.st.maxAirborne) this.st.maxAirborne = airborne;
  }

  /**
   * One simulation slice. `mover` may be null — a modal shop or the dev console
   * freezes the hero, but the leaves already falling behind the overlay have to
   * keep falling, so only the CONTACT TEST needs someone to test.
   */
  update(dt: number, mover: ContactMover | null): void {
    const t0 = perf.enabled ? performance.now() : 0;
    if (mover) this.probeContacts(dt, mover);
    this.integrate(dt);
    if (this.colorDirty && this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
      this.colorDirty = false;
    }
    if (this.dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.dirty = false;
    }
    if (perf.enabled) {
      this.st.ms = performance.now() - t0;
      if (this.st.ms > this.st.msMax) this.st.msMax = this.st.ms;
    }
  }

  // ---- lifecycle ----------------------------------------------------------

  /**
   * Wipe the pool. The ONE place an airborne particle is taken back, and the
   * only place it is defensible: the world it was falling through has just been
   * replaced, so its ground height belongs to a different zone and the hero is
   * not looking at it. `recycledAirborne` deliberately does not count these —
   * it counts the invariant, which is about recycling under pressure.
   */
  private clear(): void {
    this.state.fill(FREE);
    this.freeCount = MAX;
    for (let i = 0; i < MAX; i++) this.freeList[i] = MAX - 1 - i;
    this.live = 0;
    this.acc.fill(0);
    this.wasTouching.fill(0);
    _mat4.makeScale(0, 0, 0);
    for (let i = 0; i < MAX; i++) this.mesh.setMatrixAt(i, _mat4);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.dirty = false;
  }

  setWorld(world: World): void {
    this.world = world;
    this.clear();
  }

  /**
   * Counts, not prose. `recycledAirborne` is the invariant; `retired` and
   * `dropped` are the two exhaustion paths, and the sum of the state counts is
   * the pool. `spawned_<kind>` splits the lifetime spawn total by kind, which
   * is how the snow mix states its own proportion — `spawned_snow /
   * (spawned_leaf + spawned_snow)` on a snowy tree should land on the
   * `snowShare` the column asks for, and be exactly 0 on a temperate one.
   */
  stats(): Record<string, number> {
    let air = 0;
    let settled = 0;
    let shrinking = 0;
    for (let i = 0; i < MAX; i++) {
      const s = this.state[i];
      if (s === AIR) air++;
      else if (s === SETTLED) settled++;
      else if (s === SHRINK) shrinking++;
    }
    const out: Record<string, number> = {
      pool: MAX,
      free: this.freeCount,
      airborne: air,
      settled,
      shrinking,
      live: this.live,
      ...this.st,
      ms: +this.st.ms.toFixed(4),
      msMax: +this.st.msMax.toFixed(4),
    };
    for (let k = 0; k < KINDS.length; k++) out[`spawned_${KINDS[k].id}`] = this.kindSpawned[k];
    return out;
  }

  /**
   * TEST HOOK (see __dbgTouchFx in main.ts). Force `n` particles at the hero
   * without finding a tree first — the only practical way to drive the pool to
   * exhaustion on demand and show what the policy does there. Returns how many
   * were actually placed, which is the measurement.
   *
   * It applies the SNOW OVERLAY the real probe would, sampled at the hero's own
   * column rather than at a tree he may not be standing in. Without that a
   * forced burst would be the one emission path in the system that cannot
   * produce a mix, which is exactly backwards for the hook whose job is to
   * measure the pool under a mix.
   */
  forceBurst(mover: ContactMover, n: number): number {
    const s = 0; // leaves — the only source, and the only one with a snow ramp
    const p = mover.position;
    _point.x = p.x;
    _point.y = p.y + CHEST_Y + 1.6;
    _point.z = p.z;
    _point.spread = 0.6;
    _point.dirX = 1;
    _point.dirZ = 0;
    const cover = this.world.snowCoverAt(p.x, p.z);
    _point.snow = snowShare(cover, SOURCES[s]);
    _point.color.setHex(LEAF_BASE);
    _point.color.lerp(NEEDLE_COL, cover);
    let placed = 0;
    for (let i = 0; i < n; i++) if (this.spawn(this.pickKind(s, _point), _point)) placed++;
    return placed;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
