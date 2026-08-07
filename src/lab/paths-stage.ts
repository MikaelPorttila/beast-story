/**
 * THE PATHS AND FENCES STAGE — a road, a bridge and a fence with no world.
 *
 * Every other way of looking at a fence or a bridge deck costs a whole world:
 * a game load routes roads across a 1337-seed terrain, streams chunks, waits
 * for props, and then you have to WALK to the one bridge it built to see what
 * you changed. That is thirty seconds a look and it cannot be aimed — the world
 * decides where the interesting geometry is.
 *
 * So this stage builds the same geometry from the same modules over a ground
 * field that is four lines of arithmetic:
 *
 *   - `groundAt` is an analytic height field, so a slope, a channel and a flat
 *     are all one formula and every demo is deterministic;
 *   - the road is a hand-written `RoadSample[]` following `profileRoad`'s own
 *     rule (lift the deck clear of the water where the ground is under it), so
 *     `buildRoadRibbon` and `addBridgeFurniture` see exactly what they see in
 *     the game;
 *   - the fences go through `buildFence` unchanged.
 *
 * NOTHING HERE IS A COPY of world code. If a demo needs a shape, it hands a
 * path to `world/fences.ts`; if it needs a deck, it hands samples to
 * `world/town-parts.ts`. The stage owns the GROUND and the camera, and that is
 * all — see rule 3 in LAB.md.
 *
 * `__dbgFence()` reports what was built, in world coordinates, which is what
 * `tools/test-fence.mjs` asserts the fence invariant over. A probe that had to
 * find a bridge in the real world first would be a probe that is mostly world
 * streaming.
 */
import * as THREE from 'three';
import { Accum, PropLib } from '../world/props';
import { SolidStamp, StructureField } from '../world/structures';
import { TownParts, addBridgeFurniture, buildRoadRibbon } from '../world/town-parts';
import { buildFence, type Fence, type FenceNode } from '../world/fences';
import type { Road, RoadSample } from '../world/roads';
import { WATER_LEVEL } from '../world/terrain';
import { DECK_EDGE } from '../world/roads';

/**
 * The stage's waterline IS the game's.
 *
 * Not a stage constant, and the first version that made it one is why this is
 * spelled out: `addBridgeFurniture` foots its piers at `WATER_LEVEL - 1.6`, so
 * a stage with its own sea level built a bridge with three stone piers floating
 * in the sky above it (`shots/_fence-bridge.png`, first pass). Anything the
 * stage shares with the world it is standing in for has to come from the world.
 */
const STAGE_WATER = WATER_LEVEL;
/** How high a deck rides over the water, the same 1.9 `profileRoad` uses. */
const DECK_OVER_WATER = 1.9;

/**
 * The stage's ground, in one function.
 *
 * A ridge along +x that a fence has to climb, and a channel across it at z ~ 0
 * that a road has to bridge. Both are smooth, because the point of the stage is
 * the fence and the deck rather than a terrain mesher.
 */
export function groundAt(x: number, z: number): number {
  const ridge = Math.sin(x * 0.11) * 2.4 + Math.sin(x * 0.31 + 1.3) * 0.6;
  const channel = -7.2 * Math.exp(-(z * z) / (2 * 9 * 9));
  return STAGE_WATER + 2.6 + ridge + channel;
}

/** The demos this stage knows. `?fence=` picks one; `all` builds every one. */
export const DEMOS = ['slope', 'turn', 'ring', 'gate', 'variants', 'bridge'] as const;

/** One demo's fence, labelled with the demo that asked for it. */
export interface LabelledFence {
  readonly label: string;
  readonly fence: Fence;
}

interface Built {
  readonly fences: LabelledFence[];
  readonly road: Road | null;
}

/**
 * Build one demo into `scene` and hand back what it made, for the debug hook.
 *
 * One `SolidStamp` for the lot: the merged mesh and the collision field are the
 * same pair the town builder makes, so a fence drawn here is a fence you could
 * walk into if the stage had a hero on it.
 */
