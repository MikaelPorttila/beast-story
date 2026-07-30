import * as THREE from 'three';
import type { Input } from '../core/input';
import type { EventBus, World } from '../core/types';
import type { PalActor, PalRideState } from '../pals/framework';
import type { Player } from './index';

// ---------------------------------------------------------------------------
// Mounting — hold F, ride your pal
// ---------------------------------------------------------------------------
// The whole feature lives here: the hold-to-mount timer, the refusal rules, and
// the locomotion of a mounted pal (which is the hero's locomotion problem, not
// the pal framework's — a ridden pal is steered, not followed).
//
// Two things it deliberately does NOT own:
//   - the aim of a mounted cast. That is main.ts's business; this class only
//     answers "is a pal being ridden, and which one".
//   - anything about which pal is mountable. main.ts offers a candidate (the
//     primary) every slice and this class decides whether it can be climbed on.
//
// Everything below runs on a FIXED 60 Hz slice that may tick several times per
// rendered frame, so nothing here reads an input edge from the input layer: the
// F edge is latched off held state (see `fWasHeld`), exactly as Player does for
// the jump, and the hold timer accumulates dt on held state.

/**
 * Seconds of held F to climb into the saddle.
 *
 * 0.8 s, down from the 2.0 s this shipped with: two seconds was long enough to
 * be legible but it read as waiting for the game rather than as an action, and
 * mounting is something you do mid-stride. It is still far longer than any
 * accidental brush of F in a fight, which is the only thing the hold is
 * defending against.
 */
const MOUNT_HOLD = 0.8;
/**
 * How fast the fill drains when F is let go early, as a fraction of the bar per
 * second. Deliberately faster than it fills (1/MOUNT_HOLD = 1.25/s): a full bar
 * is gone in 0.16 s, so mashing F can never accumulate progress across taps —
 * the only way to mount is one continuous hold — while still reading as the bar
 * falling back rather than blinking out. Raised with MOUNT_HOLD to keep that
 * relationship; at the old 2.5 the drain was barely quicker than the fill.
 */
const RELEASE_DRAIN = 6.0;

/**
 * Ground mounts gallop: the pal's own follow speed times this.
 *
 * The speeds this multiplies are the species' (Sproutle 3.2 … Galebird 8.0)
 * against a hero who walks at 6 and sprints at 9.6, so the multiplier is what
 * decides whether a mount is worth having. 1.85 measured: Emberfox 9.6 (a
 * sprint you can hold forever), Boulderpup 7.8, Sproutle 5.9 — the slow tank
 * really is slower than running, which is the point of picking a mount at all.
 */
const GALLOP = 1.85;
/**
 * Flyers cruise a little more gently than the ground gallop, because they also
 * get a third axis and never have to go around anything: Galebird 12.4 u/s,
 * Frostwing 10.1, Lumimoth 8.1.
 */
const FLY_CRUISE = 1.55;

/** Horizontal acceleration lambda, in the house `1 - exp(-l*dt)` form. */
const ACCEL_LAMBDA = 5.5;
/** Heading damping. Slower than the hero's TURN_RATE 14 — a mount has mass. */
const TURN_LAMBDA = 7;
const GRAVITY = 24;
/**
 * Jump velocity for a GROUND mount, against the hero's own JUMP_VEL of 8.8.
 *
 * Same gravity, so apex scales as v^2/2g: 10.8 gives 2.43 units against his
 * 1.61 — half again as high, which is the point of being on an animal. It also
 * changes what the world is: a 2-unit face is the first thing the hero cannot
 * clear on foot (that gap is deliberate, see MAX_STEP_UP in player/index.ts),
 * and a mount clears it with room to spare. Anything past ~12 starts clearing
 * the 3-unit faces that climbing exists for, so the ceiling here is not comfort
 * but keeping climbing worth doing.
 */
const MOUNT_JUMP_VEL = 10.8;

/**
 * Highest ledge a ground mount walks onto, against the hero's MAX_STEP_UP 0.5.
 *
 * Terrain steps in whole units, so 1.1 means exactly one thing: a mount takes
 * the single terrace the hero has to jump, and is still stopped by the 2-unit
 * face that is the wall climbing exists for. That difference IS the ground
 * mount's traversal perk, and it is why the number is not simply the hero's.
 */
