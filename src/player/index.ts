import * as THREE from "three";
import type { Engine } from "../core/engine";
import type { Input } from "../core/input";
import {
  MAX_STEP_UP,
  type CarrierInfo,
  type ElementType,
  type EventBus,
  type World,
} from "../core/types";
import { CarrierRide } from "../world/carriers";
import { t } from "../i18n";
import { buildHeroRig, type HeroRig, setHairStyle, setWeaponModel, stowWeapon } from "./hero-rig";
import type { WeaponModelId } from "./weapons";
import { ThirdPersonCamera } from "./camera";
import { HeroAnimator, type AttackState } from "./animations";
import { DustSystem } from "./dust";

const WALK_SPEED = 6;
const SPRINT_MULT = 1.6;
const SWIM_SPEED = 3.4;
/** `DIVE_ACCEL` fights buoyancy; `SWIM_RISE_MAX` caps its spring, or a deep rise corks. */
const DIVE_ACCEL = 16;
const DIVE_SPEED = 3.4;
const SWIM_RISE_MAX = 12;
const GROUND_ACCEL = 42;
const AIR_ACCEL = 16;
const GRAVITY = 24;
const JUMP_VEL = 8.8;
const COYOTE_TIME = 0.12;
const JUMP_BUFFER = 0.12;
const TURN_RATE = 14;
// MAX_STEP_UP lives in core/types.ts; its derivation from JUMP_VEL and GRAVITY is
// written on it there.
/** Step-test half-width. A collision probe, not a capsule — there is no other. */
const BODY_RADIUS = 0.32;

/** Wider than BODY_RADIUS: the refusal is a colour change, not a rock. */
const DEEP_PROBE = 0.9;
/** Not a wall but the way home; the one way out there is a mount dying under you. */
const UNDERTOW = 3.2;
/** How far out the undertow looks for shallower water. Four columns. */
const UNDERTOW_REACH = 4;
const DEEP_TOAST_GAP = 6;

/** Columns are 1x1: 0.55 lands inside the wall column, under ~0.35 probes his own. */
const CLIMB_REACH = 0.55;
/** Over the 1.0 terrace a jump clears, under the 2.0 face it cannot; else Shift grabs kerbs. */
const CLIMB_MIN_RISE = 1.2;
/** About half WALK_SPEED: climbing is the slow way up. */
const CLIMB_SPEED = 3.2;
const CLIMB_SIDE_SPEED = 2.0;
const CLIMB_LAMBDA = 18;
/** Feet within this of the top mantle. Small, or the forward step reads as a pop. */
const CLIMB_TOP_EPS = 0.05;
/** Only a world change drops a face this far below the feet: fall, never snap. */
const CLIMB_LOST = 0.6;
/** Must clear the held column boundary (0.32) and stay under 1.0 to land in it. */
const MANTLE_PUSH = 0.7;
/** Re-grab lockout, long enough for the kick-off to clear probe range. */
const CLIMB_LOCKOUT = 0.35;
/** Face left above the feet needed to shuffle sideways, so wall ends stop him. */
const CLIMB_SIDE_HOLD = 0.6;

/** Must exceed MAX_STEP_UP, or the platform catch snaps a WALKING hero onto leaves. */
const CANOPY_MIN_CLEAR = 0.6;
/** The same 0.35 terrain uses for slopes: inside it he slides the dome, past it he falls. */
const CANOPY_GLUE = 0.35;

/** A mount is 2.1 units tall, so the on-foot 1.25/0.35 lands inside the animal. */
const MOUNTED_STRIKE_Y = 1.5;
const MOUNTED_REACH = 1.1;

const COMBO_DURS = [0.42, 0.42, 0.58];
/** Seconds after the last swing before the weapon goes on his back. */
const STOW_AFTER = 6;
const STRIKE_AT = 0.46; // fraction of swing where damage lands
const COMBO_COOLDOWN = 0.22;

/**
 * One beat, no chain (issue #118). `evalDraw` in animations.ts reads the same
 * BOW_RELEASE, so hand and string let go on one frame.
 */
const BOW_DUR = 0.62;
const BOW_RELEASE = 0.55;
const BOW_COOLDOWN = 0.3;

/**
 * THE CAMERA IS NOT THE BOW: pitched 17.6° down at the hero, so a shot along its
 * forward hits turf. The bow marches the ray to the ground and aims at that POINT.
 * BOW_AIM_FAR is the arrow's reach; BOW_AIM_STEP 1 is one terrain column.
 */
const BOW_AIM_FAR = 25;
const BOW_AIM_STEP = 1;
/** Skip the first stride: the ground under the hero's own feet is not a target. */
const BOW_AIM_NEAR = 3;
const RESPAWN_TIME = 3;

/** REGEN_DELAY restarts on every hit, so trickle never fights incoming damage. */
const BASE_REGEN = 1.6;
const REGEN_DELAY = 5;

const _wish = new THREE.Vector3();
const _hvel = new THREE.Vector3();
const _knock = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
/** Where the crosshair is pointing, in the world. See BOW_AIM_DIST. */
const _aimPt = new THREE.Vector3();
const _feet = new THREE.Vector3();

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

function dampAngle(cur: number, target: number, rate: number, dt: number): number {
  let d = target - cur;
  while (d > Math.PI) {
    d -= Math.PI * 2;
  }
  while (d < -Math.PI) {
    d += Math.PI * 2;
  }
  return cur + d * (1 - Math.exp(-rate * dt));
}

