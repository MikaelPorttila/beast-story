import * as THREE from "three";
import type { Input } from "../core/input";
import {
  MOUNT_KIND_KEYS,
  MOUNT_KIND_OF,
  MOUNT_KINDS,
  type CarrierInfo,
  type EventBus,
  type Locomotion,
  type MountKind,
  type World,
} from "../core/types";
import { CarrierRide } from "../world/carriers";
import { t } from "../i18n";
import type { BeastActor, BeastRideState } from "../beasts/framework";
import type { Player } from "./index";

// Runs on a FIXED 60 Hz slice that may tick several times per rendered frame, so
// nothing here reads an input edge from the input layer: edges are latched off
// held state (see `fWasHeld`), as Player does for the jump.

const MOUNT_HOLD = 0.8;
/** Drain per second on early release; faster than the fill, so mashing F gains nothing. */
const RELEASE_DRAIN = 6.0;

/**
 * Multipliers on the beast's follow speed. Not `stats.speed`, which also drives
 * follow and combat. GALLOP stays under FLY_CRUISE (issue #107).
 */
const GALLOP = 2.25;
const FLY_CRUISE = 1.55;
/** A water mount has to beat walking AROUND a bay, hence the biggest number here. */
const SWIM_GALLOP = 3.2;
/** On land, for a swim-only beast. Matches BeastActor's `mediumMult`. */
const LAND_FLOP = 0.55;
const DEEP_TOAST_GAP = 6;

const ACCEL_LAMBDA = 5.5;
/** Heading damping. Slower than the hero's TURN_RATE 14 — a mount has mass. */
const TURN_LAMBDA = 7;
const GRAVITY = 24;
/** Hero's is 8.8. Clears the 2-unit face he cannot; past ~12 it clears 3-unit faces. */
const MOUNT_JUMP_VEL = 10.8;

/** Terrain steps in whole units, so 1.1 takes one terrace and is stopped by two. */
const MOUNT_STEP_UP = 1.1;
/** Unbounded, a step-off is true of every column below and teleports (issue #125). */
const MOUNT_STEP_DOWN = 1.1;

/**
 * Asked by BOTH getting on and getting off: the support under the destination is a
 * BOUND on the altitude a body has, never a destination (issue #125, issue #91).
 * Says nothing about walls — the step UP is the caller's.
 */
function transferY(y: number, support: number, stepDown: number): number {
  return support >= y - stepDown ? support : y;
}
/** Extra half-width on the collision probe beyond the mount's body radius. */
const BODY_MARGIN = 0.15;
/** Float line below `world.waterLevel`: a wader is held here, a swimmer ceilinged by it. */
const WADE_DEPTH = 0.45;

/** Flyer vertical rates, world units/s. */
const FLY_CLIMB = 7.0;
const FLY_DIVE = 8.5;
const FLY_VY_LAMBDA = 6;

/**
 * Diving a water mount (issue #103). SWIM_RISE_MAX caps the buoyancy spring, or a
 * rise from a deep bed surfaces like a cork rather than an animal.
 */
const SWIM_CLIMB = 4.5;
const SWIM_DIVE = 5.0;
const SWIM_BUOYANCY = 6;
const SWIM_RISE_MAX = SWIM_CLIMB;
/** Clearance a flyer keeps over terrain or water; it sits above a surface, never on it. */
const FLY_CLEARANCE = 1.3;
/** Step is under the cell size (1.2) so the march cannot stride over a pocket. */
const SHOVE_STEP = 0.25;
const SHOVE_STEPS = 8;
/** Above the ground under you. Raised from 60 (issue #68): the island cruises at 78-104. */
const FLY_CEILING = 78;

/** His origin is at his FEET, so it sits a hip below BeastActor.saddleY. */
const HERO_HIP_Y = 0.6;
/** Rider seat behind centre, as a fraction of body radius; keeps the head visible. */
const SEAT_BACK = 0.55;

