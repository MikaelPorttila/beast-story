import * as THREE from 'three';
import { PostFX, readPostOptions } from './post';

/**
 * Rendering engine: renderer, scene, camera, sky, sun/ambient lighting, fog and
 * the post-processing chain (see post.ts). Visual grading lives here so the
 * critic loop has one place to tune.
 */

// Sun direction, as an offset from the shadow focus. Shared by the light, the
// sky dome's glow and the sun disk so all three can never disagree — a halo that
// does not sit where the shadows say the sun is reads instantly as wrong.
//
// ELEVATION IS AN ART DECISION, not a convenience. The old (60, 160, 40) puts
// the sun 66 degrees up, so a shadow is only 0.45x the caster's height and hides
// behind it: a top-down photo-mode frame showed no directional shadow anywhere,
// and the world read flat. 38 degrees gives shadows ~1.3x the caster's height,
// which is the raking light every Cube World screenshot has — it is what makes a
// tree read as a volume standing on ground rather than a green blob pasted on it.
//
// The height stays at 160 rather than dropping with the angle. It used to be so
// that the cloud deck (y 90-115) stayed below the light and kept casting; the
// clouds no longer cast at all (world/clouds.ts), but the height is still what
// keeps |SUN_OFFSET| long enough that the whole streamed world sits comfortably
// inside one shadow depth range — see the near/far below.
const SUN_OFFSET = new THREE.Vector3(170, 160, 113);

