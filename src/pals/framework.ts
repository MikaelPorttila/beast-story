import * as THREE from 'three';
import type {
  ElementType, EventBus, FetchJob, PalAction, PalAnimCtx, PalRig, PalSpecies,
  PalStats, SkillDef, World,
} from '../core/types';

// ---------------------------------------------------------------------------
// Skill definition registry
// ---------------------------------------------------------------------------
// The framework needs SkillDefs to know learnAtLevel and to include the
// learned SkillDef in palLevelUp events. The skills module registers its
// defs here during boot. If a def is missing we fall back to an index-based
// learn schedule so pals still progress.
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

const GRAVITY = 22;
const TELEPORT_DIST = 40;
const REVIVE_SECONDS = 8;
const POOF_SECONDS = 0.5;

// ---------------------------------------------------------------------------
// Mount form
// ---------------------------------------------------------------------------
/**
 * A ridden pal grows into a "mount form".
 *
 * Every pal in this game is knee-high: Emberfox's rig is a metre at the ears, a
 * Galebird barely more than half that, against a 1.7-unit hero. Seating a rider
 * on an unscaled pal puts a man on a housecat — captured, the hero completely
 * occluded the fox he was riding, and the Galebird swallowed him. So the rig is
 * scaled while ridden, eased over RIDE_SCALE_LAMBDA (~0.25 s to 90%) so it
 * reads as the pal swelling into its mount form rather than popping.
 *
 * MOUNT_HEIGHT is what a mount is scaled TO, not by: 2.1 units puts the mount
 * comfortably TALLER than its 1.7-unit rider, which is what makes the pair read
 * as a mount and not as a man carrying a pet, and it means the seat height, the
 * camera framing and the collision radius are one set of numbers rather than
 * ten. MOUNT_MAX_SCALE caps the smallest rigs; past ~3x, an 0.08-unit voxel is
 * a quarter-unit slab and the model stops reading as the pal you picked.
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
 * Where the MountController wants a ridden pal this slice. A single instance is
 * reused every frame — nothing here is retained past the call.
 */
export interface PalRideState {
  x: number; y: number; z: number;
  /** Final world yaw; the mount owns the smoothing, the pal just wears it. */
  yaw: number;
  pitch: number;
  bank: number;
  /** Horizontal velocity, so a dismount hands the pal its momentum back. */
  vx: number; vz: number;
  /** 0..1 gait blend, already normalised against the mount's own top speed. */
  speed01: number;
  /** Base action to animate: 'fly' for a flyer, 'run'/'walk'/'idle' on foot. */
  action: PalAction;
}

const TRANSIENT_DURATIONS: Partial<Record<PalAction, number>> = {
  attack: 0.5, cast: 0.7, special: 0.95, hurt: 0.45, happy: 1.35,
};

// ---------------------------------------------------------------------------
// Fetch errands
// ---------------------------------------------------------------------------
// A pal on an errand steers to a claimed drop instead of its station point,
// grabs it, and hurries back. WHICH drops are worth fetching is not decided
// here — main.ts offers the job (see beginFetch); this half only runs it, and
// the two abort rules below exist so a bad offer cannot strand a pal.
//
// How far from the OWNER a drop may be and still be worth walking to. The
// offer already filters on distance, so this is the pal's own bail-out for an
// owner who runs off mid-errand.
const FETCH_LEASH = 26;
// Give up on an errand that takes this long. The case this exists for is a
// drop on a ledge the pal cannot climb: without it the pal pushes into the
// hillside until the drop expires 42 s later, station point abandoned.
const FETCH_TIMEOUT = 12;
// Horizontal grab reach, squared. 0.75 units — deliberately wider than the
// player's own 0.67-unit collect radius, because a grounded pal arrives with
// its feet at the drop while a flyer arrives above it.
const FETCH_REACH_SQ = 0.75 * 0.75;
// Seconds of hurrying back after a successful grab. Purely how it reads: the
// pal turns straight around with the loot rather than sauntering, which is what
// sells the trip as an errand instead of a wander.
const FETCH_CARRY = 1.6;
// Errand pace as a multiplier on follow speed. Kept small on purpose: the gait
// is driven by speed01 normalised against the UNBOOSTED follow speed, so a big
// multiplier pins the run cycle at full blend while the pal covers ground
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
// PalOwner — the thing pals follow (the player controller)
// ---------------------------------------------------------------------------
export interface PalOwner {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  isSwimming: boolean;
}

