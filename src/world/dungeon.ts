/**
 * The Sunken Hold — the game's second ZONE, and a full `World` in its own right.
 *
 * It is deliberately NOT a reskin of the overworld. There is no terrain noise in
 * it, no water, no biomes, no props library and no shops: the whole place is a
 * bounded 160x160 rock mass with rooms and corridors cut out of it, generated
 * from its own seed. What it shares with `createWorld()` is the STREAMING SHAPE
 * — 32-unit chunks, staged builds against a per-frame millisecond budget, and a
 * load/unload radius pair with a gap in it — because that shape is what makes
 * arriving somewhere seamless, and it is worth having exactly once.
 *
 * Two consequences of the layout being a lookup table rather than noise:
 *
 *   - like `Terrain`, `getHeight` is a pure function of (seed, x, z), so a chunk
 *     can be thrown away and rebuilt bit-identically. Zone unloading is free.
 *   - the footprint is FINITE. Chunks outside it are never built, and the outer
 *     five columns of the footprint are a 26-unit rim of solid rock, so the
 *     bounded region is also the reachable one.
 *
 * The hold sits at a large coordinate offset so that it and the overworld can be
 * resident at the SAME TIME without intersecting — which is the whole point of
 * the preload band in zones.ts: the destination is built while the player is
 * still walking toward the gateway, in a place he cannot see.
 */
import * as THREE from 'three';
import { NO_CARRIERS, NO_SITE, type CelestialState, type World } from '../core/types';
import { CHUNK_SIZE } from './terrain';
import { NO_SAFE_ZONES } from './safe-zones';
import { hashCell, mulberry32 } from './noise';
import { perf } from '../core/profiler';

/**
 * Where the hold lives in world coordinates.
 *
 * Far enough that nothing about the overworld can reach it (the streamer's
 * unload radius is 6.5 chunks = 208 units, wild spawns despawn at ~90) and small
 * enough that float32 vertex data is unaffected — chunk meshes carry chunk-LOCAL
 * vertices with the offset in `mesh.position`, so the only float this number
 * ever enters is a position, where 8192 leaves ~0.001 of resolution.
 */
export const HOLD_ORIGIN_X = 8192;
export const HOLD_ORIGIN_Z = 8192;

/** Footprint, in columns. 160 = exactly 5 chunks, so no chunk is half-void. */
const GRID = 160;
/** Solid rock border, in columns. The hold's outer wall. */
const RIM = 5;

const FLOOR_Y = 0;
/**
 * Interior wall top.
 *
 * THREE, and both ends of that are constrained. It has to be above the hero's
 * jump apex — JUMP_VEL^2 / 2g = 1.61 units (player/index.ts) — or every wall in
 * the hold is a hop rather than a route. And it has to be low enough for the
 * CAMERA, which is the half that only shows up in a capture: the third-person
 * rig has no wall collision, it simply refuses to sink below the column it
 * happens to be over (see ThirdPersonCamera.update). At 6 units the camera sat
 * inside the rock behind the hero and the frame was a flat brown slab; at 3 it
 * rides up onto the wall top and looks down into the room, which is a readable
 * shot and, in play, a readable space.
 *
 * Walls stay CLIMBABLE (climbTopAt is terrain here, per the World contract) —
 * mantling onto the rock between two rooms is a shortcut, not a way out. The
 * rim is what bounds the place.
 */
const WALL_Y = 3;
/** Outer rim. 26 units of sheer rock; nothing is authored beyond it. */
const RIM_Y = 26;

/** Same 3 ms per rendered frame the overworld streamer spends. See world/index.ts. */
const BUILD_BUDGET_MS = 3;

// ---------------------------------------------------------------------------
// Palette. LINEAR radiance, like everything else that reaches a shader here —
// the comment on each says what it displays as after ACES at exposure 1.02.
// ---------------------------------------------------------------------------
const s2l = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lin = (hex: number): [number, number, number] => [
  s2l(((hex >> 16) & 255) / 255), s2l(((hex >> 8) & 255) / 255), s2l((hex & 255) / 255),
];
const FLOOR_RGB = lin(0x9a8f80);  // warm flagstone
// The walls are WARM, and that is a correction, not a preference. At a first
// pass they were a cool 0x6f6b73, and a captured corridor shot was 80% one flat
// blue-grey slab: a wall facing away from the sun receives nothing but the
// (deliberately cool) hemisphere fill, so a cool albedo on top of it has no hue
// left at all. Warm stone under a cool fill still reads as stone in shade.
const WALL_RGB = lin(0x8a7d6d);
const RIM_RGB = lin(0x5f584f);    // the outer mass, darker still
const MOSS_RGB = lin(0x5e6f4a);   // damp patches on the floor

