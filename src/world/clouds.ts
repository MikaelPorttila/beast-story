/**
 * Sky ambience: drifting chunky voxel clouds (they cast soft traveling
 * shadows) and a field of gently floating light motes near the ground.
 */
import * as THREE from 'three';
import { VoxelModel } from '../core/voxel';
import { mulberry32 } from './noise';

const CLOUD_WRAP = 190;

function cloudGeo(variant: number, seed: number, thin = false): THREE.BufferGeometry {
  const v = new VoxelModel();
  const rng = mulberry32((seed ^ 0xc10d) + variant * 977 + (thin ? 40503 : 0));
  // Fat voxel puffs: 2-3 stacked, offset ellipsoid lobes per cloud.
  // Every lobe's length:width is clamped to <= 1.8:1 so nothing reads as a
  // contrail slab from any viewing angle. `thin` builds the high cirrus deck:
  // same silhouette language, flattened and single-tiered.
  const lobes = thin ? 2 : 2 + (variant % 2);
  const baseR = (thin ? 6.5 : 5.5) + rng() * 3;
  for (let b = 0; b < lobes; b++) {
    const rx = baseR * (0.72 + rng() * 0.5);
    const rz = Math.max(rx / 1.8, rx * (0.62 + rng() * 0.38));
    const ry = thin ? 1.1 + rng() * 0.6 : 2.4 + rng() * 1.3;
    const cx = (rng() - 0.5) * baseR * 1.3;
    const cz = (rng() - 0.5) * baseR * 0.9;
    const cy = ry * 0.7 + b * (ry * (thin ? 0.6 : 0.85)) + rng() * 0.7;
    v.ellipsoid(cx, cy, cz, rx, ry, rz, 0xffffff);
  }
  // Shadowed underside: a cool blue-grey belly, not flat white. Without it
  // the puffs have no form read against the sky at all.
  v.ellipsoid(0, thin ? 0.5 : 0.9, 0, baseR * 1.1, thin ? 0.7 : 1.2, baseR * 0.8, 0xc3d2e0);
  const mesh = v.build(0.75, true);
  const g = mesh.geometry;
  (mesh.material as THREE.Material).dispose();
  return g;
}

const HIGH_WRAP = CLOUD_WRAP * 1.7;

export class Clouds {
  readonly group = new THREE.Group();
  private readonly items: Array<{ mesh: THREE.Mesh; vx: number; vz: number; wrap: number }> = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mat: THREE.MeshStandardMaterial;
  private readonly matHigh: THREE.MeshStandardMaterial;

