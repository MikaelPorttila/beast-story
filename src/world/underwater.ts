/**
 * Scene-side half of the submerged frame: state, murk fog, bubbles. Colour and
 * caustics live in the output pass — a multiply in linear HDR ahead of ACES
 * cannot darken a bright subject (issue #23).
 */
import * as THREE from "three";
import { SURFACE_Y } from "./water";
import { flags } from "../core/flags";

/** Linear per-channel absorption the distance fades to. `fog.color` multiplies
 *  sky radiance, so this is what makes murk darker rather than brighter (#23). */
const WATER_ABSORB = new THREE.Color(0.06, 0.26, 0.58);

/** Daylight-exposure fraction when fully under: the tint is a multiply ahead of
 *  ACES, so a bright bed must be dimmed first or it just desaturates to white. */
const UNDER_EXPOSURE = 0.38;

const BUBBLE_VERT = /* glsl */ `
uniform float uScale;
attribute float aSize;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.15), 1.5, 46.0);
}
`;

const BUBBLE_FRAG = /* glsl */ `
uniform float uAmount;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  // Ring, not disc: a bubble is dark in the middle, bright at the rim.
  float rim = smoothstep(0.45, 0.92, r2) * (1.0 - smoothstep(0.92, 1.0, r2));
  float body = (1.0 - r2) * 0.10;
  // Overdriven: drawn before the tint quad, so it is multiplied down too.
  gl_FragColor = vec4(vec3(0.95, 1.25, 1.40) * (0.40 + rim * 1.2), (rim * 0.85 + body) * uAmount);
}
`;

const N_BUBBLES = 40;
/** Slab half-extents around the lens. Small on purpose: a wide slab put bubbles
 *  outside the view cone and recycled the rest under the lake bed. */
const BOX_XZ = 3.0;
const BAND_Y = 2.0;

export class Underwater {
  amount = 0;
  /** Metres of water over the lens, unsmoothed. */
  depth = 0;

  /** Daylight-exposure multiplier this frame — 1 in the air. main.ts feeds it to
   *  `Engine.setExposureScale`; this class owns no renderer. */
  get exposureScale(): number {
    return 1 + (UNDER_EXPOSURE - 1) * this.amount;
  }

  /** Per-channel Beer-Lambert multiplier, composed by Engine with time of day. */
  get fogAbsorption(): Readonly<THREE.Color> {
    return this.fogColor;
  }

  /** Effect clock, seconds. Frozen under `photo=1` so captures are reproducible. */
  get clock(): number {
    return flags.photo ? 7.0 : this.time;
  }