/** Mounted framing; see ThirdPersonCamera.setFraming. The drop aims at the saddle. */
const MOUNT_CAM_SCALE = 1.35;
const MOUNT_CAM_DROP = 0.6;

const _wish = new THREE.Vector3();

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) {
    d -= Math.PI * 2;
  } else if (d < -Math.PI) {
    d += Math.PI * 2;
  }
  return d;
}

function dampAngle(cur: number, target: number, lambda: number, dt: number): number {
  return cur + angleDelta(cur, target) * (1 - Math.exp(-lambda * dt));
}

export type MountRefusal = "swimming" | "climbing" | "dead" | "beastDead" | "locked" | "none";

/**
 * Which mounts the story has handed over — session state, empty on a new game.
 * Three unlocks, one per act (game-story.md §5); nothing in shipped content
 * grants them yet, so the doors are F3, `/mount unlock` and `mounts=`.
 * A Set, not three booleans, so `list()`/`restore()` are what a save round-trips.
 */
export class MountUnlocks {
  private readonly have = new Set<MountKind>();

  has(kind: MountKind): boolean {
    return this.have.has(kind);
  }

  allows(loco: Locomotion): boolean {
    return this.have.has(MOUNT_KIND_OF[loco]);
  }

  set(kind: MountKind, on: boolean): void {
    if (on) {
      this.have.add(kind);
    } else {
      this.have.delete(kind);
    }
  }

  /** In `MOUNT_KINDS` order, so a save round-trips to the same document. */
  list(): MountKind[] {
    return MOUNT_KINDS.filter((k) => this.have.has(k));
  }

  /** Take what a save (or URL flag) says, keeping only kinds this build has. */
  restore(kinds: readonly string[]): void {
    this.have.clear();
    for (const k of kinds) {
      if ((MOUNT_KINDS as readonly string[]).includes(k)) {
        this.have.add(k as MountKind);
      }
    }
  }

  reset(): void {
    this.have.clear();
  }
}

export class MountController {
  beast: BeastActor | null = null;
  /** 0..1 hold progress, for the HUD ring. */
  hold = 0;

  private flying = false;
  /** Locomotion 'swimming' or 'amphibious'; cached so two rules cannot disagree. */
  private swimmer = false;
  /** True while the mount can only swim — no gallop, see LAND_FLOP. */
  private waterOnly = false;
  private pos = new THREE.Vector3();
  /** Where the ANIMAL is, not the rider. Every clamp here applies to this. */
  get bodyY(): number {
    return this.pos.y;
  }
  private vel = new THREE.Vector3();
  private vy = 0;
  private grounded = true;
  private jumpPressed = false;
  private jumpWasHeld = false;
  private yaw = 0;
  private pitch = 0;
  private bank = 0;
  private speed01 = 0;
  private topSpeed = 1;
  /** F held on the previous slice, so a press edge can be derived from it. */
  private fWasHeld = false;
  /** Same throttle and gap as the hero's own (Player). */
  private deepToastT = 0;
  /** One refusal toast per hold attempt, not one per slice. */
  private refusedFor: MountRefusal = "none";
  /** Reused every slice; the beast copies out of it and keeps nothing. */
  private ride: BeastRideState = {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    bank: 0,
    vx: 0,
    vz: 0,
    speed01: 0,
    action: "idle",
  };

  constructor(
    private player: Player,
    private world: World,
    private input: Input,
    private bus: EventBus,
    private unlocks: MountUnlocks,
  ) {}

  /** Rebind to another zone's ground (world/zones.ts). The caller dismounts first. */
  setWorld(world: World): void {
    this.world = world;
    // A carrier id from the zone being left means nothing in the new one.
    this.carrier.clear();
  }

  /** The moving frame under the mount's feet, if any. See world/carriers.ts. */
  private readonly carrier = new CarrierRide();

