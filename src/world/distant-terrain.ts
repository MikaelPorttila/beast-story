/** Camera-following coarse terrain + water under and beyond the 1 m chunks. */
import * as THREE from "three";
import { excludeFromAO } from "../core/types";
import type { Terrain } from "./terrain";
import { makeScratch, smoothstep, WATER_LEVEL } from "./terrain";
import { SURFACE_Y, WATER_DETAIL_FADE_WIDTH } from "./water";
import type { RimHit } from "./roads";

/** Shipped medium setting. Live choices replace these through configure(). */
const DEFAULT_VIEW_DISTANCE = 600;
const DEFAULT_DETAIL_DISTANCE = 160;
/** Re-sample after four far-grid cells, not for every nearby chunk crossing. */
const SNAP = 64;

interface Layout {
  xz: Float32Array;
  index: Uint32Array;
  outerRadius: number;
  step: number;
}

/** ONE dissolve authority, so a render-distance change moves everything
 *  together. `start`/`end` are the far GROUND's band. `ringStart`/`ringEnd` are
 *  everything BUILT that is not streamed by chunk — road ribbons, waystones,
 *  dens, lamp glow: it may stand only on DETAILED chunks, dying on the same
 *  ring as the trees, posts and fences beside it. Past the ring the clipmap's
 *  own carved corridor tint carries a road, ON the coarse ground; a deck kept
 *  over the clipmap reads as a floating slab from eye level, because the
 *  underlay is deliberately lowered beneath paths (reported three times, on
 *  foot last). `DistantTerrain.configure` is the only setter. */
export interface HorizonFade {
  start: { value: number };
  end: { value: number };
  ring: RingBand;
}

/** One camera-distance band as its two shader uniforms. */
export interface FadeBand {
  start: { value: number };
  end: { value: number };
}

/** The detailed ring's band, plus every material wearing it. The band is baked
 *  into each material as DEFINES, not uniforms: onBeforeCompile-added uniforms
 *  silently read 0 on a material that reuses another's cached program, which is
 *  exactly what happened when the ribbon, the lamps, the stones and the dens
 *  all carried the same compile hook — the ribbon lost its fade wherever it was
 *  not the first to compile. Defines are part of three's program hash, so
 *  sharing is correct by construction; `setHorizonFade` re-bakes them live. */
export interface RingBand {
  start: { value: number };
  end: { value: number };
  materials: Set<THREE.Material>;
}

export function makeHorizonFade(
  viewDistance: number,
  detailDistance = viewDistance <= 480 ? 128 : 160,
): HorizonFade {
  const fade = {
    start: { value: 0 },
    end: { value: 0 },
    ring: { start: { value: 0 }, end: { value: 0 }, materials: new Set<THREE.Material>() },
  };
  setHorizonFade(fade, viewDistance, detailDistance);
  return fade;
}

function setHorizonFade(fade: HorizonFade, viewDistance: number, detailDistance: number): void {
  // Ground matches the sky by 86% of range, leaving guard band for snap lag.
  fade.start.value = viewDistance * 0.66;
  fade.end.value = viewDistance * 0.86;
  // The same 32-unit ramp the solid props use, closing at the detailed ring.
  fade.ring.start.value = Math.max(0, detailDistance - 32);
  fade.ring.end.value = detailDistance;
  for (const material of fade.ring.materials) {
    bakeRingDefines(material, fade.ring);
  }
}

/** Written as GLSL float literals; a changed band recompiles (rare: a settings
 *  change, which already rebuilds the whole far clipmap). */
function bakeRingDefines(material: THREE.Material, band: RingBand): void {
  const defines = (material.defines ??= {});
  const start = band.start.value.toFixed(1);
  const end = band.end.value.toFixed(1);
  if (defines.BS_RING_START !== start || defines.BS_RING_END !== end) {
    defines.BS_RING_START = start;
    defines.BS_RING_END = end;
    material.needsUpdate = true;
  }
}

