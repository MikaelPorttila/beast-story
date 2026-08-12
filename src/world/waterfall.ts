/**
 * WATERFALLS — a parameterised falling-water effect: a scrolling translucent sheet
 * plus a spray field, two draw calls, animated in the shader. Built in its OWNER's
 * frame, so one class serves a flying island's fall and a weir. Mask fields are
 * quantised to `TILE_U` (three voxel cells) so the fall sits on the lattice the
 * cubes do. BROWSER ONLY — the mask is a canvas, so tools/test-zfight.mjs must never
 * import it. Under `flags.photo` the clock pins and the spray pre-rolls.
 */
import * as THREE from "three";
import type { CelestialState } from "../core/types";
import { flags } from "../core/flags";
import { mulberry32 } from "./noise";

/** Everything a fall needs to be THIS fall. The frame is the OWNER'S: +Y up, anchor
 *  on the lip, `bearing` from +Z toward +X applied to the group, so local +Z is
 *  downstream, +X across, -Y down. */
export interface WaterfallSpec {
  /** How far it falls before it is FULLY INVISIBLE — a hard bound (issue #86). */
  length: number;
  /** Sideways offset ACROSS the bearing over the length; reaches the spray too (#86). */
  lateralPush: number;
  x: number;
  y: number;
  z: number;
  /** Which way the water is heading. Radians, from +Z toward +X. */
  bearing: number;

  /** Full widths at the lip / widest / dissolve. Defaults 7.2, 10.8, 6.0 (SPEC §6). */
  lipWidth?: number;
  spreadWidth?: number;
  tailWidth?: number;
  spreadAt?: number;
  outwardPush?: number;
  fadeStart?: number;
  /** Half-angle the outer sheets splay to: off-axis, a single sheet is a PALE WIRE. */
  cross?: number;
  sheets?: number;
  segments?: number;

  flow?: number;
  foam?: number;
  /** Water lit / body / shadowed. Defaults are the SPEC §6 teal. */
  bodyLit?: number;
  bodyDark?: number;
  bodyShadow?: number;
  /** Spray budget. Default 128; 0 draws no spray and allocates no pool. */
  spray?: number;
  /** What it lands in, or null to dissolve in open air. Non-null clamps the length. */
  basin?: { y: number; radius: number } | null;
  /** Let the owner's own motion drag the plume; only meaningful on a carrier. */
  swayFromCarrier?: boolean;
  seed?: number;
}

/** Tile size ACROSS the fall — THE VOXEL GAUGE: a fibre is 1.2 units, exactly CELL. */
const TILE_U = 3.6;

/** ...and ALONG it: at TILE_U the slow fields repeated 13 times down a 48-unit fall. */
const TILE_V = 12.0;

/** Mask resolution. 256 is two texels per centimetre of fibre at `TILE_U`. */
const MASK = 256;

/** Push accumulation with depth. The honest exponent is 1; super-linear reads BLOWN. */
const PUSH_EXP = 1.35;

/** ...and it BOWS, in HALF-PERIODS: 1 is a single arch at any length, 2 is an S. */
const WANDER_TURNS = 1.0;
const WANDER_A = 1.68;

function wander(v: number): number {
  return Math.sin(v * Math.PI * WANDER_TURNS) * WANDER_A;
}

/** V-curve: a constant scroll over a stretched V accelerates the water for nothing. */
const UV_EASE = 0.72;

/** Scroll rates in tiles per second for the two panner layers; irrational with the
 *  UV scales, so the layers never beat back into phase. */
const SCROLL_A = 0.9;
const SCROLL_B = 2.6;

/** Stylised gravity for the spray, units/s². Sets the plume's time of flight. */
const GRAV = 22;

/** Frozen clock under `photo=1`. Arbitrary — it only has to never change. */
const PHOTO_CLOCK = 9.0;

/** Seconds of spray pre-rolled on the first frozen frame: t = 0 freezes an EMPTY pool. */
const PHOTO_PREROLL = 4.0;

/** How hard the carrier lean is allowed to pull the tail, world units. */
const LEAN_MAX = 4.0;

const _col = new THREE.Color();

