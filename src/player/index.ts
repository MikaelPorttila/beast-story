import * as THREE from 'three';
import type { Engine } from '../core/engine';
import type { Input } from '../core/input';
import type { ElementType, EventBus, World } from '../core/types';
import { buildHeroRig, type HeroRig } from './hero-rig';
import { ThirdPersonCamera } from './camera';
import { HeroAnimator, type AttackState } from './animations';
import { DustSystem } from './dust';

// -- tuning ----------------------------------------------------------------
const WALK_SPEED = 6;
const SPRINT_MULT = 1.6;
const SWIM_SPEED = 3.4;
const GROUND_ACCEL = 42;
const AIR_ACCEL = 16;
const GRAVITY = 24;
const JUMP_VEL = 8.8;
const COYOTE_TIME = 0.12;
const JUMP_BUFFER = 0.12;
const TURN_RATE = 14;
/**
 * Highest ledge the hero can walk onto. Above it, the move is refused and the
 * player has to jump.
 *
 * Terrain collision is integer-stepped — Terrain.getHeight floors the continuous
 * height — so every ledge in this world is a whole unit or more. Any value below
 * 1.0 therefore means the same thing in practice: hills must be jumped. 0.5 is
 * the middle of that range, leaving room for a future half-height prop to still
 * be walkable without ever letting a full cube through.
 *
 * JUMP_VEL/GRAVITY put the apex at 8.8^2 / (2*24) = 1.61 units, so a single
 * block is always clearable with a jump and a 2-unit face never is — that gap is
 * the point, and moving either constant changes what the world is climbable.
 */
const MAX_STEP_UP = 0.5;
/**
 * Horizontal half-width for the step test, so the hero is stopped with his
 * shoulder at the rock face rather than with his centre inside it. Roughly the
 * rig's body width; it is a collision probe, not a capsule — there is no
 * horizontal collision volume in this game beyond this test.
 */
const BODY_RADIUS = 0.32;

// -- climbing --------------------------------------------------------------
/**
 * How far ahead of the hero's centre the climb probe looks for a wall.
 *
 * The step-up test above stops the hero with his shoulder at the face: it
 * refuses the move once `centre + BODY_RADIUS` would enter the taller column,
 * so a hero pressed against a cliff stands between 0 and BODY_RADIUS short of
 * the column boundary. Terrain columns are 1x1 (Terrain.getHeight floors x/z),
 * so a reach of 0.55 lands the probe at worst 0.23 inside the wall column and
 * never more than 0.55 into it — it cannot skip a column and grab the one
 * behind. Anything below ~0.35 would sometimes probe the hero's own column and
 * find nothing to hold.
 */
const CLIMB_REACH = 0.55;
/**
 * Smallest rise that counts as a climbable FACE rather than a hill.
 *
 * Below MAX_STEP_UP (0.5) the hero simply walks up. A 1-unit terrace is what
 * the jump exists for — JUMP_VEL/GRAVITY put the apex at 1.61, and the step
 * test at the apex clears anything up to 2.11 — so a single block must stay a
 * jump, not a climb, or Shift would grab every kerb in the world. 1.2 sits
 * clear of the 1.0 terrace and well under the 2.0 face that is the first thing
 * a running jump cannot reliably clear, which is exactly where climbing has to
 * take over.
 */
const CLIMB_MIN_RISE = 1.2;
/**
 * Vertical climb rate. Deliberately about half WALK_SPEED: climbing is the slow
 * way up, and a 6-unit cliff should feel like a commitment (~2 s) rather than a
 * faster staircase. Sideways shuffling along a face is slower still.
 */
const CLIMB_SPEED = 3.2;
const CLIMB_SIDE_SPEED = 2.0;
/** Velocity smoothing on the face, in the house `1 - exp(-l*dt)` form. */
const CLIMB_LAMBDA = 18;
/**
 * Feet within this of the top means the hero is at the lip — mantle.
 * Small, because the mantle teleports him forward onto the ledge and doing that
 * while his feet are still visibly below the surface reads as a pop.
 */