/** The hero. Implements Damageable (faction 'player'). */
export class Player {
  root: THREE.Group;
  position: THREE.Vector3;
  velocity = new THREE.Vector3();
  forward = new THREE.Vector3(0, 0, 1);
  hp = 100;
  maxHp = 100;
  isDead = false;
  readonly faction = "player" as const;
  attackStat = 14;
  /** The ONE writer is `applyLoadout`; the rig is the storage, so nothing can disagree. */
  setWeapon(id: WeaponModelId | null): void {
    setWeaponModel(this.rig, id);
  }

  get weapon(): WeaponModelId | null {
    return this.rig.weapon;
  }

  /** `colour` is the PICKED one: null means the style draws in its own (player/hair.ts). */
  setHair(styleId: string, colour: number | null): void {
    setHairStyle(this.rig, styleId, colour);
  }

  get hairStyle(): string {
    return this.rig.hairStyle;
  }
  /** Resolved — never the "not picked" null. */
  get hairColour(): number {
    return this.rig.hairColour;
  }
  /** For `__dbgHair`: a probe proves a style swap by the GEOMETRY changing. */
  get rigHairMesh(): THREE.Mesh | null {
    return (this.rig.hair.children[0] as THREE.Mesh | undefined) ?? null;
  }
  onGround = false;
  isSwimming = false;
  /** Throttle; see DEEP_TOAST_GAP. The refusal fires on every slice at a basin edge. */
  private deepToastT = 0;
  /** True while hanging on a climbable face; gravity is off and Shift is grip. */
  isClimbing = false;
  /** Held up by a TREE. State, not a query: it gates what the step test may see. */
  onCanopy = false;
  /** MountController owns position and heading; regen, damage and the animator stay here. */
  isMounted = false;
  get isAttacking(): boolean {
    return this.attack.active;
  }
  moveSpeedNorm = 0;
  /** The step test's own radius, so "is he touching that?" cannot drift onto a second number. */
  readonly radius = BODY_RADIUS;
  onAttack?: (origin: THREE.Vector3, direction: THREE.Vector3) => void;
  /**
   * Nudges `direction` toward the enemy nearest the crosshair and reports whether
   * it moved. A hook, because the enemy list is combat's. Mutates in place.
   */
  aimAssist?: (origin: THREE.Vector3, direction: THREE.Vector3) => boolean;

  /** `carry` moves him with the frame; `support` folds the deck into `blockTop` and the floor. */
  private readonly ride = new CarrierRide();

  /** For the SAVE (issue #171): island positions are stored in island coordinates. */
  get carrier(): CarrierInfo | null {
    return this.ride.carrier;
  }

  private rig: HeroRig;
  /** Public only so main.ts can hand it to the feedback layer as a shake sink. */
  readonly cam = new ThirdPersonCamera();
  private animator = new HeroAnimator();
  private dust: DustSystem;

  private time = 0;
  private heading = 0;

  /** The BODY's heading, not the camera's. `__dbgCamYaw` answers for the arm. */
  get facing(): number {
    return this.heading;
  }
  private coyote = 0;
  private jumpBuffer = 0;
  private landBump = 0;
  private hurtT = 0;
  private flash = 0;
  private invulnT = 0;
  private deadT = 0;
  private sprinting = false;
  /** Saddle pose written by MountController; see setRidePose. */
  private rideYaw = 0;
  private rideSpeed01 = 0;
  /** Unit horizontal vector pointing INTO the face being held. */
  private climbDirX = 0;
  private climbDirZ = 1;
  /** Signed climb progress, -1..1, for the animator's reach cycle. */
  private climbRate = 0;
  /** Blocks re-grabbing right after a deliberate let-go; see CLIMB_LOCKOUT. */
  private climbLockout = 0;
  /** `input.pressed()` spans a whole frame, so the edge is latched here, not read. */
  private jumpWasHeld = false;
  private jumpEdge = false;
  /** Seconds left before passive regen resumes; reset by every hit taken. */
  private regenHold = 0;
  /** 1 = the base trickle. Public so main.ts drives it without Player knowing potions. */
  regenMultiplier = 1;

  private attack: AttackState = { active: false, combo: 0, t: 0, dur: COMBO_DURS[0] };
  /** SHEATHING IS A TIMER, not a state machine — no "am I in combat" flag to keep honest. */
  private sinceAttack = STOW_AFTER;
  private attackQueued = false;
  private struck = false;
  private attackCooldown = 0;

  constructor(
    private engine: Engine,
    private world: World,
    private input: Input,
    private bus: EventBus,
  ) {
    this.rig = buildHeroRig();
    this.root = this.rig.root;
    this.position = this.root.position;
    this.position.copy(world.spawnPoint);
    this.position.y = world.getHeight(this.position.x, this.position.z);
    this.dust = new DustSystem(engine.scene);
    engine.scene.add(this.root);
  }

  /** Rebind zone ground (world/zones.ts) without reconstructing him, so hp survives. */
  setWorld(world: World): void {
    this.world = world;
    this.ride.clear();
    this.isClimbing = false;
    this.climbLockout = 0;
    this.isSwimming = false;
    this.deepToastT = 0;
    this.onCanopy = false;
    this.velocity.set(0, 0, 0);
  }

  /** Returns what landed. Does NOT clear `regenHold`, and does not revive the dead. */
  heal(amount: number): number {
    if (this.isDead || amount <= 0) {
      return 0;
    }
    const before = this.hp;
    this.hp = clamp(this.hp + amount, 0, this.maxHp);
    return this.hp - before;
  }

