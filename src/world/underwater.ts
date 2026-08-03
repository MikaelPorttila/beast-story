/**
 * Underwater view: what the frame looks like when the CAMERA is below the water
 * surface.
 *
 * The camera, not the player. A third-person camera trails the hero and pitches
 * down, so it dips under while he is still standing in the shallows with his
 * head in the air — and the moment it does, the frame is being shot through
 * water and has to say so. Before this, swimming out of your depth simply
 * clipped the camera through the surface and the world carried on looking like a
 * sunny afternoon with a blue plane somewhere behind the lens.
 *
 * Three parts, in descending order of how much they matter:
 *
 *  1. TINT. One screen-space quad, blue-green, alpha rising with how far under
 *     the surface the lens is. It is the whole read: everything else is texture
 *     on top of it.
 *  2. MURK. The scene's own fog, pulled in from 130/270 units to a couple of
 *     units / thirty. Distance falloff for free, on every material at once, with
 *     no new programs and no second pass — three's fog uniforms are per-frame
 *     values, so this is two number writes. Restored exactly on the way out.
 *  3. BUBBLES. Forty points drifting up past the lens. Cheap, and the only part
 *     of the effect that MOVES independently of the camera, which is what stops
 *     the tint reading as a coloured gel taped over the screen.
 *
 * Everything keys off one smoothed 0..1 `amount`, so entering and leaving are
 * the same ramp run in opposite directions and there is no flash at the
 * boundary. At amount 0 both objects are `visible = false` and the fog is back
 * to its own values, i.e. a frame with the camera in the air costs exactly what
 * it cost before this file existed.
 */
import * as THREE from 'three';
import { SURFACE_Y } from './water';

/**
 * THE TINT MULTIPLIES, IT DOES NOT MIX, and that decision is the difference
 * between "submerged" and "someone taped a gel over the lens".
 *
 * The first version was an alpha mix toward a teal, and it photographed
 * (_wat-under.png) as a pale foggy room with no contrast anywhere: at any weight
 * strong enough to colour the frame, a mix also flattens every value in it
 * toward one number, and it fights the murk fog rather than composing with it —
 * the fog fades distance toward the SKY gradient (bright, see
 * installAerialPerspective in core/engine.ts), and mixing a pale teal over a
 * pale sky gives pale teal.
 *
 * Absorption is multiplicative in life (Beer-Lambert) and it is multiplicative
 * here: red goes first, then green, and blue survives. Multiplying keeps every
 * bit of the scene's own structure — the bed's shading, the terraces, a beast
 * swimming past — and simply drains the warm end out of it. And it composes
 * exactly right with the fog: fog ADDS the in-scattered light that makes deep
 * water glow rather than go black, this SUBTRACTS the absorbed part, which
 * between them is most of what an underwater image is.
 *
 * These are per-channel multipliers, so 1.0 is "no water". `amount` lerps them
 * from white, which is why entering and leaving cannot flash: at amount 0 the
 * quad is a no-op that is not even drawn.
 *
 * THE BLUE CHANNEL IS OVER 1.0 ON PURPOSE. A pure absorption filter can only
 * ever take light away, and the thing it has least of to take away in this world
 * is blue: the lake bed is SAND, roughly (0.9, 0.8, 0.5) linear, so multiplying
 * it by any tint at all leaves g > b and the frame comes back YELLOW-GREEN — a
 * swamp, not a lagoon (measured, first multiply pass). Real water fixes this
 * with in-scattered skylight, which a single blended quad cannot add and take
 * away in the same pass. Lifting blue past unity buys the same result for one
 * multiply: the bed goes cyan because its blue is being AMPLIFIED while its red
 * is being eaten, and the ordering b > g > r that says "underwater" is restored
 * without a second fullscreen pass.
 */
const SHALLOW_TINT = new THREE.Color(0.38, 0.80, 1.28);
/** Deeper down: red is gone and green is going. */
const DEEP_TINT = new THREE.Color(0.10, 0.42, 0.92);

