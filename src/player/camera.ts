import * as THREE from 'three';
import type { Input } from '../core/input';
import type { World } from '../core/types';

const _dir = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _look = new THREE.Vector3();

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

/**
 * Lateral over-the-shoulder offset, in metres along camera-right. The hero used
 * to sit dead-centre, which put his hat directly under the reticle; shifting the
 * pivot sideways parks him left of centre so the crosshair looks at clear world.
 */
const SHOULDER_OFFSET = 0.6;

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
 * Third-person orbit camera with spring-arm smoothing, terrain avoidance and
 * a light trauma-style shake for hits.
 */
export class ThirdPersonCamera {
  yaw = Math.PI;   // behind a character facing +Z
  pitch = 0.35;    // radians above the horizon (flatter = more hero on screen)
  // Pulled back from 6.2: at close range the hero blocked the aim point and the
  // world read as a corridor. 7.4 keeps him readable with room to see ahead.
  private distTarget = 7.4;
  private dist = 7.4;
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

  update(
    dt: number,
    input: Input,
    focus: THREE.Vector3,
    grounded: boolean,
    world: World,
    cam: THREE.PerspectiveCamera,
  ): void {
    // lookActive covers both captured-mouse and touch look-drag.
    if (input.lookActive) {
      this.yaw -= input.mouseDX * 0.0028;
      this.pitch += input.mouseDY * 0.0026;
    }
    this.pitch = clamp(this.pitch, -0.48, 1.25);
    this.distTarget = clamp(this.distTarget + input.wheelDelta * 0.01, 3.5, 11);
    this.dist += (this.distTarget - this.dist) * (1 - Math.exp(-8 * dt));

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

    // pivot at upper chest so the hero frames just below screen centre, then
    // slid along camera-right so he sits off-centre and no longer occludes his
    // own reticle. Camera-right for this yaw is (cos yaw, 0, -sin yaw); the
    // offset lands on the pivot, so the arm origin and the look target (which
    // is derived from the pivot below) move together and framing stays stable.
    _pivot.set(
      focus.x + Math.cos(this.yaw) * SHOULDER_OFFSET,
      this.followY + 1.28,
      focus.z - Math.sin(this.yaw) * SHOULDER_OFFSET,
    );
    const cp = Math.cos(this.pitch);
    _dir.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    _desired.copy(_pivot).addScaledVector(_dir, this.dist);

    // never sink below terrain: check endpoint plus a midpoint along the arm
    _mid.copy(_pivot).addScaledVector(_dir, this.dist * 0.55);
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
    _look.set(_pivot.x + sx * 0.7, _pivot.y + sy * 0.7, _pivot.z);
    cam.lookAt(_look);

    this.forward.set(_pivot.x - cam.position.x, 0, _pivot.z - cam.position.z);
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, 1);
    this.forward.normalize();
    // screen-right = forward x up
    this.right.set(-this.forward.z, 0, this.forward.x);
  }
}
