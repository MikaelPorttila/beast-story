/**
 * Camera-following distant landscape.
 *
 * The playable world remains the 1 m voxel chunks built by chunk.ts. This is a
 * single coarse grid underneath and beyond them: one terrain draw and one water
 * draw carrying only the silhouette, broad biome colour and coastline. It is
 * the useful overlap of a terrain clipmap and HLOD for this generated world —
 * far geometry gets a player-selected 8-24 m sample step instead of the nearby
 * ground's 1 m columns, and no props, colliders, shadows, foam or waves.
 *
 * The grid is rebuilt in-place only after the focus crosses a 64 m cell. That
 * keeps an effectively unbounded procedural world centred without allocating
 * on the frame path or rebuilding every time the player moves.
 */
import * as THREE from 'three';
import { excludeFromAO } from '../core/types';
import { Terrain, WATER_LEVEL, makeScratch, smoothstep } from './terrain';
import { SURFACE_Y, WATER_DETAIL_FADE_WIDTH } from './water';

/** Shipped medium setting. Live choices replace these through configure(). */
const DEFAULT_VIEW_DISTANCE = 600;
const DEFAULT_DETAIL_DISTANCE = 160;
/**
 * Near water does not write depth (its own shader blends while staying in the
 * opaque AO list), so the far sheet cannot overlap it as freely as ground can.
 * Start outside the guaranteed detailed ring and dissolve across the fogged
 * rim; radial distance avoids revealing the streamer's chunk-square outline.
 */
/** Re-sample after four far-grid cells, not for every nearby chunk crossing. */
const SNAP = 64;

interface Layout {
  xz: Float32Array;
  index: Uint32Array;
  outerRadius: number;
  step: number;
}

interface FadeUniforms {
  start: { value: number };
  end: { value: number };
}

/**
 * Make the far underlay converge to the exact sky radiance before projection
 * clips it. The global fog uses view depth, which is right for aerial
 * perspective but shorter than true camera distance at the sides of a wide
 * frame; without this final radial dissolve, off-axis ground can reach the far
 * plane while still visibly green and draw a hard arc against the sky.
 *
 * This adds only two varyings/uniforms and a smoothstep to the two existing far
 * draws. No geometry, chunks, textures, allocations, or frame-loop work.
 */
function installHorizonFade(material: THREE.MeshBasicMaterial, fade: FadeUniforms): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.bsHorizonFadeStart = fade.start;
    shader.uniforms.bsHorizonFadeEnd = fade.end;
    shader.vertexShader = shader.vertexShader
      .replace('#include <fog_pars_vertex>', `#include <fog_pars_vertex>
varying float vBsCameraDistance;`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>
vBsCameraDistance = length(mvPosition.xyz);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <fog_pars_fragment>', `#include <fog_pars_fragment>
varying float vBsCameraDistance;
uniform float bsHorizonFadeStart;
uniform float bsHorizonFadeEnd;`)
      .replace('#include <fog_fragment>', `#include <fog_fragment>
#ifdef USE_FOG
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
  gl_FragColor.rgb = mix(
    gl_FragColor.rgb, bsSkyRadiance(vFogElev) * fogColor, bsHorizonFade * 0.65
  );
#endif`);
  };
  material.customProgramCacheKey = () => 'bs-distant-horizon-fade-v1';
}

function layoutFor(viewDistance: number): Layout {
  // Each outer radius is an exact multiple of its step. High spends roughly
  // nine times Medium's far vertices to keep the longer horizon from turning
  // into visibly large triangles; Low deliberately does the reverse.
  // One snap cell of reserve keeps the camera-following square beyond the
  // projection sphere even when its 64 m anchor is at the far side of a snap.
  // Medium's 12 m cells are the measured compromise for aerial coastlines: the
  // old 16 m wet/dry triangles exposed lakebed as large beige wedges once the
  // detailed water correctly dissolved, while 12 m costs ~12.8k vertices total
  // and still stays far below High's ~60k. Draw count remains unchanged.
  const [outerRadius, step] = viewDistance <= 480 ? [552, 24]
    : viewDistance >= 900 ? [976, 8] : [672, 12];
  const side = outerRadius * 2 / step + 1;
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
      index[k++] = a; index[k++] = c; index[k++] = d;
      index[k++] = a; index[k++] = d; index[k++] = b;
    }
  }
  return { xz, index, outerRadius, step };
}