/** The two shader-side lines every fade here needs: camera distance, per vertex. */
function installCameraDistance(shader: { vertexShader: string; fragmentShader: string }): void {
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>
varying float vBsCameraDistance;`,
    )
    .replace(
      "#include <project_vertex>",
      `#include <project_vertex>
vBsCameraDistance = length(mvPosition.xyz);`,
    );
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <common>",
    `#include <common>
varying float vBsCameraDistance;`,
  );
}

/**
 * Radial dissolve to sky for the FAR CLIPMAP: fog's view depth is short
 * off-axis, drawing an arc. Composes with the material's existing compile hook.
 */
export function installHorizonFade(material: THREE.Material, fade: FadeBand): void {
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}|bs-horizon-fade-v4`;
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.bsHorizonFadeStart = fade.start;
    shader.uniforms.bsHorizonFadeEnd = fade.end;
    installCameraDistance(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float bsHorizonFadeStart;
uniform float bsHorizonFadeEnd;`,
      )
      .replace(
        "#include <fog_fragment>",
        `#include <fog_fragment>
{
  float bsHorizonFade = smoothstep(
    bsHorizonFadeStart, bsHorizonFadeEnd, vBsCameraDistance
  );
  // Opaque screen-door dissolve: reveal the real sky rather than trusting a
  // colour mix to survive tone mapping identically to the sky dome. Keeping the
  // material opaque preserves its underlay ordering beneath detailed chunks;
  // transparent terrain would move to three's late pass and wash over them.
  float bsHorizonDither = fract(52.9829189 * fract(dot(
    floor(gl_FragCoord.xy), vec2(0.06711056, 0.00583715)
  )));
  if (bsHorizonFade >= bsHorizonDither) discard;
#ifdef USE_FOG
  // 0.82: at 0.65 a dark survivor — the road corridor's tint — still traced a
  // legible line through the band from the air (reported).
  gl_FragColor.rgb = mix(
    gl_FragColor.rgb, bsSkyRadiance(vFogElev) * fogColor, bsHorizonFade * 0.82
  );
#endif
}`,
      );
  };
}

/**
 * Alpha fade-out over `fade`, for everything built that dies at the DETAILED
 * ring: the road ribbon, waystones, dens, lamp glow. Not the dither above — a
 * screen-door over a skin stipples whatever lies beneath into its surface,
 * which shipped as white sand dots all over a dune road (reported). Same
 * explicit blend factors as world/props.ts's foliage fade, so the material
 * stays in the opaque pass and in GTAO while honouring alpha. Fully faded
 * fragments DISCARD, or their depth writes would hole the water behind an
 * invisible bridge deck.
 */
export function installRingFade(material: THREE.Material, band: RingBand): void {
  // IDEMPOTENT: a den's three orbiting sparks share one material, and the
  // group traverse that installs fades reaches it once per spark — a second
  // install would stack the shader edits into varying redefinitions.
  if (band.materials.has(material)) {
    return;
  }
  material.transparent = false;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.SrcAlphaFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  bakeRingDefines(material, band);
  band.materials.add(material);
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}|bs-ring-fade-v2`;
  // The hook adds NO uniforms on purpose (see `RingBand`): a cached-program
  // reuse skips it entirely, and the code below must be complete without it.
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    installCameraDistance(shader);
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <opaque_fragment>",
      `float bsRingAlpha = 1.0 - smoothstep(float(BS_RING_START), float(BS_RING_END), vBsCameraDistance);
if (bsRingAlpha < 0.004) discard;
#include <opaque_fragment>
gl_FragColor.a *= bsRingAlpha;`,
    );
  };
}

function layoutFor(viewDistance: number): Layout {
  // Radius is a multiple of step, plus a snap cell of reserve for any anchor.
  const [outerRadius, step] =
    viewDistance <= 480 ? [552, 24] : viewDistance >= 900 ? [976, 8] : [672, 12];
  const side = (outerRadius * 2) / step + 1;
  const xz = new Float32Array(side * side * 2);
  let v = 0;
  for (let z = -outerRadius; z <= outerRadius; z += step) {
    for (let x = -outerRadius; x <= outerRadius; x += step) {
      xz[v++] = x;
      xz[v++] = z;
    }
  }

  const index = new Uint32Array((side - 1) * (side - 1) * 6);
  let k = 0;
  for (let z = 0; z < side - 1; z++) {
    for (let x = 0; x < side - 1; x++) {
      const a = z * side + x;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      index[k++] = a;
      index[k++] = c;
      index[k++] = d;
      index[k++] = a;
      index[k++] = d;
      index[k++] = b;
    }
  }
  return { xz, index, outerRadius, step };
}

function geometry(
  layout: Layout,
  position: Float32Array,
  color: Float32Array,
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
  // Four components opt into three.js's vertex-alpha path as well as colour.
  geo.setAttribute("color", new THREE.BufferAttribute(color, 4));
  geo.setIndex(new THREE.BufferAttribute(layout.index, 1));
  return geo;
}

