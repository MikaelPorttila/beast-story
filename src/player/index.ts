import * as THREE from 'three';
import type { Engine } from '../core/engine';
import type { Input } from '../core/input';
import { MAX_STEP_UP, type ElementType, type EventBus, type World } from '../core/types';
import { CarrierRide } from '../world/carriers';
import { t } from '../i18n';
import { buildHeroRig, type HeroRig } from './hero-rig';
import { ThirdPersonCamera } from './camera';
import { HeroAnimator, type AttackState } from './animations';
import { DustSystem } from './dust';

// -- tuning ----------------------------------------------------------------
const WALK_SPEED = 6;
const SPRINT_MULT = 1.6;
const SWIM_SPEED = 3.4;
/**
 * DIVING, and the three numbers it needs. Hold C (pad B) to swim down.
 *
 * The key is the one that already means "go down" — `MountController` reads the
 * same `KeyC` to make a flyer descend, and core/gamepad.ts already maps the B
 * face to it, so the control a player learns on a galebird is the control that
 * works in a lake. No new binding, and ui/keybinds.ts's row already covers it.
 *
 * `DIVE_ACCEL` fights the buoyancy rather than switching it off, so the hero
 * still bobs at the surface for the first moment and sinks once the key has been
 * held — which is what tells you the water is pushing back. Terminal speed is
 * SWIM_SPEED, so going down is exactly as fast as going along and the depth you
 * reach is legible from how long you have held it.
 *
 * `SWIM_RISE_MAX` is the one that is not obvious, and it is the reason diving
 * needs a change to the ASCENT at all. Buoyancy was an unclamped spring toward
 * the float line: at the 1.15 units the hero used to be able to reach it pulls
 * at 10 units/s^2, but the lake bed is 4 units down in places, and from there
 * the same spring pulls at 36 and surfaces him at 10 units/s — three times swim
 * speed, straight up, like a cork. Capping the spring makes the ascent a swim
 * (terminal 12/3.5 = 3.4 units/s, SWIM_SPEED again) instead of a launch, and it
 * costs nothing at the surface where the spring never reaches the cap anyway.
 */
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
// MAX_STEP_UP — the highest ledge the hero can walk onto — moved to
// core/types.ts when settlements grew colliders: it is now the one rule the
// hero, the saddle, a following beast, a wild enemy and the town builders'
// footprint measurement all resolve against. Its derivation from JUMP_VEL and
// GRAVITY, which still live here, is written on it there.
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

// -- standing on a tree crown ----------------------------------------------
/**
 * How far a canopy's surface must stand ABOVE the terrain before it counts as a
 * platform in its own right rather than as leaves brushing the floor.
 *
 * Must be greater than MAX_STEP_UP, and that is the whole derivation: the
 * platform catch below accepts feet that started the slice within MAX_STEP_UP
 * (0.5) of the surface, so anything closer to the ground than that would snap a
 * WALKING hero up onto it. With 0.6 the two windows cannot overlap — a hero
 * whose feet are on the terrain is never lifted by foliage — and the only way
 * onto a crown is to fall onto it, jump onto it, or climb it.
 *
 * Measured over the 120x120 units around spawn at 0.25 resolution: 54286 sampled
 * columns carry a crown, and the distribution of (climbTopAt - getHeight) over
 * them is 10 columns under 0.6, 8 in 0.6-1.2, 74 in 1.2-2.5 and 54194 above 2.5.
 * So this threshold discards 10 columns in 54000 — the extreme fringe of a dome
 * where it grazes rising ground — and the handful just above it are reachable
 * only by jumping onto them, which is the right answer for a knee-high branch.
 */
