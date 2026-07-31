/**
 * TOWNS — named places on the overworld, and the road network that joins them.
 *
 * A town here is an OVERWORLD LANDMARK, not an instanced zone: you walk in and
 * out of it seamlessly, there is no boundary and nothing loads. (The zone system
 * in world/zones.ts exists and is deliberately not used — it is for the dungeon,
 * where the point is that the overworld unloads.) A town is therefore three
 * ordinary things stacked on the same coordinates: a flatten disc in the height
 * field, an exclusion that keeps the forest off it, and a merged voxel mesh.
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
import { Terrain, WATER_LEVEL } from './terrain';
import {
  RoadNetwork, roadAt, roadLength, routeRoad, profileRoad, straightWetLength,
  DECK_EDGE, NECK_MAX, type Road,
} from './roads';
import { Accum, type PropLib, type Template } from './props';
import {
  TownParts, V, addBridgeFurniture, buildRoadRibbon, signArm,
} from './town-parts';
import { mulberry32 } from './noise';

// ---------------------------------------------------------------------------
// What towns exist
// ---------------------------------------------------------------------------

interface SiteSpec {
  id: string;
  name: string;
  /** Short, upper-case, <= 10 characters: what a fingerpost arm reads. */
  sign: string;
  kind: TownInfo['kind'];
  radius: number;
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
    id: 'encampment', name: 'The Encampment', sign: 'ENCAMPMENT',
    kind: 'camp', radius: 19, color: 0xffb45e,
  },
  {
    id: 'redbriar', name: 'Redbriar Mill', sign: 'REDBRIAR',
    kind: 'hamlet', radius: 15, color: 0x9ad46a, waterside: true,
  },
  {
    id: 'stonewatch', name: 'Stonewatch', sign: 'STONEWATCH',
    kind: 'hamlet', radius: 15, color: 0x8fc4e8,
  },
];

