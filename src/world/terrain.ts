/**
 * Terrain height + biome authority. Pure functions of (seed, x, z) so
 * collision queries agree exactly with the rendered voxel columns.
 */
import { Noise2D, WaveField } from './noise';

export const WATER_LEVEL = 8;
export const CHUNK_SIZE = 32;

/**
 * 'trampled' is not a climate — it is the yard of a SETTLEMENT, and it is a
 * biome for one reason: `props.ts` dispatches its whole vegetation scatter off
 * this enum, so a column that reports 'trampled' grows nothing without a single
 * new test anywhere in that file. See `GroundPatch`.
 */
export type BiomeId =
  'plains' | 'forest' | 'beach' | 'desert' | 'snow' | 'underwater' | 'trampled';

export interface FlattenDisc {
  x: number;
  z: number;
  /** Target continuous height (use H + 0.55 so the floored column equals H) */
  h: number;
  core: number;
  blend: number;
}

/**
 * TRODDEN GROUND — the ground a settlement has worn out, as a colour field.
 *
 * A town is already three things stacked on the same coordinates (a flatten
 * disc, a prop exclusion and a merged mesh — see towns.ts); this is the fourth,
 * and it is the one that makes the other three read as a place people live in
 * rather than a model dropped on a lawn. Months of feet do two things to
 * ground: they kill the grass, and they leave a surface that is dry packed
 * earth where the traffic is heaviest and churned mud everywhere else.
 *
 * DECLARED HERE, LIKE `FlattenDisc`, AND FOR THE SAME REASON: terrain knows
 * there are *patches*, towns.ts knows what a Terrain is, and neither imports
 * the other's implementation. Every field is derivable from a `TownInfo`, so a
 * fourth entry in `SITES` gets trodden ground with no new code.
 *
 * WHY IT IS A COLOUR PATCH AND NOT A MESH. The road solves the same problem
 * with a RIBBON — a strip of geometry on the terrain material, drawn over the
 * carriageway (town-parts.ts `buildRoadRibbon`) — and that is right for a road,
 * whose surface is a graded deck the terrain underneath is deliberately NOT.
 * A camp yard is not a deck: it is the ground itself, at the ground's own
 * height, with the ground's own 1-unit steps and corner AO. Baking it into
 * `columnInfo` instead costs no geometry, no draw call and no material, and it
 * arrives with every one of the mesher's existing tricks (per-cube churn, the
 * curvature read, the litter picks) already applied to it.
 *
 * COST. `trampleAt` runs in `columnInfo` — chunk build, ~1156 columns a chunk —
 * and NEVER in `heightCont`/`getHeight`, which are on the collision hot path.
 * A world has a handful of patches and each is rejected by one squared-distance
 * compare, so a column outside every settlement pays three compares.
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
  /**
   * The beaten tracks, four numbers each: the far end of a line that starts at
   * the settlement's centre (dx, dz, relative to x/z), the half-width of the
   * track, and how worn it is at its middle.
   *
   * A flat `Float32Array` rather than an array of objects because this is
   * scanned once per column of every chunk that touches a settlement, and the
   * query must not chase pointers or allocate — the same reason
   * `RoadNetwork.seg` is one.
   */
  paths: Float32Array;
  /**
   * Bias toward damp mud rather than dry packed earth, 0..1. A military camp
   * churns; a farming hamlet mostly wears its grass thin.
   */
  damp: number;
}

/**
 * The carved-road corridor, as the height field sees it.
 *
 * Declared HERE rather than imported from world/roads.ts so the dependency runs
 * one way: terrain knows there is *a* road field, roads.ts knows what a Terrain
 * is, and neither module has to import the other's implementation. Same reason
 * `flattens` is a plain array of discs rather than a reference to the shop
 * system that fills it.
 *
 * Two questions, because a road changes the ground in two different ways:
 *
 *  - `carveAt` is the EARTHWORKS. It answers "how strongly is the terrain here
 *    pulled toward the roadbed, and to what height" and is folded into
 *    `heightCont` alongside the flatten discs, so the cut through a hillside and
 *    the embankment across a dip are real terrain that the mesher, the props and
 *    every other height query see for free.
 *  - `surfaceAt` is the DECK. The carriageway is a CONTINUOUS surface — the
 *    whole point of carving a road is that you can walk it, and a floored
 *    integer column can only ever step a whole unit, which MAX_STEP_UP (0.5)
 *    refuses. So on the road, and only on the road, `getHeight` hands back the
 *    smooth deck height instead of the stepped column, and ramps back onto the
 *    column over a two-unit verge so there is no step at the edge either.
 */
