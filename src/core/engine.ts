import * as THREE from "three";
import { PostFX, readPostOptions } from "./post";
import { flags } from "./flags";
import { StaticShadowCache, STATIC_SHADOW_LAYER, shadowCasterCensus } from "./shadow-cache";
import type { CelestialState } from "./types";

/**
 * Renderer, scene, camera, sky, lighting, fog and the post chain (post.ts).
 * Visual grading lives here so the critic loop has one place to tune.
 */

// Reference noon offset from the shadow focus: direction sets the opening light,
// length the key's depth range. 38 degrees of elevation is an ART choice — it
// gives shadows ~1.3x the caster's height, where 66 hid them behind the caster.
const SUN_OFFSET = new THREE.Vector3(170, 160, 113);

// BOUNCE FILL — the anti-sun light, and the fix for black canopy undersides. A
// HemisphereLight cannot do it: its irradiance depends on the normal's ELEVATION
// only, so fill for the shaded face lands on the lit one. Directional light is a
// function of AZIMUTH, so a sun-facing normal clamps to zero; the elevation is
// NEGATIVE because bounce comes off the ground. Created before any world material,
// so NUM_DIR_LIGHTS is 2 for every program and warmUpShaders() stays valid.
const BOUNCE_OFFSET = new THREE.Vector3(-160, -62, -106);

/**
 * Focus drift allowed before the shadow box recentres, i.e. how long one cached
 * static shadow map lives. Costs no coverage — `updateSunFocus` adds the same 8
 * units to the ortho extent — only texel density.
 */
const SHADOW_RECENTER = 8;

// Initial shadow-camera axes; applyCelestial rebuilds the live copies. They let
// `updateSunFocus` snap the box centre to the SHADOW TEXEL GRID, which is what
// stops edges crawling — rounding in world space does not.
const SHADOW_Z = new THREE.Vector3().copy(SUN_OFFSET).normalize();
const SHADOW_X = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), SHADOW_Z).normalize();
const SHADOW_Y = new THREE.Vector3().crossVectors(SHADOW_Z, SHADOW_X);

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Sky gradient as a function of the SINE OF THE ELEVATION of a view ray. Compiled
 * into the sky dome AND, verbatim, into three's fog chunk, so a distant ridge hazes
 * toward the exact sky it is seen against.
 *
 * IMPORTANT — LINEAR radiance, not sRGB swatches: the output pass does ACES + sRGB
 * at the end. Each was solved backwards through that curve.
 */
const SKY_LIB = /* glsl */ `
vec3 bsSkyRadiance(float h) {
  vec3 zenith  = vec3(0.0170, 0.1900, 0.8700);  // displays #3a97ef, sat 0.76
  vec3 horizon = vec3(0.0850, 0.3900, 1.1500);  // displays #a4cbe7, sat 0.29 — a
                                                // pale CYAN, not a pale grey
  // The ramp ends early because a third-person camera looks DOWN: the top of a
  // 16:9 frame is only ~0.03-0.10 up the dome.
  vec3 col = mix(horizon, zenith, smoothstep(-0.06, 0.24, h));
  // Warm haze band on the horizon LINE. Width matters more than amplitude: wide,
  // it launders the sky's chroma.
  float band = 1.0 - smoothstep(0.0, 0.075, abs(h));
  col = mix(col, vec3(1.55, 1.10, 0.66), band * 0.050);
  return col;
}
`;

const SKY_FRAG =
  SKY_LIB +
  /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSkyFilter;
uniform float uDaylight;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 col = bsSkyRadiance(d.y) * uSkyFilter;

  // Sun-side glow. High exponents on purpose: warm added to blue desaturates, so a
  // broad lobe reads as white fog. Amplitudes are capped by the ROLLOFF KNEE — the
  // output pass flattens above 1.55 linear, so peak sky stays ~1.11.
  float sd = max(dot(d, uSunDir), 0.0);
  float glow = pow(sd, 260.0) * 0.30 + pow(sd, 26.0) * 0.175 + pow(sd, 4.0) * 0.055;
  col += vec3(1.00, 0.72, 0.34) * glow * uDaylight;

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Aerial perspective, patching three's fog chunks once at module load. The COLOUR
 * comes per fragment from bsSkyRadiance (elevation from `mvPosition`, so no new
 * uniforms and no per-material hooks); the RAMP is exp(-k d^2). Guarded, because
 * vite's HMR can re-evaluate this module.
 */