  get isMounted(): boolean {
    return this.beast !== null;
  }
  /** A water beast over a flooded column; the one question the dive rules turn on. */
  get isSwimming(): boolean {
    return this.beast !== null && this.swimmer && this.afloat(this.pos.x, this.pos.z);
  }
  /** Below the float line, not `waterLevel`, so bobbing at the surface reads 0. */
  get diveDepth(): number {
    if (!this.isSwimming) {
      return 0;
    }
    return Math.max(0, this.world.waterLevel - WADE_DEPTH - this.pos.y);
  }
  get progress(): number {
    return clamp(this.hold / MOUNT_HOLD, 0, 1);
  }
  get speed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  /**
   * Swimming and climbing REFUSE rather than interrupt — the hero owns his position
   * against the world there. `locked` is LAST: only once nothing fixable applies.
   */
  refusal(candidate: BeastActor | null): MountRefusal {
    if (this.player.isDead) {
      return "dead";
    }
    if (this.player.isSwimming) {
      return "swimming";
    }
    if (this.player.isClimbing) {
      return "climbing";
    }
    if (!candidate || candidate.isDead) {
      return "beastDead";
    }
    if (!this.unlocks.allows(candidate.species.locomotion)) {
      return "locked";
    }
    return "none";
  }

  /** The saddle's half of `Player.carry`, for a modal-frozen controller. */
  carryFrozen(dt: number): void {
    if (!this.beast) {
      return;
    }
    this.carryFrame();
    // ONLY on the frozen path: `updateRide` poses it on every ordinary slice, and
    // posing twice runs the animation clock at double rate.
    this.poseBeast(dt);
  }

  /**
   * `__dbgTp`'s half of the saddle: `seatHero` overwrites `player.position` every
   * slice, which made a mounted teleport a silent no-op. The carrier frame is
   * RE-TAKEN, or the old deck's delta applies to the new position next slice.
   */
  teleport(x: number, z: number, y?: number): void {
    if (!this.beast) {
      return;
    }
    this.pos.set(x, 0, z);
    this.carrier.clear();
    this.carrier.carry(this.world, this.pos);
    this.pos.y =
      y ??
      (this.flying
        ? this.floorFor(x, z)
        : Math.max(this.blockTop(x, z), this.world.waterLevel - WADE_DEPTH));
    this.vel.set(0, 0, 0);
    this.vy = 0;
    this.grounded = !this.flying;
    this.poseBeast(0);
  }

  private carryFrame(): void {
    this.carrier.carry(this.world, this.pos);
    this.yaw += this.carrier.dyaw;
  }

  /** One press, one jump. */
  private consumeJump(): boolean {
    if (!this.jumpPressed) {
      return false;
    }
    this.jumpPressed = false;
    return true;
  }

  /** One simulation slice. `candidate` is the beast F would mount; may be null. */
  update(dt: number, candidate: BeastActor | null): void {
    const input = this.input;
    // `pressed` is OR-ed in because a tap shorter than one 16.7 ms slice never
    // shows up in held state; the latch stops a two-slice frame spending it twice.
    const fHeld = input.down("KeyF") || input.pressed("KeyF");
    const fEdge = fHeld && !this.fWasHeld;
    this.fWasHeld = fHeld;

    // Space, latched the same way. Consumed in updateGround(); a flyer and a
    // swimming water beast read Space as a held RATE and ignore this latch.
    const jumpHeld = input.down("Space") || input.pressed("Space");
    this.jumpPressed = jumpHeld && !this.jumpWasHeld;
    this.jumpWasHeld = jumpHeld;
    if (this.deepToastT > 0) {
      this.deepToastT -= dt;
    }

    if (this.beast) {
      // The ground moves FIRST, before the reins are read. The rider needs no
      // carry of his own: `seatHero` places him off `this.pos`, and
      // `Player.update` skips its own frame while mounted.
      this.carryFrame();
      // A tap of F gets off; the mounting F cannot produce an edge (fWasHeld).
      if (fEdge) {
        this.dismount();
        return;
      }
      if (this.beast.isDead || this.player.isDead) {
        this.dismount(
          this.beast.isDead
            ? t("toast.mount.beastDown", { beast: t(this.beast.species.nameKey) })
            : undefined,
        );
        return;
      }
      this.updateRide(dt);
      return;
    }

    if (!fHeld) {
      this.hold = Math.max(0, this.hold - RELEASE_DRAIN * MOUNT_HOLD * dt);
      this.refusedFor = "none";
      return;
    }

    const why = this.refusal(candidate);
    if (why !== "none") {
      this.hold = 0;
      if (this.refusedFor !== why) {
        this.refusedFor = why;
        this.bus.emit({ type: "toast", text: refusalText(why, candidate) });
      }
      return;
    }
    this.refusedFor = "none";
    this.hold += dt;
    if (this.hold >= MOUNT_HOLD) {
      this.mount(candidate!);
    }
  }

