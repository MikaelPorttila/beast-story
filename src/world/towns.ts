/**
 * TOWNS — named places on the overworld, and the road network that joins them.
 *
 * A town here is an OVERWORLD LANDMARK, not an instanced zone: you walk in and
 * out of it seamlessly, there is no boundary and nothing loads. (The zone system
 * in world/zones.ts exists and is deliberately not used — it is for the dungeon,
 * where the point is that the overworld unloads.) A town is therefore four
 * ordinary things stacked on the same coordinates: a flatten disc in the height
 * field, an exclusion that keeps the forest off it, a `GroundPatch` that wears
 * its grass away into trodden mud, and a merged voxel mesh. All four are
 * derived from the same registry entry, so adding a settlement adds all four.
 *
 * THE REGISTRY IS THE PRODUCT. `planSettlements` returns a `TownRegistry`
 * (core/types.ts) carrying a stable id, a display name, a world position, a
 * footprint radius and a gate for every town, and EVERYTHING else is derived
 * from it: the roads run between registry entries, the player's spawn is a point
 * on the road out of `encampment`, the compass chips are one line per entry, and
 * a quest system that wants "where is Stonewatch" or "what towns are there" asks
 * `world.towns` and never touches geometry. Adding a fourth town is an entry in
 * `SITES` below.
 *
 * ONE ROAD EXIT PER TOWN, and it is the road that decides where. The route is
 * planned first, from a bearing rolled off the seed; the gate is then placed
 * where that route crosses the town's radius, and the perimeter is broken around
 * it. So "which side the exit is on is random per seed" and "the road goes
 * through the gate" are the same fact rather than two facts to keep in step.
 *
 * The network is a HUB: the Encampment's single road runs to a junction, and the
 * two other towns hang off that. That is what lets the start town have exactly
 * one exit while the world still has somewhere else to go, and it puts a
 * three-armed fingerpost at the fork, which is the most useful place for one.
 */
import * as THREE from 'three';
import type { TownInfo, TownRegistry } from '../core/types';
import { t, type StringKey } from '../i18n';
import { Terrain, WATER_LEVEL, type GroundPatch } from './terrain';
import {
  RoadNetwork, roadAt, roadLength, routeRoad, profileRoad, straightWetLength,
  builtDeck, setTrimStart, DECK_EDGE, NECK_MAX, type Road, type RoadClearance,
} from './roads';
import { Accum, type PropLib, type Template } from './props';
import { SolidStamp, StructureField } from './structures';
import {
  TownParts, V, addBridgeFurniture, buildRoadRibbon, signArm,
} from './town-parts';
import { mulberry32 } from './noise';

// ---------------------------------------------------------------------------
// What towns exist
// ---------------------------------------------------------------------------

/**
 * How much bigger the Encampment's timber is than the template it is baked at.
 *
 * Girth AND height, so a span runs 5.25 units instead of 4.2 and its logs top
 * out at 4.90 instead of 3.92. That last number is the one that earns it: the
 * gate arch's lintel sits at 5.04, so the wall now MEETS the arch instead of
 * stopping a third of the way up it.
 *
 * `SolidStamp.add` passes both through to `StructureField.add`, so the collider
 * grows with the mesh and there is no second number to keep in step.
 *
 * The watch posts are scaled with it. They are documented as the only thing in
 * camp taller than the wall, and at 1.0 their platform (4.76) would have ended
 * up BELOW a 4.90 wall top, leaving the guard looking at timber.
 */
const WALL_S = 1.25;

/**
 * Half a side of the Encampment's square wall, world units.
 *
 * 16.8 is within half a percent of `R * sqrt(PI) / 2 = 16.84`, the half-side
 * that gives a square the SAME AREA as the 19-unit circle it replaces — so the
 * camp changes shape without changing how much room its layout has. The four
 * sides lose 2.2 units of depth and the four corners gain 4.8.
 *
 * The corners then reach `16.8 * sqrt(2) = 23.76`, which is past several things
 * that were keyed on the footprint radius. That is what `outerRadius` on the
 * site spec is for; without it, trees grow in the corners of the camp and the
 * corner runs stand on ground the flatten only levelled 88% of the way.
 */
const CAMP_WALL_HALF = 16.8;

interface SiteSpec {
  /**
   * The stable IDENTIFIER. The road network, the compass chip, `TownRegistry.get`
   * and any quest that stores "go to Stonewatch" all key on it, so it does not
   * move when the town is renamed or translated.
   */
  id: string;
  /** DISPLAY name, as a string-table key. */
  nameKey: StringKey;
  /**
   * What a fingerpost arm reads, as a string-table key. Short, upper-case,
   * <= 10 characters — and inside the 3x5 voxel font, which is A-Z, 0-9, '-',
   * an apostrophe and a space. `signArm` folds accents (Ö -> O) and drops
   * anything left over; see `signText` in town-parts.ts and the note on the
   * `town.*.sign` block in src/i18n/en.ts.
   */
  signKey: StringKey;
  kind: TownInfo['kind'];
  radius: number;
  /**
   * How far from the middle this settlement's PERIMETER actually reaches.
   *
   * `radius` is the nominal footprint every distance test uses and it stays a
   * circle; this is the circle that CONTAINS the built wall, which for the
   * Encampment's square is its corners at `CAMP_WALL_HALF * sqrt(2)` and for a
   * hamlet is just `radius`. Levelling the ground under the wall, holding the
   * road deck level with it, and keeping the forest out of it are all facts
   * about the built thing, not about the nominal circle — and the corners of a
   * square reach 41% further than its sides.
   */
  outerRadius: number;
  color: number;
  /**
   * Prefer a site with water in its footprint's outer ring rather than avoiding
   * it. A mill needs a river, so this is scenery — but it is also what puts a
   * BRIDGE in the road network reliably rather than by luck, because a town
   * across water is a town whose road has to cross it. See `siteCost`.
   */
  waterside?: boolean;
}

/**
 * The world's towns, in placement order. The first is the START TOWN and is the
 * only one with a bespoke layout; the rest are assembled from the same pieces by
 * `buildHamlet`, which is the whole point of there being more than one — a town
 * system that only ever built the Encampment would not be a system.
 */
const SITES: readonly SiteSpec[] = [
  {
    id: 'encampment', nameKey: 'town.encampment.name', signKey: 'town.encampment.sign',
    kind: 'camp', radius: 19, outerRadius: CAMP_WALL_HALF * Math.SQRT2, color: 0xffb45e,
  },
  {
    id: 'redbriar', nameKey: 'town.redbriar.name', signKey: 'town.redbriar.sign',
    kind: 'hamlet', radius: 15, outerRadius: 15, color: 0x9ad46a, waterside: true,
  },
  {
    id: 'stonewatch', nameKey: 'town.stonewatch.name', signKey: 'town.stonewatch.sign',
    kind: 'hamlet', radius: 15, outerRadius: 15, color: 0x8fc4e8,
  },
];

/** Where the fingerpost at the fork stands, as far as a signpost is concerned. */
const JUNCTION_SIGN_KEY = 'town.junction.sign' as const;


// ---------------------------------------------------------------------------
// Trodden ground
// ---------------------------------------------------------------------------