function installAerialPerspective(): void {
  const C = THREE.ShaderChunk;
  if (C.fog_vertex.includes("vFogElev")) {
    return;
  }

  C.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying float vFogElev;
#endif
`;

  C.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // Elevation sine of the camera->fragment ray; the length guard is for sprites,
  // whose mvPosition can be the camera origin itself.
  vec3 bsFogRay = mvPosition.xyz;
  vFogElev = dot(bsFogRay, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz))
           / max(length(bsFogRay), 1e-4);
#endif
`;

  C.fog_pars_fragment =
    /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying float vFogElev;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  // Treated height above ground. An unuploaded uniform reads as zero, so only the
  // road ribbon sets it — see RIBBON_FOG_LIFT in world/towns.ts.
  uniform float bsFogGroundLift;
` +
    SKY_LIB +
    `
#endif
`;

  C.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    // fogNear = where haze starts, fogFar = where it is ~95% of the way there.
    float bsFogD = max(0.0, vFogDepth - fogNear) / max(1.0, fogFar - fogNear);
    float fogFactor = 1.0 - exp(-3.0 * bsFogD * bsFogD);
  #endif
  // Haze is a GROUND LAYER, so it thins with altitude, using vFogElev as the
  // proxy. Without this the cloud deck hazed 25-30% and read as translucent.
  fogFactor *= 1.0 - smoothstep(0.10, 0.46, vFogElev + bsFogGroundLift) * 0.86;
  // Distance drops local contrast before it takes hue: 28% toward own luma, 10% up.
  float bsFogL = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(bsFogL * 1.10), 0.28 * fogFactor);
  // fogColor is an ABSORPTION MULTIPLIER on the sky, not a fog colour (issue #23):
  // white here, driven toward a water absorption by underwater.ts.
  gl_FragColor.rgb = mix(gl_FragColor.rgb, bsSkyRadiance(vFogElev) * fogColor, fogFactor);
#endif
`;
}

installAerialPerspective();

