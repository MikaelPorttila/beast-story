import * as THREE from 'three';
import type { Input, LookDelta } from '../core/input';
import type { World } from '../core/types';

const _dir = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _look = new THREE.Vector3();
/** Scratch for `Input.takeLook`; a slice must not allocate. */
const _lookIn: LookDelta = { dx: 0, dy: 0, wheel: 0 };

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

/**
 * Framing: centred hero, reticle in the clear space above his head.
 *
 * History. The hero first sat dead-centre with the camera looking straight AT
 * the pivot, which put his hat directly under the reticle. That was solved by a
 * lateral over-the-shoulder offset (`SHOULDER_OFFSET = 0.6` m along camera-right,
 * applied to the pivot so arm origin and look target moved together), parking him
 * left of centre so the crosshair looked at clear world.
 *
 * That trade is now reversed: the brief is a centred hero, not an
 * over-the-shoulder camera. The lateral offset is gone — the pivot is once again
 * the focus in x/z, so the hero lands on the vertical screen centreline — and the
 * occlusion it existed to prevent is instead solved VERTICALLY, by aiming the
 * camera above the hero rather than at him.
 *
 * LOOK_LIFT is that aim offset, expressed as a fraction of the arm length so the
 * framing is scale-free: the look target rides `dist * LOOK_LIFT` above the pivot,
 * so the on-screen drop is `LOOK_LIFT / tan(fov/2) / 2` of the viewport height no
 * matter where the wheel has left the zoom (3.5–16 m). It is a constant tilt added
 * after the pitch clamp, not a change to `pitch`, so mouse-look still clamps
 * exactly as before.
 *
 * 0.16 measured in-game at 1280x720, fov 55, dist 7.4, by projecting
 * __dbgPlayerPos through __dbgCam: the chest pivot lands at x=640.0 (exactly the
 * viewport centreline, i.e. under the reticle) and y=467 — 107 px, ~0.148 of the
 * viewport, below the reticle at y=360, which it used to sit dead on. The top of
 * the hat measures y≈425, so there is roughly one head of clear world between the
 * hero and the crosshair. Smaller values close that gap back onto the hat; much
 * larger ones push him toward the hotbar and eat the near ground.
 *
 * It also costs 9.1° of downward view (atan 0.16), which is why the default
 * `pitch` below was raised to pay it back.
 */
const LOOK_LIFT = 0.16;

/**
 * Vertical follow smoothing — "step smoothing".
 *
 * Terrain collision is STEPPED: Terrain.getHeight floors the continuous height,
 * so the walkable surface is whole-unit terraces and Player.updateAlive snaps
 * position.y straight onto it. Walking up a hill or a den's stairs therefore
 * moves the hero a FULL UNIT between two frames.
 *
 * The pivot below is both the arm origin and the look target, and it used to
 * read focus.y directly. The arm survived it — this.pos is damped, so it merely
 * lurched — but the look target was not damped at all, so the entire frame
 * pitched a unit's worth in one frame every time the hero climbed a step. That
 * is the "camera teleports" read: the character walks up, the world snaps.
 *
 * The fix is the one every third-person game uses: the camera follows its own
 * vertical anchor that chases the character, rather than reading the character's
 * Y. (Unreal solves the same discontinuity from the other end — after a step-up
 * the character's mesh keeps a translation offset that is interpolated away.)
 * Only Y is smoothed. Horizontal motion is velocity-driven and already
 * continuous, and damping x/z as well makes the camera feel dragged in turns.
 *
 * Two rates, because grounded and airborne want opposite things:
 *
 *   GROUNDED 12  A 1-unit step becomes a glide: 63% in 83 ms, ~95% in 250 ms.
 *                Fast enough to read as the camera keeping up with the hero,
 *                slow enough that the discontinuity never lands in one frame.
 *                Note the arm gets this IN SERIES with its own damping, so the
 *                rate is deliberately higher than it would be on its own.
 *   AIRBORNE 30  A jump or a fall is a deliberate arc the player is steering,
 *                and it is already smooth in Y — there is no discontinuity to
 *                hide, and lagging it drifts the hero toward the top of the
 *                frame on the way up. This effectively tracks; it exists so that
 *                walking off a ledge does not SNAP whatever step offset is still
 *                decaying at that moment.
 *
 * MAX_STEP_LAG caps how far the anchor may trail, so a long fall cannot leave
 * the camera hanging metres above the hero while an exponential catches up.
 */