/**
 * What the DISTANCE fades to, as a per-channel filter on the sky.
 *
 * This is the other half of the same absorption argument, and until issue #23
 * there was no way to state it. The patched fog chunk fades a fragment toward
 * `bsSkyRadiance(elevation)` — the point of aerial perspective — so underwater
 * more fog meant BRIGHTER, not murkier, and the far wall of a lake dissolved
 * into daylight. The file already knew: the murk numbers below were pulled from
 * 2.5/34 back to 6/48 to keep the white-out off the near ground, which treated
 * the symptom and cost the murk. Captured at that setting, a lens 2.08 units
 * under the surface photographed as an almost white room with a faint blue cast
 * — "everything becomes super shiny", which is the issue.
 *
 * `scene.fog.color` is now a multiplier on that sky radiance and is WHITE above
 * water, so this is the only thing in the game that darkens it. The numbers are
 * linear and they are a FILTER, not a colour: red is nearly all gone by the far
 * wall, green is halved, and blue is the one that survives, which is the same
 * ordering SHALLOW_TINT argues for and the reason the two compose instead of
 * fighting. Blue is deliberately well under 1.0 here where the tint's is over
 * it: the tint has to ADD apparent in-scattering to a directly-lit near field,
 * where this is the far field, and the far field is the part that should go
 * dark and blue rather than bright and blue.
 */
const WATER_ABSORB = new THREE.Color(0.06, 0.26, 0.58);

/**
 * Fraction of the daylight exposure the frame is graded at when fully under.
 *
 * The tint above is a MULTIPLY and it lands on linear HDR radiance, before ACES
 * — so on a bright subject it cannot win. Sunlit lake bed renders near 2.6
 * linear; 0.38 of that is still 1.0, which ACES takes to 201/255 and
 * desaturates on the way. That is the whole of "everything becomes super shiny":
 * measured, a lens 2.14 units under photographed at (201, 226, 232), saturation
 * 0.131, against the same frame with `?post=0` — where the multiply lands after
 * the curve instead — at (75, 175, 255), saturation 0.707.
 *
 * The fix is not to move the tint after tone mapping, because absorption really
 * does happen in the scene. It is that there IS less light down there, and the
 * exposure is the thing that says so. 0.45 puts the tinted radiance back on the
 * part of the ACES curve that still carries chroma, which is what lets the tint
 * and WATER_ABSORB do the job they were always written to do.
 *
 * Not lower: the bubbles and the near bed still have to READ. Not higher: by
 * about 0.6 the bed's own highlights start climbing the shoulder again and the
 * blue drains back out. It ramps with `amount`, so surfacing is the same curve
 * run backwards and there is no step at the waterline.
 */
const UNDER_EXPOSURE = 0.38;

const TINT_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  // Straight to clip space. The quad is a screen-space overlay, so it must not
  // depend on the camera at all — no projection, no view matrix, no aspect
  // correction to get wrong on resize.
  gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
}
`;

const TINT_FRAG = /* glsl */ `
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform float uAmount;
uniform float uDepth;
uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 d = vUv - 0.5;
  float r = length(d) * 1.42;
  // Depth mixes the two stops; the vignette mixes them again toward the frame
  // edge, where a longer sight line through the water means more of it.
  vec3 col = mix(uShallow, uDeep, clamp(uDepth * 0.20, 0.0, 1.0));
  col = mix(col, col * uDeep * 1.35, smoothstep(0.28, 1.05, r));
  // Slow caustic-ish banding, two crossed low-frequency waves. Deliberately
  // faint (+-5%): this is the surface shifting overhead, not a light show, and
  // anything stronger on a full-screen quad reads as a shader bug.
  float caust = sin(vUv.x * 9.0 + uTime * 0.9) * sin(vUv.y * 7.0 - uTime * 0.7);
  col *= 1.0 + caust * 0.05;
  // The ramp: at uAmount 0 this is exactly white, i.e. a multiply by 1, i.e.
  // nothing. That is what makes the boundary flash-free without any special
  // case — the effect fades through "clear water" rather than through "half a
  // teal sheet".
  gl_FragColor = vec4(mix(vec3(1.0), col, uAmount), 1.0);
}
`;

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
  // A ring, not a disc. A bubble is a lens: it is dark in the middle (you are
  // looking through it) and bright at the rim (total internal reflection).
  // Filled discs at this size read as dust or as dead pixels.
  float rim = smoothstep(0.45, 0.92, r2) * (1.0 - smoothstep(0.92, 1.0, r2));
  float body = (1.0 - r2) * 0.10;
  // Overdriven radiance, for the same arithmetic reason the surf on the beach is
  // (see world/water.ts): these are drawn BEFORE the tint quad, so they are
  // multiplied down with everything else, and a bubble at the water's own
  // brightness is a bubble you cannot see.
  gl_FragColor = vec4(vec3(0.95, 1.25, 1.40) * (0.40 + rim * 1.2), (rim * 0.85 + body) * uAmount);
}
`;

