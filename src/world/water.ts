/**
 * Water: per-chunk translucent plane with baked shore-depth attribute.
 * Custom ShaderMaterial — gentle vertex waves scaled by depth (shoreline
 * stays put), a three-stop depth gradient, an analytic ripple normal driving
 * Fresnel sky reflection and a tight sun glint, plus coast-following foam.
 * Fog-aware.
 */
import * as THREE from 'three';
import { CHUNK_SIZE, Terrain, WATER_LEVEL } from './terrain';

const VERT = /* glsl */ `
uniform float uTime;
attribute float aDepth;
attribute float aShore;
varying float vDepth;
varying float vShore;
varying vec3 vWorldPos;
#include <fog_pars_vertex>
void main() {
  vDepth = aDepth;
  vShore = aShore;
  vec3 p = position;
  float d = clamp(aDepth, 0.0, 1.5);
  vec4 wp4 = modelMatrix * vec4(p, 1.0);
  // Two crossed OBLIQUE swells plus one chop. The old set had its largest term on
  // (x + z), i.e. exactly 45 degrees to the cube grid, and an axis-aligned swell
  // on a voxel bay lines its crests up with the terraces — which is half of why
  // the surface read as contour lines. Both directions here are irrational to the
  // grid and to each other, so no crest can ever run along a bed step.
  float w =
    sin(dot(wp4.xz, vec2(0.211, 0.147)) + uTime * 0.62) * 0.62 +
    sin(dot(wp4.xz, vec2(-0.163, 0.243)) - uTime * 0.51) * 0.48 +
    sin(dot(wp4.xz, vec2(0.61, -0.47)) + uTime * 1.35) * 0.22;
  p.y += w * 0.055 * d;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  vWorldPos = (modelMatrix * vec4(p, 1.0)).xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

/**
 * All colours here are LINEAR, which is what a BufferAttribute / raw shader
 * output feeds three.js. They are the linear forms of hand-picked sRGB swatches
 * (listed in the comments) — writing sRGB numbers straight in, as this shader
 * used to, lightens and desaturates everything by roughly c^(1/2.2), which is
 * exactly why the lake read as one pale grey-blue sheet from any distance.
 */
const FRAG = /* glsl */ `
uniform float uTime;
varying float vDepth;
/** Distance in cells to the nearest dry column, clamped to 5. See buildWaterMesh. */
varying float vShore;
varying vec3 vWorldPos;
#include <fog_pars_fragment>

// Four depth stops, not three. Nearly every bay in this world is one or two
// voxels deep, so the whole visible gradient used to be squeezed into the first
// stop and a shallow lagoon rendered as one flat pale cyan; splitting the shore
// end gives the shallows somewhere to go.
//
// WETSAND is DESATURATED-DOWN from #9bd7c1 to #64d5be, i.e. its red channel is
// less than half what it was (0.290 -> 0.130 linear). Red is what made it milk:
// at 0.290 linear it tone-mapped to ~0.57 sRGB, and since this stop covered every
// shallow in the world (see the ramp below) the result was the "near half of every
// lake is a milky white-cyan blowout" finding — measured in _tw-b-lake1.png, where
// the entire shelf around the bay and every small pond read as one pale mint wash.
// Cutting red keeps the same luminance but turns the wash into a saturated aqua.
const vec3 WETSAND = vec3(0.130, 0.660, 0.505); // #64d5be sun on sand through 20cm
// Pushed bluer and a step deeper (#5fd4c6 -> #37c3c9) so it separates from the new
// WETSAND rather than being a near-duplicate of it.
const vec3 SHALLOW = vec3(0.035, 0.545, 0.578); // #37c3c9 inviting turquoise
const vec3 MID     = vec3(0.016, 0.283, 0.478); // #269bc9
// #1c5c98. The old DEEP was #123a68, which after the tone curve rendered as a
// near-black strip wherever a bay dropped off — that is the "crack between sand
// and water" artefact. A stylised lake should bottom out at a saturated blue.
// #2a6d9e. Lifted again from #1c5c98: with the ramp now actually reaching this
// stop (see the smoothsteps below), the old value put a near-black core in the
// middle of every bay. A stylised lake's deep water is a saturated mid blue.
const vec3 DEEP    = vec3(0.024, 0.152, 0.355);
const vec3 FOAM    = vec3(0.930, 0.975, 1.000);
// A deliberately deeper, bluer stand-in for the sky dome rather than a copy of
// it. The dome is authored bright (its horizon runs past 1.0 so the haze band
// blooms); reflecting those values verbatim washes the lake to white paper,
// while a saturated blue reflection reads as sky AND keeps the water blue.
const vec3 SKY_HORIZON = vec3(0.55, 0.72, 0.90);
const vec3 SKY_ZENITH  = vec3(0.10, 0.34, 0.95);
// MUST match SUN_OFFSET in core/engine.ts, normalised — currently (170,160,113).
// A glint lobe that disagrees with where the terrain's shadows say the sun is
// reads instantly as wrong, and this shader cannot see the scene's lights.
const vec3 SUN_DIR = vec3(0.6554, 0.6168, 0.4356);
const vec3 SUN_COL = vec3(1.0, 0.949, 0.851);