const STEP_LAMBDA = 12;
const AIR_LAMBDA = 30;
const MAX_STEP_LAG = 1.6;

/**
 * How fast the arm-length multiplier eases between framings. Only mounting
 * moves it today, and it is deliberately slower than the zoom damping (8): the
 * pull-back is a framing change that should read as a camera move of its own,
 * not as the wheel being spun for you. ~0.5 s to 90%.
 */
const DIST_SCALE_LAMBDA = 4.5;

/**
 * Third-person orbit camera with spring-arm smoothing, terrain avoidance and
 * a light trauma-style shake for hits.
 */
export class ThirdPersonCamera {
  yaw = Math.PI;   // behind a character facing +Z
  // Radians above the horizon (flatter = more hero on screen). Was 0.35 back
  // when the camera looked straight AT the pivot and the arm angle WAS the view
  // angle. LOOK_LIFT now tilts the view up 9.1° on top of the arm, so 0.35 left
  // the game looking only 11° down: sky filled the upper third and the ground
  // the hero walks on fell away. 0.46 measures -17.6° of view pitch, close to
  // the -20.0° the 0.35 arm used to give, and the extra 2.4° of forward view is
  // welcome now that the hero no longer sits off to one side of it.
  pitch = 0.46;
  // Pulled back from 6.2: at close range the hero blocked the aim point and the
  // world read as a corridor. 7.4 keeps him readable with room to see ahead.
  private distTarget = 7.4;
  private dist = 7.4;
  /**
   * Multiplier on the arm, on top of the wheel's own zoom. The subject changes
   * size — a mounted hero plus his mount is roughly twice the silhouette of the
   * hero alone — and the honest fix is to stand further back, not to redefine
   * the zoom range the player has been scrolling through. 1 = hero framing.
   */
  private distScale = 1;
  private distScaleTarget = 1;
  /**
   * How far BELOW the usual chest pivot to aim, in world units. The pivot is
   * what lands on the framing sweet spot, and mounted the subject is not the
   * hero but the hero-and-mount pair, whose middle is roughly the saddle — a
   * pivot left at the rider's chest pushes the mount itself down into the
   * hotbar. 0 = the hero's own framing.
   */
  private pivotDrop = 0;
  private pivotDropTarget = 0;
  private readonly pos = new THREE.Vector3();
  /** Smoothed vertical anchor the pivot rides; see STEP_LAMBDA. */
  private followY = 0;
  private initialized = false;
  private shake = 0;
  private shakeT = 0;

  /** horizontal camera forward, updated every frame (used for movement) */
  readonly forward = new THREE.Vector3(0, 0, 1);
  /** horizontal camera right */
  readonly right = new THREE.Vector3(1, 0, 0);

  addShake(amount: number): void {
    this.shake = Math.min(1, this.shake + amount);
  }

  /**
   * Widen or restore the framing. Parameterised rather than forked: mounting
   * needs a longer arm (the subject is bigger) and a lower aim point (the
   * subject's middle moved down to the saddle), and both fall out of numbers
   * that are already here. (1, 0) is the hero on foot.
   */
  setFraming(distScale: number, pivotDrop: number): void {
    this.distScaleTarget = distScale;
    this.pivotDropTarget = pivotDrop;
  }