export interface RoadField {
  /**
   * Carve weight 0..1 at (x, z); the target height is left in `carveTarget`,
   * which is only meaningful when the return value is > 0. Split that way to
   * keep the query allocation-free on the collision hot path.
   */
  carveAt(x: number, z: number): number;
  readonly carveTarget: number;
  /** The walking surface: `ground` off the road, the deck (or verge ramp) on it. */
  surfaceAt(x: number, z: number, ground: number): number;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * sRGB -> linear transfer. Terrain vertex colours are written straight into a
 * BufferAttribute, which three.js consumes as LINEAR values, so a hex literal
 * has to be decoded the same way `THREE.Color.setHex` would.
 *
 * This used to be a bare /255, i.e. sRGB numbers fed in as linear. Every ground
 * colour then came out roughly `c^(1/2.2)` too bright and desaturated —
 * 0x54c832 grass rendered as #99E67A pale mint — which is precisely why the
 * meadows read as flat mint slabs no matter how much value noise was piled on
 * top: the palette was sitting in the compressed top end of the transfer curve
 * where nothing has contrast left. It also put the terrain on a different
 * colour convention from every prop and creature (VoxelModel goes through
 * THREE.Color, which converts), so ground and trees never matched.
 */
const s2l = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

const rgb = (hex: number): RGB => ({
  r: s2l(((hex >> 16) & 255) / 255),
  g: s2l(((hex >> 8) & 255) / 255),
  b: s2l((hex & 255) / 255),
});

// -- Palette (vibrant Cube World grading) -----------------------------------
// Authored as sRGB hex, exactly as they would be picked in an image editor;
// `rgb()` above converts. Sun (2.55) + hemisphere fill land these at roughly
// 0.9x, so what you pick is close to what you get before the grade.
// The greens all carry a RED AND BLUE FLOOR now, and that is a measured fix, not
// a taste change. At 0x54c832 the red channel is 0.0885 LINEAR; the mesher then
// runs a saturation link that can push chroma out by another 30%, and the critic
// sampled sunlit grass tops at rgb(0, 112, 3) and rgb(1, 106, 12) — literally no
// red left. A surface with a zero red channel cannot receive the sun's 0xffebbe
// warmth or the sky's blue fill, so the entire warm-key/cool-shadow scheme the
// engine is built around was being discarded on the single largest surface in the
// game, and every grass pixel in the world collapsed onto one hue.
//
// 0x54c832 -> 0x6ec84a raises red 0.0885 -> 0.154 and blue 0.0319 -> 0.0684
// without touching green, so the hue barely moves (it is still a clean mid green)
// but there is now headroom for the light to tint it. Same treatment for the warm
// and forest stops.
const PLAIN_GRASS = rgb(0x6ec84a);
const WARM_GRASS = rgb(0xa8cf55);
const FOREST_GRASS = rgb(0x53a742);
/**
 * Two LANDFORM-scale grass stops the plain/warm/forest blend is pulled toward
 * after the fact, driven by altitude rather than by noise.
 *
 * The colour survey's headline was that the world has six hues total — one green,
 * one sand, one rock, one water, one sky, one trunk — and that Cube World re-tints
 * its ground per biome and per elevation. Everything the meadow varied by until
 * now was a noise field, and noise cannot know where the landforms are: a hillside
 * and the valley floor beside it got statistically identical grass, so a vista had
 * no colour structure at the only scale a vista reads at.
 *
 * UPLAND is a cool, desaturated sage — what grass looks like on thin, exposed,
 * wind-scoured ground approaching the treeline. LUSH is the deep wet green of a
 * valley bottom near standing water. They are blended by height, so a single frame
 * that contains a shore, a meadow and a ridge now contains three greens that a
 * squint can separate.
 */
const UPLAND_GRASS = rgb(0x7f9e66);
const LUSH_GRASS = rgb(0x3d9e3d);
// Sands are two steps darker than they were. At 0xefdca6 the beach sat so high
// on the ACES curve that nothing applied to it survived to the screen — the
// per-cube jitter, the litter and the slope shading all compressed into one
// beige, and a shoreline could fill a third of a frame with a single value.
// Dropping the base leaves room for all three to read.
const BEACH_SAND = rgb(0xdfc891);
const DESERT_SAND = rgb(0xd0ad63);
const SNOW = rgb(0xf2f7fd);
const DIRT = rgb(0x9a6a42);
const DIRT_COLD = rgb(0x8d7a6f);
const DIRT_SAND = rgb(0xc7a468);
const UW_SAND = rgb(0xd9c68f);
const UW_DEEP = rgb(0x587a70);
/**
 * TRODDEN SETTLEMENT GROUND, two stops: earth beaten dry and hard along the
 * lines people walk, and the dark churned mud that gathers everywhere else.
 *
 * Picked in the ROAD's colour family (town-parts.ts: RUT 0x6b5843 under the
 * wheels, EARTH 0x8a7a60, GRAVEL 0x9a8f79 at the verge) and deliberately NOT in
 * the terrain's own DIRT 0x9a6a42, which is a red subsoil for cliff faces. The
 * carved road runs THROUGH the gate and into the camp, so the ribbon's verge
 * and the camp's own ground are adjacent surfaces a couple of metres apart: a
 * red-brown yard against a grey-brown road would draw exactly the seam this
 * treatment exists to remove. 0x8e7c5a sits between the road's EARTH and its
 * GRAVEL, so the gate line is a change of texture rather than of hue.
 *
 * The mud is DARK — under a third of the earth's luminance. Sun (3.05) plus the
 * hemisphere fill land these near 0.9x, so a yard blotched between them carries
 * a 3:1 value spread, which is what makes it read as churned rather than as one
 * flat brown plate — the whole failure mode a single dirt colour has.
 *
 * Both are two steps DOWN from the first pass (0x8e7c5a / 0x4f3d2c), which
 * captured (_camp-ground.png) as a pale olive-khaki rather than as earth: at
 * that value the yard sat above the road ribbon it is supposed to meet, so the
 * gate showed the seam the palette was chosen to hide, and the residual green
 * left by a wear of 0.92 tinted the whole thing toward moss. The camp's wear is
 * now a flat 1.0 as well, so no grass survives in the mix to do that.
 */
const TRAMPLED_EARTH = rgb(0x83704e);
const TRAMPLED_MUD = rgb(0x463626);
export const STONE: RGB = rgb(0x8f9096);
export const STONE_WARM: RGB = rgb(0xc09a67);

export interface ColumnScratch {
  /** Integer top surface world-y (top face sits exactly at this y) */
  h: number;
  /** Continuous height before flooring */
  hc: number;
  topR: number;
  topG: number;
  topB: number;
  dirtR: number;
  dirtG: number;
  dirtB: number;
  /** 0..1 blend toward warm sandstone strata in cliffs */
  stoneWarm: number;
  /**
   * 0..1 "this column is vegetated grass". The mesher gates its curvature
   * tinting and clover litter on this so sand, snow and lake beds never sprout
   * meadow detail.
   */
  grass: number;
  /**
   * 0..1 "a settlement has worn this column out" — see `GroundPatch`.
   *
   * A CONTINUUM rather than the `biome` boolean, and both exist for the same
   * reason `snowCoverAt` is a continuum: the wear fades over several metres at
   * the edge of a town, and that ring is where the world stops being a camp and
   * starts being a meadow again. `biome` flips to 'trampled' only in the worn
   * heart, so the prop passes have this to thin the sward out with on the way.
   */
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
  /**
   * The settlements' trodden yards. Filled by `planSettlements` in the same
   * pass that pushes the flatten discs, and empty in a world with no towns
   * (`towns=0`) or in the dungeon.
   */
  readonly grounds: GroundPatch[] = [];