/** Where the fingerpost at the fork stands, as far as a signpost is concerned. */
const JUNCTION_SIGN = 'CROSSWAY';

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
      core: SITES[i].radius + 2, blend: SITES[i].radius + 15,
    });
  }

  // -- 3. Roads. Anchored at both ends to heights the towns have committed to.
  const network = new RoadNetwork();
  const mkRoad = (
    id: string, fromId: string, toId: string,
    ax: number, az: number, ay: number, bx: number, bz: number, by: number, s: number,
  ): Road => {
    const route = routeRoad(terrain, ax, az, bx, bz, s);
    const road: Road = { id, fromId, toId, pts: profileRoad(terrain, route, ay, by) };
    network.add(road);
    return road;
  };

  const trunk = mkRoad(
    'camp-junction', SITES[0].id, 'junction',
    camp.x, camp.z, campY, jRaw.x, jRaw.z, junctionY, seed ^ 0x11,
  );
  const spurRoads = [
    mkRoad('junction-' + SITES[1].id, 'junction', SITES[1].id,
      jRaw.x, jRaw.z, junctionY, hamletA.x, hamletA.z, siteY[1], seed ^ 0x22),
    mkRoad('junction-' + SITES[2].id, 'junction', SITES[2].id,
      jRaw.x, jRaw.z, junctionY, hamletB.x, hamletB.z, siteY[2], seed ^ 0x33),
  ];
  network.build();
  terrain.roads = network;

  // -- 4. Gates, derived from where each road actually leaves its town.
  const gates = [
    gateOn(trunk, camp.x, camp.z, SITES[0].radius, true),
    gateOn(spurRoads[0], hamletA.x, hamletA.z, SITES[1].radius, false),
    gateOn(spurRoads[1], hamletB.x, hamletB.z, SITES[2].radius, false),
  ];
  for (let i = 0; i < SITES.length; i++) {
    towns.push({
      id: SITES[i].id, name: SITES[i].name, kind: SITES[i].kind,
      x: sitePos[i].x, y: siteY[i], z: sitePos[i].z,
      radius: SITES[i].radius, color: SITES[i].color,
      gateX: gates[i].x, gateZ: gates[i].z, gateAngle: gates[i].angle,
    });
  }

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
  private readonly glowMats: THREE.MeshStandardMaterial[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  /** Per-site groups and their centres, for the distance cull in `update`. */
  private readonly sites: Array<{ g: THREE.Group; x: number; z: number; r: number }> = [];

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
      const solid = new Accum();
      const glow = new Accum();
      const rng = mulberry32((seed ^ 0x5eed) + town.id.length * 7919 + town.x * 31);
      if (town.kind === 'camp') buildEncampment(solid, glow, parts, town, plan.network, rng);
      else buildHamlet(solid, glow, parts, town, plan.network, rng);
      emit(solid, props.solidMat, g, true);
      emit(glow, fireGlow, g, false);
      this.group.add(g);
      this.sites.push({ g, x: town.x, z: town.z, r: town.radius });
    }

    // -- roads ---------------------------------------------------------------
    for (const road of plan.network.roads) {
      const g = new THREE.Group();
      const solid = new Accum();
      const glow = new Accum();
      buildRoadFurniture(solid, glow, parts, road, mulberry32(seed ^ road.pts.length));
      addBridgeFurniture(solid, parts, road);
      emit(solid, props.solidMat, g, true);
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
      const solid = new Accum();
      const j = plan.junction;
      solid.add(parts.post, j.x, j.y, j.z, 0, 1, 1, 1, 1);
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
        dests.push([site.sign, Math.atan2(b.x - a.x, b.z - a.z)]);
      }
      dests.forEach(([text, ang], i) => {
        solid.add(signArm(text, SIGN_V), j.x, armY[i % armY.length], j.z, ang, 1, 1, 1, 1);
      });
      emit(solid, props.solidMat, g, true);
      this.group.add(g);
      this.sites.push({ g, x: j.x, z: j.z, r: 12 });
    }
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
    for (const s of this.sites) {
      const d = Math.hypot(s.x - focus.x, s.z - focus.z) - s.r;
      s.g.visible = d < 420;
    }
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
  solid: Accum, glow: Accum, parts: TownParts, town: TownInfo,
  network: RoadNetwork, rng: () => number,
): void {
  const { x: cx, z: cz, y: cy, radius: R, gateAngle } = town;
  const taken: Spot[] = [];
  const at = (ang: number, dist: number): [number, number] =>
    [cx + Math.sin(ang) * dist, cz + Math.cos(ang) * dist];

  // -- perimeter -----------------------------------------------------------
  // Span length is the palisade template's own 4.2 units; the count is whatever
  // divides the circumference nearest to that, so the ring closes exactly.
  const spanLen = 15 * V;
  const spans = Math.max(12, Math.round((2 * Math.PI * R) / spanLen));
  // The gate is 8 units wide, so the gap is a little over that.
  const gateGap = 5.6 / R;
  // A third of the ring, opposite the gate, is a low stone wall instead of
  // timber: two materials read as a camp that grew rather than one that was
  // issued, and the stone goes on the side nobody drives a cart through.
  for (let i = 0; i < spans; i++) {
    const a = (i / spans) * Math.PI * 2;
    let da = Math.abs(((a - gateAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (da < gateGap) continue;
    da = Math.abs(((a - gateAngle - Math.PI + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    const stone = da < 1.05;
    const [x, z] = at(a, R);
    solid.add(stone ? parts.stoneWall : parts.palisade, x, cy, z, a + Math.PI / 2, 1, 1, 1, 1);
  }
  // The gate itself, straddling the road.
  {
    const [x, z] = at(gateAngle, R);
    solid.add(parts.gate, x, cy, z, gateAngle + Math.PI / 2, 1, 1, 1, 1);
    taken.push({ x, z, r: 6 });
  }
  // -- the fire, and the ring of life around it -----------------------------
  // Off the road axis rather than dead centre: the carriageway runs from the
  // gate to the middle of camp, and a campfire in the middle of it would be a
  // bonfire in the middle of a road.
  const side = rng() < 0.5 ? 1 : -1;
  const [fx, fz] = at(gateAngle + Math.PI / 2 * side, 5.4);
  solid.add(parts.fire, fx, cy, fz, rng() * 6.28, 1, 1, 1, 1);
  glow.add(parts.fireGlow, fx, cy, fz, rng() * 6.28, 1, 1, 1, 1);
  taken.push({ x: fx, z: fz, r: 4.2 });
  // Log seats round the fire.
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.4;
    const x = fx + Math.sin(a) * 3.6;
    const z = fz + Math.cos(a) * 3.6;
    if (place(taken, network, x, z, 1.2, 3.4)) {
      solid.add(parts.woodpile, x, cy, z, a + Math.PI / 2, 0.55, 1, 1, 1, 0.4);
    }
  }

  // -- buildings ------------------------------------------------------------
  // Three huts, facing the fire, on the far half of the camp from the gate.
  for (let k = 0; k < 3; k++) {
    const a = gateAngle + Math.PI + (k - 1) * 0.75 + (rng() - 0.5) * 0.2;
    const [x, z] = at(a, R - 7.5);
    if (!place(taken, network, x, z, 4.4, 7)) continue;
    // Door toward the fire.
    solid.add(parts.huts[k], x, cy, z, Math.atan2(fx - x, fz - z), 1, 1, 1, 1);
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
    const [x, z] = at(a, R - 5.5 - rng() * 4);
    if (!place(taken, network, x, z, 3.2, 6)) continue;
    if (tentIdx % 3 === 2) solid.add(parts.bell, x, cy, z, Math.atan2(fx - x, fz - z), 1, 1, 1, 1);
    else solid.add(parts.tents[tentIdx % parts.tents.length], x, cy, z, a + Math.PI / 2, 1, 1, 1, 1);
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
    const [x, z] = at(a, R - 2.4);
    if (place(taken, network, x, z, 2.4, 5.5)) {
      solid.add(parts.watch, x, cy, z, a, 1, 1, 1, 1);
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
      const [x, z] = at(a, 5 + rng() * (R - 7));
      if (!place(taken, network, x, z, 1.4 * scl, 4.2)) continue;
      solid.add(tpl, x, cy, z, rng() * 6.28, scl, 1, 1, 1);
      placed++;
    }
  }
  // Carts, parked off the road just inside the gate.
  for (const [dside, tpl] of [[1, parts.cartHood], [-1, parts.cartOpen]] as const) {
    const a = gateAngle + dside * 0.42;
    const [x, z] = at(a, R - 8);
    if (place(taken, network, x, z, 3, 4.6)) {
      solid.add(tpl, x, cy, z, a + Math.PI / 2 + dside * 0.3, 1, 1, 1, 1);
    }
  }

  // -- light ----------------------------------------------------------------
  // Braziers: two flanking the gate, the rest spread round the interior. These
  // are the camp's night lighting and they are emissive voxels, not lights —
  // see the note on lampBody in town-parts.ts.
  const brazierSpots: Array<[number, number]> = [
    [gateAngle + 0.30, R - 3.4], [gateAngle - 0.30, R - 3.4],
  ];
  for (let k = 0; k < 5; k++) brazierSpots.push([gateAngle + 1.1 + (k / 5) * 4.4, R - 6 - rng() * 4]);
  for (const [a, d] of brazierSpots) {
    const [x, z] = at(a, d);
    if (!place(taken, network, x, z, 1.6, 4.0)) continue;
    solid.add(parts.brazier, x, cy, z, rng() * 6.28, 1, 1, 1, 1);
    glow.add(parts.brazierGlow, x, cy, z, 0, 1, 1, 1, 1);
  }
}

/**
 * A HAMLET: the same pieces, a tenth of the parts list.
 *
 * Deliberately not a smaller Encampment. It has no wall — a fence arc on the
 * weather side and nothing else — because the thing that makes the start town
 * feel like a stronghold is that the others are not one.
 */
function buildHamlet(
  solid: Accum, glow: Accum, parts: TownParts, town: TownInfo,
  network: RoadNetwork, rng: () => number,
): void {
  const { x: cx, z: cz, y: cy, radius: R, gateAngle } = town;
  const taken: Spot[] = [];
  const at = (ang: number, dist: number): [number, number] =>
    [cx + Math.sin(ang) * dist, cz + Math.cos(ang) * dist];

  // The well is the centre of a hamlet the way a fire is the centre of a camp.
  const [wx, wz] = at(gateAngle + Math.PI / 2, 4.2);
  solid.add(parts.well, wx, cy, wz, rng() * 6.28, 1, 1, 1, 1);
  taken.push({ x: wx, z: wz, r: 3 });

  for (let k = 0; k < 4; k++) {
    const a = gateAngle + Math.PI * 0.55 + (k / 4) * Math.PI * 0.9 + (rng() - 0.5) * 0.2;
    const [x, z] = at(a, R - 5.5 - rng() * 3);
    if (!place(taken, network, x, z, 4.4, 7)) continue;
    solid.add(parts.huts[k % parts.huts.length], x, cy, z, Math.atan2(wx - x, wz - z), 1, 1, 1, 1);
  }
  for (let k = 0; k < 3; k++) {
    const a = gateAngle - 0.5 - (k / 3) * 1.5;
    const [x, z] = at(a, R - 6 - rng() * 3);
    if (!place(taken, network, x, z, 3.2, 6)) continue;
    solid.add(k === 1 ? parts.bell : parts.tents[k % parts.tents.length],
      x, cy, z, a + Math.PI / 2, 1, 1, 1, 1);
  }
  // A fence arc on the side away from the road, and a paddock cart.
  const fenceLen = 15 * V;
  const arc = Math.round((Math.PI * 0.7 * R) / fenceLen);
  for (let i = 0; i < arc; i++) {
    const a = gateAngle + Math.PI * 0.65 + (i / arc) * Math.PI * 0.7;
    const [x, z] = at(a, R - 1.2);
    solid.add(parts.fence, x, cy, z, a + Math.PI / 2, 1, 1, 1, 1);
  }
  for (let k = 0; k < 14; k++) {
    const a = rng() * Math.PI * 2;
    const [x, z] = at(a, 4 + rng() * (R - 6));
    const tpl = k % 3 === 0 ? parts.crateS : k % 3 === 1 ? parts.barrel : parts.woodpile;
    if (!place(taken, network, x, z, 1.4, 4.0)) continue;
    solid.add(tpl, x, cy, z, rng() * 6.28, 1, 1, 1, 1);
  }
  {
    const [x, z] = at(gateAngle - 0.5, R - 7);
    if (place(taken, network, x, z, 3, 4.6)) {
      solid.add(parts.cartOpen, x, cy, z, gateAngle, 1, 1, 1, 1);
    }
  }
  for (let k = 0; k < 3; k++) {
    const a = gateAngle + 0.4 + k * 2.1;
    const [x, z] = at(a, R - 4.5);
    if (!place(taken, network, x, z, 1.6, 4.0)) continue;
    solid.add(parts.brazier, x, cy, z, 0, 1, 1, 1, 1);
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
  solid: Accum, glow: Accum, parts: TownParts, road: Road, rng: () => number,
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
    solid.add(parts.lamp, x, at.y, z, yaw, 1, 1, 1, 1);
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
      solid.add(
        parts.fence,
        at.x - at.dz * fside * off, at.y, at.z + at.dx * fside * off,
        Math.atan2(at.dx, at.dz), 1, 1, 1, 1,
      );
    }
    s += runs * fenceLen + 40 + rng() * 70;
  }

  // Fingerposts: one at each end that names where the road goes, set back from
  // the town so it is read on the approach rather than at the gate.
  const label = (id: string): string =>
    SITES.find((q) => q.id === id)?.sign ?? JUNCTION_SIGN;
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
    solid.add(parts.post, x, at.y, z, 0, 1, 1, 1, 1);
    solid.add(
      signArm(sign, SIGN_V), x, at.y + 3.4, z,
      Math.atan2(at.dx * dir, at.dz * dir), 1, 1, 1, 1,
    );
  }
}