  takeDamage(amount: number, from: THREE.Vector3, element?: ElementType): boolean {
    if (this.isDead || this.invulnT > 0) {
      return false;
    }
    this.hp = clamp(this.hp - amount, 0, this.maxHp);
    this.regenHold = REGEN_DELAY;
    this.flash = 1;
    this.hurtT = 0.25;
    this.invulnT = 0.35;
    // The camera kick is the `playerHurt` cue in src/feedback/cues.ts, not here.
    _knock.set(this.position.x - from.x, 0, this.position.z - from.z);
    if (_knock.lengthSq() < 1e-4) {
      _knock.copy(this.forward).multiplyScalar(-1);
    }
    _knock.normalize();
    this.velocity.x += _knock.x * 5.5;
    this.velocity.z += _knock.z * 5.5;
    this.velocity.y += 2.5;
    this.onGround = false;
    if (this.hp <= 0) {
      this.die();
    }
    // Past the i-frame gate on purpose: this means "he was hit", not "swung at".
    this.bus.emit({
      type: "playerHurt",
      amount,
      amountFrac: amount / this.maxHp,
      hpFrac: this.hp / this.maxHp,
      element,
      dirX: _knock.x,
      dirZ: _knock.z,
      fatal: this.isDead,
    });
    return true;
  }

  private die(): void {
    this.isDead = true;
    this.deadT = 0;
    this.isClimbing = false;
    // The corpse slide resolves against getHeight only, so a treetop faint falls out.
    this.onCanopy = false;
    this.attack.active = false;
    this.bus.emit({ type: "playerDied" });
    this.bus.emit({ type: "toast", text: t("toast.fainted") });
  }

  /** `respawn` is the same LIST, not reused: its revival toast is false after New Game. */
  reset(): void {
    this.isDead = false;
    this.hp = this.maxHp;
    this.flash = 0;
    this.hurtT = 0;
    this.regenHold = 0;
    this.isClimbing = false;
    this.isSwimming = false;
    this.onCanopy = false;
    this.climbLockout = 0;
    this.deepToastT = 0;
    this.attack.active = false;
    this.takeStartPose();
  }

  /**
   * The opening shot: camera on his FACE. `cam.yaw` is the bearing FROM hero TO
   * camera, so the usual framing is `heading + PI` and this is its reverse.
   */
  takeStartPose(): void {
    const start = this.world.playerStart;
    this.velocity.set(0, 0, 0);
    this.ride.clear();
    this.position.copy(start.position);
    this.position.y = Math.max(
      this.world.getHeight(this.position.x, this.position.z),
      this.world.waterLevel,
    );
    this.root.position.copy(this.position);
    this.heading = start.yaw;
    this.root.rotation.y = this.heading;
    this.forward.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.cam.yaw = start.yaw;
  }

  /**
   * Where a save left him (issue #171); the position is the caller's, already
   * resolved by main.ts. The camera goes BEHIND him, unlike `takeStartPose`.
   */
  restore(hp: number, x: number, y: number, z: number, yaw: number): void {
    this.velocity.set(0, 0, 0);
    this.ride.clear();
    this.isDead = false;
    this.flash = 0;
    this.hurtT = 0;
    this.regenHold = 0;
    this.isClimbing = false;
    this.isSwimming = false;
    this.onCanopy = false;
    this.climbLockout = 0;
    this.deepToastT = 0;
    this.attack.active = false;
    // Floored at 1: loading into a faint plays the death sequence over a Load.
    this.hp = Math.max(1, Math.min(this.maxHp, Math.round(hp)));
    this.position.set(x, y, z);
    this.root.position.copy(this.position);
    this.heading = yaw;
    this.root.rotation.y = this.heading;
    this.forward.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.cam.yaw = yaw + Math.PI;
  }

  private respawn(): void {
    this.ride.clear();
    this.isDead = false;
    this.hp = this.maxHp;
    this.flash = 0;
    this.hurtT = 0;
    this.isClimbing = false;
    this.onCanopy = false;
    this.climbLockout = 0;
    this.velocity.set(0, 0, 0);
    this.position.copy(this.world.spawnPoint);
    this.position.y = this.world.getHeight(this.position.x, this.position.z);
    this.bus.emit({ type: "playerRevived" });
    this.bus.emit({ type: "toast", text: t("toast.revived") });
  }

  /** The basis movement input is resolved against. */
  get camForward(): THREE.Vector3 {
    return this.cam.forward;
  }
  get camRight(): THREE.Vector3 {
    return this.cam.right;
  }

  /** Re-frame the follow camera; (1, 0) is the hero on foot. See the camera. */
  setCameraFraming(distScale: number, pivotDrop: number): void {
    this.cam.setFraming(distScale, pivotDrop);
  }

  /**
   * TEST HOOK: swing the camera so W walks him along `bearing` — a WALK bearing,
   * not `cam.yaw`, which is the ARM and runs the other way. `cam.forward` comes
   * from the SMOOTHED position, so wait for `__dbgCamYaw` before driving.
   */
  aimCamera(bearing: number): void {
    this.cam.yaw = bearing + Math.PI;
  }

  /** Cancels everything he was doing on his own feet; position is the mount's now. */
  setMounted(on: boolean): void {
    if (this.isMounted === on) {
      return;
    }
    this.isMounted = on;
    this.isClimbing = false;
    this.onCanopy = false;
    this.climbLockout = CLIMB_LOCKOUT;
    this.attack.active = false;
    this.attackQueued = false;
    this.jumpBuffer = 0;
    this.coyote = 0;
    if (on) {
      this.isSwimming = false;
      this.sprinting = false;
    }
  }

  /** `grounded` goes to the camera's step smoothing: a flyer's climb wants no glide. */
  setRidePose(yaw: number, speed01: number, grounded: boolean): void {
    this.rideYaw = yaw;
    this.rideSpeed01 = speed01;
    this.onGround = grounded;
  }

