/**
 * World assembly: seeded terrain + chunk streaming + water + props +
 * skill dens + sky ambience, exposed through the shared World contract.
 */
import * as THREE from 'three';
import type { World } from '../core/types';
import { CHUNK_SIZE, Terrain, WATER_LEVEL, makeScratch } from './terrain';
import { buildTerrainMesh } from './chunk';
import { buildWaterMesh, createWaterMaterial } from './water';
import { PropLib, buildChunkProps, type Exclusion } from './props';
import { Shops, type DenSpot } from './shops';
import { Clouds, Motes } from './clouds';
import { mulberry32 } from './noise';

const VIEW_RADIUS = 5;
const UNLOAD_RADIUS = 6.5;

interface ChunkRec {
  cx: number;
  cz: number;
  meshes: THREE.Mesh[];
}

const chunkKey = (cx: number, cz: number): string => `${cx},${cz}`;

// ---------------------------------------------------------------------------
// Spawn search: scenic flat grass, above water, with water in walking range.
// ---------------------------------------------------------------------------
function findSpawn(terrain: Terrain): THREE.Vector3 {
  const sc = makeScratch();

  const score = (x: number, z: number): number => {
    terrain.columnInfo(x, z, sc);
    const h = sc.h;
    if (h < WATER_LEVEL + 1 || h > WATER_LEVEL + 5) return -Infinity;
    if (sc.biome !== 'plains' && sc.biome !== 'forest') return -Infinity;
    let maxDiff = 0;
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      const nh = terrain.getHeight(x + Math.cos(ang) * 4, z + Math.sin(ang) * 4);
      const d = Math.abs(nh - h);
      if (d > maxDiff) maxDiff = d;
    }
    if (maxDiff > 2) return -Infinity;
    let nearWater = false;
    outer:
    for (const rr of [10, 16, 24]) {
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        if (terrain.getHeight(x + Math.cos(ang) * rr, z + Math.sin(ang) * rr) < WATER_LEVEL) {
          nearWater = true;
          break outer;
        }
      }
    }
    return 100 - maxDiff * 8 + (nearWater ? 30 : 0) - Math.hypot(x, z) * 0.04;
  };

  let bestX = 0;
  let bestZ = 0;
  let bestS = -Infinity;
  for (let r = 0; r <= 320; r += 8) {
    const steps = r === 0 ? 1 : 14;
    for (let a = 0; a < steps; a++) {
      const ang = (a / steps) * Math.PI * 2 + r * 0.13;
      const x = Math.round(Math.cos(ang) * r);
      const z = Math.round(Math.sin(ang) * r);
      const s = score(x, z);
      if (s > bestS) {
        bestS = s;
        bestX = x;
        bestZ = z;
      }
    }
    if (bestS > 118) break; // flat, grassy, near water, close to origin
  }
  if (bestS === -Infinity) {
    // Relaxed fallback: any dry, reasonably flat land.
    for (let r = 0; r <= 320 && bestS === -Infinity; r += 6) {
      const steps = r === 0 ? 1 : 16;
      for (let a = 0; a < steps; a++) {
        const ang = (a / steps) * Math.PI * 2;
        const x = Math.round(Math.cos(ang) * r);
        const z = Math.round(Math.sin(ang) * r);
        const h = terrain.getHeight(x, z);
        if (h >= WATER_LEVEL + 1 && h <= WATER_LEVEL + 8) {
          bestX = x;
          bestZ = z;
          bestS = 0;
          break;
        }
      }
    }
  }
  return new THREE.Vector3(bestX + 0.5, terrain.getHeight(bestX, bestZ), bestZ + 0.5);
}

// ---------------------------------------------------------------------------
// Skill Den placement: 4 flattened plateaus on widening rings around spawn.
// ---------------------------------------------------------------------------

/**
 * Per-den ring radius. All four dens used to sit 13-20 units out, so every
 * pagoda was in frame at once and the world read as a diorama on a lawn rather
 * than a landscape with settlements in it. The first ring stays a short walk
 * from spawn (there must always be a reachable shop); the rest step out so
 * finding the next one is travel.
 */
const DEN_RINGS = [18, 34, 50, 66];
/** Squared minimum spacing between two dens, and between a den and spawn. */
const DEN_SEP2 = 27 * 27;
const DEN_SPAWN_SEP2 = 15 * 15;

function placeShops(terrain: Terrain, spawn: THREE.Vector3, seed: number): DenSpot[] {
  const rng = mulberry32(seed ^ 0x5158);
  const spots: DenSpot[] = [];

  const commit = (x: number, z: number): void => {
    const h = Math.max(Math.floor(terrain.heightCont(x, z)), WATER_LEVEL + 1);
    spots.push({ x, z, h });
    terrain.flattens.push({ x, z, h: h + 0.55, core: 4.5, blend: 9 });
  };

  for (let k = 0; k < 4; k++) {
    const baseAng = (k / 4) * Math.PI * 2 + 0.62;
    const ring = DEN_RINGS[k];
    let placed = false;
    // Wider angular window + more attempts than before: the outer rings have
    // far more water/cliff to dodge, and a den that fails to place snaps back
    // onto its ring anyway (see the fallback), so searching harder is cheap.
    for (let attempt = 0; attempt < 44 && !placed; attempt++) {
      const ang = baseAng + (rng() - 0.5) * 1.1;
      const dist = ring + (rng() - 0.5) * 9 + attempt * 0.5;
      const x = Math.round(spawn.x + Math.sin(ang) * dist) + 0.5;
      const z = Math.round(spawn.z + Math.cos(ang) * dist) + 0.5;
      const hc = terrain.heightCont(x, z);
      if (hc < WATER_LEVEL + 0.8) continue;
      const sx = x - spawn.x;
      const sz = z - spawn.z;
      if (sx * sx + sz * sz < DEN_SPAWN_SEP2) continue;
      let clear = true;
      for (const o of spots) {
        const dx = o.x - x;
        const dz = o.z - z;
        if (dx * dx + dz * dz < DEN_SEP2) { clear = false; break; }
      }
      if (!clear) continue;
      commit(x, z);
      placed = true;
    }
    if (!placed) {
      commit(
        Math.round(spawn.x + Math.sin(baseAng) * ring) + 0.5,
        Math.round(spawn.z + Math.cos(baseAng) * ring) + 0.5,
      );
    }
  }
  return spots;
}