/**
 * HOW A SETTLEMENT WEARS ITS GROUND, by kind.
 *
 * Every number is a fraction of the town's OWN radius or a bearing relative to
 * its OWN gate, so this table plus a `TownInfo` is a complete `GroundPatch` —
 * which is the point: a fourth entry in `SITES` gets a trodden yard with no new
 * code, and the yard is the right shape for it because the layout functions
 * below place their huts and tents off the same two quantities.
 *
 * The two kinds are deliberately not the same surface, and the difference is
 * the difference between the buildings that stand on them:
 *
 *   - a CAMP is churned edge to edge (`base` 0.92). Sixty people, four watch
 *     posts and a cart road inside a nineteen-unit palisade do not leave a
 *     lawn; the tracks here only decide which parts are packed DRY.
 *   - a HAMLET wears bare where feet go and keeps its grass in between
 *     (`base` 0.36, narrower tracks). A mill has a yard and a green, and the
 *     thing that makes the start town feel like a stronghold is that the others
 *     are not one — the same argument `buildHamlet` makes about the palisade.
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
  /**
   * The beaten tracks: bearing RELATIVE TO THE GATE, length in radii, half
   * width in world units, and how worn the track is. Every one of them points
   * at something the layout below actually builds.
   */
  tracks: ReadonlyArray<readonly [number, number, number, number]>;
}

const HALF_PI = Math.PI / 2;

const WEAR: Record<TownInfo['kind'], WearSpec> = {
  camp: {
    // FLAT 1.0, not 0.92. Eight percent of the meadow left in the mix was
    // enough to tint the whole yard olive (_camp-ground.png, first pass) —
    // grass is the most saturated surface in the world and a trace of it
    // survives any amount of brown.
    base: 1.0,
    // 0.90 / 1.30: at the palisade (1.00 radii) the rim still holds 0.91, so
    // the ground is bare right up to the wall, and it falls through the 0.6
    // 'trampled' threshold about two units outside it — a worn apron round the
    // gate rather than a disc that stops dead on the timber.
    fade: 0.90,
    edge: 1.30,
    damp: 0.55,
    tracks: [
      // THE THOROUGHFARE, gate to the middle of camp and out through the gate.
      // Wide and dead straight because it is the cart road: `buildEncampment`
      // refuses to place anything within reach of the carriageway, so this is
      // the one line in the camp that is guaranteed to be clear ground.
      [0, 1.25, 4.4, 1.0],
      // THE FIRE. It stands a quarter-turn off the road axis at 5.4 units, on a
      // side rolled per seed — so both sides get a path, and the one that has
      // no fire on it has the log seats and braziers instead.
      [HALF_PI, 0.34, 3.6, 1.0],
      [-HALF_PI, 0.34, 3.6, 1.0],
      // THE HUTS, three of them on the far half of the camp at R - 7.5, facing
      // the fire — i.e. these tracks are the line people walk between the two.
      [Math.PI - 0.75, 0.62, 2.6, 0.95],
      [Math.PI, 0.62, 2.6, 0.95],
      [Math.PI + 0.75, 0.62, 2.6, 0.95],
      // THE TENT LINES, which fill the arc from the gate round to the huts.
      [1.5, 0.66, 2.4, 0.88],
      [2.6, 0.66, 2.4, 0.88],
      [3.8, 0.66, 2.4, 0.88],
    ],
  },
  hamlet: {
    // Half the camp's, and that IS the "different intensity" — a mill has a
    // yard and a green where a camp has only a parade ground. Captured at 0.36
    // (_hamlet-aerial.png, first pass) the difference read as two dirt spots in
    // a meadow rather than as a settlement, so the yard goes up while the
    // TRACKS stay narrow: what should distinguish a hamlet is that you can see
    // where its feet go, not that it is uniformly less brown.
    base: 0.52,
    fade: 0.80,
    edge: 1.28,
    damp: 0.30,
    tracks: [
      [0, 1.20, 3.8, 1.0], // the road in
      [HALF_PI, 0.36, 3.2, 1.0], // the well, at gateAngle + PI/2 and 4.2 out
      [Math.PI * 0.55, 0.60, 2.4, 0.95], // the four cottages
      [Math.PI * 1.0, 0.60, 2.4, 0.95],
      [Math.PI * 1.45, 0.60, 2.4, 0.95],
      [-0.9, 0.55, 2.2, 0.88], // the tents and the paddock cart
      [-1.8, 0.55, 2.2, 0.88],
    ],
  },
};

