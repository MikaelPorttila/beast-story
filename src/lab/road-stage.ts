/**
 * THE ROAD SANDBOX — real voxel ground, real carve, one case at a time.
 *
 * `paths-stage.ts` builds a road over four lines of analytic arithmetic, which
 * is the right stage for a fence and the wrong one for a road. Every defect
 * this system has ever had is about the meeting of a SMOOTH ribbon with GROUND
 * MADE OF CUBES — a corner reaching into a corridor, a shoulder that rounds to
 * a different integer a metre away, a chord that spans a step — and none of it
 * can happen over a continuous field. So none of it was reproducible in the lab
 * and every one of them had to be chased in the streamed world: load, wait for
 * chunks, teleport, raycast, guess which of three roads on one seed happens to
 * contain the case you need.
 *
 * This builds a real `Terrain`, installs a real `RoadNetwork` on it, meshes the
 * chunks with the game's own mesher and draws the game's own ribbon. Nothing
 * here is a copy: the only thing the stage owns is WHICH ROAD, and the cases
 * are chosen to be the ones that break.
 *
 *   ?road=angle    a straight run at 45 degrees to the voxel grid. The
 *                  corner-first case: a cell reaches into the corridor by its
 *                  corner rather than its edge, and a top floored to an integer
 *                  stands through the gravel there.
 *   ?road=axis     the same run along +x. The control — if a reading differs
 *                  between these two, the cause is the grid and not the road.
 *   ?road=slope    up a hillside, so `round(deck)` flips as often as it can.
 *   ?road=bend     a curve, where consecutive rings face different ways.
 *   ?road=bridge   over water: the carve is off and the deck is held clear.
 *   ?road=fork     three arms and an apron.
 *   ?road=cross    four arms — a merged crossing.
 *   ?road=foot     the narrow profile, whose band is half the width.
 *   ?road=trail    the NO-CARVE profile on a hillside: a ribbon laid straight
 *                  on the voxel ground with no earthworks under it at all,
 *                  which is the case issue #142 calls a second machine.
 *   ?road=all      every one of them, spaced out around the origin.
 *
 * `__dbgRoadLab()` reports each case's deck so a probe can sweep it without
 * knowing how the stage was built. `tools/test-road-lab.mjs` is that probe.
 */
import * as THREE from 'three';
import { Terrain, WATER_LEVEL } from '../world/terrain';
import { buildTerrainMesh } from '../world/chunk';
import {
  RoadNetwork, mergeCrossings, profileRoad, profileTrail, setTrimEnd, setTrimStart,
  type Junction, type Road,
} from '../world/roads';
import {
  FOOTPATH_PROFILE, ROAD_PROFILE, TRAIL_PROFILE, type PathProfile,
} from '../world/path-profile';
import { buildJunctionApron, buildRoadRibbon } from '../world/town-parts';

/** The cases this stage knows. `?road=` picks one; `all` builds every one. */
export const ROAD_CASES = [
  'axis', 'angle', 'slope', 'bend', 'bridge', 'fork', 'cross', 'foot', 'trail',
] as const;

/** The seed the sandbox builds on. Fixed, so a case is the same every run. */
const LAB_SEED = 1337;
/** How far apart two cases are placed in `all`. Wider than any corridor. */
const SPACING = 90;

export interface RoadLabCase {
  readonly id: string;
  readonly roads: readonly Road[];
  readonly junctions: readonly Junction[];
  /** Where to point the camera. */
  readonly at: THREE.Vector3;
}

interface Built {
  readonly cases: readonly RoadLabCase[];
  /** The stage's own walking surface — `Terrain.getHeight`, the real one. */
  getHeight(x: number, z: number): number;
  /** What the `cross` case's merge did — nodes made, crossings refused. */
  readonly crossReport: { nodes: unknown[]; refused: string[] };
  dispose(): void;
}

/** A straight deck from a to b, profiled against the real height field. */
function straight(
  terrain: Terrain, id: string, profile: PathProfile,
  ax: number, az: number, bx: number, bz: number,
): Road {
  const step = profile.carve === 'none' ? 1 : 3;
  const n = Math.max(2, Math.round(Math.hypot(bx - ax, bz - az) / step));
  const route = Array.from({ length: n + 1 }, (_, i) => ({
    x: ax + ((bx - ax) * i) / n,
    z: az + ((bz - az) * i) / n,
  }));
  if (profile.carve === 'none') {
    return {
      id, fromId: `${id}:a`, toId: `${id}:b`, profile,
      pts: profileTrail(terrain, route),
      trim: new Float32Array(8),
    };
  }
  return {
    id,
    fromId: `${id}:a`,
    toId: `${id}:b`,
    profile,
    // ANCHORED AT BOTH ENDS to the ground they start and stop on, the same
    // thing `World.addPath` does for a free-standing path — otherwise the
    // raise-only limiter leaves the deck wherever the smoothing put it and the
    // case begins with a cliff that has nothing to do with what it is testing.
    pts: profileRoad(
      terrain, route, terrain.getHeight(ax, az), terrain.getHeight(bx, bz),
    ),
    trim: new Float32Array(8),
  };
}

