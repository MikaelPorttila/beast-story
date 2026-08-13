/**
 * TOWNS — named places on the overworld and the road network joining them. A town is
 * an OVERWORLD LANDMARK, not a zone: a flatten disc, a forest exclusion, a
 * `GroundPatch` and a merged mesh, all from one registry entry. WHICH towns exist is
 * content; SITING them is this file. The network is a HUB, and each town has ONE
 * road exit, where the route crosses its radius.
 */
import * as THREE from "three";
import type { CelestialState, TownInfo, TownRegistry } from "../core/types";
import { VoxelModel } from "../core/voxel";
import { t, type StringKey } from "../i18n";
import { content, defineFactory, resolveText, TOWN_LAYOUT_KIND, type TownData } from "../content";
import type { ContentText } from "../content/types";
import { displayKey, reportContentIssue } from "../core/content-bridge";
import type { Terrain } from "./terrain";
import { WATER_LEVEL, type GroundPatch } from "./terrain";
import {
  RoadNetwork,
  roadAt,
  roadLength,
  routeRoad,
  profileRoad,
  straightWetLength,
  builtDeck,
  setTrimStart,
  NECK_MAX,
  type Junction,
  type Road,
  type RoadClearance,
} from "./roads";
import { ROAD_PROFILE, trackProfile } from "./path-profile";
import { Accum, bakeProp, type PropLib, type Template } from "./props";
import { SolidStamp, StructureField, footprintRadius } from "./structures";
import type { TownParts } from "./town-parts";
import {
  V,
  FENCE_POST_R,
  addBridgeFurniture,
  buildJunctionApron,
  buildRoadRibbon,
  fitPalisadeRun,
  signArm,
} from "./town-parts";
import { buildFence, type Fence, type FenceNode, type FenceOptions } from "./fences";
import { mulberry32 } from "./noise";
import { TOWN_NO_SPAWN_MARGIN } from "./safe-zones";

/** How much bigger the Encampment's timber is than its template: its logs top out at
 *  4.90, so the wall MEETS the gate arch's 5.04 lintel. */
const WALL_S = 1.25;

const NIGHT_WINDOW: Template = (() => {
  const v = new VoxelModel();
  v.box(-1, 0, 0, 0, 1, 0, 0xffc56b);
  return bakeProp(v, 0.22);
})();

function addNightWindow(
  acc: Accum,
  x: number,
  y: number,
  z: number,
  yaw: number,
  front: number,
  height: number,
): void {
  acc.add(
    NIGHT_WINDOW,
    x + Math.sin(yaw) * front,
    y + height,
    z + Math.cos(yaw) * front,
    yaw,
    1,
    1,
    1,
    1,
  );
}

/** Half a side of the Encampment's square wall; its corners reach 23.76, which is
 *  what `outerRadius` is for. */
const CAMP_WALL_HALF = 16.8;

export interface TownSite {
  /** Stable IDENTIFIER — the `name` half of the content id; survives a rename. */
  id: string;
  /** DISPLAY name, as a string-table key. See `displayKey`. */
  nameKey: StringKey;
  /** What a fingerpost arm reads: <= 10 upper-case characters in the 3x5 voxel font.
   *  A `ContentText` and not a key, because a carved plank is PRINTED. */
  sign: ContentText;
  /** Which registered `town-layout` builds it; layout NAME and settlement KIND are one. */
  kind: TownInfo["kind"];
  radius: number;
  /** How far this settlement's PERIMETER reaches; `radius` is the nominal circle.
   *  SUPPLIED BY THE LAYOUT, because a copy in JSON forks a load-bearing number. */
  outerRadius: number;
  /** How far out nothing hostile may spawn; 0 means no zone. See `SafeZone`. */
  noSpawnRadius: number;
  color: number;
  /** Prefer water in the outer ring — what puts a BRIDGE in the network reliably. */
  waterside: boolean;
  /** Placement order, ascending. */
  order: number;
  /** The town the player starts on the road out of. */
  start: boolean;
}

/** A `town-layout` factory: paint a settlement and say where its social focus ended
 *  up. ONE SIGNATURE FOR BOTH, `hearth` included. */
export type TownLayout = (
  solid: SolidStamp,
  glow: Accum,
  hearth: Accum,
  night: Accum,
  parts: TownParts,
  town: TownInfo,
  network: RoadNetwork,
  rng: () => number,
) => {
  x: number;
  z: number;
  /** The camp's taming pen, where a layout built one — see `World.tamingPen`. */
  pen?: { x: number; z: number; r: number };
} | null;

const LAYOUTS: ReadonlySet<string> = new Set<TownInfo["kind"]>(["camp", "hamlet"]);

/** How far a layout's built perimeter reaches. See `TownSite.outerRadius`. */
function outerRadiusOf(kind: TownInfo["kind"], radius: number): number {
  return kind === "camp" ? CAMP_WALL_HALF * Math.SQRT2 : radius;
}

/** The world's towns, in placement order — by `data.order`, not load order. One the
 *  engine cannot build is REFUSED with a diagnostic. */
function readSites(zone: string): readonly TownSite[] {
  const assets = content.all<TownData>("town");
  const sites: TownSite[] = [];
  for (const asset of assets) {
    const { data } = asset;
    // ANOTHER ZONE'S TOWN IS NOT THIS PLANNER'S (issue #144): each zone sites
    // only its own, or the Brine Reach's harbour would be the fourth ground
    // settlement this hub refuses.
    if (data.zone !== zone) {
      continue;
    }
    // A CARRIED SETTLEMENT IS NOT THIS FILE'S: its layout belongs to the carrier.
    if (data.carried) {
      continue;
    }
    if (!LAYOUTS.has(data.layout)) {
      reportContentIssue({
        severity: "error",
        code: "unknown-factory",
        message: `"${asset.id}" wants layout "${data.layout}", which no builder implements`,
        assetId: asset.id,
        assetType: asset.type,
        pkg: asset.pkg,
        source: asset.source,
        field: "data.layout",
        fix: `one of ${[...LAYOUTS].join(", ")}`,
      });
      continue;
    }
    const nameKey = displayKey(asset);
    if (nameKey === null) {
      continue;
    }
    // `LAYOUTS.has` is the runtime narrowing; the assertion only tells the compiler.
    const kind = data.layout as TownInfo["kind"];
    const outer = data.outerRadius ?? outerRadiusOf(kind, data.radius);
    sites.push({
      // The `name` half of the content id — the same split `parseId` makes.
      id: asset.id.slice(asset.type.length + 1),
      nameKey,
      sign: data.sign,
      kind,
      radius: data.radius,
      outerRadius: outer,
      // `??` and not `||`: an authored 0 means "no keep-out" and has to survive.
      noSpawnRadius: data.noSpawnRadius ?? outer + TOWN_NO_SPAWN_MARGIN,
      color: data.color,
      waterside: data.waterside,
      order: data.order,
      start: data.start,
    });
  }
  // `sort` is stable in ES2019+, so towns that tie on `order` keep load order.
  return sites.toSorted((a, b) => a.order - b.order);
}

/** How many settlements hang off the fork. See `planSettlements`'s hub note. */
const SPUR_COUNT = 2;

/**
 * HOW FAR APART THE TOWNS STAND — what matters is the SUM, since the fork is scenery
 * on the way between towns (issue #184). A unit is about a metre, so a ~1 km leg is
 * under three minutes on foot. THE TRUNK IS DELIBERATELY SHORT: the hero SPAWNS ON
 * IT and the whole starting country is placed around that point.
 */
const TRUNK_MIN = 70;
const TRUNK_MAX = 96;
const SPUR_MIN = 830;
const SPUR_MAX = 950;

/** The start town and the towns hanging off the fork, or null when this content
 *  cannot make the network. EXACTLY THREE ARMS; no towns at all is `towns=0`. */
function hub(sites: readonly TownSite[]): { start: TownSite; spurs: readonly TownSite[] } | null {
  const start = sites.find((s) => s.start);
  if (!start) {
    return null;
  }
  const spurs = sites.filter((s) => s !== start);
  if (spurs.length < SPUR_COUNT) {
    return null;
  }
  for (const extra of spurs.slice(SPUR_COUNT)) {
    reportContentIssue({
      severity: "warn",
      code: "unsupported",
      message: `"town:${extra.id}" is not sited: the road network has ${SPUR_COUNT} spurs`,
      assetId: `town:${extra.id}`,
      assetType: "town",
      fix: "the hub in world/towns.ts routes one trunk and two spurs",
    });
  }
  return { start, spurs: spurs.slice(0, SPUR_COUNT) };
}

