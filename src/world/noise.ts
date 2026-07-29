/**
 * Deterministic, dependency-free noise for world generation.
 * Integer-hash based 2D value noise with quintic interpolation, fBm and
 * ridged-multifractal variants. Fully reproducible from a numeric seed.
 */

/** Fast deterministic PRNG (mulberry32). */
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

/** Deterministic hash of an integer 3D cell -> [0,1). Used for per-voxel jitter. */
export function hashCell(seed: number, x: number, y: number, z: number): number {
  let h = (seed | 0) + Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** 2D value noise field, seeded and deterministic. */
export class Noise2D {
  constructor(private readonly seed: number) {}

  private lattice(ix: number, iz: number): number {
    return hashCell(this.seed, ix, 0x51ab, iz);
  }

  /** Smooth value noise, returns [-1, 1]. */
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

  /** Fractal Brownian motion, roughly [-1, 1]. */
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

  /** Ridged multifractal, [0, 1]; sharp crests for mountain ranges. */
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
