/**
 * Water: per-chunk translucent plane with baked shore-depth attribute.
 * Custom ShaderMaterial — gentle vertex waves scaled by depth (shoreline
 * stays put), depth-tinted color, animated foam band where water meets sand,
 * and sun sparkle. Fog-aware.
 */
import * as THREE from 'three';
import { CHUNK_SIZE, Terrain, WATER_LEVEL } from './terrain';

const VERT = /* glsl */ `
uniform float uTime;
attribute float aDepth;
varying float vDepth;
varying vec3 vWorldPos;
#include <fog_pars_vertex>
void main() {
  vDepth = aDepth;
  vec3 p = position;
  float d = clamp(aDepth, 0.0, 1.5);
  vec4 wp4 = modelMatrix * vec4(p, 1.0);
  float w =
    sin(wp4.x * 0.55 + uTime * 1.15) * 0.45 +
    sin(wp4.z * 0.48 - uTime * 0.85) * 0.45 +
    sin((wp4.x + wp4.z) * 0.22 + uTime * 0.55) * 0.6;
  p.y += w * 0.055 * d;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  vWorldPos = (modelMatrix * vec4(p, 1.0)).xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
varying float vDepth;
varying vec3 vWorldPos;
#include <fog_pars_fragment>

// cheap 2D hash for per-cell sparkle phase jitter
float hash21(vec2 p) {
  p = fract(p * vec2(127.13, 311.71));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

void main() {
  vec3 shallow = vec3(0.36, 0.78, 0.82);
  vec3 deep = vec3(0.05, 0.31, 0.58);
  float df = smoothstep(0.0, 6.0, vDepth);
  vec3 col = mix(shallow, deep, df);

  // moving sun sparkle — phase-jittered per world cell so the sin product
  // never tiles, and faded with camera distance so it doesn't read as
  // salt-and-pepper noise from altitude / grazing distance.
  float ph = hash21(floor(vWorldPos.xz)) * 6.2831853;
  float sp = sin(vWorldPos.x * 2.3 + uTime * 1.7 + ph) * sin(vWorldPos.z * 1.9 - uTime * 1.35 + ph * 1.618);
  sp *= sin((vWorldPos.x - vWorldPos.z) * 1.1 + uTime * 0.9 + ph);
  float camDist = length(cameraPosition - vWorldPos);
  // fade fully by ~34 units — grazing-angle moiré lives past that range
  float spFade = 1.0 - smoothstep(12.0, 34.0, camDist);
  col += vec3(0.55, 0.6, 0.55) * smoothstep(0.75, 1.0, sp) * (0.25 + 0.45 * df) * spFade;

  // shore foam band: the depth threshold slowly advances and retreats so the
  // band breathes like wash instead of sitting as a painted stripe.
  float tide = sin(uTime * 0.55 + vWorldPos.x * 0.055 + vWorldPos.z * 0.047);
  float foam = smoothstep(0.6 + tide * 0.18, 0.12, vDepth);
  float fw = 0.62 + 0.38 * sin(vWorldPos.x * 2.6 + uTime * 2.1) * sin(vWorldPos.z * 2.4 - uTime * 1.7);
  foam = clamp(foam * fw * (0.85 + 0.15 * tide), 0.0, 1.0);
  col = mix(col, vec3(0.94, 0.98, 1.0), foam);

  float alpha = mix(0.52, 0.86, df);
  alpha = max(alpha, foam * 0.9);
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
 * Build the water surface for a chunk; returns null when the chunk is dry.
 * Vertices carry aDepth = water depth over the terrain (negative on land).
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
  const surfaceY = WATER_LEVEL - 0.15;

  const depths = new Float32Array(G * G);
  let anyWet = false;
  for (let iz = 0; iz < G; iz++) {
    for (let ix = 0; ix < G; ix++) {
      const d = surfaceY - terrain.heightCont(ox + ix, oz + iz);
      depths[iz * G + ix] = d;
      if (d > -0.25) anyWet = true;
    }
  }
  if (!anyWet) return null;

  const positions = new Float32Array(G * G * 3);
  for (let iz = 0; iz < G; iz++) {
    for (let ix = 0; ix < G; ix++) {
      const i = iz * G + ix;
      positions[i * 3] = ix;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = iz;
    }
  }

  const idx: number[] = [];
  for (let iz = 0; iz < CHUNK_SIZE; iz++) {
    for (let ix = 0; ix < CHUNK_SIZE; ix++) {
      const a = iz * G + ix;
      const b = a + 1;
      const c = a + G;
      const d = c + 1;
      const m = Math.max(depths[a], depths[b], depths[c], depths[d]);
      if (m <= -0.25) continue;
      idx.push(a, c, d, a, d, b);
    }
  }
  if (idx.length === 0) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aDepth', new THREE.BufferAttribute(depths, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(ox, surfaceY, oz);
  mesh.renderOrder = 2;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