const CANOPY_MIN_CLEAR = 0.6;
/**
 * How far the canopy may fall away beneath the feet in one slice before the
 * hero stops being held by it.
 *
 * Deliberately the same 0.35 the terrain uses to stay glued running down a
 * slope, for the same reason: a dome is a curved surface and walking outward on
 * it drops the ground under you every slice. Inside 0.35 he slides down the
 * curve; past it he goes airborne, which is exactly what walking off a treetop
 * should do.
 *
 * Where that happens is a property of the dome, not a second constant. Measured
 * walking straight over a crown of radius 2.55 and semi-axis 2.6 at 6 m/s: the
 * feet tracked the surface exactly from the far side of the apex (y 23.12) down
 * to y 21.69 at 2.40 units from the axis, and released on the next frame — the
 * dome falls 0.47 over the following 0.1 units of travel there, which is the
 * first slice that breaks 0.35. That is 0.94 of the crown radius, so the whole
 * canopy is walkable except the last 6% where the leaves turn into a cliff.
 */
const CANOPY_GLUE = 0.35;

/**
 * Sword strike from the saddle: how high above the hero's own origin the arc
 * starts, and how far along his aim it is pushed.
 *
 * A mount is scaled to 2.1 units (see MOUNT_HEIGHT) and the rider sits on top of
 * it, so a swing struck at the on-foot 1.25/0.35 lands inside the animal. 1.5
 * puts it at the rider's chest and 1.1 clears the mount's shoulder, so the arc
 * starts in open air ahead of the pair — which is also roughly where the
 * crosshair is pointing.
 */