/** An arc, for the case where consecutive rings face different ways. */
function arc(
  terrain: Terrain, id: string, profile: PathProfile,
  cx: number, cz: number, r: number, a0: number, a1: number,
): Road {
  const n = Math.max(4, Math.round((Math.abs(a1 - a0) * r) / 3));
  const route = Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return { x: cx + Math.sin(a) * r, z: cz + Math.cos(a) * r };
  });
  const first = route[0];
  const last = route[route.length - 1];
  return {
    id,
    fromId: `${id}:a`,
    toId: `${id}:b`,
    profile,
    pts: profileRoad(
      terrain, route,
      terrain.getHeight(first.x, first.z), terrain.getHeight(last.x, last.z),
    ),
    trim: new Float32Array(8),
  };
}

/**
 * Somewhere the ground climbs, and somewhere it is under water — found rather
 * than assumed, because the height field is noise and a hand-picked coordinate
 * is a coordinate that stops being right the day the noise is touched.
 */
function findGround(
  terrain: Terrain, want: 'slope' | 'water' | 'trail',
): { x: number; z: number } {
  let best = want === 'water' ? Infinity : -Infinity;
  let at = { x: 0, z: 0 };
  // CLEAR OF THE SLOT GRID. The cases that are PLACED sit within ~150 of the
  // origin, and a found one that landed among them would carve into a
  // neighbour — measured, the water search picked (-20, -20) and put a bridge
  // through the middle of the fork.
  for (let x = -900; x <= 900; x += 40) {
    for (let z = -900; z <= 900; z += 40) {
      if (Math.hypot(x, z) < 300) continue;
      if (want === 'trail') {
        // THE STEEPEST GROUND A TRAIL COULD ACTUALLY BE ON, which is not the
        // steepest ground. `slope` below picks the sharpest place on the seed
        // and that is a CLIFF — measured, a trail laid straight across it read
        // 401 columns of ground through the ribbon at 7.4 and an 11-unit step,
        // because a two-unit band of deck following a cliff face is a vertical
        // sheet. None of that is about trails; it is about there being no route
        // there at all, which is what switchbacks and stairs are for (§11).
        //
        // `steepnessAt` is the query §14 asks for and this is its first caller:
        // 0.35 is a one-in-three, which a hero can walk and a trail can exist
        // on, and taking the steepest UNDER that ceiling puts the case on the
        // hardest ground it is meant to handle.
        const g = terrain.steepnessAt(x, z);
        if (g <= 0.35 && g > best && terrain.heightCont(x, z) > WATER_LEVEL + 4) {
          best = g;
          at = { x, z };
        }
      } else if (want === 'slope') {
        const rise = Math.abs(terrain.heightCont(x + 30, z) - terrain.heightCont(x - 30, z));
        if (rise > best && terrain.heightCont(x, z) > WATER_LEVEL + 3) {
          best = rise;
          at = { x, z };
        }
      } else {
        const h = terrain.heightCont(x, z);
        if (h < WATER_LEVEL - 1 && h < best) { best = h; at = { x, z }; }
      }
    }
  }
  return at;
}

/**
 * Build one case, or all of them, into `scene`.
 *
 * ONE `Terrain` AND ONE `RoadNetwork` for the whole stage, because that is what
 * the game has: the carve is a property of the height field, so two cases in
 * one scene have to be far enough apart not to carve each other. `SPACING` is
 * wider than any corridor's blend.
 */