  /** Climb on. The ride starts at the HERO's column, so the beast comes to you. */
  mount(beast: BeastActor): void {
    if (this.beast) {
      return;
    }
    this.beast = beast;
    this.hold = 0;
    const loco = beast.species.locomotion;
    this.flying = loco === "flying";
    this.swimmer = loco === "swimming" || loco === "amphibious";
    this.waterOnly = loco === "swimming";

    const p = this.player.position;
    this.topSpeed = this.gaitSpeed(p.x, p.z);
    // TAKE THE FRAME BEFORE ASKING WHAT THE GROUND IS: `blockTop`/`floorFor` consult
    // the ride, and unattached a mount-up on a deck reads the terrain far below.
    this.pos.set(p.x, p.y, p.z);
    this.carrier.clear();
    this.carrier.carry(this.world, this.pos);
    // The floor under his column is a lower BOUND, not a destination (issue #125).
    // A flyer's adds flight clearance, a walker's is the deepest wade.
    const support = this.flying
      ? this.floorFor(p.x, p.z)
      : Math.max(this.blockTop(p.x, p.z), this.world.waterLevel - WADE_DEPTH);
    this.pos.y = transferY(p.y, support, 0);
    this.vel.set(0, 0, 0);
    this.vy = 0;
    // `!this.flying` alone told a walker mounted in mid-air it was grounded —
    // a landed pose and a jump it has not earned.
    this.grounded = !this.flying && this.pos.y <= support;
    this.yaw = Math.atan2(this.player.forward.x, this.player.forward.z);
    this.pitch = 0;
    this.bank = 0;
    this.speed01 = 0;

    beast.setRidden(true);
    this.player.setMounted(true);
    this.player.setCameraFraming(MOUNT_CAM_SCALE, MOUNT_CAM_DROP);
    this.seatHero();
    this.bus.emit({ type: "mounted", beastId: beast.species.id, flying: this.flying });
    this.bus.emit({
      type: "toast",
      text: t(this.flying ? "toast.mount.flying" : "toast.mount.ground", {
        beast: t(beast.species.nameKey),
      }),
    });
  }

  /** On the ground he steps down beside the mount; in the air he keeps its momentum. */
  dismount(reason?: string): void {
    const beast = this.beast;
    if (!beast) {
      return;
    }
    this.beast = null;
    this.hold = 0;
    beast.setRidden(false);
    this.player.setMounted(false);
    this.player.setCameraFraming(1, 0);

    // Step off to the camera's right. DOWN is `transferY`; UP is this file's step
    // ceiling, because a wall is refused sideways too. Out of reach, he falls.
    const side = this.player.camRight;
    const r = beast.scaledRadius + 0.7;
    const x = this.pos.x + side.x * r;
    const z = this.pos.z + side.z * r;
    // `blockTop`, not terrain: else the rider lands inside the crate he dismounts
    // beside, and a hut wall reads as empty ground.
    const gh = this.blockTop(x, z);
    const p = this.player.position;
    const step = transferY(this.pos.y, gh, MOUNT_STEP_DOWN);
    if (!this.flying && gh <= this.pos.y + MOUNT_STEP_UP && step === gh) {
      p.set(x, step, z);
      this.player.onGround = true;
    } else {
      p.set(this.pos.x, this.pos.y + (this.flying ? 0.2 : 0), this.pos.z);
      this.player.onGround = false;
    }
    this.player.velocity.set(this.vel.x, this.flying ? 0 : this.vy, this.vel.z);
    this.bus.emit({ type: "dismounted", beastId: beast.species.id });
    this.bus.emit({
      type: "toast",
      text: reason ?? t("toast.dismounted", { beast: t(beast.species.nameKey) }),
    });
  }

