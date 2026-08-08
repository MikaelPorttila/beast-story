/**
 * World assembly: seeded terrain + chunk streaming + water + props +
 * skill dens + sky ambience, exposed through the shared World contract.
 */
import * as THREE from 'three';
import type {
  CelestialState, CrownContact, NpcField, NpcInfo, NpcTalk, PlayerStart, TownInfo, TownRegistry,
  World, WorldLayer,
} from '../core/types';
import { excludeFromAO } from '../core/types';
import { CarrierField } from './carriers';
import { ISLAND_KEEL, SkyIsland, readCarriedTown } from './sky-island';
import { CHUNK_SIZE, DEEP_WATER_TOP, Terrain, WATER_LEVEL, makeScratch } from './terrain';
import { buildTerrainMesh, buildTerrainMeshSteps } from './chunk';
import { DistantTerrain } from './distant-terrain';
import { buildWaterMesh, createWaterMaterial, setWaterDetailDistance } from './water';
import {
  PropLib, buildChunkProps, buildChunkPropsSteps, TREE_STRIDE,
  type ChunkProps, type Exclusion,
} from './props';
import { Shops, type DenSpot } from './shops';
import { Towns, planSettlements, type SettlementPlan } from './towns';
import { TownParts } from './town-parts';
import { Npcs, spotIsFree, type NpcSite } from './npc';
import { SpawnedSolids } from './spawned';
import { Clouds } from './clouds';
import { SwayField } from './sway';
import { mulberry32 } from './noise';
import { DEN_NO_SPAWN_RADIUS, SafeZoneField } from './safe-zones';
import { perf } from '../core/profiler';
import { flags } from '../core/flags';
import {
  invalidateStaticShadows, invalidateStaticShadowsNear, markStaticShadowCaster,
} from '../core/shadow-cache';

const DEFAULT_VIEW_RADIUS = 5;
/**
 * Wall-clock budget per rendered frame for chunk building, in ms. At the ~7.8 ms
 * frames this game runs at, 3 ms leaves the rest of the frame intact while still
 * draining the queue in a couple of seconds of walking.
 */
const BUILD_BUDGET_MS = 3;

interface ChunkRec {
  cx: number;
  cz: number;
  meshes: THREE.Mesh[];
  propsBuilt: boolean;
}

const chunkKey = (cx: number, cz: number): string => `${cx},${cz}`;

/**
 * NUMERIC chunk key, for the trunk registry only.
 *
 * `chunkKey` builds a string, and climbTopAt runs inside the player's per-frame
 * update — one template literal per lookup is exactly the kind of per-frame
 * garbage this codebase does not produce. Multiplying keeps the key injective
 * for |cz| < 2^21 chunks (67 million units out) and stays a safe integer for
 * any cx a session can reach.
 */
const trunkKey = (cx: number, cz: number): number => cx * 4194304 + cz;

/**
 * How far outside a chunk a trunk's disc can reach, in world units.
 *
 * A tree is registered in the bucket of the chunk that PLACED it, so one
 * standing near a chunk seam has to be findable from the neighbouring chunk
 * too. The fattest bole in the game is the broad oak's, measured at 0.90 units
 * of template radius; the girth roll tops out at 1.22 and the climbable disc
 * adds TRUNK_GRAB, so the widest either query can ask about is ~1.44. 2 units
 * of margin covers that with room for a fatter tree later.
 */
const TRUNK_MARGIN = 2;

/**
 * The same idea for the CROWN, which reaches far further: the widest canopy in
 * the set (again the broad oak) measures 4.32 units of template radius, times
 * the same 1.22 girth roll is 5.28. Used by climbTopAt, which has to find a
 * tree rooted in the next chunk whose branches are over this column.
 */
const CROWN_MARGIN = 6;

// ---------------------------------------------------------------------------
// Spawn search: scenic flat grass, above water, with water in walking range.
//
// SUPERSEDED for the overworld, and kept because it is the fallback and because
// it is the only thing that answers "somewhere sane to stand" without a road
// network. The hero now starts on the ROAD to the Encampment (see
// `pickRoadSpawn` in towns.ts) — a town does not own the spawn point, and the
// spawn point is not in the town. This runs only if the settlement planner
// somehow hands back a spot in the water, which its own scoring already refuses.
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

