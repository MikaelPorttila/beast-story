import * as THREE from 'three';
import { PostFX, readPostOptions } from './post';
import { flags } from './flags';
import { StaticShadowCache, STATIC_SHADOW_LAYER, shadowCasterCensus } from './shadow-cache';

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

// BOUNCE FILL — the anti-sun light, and the fix for black canopy undersides.
//
// MEASURED, on cam=-8,7,26 look=6,3,-4 with ?grade=0&ao=0 so neither the AO nor
// the grade could flatter the number: sunlit grass Y 0.228, the same grass on the
// shaded side of a tree Y 0.0139 — 6% — and the shaded side of the canopy itself
// #010d03, i.e. BLACK. With AO on it was 2.2%. Cube World's shaded foliage sits
// near 30% and is still recognisably the same green.
//
// A HemisphereLight cannot fix that and it is worth writing down why, because the
// obvious move is to keep winding it up. Hemisphere irradiance is a function of
// the normal's ELEVATION only: it lerps ground->sky by 0.5*n.y+0.5. So the two
// faces of a tree that differ most — the one facing the sun and the one facing
// away — receive *identical* fill, and every unit of fill added to open up the
// dark one lands on the bright one too. That is exactly the "raising it flattens
// the world" trade documented on this.ambient below, and it is why that knob has
// been nudged 0.52 -> 0.78 -> 0.86 over three rounds without ever fixing this.
//
// A second directional light IS a function of azimuth, so it can put light on the
// anti-sun faces and mathematically none on the sun-facing ones: a normal pointing
// at the sun dots to -0.87 against this direction and clamps to zero. It is the
// standard key/fill/bounce rig, and it is also physically the right story — this
// is the sunlit ground and the sky behind the camera bouncing back.
//
// The elevation is NEGATIVE (-18 degrees, from below the horizon) because bounce
// light comes off the ground. That is what reaches a canopy UNDERSIDE: a
// downward-facing normal takes 31% of this light where a horizontal-from-behind
// fill would give it 0. Faces the sun already owns take none of it either way.
//
// It casts no shadow, so it adds one dot product per fragment and no depth pass.
// It is created in the constructor before any world/beast material exists, so
// NUM_DIR_LIGHTS is 2 for every program the game ever compiles — no new
// permutation can appear mid-session and warmUpShaders() stays valid.
const BOUNCE_OFFSET = new THREE.Vector3(-160, -62, -106);

/**
 * How far the focus may drift from the shadow box's centre before the box is
 * recentred — and so, directly, how long one cached static shadow map lives
 * (core/shadow-cache.ts). At a walk of ~7 units/s this is a rebuild every 1.1 s,
 * i.e. one frame in ~130 at the 120 cap.
 *
 * IT COSTS NO COVERAGE, because `updateSunFocus` adds the same 8 units to the
 * ortho extent: the box is 8 units bigger and may sit up to 8 units behind the
 * hero, so the guaranteed radius of shadowed world around him is exactly what
 * it was. What it does cost is texel density — 80 units of half-extent instead
 * of 72, so 0.039 units per texel instead of 0.035, and a PCF penumbra on a
 * 1-unit cube of 0.078 units instead of 0.070. That is well inside the budget
 * the PCF choice in the constructor was made against (0.15 at the photo-mode
 * extent).
 *
 * Why not larger: the box is what the STATIC pass draws, so every unit of it is
 * more scenery in the rebuild AND a coarser penumbra, while a rebuild is
 * already amortised to about two draw calls a frame. Why not smaller: below
 * about 4 units the walk recentres several times a second and the cache stops
 * being one.
 *
 * MEASURED: 33 recentres over one straight 50-second walk, against 110 rebuilds
 * from chunks streaming in near enough to matter. The box is NOT the thing
 * costing rebuilds — see `takeDirty` in shadow-cache.ts for the one that is,
 * and why those are legitimate.
 */
const SHADOW_RECENTER = 8;

// The shadow camera's own axes, in world space. Constant, because the sun
// direction is: three's LightShadow points the box from the light at its target
// with `up` at +Y, so this is exactly the basis `Camera.lookAt` builds.
//
// They exist so `updateSunFocus` can snap the box centre to the SHADOW TEXEL
// GRID, which is the thing that actually stops shadow edges crawling. Rounding
// the centre in world space — which is what this used to do, to 0.5 units —
// only stops the crawl if the step happens to be a whole number of texels along
// each of these axes, and 0.5 units is 14.2 texels of a 72-unit box. Snapped
// here instead, a recentre cannot re-roll which texel an edge lands in at all.
const SHADOW_Z = new THREE.Vector3().copy(SUN_OFFSET).normalize();
const SHADOW_X = new THREE.Vector3()
  .crossVectors(new THREE.Vector3(0, 1, 0), SHADOW_Z).normalize();
