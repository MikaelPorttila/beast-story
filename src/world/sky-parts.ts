/**
 * Skyhaven's voxel parts bin — plaster + timber framing + blue slate, a
 * separate bin from the camp's `TownParts` (world/town-parts.ts).
 */
import { VoxelModel } from "../core/voxel";
import { bakeSolid } from "./structures";
import type { Template } from "./props";
import { mulberry32 } from "./noise";

/** World units per voxel — coarser than the town's 0.28, on purpose. */
export const SV = 0.6;

const STONE = 0x93938f;
const STONE_D = 0x6f6f6c;
const STONE_L = 0xaeaea8;
const PLASTER = 0xe4dabf;
const PLASTER_D = 0xc6ba9c;
const TIMBER = 0x7a5330;
const TIMBER_D = 0x593b21;
const WOOD = 0x9a7043;
const WOOD_D = 0x77552f;
/** Slate: the town's signature colour. Three values = lit face, shade, ridge. */
const ROOF = 0x4a5e96;
const ROOF_D = 0x2f3f70;
const ROOF_L = 0x6a7fb4;
/** Second roof colour; alternating it is what separates roofs seen from the air. */
const SHINGLE = 0x8a6540;
const SHINGLE_D = 0x63472a;
const SHINGLE_L = 0xa88055;
const LAMP = 0xffc561;
const IRON = 0x4b4b53;
const FLAG_C = 0x3f5bb5;
const FLAG_W = 0xe8e4d8;

/** Per-voxel value jitter, so a flat wall is not one flat colour. */
function shade(hex: number, k: number): number {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return (r << 16) | (g << 8) | b;
}

/**
 * A cottage. `kind` picks the silhouette: 0 plain, 1 chimney, 2 long + porch.
 * The roof is bracketed (`VoxelModel.region`) so its collider is a ridge
 * cylinder, not a slab — see `measureRidge` in world/structures.ts.
 */
export function skyCottage(kind: 0 | 1 | 2, shingle = false): Template {
  const v = new VoxelModel();
  const r = mulberry32(0x5c07 + kind * 977 + (shingle ? 5501 : 0));
  const RF = shingle ? SHINGLE : ROOF;
  const RF_D = shingle ? SHINGLE_D : ROOF_D;
  const RF_L = shingle ? SHINGLE_L : ROOF_L;
  const W = kind === 2 ? 8 : 6;
  const D = 5;
  const H = 7;

  for (let x = -W - 1; x <= W + 1; x++) {
    for (let z = -D - 1; z <= D + 1; z++) {
      if (Math.abs(x) <= W && Math.abs(z) <= D) {
        continue;
      }
      v.set(x, 0, z, shade((x + z) & 1 ? STONE : STONE_D, 0.9 + r() * 0.25));
    }
  }
  for (let x = -W; x <= W; x++) {
    for (let z = -D; z <= D; z++) {
      if (Math.abs(x) !== W && Math.abs(z) !== D) {
        continue;
      }
      for (let y = 1; y <= H; y++) {
        const corner = Math.abs(x) === W && Math.abs(z) === D;
        // Frame: corners, sill/head courses, an upright every third cell.
        const post = Math.abs(x) === W ? (z + D) % 3 === 0 : (x + W) % 3 === 0;
        const band = y === 1 || y === 4 || y === H;
        const c = corner || band || post ? (y > 4 ? TIMBER : TIMBER_D) : PLASTER;
        v.set(x, y, z, shade(c, 0.88 + r() * 0.24));
      }
    }
  }
  for (let x = -1; x <= 1; x++) {
    for (let y = 1; y <= 4; y++) v.set(x, y, D, shade(WOOD_D, 0.8));
  }
  for (let x = -2; x <= 2; x++) {
    v.set(x, 5, D, shade(TIMBER, 1.05));
  }
  const win = (x: number, z: number): void => {
    for (let dx = 0; dx <= 1; dx++) {
      for (let y = 3; y <= 4; y++) {
        v.setEmissive(x + dx, y, z, LAMP, 1.1);
      }
    }
  };
  win(-W + 2, D);
  win(W - 3, D);
  win(-W + 2, -D);
  if (kind === 2) {
    win(1, -D);
  }
  for (const wx of [-W + 1, W - 4]) {
    for (let y = 3; y <= 4; y++) {
      v.set(wx, y, D, shade(ROOF_D, 1.0));
      v.set(wx + 3, y, D, shade(ROOF_D, 1.0));
    }
  }

  // Roof: courses stepping in from a 2-cell eave overhang to the ridge, along x.
  const roof = v.region(() => {
    const rise = D + 2;
    for (let k = 0; k <= rise; k++) {
      const y = H + 1 + k;
      const zEdge = D + 2 - k;
      if (zEdge < 0) {
        break;
      }
      const c = k % 2 === 0 ? RF : RF_D;
      for (let x = -W - 2; x <= W + 2; x++) {
        const j = 0.9 + r() * 0.22;
        v.set(x, y, zEdge, shade(c, j));
        v.set(x, y, -zEdge, shade(k % 2 === 0 ? RF_D : RF, j));
        // Gable ends solid, or the roof is a hollow shell from the side.
        if (Math.abs(x) === W + 2) {
          for (let z = -zEdge; z <= zEdge; z++) {
            v.set(x, y, z, shade(RF_D, j * 0.94));
          }
        }
      }
    }
    for (let x = -W - 2; x <= W + 2; x++) {
      v.set(x, H + 2 + rise, 0, shade(RF_L, 1.06));
    }
  });

  if (kind === 1) {
    for (let y = 1; y <= H + D + 6; y++) {
      v.box(-W - 2, y, -1, -W - 1, y, 1, shade(y > H ? STONE : STONE_D, 0.88 + r() * 0.26));
    }
    v.box(-W - 3, H + D + 7, -2, -W, H + D + 7, 2, shade(STONE_L, 1.04));
  }
  if (kind === 2) {
    for (let y = 1; y <= 5; y++) {
      v.set(-3, y, D + 2, shade(TIMBER, 0.95));
      v.set(3, y, D + 2, shade(TIMBER, 0.95));
    }
    for (let x = -4; x <= 4; x++) {
      v.set(x, 6, D + 2, shade(RF, 1.0));
      v.set(x, 7, D + 1, shade(RF_D, 1.0));
    }
  }
  return bakeSolid(v, SV, roof);
}