const MOUNT_STEP_UP = 1.1;
/**
 * Extra half-width on the collision probe beyond the mount's own body radius,
 * so it is stopped with its shoulder at the rock like the hero is (see
 * BODY_RADIUS in player/index.ts — this world has no horizontal collision
 * geometry beyond these probes).
 */
const BODY_MARGIN = 0.15;
/**
 * How deep a ground mount wades before it is simply held at the surface. There
 * is no swim gait for a mount, so deep water is crossed at a wade rather than
 * walked along the lake bed with the rider underwater.
 */
const WADE_DEPTH = 0.45;

/** Vertical rates for a flyer, world units/s. Descending is a little faster. */
const FLY_CLIMB = 7.0;
const FLY_DIVE = 8.5;
/** Vertical damping toward the commanded rate. */
const FLY_VY_LAMBDA = 6;
/**
 * Clearance a flyer keeps over terrain or water. 1.3 is the mount's own belly
 * height plus a little: the floor clamp below is what guarantees a flying mount
 * can never end up inside a hill it flew at, so it has to sit above the surface
 * rather than on it.
 */
const FLY_CLEARANCE = 1.3;
/** Ceiling above the ground under you. Enough to clear anything; not orbit. */
const FLY_CEILING = 60;

/**
 * The hero rig's hip height. His origin is at his FEET, but in the riding pose
 * nothing hangs below the hips (the legs swing forward over the mount's
 * shoulders), so the origin is placed a hip BELOW the pal's saddle and the seat
 * lands on the mount's back. Where that saddle is, is the pal's business —
 * PalActor.saddleY, measured off its own silhouette.
 */
const HERO_HIP_Y = 0.6;
/**
 * How far back from the mount's centre the rider sits, as a fraction of its
 * body radius. A quadruped is ridden over the shoulders-to-hips span, not on
 * its skull; sitting half a radius back leaves the mount's own head and neck
 * visible in FRONT of the rider from the follow camera, which is what makes the
 * pair read as rider-and-mount rather than as one stacked silhouette (captured
 * at 0.35, the hero hid the fox almost completely from directly behind).
 */
const SEAT_BACK = 0.55;

/**
 * Camera framing while mounted; see ThirdPersonCamera.setFraming. The arm grows
 * 35% because the subject is now two bodies, and the aim point drops 0.6 units
 * because the middle of that subject is the saddle rather than the rider's
 * chest — captured without the drop, the mount itself sat behind the hotbar.
 */
const MOUNT_CAM_SCALE = 1.35;
const MOUNT_CAM_DROP = 0.6;

const _wish = new THREE.Vector3();

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function dampAngle(cur: number, target: number, lambda: number, dt: number): number {
  return cur + angleDelta(cur, target) * (1 - Math.exp(-lambda * dt));
}

export type MountRefusal = 'swimming' | 'climbing' | 'dead' | 'palDead' | 'none';

export class MountController {
  /** The pal being ridden, or null. */
  pal: PalActor | null = null;
  /** 0..1 hold progress, for the HUD ring. */
  hold = 0;

  private flying = false;
  private pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private vy = 0;
  private grounded = true;
  /** Space edge for the ground-mount jump; see update()/jumpEdge(). */
  private jumpPressed = false;
  private jumpWasHeld = false;
  private yaw = 0;
  private pitch = 0;
  private bank = 0;
  private speed01 = 0;
  private topSpeed = 1;
  /** F held on the previous slice, so a press edge can be derived from it. */
  private fWasHeld = false;
  /** One refusal toast per hold attempt, not one per slice. */
  private refusedFor: MountRefusal = 'none';
  /** Reused every slice; the pal copies out of it and keeps nothing. */
  private ride: PalRideState = {
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0, bank: 0, vx: 0, vz: 0,
    speed01: 0, action: 'idle',
  };

  constructor(
    private player: Player,
    private world: World,
    private input: Input,
    private bus: EventBus,
  ) {}

  get isMounted(): boolean { return this.pal !== null; }
  /** 0..1 fill for the indicator. */
  get progress(): number { return clamp(this.hold / MOUNT_HOLD, 0, 1); }
  /** Horizontal speed of the mount, for probes and the HUD. */
  get speed(): number { return Math.hypot(this.vel.x, this.vel.z); }

