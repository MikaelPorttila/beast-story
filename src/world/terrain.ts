/**
 * Terrain height + biome authority. Pure functions of (seed, x, z) so
 * collision queries agree exactly with the rendered voxel columns.
 */
import { Noise2D, WaveField } from './noise';

export const WATER_LEVEL = 8;
export const CHUNK_SIZE = 32;

export type BiomeId = 'plains' | 'forest' | 'beach' | 'desert' | 'snow' | 'underwater';

export interface FlattenDisc {
  x: number;
  z: number;
  /** Target continuous height (use H + 0.55 so the floored column equals H) */
  h: number;
  core: number;
  blend: number;
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
  biome: BiomeId;
}

export function makeScratch(): ColumnScratch {
  return {
    h: 0, hc: 0,
    topR: 0, topG: 0, topB: 0,
    dirtR: 0, dirtG: 0, dirtB: 0,
    stoneWarm: 0,
    grass: 0,
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
    return h < 1.2 ? 1.2 : h > 78 ? 78 : h;
  }

  /** Integer top surface of the column containing cell (cx, cz). */
  columnHeight(cx: number, cz: number): number {
    const h = Math.floor(this.heightCont(cx + 0.5, cz + 0.5));
    return h < 1 ? 1 : h;
  }

  /** Collision authority: stepped, matches rendered voxels exactly. */
  getHeight(x: number, z: number): number {
    return this.columnHeight(Math.floor(x), Math.floor(z));
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
    const dm = 1 + this.toothW.sample(x, z) * 0.03;
    tA.r *= dm;
    tA.g *= dm;
    tA.b *= dm;

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
    // Vegetated-grass weight: everything that isn't sand, snow or lake bed.
    out.grass = hc < WATER_LEVEL + 0.3 ? 0 : clamp01((1 - sandW) * (1 - snowW));
    out.h = h;
    out.hc = hc;
    out.biome =
      hc < WATER_LEVEL + 0.4 ? 'underwater'
      : snowW > 0.5 ? 'snow'
      : desertW > 0.5 ? 'desert'
      : beachW > 0.5 ? 'beach'
      : forestF > 0.5 ? 'forest'
      : 'plains';
  }
}