/** The `GroundPatch` a town wears, entirely derived from its registry entry. */
function wearPatch(t: TownInfo): GroundPatch {
  const spec = WEAR[t.kind];
  const paths = new Float32Array(spec.tracks.length * 4);
  for (let i = 0; i < spec.tracks.length; i++) {
    const [rel, len, hw, s] = spec.tracks[i];
    const a = t.gateAngle + rel;
    const d = len * t.radius;
    paths[i * 4] = Math.sin(a) * d;
    paths[i * 4 + 1] = Math.cos(a) * d;
    paths[i * 4 + 2] = hw;
    paths[i * 4 + 3] = s;
  }
  return {
    x: t.x, z: t.z,
    fade: spec.fade * t.radius,
    edge: spec.edge * t.radius,
    base: spec.base,
    damp: spec.damp,
    paths,
  };
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * How level and dry the ground around (x, z) is, lower being better; Infinity
 * disqualifies. `r` is the footprint being tested.
 *
 * A town is levelled by a flatten disc, so it does not need flat ground — but
 * the disc has to LAND somewhere believable. Drop a 19-unit camp on a hillside
 * and the blend ring becomes a 40-unit earthwork visible from the next valley,
 * which is the same failure the gateway's narrow flatten was written to avoid.
 */
function siteCost(
  terrain: Terrain, x: number, z: number, r: number, waterside = false,
): number {
  const h = terrain.heightCont(x, z);
  let worst = 0;
  let wet = 0;
  for (let a = 0; a < 12; a++) {
    const ang = (a / 12) * Math.PI * 2;
    for (const rr of [r * 0.55, r, r * 1.35]) {
      const nh = terrain.heightCont(x + Math.cos(ang) * rr, z + Math.sin(ang) * rr);
      worst = Math.max(worst, Math.abs(nh - h));
      if (nh < WATER_LEVEL + 0.5) wet++;
    }
  }
  // FINITE EVERYWHERE, deliberately. A first pass returned Infinity for a wet
  // centre, and on seed 1337 every candidate for the junction came back Infinity
  // — so the search kept its arbitrary initial guess, put the fork in a lake,
  // and the anchor at that end then dragged 20 units of bridge deck under the
  // waterline. A scoring function whose job is "least bad" must be able to rank
  // bad options; the penalties below are large enough that dry ground always
  // wins when dry ground exists, and the caller floors the height anyway.
  const drown = Math.max(0, WATER_LEVEL + 2.2 - h);
  // A waterside site WANTS a shore in its outer ring — 4 to 12 of the 36 probes
  // wet is a bank, not a swamp — and is still refused a wet centre.
  const wetTerm = waterside ? Math.abs(wet - 8) * 1.6 : wet * 1.4;
  return worst * 1.6 + wetTerm + drown * 40;
}

/** Best site on a ring band around (ox, oz), searched on a spiral of bearings. */
function findSite(
  terrain: Terrain, ox: number, oz: number,
  minR: number, maxR: number, baseAngle: number, spread: number,
  r: number, rng: () => number, waterside = false,
): { x: number; z: number } {
  let bestX = ox + Math.sin(baseAngle) * maxR;
  let bestZ = oz + Math.cos(baseAngle) * maxR;
  let best = Infinity;
  for (let ri = 0; ri <= 6; ri++) {
    const dist = minR + ((maxR - minR) * ri) / 6;
    for (let k = 0; k < 13; k++) {
      const ang = baseAngle + ((k / 12) - 0.5) * 2 * spread + (rng() - 0.5) * 0.08;
      const x = Math.round(ox + Math.sin(ang) * dist) + 0.5;
      const z = Math.round(oz + Math.cos(ang) * dist) + 0.5;
      let c = siteCost(terrain, x, z, r, waterside);
      if (waterside) {
        // ACROSS a channel from where the road comes from, not merely beside
        // water. This is what makes the bridge a property of the world rather
        // than of luck: the router bridges any crossing under NECK_MAX and goes
        // round anything bigger, so a site whose approach crosses ~18 units of
        // water is a site the road MUST bridge to reach. Measured without it on
        // seed 1337 the whole network came out bridgeless — every straight line
        // either missed the water entirely or crossed a full lake.
        // Hard, not a nudge. A first pass added ~26 for a dry approach and the
        // search simply paid it: the ring-wetness term and the levelness term
        // together swamped it, seed 1337 put Redbriar on dry ground with a dry
        // road to it, and the world had no bridge anywhere. A crossing between
        // 6 units (anything less is a puddle) and NECK_MAX (anything more the
        // router will go round, so the bridge would never be built) is
        // effectively a requirement, and the term says so.
        const line = straightWetLength(terrain, ox, oz, x, z);
        c += line < 6 || line > NECK_MAX ? 250 : Math.abs(line - 20) * 2;
      }
      if (c < best) { best = c; bestX = x; bestZ = z; }
    }
  }
  return { x: bestX, z: bestZ };
}

/** Where a road crosses out of a town's footprint — i.e. where its gate goes. */
function gateOn(road: Road, cx: number, cz: number, radius: number, fromStart: boolean): {
  x: number; z: number; angle: number;
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

/**
 * Where a road first crosses the plane `dot(p - c, n) = h`, walking from its
 * start — INTERPOLATED, not snapped to a sample.
 *
 * `gateOn` returns a road SAMPLE, and samples are 3 units apart, so its answer
 * can sit up to 3 units past the line it was looking for. That was harmless
 * while the gate was only a compass chip and a bearing; it is not harmless once
 * the gate is where the gravel stops and where an arch is stamped, because a
 * three-unit error there is an arch standing off its own wall.
 */
function planeHit(
  road: Road, cx: number, cz: number, nx: number, nz: number, h: number,
): { x: number; z: number } {
  const pts = road.pts;
  const at = (i: number): number => (pts[i].x - cx) * nx + (pts[i].z - cz) * nz;
  for (let i = 1; i < pts.length; i++) {
    const a = at(i - 1);
    const b = at(i);
    if (b >= h && a < h) {
      const t = (h - a) / (b - a);
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
        z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t,
      };
    }
  }
  // The route never reaches the wall — it cannot, since it starts at the middle
  // and ends outside — but a caller with a broken plane should get a point on
  // the wall rather than a crash.
  return { x: cx + nx * h, z: cz + nz * h };
}

export interface SettlementPlan {
  towns: TownRegistry;
  network: RoadNetwork;
  /** Scenic point on the Encampment road; the world's spawn. */
  spawn: THREE.Vector3;
  /** The three-way fork. */
  junction: { x: number; y: number; z: number };
}

class Registry implements TownRegistry {
  readonly roads: TownRegistry['roads'];

  constructor(readonly all: readonly TownInfo[], roads: readonly Road[]) {
    this.roads = roads.map((r) => {
      const path = new Float32Array(r.pts.length * 3);
      const bridge = new Uint8Array(r.pts.length);
      for (let i = 0; i < r.pts.length; i++) {
        path[i * 3] = r.pts[i].x;
        path[i * 3 + 1] = r.pts[i].y;
        path[i * 3 + 2] = r.pts[i].z;
        bridge[i] = r.pts[i].bridge ? 1 : 0;
      }
      return { id: r.id, from: r.fromId, to: r.toId, path, bridge };
    });
  }

  get(id: string): TownInfo | undefined {
    return this.all.find((t) => t.id === id);
  }
  nearest(x: number, z: number): TownInfo | null {
    let best: TownInfo | null = null;
    let bd = Infinity;
    for (const t of this.all) {
      const d = Math.hypot(t.x - x, t.z - z);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }
}

/**
 * Site the towns, cut the roads between them and pick the spawn.
 *
 * MUST run before any chunk is built and before `terrain.roads` is set: the
 * router asks the terrain for its NATURAL heights, and a terrain that already
 * carries the corridor would have the road planning its route along itself.
 * `createWorld` calls this immediately after constructing the Terrain.
 */
export function planSettlements(terrain: Terrain, seed: number): SettlementPlan {
  const rng = mulberry32(seed ^ 0x70b1);
  const towns: TownInfo[] = [];

  // -- 1. Sites. The Encampment first, at a walkable distance from the origin;
  // the other two hang off the junction so the network is a hub and not a star.
  /**
   * The levelled height of a site.
   *
   * Floored clear of the water because every one of these is an ANCHOR the road
   * profile is pulled onto, and an anchor under the waterline is a road that
   * dives into a lake at its own end.
   */
  const levelAt = (x: number, z: number): number =>
    Math.max(WATER_LEVEL + 2, Math.round(terrain.heightCont(x, z)));

  const camp = findSite(terrain, 0, 0, 88, 132, rng() * Math.PI * 2, Math.PI, SITES[0].radius, rng);
  const campY = levelAt(camp.x, camp.z);

  // The gate bearing is rolled here and nowhere else — this single number is
  // "which side the exit is on is random per seed". The junction is then
  // searched over a WIDE arc around it (a narrow one pinned the fork to whatever
  // was 80 units down that exact bearing, lake or not); the gate itself is
  // derived from where the finished road leaves the camp, so swinging the
  // junction to find dry ground swings the gate with it.
  const exitAngle = rng() * Math.PI * 2;
  const jRaw = findSite(terrain, camp.x, camp.z, 70, 96, exitAngle, 0.75, 12, rng);
  const junctionY = levelAt(jRaw.x, jRaw.z);

  const jAngle = Math.atan2(jRaw.x - camp.x, jRaw.z - camp.z);
  const spurA = jAngle + 0.95 + rng() * 0.5;
  const spurB = jAngle - 0.95 - rng() * 0.5;
  const hamletA = findSite(
    terrain, jRaw.x, jRaw.z, 115, 165, spurA, 0.6, SITES[1].radius, rng, SITES[1].waterside,
  );
  const hamletB = findSite(
    terrain, jRaw.x, jRaw.z, 115, 165, spurB, 0.6, SITES[2].radius, rng, SITES[2].waterside,
  );
  const sitePos = [camp, hamletA, hamletB];
  const siteY = [campY, levelAt(hamletA.x, hamletA.z), levelAt(hamletB.x, hamletB.z)];

  // -- 2. Level the ground under each town BEFORE routing, so the road's last
  // few samples already run over the ground the town will actually stand on.
  for (let i = 0; i < SITES.length; i++) {
    terrain.flattens.push({
      x: sitePos[i].x, z: sitePos[i].z, h: siteY[i] + 0.55,
      core: SITES[i].outerRadius + 2, blend: SITES[i].outerRadius + 15,
    });
  }

  // -- 3. Roads. Anchored at both ends to heights the towns have committed to.
  const network = new RoadNetwork();
  // A road INSIDE a settlement is level with the settlement, which is what the
  // hold arguments buy — see `profileRoad`. The distance held is the flatten's
  // own core (radius + 2), so the deck and the levelled ground it is cut into
  // agree over exactly the same footprint rather than nearly the same one.
  const mkRoad = (
    id: string, fromId: string, toId: string,
    ax: number, az: number, ay: number, bx: number, bz: number, by: number, s: number,
    aHold = 0, bHold = 0,
  ): Road => {
    const route = routeRoad(terrain, ax, az, bx, bz, s);
    const road: Road = {
      id, fromId, toId, pts: profileRoad(terrain, route, ay, by, aHold, bHold),
      // Left at zero; `network.build()` squares both planes to the road's own
      // ends unless something set them first. See Road.trim.
      trim: new Float32Array(8),
    };
    network.add(road);
    return road;
  };
  const hold = (i: number): number => SITES[i].outerRadius + 2;

  const trunk = mkRoad(
    'camp-junction', SITES[0].id, 'junction',
    camp.x, camp.z, campY, jRaw.x, jRaw.z, junctionY, seed ^ 0x11,
    hold(0), 0,
  );
  const spurRoads = [
    mkRoad('junction-' + SITES[1].id, 'junction', SITES[1].id,
      jRaw.x, jRaw.z, junctionY, hamletA.x, hamletA.z, siteY[1], seed ^ 0x22,
      0, hold(1)),
    mkRoad('junction-' + SITES[2].id, 'junction', SITES[2].id,
      jRaw.x, jRaw.z, junctionY, hamletB.x, hamletB.z, siteY[2], seed ^ 0x33,
      0, hold(2)),
  ];
  // The fork is levelled like a town, at a fifth of the size. Three carriageways
  // stop on this one node, and CARVE_INSET deliberately leaves the node's own
  // column to the natural ground — so without this, an unkind seed stands the
  // junction fingerpost in a divot of its own roads' making.
  //
  // AFTER the routing, deliberately. Pushed before it, this flatten moves the
  // height field the router is searching, and both spurs took a different line:
  // measured, junction-stonewatch went from 145.0 units at grade 0.102 to 145.0
  // at 0.123, for a levelling the route had no reason to care about. The deck is
  // anchored at `junctionY` either way, so the profile does not need to see it.
  terrain.flattens.push({
    x: jRaw.x, z: jRaw.z, h: junctionY + 0.55, core: 5, blend: 12,
  });
  // -- 4. Gates, derived from where each road actually leaves its town.
  //
  // BEFORE `network.build()`, which it did not used to be. The Encampment's
  // carriageway now STOPS at its gate, and a trim plane cannot be set until the
  // gate is known — while the gate is, by design, wherever the route happens to
  // cross the footprint. Nothing between `add()` and `build()` queries the
  // network (`gateOn` walks `road.pts` directly), so the move is safe.
  const gates = [
    gateOn(trunk, camp.x, camp.z, SITES[0].radius, true),
    gateOn(spurRoads[0], hamletA.x, hamletA.z, SITES[1].radius, false),
    gateOn(spurRoads[1], hamletB.x, hamletB.z, SITES[2].radius, false),
  ];

  // The camp's gate sits on a SQUARE wall, so the opening is where the route
  // crosses that side's plane — not where it crosses the footprint circle the
  // bearing was rolled from. Two steps and not one, because the square's
  // orientation IS the gate bearing: the side cannot be chosen until the bearing
  // is known, and the crossing cannot be found until the side is chosen.
  {
    const a = gates[0].angle;
    const nx = Math.sin(a);
    const nz = Math.cos(a);
    const hit = planeHit(trunk, camp.x, camp.z, nx, nz, CAMP_WALL_HALF);
    gates[0] = { x: hit.x, z: hit.z, angle: a };
    // The carriageway lives on the far side of that plane, i.e. OUTSIDE the
    // camp. Inside the wall the road is route only: the ground there is the
    // camp's own trodden yard, which `WEAR.camp.tracks[0]` already paints bare
    // and dry along exactly this line, in the road's own colour family.
    setTrimStart(trunk, hit.x, hit.z, nx, nz);
  }

  network.build();
  terrain.roads = network;
  for (let i = 0; i < SITES.length; i++) {
    towns.push({
      id: SITES[i].id, nameKey: SITES[i].nameKey, kind: SITES[i].kind,
      x: sitePos[i].x, y: siteY[i], z: sitePos[i].z,
      radius: SITES[i].radius, outerRadius: SITES[i].outerRadius,
      color: SITES[i].color,
      gateX: gates[i].x, gateZ: gates[i].z, gateAngle: gates[i].angle,
    });
  }

  // -- 5. The ground each town has worn out, derived from the registry entry
  // that was just written. AFTER the gates, because the tracks are bearings
  // relative to the gate; before any chunk is built, like the flattens.
  for (const t of towns) terrain.grounds.push(wearPatch(t));

  return {
    towns: new Registry(towns, network.roads),
    network,
    spawn: pickRoadSpawn(trunk, camp.x, camp.z),
    junction: { x: jRaw.x, y: trunk.pts[trunk.pts.length - 1].y, z: jRaw.z },
  };
}

/**
 * The player's spawn: a scenic stretch of the Encampment road.
 *
 * The town does not own the spawn point and the spawn point is not in the town —
 * you start on the ROAD, far enough out that the camp is a destination you can
 * see and walk to. The scoring wants three things at once and they pull against
 * each other, which is why it is a score and not a rule:
 *
 *   - 40-70 units from the gate. Closer and the camp is not a journey; further
 *     and the first thing the player sees is empty country.
 *   - HIGH ground relative to the road either side of it. A road crests a rise
 *     a few times over seventy metres, and standing on one of them is the
 *     difference between "a road" and "a road with somewhere at the end of it".
 *   - not a bridge, and clear of the water.
 */
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
    if (fromCamp < 34 || fromCamp > 74) continue;
    if (at.y < WATER_LEVEL + 1.5) continue;
    // How much this point stands above the road 24 units either side of it.
    let rise = 0;
    for (const ds of [-24, 24]) {
      roadAt(road, Math.max(0, Math.min(len, s + ds)), probe);
      rise += at.y - probe.y;
    }
    const score = rise * 3 + at.y * 0.4 - Math.abs(fromCamp - 52) * 0.55;
    if (score > best) { best = score; bx = at.x; by = at.y; bz = at.z; }
  }
  return new THREE.Vector3(bx, by, bz);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Voxel scale for a signpost arm — see the note on the font in town-parts.ts. */
const SIGN_V = 0.095;

interface Spot { x: number; z: number; r: number }

/**
 * The scene side of the town system: every settlement and every metre of road
 * furniture, merged into a handful of meshes.
 *
 * Built ONCE at world creation, like `Shops`, and deliberately not streamed. A
 * camp is a dense cluster of geometry that would otherwise land in two or three
 * chunk builds, and props are already ~78% of a chunk build against a 3 ms
 * budget — the measured cost of putting the Encampment in the stream was a
 * doubling of the worst chunk in the world. Boot pays for it instead, where
 * there is already a shader warm-up running and nothing on screen.
 *
 * Materials: the SHARED prop material for everything solid, the terrain material
 * for the ribbons, and exactly one new one — `glowMat`, for fire. See the rules
 * at the top of town-parts.ts.
 */
export class Towns {
  readonly group = new THREE.Group();
  /**
   * What every piece stamped below BLOCKS — the world's answer to
   * `World.structureTopAt`.
   *
   * Owned here rather than assembled by the caller because it is filled by the
   * same `SolidStamp.add` calls that fill the meshes: the layout functions take
   * one stamper, not an accumulator and a collider list, so a hut cannot be
   * drawn without also being made solid. Populated in this constructor and
   * frozen at the end of it; towns are built once and never streamed, so
   * neither is this.
   */
  readonly solids = new StructureField();
  private readonly glowMats: THREE.MeshStandardMaterial[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  /** Per-site groups and their centres, for the distance cull in `update`. */
  private readonly sites: Array<{ g: THREE.Group; x: number; z: number; r: number }> = [];
  /**
   * Where each settlement's fire ended up, by town id.
   *
   * Recorded rather than derived: the camp's fire is thrown to one side of the
   * gate axis or the other on a coin flip off the town's own stream, so the
   * only honest way to know which is to be told by the thing that placed it.
   * `NpcSite.focusOf` reads this.
   */
  private readonly fires = new Map<string, { x: number; z: number }>();

  constructor(
    plan: SettlementPlan,
    parts: TownParts,
    props: PropLib,
    terrainMat: THREE.Material,
    seed: number,
  ) {
    // Two glow materials, not one: a camp fire and a lamp on the road are the
    // same shader program (three keys on the define set, and these differ only
    // in uniform values) but they must not pulse in lockstep, which is what a
    // single shared emissiveIntensity would do.
    const mkGlow = (): THREE.MeshStandardMaterial => {
      const m = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.55,
        metalness: 0,
        // Warm, and CHROMATIC on purpose: the selective bloom tags an object by
        // its material's emissive hue spread (post.ts, tagSources), so a white
        // emissive would light up and never bloom.
        emissive: new THREE.Color(0xff9a3c),
        emissiveIntensity: 2.0,
      });
      this.glowMats.push(m);
      return m;
    };
    const fireGlow = mkGlow();
    const lampGlow = mkGlow();
    // A THIRD glow material, for the campfire alone.
    //
    // `fireGlow` is the material for every hot thing in a settlement — the
    // braziers, the forge coals and, until now, the campfire — so its intensity
    // was the only brightness knob the fire had, and turning it down turned the
    // braziers down too. The camp's fire is the one that was washing the yard
    // out, and it is the one thing here big enough to be worth its own draw
    // call. Cheap by this file's own argument above: these three are the same
    // shader program differing only in uniform values, so a third costs no
    // program link.
    const hearthGlow = mkGlow();

    const emit = (
      acc: Accum, mat: THREE.Material, parent: THREE.Group, shadows: boolean,
    ): void => {
      const geo = acc.toGeometry();
      if (!geo) return;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
      mesh.matrixAutoUpdate = false;
      parent.add(mesh);
      this.geos.push(geo);
    };

    // -- towns ---------------------------------------------------------------
    for (const town of plan.towns.all) {
      const g = new THREE.Group();
      const solid = new SolidStamp(this.solids);
      const glow = new Accum();
      const hearth = new Accum();
      const rng = mulberry32((seed ^ 0x5eed) + town.id.length * 7919 + town.x * 31);
      if (town.kind === 'camp') {
        const fire = buildEncampment(solid, glow, hearth, parts, town, plan.network, rng);
        this.fires.set(town.id, fire);
      } else {
        buildHamlet(solid, glow, parts, town, plan.network, rng);
      }
      emit(solid.acc, props.solidMat, g, true);
      emit(glow, fireGlow, g, false);
      emit(hearth, hearthGlow, g, false);
      this.group.add(g);
      this.sites.push({ g, x: town.x, z: town.z, r: town.radius });
    }

    // -- roads ---------------------------------------------------------------
    for (const road of plan.network.roads) {
      const g = new THREE.Group();
      const solid = new SolidStamp(this.solids);
      const glow = new Accum();
      // Furniture belongs to the BUILT carriageway, not to the route. It is
      // placed by arc length from an end, so on the route the Encampment's
      // first lamp landed at arc 13 and its fingerpost at arc 17 — both INSIDE
      // the walls, lighting and signposting a stretch of camp yard. Measuring
      // from the gate instead puts them 13 and 17 units OUTSIDE it, which is
      // where a lamp on the approach was always meant to be.
      const built = { ...road, pts: builtDeck(road) };
      buildRoadFurniture(
        solid, glow, parts, built, plan.network, mulberry32(seed ^ road.pts.length),
      );
      addBridgeFurniture(solid, parts, built);
      emit(solid.acc, props.solidMat, g, true);
      emit(glow, lampGlow, g, false);

      const rib = buildRoadRibbon([road], seed);
      if (rib.idx.length > 0) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(rib.pos, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(rib.nrm, 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(rib.col, 3));
        geo.setIndex(rib.idx);
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, terrainMat);
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        g.add(mesh);
        this.geos.push(geo);
      }
      this.group.add(g);
      const mid = road.pts[Math.floor(road.pts.length / 2)];
      this.sites.push({ g, x: mid.x, z: mid.z, r: roadLength(road) * 0.5 + 20 });
    }

    // -- the fingerpost at the fork -----------------------------------------
    {
      const g = new THREE.Group();
      const solid = new SolidStamp(this.solids);
      const j = plan.junction;
      solid.add(parts.post, j.x, j.y, j.z, 0);
      const armY = [j.y + 3.55, j.y + 2.85, j.y + 2.15];
      const dests: Array<[string, number]> = [];
      for (const road of plan.network.roads) {
        // Which end of this road is the junction, and where does it head?
        const first = Math.hypot(road.pts[0].x - j.x, road.pts[0].z - j.z) < 6;
        const a = first ? road.pts[0] : road.pts[road.pts.length - 1];
        const b = first ? road.pts[Math.min(6, road.pts.length - 1)]
          : road.pts[Math.max(0, road.pts.length - 7)];
        const id = first ? road.toId : road.fromId;
        const site = SITES.find((s) => s.id === id);
        if (!site) continue;
        dests.push([t(site.signKey), Math.atan2(b.x - a.x, b.z - a.z)]);
      }
      dests.forEach(([text, ang], i) => {
        solid.add(signArm(text, SIGN_V), j.x, armY[i % armY.length], j.z, ang);
      });
      emit(solid.acc, props.solidMat, g, true);
      this.group.add(g);
      this.sites.push({ g, x: j.x, z: j.z, r: 12 });
    }

    // Every stamp is in. Freeze the boxes and index them; from here the field
    // is read-only and answers `structureTopAt` for the life of the session.
    this.solids.build();
  }

  /**
   * Flicker the fires and cull whole sites by distance.
   *
   * The cull is not decoration: the towns are resident for the life of the
   * session, so without it three settlements and four hundred metres of road
   * furniture are submitted to the shadow pass and the colour pass every frame
   * from anywhere on the map. 420 units is past the far plane's useful range at
   * this fog density, so nothing pops.
   */
  update(time: number, focus: THREE.Vector3): void {
    // Two beats, an octave and a bit apart, so neither reads as a sine.
    this.glowMats[0].emissiveIntensity = 2.0 + Math.sin(time * 6.1) * 0.22
      + Math.sin(time * 2.3) * 0.13;
    this.glowMats[1].emissiveIntensity = 1.7 + Math.sin(time * 4.3 + 1.9) * 0.16
      + Math.sin(time * 9.7) * 0.08;
    // The campfire, DIMMER than the braziers rather than brighter.
    //
    // 2.0 against an emissive of 0xff9a3c is 2.35 linear at the top of the
    // flicker, and the tone chain's rolloff asymptotes at knee + head = 2.6:
    // the fire was sitting within a fifth of the hardest value the compressor
    // can pass, which is why it read as a white hole rather than an orange
    // core. 1.5 peaks at 1.7, a whisker over the 1.55 knee, so the core is the
    // brightest thing in camp and still resolves as ORANGE through the curve.
    //
    // Not lower, and 1.15 was: with the flame also down to a third of its old
    // volume, that put the hearth DIMMER than the braziers standing round it,
    // which is backwards for a camp — captured that way (_camp-far2.png, first
    // pass) with a brazier reading as the brightest thing inside the walls.
    // Most of the wash was the size; the intensity only has to stop the core
    // clipping.
    //
    // Dimming cannot switch the glow off: the selective bloom tags on emissive
    // CHROMA, not on intensity (post.ts, `tagSources`).
    this.glowMats[2].emissiveIntensity = 1.5 + Math.sin(time * 5.3 + 0.7) * 0.14
      + Math.sin(time * 2.9) * 0.06;
    for (const s of this.sites) {
      const d = Math.hypot(s.x - focus.x, s.z - focus.z) - s.r;
      s.g.visible = d < 420;
    }
  }

  /**
   * Where this town's fire stands, or null for a settlement without one.
   * `NpcSite.focusOf` in world/index.ts is the only caller.
   */
  fireOf(townId: string): { x: number; z: number } | null {
    return this.fires.get(townId) ?? null;
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.glowMats) m.dispose();
    this.geos.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

