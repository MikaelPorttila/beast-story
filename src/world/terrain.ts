/** Terrain height + biome authority. Pure functions of (seed, x, z), so
 * collision queries agree exactly with the rendered voxel columns. */
import { Noise2D, WaveField } from './noise';
import type { RimHit } from './roads';

/** The run a slope is measured over. See `Terrain.steepnessAt`. */
const SLOPE_RUN = 4;

export const WATER_LEVEL = 8;
export const CHUNK_SIZE = 32;

/** Where water stops being swimmable. A DEPTH, NOT A PLACE: shader, bed colour
 * and `World.isDeepWater` all compare the same heightfield. 4 is the first depth
 * whose bed the hero cannot reach (he dives to 3.4). */
export const DEEP_WATER_DEPTH = 4;
export const DEEP_WATER_TOP = WATER_LEVEL - DEEP_WATER_DEPTH;

/** 'trampled' and 'deepwater' are biomes because `props.ts` dispatches its
 * whole scatter off this enum, so they need no new tests there. */
export type BiomeId =
  'plains' | 'forest' | 'beach' | 'desert' | 'snow'
  | 'underwater' | 'deepwater' | 'trampled';

export interface FlattenDisc {
  x: number;
  z: number;
  /** Target continuous height (use H + 0.55 so the floored column equals H) */
  h: number;
  core: number;
  blend: number;
}

/**
 * A settlement's worn yard as a colour field in `columnInfo`, not a ribbon, so
 * it inherits the mesher's churn, curvature and litter. Declared here like
 * `FlattenDisc` so the dependency runs one way. Never on the collision path.
 */
export interface GroundPatch {
  x: number;
  z: number;
  /** Wear is undiminished inside this radius... */
  fade: number;
  /** ...and gone by this one. A soft rim, so a town is not a disc from the air. */
  edge: number;
  /** How worn the ground is away from any beaten track, 0..1. */
  base: number;
  /** Bias toward damp mud over dry packed earth, 0..1. The beaten tracks live
   * in the path network (issue #142), read via `RoadField.wearAt`. */
  damp: number;
}

/**
 * The road corridor as the height field sees it; declared here, not imported
 * from roads.ts, so the dependency runs one way. `carveAt` is the EARTHWORKS,
 * folded into `heightCont`. `surfaceAt` is the DECK: a floored column steps a
 * whole unit, which MAX_STEP_UP (0.5) refuses.
 */
