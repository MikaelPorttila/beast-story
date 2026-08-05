/**
 * WATERFALLS — a reusable, parameterised falling-water effect.
 *
 * One `Waterfall` is a scrolling translucent sheet plus a spray field, drawn in
 * two calls and animated entirely in the shader. It knows nothing about what it
 * hangs off: it is built in its OWNER's coordinate frame and added to whatever
 * `Object3D` the owner hands it to, so the same class serves a fall off a flying
 * island and a weir in a millrace. Everything that makes one fall THIS fall is
 * in `WaterfallSpec` — the `ParticleKind` idiom from `touch-particles.ts`, so a
 * second site is data and not a second file.
 *
 * WHY A SHEET AND NOT CUBES. The sky island's fall was 40 courses of opaque
 * voxels baked into the rock mesh, and it never moved. The comment defending
 * that ("a translucent quad here would be the one surface in the game that is
 * not") stopped being true when `world/water.ts` became a translucent shaded
 * surface — and it was never the real constraint anyway. `shot-sky` frames the
 * island 280-375 units out, where one 1.2-unit cube is under three pixels: the
 * soft, moving, feathered plume a waterfall needs cannot be spelled in cubes at
 * that distance. What keeps the sheet in THIS world instead is the mask: every
 * field in it is quantised to `TILE_U`, three voxel cells, so the fall's
 * fibres and its frayed silhouette sit on the same lattice the island's cubes
 * do. That is the stylisation lever, and it is the one number to move if the
 * fall ever reads as stock VFX.
 *
 * THE TECHNIQUE is the standard one, and it is standard because it is cheap:
 *
 *   - a few crossed quad strips, so the plume has a body from every bearing and
 *     feathers at the silhouette through texture alpha rather than geometry
 *     (the lesson `makeBeamRibbonGeo` in combat/vfx.ts records);
 *   - ONE RGB mask sampled TWICE at mutually irrational scales and panned at
 *     two speeds — the two-layer panner. Two taps of one texture is what turns a
 *     repeating stripe into water;
 *   - the acceleration is baked into the UVs (`pow(v, UV_EASE)`), not computed
 *     per frame: a constant scroll over a non-linearly stretched V speeds the
 *     water up as it falls, for nothing;
 *   - the tail dissolves against a low-frequency erosion field, so the fall
 *     frays out instead of ending on a ramp.
 *
 * BROWSER ONLY, deliberately: the mask is a canvas. `tools/test-zfight.mjs`
 * runs in plain Bun with no DOM and imports rigs and settlement parts, never
 * this — keep it that way, exactly as `combat/vfx.ts` is kept that way.
 *
 * DETERMINISM IS A REQUIREMENT, not a nicety. Every curated capture in `shots/`
 * is a still of a moving effect, so under `flags.photo` the sheet clock pins to
 * `PHOTO_CLOCK` and the spray runs a fixed pre-roll and then stops. Nothing in
 * this file may call `Math.random()` or `performance.now()` — the seeded
 * `mulberry32` stream is the only source of randomness, which is also what makes
 * the lab's `?t=` path (a fixed 1/60 loop rendering exactly one frame)
 * reproducible.
 */
import * as THREE from 'three';
import { flags } from '../core/flags';
import { mulberry32 } from './noise';

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/**
 * Everything a fall needs to be THIS fall rather than a generic one.
 *
 * Lives here rather than in `core/types.ts` because nothing outside `src/world/`
 * constructs one — the hub is for what crosses the `World` interface, and a type
 * used inside one directory stays with its implementation (`ContactMover` and
 * `ParticleKind` in touch-particles.ts are the precedent). Move it to the hub
 * the day a beast skill or a piece of content builds a waterfall.
 *
 * The frame is the OWNER'S: +Y up, and the anchor is the point on the lip the
 * water leaves from. `bearing` is a project bearing — measured from +Z toward
 * +X — and the group is rotated by it, so inside this file local +Z is
 * downstream, local +X is across to the right of it, and local -Y is down.
 */
export interface WaterfallSpec {
  // -- required -------------------------------------------------------------
  /**
   * How far it falls before it is FULLY INVISIBLE, in world units.
   *
   * A hard bound, not a fade hint: the geometry stops here and the shader's
   * dissolve reaches zero alpha here, so nothing can be drawn past it whatever
   * the other numbers say. One of the two knobs issue #86 names.
   */
  length: number;
  /**
   * Total sideways offset, ACROSS the bearing, accumulated over `length`.
   *
   * The other knob issue #86 names. Positive is local +X. It reaches the spray
   * as well as the sheet — see `seedDrop` — or the two halves of the effect
   * would disagree about which way the wind is blowing.
   */
  lateralPush: number;
  /** Anchor on the lip, in the owner's frame. */
  x: number;
  y: number;
  z: number;
  /** Which way the water is heading. Radians, from +Z toward +X. */
  bearing: number;

  // -- shape, all defaulted -------------------------------------------------
  /** Full width where it leaves the lip. Default 7.2 = 2 map-blocks (SPEC §6). */
  lipWidth?: number;
  /** Full width at its widest. Default 10.8 = 3 map-blocks (SPEC §6). */
  spreadWidth?: number;
  /** Full width where it dissolves. Default 6.0 — it gathers as it drops. */
  tailWidth?: number;
  /** Where `spreadWidth` is reached, as a fraction of `length`. Default 0.10. */
  spreadAt?: number;
  /** Push ALONG the bearing: the stream's own exit speed. Default 1.6. */
  outwardPush?: number;
  /** Where the dissolve begins, as a fraction of `length`. Default 0.62. */
  fadeStart?: number;
  /**
   * Half-angle the outer sheets are splayed to, radians. Default 0.55 (~31°).
   *
   * This is the fix for the defect the voxel fall was widened twice for: seen
   * from off-axis a single sheet is a PALE WIRE hanging under the island, which
   * the eye reads as a rendering artefact rather than as a river. At 0.55 the
   * outer sheets still show `sin(0.55)` = 52% of their width edge-on, so the
   * plume has a body from every bearing `shot-sky` frames it from.
   */
  cross?: number;
  /** Crossed sheets. Default 3. Drop to 2 to halve the overdraw. */
  sheets?: number;
  /** Rows down the sheet. Default 26. */
  segments?: number;

