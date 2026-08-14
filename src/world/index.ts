/**
 * World assembly: seeded terrain + chunk streaming + water + props +
 * skill dens + sky ambience, exposed through the shared World contract.
 */
import * as THREE from "three";
import type {
  CelestialState,
  CrownContact,
  NpcField,
  NpcInfo,
  NpcTalk,
  PlayerStart,
  TownInfo,
  TownRegistry,
  World,
  WorldLayer,
} from "../core/types";
import { excludeFromAO } from "../core/types";
import { CarrierField } from "./carriers";
import { ISLAND_KEEL, SkyIsland, readCarriedTown } from "./sky-island";
import { CHUNK_SIZE, DEEP_WATER_TOP, Terrain, WATER_LEVEL, makeScratch } from "./terrain";
import { buildTerrainMesh, buildTerrainMeshSteps } from "./chunk";
import { DistantTerrain, makeHorizonFade } from "./distant-terrain";
import { buildWaterMesh, createWaterMaterial, setWaterDetailDistance } from "./water";
import {
  PropLib,
  buildChunkProps,
  buildChunkPropsSteps,
  TREE_STRIDE,
  type ChunkProps,
  type Exclusion,
} from "./props";
import { Shops, type DenSpot } from "./shops";
import { Waypoints, waypointSites, WAYPOINT_PLATE_R, type WaypointSite } from "./waypoints";
import { SPUR_PROFILE } from "./path-profile";
import { levelPad, roadIntrusion } from "./placement";
import { SiteFields } from "./structures";
import { Towns, planSettlements, type SettlementPlan } from "./towns";
import {
  findCrossings,
  mergeCrossings,
  profileRoad,
  roadLength,
  routeRoad,
  runCrossesAny,
  type Road,
} from "./roads";
import { FOOTPATH_PROFILE, ROAD_PROFILE, TRAIL_PROFILE, type PathProfile } from "./path-profile";
import { TownParts } from "./town-parts";
import { Npcs, spotIsFree, type NpcSite } from "./npc";
import { SpawnedSolids } from "./spawned";
import { Clouds } from "./clouds";
import { SwayField } from "./sway";
import { mulberry32 } from "./noise";
import { DEN_NO_SPAWN_RADIUS, SafeZoneField } from "./safe-zones";
import { perf } from "../core/profiler";
import { flags } from "../core/flags";
import {
  invalidateStaticShadows,
  invalidateStaticShadowsNear,
  markStaticShadowCaster,
} from "../core/shadow-cache";

/** Rounded for a probe to compare as text; a non-finite reading stays Infinity. */
const num = (v: number): number => (Number.isFinite(v) ? +v.toFixed(3) : Infinity);

/** The refusal shape `addPath` answers with — an empty path plus the reason. */
const no = (error: string) => ({
  id: "",
  length: 0,
  samples: 0,
  note: null,
  nodes: [],
  refused: [],
  crossings: 0,
  error,
});

const DEFAULT_VIEW_RADIUS = 5;
/** Chunk-build wall-clock budget per RENDERED frame, ms. */
const BUILD_BUDGET_MS = 3;

interface ChunkRec {
  cx: number;
  cz: number;
  meshes: THREE.Mesh[];
  propsBuilt: boolean;
}

const chunkKey = (cx: number, cz: number): string => `${cx},${cz}`;

/**
 * NUMERIC chunk key for the trunk registry: `climbTopAt` runs per frame and must
 * allocate no template literal. Injective for |cz| < 2^21 chunks.
 */
const trunkKey = (cx: number, cz: number): number => cx * 4194304 + cz;

/**
 * How far outside its chunk a trunk's disc can reach. A tree lives in the bucket
 * of the chunk that PLACED it, so a seam tree must be findable from next door;
 * the widest either query asks about is ~1.44 (broad oak at max girth).
 */
const TRUNK_MARGIN = 2;

/** The same for the CROWN, whose widest reach is 5.28 (broad oak at max girth). */
const CROWN_MARGIN = 6;