  /**
   * The road corridor, or null in a world that has no roads.
   *
   * Assigned once by `createWorld` after the routes are planned, and never
   * reassigned — the routes are planned by asking THIS terrain for its natural
   * heights, so the field has to be absent while that happens and present
   * forever after. Public and mutable rather than a constructor argument for
   * exactly that ordering reason; `flattens` is filled the same way.
   */
  roads: RoadField | null = null;

  /**
   * Ground-colour drift field. Public because the chunk mesher bakes a
   * landform-scale value wash into vertex colours and must draw from the same
   * seeded field rather than inventing a grid of its own.
   *
   * A WaveField, not a Noise2D, for the reason spelled out at WaveField's
   * declaration: every colour field this world ever put on a lattice ended up
   * filed as a chequerboard.
   */
  readonly groundW: WaveField;

  /** Landform-scale meadow HUE drift (moss <-> sun-bleached), ~30 units. */
  private readonly hueW: WaveField;
  /** Mid-scale patch value wash, ~14 units. */
  private readonly patchW: WaveField;
  /** Near-cube-frequency surface tooth, ~3 units. */
  private readonly toothW: WaveField;
  /**
   * RUT-scale churn for trodden ground, ~7 units, and the reason it is its own
   * field rather than more of `toothW`.
   *
   * The first pass drove the camp's churn off `toothW` at ±9% and captured
   * (_camp-ground.png) as an unmistakable one-cube chequerboard — the artefact
   * this file's history keeps rediscovering, arrived at from a new direction.
   * `toothW` is deliberately built with five waves at a 1.47 ratio from
   * 2.05 rad/unit, so its top harmonic is 9.6 rad/unit: a 0.65-unit wavelength,
   * BELOW cube frequency, which aliases into a chequer the moment it is sampled
   * at cube centres with real amplitude. At ±3% that is invisible and the field
   * earns its keep; at ±9% it is the grid.
   *
   * This one is built the other way round on purpose: four waves at 1.35 from
   * 0.85 rad/unit, so the coarsest feature is ~7.4 units and the FINEST is
   * still 3.0 — above cube frequency by a factor of three, with nothing in the
   * spectrum that can alias however hard it is driven. Seven units is also the
   * scale a churned yard actually varies at: a cart rut, a puddle, the patch in
   * front of a tent door.
   */
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