const SHADOW_Y = new THREE.Vector3().crossVectors(SHADOW_Z, SHADOW_X);

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
vec3 bsSkyRadiance(float h) {
  vec3 zenith  = vec3(0.0170, 0.1900, 0.8700);  // displays #3a97ef, sat 0.76
  vec3 horizon = vec3(0.0850, 0.3900, 1.1500);  // displays #a4cbe7, sat 0.29 — a
                                                // pale CYAN, not a pale grey
  // ROUND 7, and this is the measurement that drove it. A vertical scan of the
  // sky in a wide capture (shots/_la-a-downsun.png, x = 250) read, top of frame
  // to horizon: rgb(86,152,227) sat 0.62 -> rgb(183,205,224) sat 0.18. That last
  // band is the bottom third of every wide shot and it is, numerically, GREY:
  // 41 code points of chroma on a value of 202. It is the "milky collar" the
  // colour critic filed, and because the fog samples this same function it was
  // also what every far treeline and every far shoreline dissolved into.
  //
  // Two things were spending the chroma, and both are fixed here:
  //   - the horizon constant itself. Was (0.1560, 0.4400, 1.0600). The r:b ratio
  //     was 0.147; ACES desaturates as it brightens, so by the time a value that
  //     luminous comes off the curve there is nothing left. Now 0.074 — red down
  //     45%, blue up 8% — which lands the same L (197 at the new exposure) with
  //     sat 0.29 instead of 0.18.
  //   - the warm band below, which was adding 87% of the horizon's own red.
  //
  // The zenith comes DOWN in absolute radiance (0.918 -> 0.870 blue) even though
  // the exposure goes up, so the zenith-to-horizon ramp is a colour ramp and not
  // just a brightness ramp: measured at exposure 1.20 it now runs sat 0.76 ->
  // 0.29 over the band a gameplay camera actually sees, where before it ran
  // 0.69 -> 0.16.
  //
  // The ramp finishes at 0.24 rather than 0.22. A third-person camera looks DOWN,
  // so the top of a 16:9 gameplay frame is only ~0.03-0.10 up the dome and a high
  // photo-mode frame barely more; ending the ramp early is what puts real blue in
  // the band the player actually sees. 0.22 was a shade too early once the
  // horizon end got its chroma back — the mid-band went blue so fast that the
  // gradient had a visible shoulder in it. It moves the fog on terrain almost not
  // at all, because a terrain fragment sits within a few hundredths of h = 0.
  vec3 col = mix(horizon, zenith, smoothstep(-0.06, 0.24, h));
  // Warm band hugging the horizon line (haze scattering). Kept narrow and weak:
  // this is the "hint of horizon glow", not a sunset. History: 0.20 at
  // (1.90,1.18,0.64) -> 0.12 -> 0.085 at (1.60,1.14,0.70) -> 0.050 at
  // (1.55,1.10,0.66) over a HALVED width (0.17 -> 0.075).
  //
  // The width is the part that mattered. At 0.17 the band was not hugging the
  // horizon LINE, it was covering everything within ~10 degrees of it — which on
  // a downward-looking gameplay camera is most of the visible sky. Multiplied out
  // it was adding (0.136, 0.097, 0.060) to a horizon of (0.156, 0.44, 1.06), i.e.
  // +87% red for +5.6% blue: single-handedly the largest consumer of the
  // horizon's chroma, and the direct cause of the sat-0.18 grey band measured
  // above. Halving the width and cutting the amplitude by 40% keeps the warm
  // hint exactly where the eye reads it as scattering — the last couple of
  // degrees above the ground — and stops it laundering the rest of the sky.
  float band = 1.0 - smoothstep(0.0, 0.075, abs(h));
  col = mix(col, vec3(1.55, 1.10, 0.66), band * 0.050);
  return col;
}
`;

const SKY_FRAG = SKY_LIB + /* glsl */ `
uniform vec3 uSunDir;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 col = bsSkyRadiance(d.y);

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
  //
  // The two WIDE lobes come down 0.20 -> 0.175 and 0.07 -> 0.055 this round, and
  // that is not a taste change — it is the exposure going 1.02 -> 1.20. These
  // amplitudes are linear radiance added to a blue, so what they cost is
  // SATURATION, and how much saturation a given amount costs depends entirely on
  // where the sum lands on the ACES shoulder. Modelled through the real curve, the
  // sd^4 lobe's territory went from displaying sat 0.56 at the old exposure to
  // 0.49 at the new one — i.e. the same constants quietly grew the pale wash
  // around the sun by a seventh. 0.055 puts it back at 0.55. The tight sd^260
  // core is left alone: it is the disc's rim and it is meant to be white.
  float sd = max(dot(d, uSunDir), 0.0);
  float glow = pow(sd, 260.0) * 0.30 + pow(sd, 26.0) * 0.175 + pow(sd, 4.0) * 0.055;
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
 *    what bsSkyRadiance above provides. The elevation it needs is computed in the
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
  vec3 bsFogRay = mvPosition.xyz;
  vFogElev = dot(bsFogRay, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz))
           / max(length(bsFogRay), 1e-4);
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
    float bsFogD = max(0.0, vFogDepth - fogNear) / max(1.0, fogFar - fogNear);
    float fogFactor = 1.0 - exp(-3.0 * bsFogD * bsFogD);
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
  float bsFogL = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(bsFogL * 1.10), 0.28 * fogFactor);
  // fogColor is an ABSORPTION MULTIPLIER on the sky, not a fog colour.
  //
  // three hands every fogged material a fogColor uniform and keeps it live
  // from scene.fog.color, and until issue #23 this chunk declared it and then
  // ignored it — the whole point of aerial perspective is that the target is
  // the sky gradient rather than one constant. That left NO WAY to say "the
  // light reaching you through this distance has been filtered", which is the
  // only thing separating haze from water. Underwater the fog therefore faded
  // the frame toward bright daylight: more fog was BRIGHTER, not murkier, and
  // the world/underwater.ts murk made a white room out of a lake bed.
  //
  // Multiplying keeps aerial perspective exactly as it was — the target is
  // still the per-fragment sky, so a ridge still hazes to the sky it is seen
  // against — and adds one channel-wise filter in front of it. scene.fog.color
  // is WHITE in the engine's own setup, so the above-water path is unchanged to
  // the bit; world/underwater.ts drives it toward a water absorption while the
  // lens is submerged. Multiplicative because absorption is (Beer-Lambert), and
  // for the same reason the underwater tint quad multiplies rather than mixes —
  // see the long note on SHALLOW_TINT.
  gl_FragColor.rgb = mix(gl_FragColor.rgb, bsSkyRadiance(vFogElev) * fogColor, fogFactor);
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
  // (see SKY_FRAG) and keeping the disk out of the bloom (see bsNoBloom below).
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

