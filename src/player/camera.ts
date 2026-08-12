import * as THREE from "three";
import type { Input, LookDelta } from "../core/input";
import type { World } from "../core/types";

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
 * Aim offset above the pivot, as a fraction of arm length so framing is
 * scale-free. Applied after the pitch clamp, so mouse-look clamps unchanged.
 */
const LOOK_LIFT = 0.16;

/**
 * Camera chases its own Y anchor, not focus.y: terrain floors to whole-unit
 * terraces, so a step would pitch the whole frame in one frame. Only Y is
 * smoothed; damping x/z drags the camera in turns.
 */
const STEP_LAMBDA = 12;
const AIR_LAMBDA = 30;
/** Caps anchor trail so a long fall cannot leave the camera metres behind. */
const MAX_STEP_LAG = 1.6;

/** Slower than the zoom damping (8) so a framing change reads as its own camera move. */
const DIST_SCALE_LAMBDA = 4.5;

export class ThirdPersonCamera {
  yaw = Math.PI; // behind a character facing +Z
  /** Radians above the horizon; pays back LOOK_LIFT's 9.1° up-tilt (-17.6° net view). */
  pitch = 0.46;
  private distTarget = 7.4;
  private dist = 7.4;
  /** Multiplier on the arm, on top of the wheel's zoom. 1 = hero framing. */
  private distScale = 1;
  private distScaleTarget = 1;
  /** World units BELOW the chest pivot to aim; mounted, the subject's middle is the saddle. */
  private pivotDrop = 0;
  private pivotDropTarget = 0;
  private readonly pos = new THREE.Vector3();
  /** Smoothed vertical anchor the pivot rides; see STEP_LAMBDA. */
  private followY = 0;
  private initialized = false;
  private shake = 0;
  private shakeT = 0;

  readonly forward = new THREE.Vector3(0, 0, 1);
  readonly right = new THREE.Vector3(1, 0, 0);

  addShake(amount: number): void {
    this.shake = Math.min(1, this.shake + amount);
  }

  /** Widen or restore the framing; (1, 0) is the hero on foot. */
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
    // TAKEN, not read: this runs per simulation slice, so a merely-read delta
    // applies once per slice (issue #37). Unconditional, ahead of the lookActive
    // gate, so a delta collected while look was off is dropped, not banked.
    input.takeLook(_lookIn);
    if (input.lookActive) {
      this.yaw -= _lookIn.dx * 0.0028;
      this.pitch += _lookIn.dy * 0.0026;
    }
    this.pitch = clamp(this.pitch, -0.48, 1.25);
    this.distTarget = clamp(this.distTarget + _lookIn.wheel * 0.01, 3.5, 16);
    this.dist += (this.distTarget - this.dist) * (1 - Math.exp(-8 * dt));
    const kFrame = 1 - Math.exp(-DIST_SCALE_LAMBDA * dt);
    this.distScale += (this.distScaleTarget - this.distScale) * kFrame;
    this.pivotDrop += (this.pivotDropTarget - this.pivotDrop) * kFrame;
    // One length for arm, avoidance midpoint and LOOK_LIFT: framing stays consistent.
    const arm = this.dist * this.distScale;

    // Must run before the pivot, which rides it; seeded so the camera never flies in from y=0.
    if (!this.initialized) {
      this.followY = focus.y;
    } else {
      const lambda = grounded ? STEP_LAMBDA : AIR_LAMBDA;
      this.followY += (focus.y - this.followY) * (1 - Math.exp(-lambda * dt));
      const lag = focus.y - this.followY;
      if (lag > MAX_STEP_LAG) {
        this.followY = focus.y - MAX_STEP_LAG;
      } else if (lag < -MAX_STEP_LAG) {
        this.followY = focus.y + MAX_STEP_LAG;
      }
    }

    // Pivot on the hero's own x/z keeps him on the frame centreline under the reticle.
    _pivot.set(focus.x, this.followY + 1.28 - this.pivotDrop, focus.z);
    const cp = Math.cos(this.pitch);
    _dir.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    _desired.copy(_pivot).addScaledVector(_dir, arm);

    _mid.copy(_pivot).addScaledVector(_dir, arm * 0.55);
    const midFloor = world.getHeight(_mid.x, _mid.z) + 0.35;
    if (_mid.y < midFloor) {
      _desired.y += (midFloor - _mid.y) * 1.7;
    }
    const endFloor = world.getHeight(_desired.x, _desired.z) + 0.45;
    if (_desired.y < endFloor) {
      _desired.y = endFloor;
    }

    if (!this.initialized) {
      this.pos.copy(_desired);
      this.initialized = true;
    } else {
      this.pos.lerp(_desired, 1 - Math.exp(-11 * dt));
    }
    const floorHere = world.getHeight(this.pos.x, this.pos.z) + 0.4;
    if (this.pos.y < floorHere) {
      this.pos.y = floorHere;
    }

    this.shake *= Math.exp(-5.5 * dt);
    this.shakeT += dt;
    const sh = this.shake * this.shake; // trauma curve: small hits stay subtle
    const sx = Math.sin(this.shakeT * 47.3) * 0.14 * sh;
    const sy = Math.sin(this.shakeT * 39.1 + 1.7) * 0.11 * sh;

    cam.position.set(this.pos.x + sx, this.pos.y + sy, this.pos.z - sx * 0.6);
    // Aim ABOVE the pivot, never at it — see LOOK_LIFT.
    _look.set(_pivot.x + sx * 0.7, _pivot.y + sy * 0.7 + arm * LOOK_LIFT, _pivot.z);
    cam.lookAt(_look);

    this.forward.set(_pivot.x - cam.position.x, 0, _pivot.z - cam.position.z);
    if (this.forward.lengthSq() < 1e-6) {
      this.forward.set(0, 0, 1);
    }
    this.forward.normalize();
    this.right.set(-this.forward.z, 0, this.forward.x);
  }
}