// Spawn search: scenic flat grass, above water, water in walking range.
// SUPERSEDED by `pickRoadSpawn` (towns.ts); kept as the fallback for a zone with
// no road network, or a planner spot somehow in the water.
function findSpawn(terrain: Terrain): THREE.Vector3 {
  const sc = makeScratch();

  const score = (x: number, z: number): number => {
    terrain.columnInfo(x, z, sc);
    const h = sc.h;
    if (h < WATER_LEVEL + 1 || h > WATER_LEVEL + 5) {
      return -Infinity;
    }
    if (sc.biome !== "plains" && sc.biome !== "forest") {
      return -Infinity;
    }
    let maxDiff = 0;
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      const nh = terrain.getHeight(x + Math.cos(ang) * 4, z + Math.sin(ang) * 4);
      const d = Math.abs(nh - h);
      if (d > maxDiff) {
        maxDiff = d;
      }
    }
    if (maxDiff > 2) {
      return -Infinity;
    }
    let nearWater = false;
    outer: for (const rr of [10, 16, 24]) {
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
    if (bestS > 118) {
      break;
    } // flat, grassy, near water, close to origin
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

// Skill Den placement: 4 flattened plateaus on widening rings around spawn.

/**
 * Per-den ring radius. The first stays a short walk from spawn (there must
 * always be a reachable shop); the rest step out so finding one is travel.
 */
const DEN_RINGS = [18, 34, 50, 66];
/** A den's pad: levelled core, and the ramp out to natural ground. */
const DEN_PAD_CORE = 4.5;
const DEN_PAD_BLEND = 9;
/**
 * How clear of a carriageway's RIM a den must stand.
 *
 * THE WHOLE PAD, not the building: a flatten ramps the ground out to `blend`,
 * and a ramp that reaches a carriageway lifts the road with it — which the road
 * probe reads as a step in the walking surface, because that is what it is. So
 * the clearance is the pad's own reach plus a pace, and any placement that
 * levels ground owes the same sum.
 */
const DEN_ROAD_CLEAR = DEN_PAD_BLEND + 2;
/** Squared minimum spacing between two dens, and between a den and spawn. */
const DEN_SEP2 = 27 * 27;
const DEN_SPAWN_SEP2 = 15 * 15;

function placeShops(
  terrain: Terrain,
  spawn: THREE.Vector3,
  seed: number,
  towns: TownRegistry,
  roads: readonly Road[],
): DenSpot[] {
  const rng = mulberry32(seed ^ 0x5158);
  const spots: DenSpot[] = [];

  /** A den may not land inside a town — the town owns that ground. */
  const inTown = (x: number, z: number): boolean => {
    for (const t of towns.all) {
      const dx = t.x - x;
      const dz = t.z - z;
      const r = t.radius + 9;
      if (dx * dx + dz * dz < r * r) {
        return true;
      }
    }
    return false;
  };

  /**
   * A den's own pad. Through `levelPad`, which is where the +0.55 convention is
   * written down: a den is placed at `h` and the ground under it reports `h`.
   */
  const commit = (x: number, z: number): void => {
    spots.push({ x, z, h: levelPad(terrain, x, z, DEN_PAD_CORE, DEN_PAD_BLEND, WATER_LEVEL) });
  };

  /**
   * The rule that was missing: a den may not stand in a road.
   *
   * The dens are sited AFTER the road network is cut, so the roads are right
   * there to ask — and until this line the pass never did, which is how a cart
   * road came to run through one. `DEN_ROAD_CLEAR` is measured from the rim and
   * is the den's own footprint plus a pace to walk round it.
   */
  const inRoad = (x: number, z: number): boolean => roadIntrusion(roads, x, z) > -DEN_ROAD_CLEAR;

  for (let k = 0; k < 4; k++) {
    const baseAng = (k / 4) * Math.PI * 2 + 0.62;
    const ring = DEN_RINGS[k];
    let placed = false;
    // Outer rings have more water and cliff to dodge, and failure snaps back
    // onto the ring anyway, so searching hard is cheap.
    for (let attempt = 0; attempt < 44 && !placed; attempt++) {
      const ang = baseAng + (rng() - 0.5) * 1.1;
      const dist = ring + (rng() - 0.5) * 9 + attempt * 0.5;
      const x = Math.round(spawn.x + Math.sin(ang) * dist) + 0.5;
      const z = Math.round(spawn.z + Math.cos(ang) * dist) + 0.5;
      const hc = terrain.heightCont(x, z);
      if (hc < WATER_LEVEL + 0.8) {
        continue;
      }
      if (inTown(x, z) || inRoad(x, z)) {
        continue;
      }
      const sx = x - spawn.x;
      const sz = z - spawn.z;
      if (sx * sx + sz * sz < DEN_SPAWN_SEP2) {
        continue;
      }
      let clear = true;
      for (const o of spots) {
        const dx = o.x - x;
        const dz = o.z - z;
        if (dx * dx + dz * dz < DEN_SEP2) {
          clear = false;
          break;
        }
      }
      if (!clear) {
        continue;
      }
      commit(x, z);
      placed = true;
    }
    if (!placed) {
      // THE LAST RESORT STILL STEPS OUT OF THE ROAD: walk the ring until the
      // bearing is clear of one, rather than dropping a den on the gravel
      // because the search ran out.
      for (let k2 = 0; k2 < 24; k2++) {
        const ang = baseAng + (k2 / 24) * Math.PI * 2;
        const x = Math.round(spawn.x + Math.sin(ang) * ring) + 0.5;
        const z = Math.round(spawn.z + Math.cos(ang) * ring) + 0.5;
        if (!inRoad(x, z)) {
          commit(x, z);
          placed = true;
          break;
        }
      }
      if (!placed) {
        commit(
          Math.round(spawn.x + Math.sin(baseAng) * ring) + 0.5,
          Math.round(spawn.z + Math.cos(baseAng) * ring) + 0.5,
        );
      }
    }
  }
  return spots;
}

/**
 * How far beside the greeter the hero wakes up. JUST outside `NPC_TALK_RANGE`
 * (2.8): inside it the greeter turns to attend on frame one and the side-by-side
 * composition is gone before anybody sees it.
 */
const START_BESIDE = 3.2;

/**
 * The hero's body radius for the clearance test. `Player.radius` (0.32) is not
 * importable — `world/` may not depend on `player/` — so this is rounded UP as a
 * stated margin rather than a load-bearing value written down twice.
 */
const START_CLEARANCE = 0.5;

/**
 * Where the hero wakes up: beside the start town's greeter, facing his way.
 *
 * THE OFFSET IS PERPENDICULAR TO HIS FACING, which puts the hero the same
 * distance from the fire the greeter is and never between him and what he is
 * looking at. `spotIsFree` is the NPC placer's own test, imported rather than
 * restated. The fallback is the road, for a zone with no settlement or people.
 */
function pickPlayerStart(
  site: NpcSite | null,
  npcs: Npcs | null,
  plan: SettlementPlan | null,
  spawnPoint: THREE.Vector3,
  terrain: Terrain,
): PlayerStart {
  const seat = (x: number, z: number, yaw: number): PlayerStart => ({
    position: new THREE.Vector3(x, terrain.getHeight(x, z), z),
    yaw,
  });

  // The road, facing the start town — the pre-existing behaviour, kept whole as
  // the answer for every zone this does not apply to.
  const startTown = plan?.sites.find((s) => s.start)?.id;
  const town = startTown ? (plan?.towns.get(startTown) ?? null) : null;
  const toTown = town ? Math.atan2(town.x - spawnPoint.x, town.z - spawnPoint.z) : 0;
  const road: PlayerStart = { position: spawnPoint.clone(), yaw: toTown };
  if (!site || !npcs || !town) {
    return road;
  }

  // The greeter: whoever stands nearest the middle of the start town. NOT the
  // first in load order, which is an array index wearing a fact's clothes, and
  // not a hard-coded `npc:gain` — a package that moves the start elsewhere
  // moves the player with it, and neither this file nor the player's opening
  // shot should know a character's name.
  let greeter: { x: number; z: number; restYaw: number } | null = null;
  let best = Infinity;
  for (const n of npcs.all) {
    const d2 = (n.x - town.x) ** 2 + (n.z - town.z) ** 2;
    if (d2 < best) {
      best = d2;
      greeter = n;
    }
  }
  if (!greeter || best > town.outerRadius ** 2) {
    return road;
  }

  // Perpendicular to his facing, so "beside him". The two sides first, then the
  // same two dropped half a pace back — a fallback that keeps the shoulder-to-
  // shoulder read where a straight retreat would put the hero behind his back.
  const f = greeter.restYaw;
  const rx = Math.cos(f);
  const rz = -Math.sin(f);
  const fx = Math.sin(f);
  const fz = Math.cos(f);
  let pick: { x: number; z: number } | null = null;
  for (const back of [0, 1.4]) {
    for (const sideSign of [1, -1]) {
      const x = greeter.x + rx * START_BESIDE * sideSign - fx * back;
      const z = greeter.z + rz * START_BESIDE * sideSign - fz * back;
      if (!spotIsFree(site, x, z, START_CLEARANCE)) {
        continue;
      }
      pick = { x, z };
      break;
    }
    if (pick) {
      break;
    }
  }
  if (!pick) {
    return road;
  }
  return seat(pick.x, pick.z, f);
}

// ---------------------------------------------------------------------------

/**
 * Where the flying town wanders, relative to `spawnPoint`. Past the outermost
 * den but still over the played part of the map; it roams `ROAM_R` around this.
 * A bearing that is not one of the four the dens sit on.
 */
const SKY_HOME_DIST = 170;
const SKY_HOME_ANGLE = 2.1;

/**
 * Two NPC fields behind one, for people on the ground AND people on something
 * that moves. A COMPOSITE rather than a wider `Npcs` because the two crews
 * differ in the one thing `Npcs` is built around: their coordinate frame.
 */
class NpcFields implements NpcField {
  constructor(private readonly parts: readonly NpcField[]) {}

  get all(): readonly NpcInfo[] {
    // Allocates; not a frame path. `nearest` is the per-slice question.
    return this.parts.flatMap((p) => p.all as NpcInfo[]);
  }

  nearest(x: number, y: number, z: number, range: number): NpcInfo | null {
    let best: NpcInfo | null = null;
    let bestD2 = Infinity;
    for (const p of this.parts) {
      const n = p.nearest(x, y, z, range);
      if (!n) {
        continue;
      }
      const d2 = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = n;
      }
    }
    return best;
  }

  talk(id: string): NpcTalk | null {
    for (const p of this.parts) {
      const t = p.talk(id);
      if (t) {
        return t;
      }
    }
    return null;
  }

  get talking(): NpcTalk | null {
    for (const p of this.parts) {
      if (p.talking) {
        return p.talking;
      }
    }
    return null;
  }

  endTalk(): void {
    for (const p of this.parts) {
      p.endTalk();
    }
  }
}

/**
 * The ground towns plus whatever a carrier holds up. A flying town belongs on
 * the registry like any other: it has an id, name, colour and place. Its `x`/`z`
 * are LIVE — read them every frame, never cache them.
 */
function withCarriedTowns(ground: TownRegistry, extra: readonly TownInfo[]): TownRegistry {
  if (extra.length === 0) {
    return ground;
  }
  const all = [...ground.all, ...extra];
  return {
    all,
    roads: ground.roads,
    get: (id) => all.find((t) => t.id === id),
    nearest: (x, z) => {
      let best: TownInfo | null = null;
      let bd2 = Infinity;
      for (const t of all) {
        const d2 = (t.x - x) ** 2 + (t.z - z) ** 2;
        if (d2 < bd2) {
          bd2 = d2;
          best = t;
        }
      }
      return best;
    },
  };
}

/**
 * What a landmark chooser is allowed to look at: the world after it has decided
 * where spawn and the dens are, but before a single chunk exists. See the
 * `landmarks` argument of createWorld.
 */
export interface LandmarkProbe {
  readonly spawnPoint: THREE.Vector3;
  readonly waterLevel: number;
  readonly shopPositions: THREE.Vector3[];
  /** The towns, so a landmark chooser can keep out of one. */
  readonly towns: TownRegistry;
  getHeight(x: number, z: number): number;
  /** Slope, for a landmark that wants to stand against something. */
  steepnessAt(x: number, z: number): number;
  /** What grows here, so a landmark can prefer to be found in a wood. */
  biomeAt(x: number, z: number): string;
}

/**
 * @param landmarks Optional: claim CLEARINGS before anything is built — flatten
 *   plus prop exclusion. Must run HERE, because a chunk's props bake into its
 *   mesh and the 3x3 around spawn is built below. `noSpawnRadius` absent means
 *   none, which is a gameplay decision rather than an unset default.
 */
/**
 * Profiles `World.addPath` builds to, by name (the content rule: an author picks
 * a behaviour by name). The beaten track and flagstone are absent on purpose —
 * they carve and draw nothing, so authoring one would look like a no-op.
 */
/** For the landmark probe's `biomeAt` — see the probe literal. */
const landmarkScratch = makeScratch();
/** Its own, because `biomeAt` is asked from a spawn roll while a landmark pass may be walking the other. */
const biomeScratch = makeScratch();

/**
 * A short trail from the carriageway to each waystone.
 *
 * ONE PATH SYSTEM (issue #142): a spur to a stone is a `Road` on the same
 * network with the SPUR profile — a trail without its litter — so it is drawn,
 * carved and walkable. A beaten `track` was the first cut and it is the wrong
 * role here: a track only wears the grass, which reads as nothing at all across
 * open ground, and the ask was for a small road you can see. It is
 * STRAIGHT and unrouted, unlike `World.addPath`: eight to twenty units across
 * ground the siting pass has already proved flat, dry and unbuilt, so there is
 * nothing to route around and a router would only bend it for no reason.
 *
 * Added before any chunk exists, so nothing needs rebuilding — the network is
 * built once at the end and every later query sees the spurs.
 */
function cutWaypointTrails(
  terrain: Terrain,
  plan: SettlementPlan,
  towns: Towns | null,
  stones: readonly WaypointSite[],
): void {
  const profile = SPUR_PROFILE;
  let added = 0;
  for (const stone of stones) {
    if (!stone.from) {
      continue;
    }
    const ax = stone.from.x;
    const az = stone.from.z;
    const full = Math.hypot(stone.x - ax, stone.z - az);
    // STOP AT THE PLATE'S RIM. A carriageway that runs UNDER the plate reports a
    // five-unit step where its deck meets the stone's own top — the trail leads
    // TO the waystone, and the last pace onto it is the plate itself.
    const span = full - WAYPOINT_PLATE_R;
    // Under two paces there is nothing to draw: the plate is at the rim already.
    if (span < 2) {
      continue;
    }
    const steps = Math.max(2, Math.round(span / 2));
    const route: { x: number; z: number }[] = [];
    for (let i = 0; i <= steps; i++) {
      const u = (i / steps) * (span / full);
      route.push({ x: ax + (stone.x - ax) * u, z: az + (stone.z - az) * u });
    }
    const last = route[route.length - 1];
    const pts = profileRoad(
      terrain,
      route,
      // THE DECK'S height where it leaves the road, and the GROUND's where it
      // arrives: a spur anchored to natural ground under a carved carriageway
      // starts with a step in it (`test-road` measured 1.0). The arrival is the
      // ROUTE'S OWN last point — the plate rim — never the stone's centre: the
      // plate stands at the HIGHEST ground under its footprint, so a deck
      // anchored to the centre ends a whole cube over the ground it stops on
      // (`test-road` measured 0.964, issue #213).
      stone.from.y,
      terrain.getHeight(last.x, last.z),
    );
    if (pts.length < 2) {
      continue;
    }
    const spur: Road = {
      id: `path:waystone-${added}`,
      fromId: "free",
      toId: stone.id,
      profile,
      pts,
      trim: new Float32Array(8),
    };
    // ADDED, NOT MERGED. A crossing splits both edges into a junction, which is
    // right for two roads that MEET and wrong for a spur that leaves one at its
    // rim: merging pulled the spur's start onto the centreline, and it laid its
    // own gravel down the inside of the cart road (reported from play).
    plan.network.add(spur);
    added++;
  }
  if (added === 0) {
    return;
  }
  plan.network.build();
  // THE SAME THREE STEPS `World.addPath` TAKES, and for its reasons: the ribbons
  // are re-fitted because a new arm reshapes the ones it meets, and the REGISTRY
  // is re-set because it holds the drawn subset — a spur left out of it is a path
  // the world carves and never paints, which is what the first cut shipped.
  towns?.rebuildPaths(plan.network.roads, plan.network.junctions);
  plan.towns.setRoads(plan.network.roads.filter((r) => r.profile.roles.draw));
}

/** For `World.debugColumn` alone — see there. */
const dbgColumnScratch = makeScratch();

const PATH_PROFILES: Record<string, PathProfile> = {
  road: ROAD_PROFILE,
  footpath: FOOTPATH_PROFILE,
  trail: TRAIL_PROFILE,
};

export function createWorld(
  scene: THREE.Scene,
  seed = 20260729,
  landmarks?: (probe: LandmarkProbe) => Array<{
    x: number;
    z: number;
    id?: string;
    noSpawnRadius?: number;
  }>,
  initialViewDistance = 600,
): World {
  const terrain = new Terrain(seed);
  const terrainMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
  });
  const waterMat = createWaterMaterial();
  const propLib = new PropLib();
  // Null when either toggle is off, so `softMat` is never patched and `?sway=0`
  // is honestly static geometry rather than the same shader zeroed.
  const sway = flags.sway && flags.props ? new SwayField((x, z) => terrain.getHeight(x, z)) : null;
  sway?.install(propLib.softMat);
  // AFTER sway, so its vertex edit sees the final bent position.
  propLib.installDistanceFade();

  // TOWNS AND ROADS FIRST: `planSettlements` routes against the NATURAL height
  // field, then installs the corridor. Everything after this sees the roads.
  const plan = flags.towns ? planSettlements(terrain, seed) : null;
  const townReg: TownRegistry = plan
    ? plan.towns
    : { all: [], roads: [], get: () => undefined, nearest: () => null };
  const spawnPoint = plan ? plan.spawn : findSpawn(terrain);
  // A guard, not a path: the planner scores its candidates dry.
  if (terrain.getHeight(spawnPoint.x, spawnPoint.z) < WATER_LEVEL) {
    spawnPoint.copy(findSpawn(terrain));
  }
  spawnPoint.y = terrain.getHeight(spawnPoint.x, spawnPoint.z);

  // THE RENDER-DISTANCE AUTHORITY, created before anything that must respect
  // it. DistantTerrain (built later, after the height field settles) is its
  // only writer — a view-distance change moves ground, roads and structures
  // together. `ringBand` is the streamed-detail ring everything BUILT dies on.
  const horizonFade = makeHorizonFade(initialViewDistance);
  const ringBand = horizonFade.ring;

  const spots = placeShops(terrain, spawnPoint, seed, townReg, plan?.network.roads ?? []);
  const shops = new Shops(spots, spawnPoint, ringBand);
  scene.add(shops.group);

  // The debug spawner's stage. Its part library is not baked until something is
  // spawned, so a session that never opens F3 pays for a `Group`.
  const spawned = new SpawnedSolids(propLib, (x, z) => terrain.getHeight(x, z));
  scene.add(spawned.group);

  const towns = plan
    ? new Towns(plan, new TownParts(), propLib, terrainMat, seed, terrain, horizonFade)
    : null;

  // THE STANDING STONES, and they are sited AFTER the settlement is built for the
  // reason the first cut of them got wrong: a site has to be tested against what
  // is THERE, and a town's huts and palisade do not exist until `Towns` has run.
  // One ended up inside Redbriar's wall. Each stone also gets a short trail from
  // the carriageway, added to the network the same way any other path is —
  // there is one path system, and a spur to a waystone is not an exception.
  const waypoints = plan
    ? new Waypoints(
        waypointSites(plan.network.roads, plan.towns.all, plan.junction, {
          heightAt: (x, z) => terrain.getHeight(x, z),
          steepnessAt: (x, z) => terrain.steepnessAt(x, z),
          waterLevel: WATER_LEVEL,
          // What is BUILT, which at this point is the settlement and the dens.
          built: (x, z, r) =>
            (towns?.solids.hits(x, z, r, -Infinity, Infinity) ?? false) ||
            shops.solids.hits(x, z, r, -Infinity, Infinity),
          // What the ROAD stood up along itself — signposts and lamps.
          furniture: towns?.furniture ?? [],
        }),
        ringBand,
      )
    : null;
  if (waypoints && plan) {
    scene.add(waypoints.group);
    markStaticShadowCaster(waypoints.group);
    // NO FLATTEN UNDER A WAYSTONE, and it is the one placed thing in the world
    // that does not get one — twice tried, twice measured. A pad levels its core
    // and ramps its blend, and the TRAIL has to cross that ramp: `test-road`
    // read 6.4 units of step on the carriageway with the pad in, against 1.0
    // without it. What a den can afford (nothing walks onto a den from a path) a
    // waystone cannot.
    //
    // The stone answers the same rule a different way: it is sited at the
    // HIGHEST ground under its own footprint (`waypointSites`), so it can only
    // ever stand proud, and its skirt fills what is under the proud side. See
    // `levelPad` for the pad rule this is the exception to.
    cutWaypointTrails(terrain, plan, towns, waypoints.all);
  }

  if (towns) {
    scene.add(towns.group);
    // Built ONCE and never streamed, so they are the other half of the static
    // shadow set. The shops and the people MOVE and are deliberately not marked.
    markStaticShadowCaster(towns.group);
  }

  // THE PEOPLE, never before the settlement: the placement search asks where the
  // road is and what the camp built. Made once, not streamed.
  const npcSite: NpcSite | null =
    plan && towns
      ? {
          towns: plan.towns,
          roads: plan.network,
          getHeight: (x: number, z: number): number => terrain.getHeight(x, z),
          structureTopAt: (x: number, z: number): number => towns.solids.topAt(x, z),
          focusOf: (id: string) => towns.fireOf(id),
        }
      : null;
  const npcs = npcSite ? new Npcs(npcSite) : null;
  if (npcs) {
    scene.add(npcs.group);
  }

  /**
   * Where the PLAYER wakes up — not `spawnPoint`, which everything else in the
   * world is still measured from. DERIVED from the start town and its first
   * resident; nothing here names a character or a settlement.
   */
  const playerStart = pickPlayerStart(npcSite, npcs, plan, spawnPoint, terrain);

  /**
   * Top of any BUILT thing over this column, or -Infinity. Hoisted out of the
   * World literal because `structureTopAt` (what stops you) and `climbTopAt`
   * (what you can grab) must not be able to disagree.
   */
  const structureTop = (x: number, z: number): number => {
    if (!flags.solids) {
      return -Infinity;
    }
    // The dens first: the one set that exists in every world.
    let top = shops.solids.topAt(x, z);
    // A standing stone is solid the way a hut is; `topAt` is -Infinity off it.
    top = Math.max(top, waypoints?.solids.topAt(x, z) ?? -Infinity);
    if (towns) {
      const t = towns.solids.topAt(x, z);
      if (t > top) {
        top = t;
      }
    }
    if (npcs) {
      const n = npcs.solids.topAt(x, z);
      if (n > top) {
        top = n;
      }
    }
    // ...and whatever F3 stood on the ground; an empty field is one bounds test.
    const s = spawned.topAt(x, z);
    if (s > top) {
      top = s;
    }
    return top;
  };

  // THE TOWN THAT FLIES. After the ground settlement and its people, whose tools
  // it borrows, and before the clouds, which must keep out of it. A CARRIER, not
  // a landmark: it claims no clearing, flatten or exclusion.
  const carriers = new CarrierField();
  const skyData = flags.towns ? readCarriedTown() : null;
  const sky = skyData
    ? new SkyIsland(
        terrain,
        propLib,
        skyData,
        spawnPoint.x + Math.sin(SKY_HOME_ANGLE) * SKY_HOME_DIST,
        spawnPoint.z + Math.cos(SKY_HOME_ANGLE) * SKY_HOME_DIST,
        seed,
        // The lakes' own shader: one water in this world, lit and clocked once.
        waterMat,
      )
    : null;
  if (sky) {
    carriers.add(sky);
    scene.add(sky.root);
  }

  const clouds = flags.clouds ? new Clouds(seed) : null;
  // A cumulus is a volume of droplets: AO found only the seams between puffs and
  // drew dotted black dashes down every crease (issue #39).
  if (clouds) {
    scene.add(excludeFromAO(clouds.group));
  }

  // 'solid' — holds trees and boulders off, but grass still carpets: a blanket
  // exclusion left a ~20m bare plane under the camera.
  const sites =
    landmarks?.({
      spawnPoint,
      waterLevel: WATER_LEVEL,
      shopPositions: shops.positions,
      towns: townReg,
      getHeight: (x: number, z: number): number => terrain.getHeight(x, z),
      steepnessAt: (x: number, z: number): number => terrain.steepnessAt(x, z),
      biomeAt: (x: number, z: number): string => {
        terrain.columnInfo(Math.floor(x), Math.floor(z), landmarkScratch);
        return landmarkScratch.biome;
      },
    }) ?? [];
  for (const s of sites) {
    // Narrower than a den's 4.5/9: a wide flatten plants a visible pancake.
    const h = Math.max(Math.floor(terrain.heightCont(s.x, s.z)), WATER_LEVEL + 1);
    terrain.flattens.push({ x: s.x, z: s.z, h: h + 0.55, core: 3.5, blend: 7 });
  }

  // WHERE NOTHING HOSTILE MAY APPEAR — one registry fed by everything that
  // claimed ground above, so the spawn path asks one question.
  // NOT here: the player's own spawn disc, which lives in combat/index.ts
  // because it is a rule about where a SESSION begins, not about a place.
  const safeZones = new SafeZoneField();
  for (const t of townReg.all) {
    safeZones.add(`town:${t.id}`, t.x, t.z, t.noSpawnRadius);
  }
  for (let i = 0; i < spots.length; i++) {
    safeZones.add(`den:${i}`, spots[i].x, spots[i].z, DEN_NO_SPAWN_RADIUS);
  }
  for (let i = 0; i < sites.length; i++) {
    safeZones.add(
      sites[i].id ?? `landmark:${i}`,
      sites[i].x,
      sites[i].z,
      sites[i].noSpawnRadius ?? 0,
    );
  }

  const exclusions: Exclusion[] = [
    { x: spawnPoint.x, z: spawnPoint.z, kind: "solid" },
    ...spots.map((s): Exclusion => ({ x: s.x, z: s.z, kind: "solid" })),
    ...sites.map((s): Exclusion => ({ x: s.x, z: s.z, kind: "solid" })),
    // A town's whole footprint plus a little yard; grass still grows inside.
    ...townReg.all.map((t): Exclusion => ({
      // outerRadius, not radius: a square wall's corners stand 41% further out,
      // and on the footprint circle trees grew inside them.
      x: t.x,
      z: t.z,
      kind: "solid",
      r: t.outerRadius + 2.5,
    })),
  ];

  /**
   * WHAT THE FOLIAGE MAY NOT GROW THROUGH — timber volumes, exactly. The
   * exclusion discs above are the other half: a disc is about the SKYLINE and is
   * generous, this is about one plank and is exact (issue #131).
   *
   * NPCs are absent on purpose: a person walks, and a chunk's grass bakes once.
   */
  const site = new SiteFields([shops.solids, towns?.solids, waypoints?.solids]);

  // Created only after roads, towns and landmarks altered the height field, so
  // its silhouette samples the same authority as near ground. View distance is
  // not voxel distance: High extends the HLOD but keeps Medium's chunk count,
  // because another 88 cube-meshing jobs stuttered (issue #97).
  let terrainDistance = initialViewDistance;
  let viewRadius = flags.viewRadius ?? (initialViewDistance <= 480 ? 4 : DEFAULT_VIEW_RADIUS);
  setWaterDetailDistance(waterMat, viewRadius * CHUNK_SIZE);
  const distant = new DistantTerrain(
    terrain,
    spawnPoint,
    initialViewDistance,
    viewRadius * CHUNK_SIZE,
    horizonFade,
  );
  if (!flags.water) {
    distant.setWaterVisible(false);
  }
  scene.add(distant.terrain, distant.water);

  const chunks = new Map<string, ChunkRec>();
  /**
   * Trees by chunk: trunkKey -> `[x, z, solidR^2, climbR^2, trunkTopY, crownR^2,
   * crownCy, crownRy]` per tree (ChunkProps.trunks / TREE_STRIDE). Bucketed
   * because these are per-frame queries over ~1000 loaded trees.
   */
  const trunks = new Map<number, number[]>();
  const queue: Array<{ cx: number; cz: number; d: number }> = [];
  const foliageQueue: ChunkRec[] = [];
  const foliageQueued = new Set<string>();
  let lastCX = Infinity;
  let lastCZ = Infinity;
  let focusX = spawnPoint.x;
  let focusZ = spawnPoint.z;
  let grassDistance = 128;
  let propsDistance = 160;
  let worldShown = true;
  let time = 0;
  let disposed = false;
  /** The chunk currently part-built, and which stage comes next. */
  let building: {
    rec: ChunkRec;
    stage: number;
    terrain: ReturnType<typeof buildTerrainMeshSteps> | null;
    props: ReturnType<typeof buildChunkPropsSteps> | null;
    /** False when this job only restores distance-culled foliage. */
    countChunk: boolean;
  } | null = null;
  let buildBudgetLeft = 0;

  /**
   * Layers the F3 panel has switched off, by mesh name. Kept HERE because the
   * streamer outlives any one decision: a chunk built after the player hid the
   * grass must arrive hidden. `applyLayers` runs on every finished stage.
   */
  const hiddenLayers: Record<WorldLayer, boolean> = {
    grass: false,
    props: false,
    water: false,
    clouds: false,
  };

  /** Squared distance from the focus to this chunk's horizontal rectangle. */
  const chunkDistanceSq = (rec: ChunkRec): number => {
    const x0 = rec.cx * CHUNK_SIZE;
    const z0 = rec.cz * CHUNK_SIZE;
    const dx =
      focusX < x0 ? x0 - focusX : focusX > x0 + CHUNK_SIZE ? focusX - (x0 + CHUNK_SIZE) : 0;
    const dz =
      focusZ < z0 ? z0 - focusZ : focusZ > z0 + CHUNK_SIZE ? focusZ - (z0 + CHUNK_SIZE) : 0;
    return dx * dx + dz * dz;
  };

  /**
   * Every mesh gets a visibility, and ANYTHING NOT A TOGGLEABLE LAYER IS SHOWN.
   * That default is the whole correctness here: `setVisible(false)` hides the
   * lot, so a show that only re-shows named layers loses the ground forever.
   */
  const applyLayers = (rec: ChunkRec): void => {
    const d2 = chunkDistanceSq(rec);
    for (const m of rec.meshes) {
      const layer = m.name.startsWith("chunk:") ? m.name.slice(6) : "";
      const inRange =
        layer === "grass"
          ? d2 < grassDistance * grassDistance
          : layer === "props"
            ? d2 < propsDistance * propsDistance
            : true;
      const visible =
        worldShown &&
        inRange &&
        (layer in hiddenLayers ? !hiddenLayers[layer as WorldLayer] : true);
      if (m.visible === visible) {
        continue;
      }
      m.visible = visible;
      // Only a REAL transition changes the caster set: this also runs as the
      // per-frame distance cull, so an unconditional invalidation would erase
      // the shadow cache 120 times a second. Bounded to the chunk.
      invalidateStaticShadowsNear(m);
    }
  };

  const startChunk = (cx: number, cz: number): ChunkRec | null => {
    const key = chunkKey(cx, cz);
    if (chunks.has(key)) {
      return null;
    }
    const rec: ChunkRec = { cx, cz, meshes: [], propsBuilt: false };
    chunks.set(key, rec);
    return rec;
  };

  /** One chunk of reserve beyond the fade, so a newly-near prop stage draining
   * through the frame budget shows no bare edge. */
  const wantsProps = (rec: ChunkRec): boolean => {
    const reserve = propsDistance + CHUNK_SIZE;
    return chunkDistanceSq(rec) < reserve * reserve;
  };

  const commitProps = (rec: ChunkRec, props: ChunkProps): void => {
    rec.propsBuilt = true;
    if (props.solid) {
      props.solid.name = "chunk:props";
    }
    if (props.soft) {
      excludeFromAO(props.soft).name = "chunk:grass";
    }
    for (const m of [props.solid, props.soft]) {
      if (!m) {
        continue;
      }
      rec.meshes.push(m);
      scene.add(m);
      markStaticShadowCaster(m);
    }
    if (props.trunks.length > 0) {
      trunks.set(trunkKey(rec.cx, rec.cz), props.trunks);
    }
    applyLayers(rec);
  };

  const buildProps = (rec: ChunkRec): void => {
    if (rec.propsBuilt || !flags.props || !wantsProps(rec)) {
      return;
    }
    commitProps(
      rec,
      buildChunkProps(rec.cx, rec.cz, terrain, propLib, exclusions, plan?.network ?? null, site),
    );
  };

  const dropProps = (rec: ChunkRec): void => {
    if (!rec.propsBuilt) {
      return;
    }
    for (let i = rec.meshes.length - 1; i >= 0; i--) {
      const m = rec.meshes[i];
      if (m.name !== "chunk:props" && m.name !== "chunk:grass") {
        continue;
      }
      invalidateStaticShadowsNear(m);
      scene.remove(m);
      m.geometry.dispose();
      rec.meshes.splice(i, 1);
    }
    trunks.delete(trunkKey(rec.cx, rec.cz));
    rec.propsBuilt = false;
  };

  const refreshFoliage = (): void => {
    for (const rec of chunks.values()) {
      const key = chunkKey(rec.cx, rec.cz);
      if (!wantsProps(rec)) {
        dropProps(rec);
        foliageQueued.delete(key);
      } else if (!rec.propsBuilt && !foliageQueued.has(key)) {
        foliageQueued.add(key);
        foliageQueue.push(rec);
      }
    }
    foliageQueue.sort((a, b) => chunkDistanceSq(a) - chunkDistanceSq(b));
  };

  const buildStage = (rec: ChunkRec, stage: number): void => {
    const { cx, cz } = rec;
    if (stage === 0) {
      const m = buildTerrainMesh(cx, cz, terrain, terrainMat);
      // NAMED though it is not a layer, so a probe can count it — the regression
      // was terrain going invisible.
      m.name = "chunk:terrain";
      rec.meshes.push(m);
      scene.add(m);
    } else if (stage === 1) {
      if (!flags.water) {
        return;
      }
      const water = buildWaterMesh(cx, cz, terrain, waterMat);
      if (water) {
        water.name = "chunk:water";
        rec.meshes.push(water);
        scene.add(water);
      }
    } else {
      buildProps(rec);
      return;
    }
    // A CHUNK IS THE DEFINITION OF STATIC SHADOW GEOMETRY: pure functions of the
    // seed that never move, so the cache draws them once.
    for (const m of rec.meshes) {
      markStaticShadowCaster(m);
    }
    // Both of these belong HERE, in the one function that adds meshes to a
    // chunk, not at its two call sites — in the streamer alone, chunks from
    // `buildChunk` never heard that the F3 panel had hidden the grass.
    applyLayers(rec);
  };

  /** Build a whole chunk now. Boot only — the streaming path stages it. */
  const buildChunk = (cx: number, cz: number): void => {
    const rec = startChunk(cx, cz);
    if (!rec) {
      return;
    }
    for (let s = 0; s <= 2; s++) {
      buildStage(rec, s);
    }
    perf.count("chunks");
  };

  const disposeChunk = (rec: ChunkRec): void => {
    // BEFORE the geometry goes: the invalidation measures bounds off it.
    for (const m of rec.meshes) {
      invalidateStaticShadowsNear(m);
    }
    for (const m of rec.meshes) {
      scene.remove(m);
      m.geometry.dispose();
    }
    trunks.delete(trunkKey(rec.cx, rec.cz));
    foliageQueued.delete(chunkKey(rec.cx, rec.cz));
  };

  const refreshQueue = (fcx: number, fcz: number): void => {
    queue.length = 0;
    const lim = (viewRadius + 0.35) * (viewRadius + 0.35);
    for (let dz = -viewRadius; dz <= viewRadius; dz++) {
      for (let dx = -viewRadius; dx <= viewRadius; dx++) {
        const d = dx * dx + dz * dz;
        if (d > lim) {
          continue;
        }
        const cx = fcx + dx;
        const cz = fcz + dz;
        if (!chunks.has(chunkKey(cx, cz))) {
          queue.push({ cx, cz, d });
        }
      }
    }
    queue.sort((a, b) => a.d - b.d);
  };

  const unloadFar = (fcx: number, fcz: number): void => {
    const unloadRadius = viewRadius + 1.5;
    const lim = unloadRadius * unloadRadius;
    for (const [key, rec] of chunks) {
      const dx = rec.cx - fcx;
      const dz = rec.cz - fcz;
      if (dx * dx + dz * dz > lim) {
        // The part-built chunk can be the one leaving range; drop it or the next
        // stage adds meshes to a disposed record.
        if (building && building.rec === rec) {
          building = null;
        }
        disposeChunk(rec);
        chunks.delete(key);
      }
    }
  };

  // Synchronous 3x3 around spawn so the hero never falls through the floor.
  const scx = Math.floor(spawnPoint.x / CHUNK_SIZE);
  const scz = Math.floor(spawnPoint.z / CHUNK_SIZE);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      buildChunk(scx + dx, scz + dz);
    }
  }

  // NAMED, not returned inline: `addPath` calls `rebuildProps`.
  const api: World = {
    waterLevel: WATER_LEVEL,
    spawnPoint,
    playerStart,
    // Null when `towns=0` switched the road network off: no roads, no stones.
    waypoints,
    // The start town's pen — the camp layout's own answer, never rederived
    // (issue #178). `y` is read here so the caller stands things ON the ground.
    tamingPen: ((): { x: number; y: number; z: number; r: number } | null => {
      const start = plan?.sites.find((ts) => ts.start);
      const pen = start ? (towns?.penOf(start.id) ?? null) : null;
      return pen ? { x: pen.x, y: terrain.getHeight(pen.x, pen.z), z: pen.z, r: pen.r } : null;
    })(),
    shopPositions: shops.positions,
    towns: withCarriedTowns(townReg, sky ? [sky.town] : []),
    safeZones,
    carriers,
    debugSpawn: spawned,
    get chunksLoaded(): number {
      return chunks.size;
    },
    // A part-built chunk counts: its trees are not in the registry yet.
    get streaming(): boolean {
      return distant.building || building !== null || queue.length > 0 || foliageQueue.length > 0;
    },
    get pendingChunks(): number {
      return (
        queue.length +
        foliageQueue.length +
        (building !== null ? 1 : 0) +
        (distant.building ? 1 : 0)
      );
    },
    getHeight: (x: number, z: number): number => terrain.getHeight(x, z),
    /**
     * Highest of terrain, trunk top and canopy surface. The whole tree holds
     * weight, and the crown is a DOME not a lid, so it falls away at the rim.
     * Per-frame: no allocation, no string keys, at most four buckets.
     */
    climbTopAt: (x: number, z: number): number => {
      let top = terrain.getHeight(x, z);
      // EVERYTHING SOLID IS CLIMBABLE: if it stops you, you can get on top.
      const s = structureTop(x, z);
      if (s > top) {
        top = s;
      }
      const c0x = Math.floor((x - CROWN_MARGIN) / CHUNK_SIZE);
      const c1x = Math.floor((x + CROWN_MARGIN) / CHUNK_SIZE);
      const c0z = Math.floor((z - CROWN_MARGIN) / CHUNK_SIZE);
      const c1z = Math.floor((z + CROWN_MARGIN) / CHUNK_SIZE);
      for (let bx = c0x; bx <= c1x; bx++) {
        for (let bz = c0z; bz <= c1z; bz++) {
          const b = trunks.get(trunkKey(bx, bz));
          if (b === undefined) {
            continue;
          }
          for (let i = 0; i < b.length; i += TREE_STRIDE) {
            const dx = x - b[i];
            const dz = z - b[i + 1];
            const d2 = dx * dx + dz * dz;
            if (d2 <= b[i + 3] && b[i + 4] > top) {
              top = b[i + 4];
            } // bole
            const cr2 = b[i + 5];
            if (d2 <= cr2) {
              // canopy dome
              const y = b[i + 6] + b[i + 7] * Math.sqrt(1 - d2 / cr2);
              if (y > top) {
                top = y;
              }
            }
          }
        }
      }
      return top;
    },

    /**
     * Top of the solid bole, or -Infinity. TRUNK ONLY: a canopy that blocked
     * movement would fence off every tree at ground level.
     */
    trunkSolidTopAt: (x: number, z: number): number => {
      let top = -Infinity;
      const c0x = Math.floor((x - TRUNK_MARGIN) / CHUNK_SIZE);
      const c1x = Math.floor((x + TRUNK_MARGIN) / CHUNK_SIZE);
      const c0z = Math.floor((z - TRUNK_MARGIN) / CHUNK_SIZE);
      const c1z = Math.floor((z + TRUNK_MARGIN) / CHUNK_SIZE);
      for (let bx = c0x; bx <= c1x; bx++) {
        for (let bz = c0z; bz <= c1z; bz++) {
          const b = trunks.get(trunkKey(bx, bz));
          if (b === undefined) {
            continue;
          }
          for (let i = 0; i < b.length; i += TREE_STRIDE) {
            const dx = x - b[i];
            const dz = z - b[i + 1];
            if (dx * dx + dz * dz > b[i + 2]) {
              continue;
            }
            if (b[i + 4] > top) {
              top = b[i + 4];
            }
          }
        }
      }
      return top;
    },
    /**
     * THREE FIELDS, one query. Towns, dens and people share the primitive but
     * not the owner: a `StructureField` is frozen at the end of its builder's
     * constructor, so each owns its own and the max is taken here. Not bucketed
     * by chunk — none of the three streams.
     */
    structureTopAt: structureTop,
    // Everyone in the zone. One field when there are only ground people.
    npcs: sky?.npcs ? new NpcFields(npcs ? [npcs, sky.npcs] : [sky.npcs]) : npcs,
    /**
     * Is this sphere inside a canopy? The only query that treats the crown as a
     * VOLUME. The three tests are ordered to reject early — vertical band, then
     * horizontal disc, then the ellipsoid — because this runs per slice.
     *
     * The sphere folds into the dome by inflating both semi-axes, which is
     * generous at the rim; that errs right, since `bake` already pulls crownR in
     * to 0.84 of the measured foliage reach.
     */
    crownContactAt(x: number, y: number, z: number, radius: number, out: CrownContact): boolean {
      const c0x = Math.floor((x - CROWN_MARGIN) / CHUNK_SIZE);
      const c1x = Math.floor((x + CROWN_MARGIN) / CHUNK_SIZE);
      const c0z = Math.floor((z - CROWN_MARGIN) / CHUNK_SIZE);
      const c1z = Math.floor((z + CROWN_MARGIN) / CHUNK_SIZE);
      for (let bx = c0x; bx <= c1x; bx++) {
        for (let bz = c0z; bz <= c1z; bz++) {
          const b = trunks.get(trunkKey(bx, bz));
          if (b === undefined) {
            continue;
          }
          for (let i = 0; i < b.length; i += TREE_STRIDE) {
            const cr2 = b[i + 5];
            // A cactus or bare snag: nothing to knock off it.
            if (cr2 < 0.25) {
              continue;
            }
            const ry = b[i + 7] + radius;
            const dy = y - b[i + 6];
            if (dy * dy > ry * ry) {
              continue;
            }
            const dx = x - b[i];
            const dz = z - b[i + 1];
            const d2 = dx * dx + dz * dz;
            const cr = Math.sqrt(cr2) + radius;
            if (d2 > cr * cr) {
              continue;
            }
            if (d2 / (cr * cr) + (dy * dy) / (ry * ry) > 1) {
              continue;
            }
            out.treeX = b[i];
            out.treeZ = b[i + 1];
            out.crownR = cr - radius;
            out.crownCy = b[i + 6];
            out.crownRy = b[i + 7];
            return true;
          }
        }
      }
      return false;
    },
    isWater: (x: number, z: number): boolean => terrain.getHeight(x, z) < WATER_LEVEL,
    // The STEPPED column, like `isWater`: what a mover's feet resolve against.
    isDeepWater: (x: number, z: number): boolean => terrain.getHeight(x, z) <= DEEP_WATER_TOP,
    // Straight through, like getHeight: it owes nothing to what is loaded.
    snowCoverAt: (x: number, z: number): number => terrain.snowCoverAt(x, z),
    // The column's own answer, which is what a spawn table is keyed on (issue #204).
    biomeAt: (x: number, z: number): string => {
      terrain.columnInfo(Math.floor(x), Math.floor(z), biomeScratch);
      return biomeScratch.biome;
    },

    /** Every loaded trunk collider as [x, z, solidR, climbR, boleTopY], for
     * /show-colliders. Allocates nothing per collider. */
    disturb(id, x, y, z, radius, kind): void {
      sway?.disturb(id, x, y, z, radius, kind);
    },

    swayDebug(): unknown {
      return sway?.debug() ?? null;
    },

    debugColliders(out: number[]): void {
      for (const b of trunks.values()) {
        for (let i = 0; i < b.length; i += TREE_STRIDE) {
          out.push(b[i], b[i + 1], Math.sqrt(b[i + 2]), Math.sqrt(b[i + 3]), b[i + 4]);
        }
      }
    },

    /** Every built collider as [cx, cz, hx, hz, yaw, topY]. The whole set —
     * neither the towns nor the dens stream. */
    debugPaths(x?: number, z?: number) {
      const net = plan?.network ?? null;
      return {
        paths: (net?.roads ?? []).map((r) => {
          const a = r.pts[0];
          const b = r.pts[r.pts.length - 1];
          // Every 8th sample (~24 units) plus the last: enough to AIM a camera at
          // a stretch of road without a probe pinning a seed's coordinates.
          const pts: Array<[number, number, number]> = [];
          for (let i = 0; i < r.pts.length; i += 8) {
            pts.push([+r.pts[i].x.toFixed(1), +r.pts[i].y.toFixed(1), +r.pts[i].z.toFixed(1)]);
          }
          pts.push([+b.x.toFixed(1), +b.y.toFixed(1), +b.z.toFixed(1)]);
          return {
            id: r.id,
            profile: r.profile.id,
            deckHalf: +r.profile.deckHalf.toFixed(3),
            deckEdge: +r.profile.deckEdge.toFixed(3),
            wear: r.wear ?? 0,
            draw: r.profile.roles.draw,
            surface: r.profile.roles.surface,
            refusesBuilt: r.profile.roles.refusesBuilt,
            litter: r.profile.litter,
            x0: +a.x.toFixed(2),
            z0: +a.z.toFixed(2),
            x1: +b.x.toFixed(2),
            z1: +b.z.toFixed(2),
            pts,
          };
        }),
        at:
          x === undefined || z === undefined || net === null
            ? null
            : {
                edge: num(net.edgeDistanceTo(x, z)),
                builtEdge: num(net.builtEdgeDistanceTo(x, z)),
                wear: +net.wearAt(x, z).toFixed(4),
                litter: +net.litterAt(x, z).toFixed(4),
              },
      };
    },
    debugPathRibbons(on: boolean): boolean {
      if (towns === null) {
        return false;
      }
      towns.setPathsVisible(on);
      return true;
    },
    addPath(spec) {
      const net = plan?.network ?? null;
      const reg = plan?.towns ?? null;
      if (net === null || reg === null || towns === null) {
        return no("this zone has no path network");
      }
      const profile = PATH_PROFILES[spec.profile ?? "footpath"];
      if (profile === undefined) {
        return no(
          `unknown profile "${spec.profile}" — try ` + Object.keys(PATH_PROFILES).join(", "),
        );
      }
      const [ax, az] = spec.from;
      const [bx, bz] = spec.to;
      if (Math.hypot(bx - ax, bz - az) < 12) {
        return no("the two ends are under 12 units apart");
      }
      // Routed and profiled exactly as the planner does — a few hundred height
      // queries — and AGAINST the paths already there, so a new path leaves an
      // existing node rather than doubling its line (`AVOID_COST` 50).
      const seedFor = Math.floor(Math.abs(ax * 7919 + bz * 104729)) ^ seed;
      // With `cross`, nothing to avoid: that charge is unpayable on top of
      // another path's gravel, and wrong for one drawn to cross (issue #142 §12d).
      const route = routeRoad(
        terrain,
        ax,
        az,
        bx,
        bz,
        seedFor,
        spec.cross ? [] : net.roads.map((r) => r.pts),
        profile,
      );
      const road: Road = {
        id: `path:added-${net.roads.length}`,
        fromId: "free",
        toId: "free",
        profile,
        // ANCHORED TO THE GROUND AT BOTH ENDS, which a free-standing path needs
        // and a road out of a town does not: with NaN the limiter's raise leaves
        // the deck wherever smoothing put it and the corridor ends in a cliff.
        //
        // `getHeight`, not `heightCont` — the deck must meet the floored column
        // the hero walks on — and read BEFORE the road joins the network.
        //
        // AT THE ROUTE'S OWN ENDS, not the ones asked for: `routeRoad` lets the
        // tail land up to `SEG_LEN * 0.35` off, which is units of height here.
        pts: profileRoad(
          terrain,
          route,
          terrain.getHeight(route[0].x, route[0].z),
          terrain.getHeight(route[route.length - 1].x, route[route.length - 1].z),
        ),
        trim: new Float32Array(8),
      };
      if (road.pts.length < 2) {
        return no("the route came back empty");
      }
      // A PATH THAT CANNOT BRIDGE MAY NOT END OVER WATER (issue #142 §12f).
      // `bridges` only charges the ROUTER for wet steps; it cannot help when an
      // END is wet, and `profileRoad` then lifts the deck 1.9 over the lake on
      // nothing at all. A FORD is the third answer and is not built yet.
      if (!profile.bridges) {
        const wet = road.pts.findIndex((q) => q.bridge);
        if (wet >= 0) {
          return no(
            `the route crosses water at ${road.pts[wet].x.toFixed(0)}, ` +
              `${road.pts[wet].z.toFixed(0)} and a ${spec.profile ?? "footpath"} ` +
              'cannot bridge — move an end, or use profile "road"',
          );
        }
      }
      // The one place the network is mutated. `build()` re-flattens every path
      // and re-buckets the index; nothing caches a segment outside it.
      net.add(road);
      // Crossings BEFORE `build()`: a merge splits both edges, so the index
      // would otherwise be built over polylines about to be replaced.
      const merge = spec.cross ? mergeCrossings(net, road) : { nodes: [], refused: [] };
      net.build();
      // EVERY ribbon and apron: a junction reshapes the arms reaching it (§12b).
      towns.rebuildPaths(net.roads, net.junctions);
      // The registry too, or `__dbgTowns().roads` describes the pre-merge world.
      reg.setRoads(net.roads.filter((r) => r.profile.roles.draw));
      // Every chunk: `carveAt` answers differently now and a chunk is a baked
      // mesh of what `heightCont` said when it was built.
      api.rebuildProps();
      // AND THE FAR MESH, which only resamples when its anchor moves.
      distant.invalidate();
      // THE GROUND UNDER THE HERO MOVED. `rebuildProps`'s promise that he cannot
      // fall through does not hold here: `getHeight` consults `terrain.roads`,
      // which this just mutated, and `carveAt` sinks a column up to 1.62. The
      // CALLER re-grounds, because this module does not own the player.
      spec.refit?.();
      // The id as it ENDED UP: a merge splits the path, so the caller gets the
      // half nearest the start and the original id would find nothing.
      const survivor = net.roads.find((r) => r.id.startsWith(road.id)) ?? road;
      // DRAWN paths only: crossing a beaten track is crossing a colour field.
      // And not the one at its own START, which is the join — a path authored to
      // leave the network begins ON a road by construction.
      const start = survivor.pts[0];
      const crossings = findCrossings(
        survivor,
        net.roads.filter((r) => r.profile.roles.draw && r !== survivor),
      ).filter((c) => Math.hypot(c.x - start.x, c.z - start.z) > ROAD_PROFILE.deckEdge).length;
      return {
        crossings,
        id: survivor.id,
        length: +roadLength(survivor).toFixed(1),
        samples: survivor.pts.length,
        note:
          profile.furniture === "road"
            ? "no lamps or fingerposts: the furniture pass is frozen at boot"
            : null,
        nodes: merge.nodes,
        refused: merge.refused,
      };
    },

    debugWear(x: number, z: number): number {
      return terrain.trampleAt(x, z);
    },

    pathRunCrosses(ax: number, az: number, bx: number, bz: number): boolean {
      const net = plan?.network ?? null;
      if (net === null) {
        return false;
      }
      return runCrossesAny(
        net.roads.filter((r) => r.profile.roles.draw),
        ax,
        az,
        bx,
        bz,
      );
    },

    pathRunHitsBuilt(ax: number, az: number, bx: number, bz: number, margin: number): boolean {
      // WHAT IS ALREADY STANDING, unlike `PathRoles.refusesBuilt`, which is
      // prospective: a runtime path arrives after the lamps and cannot retract
      // one, so its author asks this first.
      // The margin is the piece's own TIMBER (`solidR`), not the elbow room it
      // claims for placement — a lamp's 11 units would rule out the roadside.
      if (towns === null) {
        return false;
      }
      const dx = bx - ax;
      const dz = bz - az;
      const len2 = dx * dx + dz * dz || 1;
      for (const f of towns.furniture) {
        let t = ((f.x - ax) * dx + (f.z - az) * dz) / len2;
        if (t < 0) {
          t = 0;
        } else if (t > 1) {
          t = 1;
        }
        if (Math.hypot(ax + dx * t - f.x, az + dz * t - f.z) < (f.solidR ?? f.r) + margin) {
          return true;
        }
      }
      return false;
    },

    debugColumn(x: number, z: number): number {
      // Its own scratch: borrowing the streamer's corrupts a chunk mid-build.
      terrain.columnInfo(Math.floor(x), Math.floor(z), dbgColumnScratch);
      return dbgColumnScratch.h;
    },
    debugStructures(out: number[]): void {
      // Gated on the query's own flag, so the overlay can never disagree with
      // the collision. Every set that blocks is drawn, for the same reason.
      if (!flags.solids) {
        return;
      }
      towns?.solids.debugBoxes(out);
      sky?.debugStructures(out);
      shops.solids.debugBoxes(out);
      npcs?.solids.debugBoxes(out);
      spawned.debugBoxes(out);
    },
    /** Every roof cylinder as [cx, cz, axisYaw, hl, r, y, ry]. Gated like the
     * boxes; nobody but a settlement has a roof. */
    debugRidges(out: number[]): void {
      if (!flags.solids) {
        return;
      }
      towns?.solids.debugRidges(out);
      spawned.debugRidges(out);
    },
    /** See `World.foliageSite` — the field the chunk builder above consults. */
    foliageSite: site,

    debugFurniture(): Array<{ kind: string; x: number; z: number }> {
      return (towns?.furniture ?? []).map((f) => ({
        kind: f.kind ?? "?",
        x: f.x,
        z: f.z,
      }));
    },

    debugFences(): ReturnType<World["debugFences"]> {
      return (towns?.fences ?? []).map((f) => ({
        posts: f.posts.map((p) => ({
          x: +p.x.toFixed(3),
          z: +p.z.toFixed(3),
          y: +p.y.toFixed(3),
          base: +p.base.toFixed(3),
          kind: p.kind,
        })),
        closed: f.closed,
        bays: f.bays.map((b) => ({
          from: b.from,
          to: b.to,
          length: +b.length.toFixed(3),
          y: +b.y.toFixed(3),
          groundMax: +b.groundMax.toFixed(3),
        })),
      }));
    },

    debugCarriedTrees(): Array<{ x: number; z: number }> {
      return sky?.debugTrees() ?? [];
    },

    debugCarriedStreets() {
      return sky?.debugStreets() ?? { count: 0, paved: 0, clear: [] };
    },

    applyCelestial(state: Readonly<CelestialState>): void {
      // Here, so composition code need not know which zone owns water or clouds.
      waterMat.uniforms["uSunDir"]?.value.copy(state.keyDirection);
      waterMat.uniforms["uSunColor"]?.value.copy(state.keyColor);
      if (waterMat.uniforms["uSunStrength"]) {
        waterMat.uniforms["uSunStrength"].value = state.keyIntensity / 3.05;
      }
      clouds?.applyCelestial(state);
      sky?.applyCelestial(state);
      towns?.applyCelestial(state);
    },

    update(focus: THREE.Vector3, dt: number, newFrame = true): void {
      if (disposed) {
        return;
      }
      // Per RENDERED FRAME, not per slice: the sim can run several slices in one
      // frame, and a per-slice budget turned a catch-up frame into a 120 ms hitch.
      if (newFrame) {
        buildBudgetLeft = BUILD_BUDGET_MS;
        focusX = focus.x;
        focusZ = focus.z;
        waterMat.uniforms["uFocus"].value.set(focusX, focusZ);
        propLib.updateDistanceFade(focusX, focusZ);
        distant.requestUpdate(focus);
        // Outside the chunk queue, so it never blocks collision-ready streaming.
        distant.buildStep(0.6);
        // Radial fade, but a whole mesh still drops once its nearest edge is
        // outside it, buying back the draw rather than discarding fragments.
        for (const rec of chunks.values()) {
          applyLayers(rec);
        }
      }
      time += dt;
      waterMat.uniforms["uTime"].value = time;
      sway?.update(focus, time, dt);
      // WHERE the island is was decided by `carriers.advance` at the top of the
      // slice; this is only the people standing on it.
      sky?.update(dt, time, focus);
      // ...and the clouds part around it, or a cumulus grows through the square.
      if (sky) {
        clouds?.setKeepOut(sky.x, sky.y, sky.z, sky.radius, ISLAND_KEEL);
      }
      clouds?.update(focus, dt);
      shops.update(time, focus);
      waypoints?.update(focus);
      towns?.update(time, focus);
      npcs?.update(dt, time, focus);

      const fcx = Math.floor(focus.x / CHUNK_SIZE);
      const fcz = Math.floor(focus.z / CHUNK_SIZE);
      if (fcx !== lastCX || fcz !== lastCZ) {
        lastCX = fcx;
        lastCZ = fcz;
        refreshQueue(fcx, fcz);
        unloadFar(fcx, fcz);
        refreshFoliage();
      }
      // One terrain row or prop batch at a time. Water and each mesh's final
      // typed-array conversion are indivisible, so the budget is a target rather
      // than a deadline — the alternative stalls the queue under the player.
      while (buildBudgetLeft > 0 && (building || queue.length > 0 || foliageQueue.length > 0)) {
        const t0 = performance.now();
        if (!building && queue.length === 0) {
          const rec = foliageQueue.shift()!;
          const key = chunkKey(rec.cx, rec.cz);
          // A distance change or unload can stale a queued entry; rejecting it
          // here is cheaper than splicing a sorted queue.
          if (chunks.get(key) !== rec || rec.propsBuilt || !wantsProps(rec)) {
            foliageQueued.delete(key);
            continue;
          }
          building = { rec, stage: 2, terrain: null, props: null, countChunk: false };
        }
        if (!building) {
          const q = queue.shift()!;
          const rec = startChunk(q.cx, q.cz);
          if (!rec) {
            continue;
          } // already built or in flight
          building = { rec, stage: 0, terrain: null, props: null, countChunk: true };
        }
        if (building.stage === 0) {
          // Ground is the expensive stage. Nothing is published until the chunk
          // is internally complete; the HLOD underlay is the hill meanwhile.
          building.terrain ??= buildTerrainMeshSteps(
            building.rec.cx,
            building.rec.cz,
            terrain,
            terrainMat,
          );
          let result = building.terrain.next();
          while (!result.done && performance.now() - t0 < buildBudgetLeft) {
            result = building.terrain.next();
          }
          buildBudgetLeft -= performance.now() - t0;
          if (!result.done) {
            break;
          }
          const m = result.value;
          m.name = "chunk:terrain";
          building.rec.meshes.push(m);
          scene.add(m);
          markStaticShadowCaster(m);
          applyLayers(building.rec);
          building.terrain = null;
          building.stage = 1;
          continue;
        }
        if (building.stage === 2) {
          if (!flags.props || !wantsProps(building.rec)) {
            foliageQueued.delete(chunkKey(building.rec.cx, building.rec.cz));
            building.stage = 3;
          } else {
            building.props ??= buildChunkPropsSteps(
              building.rec.cx,
              building.rec.cz,
              terrain,
              propLib,
              exclusions,
              plan?.network ?? null,
              site,
            );
            let result = building.props.next();
            while (!result.done && performance.now() - t0 < buildBudgetLeft) {
              result = building.props.next();
            }
            buildBudgetLeft -= performance.now() - t0;
            if (!result.done) {
              break;
            }
            commitProps(building.rec, result.value);
            foliageQueued.delete(chunkKey(building.rec.cx, building.rec.cz));
            building.props = null;
            building.stage = 3;
          }
        } else {
          buildStage(building.rec, building.stage);
          building.stage++;
          buildBudgetLeft -= performance.now() - t0;
        }
        if (building.stage > 2) {
          if (building.countChunk) {
            perf.count("chunks");
          }
          building = null;
        }
      }
    },

    setLayerVisible(layer: WorldLayer, on: boolean): void {
      hiddenLayers[layer] = !on;
      // The island's fall is water too. Before the clouds branch and without
      // returning: the streamed water chunks below still need handling.
      if (layer === "water") {
        sky?.setWaterfallVisible(on);
      }
      if (layer === "water") {
        distant.setWaterVisible(on);
      }
      if (layer === "clouds") {
        if (clouds) {
          clouds.group.visible = on;
        }
        return;
      }
      // Already-streamed chunks now; `applyLayers` covers the ones built later.
      for (const rec of chunks.values()) {
        applyLayers(rec);
      }
    },

    setFoliageDistance(distance: number): void {
      // Clamped again here because World is a public contract debug code calls.
      grassDistance = Math.max(64, Math.min(128, distance));
      propsDistance = Math.min(grassDistance + CHUNK_SIZE, viewRadius * CHUNK_SIZE);
      propLib.setDistanceFade(grassDistance);
      refreshFoliage();
      for (const rec of chunks.values()) {
        applyLayers(rec);
      }
    },

    setTerrainDistance(distance: number): void {
      const nextDistance = distance <= 480 ? 480 : distance >= 900 ? 900 : 600;
      if (nextDistance === terrainDistance) {
        return;
      }
      terrainDistance = nextDistance;
      // Low/Medium/High use 4/5/5 detail chunks: High spends on a denser HLOD
      // rather than more cube meshes. `?view=` stays authoritative.
      viewRadius = flags.viewRadius ?? (nextDistance <= 480 ? 4 : DEFAULT_VIEW_RADIUS);
      setWaterDetailDistance(waterMat, viewRadius * CHUNK_SIZE);
      propsDistance = Math.min(grassDistance + CHUNK_SIZE, viewRadius * CHUNK_SIZE);
      const currentFocus = new THREE.Vector3(focusX, 0, focusZ);
      distant.configure(nextDistance, viewRadius * CHUNK_SIZE, currentFocus);
      const fcx = Math.floor(focusX / CHUNK_SIZE);
      const fcz = Math.floor(focusZ / CHUNK_SIZE);
      refreshQueue(fcx, fcz);
      unloadFar(fcx, fcz);
      refreshFoliage();
      for (const rec of chunks.values()) {
        applyLayers(rec);
      }
    },

    debugDistantTerrain(): Record<string, unknown> {
      return distant.debug();
    },

    warmUpEffects(render: () => void): void {
      sky?.warmUpWaterfall(render);
    },

    debugSkyFall(): Record<string, number> | null {
      return sky?.debugFall() ?? null;
    },

    /**
     * Throw away every streamed chunk and build it again — what a NATURE
     * parameter change needs, since densities are read inside `buildChunkProps`.
     * The WHOLE set, not the props meshes: a chunk's stages share one `ChunkRec`
     * and one trunk-registry entry, so a half-rebuild leaves undrawn trees in
     * `climbTopAt`. A TUNING path; the hero cannot fall through the result.
     */
    rebuildProps(): void {
      if (disposed) {
        return;
      }
      for (const rec of chunks.values()) {
        disposeChunk(rec);
      }
      chunks.clear();
      trunks.clear();
      foliageQueue.length = 0;
      foliageQueued.clear();
      // Its record is gone; a further stage would add meshes to nothing.
      building = null;
      // Force a re-queue: `update` only refreshes on a chunk-boundary crossing.
      lastCX = Infinity;
      invalidateStaticShadows();
    },

    setVisible(v: boolean): void {
      worldShown = v;
      distant.setVisible(v);
      // SHOWING THE WORLD MEANS SHOWING IT AS CONFIGURED, hence `applyLayers`
      // and not `visible = true`: the ZoneManager's warm-up hide/show otherwise
      // re-showed every layer the F3 panel had switched off.
      for (const rec of chunks.values()) {
        applyLayers(rec);
      }
      // The den lamps live here, so this also drops four point lights.
      shops.group.visible = v;
      // The towns add no lights; this only keeps a camp out of a warm-up render.
      if (towns) {
        towns.group.visible = v;
      }
      if (npcs) {
        npcs.setVisible(v);
      }
      // One flag on its root takes its people and lamps too. Its glow is
      // emissive, so it adds no lights; hidden anyway, being a lot of rock.
      sky?.setVisible(v);
      // A hidden layer stays hidden through a hide/show cycle.
      if (clouds) {
        clouds.group.visible = v && !hiddenLayers.clouds;
      }
      // Once for the whole sweep: the hide branch never reaches `applyLayers`
      // and the camp is hidden by a flag of its own.
      invalidateStaticShadows();
    },

    /** A handful of chunks per call, then everything else: 6 per frame empties a
     * walked-in world in under 20 frames. */
    disposeStep(): boolean {
      if (disposed) {
        return true;
      }
      let n = 6;
      for (const [key, rec] of chunks) {
        if (n <= 0) {
          return false;
        }
        n--;
        if (building && building.rec === rec) {
          building = null;
        }
        disposeChunk(rec);
        chunks.delete(key);
      }
      this.dispose();
      return true;
    },

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const rec of chunks.values()) {
        disposeChunk(rec);
      }
      chunks.clear();
      trunks.clear();
      foliageQueue.length = 0;
      foliageQueued.clear();
      scene.remove(shops.group);
      shops.dispose();
      if (npcs) {
        scene.remove(npcs.group);
        npcs.dispose();
      }
      if (towns) {
        scene.remove(towns.group);
        towns.dispose();
      }
      if (sky) {
        scene.remove(sky.root);
        sky.dispose();
      }
      if (clouds) {
        scene.remove(clouds.group);
        clouds.dispose();
      }
      spawned.dispose();
      terrainMat.dispose();
      waterMat.dispose();
      propLib.dispose();
      scene.remove(distant.terrain, distant.water);
      distant.dispose();
    },
  };
  return api;
}
