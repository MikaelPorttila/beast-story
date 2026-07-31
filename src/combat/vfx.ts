import * as THREE from 'three';

/**
 * Central VFX manager: one additive GPU point cloud for all particles, an
 * instanced cube field for voxel debris, plus small pools of rings, beams,
 * slash arcs, scorch decals, glow sprites and point lights. Everything is
 * procedural (canvas textures only) and allocation-free per frame.
 */

const _v = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _hsl = { h: 0, s: 0, l: 0 };
// Endpoints for the warm-up beam; module temps like the rest, even though the
// warm-up runs once, so nothing here allocates.
const _warmA = new THREE.Vector3();
const _warmB = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function easeOutCubic(t: number): number { return 1 - Math.pow(1 - t, 3); }
function easeOutQuint(t: number): number { return 1 - Math.pow(1 - t, 5); }

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

/**
 * Sweep-trail mask for the melee arc. White RGB — the whole shape lives in the
 * alpha channel — with `u` running along the arc and `v` across the ribbon.
 *
 * The cross-section is deliberately ASYMMETRIC: a thin hard core at v=0.60 with
 * a wide soft wake behind it. The arc used to be two untextured RingGeometry
 * segments, which gave a uniform band with a hard cut at both radii — captured,
 * that read as a flat white croissant with no direction to it (see
 * shots/_vfx-b-slash.png). A blade edge dragging a wake reads as a swing.
 *
 * The fibrous `streak` term keeps the wake from being a clean gaussian gradient;
 * without it the ribbon looks like an airbrushed neon tube.
 */