  /**
   * Separate from `update` because photo mode skips the controller while the world
   * keeps moving. Idempotent: the delta is published once by `CarrierRegistry.advance`.
   */
  carry(): void {
    this.ride.carry(this.world, this.position);
    if (this.ride.dyaw === 0) {
      return;
    }
    // A turning deck turns his body AND the camera arm, which is not re-derived.
    this.heading += this.ride.dyaw;
    this.cam.yaw += this.ride.dyaw;
    this.root.rotation.y = this.heading;
  }

  update(dt: number): void {
    this.time += dt;
    const input = this.input;
    const world = this.world;

    // THE GROUND MOVES FIRST, so everything below runs in world space. Skipped in
    // the saddle, where MountController would apply the delta a second time.
    if (!this.isMounted) {
      this.carry();
    }

    if (this.invulnT > 0) {
      this.invulnT -= dt;
    }
    if (this.hurtT > 0) {
      this.hurtT -= dt;
    }
    if (this.attackCooldown > 0) {
      this.attackCooldown -= dt;
    }
    this.landBump *= Math.exp(-6 * dt);

    // Latched per slice: Space is also "let go of the wall" and must not fire twice
    // in one frame. `pressed` is OR-ed in because held state misses a sub-slice tap.
    const jumpNow = input.down("Space") || input.pressed("Space");
    this.jumpEdge = jumpNow && !this.jumpWasHeld;
    this.jumpWasHeld = jumpNow;

    if (this.isDead) {
      this.deadT += dt;
      if (this.deadT >= RESPAWN_TIME) {
        this.respawn();
      }
      this.velocity.x *= Math.exp(-8 * dt);
      this.velocity.z *= Math.exp(-8 * dt);
      this.velocity.y -= GRAVITY * dt;
      this.position.addScaledVector(this.velocity, dt);
      const gh = world.getHeight(this.position.x, this.position.z);
      if (this.position.y <= gh) {
        this.position.y = gh;
        this.velocity.y = 0;
      }
      this.moveSpeedNorm = 0;
    } else if (this.isMounted) {
      this.updateRiding(dt);
      // Only LOCOMOTION belongs to the mount; the rider keeps his arms.
      this.updateAttack(dt);
    } else {
      this.updateAlive(dt);
    }

    if (this.flash > 0.001) {
      this.flash *= Math.exp(-7 * dt);
      for (const m of this.rig.materials) {
        m.emissive.setRGB(this.flash * 0.9, this.flash * 0.1, this.flash * 0.08);
      }
    } else if (this.flash > 0) {
      this.flash = 0;
      for (const m of this.rig.materials) {
        m.emissive.setRGB(0, 0, 0);
      }
    }

    this.sinceAttack = this.attack.active ? 0 : this.sinceAttack + dt;
    stowWeapon(this.rig, this.sinceAttack >= STOW_AFTER && !this.isDead);

    this.animator.update(this.rig, {
      time: this.time,
      dt,
      moveNorm: this.moveSpeedNorm,
      sprinting: this.sprinting,
      onGround: this.onGround,
      swimming: this.isSwimming,
      climbing: this.isClimbing,
      climbRate: this.climbRate,
      riding: this.isMounted,
      velY: this.velocity.y,
      attack: this.attack,
      dead: this.isDead,
      deadT: this.deadT,
      landBump: this.landBump,
      hurtT: this.hurtT,
      unarmed: this.rig.weapon === null,
      bow: this.rig.weapon === "bow",
      stowed: this.rig.stowed,
    });

    this.dust.update(dt, this.time);
    this.cam.update(dt, input, this.position, this.onGround, world, this.engine.camera);
    this.engine.updateSunFocus(this.position);
  }

  /**
   * Top of everything SOLID at a column. `trunkSolidTopAt` ignores the crown on
   * purpose: this compares a column's TOP against the feet, so a solid canopy rings
   * every tree with an invisible wall. A building needs no such trick — its
   * FOOTPRINT already omits what a body walks under (world/structures.ts).
   */
  private blockTop(x: number, z: number): number {
    const ground = this.world.getHeight(x, z);
    const trunk = this.world.trunkSolidTopAt(x, z);
    let top = trunk > ground ? trunk : ground;
    const built = this.world.structureTopAt(x, z);
    if (built > top) {
      top = built;
    }
    // A CARRIER'S DECK IS GROUND. -Infinity unless riding one, which is what makes it
    // safe to ask with (x, z) alone — `CarrierRide.carry` settled the vertical part.
    const deck = this.ride.support(x, z);
    if (deck > top) {
      top = deck;
    }
    // ...and the crown, ONLY while standing on one: unconditionally it fences every
    // tree, and without it walking up a dome steps off its uphill side.
    if (this.onCanopy) {
      const canopy = this.climbTop(x, z);
      if (canopy > top) {
        top = canopy;
      }
    }
    return top;
  }

  /** A TOAST, not a noise: what the player needs told is the fix, and that is a sentence. */
  private refuseDeep(): void {
    if (this.deepToastT > 0) {
      return;
    }
    this.deepToastT = DEEP_TOAST_GAP;
    this.bus.emit({ type: "toast", text: t("toast.deepWater") });
  }

