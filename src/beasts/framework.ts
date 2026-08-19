import * as THREE from "three";
import { ELEMENT_COLORS, MAX_STEP_UP, BEAST_CYCLE_SLOTS } from "../core/types";
import { CarrierRide } from "../world/carriers";
import type {
  ElementType,
  EventBus,
  FetchJob,
  BeastAction,
  BeastAnimCtx,
  BeastRig,
  BeastSpecies,
  BeastStats,
  SkillDef,
  World,
} from "../core/types";

// Skills register here at boot; a missing def falls back to an index schedule.
const skillRegistry = new Map<string, SkillDef>();

export function registerSkillDefs(defs: Iterable<SkillDef>): void {
  for (const d of defs) {
    skillRegistry.set(d.id, d);
  }
}

export function getSkillDef(id: string): SkillDef | undefined {
  return skillRegistry.get(id);
}

const _dummy = new THREE.Object3D();
const TWO_PI = Math.PI * 2;

function angleDelta(a: number, b: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) {
    d -= TWO_PI;
  } else if (d < -Math.PI) {
    d += TWO_PI;
  }
  return d;
}

function dampAngle(cur: number, target: number, lambda: number, dt: number): number {
  return cur + angleDelta(cur, target) * (1 - Math.exp(-lambda * dt));
}

function damp(cur: number, target: number, lambda: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-lambda * dt));
}

