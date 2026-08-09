/**
 * ROADS — the carved corridor between towns.
 *
 * A road here is not a texture painted on the ground. It is three things that
 * have to agree, and this file owns all three so they cannot drift:
 *
 *   1. a ROUTE, laid out once at world creation by walking the height field and
 *      preferring level ground (`routeRoad`);
 *   2. an ELEVATION PROFILE for that route — smoothed, slope-limited, and
 *      lifted clear of the water wherever it crosses it (`profileRoad`), which
 *      is what turns a crossing into a bridge;
 *   3. a HEIGHT FIELD (`RoadNetwork`, which implements `RoadField` from
 *      terrain.ts) that folds both back into the terrain, so collision, the
 *      mesher, beasts, enemies and the camera all see the same road for free.
 *
 * WHY THE DECK IS CONTINUOUS AND THE REST OF THE WORLD IS NOT.
 *
 * `Terrain.getHeight` floors the continuous height, so every ledge in this world
 * is a whole unit or more, and `MAX_STEP_UP` (0.5, player/index.ts) refuses all
 * of them — hills are jumped, deliberately. A road that behaved the same way
 * would be a staircase you cannot walk up, which is the opposite of what a road
 * is for. So inside the carriageway, and only there, `getHeight` hands back the
 * SMOOTH deck height instead of the stepped column.
 *
 * That would just move the problem to the kerb — a smooth deck beside a stepped
 * shoulder is a step wherever the two differ — so three things are arranged to
 * meet exactly:
 *
 *   - the carve levels the shoulder to `deck + 0.5`, which floors to
 *     `round(deck)`: never more than half a unit from the deck, in either
 *     direction, anywhere along the road;
 *   - between `DECK_HALF` and `DECK_EDGE - SHOULDER_IN` the walking surface
 *     RAMPS from the deck to `round(deck)` and then holds it out to the rim, on
 *     exactly the run over which the carve raises the ground to the same
 *     height, so the two meet at the verge with no step at all;
 *   - the ribbon mesh (see town-parts.ts `buildRoadRibbon`) is drawn on exactly
 *     that surface, out to exactly that edge, so what you see is what you stand
 *     on and the ribbon can be neither buried nor left floating.
 *
 * Measured on the finished world (seed 1337), by sampling `world.getHeight`
 * every 0.25 units along each deck polyline — see the `roads` block of the
 * `__dbgTowns()` probe in main.ts, which is where that number comes from:
 *
 *     camp-junction        72 units   maxStep 0.018   maxGrade 0.100
 *     junction-redbriar   174 units   maxStep 0.025   maxGrade 0.102
 *     junction-stonewatch 144 units   maxStep 0.025   maxGrade 0.102
 *
 * (The camp road was 0.015 / 0.088 before `profileRoad` grew its level HOLD at
 * the town ends — see there. Holding a deck flat across a footprint and then
 * decaying the correction costs a little grade and buys a settlement with no
 * terrace running down its high street; MAX_STEP_UP is still twenty-eight times
 * the largest step on the network.)
 *
 * MAX_STEP_UP is 0.5, so the largest rise anywhere on the network is a twentieth
 * of what the hero can walk over. Driven for real rather than only sampled: from
 * the spawn, holding W with no jumping covers the 34 units to the Encampment's
 * footprint at a steady 1.6 units per 250 ms and is never once blocked, where
 * the same walk over open ground (`towns=0`) stops dead against a terrace after
 * twelve.
 */
import { Terrain, WATER_LEVEL, smoothstep, type RoadField } from './terrain';
import { mulberry32 } from './noise';
import { MAX_CARVE_BLEND, ROAD_PROFILE, type PathProfile } from './path-profile';

// ---------------------------------------------------------------------------
// Corridor geometry
// ---------------------------------------------------------------------------

/**
 * The cart road's own numbers, for the handful of callers that genuinely mean
 * "the road" rather than "whatever path is here" — the lab stage, which builds
 * one by hand, and the probes.
 *
 * EVERY PLACER USES `edgeDistanceTo` INSTEAD. See `RoadClearance`: with more
 * than one profile in the world, "five units from a centreline" is a different
 * amount of road depending on which path answered, and a clearance written that
 * way silently shrinks or grows with the path it lands beside.
 */
export const DECK_HALF = ROAD_PROFILE.deckHalf;
export const DECK_EDGE = ROAD_PROFILE.deckEdge;

/**
 * Widest radius any query here can care about.
 *
 * A bound over EVERY profile rather than a max over the network, deliberately:
 * this sizes the spatial index's catchment and therefore the length of the
 * bucket scan on the collision hot path, and a per-network max would make that
 * scan grow the day somebody authors a wide path. See `MAX_CARVE_BLEND`.
 */
const REACH = MAX_CARVE_BLEND;

/**
 * Spacing of the resampled deck polyline, world units.
 *
 * Three is a compromise between two costs that pull opposite ways. Shorter
 * segments track a bend more closely but put more of them in every spatial-grid
 * cell, and the grid scan is on the collision hot path; longer ones cut the
 * corner (a 3-unit chord across the tightest bend the router can make, ~24 units
 * of radius, sags 0.05 units — invisible) but coarsen the ribbon. 3 also happens
 * to be one lamp post every seven segments, which is how the furniture is
 * spaced.
 */
const SEG_LEN = 3;
/** Spatial grid cell, world units. See `buildIndex` for why it is not bigger. */
const CELL = 8;
/** Sampling pitch of `spanDistanceTo`. See there for the error it costs. */
const SPAN_STEP = 0.35;

/**
 * THE FOUR NUMBERS THAT SHARE ONE BAND, and where they went.
 *
 * `CARVE_INSET`, `SHOULDER_IN`, `XS` and `RIM_GUARD` used to be module
 * constants here and in town-parts.ts, and all four describe the same run of
 * ground: the band between the flat carriageway and the levelled shoulder. Every
 * sample of issue #15 lived in that band while two of the four disagreed about
 * where it ended — the carve reached `round(deck)` 0.8 inside the rim while the
 * surface went on ramping to it, so over the last 0.8 of every verge the terrain
 * column stood at shoulder height with the ribbon still below it: a green step
 * face poking up through the gravel, along both sides of the whole network.
 * Measured end to end on seed 1337 with `bun tools/test-road.mjs`, which sweeps
 * the cross-section rim to rim: 300 of 5283 samples had terrain drawn over the
 * ribbon by up to 0.929, and 0 of 5295 do now.
 *
 * They are now `carveInset` / `shoulderIn` / `xs` / `rimGuard` on `PathProfile`
 * (path-profile.ts), DERIVED TOGETHER from the path's width rather than
 * authored apart — which is the whole point of issue #142's profile: four
 * independent knobs is four ways to reopen #15.
 *
 * WHERE AN ARM STOPS AND THE FORK BEGINS.
 *
 * A junction used to be nothing at all: three roads whose polylines happened to
 * end on the same node, each drawing its own ten-unit ribbon over the same
 * ground. Where they overlap — and they overlap for as long as their centrelines
 * are under two carriageways apart, measured on seed 1337 the first ELEVEN units
 * out of the node — you are looking at two or three gravel slabs stacked on one
 * another, each ending in a square cross-section because that is what a road end
 * is. Issue #45 is a photograph of exactly that: a rectangle with two
 * right-angled corners lying across the middle of a bend.
 *
 * So each arm's ribbon now starts here rather than at the node, and one APRON is
 * drawn over what is left (`buildJunctionApron`, town-parts.ts). 11 comes from
 * the measured geometry rather than from taste: the arms leave at 48, 134 and
 * 241 degrees and their separation grows about a unit per unit of arc — 4.00 at
 * arc 4, 7.98 at 8, 11.96 at 12 — so two ribbons stop overlapping at a
 * separation of 2 * DECK_EDGE = 10, and 11 clears that with a unit to spare.
 *
 * NOTHING IN THE HEIGHT FIELD KNOWS ABOUT THIS, and the first version that made
 * it a disc there is why the point is worth making. The apron is bounded by the
 * arms' own kerb lines, so every square unit of it is already inside a corridor
 * one of them carves — it needs no earthworks of its own, and giving it some was
 * actively wrong: a disc centred on the node sinks the ground by `carveAt`'s
 * 0.62 in every direction, including the wedges BETWEEN the arms that the apron
 * does not cover, and captured, each of those wedges was a one-unit trench with
 * the apron's skirt standing in it. The three arms were already levelled dead
 * flat across the node by `JUNCTION_HOLD` (towns.ts) before any of this; the
 * junction is a drawing problem and it is fixed where the drawing is.
 *
 * The radius itself is `PathProfile.apronR` — `deckEdge + 6`, so it grows and
 * shrinks with the arms that meet on the node.
 */