  constructor(seed: number) {
    this.mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      // Near-white self-glow keeps clouds bright without the old gray cast.
      emissive: 0xf7fafc,
      emissiveIntensity: 0.5,
      fog: true, // distance haze fades the deck into the sky
    });
    // High deck: same look, translucent so it layers over the low deck and
    // gives the sky depth instead of one lonely band of puffs.
    this.matHigh = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      emissive: 0xf7fafc,
      emissiveIntensity: 0.55,
      fog: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    for (let i = 0; i < 3; i++) this.geos.push(cloudGeo(i, seed));
    for (let i = 0; i < 2; i++) this.geos.push(cloudGeo(i, seed, true));
    const rng = mulberry32(seed ^ 0x5eed);

    // Low deck: tripled from 28 -> 84 so the sky is populated at every bearing.
    for (let i = 0; i < 84; i++) {
      const mesh = new THREE.Mesh(this.geos[i % 3], this.mat);
      mesh.position.set(
        (rng() - 0.5) * 2 * CLOUD_WRAP,
        70 + rng() * 25,
        (rng() - 0.5) * 2 * CLOUD_WRAP,
      );
      // Full random yaw jitter so no two clouds ever align into an X, and
      // near-uniform scale (y boosted 1.2-1.6x) so puffs stay fat, never slabby.
      mesh.rotation.y = rng() * Math.PI * 2;
      const s = 0.9 + rng() * 1.6;
      mesh.scale.set(s, s * (1.2 + rng() * 0.4), s);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      this.group.add(mesh);
      this.items.push({ mesh, vx: 1.4 + rng() * 1.2, vz: 0.35 + rng() * 0.55, wrap: CLOUD_WRAP });
    }

    // High deck at y~150, 2.5x scale, drifting slower for parallax. No shadow
    // casting — it would double the shadow-map cost for no visible gain.
    for (let i = 0; i < 20; i++) {
      const mesh = new THREE.Mesh(this.geos[3 + (i % 2)], this.matHigh);
      mesh.position.set(
        (rng() - 0.5) * 2 * HIGH_WRAP,
        144 + rng() * 16,
        (rng() - 0.5) * 2 * HIGH_WRAP,
      );
      mesh.rotation.y = rng() * Math.PI * 2;
      const s = 2.5 * (0.85 + rng() * 0.4);
      mesh.scale.set(s, s * 0.55, s);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.group.add(mesh);
      this.items.push({ mesh, vx: 0.5 + rng() * 0.5, vz: 0.12 + rng() * 0.22, wrap: HIGH_WRAP });
    }
  }

  update(focus: THREE.Vector3, dt: number): void {
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const w = it.wrap;
      const p = it.mesh.position;
      p.x += it.vx * dt;
      p.z += it.vz * dt;
      if (p.x - focus.x > w) p.x -= w * 2;
      else if (p.x - focus.x < -w) p.x += w * 2;
      if (p.z - focus.z > w) p.z -= w * 2;
      else if (p.z - focus.z < -w) p.z += w * 2;
    }
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    this.mat.dispose();
    this.matHigh.dispose();
  }
}

// ---------------------------------------------------------------------------
// Floating light motes
// ---------------------------------------------------------------------------

const MOTE_VERT = /* glsl */ `
uniform float uTime;
attribute float aPhase;
attribute float aSize;
varying float vA;
void main() {
  vec3 p = position;
  p.x += sin(uTime * 0.35 + aPhase) * 1.6;
  p.y += sin(uTime * 0.5 + aPhase * 1.7) * 0.9;
  p.z += cos(uTime * 0.28 + aPhase * 0.6) * 1.6;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = aSize * (90.0 / max(1.0, -mv.z));
  // Fully faded beyond 20 units so motes never read as lens dirt at range.
  vA = (0.55 + 0.45 * sin(uTime * 1.4 + aPhase * 2.3)) * smoothstep(20.0, 8.0, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const MOTE_FRAG = /* glsl */ `
varying float vA;
void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  float a = smoothstep(0.5, 0.08, d) * vA * 0.14;
  gl_FragColor = vec4(1.0, 0.86, 0.55, a); // warm gold only
}
`;

const tmpFocus = new THREE.Vector3();

export class Motes {
  readonly points: THREE.Points;
  private readonly mat: THREE.ShaderMaterial;
  private readonly geo: THREE.BufferGeometry;

  constructor(seed: number) {
    const rng = mulberry32(seed ^ 0x307e5);
    const N = 90;
    const pos = new Float32Array(N * 3);
    const phase = new Float32Array(N);
    const size = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      // Tight, low field: motes hug the ground (max y ~2.4 incl. bob).
      pos[i * 3] = (rng() - 0.5) * 44;
      pos[i * 3 + 1] = 0.4 + rng() * 1.1;
      pos[i * 3 + 2] = (rng() - 0.5) * 44;
      phase[i] = rng() * Math.PI * 2;
      size[i] = 3 + rng() * 5;
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
  }

  update(focus: THREE.Vector3, time: number, dt: number): void {
    this.mat.uniforms['uTime'].value = time;
    tmpFocus.set(focus.x, focus.y - 2, focus.z);
    const k = 1 - Math.exp(-dt * 1.5);
    this.points.position.lerp(tmpFocus, k);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
