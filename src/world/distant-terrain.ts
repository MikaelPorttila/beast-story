/**
 * Camera-following distant landscape.
 *
 * The playable world remains the 1 m voxel chunks built by chunk.ts. This is a
 * single 16 m grid underneath and beyond them: one terrain draw and one water
 * draw carrying only the silhouette, broad biome colour and coastline. It is
 * the useful overlap of a terrain clipmap and HLOD for this generated world —
 * far geometry gets 1/256 of the nearby ground's horizontal resolution and no
 * props, colliders, shadows, foam or waves.
 *
 * The grid is rebuilt in-place only after the focus crosses a 64 m cell. That
 * keeps an effectively unbounded procedural world centred without allocating
 * on the frame path or rebuilding every time the player moves.
 */
import * as THREE from 'three';
import { excludeFromAO } from '../core/types';
import { Terrain, WATER_LEVEL, makeScratch, smoothstep } from './terrain';
import { SURFACE_Y, WATER_DETAIL_FADE_END, WATER_DETAIL_FADE_START } from './water';

/** The detailed stream reaches about 160 m; overlap hides its irregular rim. */
const INNER_RADIUS = 128;
/** Fully opaque before the nearest streamed chunks can end on an axis. */
const FADE_END = 192;
/**
 * Near water does not write depth (its own shader blends while staying in the
 * opaque AO list), so the far sheet cannot overlap it as freely as ground can.
 * Start outside the guaranteed detailed ring and dissolve across the fogged
 * rim; radial distance avoids revealing the streamer's chunk-square outline.
 */
/** Beyond the camera's 600 m far plane, so its square edge can never appear. */
const OUTER_RADIUS = 640;
/** 16 m rather than the near terrain's 1 m columns: 256x fewer ground cells. */
const STEP = 16;
/** Re-sample after four far-grid cells, not for every nearby chunk crossing. */
const SNAP = 64;

interface Layout {
  xz: Float32Array;
  index: Uint32Array;
}