/** How high the haze is told a road sits, in `vFogElev` units — the only setter
 *  (issue #190). 0.28 is PARITY: a road then fades like the hills around it. */
const RIBBON_FOG_LIFT = 0.28;

/** The terrain material, told a road is not quite the ground it lies on. A CLONE:
 *  lifting the shared one would lift the ground out of its own haze. */
function makeRibbonMaterial(terrainMat: THREE.Material): THREE.Material {
  const mat = terrainMat.clone();
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.bsFogGroundLift = { value: RIBBON_FOG_LIFT };
  };
  // Its own program: sharing one with the chunks would share their uniform value.
  mat.customProgramCacheKey = () => "bs-road-ribbon-fog-v1";
  return mat;
}

const JUNCTION_SIGN_KEY = "town.junction.sign" as const;

/**
 * How far all three decks are held DEAD LEVEL across the fork. `surfaceAt` answers
 * with the NEAREST road's deck, so two decks of different heights make the field JUMP
 * — an invisible wall, since the ribbon steps with it. Works only PAIRED with the
 * router keeping the arms apart (`AVOID_R`); guard test-road.
 */
const JUNCTION_HOLD = 20;

/**
 * HOW A SETTLEMENT WEARS ITS GROUND, by kind. Every number is a fraction of the
 * town's OWN radius or a bearing relative to its OWN gate, so this table plus a
 * `TownInfo` is a complete `GroundPatch`.
 */
interface WearSpec {
  /** Wear away from any track, 0..1. */
  base: number;
  /** Where the wear starts fading, in radii. */
  fade: number;
  /** Where it has faded to nothing, in radii. */
  edge: number;
  /** Bias toward damp mud over dry packed earth, 0..1. */
  damp: number;
  /** Beaten tracks: bearing RELATIVE TO THE GATE, length in radii, half width, wear. */
  tracks: ReadonlyArray<readonly [number, number, number, number]>;
}

const HALF_PI = Math.PI / 2;

const WEAR: Record<TownInfo["kind"], WearSpec> = {
  camp: {
    // FLAT 1.0, not 0.92: a trace of grass tints the whole yard olive.
    base: 1.0,
    // At the palisade the rim still holds 0.91, so the ground is bare to the wall.
    fade: 0.9,
    edge: 1.3,
    damp: 0.55,
    tracks: [
      // THE THOROUGHFARE — the cart road, which `buildEncampment` keeps clear.
      [0, 1.25, 4.4, 1.0],
      // THE FIRE, a quarter-turn off the road axis, on a side rolled per seed.
      [HALF_PI, 0.34, 3.6, 1.0],
      [-HALF_PI, 0.34, 3.6, 1.0],
      [Math.PI - 0.75, 0.62, 2.6, 0.95],
      [Math.PI, 0.62, 2.6, 0.95],
      [Math.PI + 0.75, 0.62, 2.6, 0.95],
      [1.5, 0.66, 2.4, 0.88],
      [2.6, 0.66, 2.4, 0.88],
      [3.8, 0.66, 2.4, 0.88],
    ],
  },
  hamlet: {
    // Half the camp's, and the TRACKS stay narrow: a hamlet shows where its feet go.
    base: 0.52,
    fade: 0.8,
    edge: 1.28,
    damp: 0.3,
    tracks: [
      [0, 1.2, 3.8, 1.0], // the road in
      [HALF_PI, 0.36, 3.2, 1.0], // the well, at gateAngle + PI/2 and 4.2 out
      [Math.PI * 0.55, 0.6, 2.4, 0.95], // the four cottages
      [Math.PI * 1.0, 0.6, 2.4, 0.95],
      [Math.PI * 1.45, 0.6, 2.4, 0.95],
      [-0.9, 0.55, 2.2, 0.88], // the tents and the paddock cart
      [-1.8, 0.55, 2.2, 0.88],
    ],
  },
};

/** The `GroundPatch` a town wears — its YARD. The tracks are `wearTracks`. */
function wearPatch(town: TownInfo): GroundPatch {
  const spec = WEAR[town.kind];
  return {
    x: town.x,
    z: town.z,
    fade: spec.fade * town.radius,
    edge: spec.edge * town.radius,
    base: spec.base,
    damp: spec.damp,
  };
}

/** A settlement's beaten tracks, as PATHS on the network (issue #142). A track may
 *  NOT refuse what is built beside it: these lines were derived FROM the layout. */
function wearTracks(town: TownInfo, y: number): Road[] {
  const spec = WEAR[town.kind];
  return spec.tracks.map(([rel, len, hw, s], i) => {
    const a = town.gateAngle + rel;
    const d = len * town.radius;
    return {
      id: `track:${town.id}-${i}`,
      fromId: town.id,
      toId: town.id,
      profile: trackProfile(hw),
      wear: s,
      pts: [
        { x: town.x, z: town.z, y, bridge: false },
        { x: town.x + Math.sin(a) * d, z: town.z + Math.cos(a) * d, y, bridge: false },
      ],
      trim: new Float32Array(8),
    };
  });
}

/** How level and dry the ground around (x, z) is, lower being better; Infinity
 *  disqualifies. A flatten disc on a hillside is a 40-unit earthwork. */
function siteCost(terrain: Terrain, x: number, z: number, r: number, waterside = false): number {
  const h = terrain.heightCont(x, z);
  let worst = 0;
  let wet = 0;
  for (let a = 0; a < 12; a++) {
    const ang = (a / 12) * Math.PI * 2;
    // OUT TO WHERE THE FLATTEN STOPS: the blend runs to `outerRadius + 15`.
    for (const rr of [r * 0.55, r, r * 1.35, r * 2]) {
      const nh = terrain.heightCont(x + Math.cos(ang) * rr, z + Math.sin(ang) * rr);
      worst = Math.max(worst, Math.abs(nh - h));
      if (nh < WATER_LEVEL + 0.5) {
        wet++;
      }
    }
  }
  // FINITE EVERYWHERE: a function whose job is "least bad" must rank bad options.
  const drown = Math.max(0, WATER_LEVEL + 2.2 - h);
  // A waterside site wants a shore in its outer ring, and still no wet centre.
  const wetTerm = waterside ? Math.abs(wet - 8) * 1.6 : wet * 1.4;
  return worst * 1.6 + wetTerm + drown * 40;
}

function findSite(
  terrain: Terrain,
  ox: number,
  oz: number,
  minR: number,
  maxR: number,
  baseAngle: number,
  spread: number,
  r: number,
  rng: () => number,
  waterside = false,
): { x: number; z: number } {
  let bestX = ox + Math.sin(baseAngle) * maxR;
  let bestZ = oz + Math.cos(baseAngle) * maxR;
  let best = Infinity;
  for (let ri = 0; ri <= 6; ri++) {
    const dist = minR + ((maxR - minR) * ri) / 6;
    for (let k = 0; k < 13; k++) {
      const ang = baseAngle + (k / 12 - 0.5) * 2 * spread + (rng() - 0.5) * 0.08;
      const x = Math.round(ox + Math.sin(ang) * dist) + 0.5;
      const z = Math.round(oz + Math.cos(ang) * dist) + 0.5;
      let c = siteCost(terrain, x, z, r, waterside);
      if (waterside) {
        // ACROSS a channel from the road's side, not merely beside water: this is what forces
        // a bridge, since the router goes round anything over NECK_MAX.
        const line = straightWetLength(terrain, ox, oz, x, z);
        c += line < 6 || line > NECK_MAX ? 250 : Math.abs(line - 20) * 2;
      }
      if (c < best) {
        best = c;
        bestX = x;
        bestZ = z;
      }
    }
  }
  return { x: bestX, z: bestZ };
}

/** Where a road crosses out of a town's footprint — i.e. where its gate goes. */
function gateOn(
  road: Road,
  cx: number,
  cz: number,
  radius: number,
  fromStart: boolean,
): {
  x: number;
  z: number;
  angle: number;
} {
  const n = road.pts.length;
  for (let i = 0; i < n; i++) {
    const p = road.pts[fromStart ? i : n - 1 - i];
    const d = Math.hypot(p.x - cx, p.z - cz);
    if (d >= radius) {
      return { x: p.x, z: p.z, angle: Math.atan2(p.x - cx, p.z - cz) };
    }
  }
  const p = road.pts[fromStart ? n - 1 : 0];
  const a = Math.atan2(p.x - cx, p.z - cz);
  return { x: cx + Math.sin(a) * radius, z: cz + Math.cos(a) * radius, angle: a };
}