export interface DistantTerrainDebug extends Record<string, unknown> {
  anchor: [number, number];
  terrainVertices: number;
  waterVertices: number;
  wetWaterVertices: number;
  innerRadius: number;
  outerRadius: number;
  step: number;
  viewDistance: number;
  waterFadeStart: number;
  waterFadeEnd: number;
  /** Where the far ground dissolves to sky, and the detailed ring everything
   *  BUILT dies on — both bands of the one render-distance authority. */
  horizonFadeStart: number;
  horizonFadeEnd: number;
  ringFadeStart: number;
  ringFadeEnd: number;
  building: boolean;
  ready: boolean;
}

export class DistantTerrain {
  readonly terrain: THREE.Mesh;
  readonly water: THREE.Mesh;

  private layout: Layout;
  private nextLayout: Layout;
  private terrainPosition: Float32Array;
  private terrainColor: Float32Array;
  private waterPosition: Float32Array;
  private waterColor: Float32Array;
  // Double-buffered: the visible mesh stays consistent while the next samples.
  private nextTerrainPosition: Float32Array;
  private nextTerrainColor: Float32Array;
  private nextWaterPosition: Float32Array;
  private nextWaterColor: Float32Array;
  private readonly scratch = makeScratch();
  private readonly rimScratch = makeScratch();
  private readonly rim: RimHit = { found: false, x: 0, z: 0, nx: 0, nz: 0, half: 0 };
  private anchorX = Infinity;
  private anchorZ = Infinity;
  private nextAnchorX = Infinity;
  private nextAnchorZ = Infinity;
  private nextVertex = -1;
  private nextWetWaterVertices = 0;
  private shown = true;
  private waterShown = true;
  private wetWaterVertices = 0;
  private ready = false;
  private viewDistance: number;
  private detailDistance: number;
  private readonly horizonFade: HorizonFade;