/** A fork: the node three arms grow out of. Geometry only — see above. */
export interface Junction {
  x: number;
  z: number;
  /** Deck height, which every arm anchored to. */
  y: number;
  /** The arms' profile, which sets the apron's radius. */
  profile: PathProfile;
}

/**
 * The roles a query can ask for, as a bitmask. One per flag on `PathRoles`.
 * `const enum` is deliberate: these are compiled away to literals, so the test
 * in the bucket scan is a mask and a compare.
 */
const enum Role {
  Surface = 1,
  Built = 2,
  Foliage = 4,
  Wear = 8,
}
/** The roles, in index order — one spatial grid each. See `grids`. */
const ROLES = [Role.Surface, Role.Built, Role.Foliage, Role.Wear];
/** Role bit -> its slot in `ROLES`, so `nearest` needs no search. */
const ROLE_SLOT: Record<number, number> = {
  [Role.Surface]: 0, [Role.Built]: 1, [Role.Foliage]: 2, [Role.Wear]: 3,
};

const cellKey = (cx: number, cz: number): number => cx * 4194304 + cz;

// ---------------------------------------------------------------------------

export interface RoadSample {
  x: number;
  z: number;
  /** Deck height (continuous). */
  y: number;
  /**
   * True where the natural ground under this sample is below the waterline, so
   * the deck is a BRIDGE: the earthworks are switched off (a lake bed must stay
   * a lake bed, and the water mesh is built from the same heights) and the
   * furniture pass puts piers and railings here instead of lamps.
   */
  bridge: boolean;
}

/**
 * THE ROAD, AS EVERY PLACER SEES IT.
 *
 * One interface, one implementation (`RoadNetwork`), and the rule that goes
 * with it: ANYTHING THAT PUTS AN OBJECT ON THE GROUND ASKS THIS, and nothing
 * re-derives "am I near a road" from a remembered bearing, a town's gate angle
 * or the shape of the terrain.
 *
 * That rule is written down because the project has now shipped the same bug
 * four times in different clothes. The order is fixed and it is not the
 * intuitive one: the towns are sited and the roads are ROUTED AND CARVED at
 * world creation (`planSettlements`, before `terrain.roads` is set), and
 * everything else — the town's own furniture, the streamed chunk props, the
 * fences that line the road — is placed AFTERWARDS, against a terrain that
 * already has the corridor in it. A placer that consults only the height field
 * is therefore describing a world that exists, but it is not asking the
 * question it means to ask: "is there a road here" is a fact about the
 * NETWORK, not about the ground, because the ground beside a carriageway and
 * the ground under it are levelled to within half a unit of each other on
 * purpose (see the header above).
 *
 * TWO SHAPES AND TWO AUDIENCES, which is four queries.
 *
 * The shapes: a POINT (a tussock, a boulder, a barrel) and a RUN (a fence
 * panel, a wall span, anything laid end to end — a 4.2-unit panel whose
 * midpoint clears the road by six units can still be lying flat across it).
 *
 * The audiences are the part issue #142 added, and they are not the same
 * question. A thing that is BUILT — a hut, a lamp, a fence, a person — must
 * keep off a carriageway. A thing that is GROWN must keep off every path there
 * is, including a settlement's own beaten tracks, because nothing in this world
 * is walked bare by feet and then has a hedge come up through it. And a track
 * must NOT refuse what is built beside it: the camp's tracks were derived from
 * where its huts and tents are, so a track that pushed them away would erase
 * its own reason for existing. See `PathRoles`.
 *
 *  - `edgeDistanceTo` / `spanEdgeDistanceTo` — foliage. Every path.
 *  - `builtEdgeDistanceTo` / `spanBuiltEdgeDistanceTo` — built things. Only
 *    paths whose profile refuses them.
 *
 * FROM THE RIM, NOT FROM THE CENTRELINE, and that is issue #142's doing. Every
 * caller used to write `DECK_EDGE + <its own margin>` and compare against
 * `distanceTo`, which is correct only while there is exactly one width in the
 * world. With two, "5.4 units from a centreline" is inside the rim of a cart
 * road and four units off the side of a footpath — the same constant meaning
 * two different clearances, which is the shape of every bug this interface
 * exists to prevent. So the query subtracts the answering path's own
 * `deckEdge` and a caller states only the margin it actually wants:
 * `edgeDistanceTo(x, z) < 0.9` is "within 0.9 of the rim of whatever is here".
 *
 * `distanceTo` survives for the two questions that really are about the
 * centreline — the router's own avoidance, and the probes.
 */
export interface RoadClearance {
  /**
   * How far (x, z) lies OUTSIDE the rim of the nearest path of ANY kind, or
   * Infinity where there is none. Negative on the path itself, zero at the rim.
   */
  edgeDistanceTo(x: number, z: number): number;
  /** The same for the segment (ax,az)-(bx,bz): its nearest approach to a rim. */
  spanEdgeDistanceTo(ax: number, az: number, bx: number, bz: number): number;
  /** The same, over only the paths that refuse BUILT things. */
  builtEdgeDistanceTo(x: number, z: number): number;
  spanBuiltEdgeDistanceTo(ax: number, az: number, bx: number, bz: number): number;
  /** Distance from (x, z) to the nearest carriageway centreline, or Infinity. */
  distanceTo(x: number, z: number): number;
}

export interface Road {
  id: string;
  /** Town or junction ids at each end — what a signpost names. */
  fromId: string;
  toId: string;
  /** What KIND of path this is — width, carve, palette. See path-profile.ts. */
  profile: PathProfile;
  /**
   * How hard THIS path is walked, 0..1 — what `Terrain.trampleAt` reads as the
   * colour of packed dirt. Ignored unless the profile claims the `wears` role.
   *
   * Per path and not per profile because two tracks of one kind are walked
   * different amounts: the camp's thoroughfare is 1.0 and its tent lines 0.88,
   * which is `WEAR` in towns.ts choosing against what stands at the end of each.
   */
  wear?: number;
  pts: RoadSample[];
  /**
   * WHERE THE BUILT CARRIAGEWAY ENDS, as two inward half-planes:
   * [px, pz, nx, nz] for the start then the same four for the end, the corridor
   * living where `dot(q - p, n) >= 0`.
   *
   * A road has a ROUTE and it has a CARRIAGEWAY, and they are not the same
   * thing. `pts` is the route — it is what every placer means by "is there a
   * road here" — and this says how much of the route is actually surfaced.
   *
   * `build()` fills both from the end nodes even when nothing is trimmed,
   * because a terminal needs a plane anyway. `nearest` clamps its segment
   * parameter to [0, 1], so past an end node the distance is measured RADIALLY
   * and the corridor closes in a dome that reaches DECK_HALF past the last
   * sample at full sink depth — while `buildRoadRibbon` emits quads only
   * BETWEEN rings and so draws nothing over it. That uncovered half-round pit
   * was the "missing blocks" at the middle of the Encampment, and the same one
   * sat at the fork and at both hamlet centres. A plane closes the corridor
   * with a FLAT cross-section, which one ribbon ring covers exactly.
   *
   * Set before `build()` to move an end; `setTrimStart`/`setTrimEnd` do that.
   */
  trim: Float32Array;
}