/** Where a road first crosses the plane `dot(p - c, n) = h` — INTERPOLATED, because
 *  `gateOn`'s samples are 3 units apart and an arch would stand off its wall. */
function planeHit(
  road: Road,
  cx: number,
  cz: number,
  nx: number,
  nz: number,
  h: number,
): { x: number; z: number } {
  const pts = road.pts;
  const at = (i: number): number => (pts[i].x - cx) * nx + (pts[i].z - cz) * nz;
  for (let i = 1; i < pts.length; i++) {
    const a = at(i - 1);
    const b = at(i);
    if (b >= h && a < h) {
      const frac = (h - a) / (b - a);
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * frac,
        z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * frac,
      };
    }
  }
  // A caller with a broken plane should get a point on the wall, not a crash.
  return { x: cx + nx * h, z: cz + nz * h };
}

/** The registry, plus what `World.addPath` needs: a runtime path must not make
 *  `__dbgTowns().roads` disagree with the ground (issue #142 §12a). */
export interface MutableTownRegistry extends TownRegistry {
  addRoad(road: Road): void;
  /** Replace the whole list, which a crossing MERGE needs: it splits two edges into four. */
  setRoads(roads: readonly Road[]): void;
}

export interface SettlementPlan {
  towns: MutableTownRegistry;
  network: RoadNetwork;
  /** Scenic point on the start town's road; the world's spawn. */
  spawn: THREE.Vector3;
  /** The three-way fork. */
  junction: { x: number; y: number; z: number };
  /** The resolved content the registry was built from. Here because the SIGN is not on
   *  `TownInfo`: only this file's fingerposts want ten upper-case characters. */
  sites: readonly TownSite[];
}

/** The resolved site with this id, or null — `'junction'` is not a town. */
function siteOf(sites: readonly TownSite[], id: string): TownSite | null {
  return sites.find((s) => s.id === id) ?? null;
}

function roadRecord(r: Road): TownRegistry["roads"][number] {
  const path = new Float32Array(r.pts.length * 3);
  const bridge = new Uint8Array(r.pts.length);
  for (let i = 0; i < r.pts.length; i++) {
    path[i * 3] = r.pts[i].x;
    path[i * 3 + 1] = r.pts[i].y;
    path[i * 3 + 2] = r.pts[i].z;
    bridge[i] = r.pts[i].bridge ? 1 : 0;
  }
  return {
    id: r.id,
    from: r.fromId,
    to: r.toId,
    path,
    bridge,
    profile: r.profile.id,
    deckEdge: r.profile.deckEdge,
  };
}

class Registry implements MutableTownRegistry {
  private readonly mutableRoads: Array<TownRegistry["roads"][number]>;
  readonly roads: TownRegistry["roads"];

  constructor(
    readonly all: readonly TownInfo[],
    roads: readonly Road[],
  ) {
    this.mutableRoads = roads.map(roadRecord);
    this.roads = this.mutableRoads;
  }

  addRoad(road: Road): void {
    this.mutableRoads.push(roadRecord(road));
  }

  setRoads(roads: readonly Road[]): void {
    this.mutableRoads.length = 0;
    for (const r of roads) {
      this.mutableRoads.push(roadRecord(r));
    }
  }

  get(id: string): TownInfo | undefined {
    return this.all.find((town) => town.id === id);
  }
  nearest(x: number, z: number): TownInfo | null {
    let best: TownInfo | null = null;
    let bd = Infinity;
    for (const town of this.all) {
      const d = Math.hypot(town.x - x, town.z - z);
      if (d < bd) {
        bd = d;
        best = town;
      }
    }
    return best;
  }
}

/** Site the towns, cut the roads and pick the spawn. MUST run before any chunk is
 *  built and before `terrain.roads` is set, or the road routes along itself. NULL
 *  when there is nothing to plan — the `towns=0` state. */
export function planSettlements(
  terrain: Terrain,
  seed: number,
  /** Which zone's towns to site — this planner reads only its own (issue #144). */
  zone = "overworld",
): SettlementPlan | null {
  const parts = hub(readSites(zone));
  if (!parts) {
    return null;
  }
  // [start, ...spurs] — the order the rest of this function indexes.
  const sites: readonly TownSite[] = [parts.start, ...parts.spurs];

  const rng = mulberry32(seed ^ 0x70b1);
  const towns: TownInfo[] = [];

  // -- 1. Sites. The start town first; the other two hang off the junction.
  /** The levelled height of a site, floored clear of the water: each is a road ANCHOR. */
  const levelAt = (x: number, z: number): number =>
    Math.max(WATER_LEVEL + 2, Math.round(terrain.heightCont(x, z)));

  const camp = findSite(terrain, 0, 0, 88, 132, rng() * Math.PI * 2, Math.PI, sites[0].radius, rng);
  const campY = levelAt(camp.x, camp.z);

  // The gate bearing is rolled here and nowhere else; the gate follows the road.
  const exitAngle = rng() * Math.PI * 2;
  const jRaw = findSite(terrain, camp.x, camp.z, TRUNK_MIN, TRUNK_MAX, exitAngle, 0.75, 12, rng);
  const junctionY = levelAt(jRaw.x, jRaw.z);

  const jAngle = Math.atan2(jRaw.x - camp.x, jRaw.z - camp.z);
  const spurA = jAngle + 0.95 + rng() * 0.5;
  const spurB = jAngle - 0.95 - rng() * 0.5;
  const hamletA = findSite(
    terrain,
    jRaw.x,
    jRaw.z,
    SPUR_MIN,
    SPUR_MAX,
    spurA,
    0.6,
    sites[1].radius,
    rng,
    sites[1].waterside,
  );
  const hamletB = findSite(
    terrain,
    jRaw.x,
    jRaw.z,
    SPUR_MIN,
    SPUR_MAX,
    spurB,
    0.6,
    sites[2].radius,
    rng,
    sites[2].waterside,
  );
  const sitePos = [camp, hamletA, hamletB];
  const siteY = [campY, levelAt(hamletA.x, hamletA.z), levelAt(hamletB.x, hamletB.z)];

  // -- 2. Level the ground under each town BEFORE routing.
  for (let i = 0; i < sites.length; i++) {
    terrain.flattens.push({
      x: sitePos[i].x,
      z: sitePos[i].z,
      h: siteY[i] + 0.55,
      core: sites[i].outerRadius + 2,
      blend: sites[i].outerRadius + 15,
    });
  }

  // -- 3. Roads. Anchored at both ends to heights the towns have committed to.
  const network = new RoadNetwork();
  // A road INSIDE a settlement is level with it; each is routed AGAINST the ones
  // already routed, the trunk first because the hero spawns on it.
  const mkRoad = (
    id: string,
    fromId: string,
    toId: string,
    ax: number,
    az: number,
    ay: number,
    bx: number,
    bz: number,
    by: number,
    s: number,
    aHold = 0,
    bHold = 0,
    // The three ground roads are cart roads; a second profile is an asset decision.
    profile = ROAD_PROFILE,
  ): Road => {
    const route = routeRoad(
      terrain,
      ax,
      az,
      bx,
      bz,
      s,
      network.roads.map((r) => r.pts),
      profile,
    );
    const road: Road = {
      id,
      fromId,
      toId,
      profile,
      pts: profileRoad(terrain, route, ay, by, aHold, bHold),
      // Left at zero; `network.build()` squares both planes to the road's own ends.
      trim: new Float32Array(8),
    };
    network.add(road);
    return road;
  };
  const hold = (i: number): number => sites[i].outerRadius + 2;

  const trunk = mkRoad(
    "camp-junction",
    sites[0].id,
    "junction",
    camp.x,
    camp.z,
    campY,
    jRaw.x,
    jRaw.z,
    junctionY,
    seed ^ 0x11,
    hold(0),
    JUNCTION_HOLD,
  );
  const spurRoads = [
    mkRoad(
      "junction-" + sites[1].id,
      "junction",
      sites[1].id,
      jRaw.x,
      jRaw.z,
      junctionY,
      hamletA.x,
      hamletA.z,
      siteY[1],
      seed ^ 0x22,
      JUNCTION_HOLD,
      hold(1),
    ),
    mkRoad(
      "junction-" + sites[2].id,
      "junction",
      sites[2].id,
      jRaw.x,
      jRaw.z,
      junctionY,
      hamletB.x,
      hamletB.z,
      siteY[2],
      seed ^ 0x33,
      JUNCTION_HOLD,
      hold(2),
    ),
  ];
  // The fork is levelled like a small town, AFTER routing so the field the router
  // searched is untouched.
  terrain.flattens.push({
    x: jRaw.x,
    z: jRaw.z,
    h: junctionY + 0.55,
    core: 5,
    blend: 12,
  });
  // AND THE FORK IS A PIECE OF CARRIAGEWAY: `junctionY`, the height the arms hold.
  network.addJunction(jRaw.x, jRaw.z, junctionY, trunk.profile);

  // NO FOOTPATH YET (issue #142 §14): a hamlet shortcut measured 362 against 318.

  // -- 4. Gates, from where each road leaves its town. BEFORE `network.build()`.
  const gates = [
    gateOn(trunk, camp.x, camp.z, sites[0].radius, true),
    gateOn(spurRoads[0], hamletA.x, hamletA.z, sites[1].radius, false),
    gateOn(spurRoads[1], hamletB.x, hamletB.z, sites[2].radius, false),
  ];

  // The camp's gate is on a SQUARE wall, so the opening is on that side's plane.
  {
    const a = gates[0].angle;
    const nx = Math.sin(a);
    const nz = Math.cos(a);
    const hit = planeHit(trunk, camp.x, camp.z, nx, nz, CAMP_WALL_HALF);
    gates[0] = { x: hit.x, z: hit.z, angle: a };
    // Inside the wall the road is route only; `WEAR.camp.tracks[0]` paints it bare.
    setTrimStart(trunk, hit.x, hit.z, nx, nz);
  }

  for (let i = 0; i < sites.length; i++) {
    towns.push({
      id: sites[i].id,
      nameKey: sites[i].nameKey,
      kind: sites[i].kind,
      x: sitePos[i].x,
      y: siteY[i],
      z: sitePos[i].z,
      radius: sites[i].radius,
      outerRadius: sites[i].outerRadius,
      // Sited on the height field below, which is what `carried` denies.
      carried: false,
      noSpawnRadius: sites[i].noSpawnRadius,
      color: sites[i].color,
      gateX: gates[i].x,
      gateZ: gates[i].z,
      gateAngle: gates[i].angle,
    });
  }

  // -- 5. The worn ground. AFTER the gates (gate-relative) and before `build()`.
  for (const town of towns) {
    terrain.grounds.push(wearPatch(town));
    for (const track of wearTracks(town, town.y)) {
      network.add(track);
    }
  }

  network.build();
  terrain.roads = network;

  return {
    // DRAWN paths only: beaten tracks live on the network, where placers ask.
    towns: new Registry(
      towns,
      network.roads.filter((r) => r.profile.roles.draw),
    ),
    network,
    spawn: pickRoadSpawn(trunk, camp.x, camp.z),
    junction: { x: jRaw.x, y: trunk.pts[trunk.pts.length - 1].y, z: jRaw.z },
    sites,
  };
}