/** Corner-AO ramp, same idea and same reasoning as world/chunk.ts. */
const AO = [0.42, 0.60, 0.80, 1.0];
const aoLevel = (s1: boolean, s2: boolean, c: boolean): number =>
  s1 && s2 ? 0 : 3 - ((s1 ? 1 : 0) + (s2 ? 1 : 0) + (c ? 1 : 0));
/**
 * Baked side-face shade by direction (0:+X, 1:-X, 2:+Z, 3:-Z), the INVERSE of
 * the sun's azimuth — see the long note in world/chunk.ts. Re-derive if
 * SUN_OFFSET moves.
 */
const SIDE_SHADE = [0.82, 1.22, 0.90, 1.18];
/**
 * Warm bounce added to each side direction, same index as SIDE_SHADE — and it
 * matters far more down here than it does on a hillside, because a dungeon is
 * MOSTLY side faces. The two anti-sun directions receive no direct light at
 * all, and a face lit only by a cool fill reads as a hole rather than as shade;
 * see the long note in world/chunk.ts. Physically the bounce arriving at a wall
 * has come off sunlit floor a metre away, so it is warm.
 */
const SIDE_BOUNCE = [0, 1, 0.4, 0.9];

// ---------------------------------------------------------------------------
// Floorplan
// ---------------------------------------------------------------------------

interface Room { x: number; z: number; hw: number; hh: number; }

export interface HoldPlan {
  seed: number;
  /** 1 = walkable, 0 = rock. Row-major GRID x GRID, LOCAL columns. */
  mask: Uint8Array;
  rooms: Room[];
  /** Crystal cluster anchors, local xz pairs. */
  crystals: number[];
  /** Entry room centre, local. The gateway stands on it. */
  gate: { x: number; z: number };
}

const carve = (mask: Uint8Array, x0: number, z0: number, x1: number, z1: number): void => {
  const ax = Math.max(RIM, Math.min(x0, x1));
  const bx = Math.min(GRID - RIM - 1, Math.max(x0, x1));
  const az = Math.max(RIM, Math.min(z0, z1));
  const bz = Math.min(GRID - RIM - 1, Math.max(z0, z1));
  for (let z = az; z <= bz; z++) {
    const row = z * GRID;
    for (let x = ax; x <= bx; x++) mask[row + x] = 1;
  }
};

/**
 * Nine rooms on a 3x3 lattice, every horizontal neighbour joined and the middle
 * column joined vertically — the smallest connection set that is provably
 * connected without needing a spanning-tree search.
 *
 * Corridors are NINE wide. Five was the first pass and it was wrong for a
 * reason that only shows up in a capture: the third-person camera sits ~7 units
 * behind the hero at chest height, so in a 5-wide corridor the wall opposite is
 * two metres from the lens and fills four fifths of the frame. Nine leaves the
 * camera something to see past, and still reads as a corridor rather than a
 * room.
 */