  /** Lowest a flyer may be: surface plus clearance, or a deck when riding one. */
  private floorFor(x: number, z: number): number {
    const deck = this.carrier.support(x, z);
    const ground = Math.max(this.world.getHeight(x, z), this.world.waterLevel);
    return Math.max(ground, deck) + FLY_CLEARANCE;
  }

  /** The same queries the hero asks on foot (Player.blockTop); must not disagree. */
  private blockTop(x: number, z: number): number {
    const ground = this.world.getHeight(x, z);
    const trunk = this.world.trunkSolidTopAt(x, z);
    let top = trunk > ground ? trunk : ground;
    const built = this.world.structureTopAt(x, z);
    if (built > top) {
      top = built;
    }
    // ...and the carrier deck. -Infinity unless attached, which is what makes it
    // safe to ask with (x, z) alone — see `CarrierRide.support`.
    const deck = this.carrier.support(x, z);
    if (deck > top) {
      top = deck;
    }
    return top;
  }

  /** The quarter-unit margin matches BeastActor, so a puddle pays no swim boost. */
  private afloat(x: number, z: number): boolean {
    return this.world.isWater(x, z) && this.world.getHeight(x, z) < this.world.waterLevel - 0.25;
  }

  /** Top speed for the column the mount is over. See SWIM_GALLOP and LAND_FLOP. */
  private gaitSpeed(x: number, z: number): number {
    const base = this.beast!.stats.speed;
    if (this.flying) {
      return base * FLY_CRUISE;
    }
    if (this.swimmer && this.afloat(x, z)) {
      return base * SWIM_GALLOP;
    }
    return base * GALLOP * (this.waterOnly ? LAND_FLOP : 1);
  }

  /** Deep-sea rule, per axis as the hero's is, so a blocked diagonal slides. */
  private deepRefused(x: number, z: number): boolean {
    return !this.swimmer && this.world.isDeepWater(x, z);
  }

  /** Throttled to DEEP_TOAST_GAP; names the animal, unlike the hero's own line. */
  private refuseDeep(): void {
    if (this.deepToastT > 0 || !this.beast) {
      return;
    }
    this.deepToastT = DEEP_TOAST_GAP;
    this.bus.emit({
      type: "toast",
      text: t("toast.mount.refuse.deepGround", { beast: t(this.beast.species.nameKey) }),
    });
  }

  private updateRide(dt: number): void {
    const input = this.input;
    // Re-read EVERY SLICE: the speed changes when the ground turns to water.
    this.topSpeed = this.gaitSpeed(this.pos.x, this.pos.z);

    // Steering is camera-relative, exactly as on foot.
    const fwd = input.axisFwd;
    const side = input.axisSide;
    _wish
      .set(0, 0, 0)
      .addScaledVector(this.player.camForward, fwd)
      .addScaledVector(this.player.camRight, side);
    const tilt = Math.min(1, Math.hypot(fwd, side));
    const moving = _wish.lengthSq() > 1e-6;
    if (moving) {
      _wish.normalize();
    }

    // A half-deflected stick still walks.
    let target = this.topSpeed;
    if (tilt > 0 && tilt < 0.98) {
      target *= Math.max(0.35, tilt);
    }

    const k = 1 - Math.exp(-ACCEL_LAMBDA * dt);
    this.vel.x += ((moving ? _wish.x * target : 0) - this.vel.x) * k;
    this.vel.z += ((moving ? _wish.z * target : 0) - this.vel.z) * k;

    if (this.flying) {
      this.integrateFlying(dt);
    } else {
      this.integrateGround(dt);
    }

    const speed = Math.hypot(this.vel.x, this.vel.z);
    const prevYaw = this.yaw;
    if (speed > 0.35) {
      this.yaw = dampAngle(this.yaw, Math.atan2(this.vel.x, this.vel.z), TURN_LAMBDA, dt);
    }
    const turnVel = dt > 0 ? angleDelta(prevYaw, this.yaw) / dt : 0;
    const targetBank = this.flying ? clamp(-turnVel * 0.3, -0.5, 0.5) : 0;
    this.bank += (targetBank - this.bank) * (1 - Math.exp(-5 * dt));
    this.speed01 = Math.min(1, speed / Math.max(0.001, this.topSpeed));

    this.poseBeast(dt);
  }