/** How many bubbles drift around the lens. */
const N_BUBBLES = 40;
/**
 * Half-extent of the slab they wrap inside, centred on the camera. Deliberately
 * SMALL, and the first version's 5.5 in every direction is why the first
 * underwater capture had no bubbles in it at all:
 *
 *  - horizontally, 40 bubbles spread over an 11x11 box put almost none inside a
 *    55-degree cone, and the few that were there were 4-5 units out and a couple
 *    of pixels across;
 *  - vertically it was worse than sparse, it was WRONG. A bubble that rises past
 *    the surface is recycled to the bottom of the slab, which at 5.5 was several
 *    units under the lake bed — so most of the field spent its life buried in
 *    terrain, correctly depth-tested away.
 *
 * A 3-unit-wide, 2-unit-tall slab hugging the lens keeps every bubble in frame,
 * in open water, and big enough to read as a ring.
 */
const BOX_XZ = 3.0;
const BAND_Y = 2.0;

export class Underwater {
  /** 0..1, smoothed. Public so main can report it and tests can assert on it. */
  amount = 0;
  /** Metres of water over the lens, unsmoothed. */
  depth = 0;

  /**
   * What to multiply the daylight exposure by this frame — 1 in the air.
   *
   * Read by main.ts into `Engine.setExposureScale`. It is a value rather than a
   * call because this class owns no renderer and should not grow one: it knows
   * how deep the lens is, and the engine knows what to do about it.
   */
  get exposureScale(): number {
    return 1 + (UNDER_EXPOSURE - 1) * this.amount;
  }