  /**
   * Four probes, highest wins: gradient ascent, reach wider than any terrace, ties
   * to +x. Into `velocity` so it composes with his paddling. Longhand because a
   * `probe()` closure per slice is an allocation.
   */
  private undertow(dt: number): void {
    const w = this.world;
    const x = this.position.x;
    const z = this.position.z;
    const r = UNDERTOW_REACH;
    let best = w.getHeight(x + r, z);
    let bx = 1;
    let bz = 0;
    let h = w.getHeight(x - r, z);
    if (h > best) {
      best = h;
      bx = -1;
      bz = 0;
    }
    h = w.getHeight(x, z + r);
    if (h > best) {
      best = h;
      bx = 0;
      bz = 1;
    }
    h = w.getHeight(x, z - r);
    if (h > best) {
      bx = 0;
      bz = -1;
    }
    const k = 1 - Math.exp(-4 * dt);
    this.velocity.x += (UNDERTOW * bx - this.velocity.x) * k;
    this.velocity.z += (UNDERTOW * bz - this.velocity.z) * k;
    this.refuseDeep();
  }

  /**
   * `World.climbTopAt` cannot know about a flying island (it takes no `y`), so
   * without this fold nothing on a deck was climbable. Same shape as `blockTop`.
   */
  private climbTop(x: number, z: number): number {
    const w = this.world.climbTopAt(x, z);
    const deck = this.ride.support(x, z);
    return deck > w ? deck : w;
  }

  private canopyTop(x: number, z: number, ground: number): number {
    const top = this.climbTop(x, z);
    // Against what he STANDS on: a carrier's terrain is far below, so the whole
    // island would read as one enormous tree crown.
    const base = Math.max(ground, this.ride.support(x, z));
    return top > base + CANOPY_MIN_CLEAR ? top : -Infinity;
  }

  /** Held off for REGEN_DELAY after each hit. Runs on foot and in the saddle alike. */
  private updateRegen(dt: number): void {
    if (this.regenHold > 0) {
      this.regenHold -= dt;
    } else if (this.hp < this.maxHp) {
      this.hp = clamp(this.hp + BASE_REGEN * this.regenMultiplier * dt, 0, this.maxHp);
    }
  }