export function buildRoadStage(scene: THREE.Scene, which: string): Built {
  const terrain = new Terrain(LAB_SEED);
  const net = new RoadNetwork();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.95, metalness: 0,
  });
  const cases: RoadLabCase[] = [];
  /** What the crossing merge did, so the stage cannot fail quietly. */
  let crossReport: { nodes: unknown[]; refused: string[] } = { nodes: [], refused: [] };
  const geos: THREE.BufferGeometry[] = [];
  const want = (id: string): boolean => which === 'all' || which === id;

  const slope = findGround(terrain, 'slope');
  const water = findGround(terrain, 'water');
  const trailAt = findGround(terrain, 'trail');
  let slot = 0;
  /** Each case gets its own patch of world, clear of every other one's carve. */
  const origin = (): { x: number; z: number } => {
    // ON DRY LAND, and the check is not defensive tidiness. The slot grid lands
    // wherever the noise happens to be, and a case that comes down on the
    // waterline is silently a BRIDGE — `profileRoad` floors its wet samples
    // clear of the surface and flags them, the carve switches off underneath,
    // and the case stops testing what it is named for. Measured: `cross` at
    // (90, 0) came back with "the crossing lands on a bridge span" and the
    // sandbox's crossroads was quietly two separate roads.
    for (let tries = 0; tries < 24; tries++) {
      const k = slot++;
      const x = (k % 3) * SPACING - SPACING;
      const z = Math.floor(k / 3) * SPACING - SPACING;
      if (terrain.heightCont(x, z) > WATER_LEVEL + 3) return { x, z };
    }
    return { x: 0, z: 0 };
  };

  const add = (id: string, roads: Road[], junctions: Junction[], at: THREE.Vector3): void => {
    for (const r of roads) net.add(r);
    cases.push({ id, roads, junctions, at });
  };

  if (want('axis')) {
    const o = origin();
    add('axis', [straight(terrain, 'axis', ROAD_PROFILE, o.x - 30, o.z, o.x + 30, o.z)], [],
      new THREE.Vector3(o.x, 0, o.z));
  }
  if (want('angle')) {
    const o = origin();
    // 45 DEGREES EXACTLY, which is the worst case rather than a nice number:
    // the corridor's rim crosses every cell corner-first, so the amount of a
    // cell that reaches inside the rim is maximal.
    add('angle', [straight(terrain, 'angle', ROAD_PROFILE,
      o.x - 22, o.z - 22, o.x + 22, o.z + 22)], [], new THREE.Vector3(o.x, 0, o.z));
  }
  if (want('slope')) {
    add('slope', [straight(terrain, 'slope', ROAD_PROFILE,
      slope.x - 34, slope.z, slope.x + 34, slope.z)], [],
    new THREE.Vector3(slope.x, 0, slope.z));
  }
  if (want('bend')) {
    const o = origin();
    add('bend', [arc(terrain, 'bend', ROAD_PROFILE, o.x, o.z, 26, -0.9, 0.9)], [],
      new THREE.Vector3(o.x, 0, o.z));
  }
  if (want('bridge')) {
    add('bridge', [straight(terrain, 'bridge', ROAD_PROFILE,
      water.x - 40, water.z, water.x + 40, water.z)], [],
    new THREE.Vector3(water.x, 0, water.z));
  }
  if (want('foot')) {
    const o = origin();
    add('foot', [straight(terrain, 'foot', FOOTPATH_PROFILE,
      o.x - 20, o.z - 20, o.x + 20, o.z + 20)], [], new THREE.Vector3(o.x, 0, o.z));
  }
  if (want('trail')) {
    // ON THE HILLSIDE, because a trail that carves nothing is only interesting
    // where the ground is not flat — that is the whole of what §11 says makes
    // it a second machine. It shares the `slope` case's ground and runs across
    // it rather than along, so the two do not carve into each other (a trail
    // carves nothing, but the road beside it does).
    add('trail', [straight(terrain, 'trail', TRAIL_PROFILE,
      trailAt.x - 24, trailAt.z - 24, trailAt.x + 24, trailAt.z + 24)], [],
    new THREE.Vector3(trailAt.x, 0, trailAt.z));
  }
  if (want('fork') || want('cross')) {
    const o = origin();
    // A FORK IS THREE ARMS ON ONE NODE, and they have to be anchored to one
    // height or the apron is drawn at a height one of them disagrees with —
    // the same thing `JUNCTION_HOLD` buys the world's own fork.
    const y = terrain.getHeight(o.x, o.z);
    const arms = [0.4, 2.3, 4.2].map((a, i) => {
      const r = straight(terrain, `fork-${i}`, ROAD_PROFILE,
        o.x, o.z, o.x + Math.sin(a) * 34, o.z + Math.cos(a) * 34);
      r.pts[0].y = y;
      for (let k = 1; k < Math.min(7, r.pts.length); k++) {
        r.pts[k].y += (y - r.pts[0].y) * (1 - k / 7);
      }
      setTrimStart(r, o.x, o.z, Math.sin(a), Math.cos(a));
      return r;
    });
    add('fork', arms, [{ x: o.x, z: o.z, y, profile: ROAD_PROFILE }],
      new THREE.Vector3(o.x, 0, o.z));
  }

  net.build();
  terrain.roads = net;

  // A CROSSING IS MADE THE WAY THE EDITOR MAKES ONE, through `mergeCrossings`,
  // so the sandbox exercises the merge rather than a hand-built four-arm node.
  if (want('cross')) {
    const o = origin();
    const a = straight(terrain, 'cross-a', ROAD_PROFILE, o.x - 34, o.z, o.x + 34, o.z);
    const b = straight(terrain, 'cross-b', ROAD_PROFILE, o.x, o.z - 34, o.x, o.z + 34);
    // ONE HEIGHT AT THE CROSSING BEFORE THE MERGE IS ASKED. `mergeCrossings`
    // refuses two decks more than `MERGE_MAX_DROP` apart, and two roads
    // profiled independently against noise disagree by more than that as often
    // as not — measured, the first build of this case came back with the
    // crossing refused and the sandbox silently short of its junction. The
    // world does not have the problem because its arms share a node by
    // construction; a case that wants a crossroads has to arrange it.
    const mid = Math.round(b.pts.length / 2);
    const y = a.pts[Math.round(a.pts.length / 2)].y;
    for (let k = 0; k < b.pts.length; k++) {
      const w = Math.max(0, 1 - Math.abs(k - mid) / 6);
      b.pts[k].y += (y - b.pts[mid].y) * w;
    }
    net.add(a);
    net.add(b);
    crossReport = mergeCrossings(net, b);
    net.build();
    cases.push({
      id: 'cross',
      roads: net.roads.filter((r) => r.id.startsWith('cross-')),
      junctions: net.junctions.filter((j) => Math.hypot(j.x - o.x, j.z - o.z) < 20),
      at: new THREE.Vector3(o.x, 0, o.z),
    });
  }
  void setTrimEnd;

  // -- the ground, meshed with the game's own mesher -------------------------
  //
  // Only the chunks a case sits on. A chunk is 32 units and the carve reaches
  // 13, so one either side of a case's own span covers every column the road
  // touches.
  const built = new Set<string>();
  for (const c of cases) {
    const cx0 = Math.floor((c.at.x - 48) / 32);
    const cx1 = Math.floor((c.at.x + 48) / 32);
    const cz0 = Math.floor((c.at.z - 48) / 32);
    const cz1 = Math.floor((c.at.z + 48) / 32);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const key = `${cx},${cz}`;
        if (built.has(key)) continue;
        built.add(key);
        const m = buildTerrainMesh(cx, cz, terrain, mat);
        // The same name the streamer gives it, so a probe's "is the top hit
        // ground" test reads the same here as in the world.
        m.name = 'chunk:terrain';
        m.receiveShadow = true;
        scene.add(m);
        geos.push(m.geometry as THREE.BufferGeometry);
      }
    }
  }

  // -- the ribbons and the aprons, through the game's own builders -----------
  let bias = 0;
  const surfaceAt = (x: number, z: number): number => terrain.getHeight(x, z);
  const emit = (
    part: { pos: number[]; nrm: number[]; col: number[]; idx: number[] }, name: string,
  ): void => {
    if (part.idx.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(part.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(part.nrm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(part.col, 3));
    geo.setIndex(part.idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.receiveShadow = true;
    scene.add(mesh);
    geos.push(geo);
  };
  for (const road of net.roads) {
    if (!road.profile.roles.draw) continue;
    emit(
      buildRoadRibbon([road], LAB_SEED, surfaceAt, bias++ * 0.003, net.junctions),
      `road:${road.id}`,
    );
  }
  for (const j of net.junctions) {
    emit(buildJunctionApron(j, net.roads, LAB_SEED, surfaceAt, bias++ * 0.003), 'road:junction');
  }

  return {
    cases,
    crossReport,
    getHeight: (x: number, z: number) => terrain.getHeight(x, z),
    dispose(): void {
      for (const g of geos) g.dispose();
      geos.length = 0;
      mat.dispose();
    },
  };
}

/** Where a case wants the camera. */
export function roadCaseFraming(
  cases: readonly RoadLabCase[], which: string,
): { at: THREE.Vector3; dist: number } {
  const c = cases.find((q) => q.id === which) ?? cases[0];
  if (!c) return { at: new THREE.Vector3(), dist: 60 };
  return { at: c.at.clone(), dist: which === 'all' ? 200 : 46 };
}
