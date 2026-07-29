/**
 * Terrain height + biome authority. Pure functions of (seed, x, z) so
 * collision queries agree exactly with the rendered voxel columns.
 */
import { Noise2D } from './noise';

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

const rgb = (hex: number): RGB => ({
  r: ((hex >> 16) & 255) / 255,
  g: ((hex >> 8) & 255) / 255,
  b: (hex & 255) / 255,
});

// -- Palette (vibrant Cube World grading) -----------------------------------
// Boosted at source: ACES + hemisphere light + fog eat ~20% chroma, so these
// are over-saturated here to land on-target on screen.
const PLAIN_GRASS = rgb(0x54c832);
const WARM_GRASS = rgb(0x9ccc3a);
const FOREST_GRASS = rgb(0x3fa832);
const BEACH_SAND = rgb(0xefdca6);
const DESERT_SAND = rgb(0xe0be74);
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
  biome: BiomeId;
}

export function makeScratch(): ColumnScratch {
  return {
    h: 0, hc: 0,
    topR: 0, topG: 0, topB: 0,
    dirtR: 0, dirtG: 0, dirtB: 0,
    stoneWarm: 0,
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

  private readonly continentN: Noise2D;
  private readonly hillN: Noise2D;
  private readonly ridgeN: Noise2D;
  private readonly maskN: Noise2D;
  private readonly tempN: Noise2D;
  private readonly moistN: Noise2D;
  private readonly patchN: Noise2D;
  private readonly detailN: Noise2D;
  private readonly plateauN: Noise2D;

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
    this.patchN = new Noise2D(this.seed + 773);
    this.detailN = new Noise2D(this.seed + 887);
    this.plateauN = new Noise2D(this.seed + 1013);
  }

  /** Continuous terrain height at any world xz (flatten discs applied). */
  heightCont(x: number, z: number): number {
    const c = this.continentN.fbm(x * 0.0045, z * 0.0045, 4);
    let h = 9.2 + c * 10.5;
    h += this.hillN.fbm(x * 0.02, z * 0.02, 3) * 2.6;
    // Ridges: wide gate + higher mask frequency so most vistas contain a
    // ridgeline instead of an endless pancake. Cube World's identity is the
    // dramatic vertical read, so the multiplier and the ceiling both go up.
    const mk = smoothstep(-0.10, 0.32, this.maskN.fbm(x * 0.0042, z * 0.0042, 3));
    if (mk > 0) {
      const rd = this.ridgeN.ridged(x * 0.009, z * 0.009, 4);
      h += mk * rd * rd * 58;
    }
    // Mesas: a broad plateau field quantised to 4m steps, so the skyline gets
    // flat-topped tables with hard cliff edges between the ridges. One cheap
    // value-noise sample (not fbm) — heightCont is on the collision hot path.
    const pl = this.plateauN.sample(x * 0.0022, z * 0.0022) * 0.5 + 0.5;
    const mesa = smoothstep(0.55, 0.75, pl) * 14;
    if (mesa > 0) h += Math.round(mesa * 0.25) * 4;
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
    mix(tA, PLAIN_GRASS, WARM_GRASS, warmT);
    mix(tA, tA, FOREST_GRASS, forestF * 0.85);
    mix(tB, BEACH_SAND, DESERT_SAND, clamp01(desertW * 1.5));
    mix(tA, tA, tB, sandW);
    mix(tA, tA, SNOW, snowW);

    // Large-scale patchiness keeps meadows from reading flat.
    const patch = this.patchN.sample(x * 0.06, z * 0.06) * 0.5 + 0.5;
    const pm = 0.93 + patch * 0.12;
    tA.r *= pm;
    tA.g *= pm;
    tA.b *= pm;

    // Second, fine-grain color octave (~4-voxel features, +-8.5% value) so
    // close-ups don't collapse into a flat green void. Amplitude up and
    // frequency down now that the mesher's 1-voxel checker is gone: the
    // irregular blotching has to carry the ground read on its own.
    const dm = 1 + this.detailN.sample(x * 0.28, z * 0.28) * 0.085;
    tA.r *= dm;
    tA.g *= dm;
    tA.b *= dm;

    if (hc < WATER_LEVEL) {
      const d = smoothstep(0, 6, WATER_LEVEL - hc);
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