/** The player's spawn: a scenic stretch of the Encampment road, far enough out that
 *  the camp is a destination you can walk to. A score, not a rule: 40-70 units out,
 *  HIGH relative to the road either side, not a bridge. */
function pickRoadSpawn(road: Road, cx: number, cz: number): THREE.Vector3 {
  const len = roadLength(road);
  const at = { x: 0, y: 0, z: 0, dx: 0, dz: 0 };
  const probe = { x: 0, y: 0, z: 0, dx: 0, dz: 0 };
  let best = -Infinity;
  let bx = road.pts[0].x;
  let by = road.pts[0].y;
  let bz = road.pts[0].z;
  for (let s = 18; s < len - 8; s += 2) {
    roadAt(road, s, at);
    const fromCamp = Math.hypot(at.x - cx, at.z - cz);
    if (fromCamp < 34 || fromCamp > 74) {
      continue;
    }
    if (at.y < WATER_LEVEL + 1.5) {
      continue;
    }
    // How much this point stands above the road 24 units either side of it.
    let rise = 0;
    for (const ds of [-24, 24]) {
      roadAt(road, Math.max(0, Math.min(len, s + ds)), probe);
      rise += at.y - probe.y;
    }
    const score = rise * 3 + at.y * 0.4 - Math.abs(fromCamp - 52) * 0.55;
    if (score > best) {
      best = score;
      bx = at.x;
      by = at.y;
      bz = at.z;
    }
  }
  return new THREE.Vector3(bx, by, bz);
}

/** Voxel scale for a signpost arm — see the note on the font in town-parts.ts. */
const SIGN_V = 0.095;

interface Spot {
  x: number;
  z: number;
  /** PLACEMENT radius: how much room this piece wants around it. */
  r: number;
  /** PHYSICAL radius — its own timber — where that differs from `r`. See `clearRun`. */
  solidR?: number;
  kind?: string;
}

/**
 * How close a LAMP or a FINGERPOST may come to a carriageway centreline. A pass
 * offsets from ITS OWN centreline, so at a fork "6.1 off my road" is "in the middle of
 * the next one" (issue #15). A margin OUTSIDE the rim; 0.9 covers a cairn.
 */
const POST_ROAD_CLEAR = 0.9;
/** The same for a LAMP; under the 0.8 it stands off its OWN rim, or all are rejected. */
const LAMP_ROAD_CLEAR = 0.5;

/** How far a fingerpost's cairn spreads from the post line — see `signPost`. */
const POST_FOOT = 1.2;

/** Ground a fingerpost and a lamp each claim, so nothing crowds them. Only a
 *  NEIGHBOURING road's furniture is turned away — six pieces inside twenty units at
 *  a fork is issue #15. */
const LAMP_CLEAR = 11;
const POST_CLEAR = 5;

/**
 * The lowest walking surface under a footprint of radius `r`, so a thing is PLANTED:
 * past the rim the ground is the shoulder, not the deck (issue #15). The MINIMUM over
 * the footprint, so a post is set into the bank rather than on a high corner.
 */
function seatOn(
  surfaceAt: (x: number, z: number) => number,
  x: number,
  z: number,
  r: number,
): number {
  let y = surfaceAt(x, z);
  for (const [dx, dz] of [
    [r, 0],
    [-r, 0],
    [0, r],
    [0, -r],
  ] as const) {
    const h = surfaceAt(x + dx, z + dz);
    if (h < y) {
      y = h;
    }
  }
  return y;
}

/** The nearest spot to (x, z) clear of every carriageway: ask the network rather than
 *  guess a bearing that ought to be clear. */
function vergeNear(
  network: RoadClearance,
  x: number,
  z: number,
  clear: number,
): { x: number; z: number } {
  for (let ring = 1; ring <= 8; ring++) {
    const d = ring * 3;
    // Sixteen bearings, offset per ring so the rings do not sample one line of spokes.
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2 + ring * 0.2;
      const px = x + Math.sin(a) * d;
      const pz = z + Math.cos(a) * d;
      if (network.builtEdgeDistanceTo(px, pz) >= clear) {
        return { x: px, z: pz };
      }
    }
  }
  return { x, z };
}

/** The scene side of the town system: every settlement and every metre of road
 *  furniture, merged into a handful of meshes. Built ONCE at world creation and not
 *  streamed — the Encampment in the stream doubled the worst chunk build. */
export class Towns {
  readonly group = new THREE.Group();
  /** What every piece stamped below BLOCKS — the world's `structureTopAt`, filled by
   *  the same `SolidStamp.add` calls that fill the meshes. */
  readonly solids = new StructureField();
  /** Every lamp and fingerpost the road pass stood up — a MEASUREMENT for `__dbgTowns().furniture`. */
  readonly furniture: readonly Spot[] = [];
  /** Every fence the road pass built, chain by chain. See `World.debugFences`. */
  readonly fences: readonly Fence[] = [];
  private readonly glowMats: THREE.MeshStandardMaterial[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  /** What `addPathRibbon` needs: a runtime path must arrive on the same material, bias
   *  sequence and aprons as the ones built at boot. */
  private ribbonCtx!: {
    terrainMat: THREE.Material;
    surfaceAt: (x: number, z: number) => number;
    columnTop: (x: number, z: number) => number;
    seed: number;
  };
  /** One group holding every ribbon and apron, so an edit can drop the lot and re-emit. */
  private readonly pathGroup = new THREE.Group();
  private ribbonMat: THREE.Material | null = null;
  /** Per-site groups and their centres, for the distance cull in `update`. */
  private readonly sites: Array<{ g: THREE.Group; x: number; z: number; r: number }> = [];
  /** Where each settlement's fire ended up; the camp's side is a coin flip, so it is
   *  recorded rather than derived. `NpcSite.focusOf` reads this. */
  private readonly fires = new Map<string, { x: number; z: number }>();
  /** Per town, where the camp layout built its taming pen (issue #178). */
  private readonly pens = new Map<string, { x: number; z: number; r: number }>();

  constructor(
    plan: SettlementPlan,
    parts: TownParts,
    props: PropLib,
    terrainMat: THREE.Material,
    seed: number,
    /** The height field: the ribbon and the furniture both draw on `getHeight`, the
     *  walking surface, not the deck profile. Needs `terrain.roads` set. */
    terrain: Terrain,
  ) {
    const surfaceAt = (x: number, z: number): number => terrain.getHeight(x, z);
    // Two glow materials, not one: same program, but they must not pulse in lockstep.
    const mkGlow = (): THREE.MeshStandardMaterial => {
      const m = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.55,
        metalness: 0,
        // CHROMATIC on purpose: the bloom tags by emissive hue spread, so white never blooms.
        emissive: new THREE.Color(0xff9a3c),
        emissiveIntensity: 2.0,
      });
      this.glowMats.push(m);
      return m;
    };
    const fireGlow = mkGlow();
    const lampGlow = mkGlow();
    // A THIRD glow material for the campfire: `fireGlow` is shared with the braziers.
    const hearthGlow = mkGlow();
    const nightGlow = mkGlow();
    nightGlow.emissive.set(0xffb34f);
    nightGlow.emissiveIntensity = 0;
    nightGlow.userData.bsNightRole = "town-windows";

