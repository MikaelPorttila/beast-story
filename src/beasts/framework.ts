import * as THREE from 'three';
import { ELEMENT_COLORS, MAX_STEP_UP, BEAST_CYCLE_SLOTS } from '../core/types';
import { CarrierRide } from '../world/carriers';
import type {
  ElementType, EventBus, FetchJob, BeastAction, BeastAnimCtx, BeastRig, BeastSpecies,
  BeastStats, SkillDef, World,
} from '../core/types';

// ---------------------------------------------------------------------------
// Skill definition registry
// ---------------------------------------------------------------------------
// The framework needs SkillDefs to know learnAtLevel and to include the
// learned SkillDef in beastLevelUp events. The skills module registers its
// defs here during boot. If a def is missing we fall back to an index-based
// learn schedule so beasts still progress.
const skillRegistry = new Map<string, SkillDef>();

export function registerSkillDefs(defs: Iterable<SkillDef>): void {
  for (const d of defs) skillRegistry.set(d.id, d);
}

export function getSkillDef(id: string): SkillDef | undefined {
  return skillRegistry.get(id);
}

// ---------------------------------------------------------------------------
// Shared temps (module-level; single-threaded, reused every frame)
// ---------------------------------------------------------------------------
const _dummy = new THREE.Object3D();
const TWO_PI = Math.PI * 2;

function angleDelta(a: number, b: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return d;
}

/** Frame-rate independent angular damping toward a target angle. */
function dampAngle(cur: number, target: number, lambda: number, dt: number): number {
  return cur + angleDelta(cur, target) * (1 - Math.exp(-lambda * dt));
}

/** Frame-rate independent scalar damping. */
function damp(cur: number, target: number, lambda: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-lambda * dt));
}

