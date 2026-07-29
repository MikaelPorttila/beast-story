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
 * Third-person orbit camera with spring-arm smoothing, terrain avoidance and
 * a light trauma-style shake for hits.
 */
export class ThirdPersonCamera {
  yaw = Math.PI;   // behind a character facing +Z
  pitch = 0.26;    // radians above the horizon (flatter = more hero on screen)
  // Pulled in from 8 so the hero fills ~20% of frame height instead of ~12%.
  private distTarget = 6.2;
  private dist = 6.2;
  private readonly pos = new THREE.Vector3();
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

  update(dt: number, input: Input, focus: THREE.Vector3, world: World, cam: THREE.PerspectiveCamera): void {
    if (input.pointerLocked) {
      this.yaw -= input.mouseDX * 0.0028;
      this.pitch += input.mouseDY * 0.0026;
    }
    this.pitch = clamp(this.pitch, -0.48, 1.25);
    this.distTarget = clamp(this.distTarget + input.wheelDelta * 0.01, 3.5, 11);
    this.dist += (this.distTarget - this.dist) * (1 - Math.exp(-8 * dt));

    // pivot at upper chest so the hero frames just below screen centre and the
    // aim marker sits above their head (Cube World framing)
    _pivot.set(focus.x, focus.y + 1.28, focus.z);
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
