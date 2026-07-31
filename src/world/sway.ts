/**
 * GRASS THAT NOTICES — what a meadow does when something moves through it.
 *
 * Three effects, one vertex shader, one material:
 *
 *   wind      a prevailing two-octave wave over the whole meadow, always on.
 *             It is what makes the sward look alive before anything touches it,
 *             and it is what the other two read AGAINST — a patch that stops
 *             waving because a body is standing in it says more than a patch
 *             that bends out of a dead field.
 *   parting   a body walking through shoves blades outward and down, and the
 *             shove TRAILS the body (see LAG_LAMBDA) so the gap opens behind a
 *             runner and closes over about a third of a second once he stops.
 *   downwash  a beast flying low blows the grass under it: an outward-running
 *             ripple plus a steady flattening, both stronger the closer it is,
 *             and stronger again while it is climbing.
 *
 * WHY IT IS A UNIFORM ARRAY AND NOT A DISPLACEMENT TEXTURE. The obvious
 * alternative is to render the movers into a small render target and sample it
 * per vertex. It loses on every axis here. A texture fetch in the vertex stage
 * is unconditional, so the ~85% of drawn grass that is nowhere near anybody
 * gets MORE expensive, where the disc test below costs one dot product; a
 * camera-following field swims under the grass and a world-fixed one across the
 * streamed extent (352 units) is a third of a unit per texel even at 1024,
 * for an effect whose whole subject is a one-unit parted circle; and it would
 * add a pass, a material and a program to a renderer whose entire warm-up
 * architecture exists to stop the program count growing. Six slots of straight
 * ALU with a constant trip count is the shape a GPU is best at. Revisit if the
 * slot count ever needs to pass about 24.
 *
 * WHAT IT COSTS ON THE CPU. A dozen `damp` calls and one `getHeight` per mover
 * per simulation slice. `disturb` writes into preallocated buffers and `update`
 * matches by a linear scan over ten tracks — no Map, no allocation, nothing per
 * frame. See the no-per-frame-allocation rule in AGENTS.md.
 */
import * as THREE from 'three';
import type { DisturbKind } from '../core/types';
import { flags } from '../core/flags';

/**
 * How many bodies can disturb the grass at once.
 *
 * The party is three (hero-or-mount plus the two active beasts) and the wild
 * spawner puts packs of three or four near you, so six covers the party plus
 * the three nearest wild beasts, and degrades by dropping the FURTHEST rather
 * than by flickering between them. The uniform cost is 6 * 2 + 2 = 14 vec4s
 * against WebGL2's guaranteed 256 vertex vec4s, of which MeshStandard uses
 * under 40 — not a constraint at this size.
 */
export const SWAY_SLOTS = 6;

/**
 * Ceilings on the displacement, in world units, and the bounding-sphere pad
 * that has to cover them.
 *
 * A blade card is 0.098-0.132 units of HALF-width (see grassBillboard's call
 * sites in PropLib), so past about 0.35 the four quads of a rosette visibly
 * separate from each other and the tuft stops reading as one object. The pad
 * exceeds the clamp deliberately: `Accum.toGeometry` adds it to every soft
 * chunk's bounding sphere, and if a displaced vertex could leave that sphere
 * the chunk would pop in and out at the edge of the frustum.
 */
export const SWAY_MAX_PUSH = 0.34;
export const SWAY_MAX_DROOP = 0.22;
export const SWAY_BOUND_PAD = 0.40;

// ---------------------------------------------------------------------------
// Tuned constants
// ---------------------------------------------------------------------------

/** Tracks outnumber slots so a body briefly crowded out keeps its identity. */
const TRACKS = SWAY_SLOTS + 4;

/** Reports accepted per slice. Anything past this is dropped, not queued. */
const REPORTS = 16;

/**
 * How far the parted patch lags the body that made it. 1/e in 0.11 s.
 *
 * This is the "spreads" in the whole feature. At WALK_SPEED (6) the lagged
 * centre trails 0.66 units behind the hero — two body radii — so the gap reads
 * as a wake opening BEHIND him rather than as a halo bolted to his feet, and it
 * closes over about 0.33 s (three time constants) once he stops. A sprint (9.6)
 * trails 1.07 units, still inside the walk disc, so the wake lengthens with
 * speed without ever detaching from the body.
 */