  constructor(
    private readonly field: Terrain,
    focus: Readonly<THREE.Vector3>,
    viewDistance = DEFAULT_VIEW_DISTANCE,
    detailDistance = DEFAULT_DETAIL_DISTANCE,
    horizonFade = makeHorizonFade(viewDistance),
  ) {
    this.viewDistance = viewDistance;
    this.detailDistance = detailDistance;
    this.horizonFade = horizonFade;
    setHorizonFade(this.horizonFade, viewDistance, detailDistance);
    this.layout = layoutFor(this.viewDistance);
    this.nextLayout = this.layout;
    const count = this.layout.xz.length / 2;
    this.terrainPosition = new Float32Array(count * 3);
    this.terrainColor = new Float32Array(count * 4);
    this.waterPosition = new Float32Array(count * 3);
    this.waterColor = new Float32Array(count * 4);
    this.nextTerrainPosition = new Float32Array(count * 3);
    this.nextTerrainColor = new Float32Array(count * 4);
    this.nextWaterPosition = new Float32Array(count * 3);
    this.nextWaterColor = new Float32Array(count * 4);
    const terrainGeo = geometry(this.layout, this.terrainPosition, this.terrainColor);
    const waterGeo = geometry(this.layout, this.waterPosition, this.waterColor);
    const terrainMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      // Depthless opaque underlay; detailed chunks overwrite it in the same list.
      transparent: false,
      depthWrite: false,
      fog: true,
    });
    const waterMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      color: 0xffffff,
      // Alpha test, not blending: blending showed lakebed as grey wedges (#97).
      transparent: false,
      alphaTest: 0.02,
      // Underlay: depth writes let the coarse mask beat near terrain (#97).
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
      fog: true,
    });
    installHorizonFade(terrainMat, this.horizonFade);
    installHorizonFade(waterMat, this.horizonFade);

    this.terrain = excludeFromAO(new THREE.Mesh(terrainGeo, terrainMat));
    this.terrain.name = "distant:terrain";
    this.terrain.renderOrder = -2;
    this.terrain.matrixAutoUpdate = false;
    this.water = excludeFromAO(new THREE.Mesh(waterGeo, waterMat));
    this.water.name = "distant:water";
    this.water.renderOrder = -1;
    this.water.matrixAutoUpdate = false;
    // Hidden until buildStep has one consistent field; World.streaming waits.
    this.terrain.visible = false;
    this.water.visible = false;
    this.requestUpdate(focus);
  }

  /** Queue a live far-geometry budget change; the old field stays until commit. */
  configure(viewDistance: number, detailDistance: number, focus: Readonly<THREE.Vector3>): void {
    if (viewDistance === this.viewDistance && detailDistance === this.detailDistance) {
      return;
    }
    this.viewDistance = viewDistance;
    this.detailDistance = detailDistance;
    setHorizonFade(this.horizonFade, viewDistance, detailDistance);
    const next = layoutFor(viewDistance);
    const count = next.xz.length / 2;
    this.nextLayout = next;
    this.nextTerrainPosition = new Float32Array(count * 3);
    this.nextTerrainColor = new Float32Array(count * 4);
    this.nextWaterPosition = new Float32Array(count * 3);
    this.nextWaterColor = new Float32Array(count * 4);
    this.nextAnchorX = Math.floor(focus.x / SNAP) * SNAP;
    this.nextAnchorZ = Math.floor(focus.z / SNAP) * SNAP;
    this.nextVertex = 0;
    this.nextWetWaterVertices = 0;
  }

  /** Resample without the anchor moving — for ground carved at runtime. */
  invalidate(): void {
    this.nextAnchorX = this.anchorX;
    this.nextAnchorZ = this.anchorZ;
    this.nextVertex = 0;
    this.nextWetWaterVertices = 0;
  }

  requestUpdate(focus: Readonly<THREE.Vector3>): void {
    const ax = Math.floor(focus.x / SNAP) * SNAP;
    const az = Math.floor(focus.z / SNAP) * SNAP;
    if (
      (ax === this.anchorX && az === this.anchorZ) ||
      (ax === this.nextAnchorX && az === this.nextAnchorZ && this.nextVertex >= 0)
    ) {
      return;
    }
    this.nextAnchorX = ax;
    this.nextAnchorZ = az;
    this.nextVertex = 0;
    this.nextWetWaterVertices = 0;
  }

  buildStep(budgetMs: number): boolean {
    if (this.nextVertex < 0) {
      return false;
    }
    const end = performance.now() + budgetMs;
    const count = this.nextLayout.xz.length / 2;
    do {
      const stop = Math.min(this.nextVertex + 32, count);
      while (this.nextVertex < stop) {
        this.writeVertex(this.nextVertex++);
      }
    } while (this.nextVertex < count && performance.now() < end);
    if (this.nextVertex < count) {
      return false;
    }
    this.commitPending();
    return true;
  }

  get building(): boolean {
    return this.nextVertex >= 0;
  }

  /** Keep far ground under any path in the cell; the coarse grid chords over a
   * carved corridor. Lowering is safe — nothing walks on the underlay. */
  private underPaths(wx: number, wz: number, y: number): number {
    const rf = this.field.roads;
    if (rf === null) {
      return y;
    }
    // A FULL step: the triangle reaches that far, so half left edges high.
    const h = this.nextLayout.step;
    let out = rf.lowestDrawnSurfaceNear(wx, wz, h, y, this.rim);
    if (!this.rim.found) {
      return out;
    }
    // Rims too — a shallow trail's rim is near natural ground, so the
    // clipmap's own interpolation error rides over it.
    for (const side of [1, -1] as const) {
      const rx = this.rim.x + this.rim.nx * this.rim.half * side;
      const rz = this.rim.z + this.rim.nz * this.rim.half * side;
      this.field.columnInfo(rx - 0.5, rz - 0.5, this.rimScratch);
      if (this.rimScratch.h - 0.08 < out) {
        out = this.rimScratch.h - 0.08;
      }
    }
    return out;
  }

  private writeVertex(v: number): void {
    const i = v * 2;
    const p = v * 3;
    const c = v * 4;
    const lx = this.nextLayout.xz[i];
    const lz = this.nextLayout.xz[i + 1];
    const wx = this.nextAnchorX + lx;
    const wz = this.nextAnchorZ + lz;
    const d = Math.hypot(lx, lz);
    // The road's wear tint rides out with the road: full at the detailed ring
    // (the chunk colours it meets there carry it in full), gone 96 on — or the
    // corridor stays a legible dark line through total haze from the air.
    const wearCap = 1 - smoothstep(this.detailDistance, this.detailDistance + 96, d);
    // columnInfo samples the centre of a column, hence the half-unit shift.
    this.field.columnInfo(wx - 0.5, wz - 0.5, this.scratch, wearCap);
    const waterFade = smoothstep(
      Math.max(0, this.detailDistance - WATER_DETAIL_FADE_WIDTH),
      this.detailDistance,
      d,
    );

    this.nextTerrainPosition[p] = lx;
    this.nextTerrainPosition[p + 1] = this.underPaths(wx, wz, this.scratch.h - 0.08);
    this.nextTerrainPosition[p + 2] = lz;
    this.nextTerrainColor[c] = this.scratch.topR;
    this.nextTerrainColor[c + 1] = this.scratch.topG;
    this.nextTerrainColor[c + 2] = this.scratch.topB;
    // Opaque, so an unfinished near chunk shows no sky hole.
    this.nextTerrainColor[c + 3] = 1;

    this.nextWaterPosition[p] = lx;
    this.nextWaterPosition[p + 1] = SURFACE_Y - 0.04;
    this.nextWaterPosition[p + 2] = lz;
    // Blue matched to the chunk shader; darker exposed the handoff as a pool.
    this.nextWaterColor[c] = 0.035;
    this.nextWaterColor[c + 1] = 0.3;
    this.nextWaterColor[c + 2] = 0.56;
    const wetAlpha = this.scratch.h <= WATER_LEVEL ? waterFade * 0.92 : 0;
    this.nextWaterColor[c + 3] = wetAlpha;
    if (wetAlpha > 0) {
      this.nextWetWaterVertices++;
    }
  }

  private commitPending(): void {
    this.anchorX = this.nextAnchorX;
    this.anchorZ = this.nextAnchorZ;
    this.wetWaterVertices = this.nextWetWaterVertices;
    if (this.nextLayout !== this.layout) {
      this.layout = this.nextLayout;
      this.terrainPosition = this.nextTerrainPosition;
      this.terrainColor = this.nextTerrainColor;
      this.waterPosition = this.nextWaterPosition;
      this.waterColor = this.nextWaterColor;
      const oldTerrain = this.terrain.geometry;
      const oldWater = this.water.geometry;
      this.terrain.geometry = geometry(this.layout, this.terrainPosition, this.terrainColor);
      this.water.geometry = geometry(this.layout, this.waterPosition, this.waterColor);
      oldTerrain.dispose();
      oldWater.dispose();
      const count = this.layout.xz.length / 2;
      this.nextTerrainPosition = new Float32Array(count * 3);
      this.nextTerrainColor = new Float32Array(count * 4);
      this.nextWaterPosition = new Float32Array(count * 3);
      this.nextWaterColor = new Float32Array(count * 4);
    } else {
      this.terrainPosition.set(this.nextTerrainPosition);
      this.terrainColor.set(this.nextTerrainColor);
      this.waterPosition.set(this.nextWaterPosition);
      this.waterColor.set(this.nextWaterColor);
    }
    this.terrain.position.set(this.anchorX, 0, this.anchorZ);
    this.water.position.set(this.anchorX, 0, this.anchorZ);
    this.terrain.updateMatrix();
    this.water.updateMatrix();
    const terrainPos = this.terrain.geometry.getAttribute("position") as THREE.BufferAttribute;
    const terrainCol = this.terrain.geometry.getAttribute("color") as THREE.BufferAttribute;
    const waterPos = this.water.geometry.getAttribute("position") as THREE.BufferAttribute;
    const waterCol = this.water.geometry.getAttribute("color") as THREE.BufferAttribute;
    terrainPos.needsUpdate = true;
    terrainCol.needsUpdate = true;
    waterPos.needsUpdate = true;
    waterCol.needsUpdate = true;
    // No normals: MeshBasic needs none, and recomputing them every 64 m hitched.
    this.terrain.geometry.computeBoundingSphere();
    this.water.geometry.computeBoundingSphere();
    this.ready = true;
    this.terrain.visible = this.shown;
    this.water.visible = this.shown && this.waterShown;
    this.nextVertex = -1;
  }

  setVisible(shown: boolean): void {
    this.shown = shown;
    this.terrain.visible = shown && this.ready;
    this.water.visible = shown && this.waterShown && this.ready;
  }

  setWaterVisible(shown: boolean): void {
    this.waterShown = shown;
    this.water.visible = this.shown && shown && this.ready;
  }

  debug(): DistantTerrainDebug {
    return {
      anchor: [this.anchorX, this.anchorZ],
      terrainVertices: this.terrainPosition.length / 3,
      waterVertices: this.waterPosition.length / 3,
      wetWaterVertices: this.wetWaterVertices,
      innerRadius: this.detailDistance - 32,
      outerRadius: this.layout.outerRadius,
      step: this.layout.step,
      viewDistance: this.viewDistance,
      waterFadeStart: Math.max(0, this.detailDistance - WATER_DETAIL_FADE_WIDTH),
      waterFadeEnd: this.detailDistance,
      horizonFadeStart: this.horizonFade.start.value,
      horizonFadeEnd: this.horizonFade.end.value,
      ringFadeStart: this.horizonFade.ring.start.value,
      ringFadeEnd: this.horizonFade.ring.end.value,
      building: this.building,
      ready: this.ready,
    };
  }

  dispose(): void {
    this.terrain.geometry.dispose();
    (this.terrain.material as THREE.Material).dispose();
    this.water.geometry.dispose();
    (this.water.material as THREE.Material).dispose();
  }
}