    const emit = (acc: Accum, mat: THREE.Material, parent: THREE.Group, shadows: boolean): void => {
      const geo = acc.toGeometry();
      if (!geo) {
        return;
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
      mesh.matrixAutoUpdate = false;
      parent.add(mesh);
      this.geos.push(geo);
    };

    for (const town of plan.towns.all) {
      const g = new THREE.Group();
      const solid = new SolidStamp(this.solids);
      const glow = new Accum();
      const hearth = new Accum();
      const night = new Accum();
      const rng = mulberry32((seed ^ 0x5eed) + town.id.length * 7919 + town.x * 31);
      // WHICH BUILDER, BY NAME: the factory registry turns `TownInfo.kind` into a function.
      const layout = content.factory<TownLayout>(TOWN_LAYOUT_KIND, town.kind);
      const fire = layout?.(solid, glow, hearth, night, parts, town, plan.network, rng) ?? null;
      if (fire) {
        this.fires.set(town.id, fire);
        if (fire.pen) {
          this.pens.set(town.id, fire.pen);
        }
      }
      emit(solid.acc, props.solidMat, g, true);
      emit(glow, fireGlow, g, false);
      emit(hearth, hearthGlow, g, false);
      emit(night, nightGlow, g, false);
      this.group.add(g);
      this.sites.push({ g, x: town.x, z: town.z, r: town.radius });
    }

    // BEFORE the roads: its position is not negotiable and `place` is first-come.
    const postSpots: Spot[] = [];
    {
      const g = new THREE.Group();
      const solid = new SolidStamp(this.solids);
      const j = plan.junction;
      const dests: Array<[string, number]> = [];
      for (const road of plan.network.roads) {
        // A ROAD, AND ONE THAT REACHES THIS NODE: a track's ends are its own town (#142).
        if (!road.profile.roles.draw) {
          continue;
        }
        const last = road.pts[road.pts.length - 1];
        const near = Math.min(
          Math.hypot(road.pts[0].x - j.x, road.pts[0].z - j.z),
          Math.hypot(last.x - j.x, last.z - j.z),
        );
        if (near > 6) {
          continue;
        }
        const first = Math.hypot(road.pts[0].x - j.x, road.pts[0].z - j.z) < 6;
        const a = first ? road.pts[0] : road.pts[road.pts.length - 1];
        const b = first
          ? road.pts[Math.min(6, road.pts.length - 1)]
          : road.pts[Math.max(0, road.pts.length - 7)];
        const id = first ? road.toId : road.fromId;
        const site = siteOf(plan.sites, id);
        if (!site) {
          continue;
        }
        // `resolveText` rather than `t`, because a sign is a `ContentText`.
        dests.push([resolveText(site.sign), Math.atan2(b.x - a.x, b.z - a.z)]);
      }
      // ON THE VERGE, NOT IN THE ROAD: on the node itself the post was a box in the fork.
      const spot = vergeNear(plan.network, j.x, j.z, POST_ROAD_CLEAR);
      const y = seatOn(surfaceAt, spot.x, spot.z, POST_FOOT);
      solid.add(parts.post, spot.x, y, spot.z, 0);
      const armY = [y + 3.55, y + 2.85, y + 2.15];
      dests.forEach(([text, ang], i) => {
        solid.add(signArm(text, SIGN_V), spot.x, armY[i % armY.length], spot.z, ang);
      });
      postSpots.push({ x: spot.x, z: spot.z, r: POST_CLEAR, kind: "fork-post" });
      emit(solid.acc, props.solidMat, g, true);
      this.group.add(g);
      this.sites.push({ g, x: j.x, z: j.z, r: 12 });
    }

    let roadIdx = 0;
    this.ribbonCtx = {
      terrainMat,
      surfaceAt: (x, z) => terrain.getHeight(x, z),
      // THE DRAWN COLUMN, which on a carriageway is not `getHeight` — see `sectionAt`.
      columnTop: (x, z) => terrain.columnHeight(Math.floor(x), Math.floor(z)),
      seed,
    };
    this.group.add(this.pathGroup);
    /** See `fences` above: the readout `tools/test-fence.mjs` asserts over. */
    const builtFences: Fence[] = [];
    const taken: Spot[] = postSpots;
    for (const road of plan.network.roads) {
      // A painted path emits no geometry and no furniture — see `PathRoles`.
      if (!road.profile.roles.draw) {
        continue;
      }
      const g = new THREE.Group();
      const solid = new SolidStamp(this.solids);
      const glow = new Accum();
      // Furniture belongs to the BUILT carriageway: on the route it landed inside the walls.
      const built = { ...road, pts: builtDeck(road) };
      // WHAT THIS PATH CARRIES IS THE PROFILE'S CALL (issue #142, §14): lamps, posts,
      // fences and bridges are a cart road's.
      if (road.profile.furniture === "road") {
        builtFences.push(
          ...buildRoadFurniture(
            solid,
            glow,
            parts,
            built,
            plan.network,
            mulberry32(seed ^ road.pts.length),
            surfaceAt,
            taken,
            plan.sites,
          ),
        );
        builtFences.push(...addBridgeFurniture(solid, parts, built, surfaceAt));
      }
      emit(solid.acc, props.solidMat, g, true);
      emit(glow, lampGlow, g, false);
      this.group.add(g);
      const mid = road.pts[Math.floor(road.pts.length / 2)];
      this.sites.push({ g, x: mid.x, z: mid.z, r: roadLength(road) * 0.5 + 20 });
    }
    void roadIdx;
    this.furniture = taken;
    this.fences = builtFences;

    // AFTER the furniture, and in ONE call: arms and aprons share each other's rings.
    this.rebuildPaths(plan.network.roads, plan.network.junctions);

    // Every stamp is in. Freeze and index the boxes; the field is read-only now.
    this.solids.build();
  }

  /** Flicker the fires and cull whole sites by distance. Not decoration: the towns are
   *  resident for the session, so without it everything would go to every pass every
   *  frame. 420 is past the useful far range. */
  update(time: number, focus: THREE.Vector3): void {
    // Two beats, an octave and a bit apart, so neither reads as a sine.
    this.glowMats[0].emissiveIntensity =
      2.0 + Math.sin(time * 6.1) * 0.22 + Math.sin(time * 2.3) * 0.13;
    this.glowMats[1].emissiveIntensity =
      1.7 + Math.sin(time * 4.3 + 1.9) * 0.16 + Math.sin(time * 9.7) * 0.08;
    // The campfire is DIMMER than the braziers: 2.0 clipped against the tone chain and
    // read as a white hole. Bloom tags on CHROMA, not level.
    this.glowMats[2].emissiveIntensity =
      1.5 + Math.sin(time * 5.3 + 0.7) * 0.14 + Math.sin(time * 2.9) * 0.06;
    for (const s of this.sites) {
      const d = Math.hypot(s.x - focus.x, s.z - focus.z) - s.r;
      s.g.visible = d < 420;
    }
  }

  applyCelestial(state: Readonly<CelestialState>): void {
    // Windows come on through dusk and are black by day. Geometry only, never lights.
    this.glowMats[3].emissiveIntensity = 1.35 * state.night * state.night;
  }

  /** Where this town's fire stands, or null. `NpcSite.focusOf` is the only caller. */
  fireOf(townId: string): { x: number; z: number } | null {
    return this.fires.get(townId) ?? null;
  }