// One camera-facing quad, depth-tested so terrain occludes it.
const SUN_FRAG = /* glsl */ `
uniform float uOpacity;
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  // A ~1.3 deg disk. The falloff band must stay wide relative to it, or the tone
  // curve's clipped plateau outgrows the falloff and the sun reads as a rectangle.
  float core = 1.0 - smoothstep(0.045, 0.105, r);
  // Radial, so the quad never reads as a square however hot the middle gets.
  float corona = pow(max(0.0, 1.0 - r), 9.0) * 0.85 + pow(max(0.0, 1.0 - r), 3.0) * 0.30;
  // Rolloff knee 1.55: above ~2.6 a hotter core only widens the plateau.
  vec3 c = vec3(1.0, 0.965, 0.90) * (core * 3.6) + vec3(1.0, 0.74, 0.38) * corona;
  gl_FragColor = vec4(c, uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SUN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const MOON_FRAG = /* glsl */ `
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  float disc = 1.0 - smoothstep(0.82, 0.86, r);
  if (disc <= 0.0) discard;
  float crater =
      (1.0 - smoothstep(0.08, 0.20, length(p - vec2(-0.28, 0.18))))
    + (1.0 - smoothstep(0.05, 0.13, length(p - vec2(0.24, 0.31))))
    + (1.0 - smoothstep(0.07, 0.18, length(p - vec2(0.18, -0.27))))
    + (1.0 - smoothstep(0.04, 0.11, length(p - vec2(-0.38, -0.22))));
  float limb = sqrt(max(0.0, 1.0 - r * r));
  vec3 c = vec3(0.56, 0.68, 0.88) * (0.68 + limb * 0.48 - crater * 0.075);
  gl_FragColor = vec4(c, disc * uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const STAR_VERT = /* glsl */ `
attribute float aSize;
uniform float uOpacity;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize;
  vAlpha = uOpacity;
}
`;

const STAR_FRAG = /* glsl */ `
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = (1.0 - smoothstep(0.22, 0.50, d)) * vAlpha;
  gl_FragColor = vec4(vec3(0.62, 0.75, 1.0), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function makeStars(): THREE.Points {
  const count = 520;
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  let seed = 0x87b0d5;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let i = 0; i < count; i++) {
    const y = random() * 0.92 + 0.04;
    const a = random() * Math.PI * 2;
    const h = Math.sqrt(1 - y * y) * 430;
    positions[i * 3] = Math.cos(a) * h;
    positions[i * 3 + 1] = y * 430;
    positions[i * 3 + 2] = Math.sin(a) * h;
    sizes[i] = 1.2 + random() * 2.2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    uniforms: { uOpacity: { value: 0 } },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = -1;
  return points;
}

/** post.ts's grade was solved against this, so it is the BASE dimming scales. */
const DAYLIGHT_EXPOSURE = 1.2;

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly bounce: THREE.DirectionalLight;
  readonly ambient: THREE.HemisphereLight;
  private readonly skyDome: THREE.Mesh;
  private readonly sunDisk: THREE.Mesh;
  private readonly moonDisk: THREE.Mesh;
  private readonly stars: THREE.Points;
  private readonly ownBackground: THREE.Color;
  private post: PostFX | null = null;
  /** Null under `shadowcache=0` / `shadows=0`, where render() redraws every frame. */
  private shadowCache: StaticShadowCache | null = null;
  private shadowCacheOn = true;
  private shadowExtent = 0;
  /** Texel-snapped, up to SHADOW_RECENTER behind the focus. NaN until the first
   * update, so the first call recentres unconditionally. */
  private readonly shadowBoxCenter = new THREE.Vector3(NaN, NaN, NaN);
  private sunDir = new THREE.Vector3().copy(SUN_OFFSET).normalize();
  private moonDir = new THREE.Vector3().copy(this.sunDir).multiplyScalar(-1);
  private readonly sunOffset = new THREE.Vector3().copy(SUN_OFFSET);
  private readonly shadowZ = new THREE.Vector3().copy(SHADOW_Z);
  private readonly shadowX = new THREE.Vector3().copy(SHADOW_X);
  private readonly shadowY = new THREE.Vector3().copy(SHADOW_Y);
  private celestialExposure = 1;
  private localExposure = 1;
  private readonly atmosphereFilter = new THREE.Color(1, 1, 1);
  private lightCadence = 0.5;
  private celestialUpdates = 0;
  /**
   * `THREE.Clock` was deprecated in r183. `Timer` stamps `_startTime` at
   * CONSTRUCTION, so `tick()` resets it on the first frame. Deliberately NOT
   * `connect(document)`: rAF already stops in a hidden tab.
   */
  private readonly timer = new THREE.Timer();
  private timerStarted = false;
  private minFrameMs = 0;
  private nextDeadline = 0;

  constructor(container: HTMLElement) {
    // MSAA on the default framebuffer only, so it does nothing under the post
    // chain (SMAAPass does that). It stays for `?post=0`.
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = flags.shadows;
    // PCF, not PCF_SOFT: PCF_SOFT spans ~4 texels of penumbra against PCF's ~2,
    // and a world of 1-unit cubes needs a recognisably 1-unit shadow edge.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // View independent, so they update once per frame in render() rather than per
    // renderer.render() call.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = DAYLIGHT_EXPOSURE;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // renderer.info resets on every render() call, so with a composer the F2
    // overlay read only the last fullscreen quad. Reset once per frame instead.
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // Normally hidden by the dome. Doubles as render()'s ?bg= sentinel.
    this.ownBackground = new THREE.Color(0xcfe8f4);
    this.scene.background = this.ownBackground;
    // 130 is where haze begins and is the knob to reach for: the curve is squared,
    // so moving the near plane rescales the mid-distance while the streaming edge
    // at ~245 stays ~87% hazed and still hides chunk pop-in. 270 is ~95%.
    // WHITE is load-bearing — the chunk reads it as a per-channel ABSORPTION
    // multiplier, and world/underwater.ts is its only writer.
    this.scene.fog = new THREE.Fog(0xffffff, 130, 270);

    this.skyDome = new THREE.Mesh(
      new THREE.SphereGeometry(450, 32, 16),
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        uniforms: {
          uSunDir: { value: this.sunDir },
          uSkyFilter: { value: new THREE.Color(1, 1, 1) },
          uDaylight: { value: 1 },
        },
        side: THREE.BackSide,
        fog: false,
        depthWrite: false,
      }),
    );
    this.skyDome.frustumCulled = false;
    this.scene.add(this.skyDome);

    this.sunDisk = new THREE.Mesh(
      new THREE.PlaneGeometry(90, 90),
      new THREE.ShaderMaterial({
        vertexShader: SUN_VERT,
        fragmentShader: SUN_FRAG,
        uniforms: { uOpacity: { value: 1 } },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    );
    // Additive is the selective bloom's "this glows" test, but this must NOT bloom:
    // its halo is authored in SKY_FRAG, under the rolloff knee. See post.ts.
    this.sunDisk.userData.bsNoBloom = true;
    this.scene.add(this.sunDisk);

    this.moonDisk = new THREE.Mesh(
      new THREE.PlaneGeometry(58, 58),
      new THREE.ShaderMaterial({
        vertexShader: SUN_VERT,
        fragmentShader: MOON_FRAG,
        uniforms: { uOpacity: { value: 0 } },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    );
    this.moonDisk.userData.bsNoBloom = true;
    this.scene.add(this.moonDisk);

    this.stars = makeStars();
    this.scene.add(this.stars);

    this.camera = new THREE.PerspectiveCamera(
      55,
      container.clientWidth / container.clientHeight,
      0.1,
      600,
    );
    this.camera.position.set(0, 12, 18);
    // A REAL layer, and world geometry lives on it alone: a camera that does not
    // enable it renders a world with no ground.
    this.camera.layers.enable(STATIC_SHADOW_LAYER);

    // The KEY. Warm, because it is the only thing in frame that says what time it
    // is and the grade cannot add chroma the light never had; its strength is a
    // budget shared with the fill below. three does not normalise intensity by
    // colour luminance, so a hue change needs an intensity compensation.
    this.sun = new THREE.DirectionalLight(0xffebbe, 3.05);
    this.sun.position.copy(SUN_OFFSET);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    // |SUN_OFFSET| is 259 and the tallest caster reaches depth ~152; 110/370 is the
    // tightest bracket, and the depth precision per texel is what keeps bias small.
    this.sun.shadow.camera.near = 110;
    this.sun.shadow.camera.far = 370;
    // updateSunFocus() sets the real extent per frame.
    this.setShadowExtent(72);
    // Mostly normalBias: constant depth bias displaces the shadow ALONG the light,
    // sliding it out from under the caster's feet at this elevation.
    this.sun.shadow.bias = -0.00006;
    this.sun.shadow.normalBias = 0.035;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Direction-only, so it never follows the focus. Keep the colour DESATURATED (a
    // saturated green hue-rotates sunlit sand to olive) and stay under the key.
    this.bounce = new THREE.DirectionalLight(0xd7cfa6, 0.38);
    this.bounce.position.copy(BOUNCE_OFFSET);
    this.bounce.castShadow = false;
    this.scene.add(this.bounce);
    this.scene.add(this.bounce.target);

    // THE SHADOW COLOUR LIVES HERE: a surface in cast shadow is lit by this alone.
    // Keep both halves desaturated, and treat intensity as a BUDGET shared with the
    // key — it lands on LIT surfaces too. Extra lift goes in post.ts's uShadowLift.
    this.ambient = new THREE.HemisphereLight(0xb4d6fb, 0x8fa4bd, 0.55);
    this.scene.add(this.ambient);

    // The mobile URL bar collapsing fires on visualViewport, not window.
    const resize = (): void => this.onResize(container);
    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", () => {
      // iOS reports stale metrics during the flip; settle first.
      setTimeout(resize, 120);
    });
    window.visualViewport?.addEventListener("resize", resize);
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(resize).observe(container);
    }

    // World matrices are updated ONCE in render(): the shadow work runs before the
    // post chain and reads matrixWorld, and only one render() call can need it.
    this.scene.matrixWorldAutoUpdate = false;
    if (flags.shadows && flags.shadowCache) {
      this.shadowCache = new StaticShadowCache();
    }

    // Built last: RenderPass needs the finished camera and GTAOPass the drawing buffer.
    const opts = readPostOptions(location.search);
    if (opts.enabled) {
      this.post = new PostFX(this.renderer, this.scene, this.camera, opts);
      this.post.setSize(
        container.clientWidth,
        container.clientHeight,
        this.renderer.getPixelRatio(),
      );
    }
  }

  /** Apply the shared celestial answer; light direction is budgeted to 2 Hz. */
  applyCelestial(state: Readonly<CelestialState>, dt: number): void {
    this.sunDir.copy(state.sunDirection);
    this.moonDir.copy(state.moonDirection);
    const sky = this.skyDome.material as THREE.ShaderMaterial;
    sky.uniforms.uSkyFilter.value.copy(state.atmosphereFilter);
    sky.uniforms.uDaylight.value = state.daylight;
    (this.sunDisk.material as THREE.ShaderMaterial).uniforms.uOpacity.value = state.daylight;
    (this.moonDisk.material as THREE.ShaderMaterial).uniforms.uOpacity.value = state.moon;
    (this.stars.material as THREE.ShaderMaterial).uniforms.uOpacity.value = state.stars;

    this.sun.color.copy(state.keyColor);
    this.sun.intensity = state.keyIntensity;
    this.bounce.color.copy(state.bounceColor);
    this.bounce.intensity = state.bounceIntensity;
    this.ambient.color.copy(state.ambientSky);
    this.ambient.groundColor.copy(state.ambientGround);
    this.ambient.intensity = state.ambientIntensity;
    this.celestialExposure = state.exposureScale;
    this.renderer.toneMappingExposure =
      DAYLIGHT_EXPOSURE * this.celestialExposure * this.localExposure;
    this.atmosphereFilter.copy(state.atmosphereFilter);
    if (this.scene.fog) {
      this.scene.fog.color.copy(this.atmosphereFilter);
    }

    this.lightCadence += Math.max(0, dt);
    if (this.celestialUpdates > 0 && this.lightCadence < 0.5) {
      return;
    }
    this.lightCadence = 0;
    this.celestialUpdates++;
    this.shadowZ.copy(state.keyDirection).normalize();
    this.shadowX.crossVectors(THREE.Object3D.DEFAULT_UP, this.shadowZ);
    // At zenith any horizontal basis is valid; retain a stable axis there.
    if (this.shadowX.lengthSq() < 1e-6) {
      this.shadowX.set(1, 0, 0);
    } else {
      this.shadowX.normalize();
    }
    this.shadowY.crossVectors(this.shadowZ, this.shadowX).normalize();
    this.sunOffset.copy(this.shadowZ).multiplyScalar(SUN_OFFSET.length());
    this.bounce.position.copy(this.shadowZ).multiplyScalar(-200);
    this.bounce.position.y = -Math.max(48, Math.abs(this.bounce.position.y));
    this.shadowBoxCenter.set(NaN, NaN, NaN);
    this.shadowCache?.invalidate();
  }

  private setShadowExtent(s: number): void {
    this.shadowExtent = s;
    const cam = this.sun.shadow.camera;
    cam.left = -s;
    cam.right = s;
    cam.top = s;
    cam.bottom = -s;
    // LightShadow.updateMatrices does NOT recompute the projection.
    cam.updateProjectionMatrix();
  }

  /**
   * TEXEL DENSITY is the point: a penumbra is a fixed number of texels wide and a
   * hero only ~2 units tall. It must SCALE, or photo mode ends shadows in a visible
   * circle; quantised to 8, or every penumbra breathes as the camera dollies.
   */
  updateSunFocus(focus: THREE.Vector3): void {
    const want = 52 + this.camera.position.distanceTo(focus) * 1.35;
    // 152 covers a wide vista at 0.073 units/texel, still a 1-unit edge under PCF.
    // Plus SHADOW_RECENTER, so the box may LAG the focus without losing radius.
    const s = Math.round(Math.min(152, Math.max(64, want)) / 8) * 8 + SHADOW_RECENTER;
    const resized = s !== this.shadowExtent;
    if (resized) {
      this.setShadowExtent(s);
    }

    // Moves RARELY (the cache is only valid while its light matrix is) and in whole
    // TEXELS along the shadow camera's axes, which is what stops edges crawling.
    const texel = (2 * s) / this.sun.shadow.mapSize.x;
    const drift = this.shadowBoxCenter.distanceToSquared(focus);
    if (!resized && Number.isFinite(drift) && drift <= SHADOW_RECENTER * SHADOW_RECENTER) {
      return;
    }
    const u = Math.round(focus.dot(this.shadowX) / texel) * texel;
    const v = Math.round(focus.dot(this.shadowY) / texel) * texel;
    const w = focus.dot(this.shadowZ);
    this.shadowBoxCenter
      .copy(this.shadowX)
      .multiplyScalar(u)
      .addScaledVector(this.shadowY, v)
      .addScaledVector(this.shadowZ, w);
    const c = this.shadowBoxCenter;
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).add(this.sunOffset);
  }

  private onResize(container: HTMLElement): void {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    // A 3x DPR phone at native resolution costs frame rate for no visible gain.
    const dprCap = Math.min(w, h) < 700 ? 1.6 : 2;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, dprCap));
    // Portrait needs a wider FOV or the character fills the frame.
    const aspect = w / h;
    this.camera.fov = aspect < 1.33 ? Math.min(72, 55 / Math.max(0.62, aspect / 1.33)) : 55;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    // updateStyle must stay ON: the inline px setSize stamps beats index.html's
    // `canvas { width: 100% }`, so updateStyle:false freezes the CSS box.
    this.renderer.setSize(w, h);
    // Every render target has to follow the canvas AND the pixel ratio.
    this.post?.setSize(w, h, this.renderer.getPixelRatio());
  }

  /** Frame-rate cap. 0 = uncapped. */
  setFpsCap(fps: number): void {
    this.minFrameMs = fps > 0 ? 1000 / fps : 0;
    this.nextDeadline = 0;
  }

  setViewDistance(distance: number): void {
    const metres = distance <= 480 ? 480 : distance >= 900 ? 900 : 600;
    this.camera.far = metres;
    this.camera.updateProjectionMatrix();
    if (!(this.scene.fog instanceof THREE.Fog)) {
      return;
    }
    // Keep colour in the HLOD beyond the detailed ring, or aerial views read as
    // trees over a sky-coloured square. distant-terrain owns the final dissolve.
    if (metres === 480) {
      this.scene.fog.near = 120;
      this.scene.fog.far = 340;
    } else if (metres === 900) {
      this.scene.fog.near = 240;
      this.scene.fog.far = 700;
    } else {
      this.scene.fog.near = 160;
      this.scene.fog.far = 430;
    }
  }

  /**
   * False means skip tick/update/render this frame. Targets an absolute DEADLINE:
   * rAF only offers times on the refresh grid, so a fixed interval overshoots to
   * the next vsync and compounds (a 30 fps cap measured 26.7). Catch-up is clamped
   * to one period so a backgrounded tab does not run unthrottled.
   */
  beginFrame(): boolean {
    if (this.minFrameMs <= 0) {
      return true;
    }
    const now = performance.now();
    if (now < this.nextDeadline) {
      return false;
    }
    this.nextDeadline += this.minFrameMs;
    if (this.nextDeadline < now) {
      this.nextDeadline = now;
    }
    return true;
  }

  tick(): number {
    // `Timer` stamps its origin at CONSTRUCTION, so reset() re-bases it on now.
    if (!this.timerStarted) {
      this.timerStarted = true;
      this.timer.reset();
    }
    this.timer.update();
    return Math.min(this.timer.getDelta(), 0.05);
  }

  /**
   * Dim the picture as a fraction of the daylight exposure (issue #23). The
   * underwater tint MULTIPLIES linear HDR radiance before ACES, so on a bright
   * frame it desaturates to white; dropping the exposure puts the radiance back
   * where the curve still has chroma. Written through `toneMappingExposure`, which
   * PostFX.render() reads live, so `?post=0` cannot drift apart.
   */
  setExposureScale(k: number): void {
    this.localExposure = k;
    this.renderer.toneMappingExposure =
      DAYLIGHT_EXPOSURE * this.celestialExposure * this.localExposure;
  }

  setFogAbsorption(absorption: Readonly<THREE.Color>): void {
    if (this.scene.fog) {
      this.scene.fog.color.copy(this.atmosphereFilter).multiply(absorption);
    }
  }

  /** A no-op under `?post=0`, which is therefore the pre-water isolation view. */
  setUnderwater(amount: number, depth: number, time: number): void {
    this.post?.setUnderwater(amount, depth, time);
  }

  setPassEnabled(which: "ao" | "bloom" | "aa", on: boolean): void {
    this.post?.setPassEnabled(which, on);
  }

  /**
   * The expensive half is `needsUpdate`: receiving shadows is a PROGRAM permutation,
   * so every material relinks — hundreds of ms per direction, hence the early
   * return. `?shadows=0` at construction cannot be undone here.
   */
  setShadowsEnabled(on: boolean): void {
    if (!flags.shadows || this.renderer.shadowMap.enabled === on) {
      return;
    }
    this.renderer.shadowMap.enabled = on;
    this.renderer.shadowMap.needsUpdate = true;
    // Stale by construction after a spell with the map off.
    this.shadowCache?.invalidate();
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (!m) {
        return;
      }
      if (Array.isArray(m)) {
        for (const x of m) x.needsUpdate = true;
      } else {
        m.needsUpdate = true;
      }
    });
  }

  /**
   * A/B measurement only. Interleaving in ONE page load is what a performance run
   * needs: desktop frame cost drifts more than the effect over two loads.
   */
  setShadowCacheEnabled(on: boolean): void {
    if (!this.shadowCache) {
      return;
    }
    this.shadowCacheOn = on;
    this.shadowCache.invalidate();
  }

  shadowDebug(): Record<string, unknown> {
    return {
      enabled: this.renderer.shadowMap.enabled,
      cached: this.shadowCache !== null && this.shadowCacheOn,
      extent: this.shadowExtent,
      celestialUpdates: this.celestialUpdates,
      keyDirection: this.shadowZ.toArray(),
      keyIntensity: this.sun.intensity,
      bounceIntensity: this.bounce.intensity,
      ...this.shadowCache?.debug(),
      ...shadowCasterCensus(this.scene),
    };
  }

  render(): void {
    // Sky dome tracks the camera so the horizon never slides (no allocs).
    this.skyDome.position.copy(this.camera.position);

    // lookAt orients +Z at the target and PlaneGeometry faces +Z.
    this.sunDisk.position.copy(this.camera.position).addScaledVector(this.sunDir, 400);
    this.sunDisk.lookAt(this.camera.position);
    this.moonDisk.position.copy(this.camera.position).addScaledVector(this.moonDir, 400);
    this.moonDisk.lookAt(this.camera.position);
    this.stars.position.copy(this.camera.position);

    // The lab's ?bg= replaces scene.background; the dome must stand down for it.
    const plainBackdrop = this.scene.background !== this.ownBackground;
    this.skyDome.visible = !plainBackdrop;
    this.sunDisk.visible =
      !plainBackdrop &&
      (this.sunDisk.material as THREE.ShaderMaterial).uniforms.uOpacity.value > 0.01;
    this.moonDisk.visible = !plainBackdrop;
    this.stars.visible = !plainBackdrop;

    // Must be AFTER the dome/disk moves: matrixWorldAutoUpdate is off.
    this.scene.updateMatrixWorld();

    // One shadow update and one stats window per frame. The window opens FIRST so
    // the shadow pass lands inside it and a probe can read the cache's saving.
    this.renderer.info.reset();
    if (this.shadowCache && this.shadowCacheOn && this.renderer.shadowMap.enabled) {
      this.shadowCache.update(
        this.renderer,
        this.scene,
        this.camera,
        this.sun,
        this.shadowX,
        this.shadowY,
      );
    } else {
      this.renderer.shadowMap.needsUpdate = true;
    }

    if (this.post) {
      this.post.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }
}