/**
 * Point a road's start (or end) plane at (px, pz) facing (nx, nz) INWARD.
 *
 * Separate setters rather than a raw array write so the slot order — start
 * first, end second — lives in one place.
 */
export function setTrimStart(r: Road, px: number, pz: number, nx: number, nz: number): void {
  r.trim[0] = px; r.trim[1] = pz; r.trim[2] = nx; r.trim[3] = nz;
}
export function setTrimEnd(r: Road, px: number, pz: number, nx: number, nz: number): void {
  r.trim[4] = px; r.trim[5] = pz; r.trim[6] = nx; r.trim[7] = nz;
}

/**
 * The samples that carry a BUILT carriageway, with the ends interpolated onto
 * the trim planes.
 *
 * Lives here rather than in the ribbon builder so the drawing and the carving
 * cannot disagree about where a road stops — the two halves of the same bug
 * this whole mechanism exists to close.
 */
export function builtDeck(r: Road): RoadSample[] {
  const out: RoadSample[] = [];
  const inside = (p: RoadSample, o: number): number =>
    (p.x - r.trim[o]) * r.trim[o + 2] + (p.z - r.trim[o + 1]) * r.trim[o + 3];
  const lerp = (a: RoadSample, b: RoadSample, t: number): RoadSample => ({
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    y: a.y + (b.y - a.y) * t,
    // A cut end inherits the span flag of the sample it was cut from: half a
    // bridge is not a thing, and the abutment argument in `build` applies here.
    bridge: a.bridge || b.bridge,
  });
  for (let i = 0; i < r.pts.length; i++) {
    const p = r.pts[i];
    const in0 = inside(p, 0) >= 0;
    const in1 = inside(p, 4) >= 0;
    if (in0 && in1) {
      // Interpolate a terminal sample where the previous one was outside.
      if (i > 0 && out.length === 0) {
        const q = r.pts[i - 1];
        const a = inside(q, 0);
        const b = inside(p, 0);
        if (b !== a) out.push(lerp(q, p, (0 - a) / (b - a)));
      }
      out.push(p);
    } else if (out.length > 0 && !in1) {
      const q = r.pts[i - 1];
      const a = inside(q, 4);
      const b = inside(p, 4);
      if (b !== a) out.push(lerp(q, p, (0 - a) / (b - a)));
      break;
    }
  }
  return out;
}

/** Total length of a road's deck polyline, world units. */
export function roadLength(r: Road): number {
  let d = 0;
  for (let i = 1; i < r.pts.length; i++) {
    d += Math.hypot(r.pts[i].x - r.pts[i - 1].x, r.pts[i].z - r.pts[i - 1].z);
  }
  return d;
}

// ---------------------------------------------------------------------------
// The height field
// ---------------------------------------------------------------------------

/**
 * Every road in the world as one queryable corridor.
 *
 * Segments are flat `Float32Array`s and the spatial index is a `Map` of
 * `Int32Array`s for the usual reason: `carveAt` runs inside `heightCont`, which
 * the mesher calls 1156 times per chunk and the player calls a few hundred times
 * a frame, so neither query may allocate or chase objects.
 */
export class RoadNetwork implements RoadField, RoadClearance {
  readonly roads: Road[] = [];
  /**
   * The forks, for the ribbon builder and for nothing else here — a junction is
   * geometry, not a height field. See APRON_R.
   */
  readonly junctions: Junction[] = [];
  /**
   * True while every path in the network has the same rim.
   *
   * WHICH RANKING `nearest` USES, and it is not a micro-optimisation — it is
   * how the change that added profiles proves it moved no pixel. With one width
   * "nearest centreline" and "nearest rim" are the same ordering, so the scan
   * compares squared distances exactly as it always did and takes no square
   * root per candidate. The moment a second width exists the two orderings
   * differ and the penetration one is the correct answer (see `nearest`), so
   * the scan pays a `sqrt` per bucket entry — on the paths that have one.
   */
  private uniformEdge = true;
  /**
   * Which ROLE each path claims, as a bitmask per road — see `Role`.
   *
   * A mask and not four arrays because the scan tests it once per bucket entry
   * on the collision hot path, and because a role is a property of the profile
   * rather than of the segment: the whole road claims it or none of it does.
   */
  private roadRole = new Uint8Array(0);
  /** [ax, az, ay, bx, bz, by] per segment. */
  private seg = new Float32Array(0);
  private segBridge = new Uint8Array(0);
  /**
   * Which road owns each segment, and a one-entry-per-road cache of "is this
   * query point past that road's trim planes".
   *
   * PER ROAD, NOT PER SEGMENT, and that is the whole subtlety. Skipping only
   * the terminal segment does not work and fails SILENTLY: a point a tenth of a
   * unit past the end node is still ~3 units from the segment before it, well
   * inside DECK_EDGE, so the scan falls through and answers with a full-depth
   * carve and a deck height anyway. The verdict has to cover every segment of
   * the road it belongs to.
   *
   * `clipStamp` holds the query id that last decided a road, so the two dot
   * products run at most once per road per query — one road almost everywhere,
   * three only at the fork. Float64 and not Int32 so a long session cannot wrap
   * the counter into a stale-cache hit.
   *
   * FREE at this resolution, measured on the worst case: walking the trunk road
   * with `?perf=1&fps=0`, so every streamed chunk carries the corridor, taking
   * the `world` section over the 97 frames that actually built a chunk. Three
   * interleaved runs each way — before 11.57 / 12.04 / 10.02 ms, after 10.89 /
   * 10.72 / 10.59. The run-to-run spread is larger than the difference.
   */
  private segRoad = new Uint8Array(0);
  private clipStamp = new Float64Array(0);
  private clipOut = new Uint8Array(0);
  private queryId = 0;
  /**
   * ONE SPATIAL INDEX PER ROLE, and the reason is the collision hot path.
   *
   * A settlement's beaten tracks are paths now (issue #142), and there are
   * twenty-three of them against three roads — so a single grid would put
   * twenty extra segments in every bucket inside a town, and `carveAt`, which
   * runs inside `heightCont` a thousand times a chunk and hundreds of times a
   * frame, would walk and reject all of them to answer a question no track can
   * contribute to. Bucketing per role means the surface query scans exactly
   * what it scanned before a track existed.
   *
   * Indexed by `ROLES[i]`, and the bounds are per role for the same reason: a
   * query outside every carriageway is answered by one compare, whether or not
   * a town somewhere has tracks in it.
   */
  private grids: Array<Map<number, Int32Array>> = ROLES.map(() => new Map());
  private bounds = new Float64Array(ROLES.length * 4);

  /** Filled by `carveAt`; see RoadField. */
  carveTarget = 0;
  /** Scratch for `nearest`. Never read from outside this class. */
  private nDist = 0;
  private nDeck = 0;
  private nBridge = false;
  private nProfile: PathProfile = ROAD_PROFILE;

  add(road: Road): void {
    if (road.pts.length >= 2) this.roads.push(road);
  }

  /** Register a fork, so the arms know where to start. */
  addJunction(x: number, z: number, y: number, profile: PathProfile): void {
    this.junctions.push({ x, z, y, profile });
  }

