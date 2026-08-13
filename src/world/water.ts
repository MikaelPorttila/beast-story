/**
 * Water: per-chunk translucent plane with baked shore-depth attributes. Custom
 * shader — depth-scaled vertex waves, a depth gradient, an analytic ripple normal
 * driving Fresnel sky reflection and a sun glint, plus coast-following foam.
 */
import * as THREE from "three";
import type { Terrain } from "./terrain";
import { CHUNK_SIZE, WATER_LEVEL } from "./terrain";

/** Width of the radial handoff from detailed water to the far landscape sheet. */
export const WATER_DETAIL_FADE_WIDTH = 48;

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
  // Both swells are OBLIQUE to the cube grid: an axis-aligned crest lines up with
  // the bed terraces and reads as a contour line.
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
 * Colours here are LINEAR; the hex in each comment is the source sRGB swatch.
 * Writing sRGB numbers raw lightens everything by roughly c^(1/2.2).
 */
const FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunStrength;
uniform vec2 uFocus;
uniform vec2 uDetailFade;
varying float vDepth;
/** Water surface: cells to the nearest dry column, clamped to 5. Apron: cells
 *  INLAND from the waterline. Two halves of one chamfer, see buildWaterMesh. */
varying float vShore;
/** 0 on the water surface, 1 on the wet-sand apron. */
varying float vLand;
varying vec3 vWorldPos;
#include <fog_pars_fragment>

// Four depth stops, not three: nearly every bay here is one or two voxels deep.
const vec3 WETSAND = vec3(0.130, 0.660, 0.505); // #64d5be sun on sand through 20cm
const vec3 SHALLOW = vec3(0.035, 0.545, 0.578); // #37c3c9 inviting turquoise
const vec3 MID     = vec3(0.016, 0.283, 0.478); // #269bc9
const vec3 DEEP    = vec3(0.024, 0.152, 0.355);
// Must match distant-terrain.ts: contours flatten to this past the gameplay band.
const vec3 FAR     = vec3(0.035, 0.300, 0.560);
// THE DEEP SEA, reached past DEEP_WATER_DEPTH (world/terrain.ts) — the number the
// traversal rule uses. A blue ink, not black: navy still takes the reflection.
const vec3 ABYSS   = vec3(0.005, 0.017, 0.033);
const vec3 FOAM    = vec3(0.930, 0.975, 1.000);
// Deeper and bluer than the sky dome, which is authored past 1.0 so haze blooms.
const vec3 SKY_HORIZON = vec3(0.55, 0.72, 0.90);
const vec3 SKY_ZENITH  = vec3(0.10, 0.34, 0.95);
// MUST match SUN_OFFSET in core/engine.ts, normalised. This shader cannot see the
// scene's lights, and a glint that disagrees with the shadows reads as wrong.

/** Analytic normal of crossed ripples: derivatives from the sines that displace
 *  the surface, so glint and shading agree. att flattens the field with distance,
 *  or a tight lobe aliases into fireflies past ~60 units. */
vec3 waveNormal(vec2 p, float t, float att) {
  vec2 slope = vec2(0.0);
  // Six mismatched wavelengths (30 / 6.6 / 4.5 / 2.7 / 2.4 / 1.7), directions about
  // the golden angle apart: a near-square lattice made the sun path a grid of dashes.
  slope += vec2(0.17, 0.21) * 0.190 * cos(dot(vec2(0.17, 0.21), p) + t * 0.55);
  slope += vec2(0.83, 0.46) * 0.115 * cos(dot(vec2(0.83, 0.46), p) + t * 1.60);
  slope += vec2(-0.63, 1.24) * 0.088 * cos(dot(vec2(-0.63, 1.24), p) - t * 1.25);
  slope += vec2(1.71, -1.53) * 0.050 * cos(dot(vec2(1.71, -1.53), p) + t * 2.40);
  slope += vec2(-2.44, -1.06) * 0.034 * cos(dot(vec2(-2.44, -1.06), p) - t * 2.85);
  slope += vec2(2.19, 2.87) * 0.026 * cos(dot(vec2(2.19, 2.87), p) + t * 3.40);
  return normalize(vec3(-slope.x * att, 1.0, -slope.y * att));
}