function easeOutBack(t: number): number {
  const c1 = 1.70158, c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

function smoothstep01(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * Ceiling on any cycle integrated through `BeastAnimCtx.cycle()`, in rad/s.
 * 50.3 rad/s = 8.0 Hz.
 *
 * Two numbers bracket it. Above: the fastest beat anyone authored is Lumimoth's
 * panic flap at 34 rad/s (5.4 Hz), and its cruising wingbeat tops out at
 * 24 rad/s (3.8 Hz) — so 8 Hz clips nothing that exists and is a safety rail,
 * not a tuning knob. Below: the sim runs a fixed 60 Hz, so 8 Hz is 7.5 samples
 * per cycle, about the coarsest a beat can be sampled and still read as a beat
 * rather than as strobing; past ~15 Hz it aliases outright. Biology agrees that
 * this is the right neighbourhood — a swallow beats at 7-9 Hz and a sparrow at
 * ~13 Hz, so a beast-sized flyer belongs in single digits and never at the fifty
 * a runaway phase produced.
 *
 * The integration in cycle() is what actually fixed the flicker; this cap is
 * what stops a future `freq` expression — or a moveSpeed that escapes 0..1 —
 * from reintroducing it in a milder form.
 */
const MAX_CYCLE_RATE = 50.3;

/**
 * THE ANIMATION CLOCK A SPECIES POSES AGAINST — one per animated body.
 *
 * Lifted out of `BeastActor` when a second caller appeared: a WILD beast is an
 * `Enemy` wearing a `BeastSpecies` body (see src/combat/enemies.ts), and it has
 * to hand `species.animate` the same contract a companion does. Copying the four
 * lines instead would have forked the one thing in this file that is genuinely
 * subtle — the integrated phase — into a second place that could drift from the
 * argument written on `BeastAnimCtx.cycle` in core/types.ts.
 *
 * `ctx` is bound ONCE, at construction, and closes over this instance's own
 * phase array: no allocation on any frame, and no way for two bodies to share a
 * cycle. A caller writes `action`/`actionTime`/`time`/`moveSpeed`/`dt` onto it
 * just before calling `animate`, and `dt` is read back off the ctx by `cycle`
 * rather than passed, because the species calls `cycle` and the caller does not.
 */
export class BeastAnimClock {
  /**
   * Integrated phase per cycle slot — see BeastAnimCtx.cycle().
   *
   * Deliberately NOT wrapped to 0..2pi. Species derive trailing waves and
   * harmonics as constant multiples of a phase (`ph * 0.9`, `ph * 1.6`), and a
   * wrap at 2pi puts a discontinuity in every one of those whose factor is not
   * an integer — the same pop this whole mechanism exists to remove. Float64
   * carries it instead: an hour at the 8 Hz ceiling reaches 1.8e5 rad, where a
   * double still resolves 3e-11 rad, so nothing measurable is lost. Float32
   * would NOT do — it breaks down around 1e4 rad, roughly ten minutes in.
   */
  private readonly cycles = new Float64Array(BEAST_CYCLE_SLOTS);

  readonly ctx: BeastAnimCtx = {
    action: 'idle', actionTime: 0, time: 0, moveSpeed: 0, dt: 0,
    cycle: (slot: number, freq: number): number => {
      const w = freq > MAX_CYCLE_RATE ? MAX_CYCLE_RATE : freq > 0 ? freq : 0;
      this.cycles[slot] += w * this.ctx.dt;
      return this.cycles[slot];
    },
  };
}

const GRAVITY = 22;
const TELEPORT_DIST = 40;
const REVIVE_SECONDS = 8;
const POOF_SECONDS = 0.5;

// ---------------------------------------------------------------------------
// Mount form
// ---------------------------------------------------------------------------
/**
 * A ridden beast grows into a "mount form".
 *
 * Every beast in this game is knee-high: Emberfox's rig is a metre at the ears, a
 * Galebird barely more than half that, against a 1.7-unit hero. Seating a rider
 * on an unscaled beast puts a man on a housecat — captured, the hero completely
 * occluded the fox he was riding, and the Galebird swallowed him. So the rig is
 * scaled while ridden, eased over RIDE_SCALE_LAMBDA (~0.25 s to 90%) so it
 * reads as the beast swelling into its mount form rather than popping.
 *
 * MOUNT_HEIGHT is what a mount is scaled TO, not by: 2.1 units puts the mount
 * comfortably TALLER than its 1.7-unit rider, which is what makes the pair read
 * as a mount and not as a man carrying a pet, and it means the seat height, the
 * camera framing and the collision radius are one set of numbers rather than
 * ten. MOUNT_MAX_SCALE caps the smallest rigs; past ~3x, an 0.08-unit voxel is
 * a quarter-unit slab and the model stops reading as the beast you picked.
 *
 * It is scaled against the rig's MEASURED silhouette, not `rig.height` — that
 * field is a nominal body height each species declares for spacing, and for a
 * bird whose wings reach well past it, scaling by it seats the rider inside the
 * mount. See `silhouetteTop`.
 */
const MOUNT_HEIGHT = 2.1;
const MOUNT_MAX_SCALE = 3.2;
const RIDE_SCALE_LAMBDA = 9;
/**
 * Where on that silhouette the saddle is, as a fraction of its full height.
 *
 * The silhouette is measured to the highest voxel, and on most of these rigs
 * that is an ear, a horn or a raised tail rather than the back you would sit on.
 * Measured rest-pose tops: Emberfox 1.21 to the ear tips with its back around
 * 0.75, Galebird 0.80 with its back around 0.55 — so the back lands near 0.65
 * of the total. 0.72 puts the rider's hips a hand's breadth above that, which
 * captured as sitting ON the animal rather than sunk into it (0.88 was tried
 * first and left him floating half a unit clear of a fox's shoulders).
 */
const SEAT_FRACTION = 0.72;

/**
 * Where the MountController wants a ridden beast this slice. A single instance is
 * reused every frame — nothing here is retained past the call.
 */
export interface BeastRideState {
  x: number; y: number; z: number;
  /** Final world yaw; the mount owns the smoothing, the beast just wears it. */
  yaw: number;
  pitch: number;
  bank: number;
  /** Horizontal velocity, so a dismount hands the beast its momentum back. */
  vx: number; vz: number;
  /** 0..1 gait blend, already normalised against the mount's own top speed. */
  speed01: number;
  /** Base action to animate: 'fly' for a flyer, 'run'/'walk'/'idle' on foot. */
  action: BeastAction;
}

const TRANSIENT_DURATIONS: Partial<Record<BeastAction, number>> = {
  attack: 0.5, cast: 0.7, special: 0.95, hurt: 0.45, happy: 1.35,
};

// ---------------------------------------------------------------------------
// Fetch errands
// ---------------------------------------------------------------------------
// A beast on an errand steers to a claimed drop instead of its station point,
// grabs it, and hurries back. WHICH drops are worth fetching is not decided
// here — main.ts offers the job (see beginFetch); this half only runs it, and
// the two abort rules below exist so a bad offer cannot strand a beast.
//
// How far from the OWNER a drop may be and still be worth walking to. The
// offer already filters on distance, so this is the beast's own bail-out for an
// owner who runs off mid-errand.
const FETCH_LEASH = 26;
// Give up on an errand that takes this long. The case this exists for is a
// drop on a ledge the beast cannot climb: without it the beast pushes into the
// hillside until the drop expires 42 s later, station point abandoned.
const FETCH_TIMEOUT = 12;
// Horizontal grab reach, squared. 0.75 units — deliberately wider than the
// player's own 0.67-unit collect radius, because a grounded beast arrives with
// its feet at the drop while a flyer arrives above it.
const FETCH_REACH_SQ = 0.75 * 0.75;
// Seconds of hurrying back after a successful grab. Purely how it reads: the
// beast turns straight around with the loot rather than sauntering, which is what
// sells the trip as an errand instead of a wander.
const FETCH_CARRY = 1.6;
// Errand pace as a multiplier on follow speed. Kept small on purpose: the gait
// is driven by speed01 normalised against the UNBOOSTED follow speed, so a big
// multiplier pins the run cycle at full blend while the beast covers ground
// faster than the legs claim to — it skates. 1.25 is not visible as a mismatch.
const FETCH_HUSTLE = 1.25;

// ---------------------------------------------------------------------------
// Poof particle burst (teleport / revive flourish)
// ---------------------------------------------------------------------------
const PUFF_COUNT = 12;
let puffGeo: THREE.BoxGeometry | null = null;
let puffMat: THREE.MeshStandardMaterial | null = null;

class PoofPuff {
  private mesh: THREE.InstancedMesh;
  private dirs: Float32Array;   // per-instance unit dir xyz
  private seeds: Float32Array;  // per-instance speed + size
  private life = 0;
  private center = new THREE.Vector3();
  private baseRadius = 0.5;

  constructor(private scene: THREE.Scene) {
    puffGeo ??= new THREE.BoxGeometry(1, 1, 1);
    puffMat ??= new THREE.MeshStandardMaterial({
      color: 0xf4faff, emissive: 0x9fd8ff, emissiveIntensity: 0.55, roughness: 1,
    });
    this.mesh = new THREE.InstancedMesh(puffGeo, puffMat, PUFF_COUNT);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.dirs = new Float32Array(PUFF_COUNT * 3);
    this.seeds = new Float32Array(PUFF_COUNT * 2);
    for (let i = 0; i < PUFF_COUNT; i++) {
      const theta = Math.random() * TWO_PI;
      const y = Math.random() * 1.4 - 0.2;
      const r = Math.sqrt(Math.max(0, 1 - y * y * 0.4));
      this.dirs[i * 3] = Math.cos(theta) * r;
      this.dirs[i * 3 + 1] = y;
      this.dirs[i * 3 + 2] = Math.sin(theta) * r;
      this.seeds[i * 2] = 0.7 + Math.random() * 0.9;      // speed
      this.seeds[i * 2 + 1] = 0.55 + Math.random() * 0.8; // size
    }
    scene.add(this.mesh);
  }

  burst(center: THREE.Vector3, radius: number): void {
    this.center.copy(center);
    this.baseRadius = radius;
    this.life = 0.55;
    this.mesh.visible = true;
  }

  /** Retire the cloud now. See BeastActor.setVisible for who needs that. */
  clear(): void {
    this.life = 0;
    this.mesh.visible = false;
  }

  update(dt: number): void {
    if (this.life <= 0) return;
    this.life -= dt;
    if (this.life <= 0) { this.mesh.visible = false; return; }
    const t = 1 - this.life / 0.55; // 0..1
    const spread = this.baseRadius + (1 - (1 - t) * (1 - t)) * 1.5;
    for (let i = 0; i < PUFF_COUNT; i++) {
      const sp = this.seeds[i * 2], sz = this.seeds[i * 2 + 1];
      _dummy.position.set(
        this.center.x + this.dirs[i * 3] * spread * sp,
        this.center.y + this.dirs[i * 3 + 1] * spread * sp,
        this.center.z + this.dirs[i * 3 + 2] * spread * sp,
      );
      const s = Math.max(0.001, (1 - t) * 0.2 * sz);
      _dummy.scale.setScalar(s);
      _dummy.rotation.set(t * 4 * sp, t * 5 * sz, 0);
      _dummy.updateMatrix();
      this.mesh.setMatrixAt(i, _dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.dispose(); // instanced buffers; shared geo/mat stay alive
  }
}

// ---------------------------------------------------------------------------
// Strike FX — the swipe arc and the dust a beast kicks up
// ---------------------------------------------------------------------------
/**
 * WHY THIS EXISTS. A critic reading a real-game frame of a mid-attack Drakelet
 * reported "no arc trail, no anticipation smear, no dust puff at the feet, no
 * squash-and-stretch — a rigid static pose", and half of that was unfair: every
 * species DOES author a coil/lunge/recover with squash on the body. What the
 * frame genuinely lacked is the layer Cube World puts over the top of a swing —
 * a bright arc through the air and a scuff on the ground. A pose alone cannot
 * sell an impact in a still, because a still has no motion blur and no velocity;
 * the arc IS the velocity, drawn.
 *
 * Both effects are drawn as VOXELS out of the poof burst's own unit-box geometry
 * rather than as textured ribbons or sprites, for two reasons:
 *
 * 1. It is the game's language. Nothing in this world is a texture; a swipe made
 *    of shrinking cubes reads as belonging to it, where a soft additive ribbon
 *    reads as a different game's particle system pasted on.
 * 2. SHADER COST IS ZERO. Both materials are configured with exactly the same
 *    key set as `puffMat` — `{color, emissive, emissiveIntensity, roughness}` on
 *    a MeshStandardMaterial drawn through an InstancedMesh — and three keys its
 *    program cache on material parameters, never on colour values. So these
 *    share the poof's already-linked program and add no permutation for
 *    warmUpShaders() to miss. Nothing here is transparent for the same reason:
 *    the fade is done by shrinking the cube to nothing, which is also what the
 *    poof does and what reads correctly at this art scale.
 *
 * The arc's emissive is the species' element colour, saturated, at intensity
 * 1.35 — over both of PostFX's selective-bloom thresholds (emissiveIntensity
 * >= 0.30 and a max-min channel spread > 0.12, see post.ts tagSources), so the
 * slash blooms. The dust's emissive is a near-neutral 0x6b6152 at 0.25, under
 * BOTH thresholds on purpose: a glowing dust cloud is a smoke grenade.
 */
// 13, up from 9. A slash is a RIBBON, and nine segments long enough to overlap
// into one had to be 0.42 of the reach each — photographed, that made the
// Emberfox's swing four white slabs the size of its own head, each individually
// legible as a box. More, smaller segments buy the same continuous blade out of
// pieces small enough that none of them reads as a box on its own.
const ARC_SEGS = 13;
/** Seconds a swipe arc lives. Shorter than any attack transient — the arc is the
 *  strike, not the recovery, and one that outlives the lunge reads as a banner. */
const ARC_TIME = 0.26;
/** Fraction of the sweep the trail lags behind the leading edge. 0.55 gives a
 *  comet: a bright head with five or six segments still alive behind it. At 0.25
 *  the arc was three cubes and read as a spark, at 1.0 the whole arc is lit at
 *  once and reads as a static crescent decal. */
const ARC_TRAIL = 0.55;
const _white = new THREE.Color(0xffffff);

/**
 * Frames a strike-FX mesh stays visible-but-degenerate after it is built, so its
 * program is LINKED DURING BOOT.
 *
 * This is the expensive mistake this codebase makes available, and measuring for
 * it caught it: `?perf=1` over a photo-mode run with `anim=attack` reported
 * exactly one program link at frame 12, while the identical run without the
 * attack reported none. The theory that a MeshStandardMaterial configured with
 * the same key set as `puffMat` would share its already-linked program was
 * simply wrong in practice — most likely because the poof's own program is not
 * linked at boot either (a beast's first teleport is silent, so nothing ever
 * bursts during warmUpShaders).
 *
 * The fix costs nothing and needs no cooperation from main.ts, which owns
 * warmUpShaders() and is another agent's file: both meshes are born VISIBLE with
 * every instance matrix scaled to 1e-4, so warmUpShaders' eleven staged renders
 * draw them — a handful of sub-pixel triangles — and link the program while the
 * loading screen is still up. The counter is decremented from update(), which
 * the warm-up renders never call, so the meshes cannot go dark before the sweep
 * has seen them however long boot takes.
 */
const FX_WARM_FRAMES = 8;

/** Park every instance of a strike-FX mesh at a sub-pixel scale. */
function parkInstances(mesh: THREE.InstancedMesh, y: number): void {
  _dummy.position.set(0, y, 0);
  _dummy.rotation.set(0, 0, 0);
  _dummy.scale.setScalar(0.0001);
  _dummy.updateMatrix();
  for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, _dummy.matrix);
  mesh.instanceMatrix.needsUpdate = true;
}

class SwipeArc {
  private mesh: THREE.InstancedMesh;
  private mat: THREE.MeshStandardMaterial;
  private life = 0;
  private dir: 1 | -1 = 1;
  private reach = 0.6;
  private cy = 0.4;
  private cz = 0.2;
  private rise = 0.12;

  constructor(parent: THREE.Object3D, element: ElementType) {
    puffGeo ??= new THREE.BoxGeometry(1, 1, 1);
    const c = ELEMENT_COLORS[element];
    // Albedo is the element colour lifted 55% toward white, emissive is the
    // element colour at full saturation. Both halves earn their keep: the first
    // capture of this used the raw element colour for both and the Emberfox's
    // fire-orange slash crossed a fire-orange fox — a warm smear over the muzzle
    // that a still could not tell from the beast's own paint. A near-white blade
    // with a coloured glow separates from ANY species' body, including its own
    // element's, which is the case that has to work.
    this.mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(c).lerp(_white, 0.40).getHex(),
      emissive: c, emissiveIntensity: 0.8, roughness: 1,
    });
    this.mesh = new THREE.InstancedMesh(puffGeo, this.mat, ARC_SEGS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Never a caster and never a receiver: a slash is light, and a hard-edged
    // shadow of nine boxes swinging under the beast is instantly a bug.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    parkInstances(this.mesh, 0);   // see FX_WARM_FRAMES — born visible, drawn at 1e-4
    parent.add(this.mesh);
  }

  private warm = FX_WARM_FRAMES;

  /**
   * Rig-space geometry of the swing. Called once, after the rig is measured.
   *
   * The swing is a 1.9-radius circle whose centre is pushed THREE QUARTERS OF A
   * RADIUS FORWARD, not one centred on the beast.
   *
   * Two captures got here. At reach 1.55r centred on the origin the blade's own
   * thickness put it inside the beast: on the Emberfox (radius 0.35) the leading
   * segment landed across the muzzle and read as a lens flare on the face. At
   * 2.4r, still centred, it cleared the flanks but swept straight THROUGH the
   * skull and both ears, which is worse — it hides the one part of a beast that
   * carries its read. Offsetting the centre forward puts the whole arc ahead of
   * the animal: nearest point 1.85 radii out, midpoint 2.65 radii out, ends 1.5
   * radii to each side. At 0.5r of offset the blade still clipped the Emberfox's
   * muzzle mid-sweep; 0.75r clears it.
   *
   * Height likewise dropped from 0.6h +- 0.26h (which started ABOVE the ear
   * tips) to 0.5h +- 0.22h, so the rake runs chest-high down to knee-high — a
   * claw's path, not a halo's.
   */
  configure(radius: number, height: number): void {
    this.reach = radius * 1.9;
    this.cz = radius * 0.75;
    this.cy = height * 0.5;
    this.rise = height * 0.22;
  }

  /** Start a swing. Alternating direction so a combo does not repeat one pose. */
  swing(): void {
    this.life = ARC_TIME;
    this.dir = this.dir === 1 ? -1 : 1;
    this.mesh.visible = true;
  }

  update(dt: number): void {
    if (this.warm > 0 && --this.warm === 0 && this.life <= 0) this.mesh.visible = false;
    if (this.life <= 0) return;
    this.life -= dt;
    if (this.life <= 0) { this.mesh.visible = this.warm > 0; return; }
    const u = 1 - this.life / ARC_TIME;
    // Ease the head out so the arc leaves fast and settles — a linear sweep
    // reads as a windscreen wiper.
    const head = (1 - (1 - u) * (1 - u)) * (1 + ARC_TRAIL);
    const R = this.reach;
    for (let i = 0; i < ARC_SEGS; i++) {
      const fi = i / (ARC_SEGS - 1);
      const age = head - fi;
      // Crescent profile, not a wedge. `1 - age/TRAIL` put the biggest segment
      // at the LEADING edge, and captured in the real game (shots/_pa2-m-28)
      // that made the swing a solid white plate across a third of the fox with
      // its blunt end pointing the way it was travelling — the exact opposite of
      // a slash. sin(pi*x)^0.7 tapers to a point at BOTH ends and swells in the
      // middle, which is the shape every hand-drawn swipe in the genre has.
      const x = age / ARC_TRAIL;
      const w = age < 0 || age > ARC_TRAIL ? 0 : Math.sin(Math.PI * x) ** 0.7;
      if (w <= 0.001) {
        _dummy.position.set(0, this.cy, 0);
        _dummy.rotation.set(0, 0, 0);
        _dummy.scale.setScalar(0.0001);
      } else {
        // Sweep 0.95 rad to -0.95 rad about the rig's own Y, i.e. a 109-degree
        // rake across the front. `a` also drives the height, so the blade comes
        // DOWN as it crosses instead of staying a flat halo. Narrowed from
        // +-1.15: at 132 degrees the two ends sat almost beside the beast's hips,
        // where a camera behind the shoulder cannot see them, so a third of the
        // swing was spent off-screen.
        const a = this.dir * (0.95 - 1.9 * fi);
        _dummy.position.set(
          Math.sin(a) * R, this.cy + a * this.rise, this.cz + Math.cos(a) * R,
        );
        // rotation.y = a puts local +X on the arc TANGENT (the position is at
        // angle a from +Z, so the tangent is (cos a, 0, -sin a) — exactly local
        // +X after the yaw). The z-roll rakes the blade over as it travels.
        _dummy.rotation.set(0, a, -a * 0.5);
        // Long on the tangent so consecutive segments overlap into one blade,
        // tall enough to read, thin radially: 0.26/0.30/0.10 of the reach.
        // Segment pitch along the arc is R*1.9/12 = 0.158R, so 0.26R overlaps
        // 1.6x — continuous, with no gaps at the fast end of the sweep. Height
        // came down from 0.55R to 0.30R and then to 0.22R: at 0.55 the blade was
        // 0.46 units on a 0.62-unit-tall fox, a slash three quarters as tall as
        // the animal making it; at 0.30 it still photographed as a plate rather
        // than a ribbon. The tangent length is deliberately NOT cut with it —
        // long and thin is what makes a swipe read as speed.
        _dummy.scale.set(0.26 * R * w, 0.22 * R * w, 0.09 * R * w);
      }
      _dummy.updateMatrix();
      this.mesh.setMatrixAt(i, _dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.mat.dispose();
  }
}

const DUST_COUNT = 10;
const DUST_LIFE = 0.42;
let dustMat: THREE.MeshStandardMaterial | null = null;

class DustPuff {
  private mesh: THREE.InstancedMesh;
  private dirs: Float32Array;
  private seeds: Float32Array;
  private life = 0;
  private center = new THREE.Vector3();
  private spread = 0.4;
  private power = 1;

  constructor(private scene: THREE.Scene) {
    puffGeo ??= new THREE.BoxGeometry(1, 1, 1);
    // Warm pale grit. See the class comment above for why the emissive is a
    // desaturated 0x6b6152 at 0.25 — it must fall UNDER both bloom thresholds.
    dustMat ??= new THREE.MeshStandardMaterial({
      color: 0xd6cbb4, emissive: 0x6b6152, emissiveIntensity: 0.25, roughness: 1,
    });
    this.mesh = new THREE.InstancedMesh(puffGeo, dustMat, DUST_COUNT);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    parkInstances(this.mesh, 0);   // see FX_WARM_FRAMES — born visible, drawn at 1e-4
    this.dirs = new Float32Array(DUST_COUNT * 3);
    this.seeds = new Float32Array(DUST_COUNT * 2);
    for (let i = 0; i < DUST_COUNT; i++) {
      const theta = Math.random() * TWO_PI;
      // Dust goes OUT, barely up. A ground scuff that rises like a poof is
      // smoke; 0.10-0.45 of vertical against a full unit of radial keeps it
      // hugging the floor, which is what makes it read as the floor's material.
      this.dirs[i * 3] = Math.cos(theta);
      this.dirs[i * 3 + 1] = 0.10 + Math.random() * 0.35;
      this.dirs[i * 3 + 2] = Math.sin(theta);
      this.seeds[i * 2] = 0.6 + Math.random() * 0.8;      // speed
      this.seeds[i * 2 + 1] = 0.5 + Math.random() * 0.85; // size
    }
    scene.add(this.mesh);
  }

  /** `power` 0..1 scales both the throw distance and the grain size. */
  burst(x: number, y: number, z: number, radius: number, power: number): void {
    // A second burst inside the first restarts it rather than queuing: at this
    // size two overlapping clouds are indistinguishable from one.
    this.center.set(x, y, z);
    this.spread = radius;
    this.power = power;
    this.life = DUST_LIFE;
    this.mesh.visible = true;
  }

  private warm = FX_WARM_FRAMES;

  /**
   * Retire the cloud now. `warm > 0` is kept because a beast benched at boot has
   * never been drawn yet — see FX_WARM_FRAMES and BeastActor.setVisible.
   */
  clear(): void {
    this.life = 0;
    this.mesh.visible = this.warm > 0;
  }

  update(dt: number): void {
    if (this.warm > 0 && --this.warm === 0 && this.life <= 0) this.mesh.visible = false;
    if (this.life <= 0) return;
    this.life -= dt;
    if (this.life <= 0) { this.mesh.visible = this.warm > 0; return; }
    const t = 1 - this.life / DUST_LIFE;
    // Decelerating throw (1-(1-t)^2): grit leaves fast and stops, it does not
    // drift at constant speed the way a smoke puff does.
    const out = this.spread * (0.35 + (1 - (1 - t) * (1 - t)) * 1.35 * this.power);
    for (let i = 0; i < DUST_COUNT; i++) {
      const sp = this.seeds[i * 2], sz = this.seeds[i * 2 + 1];
      _dummy.position.set(
        this.center.x + this.dirs[i * 3] * out * sp,
        this.center.y + this.dirs[i * 3 + 1] * out * sp * 0.75,
        this.center.z + this.dirs[i * 3 + 2] * out * sp,
      );
      // Shrink to nothing rather than fade: no transparency, no new program.
      // 0.30 of the beast's radius, up from 0.17. At 0.17 a grain on the Emberfox
      // (radius 0.35) was 0.05 units — smaller than one of the fox's own 0.08
      // voxels, so the cloud photographed as sand-coloured noise on the sand.
      // A grain has to be at least a body voxel to read as debris.
      const s = Math.max(0.0001, (1 - t) * 0.30 * sz * this.spread * (0.55 + 0.45 * this.power));
      _dummy.scale.setScalar(s);
      _dummy.rotation.set(t * 2.2 * sp, t * 3.1 * sz, 0);
      _dummy.updateMatrix();
      this.mesh.setMatrixAt(i, _dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
  }
}

// ---------------------------------------------------------------------------
// Light travel — a companion that cannot walk to you travels as light
// ---------------------------------------------------------------------------
/**
 * WHY THIS EXISTS. Issue #70. Walkers keep their footing on the ground, so they
 * cannot follow a hero into the air — they follow his COLUMN. The leash that
 * was supposed to catch that
 * (`TELEPORT_DIST`) measures x and z only, so a hero circling on a galebird a
 * hundred units up, or standing on Skyhaven's deck, is nine metres away by the
 * only measure a walker takes: it piles up on the meadow directly underneath,
 * animating a follow it will never complete, and is still down there when he
 * lands somewhere else. Flyers now follow the owner's altitude as bodies (issue
 * #91); their equivalent unreachable medium is a deep dive.
 *
 * A GROUNDED COMPANION IS NOT PATHED UPWARD, IT IS WITHDRAWN. Making walkers
 * fly would mean a second locomotion for every species and a beast standing on
 * nothing; letting them stay behind is the bug. So a walker whose owner has got
 * out of reach dissolves into a streak of light, rides along with him with no
 * physics, no collision and nothing to target, and re-forms beside him the
 * moment there is a surface it could stand on again. A flyer uses the same
 * transition only underwater and returns at the normal swim line.
 *
 * THE MEASUREMENT IS THE ONE THE LANDING USES. Both the leaving and the
 * arriving read `reach` — the owner's feet above the surface a beast would be
 * put down on at its own station point — so the two can never disagree about
 * whether the ground is within reach. Anything else flickers: a hero standing
 * on a canopy platform is fourteen units over the forest floor his companion
 * would land on, and a rule that beamed him out on one number and back in on
 * another would strobe the beast in and out for as long as he stood there.
 */
/** Owner's feet above a grounded beast's landing surface, past which it withdraws. */
const BEAM_RISE = 13;
/**
 * ... and within which it re-forms. 4.5 is a drop a beast survives visibly — the
 * hero's own step test allows 0.5 and his fall damage starts far past this — so
 * "he has landed" and "he is skimming the meadow on a galebird" both qualify,
 * which is what the issue asks for. The gap between the two numbers is
 * hysteresis and nothing else; see BEAM_RISE for what happens without it.
 */
const BEAM_LAND = 4.5;
/**
 * The combat exception. A support beast is wanted at exactly the moment the
 * player is being hit, and a hero hovering ten units up while something claws at
 * him is inside neither the walking case nor the landed one. main.ts sets
 * `supportNeeded` when there is a live enemy near him; while it stands, a
 * companion will re-form from three times as high — it still needs a surface,
 * so this cannot put one in open sky.
 */
const BEAM_LAND_FIGHT = 14;
/**
 * How high over the owner's feet the travelling wisp rides. Shoulder height on
 * a 1.7-unit hero: high enough that the hero's own body does not hide it from a
 * camera looking slightly down, low enough that it is not mistaken for a bird.
 */
const BEAM_WISP_RISE = 1.35;
/** Seconds the departure/arrival column lives. */
const BEAM_FLASH = 0.5;
/** Height of that column, in units. Two hero-heights: read at a glance, gone. */
const BEAM_HEIGHT = 5.5;
const BEAM_SEGS = 14;
/** Instances of the above spent on the in-transit wisp. */
const WISP_SEGS = 5;

/**
 * The streak itself. ONE InstancedMesh in two modes — a one-shot COLUMN at a
 * departure or an arrival, and a persistent WISP that rides along beside the
 * owner while the beast is in transit — because they are never on screen
 * together for the same beast and a second mesh is a second draw call per
 * companion for no picture.
 *
 * Built out of the poof's own unit box on a MeshStandardMaterial, for the two
 * reasons in the strike-FX note above: it is the game's language, and it adds no
 * shader permutation. Emissive is the species' element colour at 1.4 — over both
 * of PostFX's selective-bloom thresholds, so the beam glows rather than reading
 * as a stack of coloured dice.
 */
class LightBeam {
  private mesh: THREE.InstancedMesh;
  private mat: THREE.MeshStandardMaterial;
  private life = 0;
  private dir: 1 | -1 = 1;
  private origin = new THREE.Vector3();
  private wispAt = new THREE.Vector3();
  private wispOn = false;
  private seeds: Float32Array;
  private clock = 0;

  constructor(private scene: THREE.Scene, element: ElementType) {
    puffGeo ??= new THREE.BoxGeometry(1, 1, 1);
    const c = ELEMENT_COLORS[element];
    // Same split as the swipe arc, and for the same reason: a near-white body
    // with a coloured glow separates from every species' paint including its
    // own element's. Lifted further than the arc (0.62 against 0.40) because a
    // beam is read against the SKY, which the arc never is.
    this.mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(c).lerp(_white, 0.62).getHex(),
      emissive: c, emissiveIntensity: 1.4, roughness: 1,
    });
    this.mesh = new THREE.InstancedMesh(puffGeo, this.mat, BEAM_SEGS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    parkInstances(this.mesh, 0);   // see FX_WARM_FRAMES — born visible, drawn at 1e-4
    this.seeds = new Float32Array(BEAM_SEGS * 2);
    for (let i = 0; i < BEAM_SEGS; i++) {
      this.seeds[i * 2] = 0.55 + Math.random() * 0.9;      // speed
      this.seeds[i * 2 + 1] = 0.6 + Math.random() * 0.75;  // size
    }
    scene.add(this.mesh);
  }

  private warm = FX_WARM_FRAMES;

  /** A pillar at (x, y, z) running UP (`dir` 1, a departure) or DOWN (-1). */
  column(x: number, y: number, z: number, dir: 1 | -1): void {
    this.origin.set(x, y, z);
    this.dir = dir;
    this.life = BEAM_FLASH;
    this.mesh.visible = true;
  }

  /** Where the travelling wisp is this slice. Call BEFORE update(). */
  wisp(x: number, y: number, z: number): void {
    this.wispAt.set(x, y, z);
    this.wispOn = true;
  }

  /**
   * Retire the streak now — both modes, column and wisp. `warm > 0` is kept for
   * the same reason DustPuff.clear keeps it: an unowned beast is hidden at boot
   * before its mesh has been drawn once. See BeastActor.setVisible.
   */
  clear(): void {
    this.life = 0;
    this.wispOn = false;
    this.mesh.visible = this.warm > 0;
  }

  /**
   * Size of the largest cube the renderer would draw for this streak, or 0 when
   * the mesh is hidden. A MEASUREMENT, for probes: a mesh parked by
   * FX_WARM_FRAMES is `visible` and yet draws nothing at 1e-4, so "is a streak
   * on screen?" can only be answered from the instance matrices themselves.
   * Allocation-free but O(BEAM_SEGS) — a diagnostic, never a frame-loop read.
   */
  get drawnSize(): number {
    if (!this.mesh.visible) return 0;
    let max = 0;
    for (let i = 0; i < this.mesh.count; i++) {
      this.mesh.getMatrixAt(i, _dummy.matrix);
      max = Math.max(max, _dummy.matrix.getMaxScaleOnAxis());
    }
    return max;
  }

  update(dt: number): void {
    this.clock += dt;
    if (this.warm > 0 && --this.warm === 0 && this.life <= 0 && !this.wispOn) {
      this.mesh.visible = false;
    }
    if (this.life > 0) {
      this.life -= dt;
      if (this.life > 0) { this.drawColumn(); this.wispOn = false; return; }
    }
    if (this.wispOn) { this.drawWisp(); this.wispOn = false; return; }
    this.mesh.visible = this.warm > 0;
  }

  private drawColumn(): void {
    this.mesh.visible = true;
    const t = 1 - this.life / BEAM_FLASH;   // 0..1
    for (let i = 0; i < BEAM_SEGS; i++) {
      const sp = this.seeds[i * 2], sz = this.seeds[i * 2 + 1];
      // Each cube starts at its own height up the pillar and runs on along it,
      // so the shape reads as light TRAVELLING rather than as a bar switched on.
      const along = (i / BEAM_SEGS + t * 0.75 * sp) % 1;
      _dummy.position.set(
        this.origin.x + Math.sin(i * 2.4 + this.clock) * 0.10,
        this.origin.y + (this.dir > 0 ? along : 1 - along) * BEAM_HEIGHT,
        this.origin.z + Math.cos(i * 1.7 + this.clock) * 0.10,
      );
      // Shrink to nothing rather than fade — no transparency, no new program.
      // Tapered along the pillar as well as over time, so it thins out into the
      // sky instead of ending on a hard rim.
      const taper = 1 - Math.abs(along - 0.15) * 0.55;
      _dummy.scale.setScalar(Math.max(0.0001, (1 - t) * 0.30 * sz * taper));
      _dummy.rotation.set(t * 3 * sp, t * 4 * sz, 0);
      _dummy.updateMatrix();
      this.mesh.setMatrixAt(i, _dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private drawWisp(): void {
    this.mesh.visible = true;
    for (let i = 0; i < BEAM_SEGS; i++) {
      if (i < WISP_SEGS) {
        const sz = this.seeds[i * 2 + 1];
        const a = this.clock * 2.2 + (i / WISP_SEGS) * TWO_PI;
        _dummy.position.set(
          this.wispAt.x + Math.sin(a) * 0.34,
          this.wispAt.y + Math.sin(this.clock * 3.1 + i) * 0.20 + i * 0.11,
          this.wispAt.z + Math.cos(a) * 0.34,
        );
        // 0.17 of a unit, twice the beast's own voxel. Captured at 0.10 from a
        // riding camera the wisp was four specks the size of the crosshair and
        // read as dirt on the lens; at this size it is legible as an object
        // travelling with you without competing with the mount for the frame.
        _dummy.scale.setScalar(0.17 * sz);
        _dummy.rotation.set(this.clock * 1.5, this.clock * 2.0, 0);
      } else {
        _dummy.position.copy(this.wispAt);
        _dummy.rotation.set(0, 0, 0);
        _dummy.scale.setScalar(0.0001);
      }
      _dummy.updateMatrix();
      this.mesh.setMatrixAt(i, _dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------------------
// BeastOwner — the thing beasts follow (the player controller)
// ---------------------------------------------------------------------------
export interface BeastOwner {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  isSwimming: boolean;
  /** Below the surface swim line, where a flying companion cannot follow. */
  deepDiving: boolean;
}

// ---------------------------------------------------------------------------
// Animation probe
// ---------------------------------------------------------------------------
// Read-only diagnostic, the same contract as main.ts's __dbg* probes: a tool
// samples every live beast's rig for a few hundred frames and asserts on how far
// a joint moved BETWEEN frames. It exists because "the wings flicker sometimes"
// is not a thing a screenshot can prove or disprove — a per-frame rotation
// delta is. Every beast registers here and deregisters in dispose(), so a walked
// -out zone does not leave rigs behind.
const LIVE_ACTORS = new Set<BeastActor>();

if (typeof window !== 'undefined') {
  (window as unknown as { __dbgBeastAnim: () => unknown }).__dbgBeastAnim = () => {
    const out: unknown[] = [];
    for (const a of LIVE_ACTORS) out.push(a.animProbe());
    return out;
  };
}

// ---------------------------------------------------------------------------
// BeastActor
// ---------------------------------------------------------------------------
export class BeastActor {
  /**
   * The moving frame under its feet, if any — see world/carriers.ts. One field
   * and two calls, exactly as the hero and the saddle have.
   */
  private readonly ride = new CarrierRide();

  species: BeastSpecies;
  level = 1;
  xp = 0;
  xpToNext = 25;
  stats: BeastStats;
  position = new THREE.Vector3();
  forward = new THREE.Vector3(0, 0, 1);
  hp: number;
  maxHp: number;
  isDead = false;
  faction: 'player' = 'player';
  knownSkillIds: string[] = [];
  /**
   * World yaw (radians) the beast should turn to face while idle/slow, overriding
   * the follow heading. Used by photo mode to stage portraits. null = normal.
   */
  facingOverride: number | null = null;
  /** Rig dimensions, exposed so callers (e.g. photo framing) can size shots. */
  readonly height: number;
  readonly radius: number;
  /**
   * MEASURED top of the rest-pose rig, in local units — ears, horns, wing tips
   * and all. `height` is what a species declares for spacing and is routinely
   * smaller than what it draws (Galebird: 0.55 declared); mounting needs the
   * silhouette the player actually sees, so it is measured once here at boot.
   */
  readonly silhouetteTop: number;

  private rig: BeastRig;
  private scene: THREE.Scene;
  private world: World;
  private bus: EventBus;
  private puff: PoofPuff;
  private arc: SwipeArc;
  private dust: DustPuff;
  private materials: THREE.MeshStandardMaterial[] = [];

  // Motion state
  private vel = new THREE.Vector3();
  private vy = 0;
  private grounded = true;
  private yaw = 0;
  private bank = 0;
  private pitch = 0;
  private ownerHeading = 0;
  private initialized = false;
  private speed01 = 0;

  // Action state machine
  private transient: BeastAction | null = null;
  private transientTime = 0;
  private transientDur = 0;
  private baseAction: BeastAction = 'idle';
  private baseTime = 0;
  private time = 0;
  private phase = Math.random() * TWO_PI;
  /** This body's phase integrator, and the ctx handed to `species.animate`. */
  private readonly clock = new BeastAnimClock();
  private readonly ctx: BeastAnimCtx = this.clock.ctx;

  // Fetch errand
  private fetchJob: FetchJob | null = null;
  private fetchTime = 0;
  private carryTime = 0;

  // Timers / effects
  private supportTimer = 3 + Math.random() * 4;
  private idleTimer = 8 + Math.random() * 7;
  private hurtFlash = 0;
  private flashDirty = false;
  private poofT = 0;
  private landSquash = 0;
  /** Action the strike FX have already fired for; cleared when the action ends. */
  private struckFor: BeastAction | null = null;
  /** Metres of ground covered since the last running scuff. */
  private scuffAccum = 0;
  /** Along-forward speed last slice, for the acceleration lean. */
  private prevAlong = 0;
  private deadTimer = 0;
  private dieT = 0;
  private visibleFlag = true;
  private beam: LightBeam;
  /** Travelling as light — see the light-travel note above. */
  private beaming = false;
  /**
   * Set from main.ts once a slice: is this companion WANTED right now, i.e. is
   * there a live enemy near the owner. Read only by the light-travel rule, and a
   * plain field rather than an argument because it is a fact about the world the
   * beast has no way to ask for and every other caller of `update` would have to
   * carry. See BEAM_LAND_FIGHT.
   */
  supportNeeded = false;

  // Mount form (see MOUNT_HEIGHT). `rideScale` is the eased current value, so
  // dismounting shrinks back over the same quarter second it grew.
  private ridden = false;
  private rideScale = 1;
  private rideScaleTarget = 1;

  constructor(species: BeastSpecies, scene: THREE.Scene, world: World, bus: EventBus) {
    this.species = species;
    this.scene = scene;
    this.world = world;
    this.bus = bus;

    this.rig = species.buildRig();
    this.height = this.rig.height;
    this.radius = this.rig.radius;
    // Once, at boot, on the rest pose and before the root is placed: the rig is
    // still at the origin here, so this is a local-space measurement.
    this.silhouetteTop = Math.max(0.2, new THREE.Box3().setFromObject(this.rig.root).max.y);
    this.rig.root.rotation.order = 'YXZ';
    this.rig.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        const m = o as THREE.Mesh;
        m.castShadow = true;
        // Beasts CAST but never RECEIVE. A beast is a handful of voxel parts a few
        // centimetres apart, so the parts shadow each other: an ear prints a hard
        // band across a muzzle, and faces near-parallel to the sun pick up the
        // diagonal hatching of shadow-map acne. Both land on the read-at-a-glance
        // parts — the face — and both vanish here.
        //
        // The cost is that a beast no longer darkens standing in shade, which is
        // why castShadow stays on: its contact shadow is what keeps it planted on
        // the ground. three has no per-object "receive the world's shadows but
        // not my own", so this is the whole choice. See the hero's rig for the
        // matching decision.
        m.receiveShadow = false;
        const mat = m.material;
        if ((mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
          this.materials.push(mat as THREE.MeshStandardMaterial);
        }
      }
    });
    scene.add(this.rig.root);
    this.puff = new PoofPuff(scene);
    this.dust = new DustPuff(scene);
    // In the SCENE and not on the rig, unlike the arc: the whole point of it is
    // to be on screen while the rig is hidden.
    this.beam = new LightBeam(scene, species.element);
    // AFTER the traverse above, deliberately: that traverse turns castShadow on
    // for every mesh it finds, and the arc must never be a caster.
    this.arc = new SwipeArc(this.rig.root, species.element);
    this.arc.configure(this.rig.radius, this.rig.height);
    LIVE_ACTORS.add(this);

    this.stats = this.computeStats();
    this.maxHp = this.stats.maxHp;
    this.hp = this.maxHp;

    // Skills already known at level 1
    this.species.skills.forEach((id, i) => {
      const lv = this.learnLevelOf(id, i);
      if (lv !== undefined && lv <= this.level) this.knownSkillIds.push(id);
    });
  }

  /**
   * Back to level 1, as if just constructed. What "New Game" means to a beast.
   *
   * A METHOD rather than the caller building a new `BeastActor`, and the reason
   * is the rig: a beast owns ten to thirty voxel meshes and their materials, and
   * throwing those away means the renderer has to LINK THE PROGRAMS AGAIN the
   * first time the new ones are drawn. That link is the 13.5 s the boot spends
   * in its shader phase (see the note at the top of main.ts and warmUpShaders),
   * and paying any part of it again is a stall in the middle of what is supposed
   * to be an instant New Game. Nothing about a rig is per-session; only the
   * numbers on this object are, and this is all of them.
   *
   * Deliberately does NOT touch `position`, the animation clocks or the follow
   * state. The caller is about to move the hero, and a beast teleports to an
   * owner further away than TELEPORT_DIST on its next slice anyway — which a
   * respawn always is.
   */
  reset(): void {
    this.level = 1;
    this.xp = 0;
    this.xpToNext = 25;
    this.stats = this.computeStats();
    this.maxHp = this.stats.maxHp;
    this.hp = this.maxHp;
    this.isDead = false;
    this.deadTimer = 0;
    this.dieT = 0;
    // A new game is not a place a companion is still travelling to. Cleared
    // before the visibility line below, which is what puts the body back.
    this.beaming = false;
    this.supportNeeded = false;
    this.rig.root.scale.setScalar(1);
    this.rig.root.visible = this.visibleFlag;
    // A beast that died mid-fetch left a drop marked as being carried; putting
    // it back is `abortFetch`'s whole job and it is safe when nothing is held.
    this.abortFetch();
    // The hurt flash is baked into the shared materials, so it outlives the
    // numbers above unless it is cleared here.
    if (this.flashDirty || this.hurtFlash > 0) {
      this.hurtFlash = 0;
      this.flashDirty = false;
      for (const m of this.materials) m.emissive.setRGB(0, 0, 0);
    }
    // The same list the constructor builds, rebuilt rather than trimmed: a skill
    // bought at a den is in here too, and a new game has not bought it.
    this.knownSkillIds.length = 0;
    this.species.skills.forEach((id, i) => {
      const lv = this.learnLevelOf(id, i);
      if (lv !== undefined && lv <= this.level) this.knownSkillIds.push(id);
    });
  }

  // -- Progression ----------------------------------------------------------

  private computeStats(): BeastStats {
    const b = this.species.baseStats;
    const f = Math.pow(1.08, this.level - 1);
    return {
      maxHp: Math.round(b.maxHp * f),
      attack: b.attack * f,
      defense: b.defense * f,
      // Speed compounds much more gently or high-level beasts outrun the camera.
      speed: b.speed * (1 + 0.015 * (this.level - 1)),
    };
  }

  private learnLevelOf(id: string, index: number): number | undefined {
    const def = skillRegistry.get(id);
    if (def) return def.learnAtLevel; // undefined => store-only
    return index === 0 ? 1 : 1 + index * 4; // fallback schedule
  }

  learnSkill(id: string): void {
    if (!this.knownSkillIds.includes(id)) this.knownSkillIds.push(id);
  }

  gainXp(n: number): void {
    if (n <= 0 || this.isDead) return;
    this.xp += n;
    while (this.xp >= this.xpToNext) {
      this.xp -= this.xpToNext;
      this.level++;
      this.xpToNext = Math.round(25 * Math.pow(this.level, 1.4));
      this.stats = this.computeStats();
      this.maxHp = this.stats.maxHp;
      this.hp = this.maxHp; // full heal on level-up
      let learned: SkillDef | undefined;
      this.species.skills.forEach((id, i) => {
        if (this.knownSkillIds.includes(id)) return;
        const lv = this.learnLevelOf(id, i);
        if (lv !== undefined && lv <= this.level) {
          this.knownSkillIds.push(id);
          learned ??= skillRegistry.get(id);
        }
      });
      // Both halves of the beast's identity: the id for anything that has to know
      // WHICH beast, the name key for anything that has to PRINT it. The HUD used
      // to be handed only the id and title-case it into a name.
      this.bus.emit({
        type: 'beastLevelUp',
        beastId: this.species.id,
        nameKey: this.species.nameKey,
        level: this.level,
        learned,
      });
      this.playAction('happy', 1.5);
    }
  }

  // -- Combat interface (Damageable-compatible so BeastActor can be a caster) --

  takeDamage(amount: number, from: THREE.Vector3, _element?: ElementType): boolean {
    // A beast in transit is light: nothing to hit, nothing to knock back. main.ts
    // also keeps it out of the friendlies list, so this is the backstop rather
    // than the mechanism — a projectile already in flight lands on the frame the
    // beast leaves, and it must not connect with a body that is not there.
    if (this.isDead || this.poofT > 0 || this.beaming) return false;
    const mitigated = amount * (100 / (100 + this.stats.defense));
    this.hp = Math.max(0, this.hp - mitigated);
    this.hurtFlash = 0.22;
    this.flashDirty = true;
    if (this.hp <= 0) {
      this.isDead = true;
      this.deadTimer = REVIVE_SECONDS;
      this.dieT = 0;
      this.transient = null;
      this.abortFetch();   // put the drop back in play for whoever revives
      this.carryTime = 0;
    } else {
      this.playAction('hurt');
      // Small knockback away from the source
      const dx = this.position.x - from.x, dz = this.position.z - from.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4) {
        this.vel.x += (dx / d) * 3.5;
        this.vel.z += (dz / d) * 3.5;
      }
    }
    return true;
  }

  // -- Actions / casting ----------------------------------------------------

  playAction(action: BeastAction, duration?: number): void {
    this.transient = action;
    this.transientTime = 0;
    this.transientDur = duration ?? TRANSIENT_DURATIONS[action] ?? 0.6;
  }

  beginCast(skill: SkillDef): { origin: THREE.Vector3; direction: THREE.Vector3 } {
    this.playAction(skill.castAnim);
    this.bus.emit({ type: 'skillCast', skillId: skill.id, casterNameKey: this.species.nameKey });
    const origin = new THREE.Vector3(
      this.position.x + this.forward.x * this.rig.radius * 0.7,
      this.position.y + this.rig.height * 0.62,
      this.position.z + this.forward.z * this.rig.radius * 0.7,
    );
    return { origin, direction: this.forward.clone() };
  }

  wantsSupportCast(): boolean {
    // THE TIMER IS A CADENCE, NOT A REASON TO ATTACK (issue #124). It used to
    // be the whole decision, so a support beast fired into empty countryside
    // every 6-10 seconds. Either bonded animal can occupy the support slot,
    // which made both of them appear to use skills randomly after a swap.
    // `supportNeeded` is the existing combat-near-the-owner signal: keep the
    // timer aging outside combat so a companion responds immediately when a
    // fight starts, but never spend a skill until there is one to join.
    if (!this.supportNeeded || this.isDead || this.poofT > 0
      || this.beaming || this.supportTimer > 0) return false;
    this.supportTimer = 6 + Math.random() * 4;
    return true;
  }

  // -- Fetch errands --------------------------------------------------------

  /** True while walking to a claimed drop. */
  get isFetching(): boolean { return this.fetchJob !== null; }
  /** True for a moment after a grab, while hurrying the loot back. */
  get isCarrying(): boolean { return this.carryTime > 0; }
  /** Item the current errand is for, null when not on one. */
  get fetchItemId(): string | null { return this.fetchJob ? this.fetchJob.itemId : null; }

  /**
   * Send this beast to collect a drop. Claims the job; returns false (leaving the
   * drop for someone else) if the beast is busy, dead, or another fetcher got
   * there first.
   */
  beginFetch(job: FetchJob): boolean {
    if (this.fetchJob || this.isDead || this.poofT > 0 || this.beaming) return false;
    if (!job.claim()) return false;
    this.fetchJob = job;
    this.fetchTime = 0;
    return true;
  }

  private abortFetch(): void {
    this.fetchJob?.release();
    this.fetchJob = null;
    this.fetchTime = 0;
  }

  /**
   * Advance the errand. Returns the job while the beast should still be steering
   * at it — null once it has been grabbed, abandoned, or was never running.
   */
  private updateFetch(dt: number, owner: BeastOwner): FetchJob | null {
    if (this.carryTime > 0) this.carryTime -= dt;
    const job = this.fetchJob;
    if (!job) return null;
    this.fetchTime += dt;

    const lx = job.position.x - owner.position.x;
    const lz = job.position.z - owner.position.z;
    if (!job.valid || this.fetchTime > FETCH_TIMEOUT
      || lx * lx + lz * lz > FETCH_LEASH * FETCH_LEASH) {
      this.abortFetch();
      return null;
    }

    const gx = job.position.x - this.position.x;
    const gz = job.position.z - this.position.z;
    if (gx * gx + gz * gz < FETCH_REACH_SQ) {
      // Bookkeeping BEFORE the grab: collect() credits the player synchronously
      // and emits on the bus, and a listener that wants to know WHICH beast just
      // fetched something finds it by looking for the one that is carrying.
      this.fetchJob = null;
      this.fetchTime = 0;
      this.carryTime = FETCH_CARRY;
      this.playAction('happy', 0.9);
      job.collect();
      return null;
    }
    return job;
  }

  setVisible(v: boolean): void {
    this.visibleFlag = v;
    this.rig.root.visible = v && !this.beaming && !(this.isDead && this.dieT >= 1);
    // A HIDDEN BEAST STOPS BEING SLICED — main.ts only updates the two beasts in
    // the party — so every effect it had running freezes at its last frame and
    // hangs in the world until the zone unloads. Bench a companion mid-transit
    // and its travelling wisp is left standing in the air, which is issue #136;
    // bench one a moment after a teleport and its poof does the same.
    //
    // Cleared HERE rather than at each swap site because this is the one line
    // every one of them goes through (`refreshVisibility`), and because the rule
    // is about the updates stopping, not about why they stopped: `beasts=0`
    // reaches it too. The swipe arc needs no entry — it is a child of the rig
    // root, so the line above already hides it. `beaming` is deliberately left
    // set: it is session state, and a beast swapped back in while its owner is
    // still airborne must resume travelling rather than pop in at his feet.
    if (!v) { this.beam.clear(); this.puff.clear(); this.dust.clear(); }
  }

  // -- Mounting -------------------------------------------------------------

  /** Scale this species' rig reaches in mount form. See MOUNT_HEIGHT. */
  get mountScale(): number {
    return Math.min(MOUNT_MAX_SCALE, Math.max(1, MOUNT_HEIGHT / this.silhouetteTop));
  }

  /**
   * LIVE height of the saddle above the beast's origin, mount-form growth
   * included — so a rider seated the instant the growth starts rises with it
   * instead of beginning in mid-air. See SEAT_FRACTION.
   */
  get saddleY(): number { return this.silhouetteTop * this.rideScale * SEAT_FRACTION; }

  /** LIVE radius of the rig, mount-form growth included. Drives collision. */
  get scaledRadius(): number { return this.rig.radius * this.rideScale; }

  /** True while a rider holds the reins — the framework stops steering it. */
  get isRidden(): boolean { return this.ridden; }

  /**
   * Take or give back the reins. Grabbing a beast cancels an errand in progress
   * (the drop goes back in play for the other beast) and starts the mount-form
   * growth; letting go starts the shrink and hands normal follow steering back
   * from wherever the ride ended.
   */
  setRidden(on: boolean): void {
    if (this.ridden === on) return;
    this.ridden = on;
    this.rideScaleTarget = on ? this.mountScale : 1;
    // A puff at the changeover, the same burst a teleport uses. Mounting snaps
    // the beast from the rider's shoulder to under him and starts the mount-form
    // growth; without the cloud both of those read as a glitch rather than a
    // flourish. Note it does NOT reset poofT — that scales the rig up from
    // nothing, which would fight the growth this is announcing.
    _dummy.position.copy(this.position);
    _dummy.position.y += this.rig.height * 0.5;
    this.puff.burst(_dummy.position, this.rig.radius);
    if (on) {
      // Taking the reins is a hard exit from companion light travel. A beast
      // mounted on the same slice as its rider left the water (or by a debug
      // drive staged directly in transit) otherwise stayed `beaming`, whose
      // visibility gate hid the rig throughout the ride (issue #91).
      this.beaming = false;
      this.rig.root.visible = this.visibleFlag && !(this.isDead && this.dieT >= 1);
      this.abortFetch();
      this.carryTime = 0;
      this.transient = null;
      this.playAction('happy', 0.7);
    }
  }

  /**
   * One slice with a rider in the saddle, called INSTEAD of update().
   *
   * Follow steering, the fetch errand and every bit of vertical motion are
   * bypassed — MountController owns where a ridden beast is and it collides
   * against the world itself. Everything cosmetic still runs, so a mount can be
   * hurt, cast, level up and flash exactly as it does on the ground.
   */
  rideUpdate(dt: number, s: BeastRideState): void {
    this.time += dt;
    if (this.isDead) {
      // A mount that dies under its rider is dismounted by the caller on this
      // same slice; until then just let the death animation play.
      this.puff.update(dt);
      this.arc.update(dt);
      this.dust.update(dt);
      return;
    }
    this.position.set(s.x, s.y, s.z);
    this.vel.set(s.vx, 0, s.vz);
    this.vy = 0;
    this.grounded = s.action !== 'fly';
    // No damping here on purpose: the mount smooths its own heading and the
    // hero's rig is turned to the SAME angle, so a second filter in here would
    // let the rider and the saddle disagree in every turn.
    this.yaw = s.yaw;
    this.pitch = s.pitch;
    this.bank = s.bank;
    this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.speed01 = damp(this.speed01, s.speed01, 8, dt);
    this.finishFrame(dt, s.action);
  }

  // -- Per-frame update -----------------------------------------------------

  update(dt: number, owner: BeastOwner, role: 'primary' | 'support', others: BeastActor[]): void {
    this.time += dt;

    // THE GROUND MOVES FIRST. A beast standing on something that travels goes
    // with it, before its own steering runs — the same one line the hero and
    // the saddle open with, and the reason a follower does not get left hanging
    // in the air the moment its owner's island slides out from under it. It
    // runs for a dead beast too, which is why it is above the branch: a corpse
    // on a moving deck is a body lying on a floor, not a body pinned to the
    // sky.
    this.ride.carry(this.world, this.position);
    this.yaw += this.ride.dyaw;

    if (this.isDead) {
      this.updateDead(dt, owner, role);
      this.puff.update(dt);
      // A beast killed mid-swing still has to retire its arc and its dust, or the
      // last frame of both hangs in the air until it revives.
      this.arc.update(dt);
      this.dust.update(dt);
      this.beam.update(dt);
      return;
    }

    if (role === 'support') this.supportTimer -= dt;

    // -- Owner heading (from velocity; hold last heading when still) --------
    const ovx = owner.velocity.x, ovz = owner.velocity.z;
    const ownerSpeed = Math.hypot(ovx, ovz);
    if (ownerSpeed > 0.8) {
      this.ownerHeading = dampAngle(this.ownerHeading, Math.atan2(ovx, ovz), 6, dt);
    }

    // -- Station point: right-rear for primary, left-rear for support -------
    const side = role === 'primary' ? 1 : -1;
    const cos = Math.cos(this.ownerHeading), sin = Math.sin(this.ownerHeading);
    const ox = side * 1.5, oz = -1.4;
    let tx = owner.position.x + ox * cos + oz * sin;
    let tz = owner.position.z + oz * cos - ox * sin;

    const dOwnX = owner.position.x - this.position.x;
    const dOwnZ = owner.position.z - this.position.z;
    if (!this.initialized || dOwnX * dOwnX + dOwnZ * dOwnZ > TELEPORT_DIST * TELEPORT_DIST) {
      this.teleportTo(tx, tz, !this.initialized);
      this.initialized = true;
    }

    // -- Light travel: the VERTICAL leash -----------------------------------
    // Above the horizontal one deliberately, and it re-uses the station point it
    // has just computed: a beast that beams in lands exactly where it would have
    // walked to, so nothing downstream can tell the two arrivals apart.
    const reach = owner.position.y - this.landingY(tx, tz, owner);
    const flying = this.species.locomotion === 'flying';
    if (this.beaming) {
      this.updateBeaming(dt, tx, tz, owner, reach);
      return;
    }
    // Walkers withdraw when their owner leaves every surface they could stand
    // on. Flyers solve ordinary height by flying and withdraw only for a deep
    // dive, where keeping a winged body beside the swimmer would be the lie.
    if ((flying && owner.deepDiving) || (!flying && reach > BEAM_RISE)) {
      this.beginBeam();
      this.updateBeaming(dt, tx, tz, owner, reach);
      return;
    }

    // -- Errand: steer at the drop instead of the station point -------------
    // Note the order — the teleport check above still measures the OWNER, so a
    // beast that falls far behind snaps to the party and drops the errand next
    // frame (leash), rather than teleporting to the loot.
    const errand = this.updateFetch(dt, owner);
    if (errand) { tx = errand.position.x; tz = errand.position.z; }

    // -- Arrive steering ----------------------------------------------------
    const dx = tx - this.position.x, dz = tz - this.position.z;
    const dist = Math.hypot(dx, dz);

    const loco = this.species.locomotion;
    const groundY = this.groundAt(this.position.x, this.position.z);
    const deepWater = this.world.isWater(this.position.x, this.position.z)
      && groundY < this.world.waterLevel - 0.25;
    const swimming = loco !== 'flying' && deepWater;

    let mediumMult = 1;
    if (swimming) mediumMult = loco === 'swimming' ? 1.35 : loco === 'amphibious' ? 1.2 : 0.8;
    else if (loco === 'swimming') mediumMult = 0.55;      // waddling on land
    else if (loco === 'amphibious') mediumMult = 0.8;
    else if (loco === 'flying') mediumMult = 1.1;

    const baseSpeed = this.stats.speed * mediumMult;
    const catchup = dist > 7 ? Math.min(1.7, 1 + (dist - 7) * 0.12) : 1;
    // On an errand the target is a thing to stand ON, not a station to hold
    // near, so the arrive ramp is tight and only reaches zero at the drop
    // itself. The follow ramp would still get close enough to grab (it stops
    // 0.3 units out, inside the reach above) but it spends the last three
    // units coasting, which reads as losing interest rather than arriving.
    const slowR = errand ? 1.0 : 3.0, stopR = errand ? 0 : 0.3;
    const arrive = smoothstep01((dist - stopR) / (slowR - stopR));
    const hustle = errand || this.carryTime > 0 ? FETCH_HUSTLE : 1;
    const desiredSpeed = baseSpeed * catchup * arrive * hustle;

    let desX = 0, desZ = 0;
    if (dist > 1e-4) {
      desX = (dx / dist) * desiredSpeed;
      desZ = (dz / dist) * desiredSpeed;
    }

    // Separation from sibling beasts
    for (const other of others) {
      if (other === this || other.isDead) continue;
      const sx = this.position.x - other.position.x;
      const sz = this.position.z - other.position.z;
      const sd = Math.hypot(sx, sz);
      const minD = this.rig.radius + other.rig.radius + 0.5;
      if (sd < minD && sd > 1e-4) {
        const push = (minD - sd) / minD * 5;
        desX += (sx / sd) * push;
        desZ += (sz / sd) * push;
      }
    }

    const accel = 1 - Math.exp(-4.5 * dt);
    this.vel.x += (desX - this.vel.x) * accel;
    this.vel.z += (desZ - this.vel.z) * accel;

    // -- integrate, refusing to walk into a building -------------------------
    // A beast keeps its footing on `getHeight` and always has: it walks through
    // trees, up terraces and over anything the height field says is there. What
    // it may NOT do is walk through a settlement, because that is the one case
    // the player is standing right next to — a hero pressed against a hut wall
    // with his beast's head poking out of it reads far worse than no collision at
    // all.
    //
    // The same rule the hero uses, from the same constant: the destination is
    // refused when a structure there stands more than MAX_STEP_UP above the
    // beast's own feet, probed a body radius along the direction of travel so it
    // stops with its shoulder at the wall. Per-axis, so a blocked diagonal
    // slides along the palisade instead of pinning the beast against it.
    //
    // Fliers and swimmers are exempt: a flyer cruises metres above the roof
    // (see updateFlying) and there is nothing built in deep water.
    if (loco === 'flying' || swimming) {
      this.position.x += this.vel.x * dt;
      this.position.z += this.vel.z * dt;
    } else {
      const stepCeil = this.position.y + MAX_STEP_UP;
      const r = this.rig.radius;
      const nx = this.position.x + this.vel.x * dt;
      if (this.world.structureTopAt(nx + Math.sign(this.vel.x) * r, this.position.z) <= stepCeil) {
        this.position.x = nx;
      } else {
        this.vel.x = 0;
      }
      const nz = this.position.z + this.vel.z * dt;
      if (this.world.structureTopAt(this.position.x, nz + Math.sign(this.vel.z) * r) <= stepCeil) {
        this.position.z = nz;
      } else {
        this.vel.z = 0;
      }
    }

    const horizSpeed = Math.hypot(this.vel.x, this.vel.z);

    // -- Vertical motion per locomotion ------------------------------------
    let base: BeastAction;
    if (loco === 'flying') {
      base = 'fly';
      this.updateFlying(dt, groundY, owner);
    } else if (swimming) {
      base = 'swim';
      const bob = Math.sin(this.time * 2.2 + this.phase) * 0.07;
      const targetY = this.world.waterLevel - this.rig.height * 0.32 + bob;
      this.position.y = damp(this.position.y, targetY, 5, dt);
      this.vy = 0;
      this.grounded = false;
      this.pitch = damp(this.pitch, Math.sin(this.time * 2.2 + this.phase) * 0.06, 4, dt);
    } else {
      // Resample height post-integration so snapping/hops use the true ground
      this.updateGrounded(dt, horizSpeed, this.groundAt(this.position.x, this.position.z));
      base = 'idle'; // refined below once speed01 is smoothed
    }

    // -- Normalized gait speed (smoothed for blending) ----------------------
    const targetSpeed01 = Math.min(1, horizSpeed / Math.max(0.001, this.stats.speed * mediumMult));
    this.speed01 = damp(this.speed01, targetSpeed01, 8, dt);
    if (loco !== 'flying' && !swimming) {
      base = this.speed01 > 0.5 ? 'run' : this.speed01 > 0.06 ? 'walk' : 'idle';
    }

    // -- Facing + banking ---------------------------------------------------
    const prevYaw = this.yaw;
    // A staged facing wins outright — flyers hover with enough residual speed
    // to trip the movement branch, which left photo subjects facing away.
    const targetYaw = this.facingOverride ?? (horizSpeed > 0.4
      ? Math.atan2(this.vel.x, this.vel.z)
      : this.ownerHeading);
    this.yaw = dampAngle(this.yaw, targetYaw, horizSpeed > 0.4 ? 8 : 3.5, dt);
    const turnVel = dt > 0 ? angleDelta(prevYaw, this.yaw) / dt : 0;

    if (loco === 'flying') {
      const targetBank = Math.max(-0.55, Math.min(0.55, -turnVel * 0.28));
      this.bank = damp(this.bank, targetBank, 5, dt);
    } else {
      // Ground beasts lean into a turn too, they just lean far less than a bird.
      // Previously `bank` was pinned at 0 for everything with legs, so a beast
      // circling a standing hero — which is the single most-watched beast motion
      // in the game, it happens every time the player stops — carved a flat
      // rigid arc like a shopping trolley. 0.11 rad per rad/s against the
      // flyer's 0.28, capped at 0.20 rad (11.5 degrees): a hard turn tips the
      // outer feet about 0.08 units off the floor at a 0.4-unit radius, which
      // reads as weight rather than as clipping. Scaled by gait so a beast
      // pivoting on the spot to face the hero does not list like a sinking ship.
      const turnLean = Math.max(-0.20, Math.min(0.20, -turnVel * 0.11));
      // ...and a standing beast shifts its weight. Every species' idle already
      // breathes, flicks an ear and waves a tail, but all of that happens inside
      // the rig while the rig itself stands perfectly plumb — which is why the
      // ten-beast lineup photographs as a shelf of figurines: eight upright
      // columns at identical attitudes. A 0.035 rad (2 degree) sway on a 5.5 s
      // period, cross-faded against the turn lean by gait so it never fights a
      // real turn, is small enough that no single frame looks tilted and large
      // enough that the row stops being a row. `phase` is randomised per actor
      // at construction, so two beasts of the same species never sway together.
      const sway = 0.035 * Math.sin(this.time * 1.15 + this.phase);
      const targetBank = turnLean * this.speed01 + sway * (1 - this.speed01);
      this.bank = damp(this.bank, targetBank, 6, dt);
    }
    this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));

    // -- Running scuff -------------------------------------------------------
    // Distance-driven, not time-driven, so the puffs stay locked to the ground a
    // beast is actually covering instead of firing at a fixed rate whatever the
    // speed. One every 1.6 units at a 0.4-unit stride is roughly every fourth
    // footfall — enough to trail a beast at a gallop, sparse enough that it never
    // becomes a smoke machine. Only at a real run (>0.62 gait): a walking beast
    // that raises dust looks like it is on fire.
    if (this.grounded && !swimming && loco !== 'flying') {
      if (this.speed01 > 0.62) {
        this.scuffAccum += horizSpeed * dt;
        if (this.scuffAccum > 1.6) {
          this.scuffAccum = 0;
          this.dust.burst(
            this.position.x - this.forward.x * this.rig.radius * 0.5,
            this.position.y + 0.03,
            this.position.z - this.forward.z * this.rig.radius * 0.5,
            this.rig.radius * this.rideScale, 0.28,
          );
        }
      } else this.scuffAccum = 1.4; // primed, so the first stride of a sprint puffs
    }

    this.finishFrame(dt, base);
  }

  /**
   * Everything that happens once the beast has been PLACED, whoever placed it:
   * the action state machine, the hurt flash, the scale flourishes, the rig
   * transform and the species' own animate(). The follow path and the ridden
   * path both end here so neither can quietly skip one.
   */
  private finishFrame(dt: number, base: BeastAction): void {
    // -- Action state machine ----------------------------------------------
    if (this.transient) {
      this.transientTime += dt;
      if (this.transientTime >= this.transientDur) { this.transient = null; this.struckFor = null; }
    } else this.struckFor = null;

    // -- Strike FX ----------------------------------------------------------
    // The arc fires ONE frame into the lunge, not on the frame the action
    // starts: every species spends its first sixth of a second coiling, and an
    // arc drawn over the wind-up reads as the slash happening before the swing.
    // Measured against the two most-authored attacks in the roster — Emberfox
    // lunges over at 0.12-0.26 s, Drakelet over 0.16-0.30 s — so 0.13 s lands
    // the head of the arc on the frame the body is leaving the coil in both.
    // `special` is a longer flourish (0.95 s) whose peak is around a third in.
    if (this.transient && this.transient !== this.struckFor) {
      const strikeAt = this.transient === 'special' ? 0.34
        : this.transient === 'attack' ? 0.13 : -1;
      if (strikeAt >= 0 && this.transientTime >= strikeAt) {
        this.struckFor = this.transient;
        this.arc.swing();
        // A grounded strike also scuffs the floor it pushed off. Flyers get the
        // arc alone — dust from something hovering a metre and a half up is the
        // sort of detail that reads as a bug the moment anyone notices it.
        if (this.grounded) {
          this.dust.burst(
            this.position.x + this.forward.x * this.rig.radius * 0.6,
            this.position.y + 0.04,
            this.position.z + this.forward.z * this.rig.radius * 0.6,
            this.rig.radius * this.rideScale, 0.75,
          );
        }
      }
    }
    this.arc.update(dt);
    this.dust.update(dt);
    if (base !== this.baseAction) { this.baseAction = base; this.baseTime = 0; }
    else this.baseTime += dt;

    // Idle flourish: happy wiggle every 8-15 s when standing around
    if (this.facingOverride !== null) {
      // Staged (photo) pose: hold a calm idle instead of random flourishes.
      //
      // This used to read `this.transient = null`, unconditionally, every frame
      // — and that quietly broke the whole `anim=` staging parameter in BOTH
      // entry points. `photo=1&beast=emberfox&anim=attack` sets facingOverride
      // (main.ts:1067) and then calls playAction('attack') every 2.5 s; this
      // line then cleared the transient on the very next frame, so the attack
      // was one 16 ms frame of wind-up and nothing else, forever. Four separate
      // 40-frame bursts of the real game were captured hunting a strike effect
      // that could not possibly be on screen. The lab does the same thing
      // (lab/index.ts:172) for a single subject.
      //
      // Only the beast's OWN idle flourish is suppressed now. That is what the
      // comment always meant: a portrait should not have the subject randomly
      // wiggling, but an action the caller explicitly asked for is the entire
      // point of asking for it.
      this.idleTimer = 30;
      if (this.transient === 'happy') this.transient = null;
    } else if (!this.transient && this.baseAction === 'idle') {
      this.idleTimer -= dt;
      if (this.idleTimer <= 0) {
        this.playAction('happy', 1.2 + Math.random() * 0.5);
        this.idleTimer = 8 + Math.random() * 7;
      }
    } else if (this.baseAction !== 'idle') {
      this.idleTimer = Math.max(this.idleTimer, 2.5);
    }

    // -- Hurt flash ---------------------------------------------------------
    if (this.hurtFlash > 0) {
      this.hurtFlash -= dt;
      const k = Math.max(0, this.hurtFlash / 0.22);
      for (const m of this.materials) m.emissive.setRGB(k * 0.95, k * 0.12, k * 0.08);
    } else if (this.flashDirty) {
      for (const m of this.materials) m.emissive.setRGB(0, 0, 0);
      this.flashDirty = false;
    }

    // -- Poof scale-in + landing squash-and-stretch -------------------------
    let s = 1;
    if (this.poofT > 0) {
      this.poofT -= dt;
      s = easeOutBack(Math.min(1, 1 - this.poofT / POOF_SECONDS));
      s = Math.max(0.001, s);
    }
    if (this.landSquash > 0) this.landSquash -= dt * 3.2;
    const sq = Math.max(0, this.landSquash);
    // Mount-form growth multiplies the poof/squash scale rather than replacing
    // it, so a beast that is mounted mid-flourish keeps the flourish.
    this.rideScale = damp(this.rideScale, this.rideScaleTarget, RIDE_SCALE_LAMBDA, dt);
    const ms = s * this.rideScale;
    this.rig.root.scale.set(ms * (1 + sq * 0.28), ms * (1 - sq * 0.38), ms * (1 + sq * 0.28));

    // -- Apply transform + animate -----------------------------------------
    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.set(this.pitch, this.yaw, this.bank);

    this.ctx.action = this.transient ?? this.baseAction;
    this.ctx.actionTime = this.transient ? this.transientTime : this.baseTime;
    this.ctx.time = this.time;
    this.ctx.moveSpeed = this.speed01;
    this.ctx.dt = dt;
    this.species.animate(this.rig, this.ctx);

    this.puff.update(dt);
    this.beam.update(dt);
  }

  private updateFlying(dt: number, groundY: number, owner: BeastOwner): void {
    const surf = Math.max(groundY, this.world.waterLevel);
    // Look ahead so it rises before hills instead of clipping into them
    const aheadY = this.world.getHeight(
      this.position.x + this.forward.x * 2.5,
      this.position.z + this.forward.z * 2.5,
    );
    // A flyer on an errand drops to a hair under a metre so it visibly swoops
    // on the drop and grabs it, instead of collecting from cruising altitude
    // with a metre and a half of daylight under it.
    const hover = this.fetchJob ? 0.85 : 1.55;
    const floor = Math.max(surf, aheadY, this.world.waterLevel) + hover;
    // A flying companion follows the owner's altitude as well as his column.
    // The ground remains a lower bound, so the ordinary on-foot hover is
    // unchanged; during a skyfall this is the body the player can see and mount
    // instead of a light wisp pinned to his shoulder (issue #91).
    const target = Math.max(floor, owner.position.y + hover)
      + Math.sin(this.time * 1.6 + this.phase) * 0.22;
    const prevY = this.position.y;
    this.position.y = damp(this.position.y, target, 2.6, dt);
    const vyNow = dt > 0 ? (this.position.y - prevY) / dt : 0;
    this.pitch = damp(this.pitch, Math.max(-0.35, Math.min(0.35, -vyNow * 0.09)), 4, dt);
    this.grounded = false;
    this.vy = 0;
  }

  /**
   * The height a beast keeps its footing on: the terrain, or the deck of
   * whatever is carrying it.
   *
   * A BEAST KEEPS ITS FOOTING ON `getHeight` AND ALWAYS HAS — it walks through
   * trees and up terraces like the height field says, which is deliberate and
   * is why this is not simply `blockTop`. A carrier's deck is a different case
   * from a hut: a hut is a thing standing ON the ground, and a deck IS the
   * ground, eighty units of air where the height field would otherwise be. So
   * it goes in the footing, and settlements stay out of it.
   *
   * -Infinity unless the beast is actually riding, so this is the terrain
   * everywhere else in the world — see `CarrierRide.support`.
   */
  private groundAt(x: number, z: number): number {
    const g = this.world.getHeight(x, z);
    const deck = this.ride.support(x, z);
    return deck > g ? deck : g;
  }

  private updateGrounded(dt: number, horizSpeed: number, groundY: number): void {
    // Along-forward acceleration, sampled every slice INCLUDING airborne ones so
    // that touching down does not read a stale sample as one huge spike.
    const along = this.vel.x * this.forward.x + this.vel.z * this.forward.z;
    const accel = dt > 1e-4 ? (along - this.prevAlong) / dt : 0;
    this.prevAlong = along;

    if (this.grounded) {
      if (groundY < this.position.y - 0.45) {
        // Walked off a ledge — fall
        this.grounded = false;
        this.vy = 0;
      } else if (groundY - this.position.y > 0.32 && horizSpeed > 0.5) {
        // Steep rise ahead of the feet — hop up
        const dh = Math.min(groundY - this.position.y + 0.25, 1.4);
        this.vy = Math.sqrt(2 * GRAVITY * dh);
        this.grounded = false;
        this.landSquash = Math.max(this.landSquash, 0.18);
      } else {
        this.position.y = groundY; // follow gentle terrain
      }
    }

    if (!this.grounded) {
      this.vy -= GRAVITY * dt;
      this.position.y += this.vy * dt;
      this.pitch = damp(this.pitch, Math.max(-0.28, Math.min(0.3, -this.vy * 0.035)), 6, dt);
      if (this.position.y <= groundY) {
        if (this.vy < -5.5) {
          this.landSquash = 0.32;
          // The squash alone was the whole landing. It is a body deformation
          // lasting a third of a second and it happens INSIDE the silhouette, so
          // at gameplay distance a beast dropping off a terrace simply arrived.
          // The dust is the part the eye actually catches. Scaled by impact
          // speed so a hop-up landing is a scuff and a real fall is a cloud.
          const impact = Math.min(1, (-this.vy - 5.5) / 7);
          this.dust.burst(
            this.position.x, groundY + 0.04, this.position.z,
            this.rig.radius * this.rideScale, 0.35 + 0.65 * impact,
          );
        }
        this.position.y = groundY;
        this.vy = 0;
        this.grounded = true;
      }
    } else {
      // Lean into acceleration, sit back under braking.
      //
      // Nothing else on a grounded beast used `pitch` at all — it was damped to
      // zero and stayed there — so a beast leaving a standstill to chase the hero
      // went from 0 to full gallop as a rigid board sliding forward, and stopped
      // the same way. Species animate() code cannot fix this: it is handed a
      // normalised `moveSpeed`, never its derivative. 0.014 rad per unit of
      // acceleration puts a beast accelerating at 10 u/s^2 about 8 degrees nose
      // down, which is visible in motion and invisible in a portrait; the clamp
      // stops a teleport-frame acceleration spike snapping it face-first into
      // the floor. Positive pitch is nose DOWN here — see updateFlying, where a
      // climb produces a negative one.
      const lean = Math.max(-0.14, Math.min(0.16, accel * 0.014));
      this.pitch = damp(this.pitch, lean, 8, dt);
    }
  }

  private updateDead(dt: number, owner: BeastOwner, role: 'primary' | 'support'): void {
    this.deadTimer -= dt;
    if (this.dieT < 1) {
      this.dieT = Math.min(1, this.dieT + dt / 0.55);
      const s = Math.max(0.001, 1 - this.dieT * this.dieT);
      this.rig.root.scale.setScalar(s);
      if (this.dieT >= 1) {
        this.rig.root.visible = false;
        this.puff.burst(this.position, this.rig.radius);
        if (this.flashDirty || this.hurtFlash > 0) {
          this.hurtFlash = 0;
          this.flashDirty = false;
          for (const m of this.materials) m.emissive.setRGB(0, 0, 0);
        }
      }
    }
    if (this.deadTimer <= 0) {
      // Revive beside the owner with a poof
      this.isDead = false;
      this.hp = Math.ceil(this.maxHp * 0.5);
      const side = role === 'primary' ? 1 : -1;
      const cos = Math.cos(this.ownerHeading), sin = Math.sin(this.ownerHeading);
      this.teleportTo(
        owner.position.x + (side * 1.5) * cos + (-1.4) * sin,
        owner.position.z + (-1.4) * cos - (side * 1.5) * sin,
        false,
      );
      this.rig.root.visible = this.visibleFlag;
      this.dieT = 0;
    }
  }

  /**
   * Rebind to another zone's ground (see world/zones.ts).
   *
   * A beast is the clearest case for rebinding rather than rebuilding: its level,
   * xp and known-skill list ARE the save game. Nothing else is touched — the
   * follow update already teleports a beast whose owner is further than
   * TELEPORT_DIST away, and a zone change is by construction further than that,
   * so the beast poofs in beside the hero on the first slice in the new world with
   * the height read from the new world. Any fetch errand is dropped: the item it
   * was walking to belonged to the zone we just left.
   */
  setWorld(world: World): void {
    this.world = world;
    // In transit or not, the next slice teleports it beside the hero anyway (a
    // zone change is further than TELEPORT_DIST by construction), so the body
    // comes back here rather than beaming in from the world it just left.
    this.beaming = false;
    this.rig.root.visible = this.visibleFlag && !(this.isDead && this.dieT >= 1);
    // A carrier id belongs to the zone that made it. Dropped here beside every
    // other piece of per-zone state, rather than left for the registry to fail
    // to resolve on the next slice.
    this.ride.clear();
    this.abortFetch();
    this.carryTime = 0;
    this.vel.set(0, 0, 0);
    this.vy = 0;
  }

  /** True while this companion is travelling as light — see BEAM_RISE. */
  get inTransit(): boolean { return this.beaming; }

  /** Whether the renderer is currently drawing this body; used by probes. */
  get isDrawn(): boolean { return this.rig.root.visible; }

  /**
   * Size of the light-travel streak on screen right now, 0 when there is none.
   * The reading issue #136 is about: a benched beast is never sliced again, so
   * only the picture can say whether its beam was retired. Probes only.
   */
  get beamSize(): number { return this.beam.drawnSize; }

  /**
   * The surface a beast would be put down on at (x, z), given where its owner
   * is. THE SAME ANSWER `teleportTo` PRODUCES, which is the whole reason it is a
   * method rather than an expression at each site — see the light-travel note.
   *
   * The carrier is looked up at the OWNER's point rather than at the station,
   * because `at` takes a y and the station has none yet: a hero on Skyhaven's
   * deck is inside the volume, so his companion lands on the deck; a hero flying
   * UNDER the island is not, so his lands on the meadow.
   */
  private landingY(x: number, z: number, owner: BeastOwner): number {
    const g = this.world.getHeight(x, z);
    const c = this.world.carriers.at(owner.position.x, owner.position.y, owner.position.z);
    const deck = c ? c.topAt(x, z) : -Infinity;
    if (deck > g) return deck;
    // Deep water floats a beast at the surface (teleportTo again), so a hero
    // swimming in a lake is standing on something as far as this is concerned.
    return this.world.isWater(x, z) && g < this.world.waterLevel - 0.25
      ? this.world.waterLevel : g;
  }

  private beginBeam(): void {
    this.beaming = true;
    this.abortFetch();          // the drop belongs to ground the beast is leaving
    this.transient = null;
    this.baseAction = 'idle';
    this.speed01 = 0;
    this.vel.set(0, 0, 0);
    this.vy = 0;
    this.ride.clear();          // it is riding nothing while it is light
    this.rig.root.visible = false;
    this.beam.column(this.position.x, this.position.y, this.position.z, 1);
  }

  /**
   * In transit: no steering, no gravity, no collision and nothing to hit. The
   * position is pinned to the station point ABOVE the owner rather than left
   * where the body was, so every question about where your companion is — the
   * HUD, a fetch offer, a debug probe — answers "with you", which is the
   * literal ask in issue #70.
   */
  private updateBeaming(dt: number, tx: number, tz: number, owner: BeastOwner, reach: number): void {
    this.position.set(tx, owner.position.y + BEAM_WISP_RISE, tz);
    const gate = this.supportNeeded ? BEAM_LAND_FIGHT : BEAM_LAND;
    const canLand = this.species.locomotion === 'flying' ? !owner.deepDiving : reach <= gate;
    if (canLand) {
      this.beaming = false;
      this.rig.root.visible = this.visibleFlag;
      this.teleportTo(tx, tz, false);
      // Downward, and from a beam-height above the landing, so the column ends
      // on the beast rather than starting at it.
      this.beam.column(this.position.x, this.position.y, this.position.z, -1);
    } else {
      this.beam.wisp(this.position.x, this.position.y, this.position.z);
    }
    this.beam.update(dt);
    this.puff.update(dt);
    this.arc.update(dt);
    this.dust.update(dt);
  }

  private teleportTo(x: number, z: number, silent: boolean): void {
    this.position.x = x;
    this.position.z = z;
    // A TELEPORT LANDS IN THE WORLD, and re-attaches from where it lands. The
    // destination is beside the owner, so a beast poofing in beside a hero who
    // is standing on an island has to find the island's deck rather than the
    // meadow under it — `carry` on the new position is what attaches it, and a
    // fresh attach applies no delta.
    this.ride.clear();
    this.ride.carry(this.world, this.position);
    const groundY = this.groundAt(x, z);
    const deepWater = this.world.isWater(x, z) && groundY < this.world.waterLevel - 0.25;
    if (this.species.locomotion === 'flying') {
      this.position.y = Math.max(groundY, this.world.waterLevel) + 1.55;
    } else if (deepWater) {
      this.position.y = this.world.waterLevel - this.rig.height * 0.32;
    } else {
      this.position.y = groundY;
    }
    this.vel.set(0, 0, 0);
    this.vy = 0;
    this.grounded = true;
    if (!silent) {
      this.poofT = POOF_SECONDS;
      _dummy.position.copy(this.position);
      _dummy.position.y += this.rig.height * 0.5;
      this.puff.burst(_dummy.position, this.rig.radius);
    }
  }

  /**
   * Snapshot of every rig joint's local rotation, for __dbgBeastAnim. Read-only
   * and allocating — a diagnostic called by a test tool, never by the game.
   */
  animProbe(): unknown {
    const parts: Record<string, [number, number, number]> = {};
    for (const k of Object.keys(this.rig.parts)) {
      const o = this.rig.parts[k]!;
      parts[k] = [o.rotation.x, o.rotation.y, o.rotation.z];
    }
    return {
      id: this.species.id, action: this.ctx.action,
      moveSpeed: this.ctx.moveSpeed, time: this.time, parts,
    };
  }

  dispose(): void {
    LIVE_ACTORS.delete(this);
    this.abortFetch();
    this.scene.remove(this.rig.root);
    // BEFORE the traverse, and this ordering is load-bearing: the arc is a child
    // of the rig root, and the traverse below disposes every mesh geometry it
    // finds — which for the arc is the SHARED `puffGeo` that every beast's poof
    // burst also draws. Detaching it first is what stops one beast's disposal
    // deleting the box every other beast's particles are made of.
    this.arc.dispose();
    this.beam.dispose();
    this.rig.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        const m = o as THREE.Mesh;
        m.geometry.dispose();
        const mat = m.material;
        if (Array.isArray(mat)) for (const mm of mat) mm.dispose();
        else mat.dispose();
      }
    });
    this.puff.dispose();
    this.dust.dispose();
  }
}