export interface RoadField {
  /** Carve weight 0..1; target height in `carveTarget`, meaningful only when
   * the return is > 0. Split to stay allocation-free on the hot path. */
  carveAt(x: number, z: number): number;
  readonly carveTarget: number;
  /** The walking surface: `ground` off the road, the deck (or verge ramp) on it. */
  surfaceAt(x: number, z: number, ground: number): number;
  /** The DRAWN surface, which reaches past each terminal plane as carve does not. */
  drawnSurfaceAt(x: number, z: number, ground: number): number;
  /** Lowest drawn corridor surface within `r` — for a mesh coarser than a path. */
  lowestDrawnSurfaceNear(
    x: number, z: number, r: number, ground: number, rim?: RimHit,
  ): number;
  /** How walked the ground is, 0..1. A `columnInfo` query, never a collision one. */
  wearAt(x: number, z: number): number;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** sRGB -> linear. Vertex colours go into a BufferAttribute, which three.js
 * consumes as LINEAR, so hex must decode as `THREE.Color.setHex` does. */
const s2l = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

const rgb = (hex: number): RGB => ({
  r: s2l(((hex >> 16) & 255) / 255),
  g: s2l(((hex >> 8) & 255) / 255),
  b: s2l((hex & 255) / 255),
});

// sRGB hex; `rgb()` converts. Greens carry a RED AND BLUE FLOOR: the mesher's
// saturation link pushes chroma out 30%, and zero red takes no warm sun key.
const PLAIN_GRASS = rgb(0x6ec84a);
const WARM_GRASS = rgb(0xa8cf55);
const FOREST_GRASS = rgb(0x53a742);
/** Two LANDFORM stops pulled in by ALTITUDE — noise cannot know where hills are. */
const UPLAND_GRASS = rgb(0x7f9e66);
const LUSH_GRASS = rgb(0x3d9e3d);
// Two steps down from 0xefdca6, which sat so high on ACES it lost all detail.
const BEACH_SAND = rgb(0xdfc891);
const DESERT_SAND = rgb(0xd0ad63);
const SNOW = rgb(0xf2f7fd);
const DIRT = rgb(0x9a6a42);
const DIRT_COLD = rgb(0x8d7a6f);
const DIRT_SAND = rgb(0xc7a468);
const UW_SAND = rgb(0xd9c68f);
const UW_DEEP = rgb(0x587a70);
/** A third bed stop: UW_DEEP is tuned to read as silted green under a metre of
 * turquoise, which under the abyss's dark water looks like a paint job. */
const UW_ABYSS = rgb(0x223a45);
/**
 * Trodden ground, two stops. In the ROAD's colour family (town-parts.ts EARTH /
 * GRAVEL), not the terrain's red DIRT: the ribbon runs through the gate, and a
 * hue change there would draw the seam this exists to hide.
 */
const TRAMPLED_EARTH = rgb(0x83704e);
const TRAMPLED_MUD = rgb(0x463626);
export const STONE: RGB = rgb(0x8f9096);
export const STONE_WARM: RGB = rgb(0xc09a67);

export interface ColumnScratch {
  h: number;
  hc: number;
  topR: number;
  topG: number;
  topB: number;
  dirtR: number;
  dirtG: number;
  dirtB: number;
  /** 0..1 blend toward warm sandstone strata in cliffs */
  stoneWarm: number;
  /** 0..1 vegetated grass; gates the mesher's curvature tint and clover litter. */
  grass: number;
  /** 0..1 settlement wear. A CONTINUUM, unlike the 'trampled' biome, so the
   * prop passes can thin the sward across a town's fading rim. */
  trample: number;
  biome: BiomeId;
}

export function makeScratch(): ColumnScratch {
  return {
    h: 0, hc: 0,
    topR: 0, topG: 0, topB: 0,
    dirtR: 0, dirtG: 0, dirtB: 0,
    stoneWarm: 0,
    grass: 0,
    trample: 0,
    biome: 'plains',
  };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function smoothstep(a: number, b: number, v: number): number {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

function mix(out: RGB, a: RGB, b: RGB, t: number): void {
  out.r = a.r + (b.r - a.r) * t;
  out.g = a.g + (b.g - a.g) * t;
  out.b = a.b + (b.b - a.b) * t;
}

export class Terrain {
  readonly seed: number;
  readonly flattens: FlattenDisc[] = [];
  /** Filled by `planSettlements`; empty with `towns=0` or in the dungeon. */
  readonly grounds: GroundPatch[] = [];

  /** The road corridor, or null. Mutable, not a constructor argument, for
   * ordering: routes are planned off THIS terrain's natural heights. */
  roads: RoadField | null = null;

  /** Ground-colour drift; public so the mesher shares the seeded field. A
   * WaveField, not Noise2D — a lattice reads as a chequerboard. */
  readonly groundW: WaveField;

  /** Landform-scale meadow HUE drift (moss <-> sun-bleached), ~30 units. */
  private readonly hueW: WaveField;
  /** Mid-scale patch value wash, ~14 units. */
  private readonly patchW: WaveField;
  /** Near-cube-frequency surface tooth, ~3 units. */
  private readonly toothW: WaveField;
  /** RUT-scale churn, ~7 units. Its own field because `toothW`'s top harmonic
   * is below cube frequency and aliases into a chequer when driven hard. */
  private readonly churnW: WaveField;

  private readonly continentN: Noise2D;
  private readonly hillN: Noise2D;
  private readonly ridgeN: Noise2D;
  private readonly maskN: Noise2D;
  private readonly tempN: Noise2D;
  private readonly moistN: Noise2D;
  private readonly plateauN: Noise2D;
  private readonly shelfN: Noise2D;
  private readonly scarpN: Noise2D;

  private readonly tmpA: RGB = { r: 0, g: 0, b: 0 };
  private readonly tmpB: RGB = { r: 0, g: 0, b: 0 };

  private trampleTrack = 0;
  private trampleDamp = 0;

  constructor(seed: number) {
    this.seed = seed | 0;
    this.continentN = new Noise2D(this.seed + 101);
    this.hillN = new Noise2D(this.seed + 211);
    this.ridgeN = new Noise2D(this.seed + 331);
    this.maskN = new Noise2D(this.seed + 443);
    this.tempN = new Noise2D(this.seed + 557);
    this.moistN = new Noise2D(this.seed + 661);
    this.plateauN = new Noise2D(this.seed + 1013);
    this.shelfN = new Noise2D(this.seed + 1123);
    this.scarpN = new Noise2D(this.seed + 1229);
    // Base frequency is radians per world unit; each field gets its own seed.
    this.groundW = new WaveField(this.seed + 1279, 0.28);
    this.hueW = new WaveField(this.seed + 1381, 0.21);
    this.patchW = new WaveField(this.seed + 1487, 0.45);
    this.toothW = new WaveField(this.seed + 1601, 2.05, 5, 1.47, 0.62);
    this.churnW = new WaveField(this.seed + 1721, 0.85, 4, 1.35, 0.68);
  }

  /** Continuous terrain height at any world xz (flatten discs applied). */
  heightCont(x: number, z: number): number {
    const c = this.continentN.fbm(x * 0.0045, z * 0.0045, 4);
    let h = 9.2 + c * 10.5;
    h += this.hillN.fbm(x * 0.02, z * 0.02, 3) * 2.6;
    // Fine relief: without it `floor()` makes huge plateaus where corner AO
    // bakes nothing. Two unrelated frequencies, or a lattice's diamonds print
    // into the landform. DAMPED under water — bed ripple bands the depth ramp.
    const fine =
      this.hillN.sample(x * 0.084 + 91.3, z * 0.084 - 44.7) * 0.29 +
      this.hillN.sample(z * 0.037 - 12.9, x * 0.037 + 61.1) * 0.16;
    h += fine * (0.25 + 0.75 * smoothstep(WATER_LEVEL - 1, WATER_LEVEL + 3, h));
    // Ridges: wide gate + high mask frequency so most vistas hold a ridgeline.
    const mk = smoothstep(-0.10, 0.32, this.maskN.fbm(x * 0.0042, z * 0.0042, 3));
    if (mk > 0) {
      const rd = this.ridgeN.ridged(x * 0.009, z * 0.009, 4);
      // The highland term is ADDITIVE and gated to the top few percent: raising
      // the ridge exponent instead sank the map below the beach threshold.
      h += mk * (rd * rd * 58 + smoothstep(0.62, 0.95, rd) * 34);
    }
    // Mesas. `sample`, not fbm — hot path. The 4m quantise is gated behind the
    // ridge mask; globally it terraced every meadow swell into a wedding cake.
    const pl = this.plateauN.sample(x * 0.0022, z * 0.0022) * 0.5 + 0.5;
    const mesa = smoothstep(0.55, 0.75, pl) * 14;
    if (mesa > 0) {
      if (mk > 0.45) h += Math.round(mesa * 0.25) * 4;
      else h += mesa * 0.6;
    }
    // Shelves and scarps: macro form for the NEAR ground, which otherwise has
    // only the 1-unit risers a smooth field through `floor()` can make.
    // THRESHOLDED, not quantised — thresholding raises closed ISLANDS you walk
    // around, where iso-line steps would fence the map. Heights MODULATED by a
    // finer field so each bench is a WEDGE with a low side you can jump up.
    // Damped at the waterline, as `fine` is: bed relief becomes contour banding.
    const dry = smoothstep(WATER_LEVEL + 0.6, WATER_LEVEL + 2.2, h);
    if (dry > 0) {
      const shf = this.shelfN.sample(x * 0.021, z * 0.021) * 0.5 + 0.5;
      const scf = this.scarpN.sample(x * 0.013, z * 0.013) * 0.5 + 0.5;
      const ramp = this.shelfN.sample(x * 0.038 + 137.4, z * 0.038 - 211.9) * 0.5 + 0.5;
      h += dry * (smoothstep(0.716, 0.7235, shf) * (1.6 + ramp * 4.0)
        + smoothstep(0.880, 0.887, scf) * (2.0 + ramp * 4.4));
    }
    // The deep sea, the same idea downward: base height left no column more
    // than 1-3 under, so there was no OPEN SEA. Gated on existing depth, so it
    // never touches the tide line the chamfer and water ramp are tuned against.
    // MODULATED, or every bay sinks alike into a machined bowl.
    const wet = smoothstep(WATER_LEVEL - 0.4, WATER_LEVEL - 3.0, h);
    if (wet > 0) {
      const basin = this.plateauN.sample(x * 0.0035 + 57.1, z * 0.0035 - 88.3) * 0.5 + 0.5;
      h -= wet * (0.9 + smoothstep(0.30, 0.74, basin) * 3.5);
    }
    for (let i = 0; i < this.flattens.length; i++) {
      const f = this.flattens[i];
      const dx = x - f.x;
      const dz = z - f.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < f.blend) {
        const w = 1 - smoothstep(f.core, f.blend, d);
        h += (f.h - h) * w;
      }
    }
    // Roads LAST, after the flatten discs, so a road into a town is cut through
    // whatever the town levelled rather than fighting it.
    const rf = this.roads;
    if (rf !== null) {
      const w = rf.carveAt(x, z);
      if (w > 0) h += (rf.carveTarget - h) * w;
    }
    return h < 1.2 ? 1.2 : h > 78 ? 78 : h;
  }

  /**
   * Integer top surface of the column at (cx, cz), and it must stay INTEGER:
   * a fractional top tears black gaps along the verge (side quads assume whole
   * units), and clipping to a whole unit puts a 1.0 step on the carriageway
   * against MAX_STEP_UP 0.5. Cube corners are handled when drawing instead.
   */
  columnHeight(cx: number, cz: number): number {
    const h = Math.floor(this.heightCont(cx + 0.5, cz + 0.5));
    return h < 1 ? 1 : h;
  }

  /** Collision authority: stepped, matching the voxels — EXCEPT on a road, where
   * it is the continuous deck, since whole-unit columns would be a staircase
   * MAX_STEP_UP refuses. Everything in the game resolves against this. */
  getHeight(x: number, z: number): number {
    const g = this.columnHeight(Math.floor(x), Math.floor(z));
    const rf = this.roads;
    return rf === null ? g : rf.surfaceAt(x, z, g);
  }

  /**
   * Rise over run, so 0.5 is one in two. There is no MOUNTAIN biome — it is
   * slope and altitude (issue #142 §11e). CONTINUOUS, or a floored column reads
   * every gentle slope as a staircase; `SLOPE_RUN` 4 is the compromise between
   * reading the fine relief and averaging a cliff away.
   */
  steepnessAt(x: number, z: number): number {
    const r = SLOPE_RUN;
    const dx = this.heightCont(x + r, z) - this.heightCont(x - r, z);
    const dz = this.heightCont(x, z + r) - this.heightCont(x, z - r);
    return Math.hypot(dx, dz) / (2 * r);
  }

  /**
   * Snow cover 0..1 — `columnInfo`'s `snowW` alone, as a CONTINUUM: the snow
   * line is a 5-unit smoothstep about a wandering altitude. Costs about a
   * `getHeight`. Takes CONTINUOUS x/z, unlike `columnInfo`'s cell indices.
   */
  snowCoverAt(x: number, z: number): number {
    const hc = this.heightCont(x, z);
    const temp = this.tempN.fbm(x * 0.0035, z * 0.0035, 3);
    const snowLine = 23 + temp * 6;
    return smoothstep(snowLine - 2.5, snowLine + 2.5, hc);
  }

  /**
   * Settlement wear 0..1, leaving `trampleTrack` (track wear alone, which tells
   * dry road from mud) and `trampleDamp` behind so one scan allocates nothing.
   * A `columnInfo` query only, never the collision path.
   */
  trampleAt(x: number, z: number): number {
    let best = 0;
    this.trampleTrack = 0;
    this.trampleDamp = 0;
    for (let i = 0; i < this.grounds.length; i++) {
      const p = this.grounds[i];
      const dx = x - p.x;
      const dz = z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= p.edge * p.edge) continue;
      // The tracks, from the path network (issue #142). Asked once for the whole
      // settlement: one bucket scan rather than a test per track.
      const track = this.roads === null ? 0 : this.roads.wearAt(x, z);
      // Wear must not stop on a circle, so fade it between `fade` and `edge`.
      const rim = 1 - smoothstep(p.fade, p.edge, Math.sqrt(d2));
      const w = (track > p.base ? track : p.base) * rim;
      if (w > best) {
        best = w;
        this.trampleTrack = track * rim;
        this.trampleDamp = p.damp;
      }
    }
    return best;
  }

  /** Full biome/color info for one column (writes into `out`, no allocs). */
  columnInfo(cx: number, cz: number, out: ColumnScratch): void {
    const x = cx + 0.5;
    const z = cz + 0.5;
    const hc = this.heightCont(x, z);
    const h = Math.max(1, Math.floor(hc));
    const temp = this.tempN.fbm(x * 0.0035, z * 0.0035, 3);
    const moist = this.moistN.fbm(x * 0.004, z * 0.004, 3);

    const snowLine = 23 + temp * 6;
    const snowW = smoothstep(snowLine - 2.5, snowLine + 2.5, hc);
    const desertW =
      smoothstep(0.12, 0.42, temp) *
      smoothstep(0.02, -0.28, moist) *
      smoothstep(19, 13, hc) *
      (1 - snowW);
    const beachW = smoothstep(11.6, 9.7, hc) * (1 - snowW);
    const sandW = Math.max(beachW, desertW);
    const forestF = smoothstep(-0.03, 0.2, moist) * (1 - snowW) * (1 - sandW);
    const warmT = clamp01(temp * 0.5 + 0.35);

    const tA = this.tmpA;
    const tB = this.tmpB;
    // Meadow HUE mottling, not value: hue over tens of units reads as terrain
    // where value between flat faces resolves as a chequer. TWO scales, or the
    // ~30-unit field is one slow wash across a whole hillside.
    const hueDrift = this.hueW.sample(x, z);
    const patchHue = this.patchW.sample(x, z);
    mix(tA, PLAIN_GRASS, WARM_GRASS, clamp01(warmT + hueDrift * 0.56 + patchHue * 0.30));
    mix(tA, tA, FOREST_GRASS, clamp01(
      forestF * 0.85 + Math.max(-hueDrift, 0) * 0.42 + Math.max(-patchHue, 0) * 0.22,
    ));

    // Altitude tint, a function of the TERRAIN rather than noise, so a hillside
    // and the valley under it can never come out the same green.
    const lowW = smoothstep(14.5, 9.5, hc);
    const altW = smoothstep(16, snowLine - 3, hc);
    mix(tA, tA, LUSH_GRASS, lowW * 0.42);
    mix(tA, tA, UPLAND_GRASS, altW * 0.62);
    // Regional richness off the ~250-unit moisture field already sampled for
    // `forestF`: dry country bleaches its sward, wet country deepens it.
    const rich = 0.905 + smoothstep(-0.28, 0.30, moist) * 0.215;
    tA.r *= rich;
    tA.g *= rich;
    tA.b *= rich;

    mix(tB, BEACH_SAND, DESERT_SAND, clamp01(desertW * 1.5));
    // DUNE-scale sand drift, reusing fields already sampled. Sand has no hue for
    // per-cube jitter to ride on, so per-cube value resolved as a chequer.
    const duneV = 1 + hueDrift * 0.085 + patchHue * 0.048;
    const duneW = patchHue * 0.062 - hueDrift * 0.038;
    tB.r *= duneV * (1 + duneW);
    tB.g *= duneV;
    tB.b *= duneV * (1 - duneW * 1.5);
    mix(tA, tA, tB, sandW);
    mix(tA, tA, SNOW, snowW);

    // Mid-scale patch value wash, ±2.5%. Small on purpose: at ±6% it was the
    // biggest contributor to the diamond plaid, and hue is the lever anyway.
    const pm = 1 + patchHue * 0.025;
    tA.r *= pm;
    tA.g *= pm;
    tA.b *= pm;

    // Surface tooth, ~3 units, ±3% — just above cube frequency, so it never
    // resolves into a shape; it only stops two neighbours being identical.
    const tooth = this.toothW.sample(x, z);
    const dm = 1 + tooth * 0.03;
    tA.r *= dm;
    tA.g *= dm;
    tA.b *= dm;

    // Trodden ground. Mud vs packed earth blends three noise scales against the
    // TRACKS negatively — daily traffic packs ground too hard to hold water.
    const wear = this.grounds.length > 0 ? this.trampleAt(x, z) : 0;
    if (wear > 0) {
      const churn = this.churnW.sample(x, z);
      // 0.75, not 0.95: at 0.95 nine tracks radiating from a camp centre cleared
      // the mud term outright and the whole disc flattened to one brown plate.
      const mud = clamp01(
        this.trampleDamp + patchHue * 0.85 + hueDrift * 0.40 + churn * 0.55
        - this.trampleTrack * 0.75,
      );
      mix(tB, TRAMPLED_EARTH, TRAMPLED_MUD, mud);
      // ±17% churn value. Safe at that amplitude because it is NOT per-cube, and
      // it needs to be: sRGB is a ~1/2.4 power, so this is ~7 code values.
      const ch = 1 + churn * 0.17 + patchHue * 0.05 + tooth * 0.025
        + this.trampleTrack * 0.06;
      tB.r *= ch;
      tB.g *= ch;
      tB.b *= ch;
      // COLOUR LEADS THE PROPS: `1 - (1 - wear)^2` makes a half-worn column 75%
      // earth while only half its grass is culled — bare ground with tussocks.
      mix(tA, tA, tB, wear * (2 - wear));
    }

    // Lake bed, plus the damp strip 0.7 ABOVE the waterline: cutting exactly at
    // WATER_LEVEL left sandbars a few centimetres proud as hard-edged tan slabs.
    if (hc < WATER_LEVEL + 0.7) {
      const d = smoothstep(-0.7, 6, WATER_LEVEL - hc);
      mix(tA, UW_SAND, UW_DEEP, d);
      // Into the abyss, sharing thresholds with the shader's DEEP_DARK ramp.
      // Ramped, not switched: a hard line reads as a drawn contour.
      const a = smoothstep(0, 1.6, DEEP_WATER_TOP + 0.7 - hc);
      if (a > 0) mix(tA, tA, UW_ABYSS, a);
    }

    out.topR = tA.r;
    out.topG = tA.g;
    out.topB = tA.b;

    mix(tB, DIRT, DIRT_SAND, sandW);
    mix(tB, tB, DIRT_COLD, snowW);
    out.dirtR = tB.r;
    out.dirtG = tB.g;
    out.dirtB = tB.b;

    out.stoneWarm = clamp01(desertW * 1.3 + sandW * 0.3);
    // Folding wear into `grass` switches the mesher off the whole meadow
    // treatment: curvature read, clover litter and saturation link all gate here.
    out.grass = hc < WATER_LEVEL + 0.3 ? 0
      : clamp01((1 - sandW) * (1 - snowW) * (1 - wear));
    out.trample = wear;
    // No clamp against the road surface: every sample sticking through was the
    // RIBBON sagging (fixed in `sectionAt` and distant-terrain.ts).
    out.h = h;
    out.hc = hc;
    // wear > 0.6 is where props.ts stops thinning the sward and refuses it, and
    // it must sit inside the settlement: bare to the palisade, tussocks outside.
    out.biome =
      // `h`, not `hc`: `isDeepWater` compares the STEPPED column, and a
      // fraction's disagreement puts swimmable dark water round every basin.
      h <= DEEP_WATER_TOP ? 'deepwater'
      : hc < WATER_LEVEL + 0.4 ? 'underwater'
      : wear > 0.6 ? 'trampled'
      : snowW > 0.5 ? 'snow'
      : desertW > 0.5 ? 'desert'
      : beachW > 0.5 ? 'beach'
      : forestF > 0.5 ? 'forest'
      : 'plains';
  }
}