const LAG_LAMBDA = 9;

/** Smoothing on the DERIVED velocity and climb rate. */
const VEL_LAMBDA = 8;

/**
 * Asymmetric on purpose. In fast (0.08 s) so a beast swapped into the follow slot
 * does not visibly ramp up; out slow (0.25 s time constant, about 0.75 s to
 * nothing) so recycling a slot to a different body cannot snap a metre of grass
 * upright in one frame. Recycling is guaranteed — ten tracks over six slots.
 */
const FADE_IN_LAMBDA = 12;
const FADE_OUT_LAMBDA = 4;

/** Below this a faded-out track is freed for someone else. */
const FADE_DEAD = 0.02;

/**
 * The parting disc: `radius * 2.6 + 0.35`, so 1.18 units for the hero.
 *
 * The meadow pass plants roughly one clump per 3.5 units square (see the bake
 * scale history on grassTuft). A disc the size of the body itself (0.32) would
 * contain no grass at all most of the time, and the effect would read as
 * intermittent rather than as parting.
 */
const WALK_R_MULT = 2.6;
const WALK_R_ADD = 0.35;

/**
 * How far out a walked-through blade tip is shoved.
 *
 * The tallest ordinary blade card is 0.62 units and the tallest tussock cell
 * about 0.63, so 0.26 at the tip is roughly 40% of blade height: unmistakable,
 * while the rosette is still recognisable as a rosette. The matching droop
 * lives in the shader — trodden grass goes DOWN as well as out, which is what
 * separates "walked through" from "blown".
 */
const WALK_PUSH = 0.26;

/**
 * The speed at which the directional bias saturates. WALK_SPEED, from
 * player/index.ts: a body at a walk already leans the grass fully along its
 * travel, and a sprint just gets there with a longer lag.
 */
const DIR_REF = 6;

/**
 * The downwash window, in units of clearance over the ground.
 *
 * Measured against BeastActor.updateFlying: a flyer damps its height toward
 * `max(ground, aheadY, waterLevel) + hover` with hover 1.55 cruising and 0.85
 * on a fetch errand, plus a +-0.22 bob. Real clearances are therefore 1.33-1.77
 * cruising and 0.63-1.07 swooping, so this window puts a cruise at about 55% of
 * full wash — present, not dramatic — and a fetch swoop at about 95%, where the
 * grass flattens. 3.5 at the top let an ordinary hero jump register as a
 * downdraught; 3.2 does not.
 *
 * The 2.5-unit look-ahead inside updateFlying makes clearance SPIKE as a flyer
 * crosses a downslope, which is exactly the "sweeps low, then climbs away" case
 * this is for, and it falls out for free.
 */
const CLEAR_HI = 3.2;
const CLEAR_LO = 0.55;

/**
 * The extra shake on the way up.
 *
 * updateFlying damps y at lambda 2.6, so an ordinary altitude correction (0.7
 * units of error on leaving fetch height) peaks near 1.8 units/s and a real
 * climb over a 4-unit rise peaks near 3. Normalising on 3 gives a routine
 * correction about 1.8x and a genuine ascent about 2.35x, which reads as a
 * downblast on take-off without turning every bob of the hover cycle into a
 * gust. Peak washed displacement is then 2.35 * WASH_AMP = 0.29 units, just
 * under SWAY_MAX_PUSH, so the escalation stays legible right to the top instead
 * of clipping.
 */
const CLIMB_REF = 3.0;
const CLIMB_EXTRA = 1.35;

/**
 * The wash disc: `1.6 + clearance * 0.9`. A downwash column spreads as it
 * falls, so a high flyer disturbs a wider, weaker patch — 3.0 units at cruise,
 * 2.4 on a swoop.
 */
const WASH_R_BASE = 1.6;
const WASH_R_PER = 0.9;

/** Slack added to the area disc so a body at its rim is still covered. */
const AREA_PAD = 1.0;

/**
 * The wind clock when `photo=1`.
 *
 * Every curated capture in shots/ is a still of a moving field, so without a
 * frozen clock the same URL renders a different meadow every run and
 * capture-set.ps1 stops being a regression tool. The value is arbitrary; it
 * only has to never change.
 */
const PHOTO_CLOCK = 11.0;