function placeShops(
  terrain: Terrain, spawn: THREE.Vector3, seed: number, towns: TownRegistry,
): DenSpot[] {
  const rng = mulberry32(seed ^ 0x5158);
  const spots: DenSpot[] = [];

  /** A den may not land inside a town — the town owns that ground. */
  const inTown = (x: number, z: number): boolean => {
    for (const t of towns.all) {
      const dx = t.x - x;
      const dz = t.z - z;
      const r = t.radius + 9;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  };

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
      if (inTown(x, z)) continue;
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

/**
 * How far to one side of the greeter the hero wakes up, in world units.
 *
 * 3.2 is "a few paces", and the number is picked against `NPC_TALK_RANGE` (2.8)
 * rather than by eye — JUST outside it, deliberately, and both halves of that
 * matter. Inside it, Gain turns to attend the hero on the very first frame, so
 * the two of them face each other and the composition the pose exists for —
 * two men side by side looking the same way across a fire — is gone before
 * anybody sees it, with an interact pill over it. A single step closes it, so
 * the conversation is still the obvious first thing to do.
 */
const START_BESIDE = 3.2;

/**
 * The hero's body radius, for the clearance test only.
 *
 * `Player.radius` is 0.32 and is not importable here — `world/` may not depend
 * on `player/`, which is the same one-way edge that keeps `core/types.ts` the
 * contract hub. It is rounded UP rather than copied, so the number is a stated
 * margin ("about a body's width, and a little more") rather than a load-bearing
 * value written down twice: a hero half a decimetre thicker still stands here,
 * and nothing about the pose changes if `BODY_RADIUS` is retuned.
 */
const START_CLEARANCE = 0.5;

/**
 * Where the hero wakes up: beside the start town's greeter, facing his way.
 *
 * THE OFFSET IS PERPENDICULAR TO HIS FACING, which is what makes it "beside"
 * rather than "in front of" or "behind". Both are tried and the more open one
 * wins; behind-and-to-the-side are the fallbacks, and only then the road. Two
 * things fall out of the perpendicular that are worth stating, because they are
 * the reason it is not simply "three metres from him in any free direction":
 * the hero lands the same distance from the fire that the greeter is, so he is
 * AT the fire rather than three metres further out into the dark, and he never
 * lands between the greeter and the thing the greeter is looking at.
 *
 * `spotIsFree` is the NPC placement search's own test, imported rather than
 * re-stated (world/npc.ts): a spot the hero may stand on and a spot a character
 * may stand on are the same spot, and the camp's cart road ends in the middle
 * of camp, so this is not a formality.
 *
 * THE FALLBACK IS THE ROAD, i.e. exactly what the game did before — a zone with
 * no settlement (the dungeon), no people in it, or a camp so crowded that none
 * of the four candidates is clear. Facing the town in that case, because the
 * point of the road spawn was always that the camp is a destination you can see.
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
  const town = startTown ? plan?.towns.get(startTown) ?? null : null;
  const toTown = town
    ? Math.atan2(town.x - spawnPoint.x, town.z - spawnPoint.z)
    : 0;
  const road: PlayerStart = { position: spawnPoint.clone(), yaw: toTown };
  if (!site || !npcs || !town) return road;

  // The greeter: whoever stands nearest the middle of the start town. NOT the
  // first in load order, which is an array index wearing a fact's clothes, and
  // not a hard-coded `npc:gain` — a package that moves the start elsewhere
  // moves the player with it, and neither this file nor the player's opening
  // shot should know a character's name.
  let greeter: { x: number; z: number; restYaw: number } | null = null;
  let best = Infinity;
  for (const n of npcs.all) {
    const d2 = (n.x - town.x) ** 2 + (n.z - town.z) ** 2;
    if (d2 < best) { best = d2; greeter = n; }
  }
  if (!greeter || best > town.outerRadius ** 2) return road;

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
      if (!spotIsFree(site, x, z, START_CLEARANCE)) continue;
      pick = { x, z };
      break;
    }
    if (pick) break;
  }
  if (!pick) return road;
  return seat(pick.x, pick.z, f);
}

// ---------------------------------------------------------------------------

/**
 * Where the flying town wanders, relative to `spawnPoint`.
 *
 * Far enough that it is somewhere to GO — 170 units is past the outermost skill
 * den and a good way beyond the start town — and near enough that it is in the
 * sky over the part of the map the rest of the game is in. It roams `ROAM_R`
 * (world/sky-island.ts) around this, so on any given day it can be anywhere
 * from over the Encampment to a long flight out.
 *
 * A bearing that is not one of the four the dens sit on, so the island is not
 * habitually over one.
 */
const SKY_HOME_DIST = 170;
const SKY_HOME_ANGLE = 2.1;

/**
 * Two NPC fields behind one, for a world that has people on the ground AND
 * people on something that moves.
 *
 * A COMPOSITE RATHER THAN A WIDER `Npcs`, because the two crews genuinely
 * differ in the one thing `Npcs` is built around: the frame their coordinates
 * are in. Merging them into one instance would mean a per-character frame and a
 * branch in every loop; composing two instances costs one `for` in three small
 * methods, and each half goes on being exactly the thing it already was.
 *
 * `talking` is asked of both because a conversation belongs to the field that
 * owns the character, and only one of them can have one open — `talk(id)`
 * returns null from the field that does not know the id.
 */
class NpcFields implements NpcField {
  constructor(private readonly parts: readonly NpcField[]) {}

  get all(): readonly NpcInfo[] {
    // Allocates, and is not on a frame path: this is the enumeration a map
    // screen or a quest walks. `nearest` below is the per-slice question and
    // allocates nothing.
    return this.parts.flatMap((p) => p.all as NpcInfo[]);
  }

  nearest(x: number, y: number, z: number, range: number): NpcInfo | null {
    let best: NpcInfo | null = null;
    let bestD2 = Infinity;
    for (const p of this.parts) {
      const n = p.nearest(x, y, z, range);
      if (!n) continue;
      const d2 = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = n; }
    }
    return best;
  }

  talk(id: string): NpcTalk | null {
    for (const p of this.parts) {
      const t = p.talk(id);
      if (t) return t;
    }
    return null;
  }

  get talking(): NpcTalk | null {
    for (const p of this.parts) if (p.talking) return p.talking;
    return null;
  }

  endTalk(): void {
    for (const p of this.parts) p.endTalk();
  }
}

/**
 * The ground towns plus whatever a carrier is holding up.
 *
 * The flying town is on the registry for the same reason a walled one is: it
 * has an id, a name, a colour and a place, which is the whole of what
 * `TownRegistry` promises, and a quest or a compass that had to ask a second
 * question to find out about a fourth settlement would be a contract with a
 * hole in it. Its `x`/`z` are LIVE — read them every frame, never cache them —
 * which is a property the interface always allowed and nothing had exercised.
 */
function withCarriedTowns(ground: TownRegistry, extra: readonly TownInfo[]): TownRegistry {
  if (extra.length === 0) return ground;
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
        if (d2 < bd2) { bd2 = d2; best = t; }
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
  /**
   * The towns, so a landmark chooser can keep out of one. The zone gateway is
   * placed 31-42 units from spawn and spawn is now a point on the road ~52 units
   * from the Encampment, so without this the arch had a real chance of standing
   * in the middle of the camp.
   */
  readonly towns: TownRegistry;
  getHeight(x: number, z: number): number;
}

/**
 * @param landmarks Optional: claim CLEARINGS before anything is built. Each one
 *   gets the den treatment — the terrain is flattened under it and props are
 *   kept off it — which is the only way to guarantee level, tree-free ground for
 *   something that is about to be placed there. It has to run here, not after
 *   the world is returned, because a chunk's props are baked into its mesh when
 *   the chunk is built and the 3x3 around spawn is built below. The zone
 *   gateway (main.ts) is the one user: captured without it, the arch stood in a
 *   thicket with a trunk through the middle of it.
 *
 *   A landmark is this world's OPEN-WORLD POINT OF INTEREST, so it is where a
 *   designer states a `noSpawnRadius` if the place needs one. Absent means none,
 *   which is the requirement rather than a default nobody got round to setting:
 *   a keep-out thins the population of the meadow around it, and that is a
 *   gameplay decision rather than a property of having been built. `id` is
 *   likewise optional and only names the zone in `__dbgSafeZones()`.
 */
export function createWorld(
  scene: THREE.Scene,
  seed = 20260729,
  landmarks?: (probe: LandmarkProbe) => Array<{
    x: number; z: number; id?: string; noSpawnRadius?: number;
  }>,
  initialViewDistance = 600,
): World {
  const terrain = new Terrain(seed);
  const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  const waterMat = createWaterMaterial();
  const propLib = new PropLib();
  // Grass that notices what walks and flies through it. Null when either toggle
  // is off, and then `softMat` is never patched at all, so `?sway=0` really is
  // the meadow as static geometry rather than the same shader with the numbers
  // zeroed — which is what makes it an honest A/B.
  const sway = flags.sway && flags.props ? new SwayField((x, z) => terrain.getHeight(x, z)) : null;
  sway?.install(propLib.softMat);
  // Installed AFTER sway so its vertex edit sees the final bent position. The
  // two hooks compose inside PropLib rather than one silently replacing the
  // other, which would make the distance row disable wind on grass.
  propLib.installDistanceFade();

  // TOWNS AND ROADS FIRST, and the order inside `planSettlements` is load
  // bearing: it routes against the NATURAL height field, then installs the
  // corridor on the terrain. Everything after this line — the spawn, the dens,
  // the gateway, every chunk — sees a world that already has roads cut into it.
  const plan = flags.towns ? planSettlements(terrain, seed) : null;
  const townReg: TownRegistry = plan
    ? plan.towns
    : { all: [], roads: [], get: () => undefined, nearest: () => null };
  const spawnPoint = plan ? plan.spawn : findSpawn(terrain);
  // The planner scores its candidates dry, so this is a guard rather than a
  // path: if a seed ever produced no usable stretch of road, fall back to the
  // old scenic-clearing search rather than starting the player in a lake.
  if (terrain.getHeight(spawnPoint.x, spawnPoint.z) < WATER_LEVEL) {
    spawnPoint.copy(findSpawn(terrain));
  }
  spawnPoint.y = terrain.getHeight(spawnPoint.x, spawnPoint.z);

  const spots = placeShops(terrain, spawnPoint, seed, townReg);
  const shops = new Shops(spots, spawnPoint);
  scene.add(shops.group);

  // The debug spawner's stage. Built empty and cheap — its part library is not
  // baked until something is actually spawned (see SpawnedSolids) — so a
  // session that never opens F3 pays for a `Group` and nothing else.
  const spawned = new SpawnedSolids(propLib, (x, z) => terrain.getHeight(x, z));
  scene.add(spawned.group);

  const towns = plan
    ? new Towns(plan, new TownParts(), propLib, terrainMat, seed, terrain)
    : null;
  if (towns) {
    scene.add(towns.group);
    // The settlements are built ONCE at world creation and never stream, so
    // they are the other half of the static shadow set beside the chunks —
    // and the denser half: a camp is a wall, a gate and a dozen huts standing
    // where the shadow box spends most of its life. The shops (their crystals
    // bob and spin) and the people (Gain curls a dumbbell) are deliberately NOT
    // marked; see markStaticShadowCaster.
    markStaticShadowCaster(towns.group);
  }

  // THE PEOPLE, after the settlement and never before it: the placement search
  // asks where the road is and what the camp already built, and both of those
  // answers only exist once `Towns` has stamped its last box. Like the towns
  // themselves they are made once and not streamed.
  const npcSite: NpcSite | null = plan && towns
    ? {
      towns: plan.towns,
      roads: plan.network,
      getHeight: (x: number, z: number): number => terrain.getHeight(x, z),
      structureTopAt: (x: number, z: number): number => towns.solids.topAt(x, z),
      focusOf: (id: string) => towns.fireOf(id),
    }
    : null;
  const npcs = npcSite ? new Npcs(npcSite) : null;
  if (npcs) scene.add(npcs.group);

  /**
   * WHERE THE PLAYER WAKES UP: beside the start town's greeter, at his fire,
   * looking the way he looks.
   *
   * This used to be `spawnPoint` — fifty units out on the road, with the camp a
   * destination you could see and walk to — and that point still exists and is
   * still what everything else in the world is measured from (see
   * `World.spawnPoint` in core/types.ts). What moved is only the HERO, because
   * an opening shot of a man beside a fire with somebody to talk to is a
   * different first five seconds from an opening shot of an empty road.
   *
   * IT IS DERIVED, NOT AUTHORED, and from the two facts the world already has:
   * the start town, and the first resident placed in it. Nothing here names
   * Gain or the Encampment — a package that moves the start elsewhere moves the
   * player with it, and a settlement with nobody in it falls back to the road
   * rather than inventing a spot in a camp nobody lives in.
   */
  const playerStart = pickPlayerStart(npcSite, npcs, plan, spawnPoint, terrain);

  /**
   * Top of any BUILT thing over this column — settlement boxes, the skill dens
   * and the people standing among them — or -Infinity where the column is clear.
   *
   * Hoisted out of the World literal because TWO queries need it and they must
   * not be able to disagree: `structureTopAt` (what stops you) and `climbTopAt`
   * (what you can grab). Those were separate sets once, and the gap between
   * them was the bug — see climbTopAt.
   */
  const structureTop = (x: number, z: number): number => {
    if (!flags.solids) return -Infinity;
    // The dens first: they are the one set that exists in every world, towns
    // being removable with `towns=0`.
    let top = shops.solids.topAt(x, z);
    if (towns) {
      const t = towns.solids.topAt(x, z);
      if (t > top) top = t;
    }
    if (npcs) {
      const n = npcs.solids.topAt(x, z);
      if (n > top) top = n;
    }
    // ...and whatever the F3 Debug panel has stood on the ground. Empty in
    // every session that never opened it, and `topAt` on an empty field is one
    // failed bounds test — the same price the wilderness already pays for the
    // three sets above.
    const s = spawned.topAt(x, z);
    if (s > top) top = s;
    return top;
  };

  // THE TOWN THAT FLIES. After the ground settlement and the people in it,
  // because it borrows both of their tools — `TownParts` for its timber and
  // `Npcs` for its residents — and before the clouds, which have to be told to
  // keep out of it. Gated on `flags.towns` like every other settlement: a world
  // built with `towns=0` has no towns, wherever they are.
  //
  // It is a CARRIER and not a landmark, so it claims no clearing, no flatten
  // and no exclusion: nothing it stands on is the terrain.
  const carriers = new CarrierField();
  const skyData = flags.towns ? readCarriedTown() : null;
  const sky = skyData
    ? new SkyIsland(
      terrain, propLib, skyData,
      spawnPoint.x + Math.sin(SKY_HOME_ANGLE) * SKY_HOME_DIST,
      spawnPoint.z + Math.cos(SKY_HOME_ANGLE) * SKY_HOME_DIST,
      seed,
      // The lakes' own shader, for the stream in the island's channel: one
      // water in this world, lit and clocked once. See `SkyIsland.buildStream`.
      waterMat,
    )
    : null;
  if (sky) {
    carriers.add(sky);
    scene.add(sky.root);
  }

  const clouds = flags.clouds ? new Clouds(seed) : null;
  // A cumulus is a volume of droplets, not a thing anything rests against — and
  // at 80-142 units up the only feature a 1.8-unit contact radius can find on
  // one is the seam where two puffs merge, which is issue #39's second
  // screenshot: dotted black dashes down every vertical crease.
  if (clouds) scene.add(excludeFromAO(clouds.group));

  // 'solid' — these discs hold trees, boulders, hedges and logs off the spawn
  // clearing and the den decks, but grass, flowers and shells still carpet
  // them. A blanket exclusion left a ~20m bare plane right under the camera.
  const sites = landmarks?.({
    spawnPoint,
    waterLevel: WATER_LEVEL,
    shopPositions: shops.positions,
    towns: townReg,
    getHeight: (x: number, z: number): number => terrain.getHeight(x, z),
  }) ?? [];
  for (const s of sites) {
    // Narrower than a den's 4.5/9 — a gateway is one arch, not a building, and
    // a wide flatten this far from spawn plants a visible pancake on a hillside.
    const h = Math.max(Math.floor(terrain.heightCont(s.x, s.z)), WATER_LEVEL + 1);
    terrain.flattens.push({ x: s.x, z: s.z, h: h + 0.55, core: 3.5, blend: 7 });
  }

  // WHERE NOTHING HOSTILE MAY APPEAR — one registry fed by everything that
  // claimed ground above, so the spawn path asks one question. See SafeZone in
  // core/types.ts for why this is a spawn rule and not a wall, and
  // world/safe-zones.ts for the two radii.
  //
  // Note what is NOT here: the player's own spawn point. That one is a 20-unit
  // disc in combat/index.ts and stays there, because it is a rule about where a
  // SESSION begins rather than about a place in the world — it holds in a zone
  // with no towns at all, and it would be wrong for it to move if a settlement
  // were ever sited on top of it.
  const safeZones = new SafeZoneField();
  for (const t of townReg.all) safeZones.add(`town:${t.id}`, t.x, t.z, t.noSpawnRadius);
  for (let i = 0; i < spots.length; i++) {
    safeZones.add(`den:${i}`, spots[i].x, spots[i].z, DEN_NO_SPAWN_RADIUS);
  }
  for (let i = 0; i < sites.length; i++) {
    // A landmark's is whatever the chooser asked for, and absent is 0 — see the
    // `noSpawnRadius` note on the landmarks argument.
    safeZones.add(sites[i].id ?? `landmark:${i}`, sites[i].x, sites[i].z, sites[i].noSpawnRadius ?? 0);
  }

  const exclusions: Exclusion[] = [
    { x: spawnPoint.x, z: spawnPoint.z, kind: 'solid' },
    ...spots.map((s): Exclusion => ({ x: s.x, z: s.z, kind: 'solid' })),
    ...sites.map((s): Exclusion => ({ x: s.x, z: s.z, kind: 'solid' })),
    // A town gets its whole footprint, plus a couple of metres of yard. Grass
    // and flowers still grow inside the palisade — only the occluders are held
    // off — which is what stops the camp floor reading as a bald disc.
    ...townReg.all.map((t): Exclusion => ({
      // outerRadius, not radius: the Encampment's wall is a square and its
      // corners stand 41% further out than its sides. Keyed on the footprint
      // circle, trees grew INSIDE the corners of the camp.
      x: t.x, z: t.z, kind: 'solid', r: t.outerRadius + 2.5,
    })),
  ];

  // One coarse camera-following landscape under the streamed voxel ring. It is
  // created only after roads, towns and landmarks have altered the height field,
  // so its silhouette is sampled from the same terrain authority as near ground.
  // View distance is not voxel distance. High extends and densifies the HLOD,
  // while keeping Medium's 89 detailed chunks: adding another 88 synchronous
  // cube-meshing jobs caused the repeated ground-streaming stutter reported in
  // issue #97. Foliage remains independently adjustable.
  let terrainDistance = initialViewDistance;
  let viewRadius = flags.viewRadius
    ?? (initialViewDistance <= 480 ? 4 : DEFAULT_VIEW_RADIUS);
  setWaterDetailDistance(waterMat, viewRadius * CHUNK_SIZE);
  const distant = new DistantTerrain(
    terrain, spawnPoint, initialViewDistance, viewRadius * CHUNK_SIZE,
  );
  if (!flags.water) distant.setWaterVisible(false);
  scene.add(distant.terrain, distant.water);

  const chunks = new Map<string, ChunkRec>();
  /**
   * Trees, bucketed by chunk: trunkKey -> the flat record buildChunkProps
   * emitted, `[x, z, solidR^2, climbR^2, trunkTopY, crownR^2, crownCy, crownRy]`
   * per tree (see ChunkProps.trunks / TREE_STRIDE).
   *
   * Per chunk rather than one world list because these are per-frame queries and
   * the loaded world is ~90 chunks holding ~1000 trees: scanning all of them
   * would be a thousand distance tests a frame, where one bucket is a dozen.
   * Buckets appear when the props stage of a chunk runs and vanish with it.
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
   * A chunk is built in THREE STAGES. Terrain and props yield within their
   * stages; water is small enough to remain indivisible.
   *
   * Measured on an RTX 3070 Ti: a whole chunk is ~15 ms and the old budget did
   * two of them in a frame, so streaming cost 30-51 ms spikes — the sawtooth you
   * feel walking in a straight line. Props are ~78% of that (world's worst frame
   * drops from 30 ms to 6.6 ms with `props=0`), which is why they are last: the
   * ground and its water appear first and the scenery fills in a frame or two
   * later, rather than the whole chunk popping in at the cost of a dropped frame.
   *
   * The record is registered in `chunks` at stage 0, so a half-built chunk is
   * never re-queued by refreshQueue, and unloadFar can dispose it mid-build.
   */
  /**
   * Layers the F3 panel has switched off, by mesh name.
   *
   * Kept HERE rather than read from the panel because the streamer outlives any
   * one decision: a chunk built two seconds after the player hid the grass must
   * arrive hidden. `applyLayers` is called on every finished stage for exactly
   * that, and `setLayerVisible` sweeps the chunks that already exist.
   */
  const hiddenLayers: Record<WorldLayer, boolean> = {
    grass: false, props: false, water: false, clouds: false,
  };

  /** Squared distance from the focus to this chunk's horizontal rectangle. */
  const chunkDistanceSq = (rec: ChunkRec): number => {
    const x0 = rec.cx * CHUNK_SIZE;
    const z0 = rec.cz * CHUNK_SIZE;
    const dx = focusX < x0 ? x0 - focusX
      : focusX > x0 + CHUNK_SIZE ? focusX - (x0 + CHUNK_SIZE) : 0;
    const dz = focusZ < z0 ? z0 - focusZ
      : focusZ > z0 + CHUNK_SIZE ? focusZ - (z0 + CHUNK_SIZE) : 0;
    return dx * dx + dz * dz;
  };

  /**
   * Every mesh in a chunk gets a visibility, and ANYTHING NOT A TOGGLEABLE
   * LAYER IS SHOWN. That default is the whole correctness of this function.
   *
   * The first version only ASSIGNED to the three named layers and left every
   * other mesh alone, which reads as harmless and is not: `setVisible(false)`
   * hides the lot, and if the matching show only re-shows what it recognises,
   * the terrain never comes back. A player who walked near a gateway with grass
   * switched off got a world with no ground and no water in it — the layer
   * logic was right and the DEFAULT was missing.
   *
   * So this is exhaustive by construction: named layer -> its own flag,
   * anything else -> visible. A mesh added to a chunk in future is shown unless
   * somebody deliberately makes it a layer.
   */
  const applyLayers = (rec: ChunkRec): void => {
    const d2 = chunkDistanceSq(rec);
    for (const m of rec.meshes) {
      const layer = m.name.startsWith('chunk:') ? m.name.slice(6) : '';
      const inRange = layer === 'grass' ? d2 < grassDistance * grassDistance
      : layer === 'props' ? d2 < propsDistance * propsDistance : true;
      const visible = worldShown && inRange && (layer in hiddenLayers
        ? !hiddenLayers[layer as WorldLayer]
        : true);
      if (m.visible === visible) continue;
      m.visible = visible;
      // Only a real transition changes the cached caster set. This function is
      // now also the sub-chunk distance cull and runs each rendered frame; an
      // unconditional invalidation here would erase the shadow cache 120 times
      // a second while every mesh stayed exactly as it was.
      invalidateStaticShadowsNear(m);
    }
    // A hidden caster is a changed caster set. Every path that shows or hides
    // chunk geometry goes through here — the streamer, the F3 grass/trees rows
    // and the zone handover's hide/show — so this is the one line that keeps
    // the cached shadow map honest about all three. Bounded by the chunk,
    // because the streamer calls this on every stage of every build and an
    // unbounded invalidation there is the whole cost of the cache.
  };

  const startChunk = (cx: number, cz: number): ChunkRec | null => {
    const key = chunkKey(cx, cz);
    if (chunks.has(key)) return null;
    const rec: ChunkRec = { cx, cz, meshes: [], propsBuilt: false };
    chunks.set(key, rec);
    return rec;
  };

  /**
   * Keep one complete chunk beyond the solid fade. Its geometry is already
   * invisible there, but the reserve prevents a bare edge while a newly-near
   * prop stage drains through the frame budget.
   */
  const wantsProps = (rec: ChunkRec): boolean => {
    const reserve = propsDistance + CHUNK_SIZE;
    return chunkDistanceSq(rec) < reserve * reserve;
  };

  const commitProps = (rec: ChunkRec, props: ChunkProps): void => {
    rec.propsBuilt = true;
    if (props.solid) props.solid.name = 'chunk:props';
    if (props.soft) excludeFromAO(props.soft).name = 'chunk:grass';
    for (const m of [props.solid, props.soft]) {
      if (!m) continue;
      rec.meshes.push(m);
      scene.add(m);
      markStaticShadowCaster(m);
    }
    if (props.trunks.length > 0) trunks.set(trunkKey(rec.cx, rec.cz), props.trunks);
    applyLayers(rec);
  };

  const buildProps = (rec: ChunkRec): void => {
    if (rec.propsBuilt || !flags.props || !wantsProps(rec)) return;
    commitProps(rec, buildChunkProps(
      rec.cx, rec.cz, terrain, propLib, exclusions, plan?.network ?? null,
    ));
  };

  const dropProps = (rec: ChunkRec): void => {
    if (!rec.propsBuilt) return;
    for (let i = rec.meshes.length - 1; i >= 0; i--) {
      const m = rec.meshes[i];
      if (m.name !== 'chunk:props' && m.name !== 'chunk:grass') continue;
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
      // NAMED even though it is not a layer and never will be — the ground is
      // not optional. It is named so a probe can count it: the regression that
      // made this necessary was terrain going invisible, and a test that only
      // knows the names of the things it can hide cannot see that.
      m.name = 'chunk:terrain';
      rec.meshes.push(m);
      scene.add(m);
    } else if (stage === 1) {
      if (!flags.water) return;
      const water = buildWaterMesh(cx, cz, terrain, waterMat);
      if (water) {
        water.name = 'chunk:water';
        rec.meshes.push(water);
        scene.add(water);
      }
    } else {
      buildProps(rec);
      return;
    }
    // A CHUNK IS THE DEFINITION OF STATIC SHADOW GEOMETRY. Terrain, water,
    // trees and grass are pure functions of the seed and never move again, so
    // their shadow is drawn into the cache once and composited every frame
    // afterwards (core/shadow-cache.ts). This is the same place and for the
    // same reason as `applyLayers` below: the one function that adds a mesh to
    // a chunk, rather than either of the two call sites that reach it.
    for (const m of rec.meshes) markStaticShadowCaster(m);
    // HERE, at the bottom of the one function that adds meshes to a chunk, and
    // not at the call sites. There are two of those — the streamer's staged
    // path and `buildChunk`'s build-it-all-now path — and putting this in the
    // streamer only was a real bug: with grass switched off in the F3 panel it
    // stayed off while you stood still and came back in patches as you walked,
    // because the chunks that arrived through the other path never heard about
    // the setting. A third caller would have made the same mistake again.
    applyLayers(rec);
  };

  /** Build a whole chunk now. Boot only — the streaming path stages it. */
  const buildChunk = (cx: number, cz: number): void => {
    const rec = startChunk(cx, cz);
    if (!rec) return;
    for (let s = 0; s <= 2; s++) buildStage(rec, s);
    perf.count('chunks');
  };

  const disposeChunk = (rec: ChunkRec): void => {
    // BEFORE the geometry goes: the invalidation measures its bounds off it.
    for (const m of rec.meshes) invalidateStaticShadowsNear(m);
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
        if (d > lim) continue;
        const cx = fcx + dx;
        const cz = fcz + dz;
        if (!chunks.has(chunkKey(cx, cz))) queue.push({ cx, cz, d });
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
        // The part-built chunk can be the one walking out of range; drop it or
        // the next stage would add meshes to a record already disposed.
        if (building && building.rec === rec) building = null;
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
    playerStart,
    shopPositions: shops.positions,
    towns: withCarriedTowns(townReg, sky ? [sky.town] : []),
    safeZones,
    carriers,
    debugSpawn: spawned,
    get chunksLoaded(): number { return chunks.size; },
    // A part-built chunk counts: its props stage has not run, so its trees are
    // not in the trunk registry yet and walking in would find no colliders.
    get streaming(): boolean {
      return distant.building || building !== null || queue.length > 0 || foliageQueue.length > 0;
    },
    // The part-built one counts as pending for the same reason it counts as
    // streaming: it is not finished, so the bar must not have spent it yet.
    get pendingChunks(): number {
      return queue.length + foliageQueue.length + (building !== null ? 1 : 0)
        + (distant.building ? 1 : 0);
    },
    getHeight: (x: number, z: number): number => terrain.getHeight(x, z),
    /**
     * Terrain, the top of a trunk, or the surface of a canopy — whichever is
     * highest over this column. The whole tree holds weight: a player who
     * mantles off a bole onto the leaves has to find something under him.
     *
     * The crown is modelled as a dome rather than a lid (see Template.trunk),
     * so the surface falls away toward the rim the way the foliage does.
     *
     * Called from the player's per-frame update, so: no allocation, no string
     * keys, and no scan of anything bigger than the chunk buckets that can hold
     * a tree reaching this point. Two buckets is the common worst case (a point
     * within CROWN_MARGIN of one seam); four only near a corner.
     */
    climbTopAt: (x: number, z: number): number => {
      let top = terrain.getHeight(x, z);
      // EVERYTHING SOLID IS CLIMBABLE. A hut wall, a palisade span, a crate,
      // a cart — if it stops you, you can get on top of it. See the contract.
      const s = structureTop(x, z);
      if (s > top) top = s;
      const c0x = Math.floor((x - CROWN_MARGIN) / CHUNK_SIZE);
      const c1x = Math.floor((x + CROWN_MARGIN) / CHUNK_SIZE);
      const c0z = Math.floor((z - CROWN_MARGIN) / CHUNK_SIZE);
      const c1z = Math.floor((z + CROWN_MARGIN) / CHUNK_SIZE);
      for (let bx = c0x; bx <= c1x; bx++) {
        for (let bz = c0z; bz <= c1z; bz++) {
          const b = trunks.get(trunkKey(bx, bz));
          if (b === undefined) continue;
          for (let i = 0; i < b.length; i += TREE_STRIDE) {
            const dx = x - b[i];
            const dz = z - b[i + 1];
            const d2 = dx * dx + dz * dz;
            if (d2 <= b[i + 3] && b[i + 4] > top) top = b[i + 4]; // bole
            const cr2 = b[i + 5];
            if (d2 <= cr2) {                                     // canopy dome
              const y = b[i + 6] + b[i + 7] * Math.sqrt(1 - d2 / cr2);
              if (y > top) top = y;
            }
          }
        }
      }
      return top;
    },

    /**
     * Top of the solid bole at this column, or -Infinity where there is none.
     *
     * Only the trunk is here — the crown fields are not consulted at all. A
     * canopy that blocked movement would fence off every tree in the world at
     * ground level; walking under one has to keep working.
     */
    trunkSolidTopAt: (x: number, z: number): number => {
      let top = -Infinity;
      // The solid disc is the bark itself, so it never reaches as far out of
      // its chunk as a crown does — but the seam handling is the same shape and
      // one shared margin is cheaper to reason about than two.
      const c0x = Math.floor((x - TRUNK_MARGIN) / CHUNK_SIZE);
      const c1x = Math.floor((x + TRUNK_MARGIN) / CHUNK_SIZE);
      const c0z = Math.floor((z - TRUNK_MARGIN) / CHUNK_SIZE);
      const c1z = Math.floor((z + TRUNK_MARGIN) / CHUNK_SIZE);
      for (let bx = c0x; bx <= c1x; bx++) {
        for (let bz = c0z; bz <= c1z; bz++) {
          const b = trunks.get(trunkKey(bx, bz));
          if (b === undefined) continue;
          for (let i = 0; i < b.length; i += TREE_STRIDE) {
            const dx = x - b[i];
            const dz = z - b[i + 1];
            if (dx * dx + dz * dz > b[i + 2]) continue;
            if (b[i + 4] > top) top = b[i + 4];
          }
        }
      }
      return top;
    },
    /**
     * The settlements' solid boxes — huts, palisades, crates, carts, road
     * furniture. See world/structures.ts.
     *
     * Not bucketed by chunk like the trees, because towns are not streamed:
     * they are built once at world creation and stay resident, so their
     * colliders are one flat grid that exists from boot. `towns=0` removes both
     * the meshes and this, which is the point of the flag.
     */
    /**
     * THREE FIELDS, one query. The settlement's boxes, the skill dens and the
     * people standing in the camp are the same primitive (world/structures.ts)
     * built at the same moment, but they belong to different owners — a
     * `StructureField` is frozen by its builder at the end of its own
     * constructor, and reaching into the town's to add a body afterwards would
     * break the invariant that makes it safe to index once. So each owns its
     * own and the max is taken here, which is exactly what `blockTop` already
     * does with terrain and trunks.
     */
    structureTopAt: structureTop,
    // Everyone in the zone, wherever they are standing. One field when the
    // world has only ground people, which is every world but this one.
    npcs: sky?.npcs ? new NpcFields(npcs ? [npcs, sky.npcs] : [sky.npcs]) : npcs,
    /**
     * Is this sphere inside a canopy? The third query over the same buckets,
     * and the only one that treats the crown as a VOLUME — see World.
     *
     * Same shape as trunkSolidTopAt on purpose: one margin, two nested bucket
     * loops, no allocation, no string keys. It runs once per simulation slice
     * from the contact-particle system, so the ordering of the three tests
     * inside the tree loop is chosen to reject a tree as early as possible:
     *
     *   1. the VERTICAL band, which is one subtraction and one compare and
     *      throws out essentially every tree in the bucket — the hero is under
     *      the canopy line almost always, and a bucket holds a dozen trees;
     *   2. the horizontal disc, which costs the one sqrt in here;
     *   3. the ellipsoid itself, for the trees that survived both.
     *
     * The sphere is folded into the dome by inflating both semi-axes, which is
     * a slightly generous test near the rim (a Minkowski sum of an ellipsoid and
     * a sphere is not an ellipsoid). That errs the right way: `bake` already
     * pulls crownR in to 0.84 of the measured foliage reach because the
     * outermost canopy voxels are mostly air, so the painted leaves stand ~19%
     * further out than this dome and the generous rim still lands inside them.
     */
    crownContactAt(x: number, y: number, z: number, radius: number, out: CrownContact): boolean {
      const c0x = Math.floor((x - CROWN_MARGIN) / CHUNK_SIZE);
      const c1x = Math.floor((x + CROWN_MARGIN) / CHUNK_SIZE);
      const c0z = Math.floor((z - CROWN_MARGIN) / CHUNK_SIZE);
      const c1z = Math.floor((z + CROWN_MARGIN) / CHUNK_SIZE);
      for (let bx = c0x; bx <= c1x; bx++) {
        for (let bz = c0z; bz <= c1z; bz++) {
          const b = trunks.get(trunkKey(bx, bz));
          if (b === undefined) continue;
          for (let i = 0; i < b.length; i += TREE_STRIDE) {
            const cr2 = b[i + 5];
            // A tree with no foliage worth the name — a cactus, or a snag whose
            // bare branches measured almost nothing. Nothing to knock off it.
            if (cr2 < 0.25) continue;
            const ry = b[i + 7] + radius;
            const dy = y - b[i + 6];
            if (dy * dy > ry * ry) continue;
            const dx = x - b[i];
            const dz = z - b[i + 1];
            const d2 = dx * dx + dz * dz;
            const cr = Math.sqrt(cr2) + radius;
            if (d2 > cr * cr) continue;
            if (d2 / (cr * cr) + (dy * dy) / (ry * ry) > 1) continue;
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
    // The STEPPED column, like `isWater` and for the same reason: this is what
    // a mover's feet resolve against, and a rule read off the continuous field
    // would disagree with the voxel the player can see under the water by up to
    // a unit. See DEEP_WATER_DEPTH.
    isDeepWater: (x: number, z: number): boolean => terrain.getHeight(x, z) <= DEEP_WATER_TOP,
    // Straight through to the terrain field, like getHeight: snow cover is a
    // pure function of the column and owes nothing to what is loaded, so a
    // caller can ask about a tree at the edge of the streamed radius.
    snowCoverAt: (x: number, z: number): number => terrain.snowCoverAt(x, z),

    /**
     * Every loaded trunk collider, appended to `out` as
     * [x, z, solidRadius, climbRadius, boleTopY]. For the console's
     * /show-colliders; allocates nothing per collider and is never called from
     * the frame loop.
     */
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

    /**
     * Every built collider as [cx, cz, hx, hz, yaw, topY], for the console's
     * /show-colliders. The whole set, not the loaded part: neither the towns nor
     * the dens stream.
     */
    debugStructures(out: number[]): void {
      // Gated on the same flag as the query, so the overlay can never draw a
      // cage around something that is not actually stopping anyone: under
      // `solids=0` there is nothing to show, and a picture that disagreed with
      // the collision would be worse than no picture.
      if (!flags.solids) return;
      towns?.solids.debugBoxes(out);
      // ...and whatever is being carried, transformed into world space by the
      // carrier itself. See `SkyIsland.debugStructures`.
      sky?.debugStructures(out);
      // The dens and the people too: all three block by the same primitive, so
      // /show-colliders has to draw them or the overlay would disagree with the
      // collision.
      shops.solids.debugBoxes(out);
      npcs?.solids.debugBoxes(out);
      // A spawned hut blocks like a built one, so it has to draw like one too:
      // an overlay that showed no cage around something you cannot walk through
      // would make /show-colliders a liar about the one set you just placed.
      spawned.debugBoxes(out);
    },
    /**
     * Every roof cylinder as [cx, cz, axisYaw, hl, r, y, ry]. Gated on the same
     * flag and for the same reason as the boxes above; nobody but a settlement
     * has a roof, so the NPC field never contributes one.
     */
    debugRidges(out: number[]): void {
      if (!flags.solids) return;
      towns?.solids.debugRidges(out);
      // Spawned huts and tents have roofs, and they are the same cylinders.
      spawned.debugRidges(out);
    },

    debugFurniture(): Array<{ kind: string; x: number; z: number }> {
      return (towns?.furniture ?? []).map((f) => ({
        kind: f.kind ?? '?', x: f.x, z: f.z,
      }));
    },

    debugFences(): ReturnType<World['debugFences']> {
      return (towns?.fences ?? []).map((f) => ({
        posts: f.posts.map((p) => ({
          x: +p.x.toFixed(3), z: +p.z.toFixed(3), y: +p.y.toFixed(3),
          base: +p.base.toFixed(3), kind: p.kind,
        })),
        closed: f.closed,
        bays: f.bays.map((b) => ({
          from: b.from, to: b.to, length: +b.length.toFixed(3),
          y: +b.y.toFixed(3), groundMax: +b.groundMax.toFixed(3),
        })),
      }));
    },

    debugCarriedTrees(): Array<{ x: number; z: number }> {
      return sky?.debugTrees() ?? [];
    },

    applyCelestial(state: Readonly<CelestialState>): void {
      // World-local consumers are updated here so composition code never has
      // to know which zone happens to own water, clouds, or a carried fall.
      waterMat.uniforms['uSunDir']?.value.copy(state.keyDirection);
      waterMat.uniforms['uSunColor']?.value.copy(state.keyColor);
      if (waterMat.uniforms['uSunStrength']) {
        waterMat.uniforms['uSunStrength'].value = state.keyIntensity / 3.05;
      }
      clouds?.applyCelestial(state);
      sky?.applyCelestial(state);
      towns?.applyCelestial(state);
    },

    update(focus: THREE.Vector3, dt: number, newFrame = true): void {
      if (disposed) return;
      // The build budget is per RENDERED FRAME, not per simulation slice. The
      // sim can run several slices in one frame (main.ts), and a per-slice
      // budget multiplied by those slices is what turned a catch-up frame into
      // six chunk stages and a 120 ms hitch.
      if (newFrame) {
        buildBudgetLeft = BUILD_BUDGET_MS;
        focusX = focus.x;
        focusZ = focus.z;
        waterMat.uniforms['uFocus'].value.set(focusX, focusZ);
        propLib.updateDistanceFade(focusX, focusZ);
        distant.requestUpdate(focus);
        // Far-landscape noise is deliberately outside the terrain chunk queue:
        // it never blocks collision-ready streaming. A sub-millisecond slice
        // avoids the combat/input hitch a whole 6,561-sample rebuild caused.
        distant.buildStep(0.6);
        // The fade is radial rather than chunk-stepped. A whole mesh can still
        // be rejected once its nearest edge is outside the fade, buying back
        // its draw and vertex work instead of merely discarding fragments.
        for (const rec of chunks.values()) applyLayers(rec);
      }
      time += dt;
      waterMat.uniforms['uTime'].value = time;
      // Nothing to dispose on the far side of this: the field owns no GPU
      // resource of its own, and the material it patched is `propLib`'s.
      sway?.update(focus, time, dt);
      // WHERE the island is was decided at the top of this slice, by
      // `carriers.advance` (see CarrierRegistry) — this is only the people
      // standing on it, which is the same call the ground crew gets below.
      sky?.update(dt, time, focus);
      // ...and the clouds are told where it ended up, so the deck parts around
      // it instead of a cumulus growing through the town square. One disc, set
      // per frame, because the island is the only thing in the sky that moves
      // and has a footprint.
      if (sky) clouds?.setKeepOut(sky.x, sky.y, sky.z, sky.radius, ISLAND_KEEL);
      clouds?.update(focus, dt);
      shops.update(time);
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
      // Spend the frame's budget one terrain row or prop batch at a time. Water
      // and each mesh's final typed-array conversion are the only indivisible
      // pieces, so the budget is a close target rather than a hard deadline.
      // That is deliberate — the alternative is leaving the queue stalled while
      // the player walks into unbuilt ground.
      while (buildBudgetLeft > 0 && (building || queue.length > 0 || foliageQueue.length > 0)) {
        const t0 = performance.now();
        if (!building && queue.length === 0) {
          const rec = foliageQueue.shift()!;
          const key = chunkKey(rec.cx, rec.cz);
          // A distance reduction or terrain unload can stale an entry that was
          // already queued. It is cheaper to reject it here than splice the
          // middle of a sorted queue on every settings change.
          if (chunks.get(key) !== rec || rec.propsBuilt || !wantsProps(rec)) {
            foliageQueued.delete(key);
            continue;
          }
          building = { rec, stage: 2, terrain: null, props: null, countChunk: false };
        }
        if (!building) {
          const q = queue.shift()!;
          const rec = startChunk(q.cx, q.cz);
          if (!rec) continue; // already built or in flight
          building = { rec, stage: 0, terrain: null, props: null, countChunk: true };
        }
        if (building.stage === 0) {
          // Ground is the expensive stage the player feels. The row-yielding
          // mesher keeps its CPU work inside this frame's remaining budget,
          // and publishes nothing until the whole chunk is internally complete;
          // the HLOD underlay remains the hill while these rows are built.
          building.terrain ??= buildTerrainMeshSteps(
            building.rec.cx, building.rec.cz, terrain, terrainMat,
          );
          let result = building.terrain.next();
          while (!result.done && performance.now() - t0 < buildBudgetLeft) {
            result = building.terrain.next();
          }
          buildBudgetLeft -= performance.now() - t0;
          if (!result.done) break;
          const m = result.value;
          m.name = 'chunk:terrain';
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
              building.rec.cx, building.rec.cz, terrain, propLib,
              exclusions, plan?.network ?? null,
            );
            let result = building.props.next();
            while (!result.done && performance.now() - t0 < buildBudgetLeft) {
              result = building.props.next();
            }
            buildBudgetLeft -= performance.now() - t0;
            if (!result.done) break;
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
          if (building.countChunk) perf.count('chunks');
          building = null;
        }
      }
    },

    setLayerVisible(layer: WorldLayer, on: boolean): void {
      hiddenLayers[layer] = !on;
      // The sky island's fall rides this switch: it is water, and a player who
      // turns water off expects no water anywhere. Deliberately BEFORE the
      // clouds branch and without returning — the streamed water chunks below
      // still have to be dealt with.
      if (layer === 'water') sky?.setWaterfallVisible(on);
      if (layer === 'water') distant.setWaterVisible(on);
      if (layer === 'clouds') {
        if (clouds) clouds.group.visible = on;
        return;
      }
      // Already-streamed chunks now, `applyLayers` for the ones built later —
      // a chunk that arrives after the switch was thrown has to arrive hidden,
      // or walking forward quietly turns the setting back on.
      for (const rec of chunks.values()) applyLayers(rec);
    },

    setViewOcclusion(eye: THREE.Vector3, pivot: THREE.Vector3, strength: number): void {
      propLib.updateOcclusion(eye, pivot, flags.occlusion ? strength : 0);
    },

    debugOcclusion(): { strength: number; radius: number; length: number } {
      return propLib.debugOcclusion();
    },

    setFoliageDistance(distance: number): void {
      // Gfx validates the three shipped choices before this sink is reached;
      // clamp again because World is a public contract and debug code may call
      // it directly. 64/96/128m are two, three and four terrain chunks.
      grassDistance = Math.max(64, Math.min(128, distance));
      propsDistance = Math.min(grassDistance + CHUNK_SIZE, viewRadius * CHUNK_SIZE);
      propLib.setDistanceFade(grassDistance);
      refreshFoliage();
      for (const rec of chunks.values()) applyLayers(rec);
    },

    setTerrainDistance(distance: number): void {
      const nextDistance = distance <= 480 ? 480 : distance >= 900 ? 900 : 600;
      if (nextDistance === terrainDistance) return;
      terrainDistance = nextDistance;
      // Low / Medium / High deliberately use 4 / 5 / 5 voxel-detail chunks.
      // High spends on a denser, longer HLOD instead of doubling the number of
      // expensive cube meshes. A ?view= developer override stays authoritative.
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
      for (const rec of chunks.values()) applyLayers(rec);
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
     * Throw away every streamed chunk and build them again.
     *
     * The one thing a NATURE PARAMETER change needs (world/nature.ts): the
     * densities are read inside `buildChunkProps`, so a chunk that is already
     * standing holds the old world and nothing short of rebuilding it can say
     * otherwise. Deliberately the whole set rather than the props meshes alone —
     * a chunk's three stages share one `ChunkRec` and one entry in the trunk
     * registry, and half-rebuilding it would leave trees in `climbTopAt` that
     * are no longer drawn.
     *
     * It is a TUNING path, not a frame path: dropping ~90 chunks and streaming
     * them back costs the same as walking into fresh ground and takes about as
     * long. Nothing calls it in play.
     *
     * The hero cannot fall through the result — `getHeight` is a pure function
     * of the seed (world/terrain.ts) and never consults a loaded chunk — so the
     * rebuild can be left entirely to the streamer's own budget.
     */
    rebuildProps(): void {
      if (disposed) return;
      for (const rec of chunks.values()) disposeChunk(rec);
      chunks.clear();
      trunks.clear();
      foliageQueue.length = 0;
      foliageQueued.clear();
      // The part-built chunk's record is gone; a further stage on it would add
      // meshes to a record nothing owns. Same reason `unloadFar` drops it.
      building = null;
      // Force `update` to re-queue: it only refreshes when the focus crosses a
      // chunk boundary, and standing still is the normal case while tuning.
      lastCX = Infinity;
      invalidateStaticShadows();
    },

    setVisible(v: boolean): void {
      worldShown = v;
      distant.setVisible(v);
      // SHOWING THE WORLD MEANS SHOWING IT AS CONFIGURED, which is why this
      // goes through `applyLayers` rather than setting every mesh true.
      //
      // This was the reported bug and it is a good one. The ZoneManager hides
      // the active world for a moment to warm the DESTINATION zone's shaders
      // against its own light population (zones.ts), then turns it back on —
      // and a blanket `visible = true` there re-showed every layer the F3 panel
      // had switched off. The symptom was exactly what you would expect and
      // nothing like what you would guess: grass stayed off while you stood
      // still, then came back in a lump the moment you wandered near a gateway
      // and the preload started. Measured, 80 of 89 grass meshes lit up again.
      for (const rec of chunks.values()) applyLayers(rec);
      // The den lamps live under shops.group, so this is also what takes the
      // world's four point lights out of the scene's light count. See World.
      shops.group.visible = v;
      // The towns add no lights at all (see town-parts.ts), so this is purely
      // about not drawing an overworld camp into a dungeon's warm-up render.
      if (towns) towns.group.visible = v;
      if (npcs) npcs.setVisible(v);
      // The island carries its own people and its own lamps, so one flag on its
      // root takes the lot — including, importantly, nothing: it adds no lights
      // to the scene (its glow is emissive, like every fire in the game), so a
      // zone warm-up rendered with it visible would still compile at the right
      // light counts. Hidden anyway, because it is a hundred units of rock.
      sky?.setVisible(v);
      // Same rule for the sky ambience: a hidden layer stays hidden through a
      // hide/show cycle, so `&& !hiddenLayers.clouds` rather than a bare `v`.
      if (clouds) clouds.group.visible = v && !hiddenLayers.clouds;
      // Once, at the bottom, for the whole sweep. `applyLayers` says it too on
      // the way up, but the hide branch never calls it and the camp is hidden
      // by a flag of its own — so the cached shadow map would otherwise have
      // kept a whole settlement's shadows through a zone handover.
      invalidateStaticShadows();
    },

    /**
     * A handful of chunks per call, then everything else. See World for the
     * measurement that made this necessary.
     *
     * 6 per frame empties the 90-110 chunks a walked-in world holds in under
     * 20 frames — a third of a second, all of it while the hero is somewhere
     * else entirely.
     */
    disposeStep(): boolean {
      if (disposed) return true;
      let n = 6;
      for (const [key, rec] of chunks) {
        if (n <= 0) return false;
        n--;
        if (building && building.rec === rec) building = null;
        disposeChunk(rec);
        chunks.delete(key);
      }
      this.dispose();
      return true;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const rec of chunks.values()) disposeChunk(rec);
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
}