  /** This town's taming pen, or null — a layout that built none stays null. */
  penOf(townId: string): { x: number; z: number; r: number } | null {
    return this.pens.get(townId) ?? null;
  }

  /**
   * EVERY RIBBON AND EVERY APRON IN THE WORLD, RE-EMITTED. An arm's ribbon is clipped
   * by every apron and an apron's rim IS that arm's first ring, so adding a junction
   * changes every path that touches it (issue #45 otherwise). NO FURNITURE ON A RUNTIME
   * PATH (§12f) — the shared `taken` list is frozen with this class.
   */
  rebuildPaths(roads: readonly Road[], junctions: readonly Junction[]): void {
    const ctx = this.ribbonCtx;
    for (const child of this.pathGroup.children) {
      const m = child as THREE.Mesh;
      m.geometry.dispose();
      const i = this.geos.indexOf(m.geometry as THREE.BufferGeometry);
      if (i >= 0) {
        this.geos.splice(i, 1);
      }
    }
    this.pathGroup.clear();

    /** A third of a millimetre per surface, so two at a junction are not coplanar. */
    let bias = 0;
    const add = (
      part: { pos: number[]; nrm: number[]; col: number[]; idx: number[] },
      name: string,
    ): void => {
      if (part.idx.length === 0) {
        return;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(part.pos, 3));
      geo.setAttribute("normal", new THREE.Float32BufferAttribute(part.nrm, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(part.col, 3));
      geo.setIndex(part.idx);
      geo.computeBoundingSphere();
      this.ribbonMat ??= makeRibbonMaterial(ctx.terrainMat);
      const mesh = new THREE.Mesh(geo, this.ribbonMat);
      // Named so a raycast can say WHICH surface it hit — see `__dbgSurfaceY`.
      mesh.name = name;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.pathGroup.add(mesh);
      this.geos.push(geo);
    };

    for (const road of roads) {
      if (!road.profile.roles.draw) {
        continue;
      }
      add(
        buildRoadRibbon([road], ctx.seed, ctx.surfaceAt, bias++ * 0.003, junctions),
        `road:${road.id}`,
      );
    }
    // AFTER the arms, because a junction is the piece they grow out of.
    for (const j of junctions) {
      add(buildJunctionApron(j, roads, ctx.seed, ctx.surfaceAt, bias++ * 0.003), "road:junction");
    }
  }

  dispose(): void {
    this.ribbonMat?.dispose();
    this.ribbonMat = null;
    for (const g of this.geos) {
      g.dispose();
    }
    for (const m of this.glowMats) {
      m.dispose();
    }
    this.geos.length = 0;
  }
}

/**
 * How close a fence's timber may come to a carriageway centreline: a margin OUTSIDE
 * the rim, asked through `spanEdgeDistanceTo`. Fixed panels offset from their OWN road
 * ended up flat ACROSS one; the test is per BAY now, so a run stops at the verge.
 */
const FENCE_ROAD_CLEAR = 0.6;

/** How finely a bay is sampled against what stands already; `Spot` radii start ~1.4. */
const FENCE_SPOT_STEP = 0.45;

/**
 * "Is this bay clear of everything?", in the shape `buildFence` asks it. TWO THINGS,
 * neither inferred: the ROAD through the network, because a run knows only its OWN
 * road and cannot see a second at a fork; and what is ALREADY STANDING, through the
 * shared `taken` list. A refused bay keeps its two posts.
 */
function clearRun(network: RoadClearance, taken: readonly Spot[]): FenceOptions["accept"] {
  return (ax, az, bx, bz) => {
    if (network.spanBuiltEdgeDistanceTo(ax, az, bx, bz) < FENCE_ROAD_CLEAR) {
      return false;
    }
    const dx = bx - ax;
    const dz = bz - az;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / FENCE_SPOT_STEP));
    for (const spot of taken) {
      const reach = (spot.solidR ?? spot.r) + FENCE_POST_R;
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        if (Math.hypot(ax + dx * u - spot.x, az + dz * u - spot.z) < reach) {
          return false;
        }
      }
    }
    return true;
  };
}

/**
 * Reject a spot that overlaps something already placed, or the carriageway.
 * `roadClear` IS MEASURED FROM THE PATH'S RIM AND MAY BE NEGATIVE (issue #142):
 * inside a town the road is route, not carriageway.
 */
function place(
  taken: Spot[],
  network: RoadClearance,
  x: number,
  z: number,
  r: number,
  roadClear: number,
  /** Labels the claim for `__dbgTowns().furniture`; layouts leave it off. */
  kind?: string,
  /** The piece's own timber, where its elbow room is not it. See `Spot.solidR`. */
  solidR?: number,
): boolean {
  if (network.builtEdgeDistanceTo(x, z) < roadClear) {
    return false;
  }
  for (const spot of taken) {
    const dx = spot.x - x;
    const dz = spot.z - z;
    if (dx * dx + dz * dz < (spot.r + r) * (spot.r + r)) {
      return false;
    }
  }
  taken.push({ x, z, r, solidR, kind });
  return true;
}

/** THE ENCAMPMENT: a walled camp with one gate and a fire at its heart, laid out from
 *  the outside in because each ring constrains the next. Every placement goes through
 *  `place`, which queries the road from the real field. */