  /** Flatten every road into segments and index them. Call once, after `add`. */
  build(): void {
    let n = 0;
    for (const r of this.roads) n += r.pts.length - 1;
    // PER NETWORK AND NOT PER ROLE, deliberately conservative: a grid holding
    // one width ranks the same either way, so the only cost of deciding this
    // once is a `sqrt` per candidate in a grid that did not need it.
    this.uniformEdge = this.roads.every(
      (r) => r.profile.deckEdge === this.roads[0].profile.deckEdge,
    );
    this.seg = new Float32Array(n * 6);
    this.segBridge = new Uint8Array(n);
    this.segRoad = new Uint8Array(n);
    this.roadRole = new Uint8Array(this.roads.length);
    for (let i = 0; i < this.roads.length; i++) {
      const q = this.roads[i].profile.roles;
      this.roadRole[i] = (q.surface ? Role.Surface : 0)
        | (q.refusesBuilt ? Role.Built : 0)
        | (q.refusesFoliage ? Role.Foliage : 0)
        | (q.wears ? Role.Wear : 0);
    }
    this.clipStamp = new Float64Array(this.roads.length);
    this.clipOut = new Uint8Array(this.roads.length);
    let k = 0;
    for (let ri = 0; ri < this.roads.length; ri++) {
      const r = this.roads[ri];
      // A road that nobody trimmed still gets planes, square to its own ends.
      // The default is not "no clipping": it is what turns the terminal dome
      // into a flat cross-section. See Road.trim.
      if (r.trim[2] === 0 && r.trim[3] === 0) {
        const a = r.pts[0];
        const b = r.pts[1];
        const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        setTrimStart(r, a.x, a.z, (b.x - a.x) / l, (b.z - a.z) / l);
      }
      if (r.trim[6] === 0 && r.trim[7] === 0) {
        const a = r.pts[r.pts.length - 1];
        const b = r.pts[r.pts.length - 2];
        const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        setTrimEnd(r, a.x, a.z, (b.x - a.x) / l, (b.z - a.z) / l);
      }
      for (let i = 1; i < r.pts.length; i++) {
        this.segRoad[k] = ri;
        const a = r.pts[i - 1];
        const b = r.pts[i];
        const o = k * 6;
        this.seg[o] = a.x; this.seg[o + 1] = a.z; this.seg[o + 2] = a.y;
        this.seg[o + 3] = b.x; this.seg[o + 4] = b.z; this.seg[o + 5] = b.y;
        // Either end being wet makes the whole segment a span: an abutment that
        // half-carves is a notch in the bank, and three units of extra bridge is
        // cheaper to look at than that.
        this.segBridge[k] = a.bridge || b.bridge ? 1 : 0;
        k++;
      }
    }
    this.buildIndex(k);
  }