// ---------------------------------------------------------------------------
// Shader
// ---------------------------------------------------------------------------

/** GLSL float literal — a bare `0.34` from TS would print as `0.34`, but an
 *  integral constant would print as `2` and fail to compile against a float. */
const f = (n: number): string => n.toFixed(4);

const SWAY_PARS = `
attribute float bsSwayH;   // 0 at the root, 1 at the tip; 0 on every rigid prop
uniform float bsSwayTime;
uniform vec4  bsSwayArea;  // (x, z, r2, count) — one test skips the whole loop
uniform vec4  bsSwayA[${SWAY_SLOTS}];  // (worldX, worldZ, radius, push)
uniform vec4  bsSwayB[${SWAY_SLOTS}];  // (dirX, dirZ, wash, phase)
`;

/**
 * Spliced in after `<begin_vertex>`, which is the earliest point `transformed`
 * exists and comfortably before `project_vertex`, `worldpos_vertex`,
 * `shadowmap_vertex` and `fog_vertex` — so the bent position is what gets
 * projected, what samples the shadow map and what the aerial-perspective fog
 * measures. Nothing downstream needs to know this ran.
 *
 * NORMALS ARE DELIBERATELY LEFT ALONE. A blade card carries a pure up normal by
 * construction (see grassBillboard, and the long note there about why) and a
 * tussock is a cluster of cubes; rotating normals to match a displacement of at
 * most a third of a unit would cost a normalize per vertex to change nothing
 * anyone can see.
 *
 * THE AO BUFFER DOES NOT SEE THIS. post.ts re-renders the scene through GTAO's
 * own override material, which never runs onBeforeCompile, so ambient occlusion
 * is computed against undisturbed grass. At half resolution on props 0.3-0.6
 * units tall that is invisible — do NOT "fix" it by widening the override, which
 * would cost a second program and a second geometry pass for nothing.
 */
const SWAY_BODY = `
if (bsSwayH > 0.004) {
  // The chunk's model matrix is a PURE TRANSLATION — props.ts sets position
  // only, with matrixAutoUpdate off — so object-space xz and world-space xz
  // differ by a constant, and a displacement computed in one is valid in the
  // other. Yaw or scale a soft mesh and this silently shears.
  vec2 swXZ = modelMatrix[3].xz + transformed.xz;   // .y here is world Z
  // h squared is a cantilever: the root is pinned into the ground and the tip
  // carries the whole bend. Linear h slides the blade sideways as a rigid body,
  // which reads as the tuft sliding across the terrain rather than bending.
  float h = bsSwayH * bsSwayH;

  // The prevailing wind. Two octaves, always on, no uniforms of its own beyond
  // the clock. The primary wavelength is about 18 units, so a gust crosses
  // several clumps at once and reads as weather rather than as per-blade
  // jitter, and the fixed diagonal makes it one wind rather than a shimmer.
  float wind = sin(swXZ.x * 0.35 + swXZ.y * 0.21 + bsSwayTime * 1.15)
             + 0.45 * sin(swXZ.x * 0.90 - swXZ.y * 0.70 + bsSwayTime * 2.30);
  vec2 push = vec2(wind * ${f(0.045)}, wind * ${f(0.027)});
  float droop = 0.0;

  vec2 area = swXZ - bsSwayArea.xy;
  // ONE disc test, and it is what makes the loop affordable: every influencer
  // sits within ~25 units of the hero while the streamed soft meshes span 352,
  // so the great majority of drawn grass leaves here having paid a dot product.
  if (dot(area, area) < bsSwayArea.z) {
    for (int i = 0; i < ${SWAY_SLOTS}; i++) {
      vec4 A = bsSwayA[i];
      vec4 B = bsSwayB[i];
      vec2 d = swXZ - A.xy;
      float r = length(d);
      // Branchless disable: an unused slot has radius 0, so the ratio saturates
      // and f falls out at zero without a compare.
      float fo = 1.0 - clamp(r / max(A.z, 1e-4), 0.0, 1.0);
      fo = fo * fo * (3.0 - 2.0 * fo);
      vec2 nd = r > 1e-4 ? d / r : B.xy;
      // Outward from the body, biased along its travel so the gap opens behind
      // a runner instead of closing symmetrically around him.
      push  += (nd + B.xy * ${f(0.55)}) * (A.w * fo);
      droop += A.w * fo * ${f(0.38)};
      // Rotor wash. The ripple RUNS OUTWARD — phase speed 5.9 units/s over a
      // 2.9-unit wavelength, so a 2.4-3.0 unit disc shows about one wave at a
      // time. A standing oscillation reads as the whole patch pulsing, which
      // looks like a bug, and a much shorter wavelength aliases against the
      // ~3.5-unit clump spacing and reads as noise. The steady flatten term
      // beside it is what makes the shake read as pressure from above rather
      // than as more wind. Both sit under the walk push: air shakes grass, a
      // body shoves it.
      push  += nd * (B.z * fo * sin(bsSwayTime * 13.0 - r * 2.2 + B.w) * ${f(0.13)});
      droop += B.z * fo * ${f(0.09)};
    }
  }
  float pl = length(push);
  if (pl > ${f(SWAY_MAX_PUSH)}) push *= ${f(SWAY_MAX_PUSH)} / pl;
  transformed.xz += push * h;
  transformed.y  -= min(droop, ${f(SWAY_MAX_DROOP)}) * h;
}
`;