function makeSwipeTexture(): THREE.CanvasTexture {
  const W = 128, H = 64;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1);
    const core = Math.exp(-Math.pow((v - 0.60) / 0.105, 2));
    const wake = Math.exp(-Math.pow((v - 0.50) / 0.30, 2)) * 0.52;
    const streak = 0.70 + 0.30 * (0.5 + 0.5 * Math.sin(v * 43 + Math.sin(v * 11.7) * 2.3));
    const across = Math.min(1, core + wake * streak);
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      // Zero at both tips so the ribbon comes to a point, weighted bright
      // toward the LEADING tip (u=1) — the end of the blade, not the hilt.
      const along = Math.pow(Math.sin(Math.PI * u), 0.55) * (0.46 + 0.54 * u);
      const i = (y * W + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = Math.round(255 * Math.min(1, along * across));
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Flowing ribbon mask for the beam blades. `u` runs ACROSS the ribbon, `v`
 * along it, and the whole shape is in the alpha channel.
 *
 * Captured (shots/_vfx2-beam-0.08.png) the beam was a `CylinderGeometry` with a
 * flat untextured colour: a uniform orange drainpipe with a hard silhouette and
 * a visible open end where the far cap should be. Nothing about it read as
 * energy. Two things fix that: a soft gaussian across the ribbon so the edge
 * feathers out instead of ending in a line, and a periodic striation along it
 * that we SCROLL, so the discharge visibly flows toward the target.
 *
 * `v` is periodic (both sine terms complete whole cycles over 0..1) so the
 * texture tiles seamlessly under RepeatWrapping — the scroll never seams.
 */
function makeBeamTexture(): THREE.CanvasTexture {
  const W = 64, H = 128;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    const v = y / H;
    const flow =
      0.66 + 0.34 * (0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 3 + Math.sin(v * Math.PI * 2) * 1.5));
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      const core = Math.exp(-Math.pow((u - 0.5) / 0.15, 2));
      const soft = Math.exp(-Math.pow((u - 0.5) / 0.40, 2)) * 0.45;
      const i = (y * W + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = Math.round(255 * Math.min(1, (core + soft) * flow));
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * Shockwave ring mask. The ring used to be an untextured `RingGeometry(0.84, 1)`
 * annulus at uniform alpha — captured over an AoE (shots/_vfx2-aoe-0.35.png)
 * that is a hard-edged flat hoop lying on the grass, closer to a selection decal
 * than to a blast front. Feathering the crest and adding a faint interior wash
 * gives the wave a body and a leading edge.
 *
 * three's RingGeometry lays UVs over the OUTER-radius bounding box, so uv is
 * radial about (0.5, 0.5) with the outer rim at uv-radius 0.5. The crest sits at
 * 0.88 of the outer radius, matching the old annulus's centre line.
 */
function makeRingTexture(): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const d = img.data;
  const half = S / 2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5 - half) / half, dy = (y + 0.5 - half) / half;
      const r = Math.sqrt(dx * dx + dy * dy);
      let a = 0;
      if (r <= 1) {
        // Asymmetric crest: tight on the leading (outer) side, longer wash
        // trailing inward, so the wave has a direction.
        // First pass used 0.075/0.20 sigmas and a 0.13 fill: captured
        // (shots/_vfx2-B-aoe-0.35.png) the wave lost its edge entirely and read
        // as a fuzzy orange puddle — worse than the hard hoop it replaced.
        // Halving the sigmas and the fill keeps the feathering but puts a
        // definite line back at the front.
        const s = r > 0.88 ? 0.040 : 0.115;
        const crest = Math.exp(-Math.pow((r - 0.88) / s, 2));
        const fill = Math.max(0, 0.06 * (1 - r * 0.7));
        const spokes = 0.80 + 0.20 * Math.sin(Math.atan2(dy, dx) * 13);
        a = Math.min(1, (crest * spokes + fill) * Math.min(1, (1 - r) * 22));
      }
      const i = (y * S + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = Math.round(255 * a);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * `blades` flat ribbons evenly rotated about +Y, each running from y=0 to y=1
 * with a tapered half-width. UVs: `u` across the ribbon, `v` along it.
 *
 * A tube cannot both flare and come to a point; three crossed ribbons can, and
 * they feather at the silhouette because their edges are texture alpha rather
 * than geometry. The thin core cylinder is kept alongside precisely because
 * these blades collapse when viewed straight down the beam axis.
 *
 * The profile flares from the muzzle to 72% of the length, then falls to almost
 * nothing, so the far end tapers off instead of stopping at the flat open cap
 * that was visible in shots/_vfx2-beam-0.08.png.
 */
function makeBeamRibbonGeo(blades = 3, segs = 10): THREE.BufferGeometry {
  const n = segs + 1;
  const pos = new Float32Array(blades * n * 2 * 3);
  const uv = new Float32Array(blades * n * 2 * 2);
  const idx: number[] = [];
  let k = 0, j = 0;
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI;
    const ax = Math.cos(a), az = Math.sin(a);
    const base = b * n * 2;
    for (let i = 0; i < n; i++) {
      const v = i / segs;
      const w = v < 0.72
        ? 0.55 + 0.45 * Math.sin((v / 0.72) * Math.PI * 0.5)
        : 1.0 * Math.pow(1 - (v - 0.72) / 0.28, 0.75) + 0.04;
      pos[k] = -ax * w; pos[k + 1] = v; pos[k + 2] = -az * w;
      pos[k + 3] = ax * w; pos[k + 4] = v; pos[k + 5] = az * w;
      k += 6;
      uv[j] = 0; uv[j + 1] = v; uv[j + 2] = 1; uv[j + 3] = v;
      j += 4;
      if (i < segs) {
        const q = base + i * 2;
        idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/**
 * A crescent ribbon in the XY plane — a partial ring around the +Z axis, with
 * its centre at 12 o'clock. `span` radians of arc at `radius`, whose half-width
 * tapers to zero at both tips and peaks at `peakAt`. UVs feed makeSwipeTexture().
 *
 * The PLANE is the load-bearing decision. The original arc lay in the XZ plane,
 * i.e. a plane containing the caster's forward axis — and the game's camera sits
 * behind the caster looking down that same axis, so the ribbon was always close
 * to edge-on. Tilting it about forward does not help; captured that way
 * (shots/_vfx-a4-3.53.png) the swing rendered as a straight diagonal streak with
 * no arc in it at all. Building the ring PERPENDICULAR to forward puts the whole
 * crescent broadside to the lens, and sweeping it is then a roll about that same
 * forward axis — which is also what a real swing does.
 *
 * `peakAt` under 0.5 puts the fat part of the crescent EARLY, so the arc looks
 * like it is being dragged rather than pushed.
 */
function makeSweepGeo(span: number, radius: number, halfWidth: number, peakAt: number, segs = 30): THREE.BufferGeometry {
  const n = segs + 1;
  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = i / segs;
    const s = u < peakAt ? (0.5 * u) / peakAt : 0.5 + (0.5 * (u - peakAt)) / (1 - peakAt);
    const taper = Math.pow(Math.sin(Math.PI * s), 0.62);
    const a = (u - 0.5) * span;
    const w = halfWidth * taper;
    const r0 = radius - w, r1 = radius + w;
    const sa = Math.sin(a), ca = Math.cos(a);
    const k = i * 6;
    pos[k] = sa * r0; pos[k + 1] = ca * r0; pos[k + 2] = 0;
    pos[k + 3] = sa * r1; pos[k + 4] = ca * r1; pos[k + 5] = 0;
    const j = i * 4;
    uv[j] = u; uv[j + 1] = 0; uv[j + 2] = u; uv[j + 3] = 1;
    if (i < segs) {
      const b = i * 2;
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
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
interface BeamSlot { group: THREE.Group; core: THREE.Mesh; halo: THREE.Mesh; coreMat: THREE.MeshBasicMaterial; haloMat: THREE.MeshBasicMaterial; life: number; maxLife: number; len: number; }
interface SlashSlot {
  root: THREE.Group; plane: THREE.Group; spin: THREE.Group;
  oMat: THREE.MeshBasicMaterial; iMat: THREE.MeshBasicMaterial;
  life: number; maxLife: number; dir: number; baseScale: number;
}
interface ScorchSlot { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number; maxLife: number; }

// --- melee arc tuning -------------------------------------------------------
// Measured against shots/_vfx-b-slash*.png (the old flat crescent):
//   LIFE 0.20 -> 0.23 with an INSTANT attack. The old opacity curve was
//     sin(p*PI), which peaks at half-life and is invisible on the frame the
//     swing actually lands — the hit had no on-frame confirmation at all.
//   TILT 0 -> 0.78 rad. The arc used to lie flat in the XZ plane, so from the
//     third-person camera it read as a decal on the ground rather than a swing.
//     Tilting the sweep plane about the forward axis makes it a diagonal
//     shoulder-to-hip cut, and alternating the sign per swing turns a repeated
//     button press into a visible combo.
//   The sweep is now a ROLL about the caster's forward axis (see makeSweepGeo),
//     so FROM/TO are where the crescent's centre starts and ends measured off
//     vertical. 1.20 -> -0.50 is 97 degrees of travel that carries the blade
//     down across the target and stops just past centre; TILT biases the whole
//     swing to one shoulder, and both flip sign per swing so a held attack reads
//     as alternating cuts rather than the same stamp twice.
//   PITCH leans the ring away from a camera that sits above and behind, so the
//     ring reads as an ellipse rather than a flat circle.
//   ROUND 2, measured off shots/_vfx2-mb-0.04.png / -0.10.png (the arc shot
//     from behind the caster, which is the gameplay angle): the sweep was
//     easeOutQuint over the first HALF of a 0.23 s life, so it reached 88% of
//     its travel by t=0.04 — under three frames at 60 fps, and identical in
//     every later frame. Two captures 60 ms apart were pixel-for-pixel the same
//     crescent in the same place: a stamp, not a swing. SWEEP_WINDOW 0.5 -> 0.66
//     and easeOutQuint -> easeOutCubic spread the same travel over ~5 frames at
//     60 fps and ~13 at 164, which is where the motion becomes readable; LIFE
//     0.23 -> 0.30 keeps the wake hanging afterwards, which is the part that
//     sells speed.
//   The travel itself widened from 97 to 124 degrees (FROM 1.20 -> 1.45,
//     TO -0.50 -> -0.72) so the blade enters above the shoulder and exits below
//     the hip rather than starting already halfway down.
const SLASH_LIFE = 0.30;
const SLASH_SWEEP_WINDOW = 0.66;
const SLASH_TILT = 0.40;
const SLASH_PITCH = -0.30;
// -0.55 put the ring low enough that the crescent swept THROUGH the hero's own
// body (shots/_vfx-g8-sw10.png: a white blowout with the hero inside it).
// -0.32 leaves it at chest-to-shoulder height, crossing the target, not the
// caster.
const SLASH_DROP = -0.32;
// The callers' scales (1.6 for the sword, 1.9 for a pal's melee skill) were
// authored against a flat ground crescent whose apparent size collapsed with the
// camera pitch. A ring facing the lens keeps its full size, so the same numbers
// read about 20% too large; scaling here rather than asking every caller to
// retune keeps `scale` meaning what it meant.
const SLASH_SCALE = 0.85;
const SLASH_SWEEP_FROM = 1.45;
const SLASH_SWEEP_TO = -0.72;

// --- projectile trail stitching ---------------------------------------------
// Combat emits one trail() every 0.022 s and a bolt flies at 16 u/s, so the
// call sites are 0.35 units apart in world space no matter what this file does
// — and at low frame rates the catch-up `while` loop fires two calls at the
// SAME position, which clumps instead of spacing. Captured
// (shots/_vfx2-b-dart-0.42.png) the trail was a visible string of separate
// beads with grass showing between them.
//
// So VFX remembers where each emitter was last seen and fills the gap: a call
// that lands within CONTINUE_DIST of a recent same-coloured emitter draws motes
// along the SEGMENT at a fixed world-space spacing. Density then depends on the
// bolt's speed alone, and is identical at 30 fps and 165 fps.
const TRAIL_EMITTERS = 8;
const TRAIL_SPACING = 0.13;
const TRAIL_MAX_STEPS = 8;
const TRAIL_CONTINUE_DIST = 1.6;
const TRAIL_EMITTER_TTL = 0.2;

export class VFX {
  readonly glowTexture: THREE.CanvasTexture;
  private scorchTexture: THREE.CanvasTexture;
  private swipeTexture: THREE.CanvasTexture;
  private beamTexture: THREE.CanvasTexture;
  private ringTexture: THREE.CanvasTexture;
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
  private beamRibbonGeo: THREE.BufferGeometry;
  private slashOuterGeo: THREE.BufferGeometry;
  private slashInnerGeo: THREE.BufferGeometry;
  private scorchGeo: THREE.CircleGeometry;
  private flashEl: HTMLDivElement;
  private flashOpacity = 0;
  /** Flips every swing so a combo alternates its sweep direction. */
  private slashFlip = 1;
  /** x, y, z of the last trail() call per emitter — see TRAIL_EMITTERS. */
  private trailPos = new Float32Array(TRAIL_EMITTERS * 3);
  private trailHex = new Int32Array(TRAIL_EMITTERS).fill(-1);
  private trailAge = new Float32Array(TRAIL_EMITTERS).fill(1e9);

  constructor(private scene: THREE.Scene) {
    this.glowTexture = makeGlowTexture();
    this.scorchTexture = makeScorchTexture();
    this.swipeTexture = makeSwipeTexture();
    this.beamTexture = makeBeamTexture();
    this.ringTexture = makeRingTexture();
    this.particles = new Particles(scene);
    this.debrisField = new Debris(scene);

    // 0.84 -> 0.40 inner radius: the crest now lives in the texture, and the
    // geometry only has to be wide enough to carry the feathered falloff and
    // the faint interior wash. 48 -> 64 segments because a 2-unit-radius ring
    // showed visible facets on its outer edge in shots/_vfx2-aoe-0.35.png.
    this.ringGeo = new THREE.RingGeometry(0.40, 1.0, 64);
    this.ringGeo.rotateX(-Math.PI / 2);
    // Core tapers 1.0 -> 0.28 toward the target so the far end narrows to a
    // point instead of showing the open cylinder mouth.
    this.beamGeo = new THREE.CylinderGeometry(0.28, 1.0, 1, 8, 1, true);
    this.beamGeo.translate(0, 0.5, 0);
    this.beamRibbonGeo = makeBeamRibbonGeo(3, 10);
    // Outer wake is wide and spans most of the swing; the core is a shorter,
    // much narrower blade edge riding inside it. Both come to points.
    this.slashOuterGeo = makeSweepGeo(1.95, 0.72, 0.40, 0.38, 30);
    this.slashInnerGeo = makeSweepGeo(1.62, 0.74, 0.12, 0.34, 24);
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

  /**
   * Radial explosion burst — TWO populations from one call.
   *
   * The old version was a single uniform cloud: every particle drew from the
   * same speed range with drag 1.7, so it decelerated together and the whole
   * thing read as one soft puff (captured at shots/_vfx-b-dart-hit.png — a hit
   * looked like a small orange smudge, with no evidence anything was struck).
   *
   * Splitting it costs nothing and buys the silhouette an explosion needs:
   *   SPARKS (40%) leave at ~2.2x speed with very little drag and heavy gravity,
   *     so they punch out past the flame front and arc down as discrete streaks;
   *     they run hot toward white because sparks are hotter than the fireball.
   *   FLAME (60%) is the old cloud with more drag (2.4), so it stalls close to
   *     the impact point and reads as the body of the blast rather than smearing
   *     into the sparks.
   */
  burst(x: number, y: number, z: number, hex: number, count: number, speed: number, life: number, size: number, gravity = -5, upBias = 0.5): void {
    _c.setHex(hex);
    const sparks = Math.max(2, Math.round(count * 0.4));
    for (let i = 0; i < count; i++) {
      const isSpark = i < sparks;
      let dx = Math.random() * 2 - 1, dy = Math.random() * 2 - 1, dz = Math.random() * 2 - 1;
      const len = Math.max(0.001, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const v = speed * (isSpark ? 1.5 + Math.random() * 1.4 : 0.28 + Math.random() * 0.6);
      dx = dx / len * v; dy = dy / len * v + upBias * speed * 0.5; dz = dz / len * v;
      // ROUND 2: every spark used to take the same +0.18 white lift, and with a
      // fire orange of linear (1.00, 0.14, 0.03) that lands at (1.00, 0.35,
      // 0.21) — which after ACES is a pale pink dot. Zoomed into a real impact
      // (shots/_vfx2-crop-impact.png) the whole spark population read as white
      // specks with no element in them; you could not tell fire from ice.
      // Only a THIRD of the sparks are white-hot now (the glints), the rest
      // keep the element hue at full saturation, and the fireball body keeps
      // its own hue as before.
      const white = isSpark && i % 3 === 0;
      const m = isSpark ? 1.25 + Math.random() * 0.35 : 0.62 + Math.random() * 0.55;
      const w = white ? 0.30 : 0;
      this.particles.spawn(
        x, y, z, dx, dy, dz,
        life * (isSpark ? 0.8 + Math.random() * 0.7 : 0.55 + Math.random() * 0.75),
        size * (isSpark ? 0.42 + Math.random() * 0.28 : 0.85 + Math.random() * 0.7),
        size * (isSpark ? 0.02 : 0.14),
        Math.min(1, _c.r * m + w), Math.min(1, _c.g * m + w), Math.min(1, _c.b * m + w),
        isSpark ? gravity * 2.1 : gravity, isSpark ? 0.45 : 2.4,
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

  /**
   * One step of a projectile trail: a hot core mote plus a dim smoke mote.
   *
   * Trail coherence was the worst thing about the projectiles. The caller emits
   * one of these every 0.022 s and a bolt moves at 16 u/s, i.e. one mote every
   * 0.35 units — and the old single mote was spawned with +-0.12 of position
   * jitter and +-0.6 of random velocity, which pushed neighbouring motes apart
   * faster than the gap between them. Captured (shots/_vfx-b-dart-fly.png) the
   * result was a dotted line of separate beads, not a streak.
   *
   * Two changes fix it without touching the emission rate, which combat owns:
   *   - the CORE mote gets almost no jitter (0.05) and no lateral velocity, and
   *     starts 1.5x wider than it was, so consecutive motes OVERLAP into a
   *     continuous line;
   *   - a second, much dimmer and wider mote with a slow upward drift gives the
   *     streak volume and a little smoke behind the head.
   * Two spawns per call, ~30 alive per bolt at 16 u/s — 1% of the 3072 cap.
   */
  trail(x: number, y: number, z: number, hex: number, size: number): void {
    _c.setHex(hex);
    // Core colour is DERIVED, not lifted. The old core was `channel * ~1.3 +
    // 0.16` on every channel, which is fine for a saturated fire orange and
    // catastrophic for a pale element: frostwing's ice (0x9fdcf0) came out of
    // that formula at (1, 1, 1) and the whole bolt rendered as a plain white
    // streak with no ice in it (shots/_vfx2-D-ice.png). Rebuilding the colour
    // in HSL with a saturation FLOOR and a fixed high lightness keeps every
    // element's hue at the same brightness, so a bolt is identifiable from its
    // trail alone — which is the whole point of an element colour.
    _c.getHSL(_hsl, THREE.SRGBColorSpace);
    _c2.setHSL(_hsl.h, Math.max(0.62, _hsl.s), 0.70, THREE.SRGBColorSpace);

    // --- find (or claim) the emitter this call continues -------------------
    let slot = -1, best = TRAIL_CONTINUE_DIST * TRAIL_CONTINUE_DIST, free = -1;
    for (let i = 0; i < TRAIL_EMITTERS; i++) {
      if (this.trailAge[i] > TRAIL_EMITTER_TTL) { if (free < 0) free = i; continue; }
      if (this.trailHex[i] !== hex) continue;
      const i3 = i * 3;
      const dx = x - this.trailPos[i3], dy = y - this.trailPos[i3 + 1], dz = z - this.trailPos[i3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) { best = d2; slot = i; }
    }
    let steps = 1, ax = x, ay = y, az = z;
    if (slot >= 0) {
      const s3 = slot * 3;
      ax = this.trailPos[s3]; ay = this.trailPos[s3 + 1]; az = this.trailPos[s3 + 2];
      steps = Math.min(TRAIL_MAX_STEPS, Math.max(1, Math.ceil(Math.sqrt(best) / TRAIL_SPACING)));
    } else if (free >= 0) {
      slot = free;
    }
    if (slot >= 0) {
      const s3 = slot * 3;
      this.trailPos[s3] = x; this.trailPos[s3 + 1] = y; this.trailPos[s3 + 2] = z;
      this.trailHex[slot] = hex;
      this.trailAge[slot] = 0;
    }

    // --- core motes, stitched along the segment ----------------------------
    // One mote every TRAIL_SPACING world units, laid down from where the bolt
    // WAS to where it IS. size*1.9 (was 2.4) because the motes now overlap by
    // construction and no longer have to be fat enough to bridge a 0.35-unit
    // gap on their own — a thinner, denser line reads as a streak, a fatter one
    // as a sausage.
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const px = ax + (x - ax) * f, py = ay + (y - ay) * f, pz = az + (z - az) * f;
      // 1.5x on a lightness-0.70 colour puts the brightest channel just over 1
      // and the others proportionally below it: hot, blooming, still hued.
      const m = 1.35 + Math.random() * 0.3;
      this.particles.spawn(
        px + (Math.random() - 0.5) * 0.04, py + (Math.random() - 0.5) * 0.04, pz + (Math.random() - 0.5) * 0.04,
        0, 0.12, 0,
        0.15 + Math.random() * 0.06, size * 1.9, 0.02,
        _c2.r * m, _c2.g * m, _c2.b * m,
        0, 3.4,
      );
    }

    // One smoke mote per CALL, not per step — the wake wants volume behind the
    // head, not a second solid line.
    const s = 0.42 + Math.random() * 0.24;
    this.particles.spawn(
      x + (Math.random() - 0.5) * 0.16, y + (Math.random() - 0.5) * 0.16, z + (Math.random() - 0.5) * 0.16,
      (Math.random() - 0.5) * 0.35, (Math.random() - 0.5) * 0.25 + 0.55, (Math.random() - 0.5) * 0.35,
      0.4 + Math.random() * 0.22, size * 2.2, size * 0.5,
      _c.r * s, _c.g * s, _c.b * s,
      0.5, 1.9,
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
        map: this.ringTexture,
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

  /**
   * Beam discharge: a thin tapered core down the axis, three feathered ribbons
   * of flowing energy around it, a muzzle flare, and sparks shed along the ray.
   *
   * The old version was one `CylinderGeometry` drawn twice at two widths with a
   * flat colour and no map. Captured (shots/_vfx2-beam-0.08.png) that is an
   * orange drainpipe: constant width from muzzle to target, a hard silhouette
   * on both flanks, and the open far end reading as a cut-off tube. Nothing in
   * it moved except a width scale, so a 0.3 s discharge looked like a static
   * prop that blinked on.
   */
  beam(from: THREE.Vector3, to: THREE.Vector3, hex: number): void {
    let slot: BeamSlot | null = null;
    for (const s of this.beams) if (s.life <= 0) { slot = s; break; }
    if (!slot && this.beams.length < 6) {
      const coreMat = new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false,
      });
      // Shares its program with the slash ribbons: map + additive + transparent
      // + DoubleSide + toneMapped:false is the same permutation, and warmUp()
      // draws a beam and a slash at boot either way.
      const haloMat = new THREE.MeshBasicMaterial({
        map: this.beamTexture,
        blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false,
        side: THREE.DoubleSide,
      });
      const group = new THREE.Group();
      const core = new THREE.Mesh(this.beamGeo, coreMat);
      const halo = new THREE.Mesh(this.beamRibbonGeo, haloMat);
      core.frustumCulled = false; halo.frustumCulled = false;
      group.add(core); group.add(halo);
      group.visible = false;
      core.renderOrder = 21; halo.renderOrder = 20;
      this.scene.add(group);
      slot = { group, core, halo, coreMat, haloMat, life: 0, maxLife: 1, len: 1 };
      this.beams.push(slot);
    }
    if (!slot) return;
    const len = _v.copy(to).sub(from).length();
    _v.normalize();
    // 0.18 s was under three frames of visible beam at 60 fps for a skill
    // described as a "roaring ribbon" — you could miss it entirely between two
    // screenshots. 0.3 s reads as a discharge and still never overlaps its own
    // cooldown. 0.3 -> 0.42 in round 2: the flow scroll needs long enough to
    // travel a couple of striation periods or the motion never registers.
    slot.life = 0.42; slot.maxLife = 0.42;
    slot.group.position.copy(from);
    slot.group.quaternion.setFromUnitVectors(Y_AXIS, _v);
    slot.len = len;
    slot.core.scale.set(0.05, 0.001, 0.05);
    slot.halo.scale.set(0.30, 0.001, 0.30);
    // Repeat the striation once every ~2.2 world units of beam so a long shot
    // gets more flow detail than a short one instead of stretching four bands
    // over 18 units.
    this.beamTexture.repeat.y = Math.max(1, Math.round(len / 2.2));
    _c.setHex(hex);
    slot.coreMat.color.setRGB(
      Math.min(1, _c.r * 0.4 + 0.75), Math.min(1, _c.g * 0.4 + 0.75), Math.min(1, _c.b * 0.4 + 0.75));
    // 1.55x on the halo: it is texture-masked now, so most of its area is under
    // half alpha and the old flat 0.75 opacity left the ribbon dimmer than the
    // untextured tube it replaced.
    slot.haloMat.color.copy(_c).multiplyScalar(1.55);
    slot.coreMat.opacity = 1; slot.haloMat.opacity = 0.9;
    slot.group.visible = true;

    // Muzzle flare — a beam that simply exists between two points has no source.
    this.glowPulse(from.x, from.y, from.z, hex, 1.5, 0.24);
    // Sparks shed along the ray. Emitted with a strong OUTWARD component so
    // they leave the beam rather than riding inside it, where they would be
    // invisible against the core.
    // Orthonormal basis about the ray: u = normalize(d x Y), w = d x u.
    let ux = _v.z, uz = -_v.x;
    const rl = Math.hypot(ux, uz);
    if (rl < 1e-4) { ux = 1; uz = 0; } else { ux /= rl; uz /= rl; }
    const wx = _v.y * uz * -1, wy = _v.z * ux - _v.x * uz, wz = _v.y * ux;
    const n = Math.min(22, 6 + Math.round(len * 1.4));
    for (let i = 0; i < n; i++) {
      const f = 0.06 + Math.random() * 0.92;
      const a = Math.random() * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const ox = ux * ca + wx * sa, oy = wy * sa, oz = uz * ca + wz * sa;
      const sp = 1.4 + Math.random() * 3.2;
      this.particles.spawn(
        from.x + _v.x * len * f + ox * 0.16,
        from.y + _v.y * len * f + oy * 0.16,
        from.z + _v.z * len * f + oz * 0.16,
        ox * sp + _v.x * 2.5, oy * sp + _v.y * 2.5 + 0.6, oz * sp + _v.z * 2.5,
        0.16 + Math.random() * 0.24, 0.13, 0.01,
        Math.min(1, _c.r * 1.3 + 0.3), Math.min(1, _c.g * 1.3 + 0.3), Math.min(1, _c.b * 1.3 + 0.3),
        -3.5, 2.2,
      );
    }
  }

  /**
   * Melee sweep: a tilted crescent that snaps through its arc in the first half
   * of its life, plus a handful of sparks flung off the blade edge.
   *
   * The colour is derived rather than used raw. Callers pass an ELEMENT colour
   * (or 0xdfe9ff for the hero's sword), and the old code put that on the outer
   * ring and pure white on the inner one, both additive at full opacity — every
   * captured swing clipped to a flat 255 with no hue left in it. Here the hue is
   * kept, saturation is floored at 0.55 so even a near-white input yields a
   * coloured fringe, and only the thin core is allowed near white.
   */
  slash(x: number, y: number, z: number, dirX: number, dirZ: number, hex: number, scale = 1.6): void {
    let slot: SlashSlot | null = null;
    for (const s of this.slashes) if (s.life <= 0) { slot = s; break; }
    if (!slot && this.slashes.length < 8) {
      const oMat = new THREE.MeshBasicMaterial({
        map: this.swipeTexture,
        blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
        side: THREE.DoubleSide, toneMapped: false,
      });
      const iMat = new THREE.MeshBasicMaterial({
        map: this.swipeTexture,
        blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
        side: THREE.DoubleSide, toneMapped: false, color: 0xffffff,
      });
      const root = new THREE.Group();
      // root yaws to face the swing; `plane` tilts the sweep plane about that
      // forward axis; `spin` carries the arc around inside the tilted plane.
      const plane = new THREE.Group();
      const spin = new THREE.Group();
      const outer = new THREE.Mesh(this.slashOuterGeo, oMat);
      const inner = new THREE.Mesh(this.slashInnerGeo, iMat);
      outer.renderOrder = 21; inner.renderOrder = 22;
      outer.frustumCulled = false; inner.frustumCulled = false;
      spin.add(outer); spin.add(inner);
      plane.add(spin);
      root.add(plane);
      root.visible = false;
      this.scene.add(root);
      slot = { root, plane, spin, oMat, iMat, life: 0, maxLife: 1, dir: 1, baseScale: 1 };
      this.slashes.push(slot);
    }
    if (!slot) return;
    const dir = (this.slashFlip = -this.slashFlip);
    scale *= SLASH_SCALE;
    slot.dir = dir;
    slot.baseScale = scale;
    slot.life = SLASH_LIFE; slot.maxLife = SLASH_LIFE;
    slot.root.position.set(x, y, z);
    slot.root.rotation.set(0, Math.atan2(dirX, dirZ), 0);
    slot.plane.rotation.x = SLASH_PITCH;
    // Drop the ring so the crescent rides at the caller's own height instead of
    // one ring-radius above it. Callers aim at the chest (the hero's sword uses
    // position.y + 1.25); without this the arc swept over the target's head —
    // see shots/_vfx-g7-sw12.png, where the blade is above the crosshair.
    slot.plane.position.y = SLASH_DROP;
    slot.spin.rotation.z = dir * (SLASH_TILT + SLASH_SWEEP_FROM);
    slot.root.scale.setScalar(scale);

    _c.setHex(hex);
    _c.getHSL(_hsl, THREE.SRGBColorSpace);
    const sat = Math.max(0.55, _hsl.s);
    // The gains matter as much as the hues. These materials write LINEAR
    // radiance that the output pass then tone-maps, so an sRGB lightness of
    // 0.54 lands at ~0.25 linear — captured in daylight (shots/_vfx-g3-sw01.png)
    // that was a barely visible smear against sunlit grass at ~0.35. 2.6x puts
    // the wake clearly above the ground it crosses; 3.2x on the thin core takes
    // it past 1.0, where it blooms and rolls off to white ONLY on the few pixels
    // of the blade edge instead of across the whole arc.
    slot.oMat.color.setHSL(_hsl.h, Math.min(1, sat * 1.05), 0.54, THREE.SRGBColorSpace)
      .multiplyScalar(1.35);
    // 0.87/2.0 -> 0.82/1.7: with the sweep now spread over five frames instead
    // of two, the core is on screen long enough that a full blowout to white
    // was throwing away the element hue for most of the swing.
    slot.iMat.color.setHSL(_hsl.h, sat * 0.40, 0.82, THREE.SRGBColorSpace)
      .multiplyScalar(1.7);
    slot.oMat.opacity = 0; slot.iMat.opacity = 0;
    slot.root.visible = true;

    // Sparks flung off the blade edge, laid out on the same ring the ribbon
    // rides. Without these the arc is a decal that passes through a body and
    // leaves nothing behind — this is the "it connected" cue, and it is the only
    // part of a melee hit that survives past the 0.23 s the ribbon lives.
    // `right` is the horizontal perpendicular to the strike; with world up it
    // spans the ring's plane.
    // ROUND 2: these were 10 sparks on a stratified `(i + rand)/10` sweep of the
    // arc, at one size, all moving radially outward at 2.6-5.8 u/s. Captured
    // (shots/_vfx2-mb-0.04.png) that is a string of evenly spaced identical
    // pearls sitting ON the arc — the layout is legible as a formula. Three
    // changes break it: `u` is fully random rather than stratified, the radius
    // spread widens to +-25% so they are not all on one circle, and most of the
    // speed is now TANGENTIAL (along the swing) rather than radial, so within
    // two frames they have smeared into a fan following the blade instead of
    // ringing it.
    const rx = dirZ, rz = -dirX;
    const roll = dir * (SLASH_TILT + 0.35);
    const rad = scale * 0.72;
    const cy = y + SLASH_DROP * scale;
    for (let i = 0; i < 22; i++) {
      const u = Math.random();
      const ang = roll + (u - 0.5) * 2.3 * dir;
      const sa = Math.sin(ang), ca = Math.cos(ang);
      const ox = rx * sa, oy = ca, oz = rz * sa;
      // Tangent to the ring at `ang`, in the swing's direction of travel.
      const tx = rx * ca * -dir, ty = sa * dir, tz = rz * ca * -dir;
      const rr = rad * (0.78 + Math.random() * 0.5);
      const vt = 5.0 + Math.random() * 6.5;
      const vr = 0.8 + Math.random() * 2.4;
      this.particles.spawn(
        x + ox * rr, cy + oy * rr, z + oz * rr,
        tx * vt + ox * vr, ty * vt + oy * vr * 0.5 + 0.7, tz * vt + oz * vr,
        // 0.045-0.115, not 0.07-0.18: at 6 units a point sprite of 0.12 draws a
        // ~10 px soft disc, and sixteen of those on one arc read as a string of
        // pearls (shots/_vfx2-B-mb-0.04.png). Halving the size and raising the
        // count to 22 turns the same energy into grit.
        0.13 + Math.random() * 0.24, 0.045 + Math.random() * 0.07, 0.01,
        Math.min(1, _c.r * 1.35 + 0.24), Math.min(1, _c.g * 1.35 + 0.24), Math.min(1, _c.b * 1.35 + 0.24),
        -11, 2.4,
      );
    }
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

  /**
   * Full-screen hit flash — a VIGNETTE, not a flat wash.
   *
   * This used to set a solid backgroundColor, so taking a hit painted an even
   * sheet of red over the whole frame: it hid the thing that just hit you, and a
   * uniform screen tint is the one screen effect that always reads as a bug
   * rather than as damage. A radial gradient that is clear through the middle
   * two thirds and ramps to full at the corners puts the same energy on screen
   * while leaving the fight visible.
   *
   * Called on damage and on AoE casts — a handful of times a second at worst, so
   * building the gradient string here is not on any per-frame path.
   */
  screenFlash(hex: number, strength: number): void {
    _c.setHex(hex);
    const rgb = `${Math.round(_c.r * 255)},${Math.round(_c.g * 255)},${Math.round(_c.b * 255)}`;
    this.flashEl.style.background =
      `radial-gradient(ellipse at center, rgba(${rgb},0) 34%, rgba(${rgb},0.45) 72%, rgba(${rgb},1) 100%)`;
    // 1.6x compensates for the vignette: the callers' strengths (0.14 for a hit,
    // 0.06 for an AoE cast) were chosen against a flat sheet, and the gradient
    // now clears the middle third entirely. Same peak alpha at the corners as
    // the old wash had everywhere, so the effect is no louder in total.
    this.flashOpacity = Math.max(this.flashOpacity, Math.min(0.85, strength * 1.6));
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
    for (let i = 0; i < TRAIL_EMITTERS; i++) {
      if (this.trailAge[i] <= TRAIL_EMITTER_TTL) this.trailAge[i] += dt;
    }
    // Flow scroll for every live beam. One shared texture, so all beams flow
    // together; negative so the striations run muzzle -> target.
    this.beamTexture.offset.y = (this.beamTexture.offset.y - dt * 2.6) % 1;

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
      const p = 1 - t;
      // A flash, not a fade. Opacity was linear in t and the sprite grew
      // linearly from its full size — the muzzle and impact pops read as slow
      // blooming clouds. t^1.6 dumps most of the brightness in the first three
      // frames; the scale now SNAPS from 0.6x to 1.45x on an ease-out, so the
      // pop expands instead of arriving already large.
      s.mat.opacity = t * t * Math.sqrt(t) * 0.98;
      s.sprite.scale.setScalar(s.s0 * (0.6 + 0.85 * easeOutCubic(p)));
    }

    for (const s of this.rings) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) { s.mesh.visible = false; continue; }
      const p = 1 - s.life / s.maxLife;
      // Quartic expansion (was cubic) so the leading edge outruns the fireball
      // for the first two frames, which is what makes it read as a shockwave;
      // the sharper opacity falloff (2.2, was 1.5) keeps it from lingering as a
      // decal after the blast is gone.
      const r = Math.max(0.01, s.maxR * (1 - Math.pow(1 - p, 4)));
      s.mesh.scale.set(r, 1, r);
      s.mat.opacity = Math.pow(1 - p, 2.2) * 1.15;
    }

    for (const s of this.beams) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) { s.group.visible = false; continue; }
      const t = s.life / s.maxLife;
      const p = 1 - t;
      // The discharge PUNCHES OUT: length ramps from nothing to full over the
      // first 13% of life (~55 ms). It used to appear at full length on frame
      // one, which is why it read as a static prop blinking on rather than as
      // something leaving the caster's mouth.
      const grow = easeOutQuint(Math.min(1, p / 0.13));
      s.core.scale.y = Math.max(0.001, s.len * grow);
      s.halo.scale.y = Math.max(0.001, s.len * grow);
      // Flicker on the halo only: a clean cylinder holding a constant width for
      // its whole life looks like a placeholder cylinder, which is what it was.
      const w = 0.42 + t * 0.58;
      const f = 0.86 + 0.14 * Math.sin(t * 71);
      s.core.scale.x = 0.05 * w; s.core.scale.z = 0.05 * w;
      s.halo.scale.x = 0.30 * w * f; s.halo.scale.z = 0.30 * w * f;
      s.coreMat.opacity = Math.min(1, t * 1.5);
      s.haloMat.opacity = 0.95 * t * t;
    }

    for (const s of this.slashes) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) { s.root.visible = false; continue; }
      const p = 1 - s.life / s.maxLife;
      // The blade covers its arc in the first two thirds; the rest of the life
      // is the wake hanging in the air, which is what makes the swing feel fast.
      // easeOutCubic, not Quint: quint put 88% of the travel in the first 40 ms,
      // so consecutive captured frames were the same crescent in the same place.
      const sw = easeOutCubic(Math.min(1, p / SLASH_SWEEP_WINDOW));
      s.spin.rotation.z = s.dir
        * (SLASH_TILT + SLASH_SWEEP_FROM + (SLASH_SWEEP_TO - SLASH_SWEEP_FROM) * sw);
      // `attack` reaches 1 within ~1.5 frames at 60 fps: full brightness on the
      // frame the hit lands, then a decay. The core outruns the wake (2.7 vs
      // 1.35) so what lingers is coloured, not white.
      const attack = Math.min(1, p * 11);
      s.oMat.opacity = attack * Math.pow(1 - p, 1.35) * 0.95;
      s.iMat.opacity = attack * Math.pow(1 - p, 2.7);
      s.root.scale.setScalar(s.baseScale * (1 + 0.17 * easeOutCubic(p)));
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

  /**
   * Release everything this manager put in the scene or on the GPU.
   *
   * Nothing calls this today — CombatSystem outlives its scene and REBINDS
   * across zones rather than rebuilding, precisely so the warmed shader programs
   * survive (see CombatSystem.setWorld). It exists so that the rule "everything
   * that adds to the scene has a matching dispose() path" is not quietly false
   * for the one module that adds the most.
   */
  dispose(): void {
    const drop = (o: THREE.Object3D, geo?: THREE.BufferGeometry, ...mats: THREE.Material[]): void => {
      this.scene.remove(o);
      geo?.dispose();
      for (const m of mats) m.dispose();
    };
    drop(this.particles.points, this.particles.points.geometry as THREE.BufferGeometry,
      this.particles.points.material as THREE.Material);
    drop(this.debrisField.mesh, this.debrisField.mesh.geometry as THREE.BufferGeometry,
      this.debrisField.mesh.material as THREE.Material);
    for (const s of this.lights) this.scene.remove(s.light);
    for (const s of this.glows) drop(s.sprite, undefined, s.mat);
    for (const s of this.rings) drop(s.mesh, undefined, s.mat);
    for (const s of this.beams) drop(s.group, undefined, s.coreMat, s.haloMat);
    for (const s of this.slashes) drop(s.root, undefined, s.oMat, s.iMat);
    for (const s of this.scorches) drop(s.mesh, undefined, s.mat);
    this.lights.length = 0; this.glows.length = 0; this.rings.length = 0;
    this.beams.length = 0; this.slashes.length = 0; this.scorches.length = 0;
    this.ringGeo.dispose();
    this.beamGeo.dispose();
    this.beamRibbonGeo.dispose();
    this.slashOuterGeo.dispose();
    this.slashInnerGeo.dispose();
    this.scorchGeo.dispose();
    this.glowTexture.dispose();
    this.scorchTexture.dispose();
    this.swipeTexture.dispose();
    this.beamTexture.dispose();
    this.ringTexture.dispose();
    this.flashEl.remove();
  }
}