const CLIMB_TOP_EPS = 0.05;
/**
 * The hold is lost when the face drops this far BELOW the feet. Only a world
 * change can do that (a chunk unloading, a felled tree), and the response is to
 * simply fall, not to snap anywhere.
 */
const CLIMB_LOST = 0.6;
/**
 * Mantle step: how far along the climb direction the hero is placed when he
 * tops out. Must clear the column boundary he was holding (up to 0.32 away)
 * with room to spare, and stay under 1.0 so he lands in the column he climbed
 * and not the one past it. 0.7 puts him ~0.38 inside it.
 */
const MANTLE_PUSH = 0.7;
/**
 * Re-grab lockout after deliberately letting go, so a still-held Shift does not
 * re-attach on the very next slice. 0.35 s is long enough for the kick-off to
 * carry the hero out of probe range (3.2 m/s x 0.35 = 1.1 m).
 */
const CLIMB_LOCKOUT = 0.35;
/**
 * Shuffling sideways needs this much face left above the feet, so running out
 * of wall stops the hero instead of dropping him off the end of it.
 */
const CLIMB_SIDE_HOLD = 0.6;

const COMBO_DURS = [0.42, 0.42, 0.58];
const STRIKE_AT = 0.46;      // fraction of swing where damage lands
const COMBO_COOLDOWN = 0.22;
const RESPAWN_TIME = 3;

/**
 * Passive health regeneration.
 *
 * BASE_REGEN is the floor every player has with no items and no shrine: 1.6 hp
 * a second out of 100, so a full bar takes just over a minute. Deliberately slow
 * — it is the "walk it off between fights" rate, not a reason to stop fighting.
 * Anything faster and a retreat of a few steps undoes a whole encounter.
 *
 * REGEN_DELAY holds it off after taking a hit, so regen never fights incoming
 * damage mid-encounter; the clock restarts on every hit.
 *
 * `regenMultiplier` on the Player is the hook the rest of the game turns up:
 * a potion sets it high for a few seconds, a healing well holds it high while
 * the player stands in it. Nothing does that yet — the multiplier exists so
 * those can be data rather than another special case in here.
 */
const BASE_REGEN = 1.6;
const REGEN_DELAY = 5;

const _wish = new THREE.Vector3();
const _hvel = new THREE.Vector3();
const _knock = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _feet = new THREE.Vector3();

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

function dampAngle(cur: number, target: number, rate: number, dt: number): number {
  let d = target - cur;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return cur + d * (1 - Math.exp(-rate * dt));
}

/**
 * The hero: voxel adventurer with third-person camera, terrain-collided
 * movement, swimming, a 3-hit sword combo and full procedural animation.
 * Implements Damageable (faction 'player').
 */
export class Player {
  root: THREE.Group;
  position: THREE.Vector3;
  velocity = new THREE.Vector3();
  forward = new THREE.Vector3(0, 0, 1);
  hp = 100;
  maxHp = 100;
  isDead = false;
  readonly faction = 'player' as const;
  attackStat = 14;
  onGround = false;
  isSwimming = false;
  /** True while hanging on a climbable face; gravity is off and Shift is grip. */
  isClimbing = false;
  /**
   * True while sitting in a pal's saddle. The hero controller stops moving him
   * entirely — MountController owns position, velocity and heading, and writes
   * them here every slice — but everything that is ABOUT the hero rather than
   * about his locomotion (regen, damage, the flash, the animator, the camera)
   * still runs from update() exactly as it does on foot.
   */
  isMounted = false;
  moveSpeedNorm = 0;
  onAttack?: (origin: THREE.Vector3, direction: THREE.Vector3) => void;

  private rig: HeroRig;
  private cam = new ThirdPersonCamera();
  private animator = new HeroAnimator();
  private dust: DustSystem;

