import * as THREE from 'three';

/**
 * Central VFX manager: one additive GPU point cloud for all particles, an
 * instanced cube field for voxel debris, plus small pools of rings, beams,
 * slash arcs, scorch decals, glow sprites and point lights. Everything is
 * procedural (canvas textures only) and allocation-free per frame.
 */

const _v = new THREE.Vector3();
const _c = new THREE.Color();
// Endpoints for the warm-up beam; module temps like the rest, even though the
// warm-up runs once, so nothing here allocates.
const _warmA = new THREE.Vector3();
const _warmB = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function easeOutCubic(t: number): number { return 1 - Math.pow(1 - t, 3); }

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeGlowTexture(): THREE.CanvasTexture {
  return canvasTexture(64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.16)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  });
}

function makeScorchTexture(): THREE.CanvasTexture {
  return canvasTexture(128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,0.92)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 16 + Math.random() * 44;
      const x = 64 + Math.cos(a) * r, y = 64 + Math.sin(a) * r;
      const rad = 3 + Math.random() * 9;
      const gg = ctx.createRadialGradient(x, y, 0, x, y, rad);
      gg.addColorStop(0, 'rgba(255,255,255,0.5)');
      gg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gg;
      ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
    }
  });
}

// ---------------------------------------------------------------------------
// GPU particle cloud
// ---------------------------------------------------------------------------
const P_CAP = 3072;