function makePlan(seed: number): HoldPlan {
  const rng = mulberry32(seed ^ 0x0d17);
  const mask = new Uint8Array(GRID * GRID);
  const rooms: Room[] = [];
  const CELL = 48;
  const OFF = 8;

  for (let gz = 0; gz < 3; gz++) {
    for (let gx = 0; gx < 3; gx++) {
      const cx = OFF + gx * CELL + CELL / 2 + Math.round((rng() - 0.5) * 8);
      const cz = OFF + gz * CELL + CELL / 2 + Math.round((rng() - 0.5) * 8);
      const hw = 8 + Math.round(rng() * 7);
      const hh = 8 + Math.round(rng() * 7);
      rooms.push({ x: cx, z: cz, hw, hh });
      carve(mask, cx - hw, cz - hh, cx + hw, cz + hh);
    }
  }

  const at = (gx: number, gz: number): Room => rooms[gz * 3 + gx];
  const corridor = (a: Room, b: Room): void => {
    // L-shaped, 9 wide, elbow at (b.x, a.z).
    carve(mask, a.x - 4, a.z - 4, b.x + 4, a.z + 4);
    carve(mask, b.x - 4, a.z - 4, b.x + 4, b.z + 4);
  };
  for (let gz = 0; gz < 3; gz++) {
    corridor(at(0, gz), at(1, gz));
    corridor(at(1, gz), at(2, gz));
  }
  corridor(at(1, 0), at(1, 1));
  corridor(at(1, 1), at(1, 2));

  // Crystal clusters: a few per room, never within 3 columns of a wall so a
  // cluster cannot end up half-buried in one.
  const crystals: number[] = [];
  for (const r of rooms) {
    const n = 2 + ((rng() * 3) | 0);
    for (let i = 0; i < n; i++) {
      crystals.push(
        r.x + Math.round((rng() - 0.5) * (r.hw - 3) * 2),
        r.z + Math.round((rng() - 0.5) * (r.hh - 3) * 2),
      );
    }
  }

  return { seed, mask, rooms, crystals, gate: { x: rooms[0].x, z: rooms[0].z } };
}

/** Column top in LOCAL coordinates. The whole height authority of the zone. */
function localHeight(plan: HoldPlan, lx: number, lz: number): number {
  if (lx < RIM || lz < RIM || lx >= GRID - RIM || lz >= GRID - RIM) return RIM_Y;
  return plan.mask[lz * GRID + lx] === 1 ? FLOOR_Y : WALL_Y;
}

