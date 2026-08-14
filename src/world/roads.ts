/**
 * ROADS — the carved corridor between towns. Three things that must agree, all
 * owned here: a ROUTE (`routeRoad`), an ELEVATION PROFILE (`profileRoad`, which
 * lifts a water crossing into a bridge), and a HEIGHT FIELD (`RoadNetwork`,
 * implementing terrain.ts's `RoadField`) that folds both back into the terrain.
 *
 * The deck is CONTINUOUS while the world is stepped, because `Terrain.getHeight`
 * floors and `MAX_STEP_UP` is 0.5. Three things meet at the kerb: the carve levels
 * the shoulder to `deck + 0.5` (floors to `round(deck)`), the walking surface ramps
 * to that over exactly the run the carve raises, and the ribbon is drawn on that
 * same surface out to that same edge.
 */
import type { Terrain } from "./terrain";
import { WATER_LEVEL, smoothstep, type RoadField } from "./terrain";
import { mulberry32 } from "./noise";
import { MAX_CARVE_BLEND, ROAD_PROFILE, type PathProfile } from "./path-profile";

/** For the lab stage and probes only; every placer uses `edgeDistanceTo`. */
export const DECK_HALF = ROAD_PROFILE.deckHalf;
export const DECK_EDGE = ROAD_PROFILE.deckEdge;

/** Widest radius any query cares about — a bound over EVERY profile. */
const REACH = MAX_CARVE_BLEND;

/** Deck polyline spacing. Shorter crowds the grid on the collision hot path. */
export const SEG_LEN = 3;
/** Spatial grid cell, world units. See `buildIndex` for why it is not bigger. */
const CELL = 8;
/** Sampling pitch of `spanDistanceTo`. See there for the error it costs. */
const SPAN_STEP = 0.35;
/** Litter reach past the rim; grass stops 0.4 out, so the two interleave. */
const LITTER_SKIRT = 0.5;

export interface Junction {
  x: number;
  z: number;
  /** Deck height, which every arm anchored to. */
  y: number;
  profile: PathProfile;
}

/** One per `PathRoles` flag. `const enum` so the bucket-scan test is a mask. */
const enum Role {
  Surface = 1,
  Built = 2,
  Foliage = 4,
  Wear = 8,
}
/** One spatial grid each. See `grids`. */
const ROLES = [Role.Surface, Role.Built, Role.Foliage, Role.Wear];
const ROLE_SLOT: Record<number, number> = {
  [Role.Surface]: 0,
  [Role.Built]: 1,
  [Role.Foliage]: 2,
  [Role.Wear]: 3,
};

const cellKey = (cx: number, cz: number): number => cx * 4194304 + cz;

export interface RoadSample {
  x: number;
  z: number;
  /** Deck height (continuous). */
  y: number;
  /** Ground here is under the waterline, so the deck is a BRIDGE: no earthworks. */
  bridge: boolean;
}

/**
 * THE ROAD, AS EVERY PLACER SEES IT. Nothing re-derives "am I near a road" from the
 * height field, because roads are carved BEFORE everything else is placed and the
 * ground beside a carriageway is levelled to within half a unit of it.
 *
 * Four queries: point and RUN (whose midpoint can clear a road the run lies across)
 * times two audiences — foliage keeps off EVERY path, built things only off paths
 * whose profile refuses them (`PathRoles`). FROM THE RIM, NOT THE CENTRELINE (issue
 * #142): the query subtracts the answering path's own `deckEdge`.
 */
export interface RoadClearance {
  /** Outside the nearest path's rim: negative on it, zero at the rim, else Infinity. */
  edgeDistanceTo(x: number, z: number): number;
  /** The same for a segment: its nearest approach to a rim. */
  spanEdgeDistanceTo(ax: number, az: number, bx: number, bz: number): number;
  /** The same, over only the paths that refuse BUILT things. */
  builtEdgeDistanceTo(x: number, z: number): number;
  spanBuiltEdgeDistanceTo(ax: number, az: number, bx: number, bz: number): number;
  /** Litter at (x, z), 0..1 — the inverse of every other query. See `litterAt`. */
  litterAt(x: number, z: number): number;
  /** Distance from (x, z) to the nearest carriageway centreline, or Infinity. */
  distanceTo(x: number, z: number): number;
}

export interface Road {
  id: string;
  /** Town or junction ids at each end — what a signpost names. */
  fromId: string;
  toId: string;
  profile: PathProfile;
  /** How hard THIS path is walked, 0..1. Ignored unless the profile `wears`. */
  wear?: number;
  pts: RoadSample[];
  /**
   * Where the BUILT carriageway ends (`pts` is the ROUTE), as two inward
   * half-planes [px, pz, nx, nz], corridor where `dot(q - p, n) >= 0`. Filled even
   * when nothing is trimmed: `nearest` clamps to [0, 1] and would otherwise close
   * the corridor in a radial dome the ribbon does not cover. Set before `build()`.
   */
  trim: Float32Array;
}

/** Setters rather than raw writes, so the slot order lives in one place. */
export function setTrimStart(r: Road, px: number, pz: number, nx: number, nz: number): void {
  r.trim[0] = px;
  r.trim[1] = pz;
  r.trim[2] = nx;
  r.trim[3] = nz;
}
export function setTrimEnd(r: Road, px: number, pz: number, nx: number, nz: number): void {
  r.trim[4] = px;
  r.trim[5] = pz;
  r.trim[6] = nx;
  r.trim[7] = nz;
}

/** A sample between two samples. A cut end inherits the span flag: half a bridge
 *  is not a thing. */
const lerpSample = (a: RoadSample, b: RoadSample, t: number): RoadSample => ({
  x: a.x + (b.x - a.x) * t,
  z: a.z + (b.z - a.z) * t,
  y: a.y + (b.y - a.y) * t,
  bridge: a.bridge || b.bridge,
});

/**
 * The samples carrying a BUILT carriageway, ends interpolated onto the trim planes.
 * Here, not in the ribbon builder, so drawing and carving cannot disagree.
 */
