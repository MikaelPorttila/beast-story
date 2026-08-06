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
/** 0 on the water surface, 1 on the wet-sand apron. See buildWaterMesh. */
attribute float aLand;
varying float vDepth;
varying float vShore;
varying float vLand;
varying vec3 vWorldPos;
#include <fog_pars_vertex>
void main() {
  vDepth = aDepth;
  vShore = aShore;
  vLand = aLand;
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
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunStrength;
varying float vDepth;
/**
 * On the water surface: distance in cells to the nearest dry column, clamped to
 * 5. On the apron: distance in cells INLAND from the waterline. See
 * buildWaterMesh — the two fields are the two halves of the same chamfer.
 */
varying float vShore;
/** 0 on the water surface, 1 on the wet-sand apron. */
varying float vLand;
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
// THE DEEP SEA — the dark water you are turned back from. A fifth stop, not a
// darker DEEP: every one of the four above is tuned for water you can see the
// bed through and DEEP is where a bay bottoms out, so pushing it toward ink
// would drag every three-metre lagoon down with it. This one is only reached
// past DEEP_WATER_DEPTH (world/terrain.ts), which is the same number the
// traversal rule uses — the whole point being that the water a player is
// refused is the water that looks refusing.
//
// #0f2233, and it is a BLUE ink rather than black. Black would be a hole cut in
// the lake; a deep saturated navy still takes the sky reflection and the glint
// below it, so the abyss reads as a surface with nothing under it rather than
// as missing geometry.
const vec3 ABYSS   = vec3(0.005, 0.017, 0.033);
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
  // ---- the beat both halves of the shoreline share -------------------------
  //
  // tide and the wash texture fw are computed BEFORE the water/land split
  // because the surf on the water and the run-up on the sand are one event seen
  // either side of the waterline. Driving them from two different phases is
  // instantly readable as two effects that happen to be adjacent: the white band
  // on the water advances while the wash on the sand retreats. Same sine, same
  // world-space phase, so a wave arrives everywhere along a stretch of coast at
  // once and the whole shore breathes together.
  float tide = sin(uTime * 0.55 + vWorldPos.x * 0.055 + vWorldPos.z * 0.047);
  // Wash texture from three sines on rotated, mutually irrational directions.
  // This was sin(x*2.6) * sin(z*2.4) — a SEPARABLE product, which is a
  // chequerboard: viewed across a bay at a grazing angle its rows lined up into
  // the horizontal banding that got filed against the shallows. A sum of
  // obliquely-oriented waves has no rows to line up.
  float fw = 0.58
    + 0.16 * sin(dot(vWorldPos.xz, vec2(2.31, 1.07)) + uTime * 2.1)
    + 0.15 * sin(dot(vWorldPos.xz, vec2(-1.13, 2.44)) - uTime * 1.7)
    + 0.11 * sin(dot(vWorldPos.xz, vec2(3.71, -2.93)) + uTime * 3.1);

  // ---- wet sand -----------------------------------------------------------
  //
  // The apron is the strip of beach the water has just left: a translucent decal
  // 5 cm over the first dry terrace, part of this same mesh and material (see
  // buildWaterMesh). Before it, sand met water on a bare geometric edge — the
  // single hardest cut in the world, and the reason a coast read as a decal
  // pasted onto the terrain rather than as a place where two materials meet.
  //
  // Two bands live here. The DAMP band is the wider one, a dark warm tint about
  // a metre and a half deep; the RUN-UP is a thin sheet of foam that
  // actually crosses the waterline and slides up over the sand, and it is the
  // half that sells the motion, because a band that only ever changes brightness
  // reads as a texture while a band that MOVES reads as water.
  if (vLand > 0.5) {
    // Damp sand. Tinted, not painted: this is alpha-blended over the terrain's
    // own lit sand, so the sun/shadow shading underneath still comes through and
    // a shadowed beach does not suddenly get a bright wet stripe on it.
    //
    // THE FIRST PASS AT THIS WAS INVISIBLE, and the reason is the tone curve, not
    // the blend. (0.16,0.13,0.09) at 40% over sunlit sand takes the buffer from
    // ~0.89 linear to ~0.60 — a third of the light gone — and that photographed
    // (_wat-a-surf.png) as an 18-code-value step, i.e. nothing. Sunlit sand sits
    // at sRGB ~232 here, right up on ACES's shoulder where 0.89 and 0.60 land
    // almost on top of each other. Anything meant to READ against sunlit sand has
    // to move the linear value by a FACTOR, not by a percentage. What shipped is
    // (0.145,0.115,0.080) at 70%, which takes 0.89 linear down to ~0.31 — about
    // a third of the light, displaying near sRGB 175 against the dry beach's 232.
    // Scanned off the frame (_wat-shore.png, a column crossing the waterline) the
    // real profile runs 190,164,109 at the tide mark up to 230,199,127 a metre
    // inland; that ~40-code ramp is the band.
    //
    // The PROFILE is flat-topped and NARROW, and both halves of that were bought
    // with captures. Flat-topped: the first version ramped from full strength at
    // the water to nothing 2.3 cells inland, which put all its weight under the
    // run-up below and left no band you could see. Narrow: the second version was
    // flat out to 1.9 cells and 2.55 at the fade, and from a low camera that
    // covers the ENTIRE visible beach (_wat-a-shore.png) — a wet band with no dry
    // sand next to it is not a band, it is a slightly duller beach. 1.6 cells with
    // the fade starting at 0.95 leaves bright sand above it in every framing, and
    // a strip roughly a metre wide is what a real tide line looks like anyway.
    float damp = smoothstep(1.60, 0.95, vShore) * (0.80 + 0.20 * tide);
    // The run-up. vShore here is distance INLAND, so the threshold IS the edge
    // of the sheet of water sliding up the beach: at low tide it sits back at
    // 0.13 cells (barely past the waterline), at high tide it reaches 0.97.
    // That is a band sweeping ~0.8 units up and down the sand twice per wave
    // period, and it stays INSIDE the damp band above (which reaches 1.6) so
    // there is always dark wet sand showing ahead of the foam — and because the
    // damp band itself does NOT move, what the eye
    // reads is the dark strip getting narrower and wider as the sea breathes,
    // which is far more legible than the white itself. That matters more than it
    // sounds: sunlit sand here sits at sRGB ~232, so white foam laid over it is
    // worth ten code values and the wash CANNOT be read by brightness alone.
    float reach = 0.55 + 0.42 * tide;
    float sheet = smoothstep(reach, max(0.0, reach - 0.40), vShore);
    // The leading lip of the sheet is brighter than the body of it — that is
    // where the air is, and it is what makes a run-up read as foam rather than
    // as a wet patch.
    float lip = smoothstep(reach - 0.20, reach, vShore) * smoothstep(reach + 0.12, reach, vShore);
    float run = clamp(sheet * (0.55 + 0.45 * fw) + lip * 0.90, 0.0, 1.0);
    // FOAM * 1.32, not FOAM. Same arithmetic as the damp band, run the other way:
    // FOAM is 0.93-1.00 linear and sunlit sand is ~0.89, so foam laid on a beach
    // at its authored radiance is four code values brighter than the sand it is
    // supposed to stand out from. Overdriving it puts the sheet above the sand
    // rather than level with it — and it is still under the emissive-bloom
    // threshold, so it brightens without hazing.
    //
    // What actually makes the run-up read at 40 units, though, is the DAMP BAND
    // UNDER IT: a bright line against a dark line is legible at any distance,
    // where a bright line against bright sand is not. The two bands are one
    // effect, which is why they share a threshold.
    vec3 col = mix(vec3(0.145, 0.115, 0.080), FOAM * 1.32, run);
    float alpha = clamp(max(damp * 0.70, run * 0.88), 0.0, 1.0);
    gl_FragColor = vec4(col, alpha);
    #include <fog_fragment>
    return;
  }

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
  // ...and the fourth ramp, into the deep sea. The stops are in DEPTH ATTRIBUTE
  // units, which are not depth in world units: buildWaterMesh writes
  // SURFACE_Y - (hc - 0.5), i.e. (WATER_LEVEL - hc) + 0.78. DEEP_WATER_DEPTH is
  // 4, so the first refused column has a vDepth of 3.78 and the ramp is placed
  // to straddle it — visibly darkening a third of a unit BEFORE the rule bites,
  // which is what turns "the game stopped me" into "I could see that was too
  // deep". Fully dark half a unit past, so the transition is a band you read
  // across a bay rather than a line you notice at the edge of one.
  float dAbyss = smoothstep(3.45, 4.85, vDepth);
  col = mix(col, ABYSS, dAbyss);

  vec3 toCam = cameraPosition - vWorldPos;
  float camDist = length(toCam);
  vec3 V = toCam / max(camDist, 0.001);
  float att = 0.22 + 0.78 * (1.0 - smoothstep(14.0, 70.0, camDist));
  vec3 N = waveNormal(vWorldPos.xz, uTime, att);
  // Underside: the material is DoubleSide so the surface still exists when the
  // camera is below it, and a normal pointing away from the viewer would give a
  // negative Fresnel term (floor 0.025, no reflection) and a dead specular — the
  // ceiling of the lake would read as flat matte nothing. Flipped, the same
  // ripple field shades from below.
  if (!gl_FrontFacing) N = -N;

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
  col += vec3(0.030, 0.110, 0.145) * dot(N.xz, uSunDir.xz) * att * 1.15 * uSunStrength;

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
  // ...and PULLED BACK over the abyss. dShore is saturated out there, so deep
  // sea would otherwise take the full 0.50 of sky, and at the grazing angle
  // every wide shot is taken from that is a mirror laid over a body colour of
  // 0.03 — the dark water would read dark from directly above and pale blue
  // from the shore, which is the one bearing a player actually approaches it
  // from. Cutting it by a third leaves enough reflection for the surface to
  // read as a surface.
  float refl = fres * mix(0.14, 0.50, dShore) * (1.0 - 0.34 * dAbyss);
  // FROM UNDERNEATH, FRESNEL POINTS THE OTHER WAY, and getting that backwards is
  // most of issue #23. Every line above is written for a viewer in the air, where
  // a grazing angle turns the surface into a mirror of the sky — true, and the
  // reason a lake reads as a lake. Under the water the same grazing angle is past
  // the critical angle (48.6 degrees for water/air) and the surface is a mirror of
  // the MURK: total internal reflection, the darkest thing in the frame, not the
  // brightest. Running the air formula down there laid up to 50% of pale sky over
  // the entire ceiling of the lake, and because the ceiling fills the frame the
  // moment the lens dips, the whole picture went white — "everything becomes super
  // shiny". Measured on a lens 2.14 units under: the frame came back at sat 0.03,
  // essentially neutral.
  //
  // What replaces it is the one thing a viewer under water actually sees: SNELL'S
  // WINDOW. The entire sky is refracted into a disc about 97 degrees wide straight
  // overhead, and everything outside that disc is the mirrored bed. The up term is 1
  // looking square at the ceiling and falls off toward grazing, so the smoothstep
  // IS the rim of the window — bright in the middle, gone by the critical angle,
  // which is a real and recognisable image rather than a fog of pale blue.
  //
  // Outside the window the reflection is kept but aimed at the body colour rather
  // than the sky, which is the cheap stand-in for reflecting the murk: it costs no
  // second sample and it cannot be brighter than the water already is.
  if (gl_FrontFacing) {
    col = mix(col, sky, refl);
  } else {
    float up = max(dot(N, V), 0.0);
    float window = smoothstep(0.42, 0.86, up);
    col = mix(col * 0.72, sky, window * 0.40);
  }

  // Sun glint: one tight lobe for the sparkle, one broad one for sheen. The
  // broad lobe is down from 0.11 to 0.065 — at the old weight it covered a whole
  // bay in an even white haze in any shot looking toward the sun, which is what
  // washed the lake almost to paper. The tight lobe (where the actual liquid read
  // comes from) is untouched.
  vec3 Hv = normalize(uSunDir + V);
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
  // Glint is a highlight of the sun ON TOP of the surface, so it belongs to the
  // side the sun is on. Left running underneath, the broad pow-12 lobe alone put
  // a sheet of SUN_COL across the ceiling of the lake — the same white-out as the
  // reflection above, from a second source, and the one that survives looking
  // straight down because the half-vector barely moves.
  if (gl_FrontFacing) {
    col += uSunColor * uSunStrength * (
        pow(ndh, 260.0) * 0.62
      + pow(ndh, 48.0) * 0.13
      + pow(ndh, 12.0) * 0.040
    );
  }

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
  // (tide and fw are computed at the top of main, shared with the apron.)
  float foam = smoothstep(1.65 + tide * 0.35, 0.30, vShore);
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
  //
  // ROUND 3: the crest band BREATHES (+ tide * 0.30) instead of standing
  // still. The wash threshold above has always moved with the tide, but the
  // crest — the bright line, the part you actually see from 30 units away — was
  // a fixed band, so the surf shimmered without ever advancing. Now the whole
  // white edge swings ~0.6 units in and out on the same sine the apron's run-up
  // uses, and the two read as one wave crossing the waterline.
  // The band also TIGHTENS, 1.50 -> 1.25 cells, with the weight up 0.62 -> 0.76.
  // Measured on _wat-shore.png: the old band peaked at ~0.85 of FOAM and then
  // fell off over a cell and a half, which photographs as a pale wash spreading
  // out from the beach rather than as a line of surf. Narrower and hotter is the
  // whole difference between "the water is milky near the shore" — the failure
  // this shader has hit three times — and "there is a line of foam at the
  // waterline".
  float crest = smoothstep(1.25 + tide * 0.28, 0.20, vShore) * (0.55 + 0.45 * fw);
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
  float surf = clamp(foam * 0.34 + crest * 0.76, 0.0, 1.0);
  col = mix(col, FOAM, surf);

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
  //
  // ROUND 3 — THE WATER IS TRANSPARENT AGAIN, and the paragraph above is only
  // half right. Two things had made the lake a solid sheet of paint, and one of
  // them was not deliberate at all (see createWaterMaterial: transparent:false
  // with NormalBlending makes three set NoBlending, so this alpha was being
  // DISCARDED and even the 30cm ramp never ran). With blending restored, the
  // opacity here is what the player sees, so it is worth stating what it buys:
  //
  //   - a FLOOR of 0.46 at the tide line, not 1.0. Over the first metre of depth
  //     you look through to the sunlit sand, which is the single most inviting
  //     thing a stylised lake can do, and it is a read no painted colour stop can
  //     fake — the bed's own light and its own shading come through it.
  //   - OPAQUE by 1.4 units. That is the ceiling the old comment was defending
  //     and it still holds: past a metre and a half the bed's 1-unit terraces (and
  //     the real shadow-map shadows on their walls) start printing through as
  //     contour stripes. Deep water hides them, and the depth gradient carries the
  //     drop-off instead.
  //   - SURF IS OPAQUE. The foam band forces alpha to 0.95 regardless of depth:
  //     white surf over a see-through waterline would be a pale ghost of a line
  //     at gameplay distance, which is exactly the "no shore foam" finding. It is
  //     the alpha, not the colour, that makes the band read across a bay.
  float edge = smoothstep(0.02, 0.16, vDepth);
  float alpha = edge * mix(0.46, 1.0, smoothstep(0.12, 1.40, vDepth));
  alpha = max(alpha, surf * 0.95);
  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
}
`;

export function createWaterMaterial(): THREE.ShaderMaterial {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib['fog'],
    {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.6554, 0.6168, 0.4356) },
      uSunColor: { value: new THREE.Color(1.0, 0.949, 0.851) },
      uSunStrength: { value: 1 },
    },
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
    // renderOrder of 2 still sorts it behind every other opaque object. What
    // changes is that GTAO now sees the water plane, which occludes the bed and is
    // itself flat, so there is nothing left for it to crease. depthWrite stays
    // false so the surface never clips the transparent VFX and contact shadows
    // that draw after it.
    transparent: false,

    // THE BLENDING IS EXPLICIT, AND THAT IS THE WHOLE BUG.
    //
    // The paragraph above used to end "...and `blending` is applied from the
    // material regardless of which list it is in — so the beauty pass is
    // pixel-identical". It is not, and this is where "the water stopped being
    // transparent" came from. three's WebGLState.setMaterial reads:
    //
    //     material.blending === NormalBlending && material.transparent === false
    //       ? setBlending( NoBlending )
    //       : setBlending( material.blending, ... )
    //
    // i.e. NormalBlending is treated as "the default, which an opaque material
    // does not want" and the blend equation is switched OFF entirely. The
    // fragment shader's alpha was still computed, still written, and then thrown
    // away by the fixed-function stage: every lake in the world became a solid
    // sheet of paint the moment `transparent` went false, whatever the depth ramp
    // said. The AO fix and the transparency were never actually in conflict —
    // only that one `? :` was.
    //
    // Naming the same source/destination factors explicitly takes the `===
    // NormalBlending` branch out of play, so the surface keeps its own alpha AND
    // stays in the opaque list where GTAO can see it. Both wins, no trade.
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,

    // Seen from BELOW. The camera dips under the surface whenever the hero swims
    // (see world/underwater.ts), and a FrontSide plane simply vanishes from under
    // there — you would be swimming in an open-topped box with the sky in it.
    // DoubleSide is a render-state change only, not a program permutation, so it
    // costs nothing at warm-up; the fragment stage flips its analytic normal on
    // gl_FrontFacing so the underside shades like a surface rather than like a
    // plane lit from the wrong hemisphere.
    side: THREE.DoubleSide,

    // The surface and the wet-sand apron both sit a few centimetres over
    // geometry they are meant to tint (the lake bed, the first dry terrace) with
    // depthWrite off, so at 60+ units the depth buffer cannot always separate
    // them. A small offset toward the camera settles it; nothing is coplanar with
    // the water for this to disturb.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
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
export const SURFACE_Y = WATER_LEVEL + 0.28;

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
  // The SAME chamfer run from the other side: distance in cells from a DRY
  // column back to the water. It is what the wet-sand apron is cut from, and
  // deriving it here rather than in the mesher is the point — this file already
  // knows where the waterline is to sub-cell accuracy, and terrain/chunk own the
  // land. One extra Float32Array and two sweeps over the padded grid per chunk
  // build (~2 KB, ~8k relaxations, measured at well under a tenth of the fbm
  // sampling that already happens above).
  const inland = new Float32Array(GG * GG);
  const dry = new Uint8Array(GG * GG);
  /** Integer column height, for picking the beach terrace. */
  const hgt = new Int16Array(GG * GG);
  for (let iz = 0; iz < GG; iz++)
    for (let ix = 0; ix < GG; ix++) {
      const i = iz * GG + ix;
      // Cell centres, matching Terrain.columnHeight, so one fbm evaluation yields
      // both the continuous and the integer height for this column.
      const hc = terrain.heightCont(ox + ix - PAD + 0.5, oz + iz - PAD + 0.5);
      const h = Math.max(1, Math.floor(hc));
      buf[i] = SURFACE_Y - (hc - 0.5);
      hgt[i] = h;
      dry[i] = h > WATER_LEVEL ? 1 : 0;
      dist[i] = dry[i] ? 0 : SHORE_MAX;
      inland[i] = dry[i] ? SHORE_MAX : 0;
    }

  // Two questions, not one. `anyWet` is "does this chunk need a water surface";
  // `anyNear` is "does it touch water at all", which is the one that decides
  // whether there is anything to build — because the wet-sand apron below lives
  // on DRY cells, and a coastline running just inside a chunk boundary puts its
  // beach in the next chunk over. Returning null on the old interior-only test
  // chopped that beach off at a 32-unit grid line: the damp band and the foam
  // run-up simply stopped dead on a straight edge wherever the coast came within
  // a couple of cells of a chunk seam. `anyNear` scans the PADDED grid, so a dry
  // chunk with water within PAD cells still gets built — as an apron-only mesh,
  // with no water grid in it at all (see NG below).
  let anyWet = false;
  for (let iz = 0; iz < CHUNK_SIZE && !anyWet; iz++)
    for (let ix = 0; ix < CHUNK_SIZE; ix++)
      if (!dry[(iz + PAD) * GG + (ix + PAD)]) { anyWet = true; break; }
  let anyNear = anyWet;
  for (let i = 0; i < GG * GG && !anyNear; i++) if (!dry[i]) anyNear = true;
  if (!anyNear) return null;

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
  const chamfer = (f: Float32Array): void => {
    const relax = (i: number, from: number, w: number): void => {
      const v = f[from] + w;
      if (v < f[i]) f[i] = v;
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
  };
  chamfer(dist);
  chamfer(inland);

  // Low-pass the distance field the same way `buf` was low-passed above, and for
  // a sharper reason. A chamfer transform of a BLOCKY coastline is a cone field
  // whose iso-lines are 45-degree facets, and where two wavefronts meet it has a
  // hard ridge. Every band driven off it (both foam terms) therefore came out as
  // a chain of diamond facets with a dark crease at each junction — filed as
  // "soft concentric arcs that read as map contour lines" and, at the waterline,
  // as the "row of teeth". Three tent passes round the cones into a smooth
  // shore-proximity field, so the foam traces the coast without printing its
  // staircase. Done on the PADDED grid so chunk edges still agree.
  const tent = (f: Float32Array, passes: number): void => {
    for (let pass = 0; pass < passes; pass++) {
      for (let iz = 0; iz < GG; iz++)
        for (let ix = 1; ix < GG - 1; ix++) {
          const i = iz * GG + ix;
          tmp[i] = (f[i - 1] + f[i] * 2 + f[i + 1]) * 0.25;
        }
      for (let iz = 1; iz < GG - 1; iz++)
        for (let ix = 1; ix < GG - 1; ix++) {
          const i = iz * GG + ix;
          f[i] = (tmp[i - GG] + tmp[i] * 2 + tmp[i + GG]) * 0.25;
        }
    }
  };
  tent(dist, 3);
  // The inland field gets TWO passes rather than three. It drives a band that is
  // supposed to advance and retreat over ~1.2 cells, and a third pass smears the
  // 45-degree chamfer facets so far that the run-up's leading lip loses its edge
  // — the wash stops looking like a sheet of water with a front and starts
  // looking like an airbrushed gradient. Two is enough to kill the diamond
  // facets, which is what the smoothing is for.
  tent(inland, 2);

  // ---- the wet-sand apron -------------------------------------------------
  //
  // A skirt of quads laid 5 cm over the first DRY terrace, inside this same mesh
  // and this same material, carrying the damp band and the foam run-up (see the
  // `vLand` branch in the fragment shader).
  //
  // Why it lives here and not in the terrain mesher: this file is the only place
  // that knows where the waterline is to sub-cell accuracy — `inland` above is
  // the chamfer field that produced it — and painting the band into the terrain's
  // vertex colours would quantise it to whole cells and freeze it, when the whole
  // value of the band is that it MOVES. As geometry in the water mesh it also
  // streams, disposes and z-sorts with the water it belongs to, for free.
  //
  // Selection is deliberately strict, and it is a beach test rather than a
  // proximity test:
  //
  //   - `hgt === WATER_LEVEL + 1` — the FIRST dry terrace only. The surface floats
  //     at 8.28 (see SURFACE_Y) so that terrace's top face stands 0.72 above the
  //     water: it is the strip a wave can reach. The next one up is 1.72 above and
  //     a wet band on it would read as a painted contour line, which is precisely
  //     the artefact the depth-driven foam was moved away from.
  //   - `inland <= APRON` — within 2.6 cells of water. A flat sand basin can have
  //     hundreds of cells at exactly this height (they exist all over this world);
  //     without the distance cut the whole basin would go damp.
  //
  // A cliff dropping straight into the water simply has no cell at this height,
  // so it gets no apron — which is correct. Wet sand is what a shelving beach has.
  const APRON = 2.6;
  const apPos: number[] = [];
  const apShore: number[] = [];
  const apIdx: number[] = [];
  // Corner sample of the inland field: the mean of the four cells that meet at
  // the min corner of cell `p`. Sampling per CORNER rather than per cell is what
  // keeps the band a smooth curve — a per-cell constant would step the run-up in
  // whole cells and put a staircase back on the coast.
  const cor = (p: number): number =>
    (inland[p] + inland[p - 1] + inland[p - GG] + inland[p - GG - 1]) * 0.25;
  for (let iz = 0; iz < CHUNK_SIZE; iz++) {
    for (let ix = 0; ix < CHUNK_SIZE; ix++) {
      const p = (iz + PAD) * GG + (ix + PAD);
      if (!dry[p] || hgt[p] !== WATER_LEVEL + 1 || inland[p] > APRON) continue;
      // 5 cm of lift. Small enough that nothing standing on the beach (a pebble,
      // a grass tuft, the hero's feet) is visibly floated by it, large enough
      // that the depth test still separates the two surfaces at the far end of a
      // vista; the material's polygonOffset covers the rest.
      const y = hgt[p] + 0.05 - SURFACE_Y;
      const base = apPos.length / 3;
      apPos.push(ix, y, iz, ix + 1, y, iz, ix, y, iz + 1, ix + 1, y, iz + 1);
      apShore.push(cor(p), cor(p + 1), cor(p + GG), cor(p + GG + 1));
      apIdx.push(base, base + 2, base + 3, base, base + 3, base + 1);
    }
  }
  const AP = apPos.length / 3;
  /** Water-grid vertex count: zero in an apron-only chunk (see anyNear above). */
  const NG = anyWet ? G * G : 0;

  const depths = new Float32Array(NG + AP);
  const shore = new Float32Array(NG + AP);
  const land = new Float32Array(NG + AP);
  const positions = new Float32Array((NG + AP) * 3);
  // A flat +Y normal, which this surface's OWN shader never reads (it derives the
  // ripple normal analytically in the fragment stage). It exists for the GTAO
  // pass's MeshNormalMaterial override: now that the water is in the opaque list
  // and therefore in the AO G-buffer (see createWaterMaterial), a missing `normal`
  // attribute would read as (0,0,0), normalize() would give NaN and GTAO would
  // report the whole lake fully occluded — the "lake turned solid black" failure
  // already documented in core/post.ts. 12 bytes per vertex, ~13 KB per water
  // chunk, written once at build.
  const normals = new Float32Array((NG + AP) * 3);
  for (let iz = 0; iz < G && anyWet; iz++) {
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
  // Apron vertices append to the same buffers: one geometry, one draw call, one
  // material. aDepth stays 0 on them, which is also what keeps them out of the
  // vertex shader's swell (its amplitude is scaled by depth), so the skirt lies
  // flat on the sand while the water beside it heaves.
  for (let v = 0; v < AP; v++) {
    const i = NG + v;
    positions[i * 3] = apPos[v * 3];
    positions[i * 3 + 1] = apPos[v * 3 + 1];
    positions[i * 3 + 2] = apPos[v * 3 + 2];
    normals[i * 3 + 1] = 1;
    shore[i] = apShore[v];
    land[i] = 1;
  }

  const idx: number[] = [];
  if (anyWet) {
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
  }
  for (let k = 0; k < apIdx.length; k++) idx.push(NG + apIdx[k]);
  if (idx.length === 0) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('aDepth', new THREE.BufferAttribute(depths, 1));
  geo.setAttribute('aShore', new THREE.BufferAttribute(shore, 1));
  geo.setAttribute('aLand', new THREE.BufferAttribute(land, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(ox, SURFACE_Y, oz);
  mesh.renderOrder = 2;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