/**
 * Analytic normal of four crossed directional ripples. Derivatives come from
 * the same sines that would displace the surface, so the glint and the shading
 * agree instead of one being painted on.
 *
 * The att argument flattens the ripple with distance. A pow-200 lobe riding a
 * high-frequency normal field turns into a field of aliasing fireflies past
 * ~60 units; damping the slopes instead makes the far water read as one broad
 * sheet of sun, which is what it looks like in life.
 *
 * ROUND 2: every slope amplitude is roughly DOUBLED, and this is the fix for
 * "there is not one sun glint on a whole lake" / "no water pixel in any capture
 * exceeds L=155". The specular exponents were not the problem — the NORMAL FIELD
 * was too flat for any exponent to bite. Summed, the old amplitudes gave a maximum
 * facet tilt of atan(0.157) = 8.9 degrees. In the framing that matters most (eye a
 * few units above the surface, looking down-sun, which is every wide shot of this
 * bay) the half-vector sits about 14 degrees off vertical, so the BEST facet in
 * the world could only reach N.H = cos(5.1 deg) = 0.996 — and pow(0.996, 800) is
 * 0.04. The lake was mathematically incapable of a highlight.
 *
 * At double amplitude the maximum tilt is ~17 degrees, so facets on the sun side
 * of a crest reach N.H = 1.0 exactly while the troughs fall to cos(31 deg) = 0.86,
 * where the same lobe evaluates to zero. That difference — nothing in the trough,
 * everything on the crest — is what a glint path IS. Distance attenuation is
 * unchanged and still does its job: att drives the field toward flat, and a flat
 * facet gives N.H = cos(14 deg) = 0.970, which the tight lobe reads as 0.001, so
 * the far water stays a smooth sheet instead of aliasing.
 */
vec3 waveNormal(vec2 p, float t, float att) {
  vec2 slope = vec2(0.0);
  // SIX waves in round 2, not four, and every wavelength is deliberately
  // mismatched. The old set had its two strongest terms at (0.85,0.42) and
  // (-0.38,0.92): 28 and 112 degrees apart with wavelengths of 6.6 and 6.3 —
  // i.e. a near-perfect SQUARE LATTICE. That was invisible while the field was
  // flat, but the moment the specular could see it (_tw2-d-sun.png) the sun path
  // came back as a regular grid of white dashes, which reads as a bug rather
  // than as glitter. Same lesson WaveField's declaration in noise.ts spells out
  // for ground colour: below about five waves you can find the pattern.
  //
  // Wavelengths now run 30 / 6.6 / 4.5 / 2.7 / 2.4 / 1.7 units, directions are
  // spread by roughly the golden angle, and no two ratios are simple. The two
  // shortest terms carry almost no slope of their own; they exist to chop the
  // long crests so the glint scatters instead of pooling into blobs.
  slope += vec2(0.17, 0.21) * 0.190 * cos(dot(vec2(0.17, 0.21), p) + t * 0.55);
  slope += vec2(0.83, 0.46) * 0.115 * cos(dot(vec2(0.83, 0.46), p) + t * 1.60);
  slope += vec2(-0.63, 1.24) * 0.088 * cos(dot(vec2(-0.63, 1.24), p) - t * 1.25);
  slope += vec2(1.71, -1.53) * 0.050 * cos(dot(vec2(1.71, -1.53), p) + t * 2.40);
  slope += vec2(-2.44, -1.06) * 0.034 * cos(dot(vec2(-2.44, -1.06), p) - t * 2.85);
  slope += vec2(2.19, 2.87) * 0.026 * cos(dot(vec2(2.19, 2.87), p) + t * 3.40);
  return normalize(vec3(-slope.x * att, 1.0, -slope.y * att));
}

