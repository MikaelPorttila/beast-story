import type { VoxelModel } from "../../core/voxel";

// Shared voxel painting for the species. build() bakes a fixed per-face shade
// (top 1.0, sides 0.88, front/back 0.8, bottom 0.62) and no AO at all, so anything
// recessed must be PAINTED recessed — a geometric notch darkens nothing.

/** One-cell sunlit crest: recolours the topmost filled voxel of each column. */
export function rimTop(
  m: VoxelModel,
  color: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
): void {
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      for (let y = y1; y >= y0; y--) {
        if (m.has(x, y, z)) {
          m.set(x, y, z, color);
          break;
        }
      }
    }
  }
}

/** The creature's own contact shadow: recolours the lowest filled voxel of each column. */
export function shadeUnder(
  m: VoxelModel,
  color: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
): void {
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        if (m.has(x, y, z)) {
          m.set(x, y, z, color);
          break;
        }
      }
    }
  }
}

export interface EyeSpec {
  /** |x| of the inner eye column; the bridge fills the whole gap between the pair. */
  inner: number;
  /** Eye columns per side: 2 on a seven-cell face, 1 on a five-cell one. */
  width?: 1 | 2;
  y: number;
  /** z of the flat face plane; lid ledge and bridge stand proud at z + 1. */
  faceZ: number;
  /** A very dark tint of the COAT hue — never 0x000000, which holes the silhouette. */
  iris: number;
  shine: number;
  lid?: number;
  /** Hang the upper lid proud at z + 1 too, so it shadows the iris. */
  browProud?: boolean;
  lowerLid?: boolean;
  /** Lit coat tone for a proud nose bridge — what stops a close pair reading as sunglasses. */
  bridge?: number;
  /** Emissive iris intensity. Keep it 0.5-0.9: bloom turns anything more into a headlamp. */
  glow?: number;
  cheek?: number;
}

/**
 * The house eye pair, mirrored from the right-hand geometry. The eye is the DARK mass on
 * a light face; `inner: 1` keeps a coat cell outboard so both eyes survive a 3/4 bearing.
 *
 *   layout, inner: 1, width: 2, x grows outward    # = iris
 *     y+2    =   lid  lid   (proud at z+1)         * = catchlight
 *     y+1    |    #    *                           | = proud nose bridge
 *     y+0    |    #    #                           = = lid row
 *     y-1        lid  lid   (lowerLid)
 */
export function eyes2x2(m: VoxelModel, s: EyeSpec): void {
  const z = s.faceZ;
  const w = s.width ?? 2;
  const paint = (x: number, y: number, zz: number, c: number): void => {
    if (s.glow !== undefined && c === s.iris) {
      m.setEmissive(x, y, zz, c, s.glow);
    } else {
      m.set(x, y, zz, c);
    }
  };
  // Bridge first, so a lid row stamped later can overwrite its top.
  if (s.bridge !== undefined) {
    for (let x = -(s.inner - 1); x <= s.inner - 1; x++) {
      for (let r = 0; r < 2; r++) {
        m.set(x, s.y + r, z, s.bridge);
        m.set(x, s.y + r, z + 1, s.bridge);
      }
    }
  }
  for (const sx of [1, -1]) {
    const cols: number[] = [];
    for (let d = 0; d < w; d++) {
      cols.push(sx * (s.inner + d));
    }
    for (const x of cols) {
      paint(x, s.y, z, s.iris);
      paint(x, s.y + 1, z, s.iris);
    }
    // Never emissive: a glowing catchlight blooms into a star and eats the iris.
    m.set(cols[cols.length - 1], s.y + 1, z, s.shine);
    if (s.lid !== undefined) {
      for (const x of cols) {
        m.set(x, s.y + 2, z, s.lid);
        if (s.browProud) {
          m.set(x, s.y + 2, z + 1, s.lid);
        }
        if (s.lowerLid) {
          m.set(x, s.y - 1, z, s.lid);
        }
      }
    }
    if (s.cheek !== undefined) {
      m.set(cols[cols.length - 1], s.y - 1, z, s.cheek);
    }
  }
}