// Gradient sky dome: zenith blue -> pale horizon, a warm band on the horizon
// line and a tight corona around the sun.
const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * The sky gradient, as a function of the SINE OF THE ELEVATION of a view ray.
 *
 * This one function is the whole aerial-perspective story. It is compiled into
 * the sky dome's shader AND, verbatim, into three's fog chunk by
 * installAerialPerspective() below, so a distant ridge hazes toward the exact
 * colour of the sky it is seen against: a ridge low in frame goes to the warm
 * horizon tint, a peak high in frame to the zenith blue. Fog that fades to a
 * constant colour cannot do that, and if that constant is pale it reads as smog
 * rather than as distance — captured, the whole left horizon of a vista and the
 * far shoreline of the lake dissolved into white mush with no sea/sky boundary
 * left at all.
 *
 * IMPORTANT — these constants are LINEAR radiance, not sRGB swatches.
 *
 * A raw ShaderMaterial writing to the default framebuffer used to land straight
 * on the sRGB canvas, so hand-picked sRGB numbers "just worked". Once the frame
 * goes through a composer the scene buffer is linear HDR and the output pass does
 * the ACES + sRGB step at the end, so sRGB numbers get read as radiance and come
 * out pale and grey (ACES turns #cfe8f4-as-linear into a near-neutral #d3dcdf).
 * Every value below was solved backwards through that curve at exposure 1.02 and
 * the comment says what it displays as.
 *
 * Both ends moved this round, and for the same reason: a third-person camera
 * looks DOWN, so the top of a 16:9 gameplay frame is only ~0.03-0.10 up the dome.
 * The old ramp (horizon -> zenith over h in [-0.03, 0.40]) meant essentially the
 * entire visible sky band was the pale horizon end, and the old horizon end
 * displayed as #cfe1ed — near white. So the sky was white in every wide shot and
 * every far ridge hazed to white with it. The ramp now finishes at h = 0.26 and
 * the horizon end carries real chroma.
 */
const SKY_LIB = /* glsl */ `
vec3 cpSkyRadiance(float h) {
  vec3 zenith  = vec3(0.0262, 0.2154, 0.9184);  // displays #3f8fe0
  vec3 horizon = vec3(0.2073, 0.4641, 0.9992);  // displays #9ec2e2 — pale, but
                                                // unmistakably BLUE, so a ridge
                                                // that dissolves into it reads as
                                                // atmosphere and the sea still has
                                                // an edge against it
  vec3 col = mix(horizon, zenith, smoothstep(-0.04, 0.26, h));
  // Warm band hugging the horizon line (haze scattering). Kept narrow and weak:
  // this is the "hint of horizon glow", not a sunset. 0.12 at (1.60,1.14,0.70),
  // down from 0.20 at (1.90,1.18,0.64) — against the now much bluer horizon the
  // stronger warm mix raised red past green and the band photographed as a mauve
  // stripe across the top of every wide shot.
  float band = 1.0 - smoothstep(0.0, 0.17, abs(h));
  col = mix(col, vec3(1.60, 1.14, 0.70), band * 0.12);
  return col;
}
`;

const SKY_FRAG = SKY_LIB + /* glsl */ `
uniform vec3 uSunDir;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 col = cpSkyRadiance(d.y);

  // Sun-side glow: a tight corona, a mid halo, and a barely-there wide lobe.
  // The exponents are high on purpose. Adding a warm colour to a blue sky
  // desaturates it, so a broad lobe does not read as "lit from over there", it
  // reads as white fog — an earlier pass at 24/3/1.2 blew a third of the sky to
  // near-white.
  //
  // THE AMPLITUDES ARE CAPPED BY THE ROLLOFF KNEE, and that is the whole reason
  // this was retuned. The output pass compresses everything above 1.55 linear
  // toward one displayed value, so a corona that pushes the sky past the knee
  // does not get brighter — it gets FLAT, and it takes the sun disk with it. At
  // 2.20 (and even at 1.35) the corona and the disk both landed on ~#f4f4f4 and
  // the sun photographed as a shapeless warm smudge with no disc in it at all.
  // Peak sky here is now ~1.11 linear (displays ~#cfd3e5), which leaves the disk
  // 40 code values of headroom to actually be a disc.
  float sd = max(dot(d, uSunDir), 0.0);
  float glow = pow(sd, 260.0) * 0.30 + pow(sd, 26.0) * 0.20 + pow(sd, 4.0) * 0.07;
  col += vec3(1.00, 0.72, 0.34) * glow;

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Aerial perspective, by patching three's fog shader chunks once at module load.
 *
 * Stock THREE.Fog can only mix toward a single uniform colour with a linear ramp
 * between two distances. Neither half is good enough here:
 *
 *  - the COLOUR has to vary with where the fragment sits in the sky, which is
 *    what cpSkyRadiance above provides. The elevation it needs is computed in the
 *    vertex shader from data every material already has — `mvPosition` (view
 *    space) dotted with world up expressed in view space — so this needs no new
 *    uniforms and works on stock materials, on the water shader, and on anything
 *    added later, with no per-material onBeforeCompile hooks.
 *  - the RAMP has to be exponential-squared. A linear ramp has only two knobs and
 *    they fight: start it early enough for the far ridge to fade and mid-ground
 *    trees are already washed out; start it late and there is no gradient left.
 *    exp(-k d^2) is flat near the camera and steep at the far end, which is what
 *    atmosphere actually does.
 *
 * On top of the colour mix there is a saturation/value shift over the same range:
 * fog alone converges everything onto one colour, but real distance ALSO drops
 * local contrast before it drops hue, and lifting the value a little is what makes
 * a far ridge sit visibly *behind* a near hill rather than merely paler than it.
 *
 * Called once, guarded, because vite's HMR can re-evaluate this module.
 */
function installAerialPerspective(): void {
  const C = THREE.ShaderChunk;
  if (C.fog_vertex.includes('vFogElev')) return;

  C.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying float vFogElev;
#endif
`;

  C.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // Sine of the elevation of the camera->fragment ray. viewMatrix is injected
  // into every three-managed shader, so (viewMatrix * up) is world up in view
  // space and the dot gives exactly the elevation the sky dome samples. The length
  // guard is for shaders whose mvPosition is the camera origin itself (sprites).
  vec3 cpFogRay = mvPosition.xyz;
  vFogElev = dot(cpFogRay, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz))
           / max(length(cpFogRay), 1e-4);