  /**
   * Why the hero cannot climb on right now, or 'none'.
   *
   * Swimming and climbing both REFUSE rather than interrupt. They are the two
   * places where the hero controller owns his position against the world (a
   * float height, a held face), and a mount that took over mid-hold would
   * teleport him out of the water or off the rock. Surfacing or letting go is
   * one keypress away, which makes refusing the honest answer instead of a
   * special case in three controllers.
   */
  refusal(candidate: PalActor | null): MountRefusal {
    if (this.player.isDead) return 'dead';
    if (this.player.isSwimming) return 'swimming';
    if (this.player.isClimbing) return 'climbing';
    if (!candidate || candidate.isDead) return 'palDead';
    return 'none';
  }

  /** Take the pending Space edge, if any. One press, one jump. */
  private consumeJump(): boolean {
    if (!this.jumpPressed) return false;
    this.jumpPressed = false;
    return true;
  }

  /**
   * One simulation slice. `candidate` is the pal F would mount — main.ts hands
   * over the primary — and may be null when the party is hidden.
   */
  update(dt: number, candidate: PalActor | null): void {
    const input = this.input;
    // `pressed` is OR-ed in for the same reason Player's jump does it: a tap
    // shorter than one 16.7 ms slice (a virtual button, an automated press)
    // never shows up in held state. The latch is what stops a rendered frame
    // that drains two slices from spending the same tap twice.
    const fHeld = input.down('KeyF') || input.pressed('KeyF');
    const fEdge = fHeld && !this.fWasHeld;
    this.fWasHeld = fHeld;

    // Space, latched the same way, so a ground mount's jump fires once per press
    // however many slices the frame drains. Consumed in updateGround(); a flyer
    // reads Space as held altitude instead and never looks at this.
    const jumpHeld = input.down('Space') || input.pressed('Space');
    this.jumpPressed = jumpHeld && !this.jumpWasHeld;
    this.jumpWasHeld = jumpHeld;

    if (this.pal) {
      // A tap of F gets off. The F that MOUNTED you is still down at this
      // point, and no edge can be produced from it because fWasHeld was already
      // true when the mount happened — you have to let go and press again.
      if (fEdge) { this.dismount(); return; }
      if (this.pal.isDead || this.player.isDead) {
        this.dismount(this.pal.isDead ? `${this.pal.species.name} is down!` : undefined);
        return;
      }
      this.updateRide(dt);
      return;
    }

    if (!fHeld) {
      this.hold = Math.max(0, this.hold - RELEASE_DRAIN * MOUNT_HOLD * dt);
      this.refusedFor = 'none';
      return;
    }

    const why = this.refusal(candidate);
    if (why !== 'none') {
      this.hold = 0;
      if (this.refusedFor !== why) {
        this.refusedFor = why;
        this.bus.emit({ type: 'toast', text: refusalText(why, candidate) });
      }
      return;
    }
    this.refusedFor = 'none';
    this.hold += dt;
    if (this.hold >= MOUNT_HOLD) this.mount(candidate!);
  }

  /**
   * Climb on. The ride starts at the HERO's own column rather than wherever the
   * pal happens to be trotting, so mounting can never begin with the mount
   * inside a hillside or a body-length away from its rider — the pal comes to
   * you, which is also what it looks like.
   */
  mount(pal: PalActor): void {
    if (this.pal) return;
    this.pal = pal;
    this.hold = 0;
    this.flying = pal.species.locomotion === 'flying';
    this.topSpeed = pal.stats.speed * (this.flying ? FLY_CRUISE : GALLOP);

    const p = this.player.position;
    this.pos.set(p.x, Math.max(this.world.getHeight(p.x, p.z), this.world.waterLevel - WADE_DEPTH), p.z);
    if (this.flying) this.pos.y = this.floorFor(p.x, p.z);
    this.vel.set(0, 0, 0);
    this.vy = 0;
    this.grounded = !this.flying;
    this.yaw = Math.atan2(this.player.forward.x, this.player.forward.z);
    this.pitch = 0;
    this.bank = 0;
    this.speed01 = 0;

    pal.setRidden(true);
    this.player.setMounted(true);
    this.player.setCameraFraming(MOUNT_CAM_SCALE, MOUNT_CAM_DROP);
    this.seatHero();
    this.bus.emit({
      type: 'toast',
      // The persistent badge already spells the controls out, so the toast is
      // the flourish, not a second copy of the key hints.
      text: this.flying
        ? `${pal.species.name} spreads its wings — hold on!`
        : `${pal.species.name} kneels — you're in the saddle!`,
    });
  }