// ---------------------------------------------------------------------------
// Chunk mesher: exposed faces of a three-valued heightfield, with per-vertex
// corner AO and per-cube tonal jitter. A pared-down cousin of world/chunk.ts —
// same signals, none of the biome/water machinery, because there are no biomes
// and no water down here.
// ---------------------------------------------------------------------------
function buildHoldChunk(
  cx: number, cz: number, plan: HoldPlan, material: THREE.Material,
): THREE.Mesh {
  const G = CHUNK_SIZE + 2;
  const hA = new Int16Array(G * G);
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  for (let lz = -1; lz <= CHUNK_SIZE; lz++) {
    for (let lx = -1; lx <= CHUNK_SIZE; lx++) {
      hA[(lz + 1) * G + (lx + 1)] = localHeight(plan, ox + lx, oz + lz);
    }
  }

  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const seed = plan.seed;

  /** Triangular per-cube jitter in [-1,1]; see world/chunk.ts for why not uniform. */
  const jitter = (x: number, y: number, z: number): number =>
    hashCell(seed, x, y, z) + hashCell(seed, x + 8191, y, z + 5077) - 1;

  const quad = (
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    qx: number, qy: number, qz: number, dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number, r: number, g: number, b: number,
    a0: number, a1: number, a2: number, a3: number,
  ): void => {
    const base = pos.length / 3;
    pos.push(ax, ay, az, bx, by, bz, qx, qy, qz, dx, dy, dz);
    nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    col.push(
      r * a0, g * a0, b * a0, r * a1, g * a1, b * a1,
      r * a2, g * a2, b * a2, r * a3, g * a3, b * a3,
    );
    if (a0 === a1 && a1 === a2 && a2 === a3) {
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      return;
    }
    // A gradient across a two-triangle quad creases along the split diagonal;
    // a centre vertex carrying the true bilinear average removes it. Same fix,
    // and same reason, as the overworld mesher.
    const am = (a0 + a1 + a2 + a3) * 0.25;
    pos.push((ax + qx) * 0.5, (ay + qy) * 0.5, (az + qz) * 0.5);
    nrm.push(nx, ny, nz);
    col.push(r * am, g * am, b * am);
    const m = base + 4;
    idx.push(base, base + 1, m, base + 1, base + 2, m, base + 2, base + 3, m, base + 3, base, m);
  };

  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const i = (lz + 1) * G + (lx + 1);
      const H = hA[i];
      const wx = ox + lx;
      const wz = oz + lz;
      const hE = hA[i + 1], hW = hA[i - 1], hS = hA[i + G], hN = hA[i - G];

      const body = H === FLOOR_Y ? FLOOR_RGB : H === WALL_Y ? WALL_RGB : RIM_RGB;
      let r = body[0], g = body[1], b = body[2];

      if (H === FLOOR_Y) {
        // Damp patches: a rare per-cube hash pick, so the moss scatters with no
        // grid and no tiling. The floor is the surface the camera spends the
        // most time on and one flat grey is what makes a room read as a texture
        // sample rather than a place.
        const sp = hashCell(seed, wx, 7, wz);
        if (sp > 0.90) {
          const w = 0.35 + (sp - 0.90) * 2;
          r += (MOSS_RGB[0] - r) * w;
          g += (MOSS_RGB[1] - g) * w;
          b += (MOSS_RGB[2] - b) * w;
        }
      }
      const jt = jitter(wx, H, wz);
      const hw = jitter(wx, H + 31, wz) * 0.05;
      const mt = 1 + jt * 0.05;
      r *= mt * (1 + hw); g *= mt; b *= mt * (1 - hw);

      const oE = hE > H, oW = hW > H, oS = hS > H, oN = hN > H;
      const oSE = hA[i + 1 + G] > H, oSW = hA[i - 1 + G] > H;
      const oNE = hA[i + 1 - G] > H, oNW = hA[i - 1 - G] > H;
      quad(
        lx, H, lz, lx, H, lz + 1, lx + 1, H, lz + 1, lx + 1, H, lz,
        0, 1, 0, r, g, b,
        AO[aoLevel(oW, oN, oNW)], AO[aoLevel(oW, oS, oSW)],
        AO[aoLevel(oE, oS, oSE)], AO[aoLevel(oE, oN, oNE)],
      );

      for (let dir = 0; dir < 4; dir++) {
        const nH = dir === 0 ? hE : dir === 1 ? hW : dir === 2 ? hS : hN;
        let hTA: number;
        let hTB: number;
        if (dir === 0) { hTA = hA[i + 1 - G]; hTB = hA[i + 1 + G]; }
        else if (dir === 1) { hTA = hA[i - 1 + G]; hTB = hA[i - 1 - G]; }
        else if (dir === 2) { hTA = hA[i + G + 1]; hTB = hA[i + G - 1]; }
        else { hTA = hA[i - G - 1]; hTB = hA[i - G + 1]; }

        for (let y = nH + 1; y <= H; y++) {
          // Strata: horizontal bands every 3 units, so a tall face reads as
          // stacked rock rather than as one painted flat.
          const band = 0.86 + hashCell(seed, Math.floor(y / 3), 977, 0) * 0.26;
          const j = jitter(wx, y, wz);
          const shade = SIDE_SHADE[dir] * (1 + j * 0.09) * band;
          // Per-cube hue wobble plus the direction's bounce term, on the r/b
          // axis. Value differences alone resolve as a grid; warmth differences
          // pool into "material", which is what a 6-voxel wall needs to stop
          // being one painted flat.
          const jw = jitter(wx, y + 31, wz) * 0.05 + SIDE_BOUNCE[dir] * 0.06;
          const br = body[0] * shade * (1 + jw);
          const bg = body[1] * shade;
          const bb = body[2] * shade * (1 - jw);
          const upA = AO[aoLevel(hTA >= y, false, hTA >= y + 1)];
          const upB = AO[aoLevel(hTB >= y, false, hTB >= y + 1)];
          const loA = AO[aoLevel(hTA >= y, nH >= y - 1, hTA >= y - 1)];
          const loB = AO[aoLevel(hTB >= y, nH >= y - 1, hTB >= y - 1)];
          const y0 = y - 1;
          if (dir === 0) {
            quad(lx + 1, y0, lz, lx + 1, y, lz, lx + 1, y, lz + 1, lx + 1, y0, lz + 1,
              1, 0, 0, br, bg, bb, loA, upA, upB, loB);
          } else if (dir === 1) {
            quad(lx, y0, lz + 1, lx, y, lz + 1, lx, y, lz, lx, y0, lz,
              -1, 0, 0, br, bg, bb, loA, upA, upB, loB);
          } else if (dir === 2) {
            quad(lx + 1, y0, lz + 1, lx + 1, y, lz + 1, lx, y, lz + 1, lx, y0, lz + 1,
              0, 0, 1, br, bg, bb, loA, upA, upB, loB);
          } else {
            quad(lx, y0, lz, lx, y, lz, lx + 1, y, lz, lx + 1, y0, lz,
              0, 0, -1, br, bg, bb, loA, upA, upB, loB);
          }
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(HOLD_ORIGIN_X + ox, 0, HOLD_ORIGIN_Z + oz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

// ---------------------------------------------------------------------------

interface HoldChunk { cx: number; cz: number; mesh: THREE.Mesh | null; }

const key = (cx: number, cz: number): number => cx * 64 + cz;

/**
 * Build the hold's crystal clusters as ONE merged mesh.
 *
 * Deliberately not streamed per chunk: there are ~90 shards in a bounded zone,
 * so the whole set is one draw call and one dispose.
 *
 * MERGED RATHER THAN INSTANCED, and that is a shader-cost decision, not a
 * drawing one. `USE_INSTANCING` is a program DEFINE, so an InstancedMesh needs
 * its own program for every light count it is ever drawn at — and three keys a
 * program on the number of visible lights. Measured on an RTX 3070 Ti: the
 * instanced version made the zone's warm-up sweep link one new program per step
 * at 74-220 ms of *CPU* each, i.e. ~1.6 s of freeze spread over the approach.
 * Merged, it draws with an ordinary mesh program that already exists.
 *
 * The whole lesson of this file's warm-up work in one line: a zone entered
 * mid-game should introduce no new program KEY. Geometry is free, materials are
 * not, and a define is what makes a material a material.
 */
function buildCrystals(plan: HoldPlan): { mesh: THREE.Mesh; dispose(): void } {
  const base = new THREE.OctahedronGeometry(0.42, 0).toNonIndexed();
  base.scale(1, 2.1, 1);
  const bp = base.getAttribute('position');
  const bn = base.getAttribute('normal');
  const vcount = bp.count;

  const rng = mulberry32(plan.seed ^ 0x7c3a);
  const m = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const t = new THREE.Vector3();

  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  // Vertex colour is the shard's own body; the emissive uniform does the
  // glowing. Two tones so a cluster is not one silhouette.
  const tint = [lin(0x2f6f8c), lin(0x27536b)];

  for (let i = 0; i < plan.crystals.length; i += 2) {
    const n = 2 + ((rng() * 3) | 0);
    for (let k = 0; k < n; k++) {
      const yaw = rng() * Math.PI;
      t.set(
        HOLD_ORIGIN_X + plan.crystals[i] + (rng() - 0.5) * 1.8,
        (rng() - 0.5) * 0.35 + 0.5,
        HOLD_ORIGIN_Z + plan.crystals[i + 1] + (rng() - 0.5) * 1.8,
      );
      e.set((rng() - 0.5) * 0.4, yaw, (rng() - 0.5) * 0.4);
      q.setFromEuler(e);
      s.setScalar(0.6 + rng() * 0.9);
      m.compose(t, q, s);
      nm.getNormalMatrix(m);
      const c = tint[k & 1];
      for (let j = 0; j < vcount; j++) {
        v.fromBufferAttribute(bp, j).applyMatrix4(m);
        pos.push(v.x, v.y, v.z);
        v.fromBufferAttribute(bn, j).applyMatrix3(nm).normalize();
        nrm.push(v.x, v.y, v.z);
        col.push(c[0], c[1], c[2]);
      }
    }
  }
  base.dispose();

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeBoundingSphere();

  // `vertexColors` + `emissive` is deliberately the same DEFINE SET as the
  // emissive batch a beast's voxel body uses (core/voxel.ts), which boot already
  // warms in both the lit pass and the selective-bloom pass. Colour, roughness
  // and emissive strength are uniforms and cost nothing; the define set is what
  // decides whether this material needs a program of its own.
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, emissive: 0x49d7ff, emissiveIntensity: 1.5,
    roughness: 0.25, metalness: 0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.matrixAutoUpdate = false;
  return { mesh, dispose: () => { geo.dispose(); mat.dispose(); } };
}

/**
 * Build the Sunken Hold as a `World`.
 *
 * Nothing outside ZoneManager should call this: it adds to the scene, and the
 * only thing that knows when to take it back out again is whatever owns the
 * zone.
 */
export function createDungeon(scene: THREE.Scene, seed = 0x5ea1ed): World {
  const plan = makePlan(seed);
  const stoneMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.92, metalness: 0,
  });
  const crystals = buildCrystals(plan);
  const fixtures = new THREE.Group();
  fixtures.add(crystals.mesh);

  /**
   * FOUR crystal lamps, and the number is not decoration.
   *
   * three keys a shader program on the number of visible lights in the scene,
   * so a zone whose standing light count differs from the one you came from
   * needs a fresh program for EVERY material at EVERY count it can reach. The
   * overworld carries four den lamps (world/shops.ts). Measured on an RTX
   * 3070 Ti with the hold carrying none: entering it made the warm-up sweep
   * link 47 programs at 110-360 ms of CPU each — about 2.2 s of freezing spread
   * across the approach, because counts 0-3 exist nowhere in the overworld and
   * had never been compiled. Matching the count moves the hold's range onto the
   * one boot already warmed and the same sweep links almost nothing.
   *
   * They are also, straightforwardly, what a lightless stone room needs. Placed
   * in the four corner rooms, cyan to match the shards, and NOT shadow-casting:
   * a second shadow map would cost far more than the light is worth.
   */
  for (const k of [0, 2, 6, 8]) {
    const r = plan.rooms[k];
    const lamp = new THREE.PointLight(0x7fe4ff, 5, 22, 2);
    lamp.position.set(HOLD_ORIGIN_X + r.x, FLOOR_Y + 2.6, HOLD_ORIGIN_Z + r.z);
    lamp.castShadow = false;
    fixtures.add(lamp);
  }
  scene.add(fixtures);

  const chunks = new Map<number, HoldChunk>();
  const queue: Array<{ cx: number; cz: number; d: number }> = [];
  const SPAN = GRID / CHUNK_SIZE; // 5
  /**
   * Streaming radii, in chunks. The same pair and the same GAP as the overworld
   * (world/index.ts): load inside 5, unload outside 6.5. The 1.5-chunk gap is
   * hysteresis — a player pacing across a chunk seam must not build and destroy
   * the same chunk on alternate frames. The hold is only 5x5, so in practice
   * every chunk is resident; the radii are here so the mechanism is the same
   * one, not a second one that has never been exercised.
   */
  const VIEW_RADIUS = 5;
  const UNLOAD_RADIUS = VIEW_RADIUS + 1.5;

  let lastCX = Infinity;
  let lastCZ = Infinity;
  let building: HoldChunk | null = null;
  let buildBudgetLeft = 0;
  let disposed = false;

  const spawnPoint = new THREE.Vector3(
    HOLD_ORIGIN_X + plan.gate.x + 0.5, FLOOR_Y, HOLD_ORIGIN_Z + plan.gate.z + 0.5,
  );
  /**
   * The hold has nobody living in it, so where a session would begin here is
   * simply the return gateway, facing into the room. Nothing starts a session
   * in the dungeon today — you arrive through a gateway, and `onArrive` places
   * the hero itself — so this exists to satisfy the contract honestly rather
   * than to be read. See World.playerStart.
   */
  const playerStart = { position: spawnPoint, yaw: 0 };

  const buildChunk = (rec: HoldChunk): void => {
    rec.mesh = buildHoldChunk(rec.cx, rec.cz, plan, stoneMat);
    scene.add(rec.mesh);
    perf.count('chunks');
  };

  const disposeChunk = (rec: HoldChunk): void => {
    if (!rec.mesh) return;
    scene.remove(rec.mesh);
    rec.mesh.geometry.dispose();
    rec.mesh = null;
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
        // The footprint is finite: outside it there is nothing to build, and
        // nowhere to stand either (localHeight returns the rim).
        if (cx < 0 || cz < 0 || cx >= SPAN || cz >= SPAN) continue;
        if (!chunks.has(key(cx, cz))) queue.push({ cx, cz, d });
      }
    }
    queue.sort((a, b) => a.d - b.d);
  };

  const unloadFar = (fcx: number, fcz: number): void => {
    const lim = UNLOAD_RADIUS * UNLOAD_RADIUS;
    for (const [k, rec] of chunks) {
      const dx = rec.cx - fcx;
      const dz = rec.cz - fcz;
      if (dx * dx + dz * dz > lim) {
        if (building === rec) building = null;
        disposeChunk(rec);
        chunks.delete(k);
      }
    }
  };

  return {
    // Far below the floor: there is no water in the hold, and every consumer
    // (the swim test, a beast's float height, the mount's wade depth) compares
    // against this, so it has to be somewhere nothing can reach.
    waterLevel: FLOOR_Y - 50,
    spawnPoint,
    playerStart,
    /** No skill dens down here yet. */
    shopPositions: [],
    /**
     * Nobody LIVES in the hold, so its registry is permanently empty. That is a
     * real answer rather than a stub: a quest that asks the active zone what
     * towns it has gets "none" and behaves, instead of the caller having to know
     * which zone it is in before it may ask.
     */
    towns: { all: [], roads: [], get: () => undefined, nearest: () => null },
    /**
     * And nowhere in it is safe: the hold has no settlement to keep monsters
     * out of, which is the point of it. Shared and immutable — see NO_SAFE_ZONES.
     */
    safeZones: NO_SAFE_ZONES,
    /**
     * And nobody stands in it either — null rather than an empty field, which
     * is the World contract's answer for "this zone has no people at all" and
     * costs the frame loop one null check instead of a scan of nothing.
     */
    npcs: null,
    // Nothing in the hold moves under your feet. See World.carriers.
    carriers: NO_CARRIERS,
    /**
     * ...and nothing may be built in it. The hold's geometry is authored by its
     * own plan and a camp hut dropped into it would belong to no room; the F3
     * spawner's structure branch reads this null and says so. See DebugSpawner.
     */
    debugSpawn: null,
    get chunksLoaded(): number { return chunks.size; },
    get streaming(): boolean { return building !== null || queue.length > 0; },
    get pendingChunks(): number { return queue.length + (building !== null ? 1 : 0); },

    getHeight(x: number, z: number): number {
      return localHeight(plan, Math.floor(x - HOLD_ORIGIN_X), Math.floor(z - HOLD_ORIGIN_Z));
    },
    /**
     * Rock is climbable-from, and rock is all there is: the contract's floor
     * ("never below getHeight") is also its ceiling here. Walls can therefore
     * be scaled with Shift, which is a shortcut between two rooms and not a way
     * out — the rim is 26 units and there is nothing on the far side of it.
     *
     * Returning the terrain exactly also means the hold has no one-way platforms
     * in it: the player's canopy support (see Player.canopyTop) only engages
     * where this stands CLEAR of getHeight, and here the two are the same number
     * by construction. Rock is solid from every side, which is what a wall
     * underground should be.
     */
    climbTopAt(x: number, z: number): number {
      return localHeight(plan, Math.floor(x - HOLD_ORIGIN_X), Math.floor(z - HOLD_ORIGIN_Z));
    },
    /** No trees underground. Walls are terrain, and terrain blocks already. */
    trunkSolidTopAt(): number { return -Infinity; },
    /**
     * No settlements either. The hold is cut out of rock, so everything solid
     * in it is already in the height field.
     */
    structureTopAt(): number { return -Infinity; },
    foliageSite: NO_SITE,
    /** No canopy either, so nothing here is ever brushed for leaves. */
    crownContactAt(): boolean { return false; },
    isWater(): boolean { return false; },
    /** ...so there is no deep sea in it either. See World.isDeepWater. */
    isDeepWater(): boolean { return false; },
    /** It does not snow in a hold cut out of rock. */
    snowCoverAt(): number { return 0; },
    /** Nothing grows in a hold cut out of rock, so there is nothing to part. */
    disturb(): void { /* no vegetation underground */ },
    /** Nothing but terrain here, and debugColliders deliberately excludes it. */
    debugColliders(): void { /* no discrete colliders in the hold */ },
    debugStructures(): void { /* nor any structure boxes */ },
    // Stone floors, not turf: nothing down here is worn by feet.
    debugWear: () => 0,
    debugColumn: () => 0,
    debugPaths: () => ({ paths: [], at: null }),
    debugCarriedStreets: () => ({ count: 0, paved: 0, clear: [] }),
    addPath: () => ({
      id: '', length: 0, samples: 0, note: null, nodes: [], refused: [],
      error: 'this zone has no path network',
    }),
    debugRidges(): void { /* nor any roofs */ },
    /** Nor any road furniture: the hold has no roads. */
    debugFurniture(): Array<{ kind: string; x: number; z: number }> { return []; },
    /** ...and no fences either. See World.debugFences. */
    debugFences(): ReturnType<World['debugFences']> { return []; },
    debugCarriedTrees(): Array<{ x: number; z: number }> { return []; },

    /** The enclosed hold has no sky, water, clouds or waterfall to retint. */
    applyCelestial(_state: Readonly<CelestialState>): void { /* intentionally enclosed */ },

    update(focus: THREE.Vector3, dt: number, newFrame = true): void {
      if (disposed) return;
      void dt;
      if (newFrame) buildBudgetLeft = BUILD_BUDGET_MS;
      const fcx = Math.floor((focus.x - HOLD_ORIGIN_X) / CHUNK_SIZE);
      const fcz = Math.floor((focus.z - HOLD_ORIGIN_Z) / CHUNK_SIZE);
      if (fcx !== lastCX || fcz !== lastCZ) {
        lastCX = fcx;
        lastCZ = fcz;
        refreshQueue(fcx, fcz);
        unloadFar(fcx, fcz);
      }
      // One chunk per pass here rather than the overworld's three stages: a
      // hold chunk has no props and no water, and measured it builds in 1-2 ms
      // — under the whole frame budget on its own, so there is nothing to split.
      while (buildBudgetLeft > 0 && queue.length > 0) {
        const t0 = performance.now();
        const q = queue.shift()!;
        const k = key(q.cx, q.cz);
        if (chunks.has(k)) continue;
        const rec: HoldChunk = { cx: q.cx, cz: q.cz, mesh: null };
        chunks.set(k, rec);
        building = rec;
        buildChunk(rec);
        building = null;
        buildBudgetLeft -= performance.now() - t0;
      }
    },

    /**
     * No-op, deliberately. The hold is hand-built rooms rather than streamed
     * chunks — none of the four layers the F3 panel names exists down here —
     * and the panel's settings are re-applied on the way back out (`onArrive`
     * in main.ts), so nothing is left in the wrong state.
     */
    setLayerVisible(): void { /* no streamed layers in the hold */ },
    setFoliageDistance(): void { /* no vegetation in the hold */ },
    setTerrainDistance(): void { /* an enclosed zone has no far landscape */ },
    debugDistantTerrain(): null { return null; },
    warmUpEffects(): void { /* the hold owns no visual effects of its own */ },
    debugSkyFall(): null { return null; }, // nothing flies in the hold

    /**
     * No-op: nothing grows in the hold, so there is no nature density that
     * could have changed under it. The overworld rebuilds itself on the way
     * back out only if something asked it to — see World.rebuildProps.
     */
    rebuildProps(): void { /* nothing grows down here */ },

    setVisible(v: boolean): void {
      for (const rec of chunks.values()) if (rec.mesh) rec.mesh.visible = v;
      // The crystal lamps live under `fixtures`, so this is also what takes the
      // hold's four point lights out of the scene's light count. See World.
      fixtures.visible = v;
    },

    /** Six chunks a frame, then the rest. See World.disposeStep. */
    disposeStep(): boolean {
      if (disposed) return true;
      let n = 6;
      for (const [k, rec] of chunks) {
        if (n <= 0) return false;
        n--;
        if (building === rec) building = null;
        disposeChunk(rec);
        chunks.delete(k);
      }
      this.dispose();
      return true;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const rec of chunks.values()) disposeChunk(rec);
      chunks.clear();
      queue.length = 0;
      scene.remove(fixtures);
      crystals.dispose();
      stoneMat.dispose();
    },
  };
}
