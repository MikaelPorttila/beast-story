import * as THREE from "three";

const MAX = 64;
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _euler = new THREE.Euler();

/** Voxel dust puffs: dead particles collapse to scale 0, so no visibility bookkeeping. */
export class DustSystem {
  readonly mesh: THREE.InstancedMesh;
  private px = new Float32Array(MAX);
  private py = new Float32Array(MAX);
  private pz = new Float32Array(MAX);
  private vx = new Float32Array(MAX);
  private vy = new Float32Array(MAX);
  private vz = new Float32Array(MAX);
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private size = new Float32Array(MAX);
  private spin = new Float32Array(MAX);
  private cursor = 0;
  private emitAcc = 0;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xd8c49c, roughness: 1, metalness: 0 });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    _mat4.makeScale(0, 0, 0);
    for (let i = 0; i < MAX; i++) {
      this.mesh.setMatrixAt(i, _mat4);
    }
    scene.add(this.mesh);
  }

  private spawn(x: number, y: number, z: number, spread: number, up: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX;
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * spread;
    this.px[i] = x + Math.cos(a) * r;
    this.py[i] = y + Math.random() * 0.1;
    this.pz[i] = z + Math.sin(a) * r;
    this.vx[i] = Math.cos(a) * (0.5 + Math.random() * 1.2);
    this.vy[i] = up * (0.6 + Math.random() * 0.8);
    this.vz[i] = Math.sin(a) * (0.5 + Math.random() * 1.2);
    this.maxLife[i] = this.life[i] = 0.35 + Math.random() * 0.35;
    this.size[i] = 0.08 + Math.random() * 0.1;
    this.spin[i] = (Math.random() - 0.5) * 8;
  }

  burst(pos: THREE.Vector3, count: number): void {
    for (let i = 0; i < count; i++) {
      this.spawn(pos.x, pos.y, pos.z, 0.3, 1);
    }
  }

  /** rate = particles per second. */
  emit(pos: THREE.Vector3, rate: number, dt: number): void {
    this.emitAcc += rate * dt;
    while (this.emitAcc >= 1) {
      this.emitAcc -= 1;
      this.spawn(pos.x, pos.y, pos.z, 0.18, 0.7);
    }
  }

  update(dt: number, time: number): void {
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) {
        continue;
      }
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        _mat4.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _mat4);
        continue;
      }
      this.vx[i] *= 1 - 2.5 * dt;
      this.vz[i] *= 1 - 2.5 * dt;
      this.vy[i] += 0.4 * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;

      const k = this.life[i] / this.maxLife[i]; // 1 -> 0
      const s = this.size[i] * (k > 0.75 ? (1 - k) * 4 : k / 0.75);
      _pos.set(this.px[i], this.py[i], this.pz[i]);
      _euler.set(0, this.spin[i] * (time + i), this.spin[i] * 0.35 * time);
      _quat.setFromEuler(_euler);
      _scale.set(s, s, s);
      _mat4.compose(_pos, _quat, _scale);
      this.mesh.setMatrixAt(i, _mat4);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