// ---------------------------------------------------------------------------

export function createWorld(scene: THREE.Scene, seed = 20260729): World {
  const terrain = new Terrain(seed);
  const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  const waterMat = createWaterMaterial();
  const propLib = new PropLib();

  const spawnPoint = findSpawn(terrain);
  const spots = placeShops(terrain, spawnPoint, seed);
  const shops = new Shops(spots, spawnPoint);
  scene.add(shops.group);

  const clouds = new Clouds(seed);
  scene.add(clouds.group);
  const motes = new Motes(seed);
  motes.points.position.copy(spawnPoint);
  scene.add(motes.points);

  // 'solid' — these discs hold trees, boulders, hedges and logs off the spawn
  // clearing and the den decks, but grass, flowers and shells still carpet
  // them. A blanket exclusion left a ~20m bare plane right under the camera.
  const exclusions: Exclusion[] = [
    { x: spawnPoint.x, z: spawnPoint.z, kind: 'solid' },
    ...spots.map((s): Exclusion => ({ x: s.x, z: s.z, kind: 'solid' })),
  ];

  const chunks = new Map<string, ChunkRec>();
  const queue: Array<{ cx: number; cz: number; d: number }> = [];
  let lastCX = Infinity;
  let lastCZ = Infinity;
  let time = 0;
  let disposed = false;

  const buildChunk = (cx: number, cz: number): void => {
    const key = chunkKey(cx, cz);
    if (chunks.has(key)) return;
    const meshes: THREE.Mesh[] = [];
    meshes.push(buildTerrainMesh(cx, cz, terrain, terrainMat));
    const water = buildWaterMesh(cx, cz, terrain, waterMat);
    if (water) meshes.push(water);
    const props = buildChunkProps(cx, cz, terrain, propLib, exclusions);
    if (props.solid) meshes.push(props.solid);
    if (props.soft) meshes.push(props.soft);
    for (const m of meshes) scene.add(m);
    chunks.set(key, { cx, cz, meshes });
  };

  const disposeChunk = (rec: ChunkRec): void => {
    for (const m of rec.meshes) {
      scene.remove(m);
      m.geometry.dispose();
    }
  };

  const refreshQueue = (fcx: number, fcz: number): void => {
    queue.length = 0;
    const lim = (VIEW_RADIUS + 0.35) * (VIEW_RADIUS + 0.35);
    for (let dz = -VIEW_RADIUS; dz <= VIEW_RADIUS; dz++) {
      for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
        const d = dx * dx + dz * dz;
        if (d > lim) continue;
        const cx = fcx + dx;
        const cz = fcz + dz;
        if (!chunks.has(chunkKey(cx, cz))) queue.push({ cx, cz, d });
      }
    }
    queue.sort((a, b) => a.d - b.d);
  };

  const unloadFar = (fcx: number, fcz: number): void => {
    const lim = UNLOAD_RADIUS * UNLOAD_RADIUS;
    for (const [key, rec] of chunks) {
      const dx = rec.cx - fcx;
      const dz = rec.cz - fcz;
      if (dx * dx + dz * dz > lim) {
        disposeChunk(rec);
        chunks.delete(key);
      }
    }
  };

  // Synchronous 3x3 around spawn so the hero never falls through the floor.
  const scx = Math.floor(spawnPoint.x / CHUNK_SIZE);
  const scz = Math.floor(spawnPoint.z / CHUNK_SIZE);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) buildChunk(scx + dx, scz + dz);
  }

  return {
    waterLevel: WATER_LEVEL,
    spawnPoint,
    shopPositions: shops.positions,
    getHeight: (x: number, z: number): number => terrain.getHeight(x, z),
    isWater: (x: number, z: number): boolean => terrain.getHeight(x, z) < WATER_LEVEL,

    update(focus: THREE.Vector3, dt: number): void {
      if (disposed) return;
      time += dt;
      waterMat.uniforms['uTime'].value = time;
      clouds.update(focus, dt);
      motes.update(focus, time, dt);
      shops.update(time);

      const fcx = Math.floor(focus.x / CHUNK_SIZE);
      const fcz = Math.floor(focus.z / CHUNK_SIZE);
      if (fcx !== lastCX || fcz !== lastCZ) {
        lastCX = fcx;
        lastCZ = fcz;
        refreshQueue(fcx, fcz);
        unloadFar(fcx, fcz);
      }
      // Budgeted chunk builds: 2/frame while catching up, else 1.
      let budget = queue.length > 14 ? 2 : 1;
      while (budget > 0 && queue.length > 0) {
        const q = queue.shift()!;
        if (!chunks.has(chunkKey(q.cx, q.cz))) {
          buildChunk(q.cx, q.cz);
          budget--;
        }
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const rec of chunks.values()) disposeChunk(rec);
      chunks.clear();
      scene.remove(shops.group);
      shops.dispose();
      scene.remove(clouds.group);
      clouds.dispose();
      scene.remove(motes.points);
      motes.dispose();
      terrainMat.dispose();
      waterMat.dispose();
      propLib.dispose();
    },
  };
}