  private readonly tint: THREE.Mesh;
  private readonly tintMat: THREE.ShaderMaterial;
  private readonly bubbles: THREE.Points;
  private readonly bubbleMat: THREE.ShaderMaterial;
  private readonly bubblePos: Float32Array;
  private readonly bubbleVel: Float32Array;
  private readonly bubbleAttr: THREE.BufferAttribute;
  private time = 0;
  /** scene.fog's own values, saved on the way in and put back on the way out. */
  private fogNear = 0;
  private fogFar = 0;
  private readonly fogColor = new THREE.Color(1, 1, 1);
  private fogSaved = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.tintMat = new THREE.ShaderMaterial({
      vertexShader: TINT_VERT,
      fragmentShader: TINT_FRAG,
      uniforms: {
        uShallow: { value: new THREE.Vector3(SHALLOW_TINT.r, SHALLOW_TINT.g, SHALLOW_TINT.b) },
        uDeep: { value: new THREE.Vector3(DEEP_TINT.r, DEEP_TINT.g, DEEP_TINT.b) },
        uAmount: { value: 0 },
        uDepth: { value: 0 },
        uTime: { value: 0 },
      },
      transparent: true,
      blending: THREE.MultiplyBlending,
      // No depth at all: it covers the frame unconditionally, including the sky
      // dome and every transparent VFX that drew before it. depthWrite off so it
      // cannot poison anything that draws after.
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    this.tint = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.tintMat);
    // Last, over everything. The transparent list is sorted by renderOrder first.
    this.tint.renderOrder = 9000;
    this.tint.frustumCulled = false;
    this.tint.visible = false;
    // Not a bloom source: a full-frame quad fed to the emissive pass would bloom
    // the entire image. See tagSources() in core/post.ts.
    this.tint.userData.bsNoBloom = true;
    this.scene.add(this.tint);

    this.bubblePos = new Float32Array(N_BUBBLES * 3);
    this.bubbleVel = new Float32Array(N_BUBBLES);
    const sizes = new Float32Array(N_BUBBLES);
    for (let i = 0; i < N_BUBBLES; i++) {
      this.bubblePos[i * 3] = (Math.random() * 2 - 1) * BOX_XZ;
      this.bubblePos[i * 3 + 1] = (Math.random() * 2 - 1) * BAND_Y;
      this.bubblePos[i * 3 + 2] = (Math.random() * 2 - 1) * BOX_XZ;
      // Small bubbles rise slower than big ones, which is both true and useful:
      // it stops the field moving as one sheet.
      sizes[i] = 0.035 + Math.random() * 0.075;
      this.bubbleVel[i] = 0.45 + sizes[i] * 6.0;
    }
    const geo = new THREE.BufferGeometry();
    this.bubbleAttr = new THREE.BufferAttribute(this.bubblePos, 3);
    this.bubbleAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.bubbleAttr);
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    this.bubbleMat = new THREE.ShaderMaterial({
      vertexShader: BUBBLE_VERT,
      fragmentShader: BUBBLE_FRAG,
      uniforms: { uAmount: { value: 0 }, uScale: { value: 400 } },
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.bubbles = new THREE.Points(geo, this.bubbleMat);
    // Positions are rewritten every frame around a moving camera, so any
    // bounding volume computed once is a lie; culling has to be off.
    this.bubbles.frustumCulled = false;
    this.bubbles.renderOrder = 8999; // under the tint, over everything else
    this.bubbles.visible = false;
    this.bubbles.userData.bsNoBloom = true;
    this.scene.add(this.bubbles);
  }

  /**
   * Call once per frame, AFTER the camera has been placed for this frame.
   *
   * `overWater` is the world's own answer for the column under the lens — see
   * World.isWater. Without it, standing in a pit with the camera below y=8.28
   * would tint the screen blue on dry land.
   */
  update(dt: number, overWater: boolean): void {
    this.time += dt;
    const submerged = overWater ? SURFACE_Y - this.camera.position.y : -1;
    this.depth = Math.max(0, submerged);
    // The ramp is 45 cm, which is about how far the lens travels in the frames
    // either side of the surface. Shorter and crossing the boundary pops;
    // longer and you can stand chest-deep with the screen half-tinted.
    const target = Math.max(0, Math.min(1, submerged / 0.45));
    // Frame-rate independent, and fast enough (lambda 14 -> ~0.2 s) that the
    // effect does not lag the lens through a dive. The smoothing exists for the
    // case the ramp cannot cover: the isWater gate flipping between two columns
    // as the hero swims along a shoreline.
    this.amount += (target - this.amount) * (1 - Math.exp(-14 * dt));
    if (this.amount < 0.002) {
      this.amount = 0;
      if (this.tint.visible) {
        this.tint.visible = false;
        this.bubbles.visible = false;
      }
      this.restoreFog();
      return;
    }

    this.tint.visible = true;
    this.bubbles.visible = true;
    this.tintMat.uniforms.uAmount.value = this.amount;
    this.tintMat.uniforms.uDepth.value = this.depth;
    this.tintMat.uniforms.uTime.value = this.time;
    this.bubbleMat.uniforms.uAmount.value = this.amount;
    // gl_PointSize is in device pixels, so the world-space size of a bubble has
    // to be converted with the frame's own height and vertical FOV. Reading it
    // off the projection matrix (element 5 is 1/tan(fovY/2)) keeps this correct
    // through a resize and through the ?photo= framings without a resize hook.
    this.bubbleMat.uniforms.uScale.value =
      this.camera.projectionMatrix.elements[5] * this.canvas.height * 0.5;

    // Murk. Same Fog instance and the same FOG_EXP2-less program permutation —
    // only the two numbers move, so nothing recompiles.
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog && (fog as THREE.Fog).isFog) {
      if (!this.fogSaved) {
        this.fogNear = fog.near;
        this.fogFar = fog.far;
        this.fogColor.copy(fog.color);
        this.fogSaved = true;
      }
      // 4 / 40 at full submersion. The history here is the whole of issue #23
      // and it is worth keeping: this started at 2.5 / 34, was pulled back to
      // 6 / 48 because "more fog" meant BRIGHTER — the chunk faded toward the
      // sky gradient and nothing could tell it the light had come through water
      // — and 6/48 was still a white room, just a slightly smaller one. Now
      // that `WATER_ABSORB` darkens the target, murk finally behaves like murk
      // and the numbers can come most of the way back in. Not all the way: the
      // dissolve is the in-scattering term and it is what makes deep water glow
      // rather than go black, so the far wall of a lake should fade, not
      // vanish.
      this.tintLerpFog(fog, 4, 40);
    }

    // Bubbles: rise, sway, wrap in a box around the lens. No allocation.
    const cx = this.camera.position.x;
    const cy = this.camera.position.y;
    const cz = this.camera.position.z;
    const p = this.bubblePos;
    // A bubble dies at the top of the slab OR at the surface, whichever comes
    // first — the second half of that is not cosmetic: a bubble drawn in the air
    // above the waterline is the one thing in this file that would read as a bug.
    const ceiling = Math.min(cy + BAND_Y, SURFACE_Y - 0.08);
    for (let i = 0; i < N_BUBBLES; i++) {
      const k = i * 3;
      p[k + 1] += this.bubbleVel[i] * dt;
      // Sideways wobble, out of phase per bubble so they do not shoal.
      p[k] += Math.sin(this.time * 1.7 + i * 1.3) * dt * 0.16;
      p[k + 2] += Math.cos(this.time * 1.4 + i * 2.1) * dt * 0.16;
      // Recycle to the bottom of the slab with a fresh xz, so the field never
      // thins out and never repeats a column.
      if (p[k + 1] > ceiling) {
        p[k + 1] = cy - BAND_Y;
        p[k] = cx + (Math.random() * 2 - 1) * BOX_XZ;
        p[k + 2] = cz + (Math.random() * 2 - 1) * BOX_XZ;
      }
      // Horizontal wrap is toroidal rather than random, so a bubble that drifts
      // out of the side of the slab keeps its height and its phase.
      const dx = p[k] - cx;
      if (dx > BOX_XZ) p[k] -= BOX_XZ * 2; else if (dx < -BOX_XZ) p[k] += BOX_XZ * 2;
      const dz = p[k + 2] - cz;
      if (dz > BOX_XZ) p[k + 2] -= BOX_XZ * 2; else if (dz < -BOX_XZ) p[k + 2] += BOX_XZ * 2;
      // Camera dropped fast (a dive, or a teleport): pull the stragglers back
      // into the slab rather than leaving them hanging over the surface.
      if (p[k + 1] < cy - BAND_Y * 2) p[k + 1] = cy - BAND_Y;
    }
    this.bubbleAttr.needsUpdate = true;
  }