/**
 * Half the length of one fence panel, world units.
 *
 * `roughFence` paints 14 voxels along +z and bakes CENTRED, so a stamped panel
 * reaches this far either side of the point it is stamped at. This is the
 * number `spanDistanceTo` has to be handed; a panel's midpoint on its own says
 * nothing about where its stakes land.
 */
const FENCE_HALF = 7 * V;

/**
 * How close a fence panel's timber may come to a carriageway centreline.
 *
 * `DECK_EDGE` (5.0) is the ribbon's rim — the outer edge of the surface that is
 * both drawn and walked. The 0.6 on top covers the panel's own half-width (a
 * stake is one voxel either side of the line, 0.28) and the 0.18 that
 * `spanDistanceTo` may over-report at its sampling pitch, and leaves enough
 * over that a panel which survives is visibly OFF the gravel rather than
 * touching it.
 *
 * Measured on the finished world. 38 panels are stamped between the road runs
 * and the two hamlet arcs, every road panel offset 6.5 units from its OWN
 * road — and three of them still came within 0.13, 2.16 and 5.25 units of a
 * centreline. The first two lay flat ACROSS the carriageway nine units from the
 * player's own spawn (_fence-cross-before.png), because the trunk road doubles
 * back at the junction and a run laid along the inside of that bend cuts the
 * corner: the offset is measured against the road where the panel starts, and
 * the road is somewhere else by the time the panel ends.
 *
 * Those three are cut and the other 35 stand; the closest survivor clears the
 * centreline by 5.79, i.e. 0.79 outside the ribbon's rim.
 */