  private time = 0;
  private heading = 0;
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
  /**
   * Jump held on the PREVIOUS simulation slice, so a press edge can be derived
   * from held state. input.pressed() stays true for a whole rendered frame and
   * the sim can run several slices inside one, so the edge has to be latched
   * here rather than read from the input layer.
   */
  private jumpWasHeld = false;
  private jumpEdge = false;
  /** Seconds left before passive regen resumes; reset by every hit taken. */
  private regenHold = 0;
  /**
   * Scales passive regen. 1 = the base trickle. Potions and healing wells raise
   * it; nothing does yet. Public so that gameplay policy (main.ts) can drive it
   * without Player having to know what a potion is.
   */
  regenMultiplier = 1;

  private attack: AttackState = { active: false, combo: 0, t: 0, dur: COMBO_DURS[0] };
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

  takeDamage(amount: number, from: THREE.Vector3, _element?: ElementType): void {
    if (this.isDead || this.invulnT > 0) return;
    this.hp = clamp(this.hp - amount, 0, this.maxHp);
    this.regenHold = REGEN_DELAY;
    this.flash = 1;
    this.hurtT = 0.25;
    this.invulnT = 0.35;
    this.cam.addShake(0.32);
    // knockback away from the source
    _knock.set(this.position.x - from.x, 0, this.position.z - from.z);
    if (_knock.lengthSq() < 1e-4) _knock.copy(this.forward).multiplyScalar(-1);
    _knock.normalize();
    this.velocity.x += _knock.x * 5.5;
    this.velocity.z += _knock.z * 5.5;
    this.velocity.y += 2.5;
    this.onGround = false;
    if (this.hp <= 0) this.die();
  }

  private die(): void {
    this.isDead = true;
    this.deadT = 0;
    this.isClimbing = false;
    this.attack.active = false;
    this.cam.addShake(0.5);
    this.bus.emit({ type: 'toast', text: 'You fainted!' });
  }

  private respawn(): void {
    this.isDead = false;
    this.hp = this.maxHp;
    this.flash = 0;
    this.hurtT = 0;
    this.isClimbing = false;
    this.climbLockout = 0;
    this.velocity.set(0, 0, 0);
    this.position.copy(this.world.spawnPoint);
    this.position.y = this.world.getHeight(this.position.x, this.position.z);
    this.bus.emit({ type: 'toast', text: 'Back on your feet!' });
  }

  // ---- mounting -----------------------------------------------------------
  // The hero exposes the camera basis and a saddle pose, and MountController
  // (src/player/mount.ts) does the rest. Nothing about pals is known in here.

  /** Horizontal camera forward — the basis movement input is resolved against. */
  get camForward(): THREE.Vector3 { return this.cam.forward; }
  /** Horizontal camera right. */
  get camRight(): THREE.Vector3 { return this.cam.right; }

  /** Re-frame the follow camera; (1, 0) is the hero on foot. See the camera. */
  setCameraFraming(distScale: number, pivotDrop: number): void {
    this.cam.setFraming(distScale, pivotDrop);
  }