  /**
   * Bucket segments into CELL-sized cells, each holding every segment within
   * REACH of it.
   *
   * CELL is 8 and REACH is 13, so a cell's catchment is 34x34 units and a road
   * running straight through it contributes about a dozen 3-unit segments. That
   * is the number `nearest` scans, and it is why CELL is not larger: at 16 the
   * catchment is 42x42 and the scan half again as long, for a quarter of the
   * buckets. The whole network is a few hundred segments, so the memory either
   * way is noise.
   */
  private buildIndex(count: number): void {
    this.bounds.fill(0);
    for (let g = 0; g < ROLES.length; g++) {
      this.bounds[g * 4] = Infinity;
      this.bounds[g * 4 + 1] = -Infinity;
      this.bounds[g * 4 + 2] = Infinity;
      this.bounds[g * 4 + 3] = -Infinity;
    }
    for (let g = 0; g < ROLES.length; g++) {
      const role = ROLES[g];
      const lists = new Map<number, number[]>();
      for (let i = 0; i < count; i++) {
        if ((this.roadRole[this.segRoad[i]] & role) === 0) continue;
        const o = i * 6;
        const x0 = Math.min(this.seg[o], this.seg[o + 3]) - REACH;
        const x1 = Math.max(this.seg[o], this.seg[o + 3]) + REACH;
        const z0 = Math.min(this.seg[o + 1], this.seg[o + 4]) - REACH;
        const z1 = Math.max(this.seg[o + 1], this.seg[o + 4]) + REACH;
        if (x0 < this.bounds[g * 4]) this.bounds[g * 4] = x0;
        if (x1 > this.bounds[g * 4 + 1]) this.bounds[g * 4 + 1] = x1;
        if (z0 < this.bounds[g * 4 + 2]) this.bounds[g * 4 + 2] = z0;
        if (z1 > this.bounds[g * 4 + 3]) this.bounds[g * 4 + 3] = z1;
        for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
          for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
            const key = cellKey(cx, cz);
            let l = lists.get(key);
            if (l === undefined) { l = []; lists.set(key, l); }
            l.push(i);
          }
        }
      }
      const grid = this.grids[g];
      grid.clear();
      for (const [key, l] of lists) grid.set(key, Int32Array.from(l));
    }
  }

  /**
   * Nearest path to (x, z), into `nDist` / `nDeck` / `nBridge` / `nProfile`.
   * False when nothing is within REACH — the common case, answered by a bounds
   * test and one failed `Map.get`.
   *
   * NEAREST BY PENETRATION, NOT BY CENTRELINE — issue #142, and the one genuine
   * correctness trap in the whole feature. A 2-unit footpath running 3 units
   * from a 10-unit highway is the closest CENTRELINE to a column that is under
   * the highway, so ranking by `d` hands back the footpath's deck for ground
   * the highway owns: the walking surface jumps a whole deck's worth across a
   * line nothing is drawn on, which is the same shape as the fork bug the header
   * of this file documents. `d - deckEdge` asks "which rim am I furthest
   * inside", which is the question every caller actually means.
   *
   * While one width exists the two orderings are identical and the scan stays
   * on squared distances — see `uniformEdge`.
   */
  private nearest(
    x: number, z: number, role: number, built: boolean, insetScale = 0,
  ): boolean {
    const g = ROLE_SLOT[role];
    const b = g * 4;
    if (x < this.bounds[b] || x > this.bounds[b + 1]) return false;
    if (z < this.bounds[b + 2] || z > this.bounds[b + 3]) return false;
    const bucket = this.grids[g].get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (bucket === undefined) return false;
    const uniform = this.uniformEdge;
    let best = Infinity;
    let bestD2 = Infinity;
    let deck = 0;
    let bridge = 0;
    let profile: PathProfile | null = null;
    const s = this.seg;
    if (built) this.queryId++;
    for (let i = 0; i < bucket.length; i++) {
      // THE ROLE IS THE INDEX, so there is nothing to filter here: this bucket
      // holds only paths that claim it. That is what keeps a painted track out
      // of the height field — a camp thoroughfare is 8.8 units wide against the
      // cart road's 10, so near a gate it can win the penetration race, and
      // since it carves nothing `surfaceAt` would answer with natural ground
      // where the deck is. See `PathRoles` and `grids`.
      const ri = this.segRoad[bucket[i]];
      const rp = this.roads[ri].profile;
      if (built) {
        if (this.clipStamp[ri] !== this.queryId) {
          this.clipStamp[ri] = this.queryId;
          const t = this.roads[ri].trim;
          // The inset is the PATH'S OWN `carveInset`, so a narrow path stops its
          // earthworks the same fraction of a cell inside its terminal plane
          // that a wide one does. `insetScale` is 1 for the carve and 0 for the
          // surface, which is the distinction the two callers actually draw.
          const inset = rp.carveInset * insetScale;
          const p0 = (x - t[0]) * t[2] + (z - t[1]) * t[3];
          const p1 = (x - t[4]) * t[6] + (z - t[5]) * t[7];
          this.clipOut[ri] = p0 >= inset && p1 >= inset ? 0 : 1;
        }
        if (this.clipOut[ri] === 1) continue;
      }
      const o = bucket[i] * 6;
      const ax = s[o];
      const az = s[o + 1];
      const dx = s[o + 3] - ax;
      const dz = s[o + 4] - az;
      const len2 = dx * dx + dz * dz;
      let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const px = ax + dx * t - x;
      const pz = az + dz * t - z;
      const d2 = px * px + pz * pz;
      const rank = uniform ? d2 : Math.sqrt(d2) - rp.deckEdge;
      if (rank < best) {
        best = rank;
        bestD2 = d2;
        deck = s[o + 2] + (s[o + 5] - s[o + 2]) * t;
        bridge = this.segBridge[bucket[i]];
        profile = rp;
      }
    }
    if (profile === null || bestD2 > REACH * REACH) return false;
    this.nDist = Math.sqrt(bestD2);
    this.nDeck = deck;
    this.nBridge = bridge === 1;
    this.nProfile = profile;
    return true;
  }

  /**
   * The walking surface at distance `d` from a centreline whose deck is `deck`.
   *
   * ONE function, called by `surfaceAt` (which is what the player stands on and
   * what the ribbon is drawn on) and by `carveAt` (which is what the terrain
   * column under it is cut to). They are the two halves of "what you see is what
   * you stand on" and they may not be two formulas that happen to agree.
   */
  private static surfaceOf(p: PathProfile, deck: number, d: number): number {
    if (d <= p.deckHalf) return deck;
    const t = (d - p.deckHalf) / (p.verge - p.shoulderIn);
    // Reaching the shoulder `shoulderIn` inside the rim and then holding it out
    // to the rim — see the band note above.
    return deck + (Math.round(deck) - deck) * (t > 1 ? 1 : t);
  }

  carveAt(x: number, z: number): number {
    // The path's own `carveInset`, not 0: the earthworks stop short of the
    // surface's own terminal plane.
    if (!this.nearest(x, z, Role.Surface, true, 1)) return 0;
    const prof = this.nProfile;
    // A profile that carves nothing leaves the ground exactly as it found it —
    // which is what makes a trodden trail the cheap case rather than a road with
    // its numbers turned down. See `PathCarve`.
    if (prof.carve === 'none') return 0;
    // A bridge span leaves the ground alone. Raising a lake bed to meet the deck
    // would drain the crossing, which is the one place the road is supposed to
    // be in the air.
    if (this.nBridge) return 0;
    const d = this.nDist;
    if (d >= prof.carveBlend) return 0;
    // THE GROUND IS CUT TO THE SURFACE DRAWN OVER IT, MINUS A SINK.
    //
    // Two things have to be true at once and they used to be arranged by two
    // separate formulas:
    //
    //   - the column may never stand ABOVE the walking surface, because the
    //     ribbon is drawn on that surface and a column over it is a block of
    //     grass standing up through the gravel;
    //   - the column has to REACH `round(deck)` by the ribbon's rim, because
    //     outside the rim that is what the walking surface is, and a step there
    //     is a step you cannot see.
    //
    // Cutting to `surfaceOf(d)` and sinking the result gives both by
    // construction. `floor` can only lower, so the first is free; at the rim the
    // sink has faded and the target is `round(deck)` — an integer, so `floor`
    // returns it exactly — which is the second.
    //
    // The version this replaces ramped a target of `deck - 0.62` to `deck + 0.5`
    // on a smoothstep while the surface ramped from `deck` to `round(deck)`
    // linearly. Those two curves cross: `floor(deck + 0.5)` reaches
    // `round(deck)` at about 91% of the ramp while the surface is still 0.036
    // short of it, and the ribbon's own chord between section vertices takes it
    // further down again. Measured on seed 1337, 107 of 5267 cross-road samples
    // had terrain drawn over the ribbon by up to 0.699 — the "ground clipping
    // through on to the road" of issue #15, and all of it in that band.
    //
    // The SINK is why the carriageway itself is not merely floored: a column
    // exactly at an integer deck would be coplanar with a ribbon 0.025 above it.
    // 0.62 puts the floored column strictly under the deck, never more than 1.62
    // below it, and entirely hidden by the ribbon and its skirt. Nothing walks
    // on the sunk part: inside the rim the walking surface is the deck.
    //
    // The epsilon is against the blend in `Terrain.heightCont` returning
    // 12.999999 for a target of 13 and flooring a whole unit low. It cannot
    // raise a floor: an integer plus a thousandth floors to that integer.
    this.carveTarget = RoadNetwork.surfaceOf(prof, this.nDeck, d) + 0.001
      - prof.sink * (1 - smoothstep(prof.deckHalf, prof.deckEdge - prof.shoulderIn, d));
    return 1 - smoothstep(prof.carveCore, prof.carveBlend, d);
  }

  surfaceAt(x: number, z: number, ground: number): number {
    if (!this.nearest(x, z, Role.Surface, true)) return ground;
    const d = this.nDist;
    const prof = this.nProfile;
    if (d >= prof.deckEdge) return ground;
    const deck = this.nDeck;
    // A bridge deck is flat all the way to its edge and then there is nothing:
    // step off the side and you are in the water, which is what a bridge with no
    // handrail collision means and what the railings are drawn to warn about.
    if (this.nBridge) return deck;
    return RoadNetwork.surfaceOf(prof, deck, d);
  }

  /**
   * Distance from (x, z) to the nearest carriageway centreline, or Infinity.
   * For the router's own avoidance and for the probes — a PLACER wants
   * `edgeDistanceTo`, which see.
   */
  distanceTo(x: number, z: number): number {
    // NOT clipped to the built carriageway, deliberately. A placer asking "is
    // there a road here" is asking about the ROUTE: the Encampment's
    // thoroughfare from its gate to the middle of camp is still a road you may
    // not pitch a tent on, even once no gravel is drawn along it. One polyline,
    // two questions — see Road.trim.
    return this.nearest(x, z, Role.Foliage, false) ? this.nDist : Infinity;
  }

  /**
   * How far (x, z) lies outside the RIM of the nearest path — negative on it,
   * zero at the edge of the drawn surface, Infinity where there is no path.
   *
   * THE QUERY EVERY PLACER ASKS, and the reason is in `RoadClearance`: a
   * clearance written against the centreline carries one path's width inside it
   * and means something different beside another. `distanceTo` and this differ
   * by `deckEdge`, which is exactly the part a caller should not have to know.
   */
  edgeDistanceTo(x: number, z: number): number {
    return this.nearest(x, z, Role.Foliage, false)
      ? this.nDist - this.nProfile.deckEdge : Infinity;
  }

  /**
   * The same, over only the paths that refuse BUILT things.
   *
   * A settlement's beaten track answers `edgeDistanceTo` and not this one, on
   * purpose: it is where the people walk BETWEEN the huts, derived from where
   * the huts are, so a builder that asked the foliage question would refuse to
   * place the very things the track points at. See `RoadClearance`.
   */
  builtEdgeDistanceTo(x: number, z: number): number {
    return this.nearest(x, z, Role.Built, false)
      ? this.nDist - this.nProfile.deckEdge : Infinity;
  }

  /**
   * HOW WALKED THE GROUND AT (x, z) IS, 0..1 — the colour of packed dirt.
   *
   * `Terrain.trampleAt` reads it, and it is the third of the three mechanisms
   * issue #142 folds together: this used to be `GroundPatch.paths`, a flat
   * segment array inside terrain.ts that no placer could see, which is why
   * grass grew straight down the middle of the Encampment.
   *
   * The falloff is the one it replaces, expressed in the profile's own terms:
   * full strength inside `deckHalf` and gone at `deckEdge`, which is exactly
   * what `1 - smoothstep(hw * 0.45, hw, d)` was. See `trackProfile`.
   *
   * A `columnInfo` query — chunk build, ~1156 columns a chunk — and never on
   * the collision path, the same budget `trampleAt` always had.
   */
  wearAt(x: number, z: number): number {
    const g = ROLE_SLOT[Role.Wear];
    const b = g * 4;
    if (x < this.bounds[b] || x > this.bounds[b + 1]) return 0;
    if (z < this.bounds[b + 2] || z > this.bounds[b + 3]) return 0;
    const bucket = this.grids[g].get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (bucket === undefined) return 0;
    // THE STRONGEST TRACK, NOT THE NEAREST ONE — its own scan rather than
    // `nearest`, and the difference is a real number rather than a nicety.
    // Tracks overlap where they leave a settlement's centre, and they are not
    // equally walked: the Encampment's thoroughfare is 1.0 and its tent lines
    // 0.88. Ranked by penetration, a column between the two takes whichever is
    // geometrically closer; the field this replaces took the max, and taking
    // the nearest instead moved 1.5 units of wear over a 14283-column sample of
    // the two settlements. Max is also cheaper here: no ranking, no `sqrt` per
    // candidate until the very end.
    const s = this.seg;
    let best = 0;
    for (let i = 0; i < bucket.length; i++) {
      const o = bucket[i] * 6;
      const ax = s[o];
      const az = s[o + 1];
      const dx = s[o + 3] - ax;
      const dz = s[o + 4] - az;
      const len2 = dx * dx + dz * dz;
      let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const px = ax + dx * t - x;
      const pz = az + dz * t - z;
      const road = this.roads[this.segRoad[bucket[i]]];
      const p = road.profile;
      const d2 = px * px + pz * pz;
      if (d2 >= p.deckEdge * p.deckEdge) continue;
      const w = (road.wear ?? 1)
        * (1 - smoothstep(p.deckHalf, p.deckEdge, Math.sqrt(d2)));
      if (w > best) best = w;
    }
    return best;
  }

  /**
   * Nearest approach of the SEGMENT (ax, az)-(bx, bz) to any carriageway
   * centreline, or Infinity when the whole run is clear of the network.
   *
   * THE RUN VERSION OF `edgeDistanceTo`, and it exists because a fence panel is
   * 4.2 units long. Asking the point query about a panel's midpoint says
   * nothing about where its ENDS are, and on the inside of a bend that is
   * exactly how panels end up lying flat across a carriageway their centres
   * clear by six units: measured on the finished world, two of the panels
   * `buildRoadFurniture` stamps had centres 1.41 and 3.88 units from a
   * centreline even though every one of them is offset 6.5 units from its own
   * road. See `FENCE_ROAD_CLEAR` in towns.ts.
   *
   * SAMPLED, not solved. Distance to a polyline is 1-Lipschitz, so a sample
   * every SPAN_STEP over-reports the true minimum by at most half a step —
   * under 0.18 at SPAN_STEP 0.35, which is inside the slack every caller's
   * clearance already carries. A closed-form segment-to-polyline distance would
   * have to sweep the spatial grid over the span's whole bounding box, which is
   * more code and more work for a query that runs a few dozen times at world
   * creation and never again.
   */
  spanEdgeDistanceTo(ax: number, az: number, bx: number, bz: number): number {
    return this.sweep(ax, az, bx, bz, false);
  }

  /** The run version of `builtEdgeDistanceTo`. What a fence bay asks. */
  spanBuiltEdgeDistanceTo(ax: number, az: number, bx: number, bz: number): number {
    return this.sweep(ax, az, bx, bz, true);
  }

  private sweep(
    ax: number, az: number, bx: number, bz: number, builtOnly: boolean,
  ): number {
    const dx = bx - ax;
    const dz = bz - az;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / SPAN_STEP));
    let best = Infinity;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const d = builtOnly
        ? this.builtEdgeDistanceTo(ax + dx * t, az + dz * t)
        : this.edgeDistanceTo(ax + dx * t, az + dz * t);
      if (d < best) best = d;
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * How much open water the straight line from A to B crosses, in world units.
 *
 * Shared by the router (which uses it to decide whether to bridge or go round)
 * and by the town planner (which uses it to put the waterside hamlet on the far
 * bank of a channel rather than on the far side of a lake). One function so the
 * two cannot disagree about what counts as a crossing.
 */