const FENCE_ROAD_CLEAR = DECK_EDGE + 0.6;

/**
 * Stamp one fence panel — unless its timber would land on a road.
 *
 * A run that meets a carriageway STOPS AT THE VERGE on both sides rather than
 * being deleted: only the panels that actually reach the road are skipped, so
 * what the player walks up to is a gap in a fence, which is what a field gate
 * looks like, and the panels either side still end on their own stakes rather
 * than on a post hanging over the gravel.
 *
 * The road is asked, not inferred. A fence run knows the arc length and the
 * perpendicular of ITS OWN road and nothing else, which is precisely the
 * information that cannot see a second road at a fork or the far side of a
 * hairpin — see `RoadClearance` in roads.ts for why that is the shape of every
 * one of these bugs.
 */
function fencePanel(
  solid: SolidStamp, parts: TownParts, network: RoadClearance,
  x: number, y: number, z: number, yaw: number,
): void {
  // The panel lies along its own yaw: `Accum.add` maps local +z to
  // (sin yaw, cos yaw).
  const dx = Math.sin(yaw) * FENCE_HALF;
  const dz = Math.cos(yaw) * FENCE_HALF;
  if (network.spanDistanceTo(x - dx, z - dz, x + dx, z + dz) < FENCE_ROAD_CLEAR) return;
  solid.add(parts.fence, x, y, z, yaw);
}