function geometry(
  layout: Layout, position: Float32Array, color: Float32Array,
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  // Four components opt into three.js's vertex-alpha path as well as colour.
  geo.setAttribute('color', new THREE.BufferAttribute(color, 4));
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
  // Double-buffered CPU attributes: the visible mesh stays internally
  // consistent while a new far field is sampled over several frames.
  private nextTerrainPosition: Float32Array;
  private nextTerrainColor: Float32Array;
  private nextWaterPosition: Float32Array;
  private nextWaterColor: Float32Array;
  private readonly scratch = makeScratch();
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
  private readonly horizonFade: FadeUniforms;

  constructor(
    private readonly field: Terrain,
    focus: Readonly<THREE.Vector3>,
    viewDistance = DEFAULT_VIEW_DISTANCE,
    detailDistance = DEFAULT_DETAIL_DISTANCE,
  ) {
    this.viewDistance = viewDistance;
    this.detailDistance = detailDistance;
    // Preserve most of the selected range for silhouettes, then match the sky
    // by 86%. That leaves a real guard band for snap lag, camera height and the
    // projection plane instead of asking the last few pixels to do all the work.
    this.horizonFade = {
      start: { value: viewDistance * 0.66 },
      end: { value: viewDistance * 0.86 },
    };
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
      // A depthless opaque underlay: far ground first, far water second, then
      // detailed terrain and water overwrite both in the same opaque list.
      transparent: false,
      depthWrite: false,
      fog: true,
    });
    const waterMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      color: 0xffffff,
      // Far wetness used to be blended across each coarse triangle. That made
      // the lake bed show through as enormous grey wedges (issue #97). Alpha
      // test keeps the coastline mask but makes every surviving water pixel a
      // solid surface; near chunk water still supplies the transparent shore,
      // waves and foam over the top of it.
      transparent: false,
      alphaTest: 0.02,
      // This is an UNDERLAY, not an occluder. Near terrain is drawn afterwards
      // and must overwrite it, including the lakebed that detailed translucent
      // water blends over. Writing depth here made the coarse wet/dry mask win
      // that test and appear as huge dark pools and blue islands (issue #97).
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
    this.terrain.name = 'distant:terrain';
    this.terrain.renderOrder = -2;
    this.terrain.matrixAutoUpdate = false;
    this.water = excludeFromAO(new THREE.Mesh(waterGeo, waterMat));
    this.water.name = 'distant:water';
    this.water.renderOrder = -1;
    this.water.matrixAutoUpdate = false;
    // Sampling even Medium synchronously was a visible load hitch; High is nine
    // times that geometry. Keep both meshes hidden until buildStep has produced
    // one internally consistent field, and let World.streaming hold the loading
    // or zone handoff until then.
    this.terrain.visible = false;
    this.water.visible = false;
    this.requestUpdate(focus);
  }

  /** Queue a live far-geometry budget change; the old field stays until commit. */
  configure(
    viewDistance: number, detailDistance: number, focus: Readonly<THREE.Vector3>,
  ): void {
    if (viewDistance === this.viewDistance && detailDistance === this.detailDistance) return;
    this.viewDistance = viewDistance;
    this.detailDistance = detailDistance;
    this.horizonFade.start.value = viewDistance * 0.66;
    this.horizonFade.end.value = viewDistance * 0.86;
    const next = layoutFor(viewDistance);
    const count = next.xz.length / 2;
    this.nextLayout = next;
    this.nextTerrainPosition = new Float32Array(count * 3);
    this.nextTerrainColor = new Float32Array(count * 4);
    this.nextWaterPosition = new Float32Array(count * 3);
    this.nextWaterColor = new Float32Array(count * 4);
    // Keep the complete old HLOD visible while the replacement is sampled.
    // Swapping to empty High buffers here was both a synchronous setting hitch
    // and a frame of missing hills. commitPending replaces both meshes atomically.
    this.nextAnchorX = Math.floor(focus.x / SNAP) * SNAP;
    this.nextAnchorZ = Math.floor(focus.z / SNAP) * SNAP;
    this.nextVertex = 0;
    this.nextWetWaterVertices = 0;
  }

  /** Queue a new snapped centre. Sampling is paid by buildStep over later frames. */
  requestUpdate(focus: Readonly<THREE.Vector3>): void {
    const ax = Math.floor(focus.x / SNAP) * SNAP;
    const az = Math.floor(focus.z / SNAP) * SNAP;
    if ((ax === this.anchorX && az === this.anchorZ)
      || (ax === this.nextAnchorX && az === this.nextAnchorZ && this.nextVertex >= 0)) return;
    this.nextAnchorX = ax;
    this.nextAnchorZ = az;
    this.nextVertex = 0;
    this.nextWetWaterVertices = 0;
  }

  /** Spend at most this frame's small wall-clock slice on the pending centre. */
  buildStep(budgetMs: number): boolean {
    if (this.nextVertex < 0) return false;
    const end = performance.now() + budgetMs;
    const count = this.nextLayout.xz.length / 2;
    // Check the clock once per cache-friendly batch, not once per noise sample.
    do {
      const stop = Math.min(this.nextVertex + 32, count);
      while (this.nextVertex < stop) this.writeVertex(this.nextVertex++);
    } while (this.nextVertex < count && performance.now() < end);
    if (this.nextVertex < count) return false;
    this.commitPending();
    return true;
  }

  get building(): boolean { return this.nextVertex >= 0; }

  /**
   * Keep the far ground under any path that runs through this vertex's cell.
   *
   * THE HLOD CHORDS OVER A CORRIDOR. Near ground is a 1 m column and knows
   * exactly where a road is; this grid samples every 8-24 m, so one edge can
   * span a whole carriageway — and a straight line between two vertices on the
   * banks passes clean over the trench that was cut between them. Measured on
   * seed 1337 the day `test-road`'s own pattern was corrected so it could see
   * the far mesh at all: 168 of its samples had the clipmap drawn ABOVE the
   * ribbon, worst 0.313. It is the flat green wedge lying across the road in
   * the report, and it had never shown up in a number because the guard was
   * matching a mesh name nothing is called.
   *
   * A MINIMUM OVER THE CELL, not at the vertex. Clamping the vertex alone fixes
   * nothing: its neighbour is still high and the chord between them still
   * crosses. Taking the lowest corridor surface within half a step of BOTH ends
   * puts the whole edge under the deck by construction.
   *
   * Lowering is always safe here, which is what makes this cheap rather than
   * delicate: the HLOD is a permanent underlay and the near chunks are drawn
   * over it. Nothing walks on it and nothing collides with it.
   */
  private underPaths(wx: number, wz: number, y: number): number {
    const rf = this.field.roads;
    if (rf === null) return y;
    const h = this.nextLayout.step * 0.5;
    // Nine samples: the vertex, its four edge midpoints and its four corners.
    // A corridor crossing a cell at 45 degrees misses a plus-shaped stencil.
    const c = h * 0.7071;
    let out = y;
    for (const [dx, dz] of [
      [0, 0], [h, 0], [-h, 0], [0, h], [0, -h],
      [c, c], [c, -c], [-c, c], [-c, -c],
    ] as const) {
      const s = rf.drawnSurfaceAt(wx + dx, wz + dz, y);
      if (s < out) out = s;
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
      // columnInfo samples the centre of a column, hence the half-unit shift.
      this.field.columnInfo(wx - 0.5, wz - 0.5, this.scratch);
      const d = Math.hypot(lx, lz);
      const waterFade = smoothstep(
        Math.max(0, this.detailDistance - WATER_DETAIL_FADE_WIDTH), this.detailDistance, d,
      );

      this.nextTerrainPosition[p] = lx;
      this.nextTerrainPosition[p + 1] = this.underPaths(wx, wz, this.scratch.h - 0.08);
      this.nextTerrainPosition[p + 2] = lz;
      this.nextTerrainColor[c] = this.scratch.topR;
      this.nextTerrainColor[c + 1] = this.scratch.topG;
      this.nextTerrainColor[c + 2] = this.scratch.topB;
      // The HLOD is a permanent underlay. Near chunks are drawn later and
      // overwrite it; until those chunks finish, it fills the exact same hill
      // instead of exposing sky through a radius-based alpha hole.
      this.nextTerrainColor[c + 3] = 1;

      this.nextWaterPosition[p] = lx;
      this.nextWaterPosition[p + 1] = SURFACE_Y - 0.04;
      this.nextWaterPosition[p + 2] = lz;
      // Broad mid-distance blue only. The old navy fallback was far darker than
      // the reflective chunk shader and exposed the handoff as a huge circular
      // ink pool. Near chunks retain their depth ramp, foam and waves.
      this.nextWaterColor[c] = 0.035;
      this.nextWaterColor[c + 1] = 0.300;
      this.nextWaterColor[c + 2] = 0.560;
      const wetAlpha = this.scratch.h <= WATER_LEVEL ? waterFade * 0.92 : 0;
      this.nextWaterColor[c + 3] = wetAlpha;
      if (wetAlpha > 0) this.nextWetWaterVertices++;
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
    const terrainPos = this.terrain.geometry.getAttribute('position') as THREE.BufferAttribute;
    const terrainCol = this.terrain.geometry.getAttribute('color') as THREE.BufferAttribute;
    const waterPos = this.water.geometry.getAttribute('position') as THREE.BufferAttribute;
    const waterCol = this.water.geometry.getAttribute('color') as THREE.BufferAttribute;
    terrainPos.needsUpdate = true;
    terrainCol.needsUpdate = true;
    waterPos.needsUpdate = true;
    waterCol.needsUpdate = true;
    // MeshBasic deliberately needs no normals. Recomputing them over High's
    // camera-following grid every 64 m caused a recenter hitch and shaded each
    // coarse triangle as a separate sliced face on distant mountains.
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