/**
 * The tower. Not bracketed as a roof: `measureRidge` fits an arc along a crest
 * and a stepped pyramid's crest is one cell, so the box walls are the collider.
 */
export function skyTower(): Template {
  const v = new VoxelModel();
  const r = mulberry32(0x7011);
  const W = 4;
  /** 26 courses puts the belfry over the tree line; 16 was shorter than the oaks. */
  const SHAFT = 26;
  const UPPER = 8;

  // Plinth: one course oversailing by two — low enough to walk onto, since the
  // plateau itself is flat (world/sky-island.ts).
  for (let x = -W - 2; x <= W + 2; x++) {
    for (let z = -W - 2; z <= W + 2; z++) {
      v.set(x, 0, z, shade((x + z) % 2 === 0 ? STONE : STONE_D, 0.9 + r() * 0.2));
    }
  }
  for (let y = 1; y <= SHAFT + UPPER; y++) {
    const upper = y > SHAFT;
    // Upper storey oversails by a cell (a corbel), not an extruded square.
    const w = upper ? W + 1 : W;
    for (let x = -w; x <= w; x++) {
      for (let z = -w; z <= w; z++) {
        if (Math.abs(x) !== w && Math.abs(z) !== w) {
          continue;
        }
        const quoin = Math.abs(x) === w && Math.abs(z) === w;
        let c: number;
        if (upper) {
          c = quoin || y === SHAFT + 1 ? TIMBER : PLASTER;
        }
        // Coursed wall: alternate by COURSE with broken joints. `(x+z+y)%2`
        // would paint a draughts board at this gauge.
        else {
          c = quoin ? STONE_L : (y + Math.floor((x + z) / 3)) % 2 === 0 ? STONE : STONE_D;
        }
        v.set(x, y, z, shade(c, 0.88 + r() * 0.24));
      }
    }
  }
  for (let x = -1; x <= 1; x++) {
    for (let y = 1; y <= 4; y++) v.set(x, y, W, shade(WOOD_D, 0.8));
  }
  for (let y = 6; y < SHAFT; y += 5) {
    v.setEmissive(0, y, W, LAMP, 1.1);
    v.setEmissive(0, y + 1, W, LAMP, 1.1);
    v.setEmissive(W, y + 2, 0, LAMP, 1.1);
  }
  for (let y = SHAFT + 3; y <= SHAFT + 5; y++) {
    for (const d of [-1, 0, 1]) {
      v.setEmissive(d, y, W + 1, LAMP, 1.3);
      v.setEmissive(d, y, -(W + 1), LAMP, 1.3);
      v.setEmissive(W + 1, y, d, LAMP, 1.3);
      v.setEmissive(-(W + 1), y, d, LAMP, 1.3);
    }
  }
  const base = SHAFT + UPPER + 1;
  for (let k = 0; k <= W + 2; k++) {
    const w = W + 2 - k;
    const y = base + k;
    for (let x = -w; x <= w; x++) {
      for (let z = -w; z <= w; z++) {
        if (k > 0 && Math.abs(x) !== w && Math.abs(z) !== w) {
          continue;
        }
        v.set(x, y, z, shade(k % 2 === 0 ? ROOF : ROOF_D, 0.9 + r() * 0.2));
      }
    }
  }
  const top = base + W + 3;
  for (let y = top; y <= top + 5; y++) {
    v.set(0, y, 0, shade(IRON, 1.0));
  }
  for (let x = 1; x <= 4; x++) {
    for (let y = top + 3; y <= top + 4; y++) {
      v.set(x, y, 0, shade(x % 2 === 0 ? FLAG_C : FLAG_W, 1.0));
    }
  }
  return bakeSolid(v, SV);
}

