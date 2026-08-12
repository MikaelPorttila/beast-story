export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer 3D cell -> [0,1). */
export function hashCell(seed: number, x: number, y: number, z: number): number {
  let h = (seed | 0) + Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Lattice-free field (summed plane waves). Use this, not `Noise2D`, for surface
 * COLOUR: value noise's lattice vertices read as an X and a plain looks tiled.
 * Below ~5 waves the strongest shows as banding. [-1,1] but rarely near it.
 */
export class WaveField {
  private readonly kx: Float64Array;
  private readonly kz: Float64Array;
  private readonly ph: Float64Array;
  private readonly am: Float64Array;

  /** `baseFreq` is radians per world unit; `ratio` must stay irrational so the sum never repeats. */
  constructor(seed: number, baseFreq: number, waves = 7, ratio = 1.618, gain = 0.72) {
    const rng = mulberry32(seed);
    this.kx = new Float64Array(waves);
    this.kz = new Float64Array(waves);
    this.ph = new Float64Array(waves);
    this.am = new Float64Array(waves);
    // 2.39996 rad = golden angle: directions stay maximally spread.
    let ang = rng() * Math.PI * 2;
    let freq = baseFreq;
    let amp = 1;
    let norm = 0;
    for (let i = 0; i < waves; i++) {
      // Jitter so two seeds do not share the same rosette of directions.
      const a = ang + (rng() - 0.5) * 0.5;
      this.kx[i] = Math.cos(a) * freq;
      this.kz[i] = Math.sin(a) * freq;
      this.ph[i] = rng() * Math.PI * 2;
      this.am[i] = amp;
      norm += amp;
      ang += 2.39996;
      freq *= ratio;
      amp *= gain;
    }
    for (let i = 0; i < waves; i++) this.am[i] /= norm;
  }

  sample(x: number, z: number): number {
    let s = 0;
    for (let i = 0; i < this.am.length; i++) {
      s += this.am[i] * Math.sin(this.kx[i] * x + this.kz[i] * z + this.ph[i]);
    }
    return s;
  }
}

export class Noise2D {
  constructor(private readonly seed: number) {}

  private lattice(ix: number, iz: number): number {
    return hashCell(this.seed, ix, 0x51ab, iz);
  }

  /** [-1, 1] like fbm below. */
  sample(x: number, z: number): number {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;
    const ux = fade(fx);
    const uz = fade(fz);
    const a = this.lattice(ix, iz);
    const b = this.lattice(ix + 1, iz);
    const c = this.lattice(ix, iz + 1);
    const d = this.lattice(ix + 1, iz + 1);
    const v = a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
    return v * 2 - 1;
  }

  fbm(x: number, z: number, octaves: number, lacunarity = 2.0, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.sample(x * freq + o * 13.71, z * freq - o * 7.37);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** [0, 1], sharp crests. */
  ridged(x: number, z: number, octaves: number, lacunarity = 2.1, gain = 0.55): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      let v = 1 - Math.abs(this.sample(x * freq + o * 5.13, z * freq + o * 9.02));
      v *= v;
      sum += amp * v;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}