/** Reject a spot that overlaps something already placed, or the carriageway. */
function place(
  taken: Spot[], network: RoadNetwork, x: number, z: number, r: number, roadClear: number,
): boolean {
  if (network.distanceTo(x, z) < roadClear) return false;
  for (const t of taken) {
    const dx = t.x - x;
    const dz = t.z - z;
    if (dx * dx + dz * dz < (t.r + r) * (t.r + r)) return false;
  }
  taken.push({ x, z, r });
  return true;
}

/**
 * THE ENCAMPMENT: a walled camp with one gate, a fire at its heart and enough
 * clutter to read as occupied.
 *
 * Laid out from the outside in, because each ring constrains the next: the
 * perimeter fixes the usable radius, the road through the gate fixes the one
 * line nothing may stand on, and everything else fills what is left. Every
 * placement goes through `place`, which rejects an overlap or anything within
 * reach of the carriageway — the road is a real object here, queried from the
 * same field the player walks on, not a remembered bearing.
 */
function buildEncampment(
  solid: SolidStamp, glow: Accum, hearth: Accum, parts: TownParts, town: TownInfo,
  network: RoadNetwork, rng: () => number,
): { x: number; z: number } {
  const { x: cx, z: cz, y: cy, gateAngle } = town;
  const taken: Spot[] = [];
  const at = (ang: number, dist: number): [number, number] =>
    [cx + Math.sin(ang) * dist, cz + Math.cos(ang) * dist];
  /** Distance from the middle to the WALL on a bearing. */
  const wall = (ang: number): number => {
    const u = ang - gateAngle;
    return CAMP_WALL_HALF / Math.max(Math.abs(Math.sin(u)), Math.abs(Math.cos(u)));
  };
  /**
   * ...and to a line `k` INSIDE it, measured perpendicular to the nearest side.
   *
   * `wall(ang) - k` is the obvious version and it is wrong in the one place it
   * matters: backing off k along a RADIUS near a corner only buys 0.71k of
   * clearance from either wall. Scaling keeps the inset a true perpendicular
   * distance, so a hut at `inset(a, 7.5)` is seven and a half units off the
   * timber whether it sits behind a side or is tucked into a corner — which is
   * what `R - 7.5` meant back when the wall was a circle.
   */
  const inset = (ang: number, k: number): number =>
    wall(ang) * (1 - k / CAMP_WALL_HALF);

  // -- perimeter -----------------------------------------------------------
  // FOUR RUNS AND FOUR CORNERS, squared to the gate rather than to the world
  // axes. Side `s` faces outward along `gateAngle + s * PI/2`, so side 0 is the
  // gate's: the arch sits flush on it and the road crosses it square-on, the
  // `WEAR.camp.tracks` bearings (which are already relative to the gate) keep
  // meaning what they meant, and every interior bearing below is already
  // `gateAngle + something`, so the square's own frame falls out for free.
  //
  // ALL TIMBER. A third of the ring opposite the gate used to be a low stone
  // wall — "two materials read as a camp that grew rather than one that was
  // issued" — which was true and is no longer wanted. The variety it bought is
  // gone with it; if the wall reads flat at distance the answer is a second
  // palisade variant with a different log rhythm, not the rock back.
  const spanLen = 15 * V * WALL_S;
  // Where the road actually crosses the gate side, measured ALONG that side
  // from its middle. Not assumed to be zero: the route is a greedy walk and the
  // gate is derived from where it really crosses, so the opening goes where the
  // cart goes.
  const gateOff = (town.gateX - cx) * Math.cos(gateAngle)
    - (town.gateZ - cz) * Math.sin(gateAngle);
  /**
   * Half the gate arch's own footprint. `gateArch` paints 29 voxels along +z at
   * V and is stamped unscaled — the wall is 25% bigger, the arch is not, which
   * is what brings the 4.90 wall top up to meet its 5.04 lintel.
   */
  const GATE_HALF = 29 * V * 0.5;
  /**
   * Lay a run of palisade from `u0` to `u1` along side `s`, ends flush.
   *
   * SPANS OVERLAP RATHER THAN GAP. A run is almost never a whole number of
   * 5.25-unit templates, so the remainder has to go somewhere; `ceil` puts it
   * into overlap, which reads as a denser stockade, where `round` or `floor`
   * would leave a hole, which reads as a bug.
   *
   * The runs are laid PER SEGMENT rather than on one pitch across the whole
   * side, and that is what the gate needs. A uniform pitch knows nothing about
   * where the arch stands, so the spans nearest it get dropped for clearance
   * and the wall stops ~3 units short of the posts on either side — captured
   * that way (_camp-gate.png, first pass) as two obvious holes flanking the
   * gate. Running outward FROM the arch's own faces instead puts timber against
   * post with no gap to tune.
   */
  const run = (
    nx: number, nz: number, tx: number, tz: number, f: number,
    u0: number, u1: number,
  ): void => {
    const len = u1 - u0;
    if (len <= 0.01) return;
    const n = Math.ceil(len / spanLen);
    const pitch = len / n;
    for (let j = 0; j < n; j++) {
      const u = u0 + (j + 0.5) * pitch;
      solid.add(
        parts.palisade,
        cx + nx * CAMP_WALL_HALF + tx * u, cy, cz + nz * CAMP_WALL_HALF + tz * u,
        f + Math.PI / 2, WALL_S, WALL_S,
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
    // A corner post at this side's leading corner, so four in all. Not for
    // holes — the two runs already overlap in the corner cell — but because
    // butt-jointed log ends read as two fences meeting, where a post with walls
    // hung off it reads as a stockade.
    solid.add(
      parts.cornerPost,
      cx + (nx + tx) * CAMP_WALL_HALF, cy, cz + (nz + tz) * CAMP_WALL_HALF,
      f + Math.PI / 2, WALL_S, WALL_S,
    );
  }
  // The gate itself, ON the wall line and square to it.
  {
    const f = gateAngle;
    const x = cx + Math.sin(f) * CAMP_WALL_HALF + Math.cos(f) * gateOff;
    const z = cz + Math.cos(f) * CAMP_WALL_HALF - Math.sin(f) * gateOff;
    solid.add(parts.gate, x, cy, z, gateAngle + Math.PI / 2);
    taken.push({ x, z, r: 6 });
  }
  // -- the fire, and the ring of life around it -----------------------------
  // Off the road axis rather than dead centre: the carriageway runs from the
  // gate to the middle of camp, and a campfire in the middle of it would be a
  // bonfire in the middle of a road.
  const side = rng() < 0.5 ? 1 : -1;
  const [fx, fz] = at(gateAngle + Math.PI / 2 * side, 5.4);
  solid.add(parts.fire, fx, cy, fz, rng() * 6.28);
  hearth.add(parts.fireGlow, fx, cy, fz, rng() * 6.28, 1, 1, 1, 1);
  taken.push({ x: fx, z: fz, r: 4.2 });
  // Log seats round the fire.
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.4;
    const x = fx + Math.sin(a) * 3.6;
    const z = fz + Math.cos(a) * 3.6;
    if (place(taken, network, x, z, 1.2, 3.4)) {
      solid.add(parts.woodpile, x, cy, z, a + Math.PI / 2, 0.55, 0.4);
    }
  }

  // -- buildings ------------------------------------------------------------
  // Three huts, facing the fire, on the far half of the camp from the gate.
  for (let k = 0; k < 3; k++) {
    const a = gateAngle + Math.PI + (k - 1) * 0.85 + (rng() - 0.5) * 0.2;
    const [x, z] = at(a, inset(a, 7.5));
    if (!place(taken, network, x, z, 4.4, 7)) continue;
    // Door toward the fire.
    solid.add(parts.huts[k], x, cy, z, Math.atan2(fx - x, fz - z));
    if (k === 2) {
      // Smithy: coals in the forge mouth, a stride out from the door.
      const dx = Math.sin(Math.atan2(fx - x, fz - z));
      const dz = Math.cos(Math.atan2(fx - x, fz - z));
      // On the ground outside the door, not floating beside the wall: at
      // cy + 0.62 it read as a lit window (_town-camp-far.png) rather than as a
      // fire someone is working at.
      glow.add(parts.forgeGlow, x + dx * 3.4, cy + 0.1, z + dz * 3.4, 0, 1.2, 1, 1, 1);
    }
  }

  // -- tents ----------------------------------------------------------------
  let tentIdx = 0;
  for (let k = 0; k < 9 && tentIdx < 7; k++) {
    const a = gateAngle + 0.7 + (k / 9) * Math.PI * 1.6 + (rng() - 0.5) * 0.25;
    const [x, z] = at(a, inset(a, 5.5 + rng() * 4));
    if (!place(taken, network, x, z, 3.2, 6)) continue;
    if (tentIdx % 3 === 2) solid.add(parts.bell, x, cy, z, Math.atan2(fx - x, fz - z));
    else solid.add(parts.tents[tentIdx % parts.tents.length], x, cy, z, a + Math.PI / 2);
    tentIdx++;
  }

  // -- watch platforms ------------------------------------------------------
  // AFTER the buildings, and that ordering is a bug fix rather than a taste:
  // `place` is first-come, and at radius 16.6 with a 2.4 clearance a watch post
  // sits 5.1-5.7 units from a hut at radius 11.5, which is inside the 6.8 the
  // pair needs. Placed first they silently rejected all three huts, and the camp
  // was captured (_town-camp-far.png) as a wall full of tents with nothing built
  // in it. Big, fixed structures claim their ground before the furniture does.
  for (let k = 0; k < 4; k++) {
    const a = gateAngle + Math.PI * 0.4 + (k / 4) * Math.PI * 1.2;
    const [x, z] = at(a, inset(a, 2.4));
    if (place(taken, network, x, z, 2.4, 5.5)) {
      // Scaled with the wall, and it has to be: at 1.0 the platform sits at
      // 4.76 and the wall top is now 4.90, so the guard would be looking at
      // timber. At WALL_S the platform is 5.95 and the post tops out at 7.00,
      // which keeps town-parts.ts's claim that it is the tallest thing in camp.
      solid.add(parts.watch, x, cy, z, a, WALL_S, WALL_S);
    }
  }

  // -- clutter --------------------------------------------------------------
  const clutter: Array<[Template, number, number]> = [
    [parts.barrel, 1.0, 12], [parts.crateS, 1.0, 8], [parts.crateL, 1.0, 5],
    [parts.woodpile, 1.1, 3], [parts.rack, 1.0, 2],
  ];
  for (const [tpl, scl, count] of clutter) {
    let placed = 0;
    for (let k = 0; k < count * 4 && placed < count; k++) {
      const a = rng() * Math.PI * 2;
      const [x, z] = at(a, inset(a, 2 + rng() * (CAMP_WALL_HALF - 7)));
      if (!place(taken, network, x, z, 1.4 * scl, 4.2)) continue;
      solid.add(tpl, x, cy, z, rng() * 6.28, scl);
      placed++;
    }
  }
  // Carts, parked off the road just inside the gate.
  for (const [dside, tpl] of [[1, parts.cartHood], [-1, parts.cartOpen]] as const) {
    const a = gateAngle + dside * 0.42;
    const [x, z] = at(a, inset(a, 8));
    if (place(taken, network, x, z, 3, 4.6)) {
      solid.add(tpl, x, cy, z, a + Math.PI / 2 + dside * 0.3);
    }
  }

  // -- light ----------------------------------------------------------------
  // Braziers: two flanking the gate, the rest spread round the interior. These
  // are the camp's night lighting and they are emissive voxels, not lights —
  // see the note on lampBody in town-parts.ts.
  const brazierSpots: Array<[number, number]> = [
    [gateAngle + 0.30, inset(gateAngle + 0.30, 3.4)],
    [gateAngle - 0.30, inset(gateAngle - 0.30, 3.4)],
  ];
  for (let k = 0; k < 5; k++) {
    const a = gateAngle + 1.1 + (k / 5) * 4.4;
    brazierSpots.push([a, inset(a, 6 + rng() * 4)]);
  }
  for (const [a, d] of brazierSpots) {
    const [x, z] = at(a, d);
    if (!place(taken, network, x, z, 1.6, 4.0)) continue;
    solid.add(parts.brazier, x, cy, z, rng() * 6.28);
    glow.add(parts.brazierGlow, x, cy, z, 0, 1, 1, 1, 1);
  }
  // The fire is the camp's social centre, and the NPC placer wants to know
  // where it went. See `Towns.fires` / `NpcSite.focusOf`.
  return { x: fx, z: fz };
}

/**
 * A HAMLET: the same pieces, a tenth of the parts list.
 *
 * Deliberately not a smaller Encampment. It has no wall — a fence arc on the
 * weather side and nothing else — because the thing that makes the start town
 * feel like a stronghold is that the others are not one.
 */
function buildHamlet(
  solid: SolidStamp, glow: Accum, parts: TownParts, town: TownInfo,
  network: RoadNetwork, rng: () => number,
): void {
  const { x: cx, z: cz, y: cy, radius: R, gateAngle } = town;
  const taken: Spot[] = [];
  const at = (ang: number, dist: number): [number, number] =>
    [cx + Math.sin(ang) * dist, cz + Math.cos(ang) * dist];

  // The well is the centre of a hamlet the way a fire is the centre of a camp.
  const [wx, wz] = at(gateAngle + Math.PI / 2, 4.2);
  solid.add(parts.well, wx, cy, wz, rng() * 6.28);
  taken.push({ x: wx, z: wz, r: 3 });

  for (let k = 0; k < 4; k++) {
    const a = gateAngle + Math.PI * 0.55 + (k / 4) * Math.PI * 0.9 + (rng() - 0.5) * 0.2;
    const [x, z] = at(a, R - 5.5 - rng() * 3);
    if (!place(taken, network, x, z, 4.4, 7)) continue;
    solid.add(parts.huts[k % parts.huts.length], x, cy, z, Math.atan2(wx - x, wz - z));
  }
  for (let k = 0; k < 3; k++) {
    const a = gateAngle - 0.5 - (k / 3) * 1.5;
    const [x, z] = at(a, R - 6 - rng() * 3);
    if (!place(taken, network, x, z, 3.2, 6)) continue;
    solid.add(k === 1 ? parts.bell : parts.tents[k % parts.tents.length],
      x, cy, z, a + Math.PI / 2);
  }
  // A fence arc on the side away from the road, and a paddock cart.
  //
  // Through `fencePanel` like every other run, and that is not belt and braces:
  // the arc is laid out from the town's OWN radius and gate bearing, which is
  // the one thing in `buildHamlet` that never consults the network — everything
  // else here goes through `place`. Which side of the town the road leaves on
  // is rolled per seed and the route is a greedy walk, so "the arc is opposite
  // the gate, therefore it cannot meet the road" is a coincidence this seed
  // happens to enjoy — every arc panel here clears the nearest deck by at least
  // 6.5 units, and not one of them is cut — rather than a property of the
  // layout.
  const fenceLen = 15 * V;
  const arc = Math.round((Math.PI * 0.7 * R) / fenceLen);
  for (let i = 0; i < arc; i++) {
    const a = gateAngle + Math.PI * 0.65 + (i / arc) * Math.PI * 0.7;
    const [x, z] = at(a, R - 1.2);
    fencePanel(solid, parts, network, x, cy, z, a + Math.PI / 2);
  }
  for (let k = 0; k < 14; k++) {
    const a = rng() * Math.PI * 2;
    const [x, z] = at(a, 4 + rng() * (R - 6));
    const tpl = k % 3 === 0 ? parts.crateS : k % 3 === 1 ? parts.barrel : parts.woodpile;
    if (!place(taken, network, x, z, 1.4, 4.0)) continue;
    solid.add(tpl, x, cy, z, rng() * 6.28);
  }
  {
    const [x, z] = at(gateAngle - 0.5, R - 7);
    if (place(taken, network, x, z, 3, 4.6)) {
      solid.add(parts.cartOpen, x, cy, z, gateAngle);
    }
  }
  for (let k = 0; k < 3; k++) {
    const a = gateAngle + 0.4 + k * 2.1;
    const [x, z] = at(a, R - 4.5);
    if (!place(taken, network, x, z, 1.6, 4.0)) continue;
    solid.add(parts.brazier, x, cy, z, 0);
    glow.add(parts.brazierGlow, x, cy, z, 0, 1, 1, 1, 1);
  }
}

/**
 * What lines a road: lamps at intervals, rough tree fence on some stretches,
 * and a labelled fingerpost at each end.
 *
 * Everything here is placed by ARC LENGTH along the deck and offset along its
 * perpendicular, so the furniture follows the road round a bend instead of being
 * scattered near it, and everything sits on the deck height — which is the
 * continuous surface the player walks, so a lamp at the top of a rise stands on
 * the rise rather than in it.
 */
function buildRoadFurniture(
  solid: SolidStamp, glow: Accum, parts: TownParts, road: Road,
  network: RoadClearance, rng: () => number,
): void {
  const len = roadLength(road);
  const at = { x: 0, y: 0, z: 0, dx: 0, dz: 0 };
  const LAMP_STEP = 26;
  let lampSide = 1;
  for (let s = LAMP_STEP * 0.5; s < len; s += LAMP_STEP) {
    roadAt(road, s, at);
    // Sample straight off the deck: a lamp on a bridge would be standing on
    // planks over open water, and the railings already own that edge.
    const near = road.pts[Math.min(road.pts.length - 1, Math.round(s / 3))];
    if (near.bridge) continue;
    const px = -at.dz * lampSide;
    const pz = at.dx * lampSide;
    const off = DECK_EDGE + 0.8;
    const x = at.x + px * off;
    const z = at.z + pz * off;
    const yaw = Math.atan2(-px, -pz); // bracket leans over the road
    solid.add(parts.lamp, x, at.y, z, yaw);
    glow.add(parts.lampGlow, x, at.y, z, yaw, 1, 1, 1, 1);
    lampSide = -lampSide;
  }

  // Fence: a few long runs rather than a continuous hem, on alternating sides.
  const fenceLen = 15 * V;
  let s = 20 + rng() * 30;
  while (s < len - 20) {
    const runs = 4 + Math.floor(rng() * 6);
    const fside = rng() < 0.5 ? 1 : -1;
    for (let k = 0; k < runs; k++) {
      const sk = s + k * fenceLen;
      if (sk > len - 10) break;
      roadAt(road, sk, at);
      const near = road.pts[Math.min(road.pts.length - 1, Math.round(sk / 3))];
      if (near.bridge) continue;
      const off = DECK_EDGE + 1.5;
      // The offset is measured against THIS road. `fencePanel` measures the
      // finished panel against the whole network, which is the only way a run
      // laid along one road can know about the other two at a fork — or about
      // its own road, further along, on the inside of a bend.
      fencePanel(
        solid, parts, network,
        at.x - at.dz * fside * off, at.y, at.z + at.dx * fside * off,
        Math.atan2(at.dx, at.dz),
      );
    }
    s += runs * fenceLen + 40 + rng() * 70;
  }

  // Fingerposts: one at each end that names where the road goes, set back from
  // the town so it is read on the approach rather than at the gate.
  // The road's `toId`/`fromId` are IDS; what goes on the board is the looked-up
  // sign string, folded to the font by `signArm`.
  const label = (id: string): string =>
    t(SITES.find((q) => q.id === id)?.signKey ?? JUNCTION_SIGN_KEY);
  const ends: Array<[number, string, number]> = [
    [Math.min(len * 0.4, 17), road.toId, 1],
    [Math.max(len * 0.6, len - 17), road.fromId, -1],
  ];
  for (const [sPos, destId, dir] of ends) {
    const sign = label(destId);
    roadAt(road, sPos, at);
    const px = -at.dz;
    const pz = at.dx;
    const off = DECK_EDGE + 1.1;
    const x = at.x + px * off;
    const z = at.z + pz * off;
    solid.add(parts.post, x, at.y, z, 0);
    solid.add(
      signArm(sign, SIGN_V), x, at.y + 3.4, z,
      Math.atan2(at.dx * dir, at.dz * dir),
    );
  }
}