function easeOutBack(t: number): number {
  const c1 = 1.70158,
    c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

function smoothstep01(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** Cycle-rate ceiling, rad/s. 50.3 = 8 Hz; the sim is 60 Hz, so faster aliases. */
const MAX_CYCLE_RATE = 50.3;

/**
 * One animation clock per animated body. `ctx` is bound once over this instance's
 * phase array, so no frame allocates; `cycle` reads `dt` back off the ctx.
 */
export class BeastAnimClock {
  // Integrated phase per slot. NOT wrapped to 2pi — species derive harmonics as
  // non-integer multiples and a wrap pops them. Float32 breaks near 1e4 rad.
  private readonly cycles = new Float64Array(BEAST_CYCLE_SLOTS);

  readonly ctx: BeastAnimCtx = {
    action: "idle",
    actionTime: 0,
    time: 0,
    moveSpeed: 0,
    dt: 0,
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

// Mount form: knee-high rigs are scaled TO 2.1 units against their MEASURED
// silhouette (see `silhouetteTop`), never `rig.height`.
const MOUNT_HEIGHT = 2.1;
const MOUNT_MAX_SCALE = 3.2;
const RIDE_SCALE_LAMBDA = 9;
// Saddle height as a fraction of the silhouette, which tops out at an ear or horn.
const SEAT_FRACTION = 0.72;

export interface BeastRideState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  bank: number;
  vx: number;
  vz: number;
  /** 0..1 gait blend, normalised against the mount's own top speed. */
  speed01: number;
  action: BeastAction;
}

const TRANSIENT_DURATIONS: Partial<Record<BeastAction, number>> = {
  attack: 0.5,
  cast: 0.7,
  special: 0.95,
  hurt: 0.45,
  happy: 1.35,
};

// Fetch errands. main.ts offers the job; the abort rules stop a bad offer stranding
// a beast.
const FETCH_LEASH = 26;
const FETCH_TIMEOUT = 12;
// Grab reach squared, wider than the player's 0.67: a flyer arrives above the drop.
const FETCH_REACH_SQ = 0.75 * 0.75;
const FETCH_CARRY = 1.6;
// Kept small: speed01 is normalised against the UNBOOSTED follow speed, so a
// bigger multiplier pins the run cycle and skates.
const FETCH_HUSTLE = 1.25;

const PUFF_COUNT = 12;
let puffGeo: THREE.BoxGeometry | null = null;
let puffMat: THREE.MeshStandardMaterial | null = null;

class PoofPuff {
  private mesh: THREE.InstancedMesh;
  private dirs: Float32Array; // per-instance unit dir xyz
  private seeds: Float32Array; // per-instance speed + size
  private life = 0;
  private center = new THREE.Vector3();
  private baseRadius = 0.5;

  constructor(private scene: THREE.Scene) {
    puffGeo ??= new THREE.BoxGeometry(1, 1, 1);
    puffMat ??= new THREE.MeshStandardMaterial({
      color: 0xf4faff,
      emissive: 0x9fd8ff,
      emissiveIntensity: 0.55,
      roughness: 1,
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
      this.seeds[i * 2] = 0.7 + Math.random() * 0.9; // speed
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

  clear(): void {
    this.life = 0;
    this.mesh.visible = false;
  }

  update(dt: number): void {
    if (this.life <= 0) {
      return;
    }
    this.life -= dt;
    if (this.life <= 0) {
      this.mesh.visible = false;
      return;
    }
    const t = 1 - this.life / 0.55;
    const spread = this.baseRadius + (1 - (1 - t) * (1 - t)) * 1.5;
    for (let i = 0; i < PUFF_COUNT; i++) {
      const sp = this.seeds[i * 2],
        sz = this.seeds[i * 2 + 1];
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

// Strike FX, drawn as VOXELS out of the poof's unit box on the same material keys,
// so no extra shader permutation and no transparency. The arc's emissive clears both
// bloom thresholds (>= 0.30, spread > 0.12, post.ts tagSources); the dust's must stay
// under both, or it is a smoke grenade.
const ARC_SEGS = 13;
const ARC_TIME = 0.26;
/** How far the trail lags the leading edge. 0.55 gives a comet, 1.0 a static crescent. */
const ARC_TRAIL = 0.55;
const _white = new THREE.Color(0xffffff);

// Frames a strike-FX mesh stays visible-but-degenerate, so warmUpSteps LINKS ITS
// PROGRAM at boot. Decremented from update(), which the warm-up never calls.
const FX_WARM_FRAMES = 8;

function parkInstances(mesh: THREE.InstancedMesh, y: number): void {
  _dummy.position.set(0, y, 0);
  _dummy.rotation.set(0, 0, 0);
  _dummy.scale.setScalar(0.0001);
  _dummy.updateMatrix();
  for (let i = 0; i < mesh.count; i++) {
    mesh.setMatrixAt(i, _dummy.matrix);
  }
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
    // Near-white blade, coloured glow: separates from ANY species' own paint.
    this.mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(c).lerp(_white, 0.4).getHex(),
      emissive: c,
      emissiveIntensity: 0.8,
      roughness: 1,
    });
    this.mesh = new THREE.InstancedMesh(puffGeo, this.mat, ARC_SEGS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Never a caster and never a receiver: a slash is light.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    parkInstances(this.mesh, 0); // see FX_WARM_FRAMES
    parent.add(this.mesh);
  }

  private warm = FX_WARM_FRAMES;

  /** Rig-space geometry: a 1.9-radius circle offset 0.75 radius FORWARD of the body. */
  configure(radius: number, height: number): void {
    this.reach = radius * 1.9;
    this.cz = radius * 0.75;
    this.cy = height * 0.5;
    this.rise = height * 0.22;
  }

  swing(): void {
    this.life = ARC_TIME;
    this.dir = this.dir === 1 ? -1 : 1;
    this.mesh.visible = true;
  }

  update(dt: number): void {
    if (this.warm > 0 && --this.warm === 0 && this.life <= 0) {
      this.mesh.visible = false;
    }
    if (this.life <= 0) {
      return;
    }
    this.life -= dt;
    if (this.life <= 0) {
      this.mesh.visible = this.warm > 0;
      return;
    }
    const u = 1 - this.life / ARC_TIME;
    const head = (1 - (1 - u) * (1 - u)) * (1 + ARC_TRAIL);
    const R = this.reach;
    for (let i = 0; i < ARC_SEGS; i++) {
      const fi = i / (ARC_SEGS - 1);
      const age = head - fi;
      // Crescent, not a wedge: sin(pi*x)^0.7 tapers to a point at BOTH ends.
      const x = age / ARC_TRAIL;
      const w = age < 0 || age > ARC_TRAIL ? 0 : Math.sin(Math.PI * x) ** 0.7;
      if (w <= 0.001) {
        _dummy.position.set(0, this.cy, 0);
        _dummy.rotation.set(0, 0, 0);
        _dummy.scale.setScalar(0.0001);
      } else {
        // 109-degree rake about the rig's Y; `a` also drives height, so the blade
        // comes DOWN as it crosses. Wider puts the ends off-screen.
        const a = this.dir * (0.95 - 1.9 * fi);
        _dummy.position.set(Math.sin(a) * R, this.cy + a * this.rise, this.cz + Math.cos(a) * R);
        // rotation.y = a puts local +X on the arc TANGENT; the z-roll rakes the blade.
        _dummy.rotation.set(0, a, -a * 0.5);
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
    // Warm pale grit; the emissive must fall UNDER both bloom thresholds.
    dustMat ??= new THREE.MeshStandardMaterial({
      color: 0xd6cbb4,
      emissive: 0x6b6152,
      emissiveIntensity: 0.25,
      roughness: 1,
    });
    this.mesh = new THREE.InstancedMesh(puffGeo, dustMat, DUST_COUNT);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    parkInstances(this.mesh, 0); // see FX_WARM_FRAMES
    this.dirs = new Float32Array(DUST_COUNT * 3);
    this.seeds = new Float32Array(DUST_COUNT * 2);
    for (let i = 0; i < DUST_COUNT; i++) {
      const theta = Math.random() * TWO_PI;
      this.dirs[i * 3] = Math.cos(theta);
      this.dirs[i * 3 + 1] = 0.1 + Math.random() * 0.35;
      this.dirs[i * 3 + 2] = Math.sin(theta);
      this.seeds[i * 2] = 0.6 + Math.random() * 0.8; // speed
      this.seeds[i * 2 + 1] = 0.5 + Math.random() * 0.85; // size
    }
    scene.add(this.mesh);
  }

  burst(x: number, y: number, z: number, radius: number, power: number): void {
    this.center.set(x, y, z);
    this.spread = radius;
    this.power = power;
    this.life = DUST_LIFE;
    this.mesh.visible = true;
  }

  private warm = FX_WARM_FRAMES;

  /** `warm > 0` survives — a beast benched at boot was never drawn. */
  clear(): void {
    this.life = 0;
    this.mesh.visible = this.warm > 0;
  }

  update(dt: number): void {
    if (this.warm > 0 && --this.warm === 0 && this.life <= 0) {
      this.mesh.visible = false;
    }
    if (this.life <= 0) {
      return;
    }
    this.life -= dt;
    if (this.life <= 0) {
      this.mesh.visible = this.warm > 0;
      return;
    }
    const t = 1 - this.life / DUST_LIFE;
    const out = this.spread * (0.35 + (1 - (1 - t) * (1 - t)) * 1.35 * this.power);
    for (let i = 0; i < DUST_COUNT; i++) {
      const sp = this.seeds[i * 2],
        sz = this.seeds[i * 2 + 1];
      _dummy.position.set(
        this.center.x + this.dirs[i * 3] * out * sp,
        this.center.y + this.dirs[i * 3 + 1] * out * sp * 0.75,
        this.center.z + this.dirs[i * 3 + 2] * out * sp,
      );
      // Shrink rather than fade: no transparency, no new program. A grain under a
      // body voxel reads as noise, not debris.
      const s = Math.max(0.0001, (1 - t) * 0.3 * sz * this.spread * (0.55 + 0.45 * this.power));
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

/**
 * Light travel (issue #70). A walker whose owner leaves every surface it could stand
 * on is WITHDRAWN, not pathed upward: a streak of light with no physics, collision or
 * hitbox. Flyers follow altitude as bodies (issue #91) and use this only when diving.
 * Leaving and arriving both read `reach`, so the two cannot disagree and strobe.
 */
const BEAM_RISE = 13;
/** The gap to BEAM_RISE is hysteresis, nothing else. */
const BEAM_LAND = 4.5;
/** Combat exception, while main.ts sets `supportNeeded`. Still needs a surface. */
const BEAM_LAND_FIGHT = 14;
/** Shoulder height on the owner, so his body cannot hide the wisp. */
const BEAM_WISP_RISE = 1.35;
const BEAM_FLASH = 0.5;
const BEAM_HEIGHT = 5.5;
const BEAM_SEGS = 14;
/** Instances of the above spent on the in-transit wisp. */
const WISP_SEGS = 5;

/**
 * ONE InstancedMesh in two modes — a one-shot COLUMN at a departure or arrival and
 * a WISP riding beside the owner in transit. Never on screen together.
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

  constructor(
    private scene: THREE.Scene,
    element: ElementType,
  ) {
    puffGeo ??= new THREE.BoxGeometry(1, 1, 1);
    const c = ELEMENT_COLORS[element];
    this.mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(c).lerp(_white, 0.62).getHex(),
      emissive: c,
      emissiveIntensity: 1.4,
      roughness: 1,
    });
    this.mesh = new THREE.InstancedMesh(puffGeo, this.mat, BEAM_SEGS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    parkInstances(this.mesh, 0); // see FX_WARM_FRAMES
    this.seeds = new Float32Array(BEAM_SEGS * 2);
    for (let i = 0; i < BEAM_SEGS; i++) {
      this.seeds[i * 2] = 0.55 + Math.random() * 0.9; // speed
      this.seeds[i * 2 + 1] = 0.6 + Math.random() * 0.75; // size
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

  /** Retire both modes. `warm > 0` survives, as in DustPuff.clear. */
  clear(): void {
    this.life = 0;
    this.wispOn = false;
    this.mesh.visible = this.warm > 0;
  }

  /** Largest cube drawn, 0 when hidden. A mesh parked by FX_WARM_FRAMES is
   *  `visible` yet draws nothing, so only the matrices know. Probes only. */
  get drawnSize(): number {
    if (!this.mesh.visible) {
      return 0;
    }
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
      if (this.life > 0) {
        this.drawColumn();
        this.wispOn = false;
        return;
      }
    }
    if (this.wispOn) {
      this.drawWisp();
      this.wispOn = false;
      return;
    }
    this.mesh.visible = this.warm > 0;
  }

  private drawColumn(): void {
    this.mesh.visible = true;
    const t = 1 - this.life / BEAM_FLASH;
    for (let i = 0; i < BEAM_SEGS; i++) {
      const sp = this.seeds[i * 2],
        sz = this.seeds[i * 2 + 1];
      const along = (i / BEAM_SEGS + t * 0.75 * sp) % 1;
      _dummy.position.set(
        this.origin.x + Math.sin(i * 2.4 + this.clock) * 0.1,
        this.origin.y + (this.dir > 0 ? along : 1 - along) * BEAM_HEIGHT,
        this.origin.z + Math.cos(i * 1.7 + this.clock) * 0.1,
      );
      const taper = 1 - Math.abs(along - 0.15) * 0.55;
      _dummy.scale.setScalar(Math.max(0.0001, (1 - t) * 0.3 * sz * taper));
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
          this.wispAt.y + Math.sin(this.clock * 3.1 + i) * 0.2 + i * 0.11,
          this.wispAt.z + Math.cos(a) * 0.34,
        );
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

export interface BeastOwner {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  isSwimming: boolean;
  /** Below the surface swim line, where a flying companion cannot follow. */
  deepDiving: boolean;
}

// Animation probe. Deregistered in dispose(), so a walked-out zone leaves nothing.
const LIVE_ACTORS = new Set<BeastActor>();

if (typeof window !== "undefined") {
  (window as unknown as { __dbgBeastAnim: () => unknown }).__dbgBeastAnim = () => {
    const out: unknown[] = [];
    for (const a of LIVE_ACTORS) {
      out.push(a.animProbe());
    }
    return out;
  };
}

export class BeastActor {
  /** The moving frame under its feet, if any — see world/carriers.ts. */
  private readonly ride = new CarrierRide();

  species: BeastSpecies;
  /** THIS body, not its kind: `emberfox` for the first of a species, `emberfox#2` for the next (issue #110). Saves and the bag key on it. */
  readonly id: string;
  level = 1;
  xp = 0;
  xpToNext = 25;
  stats: BeastStats;
  position = new THREE.Vector3();
  forward = new THREE.Vector3(0, 0, 1);
  hp: number;
  maxHp: number;
  isDead = false;
  faction = "player" as const;
  knownSkillIds: string[] = [];
  /** World yaw to face while idle/slow, overriding the follow heading (photo mode). */
  facingOverride: number | null = null;
  readonly height: number;
  readonly radius: number;
  /** MEASURED rest-pose top, local units. `height` is only declared spacing. */
  readonly silhouetteTop: number;

  private rig: BeastRig;
  private scene: THREE.Scene;
  private world: World;
  private bus: EventBus;
  private puff: PoofPuff;
  private arc: SwipeArc;
  private dust: DustPuff;
  private materials: THREE.MeshStandardMaterial[] = [];

  private vel = new THREE.Vector3();
  private vy = 0;
  private grounded = true;
  private yaw = 0;
  private bank = 0;
  private pitch = 0;
  private ownerHeading = 0;
  private initialized = false;
  private speed01 = 0;

  private transient: BeastAction | null = null;
  private transientTime = 0;
  private transientDur = 0;
  private baseAction: BeastAction = "idle";
  private baseTime = 0;
  private time = 0;
  private phase = Math.random() * TWO_PI;
  private readonly clock = new BeastAnimClock();
  private readonly ctx: BeastAnimCtx = this.clock.ctx;

  private fetchJob: FetchJob | null = null;
  private fetchTime = 0;
  private carryTime = 0;

  private supportTimer = 3 + Math.random() * 4;
  private idleTimer = 8 + Math.random() * 7;
  private hurtFlash = 0;
  private flashDirty = false;
  private poofT = 0;
  private landSquash = 0;
  private struckFor: BeastAction | null = null;
  private scuffAccum = 0;
  private prevAlong = 0;
  private deadTimer = 0;
  private dieT = 0;
  private visibleFlag = true;
  private beam: LightBeam;
  private beaming = false;
  /** Set from main.ts once a slice: is there a live enemy near the owner. See BEAM_LAND_FIGHT. */
  supportNeeded = false;

  // Mount form (see MOUNT_HEIGHT). `rideScale` is the eased current value.
  private ridden = false;
  private rideScale = 1;
  private rideScaleTarget = 1;

  constructor(
    species: BeastSpecies,
    scene: THREE.Scene,
    world: World,
    bus: EventBus,
    bodyId: string = species.id,
  ) {
    this.species = species;
    this.id = bodyId;
    this.scene = scene;
    this.world = world;
    this.bus = bus;

    this.rig = species.buildRig();
    this.height = this.rig.height;
    this.radius = this.rig.radius;
    // Before the root is placed, so this is a local-space measurement.
    this.silhouetteTop = Math.max(0.2, new THREE.Box3().setFromObject(this.rig.root).max.y);
    this.rig.root.rotation.order = "YXZ";
    this.rig.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        const m = o as THREE.Mesh;
        m.castShadow = true;
        // Beasts CAST but never RECEIVE: parts centimetres apart shadow each other
        // across the face, and three has no "the world's shadows but not my own".
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
    // In the SCENE, not on the rig: it must draw while the rig is hidden.
    this.beam = new LightBeam(scene, species.element);
    // AFTER the traverse, which turns castShadow on: the arc is never a caster.
    this.arc = new SwipeArc(this.rig.root, species.element);
    this.arc.configure(this.rig.radius, this.rig.height);
    LIVE_ACTORS.add(this);

    this.stats = this.computeStats();
    this.maxHp = this.stats.maxHp;
    this.hp = this.maxHp;

    this.species.skills.forEach((id, i) => {
      const lv = this.learnLevelOf(id, i);
      if (lv !== undefined && lv <= this.level) {
        this.knownSkillIds.push(id);
      }
    });
  }

  /**
   * Back to level 1 — "New Game" for a beast. A METHOD, not a fresh BeastActor:
   * rebuilding the rig re-links its shader programs. Does NOT touch `position` or the
   * clocks; a respawn is past TELEPORT_DIST and teleports next slice anyway.
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
    this.beaming = false;
    this.supportNeeded = false;
    this.rig.root.scale.setScalar(1);
    this.rig.root.visible = this.visibleFlag;
    // A death mid-fetch left a drop marked as carried; put it back.
    this.abortFetch();
    // The hurt flash lives in the shared materials, so it outlives the numbers above.
    if (this.flashDirty || this.hurtFlash > 0) {
      this.hurtFlash = 0;
      this.flashDirty = false;
      for (const m of this.materials) {
        m.emissive.setRGB(0, 0, 0);
      }
    }
    // Rebuilt, not trimmed: a skill bought at a den is in here too.
    this.knownSkillIds.length = 0;
    this.species.skills.forEach((id, i) => {
      const lv = this.learnLevelOf(id, i);
      if (lv !== undefined && lv <= this.level) {
        this.knownSkillIds.push(id);
      }
    });
  }

  /**
   * Restore from a save (issue #171). Stats and maxHp are DERIVED from the level, so a
   * save loads onto today's curve; `knownSkillIds` cannot be (a den sells skills), so
   * it is filtered to what the species still knows. HP floors at 1, never a corpse.
   */
  restore(state: {
    level: number;
    xp: number;
    xpToNext: number;
    hp: number;
    knownSkillIds: readonly string[];
  }): void {
    this.reset();
    this.level = Math.max(1, Math.round(state.level));
    this.xp = Math.max(0, state.xp);
    this.xpToNext = Math.max(1, state.xpToNext);
    this.stats = this.computeStats();
    this.maxHp = this.stats.maxHp;
    this.hp = Math.max(1, Math.min(this.maxHp, Math.round(state.hp)));
    const canKnow = new Set(this.species.skills);
    this.knownSkillIds.length = 0;
    this.species.skills.forEach((id, i) => {
      const lv = this.learnLevelOf(id, i);
      if (lv !== undefined && lv <= this.level) {
        this.knownSkillIds.push(id);
      }
    });
    for (const id of state.knownSkillIds) {
      if (canKnow.has(id) && !this.knownSkillIds.includes(id)) {
        this.knownSkillIds.push(id);
      }
    }
  }

  private computeStats(): BeastStats {
    const b = this.species.baseStats;
    const f = Math.pow(1.08, this.level - 1);
    return {
      maxHp: Math.round(b.maxHp * f),
      attack: b.attack * f,
      defense: b.defense * f,
      // Compounds gently, or high-level beasts outrun the camera.
      speed: b.speed * (1 + 0.015 * (this.level - 1)),
    };
  }

  private learnLevelOf(id: string, index: number): number | undefined {
    const def = skillRegistry.get(id);
    if (def) {
      return def.learnAtLevel;
    } // undefined => store-only
    return index === 0 ? 1 : 1 + index * 4; // fallback schedule
  }

  learnSkill(id: string): void {
    if (!this.knownSkillIds.includes(id)) {
      this.knownSkillIds.push(id);
    }
  }

  gainXp(n: number): void {
    if (n <= 0 || this.isDead) {
      return;
    }
    this.xp += n;
    while (this.xp >= this.xpToNext) {
      this.xp -= this.xpToNext;
      this.level++;
      this.xpToNext = Math.round(25 * Math.pow(this.level, 1.4));
      this.stats = this.computeStats();
      this.maxHp = this.stats.maxHp;
      this.hp = this.maxHp;
      let learned: SkillDef | undefined;
      this.species.skills.forEach((id, i) => {
        if (this.knownSkillIds.includes(id)) {
          return;
        }
        const lv = this.learnLevelOf(id, i);
        if (lv !== undefined && lv <= this.level) {
          this.knownSkillIds.push(id);
          learned ??= skillRegistry.get(id);
        }
      });
      this.bus.emit({
        type: "beastLevelUp",
        beastId: this.species.id,
        nameKey: this.species.nameKey,
        level: this.level,
        learned,
      });
      this.playAction("happy", 1.5);
    }
  }

  takeDamage(amount: number, from: THREE.Vector3, _element?: ElementType): boolean {
    // A beast in transit is light. Backstop only: a projectile already in flight
    // must not connect with an absent body.
    if (this.isDead || this.poofT > 0 || this.beaming) {
      return false;
    }
    const mitigated = amount * (100 / (100 + this.stats.defense));
    this.hp = Math.max(0, this.hp - mitigated);
    this.hurtFlash = 0.22;
    this.flashDirty = true;
    if (this.hp <= 0) {
      this.isDead = true;
      this.deadTimer = REVIVE_SECONDS;
      this.dieT = 0;
      this.transient = null;
      this.abortFetch(); // put the drop back in play for whoever revives
      this.carryTime = 0;
    } else {
      this.playAction("hurt");
      const dx = this.position.x - from.x,
        dz = this.position.z - from.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4) {
        this.vel.x += (dx / d) * 3.5;
        this.vel.z += (dz / d) * 3.5;
      }
    }
    return true;
  }

  playAction(action: BeastAction, duration?: number): void {
    this.transient = action;
    this.transientTime = 0;
    this.transientDur = duration ?? TRANSIENT_DURATIONS[action] ?? 0.6;
  }

  beginCast(skill: SkillDef): { origin: THREE.Vector3; direction: THREE.Vector3 } {
    this.playAction(skill.castAnim);
    this.bus.emit({ type: "skillCast", skillId: skill.id, casterNameKey: this.species.nameKey });
    const origin = new THREE.Vector3(
      this.position.x + this.forward.x * this.rig.radius * 0.7,
      this.position.y + this.rig.height * 0.62,
      this.position.z + this.forward.z * this.rig.radius * 0.7,
    );
    return { origin, direction: this.forward.clone() };
  }

  wantsSupportCast(): boolean {
    // The timer is a CADENCE, not a reason to attack (issue #124): no skill is
    // spent until `supportNeeded` says there is a fight to join.
    if (
      !this.supportNeeded ||
      this.isDead ||
      this.poofT > 0 ||
      this.beaming ||
      this.supportTimer > 0
    ) {
      return false;
    }
    this.supportTimer = 6 + Math.random() * 4;
    return true;
  }

  get isFetching(): boolean {
    return this.fetchJob !== null;
  }
  get isCarrying(): boolean {
    return this.carryTime > 0;
  }
  get fetchItemId(): string | null {
    return this.fetchJob ? this.fetchJob.itemId : null;
  }

  /** Claims the job; false leaves the drop for someone else. */
  beginFetch(job: FetchJob): boolean {
    if (this.fetchJob || this.isDead || this.poofT > 0 || this.beaming) {
      return false;
    }
    if (!job.claim()) {
      return false;
    }
    this.fetchJob = job;
    this.fetchTime = 0;
    return true;
  }

  private abortFetch(): void {
    this.fetchJob?.release();
    this.fetchJob = null;
    this.fetchTime = 0;
  }

  private updateFetch(dt: number, owner: BeastOwner): FetchJob | null {
    if (this.carryTime > 0) {
      this.carryTime -= dt;
    }
    const job = this.fetchJob;
    if (!job) {
      return null;
    }
    this.fetchTime += dt;

    const lx = job.position.x - owner.position.x;
    const lz = job.position.z - owner.position.z;
    if (
      !job.valid ||
      this.fetchTime > FETCH_TIMEOUT ||
      lx * lx + lz * lz > FETCH_LEASH * FETCH_LEASH
    ) {
      this.abortFetch();
      return null;
    }

    const gx = job.position.x - this.position.x;
    const gz = job.position.z - this.position.z;
    if (gx * gx + gz * gz < FETCH_REACH_SQ) {
      // BEFORE the grab: collect() emits synchronously, and a listener identifies the
      // fetcher as whichever beast is carrying.
      this.fetchJob = null;
      this.fetchTime = 0;
      this.carryTime = FETCH_CARRY;
      this.playAction("happy", 0.9);
      job.collect();
      return null;
    }
    return job;
  }

  setVisible(v: boolean): void {
    this.visibleFlag = v;
    this.rig.root.visible = v && !this.beaming && !(this.isDead && this.dieT >= 1);
    // A HIDDEN BEAST STOPS BEING SLICED, so a running effect would freeze mid-air
    // (issue #136); this is the one line every swap goes through. The arc is a rig
    // child. `beaming` is LEFT set, so a swapped-back beast resumes travelling.
    if (!v) {
      this.beam.clear();
      this.puff.clear();
      this.dust.clear();
    }
  }

  get mountScale(): number {
    return Math.min(MOUNT_MAX_SCALE, Math.max(1, MOUNT_HEIGHT / this.silhouetteTop));
  }

  /** LIVE saddle height, growth included, so a rider rises with it. See SEAT_FRACTION. */
  get saddleY(): number {
    return this.silhouetteTop * this.rideScale * SEAT_FRACTION;
  }

  get scaledRadius(): number {
    return this.rig.radius * this.rideScale;
  }

  get isRidden(): boolean {
    return this.ridden;
  }

  setRidden(on: boolean): void {
    if (this.ridden === on) {
      return;
    }
    this.ridden = on;
    this.rideScaleTarget = on ? this.mountScale : 1;
    // Does NOT reset poofT — that scales the rig from nothing and fights the growth.
    _dummy.position.copy(this.position);
    _dummy.position.y += this.rig.height * 0.5;
    this.puff.burst(_dummy.position, this.rig.radius);
    if (on) {
      // Hard exit from light travel: `beaming` hid the rig all ride (issue #91).
      this.beaming = false;
      this.rig.root.visible = this.visibleFlag && !(this.isDead && this.dieT >= 1);
      this.abortFetch();
      this.carryTime = 0;
      this.transient = null;
      this.playAction("happy", 0.7);
    }
  }

  /** One slice with a rider, INSTEAD of update(). MountController owns the motion. */
  rideUpdate(dt: number, s: BeastRideState): void {
    this.time += dt;
    if (this.isDead) {
      this.puff.update(dt);
      this.arc.update(dt);
      this.dust.update(dt);
      return;
    }
    this.position.set(s.x, s.y, s.z);
    this.vel.set(s.vx, 0, s.vz);
    this.vy = 0;
    this.grounded = s.action !== "fly";
    // No damping: the hero's rig takes the SAME angle, and a second filter would
    // let rider and saddle disagree in every turn.
    this.yaw = s.yaw;
    this.pitch = s.pitch;
    this.bank = s.bank;
    this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.speed01 = damp(this.speed01, s.speed01, 8, dt);
    this.finishFrame(dt, s.action);
  }

  update(dt: number, owner: BeastOwner, role: "primary" | "support", others: BeastActor[]): void {
    this.time += dt;

    // THE GROUND MOVES FIRST, before steering, and above the dead branch: a corpse
    // on a moving deck rides along too.
    this.ride.carry(this.world, this.position);
    this.yaw += this.ride.dyaw;

    if (this.isDead) {
      this.updateDead(dt, owner, role);
      this.puff.update(dt);
      this.arc.update(dt);
      this.dust.update(dt);
      this.beam.update(dt);
      return;
    }

    if (role === "support") {
      this.supportTimer -= dt;
    }

    const ovx = owner.velocity.x,
      ovz = owner.velocity.z;
    const ownerSpeed = Math.hypot(ovx, ovz);
    if (ownerSpeed > 0.8) {
      this.ownerHeading = dampAngle(this.ownerHeading, Math.atan2(ovx, ovz), 6, dt);
    }

    // Station point: right-rear for primary, left-rear for support.
    const side = role === "primary" ? 1 : -1;
    const cos = Math.cos(this.ownerHeading),
      sin = Math.sin(this.ownerHeading);
    const ox = side * 1.5,
      oz = -1.4;
    let tx = owner.position.x + ox * cos + oz * sin;
    let tz = owner.position.z + oz * cos - ox * sin;

    const dOwnX = owner.position.x - this.position.x;
    const dOwnZ = owner.position.z - this.position.z;
    if (!this.initialized || dOwnX * dOwnX + dOwnZ * dOwnZ > TELEPORT_DIST * TELEPORT_DIST) {
      this.teleportTo(tx, tz, !this.initialized);
      this.initialized = true;
    }

    // The VERTICAL leash, above the horizontal one, re-using the station point so a
    // beast that beams in lands where it would have walked to.
    const reach = owner.position.y - this.landingY(tx, tz, owner);
    const flying = this.species.locomotion === "flying";
    if (this.beaming) {
      this.updateBeaming(dt, tx, tz, owner, reach);
      return;
    }
    // Walkers withdraw when the owner leaves every surface; flyers only when diving.
    if ((flying && owner.deepDiving) || (!flying && reach > BEAM_RISE)) {
      this.beginBeam();
      this.updateBeaming(dt, tx, tz, owner, reach);
      return;
    }

    // Order matters: the teleport check above measures the OWNER, so a beast left
    // behind snaps to the party, not to the loot.
    const errand = this.updateFetch(dt, owner);
    if (errand) {
      tx = errand.position.x;
      tz = errand.position.z;
    }

    const dx = tx - this.position.x,
      dz = tz - this.position.z;
    const dist = Math.hypot(dx, dz);

    const loco = this.species.locomotion;
    const groundY = this.groundAt(this.position.x, this.position.z);
    const deepWater =
      this.world.isWater(this.position.x, this.position.z) &&
      groundY < this.world.waterLevel - 0.25;
    const swimming = loco !== "flying" && deepWater;

    let mediumMult = 1;
    if (swimming) {
      mediumMult = loco === "swimming" ? 1.35 : loco === "amphibious" ? 1.2 : 0.8;
    } else if (loco === "swimming") {
      mediumMult = 0.55;
    } // waddling on land
    else if (loco === "amphibious") {
      mediumMult = 0.8;
    } else if (loco === "flying") {
      mediumMult = 1.1;
    }

    const baseSpeed = this.stats.speed * mediumMult;
    const catchup = dist > 7 ? Math.min(1.7, 1 + (dist - 7) * 0.12) : 1;
    // An errand target is stood ON, so the ramp only reaches zero at the drop.
    const slowR = errand ? 1.0 : 3.0,
      stopR = errand ? 0 : 0.3;
    const arrive = smoothstep01((dist - stopR) / (slowR - stopR));
    const hustle = errand || this.carryTime > 0 ? FETCH_HUSTLE : 1;
    const desiredSpeed = baseSpeed * catchup * arrive * hustle;

    let desX = 0,
      desZ = 0;
    if (dist > 1e-4) {
      desX = (dx / dist) * desiredSpeed;
      desZ = (dz / dist) * desiredSpeed;
    }

    for (const other of others) {
      if (other === this || other.isDead) {
        continue;
      }
      const sx = this.position.x - other.position.x;
      const sz = this.position.z - other.position.z;
      const sd = Math.hypot(sx, sz);
      const minD = this.rig.radius + other.rig.radius + 0.5;
      if (sd < minD && sd > 1e-4) {
        const push = ((minD - sd) / minD) * 5;
        desX += (sx / sd) * push;
        desZ += (sz / sd) * push;
      }
    }

    const accel = 1 - Math.exp(-4.5 * dt);
    this.vel.x += (desX - this.vel.x) * accel;
    this.vel.z += (desZ - this.vel.z) * accel;

    // Refuse a destination whose structure top is over MAX_STEP_UP above the feet,
    // probed a body radius ahead, per-axis so a blocked diagonal slides. Fliers and
    // swimmers are exempt — nothing is built in deep water.
    if (loco === "flying" || swimming) {
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

    let base: BeastAction;
    if (loco === "flying") {
      base = "fly";
      this.updateFlying(dt, groundY, owner);
    } else if (swimming) {
      base = "swim";
      const bob = Math.sin(this.time * 2.2 + this.phase) * 0.07;
      const targetY = this.world.waterLevel - this.rig.height * 0.32 + bob;
      this.position.y = damp(this.position.y, targetY, 5, dt);
      this.vy = 0;
      this.grounded = false;
      this.pitch = damp(this.pitch, Math.sin(this.time * 2.2 + this.phase) * 0.06, 4, dt);
    } else {
      // Resample height post-integration so snapping/hops use the true ground
      this.updateGrounded(dt, horizSpeed, this.groundAt(this.position.x, this.position.z));
      base = "idle"; // refined below once speed01 is smoothed
    }

    const targetSpeed01 = Math.min(1, horizSpeed / Math.max(0.001, this.stats.speed * mediumMult));
    this.speed01 = damp(this.speed01, targetSpeed01, 8, dt);
    if (loco !== "flying" && !swimming) {
      base = this.speed01 > 0.5 ? "run" : this.speed01 > 0.06 ? "walk" : "idle";
    }

    const prevYaw = this.yaw;
    // A staged facing wins outright: flyers keep enough residual speed to trip the
    // movement branch, which left photo subjects facing away.
    const targetYaw =
      this.facingOverride ??
      (horizSpeed > 0.4 ? Math.atan2(this.vel.x, this.vel.z) : this.ownerHeading);
    this.yaw = dampAngle(this.yaw, targetYaw, horizSpeed > 0.4 ? 8 : 3.5, dt);
    const turnVel = dt > 0 ? angleDelta(prevYaw, this.yaw) / dt : 0;

    if (loco === "flying") {
      const targetBank = Math.max(-0.55, Math.min(0.55, -turnVel * 0.28));
      this.bank = damp(this.bank, targetBank, 5, dt);
    } else {
      // Lean into a turn, far less than a bird, scaled by gait so a beast pivoting
      // on the spot does not list like a ship.
      const turnLean = Math.max(-0.2, Math.min(0.2, -turnVel * 0.11));
      // ...and a standing beast sways 2 degrees. `phase` is per-actor.
      const sway = 0.035 * Math.sin(this.time * 1.15 + this.phase);
      const targetBank = turnLean * this.speed01 + sway * (1 - this.speed01);
      this.bank = damp(this.bank, targetBank, 6, dt);
    }
    this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));

    // Distance-driven, so puffs stay locked to the ground covered. Only at a real run.
    if (this.grounded && !swimming && loco !== "flying") {
      if (this.speed01 > 0.62) {
        this.scuffAccum += horizSpeed * dt;
        if (this.scuffAccum > 1.6) {
          this.scuffAccum = 0;
          this.dust.burst(
            this.position.x - this.forward.x * this.rig.radius * 0.5,
            this.position.y + 0.03,
            this.position.z - this.forward.z * this.rig.radius * 0.5,
            this.rig.radius * this.rideScale,
            0.28,
          );
        }
      } else {
        this.scuffAccum = 1.4;
      } // primed, so the first stride of a sprint puffs
    }

    this.finishFrame(dt, base);
  }

  /** Everything after PLACEMENT. The follow and ridden paths both end here. */
  private finishFrame(dt: number, base: BeastAction): void {
    if (this.transient) {
      this.transientTime += dt;
      if (this.transientTime >= this.transientDur) {
        this.transient = null;
        this.struckFor = null;
      }
    } else {
      this.struckFor = null;
    }

    // Fires INTO the lunge, not on the starting frame: every species coils first.
    if (this.transient && this.transient !== this.struckFor) {
      const strikeAt =
        this.transient === "special" ? 0.34 : this.transient === "attack" ? 0.13 : -1;
      if (strikeAt >= 0 && this.transientTime >= strikeAt) {
        this.struckFor = this.transient;
        this.arc.swing();
        // Flyers get the arc alone — dust from something hovering reads as a bug.
        if (this.grounded) {
          this.dust.burst(
            this.position.x + this.forward.x * this.rig.radius * 0.6,
            this.position.y + 0.04,
            this.position.z + this.forward.z * this.rig.radius * 0.6,
            this.rig.radius * this.rideScale,
            0.75,
          );
        }
      }
    }
    this.arc.update(dt);
    this.dust.update(dt);
    if (base !== this.baseAction) {
      this.baseAction = base;
      this.baseTime = 0;
    } else {
      this.baseTime += dt;
    }

    if (this.facingOverride !== null) {
      // Suppress only the beast's OWN flourish; clearing every transient here
      // killed the `anim=` staging parameter.
      this.idleTimer = 30;
      if (this.transient === "happy") {
        this.transient = null;
      }
    } else if (!this.transient && this.baseAction === "idle") {
      this.idleTimer -= dt;
      if (this.idleTimer <= 0) {
        this.playAction("happy", 1.2 + Math.random() * 0.5);
        this.idleTimer = 8 + Math.random() * 7;
      }
    } else if (this.baseAction !== "idle") {
      this.idleTimer = Math.max(this.idleTimer, 2.5);
    }

    if (this.hurtFlash > 0) {
      this.hurtFlash -= dt;
      const k = Math.max(0, this.hurtFlash / 0.22);
      for (const m of this.materials) {
        m.emissive.setRGB(k * 0.95, k * 0.12, k * 0.08);
      }
    } else if (this.flashDirty) {
      for (const m of this.materials) {
        m.emissive.setRGB(0, 0, 0);
      }
      this.flashDirty = false;
    }

    let s = 1;
    if (this.poofT > 0) {
      this.poofT -= dt;
      s = easeOutBack(Math.min(1, 1 - this.poofT / POOF_SECONDS));
      s = Math.max(0.001, s);
    }
    if (this.landSquash > 0) {
      this.landSquash -= dt * 3.2;
    }
    const sq = Math.max(0, this.landSquash);
    this.rideScale = damp(this.rideScale, this.rideScaleTarget, RIDE_SCALE_LAMBDA, dt);
    const ms = s * this.rideScale;
    this.rig.root.scale.set(ms * (1 + sq * 0.28), ms * (1 - sq * 0.38), ms * (1 + sq * 0.28));

    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.set(this.pitch, this.yaw, this.bank);

    this.ctx.action = this.transient ?? this.baseAction;
    this.ctx.actionTime = this.transient ? this.transientTime : this.baseTime;
    this.ctx.time = this.time;
    this.ctx.moveSpeed = this.speed01;
    this.ctx.dt = dt;
    // Sampled HERE: rideUpdate() is the other way in, and MountController never
    // computes a ground height itself.
    this.ctx.altitude = Math.max(
      0,
      this.position.y -
        Math.max(this.groundAt(this.position.x, this.position.z), this.world.waterLevel),
    );
    this.species.animate(this.rig, this.ctx);

    this.puff.update(dt);
    this.beam.update(dt);
  }

  private updateFlying(dt: number, groundY: number, owner: BeastOwner): void {
    const surf = Math.max(groundY, this.world.waterLevel);
    const aheadY = this.world.getHeight(
      this.position.x + this.forward.x * 2.5,
      this.position.z + this.forward.z * 2.5,
    );
    const hover = this.fetchJob ? 0.85 : 1.55;
    const floor = Math.max(surf, aheadY, this.world.waterLevel) + hover;
    // A flyer follows the owner's altitude too, ground still a lower bound, so a
    // skyfall has a mountable body rather than a wisp (issue #91).
    const target =
      Math.max(floor, owner.position.y + hover) + Math.sin(this.time * 1.6 + this.phase) * 0.22;
    const prevY = this.position.y;
    this.position.y = damp(this.position.y, target, 2.6, dt);
    const vyNow = dt > 0 ? (this.position.y - prevY) / dt : 0;
    this.pitch = damp(this.pitch, Math.max(-0.35, Math.min(0.35, -vyNow * 0.09)), 4, dt);
    this.grounded = false;
    this.vy = 0;
  }

  /**
   * Footing height: terrain, or a carrier's deck. NOT `blockTop` — walking through
   * trees and up terraces is deliberate. A deck IS the ground; a hut stands ON it.
   */
  private groundAt(x: number, z: number): number {
    const g = this.world.getHeight(x, z);
    const deck = this.ride.support(x, z);
    return deck > g ? deck : g;
  }

  private updateGrounded(dt: number, horizSpeed: number, groundY: number): void {
    // Sampled every slice INCLUDING airborne ones, or a landing spikes on a stale one.
    const along = this.vel.x * this.forward.x + this.vel.z * this.forward.z;
    const accel = dt > 1e-4 ? (along - this.prevAlong) / dt : 0;
    this.prevAlong = along;

    if (this.grounded) {
      if (groundY < this.position.y - 0.45) {
        this.grounded = false;
        this.vy = 0;
      } else if (groundY - this.position.y > 0.32 && horizSpeed > 0.5) {
        const dh = Math.min(groundY - this.position.y + 0.25, 1.4);
        this.vy = Math.sqrt(2 * GRAVITY * dh);
        this.grounded = false;
        this.landSquash = Math.max(this.landSquash, 0.18);
      } else {
        this.position.y = groundY;
      }
    }

    if (!this.grounded) {
      this.vy -= GRAVITY * dt;
      this.position.y += this.vy * dt;
      this.pitch = damp(this.pitch, Math.max(-0.28, Math.min(0.3, -this.vy * 0.035)), 6, dt);
      if (this.position.y <= groundY) {
        if (this.vy < -5.5) {
          this.landSquash = 0.32;
          // The squash happens INSIDE the silhouette; the dust is what the eye catches.
          const impact = Math.min(1, (-this.vy - 5.5) / 7);
          this.dust.burst(
            this.position.x,
            groundY + 0.04,
            this.position.z,
            this.rig.radius * this.rideScale,
            0.35 + 0.65 * impact,
          );
        }
        this.position.y = groundY;
        this.vy = 0;
        this.grounded = true;
      }
    } else {
      // Lean into acceleration — animate() only gets `moveSpeed`, never its
      // derivative. Positive pitch is nose DOWN here, unlike updateFlying.
      const lean = Math.max(-0.14, Math.min(0.16, accel * 0.014));
      this.pitch = damp(this.pitch, lean, 8, dt);
    }
  }

  private updateDead(dt: number, owner: BeastOwner, role: "primary" | "support"): void {
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
          for (const m of this.materials) {
            m.emissive.setRGB(0, 0, 0);
          }
        }
      }
    }
    if (this.deadTimer <= 0) {
      this.isDead = false;
      this.hp = Math.ceil(this.maxHp * 0.5);
      const side = role === "primary" ? 1 : -1;
      const cos = Math.cos(this.ownerHeading),
        sin = Math.sin(this.ownerHeading);
      this.teleportTo(
        owner.position.x + side * 1.5 * cos + -1.4 * sin,
        owner.position.z + -1.4 * cos - side * 1.5 * sin,
        false,
      );
      this.rig.root.visible = this.visibleFlag;
      this.dieT = 0;
    }
  }

  /**
   * Rebind to another zone's ground (world/zones.ts) rather than rebuild: level, xp
   * and the skill list ARE the save game. A zone change is past TELEPORT_DIST, so
   * the next slice poofs the beast in at the new world's height.
   */
  setWorld(world: World): void {
    this.world = world;
    this.beaming = false;
    this.rig.root.visible = this.visibleFlag && !(this.isDead && this.dieT >= 1);
    this.ride.clear();
    this.abortFetch();
    this.carryTime = 0;
    this.vel.set(0, 0, 0);
    this.vy = 0;
  }

  get inTransit(): boolean {
    return this.beaming;
  }

  get isDrawn(): boolean {
    return this.rig.root.visible;
  }

  /** Light-travel streak size on screen, 0 for none. The reading issue #136 wants. */
  get beamSize(): number {
    return this.beam.drawnSize;
  }

  /**
   * The surface a beast lands on at (x, z) — THE SAME ANSWER `teleportTo` PRODUCES.
   * The carrier is looked up at the OWNER's point: `at` takes a y, the station has none.
   */
  private landingY(x: number, z: number, owner: BeastOwner): number {
    const g = this.world.getHeight(x, z);
    const c = this.world.carriers.at(owner.position.x, owner.position.y, owner.position.z);
    const deck = c ? c.topAt(x, z) : -Infinity;
    if (deck > g) {
      return deck;
    }
    return this.world.isWater(x, z) && g < this.world.waterLevel - 0.25 ? this.world.waterLevel : g;
  }

  private beginBeam(): void {
    this.beaming = true;
    this.abortFetch(); // the drop belongs to ground the beast is leaving
    this.transient = null;
    this.baseAction = "idle";
    this.speed01 = 0;
    this.vel.set(0, 0, 0);
    this.vy = 0;
    this.ride.clear(); // it is riding nothing while it is light
    this.rig.root.visible = false;
    this.beam.column(this.position.x, this.position.y, this.position.z, 1);
  }

  /**
   * In transit: no steering, gravity, collision or hitbox. The position is pinned
   * ABOVE the owner, so every "where is my companion" answers "with you" (#70).
   */
  private updateBeaming(
    dt: number,
    tx: number,
    tz: number,
    owner: BeastOwner,
    reach: number,
  ): void {
    this.position.set(tx, owner.position.y + BEAM_WISP_RISE, tz);
    const gate = this.supportNeeded ? BEAM_LAND_FIGHT : BEAM_LAND;
    const canLand = this.species.locomotion === "flying" ? !owner.deepDiving : reach <= gate;
    if (canLand) {
      this.beaming = false;
      this.rig.root.visible = this.visibleFlag;
      this.teleportTo(tx, tz, false);
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
    // A TELEPORT LANDS IN THE WORLD and re-attaches from there, so a beast beside a
    // hero on an island finds the deck. A fresh attach applies no delta.
    this.ride.clear();
    this.ride.carry(this.world, this.position);
    const groundY = this.groundAt(x, z);
    const deepWater = this.world.isWater(x, z) && groundY < this.world.waterLevel - 0.25;
    if (this.species.locomotion === "flying") {
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

  /** Every rig joint's local rotation, for __dbgBeastAnim. Allocates; tools only. */
  animProbe(): unknown {
    const parts: Record<string, [number, number, number]> = {};
    for (const k of Object.keys(this.rig.parts)) {
      const o = this.rig.parts[k]!;
      parts[k] = [o.rotation.x, o.rotation.y, o.rotation.z];
    }
    // The flyers' contact blob in WORLD terms (issue #134); null for every walker.
    const blobPart = this.rig.parts.blob;
    let blob: unknown = null;
    if (blobPart) {
      const p = blobPart.getWorldPosition(new THREE.Vector3());
      const mat = (blobPart as THREE.Mesh).material as THREE.MeshBasicMaterial;
      blob = { y: p.y, visible: blobPart.visible, opacity: mat.opacity };
    }
    return {
      id: this.species.id,
      action: this.ctx.action,
      moveSpeed: this.ctx.moveSpeed,
      time: this.time,
      ridden: this.ridden,
      altitude: this.ctx.altitude ?? null,
      y: this.position.y,
      blob,
      parts,
    };
  }

  dispose(): void {
    LIVE_ACTORS.delete(this);
    this.abortFetch();
    this.scene.remove(this.rig.root);
    // BEFORE the traverse, which disposes every geometry it finds: the arc is a rig
    // child drawing the SHARED `puffGeo`.
    this.arc.dispose();
    this.beam.dispose();
    this.rig.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        const m = o as THREE.Mesh;
        m.geometry.dispose();
        const mat = m.material;
        if (Array.isArray(mat)) {
          for (const mm of mat) {
            mm.dispose();
          }
        } else {
          mat.dispose();
        }
      }
    });
    this.puff.dispose();
    this.dust.dispose();
  }
}