  /** No locomotion: MountController wrote position and pose; gravity here would fight it. */
  private updateRiding(dt: number): void {
    this.updateRegen(dt);
    this.sprinting = false;
    this.isSwimming = false;
    this.isClimbing = false;
    this.climbRate = 0;
    this.moveSpeedNorm = this.rideSpeed01;
    // Snapped, not damped: a second filter faces the rider out of the saddle in turns.
    this.heading = this.rideYaw;
    this.root.rotation.y = this.heading;
    this.forward.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  private updateAlive(dt: number): void {
    const input = this.input;
    const world = this.world;

    this.updateRegen(dt);

    const fwd = input.axisFwd;
    const side = input.axisSide;
    _wish.set(0, 0, 0).addScaledVector(this.cam.forward, fwd).addScaledVector(this.cam.right, side);
    const tilt = Math.min(1, Math.hypot(fwd, side));
    const moving = _wish.lengthSq() > 1e-6;
    if (moving) {
      _wish.normalize();
    }

    // Shift is sprint in the open, grip on a wall; the surface disambiguates. No
    // press edge is read, so it behaves the same at any slice count.
    if (this.climbLockout > 0) {
      this.climbLockout -= dt;
    }
    const shiftHeld = input.down("ShiftLeft");
    if (this.isClimbing) {
      if (!shiftHeld) {
        this.detachClimb(0); // let go: slide off and fall
      } else if (this.jumpEdge) {
        this.velocity.y = JUMP_VEL * 0.8;
        this.detachClimb(3.2);
      }
    } else if (shiftHeld && moving && !this.isSwimming && this.climbLockout <= 0) {
      this.tryGrab();
    }

    this.sprinting = moving && shiftHeld && !this.isSwimming && !this.isClimbing;
    if (this.isClimbing) {
      this.updateClimb(dt);
      this.finishAlive(dt, moving);
      return;
    }

    let targetSpeed = this.isSwimming
      ? SWIM_SPEED
      : WALK_SPEED * (this.sprinting ? SPRINT_MULT : 1);
    if (this.attack.active && this.onGround) {
      targetSpeed *= 0.35;
    } // planted swings
    if (tilt > 0 && tilt < 0.98) {
      targetSpeed *= Math.max(0.35, tilt);
    }

    const accel = this.isSwimming ? 14 : this.onGround ? GROUND_ACCEL : AIR_ACCEL;
    _hvel.set(this.velocity.x, 0, this.velocity.z);
    if (moving) {
      _hvel.x += (_wish.x * targetSpeed - _hvel.x) * (1 - Math.exp(-(accel / targetSpeed) * dt));
      _hvel.z += (_wish.z * targetSpeed - _hvel.z) * (1 - Math.exp(-(accel / targetSpeed) * dt));
    } else {
      const fric = Math.exp(-(this.onGround ? 11 : this.isSwimming ? 4 : 1.6) * dt);
      _hvel.x *= fric;
      _hvel.z *= fric;
    }
    this.velocity.x = _hvel.x;
    this.velocity.z = _hvel.z;

    if (input.pressed("Space")) {
      this.jumpBuffer = JUMP_BUFFER;
    } else {
      this.jumpBuffer -= dt;
    }
    this.coyote = this.onGround ? COYOTE_TIME : this.coyote - dt;
    if (this.deepToastT > 0) {
      this.deepToastT -= dt;
    }

    if (this.isSwimming) {
      const floatY = world.waterLevel - 1.15;
      if (input.down("KeyC")) {
        // Against the buoyancy, not instead of it. The vertical clamp below catches
        // the bed, so there is no separate floor test here.
        this.velocity.y -= DIVE_ACCEL * dt;
        if (this.velocity.y < -DIVE_SPEED) {
          this.velocity.y = -DIVE_SPEED;
        }
      } else {
        // CAPPED: uncapped, the spring turns into a cork once diving exists.
        const lift = Math.min((floatY - this.position.y) * 9, SWIM_RISE_MAX);
        this.velocity.y += (lift - this.velocity.y * 3.5) * dt;
      }
      if (input.down("Space")) {
        this.velocity.y += 9 * dt;
      } // paddle up
    } else {
      if (this.jumpBuffer > 0 && this.coyote > 0) {
        this.velocity.y = JUMP_VEL;
        this.jumpBuffer = 0;
        this.coyote = 0;
        this.onGround = false;
        this.dust.burst(this.position, 5);
      }
      this.velocity.y -= GRAVITY * dt;
    }

    // Horizontal first, refused past MAX_STEP_UP over the feet. Axes resolve
    // INDEPENDENTLY so a blocked diagonal slides, each probing BODY_RADIUS along its
    // own travel, and the reference is the feet BEFORE gravity — which is also what
    // makes a jump's apex read as clearance. Swimming is exempt: he floats 1.15
    // under the surface, so the rule would make every shoreline a wall.
    const feetY = this.position.y;
    if (this.isSwimming) {
      // The swimmer's version of the step test, with the probe ahead of his centre so
      // he stops at the edge of the dark. ALREADY OUT THERE is tested FIRST: every
      // column mid-basin is deep, so the refusal alone would pin him there.
      if (world.isDeepWater(this.position.x, this.position.z)) {
        this.undertow(dt);
        this.position.x += this.velocity.x * dt;
        this.position.z += this.velocity.z * dt;
      } else {
        const nx = this.position.x + this.velocity.x * dt;
        if (!world.isDeepWater(nx + Math.sign(this.velocity.x) * DEEP_PROBE, this.position.z)) {
          this.position.x = nx;
        } else {
          this.velocity.x = 0;
          this.refuseDeep();
        }

        const nz = this.position.z + this.velocity.z * dt;
        if (!world.isDeepWater(this.position.x, nz + Math.sign(this.velocity.z) * DEEP_PROBE)) {
          this.position.z = nz;
        } else {
          this.velocity.z = 0;
          this.refuseDeep();
        }
      }
    } else {
      const stepCeil = feetY + MAX_STEP_UP;
      const nx = this.position.x + this.velocity.x * dt;
      const probeX = nx + Math.sign(this.velocity.x) * BODY_RADIUS;
      if (this.blockTop(probeX, this.position.z) <= stepCeil) {
        this.position.x = nx;
      } else {
        this.velocity.x = 0;
      }

      const nz = this.position.z + this.velocity.z * dt;
      const probeZ = nz + Math.sign(this.velocity.z) * BODY_RADIUS;
      if (this.blockTop(this.position.x, probeZ) <= stepCeil) {
        this.position.z = nz;
      } else {
        this.velocity.z = 0;
      }
    }
    this.position.y += this.velocity.y * dt;

    // What holds him up. TERRAIN is solid from any direction; a TREE CROWN is a
    // ONE-WAY PLATFORM (World.trunkSolidTopAt), catching only feet that started the
    // slice at or above it and are on the way DOWN.
    const gh = world.getHeight(this.position.x, this.position.z);
    // A STRUCTURE is a floor from every direction: the horizontal test only lets him
    // over a box he just stepped onto, so a low crate is walked ON, not sunk into.
    const built = world.structureTopAt(this.position.x, this.position.z);
    let floor = built > gh ? built : gh;
    // ...and the deck, solid both ways: he only asks while inside the frame's volume.
    const deck = this.ride.support(this.position.x, this.position.z);
    if (deck > floor) {
      floor = deck;
    }
    const canopy = this.canopyTop(this.position.x, this.position.z, gh);
    let support = -Infinity;
    if (this.position.y <= floor) {
      support = floor; // solid ground always wins
      this.onCanopy = false;
    } else if (
      canopy > -Infinity &&
      this.velocity.y <= 0 &&
      // One-way, with the step test's own slack, so the two cannot disagree.
      feetY >= canopy - MAX_STEP_UP &&
      // Either he crossed the surface this slice, or it fell away by a slope's worth.
      (this.position.y <= canopy || (this.onCanopy && this.position.y - canopy < CANOPY_GLUE))
    ) {
      support = canopy;
      this.onCanopy = true;
    } else {
      // A chunk unloading under a standing player lands here too: fall, never snap.
      this.onCanopy = false;
    }

    if (support > -Infinity) {
      if (!this.onGround && this.velocity.y < -7) {
        this.landBump = clamp((-this.velocity.y - 6) / 13, 0, 1);
        _feet.set(this.position.x, support + 0.05, this.position.z);
        this.dust.burst(_feet, Math.min(14, Math.floor(-this.velocity.y)));
        // The squash's own ramp; the cue table keeps the shake gap as `shakeMin`.
        this.bus.emit({ type: "playerLanded", impact: this.landBump });
      }
      this.position.y = support;
      this.velocity.y = 0;
      this.onGround = true;
    } else if (this.onGround && this.velocity.y <= 0 && this.position.y - floor < 0.35) {
      // stay glued when running down slopes (jump sets velocity.y > 0)
      this.position.y = floor;
      this.velocity.y = 0;
    } else {
      this.onGround = false;
    }

    this.isSwimming = gh < world.waterLevel - 0.7 && this.position.y < world.waterLevel - 1.0;
    if (this.isSwimming) {
      this.onGround = false;
    }

    this.finishAlive(dt, moving);
  }

  /** The climb path and the walk path both end here, so neither can skip a step. */
  private finishAlive(dt: number, moving: boolean): void {
    const input = this.input;

    const hspeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.moveSpeedNorm = clamp(hspeed / WALK_SPEED, 0, 1);

    let targetHeading = this.heading;
    if (this.isClimbing) {
      // The animator reaches along local -z/+y, so the rig must face the rock.
      targetHeading = Math.atan2(this.climbDirX, this.climbDirZ);
    } else if (this.attack.active || input.attackHeld) {
      targetHeading = Math.atan2(this.cam.forward.x, this.cam.forward.z);
    } else if (moving) {
      targetHeading = Math.atan2(_wish.x, _wish.z);
    }
    this.heading = dampAngle(this.heading, targetHeading, TURN_RATE, dt);
    this.root.rotation.y = this.heading;
    this.forward.set(Math.sin(this.heading), 0, Math.cos(this.heading));

    this.updateAttack(dt);

    if (this.sprinting && this.onGround && this.moveSpeedNorm > 0.6) {
      _feet.set(
        this.position.x - this.forward.x * 0.3,
        this.position.y + 0.05,
        this.position.z - this.forward.z * 0.3,
      );
      this.dust.emit(_feet, 11, dt);
    }
  }

  /** Climbable and solid are different sets: a trunk is only the former. */
  private probeFace(dx: number, dz: number, reach: number): number {
    const top = this.climbTop(this.position.x + dx * reach, this.position.z + dz * reach);
    return top - this.position.y >= CLIMB_MIN_RISE ? top : -Infinity;
  }

  /**
   * Three probes: the CARDINAL snap (terrain faces are axis-aligned, so a 45-degree
   * approach must grab the wall, not the gap), the raw wish, then his OWN column —
   * a trunk is climbable without being solid.
   */
  private tryGrab(): void {
    const ax = Math.abs(_wish.x);
    const az = Math.abs(_wish.z);
    const cx = ax >= az ? Math.sign(_wish.x) : 0;
    const cz = ax >= az ? 0 : Math.sign(_wish.z);

    let top = this.probeFace(cx, cz, CLIMB_REACH);
    let dx = cx,
      dz = cz;
    if (top === -Infinity) {
      top = this.probeFace(_wish.x, _wish.z, CLIMB_REACH);
      dx = _wish.x;
      dz = _wish.z;
      if (top === -Infinity) {
        top = this.probeFace(_wish.x, _wish.z, 0);
        if (top === -Infinity) {
          return;
        }
      }
    }

    this.isClimbing = true;
    this.climbDirX = dx;
    this.climbDirZ = dz;
    this.climbRate = 0;
    this.onGround = false;
    this.onCanopy = false;
    this.coyote = 0;
    this.jumpBuffer = 0;
    // Kill inherited momentum, so a sprint into a cliff sticks instead of bouncing.
    this.velocity.set(0, 0, 0);
    this.attack.active = false;
  }

  /** Let go. `kick` pushes the hero away from the face (jump-off). */
  private detachClimb(kick: number): void {
    if (!this.isClimbing) {
      return;
    }
    this.isClimbing = false;
    this.climbRate = 0;
    this.climbLockout = CLIMB_LOCKOUT;
    this.jumpBuffer = 0;
    this.coyote = 0;
    if (kick > 0) {
      this.velocity.x = -this.climbDirX * kick;
      this.velocity.z = -this.climbDirZ * kick;
    }
  }

  /**
   * The face is the constraint, not gravity. The wish resolves against it: INTO the
   * rock drives him up, ALONG it shuffles sideways, and the standoff is kept.
   */
  private updateClimb(dt: number): void {
    const world = this.world;
    // Through `climbTop`: a face on a carrier is invisible to the world query, and
    // the branch below would read that as the hold being lost.
    const top = this.climbTop(
      this.position.x + this.climbDirX * CLIMB_REACH,
      this.position.z + this.climbDirZ * CLIMB_REACH,
    );
    const rise = top - this.position.y;

    // The face stopped existing (a chunk unloaded). Fall; do not snap anywhere.
    if (rise < -CLIMB_LOST) {
      this.detachClimb(0);
      return;
    }

    // At the lip. The ledge is checked against everything that HOLDS WEIGHT, terrain
    // or a crown — `getHeight` alone refused every treetop — and the level-with-what-
    // we-climbed test still stops a mantle onto a bare bole from flinging him up.
    let atTop = false;
    if (rise <= CLIMB_TOP_EPS) {
      const nx = this.position.x + this.climbDirX * MANTLE_PUSH;
      const nz = this.position.z + this.climbDirZ * MANTLE_PUSH;
      const dg = world.getHeight(nx, nz);
      const dc = this.canopyTop(nx, nz, dg);
      const dest = dc > -Infinity ? dc : dg;
      if (Math.abs(dest - top) <= MAX_STEP_UP) {
        this.position.x = nx;
        this.position.z = nz;
        this.position.y = dest;
        this.velocity.set(0, 0, 0);
        this.isClimbing = false;
        this.climbRate = 0;
        this.onGround = true;
        // The flag, not the position, tells the step test whether leaves count.
        this.onCanopy = dc > -Infinity;
        this.coyote = COYOTE_TIME;
        return;
      }
      atTop = true;
    }

    const moving = _wish.lengthSq() > 1e-6;
    const into = moving ? _wish.x * this.climbDirX + _wish.z * this.climbDirZ : 0;
    // face tangent: the climb direction rotated a quarter turn about +y
    const tanX = -this.climbDirZ;
    const tanZ = this.climbDirX;
    const along = moving ? _wish.x * tanX + _wish.z * tanZ : 0;

    let vy = into * CLIMB_SPEED;
    if (atTop && vy > 0) {
      vy = 0;
    }
    const k = 1 - Math.exp(-CLIMB_LAMBDA * dt);
    this.velocity.y += (vy - this.velocity.y) * k;
    this.velocity.x += (tanX * along * CLIMB_SIDE_SPEED - this.velocity.x) * k;
    this.velocity.z += (tanZ * along * CLIMB_SIDE_SPEED - this.velocity.z) * k;
    this.climbRate = clamp(this.velocity.y / CLIMB_SPEED, -1, 1);

    this.position.y += this.velocity.y * dt;
    if (atTop && this.position.y > top) {
      this.position.y = top;
    }

    // Probed from the DESTINATION, so shuffling off a ledge stops at the corner.
    const nx = this.position.x + this.velocity.x * dt;
    const nz = this.position.z + this.velocity.z * dt;
    if (
      this.climbTop(nx + this.climbDirX * CLIMB_REACH, nz + this.climbDirZ * CLIMB_REACH) >=
      this.position.y + CLIMB_SIDE_HOLD
    ) {
      this.position.x = nx;
      this.position.z = nz;
    } else {
      this.velocity.x = 0;
      this.velocity.z = 0;
    }

    const gh = world.getHeight(this.position.x, this.position.z);
    if (this.position.y <= gh) {
      this.position.y = gh;
      this.velocity.y = 0;
      this.onGround = true;
      // Lockout, or climbing to the bottom of a cliff re-grabs the same face.
      this.detachClimb(0);
      return;
    }
    if (gh < world.waterLevel - 0.7 && this.position.y < world.waterLevel - 1.0) {
      this.isSwimming = true; // hand over to the swim path next slice
      this.detachClimb(0);
    }
  }

  private updateAttack(dt: number): void {
    const input = this.input;
    const a = this.attack;
    // The bow's attack is not a swing: own duration, own strike frame, no chain.
    const bow = this.rig.weapon === "bow";

    if (a.active) {
      a.t += dt;
      // Strike frame: fire the hit callback exactly once per swing.
      if (!this.struck && a.t >= a.dur * (bow ? BOW_RELEASE : STRIKE_AT)) {
        this.struck = true;
        // Mounted, the swing comes from the RIDER and goes where he looks — his own
        // forward would land in the animal's back — and MOUNTED_REACH clears its bulk.
        // A SHOT goes where the crosshair looks, up and down included (issue #118);
        // `this.forward` is FLAT by construction and would discard the elevation.
        // Melee keeps the flat heading: an arc is tested in the plane with `inRise`.
        const mounted = this.isMounted;
        // getWorldDirection writes into the temp, so this allocates nothing.
        if (mounted || bow) {
          this.engine.camera.getWorldDirection(_dir);
        } else {
          _dir.copy(this.forward);
        }
        _origin.copy(this.position);
        _origin.y += mounted ? MOUNTED_STRIKE_Y : 1.25;
        // The bow alone re-aims from the MUZZLE; everything else homes or is an arc.
        if (bow) {
          this.engine.camera.getWorldPosition(_aimPt);
          let hit = BOW_AIM_FAR;
          // Only a DOWN ray meets the heightfield in reach; level, it finds a far hill.
          if (_dir.y < -0.02) {
            for (let d = BOW_AIM_NEAR; d <= BOW_AIM_FAR; d += BOW_AIM_STEP) {
              const x = _aimPt.x + _dir.x * d;
              const z = _aimPt.z + _dir.z * d;
              if (_aimPt.y + _dir.y * d <= this.world.getHeight(x, z)) {
                hit = d;
                break;
              }
            }
          }
          _aimPt.addScaledVector(_dir, hit).sub(_origin);
          if (_aimPt.lengthSq() > 1e-6) {
            _dir.copy(_aimPt).normalize();
          }
        }
        // Assist BEFORE the origin is pushed out: the push is along the swing.
        const steered = this.aimAssist?.(_origin, _dir) ?? false;
        _origin.addScaledVector(_dir, mounted ? MOUNTED_REACH : 0.35);
        // Square up, or the arc cuts an assist cone away from his shoulders. A snap,
        // not a damp: on the strike frame it reads as a lunge. On foot only.
        if (steered && !mounted) {
          this.heading = Math.atan2(_dir.x, _dir.z);
          this.root.rotation.y = this.heading;
          this.forward.set(Math.sin(this.heading), 0, Math.cos(this.heading));
        }
        this.onAttack?.(_origin, _dir);
      }
      // A tap queues the next hit. The bow has no chain, so it gets no burst.
      if (!bow && input.attackPressed && a.t > a.dur * 0.35 && a.combo < 2) {
        this.attackQueued = true;
      }
      if (a.t >= a.dur) {
        if (!bow && this.attackQueued && a.combo < 2) {
          a.combo += 1;
          a.dur = COMBO_DURS[a.combo];
          a.t = 0;
          this.attackQueued = false;
          this.struck = false;
        } else {
          a.active = false;
          this.attackCooldown = bow ? BOW_COOLDOWN : COMBO_COOLDOWN;
        }
      }
    } else if (
      // Mounted is NOT excluded; swimming and climbing are — both occupy the hands.
      input.attackPressed &&
      this.attackCooldown <= 0 &&
      !this.isSwimming &&
      !this.isClimbing
    ) {
      a.active = true;
      a.combo = 0;
      a.dur = bow ? BOW_DUR : COMBO_DURS[0];
      a.t = 0;
      this.attackQueued = false;
      this.struck = false;
    }
  }
}