  private readonly bubbles: THREE.Points;
  private readonly bubbleMat: THREE.ShaderMaterial;
  private readonly bubblePos: Float32Array;
  private readonly bubbleVel: Float32Array;
  private readonly bubbleAttr: THREE.BufferAttribute;
  private time = 0;
  /** scene.fog's own distances, saved on the way in and put back on the way out. */
  private fogNear = 0;
  private fogFar = 0;
  private readonly fogColor = new THREE.Color(1, 1, 1);
  private fogSaved = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.bubblePos = new Float32Array(N_BUBBLES * 3);
    this.bubbleVel = new Float32Array(N_BUBBLES);
    const sizes = new Float32Array(N_BUBBLES);
    for (let i = 0; i < N_BUBBLES; i++) {
      this.bubblePos[i * 3] = (Math.random() * 2 - 1) * BOX_XZ;
      this.bubblePos[i * 3 + 1] = (Math.random() * 2 - 1) * BAND_Y;
      this.bubblePos[i * 3 + 2] = (Math.random() * 2 - 1) * BOX_XZ;
      // Small bubbles rise slower, so the field does not move as one sheet.
      sizes[i] = 0.035 + Math.random() * 0.075;
      this.bubbleVel[i] = 0.45 + sizes[i] * 6.0;
    }
    const geo = new THREE.BufferGeometry();
    this.bubbleAttr = new THREE.BufferAttribute(this.bubblePos, 3);
    this.bubbleAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.bubbleAttr);
    geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    this.bubbleMat = new THREE.ShaderMaterial({
      vertexShader: BUBBLE_VERT,
      fragmentShader: BUBBLE_FRAG,
      uniforms: { uAmount: { value: 0 }, uScale: { value: 400 } },
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.bubbles = new THREE.Points(geo, this.bubbleMat);
    // Rewritten around a moving camera, so any bounding volume is a lie.
    this.bubbles.frustumCulled = false;
    this.bubbles.renderOrder = 8999;
    this.bubbles.visible = false;
    this.bubbles.userData.bsNoBloom = true;
    this.scene.add(this.bubbles);
  }

  /** Call once per frame, AFTER the camera is placed. `overWater` is World.isWater
   *  for the column under the lens — without it a deep pit tints the screen. */
  update(dt: number, overWater: boolean): void {
    this.time += dt;
    const submerged = overWater ? SURFACE_Y - this.camera.position.y : -1;
    this.depth = Math.max(0, submerged);
    // 45 cm ramp: shorter pops at the waterline, longer half-tints chest-deep.
    const target = Math.max(0, Math.min(1, submerged / 0.45));
    // lambda 14 (~0.2 s); covers the isWater gate flipping along a shoreline.
    this.amount += (target - this.amount) * (1 - Math.exp(-14 * dt));
    if (this.amount < 0.002) {
      this.amount = 0;
      if (this.bubbles.visible) {
        this.bubbles.visible = false;
      }
      this.restoreFog();
      return;
    }

    this.bubbles.visible = true;
    this.bubbleMat.uniforms.uAmount.value = this.amount;
    // gl_PointSize is device pixels; projection element 5 is 1/tan(fovY/2), so
    // this survives a resize and the ?photo= framings with no resize hook.
    this.bubbleMat.uniforms.uScale.value =
      this.camera.projectionMatrix.elements[5] * this.canvas.height * 0.5;

    // Murk: same Fog instance and program permutation, so nothing recompiles.
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog && (fog as THREE.Fog).isFog) {
      if (!this.fogSaved) {
        this.fogNear = fog.near;
        this.fogFar = fog.far;
        this.fogSaved = true;
      }
      // 4 / 40 under: not tighter, in-scattering keeps deep water from going black.
      this.tintLerpFog(fog, 4, 40);
    }

    const cx = this.camera.position.x;
    const cy = this.camera.position.y;
    const cz = this.camera.position.z;
    const p = this.bubblePos;
    // Cap at the surface too: a bubble drawn above the waterline reads as a bug.
    const ceiling = Math.min(cy + BAND_Y, SURFACE_Y - 0.08);
    for (let i = 0; i < N_BUBBLES; i++) {
      const k = i * 3;
      p[k + 1] += this.bubbleVel[i] * dt;
      // Sideways wobble, out of phase per bubble so they do not shoal.
      p[k] += Math.sin(this.time * 1.7 + i * 1.3) * dt * 0.16;
      p[k + 2] += Math.cos(this.time * 1.4 + i * 2.1) * dt * 0.16;
      if (p[k + 1] > ceiling) {
        p[k + 1] = cy - BAND_Y;
        p[k] = cx + (Math.random() * 2 - 1) * BOX_XZ;
        p[k + 2] = cz + (Math.random() * 2 - 1) * BOX_XZ;
      }
      // Toroidal wrap, so a drifting bubble keeps its height and phase.
      const dx = p[k] - cx;
      if (dx > BOX_XZ) {
        p[k] -= BOX_XZ * 2;
      } else if (dx < -BOX_XZ) {
        p[k] += BOX_XZ * 2;
      }
      const dz = p[k + 2] - cz;
      if (dz > BOX_XZ) {
        p[k + 2] -= BOX_XZ * 2;
      } else if (dz < -BOX_XZ) {
        p[k + 2] += BOX_XZ * 2;
      }
      // Camera dropped fast (dive or teleport): pull stragglers back into the slab.
      if (p[k + 1] < cy - BAND_Y * 2) {
        p[k + 1] = cy - BAND_Y;
      }
    }
    this.bubbleAttr.needsUpdate = true;
  }

  private tintLerpFog(fog: THREE.Fog, near: number, far: number): void {
    fog.near = this.fogNear + (near - this.fogNear) * this.amount;
    fog.far = this.fogFar + (far - this.fogFar) * this.amount;
    // Per-channel absorption on the sky (installAerialPerspective); linear-sRGB.
    this.fogColor.setRGB(
      1 + (WATER_ABSORB.r - 1) * this.amount,
      1 + (WATER_ABSORB.g - 1) * this.amount,
      1 + (WATER_ABSORB.b - 1) * this.amount,
    );
  }

  private restoreFog(): void {
    if (!this.fogSaved) {
      return;
    }
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog && (fog as THREE.Fog).isFog) {
      fog.near = this.fogNear;
      fog.far = this.fogFar;
    }
    this.fogColor.setRGB(1, 1, 1);
    this.fogSaved = false;
  }

  /** Link the bubble program once: a first-use link stalls the GPU, and the frame
   *  you first go under is the worst moment to pay it (warmUpShaders in main.ts).
   *  Alpha is non-zero so the points actually rasterise. */
  warmUp(render: () => void): void {
    this.bubbles.visible = true;
    this.bubbleMat.uniforms.uAmount.value = 0.002;
    const p = this.bubblePos;
    for (let i = 0; i < N_BUBBLES; i++) {
      p[i * 3] = this.camera.position.x + (i % 5) * 0.1 - 0.2;
      p[i * 3 + 1] = this.camera.position.y;
      p[i * 3 + 2] = this.camera.position.z - 2 - (i % 3) * 0.3;
    }
    this.bubbleAttr.needsUpdate = true;
    this.bubbleMat.uniforms.uScale.value =
      this.camera.projectionMatrix.elements[5] * this.canvas.height * 0.5;
    render();
    this.bubbles.visible = false;
    this.bubbleMat.uniforms.uAmount.value = 0;
  }

  dispose(): void {
    this.restoreFog();
    this.scene.remove(this.bubbles);
    this.bubbles.geometry.dispose();
    this.bubbleMat.dispose();
  }
}