export function builtDeck(r: Road): RoadSample[] {
  const out: RoadSample[] = [];
  const inside = (p: RoadSample, o: number): number =>
    (p.x - r.trim[o]) * r.trim[o + 2] + (p.z - r.trim[o + 1]) * r.trim[o + 3];
  for (let i = 0; i < r.pts.length; i++) {
    const p = r.pts[i];
    const in0 = inside(p, 0) >= 0;
    const in1 = inside(p, 4) >= 0;
    if (in0 && in1) {
      if (i > 0 && out.length === 0) {
        const q = r.pts[i - 1];
        const a = inside(q, 0);
        const b = inside(p, 0);
        if (b !== a) {
          out.push(lerpSample(q, p, (0 - a) / (b - a)));
        }
      }
      out.push(p);
    } else if (out.length > 0 && !in1) {
      const q = r.pts[i - 1];
      const a = inside(q, 4);
      const b = inside(p, 4);
      if (b !== a) {
        out.push(lerpSample(q, p, (0 - a) / (b - a)));
      }
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

/** Filled by `lowestDrawnSurfaceNear`; a caller-owned scratch, never retained. */
export interface RimHit {
  found: boolean;
  x: number;
  z: number;
  /** Unit normal to the corridor, so a caller can step out to either rim. */
  nx: number;
  nz: number;
  /** `PathProfile.deckEdge` of the road that won. */
  half: number;
}

/**
 * Every road as one queryable corridor. Flat typed arrays throughout: `carveAt`
 * runs inside `heightCont`, so no query may allocate or chase objects.
 */
export class RoadNetwork implements RoadField, RoadClearance {
  readonly roads: Road[] = [];
  /** For the ribbon builder only — a junction is geometry, not height. */
  readonly junctions: Junction[] = [];
  /**
   * One rim everywhere, so "nearest centreline" and "nearest rim" rank alike and
   * the scan stays on squared distances. See `nearest`.
   */
  private uniformEdge = true;
  /** Roles per road as a bitmask; the scan tests it once per bucket entry. */
  private roadRole = new Uint8Array(0);
  /** [ax, az, ay, bx, bz, by] per segment. */
  private seg = new Float32Array(0);
  private segBridge = new Uint8Array(0);
  /**
   * Which road owns each segment, plus a per-road cache of "is this point past that
   * road's trim planes". The verdict is PER ROAD, not per segment: a point just past
   * an end node is still within DECK_EDGE of the previous segment, so skipping only
   * the terminal one falls through to a full-depth carve.
   */
  private segRoad = new Uint16Array(0);
  private clipStamp = new Float64Array(0);
  private clipOut = new Uint8Array(0);
  private queryId = 0;
  /**
   * ONE INDEX PER ROLE, for the collision hot path: a town's beaten tracks would
   * otherwise sit in every bucket a surface query scans. Indexed by `ROLES[i]`,
   * bounds per role so a query outside every carriageway costs one compare.
   */
  private grids: Array<Map<number, Int32Array>> = ROLES.map(() => new Map());
  private bounds = new Float64Array(ROLES.length * 4);

  /** Filled by `carveAt`; see RoadField. */
  carveTarget = 0;
  /** Scratch for `nearest`. */
  private nDist = 0;
  private nDeck = 0;
  private nBridge = false;
  private nProfile: PathProfile = ROAD_PROFILE;

  add(road: Road): void {
    if (road.pts.length >= 2) {
      this.roads.push(road);
    }
  }

  /**
   * Swap one path for two, IN PLACE: deleting and appending would lose the ordering
   * the ribbon's lift bias is assigned from. Call `build()` after.
   */
  replace(road: Road, halves: readonly Road[]): void {
    const i = this.roads.indexOf(road);
    if (i < 0) {
      return;
    }
    this.roads.splice(i, 1, ...halves);
  }

  /** Register a fork, so the arms know where to start. */
  addJunction(x: number, z: number, y: number, profile: PathProfile): void {
    this.junctions.push({ x, z, y, profile });
  }

  /** Flatten every road into segments and index them. Call once, after `add`. */
  build(): void {
    let n = 0;
    for (const r of this.roads) {
      n += r.pts.length - 1;
    }
    // Per network, not per role: conservative, and costs at most a needless sqrt.
    this.uniformEdge = this.roads.every(
      (r) => r.profile.deckEdge === this.roads[0].profile.deckEdge,
    );
    this.seg = new Float32Array(n * 6);
    this.segBridge = new Uint8Array(n);
    this.segRoad = new Uint16Array(n);
    this.roadRole = new Uint8Array(this.roads.length);
    for (let i = 0; i < this.roads.length; i++) {
      const q = this.roads[i].profile.roles;
      this.roadRole[i] =
        (q.surface ? Role.Surface : 0) |
        (q.refusesBuilt ? Role.Built : 0) |
        (q.refusesFoliage ? Role.Foliage : 0) |
        (q.wears ? Role.Wear : 0);
    }
    this.clipStamp = new Float64Array(this.roads.length);
    this.clipOut = new Uint8Array(this.roads.length);
    let k = 0;
    for (let ri = 0; ri < this.roads.length; ri++) {
      const r = this.roads[ri];
      // Planes square to the ends turn the terminal dome flat. See Road.trim.
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
        this.seg[o] = a.x;
        this.seg[o + 1] = a.z;
        this.seg[o + 2] = a.y;
        this.seg[o + 3] = b.x;
        this.seg[o + 4] = b.z;
        this.seg[o + 5] = b.y;
        // Either end wet spans the whole segment: a half-carved abutment notches.
        this.segBridge[k] = a.bridge || b.bridge ? 1 : 0;
        k++;
      }
    }
    this.buildIndex(k);
  }

  /**
   * Bucket segments into CELL cells, each holding every segment within REACH. CELL 8
   * + REACH 13 is a 34x34 catchment; CELL 16 would be 42x42 and scan half again.
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
        if ((this.roadRole[this.segRoad[i]] & role) === 0) {
          continue;
        }
        const o = i * 6;
        const x0 = Math.min(this.seg[o], this.seg[o + 3]) - REACH;
        const x1 = Math.max(this.seg[o], this.seg[o + 3]) + REACH;
        const z0 = Math.min(this.seg[o + 1], this.seg[o + 4]) - REACH;
        const z1 = Math.max(this.seg[o + 1], this.seg[o + 4]) + REACH;
        if (x0 < this.bounds[g * 4]) {
          this.bounds[g * 4] = x0;
        }
        if (x1 > this.bounds[g * 4 + 1]) {
          this.bounds[g * 4 + 1] = x1;
        }
        if (z0 < this.bounds[g * 4 + 2]) {
          this.bounds[g * 4 + 2] = z0;
        }
        if (z1 > this.bounds[g * 4 + 3]) {
          this.bounds[g * 4 + 3] = z1;
        }
        for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
          for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
            const key = cellKey(cx, cz);
            let l = lists.get(key);
            if (l === undefined) {
              l = [];
              lists.set(key, l);
            }
            l.push(i);
          }
        }
      }
      const grid = this.grids[g];
      grid.clear();
      for (const [key, l] of lists) {
        grid.set(key, Int32Array.from(l));
      }
    }
  }

  /**
   * Nearest path to (x, z), into `nDist` / `nDeck` / `nBridge` / `nProfile`; false
   * when nothing is within REACH. NEAREST BY PENETRATION, NOT CENTRELINE (issue
   * #142): a narrow path beside a wide one owns the closest centreline to a column
   * the wide one surfaces, so rank on `d - deckEdge`. See `uniformEdge`.
   */
  private nearest(x: number, z: number, role: number, built: boolean, insetScale = 0): boolean {
    const g = ROLE_SLOT[role];
    const b = g * 4;
    if (x < this.bounds[b] || x > this.bounds[b + 1]) {
      return false;
    }
    if (z < this.bounds[b + 2] || z > this.bounds[b + 3]) {
      return false;
    }
    const bucket = this.grids[g].get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (bucket === undefined) {
      return false;
    }
    const uniform = this.uniformEdge;
    let best = Infinity;
    let bestD2 = Infinity;
    let deck = 0;
    let bridge = 0;
    let profile: PathProfile | null = null;
    const s = this.seg;
    if (built) {
      this.queryId++;
    }
    for (let i = 0; i < bucket.length; i++) {
      // The role IS the index, which keeps a wide painted track out of the field.
      const ri = this.segRoad[bucket[i]];
      const rp = this.roads[ri].profile;
      if (built) {
        if (this.clipStamp[ri] !== this.queryId) {
          this.clipStamp[ri] = this.queryId;
          const t = this.roads[ri].trim;
          // `insetScale` is 1 for the carve and 0 for the surface.
          const inset = rp.carveInset * insetScale;
          const p0 = (x - t[0]) * t[2] + (z - t[1]) * t[3];
          const p1 = (x - t[4]) * t[6] + (z - t[5]) * t[7];
          this.clipOut[ri] = p0 >= inset && p1 >= inset ? 0 : 1;
        }
        if (this.clipOut[ri] === 1) {
          continue;
        }
      }
      const o = bucket[i] * 6;
      const ax = s[o];
      const az = s[o + 1];
      const dx = s[o + 3] - ax;
      const dz = s[o + 4] - az;
      const len2 = dx * dx + dz * dz;
      let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
      if (t < 0) {
        t = 0;
      } else if (t > 1) {
        t = 1;
      }
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
    if (profile === null || bestD2 > REACH * REACH) {
      return false;
    }
    this.nDist = Math.sqrt(bestD2);
    this.nDeck = deck;
    this.nBridge = bridge === 1;
    this.nProfile = profile;
    return true;
  }

  /**
   * The walking surface `d` from a centreline whose deck is `deck`. ONE function for
   * both `surfaceAt` and `carveAt` — they may not be two formulas that agree.
   */
  private static surfaceOf(p: PathProfile, deck: number, d: number): number {
    if (d <= p.deckHalf) {
      return deck;
    }
    const t = (d - p.deckHalf) / (p.verge - p.shoulderIn);
    // Reaches the shoulder `shoulderIn` inside the rim, then holds it to the rim.
    return deck + (Math.round(deck) - deck) * (t > 1 ? 1 : t);
  }

  carveAt(x: number, z: number): number {
    // insetScale 1: the earthworks stop short of the surface's terminal plane.
    if (!this.nearest(x, z, Role.Surface, true, 1)) {
      return 0;
    }
    const prof = this.nProfile;
    if (prof.carve === "none") {
      return 0;
    }
    // A bridge span leaves the ground alone: raising a lake bed would drain it.
    if (this.nBridge) {
      return 0;
    }
    const d = this.nDist;
    if (d >= prof.carveBlend) {
      return 0;
    }
    // Cut to the SURFACE DRAWN OVER the column, minus a sink: `floor` can only
    // lower (nothing stands through the ribbon) and at the rim the faded target is
    // the integer `round(deck)` that `floor` returns exactly (no invisible step).
    // Issue #15 was two separate curves for these that crossed. The sink also keeps
    // an integer deck off coplanar with the ribbon; the epsilon guards `heightCont`
    // blending to 12.999999 for 13. `dCell` reaches inward half a cell diagonal
    // because a column is a CELL whose inner corner sees a lower drawn surface.
    const dCell = d > prof.carveInset ? d - prof.carveInset : 0;
    let target =
      RoadNetwork.surfaceOf(prof, this.nDeck, dCell) +
      0.001 -
      prof.sink * (1 - smoothstep(prof.deckHalf, prof.deckEdge - prof.shoulderIn, dCell));
    // A cell the RIBBON CANNOT FULLY COVER — outer corner past the rim — may
    // not end up below the rim's landing. Through the corner inset, the
    // ramp/sink band reaches such cells and dug a one-column trench along the
    // verge, the black slits reported twice (trails worst: their whole shoulder
    // fits inside one cell); a NATURAL pit there is the same hole, and the
    // clamp FILLS it too — `heightCont`'s lerp raises toward the target. The
    // cell's inner corner may now stand up to `round(deck) - deck` proud of the
    // ramp it meets, under half a unit always, reading as ground lapping the
    // gravel; collision is untouched (`surfaceAt` stays the deck).
    if (d > prof.deckEdge - prof.carveInset) {
      const rim = Math.round(this.nDeck) + 0.001;
      if (target < rim) {
        target = rim;
      }
    }
    this.carveTarget = target;
    return 1 - smoothstep(prof.carveCore, prof.carveBlend, d);
  }

  /**
   * `surfaceAt` for the DRAWN ground, reaching `carveInset` PAST each terminal plane:
   * the carve holds back the same amount, so the two OVERLAP and no ribbon is drawn
   * over unlevelled ground (issue #15). Drawing only — collision keeps `surfaceAt`.
   */
  drawnSurfaceAt(x: number, z: number, ground: number): number {
    // Unclipped: the ROUTE. Safe because `columnInfo` only lowers a column already
    // within a metre of the corridor surface.
    if (!this.nearest(x, z, Role.Surface, false)) {
      return ground;
    }
    const d = this.nDist;
    const prof = this.nProfile;
    if (d >= prof.deckEdge) {
      return ground;
    }
    if (this.nBridge) {
      return this.nDeck;
    }
    return RoadNetwork.surfaceOf(prof, this.nDeck, d);
  }

  surfaceAt(x: number, z: number, ground: number): number {
    return this.surfaceOfAt(x, z, ground, 0);
  }

  /**
   * The DRAWN ribbon surface where it is LOWEST over the cell at (x, z) — a
   * disc of radius `r` — or NaN where no drawn, grounded path covers any of it.
   * The mesher caps a covered column's DRAWN top just under this, so the ground
   * follows the road's shape instead of quantizing a corner through the ribbon
   * (green slivers on the carriageway) or a whole unit under it (black slits) —
   * both reported. EVERY covering path is consulted, not the nearest: at a fork
   * or a spur mouth the LOWER ribbon is what a raised cap would poke through
   * (test-road measured 456 such samples on a nearest-only cut). Bridges are
   * excluded — their ground is a gorge or a lake bed and stays where it is.
   * Unclipped, like `drawnSurfaceAt`, so the cap holds to the drawn ends.
   */
  drawnCapNear(x: number, z: number, r: number): number {
    const g = ROLE_SLOT[Role.Surface];
    const b = g * 4;
    if (x < this.bounds[b] - r || x > this.bounds[b + 1] + r) {
      return NaN;
    }
    if (z < this.bounds[b + 2] - r || z > this.bounds[b + 3] + r) {
      return NaN;
    }
    const bucket = this.grids[g].get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (bucket === undefined) {
      return NaN;
    }
    const s = this.seg;
    let cap = NaN;
    for (let i = 0; i < bucket.length; i++) {
      const road = this.roads[this.segRoad[bucket[i]]];
      const prof = road.profile;
      if (!prof.roles.draw || this.segBridge[bucket[i]] === 1) {
        continue;
      }
      const o = bucket[i] * 6;
      const ax = s[o];
      const az = s[o + 1];
      const dx = s[o + 3] - ax;
      const dz = s[o + 4] - az;
      const len2 = dx * dx + dz * dz;
      let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
      if (t < 0) {
        t = 0;
      } else if (t > 1) {
        t = 1;
      }
      const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
      if (d - r >= prof.deckEdge) {
        continue;
      }
      const deck = s[o + 2] + (s[o + 5] - s[o + 2]) * t;
      // `surfaceOf` is monotonic in d, so the lowest over the covered span is
      // at one of its ends.
      const lo = RoadNetwork.surfaceOf(prof, deck, d - r > 0 ? d - r : 0);
      const hi = RoadNetwork.surfaceOf(prof, deck, d + r < prof.deckEdge ? d + r : prof.deckEdge);
      const low = lo < hi ? lo : hi;
      if (!(low >= cap)) {
        cap = low;
      }
    }
    return cap;
  }

  private surfaceOfAt(x: number, z: number, ground: number, insetScale: number): number {
    if (!this.nearest(x, z, Role.Surface, true, insetScale)) {
      return ground;
    }
    const d = this.nDist;
    const prof = this.nProfile;
    if (d >= prof.deckEdge) {
      return ground;
    }
    const deck = this.nDeck;
    // Flat to its edge and then nothing: no handrail collision on a bridge.
    if (this.nBridge) {
      return deck;
    }
    return RoadNetwork.surfaceOf(prof, deck, d);
  }

  /**
   * Nearest carriageway centreline, or Infinity. For the router's own avoidance and
   * the probes — a PLACER wants `edgeDistanceTo`.
   */
  distanceTo(x: number, z: number): number {
    // Not clipped: a placer means the ROUTE, still a road. See Road.trim.
    return this.nearest(x, z, Role.Foliage, false) ? this.nDist : Infinity;
  }

  /** Outside the nearest path's RIM. THE QUERY EVERY PLACER ASKS; see `RoadClearance`. */
  edgeDistanceTo(x: number, z: number): number {
    return this.nearest(x, z, Role.Foliage, false) ? this.nDist - this.nProfile.deckEdge : Infinity;
  }

  /**
   * The same, over only paths that refuse BUILT things — a beaten track answers
   * `edgeDistanceTo` and not this, being derived from the huts it runs between.
   */
  builtEdgeDistanceTo(x: number, z: number): number {
    return this.nearest(x, z, Role.Built, false) ? this.nDist - this.nProfile.deckEdge : Infinity;
  }

  /**
   * The LOWEST drawn corridor surface within `r` of (x, z), else `ground`. A SPATIAL
   * query, because the clipmap's nine-point stencil (`underPaths`) straddles a path
   * narrower than its gaps: each segment is tested against the cell as a DISC.
   */
  lowestDrawnSurfaceNear(x: number, z: number, r: number, ground: number, rim?: RimHit): number {
    if (rim !== undefined) {
      rim.found = false;
    }
    const g = ROLE_SLOT[Role.Surface];
    const b = g * 4;
    if (x < this.bounds[b] - r || x > this.bounds[b + 1] + r) {
      return ground;
    }
    if (z < this.bounds[b + 2] - r || z > this.bounds[b + 3] + r) {
      return ground;
    }
    let out = ground;
    // The cell can straddle a bucket boundary, so look up its four corners too.
    for (const [ox, oz] of [
      [0, 0],
      [r, r],
      [r, -r],
      [-r, r],
      [-r, -r],
    ] as const) {
      const bucket = this.grids[g].get(
        cellKey(Math.floor((x + ox) / CELL), Math.floor((z + oz) / CELL)),
      );
      if (bucket === undefined) {
        continue;
      }
      const s = this.seg;
      for (let i = 0; i < bucket.length; i++) {
        const ri = this.segRoad[bucket[i]];
        const road = this.roads[ri];
        if (!road.profile.roles.draw) {
          continue;
        }
        const o = bucket[i] * 6;
        const ax = s[o];
        const az = s[o + 1];
        const dx = s[o + 3] - ax;
        const dz = s[o + 4] - az;
        const len2 = dx * dx + dz * dz;
        let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
        if (t < 0) {
          t = 0;
        } else if (t > 1) {
          t = 1;
        }
        const px = ax + dx * t;
        const pz = az + dz * t;
        if (Math.hypot(px - x, pz - z) > r + road.profile.deckEdge) {
          continue;
        }
        const deck = s[o + 2] + (s[o + 5] - s[o + 2]) * t;
        if (deck < out) {
          out = deck;
        }
        // The rim, for a caller that samples the walking surface itself: the deck
        // is only the middle of the corridor. See `underPaths`.
        if (rim !== undefined && !rim.found) {
          rim.found = true;
          rim.x = px;
          rim.z = pz;
          const len = Math.hypot(dx, dz) || 1;
          rim.nx = -dz / len;
          rim.nz = dx / len;
          rim.half = road.profile.deckEdge;
        }
      }
    }
    return out;
  }

  /**
   * Loose stone and stick, 0..1 — the one query here that WANTS the corridor. A band
   * at the VERGE, not a disc: wheels sweep a carriageway clear onto its edge.
   */
  litterAt(x: number, z: number): number {
    if (!this.nearest(x, z, Role.Foliage, false)) {
      return 0;
    }
    const p = this.nProfile;
    if (p.litter <= 0) {
      return 0;
    }
    const d = this.nDist;
    if (d <= p.deckHalf) {
      return 0;
    }
    if (d >= p.deckEdge + LITTER_SKIRT) {
      return 0;
    }
    // Up over the verge, held across the rim, down over the skirt outside it.
    const up = smoothstep(p.deckHalf, p.deckEdge, d);
    const down = 1 - smoothstep(p.deckEdge, p.deckEdge + LITTER_SKIRT, d);
    return p.litter * Math.min(up, down);
  }

  /**
   * How walked the ground is, 0..1 — read by `Terrain.trampleAt`. Full inside
   * `deckHalf`, gone at `deckEdge`. `columnInfo` budget, never the collision path.
   */
  wearAt(x: number, z: number): number {
    const g = ROLE_SLOT[Role.Wear];
    const b = g * 4;
    if (x < this.bounds[b] || x > this.bounds[b + 1]) {
      return 0;
    }
    if (z < this.bounds[b + 2] || z > this.bounds[b + 3]) {
      return 0;
    }
    const bucket = this.grids[g].get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (bucket === undefined) {
      return 0;
    }
    // The STRONGEST track, not the nearest: overlapping tracks are walked
    // different amounts, and max is what the field this replaces took.
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
      if (t < 0) {
        t = 0;
      } else if (t > 1) {
        t = 1;
      }
      const px = ax + dx * t - x;
      const pz = az + dz * t - z;
      const road = this.roads[this.segRoad[bucket[i]]];
      const p = road.profile;
      const d2 = px * px + pz * pz;
      if (d2 >= p.deckEdge * p.deckEdge) {
        continue;
      }
      const w = (road.wear ?? 1) * (1 - smoothstep(p.deckHalf, p.deckEdge, Math.sqrt(d2)));
      if (w > best) {
        best = w;
      }
    }
    return best;
  }

  /**
   * The run version of `edgeDistanceTo`: a midpoint query says nothing about where a
   * run's ends are, and on a bend they can lie across the carriageway. SAMPLED —
   * polyline distance is 1-Lipschitz, so SPAN_STEP over-reports by under 0.18.
   */
  spanEdgeDistanceTo(ax: number, az: number, bx: number, bz: number): number {
    return this.sweep(ax, az, bx, bz, false);
  }

  /** The run version of `builtEdgeDistanceTo`. What a fence bay asks. */
  spanBuiltEdgeDistanceTo(ax: number, az: number, bx: number, bz: number): number {
    return this.sweep(ax, az, bx, bz, true);
  }

  private sweep(ax: number, az: number, bx: number, bz: number, builtOnly: boolean): number {
    const dx = bx - ax;
    const dz = bz - az;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / SPAN_STEP));
    let best = Infinity;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const d = builtOnly
        ? this.builtEdgeDistanceTo(ax + dx * t, az + dz * t)
        : this.edgeDistanceTo(ax + dx * t, az + dz * t);
      if (d < best) {
        best = d;
      }
    }
    return best;
  }
}