  /** Filled by `trampleAt`; see there. Never read from outside this class. */
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
    // Base frequencies are radians per world unit: 2*PI/f is the coarsest
    // feature size. 0.21 -> ~30 units, 0.45 -> ~14 units, 2.05 -> ~3 units
    // (just above cube frequency, where a field stops being a readable shape and
    // becomes surface tooth). Each gets its own seed so the three cannot align.
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
    // Fine relief — the change that makes the ground read as Cube World rather
    // than as a lawn.
    //
    // Everything above is smooth at a scale of 50+ units, so `floor()` produced
    // enormous single-height plateaus: shots of the near meadow showed 10x10
    // voxel expanses at exactly one y. On a flat plateau every column's eight
    // neighbours are level, so the mesher's corner AO evaluates to "fully open"
    // everywhere and bakes nothing at all — which is why the grass kept reading
    // as flat mint slabs no matter how the colour was tuned. Cube World's ground
    // steps by one block every few metres, and it is the AO in those steps that
    // gives its meadows their tooth.
    //
    // Two samples, not one: a single value-noise field at this frequency lays its
    // lattice diamonds straight into the landform, and a repeating diamond bump
    // pattern would be a worse artefact than the one it fixes. Unrelated
    // frequencies (~12 and ~27 units) on offset origins break it up. Combined
    // amplitude is +-0.45 — under half a voxel, so it adds scattered single-block
    // steps and gentle swells and never a wall the hero has to climb.
    //
    // The relief is DAMPED to a quarter under water. A lake bed is a silted plain,
    // not a bumpy meadow, and more to the point the water shader's colour ramp is a
    // steep function of depth: +-0.45 units of bed ripple at a 12-unit wavelength
    // turned into pale/dark colour bands marching across every bay, which is
    // exactly the "soft concentric arcs that read as map contour lines" finding
    // reappearing from a completely different cause. Flattening the bed removes
    // the input rather than flattening the ramp, which would have cost the depth
    // gradient that the same finding also asked for.
    const fine =
      this.hillN.sample(x * 0.084 + 91.3, z * 0.084 - 44.7) * 0.29 +
      this.hillN.sample(z * 0.037 - 12.9, x * 0.037 + 61.1) * 0.16;
    h += fine * (0.25 + 0.75 * smoothstep(WATER_LEVEL - 1, WATER_LEVEL + 3, h));
    // Ridges: wide gate + higher mask frequency so most vistas contain a
    // ridgeline instead of an endless pancake. Cube World's identity is the
    // dramatic vertical read, so the multiplier and the ceiling both go up.
    const mk = smoothstep(-0.10, 0.32, this.maskN.fbm(x * 0.0042, z * 0.0042, 3));
    if (mk > 0) {
      const rd = this.ridgeN.ridged(x * 0.009, z * 0.009, 4);
      // A HIGHLAND term rides on top of the existing ridge, gated by a smoothstep
      // that is exactly zero for all but the top few percent of the field.
      //
      // The silhouette survey's landform finding was that a 300-unit view spans
      // about 8 units of relief and "no cliff, ridge, mesa or peak exists
      // anywhere". The obvious fix — raise the ridge exponent — was tried and
      // captured first, and it is a trap: `ridged` averages about 0.49 here, so
      // rd^3*88 replaces 13.9 units of typical relief with 10.4, the whole map
      // sinks a couple of units, and in _tw2-b-vista.png the entire foreground
      // meadow dropped below the beach threshold (smoothstep(11.6, 9.7, hc)) and
      // came out as one beige expanse. Everything in this world is placed on the
      // plains; the plains must not move.
      //
      // So the term is additive and gated instead. Below rd 0.62 — which is most
      // of the map — it contributes exactly nothing and heights are bit-identical
      // to before. At rd 0.81 it adds 21 units, at 0.92 it adds 33 and the 78-unit
      // ceiling starts to clip. That turns the rare strong ridge into an actual
      // peak with a skyline, and leaves the meadow, the shoreline and the spawn
      // basin untouched.
      h += mk * (rd * rd * 58 + smoothstep(0.62, 0.95, rd) * 34);
    }
    // Mesas: a broad plateau field. One cheap value-noise sample (not fbm) —
    // heightCont is on the collision hot path.
    //
    // The 4m quantise used to be global, which terraced EVERY hill — gentle
    // meadow swells came out as wedding cakes and the whole silhouette read as
    // stair-stepped. Mesas are a HIGHLAND feature, so the quantise is gated
    // behind the ridge mask: inside a range you get flat-topped tables with
    // hard cliff edges, out on the plains the same field contributes a smooth
    // (unquantised, gentler) swell.
    const pl = this.plateauN.sample(x * 0.0022, z * 0.0022) * 0.5 + 0.5;
    const mesa = smoothstep(0.55, 0.75, pl) * 14;
    if (mesa > 0) {
      if (mk > 0.45) h += Math.round(mesa * 0.25) * 4;
      else h += mesa * 0.6;
    }
    // ---- shelves and scarps: macro form for the NEAR ground -----------------
    //
    // Measured before this term, over a fixed 128x128 patch of low ground:
    // 98.9% of every riser in it was exactly ONE unit, 1.1% were two, and NOT
    // ONE column in the whole area (16 chunks) carried a face of three or more.
    // That is the "everything inside ~60 units is uniform 1-block staircase
    // terracing at even increments — it reads as noise, not landform" finding,
    // arithmetically: a smooth height field put through `floor()` can only ever
    // produce 1-unit risers, because a gradient gentle enough to look like a
    // meadow crosses one integer at a time. Every landform this world had —
    // ridges, mesas, peaks — lives at 0.0022..0.009 rad/unit, i.e. 100+ units
    // across, so it is BACKGROUND by construction and the foreground got the
    // fine relief and nothing else.
    //
    // The fix is not another quantiser over the whole field. The comment on the
    // mesa above says why: quantising globally terraces every gentle swell into
    // a wedding cake. What is added instead is a pair of RAISED PLATEAUX with
    // near-vertical rims, sampled at scales the near field can actually contain,
    // and each one is a `smoothstep` over a deliberately NARROW band rather than
    // a floor():
    //
    //  - `shelf`, ~48-unit cells, over a 0.0075-wide band of the field. Value
    //    noise at that cell size runs about 0.013 of field per world unit, so
    //    the rim climbs its full height across a bit over half a unit of ground
    //    and floors into a 2-, 3- or 4-unit riser. The threshold sits at the
    //    82nd percentile of the field, so it raises ~16% of dry land: grassy
    //    benches ten to twenty metres across, the size class the near ground was
    //    missing entirely.
    //  - `scarp`, ~77-unit cells, 88th percentile (~10% of dry land) and half
    //    again as tall, so a chunk neighbourhood usually contains one real cliff.
    //
    // Both heights are MODULATED by a third field at ~26-unit cells, which is
    // finer than either plateau. That is the part that matters most and it is
    // not decoration: multiplied by a constant, a thresholded field raises a
    // cylinder with the same sheer rim all the way round, and a ring of cliff is
    // a wall whichever way you approach it. Modulated, each bench is a WEDGE —
    // 1.6 units of rim on one flank and 5.6 on the other, with its top sloping
    // between — so every raised area has a low side you can jump up and the
    // tabletop carries its own 1-block terracing instead of being a machined
    // plate.
    //
    // WHY THIS DOES NOT WALL THE PLAYER IN. Both are ISLANDS, not contour lines.
    // A quantised field steps along its iso-lines, which run unbroken for
    // hundreds of units and would fence the map; thresholding one instead raises
    // the closed region ABOVE the threshold, which is a blob you walk around.
    // MAX_STEP_UP is 0.5 and the jump apex is 1.61 (player/index.ts), so the
    // tall side of a rim is genuinely impassable on foot and is meant to be —
    // it is CLIMBABLE (CLIMB_MIN_RISE 1.2) and a ground mount clears the 1-unit
    // terraces around it.
    //
    // The traversal cost was measured, not assumed. Over 240 random dry starts
    // in a fixed 500-unit box, walking a straight line under the player's own
    // step rule: WITHOUT jumping the median run is 5.0 units before and 5.0
    // after — unchanged, because a 1-unit terrace already stopped him. WITH
    // jumps the median goes 74.8 -> 49.5 units and the mean 136.6 -> 79.1. In
    // the running game (sprinting 8 s on each of eight bearings) the same
    // comparison is ~32 -> ~25 units of mean displacement. So a jumping run now
    // meets something it has to go round or climb roughly every fifty metres
    // instead of every seventy-five, which is the "a few per chunk
    // neighbourhood is drama" line rather than the maze on the other side of it.
    //
    // Over the same fixed 128x128 low-ground patch the risers now read 95.4% at
    // one unit, 3.5% at two and 1.2% at three or more (0 columns before, 22
    // after); columns standing 2+ above their own four-neighbour minimum go from
    // 0.6% of the land to 3.0%. One knock-on worth knowing about: `findSpawn`
    // rejects any column whose eight probes at radius 4 differ by more than 2,
    // so the world's spawn point moves — for seed 1337 from (-63, 35) to
    // (38, -79). Nothing depends on the old coordinates; the dens, the gate and
    // the flatten discs are all placed relative to whatever it picks.
    //
    // Both are damped to nothing at the waterline for the same reason `fine` is:
    // a shelf rim standing out of a lagoon is a wall of grass in the surf, and
    // the water shader's depth ramp turns any bed relief into contour banding.
    // The ramp is `WATER_LEVEL + 0.6 .. + 2.2`, i.e. fully off until 60cm of dry
    // land and fully on by 2.2 — every lake bed and the tide line itself are
    // bit-identical to before, while the dry beach above them can carry a bench.
    //
    // COST. Three more `Noise2D.sample` calls on the collision hot path, against
    // the fourteen this function already spends in three fbm chains and a ridged
    // multifractal. Timed at a million calls, `getHeight` goes 255 ns -> 305 ns,
    // i.e. +20% of a function that a frame calls a few hundred times: about
    // 15 microseconds of a 7.8 ms frame. Sampled, not fbm'd, for exactly this
    // reason — the same rule the mesa term above follows.
    const dry = smoothstep(WATER_LEVEL + 0.6, WATER_LEVEL + 2.2, h);
    if (dry > 0) {
      const shf = this.shelfN.sample(x * 0.021, z * 0.021) * 0.5 + 0.5;
      const scf = this.scarpN.sample(x * 0.013, z * 0.013) * 0.5 + 0.5;
      const ramp = this.shelfN.sample(x * 0.038 + 137.4, z * 0.038 - 211.9) * 0.5 + 0.5;
      h += dry * (smoothstep(0.716, 0.7235, shf) * (1.6 + ramp * 4.0)
        + smoothstep(0.880, 0.887, scf) * (2.0 + ramp * 4.4));
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
    // Roads LAST, after the flatten discs, so a road running into a town is cut
    // through whatever the town levelled rather than fighting it. The two agree
    // anyway — a road's end height is where the town takes its own level from —
    // but the order makes that an invariant instead of a coincidence.
    const rf = this.roads;
    if (rf !== null) {
      const w = rf.carveAt(x, z);
      if (w > 0) h += (rf.carveTarget - h) * w;
    }
    return h < 1.2 ? 1.2 : h > 78 ? 78 : h;
  }