export function straightWetLength(
  terrain: Terrain, ax: number, az: number, bx: number, bz: number,
): number {
  const d = Math.hypot(bx - ax, bz - az);
  const steps = Math.max(1, Math.round(d / 2));
  let wet = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (terrain.heightCont(ax + (bx - ax) * t, az + (bz - az) * t) < WATER_LEVEL) {
      wet += d / steps;
    }
  }
  return wet;
}

/**
 * The widest crossing still worth bridging rather than driving around. Above it
 * the router pays an order of magnitude more per wet step and goes round.
 */
export const NECK_MAX = 40;

/**
 * HOW FAR APART TWO ROADS HAVE TO RUN TO READ AS TWO ROADS.
 *
 * `DECK_EDGE` is 5, so a carriageway is ten units of drawn, walked surface;
 * 18 between centrelines leaves eight units of ground down the middle, which is
 * enough for the verges, a lamp and the grass to come back. Below about twelve
 * the two ribbons touch and the pair reads as one wide, ragged apron rather
 * than as a fork.
 *
 * Measured on seed 1337, sample by sample out of the fork: the trunk and the
 * Stonewatch spur ran 0.63, 0.80, 0.91, 1.10, 1.53 and 1.94 units apart over
 * their first twenty. Two ten-unit ribbons on two different deck profiles,
 * drawn one over the other — which is what the report in issue #15 is a picture
 * of, and also where the walking surface stepped 0.801 against a MAX_STEP_UP of
 * 0.5, because `surfaceAt` answers with the nearest road and the nearest road
 * changes from column to column when they are a unit apart.
 *
 * It is `PathProfile.avoidR` (`2 * deckEdge + 8`) rather than a constant, so a
 * narrow path is allowed to run nearer another one than a cart road is — the
 * ground down the middle is what the number is about, and a footpath needs less
 * of it. 18 on the road, which is what shipped.
 */
/**
 * What a step pays for landing dead on an existing centreline.
 *
 * IT HAS TO BE BIG, and the reason is that the charge is LINEAR in a distance
 * the walk can only change 3 units at a time. A step's whole reward for moving
 * away is `AVOID_COST * SEG_LEN / AVOID_R`, i.e. a sixth of this number, and it
 * is paid against a turn charge of up to 1.68 and a climb term of 3.4 per unit.
 * So the intuitive values do nothing at all.
 *
 * Measured on seed 1337 as the closest the trunk and the Stonewatch spur come
 * to each other more than AVOID_FREE out of the fork, and how far out they are
 * finally a full corridor (10 units) apart:
 *
 *      cost   min sep    10 apart by
 *         3      1.10        24 units    (identical to no charge at all)
 *         7      1.10        24 units    (likewise — a sixth of 7 is 1.2)
 *        14      5.33        21 units
 *        30      4.64        21 units
 *        50     14.03        11 units
 *        70     14.03        11 units    (saturated)
 *
 * 50 is where the arms leave the fork as separate roads rather than as one
 * apron that narrows, and it is also the best `test-road.mjs` gets: the walking
 * surface's worst step across the fork goes 0.047 -> 0.034 and the terrain
 * poking through the ribbon 36 -> 22 samples. Above it nothing moves, because
 * the walk is already taking the widest bearing it has on every step that
 * matters.
 */
const AVOID_COST = 50;
/**
 * How much of an existing road, measured from the new route's own start, is
 * exempt. A fork IS a shared point; the roads only have to part company once
 * they are clear of it, and this is roughly the radius of the junction apron.
 */
const AVOID_FREE = 12;

/**
 * Walk from (ax, az) to (bx, bz) preferring level ground.
 *
 * A greedy stepped walk rather than a proper least-cost search, and that is a
 * deliberate ceiling on the ambition: an A* over the height field would give a
 * better road and would also have to be told how much it may spend, because the
 * field is defined everywhere and the search space is unbounded. What a road
 * actually needs is to LOOK like it followed the land, and a bearing search that
 * charges for climbing and for turning gives that in a few hundred height
 * queries — the whole network costs about as much as one chunk of terrain.
 *
 * The scoring is four terms: the climb (dominant — this is what makes the road
 * hug a contour), the turn away from the target (so it still arrives), a water
 * charge that is heavy enough to route around a lake but not so heavy that a
 * narrow neck is never crossed (crossing IS wanted occasionally; it is where the
 * bridges come from), and a charge for running alongside a road that already
 * exists — see `avoid`.
 */
