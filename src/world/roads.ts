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
 *   - between `DECK_HALF` and `DECK_EDGE` the walking surface RAMPS from the
 *     deck to `round(deck)`, so the two meet at the verge with no step at all;
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

// ---------------------------------------------------------------------------
// Corridor geometry
// ---------------------------------------------------------------------------

/**
 * Half-width of the CARRIAGEWAY — the flat part, where `getHeight` is the deck
 * exactly. 2.8 makes a 5.6-unit road: two carts wide in the fiction, and wide
 * enough that the hero (BODY_RADIUS 0.32) plus the camera's shoulder swing stay
 * on it without the player having to steer.
 */
export const DECK_HALF = 2.8;
/** Width of the verge ramp outside it, where the deck meets the shoulder. */
export const VERGE = 2.2;
/** Outer edge of the walking surface, and of the ribbon mesh. */
export const DECK_EDGE = DECK_HALF + VERGE;
/**
 * How far the earthworks are fully applied. Must be comfortably past DECK_EDGE
 * so the ribbon's outer edge lands on ground that is already levelled to
 * `round(deck)` — otherwise the two would meet at whatever the natural terrain
 * happened to be doing and the seam would open up.
 */
const ROAD_CORE = 6.5;
/** Where the earthworks have faded back into natural ground. */
const ROAD_BLEND = 13;
/** Widest radius any query here can care about. */
const REACH = ROAD_BLEND;

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
 * How far INSIDE the surface's terminal plane the earthworks stop.
 *
 * The carve is sampled at COLUMN CENTRES and the ribbon is drawn on the plane
 * itself, so a column whose centre falls a tenth of a unit inside the built
 * side gets cut a whole unit down while up to half its area sticks out past the
 * ribbon's end ring — a hand-wide, one-block-deep slot straight across the end,
 * which is the same class of hole this whole mechanism exists to close, just
 * narrower. Standing the carve's plane half a cell diagonal further in (0.707,
 * rounded up) puts every sunk column wholly under cover.
 *
 * The 0.75 of ribbon that then lies on uncarved ground is lying on ground the
 * town's own flatten already levelled to the deck height, so it sits flat.
 */
const CARVE_INSET = 0.75;

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
 * Two questions, because objects come in two shapes:
 *
 *  - `distanceTo` for a POINT — a tussock, a boulder, a barrel.
 *  - `spanDistanceTo` for a RUN — a fence panel, a wall span, anything laid end
 *    to end. A 4.2-unit panel whose midpoint clears the road by six units can
 *    still be lying flat across it; see there.
 */
export interface RoadClearance {
  /** Distance from (x, z) to the nearest carriageway centreline, or Infinity. */
  distanceTo(x: number, z: number): number;
  /** Nearest approach of the segment (ax,az)-(bx,bz) to any centreline. */
  spanDistanceTo(ax: number, az: number, bx: number, bz: number): number;
}

export interface Road {
  id: string;
  /** Town or junction ids at each end — what a signpost names. */
  fromId: string;
  toId: string;
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
  private grid = new Map<number, Int32Array>();
  private minX = Infinity;
  private maxX = -Infinity;
  private minZ = Infinity;
  private maxZ = -Infinity;

  /** Filled by `carveAt`; see RoadField. */
  carveTarget = 0;
  /** Scratch for `nearest`. Never read from outside this class. */
  private nDist = 0;
  private nDeck = 0;
  private nBridge = false;

  add(road: Road): void {
    if (road.pts.length >= 2) this.roads.push(road);
  }