  /** Integer top surface of the column containing cell (cx, cz). */
  columnHeight(cx: number, cz: number): number {
    const h = Math.floor(this.heightCont(cx + 0.5, cz + 0.5));
    return h < 1 ? 1 : h;
  }

  /**
   * Collision authority: stepped, and matching the rendered voxels exactly —
   * EXCEPT on a road, where it is the continuous deck and matches the road
   * ribbon instead.
   *
   * That exception is the entire point of carving a road. Flooring the height
   * means every ledge in the world is a whole unit, and MAX_STEP_UP refuses all
   * of them, so a road built out of terrain columns would be a staircase. The
   * corridor hands back a smooth surface and ramps it back onto the (levelled)
   * shoulder over the verge, so a walk down a road meets no step at all in
   * either direction — see roads.ts.
   *
   * Still pure, still allocation-free, and still the single answer everything in
   * the game resolves against: pals, enemies, drops and the camera walk the
   * bridge over the lake for free, without any of them knowing what a bridge is.
   */
  getHeight(x: number, z: number): number {
    const g = this.columnHeight(Math.floor(x), Math.floor(z));
    const rf = this.roads;
    return rf === null ? g : rf.surfaceAt(x, z, g);
  }

  /**
   * How SNOW-COVERED this column is, 0..1 — `columnInfo`'s `snowW` on its own,
   * without the colour work.
   *
   * The same number three ways: the weight the ground colour is mixed toward
   * SNOW with, the gate (>0.5) that makes `biome` 'snow' and puts snow-capped
   * pines in a chunk instead of oaks, and — the reason it is public — what a
   * caller outside the mesher needs to ask "is the thing at this column under
   * snow". Deliberately the CONTINUUM and not the biome boolean: the snow line
   * is a 5-unit-tall smoothstep around an altitude that itself wanders 6 units
   * with the temperature field, so half-covered ground is a real state the world
   * spends a lot of area in, and a caller that wants a threshold can take one.
   *
   * Cost: one `heightCont` plus one fbm — about the same as `getHeight`, and an
   * eighth of a `columnInfo`. Cheap enough for a per-contact query (the contact
   * particles ask once per burst, not once per particle), not for a per-column
   * loop that could have used `columnInfo` and got this for free.
   *
   * Takes CONTINUOUS world x/z, like `heightCont` and unlike `columnInfo`, whose
   * arguments are cell indices.
   */
  snowCoverAt(x: number, z: number): number {
    const hc = this.heightCont(x, z);
    const temp = this.tempN.fbm(x * 0.0035, z * 0.0035, 3);
    const snowLine = 23 + temp * 6;
    return smoothstep(snowLine - 2.5, snowLine + 2.5, hc);
  }