#endif
`;

  C.fog_pars_fragment = /* glsl */ `
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
` + SKY_LIB + `
#endif
`;

  C.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    // fogNear = where haze starts, fogFar = where it is ~95% of the way there.
    float cpFogD = max(0.0, vFogDepth - fogNear) / max(1.0, fogFar - fogNear);
    float fogFactor = 1.0 - exp(-3.0 * cpFogD * cpFogD);
  #endif
  // Haze is a GROUND LAYER, so it thins with altitude. vFogElev already says how
  // far above the horizon this fragment is seen, which is the cheap proxy: a ridge
  // on the horizon gets all of it, a mountain peak high in frame gets ~60% (so the
  // haze gradient runs UP the mountain, which is what reads as height), and the
  // cloud deck gets almost none.
  //
  // Without this the clouds were the giveaway. They sit 90-115 units up, so they
  // are "far" by view distance and were hazing 25-30% toward the sky — which made
  // them look translucent, and worse, the ones near the sun went a saturated blue
  // because the fog samples the sky gradient WITHOUT the sun's corona while the
  // dome behind them has it. Attenuated, they stay white and opaque.
  fogFactor *= 1.0 - smoothstep(0.10, 0.46, vFogElev) * 0.86;
  // Distance drops local contrast and lifts value before it takes hue: 28% toward
  // the fragment's own luma, 10% brighter, both scaled by the same factor.
  float cpFogL = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(cpFogL * 1.10), 0.28 * fogFactor);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, cpSkyRadiance(vFogElev), fogFactor);
#endif
`;
}

installAerialPerspective();