  /**
   * Get off. On the ground the hero steps down beside the mount; in the air he
   * simply leaves the saddle with the mount's momentum and falls, which is both
   * the simplest rule and the one players expect.
   */
  dismount(reason?: string): void {
    const pal = this.pal;
    if (!pal) return;
    this.pal = null;
    this.hold = 0;
    pal.setRidden(false);
    this.player.setMounted(false);
    this.player.setCameraFraming(1, 0);

    // Step off to the camera's right, clear of the mount's body, and only take
    // the ground there if it is not a wall — otherwise stay where the saddle
    // was and let gravity sort it out.
    const side = this.player.camRight;
    const r = pal.scaledRadius + 0.7;
    const x = this.pos.x + side.x * r;
    const z = this.pos.z + side.z * r;
    const gh = this.world.getHeight(x, z);
    const p = this.player.position;
    if (!this.flying && gh <= this.pos.y + MOUNT_STEP_UP) {
      p.set(x, gh, z);
      this.player.onGround = true;
    } else {
      p.set(this.pos.x, this.pos.y + (this.flying ? 0.2 : 0), this.pos.z);
      this.player.onGround = false;
    }
    this.player.velocity.set(this.vel.x, this.flying ? 0 : this.vy, this.vel.z);
    this.bus.emit({ type: 'toast', text: reason ?? `Dismounted ${pal.species.name}` });
  }

  // -- ride ------------------------------------------------------------------

  /** Lowest a flyer may be at this column: terrain or water, plus clearance. */
  private floorFor(x: number, z: number): number {
    return Math.max(this.world.getHeight(x, z), this.world.waterLevel) + FLY_CLEARANCE;
  }

  /** Top of everything solid at a column — terrain, plus a tree's bole. */
  private blockTop(x: number, z: number): number {
    const ground = this.world.getHeight(x, z);
    const trunk = this.world.trunkSolidTopAt(x, z);
    return trunk > ground ? trunk : ground;
  }

  private updateRide(dt: number): void {
    const pal = this.pal!;
    const input = this.input;

    // ---- steering: camera-relative, exactly as on foot ----
    const fwd = input.axisFwd;
    const side = input.axisSide;
    _wish.set(0, 0, 0)
      .addScaledVector(this.player.camForward, fwd)
      .addScaledVector(this.player.camRight, side);
    const tilt = Math.min(1, Math.hypot(fwd, side));
    const moving = _wish.lengthSq() > 1e-6;
    if (moving) _wish.normalize();

    // The mount's top speed is the PAL's, not the hero's — that is the whole
    // point of riding one. A half-deflected stick still walks.
    let target = this.topSpeed;
    if (tilt > 0 && tilt < 0.98) target *= Math.max(0.35, tilt);

    const k = 1 - Math.exp(-ACCEL_LAMBDA * dt);
    this.vel.x += ((moving ? _wish.x * target : 0) - this.vel.x) * k;
    this.vel.z += ((moving ? _wish.z * target : 0) - this.vel.z) * k;

    if (this.flying) this.integrateFlying(dt);
    else this.integrateGround(dt);

    // ---- facing / banking ----
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const prevYaw = this.yaw;
    if (speed > 0.35) {
      this.yaw = dampAngle(this.yaw, Math.atan2(this.vel.x, this.vel.z), TURN_LAMBDA, dt);
    }
    const turnVel = dt > 0 ? angleDelta(prevYaw, this.yaw) / dt : 0;
    const targetBank = this.flying ? clamp(-turnVel * 0.3, -0.5, 0.5) : 0;
    this.bank += (targetBank - this.bank) * (1 - Math.exp(-5 * dt));
    this.speed01 = Math.min(1, speed / Math.max(0.001, this.topSpeed));

    // ---- hand the pal its pose, and sit the hero on top of it ----
    const s = this.ride;
    s.x = this.pos.x; s.y = this.pos.y; s.z = this.pos.z;
    s.yaw = this.yaw; s.pitch = this.pitch; s.bank = this.bank;
    s.vx = this.vel.x; s.vz = this.vel.z;
    s.speed01 = this.speed01;
    s.action = this.flying ? 'fly' : this.speed01 > 0.5 ? 'run' : this.speed01 > 0.06 ? 'walk' : 'idle';
    pal.rideUpdate(dt, s);
    this.seatHero();
  }