/**
 * The exposure a sunlit frame is graded at. Every number in post.ts's grade was
 * solved against this one, so it is the BASE that anything dimming the picture
 * scales — see `setExposureScale`, and the long note at the assignment below for
 * how 1.20 was arrived at.
 */
const DAYLIGHT_EXPOSURE = 1.20;

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  /** Anti-sun bounce fill; see BOUNCE_OFFSET. */
  readonly bounce: THREE.DirectionalLight;
  readonly ambient: THREE.HemisphereLight;
  private readonly skyDome: THREE.Mesh;
  private readonly sunDisk: THREE.Mesh;
  /** The background the sky dome is painted to match; see render(). */
  private readonly ownBackground: THREE.Color;
  private post: PostFX | null = null;
  /**
   * The cached static half of the shadow map, or null under `shadowcache=0` /
   * `shadows=0` — in which case render() falls back to the plain "redraw
   * everything, every frame" it always did. See core/shadow-cache.ts.
   */
  private shadowCache: StaticShadowCache | null = null;
  /** Runtime A/B switch over that cache; see `setShadowCacheEnabled`. */
  private shadowCacheOn = true;
  /** Current shadow ortho half-extent; see updateSunFocus(). */
  private shadowExtent = 0;
  /**
   * Where the shadow box is actually centred — texel-snapped, and up to
   * SHADOW_RECENTER units behind the focus. NaN until the first update, which is
   * what makes the first call recentre unconditionally.
   */
  private readonly shadowBoxCenter = new THREE.Vector3(NaN, NaN, NaN);
  private sunDir = new THREE.Vector3().copy(SUN_OFFSET).normalize();
  /**
   * The frame clock. `THREE.Clock` was DEPRECATED in three r183 — its own
   * source now says so and logs "Clock: This module has been deprecated.
   * Please use THREE.Timer instead." from the constructor, which is exactly
   * the line that was appearing in this game's boot console. We are on
   * 0.185.1, so the replacement is `THREE.Timer` (three/src/core/Timer.js).
   *
   * The swap is not quite like for like, and `tick()` below puts the
   * difference back. `Clock` computed its delta INSIDE `getDelta()` and
   * auto-started on the first call, so frame one measured itself and read 0.
   * `Timer` separates `update()` (advance) from `getDelta()` (query) — the
   * whole point of the redesign, so a delta can be read many times in one
   * simulation step without moving — and its `_startTime` is stamped at
   * CONSTRUCTION. Left alone, the first `update()` would therefore report the
   * entire gap between building the Engine and the first frame, which on this
   * project's boot is measured in seconds (see the boot note in main.ts). The
   * 0.05 clamp would have swallowed it, but "the clamp hides it" is not the
   * same as "the number is right", so the first tick `reset()`s first and
   * frame one still reads ~0 exactly as it always did.
   *
   * Deliberately NOT `connect(document)`: that opts into the Page Visibility
   * API to zero the delta while the tab is hidden, which `Clock` never did and
   * which this loop does not need — rAF stops firing in a hidden tab anyway,
   * and the returning frame's oversized delta is what the 0.05 clamp is for.
   */
  private readonly timer = new THREE.Timer();
  /** False until the first tick(), which is where the timer is zeroed; see above. */
  private timerStarted = false;
  private minFrameMs = 0;
  private nextDeadline = 0;

  constructor(container: HTMLElement) {
    // `antialias` is MSAA on the default framebuffer only. The post chain draws
    // into render targets, so it does nothing there and SMAAPass does the work
    // instead; the flag stays for the ?post=0 fallback path.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    // `shadows=0` drops the shadow map entirely (core/flags.ts) — a 4096^2 depth
    // pass over every caster in the streamed world is the single most expensive
    // thing a frame does, so pricing it is the first question any perf run asks.
    this.renderer.shadowMap.enabled = flags.shadows;
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
    // EXPOSURE 1.02 -> 1.20, and it is the answer to "the image is saturated but
    // never bright".
    //
    // MEASURED across four wide captures at 1.02: p99 luminance was 200-202 in
    // every single one and the fraction of pixels at or above 240 was 0.00%. The
    // brightest thing in the entire game was a cloud top. That is the poster-paint
    // read — a picture with no highlight range at all, because ACES's shoulder is
    // steep and nothing in the scene was hot enough to climb it. Modelled through
    // this exact curve plus the grade (see post.ts), a PURE WHITE lambertian
    // surface facing the sun displayed at 219; at 1.20 it displays at 229, sunlit
    // sand goes 188 -> 201 and cloud tops (white albedo plus their own emissive)
    // finally clear 240.
    //
    // It is not a free brightening and the sun/fill split below pays for it: the
    // midtones would otherwise come up with the highlights and the whole frame
    // would go milky. Sunlit grass moves 118 -> 132 while grass in cast shadow
    // moves 64 -> 50, i.e. the picture got brighter and its shadows got DEEPER.
    this.renderer.toneMappingExposure = DAYLIGHT_EXPOSURE;
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
    // bsSkyRadiance, so scene.fog.color is not read at all. The two numbers here
    // are what the chunk does use:
    //
    //   100 where haze begins. Captured at 55 first and it was too eager: the far
    //       shore of the bay, 90-120 units out and still somewhere the player
    //       walks to, was already visibly pale and the low cloud deck (which sits
    //       90-115 units up) went blue-grey and translucent. At 85 a fragment at
    //       120 units takes 9% instead of 28%.
    //       85 -> 100 this round. The curve is exp(-3 d^2) over d = (depth-near)/
    //       (far-near), so moving the near plane rescales the WHOLE mid-distance:
    //       a fragment at 150 units goes from 31% hazed to 20%, and one at 200
    //       from 68% to 63%, while the streaming edge at ~245 barely moves (89% ->
    //       88%) and so still hides chunk pop-in. That band from 120 to 180 units
    //       is where the far treeline of a vista sits, and at 31% it was arriving
    //       as pale mush with no green left; the edge of the world is the only
    //       part that is supposed to dissolve.
    //       100 -> 130 this round, same argument one more turn. Captured
    //       (shots/_la-a-downsun.png) the far treeline was still arriving as white
    //       mush with no skyline left, which is a vista with no horizon in it. The
    //       near plane is the right knob rather than the far one BECAUSE of the
    //       squared curve: at 130/270 a fragment at 150 units takes 6% instead of
    //       23% and one at 200 units takes 53% instead of 65%, while the streaming
    //       edge at ~245 goes 89% -> 87% and still hides chunk pop-in. That is the
    //       "cut the fog density about 40%" note, spent entirely on the band the
    //       player can walk to and none of it on the edge of the world.
    //   270 where haze is ~95%. Near the STREAMING RADIUS, not the far plane:
    //       VIEW_RADIUS is 5 chunks of 32 units, so the farthest terrain that
    //       exists is ~245 units away on the diagonal, which lands at ~86%. The
    //       old 420 was past the edge of the world entirely, which is why the
    //       mountains came back at full saturation — the fog never reached them.
    //
    // WHITE, and that is now load-bearing rather than decorative. The colour
    // argument used to be the horizon's displayed value on the grounds that
    // nothing read it; the patched chunk now uses it as a per-channel
    // ABSORPTION MULTIPLIER on the sky radiance it fades toward, so 1,1,1 means
    // "nothing between you and the distance" and is what keeps the daylight
    // path identical to what it was. world/underwater.ts is the only writer,
    // and it puts this back on the way out. See installAerialPerspective.
    this.scene.fog = new THREE.Fog(0xffffff, 130, 270);

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
    this.sunDisk.userData.bsNoBloom = true;
    this.scene.add(this.sunDisk);

    this.camera = new THREE.PerspectiveCamera(
      55, container.clientWidth / container.clientHeight, 0.1, 600,
    );
    this.camera.position.set(0, 12, 18);
    // The cached-shadow layer is a REAL layer, and world geometry lives on it
    // alone (see shadow-cache.ts) — so a camera that does not enable it renders
    // a world with no ground in it. This one line is the whole cost of the
    // split outside the shadow passes themselves.
    this.camera.layers.enable(STATIC_SHADOW_LAYER);

    // Warm and deliberately not brighter than it has to be: the hemisphere fill
    // below is what lifts the shadows, and every step this goes up has to be paid
    // for there or the world flattens. The warmth is what makes the cool fill read
    // as a warm/cool contrast instead of just a brighter grey. 2.55 -> 2.45 -> 2.38
    // across three rounds, each step paying for the fill going up.
    //
    // COLOUR 0xfff0cf -> 0xffebbe this round, and the intensity 2.38 -> 2.45 is
    // NOT a brightening — it is the exact compensation for it. three does not
    // normalise a light by its colour's luminance, and the new colour's relative
    // luminance is 0.841 against the old 0.881, so 2.38 * 0.881/0.841 = 2.45 puts
    // the same energy on a white surface. Everything that moves is hue.
    //
    // Why move it at all: this is the only thing in the frame that says what TIME
    // it is. Sunlit grass was arriving at #619036 — a cool acid green — because
    // the key was only barely warm and the grade's warm/cool split is a gain that
    // cannot manufacture chroma the light never had. Cube World's signature is a
    // warm yellow-green sunlit grass against a cool blue shadow, and the warmth
    // has to come from the key or it reads as an overcast noon with the colour
    // pushed in afterwards. It also widens the gap against the now-cool shadow
    // side, which is free contrast that costs no value range.
    //
    // 2.45 -> 3.05 this round, together with the hemisphere fill coming 0.86 ->
    // 0.55. This is the "I cannot tell where the sun is" fix and the two halves
    // are one change: the key goes up 24% and the fill comes down 36%, so the
    // total on a LIT up-facing surface barely moves (1.87 -> 1.94 in relative
    // irradiance) while the total on a SHADOWED one drops by a third.
    //
    // Modelled through the real tone curve and grade (post.ts), on grass:
    //   before  lit L=118, cast shadow L=64 — shadow at 54% of lit, 1.85:1
    //   after   lit L=132, cast shadow L=50 — shadow at 38% of lit, 2.61:1
    // Cube World's shadows sit near 30% of the lit surface. 38% is most of the way
    // there and stops short on purpose: the last stretch would have to come out of
    // the hemisphere fill, and that fill is the only light a canopy underside or a
    // north-facing cliff gets. The remaining gap is bought in the grade's shadow
    // floor instead (post.ts uShadowLift), which only touches the darkest values.
    this.sun = new THREE.DirectionalLight(0xffebbe, 3.05);
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

    // The bounce fill (see BOUNCE_OFFSET). A DirectionalLight is direction-only,
    // so this never needs to follow the focus the way the sun does — the position
    // is read as a direction against the target at the origin and the magnitude is
    // irrelevant.
    //
    // COLOUR: what light bouncing off sunlit grass and sand actually is — warm,
    // slightly green-yellow, and DESATURATED. The saturation is the constraint,
    // not the hue: the ambient's ground half was 0x6b7f52 (saturated grass green)
    // in an earlier round and it hue-rotated sunlit sand to olive, which reads as
    // mould. 0xd7cfa6 carries the warmth with a max-min chroma of 0.20 linear,
    // low enough that it tints rather than repaints, and it is the warm half of
    // the warm/cool story the cool sky fill already tells.
    //
    // INTENSITY 0.42, swept against the measurement in BOUNCE_OFFSET's comment.
    // It is a fill, so it must stay well under the sun (2.38) or the anti-sun side
    // of a tree starts to look like a second noon.
    // 0.42 -> 0.38: a token trim, not a cut. The hemisphere fill above is losing
    // 36% of its strength this round, and this light is what keeps a canopy
    // UNDERSIDE off black when that happens — it is the one fill term that lands
    // on downward and anti-sun normals and mathematically none on the sun-facing
    // ones, so unlike the hemisphere it cannot flatten anything. It comes down at
    // all only because the key went up 24% and a fill has to keep its distance.
    this.bounce = new THREE.DirectionalLight(0xd7cfa6, 0.38);
    this.bounce.position.copy(BOUNCE_OFFSET);
    this.bounce.castShadow = false;
    this.scene.add(this.bounce);
    this.scene.add(this.bounce.target);

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
    // ROUND 7: 0.86 -> 0.55 with the sun going 2.45 -> 3.05 (see there for the
    // measured before/after). This reverses four rounds of winding this knob up
    // (0.52 -> 0.78 -> 0.86) and the reason is that every one of those rounds was
    // paying for a problem that has since been fixed somewhere better. The dark
    // canopy underside that 0.78 and 0.86 were chasing is now held up by the
    // BOUNCE light, which is a direction and so cannot flatten the sun-facing
    // side; the crushed shadow midtones are held up by the grade's shadow floor,
    // which only touches the darkest values. What was left of this number was
    // pure flattening: a shadowed up-facing surface is lit by this light ALONE,
    // so 0.86 against a 2.45 sun is exactly why "shadows=0 vs default changes
    // only 9% of pixels" and why open ground read as lit from nowhere.
    //
    // The sky half goes 0xc2dcf9 -> 0xb4d6fb at the same time. That is the OTHER
    // half of "shadows must read cooler": with the fill at 0.55 it is a smaller
    // share of a lit surface's total, so it can afford more chroma without
    // tinting the lit world, and a shadowed surface — which sees nothing else —
    // gets a measurably bluer cast. Measured on the model, shadowed sand goes
    // from rgb(99,106,82) (a warm olive, i.e. the acid-green shadow filed against
    // this) to rgb(74,87,72), where the blue channel no longer sits below the red.
    this.ambient = new THREE.HemisphereLight(0xb4d6fb, 0x8fa4bd, 0.55);
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

    // The scene's world matrices are updated ONCE, at the top of render(),
    // rather than by three at the top of each renderer.render() call. Two
    // reasons, and the first is a correctness one: the shadow work now happens
    // before the post chain runs, and it reads the light's and every caster's
    // matrixWorld. The second is that a frame makes half a dozen render() calls
    // — the scene, the AO prepass, the bloom pass, and the two the shadow cache
    // adds — and only one of them can possibly have anything to recompute.
    //
    // The second reason turned out to be worth more than the feature it was
    // done for. Measured with the interleaved A/B in tools/test-shadowcache.mjs
    // on an RTX 3070 Ti at 1280x800: **-0.46 ms standing and -0.58 ms walking**,
    // unanimous across every alternation, on a 5-6 ms frame. Three walks the
    // whole graph per render() whether or not anything in it moved, and a
    // streamed world is a couple of thousand objects.
    this.scene.matrixWorldAutoUpdate = false;
    if (flags.shadows && flags.shadowCache) this.shadowCache = new StaticShadowCache();

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
    // Ceiling 112 -> 152. The floor and the slope are untouched: the gameplay
    // camera sits ~12 units behind the player, wants 68 and gets 72 (80 once the
    // recentre margin below is added), nowhere near either end. This only moves photo-mode and
    // fly-cam framings, and there it fixes a real hole — VIEW_RADIUS streams
    // terrain to ~245 units, so a 112-unit box left more than half of every vista
    // with no cast shadow at all, which is exactly the "flat diorama" read on a
    // wide shot. 152 covers roughly twice the area for 0.073 units/texel instead
    // of 0.055; PCF spans ~2 texels either way, so the penumbra on a 1-unit cube
    // goes from 0.11 to 0.15 units — still a recognisably 1-unit edge, which is
    // the constraint the PCF choice in the constructor was made against.
    // Plus SHADOW_RECENTER, so that the box may LAG the focus by that much
    // without the shadowed radius around the hero shrinking. See the constant.
    const s = Math.round(Math.min(152, Math.max(64, want)) / 8) * 8 + SHADOW_RECENTER;
    const resized = s !== this.shadowExtent;
    if (resized) this.setShadowExtent(s);

    // THE BOX MOVES IN JUMPS NOW, and both halves of that are deliberate.
    //
    // It moves RARELY because a cached static shadow map is only valid while the
    // light matrix it was rendered with is: recentring every frame would rebuild
    // the cache every frame and the whole thing would be a fullscreen quad's
    // worth of pure loss. So the focus is allowed to wander SHADOW_RECENTER
    // units inside the box before the box follows it.
    //
    // It moves in whole TEXELS because that is what stops shadow edges crawling.
    // The previous version rounded the centre to 0.5 world units and said in a
    // comment that a fixed light direction made that a light-space quantisation
    // too; it does not — 0.5 units is 14.2 texels of the box it was written for,
    // so every step re-rolled which texel each edge fell in. Projecting onto the
    // shadow camera's own axes (SHADOW_X/Y, constant because the sun is) and
    // rounding THERE makes the claim true, and is what lets the box jump 8 units
    // without a visible shimmer at the seam.
    const texel = (2 * s) / this.sun.shadow.mapSize.x;
    const drift = this.shadowBoxCenter.distanceToSquared(focus);
    if (!resized && Number.isFinite(drift) && drift <= SHADOW_RECENTER * SHADOW_RECENTER) return;
    const u = Math.round(focus.dot(SHADOW_X) / texel) * texel;
    const v = Math.round(focus.dot(SHADOW_Y) / texel) * texel;
    const w = focus.dot(SHADOW_Z);
    this.shadowBoxCenter
      .copy(SHADOW_X).multiplyScalar(u)
      .addScaledVector(SHADOW_Y, v)
      .addScaledVector(SHADOW_Z, w);
    const c = this.shadowBoxCenter;
    this.sun.target.position.copy(c);
    this.sun.position.set(c.x + SUN_OFFSET.x, c.y + SUN_OFFSET.y, c.z + SUN_OFFSET.z);
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
    // `Timer` stamps its origin when it is CONSTRUCTED, so the first update
    // would otherwise bill this frame for the whole boot; reset() re-bases it
    // on now, which reproduces Clock's auto-start (frame one reads ~0).
    if (!this.timerStarted) {
      this.timerStarted = true;
      this.timer.reset();
    }
    this.timer.update();
    return Math.min(this.timer.getDelta(), 0.05);
  }

  /**
   * Dim the whole picture, as a fraction of the daylight exposure.
   *
   * THE ONE KNOB THAT WORKS ON A FRAME THAT IS ALREADY TOO BRIGHT, and issue #23
   * is why it exists. The underwater tint (world/underwater.ts) is a MULTIPLY,
   * and a multiply lands on LINEAR HDR radiance here — before ACES, not after.
   * Sunlit sand under two metres of water renders near 2.6 linear, so tinting it
   * to 0.38 of its red still leaves 1.0, which ACES maps to 201/255 and
   * desaturates on the way: the lake bed came back white whatever colour the
   * tint was. Measured on the same dive, the identical frame with `?post=0` —
   * where the multiply lands on already-tone-mapped values instead — read
   * (75, 175, 255) at saturation 0.71 against (201, 226, 232) at 0.13.
   *
   * Absorption belongs in the scene, so the answer is not to move the tint after
   * the curve; it is that there is LESS LIGHT down there, and the exposure is
   * what says so. Dropping it puts the radiance back on the part of the curve
   * that still has chroma, and the tint then colours a picture that can be
   * coloured.
   *
   * Written through `renderer.toneMappingExposure` rather than to the output
   * pass, deliberately: PostFX.render() reads that live precisely so the
   * composer path and the `?post=0` fallback can never drift apart.
   */
  setExposureScale(k: number): void {
    this.renderer.toneMappingExposure = DAYLIGHT_EXPOSURE * k;
  }

  /**
   * Hand the underwater state to the output pass. See `PostFX.setUnderwater`.
   *
   * A no-op under `?post=0`, and that is worth knowing rather than fixing: with
   * no output pass there is no underwater grade, so `post=0` is the isolation
   * view that shows what the scene looks like before the water is applied to it.
   * That is exactly how issue #23 was diagnosed.
   */
  setUnderwater(amount: number, depth: number, time: number): void {
    this.post?.setUnderwater(amount, depth, time);
  }

  /** One post pass on or off, for the F3 panel. See `PostFX.setPassEnabled`. */
  setPassEnabled(which: 'ao' | 'bloom' | 'aa', on: boolean): void {
    this.post?.setPassEnabled(which, on);
  }

  /**
   * Shadows on or off at runtime.
   *
   * The expensive half is not the flag, it is `needsUpdate`: whether a material
   * receives shadows is a PROGRAM permutation in three, so every material in the
   * scene has to be relinked when this changes — a stall of a few hundred
   * milliseconds the first time each direction is taken, and nothing afterwards
   * (the programs are cached, so flipping back is instant). That cost is
   * acceptable for a setting a player changes once and unacceptable per frame,
   * which is why this early-returns when nothing moved rather than trusting the
   * caller.
   *
   * `?shadows=0` at construction is a stronger statement and this cannot undo
   * it: with no shadow-casting light set up there is nothing to switch back on.
   */
  setShadowsEnabled(on: boolean): void {
    if (!flags.shadows || this.renderer.shadowMap.enabled === on) return;
    this.renderer.shadowMap.enabled = on;
    this.renderer.shadowMap.needsUpdate = true;
    // The cached half is stale by construction after a spell with the map
    // switched off: nothing was drawn into it, and the world moved on.
    this.shadowCache?.invalidate();
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (!m) return;
      if (Array.isArray(m)) for (const x of m) x.needsUpdate = true;
      else m.needsUpdate = true;
    });
  }

  /**
   * Switch the cache off and on at runtime, for A/B measurement only.
   *
   * `shadowcache=0` is the same A/B across two page loads and is what a capture
   * uses; this is the form a PERFORMANCE run needs, because frame cost on a
   * desktop drifts by more than the thing being measured over the minute two
   * loads take. Interleaved in one page, against one stretch of world, the drift
   * cancels — see tools/test-shadowcache.mjs.
   */
  setShadowCacheEnabled(on: boolean): void {
    if (!this.shadowCache) return;
    this.shadowCacheOn = on;
    this.shadowCache.invalidate();
  }

  /** What the cache did this frame; see `__dbgShadows()`. */
  shadowDebug(): Record<string, unknown> {
    return {
      enabled: this.renderer.shadowMap.enabled,
      cached: this.shadowCache !== null && this.shadowCacheOn,
      extent: this.shadowExtent,
      ...(this.shadowCache?.debug() ?? {}),
      ...shadowCasterCensus(this.scene),
    };
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

    // EVERY WORLD MATRIX, ONCE, and it has to be here rather than at the top of
    // the method: the sky dome and the sun disk are moved a few lines up, and
    // with `scene.matrixWorldAutoUpdate` off (see the constructor) nothing else
    // is going to pick that up. Everything below reads matrixWorld — the shadow
    // passes directly, the post chain through three.
    this.scene.updateMatrixWorld();

    // One shadow-map update and one stats window per frame, however many
    // renderer.render() calls the post chain makes (see the constructor).
    //
    // With the cache on, "one update" is one pass over the ACTORS plus a
    // fullscreen quad carrying the world; without it, the plain flag that
    // redraws every caster in the world. Both leave `needsUpdate` false behind
    // them, so the chain's remaining render() calls add nothing either way.
    // The stats window opens FIRST, so the shadow pass lands inside it. That is
    // what lets a probe read the cache's saving straight off the draw counter
    // (tools/test-shadowcache.mjs does) instead of having to infer it from a
    // millisecond figure that moves with the weather on the host.
    this.renderer.info.reset();
    if (this.shadowCache && this.shadowCacheOn && this.renderer.shadowMap.enabled) {
      this.shadowCache.update(
        this.renderer, this.scene, this.camera, this.sun, SHADOW_X, SHADOW_Y,
      );
    } else {
      this.renderer.shadowMap.needsUpdate = true;
    }

    if (this.post) this.post.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