function buildEncampment(
  solid: SolidStamp,
  glow: Accum,
  hearth: Accum,
  night: Accum,
  parts: TownParts,
  town: TownInfo,
  network: RoadNetwork,
  rng: () => number,
): { x: number; z: number; pen?: { x: number; z: number; r: number } } {
  const { x: cx, z: cz, y: cy, gateAngle } = town;
  const taken: Spot[] = [];
  const at = (ang: number, dist: number): [number, number] => [
    cx + Math.sin(ang) * dist,
    cz + Math.cos(ang) * dist,
  ];
  /** Distance from the middle to the WALL on a bearing. */
  const wall = (ang: number): number => {
    const u = ang - gateAngle;
    return CAMP_WALL_HALF / Math.max(Math.abs(Math.sin(u)), Math.abs(Math.cos(u)));
  };
  /** ...and to a line `k` INSIDE it, perpendicular to the nearest side: backing off
   *  along a RADIUS would buy only 0.71k near a corner. */
  const inset = (ang: number, k: number): number => wall(ang) * (1 - k / CAMP_WALL_HALF);

  // FOUR RUNS AND FOUR CORNERS, squared to the gate: side 0 is the gate's, so the arch
  // sits flush and every gate-relative bearing holds.
  const gateOff = (town.gateX - cx) * Math.cos(gateAngle) - (town.gateZ - cz) * Math.sin(gateAngle);
  /** Half the gate arch's footprint: 29 voxels at V, stamped unscaled while the wall is 25% bigger. */
  const GATE_HALF = 29 * V * 0.5;
  /**
   * Lay a run of palisade from `u0` to `u1` along side `s`, ends flush. SPANS FIT END TO
   * END: `ceil` picks the denser log rhythm and the template's own +z is scaled to the
   * pitch (issue #128). Laid PER SEGMENT, outward FROM the arch's own faces.
   */
  const run = (
    nx: number,
    nz: number,
    tx: number,
    tz: number,
    f: number,
    u0: number,
    u1: number,
  ): void => {
    const len = u1 - u0;
    if (len <= 0.01) {
      return;
    }
    const fit = fitPalisadeRun(len, WALL_S);
    for (let j = 0; j < fit.count; j++) {
      const u = u0 + (j + 0.5) * fit.pitch;
      solid.add(
        parts.palisade,
        cx + nx * CAMP_WALL_HALF + tx * u,
        cy,
        cz + nz * CAMP_WALL_HALF + tz * u,
        f + Math.PI / 2,
        WALL_S,
        WALL_S,
        fit.lengthScale,
      );
    }
  };
  for (let s = 0; s < 4; s++) {
    const f = gateAngle + s * (Math.PI / 2);
    const nx = Math.sin(f);
    const nz = Math.cos(f);
    const tx = Math.cos(f);
    const tz = -Math.sin(f);
    if (s === 0) {
      run(nx, nz, tx, tz, f, -CAMP_WALL_HALF, gateOff - GATE_HALF);
      run(nx, nz, tx, tz, f, gateOff + GATE_HALF, CAMP_WALL_HALF);
    } else {
      run(nx, nz, tx, tz, f, -CAMP_WALL_HALF, CAMP_WALL_HALF);
    }
    // A corner post per side: butt-jointed log ends read as two fences meeting.
    solid.add(
      parts.cornerPost,
      cx + (nx + tx) * CAMP_WALL_HALF,
      cy,
      cz + (nz + tz) * CAMP_WALL_HALF,
      f + Math.PI / 2,
      WALL_S,
      WALL_S,
    );
  }
  {
    const f = gateAngle;
    const x = cx + Math.sin(f) * CAMP_WALL_HALF + Math.cos(f) * gateOff;
    const z = cz + Math.cos(f) * CAMP_WALL_HALF - Math.sin(f) * gateOff;
    solid.add(parts.gate, x, cy, z, gateAngle + Math.PI / 2);
    taken.push({ x, z, r: 6 });
  }
  // Off the road axis: the carriageway runs from the gate to the middle of camp.
  const side = rng() < 0.5 ? 1 : -1;
  const [fx, fz] = at(gateAngle + (Math.PI / 2) * side, 5.4);
  solid.add(parts.fire, fx, cy, fz, rng() * 6.28);
  hearth.add(parts.fireGlow, fx, cy, fz, rng() * 6.28, 1, 1, 1, 1);
  taken.push({ x: fx, z: fz, r: 4.2 });
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.4;
    const x = fx + Math.sin(a) * 3.6;
    const z = fz + Math.cos(a) * 3.6;
    if (place(taken, network, x, z, 1.2, -1.6)) {
      solid.add(parts.woodpile, x, cy, z, a + Math.PI / 2, 0.55, 0.4);
    }
  }

  // THE TAMING PEN (issue #178): `quest:land/first-light`'s words say "penned",
  // and until this ring existed the quest staged an ordinary wild beast on open
  // ground. It stands across the carriageway from the fire — the practice
  // happens in view of it — and it is CLAIMED before the huts and tents are
  // sited, so nothing else lands inside. `solidR` is a stake's width: the claim
  // is elbow room, and the fence must be allowed to stand within its own claim.
  // Which ANIMAL is in the pen is quest dressing and main.ts's business.
  let pen: { x: number; z: number; r: number } | undefined;
  {
    const PEN_R = 3.6;
    // The snapshot BEFORE the claim, or `clearRun` refuses the ring's own bays.
    const clearBefore = clearRun(network, taken.slice());
    for (let attempt = 0; attempt < 10 && !pen; attempt++) {
      const a = gateAngle - (Math.PI / 2) * side + (attempt - 4.5) * 0.16;
      const d = 6.2 + (attempt % 3) * 1.1;
      const [px, pz] = at(a, d);
      if (!place(taken, network, px, pz, PEN_R + 1.8, 1.6, undefined, FENCE_POST_R)) {
        continue;
      }
      const ring: FenceNode[] = [];
      for (let i = 0; i <= 10; i++) {
        const ra = gateAngle + (i / 10) * Math.PI * 2;
        ring.push({ x: px + Math.sin(ra) * PEN_R, y: cy, z: pz + Math.cos(ra) * PEN_R });
      }
      buildFence(solid, parts.fence, ring, { accept: clearBefore, glow });
      pen = { x: px, z: pz, r: PEN_R };
    }
  }

  for (let k = 0; k < 3; k++) {
    const a = gateAngle + Math.PI + (k - 1) * 0.85 + (rng() - 0.5) * 0.2;
    const [x, z] = at(a, inset(a, 7.5));
    if (!place(taken, network, x, z, 4.4, 2)) {
      continue;
    }
    const yaw = Math.atan2(fx - x, fz - z);
    solid.add(parts.huts[k], x, cy, z, yaw);
    addNightWindow(night, x, cy, z, yaw, 3.35, 2.0);
    if (k === 2) {
      const dx = Math.sin(Math.atan2(fx - x, fz - z));
      const dz = Math.cos(Math.atan2(fx - x, fz - z));
      // On the ground outside the door: at cy + 0.62 it read as a lit window.
      glow.add(parts.forgeGlow, x + dx * 3.4, cy + 0.1, z + dz * 3.4, 0, 1.2, 1, 1, 1);
    }
  }

  let tentIdx = 0;
  for (let k = 0; k < 9 && tentIdx < 7; k++) {
    const a = gateAngle + 0.7 + (k / 9) * Math.PI * 1.6 + (rng() - 0.5) * 0.25;
    const [x, z] = at(a, inset(a, 5.5 + rng() * 4));
    if (!place(taken, network, x, z, 3.2, 1)) {
      continue;
    }
    const yaw = tentIdx % 3 === 2 ? Math.atan2(fx - x, fz - z) : a + Math.PI / 2;
    if (tentIdx % 3 === 2) {
      solid.add(parts.bell, x, cy, z, yaw);
    } else {
      solid.add(parts.tents[tentIdx % parts.tents.length], x, cy, z, yaw);
    }
    addNightWindow(night, x, cy, z, yaw, 2.7, 1.45);
    tentIdx++;
  }

  // AFTER the buildings: `place` is first-come, and first they rejected all three huts.
  for (let k = 0; k < 4; k++) {
    const a = gateAngle + Math.PI * 0.4 + (k / 4) * Math.PI * 1.2;
    const [x, z] = at(a, inset(a, 2.4));
    if (place(taken, network, x, z, 2.4, 0.5)) {
      // Scaled with the wall: at 1.0 the platform (4.76) sits below the 4.90 wall top.
      solid.add(parts.watch, x, cy, z, a, WALL_S, WALL_S);
    }
  }

  const clutter: Array<[Template, number, number]> = [
    [parts.barrel, 1.0, 12],
    [parts.crateS, 1.0, 8],
    [parts.crateL, 1.0, 5],
    [parts.woodpile, 1.1, 3],
    [parts.rack, 1.0, 2],
  ];
  for (const [tpl, scl, count] of clutter) {
    let placed = 0;
    for (let k = 0; k < count * 4 && placed < count; k++) {
      const a = rng() * Math.PI * 2;
      const [x, z] = at(a, inset(a, 2 + rng() * (CAMP_WALL_HALF - 7)));
      if (!place(taken, network, x, z, 1.4 * scl, -0.8)) {
        continue;
      }
      solid.add(tpl, x, cy, z, rng() * 6.28, scl);
      placed++;
    }
  }
  for (const [dside, tpl] of [
    [1, parts.cartHood],
    [-1, parts.cartOpen],
  ] as const) {
    const a = gateAngle + dside * 0.42;
    const [x, z] = at(a, inset(a, 8));
    if (place(taken, network, x, z, 3, -0.4)) {
      solid.add(tpl, x, cy, z, a + Math.PI / 2 + dside * 0.3);
    }
  }

  // Braziers: emissive voxels, not lights — see lampBody in town-parts.ts.
  const brazierSpots: Array<[number, number]> = [
    [gateAngle + 0.3, inset(gateAngle + 0.3, 3.4)],
    [gateAngle - 0.3, inset(gateAngle - 0.3, 3.4)],
  ];
  for (let k = 0; k < 5; k++) {
    const a = gateAngle + 1.1 + (k / 5) * 4.4;
    brazierSpots.push([a, inset(a, 6 + rng() * 4)]);
  }
  for (const [a, d] of brazierSpots) {
    const [x, z] = at(a, d);
    if (!place(taken, network, x, z, 1.6, -1)) {
      continue;
    }
    solid.add(parts.brazier, x, cy, z, rng() * 6.28);
    glow.add(parts.brazierGlow, x, cy, z, 0, 1, 1, 1, 1);
  }
  // The NPC placer wants to know where the fire went. See `NpcSite.focusOf`.
  return { x: fx, z: fz, pen };
}

/** A HAMLET: the same pieces, a tenth of the parts list. No wall, because what makes
 *  the start town a stronghold is that the others are not. `_hearth` is the
 *  signature's, and a hamlet has nothing for it. */