  /**
   * How worn a settlement has left the ground at (x, z), 0..1, with two
   * by-products left in `trampleTrack` and `trampleDamp` for the caller that
   * wants to colour it.
   *
   * Split that way — a return value plus two fields — for the same reason
   * `RoadField.carveAt` leaves `carveTarget` behind: the three numbers come out
   * of one scan and returning them together would mean allocating an object per
   * column. `trampleTrack` is the wear from the beaten tracks ALONE, before the
   * rim fade, and it is what tells the colour which columns are packed dry road
   * and which are the mud between.
   *
   * NOT for the collision path. This is a `columnInfo` query (chunk build); the
   * ground a settlement stands on is levelled by an ordinary `FlattenDisc`, and
   * how it is COLOURED is no business of `getHeight`.
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
      // The tracks, as distance to a segment from the centre outwards. `place`
      // in towns.ts keeps every tent, hut and barrel off the carriageway with
      // the same primitive; this is the inverse question — where the ground
      // BETWEEN those buildings is walked flat.
      const q = p.paths;
      let track = 0;
      for (let k = 0; k < q.length; k += 4) {
        const ax = q[k];
        const az = q[k + 1];
        const len2 = ax * ax + az * az;
        let t = len2 > 1e-9 ? (dx * ax + dz * az) / len2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const px = dx - ax * t;
        const pz = dz - az * t;
        const hw = q[k + 2];
        // Soft-edged: a footpath has no kerb. Full strength for the inner 45%
        // of its width, gone at the rim.
        const s = q[k + 3] * (1 - smoothstep(hw * 0.45, hw, Math.sqrt(px * px + pz * pz)));
        if (s > track) track = s;
      }
      // The rim. Wear does not stop on a circle — from the air that is exactly
      // what a settlement must not look like — so everything above is faded out
      // over the several metres between `fade` and `edge`.
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
    // Meadow HUE mottling rather than value. A ~30-unit field slides the grass
    // between the cool forest green and the warm yellow-green, which is what
    // stops a Cube World field from looking like painted card — and, crucially,
    // it is the mottling that CAN be pushed hard without the ground reading as
    // tiled. Value differences between neighbouring flat faces are what the eye
    // resolves as a chequer; a hue drift over thirty units reads as terrain.
    // Amplitude is up (0.42 -> 0.56) precisely because most of the VALUE
    // variation below has been cut.
    //
    // TWO scales of hue, not one. The ~30-unit field alone is a smooth gradient
    // across a whole hillside, and in a vista (_tw-r6-vista.png) a hillside is
    // twenty metres of frame — so the meadow reads as one wash with a slow ramp
    // across it, which is not what a Cube World field looks like. The ~14-unit
    // patch field, until now spent entirely on a ±2.5% value wash, is added to the
    // same blend at roughly half the weight: at fourteen cubes across it is far too
    // coarse to interact with the cube grid, so it costs nothing in chequer risk
    // and buys visible patches of yellow-green sitting in deeper green.
    const hueDrift = this.hueW.sample(x, z);
    const patchHue = this.patchW.sample(x, z);
    mix(tA, PLAIN_GRASS, WARM_GRASS, clamp01(warmT + hueDrift * 0.56 + patchHue * 0.30));
    mix(tA, tA, FOREST_GRASS, clamp01(
      forestF * 0.85 + Math.max(-hueDrift, 0) * 0.42 + Math.max(-patchHue, 0) * 0.22,
    ));

    // ---- landform-scale grass structure ------------------------------------
    // Altitude tint. `lowW` runs up as a column approaches the water table,
    // `altW` as it climbs toward the snow line, and both are functions of the
    // TERRAIN, so a hillside and the valley under it can never come out the same
    // green however the noise falls. This is the answer to "the world has six
    // hues total" and to "the entire right 60% of the squinted frame is
    // undifferentiated green mush": at a squint the vista now reads as a dark
    // valley floor, a mid meadow and a pale ridge.
    const lowW = smoothstep(14.5, 9.5, hc);
    const altW = smoothstep(16, snowLine - 3, hc);
    mix(tA, tA, LUSH_GRASS, lowW * 0.42);
    mix(tA, tA, UPLAND_GRASS, altW * 0.62);
    // Regional richness, off the ~250-unit moisture field that already decides
    // where forest goes. Dry country bleaches its sward pale and dusty, wet
    // country deepens it — ±11% of value at the scale of a whole valley, which is
    // far too coarse to interact with the cube grid and so carries no chequer
    // risk at all. It is the cheapest landform-scale variation available: the fbm
    // is already sampled for `forestF`.
    const rich = 0.905 + smoothstep(-0.28, 0.30, moist) * 0.215;
    tA.r *= rich;
    tA.g *= rich;
    tA.b *= rich;

    mix(tB, BEACH_SAND, DESERT_SAND, clamp01(desertW * 1.5));
    // DUNE-scale sand drift, ~30 units of value and ~14 units of warmth, reusing
    // the two wave fields already sampled above.
    //
    // Sand had nothing but per-CUBE jitter, and that is the wrong scale for it:
    // a pale desaturated surface has no hue for a per-cube jitter to ride on, so
    // the jitter arrives as pure value and the eye resolves the cube grid as a
    // chequer — filed by the life-and-detail survey as "a per-block two-tone
    // chequer that reads as a texture-atlas debug grid". The fix is not less
    // variation, it is variation at the scale of DUNES: ±8.5% of value over
    // thirty units reads as a beach that undulates, and it frees the mesher to
    // cut the per-cube value share (see chunk.ts) that was causing the grid.
    const duneV = 1 + hueDrift * 0.085 + patchHue * 0.048;
    const duneW = patchHue * 0.062 - hueDrift * 0.038;
    tB.r *= duneV * (1 + duneW);
    tB.g *= duneV;
    tB.b *= duneV * (1 - duneW * 1.5);
    mix(tA, tA, tB, sandW);
    mix(tA, tA, SNOW, snowW);

    // Mid-scale patch value wash, ~14 units, ±2.5%. Small on purpose: this used
    // to be a ±6% value-noise field and it was the single biggest contributor to
    // the diamond plaid. Now that the field has no lattice it could carry more,
    // but broad value drift is not what the ground was missing — hue was.
    const pm = 1 + patchHue * 0.025;
    tA.r *= pm;
    tA.g *= pm;
    tA.b *= pm;

    // Surface tooth, ~3 units, ±3%. Just above cube frequency, so it never
    // resolves into a shape; it just keeps two neighbouring cubes from ever
    // being bit-identical. Halved from ±7% for the same reason as the patch
    // field — at 3 units it was close enough to cube scale to read as a pattern.
    const tooth = this.toothW.sample(x, z);
    const dm = 1 + tooth * 0.03;
    tA.r *= dm;
    tA.g *= dm;
    tA.b *= dm;

    // ---- trodden settlement ground ------------------------------------------
    // Whatever this column would have been, a town has been standing on it. See
    // `GroundPatch`; the arithmetic here is the whole difference between a camp
    // floor and a brown dinner plate, so it is worth spelling out.
    //
    // MUD vs PACKED EARTH is a per-column blend, driven by four things that
    // pull in different directions. Three of the fields are free — they are
    // already sampled above for the meadow — and only `churnW` is new, and only
    // for columns a settlement actually covers:
    //
    //  - `patchHue`, the ~14-unit field, at the largest weight. This is the one
    //    that does the work: it puts puddle-sized blotches of dark churn in a
    //    dry yard at exactly the scale a person walking through the camp reads
    //    as "wet patch" rather than as "different biome".
    //  - `hueDrift`, ~30 units, at half that, so one quarter of a big camp is
    //    generally wetter than the other instead of the blotches being evenly
    //    stirred.
    //  - `churnW`, ~7 units, which is rut and puddle scale — the size a person
    //    walking through the camp reads as one wet patch.
    //  - the BEATEN TRACKS, negatively and hardest of all. Ground that is walked
    //    every day is packed too hard to hold water: the gate-to-fire line and
    //    the paths out to the huts come out pale and dry, which is what turns a
    //    field of mud into a place with routes through it.
    const wear = this.grounds.length > 0 ? this.trampleAt(x, z) : 0;
    if (wear > 0) {
      // The ~7-unit churn field joins the two hue fields in choosing mud, so
      // the wet patches come at three scales at once (quarter of a camp, a
      // puddle, a rut) instead of one.
      const churn = this.churnW.sample(x, z);
      // 0.75, not the 0.95 of the first pass. At 0.95 a track cleared the mud
      // term outright, and with nine tracks radiating from the middle of a camp
      // that left the whole central disc clamped at zero: measured over the
      // 15x15 columns around the Encampment's centre the luminance ran 114-122
      // out of 255 — an eight-value plateau, i.e. exactly the flat brown plate
      // this is supposed to avoid, with all the mud pushed out to the wedges
      // between the spokes. A cart track HAS ruts and ruts hold water; at 0.75
      // roughly a third of the columns on a path still take some mud and the
      // path stays clearly the drier surface.
      const mud = clamp01(
        this.trampleDamp + patchHue * 0.85 + hueDrift * 0.40 + churn * 0.55
        - this.trampleTrack * 0.75,
      );
      mix(tB, TRAMPLED_EARTH, TRAMPLED_MUD, mud);
      // CHURN VALUE: ±17% at ~7 units, plus a small dust lift where the traffic
      // packs the surface. Five times the meadow's per-cube share and safe at
      // that amplitude precisely because it is NOT per-cube — see `churnW`. It
      // needs to be that big to be seen at all: sRGB is a ~1/2.4 power of this,
      // so ±17% of linear radiance is only about seven code values on screen.
      const ch = 1 + churn * 0.17 + patchHue * 0.05 + tooth * 0.025
        + this.trampleTrack * 0.06;
      tB.r *= ch;
      tB.g *= ch;
      tB.b *= ch;
      // COLOUR LEADS THE PROPS. `1 - (1 - wear)^2` rather than `wear`, so a
      // half-worn column is 75% earth by colour while `out.trample` still culls
      // its grass at 50%. That gap IS the reference picture: ground that has
      // gone to bare earth with tussocks still standing on it, thinning as you
      // walk in. Mixing on the raw weight instead left Redbriar Mill — a hamlet
      // in a snowfield, so the most demanding case — reading as pale beige,
      // because half of pure white is still nearly white.
      mix(tA, tA, tB, wear * (2 - wear));
    }

    // Lake bed, and — crucially — the damp strip just ABOVE the waterline. The
    // cut used to be exactly at WATER_LEVEL, so a column whose continuous height
    // landed a hair over it stayed full dry-beach brightness: sandbars sitting a
    // few centimetres proud of a lagoon rendered as hard-edged tan slabs floating
    // in the water, which is what got filed as "rectangular sand patches in the
    // bay". Every shore has a darker, cooler wet band; ramping the bed colour in
    // from 0.7 units above the surface gives it one, and the slabs read as
    // sandbars instead of as artefacts.
    if (hc < WATER_LEVEL + 0.7) {
      const d = smoothstep(-0.7, 6, WATER_LEVEL - hc);
      mix(tA, UW_SAND, UW_DEEP, d);
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
    // Vegetated-grass weight: everything that isn't sand, snow, lake bed — or
    // trodden into the ground by a settlement. Handing the wear to `grass` is
    // what switches the mesher off the meadow treatment automatically: the
    // curvature moss/bleach read, the clover-and-blade litter picks and the
    // saturation link all gate on it, and a camp yard should have none of them.
    // What it gets instead is the sparse-surface litter (grit, a dark pebble)
    // and the smaller per-cube value share, which is the right texture for dirt.
    out.grass = hc < WATER_LEVEL + 0.3 ? 0
      : clamp01((1 - sandW) * (1 - snowW) * (1 - wear));
    out.trample = wear;
    out.h = h;
    out.hc = hc;
    // 0.6, not "any wear at all". The threshold is where props.ts stops
    // thinning the sward and starts refusing it outright (see the cull there),
    // and it has to sit inside the settlement rather than at its rim: measured
    // on seed 1337 the Encampment's palisade stands at wear 0.84 and the apron
    // outside the gate falls through 0.6 about two metres beyond it, so the
    // ground is bare to the wall and the last tussocks survive just outside it.
    out.biome =
      hc < WATER_LEVEL + 0.4 ? 'underwater'
      : wear > 0.6 ? 'trampled'
      : snowW > 0.5 ? 'snow'
      : desertW > 0.5 ? 'desert'
      : beachW > 0.5 ? 'beach'
      : forestF > 0.5 ? 'forest'
      : 'plains';
  }
}