/** ONE 256² texture, three fields. Every term is PERIODIC IN BOTH AXES so it wraps. */
function makeFallMask(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = MASK;
  c.height = MASK;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(MASK, MASK);
  const d = img.data;
  const TAU = Math.PI * 2;
  for (let y = 0; y < MASK; y++) {
    const v = y / MASK;
    for (let x = 0; x < MASK; x++) {
      const u = x / MASK;

      // R — FLOW STRIATION: fast across u, slow along v, or it is directionless speckle.
      const fib =
        0.5 +
        0.5 * Math.sin(TAU * 3 * u + 1.1 * Math.sin(TAU * 1 * v) + 0.6 * Math.sin(TAU * 2 * v));
      const along = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(TAU * 2 * v + TAU * u));
      const r = (0.34 + 0.66 * fib) * along;

      // G — FOAM CLUMPS: oblique waves squared into blobs with real gaps.
      const cl =
        (Math.sin(TAU * (4 * u + 1 * v)) +
          Math.sin(TAU * (3 * u - 1 * v)) +
          Math.sin(TAU * (6 * u + 2 * v))) /
        3;
      const g = Math.pow(0.5 + 0.5 * cl, 2.2);

      // B — EROSION, the tail's dissolve threshold. Low frequency, or the tail noises.
      const b =
        0.5 +
        0.5 * (Math.sin(TAU * (1 * u + 1 * v)) * 0.62 + Math.sin(TAU * (2 * u - 1 * v)) * 0.38);

      const i = (y * MASK + x) * 4;
      d[i] = Math.round(255 * r);
      d[i + 1] = Math.round(255 * g);
      d[i + 2] = Math.round(255 * b);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  // NOT sRGB: these are scalar FIELDS a transfer function would bend.
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

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
  // THE CARRIER LEAN: the owner's own motion, NOT the spec's baked lateralPush.
  float k = pow(aLife, 1.6);
  p.x += uLean.x * k;
  p.z += uLean.y * k;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

/** Colours reaching gl_FragColor are LINEAR; the uniforms convert on the way in. */
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
uniform vec3 uSunDir;
uniform float uSunStrength;
uniform float uOpacity;
varying float vLife;
varying float vAcross;
varying vec2 vMaskUv;
varying vec3 vNrm;
#include <fog_pars_fragment>

// MUST match SUN_OFFSET in core/engine.ts, normalised — one sun for fall and rock.

/** Where the head foam ends, as a fraction of the fall. */
const float HEAD = 0.10;

void main() {
  // Across-sheet U is WORLD UNITS over the tile size, so a fibre stays 1.2 units wide.
  float uw = vAcross / uTileW;

  // THE TWO-LAYER PANNER: two irrational taps. One tap is a stripe; two is water.
  vec2 uvA = vec2(uw,        vMaskUv.y - uTime * uFlow * ${SCROLL_A.toFixed(2)});
  vec2 uvB = vec2(uw * 0.63, vMaskUv.y * 2.17 - uTime * uFlow * ${SCROLL_B.toFixed(2)});
  vec3 a = texture2D(uMask, uvA).rgb;
  vec3 b = texture2D(uMask, uvB).rgb;

  // Screen-ish, not a product, and NORMALISED: the raw 1.55 peak drove it cyan.
  float flow = clamp(a.r * 0.55 + b.r * 0.55 + a.r * b.r * 0.45, 0.0, 1.40) / 1.40;
  float foamK = max(a.g, b.g * 0.8);
  float erode = a.b;

  // THE HEAD IS WHITE WATER; past it, foam survives only where the clump field says.
  float head = 1.0 - smoothstep(0.0, HEAD, vLife);
  // 0.20, not 0.35: foam past the lip is a highlight on water, not a second colour.
  float white = clamp(head + foamK * 0.20 * (1.0 - vLife), 0.0, 1.0);

  float sun = dot(normalize(vNrm), uSunDir) * uSunStrength;
  vec3 water = mix(uShadow, uBody, smoothstep(-0.55, 0.15, sun));
  water = mix(water, uLit, smoothstep(0.15, 0.75, sun));
  // Threads brighten rather than tint, centred on 1.0 so the mean stays on the teal.
  water *= 0.74 + 0.38 * flow;

  // THE SILHOUETTE IS TEXTURE ALPHA, so the plume frays instead of ending on a cut.
  float across = 1.0 - abs(vMaskUv.x * 2.0 - 1.0);
  float edge = smoothstep(foamK * 0.30, 0.26 + foamK * 0.30, across);

  // A DENSE CORE AND THIN SHOULDERS: a fall is a volume, not a painted ribbon.
  water *= mix(1.08, 0.88, across);
  vec3 col = mix(water, uFoam, white);

  // A THICKENING SHEET, and a DENSE one: thinner, and what reached the frame was the
  // background tinted rather than water.
  float alpha = mix(0.55, 0.92, smoothstep(0.0, 0.30, vLife));
  // The threads modulate the sheet, not perforate it: deeper gaps read as gauze.
  alpha *= edge * (0.74 + 0.26 * flow);

  // vLife runs 0..1 over exactly WaterfallSpec.length; eroding it frays the tail.
  alpha *= 1.0 - smoothstep(uFadeStart - erode * 0.25, 1.0, vLife);

  // The head is nearly opaque regardless: at distance the ALPHA makes a band read.
  alpha = max(alpha, head * 0.75 * edge);

  // ...but the TOP EDGE fades in, or the splayed sheets stack their top rows into a
  // hard white slab lying at the lip.
  alpha *= smoothstep(0.0, 0.045, vLife);

  gl_FragColor = vec4(col, alpha * uOpacity);
  #include <fog_fragment>
}
`;

/** Camera-facing quads billboarded in the VERTEX STAGE: gl_PointSize is device pixels
 *  and would need the canvas height every frame. View space keeps it square to the lens. */
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

/** NORMAL blending, not additive: additive white vanishes on sky and blows on keel. */
const SPRAY_FRAG = /* glsl */ `
uniform vec3 uFoam;
uniform float uOpacity;
varying vec2 vCorner;
varying float vFade;
#include <fog_pars_fragment>
void main() {
  float d = length(vCorner);
  if (d > 1.0) discard;
  // SOFT: a tight core reads as a bead of glass. Spray is a haze with drops in it.
  float a = smoothstep(1.0, 0.05, d) * (0.72 + 0.28 * smoothstep(0.75, 0.0, d)) * 0.72;
  gl_FragColor = vec4(uFoam, a * vFade * uOpacity);
  #include <fog_fragment>
}
`;

/** Spray zones. A droplet's zone decides where it starts and how it flies. */
const Z_LIP = 0;
const Z_SHEET = 1;
const Z_TAIL = 2;

/** One fall. Build it, add `group` to the owner, tick `update`, `dispose` with it. */
export class Waterfall {
  readonly group = new THREE.Group();

  private readonly mask: THREE.CanvasTexture;
  private readonly sheetGeo: THREE.BufferGeometry;
  private readonly sheetMat: THREE.ShaderMaterial;
  private readonly sheet: THREE.Mesh;

  private readonly sprayGeo: THREE.InstancedBufferGeometry | null = null;
  private readonly sprayMat: THREE.ShaderMaterial | null = null;
  private readonly sprayMesh: THREE.Mesh | null = null;
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
  private readonly centre: Float32Array;
  private readonly size: Float32Array;
  private readonly fade: Float32Array;
  private centreAttr: THREE.InstancedBufferAttribute | null = null;
  private fadeAttr: THREE.InstancedBufferAttribute | null = null;
  /** DYNAMIC: re-rolled on every recycle, or a droplet keeps its first size forever. */
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

  applyCelestial(state: Readonly<CelestialState>): void {
    this.sheetMat.uniforms.uSunDir.value.copy(state.keyDirection);
    this.sheetMat.uniforms.uSunStrength.value = state.keyIntensity / 3.05;
  }

  constructor(spec: WaterfallSpec) {
    const lipWidth = spec.lipWidth ?? 7.2;
    const spreadWidth = spec.spreadWidth ?? 10.8;
    const tailWidth = spec.tailWidth ?? 6.0;
    const spreadAt = spec.spreadAt ?? 0.1;
    const sheets = spec.sheets ?? 3;
    const segments = spec.segments ?? 26;
    const cross = spec.cross ?? 0.55;
    const basin = spec.basin ?? null;

    // A BASIN CLAMPS THE FALL: the drop wins over the authored length; it must arrive.
    this.basinY = basin ? basin.y : null;
    this.basinR = basin ? basin.radius : 0;
    this.fallLength = basin ? Math.max(0.5, Math.min(spec.length, spec.y - basin.y)) : spec.length;
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
    // three's Euler-Y agrees with the project bearing: local +Z downstream, +X across.
    this.group.rotation.y = spec.bearing;
    this.group.matrixAutoUpdate = false;
    this.group.updateMatrix();

    this.mask = makeFallMask();

    this.sheetGeo = this.buildSheet(sheets, segments, cross);

    this.sheetMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib["fog"],
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
          uSunDir: { value: new THREE.Vector3(0.6554, 0.6168, 0.4356) },
          uSunStrength: { value: 1 },
        },
      ]),
      vertexShader: SHEET_VERT,
      fragmentShader: SHEET_FRAG,
      // TRANSPARENT, the OPPOSITE of world/water.ts: water went opaque to stay in the
      // GTAO G-buffer, but a sheet in there paints a dark halo down the cliff behind it.
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      // Fog is MANUAL in a raw ShaderMaterial, or the fall is the one unhazed surface.
      fog: true,
    });
    this.sheetMat.uniforms.uMask.value = this.mask;

    this.sheet = new THREE.Mesh(this.sheetGeo, this.sheetMat);
    // Deliberately NOT chunk:water — tools/test-gfx.mjs counts meshes by that name.
    this.sheet.name = "vfx:waterfall";
    // Between world/water.ts (2) and the gateway (5).
    this.sheet.renderOrder = 3;
    this.sheet.castShadow = false;
    this.sheet.receiveShadow = false;
    // The vertex shader displaces by the lean, so bounds off the static positions lie.
    this.sheetGeo.computeBoundingSphere();
    if (this.sheetGeo.boundingSphere) {
      this.sheetGeo.boundingSphere.radius += LEAN_MAX + Math.abs(this.lateralPush) * 0.1;
    }
    this.group.add(this.sheet);
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
      geo.setAttribute(
        "aCorner",
        new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2),
      );
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      this.centreAttr = new THREE.InstancedBufferAttribute(this.centre, 3);
      this.centreAttr.setUsage(THREE.DynamicDrawUsage);
      this.fadeAttr = new THREE.InstancedBufferAttribute(this.fade, 1);
      this.fadeAttr.setUsage(THREE.DynamicDrawUsage);
      this.sizeAttr = new THREE.InstancedBufferAttribute(this.size, 1);
      this.sizeAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("aCentre", this.centreAttr);
      geo.setAttribute("aFade", this.fadeAttr);
      geo.setAttribute("aSize", this.sizeAttr);

      const mat = new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib["fog"],
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
      mesh.name = "vfx:waterfall-spray";
      mesh.renderOrder = 4;
      mesh.castShadow = false;
      // Centres are rewritten every slice, so any bounding volume computed once lies.
      mesh.frustumCulled = false;
      this.sprayGeo = geo;
      this.sprayMat = mat;
      this.sprayMesh = mesh;
      this.group.add(mesh);

      for (let i = 0; i < this.n; i++) {
        this.zone[i] = i < this.n * 0.22 ? Z_LIP : i < this.n * 0.69 ? Z_SHEET : Z_TAIL;
        this.seedDrop(i, this.rand());
        // Publish the seeded pool NOW, or the boot sweep's only frame stacks it all.
        this.centre[i * 3] = this.px[i];
        this.centre[i * 3 + 1] = this.py[i];
        this.centre[i * 3 + 2] = this.pz[i];
        this.fade[i] = 1;
      }
    }
  }

  /** Full width of the plume at v — the single source the sheet and spray both use. */
  private widthAt(v: number): number {
    const lip = this.lipWidth;
    const tail = this.tailWidth;
    const open = this.spreadAt > 0 ? smoothstep(0, this.spreadAt, v) : 1;
    const w = lip + (this.spreadWidth - lip) * open;
    // Holds its width most of the way down and gathers late, unlike a linear taper.
    return tail + (w - tail) * Math.pow(1 - v, 0.35);
  }

  /** `sheets` quad strips, splayed about local Y — the strips are the plume. */
  private buildSheet(sheets: number, segments: number, cross: number): THREE.BufferGeometry {
    const rows = segments + 1;
    const pos: number[] = [];
    const nrm: number[] = [];
    const uvs: number[] = [];
    const life: number[] = [];
    const across: number[] = [];
    const idx: number[] = [];
    const tiles = Math.max(1, this.fallLength / TILE_V);

    for (let b = 0; b < sheets; b++) {
      // Splayed, not fanned through a half-turn: a fall has a FRONT, a beam does not.
      const a = sheets > 1 ? (b / (sheets - 1) - 0.5) * 2 * cross : 0;
      const ax = Math.cos(a);
      const az = Math.sin(a);
      const base = pos.length / 3;
      for (let i = 0; i < rows; i++) {
        const v = i / segments;
        const halfW = this.widthAt(v) * 0.5;
        const drift = this.lateralPush * Math.pow(v, PUSH_EXP) + wander(v);
        const along = this.outwardPush * Math.pow(v, PUSH_EXP);
        const cy = -this.fallLength * v;
        const uvY = Math.pow(v, UV_EASE) * tiles;
        for (const s of [-1, 1]) {
          pos.push(drift + ax * halfW * s, cy, along + az * halfW * s);
          // EVERY SHEET TAKES THE FALL'S OWN NORMAL: its own gave three flat values.
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

    // There is NO LIP CAP any more: the seam it hid is gone, and at aLife 0 a
    // horizontal quad is whited by the head term into a paving stone on the grass.

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
    g.setAttribute("aLife", new THREE.BufferAttribute(new Float32Array(life), 1));
    g.setAttribute("aAcross", new THREE.BufferAttribute(new Float32Array(across), 1));
    g.setIndex(idx);
    return g;
  }

  /** (Re)launch droplet i; start is where in its own life it begins, so the pool seeds
   *  across the plume. THE LATERAL PUSH REACHES THE SPRAY, over the time of flight. */
  private seedDrop(i: number, start: number): void {
    const r = this.rand;
    const z = this.zone[i];
    const tof = Math.sqrt((2 * this.fallLength) / GRAV);
    const from = z === Z_LIP ? 0 : z === Z_SHEET ? 0.05 : 0.6;
    const to = z === Z_LIP ? 0.06 : z === Z_SHEET ? 0.75 : 1.0;
    const v0 = from + (to - from) * start;
    const halfW = this.widthAt(v0) * 0.5;

    this.py[i] = -this.fallLength * v0;
    this.px[i] =
      this.lateralPush * Math.pow(v0, PUSH_EXP) + wander(v0) + (r() * 2 - 1) * halfW * 1.15;
    this.pz[i] = this.outwardPush * Math.pow(v0, PUSH_EXP) + (r() * 2 - 1) * 1.1;

    // Launch speed climbs with the zone: lip mist drifts, sheet spray runs with it.
    const drive = z === Z_LIP ? 0.25 : z === Z_SHEET ? 1.0 : 0.75;
    this.vx[i] = (this.lateralPush / tof) * drive + (r() * 2 - 1) * 0.8;
    this.vz[i] = (this.outwardPush / tof) * drive + (r() * 2 - 1) * 0.5;
    this.vy[i] =
      z === Z_LIP
        ? 0.4 + r() * 0.8 // thrown up off the lip before it falls
        : -(2 + r() * 5) - GRAV * tof * v0 * 0.35;

    this.span[i] = z === Z_LIP ? 0.7 + r() * 0.8 : 0.9 + r() * 1.5;
    this.life[i] = this.span[i] * (1 - start * 0.6);
    // Lip mist is biggest and softest; sheet spray is water that has not broken up.
    this.size[i] =
      z === Z_LIP ? 0.42 + r() * 0.44 : z === Z_SHEET ? 0.14 + r() * 0.18 : 0.24 + r() * 0.32;
  }

  /** One slice of the pool, INTEGRATED IN THE FALL'S OWN FRAME — exact because
   *  CarrierBody only writes rotation.y. A carrier that PITCHED would need rotating. */
  private stepSpray(dt: number): void {
    if (this.n === 0) {
      return;
    }
    const c = this.centre;
    const f = this.fade;
    for (let i = 0; i < this.n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.seedDrop(i, 0);
      }
      this.vy[i] -= GRAV * 0.42 * dt;
      // Air drag in the house exp(-k*dt) form, so slicing cannot change the path.
      const d = Math.exp(-0.9 * dt);
      this.vx[i] *= d;
      this.vz[i] *= d;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;

      // In OPEN AIR a droplet stops existing at the dissolve. Over a BASIN it bounces,
      // because a plume that arrives and vanishes reads as ending in mid-air.
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
          this.size[i] = 0.34 + this.rand() * 0.4;
        }
      } else if (this.py[i] < -this.fallLength) {
        this.seedDrop(i, 0);
      }

      const k = i * 3;
      c[k] = this.px[i];
      c[k + 1] = this.py[i];
      c[k + 2] = this.pz[i];
      const t = 1 - this.life[i] / this.span[i];
      f[i] = Math.min(1, t / 0.2) * Math.min(1, (1 - t) / 0.33);
    }
    if (this.centreAttr) {
      this.centreAttr.needsUpdate = true;
    }
    if (this.fadeAttr) {
      this.fadeAttr.needsUpdate = true;
    }
    if (this.sizeAttr) {
      this.sizeAttr.needsUpdate = true;
    }
  }

  /** One simulation slice. carrierDX/DZ are the owner's step IN THE FALL'S OWN FRAME.
   *  Under photo=1 the clock pins and the pool pre-rolls exactly once. */
  update(dt: number, carrierDX = 0, carrierDZ = 0): void {
    if (flags.photo) {
      if (this.frozen) {
        return;
      }
      this.frozen = true;
      this.time = PHOTO_CLOCK;
      this.sheetMat.uniforms.uTime.value = PHOTO_CLOCK;
      // Fixed steps, so the pre-roll is identical on software GL and on a 165 Hz host.
      const STEP = 1 / 60;
      for (let t = 0; t < PHOTO_PREROLL; t += STEP) {
        this.stepSpray(STEP);
      }
      // Lean is zero by construction: SkyIsland.steer returns early under photo.
      this.sheetMat.uniforms.uLean.value.set(0, 0);
      return;
    }

    this.time += dt;
    this.sheetMat.uniforms.uTime.value = this.time;

    // THE CARRIER LEAN, only where the owner asked. Smoothed, and clamped so a
    // teleported carrier cannot fling the tail to the horizon.
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

  /** Link both programs at boot. Opacity is non-zero: a transparent draw links nothing. */
  warmUp(render: () => void): void {
    const wasVisible = this.visible;
    this.setVisible(true);
    this.sheetMat.uniforms.uOpacity.value = 0.002;
    if (this.sprayMat) {
      this.sprayMat.uniforms.uOpacity.value = 0.002;
    }
    render();
    this.sheetMat.uniforms.uOpacity.value = 1;
    if (this.sprayMat) {
      this.sprayMat.uniforms.uOpacity.value = 1;
    }
    this.setVisible(wasVisible);
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.sheet.visible = on;
    if (this.sprayMesh) {
      this.sprayMesh.visible = on;
    }
  }

  /** Counts, not prose — the probe surface, like TouchParticles.stats(). */
  stats(): Record<string, number> {
    let alive = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.fade[i] > 0.01) alive++;
    }
    return {
      length: +this.fallLength.toFixed(3),
      push: +this.lateralPush.toFixed(3),
      anchorX: +this.group.position.x.toFixed(3),
      anchorY: +this.group.position.y.toFixed(3),
      anchorZ: +this.group.position.z.toFixed(3),
      bearing: +this.group.rotation.y.toFixed(4),
      spray: this.n,
      sprayAlive: alive,
      verts: this.sheetGeo.getAttribute("position").count,
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