// Sun disk: one camera-facing quad, depth-tested so terrain occludes it. A soft
// round core (which the bloom pass smears into a halo) plus a wide corona so the
// disk still reads with bloom switched off.
const SUN_FRAG = /* glsl */ `
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  // Core edge at ~10.5% of the quad half-width, i.e. 4.7 units of a 90-unit quad
  // 400 units out: a ~1.3 deg disk, a bit over twice life size. Big enough to
  // read through the bloom halo, small enough that it is still the sun.
  //
  // The falloff band is 0.045 -> 0.105 rather than the old 0.060 -> 0.092, i.e.
  // more than twice as wide relative to the disk. Combined with the output pass's
  // highlight rolloff (which stops the centre clipping to a flat #ffffff plateau)
  // that is what turns the sun from a blown-out hard-edged blob into a disc with
  // an edge — the previous version photographed as a white rectangle because the
  // clipped plateau was wider than the falloff and only the quad's own bounds
  // showed.
  float core = 1.0 - smoothstep(0.045, 0.105, r);
  // Two corona lobes: a tight one that gives the disc a bright rim, and a broad
  // one for the atmospheric flare. Radial, so the quad is never visible as a
  // square however hot the middle gets.
  float corona = pow(max(0.0, 1.0 - r), 9.0) * 0.85 + pow(max(0.0, 1.0 - r), 3.0) * 0.30;
  // 3.6 against a near-sun sky of ~1.11: this is a linear HDR buffer and the
  // rolloff knee is 1.55, so everything above ~2.6 lands on the same displayed
  // value. A hotter core cannot get brighter, it can only widen the plateau —
  // what makes the disc legible is keeping the SKY around it well under the knee
  // (see SKY_FRAG) and keeping the disk out of the bloom (see cpNoBloom below).
  vec3 c = vec3(1.0, 0.965, 0.90) * (core * 3.6) + vec3(1.0, 0.74, 0.38) * corona;
  gl_FragColor = vec4(c, 1.0);
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

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly ambient: THREE.HemisphereLight;
  private readonly skyDome: THREE.Mesh;
  private readonly sunDisk: THREE.Mesh;
  /** The background the sky dome is painted to match; see render(). */
  private readonly ownBackground: THREE.Color;
  private post: PostFX | null = null;
  /** Current shadow ortho half-extent; see updateSunFocus(). */
  private shadowExtent = 0;
  private sunDir = new THREE.Vector3().copy(SUN_OFFSET).normalize();
  private clock = new THREE.Clock();
  private minFrameMs = 0;
  private nextDeadline = 0;

  constructor(container: HTMLElement) {
    // `antialias` is MSAA on the default framebuffer only. The post chain draws
    // into render targets, so it does nothing there and SMAAPass does the work
    // instead; the flag stays for the ?post=0 fallback path.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    // PCF, not PCF_SOFT. Read three's shadowmap_pars_fragment: PCF_SOFT samples a
    // bilinear-weighted grid spanning -1..+2 texels, i.e. ~4 texels of penumbra,
    // while PCF's 17 taps span -1..+1 at shadowRadius 1, i.e. ~2. On a world made
    // of 1-unit cubes that difference is the whole complaint: a 1-unit block has
    // to cast a shadow with a recognisably 1-unit edge, and at 4 texels of blur
    // every small caster became a soft smudge with no shape.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // A frame now issues several renderer.render() calls (scene, the AO
    // normal/depth prepass, the emissive bloom pass). Shadows are view
    // independent here, so re-rendering a 4096^2 map for each of them was pure
    // waste: drive it manually and update exactly once per frame in render().
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Same reason, for the stats: renderer.info resets itself on every
    // render() call, which with a composer left the F2 overlay reporting the
    // draw calls of the last fullscreen quad. Reset once per frame instead so
    // the readout is the true per-frame total.
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // Fallback clear colour, in the dome's horizon family. It is normally
    // invisible — the dome covers every pixel of sky — and exists so a frame that
    // somehow misses the dome does not flash. It also doubles as the sentinel
    // render() uses to detect the lab's ?bg= override; see there.
    this.ownBackground = new THREE.Color(0xcfe8f4);
    this.scene.background = this.ownBackground;
    // Aerial perspective. The CURVE and the COLOUR both live in the patched fog
    // chunk (installAerialPerspective) — the colour is sampled per fragment from
    // cpSkyRadiance, so scene.fog.color is not read at all. The two numbers here
    // are what the chunk does use:
    //
    //   85  where haze begins. Captured at 55 first and it was too eager: the far
    //       shore of the bay, 90-120 units out and still somewhere the player
    //       walks to, was already visibly pale and the low cloud deck (which sits
    //       90-115 units up) went blue-grey and translucent. At 85 a fragment at
    //       120 units takes 9% instead of 28%.
    //   270 where haze is ~95%. Near the STREAMING RADIUS, not the far plane:
    //       VIEW_RADIUS is 5 chunks of 32 units, so the farthest terrain that
    //       exists is ~245 units away on the diagonal, which lands at ~86%. The
    //       old 420 was past the edge of the world entirely, which is why the
    //       mountains came back at full saturation — the fog never reached them.
    //
    // The colour argument is kept at the horizon's displayed value so anything
    // that inspects scene.fog (nothing does today) sees something sane.
    this.scene.fog = new THREE.Fog(0xa9c8e2, 85, 270);

    // One-draw-call inverted sphere; follows the camera each frame (render()).
    this.skyDome = new THREE.Mesh(
      new THREE.SphereGeometry(450, 32, 16),
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        uniforms: { uSunDir: { value: this.sunDir } },
        side: THREE.BackSide,
        fog: false,
        depthWrite: false,
      }),
    );
    this.skyDome.frustumCulled = false;
    this.scene.add(this.skyDome);

    // Sun disk. Sits at 400 units, inside the 450 dome and inside the 600 far
    // plane, and keeps depth testing so terrain still occludes it. depthWrite is
    // off and it is additive, so it never disturbs anything drawn after it.
    this.sunDisk = new THREE.Mesh(
      new THREE.PlaneGeometry(90, 90),
      new THREE.ShaderMaterial({
        vertexShader: SUN_VERT,
        fragmentShader: SUN_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    );
    // The disk is additive, which is the selective bloom's "this glows" test — but
    // it must NOT bloom. Its own halo is authored in SKY_FRAG, where the amplitude
    // can be held under the rolloff knee; a bloom halo instead spreads ~0.6 linear
    // over a couple of hundred pixels, which pushes that whole area past the knee
    // and produces exactly the flat white plateau with a square-ish edge that got
    // filed against this. See tagSources() in post.ts.
    this.sunDisk.userData.cpNoBloom = true;
    this.scene.add(this.sunDisk);

    this.camera = new THREE.PerspectiveCamera(
      55, container.clientWidth / container.clientHeight, 0.1, 600,
    );
    this.camera.position.set(0, 12, 18);

    // Warm and deliberately not brighter than it has to be: the hemisphere fill
    // below is what lifts the shadows, and every step this goes up has to be paid
    // for there or the world flattens. The warmth is what makes the cool fill read
    // as a warm/cool contrast instead of just a brighter grey. 2.55 -> 2.45 -> 2.38
    // across three rounds, each step paying for the fill going up.
    this.sun = new THREE.DirectionalLight(0xfff0cf, 2.38);
    this.sun.position.copy(SUN_OFFSET);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    // Depth range. |SUN_OFFSET| is 259, so the focus plane sits at depth 259 and
    // the sine of the sun's elevation is 0.617: a peak at the terrain ceiling
    // (y 78) standing 66 units above the player is 66/0.617 = 107 units nearer the
    // light, i.e. depth 152. 110/370 brackets that with margin at both ends while
    // being a 260-unit range instead of the old 440 — nearly twice the depth
    // precision per shadow texel, which is what lets the bias come down and the
    // contact point stay attached to the caster's feet.
    //
    // A near plane of 110 also happens to sit BEHIND the cloud deck (a cloud at
    // y 100 is only ~99 units from the light along the sun ray), so even if cloud
    // casting were switched back on the clouds could not print the huge hard-edged
    // casterless quadrilaterals on the grass that got filed against this.
    this.sun.shadow.camera.near = 110;
    this.sun.shadow.camera.far = 370;
    // The ortho extent is set per frame by updateSunFocus() — it scales with how
    // far the camera is from the action, so a gameplay camera gets a tight, dense
    // cascade and a wide photo-mode vista still gets shadows out to the horizon.
    // This initial value only has to be sane for the first frame.
    this.setShadowExtent(72);
    // Bias split: almost all of it slope-scaled rather than constant. A constant
    // depth bias displaces a shadow ALONG the light, and at 38 degrees of
    // elevation that displacement is 1.6x what it was at 66 — visible as the
    // shadow sliding out from under its caster's feet. normalBias offsets the
    // lookup along the surface normal instead, which is self-scaling with the
    // angle between surface and light and does not detach the contact point.
    // Both are down from -0.00012/0.06: the halved depth range above and the
    // denser cascade mean less bias is needed, and less bias is a tighter contact.
    this.sun.shadow.bias = -0.00006;
    this.sun.shadow.normalBias = 0.035;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // THE SHADOW COLOUR LIVES HERE. Everything in cast shadow is lit by this
    // light alone, so its colour IS the shadow's colour and its intensity IS the
    // shadow's brightness relative to the lit surface.
    //
    // The ground half used to be 0x6b7f52 — a saturated grass green — at a
    // strength that let it dominate a downward-ish face. That is not a shadow, it
    // is a hue rotation: sunlit sand at #d9d9a0 fell to #5a6633 in shadow, i.e.
    // it turned olive, which reads as mould on the ground rather than as shade.
    // A desaturated blue-grey bounce keeps the shift where the eye expects it —
    // darker AND cooler, never a different hue.
    //
    // Intensity is a BUDGET, not a free knob: the fill lands on lit surfaces too,
    // so raising it without taking the same amount off the sun flattens the whole
    // world. 0.52 -> 0.78 with the sun going 2.55 -> 2.45 takes a shadowed
    // up-facing surface from a measured 11% of its lit value to 19-20%, i.e. into
    // the range where shadowed foliage still separates from shadowed terrain.
    //
    // Note that 0.78 is not as large as it looks next to the old 0.52: three does
    // not normalise a light's intensity by its colour's luminance, and the sky
    // colour below is a much bluer — so much less luminous — blue than the
    // near-white it replaced. Most of the extra number is paying for chroma, not
    // adding brightness.
    //
    // Both ends of this were captured and measured. 0.90 with the old near-white
    // sky colour dropped the sun/fill ratio to 2.6:1 and every cube lost its form
    // shading: sand went pale and chalky and the terraces read as one flat sheet.
    // 0.86 with the blue was the same failure a shade milder. 0.78 holds the ratio
    // above 3:1 and the sand stays a saturated warm yellow. The remaining lift
    // comes from the grade's cool floor (post.ts step 4), which touches only the
    // darkest values and so cannot flatten anything.
    //
    // The SKY half matters more than the ground half for a shadow on open ground,
    // because a shadowed up-facing surface is lit by the sky hemisphere alone. It
    // was 0xd6ecff, which is only nominally blue (R at 214/255): measured, shadowed
    // sand still came out a yellow-green #50583a. 0xb8daff carries enough chroma
    // that the same surface reads as a cool grey-tan, and because the fill is only
    // ~23% of a lit surface's total the lit world barely moves — what movement
    // there is, the warm sun colour above already cancels.
    // Round-6 nudge: 0.78 -> 0.86 with the sun coming 2.45 -> 2.38, and the sky
    // half losing a little of its blue (0xb8daff -> 0xc2dcf9). Measured on a
    // gameplay frame, grass in cast shadow was at 19% of its sunlit luminance with
    // almost no red left in it; this takes it to ~22% and puts the red back, which
    // is what makes a shadow read as "the same green, cooler" instead of as a hole.
    // Deliberately a NUDGE and not the 1.6x the arithmetic would need to hit 30%:
    // that would drop the sun/fill ratio to 2.3:1, and 2.6:1 was already measured
    // to flatten every cube's form shading and turn sand chalky. The rest of the
    // lift is bought in the grade's shadow floor, which only touches dark values
    // and so cannot flatten anything.
    this.ambient = new THREE.HemisphereLight(0xc2dcf9, 0x8fa4bd, 0.86);
    this.scene.add(this.ambient);

    // Responsive: plain resizes, orientation flips, and the mobile URL bar
    // collapsing (which fires on visualViewport, not window).
    const resize = (): void => this.onResize(container);
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => {
      // iOS reports stale metrics during the flip; settle first.
      setTimeout(resize, 120);
    });
    window.visualViewport?.addEventListener('resize', resize);
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(resize).observe(container);
    }

    // Post-processing is built last: RenderPass needs the finished camera, and
    // GTAOPass sizes its G-buffer from the renderer's current drawing buffer.
    const opts = readPostOptions(location.search);
    if (opts.enabled) {
      this.post = new PostFX(this.renderer, this.scene, this.camera, opts);
      this.post.setSize(
        container.clientWidth, container.clientHeight, this.renderer.getPixelRatio(),
      );
    }
  }

  /** Resize the shadow ortho box. Half-extent in world units. */
  private setShadowExtent(s: number): void {
    this.shadowExtent = s;
    const cam = this.sun.shadow.camera;
    cam.left = -s;
    cam.right = s;
    cam.top = s;
    cam.bottom = -s;
    // three's LightShadow.updateMatrices does NOT recompute the projection, so
    // this call is not optional — without it the frustum silently stays put.
    cam.updateProjectionMatrix();
  }

  /**
   * Keep the shadow frustum centered on the action, and sized to it.
   *
   * TEXEL DENSITY IS THE WHOLE POINT. A fixed 180-unit box on a 4096 map is 0.044
   * units per texel — 22 texels across a terrain cube, which sounds ample and is
   * not, because the penumbra is a fixed number of texels wide and a hero is only
   * ~2 units tall. Fitting the box to the camera instead gives a gameplay camera
   * (~12 units behind the player) a 136-unit box at 0.033 units/texel, and shrinks
   * the penumbra with it.
   *
   * It has to scale rather than just be small, because photo mode puts the camera
   * 40+ units out and looks across 250 units of world: a box tight enough for
   * gameplay would end shadows in a visible circle halfway up a vista.
   *
   * Quantised to 8 units so the extent does not change every frame — a
   * continuously resizing box makes every penumbra in the frame breathe as the
   * camera dollies, which reads as a rendering glitch rather than as motion.
   */
  updateSunFocus(focus: THREE.Vector3): void {
    const want = 52 + this.camera.position.distanceTo(focus) * 1.35;
    const s = Math.round(Math.min(112, Math.max(64, want)) / 8) * 8;
    if (s !== this.shadowExtent) this.setShadowExtent(s);

    // Snap the box to a coarse world lattice. Shadows live in world space, so
    // moving the box moves no shadow — the only thing an unsnapped box changes is
    // WHICH shadow texel each edge lands on, and that re-rolls every frame as the
    // player walks, which is the crawling/shimmering along shadow edges. 0.5 units
    // is ~15 texels at the tightest cascade: coarse enough to be stable, far too
    // small to shift coverage. The light direction is fixed, so quantising world
    // space quantises light space too.
    const fx = Math.round(focus.x * 2) * 0.5;
    const fy = Math.round(focus.y * 2) * 0.5;
    const fz = Math.round(focus.z * 2) * 0.5;
    this.sun.target.position.set(fx, fy, fz);
    this.sun.position.set(fx + SUN_OFFSET.x, fy + SUN_OFFSET.y, fz + SUN_OFFSET.z);
  }

  private onResize(container: HTMLElement): void {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    // Cap the backing-store scale on small screens: a 3x DPR phone rendering a
    // shadow-mapped scene at native resolution tanks the frame rate for no
    // visible gain at this art style's chunkiness.
    const dprCap = Math.min(w, h) < 700 ? 1.6 : 2;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, dprCap));
    // Narrow (portrait phone) viewports need a wider FOV or the character fills
    // the frame; widen as aspect drops below 4:3.
    const aspect = w / h;
    this.camera.fov = aspect < 1.33 ? Math.min(72, 55 / Math.max(0.62, aspect / 1.33)) : 55;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    // updateStyle must stay ON. The constructor's setSize() stamps inline
    // `width/height` in px on the canvas, and inline styles beat the
    // `canvas { width: 100% }` rule in index.html — so resizing with
    // updateStyle:false grew the backing store while the CSS box stayed at its
    // first-frame size, and the browser stretched a 1400x480 image into a
    // 1200x700 box. Measured: #app 1400x480, canvas CSS still 1200x700.
    // There is no feedback risk: #app is sized from the viewport (100%/100dvh),
    // never from its child.
    this.renderer.setSize(w, h);
    // Every render target in the chain has to follow the canvas AND the pixel
    // ratio. Missing this is the classic composer bug: the picture keeps
    // rendering at the old backing size and gets stretched over the new canvas.
    this.post?.setSize(w, h, this.renderer.getPixelRatio());
  }

  /**
   * Frame-rate cap. 0 = uncapped. Agent capture runs use 30 so software-GL
   * rendering doesn't burn time on frames nobody looks at.
   */
  setFpsCap(fps: number): void {
    this.minFrameMs = fps > 0 ? 1000 / fps : 0;
    this.nextDeadline = 0;
  }

  /**
   * Call at the top of the frame callback. Returns false when the cap says
   * this frame should be skipped — skip tick/update/render and return.
   * Because tick() reads the clock delta, a skipped frame simply rolls its
   * elapsed time into the next one, so simulation speed is unaffected.
   *
   * This targets an absolute DEADLINE rather than sleeping a fixed interval
   * since the last frame, because the interval form always undershoots. rAF only
   * offers times on a display-refresh grid, so "has 33.33 ms passed?" is answered
   * on the first tick at or after 33.33 — typically 41.7 (3 vsyncs at 72 Hz) —
   * and the error compounds: a 30 fps cap measured 26.7. Advancing the deadline
   * by exactly minFrameMs and letting it fall behind real time means a late frame
   * shortens the next interval instead of adding to it, and the long-run average
   * is the requested rate. The catch-up is clamped to one period so a tab that
   * was backgrounded for a minute does not then run unthrottled to "repay" it.
   */
  beginFrame(): boolean {
    if (this.minFrameMs <= 0) return true;
    const now = performance.now();
    if (now < this.nextDeadline) return false;
    this.nextDeadline += this.minFrameMs;
    if (this.nextDeadline < now) this.nextDeadline = now;
    return true;
  }

  /** Returns dt in seconds, clamped */
  tick(): number {
    return Math.min(this.clock.getDelta(), 0.05);
  }

  render(): void {
    // Sky dome tracks the camera so the horizon never slides (no allocs).
    this.skyDome.position.copy(this.camera.position);

    // Sun disk rides the same camera-locked shell as the dome and turns to face
    // the lens. lookAt orients +Z at the target and PlaneGeometry faces +Z.
    this.sunDisk.position.copy(this.camera.position).addScaledVector(this.sunDir, 400);
    this.sunDisk.lookAt(this.camera.position);

    // The lab replaces scene.background with a flat colour (?bg=RRGGBB) to get a
    // plain backdrop. Honour that by standing the sky down — otherwise the dome
    // covers the background and the parameter does nothing.
    const plainBackdrop = this.scene.background !== this.ownBackground;
    this.skyDome.visible = !plainBackdrop;
    this.sunDisk.visible = !plainBackdrop;

    // One shadow-map update and one stats window per frame, however many
    // renderer.render() calls the post chain makes (see the constructor).
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.info.reset();

    if (this.post) this.post.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