// ---------------------------------------------------------------------------

/** Frame-rate-independent smoothing. Never a fixed lerp factor — AGENTS.md. */
function damp(cur: number, target: number, lambda: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-lambda * dt));
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * One body the field is following.
 *
 * `lx/lz` is the LAGGED centre — the wake, not the body — and is what the
 * shader is given. `px/py/pz` is the last reported position, kept only so the
 * velocity and climb rate can be DERIVED here: BeastActor, MountController and
 * Enemy all keep their velocities private, and deriving from position deltas
 * means none of them has to change to make grass react to them.
 */
interface Track {
  id: number;
  live: boolean;
  seen: boolean;
  /** First slice for this id — deltas are meaningless until the second. */
  fresh: boolean;
  w: number;
  lx: number; lz: number;
  px: number; py: number; pz: number;
  vx: number; vz: number; climb: number;
  radius: number;
  fly: boolean;
  clearance: number;
  /** Fixed per track so two flyers' ripples never march in lockstep. */
  phase: number;
}

export class SwayField {
  readonly uniforms = {
    bsSwayTime: { value: 0 },
    bsSwayArea: { value: new THREE.Vector4(0, 0, -1, 0) },
    bsSwayA: { value: Array.from({ length: SWAY_SLOTS }, () => new THREE.Vector4()) },
    bsSwayB: { value: Array.from({ length: SWAY_SLOTS }, () => new THREE.Vector4()) },
  };

  private readonly tracks: Track[] = Array.from({ length: TRACKS }, (_, i) => ({
    id: 0, live: false, seen: false, fresh: true, w: 0,
    lx: 0, lz: 0, px: 0, py: 0, pz: 0, vx: 0, vz: 0, climb: 0,
    radius: 0.5, fly: false, clearance: 99,
    // An irrational-ish stride so the phases never coincide, whatever order the
    // tracks get claimed in.
    phase: i * 2.399963,
  }));

  /** Per-slice report buffer: id, then (x, y, z, radius, fly) per report. */
  private readonly repId = new Int32Array(REPORTS);
  private readonly repData = new Float32Array(REPORTS * 5);
  private repCount = 0;

  constructor(private readonly heightAt: (x: number, z: number) => number) {}