  /**
   * The beast's rig only learns `this.pos` here, so every path that moves it must
   * call this. `seatHero` last: it reads `this.pos`.
   */
  private poseBeast(dt: number): void {
    const beast = this.beast;
    if (!beast) {
      return;
    }
    const s = this.ride;
    s.x = this.pos.x;
    s.y = this.pos.y;
    s.z = this.pos.z;
    s.yaw = this.yaw;
    s.pitch = this.pitch;
    s.bank = this.bank;
    s.vx = this.vel.x;
    s.vz = this.vel.z;
    s.speed01 = this.speed01;
    // 'swim' at any speed, including standing still — 'idle' would stand a
    // floating beast up on the water.
    s.action = this.flying
      ? "fly"
      : this.isSwimming
        ? "swim"
        : this.speed01 > 0.5
          ? "run"
          : this.speed01 > 0.06
            ? "walk"
            : "idle";
    beast.rideUpdate(dt, s);
    this.seatHero();
  }

  private integrateGround(dt: number): void {
    const world = this.world;
    // Horizontal first, axis by axis so a blocked diagonal slides along the face.
    const feetY = this.pos.y;
    // A swimmer is exempt from the step test, as the hero is: dived, its feet are
    // under the shallows and every slope would be a wall. The floor clamp bounds it.
    const stepCeil = this.isSwimming ? Infinity : feetY + MOUNT_STEP_UP;
    const radius = this.beast!.scaledRadius + BODY_MARGIN;

    const nx = this.pos.x + this.vel.x * dt;
    const px = nx + Math.sign(this.vel.x) * radius;
    if (this.blockTop(px, this.pos.z) <= stepCeil && !this.deepRefused(px, this.pos.z)) {
      this.pos.x = nx;
    } else {
      this.vel.x = 0;
      if (this.deepRefused(px, this.pos.z)) {
        this.refuseDeep();
      }
    }

    const nz = this.pos.z + this.vel.z * dt;
    const pz = nz + Math.sign(this.vel.z) * radius;
    if (this.blockTop(this.pos.x, pz) <= stepCeil && !this.deepRefused(this.pos.x, pz)) {
      this.pos.z = nz;
    } else {
      this.vel.z = 0;
      if (this.deepRefused(this.pos.x, pz)) {
        this.refuseDeep();
      }
    }

    // Asked AFTER the horizontal step, so a mount that swims onto a beach falls
    // on the same slice it stops being afloat.
    if (this.isSwimming) {
      this.integrateSwim(dt);
      return;
    }

    // An EDGE, so holding Space does not pogo; gated on `grounded`, so no double jump.
    if (this.grounded && this.consumeJump()) {
      this.vy = MOUNT_JUMP_VEL;
      this.grounded = false;
    }
    this.vy -= GRAVITY * dt;
    this.pos.y += this.vy * dt;

    // WHAT HOLDS A MOUNT UP IS WHAT STOPPED IT GETTING HERE: `blockTop`, matching the
    // horizontal test above (issue #32). A non-swimmer wades, never below WADE_DEPTH.
    const gh = Math.max(this.blockTop(this.pos.x, this.pos.z), world.waterLevel - WADE_DEPTH);
    if (this.pos.y <= gh) {
      this.pos.y = gh;
      this.vy = 0;
      this.grounded = true;
    } else if (this.grounded && this.vy <= 0 && this.pos.y - gh < 0.5) {
      this.pos.y = gh; // stay glued running down slopes
      this.vy = 0;
    } else {
      this.grounded = false;
    }
    this.pitch += (0 - this.pitch) * (1 - Math.exp(-8 * dt));
  }