  private integrateGround(dt: number): void {
    const world = this.world;
    // Horizontal first, axis by axis so a blocked diagonal slides along the
    // face instead of stopping dead — the same resolution the hero uses, with
    // the mount's own body radius and its higher step.
    const feetY = this.pos.y;
    const stepCeil = feetY + MOUNT_STEP_UP;
    const radius = this.pal!.scaledRadius + BODY_MARGIN;

    const nx = this.pos.x + this.vel.x * dt;
    if (this.blockTop(nx + Math.sign(this.vel.x) * radius, this.pos.z) <= stepCeil) this.pos.x = nx;
    else this.vel.x = 0;

    const nz = this.pos.z + this.vel.z * dt;
    if (this.blockTop(this.pos.x, nz + Math.sign(this.vel.z) * radius) <= stepCeil) this.pos.z = nz;
    else this.vel.z = 0;

    // Space bounds a ground mount. The rider is a passenger — the pal jumps, so
    // the jump is the pal's, not the hero's, and it clears more than he can on
    // foot. Read as an EDGE (the same latched `pressed`-OR-`down` shape the rest
    // of this file uses for F) so holding Space does not pogo, and gated on
    // `grounded` so there is no second jump in mid-air.
    if (this.grounded && this.consumeJump()) {
      this.vy = MOUNT_JUMP_VEL;
      this.grounded = false;
    }
    this.vy -= GRAVITY * dt;
    this.pos.y += this.vy * dt;

    // Deep water is waded, not swum: there is no swimming gait for a mount, so
    // the floor never goes further down than WADE_DEPTH below the surface.
    const gh = Math.max(world.getHeight(this.pos.x, this.pos.z), world.waterLevel - WADE_DEPTH);
    if (this.pos.y <= gh) {
      this.pos.y = gh;
      this.vy = 0;
      this.grounded = true;
    } else if (this.grounded && this.vy <= 0 && this.pos.y - gh < 0.5) {
      this.pos.y = gh;          // stay glued running down slopes
      this.vy = 0;
    } else {
      this.grounded = false;
    }
    this.pitch += (0 - this.pitch) * (1 - Math.exp(-8 * dt));
  }

  private integrateFlying(dt: number): void {
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    // Space climbs, C dives, neither holds altitude. Shift is deliberately not
    // involved: it is already sprint-or-grip on foot and a third meaning would
    // make it unreadable.
    const up = this.input.down('Space') ? 1 : 0;
    const down = this.input.down('KeyC') ? 1 : 0;
    const wantVy = up * FLY_CLIMB - down * FLY_DIVE;
    this.vy += (wantVy - this.vy) * (1 - Math.exp(-FLY_VY_LAMBDA * dt));
    this.pos.y += this.vy * dt;

    // The floor is not a suggestion: a flyer steered into a hillside rides up
    // over it rather than through it, and the ceiling stops the climb key from
    // being a lift into empty sky.
    const floor = this.floorFor(this.pos.x, this.pos.z);
    if (this.pos.y < floor) {
      this.pos.y = floor;
      if (this.vy < 0) this.vy = 0;
    }
    const ceil = Math.max(this.world.getHeight(this.pos.x, this.pos.z), this.world.waterLevel)
      + FLY_CEILING;
    if (this.pos.y > ceil) {
      this.pos.y = ceil;
      if (this.vy > 0) this.vy = 0;
    }
    this.grounded = false;
    this.pitch += (clamp(-this.vy * 0.055, -0.35, 0.35) - this.pitch)
      * (1 - Math.exp(-5 * dt));
  }

  /** Put the hero in the saddle and tell him which way he is pointing. */
  private seatHero(): void {
    const pal = this.pal!;
    const back = pal.scaledRadius * SEAT_BACK;
    this.player.position.set(
      this.pos.x - Math.sin(this.yaw) * back,
      this.pos.y + pal.saddleY - HERO_HIP_Y,
      this.pos.z - Math.cos(this.yaw) * back,
    );
    this.player.velocity.set(this.vel.x, this.flying ? this.vy : 0, this.vel.z);
    this.player.setRidePose(this.yaw, this.speed01, !this.flying && this.grounded);
  }
}

function refusalText(why: MountRefusal, candidate: PalActor | null): string {
  switch (why) {
    case 'swimming': return 'Too deep to mount — get out of the water first.';
    case 'climbing': return 'Not while you are on the wall.';
    case 'palDead': return candidate ? `${candidate.species.name} is in no shape to carry you.` : 'No pal to ride.';
    default: return 'Not now.';
  }
}