const MOUNTED_STRIKE_Y = 1.5;
const MOUNTED_REACH = 1.1;

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
   * True while the surface holding him up is a TREE rather than the terrain — a
   * canopy dome, or the top face of a bole.
   *
   * It is state and not a query because it changes what the horizontal step test
   * is allowed to see: from the ground a crown is overhead and must stay
   * invisible to collision (see blockTop), while standing on one it is the
   * floor. Read-only outside; the vertical resolution and the mantle are the two
   * places that set it.
   */
  onCanopy = false;
  /**
   * True while sitting in a beast's saddle. The hero controller stops moving him
   * entirely — MountController owns position, velocity and heading, and writes
   * them here every slice — but everything that is ABOUT the hero rather than
   * about his locomotion (regen, damage, the flash, the animator, the camera)
   * still runs from update() exactly as it does on foot.
   */
  isMounted = false;
  /** True while a sword swing is in progress. Read-only; for tests and HUD. */
  get isAttacking(): boolean { return this.attack.active; }
  moveSpeedNorm = 0;
  /**
   * Horizontal half-width of the body — the same BODY_RADIUS the step test
   * probes with, published so that anything asking "is he touching that?" uses
   * the collision probe's own idea of how wide he is instead of a second number
   * that can drift away from it.
   *
   * With `position` and `velocity` above it also makes the hero a `ContactMover`
   * (world/touch-particles.ts) structurally, so the contact-particle system can
   * be handed a mount or a beast instead without knowing what either is.
   */
  readonly radius = BODY_RADIUS;
  onAttack?: (origin: THREE.Vector3, direction: THREE.Vector3) => void;
  /**
   * Melee aim assist, asked once per swing on the strike frame.
   *
   * Nudges `direction` toward the enemy nearest the crosshair and returns
   * whether it moved it. The hook is here rather than the logic because the
   * three pieces live in three places and none of them should reach across:
   * the enemy list is the combat system's, the policy is main.ts's, and the
   * BODY is this class's — a swing that gets steered has to take the hero's
   * facing with it, or the arc lands somewhere his sword visibly is not.
   *
   * It mutates in place, like every other vector on this path, so a swing
   * allocates nothing.
   */
  aimAssist?: (origin: THREE.Vector3, direction: THREE.Vector3) => boolean;

  /**
   * The moving frame under his feet, if any — a flying island's deck today.
   *
   * ONE FIELD AND TWO CALLS, and nothing else in this file knows what it is
   * standing on: `carry` at the top of the slice moves him with the frame, and
   * `support` folds the deck into the two column-top questions he already asks
   * (`blockTop` for the step test, `floor` for what holds him up). See
   * world/carriers.ts.
   */
  private readonly ride = new CarrierRide();

  private rig: HeroRig;
  /**
   * The follow camera.
   *
   * Public (read-only) only so main.ts can hand it to the feedback layer as a
   * shake sink. It used to be private, which is precisely why the three shake
   * calls in this file existed here at all: nothing else in the game could
   * reach the camera, so every impact worth a kick had to be one the hero
   * already knew about. Combat could not shake it for a crit, and never did.
   */
  readonly cam = new ThirdPersonCamera();
  private animator = new HeroAnimator();
  private dust: DustSystem;

  private time = 0;
  private heading = 0;

  /**
   * Which way the body is turned, `atan2(dx, dz)`. Read-only.
   *
   * The BODY and not the camera, which is the distinction that makes it worth
   * exposing: the two agree while he walks and part company whenever he does
   * not — standing still with the mouse moving, and in the opening pose, where
   * the camera is deliberately on the wrong side of him. `__dbgCamYaw` answers
   * for the arm; nothing answered for the man.
   */
  get facing(): number { return this.heading; }
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

  /**
   * Move the hero to a different zone's ground (see world/zones.ts).
   *
   * The world was captured at construction, and reconstructing the hero to
   * change it would throw away the one thing that must survive a transition —
   * his hp, and everything else on this object. So the reference is rebound and
   * nothing else moves; the caller places him at the new spawn afterwards,
   * because where he arrives is gameplay policy and not the controller's
   * business. `respawn()` reads `this.world` too, so dying in the new zone puts
   * him back in the new zone.
   */
  setWorld(world: World): void {
    this.world = world;
    // Whatever was carrying him belonged to the zone he is leaving, and its id
    // means nothing in the new one. `CarrierRide` would drop it on its own next
    // slice (the registry answers `undefined`), but saying so here keeps the
    // "everything the old zone owned is released" list in one place.
    this.ride.clear();
    this.isClimbing = false;
    this.climbLockout = 0;
    this.isSwimming = false;
    // Whatever was under his feet belonged to the zone he is leaving.
    this.onCanopy = false;
    this.velocity.set(0, 0, 0);
  }

  takeDamage(amount: number, from: THREE.Vector3, element?: ElementType): boolean {
    if (this.isDead || this.invulnT > 0) return false;
    this.hp = clamp(this.hp - amount, 0, this.maxHp);
    this.regenHold = REGEN_DELAY;
    this.flash = 1;
    this.hurtT = 0.25;
    this.invulnT = 0.35;
    // The camera kick that used to be here is now the `playerHurt` cue in
    // src/feedback/cues.ts, at the same 0.32, alongside the rumble it belongs
    // with. Same for `die()` and the hard landing below.
    // knockback away from the source
    _knock.set(this.position.x - from.x, 0, this.position.z - from.z);
    if (_knock.lengthSq() < 1e-4) _knock.copy(this.forward).multiplyScalar(-1);
    _knock.normalize();
    this.velocity.x += _knock.x * 5.5;
    this.velocity.z += _knock.z * 5.5;
    this.velocity.y += 2.5;
    this.onGround = false;
    if (this.hp <= 0) this.die();
    // Emitted only past the i-frame gate above, which is the whole point: this
    // is the event a controller rumbles on, so it has to mean "he was hit", not
    // "something swung at him". `_knock` is already the unit heading away from
    // the attacker, so the direction costs nothing to carry.
    this.bus.emit({
      type: 'playerHurt',
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
    // The corpse slide (update's dead branch) resolves against getHeight only,
    // so a body that fainted in a treetop falls out of it rather than lying on
    // leaves the dead path cannot see.
    this.onCanopy = false;
    this.attack.active = false;
    this.bus.emit({ type: 'playerDied' });
    this.bus.emit({ type: 'toast', text: t('toast.fainted') });
  }

  /**
   * Back to a new game's hero: full health, at the spawn, holding nothing.
   *
   * `respawn` below is the same shape and is deliberately NOT reused: it emits
   * `playerRevived` and a "you are back on your feet" toast, which are true after
   * fainting and false after New Game — the second would greet a player with a
   * message about an injury they never took. What is shared is the LIST, and the
   * two are three lines apart so a field added to one is visible from the other.
   */
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
    this.attack.active = false;
    this.takeStartPose();
  }

  /**
   * Stand the hero where a new session begins, looking the way it begins, with
   * the camera on his FACE.
   *
   * THE CAMERA ARM IS HIS HEADING AND NOT ITS OPPOSITE, which is the whole
   * point and is worth stating because it is the reverse of every other camera
   * write in this file. `cam.yaw` is the bearing FROM the hero TO the camera
   * (see `aimCamera`), so the usual over-the-shoulder framing is `heading + PI`
   * — the camera behind him, looking the way he looks. Setting it to `heading`
   * puts the camera in FRONT, looking back at him, which is what an opening
   * shot of a character wants and what nothing else in the game does.
   *
   * IT IS A SHOT, NOT A MODE, and it un-does itself: movement is camera
   * relative, so the first press of W walks him toward the lens and his heading
   * damps round to meet it within a few hundred milliseconds (`TURN_RATE`).
   * That is the intended behaviour rather than a defect to design around — the
   * composition is for the moment before the player touches anything, and any
   * input at all is the player saying they are done looking at it. A mouse
   * movement swings the arm directly and skips even that.
   *
   * Called by `reset()` and by the composition root's first placement, so a
   * second New Game in one session opens on the same shot as the first.
   */
  takeStartPose(): void {
    const start = this.world.playerStart;
    this.velocity.set(0, 0, 0);
    this.ride.clear();
    this.position.copy(start.position);
    this.position.y = Math.max(
      this.world.getHeight(this.position.x, this.position.z), this.world.waterLevel,
    );
    this.root.position.copy(this.position);
    this.heading = start.yaw;
    this.root.rotation.y = this.heading;
    this.forward.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.cam.yaw = start.yaw;
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
    this.bus.emit({ type: 'playerRevived' });
    this.bus.emit({ type: 'toast', text: t('toast.revived') });
  }

  // ---- mounting -----------------------------------------------------------
  // The hero exposes the camera basis and a saddle pose, and MountController
  // (src/player/mount.ts) does the rest. Nothing about beasts is known in here.

  /** Horizontal camera forward — the basis movement input is resolved against. */
  get camForward(): THREE.Vector3 { return this.cam.forward; }
  /** Horizontal camera right. */
  get camRight(): THREE.Vector3 { return this.cam.right; }

  /** Re-frame the follow camera; (1, 0) is the hero on foot. See the camera. */
  setCameraFraming(distScale: number, pivotDrop: number): void {
    this.cam.setFraming(distScale, pivotDrop);
  }

  /**
   * TEST HOOK, like `__dbgTp` in main.ts: swing the follow camera so that
   * holding W walks the hero along `bearing`, an atan2(dx, dz) heading.
   *
   * Movement is camera-relative, so the camera IS the steering wheel: without
   * this a headless test can only ever walk the hero in whatever direction the
   * camera happened to start, and "drive him into that hut" becomes "hope the
   * hut is downwind". Mouse-look is the only other way to turn, and it needs
   * pointer lock. Nothing in the game calls this.
   *
   * The half turn is the whole reason this takes a WALK bearing rather than
   * `cam.yaw` itself: the camera's yaw is the ARM — where the camera sits
   * relative to the hero, which is also what `__dbgCamYaw` reports — and the
   * view runs the other way down it. A caller handed the raw field walks
   * backwards, and does so silently.
   *
   * `cam.forward` is derived from the camera's SMOOTHED position, not from the
   * yaw, so a large swing takes a few hundred milliseconds to arrive; a caller
   * that drives immediately walks off along the old heading. Wait for
   * `__dbgCamYaw` to agree before pressing anything.
   */
  aimCamera(bearing: number): void {
    this.cam.yaw = bearing + Math.PI;
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
    // MountController resolves against getHeight, so the saddle never stands on
    // leaves; mounting in a treetop rides the animal down to the ground.
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

  /**
   * Move with whatever is carrying him, and nothing else.
   *
   * SEPARATE FROM `update` BECAUSE A FROZEN HERO IS STILL STANDING ON
   * SOMETHING. Every modal in this game freezes the player controller — the
   * shop, the F1 sheet, the in-game menu, the console — and while the world's
   * moving parts go on moving, so a hero who opened the menu on a flying
   * island watched it slide out from under him and was left standing in the
   * sky. Being frozen means "takes no input and runs no physics", not
   * "detached from the world".
   *
   * It is idempotent per slice and safe to call from either path: `carry`
   * applies the frame's published delta once, and the delta is published once
   * per slice by `CarrierRegistry.advance`.
   */
  carry(): void {
    this.ride.carry(this.world, this.position);
    if (this.ride.dyaw === 0) return;
    // A TURNING DECK TURNS WHAT IS ON IT — his body and the camera arm both,
    // or a hero standing still on a banking island slowly ends up facing
    // across a deck he never turned on, with the view swinging past him.
    // `cam.yaw` is the bearing from the hero to the camera and is the one
    // thing here that is not re-derived per frame from his heading.
    this.heading += this.ride.dyaw;
    this.cam.yaw += this.ride.dyaw;
    this.root.rotation.y = this.heading;
  }

  /**
   * Keep the lens on him while the controller is frozen.
   *
   * THE OTHER HALF OF `carry`, AND A BUG IN ITS OWN RIGHT. `update` is what
   * drives the follow camera, and every modal skips `update` — so with the shop,
   * the F1 sheet, the in-game menu or the console open, the camera stopped
   * following. That was invisible for as long as a frozen hero could not move,
   * and stopped being invisible the moment he could: carried by a flying island,
   * he slides out from under a camera that is still pointing at where the deck
   * used to be. It is also wrong for the plainer reason that the camera damps
   * toward its rest pose over several hundred milliseconds, so opening a panel
   * mid-turn froze the arm halfway through the swing.
   *
   * IT DOES NOT READ LOOK INPUT, and it does not have to guard against it here:
   * `frame()` in main.ts calls `Input.clearLook()` for the whole of any frame
   * with a modal up (the F1 sheet keeps pointer lock, so it genuinely does go on
   * collecting delta), and the console releases the pointer, which is what feeds
   * that delta in the first place. So the camera gets a zero-look update and
   * does only the part that is wanted: follow, damp, and re-place the lens.
   */
  followCamera(dt: number): void {
    this.cam.update(dt, this.input, this.position, this.onGround, this.world, this.engine.camera);
    this.engine.updateSunFocus(this.position);
  }

  update(dt: number): void {
    this.time += dt;
    const input = this.input;
    const world = this.world;

    // THE GROUND MOVES FIRST. If he is standing on something that travels, this
    // is where he travels with it — before gravity, before the step test, and
    // before the camera reads his position. Everything below then runs in world
    // space exactly as it always has and never learns that it was moved.
    //
    // Skipped in the saddle: `MountController` carries the pair of them and
    // writes this position, so running the frame here as well would apply the
    // island's motion to the hero twice.
    if (!this.isMounted) {
      this.carry();
    }

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
      // The sword works from the saddle, so the combo still ticks here. Only
      // LOCOMOTION belongs to the mount; the rider keeps his own arms.
      this.updateAttack(dt);
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
   * Top of everything SOLID at a column: terrain, a tree's bole, and whatever a
   * settlement has built there.
   *
   * Trees used to be scenery you walked straight through. A trunk is now an
   * obstacle you go around — but only the trunk. `trunkSolidTopAt` deliberately
   * ignores the crown (see world/index.ts): a canopy sits several units up, and
   * because this test compares a column's TOP against the feet, a solid crown
   * would read as an invisible wall ringing every tree and you could not walk
   * under one at all.
   *
   * TOWNS were scenery in exactly the same way until `structureTopAt` existed —
   * you walked through the huts, the palisade, the well and the crates. A
   * building needs no one-way trick, because unlike a canopy it is material
   * standing on the ground over its whole footprint; the reason it can be
   * blocked here without fencing off the world is that the FOOTPRINT already
   * left out anything a body walks under. That is measured at bake time, which
   * is what keeps the Encampment's gate an opening rather than a wall — see
   * world/structures.ts.
   *
   * Both queries return -Infinity from the world where there is nothing, so the
   * max is just the terrain there.
   */
  private blockTop(x: number, z: number): number {
    const ground = this.world.getHeight(x, z);
    const trunk = this.world.trunkSolidTopAt(x, z);
    let top = trunk > ground ? trunk : ground;
    const built = this.world.structureTopAt(x, z);
    if (built > top) top = built;
    // A CARRIER'S DECK IS GROUND, and is folded in here rather than being a
    // fourth kind of collision — the same argument `structureTopAt` makes about
    // settlements. It answers -Infinity unless he is actually riding one, which
    // is what makes it safe to ask with (x, z) alone: the vertical question was
    // settled by `CarrierRide.carry` at the top of this slice, and asking it
    // again with no y is exactly how a walker on the meadow would be teleported
    // onto an island passing overhead.
    const deck = this.ride.support(x, z);
    if (deck > top) top = deck;
    // ...and, ONLY while he is standing on a crown, the crown itself. Up there
    // the leaves under his feet are the floor, so the step test has to see the
    // next column's leaves or walking up the inside of the dome would step off
    // its uphill side into thin air.
    //
    // The condition is the whole reason a canopy can be walked on without also
    // being a wall. From the ground a crown is OVERHEAD, and a column whose top
    // is overhead is precisely what this test cannot distinguish from a cliff;
    // adding it unconditionally is the invisible fence around every tree that
    // trunkSolidTopAt exists to avoid. Anything BELOW the feet reads as a drop
    // in either case, so stepping off the rim is never refused.
    if (this.onCanopy) {
      const canopy = this.climbTop(x, z);
      if (canopy > top) top = canopy;
    }
    return top;
  }

  /**
   * The tree surface over a column — a canopy dome or a bole's top face — when
   * it stands clear enough of the terrain to be a platform of its own, else
   * -Infinity.
   *
   * `climbTopAt` already returns exactly this surface (it is the max of terrain,
   * bole top and dome), so no new world query was needed: subtracting the ground
   * out of it is all "is there a tree platform here?" amounts to. `ground` is
   * passed in because every caller has just measured it.
   */
  /**
   * Top of everything CLIMBABLE at a column — including whatever is carrying
   * him.
   *
   * THE CLIMB QUERY HAD THE SAME HOLE THE STEP TEST HAD. `World.climbTopAt`
   * knows about terrain, trees and the settlements standing on the ground; it
   * cannot know about a flying island, because a carrier's surface is only
   * answerable to a body that is riding one (it takes no `y`, and a deck two
   * hundred units up would otherwise be reported over a meadow). So on the
   * island nothing was climbable at all: `probeFace` asked for the wall of the
   * hut in front of him and got the terrain two hundred units below.
   *
   * `ride.support` is -Infinity unless he is actually attached, so everywhere
   * else in the world this is exactly the query it always was. Same argument,
   * same shape and the same one-line fold as `blockTop` — see `CarrierRide`.
   */
  private climbTop(x: number, z: number): number {
    const w = this.world.climbTopAt(x, z);
    const deck = this.ride.support(x, z);
    return deck > w ? deck : w;
  }

  private canopyTop(x: number, z: number, ground: number): number {
    const top = this.climbTop(x, z);
    // MEASURED AGAINST WHAT HE IS STANDING ON, not against the terrain. On a
    // carrier the terrain is hundreds of units below, so every column of the
    // deck would clear `ground` by miles and the whole island would read as one
    // enormous tree crown. The support branch in `update` happens to test solid
    // ground first and so never reaches the canopy case — but relying on the
    // order of two branches to keep a query honest is how the next change
    // breaks it.
    const base = Math.max(ground, this.ride.support(x, z));
    return top > base + CANOPY_MIN_CLEAR ? top : -Infinity;
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
      if (input.down('KeyC')) {
        // Swim DOWN, against the buoyancy rather than instead of it — see
        // DIVE_ACCEL. The bed catches him on the way: the vertical clamp
        // further down runs for a swimmer exactly as it does for a walker, so
        // there is no separate floor test here and no way to dive through the
        // world.
        this.velocity.y -= DIVE_ACCEL * dt;
        if (this.velocity.y < -DIVE_SPEED) this.velocity.y = -DIVE_SPEED;
      } else {
        // Buoyancy, CAPPED. Uncapped this is a spring on the distance to the
        // float line, which was harmless while nothing could get more than a
        // metre under it and turns into a cork the moment diving exists.
        const lift = Math.min((floatY - this.position.y) * 9, SWIM_RISE_MAX);
        this.velocity.y += (lift - this.velocity.y * 3.5) * dt;
      }
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

    // ---- what is holding him up ----
    // Two surfaces can, and they are not the same kind of thing.
    //
    // The TERRAIN is solid: it catches the feet from any direction and is what
    // beasts, enemies, the camera and every drop resolve against too.
    //
    // A TREE CROWN is a ONE-WAY PLATFORM. It has to be, and the reason is the
    // same one written on World.trunkSolidTopAt: a canopy is 7-10 units across
    // and sits several units up, so anything that blocks there also blocks at
    // ground level, and every tree in the world grows an invisible fence. Read
    // from below, the identical mistake is a ceiling — jumping under a tree
    // would bonk. So the crown only ever catches feet that STARTED the slice at
    // or above it and are on their way DOWN: falling onto it lands, walking on
    // it holds, and everything approaching from underneath passes straight
    // through as it always did.
    const gh = world.getHeight(this.position.x, this.position.z);
    // A STRUCTURE is a floor as well as a wall, and it is the same floor from
    // every direction — the exact opposite of a crown. The horizontal test above
    // only ever lets the hero's centre into a column whose top is within
    // MAX_STEP_UP of his feet, so the only box he can be standing over is one he
    // just stepped onto; catching him on it here is what makes a low crate
    // something you walk ON rather than something you sink into. Anything taller
    // he was refused at the wall, and anything he jumped onto he lands on.
    const built = world.structureTopAt(this.position.x, this.position.z);
    let floor = built > gh ? built : gh;
    // ...and the deck of whatever is carrying him, by the same rule and in the
    // same max. SOLID BOTH WAYS like a structure and unlike a canopy: he is
    // only ever asking this while he is inside the frame's own volume, so there
    // is no "from underneath" case for it to get wrong.
    const deck = this.ride.support(this.position.x, this.position.z);
    if (deck > floor) floor = deck;
    const canopy = this.canopyTop(this.position.x, this.position.z, gh);
    let support = -Infinity;
    if (this.position.y <= floor) {
      support = floor;                    // solid ground always wins
      this.onCanopy = false;
    } else if (
      canopy > -Infinity && this.velocity.y <= 0
      // One-way, with MAX_STEP_UP of slack so that walking UP the curve of a
      // dome he is already standing on is a step and not a wall. Deliberately
      // the same slack the horizontal step test uses: a move blockTop allowed
      // is therefore always a move this test can catch, and the two can never
      // disagree about whether he is still on the tree.
      && feetY >= canopy - MAX_STEP_UP
      // Either he crossed the surface this slice (a landing), or he is already
      // on it and it has only fallen away by a slope's worth (walking down the
      // dome). Past that he is off the edge and gravity has him.
      && (this.position.y <= canopy
        || (this.onCanopy && this.position.y - canopy < CANOPY_GLUE))
    ) {
      support = canopy;
      this.onCanopy = true;
    } else {
      // Nothing up here. This is also what a chunk unloading under a standing
      // player looks like — the crown simply stops being reported and he falls,
      // which is the same answer CLIMB_LOST gives when the face a climber is
      // holding disappears: fall, never snap.
      this.onCanopy = false;
    }

    if (support > -Infinity) {
      if (!this.onGround && this.velocity.y < -7) {
        this.landBump = clamp((-this.velocity.y - 6) / 13, 0, 1);
        _feet.set(this.position.x, support + 0.05, this.position.z);
        this.dust.burst(_feet, Math.min(14, Math.floor(-this.velocity.y)));
        // The same ramp the hero's own squash uses, so the cue and the body's
        // compression read one number. The shake this replaced only fired below
        // -15 while the squash starts at -7; the cue table keeps that gap as
        // `playerLanded.shakeMin`.
        this.bus.emit({ type: 'playerLanded', impact: this.landBump });
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

    // ---- speed norm for animation / beasts ----
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
    const top = this.climbTop(
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
    // Hanging, not standing: nothing is under his feet until he tops out.
    this.onCanopy = false;
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
    // Through `climbTop`, like every other climb query: the face he is holding
    // may belong to a building on a carrier, and the world query cannot see it.
    // Losing it here is not harmless — the branch below reads a vanished face as
    // "the wall fell out from under the hands" and drops him.
    const top = this.climbTop(
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

    // At the lip. Mantle if there is somewhere to stand, and the ledge column is
    // checked against everything that HOLDS WEIGHT — the terrain, or a crown
    // standing clear above it — not against the terrain alone.
    //
    // getHeight alone was the rule until crowns became standable, and it is why
    // topping out of a tree used to refuse: the ground under a canopy is metres
    // below the leaves, so `dest` never matched `top` and the hero stayed
    // clinging at full stretch. The level-with-what-we-climbed test still does
    // its original job — it is what stops a mantle onto a bole with nothing over
    // it from flinging him into the air — because a column that holds nothing
    // still answers with the distant ground.
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
        // Hand the vertical resolution the right floor for the next slice: it
        // is the flag, not the position, that tells the step test whether the
        // leaves under him count.
        this.onCanopy = dc > -Infinity;
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
      this.climbTop(nx + this.climbDirX * CLIMB_REACH, nz + this.climbDirZ * CLIMB_REACH)
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
        // In the saddle the swing comes from the RIDER and goes where he is
        // looking, not where the mount happens to be pointing. Two reasons: the
        // hero sits above the animal, so an arc struck at his own forward from
        // hip height lands in the mount's back; and mounted skills already aim
        // down the crosshair, so a sword that tracked the mount's nose instead
        // would be the one thing in the saddle that ignores where you aim.
        // MOUNTED_REACH pushes the origin out past the mount's own bulk, which
        // is what stops a swing from a 2.1-unit animal connecting with nothing.
        const mounted = this.isMounted;
        // getWorldDirection writes into the temp, so this allocates nothing.
        if (mounted) this.engine.camera.getWorldDirection(_dir);
        else _dir.copy(this.forward);
        _origin.copy(this.position);
        _origin.y += mounted ? MOUNTED_STRIKE_Y : 1.25;
        // AIM ASSIST BEFORE THE ORIGIN IS PUSHED OUT, because the push is along
        // the swing and the swing is what is about to move. Asked from the body,
        // not from the offset point: 0.35 units cannot change which enemy is
        // nearest the crosshair, and feeding it a point derived from the answer
        // would be circular.
        const steered = this.aimAssist?.(_origin, _dir) ?? false;
        _origin.addScaledVector(_dir, mounted ? MOUNTED_REACH : 0.35);
        // Square up to the swing that is actually being thrown. Without this the
        // arc — which is 100 degrees wide and drawn from `_dir` — can cut at up
        // to the assist cone away from the shoulders it comes out of, and reads
        // as a slash detached from the hero. A snap rather than a damp because
        // it happens ON the strike frame of a fast animation, where it reads as
        // a lunge; `targetHeading` goes on damping toward the camera from the
        // next slice, so nothing is left twisted.
        //
        // On foot only. In the saddle the heading belongs to the mount, and the
        // rider's swing already goes down the crosshair rather than along his
        // body — see the note above.
        if (steered && !mounted) {
          this.heading = Math.atan2(_dir.x, _dir.z);
          this.root.rotation.y = this.heading;
          this.forward.set(Math.sin(this.heading), 0, Math.cos(this.heading));
        }
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
      // Mounted is deliberately NOT excluded: the sword works from the saddle,
      // on the ground and in the air. Swimming and climbing still are — both
      // occupy the hands, and neither has a swing pose.
      input.attackPressed && this.attackCooldown <= 0
      && !this.isSwimming && !this.isClimbing
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