  /**
   * The vertical half of `integrateGround` for a water beast. The surface is a
   * CEILING and the bed a FLOOR; both clamps ask `blockTop` (issue #32).
   */
  private integrateSwim(dt: number): void {
    // SPEND the pending Space edge: left latched, it fires as a jump on whatever
    // slice the mount reaches the shore.
    this.consumeJump();

    const floatY = this.world.waterLevel - WADE_DEPTH;
    const up = this.input.down("Space") ? 1 : 0;
    const down = this.input.down("KeyC") ? 1 : 0;
    // A commanded RATE like the flyer's climb, not an acceleration against
    // buoyancy the way the hero's dive is: the animal swims down.
    const want =
      up || down
        ? up * SWIM_CLIMB - down * SWIM_DIVE
        : // Nothing held: float back up, capped — see SWIM_RISE_MAX.
          Math.min((floatY - this.pos.y) * SWIM_BUOYANCY, SWIM_RISE_MAX);
    this.vy += (want - this.vy) * (1 - Math.exp(-FLY_VY_LAMBDA * dt));
    this.pos.y += this.vy * dt;

    // CEILING FIRST, FLOOR LAST: in barely swimmable water the bed stands above
    // the float line, and the other order pushes the mount into the ground.
    if (this.pos.y > floatY) {
      this.pos.y = floatY;
      if (this.vy > 0) {
        this.vy = 0;
      }
    }
    const bed = this.blockTop(this.pos.x, this.pos.z);
    if (this.pos.y <= bed) {
      this.pos.y = bed;
      if (this.vy < 0) {
        this.vy = 0;
      }
      this.grounded = true;
    } else {
      this.grounded = false;
    }
    // The flyer's tilt, at the flyer's gain.
    this.pitch += (clamp(-this.vy * 0.055, -0.35, 0.35) - this.pitch) * (1 - Math.exp(-5 * dt));
  }

  /**
   * Is a body INSIDE a carrier's mass? `deckAt` and NOT `topAt`, which includes
   * what stands on the deck — a flyer beside a cottage is not inside the island.
   */
  private inMass(x: number, z: number, y: number): boolean {
    const body = this.world.carriers.bodyAt(x, z);
    if (!body) {
      return false;
    }
    return y > body.bottomAt(x, z) && y < body.deckAt(x, z);
  }

  /**
   * Push out through the flank — outward from the frame's centre, never up. A march,
   * not a solve: the outline has four harmonics, the keel terraces (world/sky-island.ts).
   */
  private shoveOut(body: CarrierInfo): void {
    let ux = this.pos.x - body.x;
    let uz = this.pos.z - body.z;
    const d = Math.hypot(ux, uz);
    // Dead centre: any bearing will do, and picking one beats dividing by zero.
    if (d < 1e-3) {
      ux = 0;
      uz = 1;
    } else {
      ux /= d;
      uz /= d;
    }
    for (let i = 0; i < SHOVE_STEPS; i++) {
      this.pos.x += ux * SHOVE_STEP;
      this.pos.z += uz * SHOVE_STEP;
      if (!this.inMass(this.pos.x, this.pos.z, this.pos.y)) {
        return;
      }
    }
  }