  /** Ease the fog toward the murk values by the current amount. */
  private tintLerpFog(fog: THREE.Fog, near: number, far: number): void {
    fog.near = this.fogNear + (near - this.fogNear) * this.amount;
    fog.far = this.fogFar + (far - this.fogFar) * this.amount;
    // And what the distance fades TO. `fog.color` is a per-channel absorption
    // multiplier on the sky the patched chunk samples (see
    // installAerialPerspective), so this is the same Beer-Lambert idea as the
    // tint quad applied to the in-scattered half instead of the direct half.
    // Working colour space is linear-sRGB, so `setRGB` writes exactly these
    // numbers and no transfer function touches them.
    fog.color.setRGB(
      1 + (WATER_ABSORB.r - 1) * this.amount,
      1 + (WATER_ABSORB.g - 1) * this.amount,
      1 + (WATER_ABSORB.b - 1) * this.amount,
    );
  }

  private restoreFog(): void {
    if (!this.fogSaved) return;
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog && (fog as THREE.Fog).isFog) {
      fog.near = this.fogNear;
      fog.far = this.fogFar;
      fog.color.copy(this.fogColor);
    }
    this.fogSaved = false;
  }

  /**
   * Draw both materials once, from wherever the camera happens to be parked.
   *
   * This is the whole reason the class exposes anything besides update(): a
   * first-use program link stalls the GPU process for several hundred
   * milliseconds about half a second later, and "the frame you first go under"
   * is the worst possible moment to pay it — see warmUpShaders() in main.ts,
   * which calls this. The alpha is not zero, because a fragment shader whose
   * output is discarded is still a compiled program but a draw call that is
   * culled is not: the quad has to actually rasterise.
   */
  warmUp(render: () => void): void {
    this.tint.visible = true;
    this.bubbles.visible = true;
    this.tintMat.uniforms.uAmount.value = 0.002;
    this.bubbleMat.uniforms.uAmount.value = 0.002;
    // Park the bubbles on the camera so they are certainly on screen and
    // certainly rasterise a few fragments each.
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
    this.tint.visible = false;
    this.bubbles.visible = false;
    this.tintMat.uniforms.uAmount.value = 0;
    this.bubbleMat.uniforms.uAmount.value = 0;
  }

  dispose(): void {
    this.restoreFog();
    this.scene.remove(this.tint);
    this.scene.remove(this.bubbles);
    this.tint.geometry.dispose();
    this.tintMat.dispose();
    this.bubbles.geometry.dispose();
    this.bubbleMat.dispose();
  }
}