function buildHamlet(
  solid: SolidStamp,
  glow: Accum,
  _hearth: Accum,
  night: Accum,
  parts: TownParts,
  town: TownInfo,
  network: RoadNetwork,
  rng: () => number,
): { x: number; z: number } | null {
  const { x: cx, z: cz, y: cy, radius: R, gateAngle } = town;
  const taken: Spot[] = [];
  const at = (ang: number, dist: number): [number, number] => [
    cx + Math.sin(ang) * dist,
    cz + Math.cos(ang) * dist,
  ];

  const [wx, wz] = at(gateAngle + Math.PI / 2, 4.2);
  solid.add(parts.well, wx, cy, wz, rng() * 6.28);
  taken.push({ x: wx, z: wz, r: 3 });

  for (let k = 0; k < 4; k++) {
    const a = gateAngle + Math.PI * 0.55 + (k / 4) * Math.PI * 0.9 + (rng() - 0.5) * 0.2;
    const [x, z] = at(a, R - 5.5 - rng() * 3);
    if (!place(taken, network, x, z, 4.4, 2)) {
      continue;
    }
    const yaw = Math.atan2(wx - x, wz - z);
    solid.add(parts.huts[k % parts.huts.length], x, cy, z, yaw);
    addNightWindow(night, x, cy, z, yaw, 3.35, 2.0);
  }
  for (let k = 0; k < 3; k++) {
    const a = gateAngle - 0.5 - (k / 3) * 1.5;
    const [x, z] = at(a, R - 6 - rng() * 3);
    if (!place(taken, network, x, z, 3.2, 1)) {
      continue;
    }
    const yaw = a + Math.PI / 2;
    solid.add(k === 1 ? parts.bell : parts.tents[k % parts.tents.length], x, cy, z, yaw);
    addNightWindow(night, x, cy, z, yaw, 2.7, 1.45);
  }
  // A fence arc away from the road. Road-tested like every run: the arc is laid from
  // the town's OWN radius and gate bearing, and the gate side is per seed.
  const arcPath: FenceNode[] = [];
  for (let i = 0; i <= 12; i++) {
    const a = gateAngle + Math.PI * 0.65 + (i / 12) * Math.PI * 0.7;
    const [x, z] = at(a, R - 1.2);
    arcPath.push({ x, y: cy, z });
  }
  buildFence(solid, parts.fence, arcPath, {
    accept: clearRun(network, taken),
    lanternEvery: 4,
    glow,
  });
  for (let k = 0; k < 14; k++) {
    const a = rng() * Math.PI * 2;
    const [x, z] = at(a, 4 + rng() * (R - 6));
    const tpl = k % 3 === 0 ? parts.crateS : k % 3 === 1 ? parts.barrel : parts.woodpile;
    if (!place(taken, network, x, z, 1.4, -1)) {
      continue;
    }
    solid.add(tpl, x, cy, z, rng() * 6.28);
  }
  {
    const [x, z] = at(gateAngle - 0.5, R - 7);
    if (place(taken, network, x, z, 3, -0.4)) {
      solid.add(parts.cartOpen, x, cy, z, gateAngle);
    }
  }
  for (let k = 0; k < 3; k++) {
    const a = gateAngle + 0.4 + k * 2.1;
    const [x, z] = at(a, R - 4.5);
    if (!place(taken, network, x, z, 1.6, -1)) {
      continue;
    }
    solid.add(parts.brazier, x, cy, z, 0);
    glow.add(parts.brazierGlow, x, cy, z, 0, 1, 1, 1, 1);
  }
  // A hamlet has no fire, so nothing for `NpcSite.focusOf` to point at.
  return null;
}

/** The two behaviours a town's `layout` field may select. AT MODULE LOAD, before
 *  `bootstrapContent()`, which also PUBLISHES the names to the content type. */
defineFactory(TOWN_LAYOUT_KIND, "camp", buildEncampment satisfies TownLayout);
defineFactory(TOWN_LAYOUT_KIND, "hamlet", buildHamlet satisfies TownLayout);

/**
 * What lines a road: lamps at intervals, fence on some stretches, and a fingerpost
 * naming a town, all placed by ARC LENGTH along the deck so they follow a bend. Two
 * things it may not decide itself, both issue #15: WHERE THE GROUND IS (`seatOn`, not
 * the deck) and WHETHER THE SPOT IS FREE (`taken`, plus the whole network).
 */
function buildRoadFurniture(
  solid: SolidStamp,
  glow: Accum,
  parts: TownParts,
  road: Road,
  network: RoadClearance,
  rng: () => number,
  surfaceAt: (x: number, z: number) => number,
  taken: Spot[],
  /** The sited towns, for "is this end a town" and "what does its plank say". */
  sites: readonly TownSite[],
): Fence[] {
  const len = roadLength(road);
  /** THIS road's rim, which every offset is measured from; `accept` then asks the network. */
  const rim = road.profile.deckEdge;
  const at = { x: 0, y: 0, z: 0, dx: 0, dz: 0 };
  /** The chains built here, handed back for `World.debugFences`. */
  const built: Fence[] = [];

  // Fingerposts FIRST: `place` is first-come. ONE PER TOWN END and none at the fork,
  // which already carries a three-armed post (issue #15's clutter).
  const ends: Array<[number, string, string, number]> = [
    [Math.min(len * 0.4, 17), road.fromId, road.toId, 1],
    [Math.max(len * 0.6, len - 17), road.toId, road.fromId, -1],
  ];
  for (const [sPos, standsAt, names, dir] of ends) {
    if (siteOf(sites, standsAt) === null) {
      continue;
    }
    // The junction has no asset, so its plank is the one sign left in the string table.
    const named = siteOf(sites, names);
    const sign = named ? resolveText(named.sign) : t(JUNCTION_SIGN_KEY);
    // Walk BACK until the post is clear: a post is the road's name, so it moves.
    for (let k = 0; k < 6; k++) {
      const s = Math.max(2, Math.min(len - 2, sPos - dir * k * 3));
      roadAt(road, s, at);
      const px = -at.dz;
      const pz = at.dx;
      const off = rim + 1.1;
      const x = at.x + px * off;
      const z = at.z + pz * off;
      if (
        !place(
          taken,
          network,
          x,
          z,
          POST_CLEAR,
          POST_ROAD_CLEAR,
          "post",
          footprintRadius(parts.post),
        )
      ) {
        continue;
      }
      const y = seatOn(surfaceAt, x, z, POST_FOOT);
      solid.add(parts.post, x, y, z, 0);
      solid.add(signArm(sign, SIGN_V), x, y + 3.4, z, Math.atan2(at.dx * dir, at.dz * dir));
      break;
    }
  }

  const LAMP_STEP = 26;
  let lampSide = 1;
  for (let s = LAMP_STEP * 0.5; s < len; s += LAMP_STEP) {
    roadAt(road, s, at);
    // Off the deck: a lamp on a bridge would stand on planks over open water.
    const near = road.pts[Math.min(road.pts.length - 1, Math.round(s / 3))];
    if (near.bridge) {
      continue;
    }
    // Alternating sides is the LOOK; which side is free is the network's call.
    for (const side of [lampSide, -lampSide]) {
      const px = -at.dz * side;
      const pz = at.dx * side;
      const off = rim + 0.8;
      const x = at.x + px * off;
      const z = at.z + pz * off;
      if (
        !place(
          taken,
          network,
          x,
          z,
          LAMP_CLEAR,
          LAMP_ROAD_CLEAR,
          "lamp",
          footprintRadius(parts.lamp),
        )
      ) {
        continue;
      }
      const y = seatOn(surfaceAt, x, z, 0.4);
      const yaw = Math.atan2(-px, -pz); // bracket leans over the road
      solid.add(parts.lamp, x, y, z, yaw);
      glow.add(parts.lampGlow, x, y, z, yaw, 1, 1, 1, 1);
      break;
    }
    lampSide = -lampSide;
  }

  // Fence: long runs rather than a continuous hem, sampled as a PATH along the verge
  // so `buildFence` follows a bend as one chain.
  const FENCE_STEP = 4;
  let s = 20 + rng() * 30;
  while (s < len - 20) {
    const runLen = (4 + Math.floor(rng() * 6)) * FENCE_STEP;
    const fside = rng() < 0.5 ? 1 : -1;
    const path: FenceNode[] = [];
    for (let sk = s; sk <= Math.min(s + runLen, len - 10); sk += FENCE_STEP) {
      roadAt(road, sk, at);
      // A bridge deck has its own railing and no verge, so a run reaching one ENDS.
      const near = road.pts[Math.min(road.pts.length - 1, Math.round(sk / 3))];
      if (near.bridge) {
        break;
      }
      // Offsets are against THIS road; `accept` checks each bay against the network.
      const off = rim + 1.5;
      const fx = at.x - at.dz * fside * off;
      const fz = at.z + at.dx * fside * off;
      // THE COLUMN THE POST STANDS IN, not the minimum over its neighbourhood: a fence line
      // seated under the verge would have its planks inside it.
      path.push({ x: fx, y: surfaceAt(fx, fz), z: fz });
    }
    if (path.length > 1) {
      built.push(
        ...buildFence(solid, parts.fence, path, {
          accept: clearRun(network, taken),
          groundAt: (x, z) => surfaceAt(x, z),
        }),
      );
    }
    s += runLen + 40 + rng() * 70;
  }
  return built;
}
