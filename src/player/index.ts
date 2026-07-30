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
const COMBO_DURS = [0.42, 0.42, 0.58];
const STRIKE_AT = 0.46;      // fraction of swing where damage lands
const COMBO_COOLDOWN = 0.22;
const RESPAWN_TIME = 3;

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
    this.attack.active = false;
    this.cam.addShake(0.5);
    this.bus.emit({ type: 'toast', text: 'You fainted!' });
  }

  private respawn(): void {
    this.isDead = false;
    this.hp = this.maxHp;
    this.flash = 0;
    this.hurtT = 0;
    this.velocity.set(0, 0, 0);
    this.position.copy(this.world.spawnPoint);
    this.position.y = this.world.getHeight(this.position.x, this.position.z);
    this.bus.emit({ type: 'toast', text: 'Back on your feet!' });
  }

  update(dt: number): void {
    this.time += dt;
    const input = this.input;
    const world = this.world;

    if (this.invulnT > 0) this.invulnT -= dt;
    if (this.hurtT > 0) this.hurtT -= dt;
    if (this.attackCooldown > 0) this.attackCooldown -= dt;
    this.landBump *= Math.exp(-6 * dt);

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

  private updateAlive(dt: number): void {
    const input = this.input;
    const world = this.world;

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

    this.sprinting = moving && input.down('ShiftLeft') && !this.isSwimming;
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
      if (world.getHeight(probeX, this.position.z) <= stepCeil) this.position.x = nx;
      else this.velocity.x = 0;

      const nz = this.position.z + this.velocity.z * dt;
      const probeZ = nz + Math.sign(this.velocity.z) * BODY_RADIUS;
      if (world.getHeight(this.position.x, probeZ) <= stepCeil) this.position.z = nz;
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

    // ---- speed norm for animation / pals ----
    const hspeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.moveSpeedNorm = clamp(hspeed / WALK_SPEED, 0, 1);

    // ---- facing ----
    let targetHeading = this.heading;
    if (this.attack.active || input.attackHeld) {
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
    } else if (input.attackPressed && this.attackCooldown <= 0 && !this.isSwimming) {
      a.active = true;
      a.combo = 0;
      a.dur = COMBO_DURS[0];
      a.t = 0;
      this.attackQueued = false;
      this.struck = false;
    }
  }
}