/**
 * Below this a crossing is REFUSED, not merged (issue #142 §12e); sharing a run is
 * not built. From the apron: the rim between two arms pinches to
 * `deckEdge / cos((pi - gap) / 2)`, already 23 units against an 11-unit radius.
 */
const GLANCE_MIN = (25 * Math.PI) / 180;

export interface Crossing {
  /** The path being merged IN, and where along its polyline. */
  seg: number;
  t: number;
  /** The path already there, and where along ITS polyline. */
  other: Road;
  otherSeg: number;
  otherT: number;
  x: number;
  z: number;
  /** Deck heights either side, which must agree for the node to be flat. */
  y: number;
  otherY: number;
  /** Angle between the two centrelines, 0..pi/2. */
  angle: number;
}

/** Every place `road` crosses one of `others`. O(n*m); it runs once, on authoring. */
export function findCrossings(road: Road, others: readonly Road[]): Crossing[] {
  const out: Crossing[] = [];
  for (let i = 1; i < road.pts.length; i++) {
    const a0 = road.pts[i - 1];
    const a1 = road.pts[i];
    const rx = a1.x - a0.x;
    const rz = a1.z - a0.z;
    for (const other of others) {
      if (other === road) {
        continue;
      }
      for (let k = 1; k < other.pts.length; k++) {
        const b0 = other.pts[k - 1];
        const b1 = other.pts[k];
        const sx = b1.x - b0.x;
        const sz = b1.z - b0.z;
        const den = rx * sz - rz * sx;
        if (Math.abs(den) < 1e-9) {
          continue;
        } // parallel, or a degenerate segment
        const t = ((b0.x - a0.x) * sz - (b0.z - a0.z) * sx) / den;
        const u = ((b0.x - a0.x) * rz - (b0.z - a0.z) * rx) / den;
        if (t < 0 || t > 1 || u < 0 || u > 1) {
          continue;
        }
        const rl = Math.hypot(rx, rz) || 1;
        const sl = Math.hypot(sx, sz) || 1;
        // Unsigned: a crossing has no direction, so 175 degrees is 5 apart.
        const dot = Math.abs((rx * sx + rz * sz) / (rl * sl));
        out.push({
          seg: i,
          t,
          other,
          otherSeg: k,
          otherT: u,
          x: a0.x + rx * t,
          z: a0.z + rz * t,
          y: a0.y + (a1.y - a0.y) * t,
          otherY: b0.y + (b1.y - b0.y) * u,
          angle: Math.acos(Math.min(1, dot)),
        });
      }
    }
  }
  return out;
}