  /**
   * Climb into / out of the saddle. Everything the hero was doing on his own
   * two feet is cancelled: a swing in progress, a held wall, the jump buffer.
   * Position and velocity are the mount's business from here.
   */
  setMounted(on: boolean): void {
    if (this.isMounted === on) return;
    this.isMounted = on;
    this.isClimbing = false;
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

  /**
   * Where the saddle has the hero pointing this slice. `grounded` is passed
   * straight through to the camera's step smoothing: a mount walking terraced
   * terrain wants the grounded glide, a flyer's continuous climb does not.
   */
  setRidePose(yaw: number, speed01: number, grounded: boolean): void {
    this.rideYaw = yaw;
    this.rideSpeed01 = speed01;
    this.onGround = grounded;
  }

  update(dt: number): void {
    this.time += dt;
    const input = this.input;
    const world = this.world;

    if (this.invulnT > 0) this.invulnT -= dt;
    if (this.hurtT > 0) this.hurtT -= dt;
    if (this.attackCooldown > 0) this.attackCooldown -= dt;
    this.landBump *= Math.exp(-6 * dt);

    // Jump press edge, latched per simulation slice. Space is BOTH the jump and
    // the "let go of the wall" button, and the second one must not fire twice
    // when two sim slices land inside one rendered frame — see jumpWasHeld.
    //
    // `pressed` is OR-ed in on purpose: held state alone misses a tap shorter
    // than one 16.7 ms slice (a virtual button, or an automated press), which is
    // exactly the case the buffered jump below already handles. `pressed` stays
    // true for the whole rendered frame, so the latch is what stops a two-slice
    // frame from spending the same tap twice.
    const jumpNow = input.down('Space') || input.pressed('Space');
    this.jumpEdge = jumpNow && !this.jumpWasHeld;
    this.jumpWasHeld = jumpNow;

    if (this.isDead) {
      this.deadT += dt;
      if (this.deadT >= RESPAWN_TIME) this.respawn();
      // keep gravity so the body settles onto slopes
      this.velocity.x *= Math.exp(-8 * dt);
      this.velocity.z *= Math.exp(-8 * dt);
      this.velocity.y -= GRAVITY * dt;
      this.position.addScaledVector(this.velocity, dt);
      const gh = world.getHeight(this.position.x, this.position.z);
      if (this.position.y <= gh) { this.position.y = gh; this.velocity.y = 0; }
      this.moveSpeedNorm = 0;
    } else if (this.isMounted) {
      this.updateRiding(dt);
    } else {
      this.updateAlive(dt);
    }

    // damage flash on all rig materials
    if (this.flash > 0.001) {
      this.flash *= Math.exp(-7 * dt);
      for (const m of this.rig.materials) {
        m.emissive.setRGB(this.flash * 0.9, this.flash * 0.1, this.flash * 0.08);
      }
    } else if (this.flash > 0) {
      this.flash = 0;
      for (const m of this.rig.materials) m.emissive.setRGB(0, 0, 0);
    }

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
    });