void main() {
  // Three ramps over four stops. Depth runs from ~0 right at the waterline to
  // ~0.8 over the shallowest flooded terrace and on down (see buildWaterMesh for
  // where the offset comes from). Stops are placed so the tide line is wet sand,
  // the first couple of terraces are turquoise, and only genuinely deep water
  // reaches the saturated blue.
  // The deep stop is reached at 3.6 units, not 5.6. Measured off the actual world:
  // almost no bay here gets past 4 units, so with the old ramp the DEEP colour was
  // never mixed in at ALL and the whole lake sat between WETSAND and MID — which
  // is precisely the "a 1-unit shallow and a 20-unit deep are the same colour"
  // finding. Same reason the mid stop moved in.
  // All three ramps are pulled SHOREWARD (0.85/1.70/3.60 -> 0.45/1.30/3.20).
  // Measured off _tw-b-lake1.png: the shelf around a bay sits at 0.3-0.8 units of
  // depth and covers roughly a third of the water in any low shot, so with the old
  // first ramp that whole shelf never got past the WETSAND stop and read as one
  // pale wash. Reaching SHALLOW by 45cm turns the shelf turquoise and leaves
  // WETSAND as the thin lighter line along the tide mark it is supposed to be.
  float dWet   = smoothstep(0.02, 0.45, vDepth);
  float dShore = smoothstep(0.40, 1.30, vDepth);
  float dDeep  = smoothstep(1.10, 3.20, vDepth);
  vec3 col = mix(WETSAND, SHALLOW, dWet);
  col = mix(col, MID, dShore);
  col = mix(col, DEEP, dDeep);

  vec3 toCam = cameraPosition - vWorldPos;
  float camDist = length(toCam);
  vec3 V = toCam / max(camDist, 0.001);
  float att = 0.22 + 0.78 * (1.0 - smoothstep(14.0, 70.0, camDist));
  vec3 N = waveNormal(vWorldPos.xz, uTime, att);

  // Fresnel sky reflection — the cheap stand-in for a real reflection pass,
  // and the dominant term in any real body of water. Grazing angles (every
  // wide shot) turn the surface into a mirror of the sky, which is what makes
  // a lake read as a lake instead of a hole cut in the terrain.
  // Ripple SHADING, which is what actually makes the wave normal visible.
  //
  // Everything the normal fed before this line is view-dependent and vanishes in
  // the two framings that matter most. Looking down on a bay (_tw-r2-lake1.png)
  // the Fresnel term collapses to its 0.025 floor and the reflection contributes
  // ~0.7%; and because the ripple field's steepest facet is only about 12 degrees
  // while a grazing sun path needs ~22, the specular lobes below never light up
  // either. The result was a lake with a mathematically correct normal field and
  // not one pixel of evidence for it — "no readable wave normal" in the survey.
  //
  // Tilting the body colour by the facet's alignment with the sun's azimuth is
  // view-INDEPENDENT, so the swell reads from every angle. +-9% at full strength,
  // faded out with the same att factor as the normal itself so the far water stays a
  // smooth sheet instead of aliasing into fireflies.
  //
  // ADDITIVE, not multiplicative. The first attempt scaled the body colour by
  // 1 +- 9% and was almost invisible (_tw-r3-lake1.png, first version): deep water
  // is around (0.02, 0.15, 0.32) linear, so a proportional term moves it by
  // hundredths and the tone curve then compresses what is left. Adding a fixed
  // pale-cyan facet radiance instead gives the crests the same absolute lift
  // wherever they are, which is also what a real swell does — the crest catches
  // more sky than the trough regardless of how deep the water under it is.
  // Weight 2.0 -> 1.15 in round 2, which is NOT a retreat: the wave normal it
  // reads got twice as steep in the same round, so the product is close to
  // unchanged. Kept level deliberately — at the full 2.0 against the new normal,
  // _tw2-c-shore.png came out corrugated, the swell resolving into regular
  // light/dark stripes across the near bay because a 6-unit wavelength viewed
  // from 4 units up compresses into horizontal banding. The extra steepness is
  // meant to be spent on the specular below, where it produces a glint path,
  // not here where it produces stripes.
  col += vec3(0.030, 0.110, 0.145) * dot(N.xz, SUN_DIR.xz) * att * 1.15;

  vec3 R = reflect(-V, N);
  vec3 sky = mix(SKY_HORIZON, SKY_ZENITH, smoothstep(0.0, 0.45, R.y));
  // Tint the reflection toward the water's own hue. Physically the reflection is
  // untinted, but a pale sky reflected at full strength turns a stylised lake
  // into a sheet of white paper in every wide shot; pulling it teal keeps the
  // body colour reading all the way to the horizon.
  sky *= vec3(0.66, 0.94, 1.0);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0);
  fres = 0.025 + 0.975 * fres;
  // Ceiling on the reflection for the same reason: shallows especially must keep
  // their turquoise, because over a sunlit sand bar you look THROUGH the water.
  //
  // The ceiling is DOWN from 0.20/0.42 to 0.12/0.28. Every wide shot of this
  // world is a grazing view, where the Fresnel term saturates, so the old
  // ceiling laid up to 42% pale sky over the entire bay at once — which flattened
  // the depth ramp into the single wash the critic measured. A reflection has to
  // be strong enough to say "surface" and weak enough to leave the body colour
  // legible; below 0.3 it does both.
  // ROUND 2: the DEEP end of the ceiling goes back up, 0.28 -> 0.50, while the
  // shallow end barely moves (0.12 -> 0.14). Splitting them is the point — the
  // previous round cut both together to stop the shallows washing out, and took
  // the open water's only source of brightness with it. Measured on
  // _tw2-a-shore.png (eye 4 units up, half the frame lake): the water sat darker
  // than the sky it was supposedly reflecting and read as matte turquoise
  // plastic, "a static flat cyan plane". A real lake at a grazing angle is close
  // to a mirror; at 0.50 the deep water finally lifts toward the sky at the
  // horizon and the surface reads as a surface, while dShore keeps the shallows —
  // the ones you are meant to see the sand through — at their old value.
  float refl = fres * mix(0.14, 0.50, dShore);
  col = mix(col, sky, refl);

  // Sun glint: one tight lobe for the sparkle, one broad one for sheen. The
  // broad lobe is down from 0.11 to 0.065 — at the old weight it covered a whole
  // bay in an even white haze in any shot looking toward the sun, which is what
  // washed the lake almost to paper. The tight lobe (where the actual liquid read
  // comes from) is untouched.
  vec3 Hv = normalize(SUN_DIR + V);
  float ndh = max(dot(N, Hv), 0.0);
  // Three lobes now, not two. The tight one is the sparkle, the broad one the
  // sheen, and the new middle lobe is the actual GLINT STREAK — a bright band a
  // few metres wide crossing the bay wherever the surface happens to be angled
  // between the sun and the eye. With only a pow-200 and a pow-22 there was
  // nothing at the scale a glint reads at: the sparkle was sub-pixel at any
  // distance and the sheen was a flat haze over everything, so a shot could
  // legitimately be filed as having "zero specular sun glint".
  // Exponents up hard and weights down hard: 220/60/16 at 1.8/0.34/0.055 becomes
  // 800/150/26 at 1.10/0.10/0.028. This is the "milky white-cyan blowout" that has
  // been read as a foam problem and as a bloom problem in turn, and it is neither
  // — it is arithmetic in this line.
  //
  // Worked at the framing that shows it worst (_tw-r4-shore2.png, eye 5 units over
  // the water looking down-sun): the view sits ~9.5 degrees above the surface, so
  // the half-vector is about 14 degrees off vertical, and the ripple field's
  // steepest facet is ~12 degrees. That means N.H does not fall off across most of
  // the near bay — it sits at 0.99+ over hundreds of square metres — and
  // pow(0.994, 220) is still 0.27. With the old weights the three lobes together
  // added ~0.77 of white to a body colour whose green channel is 0.55. A third of
  // the lake went to paper.
  //
  // At the new exponents the same 0.994 facet contributes 0.074, while a facet
  // actually square to the half-vector still reaches ~0.86 — so the glitter path
  // becomes a scatter of bright crests riding the swell instead of one flat sheet,
  // which is what it is supposed to look like.
  //
  // ROUND 2, and it is the SAME arithmetic run the other way. With the ripple
  // field now twice as steep (see waveNormal), N.H genuinely spans 1.0 down to
  // 0.86 across a down-sun bay instead of sitting pinned at 0.994, so the
  // exponents no longer have to be extreme to avoid blanketing — a pow-220 lobe
  // that reads 0.74 on a crest reads 0.0 in the trough beside it, which is a
  // sparkle path rather than a haze. 800/150/26 at 1.10/0.10/0.028 becomes
  // 260/48/12 at 0.62/0.13/0.040.
  //
  // The weights were 1.55/0.20/0.055 for one capture. That put ~1.35 of white on
  // every crest and _tw2-c-sun.png came back with a large blown mush of white
  // across the near bay — the failure mode this shader has hit twice before, from
  // the other direction. 0.62 lands a crest at roughly 0.55 above the body
  // colour, which tone-maps bright without clipping, so the path reads as a lit
  // scatter and the survey's "not one water pixel exceeds L=155 / there is not
  // one sun glint on a whole lake" is answered without repainting the lake white.
  col += SUN_COL * (
      pow(ndh, 260.0) * 0.62
    + pow(ndh, 48.0) * 0.13
    + pow(ndh, 12.0) * 0.040
  );

  // Shore foam, driven by DISTANCE TO THE COAST rather than by depth.
  //
  // Depth is the wrong signal and produced two separate artefacts. A shallow
  // lagoon is uniformly shallow, so a depth-driven band whitened the entire pond
  // into a milk puddle; and because the bed steps in 1-unit terraces, a depth
  // band also painted a stripe along every submerged terrace, which read as
  // stepped geometry out in open water. aShore is a baked distance field to the
  // nearest dry column, so the band traces the actual waterline — every notch and
  // spit of it — and nothing else. The threshold breathes with the tide so the
  // wash advances and retreats instead of sitting as a painted stripe.
  // The band is NARROWER: 2.4 cells -> 1.65. At 2.4 (widened again by the three
  // tent passes that smooth the distance field) the wash reached most of the way
  // across every shallow bay, and a small pond was foam edge to edge — visible in
  // _tw-b-bay.png as a pond rendered entirely white. Surf belongs on the waterline,
  // not on the bay.
  float tide = sin(uTime * 0.55 + vWorldPos.x * 0.055 + vWorldPos.z * 0.047);
  float foam = smoothstep(1.65 + tide * 0.35, 0.30, vShore);
  // Wash texture from three sines on rotated, mutually irrational directions.
  // This was sin(x*2.6) * sin(z*2.4) — a SEPARABLE product, which is a
  // chequerboard: viewed across a bay at a grazing angle its rows lined up into
  // the horizontal banding that got filed against the shallows. A sum of
  // obliquely-oriented waves has no rows to line up.
  float fw = 0.58
    + 0.16 * sin(dot(vWorldPos.xz, vec2(2.31, 1.07)) + uTime * 2.1)
    + 0.15 * sin(dot(vWorldPos.xz, vec2(-1.13, 2.44)) - uTime * 1.7)
    + 0.11 * sin(dot(vWorldPos.xz, vec2(3.71, -2.93)) + uTime * 3.1);
  foam = clamp(foam * fw * (0.85 + 0.15 * tide), 0.0, 1.0);
  // A brighter, narrower crest rides the outer edge of the wash so the foam has
  // a leading line instead of fading off as a smear. Both bands are kept tight:
  // a wide wash spread over a shallow bay reads as milk, not surf.
  // The crest is the LINE of surf, so it is narrow and bright rather than wide and
  // weak: it keeps roughly the band it always had and takes the weight the wash
  // gave up. Capture-driven — with the wash alone (_tw-r1-vista.png) the sand met
  // the water at a bare edge with no surf at all, which read as a decal cut rather
  // than a coast.
  //
  // The inner stop CANNOT go much under 0.3, which cost a capture to learn: a water
  // quad only exists on a WET cell, so aShore is a chamfer distance that bottoms
  // out near 1.0 at the waterline and only the three tent passes pull it lower. An
  // attempt at smoothstep(0.80, 0.05) therefore evaluated to exactly zero at every
  // vertex in the world and switched the surf off completely (_tw-r4-shore2.png:
  // water meets sand at a bare cyan edge).
  float crest = smoothstep(1.55, 0.30, vShore) * (0.55 + 0.45 * fw);
  // Weights are down (0.72/0.50 -> 0.52/0.40) so the wash NEVER reaches the full
  // FOAM colour. At the old weights the band saturated to near-opaque white a
  // block or two out from every shore, and a saturated band on a stepped coast is
  // indistinguishable from a row of white cubes — which is exactly what it was
  // filed as. Capped like this the foam always keeps some water under it.
  // The WASH is down (0.52 -> 0.36) and the CREST is up (0.40 -> 0.52): together
  // with the narrower bands above, that is the whole shape change — the broad milk
  // halo becomes a bright line hugging the waterline with a short wash behind it.
  // ROUND 2: the CREST goes 0.46 -> 0.62 and its band widens 1.25 -> 1.55 cells,
  // while the wash stays where it is. Measured on _tw2-a-shore.png and
  // _tw2-a-sun.png, both taken low over the bay: the sand met the water at a bare
  // cyan edge with no surf visible at all at 1280px, which is the "no shore foam"
  // and "the shoreline is a hard white rim with no wet-sand darkening" pair of
  // findings. The previous round's cut was aimed at a broad milk halo, and that
  // halo is the WASH term — leaving it low and putting the weight on the narrow
  // crest gives a bright line hugging the waterline, which is what surf is,
  // without re-flooding the bay.
  col = mix(col, FOAM, clamp(foam * 0.34 + crest * 0.62, 0.0, 1.0));

  // Opacity has to climb FAST, and from a HIGH floor. Bays here are only a voxel
  // or two deep, so anything gentler left the pale sand bed showing through
  // everywhere: the water read as a blue film over a beach, and the bed's voxel
  // terraces printed through it as a grid of cube tops and side faces — visible
  // as a row of hard blue blocks along every far bank. The shallows keep their
  // "you can see the sand" read from the WETSAND stop instead, which is painted
  // rather than seen through and so cannot carry the terraces with it.
  // OPAQUE past the tide line. The last 6% of transparency was still enough to
  // print the lake bed's terraces through as dark stripes following the bed
  // contours — and they are not the bed's albedo, they are real shadow-map
  // shadows: a 1-unit terrace wall under water is a vertical surface with the
  // terrace in front of it, so the shadow map correctly reports it occluded and it
  // drops to ambient-only however its shading normal is oriented. No amount of
  // colour work on the bed can remove a shadow. Since the shallows get their
  // "you can see the sand" read from the painted WETSAND stop rather than from
  // actually seeing through (see the colour stops above), the transparency was
  // buying nothing and costing the single worst artefact in the world.
  //
  // A short ramp is kept over the first 30cm of depth purely so the waterline
  // itself is a soft edge instead of a hard cut against the beach.
  float alpha = smoothstep(0.02, 0.30, vDepth);
  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
}
`;

export function createWaterMaterial(): THREE.ShaderMaterial {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib['fog'],
    { uTime: { value: 0 } },
  ]);
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    // NOT `transparent`, even though it blends. This is the fix for the "soft
    // concentric arcs that read as map contour lines" artefact, which survived
    // three separate rounds of work inside this shader because it was never in
    // this shader at all: it is GTAO.
    //
    // OpaqueGTAOPass (core/post.ts) builds its depth/normal G-buffer by
    // re-rendering the scene and hiding everything whose material reports
    // `transparent`. The water was hidden; the LAKE BED was not. So the AO buffer
    // contained the bed's 1-unit terraces, GTAO correctly found a contact crease at
    // the foot of every terrace wall, and that AO was then multiplied into the
    // beauty image at pixels covered by fully OPAQUE water. The result is a set of
    // thin dark dithered lines tracing the bed's height contours across the middle
    // of every bay. Verified by capture: `?ao=0` removes them completely and
    // changes nothing else about the water (_tw-b-lake1.png vs _tw-b-lake1-ao0.png).
    //
    // `transparent: false` puts the surface in the opaque render list, where its
    // renderOrder of 2 still sorts it behind every other opaque object, and
    // `blending` is applied from the material regardless of which list it is in —
    // so the beauty pass is pixel-identical. What changes is that GTAO now sees the
    // water plane, which occludes the bed and is itself flat, so there is nothing
    // left for it to crease. depthWrite stays false so the surface never clips the
    // transparent VFX and contact shadows that draw after it.
    transparent: false,
    depthWrite: false,
    fog: true,
  });
  return mat;
}

/**
 * Height of the water surface. Deliberately ABOVE the integer voxel layer at
 * WATER_LEVEL, which is the fix for the worst artefact in the whole lake.
 *
 * The lake bed is a gently sloping continuous field that the mesher floors into
 * 1-unit terraces, so the contour where it crosses y = 8 comes out as long thin
 * winding ridges of columns rendered at exactly y = 8 — sandbars a single voxel
 * high, snaking right through the shallows. With the old surface at 7.85 those
 * ridges stood 0.15 proud of the water, and depending on how coverage was
 * decided they either poked through the surface as hard-edged tan rectangles and
 * beige wedges, or left ridge-shaped HOLES in the water through which their own
 * side faces showed as rows of dark blue bricks marching along the bottom. Both
 * were filed as "broken geometry", and both are the same 15-centimetre problem.
 *
 * Floating the surface 0.28 above WATER_LEVEL submerges that entire layer. The
 * ridges become a turquoise ripple in the shallows, the shoreline moves out to
 * the next contour (which stands a clean 0.7+ above the water and reads as a
 * proper bank), and every beach gains an inviting shallow fringe.
 */
const SURFACE_Y = WATER_LEVEL + 0.28;

/**
 * Build the water surface for a chunk; returns null when the chunk is dry.
 *
 * Three fields are baked from ONE height sample per padded cell:
 *
 *  - `wet`, coverage, from the INTEGER height the mesher renders, so a water quad
 *    can never overhang a column drawn as dry land;
 *  - `aShore`, distance in cells to the nearest dry column, which drives the foam;
 *  - `aDepth`, from the CONTINUOUS height, because every colour and opacity ramp
 *    is a function of it and the integer height would step them. Deriving depth
 *    from the integers (which is where this landed first) put a distinct colour
 *    band on every 1-unit bed terrace, and on a gently shelving bay those
 *    terraces are ten cells wide — no amount of blurring reaches across them, and
 *    the bay read as stepped bands of blue. The `- 0.5` is what keeps the smooth
 *    field consistent with the integer one: `columnHeight` is `floor(hc)`, so
 *    `hc - 0.5` is the mid-cell estimate of it, and a covered cell is therefore
 *    always at positive depth.
 */
export function buildWaterMesh(
  cx: number,
  cz: number,
  terrain: Terrain,
  material: THREE.ShaderMaterial,
): THREE.Mesh | null {
  const G = CHUNK_SIZE + 1;
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;

  // PAD is sampled OUTSIDE the chunk so both the blur and the chamfer sweeps
  // below compute identical values on a shared chunk edge from either side; no
  // seam appears down the boundary in the depth gradient or the foam band.
  const PAD = 7;
  const GG = G + PAD * 2;
  const buf = new Float32Array(GG * GG);
  // SHORE_MAX must stay well under PAD so the chamfer sweeps never mistake the
  // padded array's own border for coastline.
  const SHORE_MAX = 5;
  const dist = new Float32Array(GG * GG);
  const dry = new Uint8Array(GG * GG);
  for (let iz = 0; iz < GG; iz++)
    for (let ix = 0; ix < GG; ix++) {
      const i = iz * GG + ix;
      // Cell centres, matching Terrain.columnHeight, so one fbm evaluation yields
      // both the continuous and the integer height for this column.
      const hc = terrain.heightCont(ox + ix - PAD + 0.5, oz + iz - PAD + 0.5);
      const h = Math.max(1, Math.floor(hc));
      buf[i] = SURFACE_Y - (hc - 0.5);
      dry[i] = h > WATER_LEVEL ? 1 : 0;
      dist[i] = dry[i] ? 0 : SHORE_MAX;
    }

  let anyWet = false;
  for (let iz = 0; iz < CHUNK_SIZE && !anyWet; iz++)
    for (let ix = 0; ix < CHUNK_SIZE; ix++)
      if (!dry[(iz + PAD) * GG + (ix + PAD)]) { anyWet = true; break; }
  if (!anyWet) return null;

  // ---- depth attribute, low-pass filtered ---------------------------------
  // The colour and opacity ramps are non-linear functions of a per-vertex
  // attribute on a 1-unit grid. Interpolating it linearly across each cell and
  // THEN running it through three smoothsteps leaves a gradient kink at every
  // cell boundary, and because the shore ramps play out over well under a metre
  // those kinks were large: the shallows rendered as a visible checkerboard of
  // 1-metre squares — the "blotchy noise rather than depth" in the wide shots.
  // Two 1-2-1 tent passes remove the high-frequency component that the linear
  // interpolation cannot represent.
  const tmp = new Float32Array(GG * GG);
  for (let pass = 0; pass < 2; pass++) {
    for (let iz = 0; iz < GG; iz++)
      for (let ix = 1; ix < GG - 1; ix++) {
        const i = iz * GG + ix;
        tmp[i] = (buf[i - 1] + buf[i] * 2 + buf[i + 1]) * 0.25;
      }
    for (let iz = 1; iz < GG - 1; iz++)
      for (let ix = 1; ix < GG - 1; ix++) {
        const i = iz * GG + ix;
        buf[i] = (tmp[i - GG] + tmp[i] * 2 + tmp[i + GG]) * 0.25;
      }
  }

  // Two-pass chamfer distance to the nearest dry column (1 orthogonal, 1.414
  // diagonal). Computed over the PADDED grid so the value on a chunk edge is
  // identical from either side and the foam band crosses chunk seams unbroken.
  const D = 1, Q = 1.4142;
  const relax = (i: number, from: number, w: number): void => {
    const v = dist[from] + w;
    if (v < dist[i]) dist[i] = v;
  };
  for (let iz = 1; iz < GG; iz++)
    for (let ix = 1; ix < GG - 1; ix++) {
      const i = iz * GG + ix;
      relax(i, i - GG, D); relax(i, i - 1, D);
      relax(i, i - GG - 1, Q); relax(i, i - GG + 1, Q);
    }
  for (let iz = GG - 2; iz >= 0; iz--)
    for (let ix = GG - 2; ix >= 1; ix--) {
      const i = iz * GG + ix;
      relax(i, i + GG, D); relax(i, i + 1, D);
      relax(i, i + GG + 1, Q); relax(i, i + GG - 1, Q);
    }

  // Low-pass the distance field the same way `buf` was low-passed above, and for
  // a sharper reason. A chamfer transform of a BLOCKY coastline is a cone field
  // whose iso-lines are 45-degree facets, and where two wavefronts meet it has a
  // hard ridge. Every band driven off it (both foam terms) therefore came out as
  // a chain of diamond facets with a dark crease at each junction — filed as
  // "soft concentric arcs that read as map contour lines" and, at the waterline,
  // as the "row of teeth". Three tent passes round the cones into a smooth
  // shore-proximity field, so the foam traces the coast without printing its
  // staircase. Done on the PADDED grid so chunk edges still agree.
  for (let pass = 0; pass < 3; pass++) {
    for (let iz = 0; iz < GG; iz++)
      for (let ix = 1; ix < GG - 1; ix++) {
        const i = iz * GG + ix;
        tmp[i] = (dist[i - 1] + dist[i] * 2 + dist[i + 1]) * 0.25;
      }
    for (let iz = 1; iz < GG - 1; iz++)
      for (let ix = 1; ix < GG - 1; ix++) {
        const i = iz * GG + ix;
        dist[i] = (tmp[i - GG] + tmp[i] * 2 + tmp[i + GG]) * 0.25;
      }
  }

  const depths = new Float32Array(G * G);
  const shore = new Float32Array(G * G);
  const positions = new Float32Array(G * G * 3);
  // A flat +Y normal, which this surface's OWN shader never reads (it derives the
  // ripple normal analytically in the fragment stage). It exists for the GTAO
  // pass's MeshNormalMaterial override: now that the water is in the opaque list
  // and therefore in the AO G-buffer (see createWaterMaterial), a missing `normal`
  // attribute would read as (0,0,0), normalize() would give NaN and GTAO would
  // report the whole lake fully occluded — the "lake turned solid black" failure
  // already documented in core/post.ts. 12 bytes per vertex, ~13 KB per water
  // chunk, written once at build.
  const normals = new Float32Array(G * G * 3);
  for (let iz = 0; iz < G; iz++) {
    for (let ix = 0; ix < G; ix++) {
      const i = iz * G + ix;
      const p = (iz + PAD) * GG + (ix + PAD);
      depths[i] = buf[p];
      shore[i] = Math.min(dist[p], SHORE_MAX);
      positions[i * 3] = ix;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = iz;
      normals[i * 3 + 1] = 1;
    }
  }

  const idx: number[] = [];
  for (let iz = 0; iz < CHUNK_SIZE; iz++) {
    for (let ix = 0; ix < CHUNK_SIZE; ix++) {
      if (dry[(iz + PAD) * GG + (ix + PAD)]) continue;
      const a = iz * G + ix;
      const b = a + 1;
      const c = a + G;
      const d = c + 1;
      idx.push(a, c, d, a, d, b);
    }
  }
  if (idx.length === 0) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('aDepth', new THREE.BufferAttribute(depths, 1));
  geo.setAttribute('aShore', new THREE.BufferAttribute(shore, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(ox, SURFACE_Y, oz);
  mesh.renderOrder = 2;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