  private integrateFlying(dt: number): void {
    // PER AXIS: a flyer sliding along the island's cliff keeps the speed that is
    // along it. A combined test stops him dead against a wall he is passing.
    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.z + this.vel.z * dt;
    if (!this.inMass(nx, this.pos.z, this.pos.y)) {
      this.pos.x = nx;
    }
    if (!this.inMass(this.pos.x, nz, this.pos.y)) {
      this.pos.z = nz;
    }

    const up = this.input.down("Space") ? 1 : 0;
    const down = this.input.down("KeyC") ? 1 : 0;
    const wantVy = up * FLY_CLIMB - down * FLY_DIVE;
    this.vy += (wantVy - this.vy) * (1 - Math.exp(-FLY_VY_LAMBDA * dt));
    this.pos.y += this.vy * dt;

    const floor = this.floorFor(this.pos.x, this.pos.z);
    if (this.pos.y < floor) {
      this.pos.y = floor;
      if (this.vy < 0) {
        this.vy = 0;
      }
    }
    // The ceiling is clearance over the ground under you, and a carrier's deck is
    // ground — else the ceiling forbids the only approach to the island.
    // `ceilingAt`, not `ride.support`: the mount is not attached yet.
    const overhead = this.world.carriers.ceilingAt(this.pos.x, this.pos.z);
    const ceil =
      Math.max(this.world.getHeight(this.pos.x, this.pos.z), this.world.waterLevel, overhead) +
      FLY_CEILING;
    if (this.pos.y > ceil) {
      this.pos.y = ceil;
      if (this.vy > 0) {
        this.vy = 0;
      }
    }
    // `ride.support` is gated on being attached, so a flyer at the keel used to pass
    // through the rock (issue #80). The keel is a ceiling; the deck is `floorFor`'s
    // job. Never push UP. Asked LAST, so it wins over the ceiling above.
    const body = this.world.carriers.bodyAt(this.pos.x, this.pos.z);
    if (body) {
      const keel = body.bottomAt(this.pos.x, this.pos.z);
      if (this.pos.y < keel && this.pos.y > keel - FLY_CLEARANCE) {
        // The way up is round the rim, not through the middle.
        this.pos.y = keel - FLY_CLEARANCE;
        if (this.vy > 0) {
          this.vy = 0;
        }
      } else if (this.pos.y >= keel && this.pos.y <= body.deckAt(this.pos.x, this.pos.z)) {
        // In the mass, unreachable by flying — so the island flew into HIM.
        this.shoveOut(body);
      }
    }
    this.grounded = false;
    this.pitch += (clamp(-this.vy * 0.055, -0.35, 0.35) - this.pitch) * (1 - Math.exp(-5 * dt));
  }

  private seatHero(): void {
    const beast = this.beast!;
    const back = beast.scaledRadius * SEAT_BACK;
    this.player.position.set(
      this.pos.x - Math.sin(this.yaw) * back,
      this.pos.y + beast.saddleY - HERO_HIP_Y,
      this.pos.z - Math.cos(this.yaw) * back,
    );
    this.player.velocity.set(this.vel.x, this.flying ? this.vy : 0, this.vel.z);
    this.player.setRidePose(this.yaw, this.speed01, !this.flying && this.grounded);
  }
}

function refusalText(why: MountRefusal, candidate: BeastActor | null): string {
  switch (why) {
    case "swimming":
      return t("toast.mount.refuse.swimming");
    case "climbing":
      return t("toast.mount.refuse.climbing");
    case "beastDead":
      return candidate
        ? t("toast.mount.refuse.beastDead", { beast: t(candidate.species.nameKey) })
        : t("toast.mount.refuse.noBeast");
    // Named by KIND, not species: what is missing is the act, not this animal.
    case "locked":
      return candidate
        ? t("toast.mount.refuse.locked", {
            kind: t(MOUNT_KIND_KEYS[MOUNT_KIND_OF[candidate.species.locomotion]].name),
          })
        : t("toast.mount.refuse.other");
    default:
      return t("toast.mount.refuse.other");
  }
}