    this.dust.update(dt, this.time);
    this.cam.update(dt, input, this.position, this.onGround, world, this.engine.camera);
    this.engine.updateSunFocus(this.position);
  }

  /**
   * Top of everything SOLID at a column: terrain, plus a tree's bole.
   *
   * Trees used to be scenery you walked straight through. A trunk is now an
   * obstacle you go around — but only the trunk. `trunkSolidTopAt` deliberately
   * ignores the crown (see world/index.ts): a canopy sits several units up, and
   * because this test compares a column's TOP against the feet, a solid crown
   * would read as an invisible wall ringing every tree and you could not walk
   * under one at all.
   *
   * Returns -Infinity from the world where there is no trunk, so the max is just
   * the terrain there.
   */
  private blockTop(x: number, z: number): number {
    const ground = this.world.getHeight(x, z);
    const trunk = this.world.trunkSolidTopAt(x, z);
    return trunk > ground ? trunk : ground;
  }

  /**
   * Passive health regen. Held off for REGEN_DELAY after each hit (takeDamage
   * restarts the clock), so it tops the bar up between fights instead of tugging
   * against damage during one. Scaled by regenMultiplier, which is what a potion
   * or a healing well will raise. Runs on foot and in the saddle alike.
   */
  private updateRegen(dt: number): void {
    if (this.regenHold > 0) {
      this.regenHold -= dt;
    } else if (this.hp < this.maxHp) {
      this.hp = clamp(this.hp + BASE_REGEN * this.regenMultiplier * dt, 0, this.maxHp);
    }
  }

  /**
   * One slice in the saddle.
   *
   * There is deliberately no locomotion here at all: MountController has already
   * written position, velocity and the saddle pose for this slice, and running
   * gravity or the step test on top of that would fight it. What remains is the
   * hero's own business — regen, and the facing/gait the animator reads.
   *
   * The melee combo is OFF while mounted (see updateAttack's guard): a sword arc
   * swung from the saddle would land at the mount's feet, and a mounted attack
   * is a feature with its own reach and animation, not a leftover of this one.
   */
  private updateRiding(dt: number): void {
    this.updateRegen(dt);
    this.sprinting = false;
    this.isSwimming = false;
    this.isClimbing = false;
    this.climbRate = 0;
    this.moveSpeedNorm = this.rideSpeed01;
    // Snapped, not damped: the mount already smoothed this heading, and a second
    // filter here would let the rider face out of the saddle through every turn.
    this.heading = this.rideYaw;
    this.root.rotation.y = this.heading;
    this.forward.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  private updateAlive(dt: number): void {
    const input = this.input;
    const world = this.world;

    this.updateRegen(dt);

    // ---- movement input, camera relative ----
    // Analog axes: keyboard when keys are held, virtual stick on touch.
    const fwd = input.axisFwd;
    const side = input.axisSide;
    _wish.set(0, 0, 0)
      .addScaledVector(this.cam.forward, fwd)
      .addScaledVector(this.cam.right, side);
    // Stick deflection scales speed; keyboard always reads as full tilt.
    const tilt = Math.min(1, Math.hypot(fwd, side));
    const moving = _wish.lengthSq() > 1e-6;
    if (moving) _wish.normalize();

    // ---- Shift: sprint in the open, grip on a wall ----
    // The SAME held key means both, and the surface is what disambiguates: with
    // a climbable face within CLIMB_REACH of the hero's chest and the movement
    // wish pushing into it, Shift is a grip; anywhere else it is the sprint it
    // has always been. Nothing here reads a press edge, so it behaves the same
    // whether the frame drains one simulation slice or four — running into a
    // wall with Shift already down grabs it, and letting Shift go lets go.
    if (this.climbLockout > 0) this.climbLockout -= dt;
    const shiftHeld = input.down('ShiftLeft');
    if (this.isClimbing) {
      if (!shiftHeld) {
        this.detachClimb(0);            // let go: slide off and fall
      } else if (this.jumpEdge) {
        // kick off the face: up, and away from it
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
    if (this.attack.active && this.onGround) targetSpeed *= 0.35; // planted swings
    // A half-deflected stick walks; a full one runs. Keyboard tilt is always 1.
    if (tilt > 0 && tilt < 0.98) targetSpeed *= Math.max(0.35, tilt);

    // ---- horizontal acceleration / friction ----
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

    // ---- jumping / gravity / buoyancy ----
    if (input.pressed('Space')) this.jumpBuffer = JUMP_BUFFER;
    else this.jumpBuffer -= dt;
    this.coyote = this.onGround ? COYOTE_TIME : this.coyote - dt;

    if (this.isSwimming) {
      const floatY = world.waterLevel - 1.15;
      this.velocity.y += ((floatY - this.position.y) * 9 - this.velocity.y * 3.5) * dt;
      if (input.down('Space')) this.velocity.y += 9 * dt; // paddle up
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

    // ---- integrate + terrain collision ----
    // Horizontal first, and refused when the destination column stands more than
    // MAX_STEP_UP above the feet. There is no horizontal collision geometry in
    // this world, so without the test walking into a taller column simply put the
    // hero on top of it on the next lines down — every terrace was a staircase
    // you could stroll up. Now a hill is something you jump.
    //
    // The axes resolve INDEPENDENTLY, which is what lets a blocked diagonal slide
    // along the cliff instead of stopping dead, and each probes BODY_RADIUS along
    // its own direction of travel so the stop happens at the rock face.
    //
    // The reference height is the feet BEFORE this frame's gravity, so the test
    // asks "can he step onto that?" and not "did he sink a millimetre first?".
    // Airborne, the same test reads as clearance: at the apex of a jump the feet
    // are 1.61 units up, so a 1-unit ledge is no longer a wall — which is exactly
    // how jumping gets you up a hill.
    //
    // Swimming is exempt. A swimmer floats ~1.15 units below the surface, so the
    // rule would make every shoreline a wall and there would be no way out of the
    // water.
    const feetY = this.position.y;
    if (this.isSwimming) {
      this.position.x += this.velocity.x * dt;
      this.position.z += this.velocity.z * dt;
    } else {
      const stepCeil = feetY + MAX_STEP_UP;
      const nx = this.position.x + this.velocity.x * dt;
      const probeX = nx + Math.sign(this.velocity.x) * BODY_RADIUS;
      if (this.blockTop(probeX, this.position.z) <= stepCeil) this.position.x = nx;
      else this.velocity.x = 0;

      const nz = this.position.z + this.velocity.z * dt;
      const probeZ = nz + Math.sign(this.velocity.z) * BODY_RADIUS;
      if (this.blockTop(this.position.x, probeZ) <= stepCeil) this.position.z = nz;
      else this.velocity.z = 0;
    }
    this.position.y += this.velocity.y * dt;

    const gh = world.getHeight(this.position.x, this.position.z);
    if (this.position.y <= gh) {
      if (!this.onGround && this.velocity.y < -7) {
        this.landBump = clamp((-this.velocity.y - 6) / 13, 0, 1);
        _feet.set(this.position.x, gh + 0.05, this.position.z);
        this.dust.burst(_feet, Math.min(14, Math.floor(-this.velocity.y)));
        if (this.velocity.y < -15) this.cam.addShake(0.15);
      }
      this.position.y = gh;
      this.velocity.y = 0;
      this.onGround = true;
    } else if (this.onGround && this.velocity.y <= 0 && this.position.y - gh < 0.35) {
      // stay glued when running down slopes (jump sets velocity.y > 0)
      this.position.y = gh;
      this.velocity.y = 0;
    } else {
      this.onGround = false;
    }

    // ---- swimming state ----
    this.isSwimming =
      gh < world.waterLevel - 0.7 && this.position.y < world.waterLevel - 1.0;
    if (this.isSwimming) this.onGround = false;

    this.finishAlive(dt, moving);
  }

  /**
   * Everything that happens after the hero has been moved, whichever way he was
   * moved: facing, the melee combo, animation speed and footfall dust. The climb
   * path and the walk path both end here so neither can quietly skip one.
   */
  private finishAlive(dt: number, moving: boolean): void {
    const input = this.input;

    // ---- speed norm for animation / pals ----
    const hspeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.moveSpeedNorm = clamp(hspeed / WALK_SPEED, 0, 1);

    // ---- facing ----
    let targetHeading = this.heading;
    if (this.isClimbing) {
      // square up to the rock: the animator reaches along local -z/+y, so the
      // hands only land on the face if the whole rig is turned to it.
      targetHeading = Math.atan2(this.climbDirX, this.climbDirZ);
    } else if (this.attack.active || input.attackHeld) {
      targetHeading = Math.atan2(this.cam.forward.x, this.cam.forward.z);
    } else if (moving) {
      targetHeading = Math.atan2(_wish.x, _wish.z);
    }
    this.heading = dampAngle(this.heading, targetHeading, TURN_RATE, dt);
    this.root.rotation.y = this.heading;
    this.forward.set(Math.sin(this.heading), 0, Math.cos(this.heading));

    // ---- melee combo ----
    this.updateAttack(dt);

    // ---- sprint dust ----
    if (this.sprinting && this.onGround && this.moveSpeedNorm > 0.6) {
      _feet.set(
        this.position.x - this.forward.x * 0.3,
        this.position.y + 0.05,
        this.position.z - this.forward.z * 0.3,
      );
      this.dust.emit(_feet, 11, dt);
    }
  }

  // ---- climbing -----------------------------------------------------------

  /**
   * Top of the climbable column `reach` ahead along (dx, dz), or -Infinity if
   * what is there is not a face worth grabbing.
   *
   * `climbTopAt` is asked, not `getHeight`: climbable and solid are different
   * sets. Terrain is both, a tree trunk is only the former — which is why the
   * hero can stand inside a trunk's column and still find something to hold.
   */
  private probeFace(dx: number, dz: number, reach: number): number {
    const top = this.world.climbTopAt(
      this.position.x + dx * reach,
      this.position.z + dz * reach,
    );
    return top - this.position.y >= CLIMB_MIN_RISE ? top : -Infinity;
  }

  /**
   * Look for a face to grab in the direction the hero is leaning. Three probes,
   * cheapest-and-most-likely first, and only ever on the slices where Shift is
   * held with a movement wish — never per frame unconditionally:
   *
   *  1. the CARDINAL snap of the wish. Terrain faces are axis-aligned column
   *     walls, so walking into a cliff at 45 degrees should still grab the wall
   *     in front rather than the diagonal gap between two columns.
   *  2. the raw wish, for anything that is not grid-aligned (a trunk beside you).
   *  3. the hero's OWN column, because a trunk is climbable without being solid:
   *     you walk into it and end up standing inside it with nothing ahead.
   */
  private tryGrab(): void {
    const ax = Math.abs(_wish.x);
    const az = Math.abs(_wish.z);
    const cx = ax >= az ? Math.sign(_wish.x) : 0;
    const cz = ax >= az ? 0 : Math.sign(_wish.z);

    let top = this.probeFace(cx, cz, CLIMB_REACH);
    let dx = cx, dz = cz;
    if (top === -Infinity) {
      top = this.probeFace(_wish.x, _wish.z, CLIMB_REACH);
      dx = _wish.x; dz = _wish.z;
      if (top === -Infinity) {
        top = this.probeFace(_wish.x, _wish.z, 0);
        if (top === -Infinity) return;
      }
    }

    this.isClimbing = true;
    this.climbDirX = dx;
    this.climbDirZ = dz;
    this.climbRate = 0;
    this.onGround = false;
    this.coyote = 0;
    this.jumpBuffer = 0;
    // Grabbing kills inherited momentum — a sprint into a cliff should stick to
    // it, not bounce along it — and cancels a swing in progress; you cannot
    // hold a rock face and a sword at the same time.
    this.velocity.set(0, 0, 0);
    this.attack.active = false;
  }

  /** Let go. `kick` pushes the hero away from the face (jump-off). */
  private detachClimb(kick: number): void {
    if (!this.isClimbing) return;
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
   * One slice on the wall. Gravity, the jump buffer and the step-up test are all
   * out of the picture here; the face itself is the constraint.
   *
   * The wish is resolved against the face rather than against the world: its
   * component INTO the rock drives the hero up (pushing towards what you are
   * holding is the universal "climb" input, and with the camera behind him W is
   * exactly that), and its component ALONG the rock shuffles him sideways. The
   * hero never moves toward the face, so the standoff he grabbed at is the
   * standoff he keeps.
   */
  private updateClimb(dt: number): void {
    const world = this.world;
    const top = world.climbTopAt(
      this.position.x + this.climbDirX * CLIMB_REACH,
      this.position.z + this.climbDirZ * CLIMB_REACH,
    );
    const rise = top - this.position.y;

    // The face fell out from under the hands — a chunk unloaded, or whatever we
    // were holding stopped existing. Fall; do not snap anywhere.
    if (rise < -CLIMB_LOST) {
      this.detachClimb(0);
      return;
    }

    // At the lip. Mantle if there is somewhere to stand: the ledge column is
    // checked for real (getHeight, the SOLID surface) and has to be level with
    // what we climbed, so topping out on a trunk — climbable, but not something
    // you can stand on — leaves the hero clinging at full stretch instead of
    // being flung into the air above it.
    let atTop = false;
    if (rise <= CLIMB_TOP_EPS) {
      const nx = this.position.x + this.climbDirX * MANTLE_PUSH;
      const nz = this.position.z + this.climbDirZ * MANTLE_PUSH;
      const dest = world.getHeight(nx, nz);
      if (Math.abs(dest - top) <= MAX_STEP_UP) {
        this.position.x = nx;
        this.position.z = nz;
        this.position.y = dest;
        this.velocity.set(0, 0, 0);
        this.isClimbing = false;
        this.climbRate = 0;
        this.onGround = true;
        this.coyote = COYOTE_TIME;
        return;
      }
      atTop = true;
    }

    // ---- resolve the wish against the face ----
    const moving = _wish.lengthSq() > 1e-6;
    const into = moving ? _wish.x * this.climbDirX + _wish.z * this.climbDirZ : 0;
    // face tangent: the climb direction rotated a quarter turn about +y
    const tanX = -this.climbDirZ;
    const tanZ = this.climbDirX;
    const along = moving ? _wish.x * tanX + _wish.z * tanZ : 0;

    let vy = into * CLIMB_SPEED;
    if (atTop && vy > 0) vy = 0;
    const k = 1 - Math.exp(-CLIMB_LAMBDA * dt);
    this.velocity.y += (vy - this.velocity.y) * k;
    this.velocity.x += (tanX * along * CLIMB_SIDE_SPEED - this.velocity.x) * k;
    this.velocity.z += (tanZ * along * CLIMB_SIDE_SPEED - this.velocity.z) * k;
    this.climbRate = clamp(this.velocity.y / CLIMB_SPEED, -1, 1);

    // ---- integrate ----
    this.position.y += this.velocity.y * dt;
    if (atTop && this.position.y > top) this.position.y = top;

    // Sideways only where the face continues: the probe is taken from the
    // DESTINATION, so shuffling off the end of a ledge stops at the corner
    // rather than dropping the hero into space.
    const nx = this.position.x + this.velocity.x * dt;
    const nz = this.position.z + this.velocity.z * dt;
    if (
      world.climbTopAt(nx + this.climbDirX * CLIMB_REACH, nz + this.climbDirZ * CLIMB_REACH)
      >= this.position.y + CLIMB_SIDE_HOLD
    ) {
      this.position.x = nx;
      this.position.z = nz;
    } else {
      this.velocity.x = 0;
      this.velocity.z = 0;
    }

    // ---- back on the floor / in the drink ----
    const gh = world.getHeight(this.position.x, this.position.z);
    if (this.position.y <= gh) {
      this.position.y = gh;
      this.velocity.y = 0;
      this.onGround = true;
      // Lockout, so climbing down to the bottom of a cliff ends standing on the
      // ground rather than re-grabbing the same face on the next slice.
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

    if (a.active) {
      a.t += dt;
      // strike frame: fire the hit callback exactly once per swing
      if (!this.struck && a.t >= a.dur * STRIKE_AT) {
        this.struck = true;
        _origin.copy(this.position);
        _origin.y += 1.25;
        _origin.addScaledVector(this.forward, 0.35);
        _dir.copy(this.forward);
        this.onAttack?.(_origin, _dir);
      }
      if (input.attackPressed && a.t > a.dur * 0.35 && a.combo < 2) {
        this.attackQueued = true;
      }
      if (a.t >= a.dur) {
        if (this.attackQueued && a.combo < 2) {
          a.combo += 1;
          a.dur = COMBO_DURS[a.combo];
          a.t = 0;
          this.attackQueued = false;
          this.struck = false;
        } else {
          a.active = false;
          this.attackCooldown = COMBO_COOLDOWN;
        }
      }
    } else if (
      input.attackPressed && this.attackCooldown <= 0
      && !this.isSwimming && !this.isClimbing && !this.isMounted
    ) {
      a.active = true;
      a.combo = 0;
      a.dur = COMBO_DURS[0];
      a.t = 0;
      this.attackQueued = false;
      this.struck = false;
    }
  }
}