  /**
   * Patch the shared soft material. Called once per PropLib.
   *
   * `onBeforeCompile` rather than a bespoke ShaderMaterial (which is what
   * water.ts does) because everything MeshStandardMaterial already gives this
   * geometry is wanted unchanged: the lighting, the shadow receive, and above
   * all the aerial-perspective fog, which engine.ts installs by rewriting
   * three's fog ShaderChunks globally. Include resolution happens after this
   * hook runs, so those patched chunks land exactly as they do today.
   *
   * The cost, stated honestly: `softMat` and `solidMat` are identically
   * parameterised today and therefore share one program per light count, and
   * this splits them. That is up to eleven extra programs at boot, all of them
   * linked by the warm-up sweep — which stages the camera at the spawn point,
   * where there is grass — and none afterwards.
   */
  install(mat: THREE.Material): void {
    mat.customProgramCacheKey = (): string => 'bsSway';
    mat.onBeforeCompile = (shader): void => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${SWAY_PARS}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${SWAY_BODY}`);
    };
  }

  /**
   * Report a body for this slice. See `World.disturb` for the id contract.
   *
   * Allocation-free and unordered; the overflow policy is to DROP, because a
   * queue would just hand a stale position to the next slice.
   */
  disturb(id: number, x: number, y: number, z: number, radius: number, kind: DisturbKind): void {
    if (this.repCount >= REPORTS) return;
    const i = this.repCount++;
    this.repId[i] = id;
    const b = i * 5;
    this.repData[b] = x;
    this.repData[b + 1] = y;
    this.repData[b + 2] = z;
    this.repData[b + 3] = radius;
    this.repData[b + 4] = kind === 'fly' ? 1 : 0;
  }

  /** Resolve this slice's reports into tracks, then tracks into uniforms. */
  update(focus: THREE.Vector3, time: number, dt: number): void {
    this.uniforms.bsSwayTime.value = flags.photo ? PHOTO_CLOCK : time;

    const tracks = this.tracks;
    for (let i = 0; i < TRACKS; i++) tracks[i].seen = false;

    for (let r = 0; r < this.repCount; r++) {
      const id = this.repId[r];
      const b = r * 5;
      let t = this.find(id);
      if (!t) {
        t = this.claim(id);
        if (!t) continue;   // every track is live and still fading; drop this one
      }
      const x = this.repData[b];
      const y = this.repData[b + 1];
      const z = this.repData[b + 2];
      if (t.fresh) {
        t.px = x; t.py = y; t.pz = z;
        t.lx = x; t.lz = z;
        t.vx = 0; t.vz = 0; t.climb = 0;
        t.fresh = false;
      } else if (dt > 0) {
        t.vx = damp(t.vx, (x - t.px) / dt, VEL_LAMBDA, dt);
        t.vz = damp(t.vz, (z - t.pz) / dt, VEL_LAMBDA, dt);
        t.climb = damp(t.climb, (y - t.py) / dt, VEL_LAMBDA, dt);
        t.px = x; t.py = y; t.pz = z;
      }
      t.lx = damp(t.lx, x, LAG_LAMBDA, dt);
      t.lz = damp(t.lz, z, LAG_LAMBDA, dt);
      t.radius = this.repData[b + 3];
      t.fly = this.repData[b + 4] > 0.5;
      t.clearance = y - this.heightAt(x, z);
      t.seen = true;
      t.w = damp(t.w, 1, FADE_IN_LAMBDA, dt);
    }
    this.repCount = 0;

    // Unreported tracks keep their last centre and fade out where they stand,
    // which is what a body walking out of range should look like.
    for (let i = 0; i < TRACKS; i++) {
      const t = tracks[i];
      if (!t.live || t.seen) continue;
      t.w = damp(t.w, 0, FADE_OUT_LAMBDA, dt);
      if (t.w < FADE_DEAD) { t.live = false; t.w = 0; }
    }

    this.writeSlots(focus);
  }

  private find(id: number): Track | null {
    // A linear scan over ten entries, which beats a Map on both time and
    // garbage at this size.
    for (let i = 0; i < TRACKS; i++) {
      const t = this.tracks[i];
      if (t.live && t.id === id) return t;
    }
    return null;
  }

  private claim(id: number): Track | null {
    let coldest: Track | null = null;
    for (let i = 0; i < TRACKS; i++) {
      const t = this.tracks[i];
      if (!t.live) { coldest = t; break; }
      if (!coldest || t.w < coldest.w) coldest = t;
    }
    // Never evict a track that is still visibly bending grass — the pool is
    // four deeper than the slot count precisely so this can refuse.
    if (!coldest || (coldest.live && coldest.w > 0.5)) return null;
    coldest.id = id;
    coldest.live = true;
    coldest.fresh = true;
    coldest.w = 0;
    return coldest;
  }

  /**
   * Pick the SWAY_SLOTS most deserving tracks and pack them into the uniforms.
   *
   * Score is `weight / (1 + distance² to the focus)`: a body that has faded in
   * fully and is under the camera beats a distant one, and a fading one yields
   * its slot as it goes quiet rather than at a hard cutoff. The selection is
   * `SWAY_SLOTS * TRACKS` comparisons — 60 — with a bitmask instead of a sorted
   * copy, so it allocates nothing.
   */
  private writeSlots(focus: THREE.Vector3): void {
    const A = this.uniforms.bsSwayA.value;
    const B = this.uniforms.bsSwayB.value;
    let used = 0;
    let count = 0;
    // Area disc, accumulated as the slots are written: centroid first, extent
    // second, because the extent needs the centre.
    let cx = 0;
    let cz = 0;

    for (let s = 0; s < SWAY_SLOTS; s++) {
      let best = -1;
      let bestScore = 0;
      for (let i = 0; i < TRACKS; i++) {
        if (used & (1 << i)) continue;
        const t = this.tracks[i];
        if (!t.live || t.w <= FADE_DEAD) continue;
        const dx = t.lx - focus.x;
        const dz = t.lz - focus.z;
        const score = t.w / (1 + dx * dx + dz * dz);
        if (score > bestScore) { bestScore = score; best = i; }
      }
      if (best < 0) { A[s].set(0, 0, 0, 0); B[s].set(0, 0, 0, 0); continue; }
      used |= 1 << best;
      const t = this.tracks[best];

      let radius: number;
      let pushAmt: number;
      let wash: number;
      if (t.fly) {
        // A flyer does not shove grass with its body; it blows it.
        const near = clamp01((CLEAR_HI - t.clearance) / (CLEAR_HI - CLEAR_LO));
        const gain = 1 + clamp01(t.climb / CLIMB_REF) * CLIMB_EXTRA;
        radius = WASH_R_BASE + Math.max(t.clearance, 0) * WASH_R_PER;
        pushAmt = 0;
        wash = near * gain * t.w;
      } else {
        radius = t.radius * WALK_R_MULT + WALK_R_ADD;
        pushAmt = WALK_PUSH * t.w;
        wash = 0;
      }
      // Direction carries SPEED as well as bearing: a body ambling through
      // grass leans it a little along its travel, a sprinter leans it fully.
      const sp = Math.hypot(t.vx, t.vz);
      const k = sp > 1e-3 ? Math.min(sp, DIR_REF) / (DIR_REF * sp) : 0;

      A[s].set(t.lx, t.lz, radius, pushAmt);
      B[s].set(t.vx * k, t.vz * k, wash, t.phase);
      cx += t.lx;
      cz += t.lz;
      count++;
    }

    const area = this.uniforms.bsSwayArea.value;
    if (count === 0) {
      // A negative squared radius fails the shader's `dot(d,d) < r2` test
      // everywhere, so an idle world pays for the wind and nothing else.
      area.set(0, 0, -1, 0);
      return;
    }
    cx /= count;
    cz /= count;
    let reach = 0;
    for (let s = 0; s < SWAY_SLOTS; s++) {
      if (A[s].z <= 0) continue;
      const d = Math.hypot(A[s].x - cx, A[s].y - cz) + A[s].z;
      if (d > reach) reach = d;
    }
    reach += AREA_PAD;
    area.set(cx, cz, reach * reach, count);
  }

  /** Diagnostic snapshot for `__dbgSway()`. Allocates; never called per frame. */
  debug(): unknown {
    const A = this.uniforms.bsSwayA.value;
    const B = this.uniforms.bsSwayB.value;
    const slots = [];
    for (let s = 0; s < SWAY_SLOTS; s++) {
      if (A[s].z <= 0) continue;
      slots.push({
        x: A[s].x, z: A[s].y, radius: A[s].z, push: A[s].w,
        dirX: B[s].x, dirZ: B[s].y, wash: B[s].z,
      });
    }
    const tracks = this.tracks.filter((t) => t.live).map((t) => ({
      id: t.id, w: t.w, fly: t.fly, clearance: t.clearance,
      climb: t.climb, speed: Math.hypot(t.vx, t.vz),
      lag: Math.hypot(t.px - t.lx, t.pz - t.lz),
    }));
    const area = this.uniforms.bsSwayArea.value;
    return {
      time: this.uniforms.bsSwayTime.value,
      frozen: flags.photo,
      area: { x: area.x, z: area.y, r: area.z > 0 ? Math.sqrt(area.z) : 0, count: area.w },
      slots,
      tracks,
      maxPush: SWAY_MAX_PUSH,
    };
  }
}