/**
 * A fence panel: two posts and two rails, six cells long. Marks the rim without
 * closing it — stamped with gaps (world/sky-island.ts) and low enough to vault.
 */
export function skyFence(): Template {
  const v = new VoxelModel();
  const r = mulberry32(0x0fe4);
  for (let y = 0; y <= 3; y++) {
    v.set(-3, y, 0, shade(WOOD_D, 0.9 + r() * 0.2));
    v.set(3, y, 0, shade(WOOD_D, 0.9 + r() * 0.2));
  }
  for (let x = -3; x <= 3; x++) {
    v.set(x, 1, 0, shade(WOOD, 0.9 + r() * 0.2));
    v.set(x, 3, 0, shade(WOOD, 0.9 + r() * 0.2));
  }
  return bakeSolid(v, SV);
}

export function skyLamp(): Template {
  const v = new VoxelModel();
  for (let y = 0; y <= 8; y++) {
    v.set(0, y, 0, shade(y < 2 ? STONE_D : WOOD_D, 1.0));
  }
  v.set(0, 9, 0, shade(IRON, 1.0));
  v.box(-1, 7, -1, 1, 8, 1, shade(IRON, 0.9));
  v.setEmissive(0, 8, 0, LAMP, 2.2);
  return bakeSolid(v, SV);
}

export function skyWell(): Template {
  const v = new VoxelModel();
  const r = mulberry32(0x3e11);
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) {
      if (Math.abs(x) < 2 && Math.abs(z) < 2) {
        continue;
      }
      for (let y = 0; y <= 2; y++) {
        v.set(x, y, z, shade((x + z + y) % 2 ? STONE : STONE_D, 0.9 + r() * 0.2));
      }
    }
  }
  for (let y = 3; y <= 7; y++) {
    v.set(-2, y, 0, shade(WOOD_D, 1.0));
    v.set(2, y, 0, shade(WOOD_D, 1.0));
  }
  for (let x = -2; x <= 2; x++) {
    v.set(x, 7, 0, shade(WOOD, 1.05));
  }
  for (let x = -3; x <= 3; x++) {
    for (let z = -1; z <= 1; z++) {
      v.set(x, 8 + (z === 0 ? 1 : 0), z, shade(z === 0 ? ROOF_L : ROOF, 1.0));
    }
  }
  return bakeSolid(v, SV);
}