  update(
    dt: number,
    input: Input,
    focus: THREE.Vector3,
    grounded: boolean,
    world: World,
    cam: THREE.PerspectiveCamera,
  ): void {
    // TAKEN, not read. This method runs once per SIMULATION SLICE and a rendered
    // frame drains anywhere from none to MAX_STEPS of them, so a delta merely
    // read here is applied once per slice — sensitivity multiplied by the frame's
    // slice count, and a hitch mid-fight spending the whole hitch's worth of
    // mouse movement four times over. That is issue #37; see Input.takeLook for
    // the measurements. Unconditional, ahead of the `lookActive` gate: a delta
    // collected while look was inactive has to be dropped rather than banked for
    // whenever it comes back.
    input.takeLook(_lookIn);
    // lookActive covers both captured-mouse and touch look-drag.
    if (input.lookActive) {
      this.yaw -= _lookIn.dx * 0.0028;
      this.pitch += _lookIn.dy * 0.0026;
    }
    this.pitch = clamp(this.pitch, -0.48, 1.25);
    // Zoom range. The far end was 11 m, which framed the hero but left no room
    // to read a fight or a settlement around him; 16 m gives roughly a third
    // more world on screen at the same fov without the hero shrinking past
    // legibility (he is ~1.8 m, ~7% of a 720p frame height at 16 m).
    this.distTarget = clamp(this.distTarget + _lookIn.wheel * 0.01, 3.5, 16);
    this.dist += (this.distTarget - this.dist) * (1 - Math.exp(-8 * dt));
    const kFrame = 1 - Math.exp(-DIST_SCALE_LAMBDA * dt);
    this.distScale += (this.distScaleTarget - this.distScale) * kFrame;
    this.pivotDrop += (this.pivotDropTarget - this.pivotDrop) * kFrame;
    // Everything downstream — the arm, the terrain-avoidance midpoint and the
    // scale-free LOOK_LIFT — reads this one length, so the framing stays
    // self-consistent at any zoom and any scale.
    const arm = this.dist * this.distScale;

    // Vertical anchor: chase focus.y instead of reading it, so a terrace step
    // becomes a glide. Runs before the pivot because the pivot rides it, and it
    // seeds itself on the first frame so the camera does not fly in from y=0.
    if (!this.initialized) {
      this.followY = focus.y;
    } else {
      const lambda = grounded ? STEP_LAMBDA : AIR_LAMBDA;
      this.followY += (focus.y - this.followY) * (1 - Math.exp(-lambda * dt));
      const lag = focus.y - this.followY;
      if (lag > MAX_STEP_LAG) this.followY = focus.y - MAX_STEP_LAG;
      else if (lag < -MAX_STEP_LAG) this.followY = focus.y + MAX_STEP_LAG;
    }

    // pivot at upper chest, on the hero's own x/z: the arm orbits him and the
    // look target is derived from this point, so he stays on the vertical
    // centreline of the frame directly under the reticle. (This used to carry a
    // camera-right shoulder offset — see LOOK_LIFT for why it went.)
    _pivot.set(focus.x, this.followY + 1.28 - this.pivotDrop, focus.z);
    const cp = Math.cos(this.pitch);
    _dir.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    _desired.copy(_pivot).addScaledVector(_dir, arm);

    // never sink below terrain: check endpoint plus a midpoint along the arm
    _mid.copy(_pivot).addScaledVector(_dir, arm * 0.55);
    const midFloor = world.getHeight(_mid.x, _mid.z) + 0.35;
    if (_mid.y < midFloor) _desired.y += (midFloor - _mid.y) * 1.7;
    const endFloor = world.getHeight(_desired.x, _desired.z) + 0.45;
    if (_desired.y < endFloor) _desired.y = endFloor;

    if (!this.initialized) {
      this.pos.copy(_desired);
      this.initialized = true;
    } else {
      this.pos.lerp(_desired, 1 - Math.exp(-11 * dt));
    }
    // hard guarantee after smoothing
    const floorHere = world.getHeight(this.pos.x, this.pos.z) + 0.4;
    if (this.pos.y < floorHere) this.pos.y = floorHere;

    // shake: decaying pseudo-random wobble
    this.shake *= Math.exp(-5.5 * dt);
    this.shakeT += dt;
    const sh = this.shake * this.shake; // trauma curve: small hits stay subtle
    const sx = Math.sin(this.shakeT * 47.3) * 0.14 * sh;
    const sy = Math.sin(this.shakeT * 39.1 + 1.7) * 0.11 * sh;

    cam.position.set(this.pos.x + sx, this.pos.y + sy, this.pos.z - sx * 0.6);
    // Aim ABOVE the pivot, never at it: the aim point is what lands dead centre
    // of frame, so lifting it drops the hero below the reticle without touching
    // this.pitch (and therefore without touching its clamp). Scaled by the arm
    // length so the on-screen drop is the same at every zoom — see LOOK_LIFT.
    _look.set(_pivot.x + sx * 0.7, _pivot.y + sy * 0.7 + arm * LOOK_LIFT, _pivot.z);
    cam.lookAt(_look);

    this.forward.set(_pivot.x - cam.position.x, 0, _pivot.z - cam.position.z);
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, 1);
    this.forward.normalize();
    // screen-right = forward x up
    this.right.set(-this.forward.z, 0, this.forward.x);
  }
}