export function routeRoad(
  terrain: Terrain, ax: number, az: number, bx: number, bz: number, seed: number,
  avoid: readonly RoadSample[][] = [],
  profile: PathProfile = ROAD_PROFILE,
): Array<{ x: number; z: number }> {
  const avoidR = profile.avoidR;
  // GO ROUND, OR BUILD A BRIDGE — decided once, up front, from how much water
  // the straight line actually crosses.
  //
  // A greedy walk cannot make this choice for itself, and both ways of trying
  // were measured on seed 1337. With a cheap per-step water charge (5.5) the
  // Redbriar road drove into a lake and stayed in it for a hundred units: once
  // the walk is on a flat bed, every wet candidate is level and every dry one
  // means climbing a bank, so the charge that was supposed to keep it out was
  // paid over and over to keep it in. With an expensive one (22) it never
  // entered water at all and the world had no bridges anywhere. Neither is a
  // tuning failure — a greedy step cannot know that going round costs two
  // hundred units, because it can only see three.
  //
  // So the decision is made where the information is. Sample the A-B line; if
  // the water on it is a NECK (under 34 units) the crossing is cheap and the
  // route takes it, which puts a bridge exactly where a road would really have
  // one. If it is a LAKE, the charge goes up by an order of magnitude and the
  // route goes round.
  //
  // A path that cannot BRIDGE is never in neck mode, whatever the crossing
  // looks like: bridges are the cart road's geometry and a footpath has none,
  // so its answer to water is always to go round. See `PathProfile.bridges`.
  const neck = profile.bridges
    && straightWetLength(terrain, ax, az, bx, bz) <= NECK_MAX;
  // In NECK mode a wet step costs nothing at all and only its depth is charged,
  // so the route takes the shallowest line across. A first pass charged a small
  // flat 1.6 and the road still skirted every channel: at three units a step the
  // turn charge is only 0.42 per notch, so going round a twenty-metre inlet is
  // always cheaper than any per-step water charge that is not effectively zero.
  // Deciding to bridge is the up-front `neck` test's job; once it has decided,
  // the walk must not second-guess it.
  const waterCost = neck ? 0 : 26;
  const depthCost = neck ? 0.5 : 1.2;

  // TWO ROADS OUT OF ONE FORK MUST NOT BE ONE ROAD.
  //
  // Every sample of every road already routed, minus the ones near either of
  // this route's own ENDS — a shared node is SHARED, so a walk leaving one is
  // standing on the other road by definition and charging for that would pin it
  // to the node. Past `AVOID_FREE` the two are supposed to be separate paths
  // and the charge applies in full.
  //
  // BOTH ends, not only the start. A road out of the fork ends at a town no
  // other road reaches, so the destination exemption changes nothing about the
  // three that shipped (test-road reports the same lengths and grades) — but a
  // path between two places that ALREADY have a road, which is what a footpath
  // between the hamlets is, arrives at a node it shares and would otherwise be
  // shoved off it by a charge of 50 in the last twenty units.
  const others: RoadSample[] = [];
  for (const road of avoid) {
    for (const p of road) {
      if (Math.hypot(p.x - ax, p.z - az) <= AVOID_FREE) continue;
      if (Math.hypot(p.x - bx, p.z - bz) <= AVOID_FREE) continue;
      others.push(p);
    }
  }
  /** Nearest existing carriageway to a candidate step, or Infinity. */
  const nearOther = (x: number, z: number): number => {
    let best = Infinity;
    for (const p of others) {
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };

  const rng = mulberry32(seed);
  const pts: Array<{ x: number; z: number }> = [{ x: ax, z: az }];
  let cx = ax;
  let cz = az;
  let h = terrain.heightCont(cx, cz);
  // A hard iteration cap: the walk is greedy, so a pathological basin could in
  // principle orbit. 3x the straight-line step count is generous and the
  // fallback (append the destination and let the profile smooth it) is benign.
  const maxSteps = Math.ceil((Math.hypot(bx - ax, bz - az) / SEG_LEN) * 3) + 12;
  for (let step = 0; step < maxSteps; step++) {
    const toB = Math.hypot(bx - cx, bz - cz);
    if (toB <= SEG_LEN * 1.5) break;
    const base = Math.atan2(bx - cx, bz - cz);
    let bestScore = Infinity;
    let bestX = cx;
    let bestZ = cz;
    let bestH = h;
    for (let k = -4; k <= 4; k++) {
      // The swing narrows as the destination gets close, so the last few steps
      // cannot wander off and leave a hook at the town gate.
      const spread = Math.min(0.30, 0.30 * (toB / 40));
      const ang = base + k * spread;
      const nx = cx + Math.sin(ang) * SEG_LEN;
      const nz = cz + Math.cos(ang) * SEG_LEN;
      const nh = terrain.heightCont(nx, nz);
      // A DECK OVER WATER IS FLAT. What the bed does underneath it is not the
      // road's problem, so the climb term must not see it — otherwise crossing
      // an eight-unit-deep channel is scored as descending eight units and
      // climbing back out, and no bridge is ever cheaper than a detour.
      const wet = nh < WATER_LEVEL + 0.4;
      const eff = wet ? WATER_LEVEL + 1.9 : nh;
      let score = Math.abs(eff - h) * 3.4 + Math.abs(k) * 0.42;
      // Deeper water still costs more than shallow, whichever regime we are in,
      // so a crossing that is going to happen happens at the narrowest, shallowest
      // point available.
      if (wet) score += waterCost + (WATER_LEVEL - nh) * depthCost;
      // Keep clear of a road that is already there. Linear in how far inside
      // AVOID_R the step lands, so the charge is a nudge at the edge of the
      // corridor and unpayable on top of the other road's gravel.
      if (others.length > 0) {
        const dOther = nearOther(nx, nz);
        if (dOther < avoidR) score += AVOID_COST * (1 - dOther / avoidR);
      }
      // A whisper of noise so two roads leaving the same junction on similar
      // bearings do not lock onto the same contour and run as a double line.
      // On its own it never did: it is a twelfth of what a single notch of turn
      // costs, against a climb term that both roads read off the same hillside.
      score += rng() * 0.12;
      if (score < bestScore) {
        bestScore = score;
        bestX = nx;
        bestZ = nz;
        bestH = eff;
      }
    }
    cx = bestX;
    cz = bestZ;
    h = bestH;
    pts.push({ x: cx, z: cz });
  }
  pts.push({ x: bx, z: bz });

  // Smooth the plan view. The greedy walk picks one of nine bearings each step,
  // so its output zigzags by up to a sixth of a radian between segments and
  // reads as a saw rather than as a road. Three passes of a pinned 1-2-1 blur
  // takes that out without pulling the line off the ground it chose.
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < pts.length - 1; i++) {
      pts[i].x = (pts[i - 1].x + pts[i].x * 2 + pts[i + 1].x) / 4;
      pts[i].z = (pts[i - 1].z + pts[i].z * 2 + pts[i + 1].z) / 4;
    }
  }
  return resample(pts, SEG_LEN);
}

/** Re-space a polyline at a fixed arc length, endpoints preserved. */
function resample(
  pts: Array<{ x: number; z: number }>, step: number,
): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [{ x: pts[0].x, z: pts[0].z }];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1].x;
    const az = pts[i - 1].z;
    const dx = pts[i].x - ax;
    const dz = pts[i].z - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    let t = carry;
    while (t + step <= len) {
      t += step;
      out.push({ x: ax + (dx / len) * t, z: az + (dz / len) * t });
    }
    carry = t - len;
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.z - tail.z) > step * 0.35) {
    out.push({ x: last.x, z: last.z });
  } else {
    tail.x = last.x;
    tail.z = last.z;
  }
  return out;
}