  /** Flatten every road into segments and index them. Call once, after `add`. */
  build(): void {
    let n = 0;
    for (const r of this.roads) n += r.pts.length - 1;
    this.seg = new Float32Array(n * 6);
    this.segBridge = new Uint8Array(n);
    this.segRoad = new Uint8Array(n);
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
    const lists = new Map<number, number[]>();
    for (let i = 0; i < count; i++) {
      const o = i * 6;
      const x0 = Math.min(this.seg[o], this.seg[o + 3]) - REACH;
      const x1 = Math.max(this.seg[o], this.seg[o + 3]) + REACH;
      const z0 = Math.min(this.seg[o + 1], this.seg[o + 4]) - REACH;
      const z1 = Math.max(this.seg[o + 1], this.seg[o + 4]) + REACH;
      if (x0 < this.minX) this.minX = x0;
      if (x1 > this.maxX) this.maxX = x1;
      if (z0 < this.minZ) this.minZ = z0;
      if (z1 > this.maxZ) this.maxZ = z1;
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
        for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
          const key = cellKey(cx, cz);
          let l = lists.get(key);
          if (l === undefined) { l = []; lists.set(key, l); }
          l.push(i);
        }
      }
    }
    this.grid.clear();
    for (const [key, l] of lists) this.grid.set(key, Int32Array.from(l));
  }

  /**
   * Nearest point on any road to (x, z), into `nDist` / `nDeck` / `nBridge`.
   * False when nothing is within REACH — the common case, answered by a bounds
   * test and one failed `Map.get`.
   */
  private nearest(x: number, z: number, built: boolean, inset = 0): boolean {
    if (x < this.minX || x > this.maxX || z < this.minZ || z > this.maxZ) return false;
    const bucket = this.grid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (bucket === undefined) return false;
    let best = Infinity;
    let deck = 0;
    let bridge = 0;
    const s = this.seg;
    if (built) this.queryId++;
    for (let i = 0; i < bucket.length; i++) {
      if (built) {
        const ri = this.segRoad[bucket[i]];
        if (this.clipStamp[ri] !== this.queryId) {
          this.clipStamp[ri] = this.queryId;
          const t = this.roads[ri].trim;
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
      if (d2 < best) {
        best = d2;
        deck = s[o + 2] + (s[o + 5] - s[o + 2]) * t;
        bridge = this.segBridge[bucket[i]];
      }
    }
    if (best > REACH * REACH) return false;
    this.nDist = Math.sqrt(best);
    this.nDeck = deck;
    this.nBridge = bridge === 1;
    return true;
  }

  carveAt(x: number, z: number): number {
    // CARVE_INSET, not 0: the earthworks stop short of the surface's own plane.
    if (!this.nearest(x, z, true, CARVE_INSET)) return 0;
    // A bridge span leaves the ground alone. Raising a lake bed to meet the deck
    // would drain the crossing, which is the one place the road is supposed to
    // be in the air.
    if (this.nBridge) return 0;
    const d = this.nDist;
    if (d >= ROAD_BLEND) return 0;
    // THE ROADBED IS SUNK UNDER THE CARRIAGEWAY, and it has to be.
    //
    // Outside the ribbon the target is `deck + 0.5`, which floors to
    // `round(deck)` — within half a unit of the deck in either direction, which
    // is what makes stepping off the road walkable. But `round(deck)` can be
    // half a unit ABOVE the deck, and the ribbon is drawn AT the deck: captured
    // with a single target across the whole corridor (_town-spawn.png, first
    // pass) the road was invisible from the saddle, because on every stretch
    // where frac(deck) > 0.5 the levelled ground had swallowed it.
    //
    // So under the carriageway the ground is cut a further 0.62 down — enough
    // that the floored column is always strictly below the deck, never more than
    // 1.62 below it, and entirely hidden by the ribbon and its skirt. The cut
    // ramps back up to `deck + 0.5` and REACHES it 0.8 units INSIDE the ribbon's
    // rim, so that every column whose centre could fall outside the rim is
    // already at the shoulder height the rim is drawn at. Nothing walks on the
    // sunk part: inside the rim the walking surface is the deck.
    this.carveTarget = this.nDeck - 0.62 + smoothstep(DECK_HALF, DECK_EDGE - 0.8, d) * 1.12;
    return 1 - smoothstep(ROAD_CORE, ROAD_BLEND, d);
  }

  surfaceAt(x: number, z: number, ground: number): number {
    if (!this.nearest(x, z, true)) return ground;
    const d = this.nDist;
    if (d >= DECK_EDGE) return ground;
    const deck = this.nDeck;
    // A bridge deck is flat all the way to its edge and then there is nothing:
    // step off the side and you are in the water, which is what a bridge with no
    // handrail collision means and what the railings are drawn to warn about.
    if (this.nBridge || d <= DECK_HALF) return deck;
    const shoulder = Math.round(deck);
    return deck + (shoulder - deck) * ((d - DECK_HALF) / VERGE);
  }

  /**
   * Distance from (x, z) to the nearest carriageway centreline, or Infinity.
   * For the prop pass, which has to keep trees and boulders off a road it never
   * otherwise hears about, and for the town builder's clearance tests.
   */
  distanceTo(x: number, z: number): number {
    // NOT clipped to the built carriageway, deliberately. A placer asking "is
    // there a road here" is asking about the ROUTE: the Encampment's
    // thoroughfare from its gate to the middle of camp is still a road you may
    // not pitch a tent on, even once no gravel is drawn along it. One polyline,
    // two questions — see Road.trim.
    return this.nearest(x, z, false) ? this.nDist : Infinity;
  }

  /**
   * Nearest approach of the SEGMENT (ax, az)-(bx, bz) to any carriageway
   * centreline, or Infinity when the whole run is clear of the network.
   *
   * THE RUN VERSION OF `distanceTo`, and it exists because a fence panel is
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
  spanDistanceTo(ax: number, az: number, bx: number, bz: number): number {
    const dx = bx - ax;
    const dz = bz - az;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / SPAN_STEP));
    let best = Infinity;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const d = this.distanceTo(ax + dx * t, az + dz * t);
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
 * The scoring is three terms: the climb (dominant — this is what makes the road
 * hug a contour), the turn away from the target (so it still arrives), and a
 * water charge that is heavy enough to route around a lake but not so heavy that
 * a narrow neck is never crossed. Crossing IS wanted occasionally; it is where
 * the bridges come from.
 */
export function routeRoad(
  terrain: Terrain, ax: number, az: number, bx: number, bz: number, seed: number,
): Array<{ x: number; z: number }> {
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
  const neck = straightWetLength(terrain, ax, az, bx, bz) <= NECK_MAX;
  // In NECK mode a wet step costs nothing at all and only its depth is charged,
  // so the route takes the shallowest line across. A first pass charged a small
  // flat 1.6 and the road still skirted every channel: at three units a step the
  // turn charge is only 0.42 per notch, so going round a twenty-metre inlet is
  // always cheaper than any per-step water charge that is not effectively zero.
  // Deciding to bridge is the up-front `neck` test's job; once it has decided,
  // the walk must not second-guess it.
  const waterCost = neck ? 0 : 26;
  const depthCost = neck ? 0.5 : 1.2;

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
      // A whisper of noise so two roads leaving the same junction on similar
      // bearings do not lock onto the same contour and run as a double line.
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
    const delta = target - y[idx];
    // `hold` samples pinned flat, then ANCHOR more of linear decay. The decay
    // still starts from the FULL delta, so the two pieces meet without a kink,
    // and over ANCHOR * SEG_LEN = 42 units a correction of a unit or so costs
    // about 0.024 of grade against MAX_GRADE 0.10 — invisible next to the
    // terrain the road is crossing.
    const flat = Math.round(hold / SEG_LEN);
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