// ---------------------------------------------------------------------------
// PalActor
// ---------------------------------------------------------------------------
export class PalActor {
  species: PalSpecies;
  level = 1;
  xp = 0;
  xpToNext = 25;
  stats: PalStats;
  position = new THREE.Vector3();
  forward = new THREE.Vector3(0, 0, 1);
  hp: number;
  maxHp: number;
  isDead = false;
  faction: 'player' = 'player';
  knownSkillIds: string[] = [];
  /**
   * World yaw (radians) the pal should turn to face while idle/slow, overriding
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

  private rig: PalRig;
  private scene: THREE.Scene;
  private world: World;
  private bus: EventBus;
  private puff: PoofPuff;
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
  private transient: PalAction | null = null;
  private transientTime = 0;
  private transientDur = 0;
  private baseAction: PalAction = 'idle';
  private baseTime = 0;
  private time = 0;
  private phase = Math.random() * TWO_PI;
  private ctx: PalAnimCtx = { action: 'idle', actionTime: 0, time: 0, moveSpeed: 0, dt: 0 };

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
  private deadTimer = 0;
  private dieT = 0;
  private visibleFlag = true;

  // Mount form (see MOUNT_HEIGHT). `rideScale` is the eased current value, so
  // dismounting shrinks back over the same quarter second it grew.
  private ridden = false;
  private rideScale = 1;
  private rideScaleTarget = 1;

  constructor(species: PalSpecies, scene: THREE.Scene, world: World, bus: EventBus) {
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
        // Pals CAST but never RECEIVE. A pal is a handful of voxel parts a few
        // centimetres apart, so the parts shadow each other: an ear prints a hard
        // band across a muzzle, and faces near-parallel to the sun pick up the
        // diagonal hatching of shadow-map acne. Both land on the read-at-a-glance
        // parts — the face — and both vanish here.
        //
        // The cost is that a pal no longer darkens standing in shade, which is
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

    this.stats = this.computeStats();
    this.maxHp = this.stats.maxHp;
    this.hp = this.maxHp;

    // Skills already known at level 1
    this.species.skills.forEach((id, i) => {
      const lv = this.learnLevelOf(id, i);
      if (lv !== undefined && lv <= this.level) this.knownSkillIds.push(id);
    });
  }

  // -- Progression ----------------------------------------------------------

  private computeStats(): PalStats {
    const b = this.species.baseStats;
    const f = Math.pow(1.08, this.level - 1);
    return {
      maxHp: Math.round(b.maxHp * f),
      attack: b.attack * f,
      defense: b.defense * f,
      // Speed compounds much more gently or high-level pals outrun the camera.
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
      this.bus.emit({ type: 'palLevelUp', palId: this.species.id, level: this.level, learned });
      this.playAction('happy', 1.5);
    }
  }

  // -- Combat interface (Damageable-compatible so PalActor can be a caster) --

  takeDamage(amount: number, from: THREE.Vector3, _element?: ElementType): void {
    if (this.isDead || this.poofT > 0) return;
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
  }

  // -- Actions / casting ----------------------------------------------------

  playAction(action: PalAction, duration?: number): void {
    this.transient = action;
    this.transientTime = 0;
    this.transientDur = duration ?? TRANSIENT_DURATIONS[action] ?? 0.6;
  }

  beginCast(skill: SkillDef): { origin: THREE.Vector3; direction: THREE.Vector3 } {
    this.playAction(skill.castAnim);
    this.bus.emit({ type: 'skillCast', skillId: skill.id, casterName: this.species.name });
    const origin = new THREE.Vector3(
      this.position.x + this.forward.x * this.rig.radius * 0.7,
      this.position.y + this.rig.height * 0.62,
      this.position.z + this.forward.z * this.rig.radius * 0.7,
    );
    return { origin, direction: this.forward.clone() };
  }

  wantsSupportCast(): boolean {
    if (this.isDead || this.poofT > 0 || this.supportTimer > 0) return false;
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
   * Send this pal to collect a drop. Claims the job; returns false (leaving the
   * drop for someone else) if the pal is busy, dead, or another fetcher got
   * there first.
   */
  beginFetch(job: FetchJob): boolean {
    if (this.fetchJob || this.isDead || this.poofT > 0) return false;
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
   * Advance the errand. Returns the job while the pal should still be steering
   * at it — null once it has been grabbed, abandoned, or was never running.
   */
  private updateFetch(dt: number, owner: PalOwner): FetchJob | null {
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
      // and emits on the bus, and a listener that wants to know WHICH pal just
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
    this.rig.root.visible = v && !(this.isDead && this.dieT >= 1);
  }

  // -- Mounting -------------------------------------------------------------

  /** Scale this species' rig reaches in mount form. See MOUNT_HEIGHT. */
  get mountScale(): number {
    return Math.min(MOUNT_MAX_SCALE, Math.max(1, MOUNT_HEIGHT / this.silhouetteTop));
  }

  /**
   * LIVE height of the saddle above the pal's origin, mount-form growth
   * included — so a rider seated the instant the growth starts rises with it
   * instead of beginning in mid-air. See SEAT_FRACTION.
   */
  get saddleY(): number { return this.silhouetteTop * this.rideScale * SEAT_FRACTION; }

  /** LIVE radius of the rig, mount-form growth included. Drives collision. */
  get scaledRadius(): number { return this.rig.radius * this.rideScale; }

  /** True while a rider holds the reins — the framework stops steering it. */
  get isRidden(): boolean { return this.ridden; }

  /**
   * Take or give back the reins. Grabbing a pal cancels an errand in progress
   * (the drop goes back in play for the other pal) and starts the mount-form
   * growth; letting go starts the shrink and hands normal follow steering back
   * from wherever the ride ended.
   */
  setRidden(on: boolean): void {
    if (this.ridden === on) return;
    this.ridden = on;
    this.rideScaleTarget = on ? this.mountScale : 1;
    // A puff at the changeover, the same burst a teleport uses. Mounting snaps
    // the pal from the rider's shoulder to under him and starts the mount-form
    // growth; without the cloud both of those read as a glitch rather than a
    // flourish. Note it does NOT reset poofT — that scales the rig up from
    // nothing, which would fight the growth this is announcing.
    _dummy.position.copy(this.position);
    _dummy.position.y += this.rig.height * 0.5;
    this.puff.burst(_dummy.position, this.rig.radius);
    if (on) {
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
   * bypassed — MountController owns where a ridden pal is and it collides
   * against the world itself. Everything cosmetic still runs, so a mount can be
   * hurt, cast, level up and flash exactly as it does on the ground.
   */
  rideUpdate(dt: number, s: PalRideState): void {
    this.time += dt;
    if (this.isDead) {
      // A mount that dies under its rider is dismounted by the caller on this
      // same slice; until then just let the death animation play.
      this.puff.update(dt);
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

  update(dt: number, owner: PalOwner, role: 'primary' | 'support', others: PalActor[]): void {
    this.time += dt;

    if (this.isDead) {
      this.updateDead(dt, owner, role);
      this.puff.update(dt);
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

    // -- Errand: steer at the drop instead of the station point -------------
    // Note the order — the teleport check above still measures the OWNER, so a
    // pal that falls far behind snaps to the party and drops the errand next
    // frame (leash), rather than teleporting to the loot.
    const errand = this.updateFetch(dt, owner);
    if (errand) { tx = errand.position.x; tz = errand.position.z; }

    // -- Arrive steering ----------------------------------------------------
    const dx = tx - this.position.x, dz = tz - this.position.z;
    const dist = Math.hypot(dx, dz);

    const loco = this.species.locomotion;
    const groundY = this.world.getHeight(this.position.x, this.position.z);
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

    // Separation from sibling pals
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

    this.position.x += this.vel.x * dt;
    this.position.z += this.vel.z * dt;

    const horizSpeed = Math.hypot(this.vel.x, this.vel.z);

    // -- Vertical motion per locomotion ------------------------------------
    let base: PalAction;
    if (loco === 'flying') {
      base = 'fly';
      this.updateFlying(dt, groundY);
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
      this.updateGrounded(dt, horizSpeed, this.world.getHeight(this.position.x, this.position.z));
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
      this.bank = damp(this.bank, 0, 8, dt);
    }
    this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));

    this.finishFrame(dt, base);
  }

  /**
   * Everything that happens once the pal has been PLACED, whoever placed it:
   * the action state machine, the hurt flash, the scale flourishes, the rig
   * transform and the species' own animate(). The follow path and the ridden
   * path both end here so neither can quietly skip one.
   */
  private finishFrame(dt: number, base: PalAction): void {
    // -- Action state machine ----------------------------------------------
    if (this.transient) {
      this.transientTime += dt;
      if (this.transientTime >= this.transientDur) this.transient = null;
    }
    if (base !== this.baseAction) { this.baseAction = base; this.baseTime = 0; }
    else this.baseTime += dt;

    // Idle flourish: happy wiggle every 8-15 s when standing around
    if (this.facingOverride !== null) {
      // Staged (photo) pose: hold a calm idle instead of random flourishes.
      this.idleTimer = 30;
      this.transient = null;
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
    // it, so a pal that is mounted mid-flourish keeps the flourish.
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
  }

  private updateFlying(dt: number, groundY: number): void {
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
    const target = Math.max(surf, aheadY, this.world.waterLevel)
      + hover + Math.sin(this.time * 1.6 + this.phase) * 0.22;
    const prevY = this.position.y;
    this.position.y = damp(this.position.y, target, 2.6, dt);
    const vyNow = dt > 0 ? (this.position.y - prevY) / dt : 0;
    this.pitch = damp(this.pitch, Math.max(-0.35, Math.min(0.35, -vyNow * 0.09)), 4, dt);
    this.grounded = false;
    this.vy = 0;
  }

  private updateGrounded(dt: number, horizSpeed: number, groundY: number): void {
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
        if (this.vy < -5.5) this.landSquash = 0.32;
        this.position.y = groundY;
        this.vy = 0;
        this.grounded = true;
      }
    } else {
      this.pitch = damp(this.pitch, 0, 8, dt);
    }
  }

  private updateDead(dt: number, owner: PalOwner, role: 'primary' | 'support'): void {
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
   * A pal is the clearest case for rebinding rather than rebuilding: its level,
   * xp and known-skill list ARE the save game. Nothing else is touched — the
   * follow update already teleports a pal whose owner is further than
   * TELEPORT_DIST away, and a zone change is by construction further than that,
   * so the pal poofs in beside the hero on the first slice in the new world with
   * the height read from the new world. Any fetch errand is dropped: the item it
   * was walking to belonged to the zone we just left.
   */
  setWorld(world: World): void {
    this.world = world;
    this.abortFetch();
    this.carryTime = 0;
    this.vel.set(0, 0, 0);
    this.vy = 0;
  }

  private teleportTo(x: number, z: number, silent: boolean): void {
    this.position.x = x;
    this.position.z = z;
    const groundY = this.world.getHeight(x, z);
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

  dispose(): void {
    this.abortFetch();
    this.scene.remove(this.rig.root);
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
  }
}