export function buildPathsStage(
  scene: THREE.Scene, demo: string,
): Built & { dispose(): void } {
  const lib = new PropLib();
  const parts = new TownParts();
  const field = new StructureField();
  const solid = new SolidStamp(field);
  const glow = new Accum();
  const fences: LabelledFence[] = [];
  let road: Road | null = null;

  const want = (name: string): boolean => demo === 'all' || demo === name;

  // -- the ground ------------------------------------------------------------
  const ground = groundMesh();
  scene.add(ground);

  // -- fences ----------------------------------------------------------------
  /** A path along +x at `z`, seated on the ground, `n` samples over `len`. */
  const alongX = (z: number, len: number, n: number, x0 = -len / 2): FenceNode[] =>
    Array.from({ length: n + 1 }, (_, i) => {
      const x = x0 + (i / n) * len;
      return { x, y: groundAt(x, z), z };
    });

  if (want('slope')) {
    // Straight over the ridge: the case where the LINE moves under the fence.
    fences.push({
      label: 'slope',
      fence: buildFence(solid, parts.fence, alongX(-26, 40, 20), { groundAt }),
    });
  }
  if (want('turn')) {
    // A right angle with two long legs, so a corner post's fork has to bisect
    // it and both bays have to reach it.
    const corner: FenceNode[] = [];
    for (let i = 0; i <= 8; i++) {
      const x = -20 + i * 2.5;
      corner.push({ x, y: groundAt(x, -18), z: -18 });
    }
    for (let i = 1; i <= 8; i++) {
      const z = -18 + i * 2.5;
      corner.push({ x: 0, y: groundAt(0, z), z });
    }
    fences.push({
      label: 'turn', fence: buildFence(solid, parts.fence, corner, { groundAt }),
    });
  }
  if (want('ring')) {
    // A closed ring: the last bay joins the last post to the first, with no
    // seam and no double post.
    const ring: FenceNode[] = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const x = 22 + Math.sin(a) * 8;
      const z = -18 + Math.cos(a) * 8;
      ring.push({ x, y: groundAt(x, z), z });
    }
    fences.push({
      label: 'ring',
      fence: buildFence(solid, parts.fence, ring, { closed: true, groundAt }),
    });
  }
  if (want('gate')) {
    // A refused bay in the middle: both posts stand, the planks do not. This is
    // what a run meeting a road looks like.
    fences.push({
      label: 'gate',
      fence: buildFence(solid, parts.fence, alongX(-32, 36, 18), {
        groundAt,
        accept: (ax, _az, bx) => !(ax > -6 && bx < 6),
      }),
    });
  }
  if (want('variants')) {
    // Every post variant on one run, lanterns included.
    fences.push({
      label: 'variants',
      fence: buildFence(solid, parts.fence, alongX(24, 30, 15), {
        groundAt, lanternEvery: 4, tallEvery: 2, glow,
      }),
    });
  }

  // -- the road, and the bridge over the channel -----------------------------
  if (want('bridge')) {
    road = stageRoad();
    const rib = buildRoadRibbon([road], 7, groundAt);
    if (rib.idx.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(rib.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(rib.nrm, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(rib.col, 3));
      geo.setIndex(rib.idx);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, lib.solidMat);
      mesh.name = 'road:lab';
      scene.add(mesh);
    }
    // LABELLED as a railing, because a railing is the one fence whose posts
    // stand on a DECK: the ground under them is the river bed, so the "no post
    // hangs over its own ground" check that every other demo must pass is not
    // a statement about this one. See `buildFence`'s `maxDrop`.
    for (const fence of addBridgeFurniture(solid, parts, road, groundAt)) {
      fences.push({ label: 'bridge', fence });
    }
    scene.add(waterMesh());
  }

  // -- one merged mesh, exactly as a town emits one ---------------------------
  const solidGeo = solid.acc.toGeometry();
  if (solidGeo) {
    const mesh = new THREE.Mesh(solidGeo, lib.solidMat);
    mesh.name = 'lab:fences';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  const glowGeo = glow.toGeometry();
  let glowMat: THREE.MeshStandardMaterial | null = null;
  if (glowGeo) {
    glowMat = new THREE.MeshStandardMaterial({
      vertexColors: true, emissive: 0xffffff, emissiveIntensity: 1.8, roughness: 1,
    });
    scene.add(new THREE.Mesh(glowGeo, glowMat));
  }

  return {
    fences,
    road,
    dispose(): void {
      solidGeo?.dispose();
      glowGeo?.dispose();
      glowMat?.dispose();
      lib.dispose();
    },
  };
}