void main() {
  // tide and fw precede the water/land split because surf and run-up are one event
  // seen either side of the waterline: one sine, one world phase, one breathing coast.
  float tide = sin(uTime * 0.55 + vWorldPos.x * 0.055 + vWorldPos.z * 0.047);
  // Oblique sines. A separable sin(x)*sin(z) is a chequerboard, and at a grazing
  // angle its rows line up into horizontal banding.
  float fw = 0.58
    + 0.16 * sin(dot(vWorldPos.xz, vec2(2.31, 1.07)) + uTime * 2.1)
    + 0.15 * sin(dot(vWorldPos.xz, vec2(-1.13, 2.44)) - uTime * 1.7)
    + 0.11 * sin(dot(vWorldPos.xz, vec2(3.71, -2.93)) + uTime * 3.1);

  // The apron: a translucent decal 5 cm over the first dry terrace, same mesh and
  // material. DAMP band only — foam here draws a second shoreline a voxel up (#93).
  if (vLand > 0.5) {
    // Tinted, not painted, so a shadowed beach gets no wet stripe. Sunlit sand sits
    // on ACES's shoulder, so this must move the linear value by a FACTOR.
    float damp = smoothstep(1.60, 0.95, vShore) * (0.80 + 0.20 * tide);
    gl_FragColor = vec4(vec3(0.145, 0.115, 0.080), damp * 0.70);
    #include <fog_fragment>
    return;
  }

  // Three ramps over four stops, all pulled SHOREWARD: almost no bay here gets past
  // 4 units, so the far stops were never mixed in and every lake read alike.
  float dWet   = smoothstep(0.02, 0.45, vDepth);
  float dShore = smoothstep(0.40, 1.30, vDepth);
  float dDeep  = smoothstep(1.10, 3.20, vDepth);
  vec3 col = mix(WETSAND, SHALLOW, dWet);
  col = mix(col, MID, dShore);
  col = mix(col, DEEP, dDeep);
  // Fourth ramp, into the deep sea. Stops are DEPTH ATTRIBUTE units: buildWaterMesh
  // writes (WATER_LEVEL - hc) + 0.78, so DEEP_WATER_DEPTH of 4 is a vDepth of 3.78.
  float dAbyss = smoothstep(3.45, 4.85, vDepth);
  col = mix(col, ABYSS, dAbyss);
  // Depth reads well nearby and becomes a contour map of blobs from height, so
  // flatten the colour term only; normal, Fresnel and glint stay alive over it.
  float farWater = smoothstep(80.0, 170.0, distance(vWorldPos.xz, uFocus));
  // Height matters as much as range: from a flying mount the depth field is a map.
  float aerialWater = smoothstep(18.0, 55.0, max(cameraPosition.y - vWorldPos.y, 0.0));
  col = mix(col, FAR, max(farWater, aerialWater));

  vec3 toCam = cameraPosition - vWorldPos;
  float camDist = length(toCam);
  vec3 V = toCam / max(camDist, 0.001);
  float att = 0.22 + 0.78 * (1.0 - smoothstep(14.0, 70.0, camDist));
  vec3 N = waveNormal(vWorldPos.xz, uTime, att);
  // DoubleSide: unflipped, the underside gets a negative Fresnel and a dead specular.
  if (!gl_FrontFacing) N = -N;

  // Ripple SHADING, view-INDEPENDENT because Fresnel and the specular both collapse
  // looking down on a bay. ADDITIVE: deep water is ~(0.02,0.15,0.32) linear, so a
  // proportional term moves it by hundredths. Low, or the swell corrugates.
  col += vec3(0.030, 0.110, 0.145) * dot(N.xz, uSunDir.xz) * att * 1.15 * uSunStrength;

  vec3 R = reflect(-V, N);
  vec3 sky = mix(SKY_HORIZON, SKY_ZENITH, smoothstep(0.0, 0.45, R.y));
  // Tint the reflection to the water's hue: a full-strength pale sky is white paper.
  sky *= vec3(0.66, 0.94, 1.0);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0);
  fres = 0.025 + 0.975 * fres;
  // Reflection ceiling, split by depth: shallows keep their turquoise, deep water
  // needs sky or it is matte plastic, and the abyss is cut back to stay dark.
  float refl = fres * mix(0.14, 0.50, dShore) * (1.0 - 0.34 * dAbyss);
  // FROM UNDERNEATH, FRESNEL POINTS THE OTHER WAY, which was most of issue #23:
  // past the critical angle (48.6 deg) the surface mirrors the MURK. So below, the
  // sky is SNELL'S WINDOW and outside that disc the reflection aims at the body.
  if (gl_FrontFacing) {
    col = mix(col, sky, refl);
  } else {
    float up = max(dot(N, V), 0.0);
    float window = smoothstep(0.42, 0.86, up);
    col = mix(col * 0.72, sky, window * 0.40);
  }

  vec3 Hv = normalize(uSunDir + V);
  float ndh = max(dot(N, Hv), 0.0);
  // Three lobes: sparkle, sheen, and a middle GLINT STREAK at the scale a glint
  // reads at. Weights are matched to waveNormal's steepness — the failure in both
  // directions is white sheeting. Front-facing only, or it sheets the ceiling.
  if (gl_FrontFacing) {
    col += uSunColor * uSunStrength * (
        pow(ndh, 260.0) * 0.62
      + pow(ndh, 48.0) * 0.13
      + pow(ndh, 12.0) * 0.040
    );
  }

  // Shore foam by DISTANCE TO THE COAST, not depth: a lagoon is uniformly shallow
  // and a depth band also striped every submerged terrace. Breathes on the tide.
  float foam = smoothstep(1.65 + tide * 0.35, 0.30, vShore);
  foam = clamp(foam * fw * (0.85 + 0.15 * tide), 0.0, 1.0);
  // A narrower, brighter crest on the outer edge of the wash gives the surf a
  // leading line. The inner stop cannot go far under 0.3: aShore bottoms out near 1.
  float crest = smoothstep(1.25 + tide * 0.28, 0.20, vShore) * (0.55 + 0.45 * fw);
  // Wash low, crest high: the broad milk halo is the WASH term, the surf the crest.
  float surf = clamp(foam * 0.34 + crest * 0.76, 0.0, 1.0);
  col = mix(col, FOAM, surf);

  // Opacity: a FLOOR of 0.46 at the tide line, so the first metre shows sunlit sand,
  // and OPAQUE by 1.4 units, past which the bed's terraces and the shadow-map shadows
  // on their walls print through. Surf forces 0.95 — see-through foam is a ghost.
  float edge = smoothstep(0.02, 0.16, vDepth);
  float alpha = edge * mix(0.46, 1.0, smoothstep(0.12, 1.40, vDepth));
  alpha = max(alpha, surf * 0.95);
  // Detailed water ends on a ragged ring; fade it into the coarse far sheet so the
  // ring never shows as a square edge from flight height (issue #96).
  alpha *= 1.0 - smoothstep(
    uDetailFade.x, uDetailFade.y, distance(vWorldPos.xz, uFocus)
  );
  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
}
`;

export function createWaterMaterial(): THREE.ShaderMaterial {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib["fog"],
    {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.6554, 0.6168, 0.4356) },
      uSunColor: { value: new THREE.Color(1.0, 0.949, 0.851) },
      uSunStrength: { value: 1 },
      uFocus: { value: new THREE.Vector2() },
      // Medium's five 32 m chunks; the fade must finish before the nearest edge.
      uDetailFade: { value: new THREE.Vector2(160 - WATER_DETAIL_FADE_WIDTH, 160) },
    },
  ]);
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    // NOT `transparent`, though it blends. OpaqueGTAOPass hides transparent materials
    // from its G-buffer, so it creased the terraced lake BED and multiplied that AO
    // under opaque water. In the opaque list the flat plane occludes the bed.
    transparent: false,

    // THE BLENDING IS EXPLICIT, AND THAT IS THE WHOLE BUG: three's setMaterial does
    // `blending === NormalBlending && !transparent ? NoBlending : ...`, so an opaque
    // material's alpha was thrown away and every lake became a sheet of paint.
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,

    // Seen from BELOW whenever the hero swims (world/underwater.ts). A render state,
    // not a program permutation, so it costs nothing at warm-up.
    side: THREE.DoubleSide,

    // Surface and apron sit centimetres over the geometry they tint with depthWrite
    // off, so past ~60 units the depth buffer cannot always separate them.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
    depthWrite: false,
    fog: true,
  });
  return mat;
}

/**
 * A second surface off the same shader for water that is NOT a terrain chunk —
 * today the flying island's stream (world/sky-island.ts). It shares `src`'s uniform
 * OBJECTS by reference, so it cannot be lit at another time of day. It does NOT
 * share `uDetailFade`: there is no coarse far sheet eighty units up.
 */
export function createCarriedWaterMaterial(src: THREE.ShaderMaterial): THREE.ShaderMaterial {
  const mat = createWaterMaterial();
  mat.uniforms = {
    ...src.uniforms,
    uDetailFade: { value: new THREE.Vector2(1e7, 1e7 + 1) },
  };
  return mat;
}

/** Keep detailed water's dissolve aligned with the current voxel-detail ring. */
export function setWaterDetailDistance(mat: THREE.ShaderMaterial, distance: number): void {
  (mat.uniforms["uDetailFade"].value as THREE.Vector2).set(
    Math.max(0, distance - WATER_DETAIL_FADE_WIDTH),
    distance,
  );
}

/**
 * Water surface height, deliberately ABOVE the integer voxel layer at WATER_LEVEL.
 * The mesher floors the bed into 1-unit terraces, so the y = 8 contour comes out as
 * single-voxel sandbars snaking through the shallows; 0.28 of float submerges that
 * whole layer and moves the shoreline out to the next contour.
 */
export const SURFACE_Y = WATER_LEVEL + 0.28;

/**
 * Build the water surface for a chunk; null when the chunk is dry. Three fields from
 * ONE height sample per padded cell: `wet` coverage from the INTEGER height the
 * mesher renders, so a quad never overhangs dry land; `aShore`, cells to the nearest
 * dry column, for the foam; and `aDepth` from the CONTINUOUS height, since integer
 * depth banded every terrace (`- 0.5` is the mid-cell estimate of floor(hc)).
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

  // PAD samples OUTSIDE the chunk so the blur and chamfer sweeps agree on a shared
  // edge from either side, and no seam appears down a chunk boundary.
  const PAD = 7;
  const GG = G + PAD * 2;
  const buf = new Float32Array(GG * GG);
  // Must stay well under PAD, or the chamfer reads the padded border as coastline.
  const SHORE_MAX = 5;
  const dist = new Float32Array(GG * GG);
  // The same chamfer from the other side: cells from a DRY column back to water,
  // which is what the wet-sand apron is cut from.
  const inland = new Float32Array(GG * GG);
  const dry = new Uint8Array(GG * GG);
  /** Integer column height, for picking the beach terrace. */
  const hgt = new Int16Array(GG * GG);
  for (let iz = 0; iz < GG; iz++) {
    for (let ix = 0; ix < GG; ix++) {
      const i = iz * GG + ix;
      // Cell centres, matching Terrain.columnHeight: one fbm gives both heights.
      const hc = terrain.heightCont(ox + ix - PAD + 0.5, oz + iz - PAD + 0.5);
      const h = Math.max(1, Math.floor(hc));
      buf[i] = SURFACE_Y - (hc - 0.5);
      hgt[i] = h;
      dry[i] = h > WATER_LEVEL ? 1 : 0;
      dist[i] = dry[i] ? 0 : SHORE_MAX;
      inland[i] = dry[i] ? SHORE_MAX : 0;
    }
  }

  // Two questions: anyWet is "does this chunk need water", anyNear is "does it
  // touch water at all". The apron lives on DRY cells, so a coast just inside a
  // boundary puts its beach in the next chunk, and interior-only chopped it off.
  let anyWet = false;
  for (let iz = 0; iz < CHUNK_SIZE && !anyWet; iz++) {
    for (let ix = 0; ix < CHUNK_SIZE; ix++) {
      if (!dry[(iz + PAD) * GG + (ix + PAD)]) {
        anyWet = true;
        break;
      }
    }
  }
  let anyNear = anyWet;
  for (let i = 0; i < GG * GG && !anyNear; i++) {
    if (!dry[i]) {
      anyNear = true;
    }
  }
  if (!anyNear) {
    return null;
  }

  // Low-pass the depth attribute: the ramps are non-linear functions of it on a
  // 1-unit grid, so linear interpolation kinked the shallows into 1-metre squares.
  const tmp = new Float32Array(GG * GG);
  for (let pass = 0; pass < 2; pass++) {
    for (let iz = 0; iz < GG; iz++) {
      for (let ix = 1; ix < GG - 1; ix++) {
        const i = iz * GG + ix;
        tmp[i] = (buf[i - 1] + buf[i] * 2 + buf[i + 1]) * 0.25;
      }
    }
    for (let iz = 1; iz < GG - 1; iz++) {
      for (let ix = 1; ix < GG - 1; ix++) {
        const i = iz * GG + ix;
        buf[i] = (tmp[i - GG] + tmp[i] * 2 + tmp[i + GG]) * 0.25;
      }
    }
  }

  // Two-pass chamfer to the nearest dry column (1 orthogonal, 1.414 diagonal), over
  // the PADDED grid so a chunk edge gets the same value from either side.
  const D = 1,
    Q = 1.4142;
  const chamfer = (f: Float32Array): void => {
    const relax = (i: number, from: number, w: number): void => {
      const v = f[from] + w;
      if (v < f[i]) {
        f[i] = v;
      }
    };
    for (let iz = 1; iz < GG; iz++) {
      for (let ix = 1; ix < GG - 1; ix++) {
        const i = iz * GG + ix;
        relax(i, i - GG, D);
        relax(i, i - 1, D);
        relax(i, i - GG - 1, Q);
        relax(i, i - GG + 1, Q);
      }
    }
    for (let iz = GG - 2; iz >= 0; iz--) {
      for (let ix = GG - 2; ix >= 1; ix--) {
        const i = iz * GG + ix;
        relax(i, i + GG, D);
        relax(i, i + 1, D);
        relax(i, i + GG + 1, Q);
        relax(i, i + GG - 1, Q);
      }
    }
  };
  chamfer(dist);
  chamfer(inland);

  // Low-pass the distance field too: a chamfer of a blocky coast is a cone field
  // with 45-degree facets, which came out as a chain of diamonds at the waterline.
  const tent = (f: Float32Array, passes: number): void => {
    for (let pass = 0; pass < passes; pass++) {
      for (let iz = 0; iz < GG; iz++) {
        for (let ix = 1; ix < GG - 1; ix++) {
          const i = iz * GG + ix;
          tmp[i] = (f[i - 1] + f[i] * 2 + f[i + 1]) * 0.25;
        }
      }
      for (let iz = 1; iz < GG - 1; iz++) {
        for (let ix = 1; ix < GG - 1; ix++) {
          const i = iz * GG + ix;
          f[i] = (tmp[i - GG] + tmp[i] * 2 + tmp[i + GG]) * 0.25;
        }
      }
    }
  };
  tent(dist, 3);
  // TWO passes here: a third smears the run-up's leading lip into an airbrush.
  tent(inland, 2);

  // The wet-sand apron: quads 5 cm over the first DRY terrace, in this mesh and
  // material (the vLand branch above). It lives here because `inland` is the only
  // sub-cell answer for where the waterline is, and a baked band would stop MOVING.
  // Beach test: first dry terrace only, and inland <= APRON or a basin goes damp.
  const APRON = 2.6;
  const apPos: number[] = [];
  const apShore: number[] = [];
  const apIdx: number[] = [];
  // Per CORNER, not per cell, or the run-up steps in whole cells.
  const cor = (p: number): number =>
    (inland[p] + inland[p - 1] + inland[p - GG] + inland[p - GG - 1]) * 0.25;
  for (let iz = 0; iz < CHUNK_SIZE; iz++) {
    for (let ix = 0; ix < CHUNK_SIZE; ix++) {
      const p = (iz + PAD) * GG + (ix + PAD);
      if (!dry[p] || hgt[p] !== WATER_LEVEL + 1 || inland[p] > APRON) {
        continue;
      }
      // 5 cm: too small to float a pebble visibly, big enough for the depth test.
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
  // A flat +Y normal this shader never reads, present for the GTAO normal override:
  // a missing attribute reads (0,0,0) and GTAO reports the lake fully occluded.
  const normals = new Float32Array((NG + AP) * 3);
  const wetRows = anyWet ? G : 0;
  for (let iz = 0; iz < wetRows; iz++) {
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
  // Apron verts append to the same buffers; aDepth stays 0, which also keeps them
  // out of the vertex shader's depth-scaled swell.
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
        if (dry[(iz + PAD) * GG + (ix + PAD)]) {
          continue;
        }
        const a = iz * G + ix;
        const b = a + 1;
        const c = a + G;
        const d = c + 1;
        idx.push(a, c, d, a, d, b);
      }
    }
  }
  for (let k = 0; k < apIdx.length; k++) {
    idx.push(NG + apIdx[k]);
  }
  if (idx.length === 0) {
    return null;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setAttribute("aDepth", new THREE.BufferAttribute(depths, 1));
  geo.setAttribute("aShore", new THREE.BufferAttribute(shore, 1));
  geo.setAttribute("aLand", new THREE.BufferAttribute(land, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(ox, SURFACE_Y, oz);
  mesh.renderOrder = 2;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
