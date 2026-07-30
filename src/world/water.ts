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
const vec3 WETSAND = vec3(0.290, 0.660, 0.520); // #9bd7c1 sun on sand through 20cm
const vec3 SHALLOW = vec3(0.108, 0.620, 0.545); // #5fd4c6 inviting turquoise
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
 */
vec3 waveNormal(vec2 p, float t, float att) {
  vec2 slope = vec2(0.0);
  slope += vec2(0.85, 0.42) * 0.055 * cos(dot(vec2(0.85, 0.42), p) + t * 1.6);
  slope += vec2(-0.38, 0.92) * 0.048 * cos(dot(vec2(-0.38, 0.92), p) + t * 1.25);
  slope += vec2(1.90, -1.35) * 0.017 * cos(dot(vec2(1.90, -1.35), p) + t * 2.4);
  slope += vec2(0.21, 0.17) * 0.090 * cos(dot(vec2(0.21, 0.17), p) + t * 0.55);
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
  float dWet   = smoothstep(0.05, 0.85, vDepth);
  float dShore = smoothstep(0.65, 1.70, vDepth);
  float dDeep  = smoothstep(1.40, 3.60, vDepth);
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
  float refl = fres * mix(0.12, 0.28, dShore);
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
  col += SUN_COL * (
      pow(ndh, 220.0) * 1.8
    + pow(ndh, 60.0) * 0.34
    + pow(ndh, 16.0) * 0.055
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
  float tide = sin(uTime * 0.55 + vWorldPos.x * 0.055 + vWorldPos.z * 0.047);
  float foam = smoothstep(2.4 + tide * 0.4, 0.45, vShore);
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
  float crest = smoothstep(1.35, 0.4, vShore) * (0.55 + 0.45 * fw);
  // Weights are down (0.72/0.50 -> 0.52/0.40) so the wash NEVER reaches the full
  // FOAM colour. At the old weights the band saturated to near-opaque white a
  // block or two out from every shore, and a saturated band on a stepped coast is
  // indistinguishable from a row of white cubes — which is exactly what it was
  // filed as. Capped like this the foam always keeps some water under it.
  col = mix(col, FOAM, clamp(foam * 0.52 + crest * 0.40, 0.0, 1.0));

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
    transparent: true,
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
  for (let iz = 0; iz < G; iz++) {
    for (let ix = 0; ix < G; ix++) {
      const i = iz * G + ix;
      const p = (iz + PAD) * GG + (ix + PAD);
      depths[i] = buf[p];
      shore[i] = Math.min(dist[p], SHORE_MAX);
      positions[i * 3] = ix;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = iz;
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