/**
 * Turn a route into a deck: the elevation profile plus the bridge flags.
 *
 * Four stages, in this order and for reasons that do not commute:
 *
 *  1. SMOOTH the natural profile over a wide window. The ground the route
 *     follows still terraces by a unit every few metres; a deck that copied it
 *     would carry every one of those steps.
 *  2. FLOOR it clear of the water wherever the ground is wet, which is what
 *     makes a crossing a bridge rather than a ford.
 *  3. SLOPE-LIMIT, by RAISING only. A raise-only limiter cannot undo stage 2,
 *     and it produces the cut-and-fill envelope a real road has: it fills dips
 *     rather than diving into them.
 *  4. ANCHOR the two ends onto heights their town or junction has already
 *     committed to, spreading the correction over `ANCHOR` samples so it costs
 *     at most a hair of extra grade.
 *
 * `startY`/`endY` may be NaN, which means "whatever the profile says" — that is
 * how the FIRST road out of a town gets to decide what height the town sits at.
 *
 * `startHold`/`endHold` are how far, in world units, the deck is held DEAD
 * LEVEL at that end's anchor height before the correction is allowed to decay.
 * Pass a town's footprint and the road inside the town is level with the town,
 * which is not a nicety: the earthworks level the shoulder to `round(deck)`, so
 * a deck that has drifted half a unit below the town's own height by the time
 * it reaches the gate lays a 1-unit terrace down the length of the high street.
 * Measured on seed 1337 before this argument existed, Redbriar Mill's interior
 * held 253 columns a full unit below the other 2200 — all of them inside the
 * road's 13-unit blend — and the same road's approach into the Encampment was
 * within 0.17. Which of the two a seed gives you is luck; the hold removes it.
 */
export function profileRoad(
  terrain: Terrain,
  route: Array<{ x: number; z: number }>,
  startY: number,
  endY: number,
  startHold = 0,
  endHold = 0,
): RoadSample[] {
  const n = route.length;
  const nat = new Float32Array(n);
  for (let i = 0; i < n; i++) nat[i] = terrain.heightCont(route[i].x, route[i].z);

  // 1. Wide box smooth. +-6 samples at SEG_LEN 3 is a 36-unit window, which is
  // the scale of the shelves and scarps the near ground carries (terrain.ts) —
  // narrower and the deck rides over each of them, wider and the road stops
  // relating to the land at all.
  const y = new Float32Array(n);
  const R = 6;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let cnt = 0;
    for (let k = -R; k <= R; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      sum += nat[j];
      cnt++;
    }
    y[i] = sum / cnt;
  }

  // 2. Which samples are over water, widened by one either side so the deck is
  // already at bridge height where the abutment piers stand rather than still
  // climbing.
  const bridge = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (nat[i] < WATER_LEVEL + 0.35) bridge[i] = 1;
  const wide = Uint8Array.from(bridge);
  for (let i = 0; i < n; i++) {
    if (!bridge[i]) continue;
    if (i > 0) wide[i - 1] = 1;
    if (i < n - 1) wide[i + 1] = 1;
  }

  const MAX_GRADE = 0.10;
  const rise = MAX_GRADE * SEG_LEN;
  const ANCHOR = 14;
  // 1.9 units of air over the surface: enough that the deck reads as a bridge
  // from the bank, low enough that the abutment ramps are short.
  const floorWater = (): void => {
    for (let i = 0; i < n; i++) {
      if (wide[i] && y[i] < WATER_LEVEL + 1.9) y[i] = WATER_LEVEL + 1.9;
    }
  };
  const slopeLimit = (passes: number): void => {
    for (let pass = 0; pass < passes; pass++) {
      for (let i = 1; i < n; i++) if (y[i] < y[i - 1] - rise) y[i] = y[i - 1] - rise;
      for (let i = n - 2; i >= 0; i--) if (y[i] < y[i + 1] - rise) y[i] = y[i + 1] - rise;
    }
  };
  const anchor = (idx: number, target: number, dir: 1 | -1, hold: number): void => {
    if (!Number.isFinite(target)) return;
    // `hold` samples pinned flat, then ANCHOR more of linear decay from the held
    // height back onto the profile the road would otherwise have had. Over
    // ANCHOR * SEG_LEN = 42 units a correction of a unit or so costs about 0.024
    // of grade against MAX_GRADE 0.10 — invisible next to the terrain the road
    // is crossing.
    //
    // THE DELTA IS MEASURED WHERE THE HOLD ENDS, not at the anchor sample, and
    // that is the whole of the difference between a hold that joins and a hold
    // that steps. The decay is a rigid shift of the profile that tapers to
    // nothing — which is what keeps the road undulating with the land through
    // the corrected stretch instead of being ironed flat by it — so it meets
    // the held run only if the shift it starts from is the one that lands the
    // FIRST DECAYING SAMPLE on `target`.
    //
    // With no hold the two are the same expression and this changes nothing.
    // With one they are not: a town flattens its own footprint before the road
    // is routed over it, so the ground under a town hold is level and the
    // distinction never showed. The fork's flatten is a fifth of the size, and
    // at `JUNCTION_HOLD` 20 the raw profile had climbed 2.1 units over the held
    // stretch — so measuring at the anchor pinned twenty units of deck at the
    // junction height and then resumed 2.1 units above it, in one 3-unit
    // segment. Measured on seed 1337: `junction-redbriar` maxGrade 0.700 /
    // maxStep 0.175, against 0.242 / 0.060 the way it is written here.
    const flat = Math.round(hold / SEG_LEN);
    const join = idx + dir * flat;
    const delta = target - (join >= 0 && join < n ? y[join] : y[idx]);
    for (let k = 0; k < flat + ANCHOR; k++) {
      const j = idx + dir * k;
      if (j < 0 || j >= n) break;
      y[j] = k < flat ? target : y[j] + delta * (1 - (k - flat) / ANCHOR);
    }
  };

  // 3 & 4, TWICE. The three constraints do not commute: the slope limiter can
  // only raise (so it cannot undo the water floor), but an anchor can lower, and
  // an anchor that lands on a span pushes the deck back under the surface — on
  // seed 1337 that put twenty units of bridge at y 7.2 with the water at 8.
  // Alternating them converges in two rounds because each correction is smaller
  // than the last, and the final floor is the guarantee: no deck sample over
  // water is ever below the water. Town heights are themselves floored clear of
  // it (see `levelAt`), so the last floor never has an end sample to move.
  for (let it = 0; it < 2; it++) {
    floorWater();
    slopeLimit(2);
    anchor(0, startY, 1, startHold);
    anchor(n - 1, endY, -1, endHold);
  }
  floorWater();

  const out: RoadSample[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = { x: route[i].x, z: route[i].z, y: y[i], bridge: wide[i] === 1 };
  }
  return out;
}

/**
 * Position and tangent at arc length `s` along a road, into `out`.
 * Used by the furniture pass and by the spawn search; never per frame.
 */
export function roadAt(
  r: Road, s: number, out: { x: number; y: number; z: number; dx: number; dz: number },
): void {
  let acc = 0;
  for (let i = 1; i < r.pts.length; i++) {
    const a = r.pts[i - 1];
    const b = r.pts[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (acc + len >= s || i === r.pts.length - 1) {
      const t = len > 1e-6 ? Math.min(1, Math.max(0, (s - acc) / len)) : 0;
      out.x = a.x + (b.x - a.x) * t;
      out.z = a.z + (b.z - a.z) * t;
      out.y = a.y + (b.y - a.y) * t;
      const inv = len > 1e-6 ? 1 / len : 0;
      out.dx = (b.x - a.x) * inv;
      out.dz = (b.z - a.z) * inv;
      return;
    }
    acc += len;
  }
}