  // -- look, all defaulted --------------------------------------------------
  /** UV scroll multiplier. 1 is the tuned default. */
  flow?: number;
  /** Head foam. Default #BCE6F0, the SPEC §6 head. */
  foam?: number;
  /** Water lit / body / shadowed. Defaults are the SPEC §6 teal. */
  bodyLit?: number;
  bodyDark?: number;
  bodyShadow?: number;
  /** Spray budget. Default 128; 0 draws no spray and allocates no pool. */
  spray?: number;
  /**
   * What it lands in, in the owner's frame, or null for a fall that dissolves
   * in open air. Non-null clamps `length` to the drop and moves the dissolve
   * most of the way down, because a fall that reaches a pool must arrive.
   */
  basin?: { y: number; radius: number } | null;
  /**
   * Let the owner's own motion drag the plume. Only meaningful on a carrier —
   * see `update`. Off by default: a weir does not move.
   */
  swayFromCarrier?: boolean;
  /** The one source of randomness in the whole module. */
  seed?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * World size of one texture tile ACROSS the fall.
 *
 * THE VOXEL GAUGE, and the one number that decides whether a translucent sheet
 * belongs in a world of cubes. The mask carries three fibres of flow striation
 * per tile, so a fibre is 1.2 units wide — exactly `CELL` in
 * world/sky-island.ts. Move this and the fall stops agreeing with the rock it
 * comes off.
 */
const TILE_U = 3.6;

/**
 * ...and ALONG it, which is a different number and has to be.
 *
 * The mask is one square texture, but a waterfall is not square: its detail is
 * fine across (threads a cell wide) and LONG down (a thread runs for metres).
 * Tiling both axes at `TILE_U` put thirteen repeats down a 48-unit fall, so
 * every field the mask varies slowly in — the thread's own brightening, the
 * foam clumps, the erosion — repeated every 3.6 units and the sheet came back
 * as a lattice of speckle rather than as water (shots/_wf-b.png). At 12 there
 * are four repeats over the same fall and the slow fields stay slow.
 *
 * This is also why the scroll rates below are what they are: a tile is now
 * 12 units of world, not 3.6.
 */
const TILE_V = 12.0;

/** Mask resolution. 256 is two texels per centimetre of fibre at `TILE_U`. */
const MASK = 256;

/**
 * How the lateral push accumulates with depth.
 *
 * A constant sideways force gives displacement and depth both proportional to
 * t², i.e. displacement LINEAR in depth — the honest exponent is 1. It is 1.35
 * because a real plume also loses coherence as it falls, and slightly
 * super-linear is what reads as BLOWN rather than as sheared: the top of the
 * fall stays on the lip where the eye expects it and the tail is what travels.
 */
const PUSH_EXP = 1.35;

/**
 * ...and it BOWS. A perfectly straight column reads as a ruler drawn on the sky.
 *
 * ONE BEND, and that is the whole of this constant. It was carried over from
 * the voxel fall as a rate per world unit (0.175 rad/unit, from `sin(k * 0.21)`
 * in cells), which over a 48-unit drop is one and a third CYCLES — an S. On a
 * fall you can walk around, an S reads as two separate mid-air kinks with
 * nothing to have caused either, and it was the first thing reported from play.
 * Half a period over the whole fall, whatever the fall's length, is a plume
 * that leans out and comes back: one bend, and it stays one bend on a three-
 * unit weir and on a fifty-unit drop alike.
 *
 * `WANDER_TURNS` is in HALF-PERIODS, so 1 is a single arch. Push it past 2 and
 * the S is back.
 */
const WANDER_TURNS = 1.0;
const WANDER_A = 1.68;

/** Lateral offset of the bow at `v`, in world units. See `WANDER_TURNS`. */
function wander(v: number): number {
  return Math.sin(v * Math.PI * WANDER_TURNS) * WANDER_A;
}

/**
 * V-curve. `uv.y = pow(v, UV_EASE) * tiles` stretches the texture toward the
 * lip and compresses it toward the tail, so a CONSTANT scroll rate covers more
 * world units per second the further the water has fallen. That is the whole of
 * the acceleration, and it costs nothing per frame.
 */
const UV_EASE = 0.72;

/**
 * Scroll rates, in texture tiles per second, for the two panner layers.
 *
 * Derived rather than guessed, then rounded. At the default 48-unit fall
 * `d(uv.y)/d(world y)` is about 0.073 mid-plume, so layer A covers roughly
 * 12 world units a second there and layer B — sampled at 2.17x the scale —
 * about 16. Real water arriving off a 48-unit drop is doing 30 m/s, which
 * renders as a grey blur; a stylised fall wants to be legibly fast, not
 * literally fast.
 *
 * The two rates and the two UV scales in the fragment shader are mutually
 * irrational, so the layers never beat back into phase and print a pattern.
 */
const SCROLL_A = 0.90;
const SCROLL_B = 2.60;

/** Stylised gravity for the spray, units/s². Sets the plume's time of flight. */
const GRAV = 22;

/** Frozen clock under `photo=1`. Arbitrary — it only has to never change. */
const PHOTO_CLOCK = 9.0;

/**
 * Seconds of spray integrated on the first frozen frame.
 *
 * Freezing the pool at t = 0 would give a fully deterministic EMPTY field,
 * which is the wrong kind of reproducible. Long enough that the longest-lived
 * droplet has reached the tail at the default length.
 */
const PHOTO_PREROLL = 4.0;

/** How hard the carrier lean is allowed to pull the tail, world units. */
const LEAN_MAX = 4.0;

/** Module scratch — no allocation in any update path. */
const _col = new THREE.Color();

// ---------------------------------------------------------------------------
// The mask
// ---------------------------------------------------------------------------

/**
 * ONE 256² texture carrying three independent fields, one per channel. Three
 * fields, one sampler, one texture unit — and the fragment shader takes two
 * taps of it, so six fields' worth of variation for two fetches.
 *
 * EVERY TERM IS PERIODIC IN BOTH AXES (whole cycles over 0..1), which is what
 * lets both axes wrap: the sheet tiles vertically as it scrolls and the mask
 * repeats across a plume wider than one tile, and neither seams.
 */
function makeFallMask(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = MASK;
  c.height = MASK;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(MASK, MASK);
  const d = img.data;
  const TAU = Math.PI * 2;
  for (let y = 0; y < MASK; y++) {
    const v = y / MASK;
    for (let x = 0; x < MASK; x++) {
      const u = x / MASK;

      // R — FLOW STRIATION, and the ORIENTATION here is the whole point. Water
      // in a fall runs in long threads DOWN it, so the field has to vary fast
      // across (u) and slowly along (v): three fibres per tile across, phase
      // pushed by two slow harmonics of v so a thread wanders instead of ruling
      // a straight line. Built the other way round first — fast in v, slow in
      // u — and the sheet came back as a field of speckle with no direction in
      // it at all (shots/_wf-a.png), which is the difference between water and
      // television static.
      const fib = 0.5 + 0.5 * Math.sin(
        TAU * 3 * u + 1.1 * Math.sin(TAU * 1 * v) + 0.6 * Math.sin(TAU * 2 * v),
      );
      // ...and a thread brightens and dims ALONG its length, or the sheet is a
      // set of parallel pipes. Slow, and skewed by u so neighbours are out of
      // step.
      const along = 0.70 + 0.30 * (0.5 + 0.5 * Math.sin(TAU * 2 * v + TAU * u));
      const r = (0.34 + 0.66 * fib) * along;

      // G — FOAM CLUMPS. Three oblique waves, none axis-aligned, then squared
      // to pull the field into blobs with gaps between them rather than a
      // smooth wash. This drives both the head mix and the ragged silhouette,
      // so it has to have real holes in it. Weighted toward u for the same
      // reason R is: a clump of foam in a fall is stretched by the fall.
      const cl = (
        Math.sin(TAU * (4 * u + 1 * v))
        + Math.sin(TAU * (3 * u - 1 * v))
        + Math.sin(TAU * (6 * u + 2 * v))
      ) / 3;
      const g = Math.pow(0.5 + 0.5 * cl, 2.2);

      // B — EROSION. One low frequency, because this is the threshold the tail
      // dissolves against and its job is to make the fall fray in broad tongues
      // rather than fade as a flat ramp. Any faster and the tail goes to noise.
      const b = 0.5 + 0.5 * (
        Math.sin(TAU * (1 * u + 1 * v)) * 0.62
        + Math.sin(TAU * (2 * u - 1 * v)) * 0.38
      );

      const i = (y * MASK + x) * 4;
      d[i] = Math.round(255 * r);
      d[i + 1] = Math.round(255 * g);
      d[i + 2] = Math.round(255 * b);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  // NOT sRGB. These are three scalar FIELDS the shader does arithmetic with,
  // not a colour — decoding them through a transfer function would bend every
  // threshold in the fragment stage away from the value written here.
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

const SHEET_VERT = /* glsl */ `
uniform vec2 uLean;
attribute float aLife;
attribute float aAcross;
varying float vLife;
varying float vAcross;
varying vec2 vMaskUv;
varying vec3 vNrm;
#include <fog_pars_vertex>
void main() {
  vLife = aLife;
  vAcross = aAcross;
  vMaskUv = uv;
  vNrm = normalize(mat3(modelMatrix) * normal);
  vec3 p = position;
  // THE CARRIER LEAN, and it is NOT the spec's lateralPush — that one is baked
  // into the vertices at build time and describes the wind at this site. This
  // one is the owner's own motion dragging the plume, it lives in a uniform,
  // and it is zero for anything that does not move. Keep them apart or the next
  // person tunes one and blames the other.
  float k = pow(aLife, 1.6);
  p.x += uLean.x * k;
  p.z += uLean.y * k;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

/**
 * All colours reaching `gl_FragColor` are LINEAR — the uniforms are converted
 * once on the way in (`THREE.Color.setHex(hex, SRGBColorSpace)` lands in the
 * renderer's working space). Writing sRGB numbers straight into a raw shader
 * lightens and desaturates everything by roughly c^(1/2.2), which is exactly
 * the mistake world/water.ts documents at its own FRAG.
 */
const SHEET_FRAG = /* glsl */ `
uniform sampler2D uMask;
uniform float uTime;
uniform float uFlow;
uniform float uFadeStart;
uniform float uTileW;
uniform vec3 uFoam;
uniform vec3 uLit;
uniform vec3 uBody;
uniform vec3 uShadow;
uniform float uOpacity;
varying float vLife;
varying float vAcross;
varying vec2 vMaskUv;
varying vec3 vNrm;
#include <fog_pars_fragment>

// MUST match SUN_OFFSET in core/engine.ts, normalised, and it is the same
// vector world/water.ts uses. In xz it is (0.833, 0.554), which is exactly the
// island's baked SUN_AZ_X / SUN_AZ_Z — one sun, so the fall's shading and the
// rock's baked shading cannot disagree about which side is lit.
const vec3 SUN_DIR = vec3(0.6554, 0.6168, 0.4356);

/** Where the head foam ends, as a fraction of the fall. */
const float HEAD = 0.10;

void main() {
  // Across-sheet U is in WORLD UNITS over the tile size, not 0..1, so a fibre
  // stays 1.2 units wide whatever the plume's width is doing. The 0..1 U is
  // kept separately for the silhouette, which is a fraction of the width by
  // definition.
  float uw = vAcross / uTileW;

  // THE TWO-LAYER PANNER. Two taps of one texture at mutually irrational
  // scales, panned at different rates: layer A is the body of the flow and
  // layer B is the faster detail riding on it. One tap is a moving stripe; two
  // is water.
  vec2 uvA = vec2(uw,        vMaskUv.y - uTime * uFlow * ${SCROLL_A.toFixed(2)});
  vec2 uvB = vec2(uw * 0.63, vMaskUv.y * 2.17 - uTime * uFlow * ${SCROLL_B.toFixed(2)});
  vec3 a = texture2D(uMask, uvA).rgb;
  vec3 b = texture2D(uMask, uvB).rgb;

  // Screen-ish combine rather than a product: multiplying two masks that are
  // both mostly dark leaves a sheet with no bright threads in it at all.
  // NORMALISED to 0..1, because the raw sum peaks at 1.55 and everything below
  // multiplies colour by it — unnormalised it drove the water a full stop past
  // the SPEC teal and the plume came back electric cyan (shots/_wf-a.png).
  float flow = clamp(a.r * 0.55 + b.r * 0.55 + a.r * b.r * 0.45, 0.0, 1.40) / 1.40;
  float foamK = max(a.g, b.g * 0.8);
  float erode = a.b;

  // THE HEAD IS WHITE WATER. The brightest part of a fall is where it breaks
  // over the lip, and past the head the foam only survives where the clump
  // field says it does.
  float head = 1.0 - smoothstep(0.0, HEAD, vLife);
  // 0.20, not 0.35. Past the head the foam field covers a good half the sheet,
  // so a third of it mixed toward a near-white foam lifted the WHOLE plume off
  // the SPEC teal and it came back a pale cyan against the grey cliff
  // (shots/_wf-isl1.png). Foam past the lip is a highlight on water, not a
  // second colour the water is made of.
  float white = clamp(head + foamK * 0.20 * (1.0 - vLife), 0.0, 1.0);

  // Two-stop sun walk. A sheet has one normal per side, so this is a lit face
  // and a shaded face and the gradient between them — enough for the plume to
  // turn as the island turns, and no more than the rest of the world does.
  float sun = dot(normalize(vNrm), SUN_DIR);
  vec3 water = mix(uShadow, uBody, smoothstep(-0.55, 0.15, sun));
  water = mix(water, uLit, smoothstep(0.15, 0.75, sun));
  // The flow threads brighten the water rather than tinting it: the fibres in a
  // fall are where the light gets through, not a different liquid. Centred on
  // 1.0 so the sheet's MEAN stays on the SPEC teal and the threads move either
  // side of it, rather than the whole plume riding above it.
  water *= 0.74 + 0.38 * flow;

  // THE SILHOUETTE IS TEXTURE ALPHA, not geometry, so the plume feathers and
  // frays at its edges instead of ending on a straight cut. The foam field
  // widens the soft band where it is strong, which is what puts torn wisps on
  // the outside of the fall.
  float across = 1.0 - abs(vMaskUv.x * 2.0 - 1.0);
  float edge = smoothstep(foamK * 0.30, 0.26 + foamK * 0.30, across);

  // A DENSE CORE AND THIN SHOULDERS. Without this every sheet is one flat value
  // across its whole width and the plume reads as a painted ribbon: a fall is a
  // volume, and the middle of it is where the water is deep enough to take a
  // colour. Cheap: across was already computed for the silhouette.
  water *= mix(1.08, 0.88, across);
  vec3 col = mix(water, uFoam, white);

  // A THICKENING SHEET: thin and see-through where it leaves the lip, dense
  // through the body.
  //
  // DENSE, and that is the fix for "the plume is a pale cyan wash". At 0.42-0.72
  // the sky read through the water everywhere and the SPEC teal never survived
  // the blend — what reached the frame was the BACKGROUND tinted, not water
  // (shots/_wf-c.png). A fall you can see the sky through is mist; a fall is
  // nearly opaque through its body and translucent only at its edges, which the
  // silhouette term below is what provides.
  float alpha = mix(0.55, 0.92, smoothstep(0.0, 0.30, vLife));
  // The threads modulate the sheet, they do not perforate it: at 0.55 + 0.45
  // the gaps between fibres went to half alpha and the whole plume read as
  // gauze.
  alpha *= edge * (0.74 + 0.26 * flow);

  // THE 'length' PARAMETER, enforced in the shader as well as in the geometry.
  // vLife runs 0..1 over exactly WaterfallSpec.length, so this reaches zero AT
  // the
  // parameter — nothing can hang past it. Eroding the threshold per column is
  // what makes the tail fray into tongues instead of fading as a flat band.
  alpha *= 1.0 - smoothstep(uFadeStart - erode * 0.25, 1.0, vLife);

  // The head is nearly opaque regardless, for the same reason world/water.ts
  // forces its surf band to 0.95: at gameplay distance it is the ALPHA and not
  // the colour that makes a white band read.
  alpha = max(alpha, head * 0.75 * edge);

  // ...but the TOP EDGE fades in, and that is what stops the head reading as a
  // slab. The sheets are splayed about the fall's axis, so from a camera above
  // the deck their top rows stack up into three overlapping quads at full
  // head-foam white — a hard-edged paving stone lying at the lip, which is
  // exactly what it looked like from the fence. Fading the first courses lets
  // the channel behind show through them, so the water arrives at the edge and
  // goes over it instead of starting there.
  alpha *= smoothstep(0.0, 0.045, vLife);

  gl_FragColor = vec4(col, alpha * uOpacity);
  #include <fog_fragment>
}
`;

// ---------------------------------------------------------------------------
// The spray
// ---------------------------------------------------------------------------

/**
 * Camera-facing quads billboarded in the VERTEX STAGE, not `gl_PointSize`.
 *
 * `gl_PointSize` is in device pixels, so a point cloud has to be told the
 * canvas height and the projection's vertical term every frame to keep a
 * world-space size (world/underwater.ts does exactly that). A waterfall is
 * built by a world object that has no business holding the canvas, and the
 * billboard costs two adds in a shader that was going to run anyway. Offsetting
 * in VIEW space also means the parent's rotation moves the droplet and leaves
 * the sprite square to the lens, which is the whole reason spray is not
 * geometry.
 */
const SPRAY_VERT = /* glsl */ `
attribute vec2 aCorner;
attribute vec3 aCentre;
attribute float aSize;
attribute float aFade;
varying vec2 vCorner;
varying float vFade;
#include <fog_pars_vertex>
void main() {
  vCorner = aCorner;
  vFade = aFade;
  vec4 mvPosition = modelViewMatrix * vec4(aCentre, 1.0);
  mvPosition.xy += aCorner * aSize;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

/**
 * NORMAL blending, not additive, and that is a decision rather than a default.
 * `tagSources` in core/post.ts bloom-tags anything additive automatically, and
 * mist has to read against two backgrounds at once: additive white is invisible
 * against a bright sky and blows out against the dark keel. A foam-coloured
 * normal-blended sprite reads on both, and is never tagged, so it needs no
 * `bsNoBloom` opt-out.
 */
const SPRAY_FRAG = /* glsl */ `
uniform vec3 uFoam;
uniform float uOpacity;
varying vec2 vCorner;
varying float vFade;
#include <fog_pars_fragment>
void main() {
  float d = length(vCorner);
  if (d > 1.0) discard;
  // SOFT, and softer than the first pass. A tight core on a droplet this size
  // reads as a bead of glass rather than as water in the air — captured
  // (shots/_wf-c.png) the spray was a scatter of white bubbles beside the
  // plume. Spray is seen as a haze with a suggestion of drops in it.
  float a = smoothstep(1.0, 0.05, d) * (0.72 + 0.28 * smoothstep(0.75, 0.0, d)) * 0.72;
  gl_FragColor = vec4(uFoam, a * vFade * uOpacity);
  #include <fog_fragment>
}
`;

/** Spray zones. A droplet's zone decides where it starts and how it flies. */
const Z_LIP = 0;
const Z_SHEET = 1;
const Z_TAIL = 2;

// ---------------------------------------------------------------------------

/**
 * One fall. Build it, add `group` to the owner, tick `update` once a slice, and
 * `dispose` it with the owner.
 */
export class Waterfall {
  readonly group = new THREE.Group();

  private readonly mask: THREE.CanvasTexture;
  private readonly sheetGeo: THREE.BufferGeometry;
  private readonly sheetMat: THREE.ShaderMaterial;
  private readonly sheet: THREE.Mesh;

  private readonly sprayGeo: THREE.InstancedBufferGeometry | null = null;
  private readonly sprayMat: THREE.ShaderMaterial | null = null;
  private readonly sprayMesh: THREE.Mesh | null = null;

  // ---- packed droplet state, all preallocated ----
  private readonly n: number;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly life: Float32Array;
  private readonly span: Float32Array;
  private readonly zone: Uint8Array;
  /** The buffers the shader reads. Rewritten in place every slice. */
  private readonly centre: Float32Array;
  private readonly size: Float32Array;
  private readonly fade: Float32Array;
  private centreAttr: THREE.InstancedBufferAttribute | null = null;
  private fadeAttr: THREE.InstancedBufferAttribute | null = null;
  /**
   * `size` is re-rolled on every recycle, so it is a DYNAMIC attribute like the
   * other two. Left static at first, which meant a droplet kept whatever size it
   * was given at construction for the life of the process — the roll in
   * `seedDrop` was computed, stored, and never reached the GPU.
   */
  private sizeAttr: THREE.InstancedBufferAttribute | null = null;

  /** The length actually used — `spec.length`, clamped by a basin if there is one. */
  private readonly fallLength: number;
  private readonly lateralPush: number;
  private readonly outwardPush: number;
  /** The width profile, kept because the spray has to scatter over the same plume. */
  private readonly lipWidth: number;
  private readonly spreadWidth: number;
  private readonly tailWidth: number;
  private readonly spreadAt: number;
  private readonly basinY: number | null;
  private readonly basinR: number;
  private readonly sway: boolean;
  private readonly rand: () => number;

  private time = 0;
  private frozen = false;
  /** Smoothed carrier lean, in the fall's own frame. */
  private leanX = 0;
  private leanZ = 0;
  private visible = true;

  constructor(spec: WaterfallSpec) {
    const lipWidth = spec.lipWidth ?? 7.2;
    const spreadWidth = spec.spreadWidth ?? 10.8;
    const tailWidth = spec.tailWidth ?? 6.0;
    const spreadAt = spec.spreadAt ?? 0.10;
    const sheets = spec.sheets ?? 3;
    const segments = spec.segments ?? 26;
    const cross = spec.cross ?? 0.55;
    const basin = spec.basin ?? null;

    // A BASIN CLAMPS THE FALL. A plume that dissolves in mid-air above a pool
    // it was supposed to land in is worse than one that ends square, so the
    // drop wins over the authored length and the dissolve moves most of the way
    // down — the fall has to arrive.
    this.basinY = basin ? basin.y : null;
    this.basinR = basin ? basin.radius : 0;
    this.fallLength = basin
      ? Math.max(0.5, Math.min(spec.length, spec.y - basin.y))
      : spec.length;
    const fadeStart = spec.fadeStart ?? (basin ? 0.88 : 0.62);

    this.lateralPush = spec.lateralPush;
    this.outwardPush = spec.outwardPush ?? 1.6;
    this.sway = spec.swayFromCarrier ?? false;
    this.lipWidth = lipWidth;
    this.spreadWidth = spreadWidth;
    this.tailWidth = tailWidth;
    this.spreadAt = spreadAt;
    this.rand = mulberry32(spec.seed ?? 0x7a11);

    this.group.position.set(spec.x, spec.y, spec.z);
    // three's Euler-Y and this project's bearing agree: rotation.y = bearing
    // maps local +Z to (sin, cos), which is exactly `at(angle, d)`. So inside
    // this file local +Z is downstream and local +X is across.
    this.group.rotation.y = spec.bearing;
    this.group.matrixAutoUpdate = false;
    this.group.updateMatrix();

    this.mask = makeFallMask();

    this.sheetGeo = this.buildSheet(sheets, segments, cross);

    this.sheetMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib['fog'],
        {
          uMask: { value: null },
          uTime: { value: 0 },
          uFlow: { value: spec.flow ?? 1.0 },
          uFadeStart: { value: fadeStart },
          uTileW: { value: TILE_U },
          uLean: { value: new THREE.Vector2(0, 0) },
          uOpacity: { value: 1 },
          uFoam: { value: linear(spec.foam ?? 0xbce6f0) },
          uLit: { value: linear(spec.bodyLit ?? 0x1e8aa2) },
          uBody: { value: linear(spec.bodyDark ?? 0x1e7e96) },
          uShadow: { value: linear(spec.bodyShadow ?? 0x127296) },
        },
      ]),
      vertexShader: SHEET_VERT,
      fragmentShader: SHEET_FRAG,
      // TRANSPARENT, which is the OPPOSITE of what world/water.ts chose, and
      // for a stated reason. Water went `transparent: false` so it would stay
      // in the GTAO G-buffer, because the lake BED underneath it was creasing
      // and printing contour lines through the surface. A waterfall hangs in
      // open air: there is nothing under it whose AO could print through, and a
      // vertical sheet the height of the keel sitting IN the AO buffer would
      // occlude the cliff behind it and paint a dark halo down it.
      // `_overrideVisibility` in core/post.ts hides transparent materials from
      // that pass, which is what we want.
      //
      // Being genuinely transparent also means the trap water.ts documents at
      // length — `NormalBlending` with `transparent: false` makes three call
      // `setBlending(NoBlending)` and throw the alpha away — cannot fire here,
      // so no explicit CustomBlending block is needed. The next reader will
      // have just come from that file; this is why the two differ.
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      // Fog is MANUAL in a raw ShaderMaterial, and skipping it would make the
      // fall the one surface in the frame that does not haze — the island
      // cruises 190-215 up and is framed 280-375 units out, well inside the
      // aerial-perspective ramp core/engine.ts installs globally.
      fog: true,
    });
    this.sheetMat.uniforms.uMask.value = this.mask;

    this.sheet = new THREE.Mesh(this.sheetGeo, this.sheetMat);
    // Named for the debug surface, and deliberately NOT `chunk:water`:
    // tools/test-gfx.mjs counts meshes by that name and would start counting
    // this one as a streamed water chunk.
    this.sheet.name = 'vfx:waterfall';
    // Between world/water.ts (2) and the gateway (5).
    this.sheet.renderOrder = 3;
    this.sheet.castShadow = false;
    this.sheet.receiveShadow = false;
    // The vertex shader displaces by the lean, so the bounds computed off the
    // static positions are a lie by up to LEAN_MAX in each horizontal axis.
    this.sheetGeo.computeBoundingSphere();
    if (this.sheetGeo.boundingSphere) {
      this.sheetGeo.boundingSphere.radius += LEAN_MAX + Math.abs(this.lateralPush) * 0.1;
    }
    this.group.add(this.sheet);

    // ---- spray ----
    this.n = Math.max(0, Math.floor(spec.spray ?? 128));
    this.px = new Float32Array(this.n);
    this.py = new Float32Array(this.n);
    this.pz = new Float32Array(this.n);
    this.vx = new Float32Array(this.n);
    this.vy = new Float32Array(this.n);
    this.vz = new Float32Array(this.n);
    this.life = new Float32Array(this.n);
    this.span = new Float32Array(this.n);
    this.zone = new Uint8Array(this.n);
    this.centre = new Float32Array(this.n * 3);
    this.size = new Float32Array(this.n);
    this.fade = new Float32Array(this.n);

    if (this.n > 0) {
      const geo = new THREE.InstancedBufferGeometry();
      geo.instanceCount = this.n;
      // One unit quad, shared by every droplet and expanded in view space.
      geo.setAttribute('aCorner', new THREE.BufferAttribute(
        new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2,
      ));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      this.centreAttr = new THREE.InstancedBufferAttribute(this.centre, 3);
      this.centreAttr.setUsage(THREE.DynamicDrawUsage);
      this.fadeAttr = new THREE.InstancedBufferAttribute(this.fade, 1);
      this.fadeAttr.setUsage(THREE.DynamicDrawUsage);
      this.sizeAttr = new THREE.InstancedBufferAttribute(this.size, 1);
      this.sizeAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aCentre', this.centreAttr);
      geo.setAttribute('aFade', this.fadeAttr);
      geo.setAttribute('aSize', this.sizeAttr);

      const mat = new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib['fog'],
          {
            uFoam: { value: linear(spec.foam ?? 0xbce6f0) },
            uOpacity: { value: 1 },
          },
        ]),
        vertexShader: SPRAY_VERT,
        fragmentShader: SPRAY_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
        fog: true,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'vfx:waterfall-spray';
      mesh.renderOrder = 4;
      mesh.castShadow = false;
      // Every centre lives in an attribute rewritten each slice, so any bounding
      // volume computed once is a lie.
      mesh.frustumCulled = false;
      this.sprayGeo = geo;
      this.sprayMat = mat;
      this.sprayMesh = mesh;
      this.group.add(mesh);

      for (let i = 0; i < this.n; i++) {
        this.zone[i] = i < this.n * 0.22 ? Z_LIP : i < this.n * 0.69 ? Z_SHEET : Z_TAIL;
        this.seedDrop(i, this.rand());
        // Publish the seeded pool NOW rather than leaving the instance buffers
        // zeroed until the first update. Without this the first frame drawn —
        // which for the boot sweep is the only frame drawn — has all 128
        // droplets stacked on the anchor, and the warm-up is supposed to
        // rasterise what the player will actually see.
        this.centre[i * 3] = this.px[i];
        this.centre[i * 3 + 1] = this.py[i];
        this.centre[i * 3 + 2] = this.pz[i];
        this.fade[i] = 1;
      }
    }
  }

  // ---- build --------------------------------------------------------------

  /**
   * Full width of the plume at `v`. Broad at the lip, then gathering.
   *
   * The single source of the profile: the sheet's vertices and the spray's
   * scatter both come through here, so a droplet is never outside the water it
   * was thrown off.
   */
  private widthAt(v: number): number {
    const lip = this.lipWidth;
    const tail = this.tailWidth;
    const open = this.spreadAt > 0 ? smoothstep(0, this.spreadAt, v) : 1;
    const w = lip + (this.spreadWidth - lip) * open;
    // ...and then it draws in. `pow(1 - v, 0.35)` holds the width most of the
    // way down and gathers late, which is what a fall does; a linear taper is a
    // triangle and reads as a splash of paint.
    return tail + (w - tail) * Math.pow(1 - v, 0.35);
  }

  /**
   * `sheets` quad strips, splayed about local Y, plus a flat cap over the lip.
   *
   * The strips are the plume. The CAP is four quads lying on the owner's
   * surface just upstream of the anchor, in the SAME geometry and the same
   * material: it replaces the pale voxels the old fall put at the lip, and more
   * usefully it hides the seam where the owner's opaque water channel runs into
   * a translucent sheet.
   */
  private buildSheet(
    sheets: number, segments: number, cross: number,
  ): THREE.BufferGeometry {
    const rows = segments + 1;
    const pos: number[] = [];
    const nrm: number[] = [];
    const uvs: number[] = [];
    const life: number[] = [];
    const across: number[] = [];
    const idx: number[] = [];
    const tiles = Math.max(1, this.fallLength / TILE_V);

    for (let b = 0; b < sheets; b++) {
      // Splayed, not evenly fanned through a half-turn: a fall has a FRONT and
      // a beam does not, so the sheets stay within `cross` of the lip's own
      // plane instead of spreading to a tube.
      const a = sheets > 1
        ? (b / (sheets - 1) - 0.5) * 2 * cross
        : 0;
      const ax = Math.cos(a);
      const az = Math.sin(a);
      const base = pos.length / 3;
      for (let i = 0; i < rows; i++) {
        const v = i / segments;
        const halfW = this.widthAt(v) * 0.5;
        const drift = this.lateralPush * Math.pow(v, PUSH_EXP)
          + wander(v);
        const along = this.outwardPush * Math.pow(v, PUSH_EXP);
        const cy = -this.fallLength * v;
        const uvY = Math.pow(v, UV_EASE) * tiles;
        for (const s of [-1, 1]) {
          pos.push(drift + ax * halfW * s, cy, along + az * halfW * s);
          // EVERY SHEET TAKES THE FALL'S OWN NORMAL, not its own geometric one.
          //
          // The splay is a trick for giving a flat thing a silhouette from every
          // bearing; it is not three surfaces at three angles, it is one body of
          // water. Shading each sheet by its own normal puts the outer two at
          // sun dots of 0.03 and 0.71 against the middle's 0.44 — three flat
          // panels in three distinct values, which from above the deck reads as
          // a hard-edged grey-and-white slab lying at the lip rather than as
          // churn. Reported from play. Downstream (+Z) is the face the water
          // presents, and the modelMatrix turns it with the island.
          nrm.push(0, 0, 1);
          uvs.push(s < 0 ? 0 : 1, uvY);
          life.push(v);
          across.push(halfW * s);
        }
        if (i < segments) {
          const q = base + i * 2;
          idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2);
        }
      }
    }

    // THERE IS NO LIP CAP, and there was one.
    //
    // It was four flat quads lying just above the owner's surface at the head of
    // the fall, there to hide the seam where an opaque water channel meets a
    // translucent sheet. Two things removed the seam it was hiding: the owner
    // now anchors the fall ON its outline rather than a cell inboard, and the
    // channel feeding it flares to this same `lipWidth` (see `onStream` in
    // world/sky-island.ts). With nothing left to cover, what the cap actually
    // did was read as a hard-edged white SLAB sitting on the grass — a
    // horizontal quad at `aLife` 0 is fully whited by the head-foam term, and
    // from any camera above the deck it is a paving stone rather than water.
    //
    // If a future site needs one, the seam it covers is the owner's problem to
    // state, not this module's to guess at.

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    g.setAttribute('aLife', new THREE.BufferAttribute(new Float32Array(life), 1));
    g.setAttribute('aAcross', new THREE.BufferAttribute(new Float32Array(across), 1));
    g.setIndex(idx);
    return g;
  }

  // ---- spray simulation ---------------------------------------------------

  /**
   * (Re)launch droplet `i`. `start` is where in its own life it begins, 0..1 —
   * the pool is seeded across the whole plume at construction so the fall is
   * never seen filling up from the lip.
   *
   * THE LATERAL PUSH REACHES THE SPRAY, and it has to: a plume whose sheet
   * leans and whose droplets fall straight is two effects disagreeing about the
   * wind. The horizontal seed is the same total offset the vertices carry,
   * divided by the time of flight, so change `lateralPush` and both move.
   */
  private seedDrop(i: number, start: number): void {
    const r = this.rand;
    const z = this.zone[i];
    const tof = Math.sqrt((2 * this.fallLength) / GRAV);
    // Where along the fall this zone lives, and how long a droplet of it lasts.
    const from = z === Z_LIP ? 0 : z === Z_SHEET ? 0.05 : 0.6;
    const to = z === Z_LIP ? 0.06 : z === Z_SHEET ? 0.75 : 1.0;
    const v0 = from + (to - from) * start;
    const halfW = this.widthAt(v0) * 0.5;

    this.py[i] = -this.fallLength * v0;
    this.px[i] = this.lateralPush * Math.pow(v0, PUSH_EXP)
      + wander(v0)
      + (r() * 2 - 1) * halfW * 1.15;
    this.pz[i] = this.outwardPush * Math.pow(v0, PUSH_EXP) + (r() * 2 - 1) * 1.1;

    // Lip mist drifts, sheet spray runs with the water, tail spray is what is
    // left of it — so the launch speed climbs with the zone.
    const drive = z === Z_LIP ? 0.25 : z === Z_SHEET ? 1.0 : 0.75;
    this.vx[i] = (this.lateralPush / tof) * drive + (r() * 2 - 1) * 0.8;
    this.vz[i] = (this.outwardPush / tof) * drive + (r() * 2 - 1) * 0.5;
    this.vy[i] = z === Z_LIP
      ? 0.4 + r() * 0.8          // thrown up off the lip before it falls
      : -(2 + r() * 5) - GRAV * tof * v0 * 0.35;

    this.span[i] = z === Z_LIP ? 0.7 + r() * 0.8 : 0.9 + r() * 1.5;
    this.life[i] = this.span[i] * (1 - start * 0.6);
    // Lip mist is the biggest and softest — it is a cloud, not a drop. Sheet
    // spray is the smallest: it is water that has just left the plume and has
    // not had time to break up. The tail is in between, and it is what carries
    // the dissolve.
    this.size[i] = z === Z_LIP
      ? 0.42 + r() * 0.44
      : z === Z_SHEET ? 0.14 + r() * 0.18 : 0.24 + r() * 0.32;
  }

  /**
   * One slice of the droplet pool.
   *
   * INTEGRATED IN THE FALL'S OWN FRAME, which is exact here rather than an
   * approximation: `CarrierBody` only ever writes `rotation.y`, so local -Y is
   * world down and gravity needs no transform. A carrier that PITCHED would
   * break this, and would need the pool rotated into world space first.
   */
  private stepSpray(dt: number): void {
    if (this.n === 0) return;
    const c = this.centre;
    const f = this.fade;
    for (let i = 0; i < this.n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) this.seedDrop(i, 0);
      this.vy[i] -= GRAV * 0.42 * dt;
      // Air drag, in the house `exp(-k*dt)` form so the trajectory is the same
      // whether one slice is drained this frame or four.
      const d = Math.exp(-0.9 * dt);
      this.vx[i] *= d;
      this.vz[i] *= d;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;

      // WHAT HAPPENS AT THE BOTTOM, and the two cases are genuinely different
      // rather than one with a flag on it.
      //
      // In OPEN AIR the droplet simply stops existing at the dissolve: spray
      // hanging below a plume that has already faded out is the one thing here
      // that would read as a bug.
      //
      // Over a BASIN it bounces — a fall landing in water throws mist back up,
      // and a plume that arrives at a pool and vanishes reads as a plume ending
      // in mid-air a foot above it. The droplet is re-launched slowly upward
      // somewhere on the basin disc, which is the only thing `basin.radius`
      // means and the reason it is a parameter rather than a constant.
      if (this.basinY !== null) {
        const floor = this.basinY - this.group.position.y;
        if (this.py[i] < floor) {
          const a = r2(this.rand) * Math.PI;
          const rad = Math.sqrt(this.rand()) * this.basinR;
          this.px[i] = Math.cos(a) * rad;
          this.pz[i] = Math.sin(a) * rad;
          this.py[i] = floor;
          this.vx[i] = Math.cos(a) * (0.5 + this.rand() * 1.1);
          this.vz[i] = Math.sin(a) * (0.5 + this.rand() * 1.1);
          this.vy[i] = 1.4 + this.rand() * 2.2;
          this.span[i] = 0.8 + this.rand() * 0.9;
          this.life[i] = this.span[i];
          this.size[i] = 0.34 + this.rand() * 0.40;
        }
      } else if (this.py[i] < -this.fallLength) {
        this.seedDrop(i, 0);
      }

      const k = i * 3;
      c[k] = this.px[i];
      c[k + 1] = this.py[i];
      c[k + 2] = this.pz[i];
      // Fade in over the first fifth of a life and out over the last third, so
      // no droplet ever pops into or out of existence.
      const t = 1 - this.life[i] / this.span[i];
      f[i] = Math.min(1, t / 0.2) * Math.min(1, (1 - t) / 0.33);
    }
    if (this.centreAttr) this.centreAttr.needsUpdate = true;
    if (this.fadeAttr) this.fadeAttr.needsUpdate = true;
    // `size` changes on every recycle, so it uploads with the other two. 128
    // floats a slice; the alternative is a droplet that keeps its first roll for
    // the life of the process.
    if (this.sizeAttr) this.sizeAttr.needsUpdate = true;
  }

  // ---- frame --------------------------------------------------------------

  /**
   * One simulation slice.
   *
   * `carrierDX/DZ` are the owner's step over this slice IN THE FALL'S OWN
   * FRAME — `CarrierBody.advance` already publishes a world-space `dx/dz`, and
   * the owner rotates it in. Pass nothing for a fall that does not move.
   *
   * Under `photo=1` the clock pins and the pool runs a fixed pre-roll exactly
   * once. Everything after that is a no-op, so two capture runs of the same URL
   * render the same frame — which is what `shots/` is for.
   */
  update(dt: number, carrierDX = 0, carrierDZ = 0): void {
    if (flags.photo) {
      if (this.frozen) return;
      this.frozen = true;
      this.time = PHOTO_CLOCK;
      this.sheetMat.uniforms.uTime.value = PHOTO_CLOCK;
      // A frozen pool at t=0 is a deterministic EMPTY field, which is the wrong
      // kind of reproducible. Integrate a fixed number of fixed steps instead —
      // fixed so the pre-roll is identical on a software rasteriser and on a
      // 165 Hz host.
      const STEP = 1 / 60;
      for (let t = 0; t < PHOTO_PREROLL; t += STEP) this.stepSpray(STEP);
      // The lean is zero by construction: `SkyIsland.steer` returns early under
      // photo, so the carrier publishes no step at all.
      this.sheetMat.uniforms.uLean.value.set(0, 0);
      return;
    }

    this.time += dt;
    this.sheetMat.uniforms.uTime.value = this.time;

    // THE CARRIER LEAN, and only for a fall whose owner asked for it. The
    // owner's step over a slice divided by the slice is its velocity; the plume
    // trails against it. Smoothed so a turn eases the tail across rather than
    // snapping it, and clamped because a carrier that is teleported must not
    // fling the fall to the horizon.
    //
    // Off by default rather than inferred from "did the caller pass a step",
    // because those are different questions: a weir on a bank has no step to
    // pass and would behave the same either way, but a fall on a barge might
    // want to ride its frame rigidly rather than trail behind it, and that has
    // to be sayable.
    if (this.sway) {
      const vx = dt > 0 ? -carrierDX / dt : 0;
      const vz = dt > 0 ? -carrierDZ / dt : 0;
      const k = 1 - Math.exp(-0.9 * dt);
      this.leanX += (clamp(vx * 3.0, -LEAN_MAX, LEAN_MAX) - this.leanX) * k;
      this.leanZ += (clamp(vz * 3.0, -LEAN_MAX, LEAN_MAX) - this.leanZ) * k;
      this.sheetMat.uniforms.uLean.value.set(this.leanX, this.leanZ);
    }

    this.stepSpray(dt);
  }

  // ---- lifecycle ----------------------------------------------------------

  /**
   * Link both programs at boot.
   *
   * A program not linked during the warm-up sweep links on the frame the player
   * first sees the effect, which is a measured half-second stall (see the note
   * in combat/vfx.ts). The caller renders; all this has to do is guarantee the
   * meshes actually RASTERISE, because a culled or fully transparent draw links
   * nothing — hence a small non-zero opacity rather than zero.
   */
  warmUp(render: () => void): void {
    const wasVisible = this.visible;
    this.setVisible(true);
    this.sheetMat.uniforms.uOpacity.value = 0.002;
    if (this.sprayMat) this.sprayMat.uniforms.uOpacity.value = 0.002;
    render();
    this.sheetMat.uniforms.uOpacity.value = 1;
    if (this.sprayMat) this.sprayMat.uniforms.uOpacity.value = 1;
    this.setVisible(wasVisible);
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.sheet.visible = on;
    if (this.sprayMesh) this.sprayMesh.visible = on;
  }

  /**
   * Counts, not prose — the probe surface, like `TouchParticles.stats()`.
   * `length` and `push` are echoed back because a probe asserting that a
   * parameter reached the geometry should be able to read what the module
   * thinks it was handed.
   */
  stats(): Record<string, number> {
    let alive = 0;
    for (let i = 0; i < this.n; i++) if (this.fade[i] > 0.01) alive++;
    return {
      length: +this.fallLength.toFixed(3),
      push: +this.lateralPush.toFixed(3),
      // WHERE IT IS, in the owner's frame. Not decoration: a probe that wants
      // to measure pixels on the plume has to be able to put a camera in front
      // of it, and only the fall knows where its owner put it.
      anchorX: +this.group.position.x.toFixed(3),
      anchorY: +this.group.position.y.toFixed(3),
      anchorZ: +this.group.position.z.toFixed(3),
      bearing: +this.group.rotation.y.toFixed(4),
      spray: this.n,
      sprayAlive: alive,
      verts: this.sheetGeo.getAttribute('position').count,
      tris: (this.sheetGeo.getIndex()?.count ?? 0) / 3,
      leanX: +this.leanX.toFixed(3),
      leanZ: +this.leanZ.toFixed(3),
      time: +this.time.toFixed(3),
      frozen: this.frozen ? 1 : 0,
      visible: this.visible ? 1 : 0,
    };
  }

  dispose(): void {
    this.group.remove(this.sheet);
    this.sheetGeo.dispose();
    this.sheetMat.dispose();
    if (this.sprayMesh) {
      this.group.remove(this.sprayMesh);
      this.sprayGeo?.dispose();
      this.sprayMat?.dispose();
    }
    this.mask.dispose();
    this.group.parent?.remove(this.group);
  }
}

// ---------------------------------------------------------------------------

/** sRGB hex -> a linear vec3 the raw shader can write straight out. */
function linear(hex: number): THREE.Vector3 {
  _col.setHex(hex, THREE.SRGBColorSpace);
  return new THREE.Vector3(_col.r, _col.g, _col.b);
}

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** One draw from the seeded stream, mapped to -1..1. */
function r2(rand: () => number): number {
  return rand() * 2 - 1;
}