/** `findCrossings`' test against a bare line, for deciding where a path STARTS. */
export function runCrossesAny(
  roads: readonly Road[],
  ax: number,
  az: number,
  bx: number,
  bz: number,
): boolean {
  const rx = bx - ax;
  const rz = bz - az;
  for (const other of roads) {
    for (let k = 1; k < other.pts.length; k++) {
      const b0 = other.pts[k - 1];
      const b1 = other.pts[k];
      const sx = b1.x - b0.x;
      const sz = b1.z - b0.z;
      const den = rx * sz - rz * sx;
      if (Math.abs(den) < 1e-9) {
        continue;
      }
      const t = ((b0.x - ax) * sz - (b0.z - az) * sx) / den;
      const u = ((b0.x - ax) * rz - (b0.z - az) * rx) / den;
      // The run's start sits ON a road by construction, so skip its first 2%.
      if (t > 0.02 && t < 1 && u >= 0 && u <= 1) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Cut a path in two at (segment, t). The cut sample is SHARED, at one height, so the
 * halves meet rather than nearly meet. Each gets a zeroed trim plane at the node for
 * `build()` to square. See `Road.trim`.
 */
export function splitRoad(r: Road, seg: number, t: number, y: number): [Road, Road] {
  const a = r.pts[seg - 1];
  const b = r.pts[seg];
  const cut: RoadSample = {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    y,
    // A cut end inherits the span flag: half a bridge is not a thing.
    bridge: a.bridge || b.bridge,
  };
  const head: Road = {
    ...r,
    id: `${r.id}#a`,
    pts: [...r.pts.slice(0, seg), cut],
    trim: Float32Array.of(r.trim[0], r.trim[1], r.trim[2], r.trim[3], 0, 0, 0, 0),
  };
  const tail: Road = {
    ...r,
    id: `${r.id}#b`,
    pts: [cut, ...r.pts.slice(seg)],
    trim: Float32Array.of(0, 0, 0, 0, r.trim[4], r.trim[5], r.trim[6], r.trim[7]),
  };
  return [head, tail];
}

/**
 * How much of each arm a node holds dead level — the same 20 as `JUNCTION_HOLD` in
 * towns.ts. Agreeing at the node alone is not enough: outside `deckHalf` the surface
 * is `round(deck)`, which flips a WHOLE UNIT as two arms diverge.
 */
const NODE_HOLD = 20;

/**
 * Hold a split half level at the node height, then decay back onto its raw profile.
 * THE DELTA IS MEASURED WHERE THE HOLD ENDS, not at the node: the decay is a rigid
 * taper, so only that shift lands the first decaying sample on target.
 */
function holdAtNode(pts: RoadSample[], fromEnd: boolean, y: number): void {
  const idx = (k: number): number => (fromEnd ? pts.length - 1 - k : k);
  const flat = Math.round(NODE_HOLD / SEG_LEN);
  const joinK = Math.min(flat, pts.length - 1);
  const delta = y - pts[idx(joinK)].y;
  for (let k = 0; k < flat + 14; k++) {
    const j = idx(k);
    if (j < 0 || j >= pts.length) {
      break;
    }
    pts[j].y = k < flat ? y : pts[j].y + delta * (1 - (k - flat) / 14);
  }
}

/**
 * Largest deck disagreement a node can average away. Not `MAX_STEP_UP`: the mean
 * moves each deck by half of it and the decay spreads that over 14 samples, so 1.5
 * costs 0.036 of grade against MAX_GRADE 0.10. Past it, refused.
 */
const MERGE_MAX_DROP = 1.5;

export interface MergeReport {
  nodes: Array<{ x: number; z: number; y: number; arms: number }>;
  /** Crossings left alone, each with the reason. */
  refused: string[];
}

/** A crossing as a report label. */
const crossingAt = (c: { x: number; z: number }): string => `${c.x.toFixed(0)}, ${c.z.toFixed(0)}`;

/**
 * Turn the place `road` crosses the network into a junction (issue #142 §12e). ONE
 * CROSSING PER CALL: a split changes both polylines, so later crossings are indexed
 * against paths that no longer exist. The wider profile owns the node.
 */
export function mergeCrossings(net: RoadNetwork, road: Road): MergeReport {
  const report: MergeReport = { nodes: [], refused: [] };
  const hits = findCrossings(road, net.roads);
  if (hits.length === 0) {
    return report;
  }

  let chosen: Crossing | null = null;
  for (const c of hits) {
    // A glancing crossing is not a crossing. See `GLANCE_MIN`.
    if (c.angle < GLANCE_MIN) {
      report.refused.push(
        `${crossingAt(c)}: the two paths meet at ` +
          `${((c.angle * 180) / Math.PI).toFixed(0)} degrees — under ` +
          `${((GLANCE_MIN * 180) / Math.PI).toFixed(0)} they should share one run, ` +
          "which is not built",
      );
      continue;
    }
    // A junction mid-span is a hole in a bridge; `addBridgeFurniture` owns it.
    if (
      road.pts[c.seg].bridge ||
      road.pts[c.seg - 1].bridge ||
      c.other.pts[c.otherSeg].bridge ||
      c.other.pts[c.otherSeg - 1].bridge
    ) {
      report.refused.push(`${crossingAt(c)}: the crossing lands on a bridge span`);
      continue;
    }
    // Inside another apron there is no arm to grow: the ribbon is already clipped.
    const inApron = net.junctions.find(
      (j) => Math.hypot(c.x - j.x, c.z - j.z) < j.profile.apronR + road.profile.apronR,
    );
    if (inApron !== undefined) {
      report.refused.push(
        `${crossingAt(c)}: inside the apron already at ` +
          `${inApron.x.toFixed(0)}, ${inApron.z.toFixed(0)}`,
      );
      continue;
    }
    // Two decks at two heights make a step across the node. See MERGE_MAX_DROP.
    if (Math.abs(c.y - c.otherY) > MERGE_MAX_DROP) {
      report.refused.push(
        `${crossingAt(c)}: the decks are ` +
          `${Math.abs(c.y - c.otherY).toFixed(2)} apart, over the ${MERGE_MAX_DROP} ` +
          "a node can absorb",
      );
      continue;
    }
    // A one-sample half has no segment for its trim plane to square itself to.
    if (
      c.seg < 2 ||
      c.seg > road.pts.length - 2 ||
      c.otherSeg < 2 ||
      c.otherSeg > c.other.pts.length - 2
    ) {
      report.refused.push(`${crossingAt(c)}: too near the end of one of the two paths`);
      continue;
    }
    if (chosen === null) {
      chosen = c;
    } else {
      report.refused.push(`${crossingAt(c)}: only the first crossing of a path is merged`);
    }
  }
  if (chosen === null) {
    return report;
  }

  // One height, both decks eased into it: a grade change, not a step at the join.
  const y = (chosen.y + chosen.otherY) / 2;
  const [aHead, aTail] = splitRoad(road, chosen.seg, chosen.t, y);
  const [bHead, bTail] = splitRoad(chosen.other, chosen.otherSeg, chosen.otherT, y);
  // All four arms dead level across the node. See `NODE_HOLD`.
  holdAtNode(aHead.pts, true, y);
  holdAtNode(aTail.pts, false, y);
  holdAtNode(bHead.pts, true, y);
  holdAtNode(bTail.pts, false, y);
  net.replace(road, [aHead, aTail]);
  net.replace(chosen.other, [bHead, bTail]);
  // An apron sized to the narrower profile would be drawn under the wider rings.
  const profile =
    road.profile.deckEdge >= chosen.other.profile.deckEdge ? road.profile : chosen.other.profile;
  net.addJunction(chosen.x, chosen.z, y, profile);
  report.nodes.push({
    x: +chosen.x.toFixed(2),
    z: +chosen.z.toFixed(2),
    y: +y.toFixed(2),
    arms: 4,
  });
  return report;
}

/**
 * How much open water the straight line from A to B crosses, world units. Shared
 * by the router and the town planner so the two cannot disagree about a crossing.
 */
export function straightWetLength(
  terrain: Terrain,
  ax: number,
  az: number,
  bx: number,
  bz: number,
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
 * What a step pays for landing dead on an existing centreline. IT HAS TO BE BIG:
 * the charge is linear in a distance the walk changes 3 units at a time, so a
 * step's whole reward for moving away is a sixth of this against a climb term of
 * 3.4 per unit. Swept 3..70; below 14 nothing moves and above 50 it saturates.
 */
const AVOID_COST = 50;
/**
 * How much of an existing road, measured from the new route's own ends, is exempt.
 * A fork IS a shared point — roughly the radius of the junction apron.
 */
const AVOID_FREE = 12;

/**
 * Walk from (ax, az) to (bx, bz) preferring level ground. Greedy bearing search,
 * not A*: a road only has to LOOK like it followed the land, and this costs a few
 * hundred height queries. Four score terms — climb (dominant, so it hugs a
 * contour), turn away from the target, water, and `avoid` for an existing road.
 */
export function routeRoad(
  terrain: Terrain,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  seed: number,
  avoid: readonly RoadSample[][] = [],
  profile: PathProfile = ROAD_PROFILE,
): Array<{ x: number; z: number }> {
  const avoidR = profile.avoidR;
  // Go round or bridge, decided ONCE up front from the whole A-B line: a greedy
  // step sees three units, so it cannot know a detour costs two hundred. A cheap
  // per-step water charge drove the road into a lake and stayed in it; an
  // expensive one gave the world no bridges at all. A path that cannot bridge is
  // never in neck mode. See `PathProfile.bridges`.
  const neck = profile.bridges && straightWetLength(terrain, ax, az, bx, bz) <= NECK_MAX;
  // In neck mode a wet step is free and only depth is charged, so the crossing
  // takes the shallowest line; the walk must not second-guess the `neck` test.
  const waterCost = neck ? 0 : 26;
  const depthCost = neck ? 0.5 : 1.2;

  // Every sample of every routed road, minus those near either of this route's own
  // ENDS: a shared node is shared, so charging there would shove the path off it.
  // Both ends, not only the start — a path between two places that already have a
  // road arrives at a node it shares.
  const others: RoadSample[] = [];
  for (const road of avoid) {
    for (const p of road) {
      if (Math.hypot(p.x - ax, p.z - az) <= AVOID_FREE) {
        continue;
      }
      if (Math.hypot(p.x - bx, p.z - bz) <= AVOID_FREE) {
        continue;
      }
      others.push(p);
    }
  }
  /** Nearest existing carriageway to a candidate step, or Infinity. */
  const nearOther = (x: number, z: number): number => {
    let best = Infinity;
    for (const p of others) {
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < best) {
        best = d;
      }
    }
    return Math.sqrt(best);
  };

  const rng = mulberry32(seed);
  const pts: Array<{ x: number; z: number }> = [{ x: ax, z: az }];
  let cx = ax;
  let cz = az;
  let h = terrain.heightCont(cx, cz);
  // Iteration cap: a greedy walk could orbit a pathological basin. The fallback
  // (append the destination and let the profile smooth it) is benign.
  const maxSteps = Math.ceil((Math.hypot(bx - ax, bz - az) / SEG_LEN) * 3) + 12;
  for (let step = 0; step < maxSteps; step++) {
    const toB = Math.hypot(bx - cx, bz - cz);
    if (toB <= SEG_LEN * 1.5) {
      break;
    }
    const base = Math.atan2(bx - cx, bz - cz);
    let bestScore = Infinity;
    let bestX = cx;
    let bestZ = cz;
    let bestH = h;
    for (let k = -4; k <= 4; k++) {
      // The swing narrows near the destination, so no hook at the town gate.
      const spread = Math.min(0.3, 0.3 * (toB / 40));
      const ang = base + k * spread;
      const nx = cx + Math.sin(ang) * SEG_LEN;
      const nz = cz + Math.cos(ang) * SEG_LEN;
      const nh = terrain.heightCont(nx, nz);
      // A deck over water is FLAT, so the climb term must not see the bed — or a
      // deep channel scores as a descent and a climb and no bridge ever wins.
      const wet = nh < WATER_LEVEL + 0.4;
      const eff = wet ? WATER_LEVEL + 1.9 : nh;
      let score = Math.abs(eff - h) * 3.4 + Math.abs(k) * 0.42;
      // Depth is charged in both regimes, so a crossing takes the shallowest line.
      if (wet) {
        score += waterCost + (WATER_LEVEL - nh) * depthCost;
      }
      // Linear in how far inside `avoidR` the step lands: a nudge at the rim,
      // unpayable on the other road's gravel.
      if (others.length > 0) {
        const dOther = nearOther(nx, nz);
        if (dOther < avoidR) {
          score += AVOID_COST * (1 - dOther / avoidR);
        }
      }
      // A whisper of noise so two roads out of one junction do not lock onto the
      // same contour. A twelfth of one notch of turn — not enough on its own.
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

  // Smooth the plan view: nine discrete bearings zigzag by up to a sixth of a
  // radian. Three pinned 1-2-1 passes, which do not pull the line off its ground.
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
  pts: Array<{ x: number; z: number }>,
  step: number,
): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [{ x: pts[0].x, z: pts[0].z }];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1].x;
    const az = pts[i - 1].z;
    const dx = pts[i].x - ax;
    const dz = pts[i].z - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) {
      continue;
    }
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
 * Turn a route into a deck: elevation profile plus bridge flags. Four stages that
 * do NOT commute — smooth wide, floor clear of water (which makes a crossing a
 * bridge), slope-limit by RAISING only (so it cannot undo the floor, and it fills
 * dips like real cut-and-fill), then anchor both ends onto committed heights.
 *
 * `startY`/`endY` may be NaN — "whatever the profile says", which is how the first
 * road out of a town decides the town's height.
 *
 * `startHold`/`endHold` hold the deck DEAD LEVEL at that end's anchor height
 * before the correction decays. Pass a town's footprint: a deck drifting half a
 * unit below the town's height lays a 1-unit terrace down its high street.
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
  for (let i = 0; i < n; i++) {
    nat[i] = terrain.heightCont(route[i].x, route[i].z);
  }

  // 1. Wide box smooth. +-6 at SEG_LEN 3 is a 36-unit window, the scale of the
  // shelves and scarps the near ground carries (terrain.ts).
  const y = new Float32Array(n);
  const R = 6;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let cnt = 0;
    for (let k = -R; k <= R; k++) {
      const j = i + k;
      if (j < 0 || j >= n) {
        continue;
      }
      sum += nat[j];
      cnt++;
    }
    y[i] = sum / cnt;
  }

  // 2. Wet samples, widened by one either side so the deck is already at bridge
  // height where the abutment piers stand.
  const bridge = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (nat[i] < WATER_LEVEL + 0.35) {
      bridge[i] = 1;
    }
  }
  const wide = Uint8Array.from(bridge);
  for (let i = 0; i < n; i++) {
    if (!bridge[i]) {
      continue;
    }
    if (i > 0) {
      wide[i - 1] = 1;
    }
    if (i < n - 1) {
      wide[i + 1] = 1;
    }
  }

  const MAX_GRADE = 0.1;
  const rise = MAX_GRADE * SEG_LEN;
  const ANCHOR = 14;
  // 1.9 of air: reads as a bridge from the bank, keeps the abutment ramps short.
  const floorWater = (): void => {
    for (let i = 0; i < n; i++) {
      if (wide[i] && y[i] < WATER_LEVEL + 1.9) {
        y[i] = WATER_LEVEL + 1.9;
      }
    }
  };
  const slopeLimit = (passes: number): void => {
    for (let pass = 0; pass < passes; pass++) {
      for (let i = 1; i < n; i++) {
        if (y[i] < y[i - 1] - rise) {
          y[i] = y[i - 1] - rise;
        }
      }
      for (let i = n - 2; i >= 0; i--) {
        if (y[i] < y[i + 1] - rise) {
          y[i] = y[i + 1] - rise;
        }
      }
    }
  };
  // BOTH ANCHORS AT ONCE, never one after the other: applied in sequence, on a
  // path shorter than two tapers the one run last drags the other's end off its
  // target — a 6-sample waystone spur started 1.2 under the road deck it was
  // anchored to, a 1.126 step in the walking surface (issue #213). Each `hold`
  // is pinned flat; between the holds the two corrections cross-fade, each dying
  // over at most ANCHOR samples — over 42 units a 1-unit correction costs 0.024
  // of grade — and always by the other anchor's hold, so a short deck grades
  // evenly from target to target instead of hoarding the drop at one tail.
  //
  // THE DELTAS ARE MEASURED WHERE THE HOLDS END, not at the anchor samples: the
  // decay is a rigid taper (which keeps the road undulating with the land), so
  // only that shift lands the first decaying sample on `target`. Measured at the
  // anchor instead, a held stretch resumes 2.1 units off in one segment.
  const anchors = (): void => {
    const haveS = Number.isFinite(startY);
    const haveE = Number.isFinite(endY);
    if (!haveS && !haveE) {
      return;
    }
    const joinS = Math.min(Math.round(startHold / SEG_LEN), n - 1);
    const joinE = Math.max(n - 1 - Math.round(endHold / SEG_LEN), 0);
    const span = Math.max(1, joinE - joinS);
    const decay = Math.min(ANCHOR, span);
    const dS = haveS ? startY - y[joinS] : 0;
    const dE = haveE ? endY - y[joinE] : 0;
    for (let i = 0; i < n; i++) {
      if (haveE && i >= joinE) {
        y[i] = endY;
      } else if (haveS && i <= joinS) {
        y[i] = startY;
      } else {
        const wS = Math.max(0, 1 - (i - joinS) / decay);
        const wE = Math.max(0, 1 - (joinE - i) / decay);
        y[i] += (haveS ? dS * wS : 0) + (haveE ? dE * wE : 0);
      }
    }
  };

  // 3 & 4, TWICE: an anchor can LOWER, and one landing on a span pushes the deck
  // under the water the floor lifted it over. Alternating converges in two rounds,
  // and the final floor is the guarantee. Town heights are floored too (`levelAt`).
  for (let it = 0; it < 2; it++) {
    floorWater();
    slopeLimit(2);
    anchors();
  }
  floorWater();

  const out: RoadSample[] = Array.from({ length: n });
  for (let i = 0; i < n; i++) {
    out[i] = { x: route[i].x, z: route[i].z, y: y[i], bridge: wide[i] === 1 };
  }
  return out;
}

/**
 * A trail's deck is the FLOORED ground it is drawn on, per sample — the same
 * number the hero walks on where nothing carves, so ribbon and surface agree by
 * construction. `profileRoad` is the wrong machine here: smoothing and raise-only
 * slope limiting invent a deck the missing earthworks never come up to (measured
 * 7.8 units of float). No water floor either: a trail cannot bridge, so a wet
 * sample fords (issue #142 §11h).
 */
export function profileTrail(
  terrain: Terrain,
  route: Array<{ x: number; z: number }>,
): RoadSample[] {
  return route.map((p) => ({
    x: p.x,
    z: p.z,
    y: terrain.getHeight(p.x, p.z),
    bridge: false,
  }));
}

/**
 * Position and tangent at arc length `s` along a road, into `out`.
 * Used by the furniture pass and by the spawn search; never per frame.
 */
export function roadAt(
  r: Road,
  s: number,
  out: { x: number; y: number; z: number; dx: number; dz: number },
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