function makeLayout(): Layout {
  const side = OUTER_RADIUS * 2 / STEP + 1;
  const xz = new Float32Array(side * side * 2);
  let v = 0;
  for (let z = -OUTER_RADIUS; z <= OUTER_RADIUS; z += STEP) {
    for (let x = -OUTER_RADIUS; x <= OUTER_RADIUS; x += STEP) {
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
  return { xz, index };
}

const LAYOUT = makeLayout();

function geometry(position: Float32Array, color: Float32Array): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  // Four components opt into three.js's vertex-alpha path as well as colour.
  geo.setAttribute('color', new THREE.BufferAttribute(color, 4));
  geo.setIndex(new THREE.BufferAttribute(LAYOUT.index, 1));
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
}

export class DistantTerrain {
  readonly terrain: THREE.Mesh;
  readonly water: THREE.Mesh;

  private readonly terrainPosition = new Float32Array(LAYOUT.xz.length / 2 * 3);
  private readonly terrainColor = new Float32Array(LAYOUT.xz.length / 2 * 4);
  private readonly waterPosition = new Float32Array(LAYOUT.xz.length / 2 * 3);
  private readonly waterColor = new Float32Array(LAYOUT.xz.length / 2 * 4);
  // Double-buffered CPU attributes: the visible mesh stays internally
  // consistent while a new far field is sampled over several frames.
  private readonly nextTerrainPosition = new Float32Array(this.terrainPosition.length);
  private readonly nextTerrainColor = new Float32Array(this.terrainColor.length);
  private readonly nextWaterPosition = new Float32Array(this.waterPosition.length);
  private readonly nextWaterColor = new Float32Array(this.waterColor.length);
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

  constructor(private readonly field: Terrain, focus: Readonly<THREE.Vector3>) {
    const terrainGeo = geometry(this.terrainPosition, this.terrainColor);
    const waterGeo = geometry(this.waterPosition, this.waterColor);
    const terrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    const waterMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      fog: true,
    });

    this.terrain = excludeFromAO(new THREE.Mesh(terrainGeo, terrainMat));
    this.terrain.name = 'distant:terrain';
    this.terrain.renderOrder = -2;
    this.terrain.matrixAutoUpdate = false;
    this.water = excludeFromAO(new THREE.Mesh(waterGeo, waterMat));
    this.water.name = 'distant:water';
    this.water.renderOrder = -1;
    this.water.matrixAutoUpdate = false;
    this.rebuildNow(focus);
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
    const count = LAYOUT.xz.length / 2;
    // Check the clock once per cache-friendly batch, not once per noise sample.
    do {
      const stop = Math.min(this.nextVertex + 32, count);
      while (this.nextVertex < stop) this.writeVertex(this.nextVertex++);
    } while (this.nextVertex < count && performance.now() < end);
    if (this.nextVertex < count) return false;
    this.commitPending();
    return true;
  }

  private rebuildNow(focus: Readonly<THREE.Vector3>): void {
    this.nextAnchorX = Math.floor(focus.x / SNAP) * SNAP;
    this.nextAnchorZ = Math.floor(focus.z / SNAP) * SNAP;
    this.nextVertex = 0;
    this.nextWetWaterVertices = 0;
    const count = LAYOUT.xz.length / 2;
    while (this.nextVertex < count) this.writeVertex(this.nextVertex++);
    this.commitPending();
  }

  private writeVertex(v: number): void {
      const i = v * 2;
      const p = v * 3;
      const c = v * 4;
      const lx = LAYOUT.xz[i];
      const lz = LAYOUT.xz[i + 1];
      const wx = this.nextAnchorX + lx;
      const wz = this.nextAnchorZ + lz;
      // columnInfo samples the centre of a column, hence the half-unit shift.
      this.field.columnInfo(wx - 0.5, wz - 0.5, this.scratch);
      const d = Math.hypot(lx, lz);
      const fade = smoothstep(INNER_RADIUS, FADE_END, d);
      const waterFade = smoothstep(WATER_DETAIL_FADE_START, WATER_DETAIL_FADE_END, d);

      this.nextTerrainPosition[p] = lx;
      this.nextTerrainPosition[p + 1] = this.scratch.h - 0.08;
      this.nextTerrainPosition[p + 2] = lz;
      this.nextTerrainColor[c] = this.scratch.topR;
      this.nextTerrainColor[c + 1] = this.scratch.topG;
      this.nextTerrainColor[c + 2] = this.scratch.topB;
      this.nextTerrainColor[c + 3] = fade;

      this.nextWaterPosition[p] = lx;
      this.nextWaterPosition[p + 1] = SURFACE_Y - 0.04;
      this.nextWaterPosition[p + 2] = lz;
      // Broad, dark water only. Near chunks retain their depth ramp, foam and
      // waves; at this distance those details alias and cost more than they say.
      this.nextWaterColor[c] = 0.018;
      this.nextWaterColor[c + 1] = 0.115;
      this.nextWaterColor[c + 2] = 0.260;
      const wetAlpha = this.scratch.h <= WATER_LEVEL ? waterFade * 0.92 : 0;
      this.nextWaterColor[c + 3] = wetAlpha;
      if (wetAlpha > 0) this.nextWetWaterVertices++;
  }

  private commitPending(): void {
    this.anchorX = this.nextAnchorX;
    this.anchorZ = this.nextAnchorZ;
    this.wetWaterVertices = this.nextWetWaterVertices;
    this.terrainPosition.set(this.nextTerrainPosition);
    this.terrainColor.set(this.nextTerrainColor);
    this.waterPosition.set(this.nextWaterPosition);
    this.waterColor.set(this.nextWaterColor);
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
    this.terrain.geometry.computeVertexNormals();
    (this.terrain.geometry.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true;
    this.terrain.geometry.computeBoundingSphere();
    this.water.geometry.computeBoundingSphere();
    this.terrain.visible = this.shown;
    this.water.visible = this.shown && this.waterShown;
    this.nextVertex = -1;
  }

  setVisible(shown: boolean): void {
    this.shown = shown;
    this.terrain.visible = shown;
    this.water.visible = shown && this.waterShown;
  }

  setWaterVisible(shown: boolean): void {
    this.waterShown = shown;
    this.water.visible = this.shown && shown;
  }

  debug(): DistantTerrainDebug {
    return {
      anchor: [this.anchorX, this.anchorZ],
      terrainVertices: this.terrainPosition.length / 3,
      waterVertices: this.waterPosition.length / 3,
      wetWaterVertices: this.wetWaterVertices,
      innerRadius: INNER_RADIUS,
      outerRadius: OUTER_RADIUS,
      step: STEP,
    };
  }

  dispose(): void {
    this.terrain.geometry.dispose();
    (this.terrain.material as THREE.Material).dispose();
    this.water.geometry.dispose();
    (this.water.material as THREE.Material).dispose();
  }
}