class Particles {
  readonly points: THREE.Points;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private sizeAttr: THREE.BufferAttribute;
  private pos = new Float32Array(P_CAP * 3);
  private col = new Float32Array(P_CAP * 3);
  private size = new Float32Array(P_CAP);
  private vel = new Float32Array(P_CAP * 3);
  private life = new Float32Array(P_CAP);
  private maxLife = new Float32Array(P_CAP);
  private s0 = new Float32Array(P_CAP);
  private s1 = new Float32Array(P_CAP);
  private baseCol = new Float32Array(P_CAP * 3);
  private grav = new Float32Array(P_CAP);
  private drag = new Float32Array(P_CAP);
  private swirl = new Float32Array(P_CAP * 3); // cx, cz, angular speed
  alive = 0;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.colAttr = new THREE.BufferAttribute(this.col, 3);
    this.sizeAttr = new THREE.BufferAttribute(this.size, 1);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aColor', this.colAttr);
    geo.setAttribute('aSize', this.sizeAttr);
    geo.setDrawRange(0, 0);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute vec3 aColor;
        attribute float aSize;
        varying vec3 vColor;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (520.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          float a = smoothstep(0.5, 0.06, d);
          gl_FragColor = vec4(vColor, a);
        }`,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
    scene.add(this.points);
  }

  spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, s0: number, s1: number,
    r: number, g: number, b: number,
    grav: number, drag: number,
    swirlSpeed = 0, swirlCX = 0, swirlCZ = 0,
  ): void {
    if (this.alive >= P_CAP) return;
    const i = this.alive++;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.s0[i] = s0; this.s1[i] = s1;
    this.baseCol[i3] = r; this.baseCol[i3 + 1] = g; this.baseCol[i3 + 2] = b;
    this.grav[i] = grav; this.drag[i] = drag;
    this.swirl[i3] = swirlCX; this.swirl[i3 + 1] = swirlCZ; this.swirl[i3 + 2] = swirlSpeed;
  }

  private swapRemove(i: number): void {
    const j = --this.alive;
    if (i !== j) {
      const i3 = i * 3, j3 = j * 3;
      for (let k = 0; k < 3; k++) {
        this.pos[i3 + k] = this.pos[j3 + k];
        this.vel[i3 + k] = this.vel[j3 + k];
        this.baseCol[i3 + k] = this.baseCol[j3 + k];
        this.swirl[i3 + k] = this.swirl[j3 + k];
      }
      this.life[i] = this.life[j]; this.maxLife[i] = this.maxLife[j];
      this.s0[i] = this.s0[j]; this.s1[i] = this.s1[j];
      this.grav[i] = this.grav[j]; this.drag[i] = this.drag[j];
    }
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.alive) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.swapRemove(i); continue; }
      const i3 = i * 3;
      this.vel[i3 + 1] += this.grav[i] * dt;
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3] *= dr; this.vel[i3 + 1] *= dr; this.vel[i3 + 2] *= dr;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const sw = this.swirl[i3 + 2];
      if (sw !== 0) {
        const cx = this.swirl[i3], cz = this.swirl[i3 + 1];
        const ox = this.pos[i3] - cx, oz = this.pos[i3 + 2] - cz;
        const a = sw * dt, ca = Math.cos(a), sa = Math.sin(a);
        this.pos[i3] = cx + ox * ca - oz * sa;
        this.pos[i3 + 2] = cz + ox * sa + oz * ca;
      }
      const t = this.life[i] / this.maxLife[i];
      const fade = t * t;
      this.col[i3] = this.baseCol[i3] * fade;
      this.col[i3 + 1] = this.baseCol[i3 + 1] * fade;
      this.col[i3 + 2] = this.baseCol[i3 + 2] * fade;
      this.size[i] = this.s1[i] + (this.s0[i] - this.s1[i]) * t;
      i++;
    }
    (this.points.geometry as THREE.BufferGeometry).setDrawRange(0, this.alive);
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Instanced voxel debris (death bursts)
// ---------------------------------------------------------------------------
const D_CAP = 320;

class Debris {
  readonly mesh: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private pos = new Float32Array(D_CAP * 3);
  private vel = new Float32Array(D_CAP * 3);
  private rot = new Float32Array(D_CAP * 3);
  private angV = new Float32Array(D_CAP * 3);
  private life = new Float32Array(D_CAP);
  private maxLife = new Float32Array(D_CAP);
  private size = new Float32Array(D_CAP);
  private floorY = new Float32Array(D_CAP);
  private alive = 0;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 });
    this.mesh = new THREE.InstancedMesh(geo, mat, D_CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    _c.setHex(0xffffff);
    for (let i = 0; i < D_CAP; i++) this.mesh.setColorAt(i, _c);
    scene.add(this.mesh);
  }

  spawn(x: number, y: number, z: number, hex: number, speed: number, size: number, floorY: number): void {
    if (this.alive >= D_CAP) return;
    const i = this.alive++;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    const a = Math.random() * Math.PI * 2;
    const up = 0.35 + Math.random() * 0.85;
    const h = (0.3 + Math.random() * 0.7) * speed;
    this.vel[i3] = Math.cos(a) * h;
    this.vel[i3 + 1] = up * speed;
    this.vel[i3 + 2] = Math.sin(a) * h;
    this.rot[i3] = Math.random() * Math.PI; this.rot[i3 + 1] = Math.random() * Math.PI; this.rot[i3 + 2] = Math.random() * Math.PI;
    this.angV[i3] = (Math.random() - 0.5) * 14;
    this.angV[i3 + 1] = (Math.random() - 0.5) * 14;
    this.angV[i3 + 2] = (Math.random() - 0.5) * 14;
    this.life[i] = 0.8 + Math.random() * 0.8;
    this.maxLife[i] = this.life[i];
    this.size[i] = size * (0.7 + Math.random() * 0.7);
    this.floorY[i] = floorY;
    _c.setHex(hex);
    this.mesh.setColorAt(i, _c);
  }

  private swapRemove(i: number): void {
    const j = --this.alive;
    if (i !== j) {
      const i3 = i * 3, j3 = j * 3;
      for (let k = 0; k < 3; k++) {
        this.pos[i3 + k] = this.pos[j3 + k];
        this.vel[i3 + k] = this.vel[j3 + k];
        this.rot[i3 + k] = this.rot[j3 + k];
        this.angV[i3 + k] = this.angV[j3 + k];
      }
      this.life[i] = this.life[j]; this.maxLife[i] = this.maxLife[j];
      this.size[i] = this.size[j]; this.floorY[i] = this.floorY[j];
      const colors = this.mesh.instanceColor;
      if (colors) {
        const arr = colors.array as Float32Array;
        arr[i3] = arr[j3]; arr[i3 + 1] = arr[j3 + 1]; arr[i3 + 2] = arr[j3 + 2];
      }
    }
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.alive) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.swapRemove(i); continue; }
      const i3 = i * 3;
      this.vel[i3 + 1] -= 20 * dt;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const half = this.size[i] * 0.5;
      if (this.pos[i3 + 1] < this.floorY[i] + half) {
        this.pos[i3 + 1] = this.floorY[i] + half;
        this.vel[i3 + 1] *= -0.38;
        this.vel[i3] *= 0.6; this.vel[i3 + 2] *= 0.6;
        this.angV[i3] *= 0.6; this.angV[i3 + 1] *= 0.6; this.angV[i3 + 2] *= 0.6;
      }
      this.rot[i3] += this.angV[i3] * dt;
      this.rot[i3 + 1] += this.angV[i3 + 1] * dt;
      this.rot[i3 + 2] += this.angV[i3 + 2] * dt;
      const t = this.life[i] / this.maxLife[i];
      const s = this.size[i] * (t < 0.3 ? t / 0.3 : 1);
      this.dummy.position.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]);
      this.dummy.rotation.set(this.rot[i3], this.rot[i3 + 1], this.rot[i3 + 2]);
      this.dummy.scale.setScalar(Math.max(0.001, s));
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      i++;
    }
    this.mesh.count = this.alive;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Small pooled effect records
// ---------------------------------------------------------------------------
interface LightSlot { light: THREE.PointLight; mode: 0 | 1 | 2; life: number; maxLife: number; peak: number; }
interface GlowSlot { sprite: THREE.Sprite; mat: THREE.SpriteMaterial; mode: 0 | 1 | 2; life: number; maxLife: number; s0: number; }
interface RingSlot { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number; maxLife: number; maxR: number; }
interface BeamSlot { group: THREE.Group; core: THREE.Mesh; halo: THREE.Mesh; coreMat: THREE.MeshBasicMaterial; haloMat: THREE.MeshBasicMaterial; life: number; maxLife: number; }
interface SlashSlot { root: THREE.Group; spin: THREE.Group; oMat: THREE.MeshBasicMaterial; iMat: THREE.MeshBasicMaterial; life: number; maxLife: number; }
interface ScorchSlot { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number; maxLife: number; }

export class VFX {
  readonly glowTexture: THREE.CanvasTexture;
  private scorchTexture: THREE.CanvasTexture;
  private particles: Particles;
  private debrisField: Debris;
  private lights: LightSlot[] = [];
  private glows: GlowSlot[] = [];
  private rings: RingSlot[] = [];
  private beams: BeamSlot[] = [];
  private slashes: SlashSlot[] = [];
  private scorches: ScorchSlot[] = [];
  private ringGeo: THREE.RingGeometry;
  private beamGeo: THREE.CylinderGeometry;
  private slashOuterGeo: THREE.RingGeometry;
  private slashInnerGeo: THREE.RingGeometry;
  private scorchGeo: THREE.CircleGeometry;
  private flashEl: HTMLDivElement;
  private flashOpacity = 0;

  constructor(private scene: THREE.Scene) {
    this.glowTexture = makeGlowTexture();
    this.scorchTexture = makeScorchTexture();
    this.particles = new Particles(scene);
    this.debrisField = new Debris(scene);

    this.ringGeo = new THREE.RingGeometry(0.84, 1.0, 48);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.beamGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    this.beamGeo.translate(0, 0.5, 0);
    this.slashOuterGeo = new THREE.RingGeometry(0.62, 1.05, 28, 1, Math.PI / 2 - 1.0, 2.0);
    this.slashOuterGeo.rotateX(Math.PI / 2);
    this.slashInnerGeo = new THREE.RingGeometry(0.72, 0.95, 28, 1, Math.PI / 2 - 0.82, 1.64);
    this.slashInnerGeo.rotateX(Math.PI / 2);
    this.scorchGeo = new THREE.CircleGeometry(1, 22);
    this.scorchGeo.rotateX(-Math.PI / 2);

    this.flashEl = document.createElement('div');
    const st = this.flashEl.style;
    st.position = 'fixed';
    st.inset = '0';
    st.pointerEvents = 'none';
    st.opacity = '0';
    st.zIndex = '40';
    st.mixBlendMode = 'screen';
    document.body.appendChild(this.flashEl);
  }

  // ---------------------------------------------------- particle emitters

  /** Radial explosion burst. */
  burst(x: number, y: number, z: number, hex: number, count: number, speed: number, life: number, size: number, gravity = -5, upBias = 0.5): void {
    _c.setHex(hex);
    for (let i = 0; i < count; i++) {
      let dx = Math.random() * 2 - 1, dy = Math.random() * 2 - 1, dz = Math.random() * 2 - 1;
      const len = Math.max(0.001, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const v = speed * (0.35 + Math.random() * 0.65);
      dx = dx / len * v; dy = dy / len * v + upBias * speed * 0.5; dz = dz / len * v;
      const m = 0.7 + Math.random() * 0.6;
      this.particles.spawn(
        x, y, z, dx, dy, dz,
        life * (0.55 + Math.random() * 0.75), size * (0.7 + Math.random() * 0.6), size * 0.12,
        Math.min(1, _c.r * m), Math.min(1, _c.g * m), Math.min(1, _c.b * m),
        gravity, 1.7,
      );
    }
  }

  /** Rising (optionally swirling) column from a disc — heals, AoE pillars. */
  rise(x: number, y: number, z: number, hex: number, count: number, radius: number, vy: number, life: number, size: number, swirlSpeed = 0): void {
    _c.setHex(hex);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = radius * Math.sqrt(Math.random());
      const m = 0.75 + Math.random() * 0.5;
      this.particles.spawn(
        x + Math.cos(a) * rr, y + Math.random() * 0.4, z + Math.sin(a) * rr,
        0, vy * (0.6 + Math.random() * 0.8), 0,
        life * (0.6 + Math.random() * 0.8), size * (0.7 + Math.random() * 0.6), size * 0.2,
        Math.min(1, _c.r * m), Math.min(1, _c.g * m), Math.min(1, _c.b * m),
        1.2, 0.4, swirlSpeed, x, z,
      );
    }
  }

  /** Single tiny fading mote (projectile trails). */
  trail(x: number, y: number, z: number, hex: number, size: number): void {
    _c.setHex(hex);
    const m = 0.8 + Math.random() * 0.4;
    this.particles.spawn(
      x + (Math.random() - 0.5) * 0.12, y + (Math.random() - 0.5) * 0.12, z + (Math.random() - 0.5) * 0.12,
      (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6 + 0.3, (Math.random() - 0.5) * 0.6,
      0.28 + Math.random() * 0.18, size, 0.02,
      Math.min(1, _c.r * m), Math.min(1, _c.g * m), Math.min(1, _c.b * m),
      0, 2.2,
    );
  }

  /** Low outward dust poof at ground level. */
  dust(x: number, y: number, z: number, count: number, hex = 0xcdb894): void {
    _c.setHex(hex);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 0.8 + Math.random() * 1.4;
      const m = 0.55 + Math.random() * 0.4;
      this.particles.spawn(
        x + Math.cos(a) * 0.2, y + Math.random() * 0.15, z + Math.sin(a) * 0.2,
        Math.cos(a) * v, 0.7 + Math.random() * 1.1, Math.sin(a) * v,
        0.4 + Math.random() * 0.3, 0.24, 0.05,
        _c.r * m, _c.g * m, _c.b * m,
        -3.5, 2.6,
      );
    }
  }

  // ------------------------------------------------------------- lights

  private lightSlot(): LightSlot | null {
    for (const s of this.lights) if (s.mode === 0) return s;
    if (this.lights.length < 10) {
      const light = new THREE.PointLight(0xffffff, 0, 12, 2);
      light.visible = false;
      this.scene.add(light);
      const slot: LightSlot = { light, mode: 0, life: 0, maxLife: 1, peak: 0 };
      this.lights.push(slot);
      return slot;
    }
    return null;
  }

  acquireLight(hex: number, intensity: number, distance: number): THREE.PointLight | null {
    const s = this.lightSlot();
    if (!s) return null;
    s.mode = 1;
    s.light.color.setHex(hex);
    s.light.intensity = intensity;
    s.light.distance = distance;
    s.light.visible = true;
    return s.light;
  }

  releaseLight(light: THREE.PointLight): void {
    for (const s of this.lights) {
      if (s.light === light) { s.mode = 0; s.light.visible = false; return; }
    }
  }

  flashLight(x: number, y: number, z: number, hex: number, intensity: number, distance: number, life: number): void {
    const s = this.lightSlot();
    if (!s) return;
    s.mode = 2;
    s.life = life; s.maxLife = life; s.peak = intensity;
    s.light.color.setHex(hex);
    s.light.intensity = intensity;
    s.light.distance = distance;
    s.light.position.set(x, y, z);
    s.light.visible = true;
  }

  // -------------------------------------------------------- glow sprites

  private glowSlot(): GlowSlot | null {
    for (const s of this.glows) if (s.mode === 0) return s;
    if (this.glows.length < 28) {
      const mat = new THREE.SpriteMaterial({
        map: this.glowTexture, blending: THREE.AdditiveBlending,
        transparent: true, depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 19;
      this.scene.add(sprite);
      const slot: GlowSlot = { sprite, mat, mode: 0, life: 0, maxLife: 1, s0: 1 };
      this.glows.push(slot);
      return slot;
    }
    return null;
  }

  acquireGlow(hex: number, scale: number): THREE.Sprite | null {
    const s = this.glowSlot();
    if (!s) return null;
    s.mode = 1;
    s.mat.color.setHex(hex);
    s.mat.opacity = 1;
    s.sprite.scale.setScalar(scale);
    s.sprite.visible = true;
    return s.sprite;
  }

  releaseGlow(sprite: THREE.Sprite): void {
    for (const s of this.glows) {
      if (s.sprite === sprite) { s.mode = 0; s.sprite.visible = false; return; }
    }
  }

  glowPulse(x: number, y: number, z: number, hex: number, scale: number, life: number): void {
    const s = this.glowSlot();
    if (!s) return;
    s.mode = 2;
    s.life = life; s.maxLife = life; s.s0 = scale;
    s.mat.color.setHex(hex);
    s.mat.opacity = 1;
    s.sprite.position.set(x, y, z);
    s.sprite.scale.setScalar(scale);
    s.sprite.visible = true;
  }

  // ------------------------------------------------------ rings / beams

  ring(x: number, y: number, z: number, hex: number, maxRadius: number, life: number): void {
    let slot: RingSlot | null = null;
    for (const s of this.rings) if (s.life <= 0) { slot = s; break; }
    if (!slot && this.rings.length < 14) {
      const mat = new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
        side: THREE.DoubleSide, toneMapped: false,
      });
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 18;
      this.scene.add(mesh);
      slot = { mesh, mat, life: 0, maxLife: 1, maxR: 1 };
      this.rings.push(slot);
    }
    if (!slot) return;
    slot.life = life; slot.maxLife = life; slot.maxR = maxRadius;
    slot.mat.color.setHex(hex);
    slot.mesh.position.set(x, y + 0.05, z);
    slot.mesh.scale.set(0.01, 1, 0.01);
    slot.mesh.visible = true;
  }

  beam(from: THREE.Vector3, to: THREE.Vector3, hex: number): void {
    let slot: BeamSlot | null = null;
    for (const s of this.beams) if (s.life <= 0) { slot = s; break; }
    if (!slot && this.beams.length < 6) {
      const coreMat = new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false,
      });
      const haloMat = new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false,
        side: THREE.DoubleSide,
      });
      const group = new THREE.Group();
      const core = new THREE.Mesh(this.beamGeo, coreMat);
      const halo = new THREE.Mesh(this.beamGeo, haloMat);
      group.add(core); group.add(halo);
      group.visible = false;
      core.renderOrder = 21; halo.renderOrder = 20;
      this.scene.add(group);
      slot = { group, core, halo, coreMat, haloMat, life: 0, maxLife: 1 };
      this.beams.push(slot);
    }
    if (!slot) return;
    const len = _v.copy(to).sub(from).length();
    _v.normalize();
    slot.life = 0.18; slot.maxLife = 0.18;
    slot.group.position.copy(from);
    slot.group.quaternion.setFromUnitVectors(Y_AXIS, _v);
    slot.core.scale.set(0.07, len, 0.07);
    slot.halo.scale.set(0.26, len, 0.26);
    _c.setHex(hex);
    slot.coreMat.color.setRGB(
      Math.min(1, _c.r * 0.4 + 0.75), Math.min(1, _c.g * 0.4 + 0.75), Math.min(1, _c.b * 0.4 + 0.75));
    slot.haloMat.color.setHex(hex);
    slot.coreMat.opacity = 1; slot.haloMat.opacity = 0.75;
    slot.group.visible = true;
  }

  slash(x: number, y: number, z: number, dirX: number, dirZ: number, hex: number, scale = 1.6): void {
    let slot: SlashSlot | null = null;
    for (const s of this.slashes) if (s.life <= 0) { slot = s; break; }
    if (!slot && this.slashes.length < 8) {
      const oMat = new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
        side: THREE.DoubleSide, toneMapped: false,
      });
      const iMat = new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
        side: THREE.DoubleSide, toneMapped: false, color: 0xffffff,
      });
      const root = new THREE.Group();
      const spin = new THREE.Group();
      const outer = new THREE.Mesh(this.slashOuterGeo, oMat);
      const inner = new THREE.Mesh(this.slashInnerGeo, iMat);
      outer.renderOrder = 21; inner.renderOrder = 22;
      spin.add(outer); spin.add(inner);
      root.add(spin);
      root.visible = false;
      this.scene.add(root);
      slot = { root, spin, oMat, iMat, life: 0, maxLife: 1 };
      this.slashes.push(slot);
    }
    if (!slot) return;
    slot.life = 0.2; slot.maxLife = 0.2;
    slot.root.position.set(x, y, z);
    slot.root.rotation.set(-0.3, Math.atan2(dirX, dirZ), (Math.random() - 0.5) * 0.8);
    slot.root.scale.setScalar(scale);
    slot.oMat.color.setHex(hex);
    slot.oMat.opacity = 0; slot.iMat.opacity = 0;
    slot.spin.rotation.y = 1.1;
    slot.root.visible = true;
  }

  scorch(x: number, y: number, z: number, hex: number, radius: number): void {
    let slot: ScorchSlot | null = null;
    for (const s of this.scorches) if (s.life <= 0) { slot = s; break; }
    if (!slot && this.scorches.length < 16) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.scorchTexture, transparent: true, depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.scorchGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 2;
      this.scene.add(mesh);
      slot = { mesh, mat, life: 0, maxLife: 1 };
      this.scorches.push(slot);
    }
    if (!slot) return;
    slot.life = 7; slot.maxLife = 7;
    _c.setHex(hex);
    slot.mat.color.setRGB(_c.r * 0.16 + 0.03, _c.g * 0.16 + 0.03, _c.b * 0.16 + 0.03);
    slot.mat.opacity = 0.85;
    slot.mesh.position.set(x, y + 0.03, z);
    slot.mesh.rotation.y = Math.random() * Math.PI * 2;
    slot.mesh.scale.set(radius, 1, radius);
    slot.mesh.visible = true;
  }

  // ---------------------------------------------------------- debris etc

  debrisBurst(x: number, y: number, z: number, palette: readonly number[], count: number, speed: number, size: number, floorY: number): void {
    for (let i = 0; i < count; i++) {
      const hex = palette[(Math.random() * palette.length) | 0];
      this.debrisField.spawn(
        x + (Math.random() - 0.5) * 0.4,
        y + (Math.random() - 0.5) * 0.4,
        z + (Math.random() - 0.5) * 0.4,
        hex, speed, size, floorY,
      );
    }
  }

  screenFlash(hex: number, strength: number): void {
    _c.setHex(hex);
    this.flashEl.style.backgroundColor =
      `rgb(${Math.round(_c.r * 255)},${Math.round(_c.g * 255)},${Math.round(_c.b * 255)})`;
    this.flashOpacity = Math.max(this.flashOpacity, strength);
  }

  // ----------------------------------------------------------- warm-up

  /**
   * Shader warm-up: put one of every effect on screen so its program is linked
   * and takes its first draw NOW, at boot, instead of the first time a pal
   * casts. Measured, that first cast linked 14 programs and the GPU process
   * then stalled a frame for ~500 ms. See warmUpShaders() in main.ts.
   */
  warmUp(x: number, y: number, z: number): void {
    const hex = 0xffffff;
    this.burst(x, y, z, hex, 6, 2, 0.3, 0.2);
    this.rise(x, y, z, hex, 6, 0.5, 1, 0.3, 0.2, 1);
    this.trail(x, y, z, hex, 0.2);
    this.dust(x, y, z, 6);
    this.debrisBurst(x, y, z, [hex], 6, 2, 0.2, y);
    this.glowPulse(x, y, z, hex, 1, 0.3);
    this.ring(x, y, z, hex, 1.5, 0.3);
    _warmA.set(x, y, z);
    _warmB.set(x + 2, y + 1, z);
    this.beam(_warmA, _warmB, hex);
    this.slash(x, y, z, 1, 0, hex);
    this.scorch(x, y, z, hex, 1);
  }

  /**
   * Make `n` more pool lights visible.
   *
   * This is the half that matters most and is the least obvious: three keys a
   * program on the NUMBER OF LIGHTS in the scene, so every lit material gets a
   * fresh program the first time one light is up, another the first time two
   * are up, and so on. A firefight lighting three projectiles at once therefore
   * recompiles the world at three separate moments. Warming the whole range
   * costs one render per step at boot and buys all of them.
   */
  warmUpLights(x: number, y: number, z: number, n: number): void {
    for (let i = 0; i < n; i++) this.flashLight(x, y, z, 0xffffff, 0.001, 4, 0.02);
  }

  // -------------------------------------------------------------- update

  update(dt: number): void {
    this.particles.update(dt);
    this.debrisField.update(dt);

    for (const s of this.lights) {
      if (s.mode !== 2) continue;
      s.life -= dt;
      if (s.life <= 0) { s.mode = 0; s.light.visible = false; continue; }
      const t = s.life / s.maxLife;
      s.light.intensity = s.peak * t * t;
    }

    for (const s of this.glows) {
      if (s.mode !== 2) continue;
      s.life -= dt;
      if (s.life <= 0) { s.mode = 0; s.sprite.visible = false; continue; }
      const t = s.life / s.maxLife;
      s.mat.opacity = t * 0.95;
      s.sprite.scale.setScalar(s.s0 * (1 + 0.7 * (1 - t)));
    }

    for (const s of this.rings) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) { s.mesh.visible = false; continue; }
      const p = 1 - s.life / s.maxLife;
      const r = Math.max(0.01, s.maxR * easeOutCubic(p));
      s.mesh.scale.set(r, 1, r);
      s.mat.opacity = Math.pow(1 - p, 1.5) * 0.95;
    }

    for (const s of this.beams) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) { s.group.visible = false; continue; }
      const t = s.life / s.maxLife;
      const w = 0.5 + t * 0.5;
      s.core.scale.x = 0.07 * w; s.core.scale.z = 0.07 * w;
      s.halo.scale.x = 0.26 * w; s.halo.scale.z = 0.26 * w;
      s.coreMat.opacity = t;
      s.haloMat.opacity = 0.75 * t;
    }

    for (const s of this.slashes) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) { s.root.visible = false; continue; }
      const p = 1 - s.life / s.maxLife;
      s.spin.rotation.y = 1.1 - 2.2 * easeOutCubic(p);
      const o = Math.sin(p * Math.PI);
      s.oMat.opacity = o * 0.9;
      s.iMat.opacity = o;
    }

    for (const s of this.scorches) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) { s.mesh.visible = false; continue; }
      const t = s.life / s.maxLife;
      s.mat.opacity = 0.85 * Math.min(1, t * 1.7);
    }

    if (this.flashOpacity > 0.004) {
      this.flashOpacity *= Math.exp(-7 * dt);
      this.flashEl.style.opacity = this.flashOpacity.toFixed(3);
    } else if (this.flashOpacity !== 0) {
      this.flashOpacity = 0;
      this.flashEl.style.opacity = '0';
    }
  }
}