export function skyStall(): Template {
  const v = new VoxelModel();
  for (const [px, pz] of [
    [-3, -2],
    [3, -2],
    [-3, 2],
    [3, 2],
  ] as const) {
    for (let y = 0; y <= 5; y++) {
      v.set(px, y, pz, shade(WOOD_D, 1.0));
    }
  }
  for (let x = -4; x <= 4; x++) {
    for (let z = -3; z <= 3; z++) {
      v.set(x, 6, z, shade(Math.floor((x + 8) / 2) % 2 === 0 ? ROOF : PLASTER, 1.0));
    }
  }
  for (let x = -3; x <= 3; x++) {
    for (let z = -2; z <= 2; z++) {
      v.set(x, 2, z, shade(WOOD, 1.0));
    }
  }
  v.box(-2, 3, -1, -1, 3, 0, shade(0xc4622f, 1.0));
  v.box(1, 3, 0, 2, 3, 1, shade(0x6fae4a, 1.0));
  return bakeSolid(v, SV);
}

/**
 * The gate: timber posts, crossbeam, hanging banner, stone threshold. No wall
 * attached — it stands ON the rim to break its silhouette.
 */
export function skyGate(): Template {
  const v = new VoxelModel();
  const r = mulberry32(0x9a7e);
  for (let x = -5; x <= 5; x++) {
    for (let z = -3; z <= 3; z++) {
      v.set(x, 0, z, shade((x + z) % 2 === 0 ? STONE : STONE_D, 0.9 + r() * 0.2));
    }
  }
  for (const px of [-4, 4] as const) {
    for (let y = 1; y <= 12; y++) {
      const w = y <= 2 ? 1 : 0;
      for (let dx = -w; dx <= w; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          v.set(px + dx, y, dz, shade(y % 4 === 0 ? TIMBER_D : TIMBER, 0.9 + r() * 0.2));
        }
      }
    }
  }
  for (let x = -5; x <= 5; x++) {
    for (let z = -1; z <= 1; z++) {
      v.set(x, 13, z, shade(TIMBER, 1.0));
      v.set(x, 14, z, shade(TIMBER_D, 0.95));
    }
  }
  for (let x = -2; x <= 2; x++) {
    for (let y = 7; y <= 12; y++) {
      const edge = x === -2 || x === 2 || y === 12;
      v.set(x, y, 0, shade(edge ? ROOF_D : ROOF, 0.95 + r() * 0.15));
    }
  }
  v.set(0, 10, 1, shade(FLAG_W, 1.05));
  v.set(-1, 9, 1, shade(FLAG_W, 1.05));
  v.set(1, 9, 1, shade(FLAG_W, 1.05));
  for (const px of [-4, 4] as const) {
    v.setEmissive(px, 12, 2, LAMP, 2.0);
  }
  return bakeSolid(v, SV);
}

export function skyBush(big: boolean): Template {
  const v = new VoxelModel();
  const r = mulberry32(big ? 0x21b1 : 0x21b2);
  const R = big ? 2.6 : 1.7;
  v.ellipsoid(0, R * 0.8, 0, R, R * 0.8, R, 0x4f7a34);
  // Lit crown painted, not lit — as the canopy builders in world/props.ts do.
  v.ellipsoid(0, R * 1.1, 0, R * 0.8, R * 0.5, R * 0.8, 0x69973f);
  if (big && r() > 0.4) {
    v.set(1, Math.round(R * 1.4), 0, 0xd8d264);
    v.set(-1, Math.round(R * 1.2), 1, 0xd07a86);
  }
  return bakeSolid(v, SV);
}

/** Chimney smoke: static cubes, not particles — rides the town's merged mesh. */
export function skySmoke(): Template {
  const v = new VoxelModel();
  const r = mulberry32(0x53a1);
  let x = 0;
  let z = 0;
  for (let k = 0; k < 6; k++) {
    const y = k * 2;
    const w = k < 2 ? 0 : 1;
    for (let dx = -w; dx <= w; dx++) {
      for (let dz = -w; dz <= w; dz++) {
        if (w > 0 && Math.abs(dx) + Math.abs(dz) > 1) {
          continue;
        }
        v.set(x + dx, y, z + dz, shade(0xd8d8d4, 0.9 + r() * 0.2));
      }
    }
    x += r() > 0.4 ? 1 : 0;
    z += r() > 0.7 ? 1 : 0;
  }
  return bakeSolid(v, SV);
}