/**
 * A road along +z through the channel, profiled the way `profileRoad` profiles
 * one: the deck follows the ground, is smoothed, and wherever the natural
 * ground is under the waterline it is held `DECK_OVER_WATER` above it and the
 * sample is flagged as a span.
 *
 * Sampled every 3 units, which is the router's own `SEG_LEN` — and the interval
 * the old railing code mistook for a railing's length.
 */
function stageRoad(): Road {
  const pts: RoadSample[] = [];
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const z = -36 + i * 3;
    const nat = groundAt(0, z);
    const wet = nat < STAGE_WATER + 0.35;
    pts.push({ x: 0, z, y: 0, bridge: wet });
  }
  // Deck: the higher of the ground and the clearance, then smoothed, so the
  // approach ramps into the span instead of stepping onto it.
  const raw = pts.map((p) => Math.max(groundAt(p.x, p.z), STAGE_WATER + DECK_OVER_WATER));
  for (let pass = 0; pass < 6; pass++) {
    for (let i = 1; i < raw.length - 1; i++) {
      raw[i] = (raw[i - 1] + raw[i] * 2 + raw[i + 1]) / 4;
    }
  }
  for (let i = 0; i < pts.length; i++) pts[i].y = raw[i];
  // The span is WIDENED by one sample either side, as `profileRoad` widens it,
  // so the abutment is deck rather than a half-carved notch in the bank.
  const wide = pts.map((p) => p.bridge);
  for (let i = 0; i < pts.length; i++) {
    if (!wide[i]) continue;
    if (i > 0) pts[i - 1].bridge = true;
    if (i < pts.length - 1) pts[i + 1].bridge = true;
  }
  const a = pts[0];
  const b = pts[pts.length - 1];
  return {
    id: 'lab', fromId: 'lab:a', toId: 'lab:b', pts,
    trim: new Float32Array([a.x, a.z, 0, 1, b.x, b.z, 0, -1]),
  };
}

/** The stage floor, sampled off `groundAt`. Coarse on purpose: it is a stage. */
function groundMesh(): THREE.Mesh {
  const size = 96;
  const seg = 96;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const col: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, groundAt(x, z));
    const shade = 0.82 + ((Math.floor(x) + Math.floor(z)) % 2) * 0.06;
    col.push(0.36 * shade, 0.44 * shade, 0.24 * shade);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }),
  );
  mesh.name = 'lab:ground';
  mesh.receiveShadow = true;
  return mesh;
}

/** A flat pane at `STAGE_WATER`, so a bridge is visibly over water. */
function waterMesh(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(96, 96);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      color: 0x2f6d86, roughness: 0.3, transparent: true, opacity: 0.75,
    }),
  );
  mesh.position.y = STAGE_WATER;
  mesh.name = 'lab:water';
  return mesh;
}

/** Where a demo wants the camera, so `?fence=` frames itself. */
export function stageFraming(demo: string): { at: THREE.Vector3; dist: number } {
  switch (demo) {
    case 'bridge': return { at: new THREE.Vector3(0, STAGE_WATER + 2, 0), dist: 34 };
    case 'ring': return { at: new THREE.Vector3(22, STAGE_WATER + 3, -18), dist: 26 };
    case 'turn': return { at: new THREE.Vector3(-8, STAGE_WATER + 3, -10), dist: 30 };
    case 'variants': return { at: new THREE.Vector3(0, STAGE_WATER + 3, 24), dist: 26 };
    case 'gate': return { at: new THREE.Vector3(0, STAGE_WATER + 3, -32), dist: 30 };
    case 'all': return { at: new THREE.Vector3(0, STAGE_WATER + 2, 0), dist: 64 };
    default: return { at: new THREE.Vector3(0, STAGE_WATER + 3, -26), dist: 30 };
  }
}

/** The deck's own half-width, for a probe that wants to aim at a railing. */
export const STAGE_DECK_EDGE = DECK_EDGE;
