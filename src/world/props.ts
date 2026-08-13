/**
 * Vegetation & decoration props. Templates are baked once, then stamped into two
 * merged meshes per chunk: a shadow-casting "solid" mesh and a "soft" mesh
 * (grass, flowers) that only receives shadows.
 */
import * as THREE from "three";
import { VoxelModel, shade } from "../core/voxel";
import { hashCell, mulberry32 } from "./noise";
import type { Terrain } from "./terrain";
import { CHUNK_SIZE, WATER_LEVEL, makeScratch, type ColumnScratch } from "./terrain";
import { type RoadClearance } from "./roads";
import { SWAY_BOUND_PAD } from "./sway";
import { nature, natureCount } from "./nature";
import { flags } from "../core/flags";
import type { SiteClearance } from "../core/types";

/**
 * One box of a template's SOLID FOOTPRINT, in TEMPLATE units (bake scale already
 * in, so a stamp applies only its own girth/height). Axis-aligned in the
 * template's frame; the stamp's yaw makes it oriented. A list, because one model
 * is often several obstacles. Derived by `measureFootprint` in structures.ts.
 */
export interface SolidBox {
  /** Centre, relative to the template origin, on the template's own x/z. */
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  /** Top face, above the template's base (y = 0). */
  top: number;
}

/**
 * A ROOF: one cylinder on its side along a ridge, template units like `SolidBox`.
 * The second and last collision primitive — a box over a gable is issue #3, a
 * cage floating above the thatch. Elliptic because `Accum` scales girth and
 * height independently.
 */
export interface SolidRidge {
  /** Centre of the axis, relative to the template origin, on its own x/z. */
  cx: number;
  cz: number;
  /** Bearing of the axis in the template's frame; 0 runs along +z. */
  axis: number;
  /** Half-length along the axis — gable to gable. */
  hl: number;
  /** Horizontal semi-axis: half the span across the ridge. */
  r: number;
  /** Height of the cylinder's axis above the template base (y = 0). */
  y: number;
  /** Vertical semi-axis, so the crest stands at `y + ry`. */
  ry: number;
  /** Worst gap between cylinder and thatch, template units. Reported by `__dbgRidges()`. */
  fitError: number;
}

/** A baked, stampable voxel model. Towns use the same machinery — see `bakeProp`. */
export interface Template {
  pos: Float32Array;
  nrm: Float32Array;
  col: Float32Array;
  idx: ArrayLike<number>;
  /**
   * Furthest vertex from the stamp axis, TEMPLATE units. A circumscribing disc,
   * because a stamp yaws and only an axis-measured extent holds for every yaw.
   * The prop's own size only; "too close to a wall" is the caller's business.
   */
  spanR: number;
  /** Height of the tallest vertex above the model's base. */
  spanY: number;
  /**
   * The tree inside this template, TEMPLATE units. `r`/`top` are the shaft, the
   * only solid part; the crown is an ellipsoid so the walkable surface is
   * `crownCy + crownRy * sqrt(1 - d^2/crownR^2)` rather than a flat lid.
   * Templates carrying this bake UNCENTRED, so the shaft axis is the model
   * origin — the stamp yaws about the trunk and the registry records the
   * climbable line.
   */
  trunk?: { r: number; top: number; crownR: number; crownCy: number; crownRy: number };
  /**
   * What this template BLOCKS; absent means walk-through scenery. Attached by
   * `bakeSolid` (structures.ts) at bake time, so a part cannot be resized
   * without its collider moving with it.
   */
  solid?: readonly SolidBox[];
  /** The ROOFS on this template — a list, since a building with two wings has two ridges. */
  ridge?: readonly SolidRidge[];
  /**
   * Tallest vertex, marking this as something that BENDS (grass, reeds); absent
   * means rigid. `Accum` divides each vertex's y by it into the `bsSwayH`
   * attribute, 0 at root to 1 at tip — all sway.ts's shader needs.
   */
  swayHeight?: number;
}

/**
 * Undo VoxelModel's baked fake-sun face table (top 1.0, ±X 0.88, ±Z 0.80, bottom
 * 0.62) and warm the shaded faces instead, or the bake stacks on the real sun.
 * ISOTROPIC, because every stamp is randomly yawed.
 */
export function relight(nrm: Float32Array, col: Float32Array): void {
  for (let i = 0; i < nrm.length; i += 3) {
    const ny = nrm[i + 1];
    let lift: number;
    if (ny > 0.5) {
      lift = 1;
    } // top: already 1.0, leave alone
    else if (ny < -0.5) {
      lift = 0.86 / 0.62;
    } // bottom
    else if (Math.abs(nrm[i]) > 0.5) {
      lift = 0.96 / 0.88;
    } // +/-X
    else {
      lift = 0.96 / 0.8;
    } // +/-Z
    const warm = ny > 0.5 ? 0 : 0.055;
    col[i] *= lift * (1 + warm);
    col[i + 1] *= lift;
    col[i + 2] *= lift * (1 - warm);
  }
}

/** `Template.spanR` / `spanY`, measured off the vertices — never authored. */
function measureSpan(pos: ArrayLike<number>): { spanR: number; spanY: number } {
  let r2 = 0;
  let spanY = 0;
  for (let i = 0; i < pos.length; i += 3) {
    const d = pos[i] * pos[i] + pos[i + 2] * pos[i + 2];
    if (d > r2) {
      r2 = d;
    }
    if (pos[i + 1] > spanY) {
      spanY = pos[i + 1];
    }
  }
  return { spanR: Math.sqrt(r2), spanY };
}

/**
 * Bake a voxel model to a stampable template. `trunkR`/`trunkTop` are in VOXELS
 * and make it a climbable tree; passing them also flips `build` to uncentred, so
 * the model origin is the shaft axis. y = 0 is the lowest voxel either way.
 */
function bake(model: VoxelModel, scale: number, trunkR?: number, trunkTop?: number): Template {
  const mesh = model.build(scale, trunkR === undefined);
  const g = mesh.geometry;
  const pos = (g.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
  const t: Template = {
    pos,
    nrm: (g.getAttribute("normal") as THREE.BufferAttribute).array as Float32Array,
    col: (g.getAttribute("color") as THREE.BufferAttribute).array as Float32Array,
    idx: g.getIndex()!.array,
    ...measureSpan(pos),
  };
  if (trunkR !== undefined && trunkTop !== undefined) {
    // Foliage = beyond the flared bole AND above mid-shaft; the radial test alone
    // lets root buttresses in. sqrt(2) reaches the square bole's CORNERS.
    const bole = (trunkR + 1) * scale * Math.SQRT2;
    const foliageFloor = trunkTop * scale * 0.5;
    let crownR = 0;
    let crownLo = Infinity;
    let crownHi = -Infinity;
    for (let i = 0; i < t.pos.length; i += 3) {
      const y = t.pos[i + 1];
      if (y <= foliageFloor) {
        continue;
      }
      const d = Math.hypot(t.pos[i], t.pos[i + 2]);
      if (d <= bole) {
        continue;
      }
      if (d > crownR) {
        crownR = d;
      }
      if (y < crownLo) {
        crownLo = y;
      }
      if (y > crownHi) {
        crownHi = y;
      }
    }
    if (crownLo === Infinity) {
      crownLo = trunkTop * scale;
      crownHi = crownLo;
    }

    // Measured, not `trunkR`: that is the half-width to a FACE, so a disc of it is
    // inscribed and the hero walks into the bark.
    let boleR = 0;
    // Band floor above the root flare, following trunk()'s own `round(h * 0.1)`:
    // a flat `2 * scale` landed exactly on voxel 1's top vertices at some scales.
    const flareTop = (Math.max(2, Math.round(trunkTop * 0.1) + 1) + 0.01) * scale;
    for (let i = 0; i < t.pos.length; i += 3) {
      const y = t.pos[i + 1];
      if (y < flareTop || y > foliageFloor) {
        continue;
      }
      const d = Math.hypot(t.pos[i], t.pos[i + 2]);
      if (d > boleR) {
        boleR = d;
      }
    }
    // Degenerate shaft (a palm's stalk can fall entirely inside the band).
    if (boleR <= 0) {
      boleR = trunkR * scale * Math.SQRT2;
    }

    t.trunk = {
      r: boleR,
      top: trunkTop * scale,
      // 0.84 of the measured reach: a canopy's outermost voxels are mostly air.
      crownR: crownR * 0.84,
      crownCy: (crownHi + crownLo) / 2,
      crownRy: (crownHi - crownLo) / 2,
    };
  }
  relight(t.nrm, t.col);
  (mesh.material as THREE.Material).dispose();
  return t;
}

/**
 * Bake a model with no tree in it — the town builder's entry point. Wrapped so
 * nothing outside this file learns that `bake`'s trunk args also flip centring.
 */
export function bakeProp(model: VoxelModel, scale: number): Template {
  return bake(model, scale);
}

/**
 * Mark a template as something that bends. Height is measured, never authored.
 * Roots sit at y = 0, so a vertex's y IS its height above the root and the ratio
 * survives the per-stamp height scale.
 */
function withSway(t: Template): Template {
  let top = 0;
  for (let i = 1; i < t.pos.length; i += 3) {
    if (t.pos[i] > top) {
      top = t.pos[i];
    }
  }
  if (top > 0) {
    t.swayHeight = top;
  }
  return t;
}

/**
 * Clear air between a prop and built timber, world units. Not a clearance radius
 * — 0.05 is a sixth of a palisade voxel, so grass still grows against a wall
 * (issue #131).
 */
const SITE_SKIN = 0.05;

/**
 * Vertex accumulator for a merged, multi-stamp mesh. See `add`. Exported for the
 * town builder, which merges a whole encampment into two meshes.
 */
export class Accum {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  /**
   * Per-vertex blade height 0..1, null where an accumulator never carries grass.
   * Opt-in: only the chunk's soft mesh runs sway.ts's shader, and this is a byte
   * on every vertex.
   */
  readonly sway: number[] | null;

  /**
   * Where the world's built structures stand, or null where stamps may land
   * anywhere. THE ONE PLACE FOLIAGE IS KEPT OUT OF A BUILDING (issue #131) —
   * everything a chunk grows goes through this method, so the rule is never
   * respelled at a stamp site. It refuses a stamp whose own measured extent would
   * pass through timber and refuses nothing else, so grass grows against a wall.
   * REFUSED AFTER THE DRAWS, so a refusal cannot change what the next chunk grows.
   */
  site: SiteClearance | null = null;
  /** World origin the stamps on this accumulator are local to. */
  siteOx = 0;
  siteOz = 0;

  constructor(sway = false) {
    this.sway = sway ? [] : null;
  }

  /**
   * Stamp one template. `sy` (height) and `sz` (length, the template's own +z) are
   * independent of `s` (girth) — fences and the palisade use `sz` to span an exact
   * gap. Normals are NOT rescaled: anisotropy stays inside ~0.8..1.25, where the
   * shading error is below the per-voxel jitter.
   */
  add(
    t: Template,
    x: number,
    y: number,
    z: number,
    yaw: number,
    s: number,
    tr: number,
    tg: number,
    tb: number,
    sy: number = s,
    sz: number = s,
  ): boolean {
    // Girth widens the disc; `sy` only makes it taller.
    if (
      this.site !== null &&
      this.site.hits(
        this.siteOx + x,
        this.siteOz + z,
        t.spanR * (s > sz ? s : sz) + SITE_SKIN,
        y,
        y + t.spanY * sy,
      )
    ) {
      return false;
    }
    const base = this.pos.length / 3;
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const p = t.pos;
    const n = t.nrm;
    const cl = t.col;
    // A rigid template on a sway accumulator writes zeroes, so it stands still.
    const sw = this.sway;
    const inv = t.swayHeight ? 1 / t.swayHeight : 0;
    for (let i = 0; i < p.length; i += 3) {
      const px = p[i] * s;
      const py = p[i + 1] * sy;
      const pz = p[i + 2] * sz;
      this.pos.push(x + px * c + pz * sn, y + py, z - px * sn + pz * c);
      const nx = n[i];
      const nz = n[i + 2];
      this.nrm.push(nx * c + nz * sn, n[i + 1], -nx * sn + nz * c);
      this.col.push(cl[i] * tr, cl[i + 1] * tg, cl[i + 2] * tb);
      if (sw) {
        const k = p[i + 1] * inv;
        sw.push(k >= 1 ? 255 : (k * 255) | 0);
      }
    }
    const ix = t.idx;
    for (let i = 0; i < ix.length; i++) {
      this.idx.push(base + ix[i]);
    }
    return true;
  }

  toGeometry(): THREE.BufferGeometry | null {
    if (this.idx.length === 0) {
      return null;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    if (this.sway) {
      // Normalised byte, not float: ~30k vertices x 121 chunks, and 1/255 of a
      // blade is finer than any visible bend.
      geo.setAttribute("bsSwayH", new THREE.BufferAttribute(new Uint8Array(this.sway), 1, true));
      // The shader pushes vertices horizontally; without the pad, rim grass is
      // culled a frame early and the meadow edge blinks.
      if (geo.boundingSphere) {
        geo.boundingSphere.radius += SWAY_BOUND_PAD;
      }
    }
    return geo;
  }
}

/**
 * Canopy painter keeping a private copy of what it painted, because VoxelModel is
 * write-only and `bake` needs a second top-to-bottom shading pass.
 */
class Canopy {
  private readonly cells = new Map<string, number>();
  private minX = Infinity;
  private maxX = -Infinity;
  private minZ = Infinity;
  private maxZ = -Infinity;
  private minY = Infinity;
  private maxY = -Infinity;
  private n: number;

  constructor(
    private readonly v: VoxelModel,
    seed: number,
  ) {
    this.n = (seed | 0) >>> 0;
  }

  private rnd(): number {
    this.n = (this.n * 1664525 + 1013904223) >>> 0;
    return ((this.n >>> 9) & 0xffff) / 0x10000;
  }

  private put(x: number, y: number, z: number, color: number): void {
    this.cells.set(`${x},${y},${z}`, color);
    this.v.set(x, y, z, color);
    if (x < this.minX) {
      this.minX = x;
    }
    if (x > this.maxX) {
      this.maxX = x;
    }
    if (z < this.minZ) {
      this.minZ = z;
    }
    if (z > this.maxZ) {
      this.maxZ = z;
    }
    if (y < this.minY) {
      this.minY = y;
    }
    if (y > this.maxY) {
      this.maxY = y;
    }
  }

  /** A leaf clump. `ragged` erodes the rim so the outline is not a machined sphere. */
  clump(
    cx: number,
    cy: number,
    cz: number,
    rx: number,
    ry: number,
    rz: number,
    color: number,
    ragged = 0.2,
  ): void {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
        for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++) {
          const dx = (x - cx) / rx,
            dy = (y - cy) / ry,
            dz = (z - cz) / rz;
          const d = dx * dx + dy * dy + dz * dz;
          if (d > 1.0) {
            continue;
          }
          // Graded by depth, not a flat roll: chews the rim into lobes rather than
          // thinning evenly. The 0.80 floor is shallow enough that nothing detaches.
          if (d > 0.8 && this.rnd() < ragged * ((d - 0.8) / 0.2) * 1.9) {
            continue;
          }
          // TWO frequencies: white noise alone averages out at a few metres, so the
          // coarse term is correlated over 2x2x2 blocks and the fine one breaks it up.
          const cell =
            (((x >> 1) * 73856093) ^ ((y >> 1) * 19349663) ^ ((z >> 1) * 83492791)) >>> 0;
          const coarse = 0.88 + (((cell >>> 7) & 0xff) / 255) * 0.26;
          this.put(x, y, z, shade(color, coarse * (0.945 + this.rnd() * 0.11)));
        }
      }
    }
  }

  /**
   * A rectangular block, recorded like a clump so the shading pass sees it —
   * a boulder needs one flat face and one hard edge to read as rock.
   */
  slab(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    color: number,
  ): void {
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          const cell =
            (((x >> 1) * 73856093) ^ ((y >> 1) * 19349663) ^ ((z >> 1) * 83492791)) >>> 0;
          this.put(x, y, z, shade(color, 0.9 + (((cell >>> 7) & 0xff) / 255) * 0.2));
        }
      }
    }
  }

  /**
   * Repaint the topmost recorded voxel of a PATCH of columns — moss on a boulder.
   * The coarse `(x >> 1, z >> 1)` hash makes colonies rather than speckle.
   * Must run AFTER `bake()`, which would otherwise repaint the moss as stone.
   */
  speckleTop(color: number, prob: number, seed: number): void {
    for (let x = this.minX; x <= this.maxX; x++) {
      for (let z = this.minZ; z <= this.maxZ; z++) {
        let hi = -Infinity;
        for (let y = this.minY; y <= this.maxY; y++) {
          if (this.cells.has(`${x},${y},${z}`)) {
            hi = y;
          }
        }
        if (hi === -Infinity) {
          continue;
        }
        const h = (((x >> 1) * 374761393) ^ ((z >> 1) * 668265263) ^ seed) >>> 0;
        if (((h >>> 11) & 0xff) / 255 > prob) {
          continue;
        }
        this.v.set(x, hi, z, shade(color, 0.86 + (((h >>> 3) & 0x3f) / 63) * 0.28));
      }
    }
  }

  /**
   * Vertical light gradient: sunlit crown, dark underside. `k` scales it toward
   * neutral — a three-voxel bush is all crown and all belly at once.
   */
  bake(k = 1): void {
    const scaled = (v: number): number => 1 + (v - 1) * k;
    for (let x = this.minX; x <= this.maxX; x++) {
      for (let z = this.minZ; z <= this.maxZ; z++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let y = this.minY; y <= this.maxY; y++) {
          if (!this.cells.has(`${x},${y},${z}`)) {
            continue;
          }
          if (y < lo) {
            lo = y;
          }
          hi = y;
        }
        if (lo === Infinity) {
          continue;
        }
        const at = (y: number, m: number): void => {
          const c = this.cells.get(`${x},${y},${z}`);
          if (c !== undefined) {
            this.v.set(x, y, z, shade(c, m));
          }
        };
        // Graded by how high THIS column's top sits: flat, it bleaches the whole
        // upper shell to one value instead of laying a dome of light on the crown.
        const rel = (hi - this.minY) / Math.max(1, this.maxY - this.minY);
        at(hi, scaled(1.02 + 0.26 * rel));
        if (hi - 1 > lo) {
          at(hi - 1, scaled(0.98 + 0.16 * rel));
        }
        at(lo, scaled(0.62));
        if (lo + 1 < hi) {
          at(lo + 1, scaled(0.78));
        }
        if (lo + 2 < hi) {
          at(lo + 2, scaled(0.9));
        }
      }
    }
  }
}

/**
 * Tapered trunk spanning `[-r, r)` in x and z, `r0` at the root to `r1` under the
 * crown, flared at the foot. Centred on voxel 0, so every caller MUST pass
 * `trunkR`/`trunkTop` to `bake` for the uncentred bake — see `Template.trunk`.
 */
function trunk(v: VoxelModel, h: number, base: number, seed: number, r0 = 1, r1 = r0): void {
  let n = seed >>> 0;
  const rnd = (): number => {
    n = (n * 1664525 + 1013904223) >>> 0;
    return ((n >>> 9) & 0xffff) / 0x10000;
  };
  const flareTo = Math.max(1, Math.round(h * 0.1));
  for (let y = 0; y <= h; y++) {
    // Taper done by ~70% up, so the crown sits on a column not a spike.
    const t = Math.min(1, y / h / 0.7);
    let r = Math.max(1, Math.round(r0 + (r1 - r0) * t));
    if (y < flareTo) {
      r += 1;
    } // root flare
    const m = 0.84 + rnd() * 0.3;
    v.box(-r, y, -r, r - 1, y, r - 1, shade(base, m));
  }
  // Root buttresses so the trunk grips the ground.
  const b = r0 + 1;
  v.set(-b - 1, 0, 0, shade(base, 0.78));
  v.set(b, 0, -1, shade(base, 0.86));
  v.set(0, 0, b, shade(base, 0.8));
}

/**
 * Broadleaf canopy palette: a step darker and cooler than the meadow (0x54c832),
 * or a tree dissolves into a grassy hillside. `Canopy.bake` adds a gradient on top.
 */
const CANOPY_DEEP = 0x22662f;
const CANOPY_MID = 0x2d7c36;
const CANOPY_SIDE = 0x35893a;
const CANOPY_LIT = 0x459a43;
const CANOPY_CROWN = 0x5cb251;
const BIRCH_DEEP = 0x3a8c3a;
const BIRCH_MID = 0x4aa044;
const BIRCH_CROWN = 0x6cbe55;

/**
 * TREE SCALE. Foliage must start above ~4 units or it fills the third-person
 * camera, and a canopy costs by SURFACE against the 3 ms chunk-build budget — so
 * size comes mostly from bake scale, not voxel count.
 */

/** Tall, narrow oak with an offset lobe — breaks up the round-oak silhouette. */
function oakTreeTall(): Template {
  const v = new VoxelModel();
  const H = 20;
  trunk(v, H, 0x7a5233, 0x51f7, 2, 1);
  const c = new Canopy(v, 0x2731);
  c.clump(-0.5, H + 3.0, -0.5, 5.6, 6.4, 5.6, CANOPY_MID);
  c.clump(-0.5, H + 8.2, -0.5, 3.8, 3.2, 3.8, CANOPY_CROWN);
  c.clump(3.2, H - 0.5, 1.8, 3.6, 2.8, 3.6, CANOPY_SIDE);
  c.clump(-4.0, H + 4.2, 1.2, 3.2, 2.6, 3.2, CANOPY_LIT);
  c.bake();
  return bake(v, 0.48, 1, H + 1);
}

function oakTree(big: boolean): Template {
  const v = new VoxelModel();
  const h = big ? 15 : 13;
  trunk(v, h, 0x7a5233, big ? 0x91c3 : 0x4b12, 2, 1);
  const c = new Canopy(v, big ? 0x77ab : 0x1d0e);
  // Lobes as fractions of R, so both variants are one tree at two sizes.
  const R = big ? 8.2 : 6.8;
  c.clump(-0.6, h + 3.6, -0.6, R, R * 0.66, R, CANOPY_DEEP);
  c.clump(R * 0.42, h + 6.4, R * 0.2, R * 0.56, R * 0.45, R * 0.56, CANOPY_LIT);
  c.clump(-R * 0.46, h + 5.6, -R * 0.3, R * 0.52, R * 0.42, R * 0.52, CANOPY_MID);
  c.clump(R * 0.1, h + 4.8, R * 0.46, R * 0.42, R * 0.34, R * 0.42, CANOPY_SIDE);
  c.clump(-0.6, h + 8.6, -0.6, R * 0.46, R * 0.3, R * 0.46, CANOPY_CROWN);
  c.bake();
  return bake(v, big ? 0.52 : 0.46, 1.5, h + 1);
}

/**
 * Low, broad, spreading crown on a short trunk — the counter-shape to the other
 * oaks. Shortest tree in the set, so it sets camera clearance: its foliage floor
 * is 5.50 units on a 12-voxel shaft, and an 11-voxel shaft was marginal at 5.00.
 */
function oakTreeBroad(): Template {
  const v = new VoxelModel();
  const H = 12;
  trunk(v, H, 0x744d31, 0x3ac1, 2, 2);
  const c = new Canopy(v, 0x6f22);
  c.clump(0, H + 3.0, 0, 9.0, 5.2, 8.6, CANOPY_DEEP);
  c.clump(-4.2, H + 5.0, 2.2, 4.6, 3.2, 4.4, CANOPY_MID);
  c.clump(4.6, H + 4.4, -2.6, 4.4, 3.0, 4.2, CANOPY_SIDE);
  c.clump(0.6, H + 6.6, 0.4, 4.2, 2.8, 4.0, CANOPY_LIT);
  c.clump(-1.2, H + 8.4, -1.0, 2.6, 1.8, 2.6, CANOPY_CROWN);
  c.bake();
  return bake(v, 0.5, 1.8, H + 1);
}

function birchTree(): Template {
  const v = new VoxelModel();
  const H = 18;
  for (let y = 0; y <= H; y++) {
    v.box(
      -1,
      y,
      -1,
      0,
      y,
      0,
      y % 7 === 2 || y % 7 === 5 ? 0x8f7752 : y % 5 === 3 ? 0xb59d78 : 0xc9b184,
    );
  }
  v.set(-2, 0, 0, 0xb59d78);
  v.set(0, 0, 1, 0xa89066);
  const c = new Canopy(v, 0xbb31);
  c.clump(-0.5, H + 3.4, -0.5, 5.4, 4.6, 5.4, BIRCH_MID);
  c.clump(2.0, H + 6.4, 1.0, 3.2, 2.4, 3.2, BIRCH_CROWN);
  c.clump(-2.6, H + 2.0, -1.4, 3.0, 2.4, 3.0, BIRCH_DEEP);
  c.bake();
  return bake(v, 0.42, 1, H + 1);
}

function pineTree(tall: boolean): Template {
  const v = new VoxelModel();
  const g1 = 0x2f8442;
  const g2 = 0x3f9c50;
  const snow = 0xd2e4ee;
  // Bare shaft under the first tier, or there is no bole to climb.
  const bare = tall ? 12 : 10;
  trunk(v, bare, 0x6b4a2e, tall ? 0x3d71 : 0x71c4, 2, 1);
  // [radius, y0, y1] tiers stacked from `bare` up.
  const layers: Array<[number, number, number]> = tall
    ? [
        [6, 0, 3],
        [5, 4, 7],
        [4, 8, 11],
        [3, 12, 14],
        [2, 15, 17],
        [1, 18, 19],
      ]
    : [
        [5, 0, 3],
        [4, 4, 6],
        [3, 7, 9],
        [2, 10, 12],
        [1, 13, 14],
      ];
  let n = 0x9e11;
  for (let li = 0; li < layers.length; li++) {
    const [r, ly0, ly1] = layers[li];
    const y0 = bare + ly0;
    const y1 = bare + ly1;
    const base = li % 2 === 0 ? g1 : g2;
    const tierM = 0.78 + (li / Math.max(1, layers.length - 1)) * 0.44;
    // ROUND tiers: square slabs stack into a ziggurat, and a disc is also cheaper.
    const r2 = (r + 0.45) * (r + 0.45);
    for (let x = -r; x <= r; x++) {
      for (let z = -r; z <= r; z++) {
        const d2 = x * x + z * z;
        if (d2 > r2) {
          continue;
        }
        for (let y = y0; y <= y1; y++) {
          n = (n * 1664525 + 1013904223) >>> 0;
          const j = 0.9 + (((n >>> 12) & 0xff) / 255) * 0.2;
          v.set(x, y, z, shade(base, tierM * j * (y === y0 ? 0.74 : 1)));
        }
        // Snow rim-weighted: a solid lid per tier reads as a barber pole.
        n = (n * 1664525 + 1013904223) >>> 0;
        if (((n >>> 9) & 0xff) / 255 < 0.2 + (d2 / r2) * 0.6) {
          v.set(x, y1, z, shade(snow, 0.88 + (((n >>> 19) & 0x3f) / 63) * 0.22));
        }
      }
    }
  }
  return bake(v, tall ? 0.5 : 0.44, 1, bare);
}

/** Asymmetric pine — tier offsets wobble so the cone silhouette isn't a stamp. */
function pineIrregular(): Template {
  const v = new VoxelModel();
  const bare = 10;
  trunk(v, bare, 0x6b4a2e, 0x1ac9, 2, 1);
  const g1 = 0x2f8244;
  const g2 = 0x3a9349;
  const snow = 0xd2e4ee;
  // [radius, y0, y1, xOffset, zOffset], y relative to the top of the bare shaft
  const layers: Array<[number, number, number, number, number]> = [
    [5, 0, 3, 1, 0],
    [5, 4, 6, -2, 1],
    [4, 7, 9, 0, -2],
    [3, 10, 12, 1, 0],
    [2, 13, 15, 0, 1],
    [1, 16, 17, -1, 0],
  ];
  // As `pineTree`, but tiers OFFSET from the axis so the discs overhang.
  let n = 0x51c7;
  for (let li = 0; li < layers.length; li++) {
    const [r, y0, y1, dx, dz] = layers[li];
    const base = li % 2 === 0 ? g1 : g2;
    const r2 = (r + 0.45) * (r + 0.45);
    for (let x = -r; x <= r; x++) {
      for (let z = -r; z <= r; z++) {
        const d2 = x * x + z * z;
        if (d2 > r2) {
          continue;
        }
        for (let y = bare + y0; y <= bare + y1; y++) {
          n = (n * 1664525 + 1013904223) >>> 0;
          const j = 0.9 + (((n >>> 12) & 0xff) / 255) * 0.2;
          v.set(x + dx, y, z + dz, shade(base, j * (y === bare + y0 ? 0.78 : 1)));
        }
        n = (n * 1664525 + 1013904223) >>> 0;
        if (((n >>> 9) & 0xff) / 255 < 0.2 + (d2 / r2) * 0.6) {
          v.set(x + dx, bare + y1, z + dz, shade(snow, 0.88 + (((n >>> 19) & 0x3f) / 63) * 0.22));
        }
      }
    }
  }
  return bake(v, 0.46, 1, bare);
}

/**
 * Dead standing snag: bare bole, broken top, no foliage. All silhouette and no
 * mass, and by far the cheapest tree in the set.
 *
 * Every limb must start ABOVE mid-shaft: `bake` measures the bole radius up to
 * `trunkTop * 0.5`, so a lower limb would inflate the collide cylinder to its reach.
 */
function deadSnag(tall: boolean): Template {
  const v = new VoxelModel();
  // 7.5 / 10.8 units of bare bole — as high as the broadleaf crowns start.
  const H = tall ? 20 : 15;
  const bark = 0x6f5c45;
  trunk(v, H, bark, tall ? 0x2c81 : 0x5f31, 2, 1);
  v.set(0, H + 1, 0, shade(bark, 1.12));
  v.set(-1, H + 1, 0, shade(bark, 0.9));
  v.set(-1, H + 2, 0, shade(bark, 1.04));
  // [dx, dz, y0, length]; limbs rise as they reach out.
  const limbs: Array<[number, number, number, number]> = tall
    ? [
        [1, 0, 12, 5],
        [-1, 0, 14, 4],
        [0, 1, 16, 4],
        [0, -1, 17, 3],
      ]
    : [
        [1, 0, 9, 4],
        [-1, 0, 11, 3],
        [0, 1, 12, 3],
      ];
  for (const [dx, dz, y0, len] of limbs) {
    for (let k = 1; k <= len; k++) {
      const y = y0 + Math.floor(k * 0.7);
      v.set(dx * k, y, dz * k, shade(bark, k > len - 2 ? 1.14 : 0.94));
      // Keeps the run face-connected where the rise steps up.
      v.set(dx * k, y - 1, dz * k, shade(bark, 0.84));
    }
  }
  return bake(v, tall ? 0.54 : 0.5, 1, H);
}

/** Palm: frond count, lean slope and height multiplier vary the beach line. */
function palmTree(fronds: number, lean: number, heightMul: number): Template {
  const v = new VoxelModel();
  const trunkC = 0x8a6238;
  const H = Math.max(16, Math.round(22 * heightMul));
  let topX = 0;
  for (let y = 0; y <= H; y++) {
    const xo = Math.round(y * lean);
    v.box(xo - 1, y, -1, xo, y, 0, y % 3 === 0 ? 0x7a5530 : trunkC);
    topX = xo;
  }
  const topY = H + 1;
  const leaf = 0x3f9e45;
  const leafL = 0x55b858;
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + fronds * 0.73;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    // Width along the frond's own PERPENDICULAR, or fronds along z stay 1 voxel wide.
    const qx = Math.round(-dz);
    const qz = Math.round(dx);
    for (let k = 1; k <= 8; k++) {
      const y = topY + (k <= 2 ? 1 : k <= 5 ? 0 : -(k - 5));
      const cx = topX + Math.round(dx * k);
      const cz = Math.round(dz * k);
      v.set(cx, y, cz, k >= 6 ? leafL : leaf);
      if (k <= 6) {
        v.set(cx + qx, y, cz + qz, k >= 5 ? leafL : leaf);
      }
      if (k >= 2 && k <= 5) {
        v.set(cx - qx, y, cz - qz, leaf);
      }
    }
  }
  v.box(topX - 1, topY, -1, topX, topY, 0, leaf);
  v.box(topX - 1, topY + 1, -1, topX, topY + 1, 0, leafL);
  v.set(topX - 2, topY - 1, 0, 0x5c3d24);
  v.set(topX + 1, topY - 1, 1, 0x5c3d24);
  return bake(v, 0.36, 1, H);
}

function cactus(small: boolean): Template {
  const v = new VoxelModel();
  const c = 0x3d9950;
  const cl = 0x54b862;
  v.box(-1, 0, 0, 0, small ? 5 : 9, 0, c);
  v.box(0, 1, 0, 0, small ? 4 : 8, 0, cl);
  if (!small) {
    v.set(1, 4, 0, c);
    v.box(2, 4, 0, 2, 7, 0, c);
    v.set(2, 7, 0, cl);
    v.set(-2, 5, 0, c);
    v.box(-3, 5, 0, -3, 8, 0, c);
    v.set(-3, 8, 0, cl);
    v.set(0, small ? 6 : 10, 0, 0xd08b9e);
  }
  return bake(v, small ? 0.16 : 0.18);
}

function rock(kind: 0 | 1 | 2, mossy = false): Template {
  const v = new VoxelModel();
  // A wide warm range. The dark end stays light: the shading pass takes another
  // 23% off it, and albedo painted dark ends up a hueless near-black chip.
  const warmA = 0xbdb2a0;
  const warmB = 0x9c917f;
  const warmC = 0x847a6b;
  const warmD = 0x6f6558;
  // Painted through Canopy (misnamed here) so the second pass shades each column
  // top-down. Every boulder needs one flat, fractured plane to read as stone.
  const g = new Canopy(v, 0x51a3 + kind * 71);
  if (kind === 0) {
    g.clump(0, 0.8, 0, 3, 2, 2.4, warmB, 0.12);
    g.clump(0.8, 1.8, 0.2, 1.5, 1, 1.2, warmA, 0);
    g.clump(-1.6, 0.2, -0.9, 1.9, 0.9, 1.6, warmD, 0.2);
    g.slab(-1, 2, -2, 2, 2, 1, warmA);
    v.set(4, -1, 1, shade(warmC, 0.96));
    v.box(-4, -1, -1, -4, 0, -1, shade(warmA, 0.9));
  } else if (kind === 1) {
    g.clump(0, 1, 0, 3.6, 2.6, 3, warmC, 0.12);
    g.clump(-1.4, 1.2, 0.8, 2, 1.6, 1.6, warmB, 0);
    g.clump(1.6, 2.4, -0.6, 1.4, 1, 1.2, warmA, 0);
    g.clump(1.2, 0.1, 1.8, 2.2, 1.0, 1.8, warmD, 0.2);
    g.slab(-3, 1, -2, -1, 2, 1, warmB);
    g.slab(-3, 0, -1, 3, 0, 2, warmD);
    v.box(5, -1, 2, 5, 0, 2, shade(warmB, 0.92));
    v.set(-4, -1, -3, shade(warmA, 0.88));
  } else {
    g.clump(0, 0.8, 0, 3, 2, 2.4, warmC, 0.12);
    g.clump(-1.4, 0.2, 1.0, 1.8, 0.9, 1.5, warmD, 0.2);
    g.slab(-2, 1, -1, 1, 1, 2, warmB);
    v.set(4, -1, 0, shade(warmB, 0.94));
  }
  // 0.6 strength: a 4-voxel boulder under the full canopy ramp is a two-tone stack.
  g.bake(0.6);
  // Lichen crust, desaturated to ~a third of the meadow's chroma: meadow-green
  // stops reading as stone. Placement picks these in plains and forest only.
  if (mossy) {
    g.speckleTop(0x4a7a38, 0.55, 0x51a3 + kind * 71);
    g.speckleTop(0x5c8a3c, 0.22, 0x9c17 + kind * 37);
  }
  // After the shading pass, which would otherwise repaint the cap as rock.
  if (kind === 2) {
    v.ellipsoid(0, 2.1, 0, 2.4, 0.9, 1.9, 0xe9f2f7);
  }
  return bake(v, kind === 1 ? 0.28 : 0.2);
}

/**
 * Chunky voxel tussock, four silhouettes (`variant` 0-3). A solid volume, so the
 * screen-space occlusion pass reads it where a 2-pixel billboard is crushed.
 * Each shape is ASYMMETRIC — a symmetric footprint gains nothing from the random
 * per-instance yaw.
 */
function grassTuft(dry: boolean, variant = 0): Template {
  const v = new VoxelModel();
  // Mid tone just UNDER the sward, only the tips brighter: a tuft lighter than the
  // grass reads as fuzz lying on it. Authored against `relight` above.
  const a = dry ? 0xc4b473 : 0x58a83c;
  const b = dry ? 0xb2a066 : 0x4b9634;
  const c = dry ? 0xd8c88c : 0x86c95a;
  const root = dry ? 0x8b7d50 : 0x33682a;
  // [x, z, height] over face-connected 1x1 cells — a SOLID mound, since thin
  // geometry with air behind it wrecks the occlusion pass. 1x1 columns at double
  // the bake scale, not 2x2: same silhouette, a third of the triangles.
  const SHAPES: Array<Array<[number, number, number]>> = [
    [
      [0, 0, 1],
      [1, 0, 2],
      [1, 1, 0],
      [0, -1, 0],
      [-1, 0, 0],
      [2, 0, 0],
    ],
    [
      [0, -1, 0],
      [0, 0, 0],
      [0, 1, 2],
      [1, 1, 1],
      [0, 2, 0],
      [-1, 0, 0],
    ],
    [
      [0, 0, 2],
      [1, 0, 0],
      [2, 0, 1],
      [2, 1, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 2],
      [-1, 0, 0],
      [-1, 1, 0],
      [1, 2, 0],
    ],
  ];
  const cells = SHAPES[variant % SHAPES.length];
  for (let s = 0; s < cells.length; s++) {
    const [x, z, h] = cells[s];
    for (let y = 0; y <= h; y++) {
      v.set(x, y, z, y === 0 ? root : s % 3 === 0 ? a : b);
    }
    if (h >= 2) {
      v.set(x, h, z, c);
    }
  }
  // The tussock's readable MASS, not the clump count, is the knob to turn: scaling
  // it costs no triangles. Tallest cell lands at 0.63 units, under a terrain step.
  return withSway(bake(v, 0.21));
}

/**
 * The CARPET primitive: a two-or-three-voxel sprig, the cheapest readable ground
 * cover here — ~40 vertices against the tussock's 140, so a chunk can carry
 * hundreds. `addSprig` is cheap at the CALL site too: it seats on `columnHeight`
 * and inherits the clump's tint instead of running a full `columnInfo`.
 *
 * The four variants differ by BAKE SCALE rather than voxel count, because at this
 * size a voxel is pure cost and a scale is free. A lone cube would normally print
 * as a black die (see `shells`), but `relight` lifts the side faces and the sward
 * is saturated enough that a shaded side reads as shade.
 */
function grassSprig(dry: boolean, variant = 0): Template {
  const v = new VoxelModel();
  const a = dry ? 0xc0b070 : 0x54a339;
  const b = dry ? 0xaf9d63 : 0x4a9233;
  const c = dry ? 0xd6c68a : 0x83c657;
  const root = dry ? 0x8b7d50 : 0x33682a;
  /** [x, z, height] over face-connected 1x1 cells, and the bake scale. */
  const SHAPES: Array<{ cells: Array<[number, number, number]>; s: number }> = [
    { cells: [[0, 0, 0]], s: 0.34 },
    { cells: [[0, 0, 1]], s: 0.26 },
    {
      cells: [
        [0, 0, 1],
        [1, 0, 0],
      ],
      s: 0.22,
    },
    {
      cells: [
        [0, 0, 0],
        [0, 1, 0],
      ],
      s: 0.28,
    },
  ];
  const sh = SHAPES[variant % SHAPES.length];
  for (let s = 0; s < sh.cells.length; s++) {
    const [x, z, h] = sh.cells[s];
    for (let y = 0; y <= h; y++) {
      // Contact-shade root only where something stands above it, or a one-voxel
      // sprig is just a dark chip on lit grass.
      v.set(x, y, z, h > 0 && y === 0 ? root : s % 2 === 0 ? a : b);
    }
    if (h >= 1) {
      v.set(x, h, z, c);
    }
  }
  return withSway(bake(v, sh.s));
}

/**
 * A low mat of flowering ground cover in a NON-GREEN hue: meadow colour arrives
 * as drifts of one species, and a single `flower` blossom is ~9 pixels at 40
 * units — under the threshold where a hue reads as anything. A flat mass of
 * one-voxel cells is also the cheaper geometry. `petal`/`rim` stay off full
 * chroma or the drift reads as a decal.
 */
function bloomMat(petal: number, rim: number, leaf: number): Template {
  const v = new VoxelModel();
  // Asymmetric about both axes, so the random yaw changes the outline.
  const CELLS: Array<[number, number, number]> = [
    [0, 0, 1],
    [1, 0, 1],
    [2, 0, 0],
    [-1, 0, 0],
    [3, 1, 0],
    [0, 1, 1],
    [1, 1, 0],
    [-1, 1, 0],
    [2, 1, 1],
    [0, -1, 0],
    [1, -1, 1],
    [2, -1, 0],
    [0, 2, 0],
  ];
  for (let i = 0; i < CELLS.length; i++) {
    const [dx, dz, tall] = CELLS[i];
    v.set(dx, 0, dz, shade(leaf, 0.82 + (((i * 37) % 7) / 7) * 0.24));
    v.set(dx, 1, dz, i % 3 === 0 ? rim : petal);
    if (tall) {
      v.set(dx, 2, dz, i % 4 === 0 ? rim : petal);
    }
  }
  // ~0.93 units across, 0.9-1.4 at the meadow pass's roll — the largest ground cover.
  return bake(v, 0.155);
}

/**
 * sRGB hex -> linear triple: three.js reads a raw BufferAttribute as linear, and
 * terrain.ts uses the same conversion, so blades share the ground's convention.
 */
const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const lin = (hex: number): [number, number, number] => [
  srgbToLinear(((hex >> 16) & 255) / 255),
  srgbToLinear(((hex >> 8) & 255) / 255),
  srgbToLinear((hex & 255) / 255),
];

/**
 * A tuft of crossed grass planes. Blades stay around a third of a terrain step,
 * and their colour band is anchored just off the ground's own, or they print as
 * black spikes on grass and acid olive on sand.
 *
 * Three planes at 0/60/120, not two at 0/90: with two there are bearings where one
 * plane is edge-on and the tuft reads as a single leaning card.
 */
function grassBillboard(
  tiltX: number,
  tiltZ: number,
  height: number,
  width: number,
  // The card's UP normal takes the ground's own sun, so a brighter albedo reads as
  // paper scraps. Contrast lives INSIDE the blade: dark root, tip just over the sward.
  rootC: [number, number, number] = lin(0x2f6b1c),
  tipC: [number, number, number] = lin(0x82c745),
): Template {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  /**
   * One blade quad, emitted with BOTH windings over the same four vertices:
   * three.js negates the shading normal on back faces, so a single winding on a
   * DoubleSide material renders half of every meadow as black spikes.
   */
  const quad = (ax: number, az: number, ox: number, oz: number, s: number): void => {
    const base = pos.length / 3;
    const w = width * s;
    const h = height * s;
    const taper = 0.62; // narrower at the tip, but not a needle
    pos.push(
      -ax * w + ox,
      0,
      -az * w + oz,
      ax * w + ox,
      0,
      az * w + oz,
      ax * w * taper + tiltX + ox,
      h,
      az * w * taper + tiltZ + oz,
      -ax * w * taper + tiltX + ox,
      h,
      -az * w * taper + tiltZ + oz,
    );
    // Straight UP, with none of the blade's own facing mixed in: any face-normal
    // component renders some quads near-black in full sun. The root-to-tip vertex
    // gradient carries the form instead.
    for (let i = 0; i < 4; i++) {
      nrm.push(0, 1, 0);
    }
    col.push(...rootC, ...rootC, ...tipC, ...tipC);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  const C60 = 0.5,
    S60 = 0.866;
  quad(1, 0, 0, 0, 1);
  quad(-C60, S60, 0, 0, 0.92);
  quad(-C60, -S60, 0, 0, 0.86);
  quad(C60, S60, 0.11, -0.08, 0.66);
  return withSway({
    pos: new Float32Array(pos),
    nrm: new Float32Array(nrm),
    col: new Float32Array(col),
    idx,
    ...measureSpan(pos),
  });
}

/**
 * A blossom on a stem. Two tones — `petal` lit, `rim` the shaded outer petals —
 * because a single-colour blossom is a flat chip of pure hue in a green/tan world.
 */
function flower(petal: number, rim: number): Template {
  const v = new VoxelModel();
  v.box(0, 0, 0, 0, 2, 0, 0x4a9a3c);
  v.set(1, 1, 0, 0x5cb44a);
  v.set(1, 3, 0, rim);
  v.set(-1, 3, 0, rim);
  v.set(0, 3, 1, rim);
  v.set(0, 3, -1, rim);
  v.set(0, 4, 0, petal);
  v.set(0, 3, 0, 0xf5e7bc);
  return bake(v, 0.11);
}

/**
 * Low rounded leaf bush — the anchor prop for meadow clumps. Darker and cooler
 * than the meadow, as the canopies are, or it dissolves into the sward.
 */
function bush(): Template {
  const v = new VoxelModel();
  const c = new Canopy(v, 0x4a17);
  // No erosion at this size: three voxels tall, so nibbling detaches cells.
  c.clump(0, 1.1, 0, 2.7, 1.5, 2.5, 0x2d7325, 0);
  c.clump(1.3, 1.6, 0.7, 1.6, 1.1, 1.5, 0x3f8e30, 0);
  c.clump(-1.4, 1.4, -0.6, 1.5, 1.0, 1.4, 0x25631f, 0);
  c.bake(0.45);
  v.set(1, 3, 0, 0x5aa843); // highlight sprig
  return bake(v, 0.155);
}

/** Fern: a low rosette of arched fronds — wider than a blade, shorter than a bush. */
function fern(variant: number): Template {
  const v = new VoxelModel();
  const dark = 0x27661f;
  const mid = 0x35802a;
  const light = 0x4a9c39;
  // No variant uses a symmetric subset — symmetry cancels the per-instance yaw.
  const DIRS: Array<[number, number]> = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ];
  /** [direction index, length] per variant. */
  const SETS: Array<Array<[number, number]>> = [
    [
      [0, 4],
      [1, 2],
      [2, 3],
      [4, 3],
      [5, 4],
      [6, 2],
    ],
    [
      [0, 3],
      [2, 4],
      [3, 2],
      [4, 4],
      [6, 3],
      [7, 3],
      [1, 2],
    ],
    [
      [1, 4],
      [2, 2],
      [3, 3],
      [5, 2],
      [6, 4],
      [7, 3],
    ],
  ];
  v.box(0, 0, 0, 0, 3, 0, dark);
  v.set(0, 4, 0, light);
  for (const [d, len] of SETS[variant % SETS.length]) {
    const [dx, dz] = DIRS[d];
    // Along the frond's own perpendicular, or fronds along z stay 1 voxel wide.
    const px = -dz;
    const pz = dx;
    for (let k = 1; k <= len; k++) {
      const tip = k === len;
      const y = tip ? 2 : 3;
      v.set(dx * k, y, dz * k, tip ? light : mid);
      // ONE width cell: two put the fern at 600 vertices, more than a boulder.
      if (k === 1) {
        v.set(dx + px, y, dz + pz, mid);
      }
      if (tip && len >= 2) {
        v.set(dx * (k - 1), y, dz * (k - 1), mid);
      }
    }
  }
  // ~1.1 units wide against 0.68 tall: splayed and low reads as undergrowth.
  return bake(v, 0.135);
}

/** Reeds: a stand of stems with pale seed heads, breaking the waterline seam. */
function reeds(): Template {
  const v = new VoxelModel();
  // 2x1 stems, short: 1x1 columns eight voxels tall read as a picket fence, and a
  // 2-wide stem survives aliasing without being over-bright.
  const stem = 0x5f9c46;
  const stemD = 0x4d843c;
  const head = 0xbda868;
  const offs: Array<[number, number, number]> = [
    [0, 0, 4],
    [2, 0, 3],
    [-2, 1, 4],
    [0, -2, 5],
    [2, 2, 2],
    [-2, -2, 3],
    [4, 0, 3],
  ];
  for (const [x, z, h] of offs) {
    for (let y = 0; y <= h; y++) {
      v.box(x, y, z, x + 1, y, z, y % 3 === 0 ? stemD : stem);
    }
    v.box(x, h + 1, z, x + 1, h + 1, z, head);
  }
  // Reeds bend with the grass; a rigid bed beside a waving sward is what you notice.
  return withSway(bake(v, 0.17));
}

/** Dead branch — dry litter, tiny and desaturated, to break up bare ground. */
function deadwood(): Template {
  const v = new VoxelModel();
  const w = 0x7d6b52;
  v.box(-2, 0, 0, 2, 0, 0, w);
  v.set(3, 0, 1, shade(w, 0.86));
  v.set(-1, 1, 0, shade(w, 1.08));
  v.set(1, 0, -1, shade(w, 0.92));
  return bake(v, 0.13);
}

/**
 * Weathered driftwood log for the beach band. Knobbly on purpose: a smooth
 * one-tone prism on flat sand reads as a bar of soap.
 */
function driftwood(): Template {
  const v = new VoxelModel();
  const wood = 0x9b8468;
  const woodL = 0xb5a084;
  const woodD = 0x776350;
  for (let x = -3; x <= 3; x++) {
    v.set(x, 0, 0, x % 2 === 0 ? wood : woodD);
  }
  v.box(-2, 1, 0, 1, 1, 0, woodL);
  v.set(-1, 1, 1, woodD); // split down the flank
  v.set(2, 0, 1, wood);
  v.set(4, 0, 0, woodD); // broken tip
  v.set(-4, 1, 0, woodL); // upturned root end
  v.set(-4, 0, -1, woodD);
  v.set(1, 1, 1, shade(woodL, 0.9)); // branch stub
  return bake(v, 0.16);
}

/** Fallen log — a mid-scale occluder: 2-wide mossy trunk, ~3m long, waist high. */
function fallenLog(): Template {
  const v = new VoxelModel();
  const bark = 0x6b4f33;
  const barkL = 0x7d5e3d;
  const moss = 0x5aa845;
  for (let x = -5; x <= 5; x++) {
    v.box(x, 0, 0, x, 1, 1, x % 3 === 0 ? bark : barkL);
  }
  v.set(6, 0, 0, shade(bark, 0.82)); // splintered end
  v.set(6, 1, 1, shade(bark, 0.9));
  v.set(-6, 1, 1, shade(barkL, 0.88)); // torn root end
  v.set(-3, 2, 0, moss);
  v.set(0, 2, 1, shade(moss, 1.08));
  v.set(2, 2, 0, moss);
  v.set(3, 2, 1, shade(moss, 0.92));
  v.set(1, 1, 2, bark); // branch stubs
  v.set(-2, 1, -1, barkL);
  return bake(v, 0.22);
}

/**
 * Waist-high hedge clump — the size class between grass and tree.
 *
 * Needs ~5 voxels across the short axis: an ellipsoid of radius 1.8 rasterises to
 * a PLUS SIGN, so radii are large and the bake scale small to keep the world size.
 * Painted through `Canopy`, not `v.ellipsoid`, which writes one flat colour a lobe.
 * Greens sit darker than the sward or the shrub has no silhouette.
 */
function hedgeClump(): Template {
  const v = new VoxelModel();
  v.box(0, 0, 0, 0, 2, 0, 0x6a5233);
  const c = new Canopy(v, 0x7c31);
  c.clump(0, 3.5, 0, 5.4, 3.8, 4.5, 0x2c6f24, 0.34);
  c.clump(4.1, 4.1, -1.6, 3.5, 3.0, 3.2, 0x387f2c, 0.34);
  c.clump(-3.8, 3.2, 1.9, 3.2, 2.7, 3.0, 0x235c1e, 0.3);
  c.clump(0.6, 6.6, 0.3, 2.6, 1.9, 2.4, 0x428a33, 0.38);
  // 0.85, not 1.0: a hedge is a third of a crown's height, so the ramp's five rows
  // cover proportionally more of it.
  c.bake(0.85);
  v.set(-2, 8, 2, 0x5fb542); // stray sprig breaks the dome
  return bake(v, 0.152);
}

/**
 * Knee-high hedge — the rung between grass (~0.4) and hedgeClump (~1.7), at ~60%
 * of the latter and rounder. Same rasterisation rules as `hedgeClump`.
 */
function hedgeSmall(): Template {
  const v = new VoxelModel();
  const c = new Canopy(v, 0x91f7);
  c.clump(0, 2.1, 0, 3.1, 2.1, 2.8, 0x316f26, 0.32);
  c.clump(2.1, 1.9, 1.0, 1.9, 1.6, 1.7, 0x3d8530, 0.32);
  c.clump(-1.9, 1.7, -0.9, 1.7, 1.4, 1.5, 0x275c1e, 0.28);
  c.bake(0.8);
  v.set(0, 5, 0, 0x51a13a); // sprig off the crown
  v.set(-2, 4, 2, 0x4a9835);
  return bake(v, 0.14);
}

/**
 * Tiny shell/pebble dots on the sand. Each dot is 2x1 in plan and one voxel tall
 * so its lit top dominates: a lone near-white cube on bright sand prints as a
 * cream-topped BLACK die. Tones stay barely off the sand's own value.
 */
function shells(): Template {
  const v = new VoxelModel();
  // A pale top with a DARKER cell butted against it: one-tone 2x1 blocks read as
  // bars of soap, and near-white ones as dominoes on the beach.
  const pale = 0xd9c9a8;
  const mid = 0xc9b997;
  const dark = 0xb7a685;
  v.box(0, 0, 0, 1, 0, 0, pale);
  v.set(2, 0, 0, dark);
  v.box(3, 0, 2, 4, 0, 2, mid);
  v.set(3, 0, 3, dark);
  v.box(-2, 0, 3, -1, 0, 3, pale);
  v.set(-2, 0, 4, dark);
  v.set(1, 0, 5, mid);
  return bake(v, 0.085);
}

function mushroom(): Template {
  const v = new VoxelModel();
  v.box(0, 0, 0, 0, 2, 0, 0xdcd4c2);
  // Brick, not a pure hue chip. Lit crown over a darker skirt, so the cap has form.
  v.box(-1, 3, -1, 1, 3, 1, 0xa8564a);
  v.set(0, 4, 0, 0xc26a58);
  v.set(-1, 3, 0, 0xe0d8c8);
  v.set(1, 3, -1, 0xe0d8c8);
  return bake(v, 0.14);
}

interface FoliageFadeUniforms {
  bsFoliageFocus: { value: THREE.Vector2 };
  bsFoliageFadeStart: { value: number };
  bsFoliageFadeEnd: { value: number };
}

/**
 * Fade a shared prop material by WORLD distance with real alpha coverage —
 * screen-door opacity stippled and sky-colour fading made blue ghost trees. Solid
 * chunks blend in the opaque list so GTAO still sees trees and rocks, with depth
 * writes on for one stable silhouette.
 */
function installFoliageFade(mat: THREE.Material, uniforms: FoliageFadeUniforms, key: string): void {
  const previousCompile = mat.onBeforeCompile;
  const previousKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = (): string => `${previousKey()}|bsFoliageFade:${key}`;
  mat.onBeforeCompile = (shader, renderer): void => {
    previousCompile.call(mat, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 bsFoliageWorldXZ;")
      // After sway has changed `transformed`, so bent grass fades where it is drawn.
      .replace(
        "#include <project_vertex>",
        "bsFoliageWorldXZ = (modelMatrix * vec4(transformed, 1.0)).xz;\n#include <project_vertex>",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec2 bsFoliageWorldXZ;
uniform vec2 bsFoliageFocus;
uniform float bsFoliageFadeStart;
uniform float bsFoliageFadeEnd;`,
      )
      .replace(
        "#include <opaque_fragment>",
        `
float bsFoliageAlpha = 1.0 - smoothstep(
  bsFoliageFadeStart, bsFoliageFadeEnd,
  distance(bsFoliageWorldXZ, bsFoliageFocus)
);
#include <opaque_fragment>
gl_FragColor.a *= bsFoliageAlpha;`,
      );
  };
}

export class PropLib {
  readonly solidMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
    // Keep solid props in GTAO. Explicit factors bypass three's opaque
    // NormalBlending shortcut, the same subtle split water.ts relies on.
    transparent: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  // Front-side: blades carry both windings themselves and every other soft prop is
  // a closed volume. DoubleSide here turns half the meadow black.
  readonly softMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1.0,
    metalness: 0,
    transparent: true,
  });
  private readonly fadeFocus = new THREE.Vector2();
  private readonly solidFade: FoliageFadeUniforms = {
    bsFoliageFocus: { value: this.fadeFocus },
    bsFoliageFadeStart: { value: 128 },
    bsFoliageFadeEnd: { value: 160 },
  };
  private readonly softFade: FoliageFadeUniforms = {
    bsFoliageFocus: { value: this.fadeFocus },
    bsFoliageFadeStart: { value: 96 },
    bsFoliageFadeEnd: { value: 128 },
  };

  readonly oakA = oakTree(false);
  readonly oakB = oakTree(true);
  readonly oakC = oakTreeTall();
  readonly oakD = oakTreeBroad();
  readonly birch = birchTree();
  readonly pine = pineTree(false);
  readonly pineTall = pineTree(true);
  readonly pineIrr = pineIrregular();
  readonly snag = deadSnag(false);
  readonly snagTall = deadSnag(true);
  // Lean is a SLOPE, so it costs `height * lean` of drift: at 22 voxels of bole a
  // steeper lean bends the palm flat and divorces its head from its registered trunk.
  readonly palm = palmTree(6, 0.12, 1.0);
  readonly palmB = palmTree(5, 0.05, 0.82);
  readonly palmC = palmTree(7, 0.17, 1.2);
  readonly cactusBig = cactus(false);
  readonly cactusSmall = cactus(true);
  readonly rockA = rock(0);
  readonly rockB = rock(1);
  readonly rockSnow = rock(2);
  /** Same two boulders wearing a lichen crust — see `rock`. Grass biomes only. */
  readonly rockAMoss = rock(0, true);
  readonly rockBMoss = rock(1, true);
  /** Four asymmetric wet-meadow tussocks, and four dune ones. */
  readonly tufts = [0, 1, 2, 3].map((k) => grassTuft(false, k));
  readonly tuftsDry = [0, 1, 2, 3].map((k) => grassTuft(true, k));
  /** The carpet: the same two palettes at a third of the tussock's vertices. */
  readonly sprigs = [0, 1, 2, 3].map((k) => grassSprig(false, k));
  readonly sprigsDry = [0, 1, 2, 3].map((k) => grassSprig(true, k));
  /**
   * Non-green ground-cover drifts, each a step off full chroma. Placement holds one
   * hue over a whole clump-cluster, so a hillside shows patches, not confetti.
   */
  readonly bloomHeather = bloomMat(0x9b82c4, 0x77619c, 0x3f7a35);
  readonly bloomButter = bloomMat(0xe3c95e, 0xbfa544, 0x437f37);
  readonly bloomClover = bloomMat(0xcf7f76, 0xa85f58, 0x3d7a33);
  readonly bloomYarrow = bloomMat(0xe4dcc6, 0xbdb39c, 0x467f38);
  readonly bloomRust = bloomMat(0xc98a55, 0xa16a3e, 0x6e7a3a);
  // Width is the HALF-width of a quad. Short and broad reads as ground cover, tall
  // and thin as reeds, and under half a terrain step is the line between them —
  // but below ~0.3 a blade hides behind the ground's own relief entirely.
  readonly grassA = grassBillboard(0.03, 0.02, 0.39, 0.115);
  readonly grassB = grassBillboard(-0.05, 0.03, 0.46, 0.132);
  readonly grassC = grassBillboard(0.02, -0.04, 0.29, 0.098);
  // A taller, yellower anchor blade — still barely half a step.
  readonly grassTall = grassBillboard(-0.03, 0.05, 0.62, 0.12, lin(0x35701c), lin(0x93c14a));
  // Dune grass, just off the sand's own value as the meadow blades sit off the
  // sward's. Narrow and dark, or a dune blade reads as a broad pale sheet.
  readonly grassDuneA = grassBillboard(0.04, 0.02, 0.3, 0.062, lin(0x8a8049), lin(0xb0a468));
  readonly grassDuneB = grassBillboard(-0.04, -0.03, 0.23, 0.055, lin(0x8a8049), lin(0xb0a468));
  readonly bushT = bush();
  /** Three asymmetric fern rosettes — see `fern` for why one was not enough. */
  readonly ferns = [0, 1, 2].map((k) => fern(k));
  readonly reedsT = reeds();
  readonly deadwoodT = deadwood();
  readonly driftwoodT = driftwood();
  readonly logT = fallenLog();
  readonly hedgeT = hedgeClump();
  readonly hedgeSmallT = hedgeSmall();
  readonly shellT = shells();
  // Every hue a step off full chroma with a darker, greyer rim — see `flower`.
  readonly flowerR = flower(0xdd7a68, 0xb85a4e);
  readonly flowerY = flower(0xe8c765, 0xc6a34a);
  readonly flowerP = flower(0xd292b0, 0xb0708f);
  readonly flowerW = flower(0xefe9dc, 0xcdc5b6);
  readonly flowerO = flower(0xe09b5e, 0xbc7a44);

  /** Install after the optional sway patch so both shader edits compose. */
  installDistanceFade(): void {
    installFoliageFade(this.solidMat, this.solidFade, "solid");
    installFoliageFade(this.softMat, this.softFade, "soft");
  }

  /** Update the shared shader once per rendered frame; no per-chunk uniforms. */
  updateDistanceFade(x: number, z: number): void {
    this.fadeFocus.set(x, z);
  }

  /**
   * Grass uses the player's choice. Tall silhouettes keep one extra 32m chunk,
   * capped at the terrain streamer's 160m cardinal reach.
   */
  setDistanceFade(grassEnd: number): void {
    const solidEnd = Math.min(grassEnd + 32, 160);
    this.softFade.bsFoliageFadeStart.value = Math.max(0, grassEnd - 32);
    this.softFade.bsFoliageFadeEnd.value = grassEnd;
    this.solidFade.bsFoliageFadeStart.value = Math.max(0, solidEnd - 32);
    this.solidFade.bsFoliageFadeEnd.value = solidEnd;
  }

  dispose(): void {
    this.solidMat.dispose();
    this.softMat.dispose();
  }
}

const mushroomT = mushroom();

/**
 * The linear colours the tussock palettes are authored around. `Accum.add`
 * MULTIPLIES by the tint, so ground / reference is the factor that would make a
 * tuft exactly the ground colour; lerping from 1 toward it is a partial blend.
 */
const TUFT_REF = lin(0x58a83c);
const TUFT_REF_DRY = lin(0xc4b473);
/** Clamp a ground-blend tint so a snow or lake-bed sample cannot blow one out. */
const clampTint = (v: number): number => (v < 0.5 ? 0.5 : v > 1.7 ? 1.7 : v);

export interface ChunkProps {
  solid: THREE.Mesh | null;
  soft: THREE.Mesh | null;
  /**
   * Trees in this chunk, flat, stride `TREE_STRIDE`:
   * `[worldX, worldZ, solidR^2, climbR^2, trunkTopY, crownR^2, crownCy, crownRy]`.
   * Flat because the player's per-frame update scans it; `world/index.ts` buckets
   * it by chunk key and drops it on unload.
   */
  trunks: number[];
}

/** Numbers per tree in `ChunkProps.trunks`. */
export const TREE_STRIDE = 8;

/**
 * Extra reach before a trunk counts as CLIMBABLE, world units — roughly the hero's
 * BODY_RADIUS, since he grabs bark with his shoulder. NOT applied to the solid
 * radius: the player controller already does its own body-width probing.
 */
const TRUNK_GRAB = 0.34;

/**
 * World-space points props must keep clear of (spawn + shop dens). `kind: 'solid'`
 * (default) holds back only shadow-casting occluders, so grass and flowers still
 * grow up to a deck; `'all'` clears every class — use sparingly, a bald disc reads
 * as a bug.
 */
export type Exclusion = {
  x: number;
  z: number;
  kind?: "solid" | "all";
  /**
   * Clearance radius override, world units. Absent means the default pair below
   * (4.5m occluders, 9.5m trees), sized for a single building — a town's larger
   * footprint must state its own. Given, it covers BOTH classes plus the tree margin.
   */
  r?: number;
};

/**
 * How far a solid prop, and a tree, stay off a path — about what a road LOOKS
 * like, not about blocking it.
 *
 * ALL THREE ARE MARGINS OUTSIDE THE PATH'S RIM, never distances from a centreline
 * (`edgeDistanceTo`), so a clearance shrinks with the path: written against the
 * centreline each carried the cart road's half-corridor and a forest trail would
 * strip trees to a cart road's distance (issue #142).
 */
const ROAD_SOLID_CLEAR = 2.5;
const ROAD_TREE_CLEAR = 7;
/**
 * Soft props stop 0.4 past the ribbon's rim — the one blanket soft exclusion in
 * the world, and safe because the ribbon covers the ground it clears.
 */
const ROAD_SOFT_CLEAR = 0.4;

/**
 * How far a meadow clump throws its members from its own centre. A clump further
 * than `ROAD_SOFT_CLEAR + CLUMP_REACH` from a path cannot reach one and pays for
 * no per-stamp road query; nearer clumps test each stamp individually.
 */
const CLUMP_REACH = 2.2;

/** Squared clearance radius for solid occluders (~4.5m). */
const SOLID_CLEAR_R2 = 20;
/**
 * Squared clearance radius for TREES (~9.5m) — wider than any other occluder
 * because of the CROWN, not the trunk: 9.5 is the crown radius plus the camera's
 * arm, i.e. where the nearest branch clears the lens. Everything else still comes
 * to 4.5m, so a clearing reads as a glade rather than a bald disc.
 */
const TREE_CLEAR_R2 = 90;

export function* buildChunkPropsSteps(
  cx: number,
  cz: number,
  terrain: Terrain,
  lib: PropLib,
  exclusions: readonly Exclusion[],
  roads: RoadClearance | null = null,
  site: SiteClearance | null = null,
): Generator<void, ChunkProps, void> {
  const rng = mulberry32(Math.floor(hashCell(terrain.seed, cx, 91, cz) * 0xffffffff));
  const solid = new Accum();
  // The soft mesh is the only one sway.ts's shader runs on. Flag-gated so `?sway=0`
  // prices the WHOLE feature, attribute byte and bounding pad included.
  const soft = new Accum(flags.sway);
  const trunks: number[] = [];
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  const ci: ColumnScratch = makeScratch();

  /**
   * Does a settlement reach into this chunk? Asked ONCE, so a wilderness chunk pays
   * a null test per stamp instead of a bounds test. The margin is `CLUMP_REACH` plus
   * the widest crown, so a neighbour chunk cannot throw a member over a wall.
   */
  if (site !== null) {
    const M = CLUMP_REACH + 5;
    if (site.anyIn(ox - M, oz - M, ox + CHUNK_SIZE + M, oz + CHUNK_SIZE + M)) {
      solid.site = soft.site = site;
      solid.siteOx = soft.siteOx = ox;
      solid.siteOz = soft.siteOz = oz;
    }
  }

  /**
   * How far (x, z) lies outside the nearest path's RIM, Infinity with no paths. Also
   * left in `roadDist` for callers that want it after an exclusion test paid for it.
   * The one place in this file that talks to the road network.
   */
  let roadDist = Infinity;
  const roadDistAt = (wx: number, wz: number): number => {
    roadDist = roads === null ? Infinity : roads.edgeDistanceTo(wx, wz);
    return roadDist;
  };

  /** Occluders (trees/rocks/hedges/logs/cacti) keep a small disc clear. */
  const exSolid = (wx: number, wz: number): boolean => {
    for (let i = 0; i < exclusions.length; i++) {
      const e = exclusions[i];
      const dx = wx - e.x;
      const dz = wz - e.z;
      const r2 = e.r === undefined ? SOLID_CLEAR_R2 : e.r * e.r;
      if (dx * dx + dz * dz < r2) {
        return true;
      }
    }
    return roadDistAt(wx, wz) < ROAD_SOLID_CLEAR;
  };

  /** Trees keep a far wider disc than any other occluder — see TREE_CLEAR_R2. */
  const exTree = (wx: number, wz: number): boolean => {
    for (let i = 0; i < exclusions.length; i++) {
      const e = exclusions[i];
      const dx = wx - e.x;
      const dz = wz - e.z;
      // A town's radius plus a CROWN's reach (7-10 units across), not a trunk's, or
      // oaks outside the palisade roof the camp over.
      const r = e.r === undefined ? 0 : e.r + 9;
      const r2 = e.r === undefined ? TREE_CLEAR_R2 : r * r;
      if (dx * dx + dz * dz < r2) {
        return true;
      }
    }
    return roadDistAt(wx, wz) < ROAD_TREE_CLEAR;
  };

  /**
   * Is the STAMP point on the road surface? Asking at a clump's centre instead lets
   * members scatter onto the ribbon, where they sit on the floored column — up to
   * half a unit above the deck, i.e. blades poking through the floor.
   *
   * `softHitRoad` records that the last `exSoft` was refused by a PATH rather than a
   * disc: litter belongs on a path and not on a den, and `roadDist` is stale on the
   * disc branch because `exSoft` returns early there.
   */
  let softHitRoad = false;
  const onRoad = (wx: number, wz: number): boolean => {
    softHitRoad = roadDistAt(wx, wz) < ROAD_SOFT_CLEAR;
    return softHitRoad;
  };

  /** Grass/flowers/shells: only 'all' discs stop them. */
  const exSoft = (wx: number, wz: number): boolean => {
    softHitRoad = false;
    for (let i = 0; i < exclusions.length; i++) {
      if (exclusions[i].kind !== "all") {
        continue;
      }
      const dx = wx - exclusions[i].x;
      const dz = wz - exclusions[i].z;
      if (dx * dx + dz * dz < SOLID_CLEAR_R2) {
        return true;
      }
    }
    return onRoad(wx, wz);
  };

  /**
   * Has a settlement worn the grass off this column? The soft half of trodden ground
   * (terrain.ts `GroundPatch` is the colour half).
   *
   * A PURE HASH, never `rng()`: a draw here would advance the per-chunk stream and
   * re-scatter every chunk's vegetation. 1/0.6 because `columnInfo` flips `biome` to
   * 'trampled' at 0.6, so the cull must reach zero by then or the sward drops off a
   * circle instead of thinning.
   */
  const trodden = (wx: number, wz: number, wear: number): boolean =>
    hashCell(terrain.seed, wx, 313, wz) < wear * (1 / 0.6);

  /**
   * Drop this ONE stamp to honour a nature density of `f`? See world/nature.ts.
   *
   * A PURE HASH, for `trodden`'s reason. `salt` separates the decisions so a column
   * does not lose its rock and its sprig together, which would carve bald patches.
   * `f >= 1` skips the hash entirely, keeping the baseline world bit-for-bit. Only
   * ever REMOVES — group placements scale their COUNT instead.
   */
  const thin = (wx: number, wz: number, salt: number, f: number): boolean =>
    f < 1 && hashCell(terrain.seed, wx, salt, wz) >= f;

  /**
   * The height a SOFT prop sits at, given the column height the caller already paid
   * for. Near a road it goes through `surfaceAt` so the prop stands on the DECK: the
   * floored column beside a carriageway is levelled to `round(deck)` and can sit half
   * a unit above what the ribbon draws.
   *
   * `rf.surfaceAt(x, z, column)`, not `terrain.getHeight` — the latter re-derives the
   * column through `heightCont`, this file's dominant cost, paying for it twice.
   */
  const softSeat = (x: number, z: number, column: number, nearRoad: boolean): number => {
    const rf = terrain.roads;
    return nearRoad && rf !== null ? rf.surfaceAt(ox + x, oz + z, column) : column;
  };

  /**
   * A wayside stone or stick, on a candidate the sward just refused. SOFT, not solid
   * — a pebble you trip over on a carriageway is worse than an empty road, and this
   * changes no collider. Seated via `softSeat` or it floats above the ribbon.
   */
  const litter = (
    x: number,
    z: number,
    wx: number,
    wz: number,
    h: number,
    yaw: number,
    scl: number,
    pick: number,
  ): void => {
    if (roads === null) {
      return;
    }
    const q = roads.litterAt(ox + x, oz + z);
    if (q <= 0) {
      return;
    }
    // Hashed, not rolled: consuming from `rng` here would shift every stamp in the
    // chunk the day a road moved.
    if (hashCell(terrain.seed, wx, 913, wz) > q) {
      return;
    }
    const y = softSeat(x, z, h, true);
    const t = 0.88 + pick * 0.2;
    // Two thirds stone, one third stick — the mix a swept verge has.
    if (pick < 0.66) {
      // A boulder template at a fifth of its size is a pebble — scale, not a new
      // model, so the verge is made of the same stone as the meadow.
      soft.add(lib.rockA, x, y - 0.06, z, yaw, 0.16 + scl * 0.12, t, t, t * 0.96);
    } else {
      soft.add(lib.deadwoodT, x, y - 0.02, z, yaw, 0.45 + scl * 0.3, t, t * 0.97, t * 0.9);
    }
  };

  const flatEnough = (wx: number, wz: number, h: number, tol: number): boolean =>
    Math.abs(terrain.getHeight(wx + 1, wz) - h) <= tol &&
    Math.abs(terrain.getHeight(wx - 1, wz) - h) <= tol &&
    Math.abs(terrain.getHeight(wx, wz + 1) - h) <= tol &&
    Math.abs(terrain.getHeight(wx, wz - 1) - h) <= tol;

  /**
   * Stamp one tussock, tinted 45% toward the ground beneath and sunk 0.07 so the dark
   * root row is half buried. CLOBBERS `ci` — read it first. `nearRoad` means the
   * caller wants this stamp road-tested individually.
   */
  const addTuft = (
    dry: boolean,
    x: number,
    z: number,
    yaw: number,
    scl: number,
    vmul: number,
    nearRoad = false,
  ): void => {
    if (nearRoad && onRoad(ox + x, oz + z)) {
      return;
    }
    terrain.columnInfo(ox + Math.floor(x), oz + Math.floor(z), ci);
    if (ci.h < WATER_LEVEL + 1) {
      return;
    }
    const ref = dry ? TUFT_REF_DRY : TUFT_REF;
    const tpl = (dry ? lib.tuftsDry : lib.tufts)[Math.floor(rng() * 3.999)];
    const B = 0.45;
    soft.add(
      tpl,
      x,
      softSeat(x, z, ci.h, nearRoad) - 0.07,
      z,
      yaw,
      scl,
      clampTint(1 - B + B * (ci.topR / ref[0])) * vmul,
      clampTint(1 - B + B * (ci.topG / ref[1])) * vmul,
      clampTint(1 - B + B * (ci.topB / ref[2])) * vmul,
    );
  };

  /**
   * Stamp one carpet sprig. NOT a cheaper `addTuft`: it reuses the clump's tint and
   * asks only for a column height, where `addTuft` runs a full `columnInfo` per
   * instance. That is what makes ~500 sprigs a chunk affordable — `columnInfo` is
   * this file's dominant cost, and ground colour barely varies across one clump.
   */
  const addSprig = (
    dry: boolean,
    x: number,
    z: number,
    yaw: number,
    scl: number,
    tr: number,
    tg: number,
    tb: number,
    nearRoad = false,
  ): void => {
    if (nearRoad && onRoad(ox + x, oz + z)) {
      return;
    }
    const h = terrain.columnHeight(ox + Math.floor(x), oz + Math.floor(z));
    if (h < WATER_LEVEL + 1) {
      return;
    }
    const tpl = (dry ? lib.sprigsDry : lib.sprigs)[Math.floor(rng() * 3.999)];
    soft.add(tpl, x, softSeat(x, z, h, nearRoad) - 0.06, z, yaw, scl, tr, tg, tb);
  };

  /**
   * Lowest rendered column height under a footprint of radius `r`. Seating on the
   * MINIMUM means a prop can only be buried, never floating — buried is invisible,
   * floating is a bug the eye finds instantly. Callers sink the base further.
   */
  const groundMin = (wx: number, wz: number, r: number): number => {
    const k = Math.max(1, Math.round(r));
    let m = terrain.getHeight(wx, wz);
    let v = terrain.getHeight(wx + k, wz);
    if (v < m) {
      m = v;
    }
    v = terrain.getHeight(wx - k, wz);
    if (v < m) {
      m = v;
    }
    v = terrain.getHeight(wx, wz + k);
    if (v < m) {
      m = v;
    }
    v = terrain.getHeight(wx, wz - k);
    if (v < m) {
      m = v;
    }
    v = terrain.getHeight(wx + k, wz + k);
    if (v < m) {
      m = v;
    }
    v = terrain.getHeight(wx - k, wz - k);
    if (v < m) {
      m = v;
    }
    v = terrain.getHeight(wx + k, wz - k);
    if (v < m) {
      m = v;
    }
    v = terrain.getHeight(wx - k, wz + k);
    if (v < m) {
      m = v;
    }
    return m;
  };

  // Tree pass: a jittered 4x4 grid of 8-unit cells keeps organic spacing. A crown is
  // 7-10 units across, so a denser lattice merges into one green ceiling with no
  // individual trees in it. Roughly 11.6 trees a chunk in forest, 5.6 in plains.
  for (let gx = 0; gx < 4; gx++) {
    // Four candidates is the scheduling grain: under the frame budget without
    // yielding per stamp.
    if (gx > 0) {
      yield;
    }
    for (let gz = 0; gz < 4; gz++) {
      const lx = gx * 8 + Math.floor(rng() * 8);
      const lz = gz * 8 + Math.floor(rng() * 8);
      const roll = rng();
      const yaw = rng() * Math.PI * 2;
      // Girth and height vary INDEPENDENTLY and over a much wider range than the
      // old single 0.85-1.25 factor: adjacent trees came out as scaled copies of
      // one silhouette, which is what made whole hillsides read as two or three
      // repeated stamps. 0.78-1.22 girth against 0.80-1.30 height gives squat
      // spreading trees and lanky ones from the same template.
      const scl = 0.78 + rng() * 0.44;
      const sclY = scl * (0.86 + rng() * 0.32);
      const tintRoll = rng();
      const hueRoll = rng(); // foliage hue, decoupled from foliage VALUE
      const vroll = rng(); // variant pick, decoupled from density roll
      const jx = (rng() - 0.5) * 1.3;
      const jz = (rng() - 0.5) * 1.3;
      const wx = ox + lx;
      const wz = oz + lz;
      terrain.columnInfo(wx, wz, ci);
      const h = ci.h;

      // Acceptance is per CANDIDATE over 16 a chunk. Cacti and palms also take the
      // 2.2x jitter, or a coarse lattice makes a desert read as a planted orchard.
      let tpl: Template | null = null;
      let jitterMul = 1;
      // Scales every acceptance rate below (world/nature.ts). `roll` is drawn either
      // way, so no factor can move a tree it did not remove.
      const nTrees = nature.for(ci.biome).trees;
      // ~1 tree in 11 is a snag (1 in 14 on plains, where more would read as blight):
      // the only outline in the set that is not a blob on a stick.
      if (ci.biome === "forest" && roll < 0.8 * nTrees) {
        tpl =
          vroll < 0.22
            ? lib.oakA
            : vroll < 0.41
              ? lib.oakB
              : vroll < 0.58
                ? lib.oakC
                : vroll < 0.75
                  ? lib.oakD
                  : vroll < 0.91
                    ? lib.birch
                    : vroll < 0.96
                      ? lib.snag
                      : lib.snagTall;
      } else if (ci.biome === "plains" && roll < 0.3 * nTrees) {
        tpl =
          vroll < 0.3
            ? lib.oakA
            : vroll < 0.51
              ? lib.oakC
              : vroll < 0.74
                ? lib.oakD
                : vroll < 0.93
                  ? lib.birch
                  : lib.snag;
      } else if (ci.biome === "snow" && roll < 0.62 * nTrees) {
        tpl =
          vroll < 0.34
            ? lib.pine
            : vroll < 0.64
              ? lib.pineTall
              : vroll < 0.9
                ? lib.pineIrr
                : lib.snagTall;
      } else if (ci.biome === "beach" && roll < 0.5 * nTrees && ci.hc >= 8.6 && ci.hc <= 11.5) {
        // three distinct palms + extra scatter so beach lines feel organic
        tpl = vroll < 0.34 ? lib.palm : vroll < 0.67 ? lib.palmB : lib.palmC;
        jitterMul = 2.2;
      } else if (ci.biome === "desert" && roll < 0.3 * nTrees) {
        tpl = lib.cactusBig;
        jitterMul = 2.2;
      }
      if (!tpl) {
        continue;
      }
      if (h < WATER_LEVEL + (ci.biome === "beach" ? 0 : 1)) {
        continue;
      }
      if (!flatEnough(wx, wz, h, 2)) {
        continue;
      }

      // Per-instance tint on INDEPENDENT value and hue rolls: driven off one roll,
      // the brightest tree is always the greenest and the family lies on one line
      // through colour space. `hw` runs -1 (cool) to +1 (warm yellow-green).
      const t = 0.85 + tintRoll * 0.3;
      const hw = hueRoll * 2 - 1;
      // Trunk flares are ~1.5-3 units wide, so the seating probe uses r=2 and sinks
      // 0.45: the flare and buttress voxels have to bed into the ground.
      const px = lx + 0.5 + jx * jitterMul;
      const pz = lz + 0.5 + jz * jitterMul;
      // THE EXCLUSION TEST GOES ON THE TRUNK, not the candidate column: `jitterMul`
      // puts the stamp up to 2 units off centre. Widening the radius instead would
      // enlarge every clearing rather than fixing it where the tree is.
      if (exTree(ox + px, oz + pz)) {
        continue;
      }
      const baseY = groundMin(wx, wz, 2) - 0.45;
      // A REFUSED TREE IS REGISTERED NOWHERE: a trunk in the registry with no mesh
      // is an invisible tree you cannot walk through.
      if (
        !solid.add(
          tpl,
          px,
          baseY,
          pz,
          yaw,
          scl,
          t * (1 + hw * 0.11),
          t * (1 + hw * 0.02),
          t * (1 - hw * 0.13),
          sclY,
        )
      ) {
        continue;
      }
      // Registered with the stamp's own girth and height, so this describes the
      // INSTANCE. Field order must match ChunkProps.trunks / TREE_STRIDE.
      if (tpl.trunk) {
        const sr = tpl.trunk.r * scl;
        const cr = tpl.trunk.crownR * scl;
        const gr = sr + TRUNK_GRAB;
        trunks.push(
          ox + px,
          oz + pz,
          sr * sr,
          gr * gr,
          baseY + tpl.trunk.top * sclY,
          cr * cr,
          baseY + tpl.trunk.crownCy * sclY,
          tpl.trunk.crownRy * sclY,
        );
      }
    }
  }

  // Mid-scale silhouette pass: boulder clusters, logs and hedge knots break the
  // horizon between ankle height and 8m. Stamps `n` copies in a loose knot around
  // (mlx, mlz), re-grounding each on its own column.
  const stampKnot = (
    tpl: Template,
    mlx: number,
    mlz: number,
    n: number,
    spread: number,
    sMin: number,
    sSpan: number,
    yOff: number,
    t: number,
    nearRoad: boolean,
  ): void => {
    for (let b = 0; b < n; b++) {
      const ang = rng() * Math.PI * 2;
      const rad = b === 0 ? 0 : spread * (0.45 + rng());
      const bx = mlx + Math.cos(ang) * rad;
      const bz = mlz + Math.sin(ang) * rad;
      if (bx < 0 || bz < 0 || bx >= CHUNK_SIZE || bz >= CHUNK_SIZE) {
        continue;
      }
      if (nearRoad && roadDistAt(ox + bx, oz + bz) < ROAD_SOLID_CLEAR) {
        continue;
      }
      terrain.columnInfo(ox + Math.floor(bx), oz + Math.floor(bz), ci);
      if (ci.h < WATER_LEVEL + 1) {
        continue;
      }
      const bt = t * (0.93 + rng() * 0.14);
      const gy = groundMin(ox + Math.floor(bx), oz + Math.floor(bz), 2);
      solid.add(
        tpl,
        bx,
        gy + yOff,
        bz,
        rng() * Math.PI * 2,
        sMin + rng() * sSpan,
        bt,
        bt * 1.02,
        bt * 0.95,
      );
    }
  };

  const midCount = 5 + Math.floor(rng() * 4);
  for (let m = 0; m < midCount; m++) {
    if (m > 0 && m % 2 === 0) {
      yield;
    }
    const mlx = 2 + rng() * (CHUNK_SIZE - 4);
    const mlz = 2 + rng() * (CHUNK_SIZE - 4);
    const kind = rng();
    const yaw = rng() * Math.PI * 2;
    const wx = ox + Math.floor(mlx);
    const wz = oz + Math.floor(mlz);
    terrain.columnInfo(wx, wz, ci);
    const h = ci.h;
    const biome = ci.biome;
    if (h < WATER_LEVEL + 1) {
      continue;
    }
    if (biome === "underwater") {
      continue;
    }
    if (exSolid(wx + 0.5, wz + 0.5)) {
      continue;
    }
    // Every shape below is a KNOT around the candidate, reaching up to ~2.9 units, so
    // a satellite can land in the road even when the centre cleared it. `exSolid` has
    // already left the distance in `roadDist`, so this test is free.
    const nearRoad = roadDist < ROAD_SOLID_CLEAR + 3;
    if (!flatEnough(wx, wz, h, 2)) {
      continue;
    }
    const t = 0.92 + rng() * 0.16;
    const green = biome === "plains" || biome === "forest";
    // Nature densities (world/nature.ts). The ladder's band BOUNDARIES are left
    // alone: scaling one would hand its width to the next kind, so "fewer rocks"
    // would silently mean "more hedges". Only counts inside a branch, and the band
    // with nothing after it, are scaled; a lone stamp is thinned by hash.
    const nf = nature.for(biome);

    // Size ladder, shortest to tallest: knee hedge (~1) -> log -> tall hedge (~1.7)
    // -> rock+log pair (~2) -> boulder outcrop (~2.5-3.5) -> tree (~4-6).
    if (!green) {
      // Desert/snow/beach: boulders only.
      if (kind >= 0.42 * nf.rocks) {
        continue;
      }
    } else if (kind >= 0.36) {
      if (kind < 0.5) {
        // Rock + log pair: one readable ~2m mass rather than two lone pebbles.
        // `green` is true here, so always the mossy pair.
        const rk = rng() < 0.5 ? lib.rockAMoss : lib.rockBMoss;
        // Capped at 1.95: a mid-ground silhouette prop must stay clearly shorter than
        // the hero, and past ~2.5x rock(1) is a 5-unit slab.
        const rs = 1.45 + rng() * 0.5;
        const rw = 0.94 + rng() * 0.13;
        // Drawn, then possibly dropped: the rolls must happen either way or a rock
        // density would re-scatter the log beside it. See `thin`.
        if (!thin(wx, wz, 617, nf.rocks)) {
          solid.add(rk, mlx, groundMin(wx, wz, 2) - 0.45, mlz, yaw, rs, t * rw, t, t * (1.94 - rw));
        }
        const lang = yaw + 1.1 + rng() * 1.2;
        const lx2 = mlx + Math.cos(lang) * (1.4 + rng() * 0.9);
        const lz2 = mlz + Math.sin(lang) * (1.4 + rng() * 0.9);
        if (
          lx2 >= 0 &&
          lz2 >= 0 &&
          lx2 < CHUNK_SIZE &&
          lz2 < CHUNK_SIZE &&
          !(nearRoad && roadDistAt(ox + lx2, oz + lz2) < ROAD_SOLID_CLEAR)
        ) {
          terrain.columnInfo(ox + Math.floor(lx2), oz + Math.floor(lz2), ci);
          if (ci.h >= WATER_LEVEL + 1) {
            const lt = t * (0.95 + rng() * 0.1);
            solid.add(
              lib.logT,
              lx2,
              groundMin(ox + Math.floor(lx2), oz + Math.floor(lz2), 2) - 0.2,
              lz2,
              lang + Math.PI * 0.5,
              1.4 + rng() * 0.5,
              lt,
              lt * 0.98,
              lt * 0.92,
            );
          }
        }
      } else if (kind < 0.64) {
        solid.add(
          lib.logT,
          mlx,
          groundMin(wx, wz, 2) - 0.2,
          mlz,
          yaw,
          0.9 + rng() * 0.5,
          t,
          t * 0.98,
          t * 0.94,
        );
      } else if (kind < 0.84) {
        // knee-high hedges: the rung between grass and the tall clump
        stampKnot(
          lib.hedgeSmallT,
          mlx,
          mlz,
          natureCount(2 + Math.floor(rng() * 3), nf.bushes),
          1.5,
          0.85 + rng() * 0.2,
          0.35,
          -0.25,
          t,
          nearRoad,
        );
      } else {
        stampKnot(
          lib.hedgeT,
          mlx,
          mlz,
          natureCount(1 + Math.floor(rng() * 3), nf.bushes),
          1.5,
          0.95,
          0.45,
          -0.3,
          t,
          nearRoad,
        );
      }
      continue;
    }

    {
      // Boulder cluster around a shared centre, so it reads as one outcrop.
      const n = natureCount(2 + Math.floor(rng() * 2), nf.rocks);
      for (let b = 0; b < n; b++) {
        const ang = rng() * Math.PI * 2;
        const rad = b === 0 ? 0 : 0.9 + rng() * 2;
        const bx = mlx + Math.cos(ang) * rad;
        const bz = mlz + Math.sin(ang) * rad;
        if (bx < 0 || bz < 0 || bx >= CHUNK_SIZE || bz >= CHUNK_SIZE) {
          continue;
        }
        if (nearRoad && roadDistAt(ox + bx, oz + bz) < ROAD_SOLID_CLEAR) {
          continue;
        }
        terrain.columnInfo(ox + Math.floor(bx), oz + Math.floor(bz), ci);
        if (ci.h < WATER_LEVEL + 1) {
          continue;
        }
        const tpl =
          biome === "snow"
            ? lib.rockSnow
            : green
              ? rng() < 0.5
                ? lib.rockAMoss
                : lib.rockBMoss
              : rng() < 0.5
                ? lib.rockA
                : lib.rockB;
        const bt = t * (0.94 + rng() * 0.12);
        const gy = groundMin(ox + Math.floor(bx), oz + Math.floor(bz), 2);
        // Per-boulder warm/cool tint: a flat neutral one makes an outcrop three copies
        // of the same hueless grey, which reads as untextured placeholder.
        const bw = 0.94 + rng() * 0.13;
        solid.add(
          tpl,
          bx,
          gy - 0.45,
          bz,
          rng() * Math.PI * 2,
          1.25 + rng() * 0.6,
          bt * bw,
          bt,
          bt * (1.94 - bw),
        );
      }
    }
  }

  // Meadow cluster pass: clumps rather than a uniform sprinkle, so the meadow has
  // dense pockets with breathing room instead of an even texture.
  const flowers = [lib.flowerR, lib.flowerY, lib.flowerP, lib.flowerW, lib.flowerO];
  const grasses = [lib.grassA, lib.grassB, lib.grassC];
  const blooms = [
    lib.bloomHeather,
    lib.bloomButter,
    lib.bloomClover,
    lib.bloomYarrow,
    lib.bloomRust,
  ];
  for (let k = 0; k < 115; k++) {
    // One candidate stamps a whole carpet, so four per yield keeps a slice under 1 ms.
    if (k > 0 && k % 4 === 0) {
      yield;
    }
    const clx = 1 + rng() * (CHUNK_SIZE - 2);
    const clz = 1 + rng() * (CHUNK_SIZE - 2);
    const accept = rng();
    const wcx = ox + Math.floor(clx);
    const wcz = oz + Math.floor(clz);
    terrain.columnInfo(wcx, wcz, ci);
    const cb = ci.biome;
    if (cb !== "plains" && cb !== "forest") {
      continue;
    }
    // At 0.82 of 115 candidates a plains chunk plants ~94 clumps, one per 3.3 units
    // square, so neighbouring carpets touch and no ground plane is bare polygon.
    //
    // A CLUMP IS THE MEADOW'S UNIT, so `grass` scales the acceptance rate AND
    // everything inside a clump. Note the consequence: `grass 0` clears the clumps
    // and with them their flower and bush — the mid-scale pass still plants hedges.
    const nm = nature.for(cb);
    if (accept > (cb === "plains" ? 0.82 : 0.46) * nm.grass) {
      continue;
    }
    if (ci.h < WATER_LEVEL + 1) {
      continue;
    }
    if (ci.trample > 0 && trodden(wcx, wcz, ci.trample)) {
      continue;
    }
    // Grass and flowers are welcome on the doorstep — only the bush below, which casts
    // shadows and blocks the path, respects the den discs.
    if (exSoft(wcx + 0.5, wcz + 0.5)) {
      continue;
    }
    // A CLEAR CLUMP CENTRE SAYS NOTHING ABOUT ITS MEMBERS, which scatter up to
    // CLUMP_REACH away. Testing them one by one is the only way the sward stops
    // exactly at the ribbon's rim. `roadDist` is already measured, so this is free.
    const nearRoad = roadDist < ROAD_SOFT_CLEAR + CLUMP_REACH;
    const isForest = cb === "forest";
    // +-8% per-cluster value jitter so whole clumps read lighter or darker.
    const cj = 0.92 + rng() * 0.16;
    // Billboard blades, in a TIGHT disc so they occlude each other and register as
    // grass. Kept few: they barely survive to the screen and are the meadow's biggest
    // vertex line item, but a handful under a tussock reads as the grass it stands in.
    const members = natureCount(3 + Math.floor(rng() * 4), nm.grass);
    const grass = grasses[Math.floor(rng() * 2.999)];
    // The clump's ground tint, resolved ONCE — the sprig carpet is far too numerous
    // to re-sample the column per stamp. Same blend and clamp as `addTuft`.
    const B = 0.45;
    const sprR = clampTint(1 - B + B * (ci.topR / TUFT_REF[0])) * cj;
    const sprG = clampTint(1 - B + B * (ci.topG / TUFT_REF[1])) * cj;
    const sprB = clampTint(1 - B + B * (ci.topB / TUFT_REF[2])) * cj;
    // A knee-high tussock anchors ~a fifth of clumps, giving the meadow a second height.
    if (rng() < 0.22 * nm.grass) {
      soft.add(
        lib.grassTall,
        clx,
        ci.h - 0.03,
        clz,
        rng() * Math.PI * 2,
        0.8 + rng() * 0.4,
        cj * 0.98,
        cj,
        cj * 0.92,
      );
    }
    // THE CARPET: sprigs in a 2.2-unit disc, deliberately WIDER than the tussocks'
    // 1.05 — tussocks want to overlap each other, sprigs to close the gap between one
    // clump and the next. Stamped BEFORE the tussocks, while `ci` still holds the
    // cluster's own column.
    const sprigN = natureCount(4 + Math.floor(rng() * 5), nm.grass);
    for (let m = 0; m < sprigN; m++) {
      const ang = rng() * Math.PI * 2;
      // sqrt for a uniform sample over the DISC: piled at the centre it is a pom-pom.
      const rad = Math.sqrt(rng()) * 2.2;
      const sx = clx + Math.cos(ang) * rad;
      const sz = clz + Math.sin(ang) * rad;
      if (sx < 0 || sz < 0 || sx >= CHUNK_SIZE || sz >= CHUNK_SIZE) {
        continue;
      }
      addSprig(
        false,
        sx,
        sz,
        rng() * Math.PI * 2,
        0.85 + rng() * 0.6,
        sprR * (isForest ? 0.93 : 1),
        sprG,
        sprB * (isForest ? 0.9 : 1),
        nearRoad,
      );
    }
    // The tussock is the readable OBJECT in a clump; the sprigs carry the coverage, at
    // a third of the vertices, so few tussocks go a long way.
    const tuftN = natureCount(1 + Math.floor(rng() * 3), nm.grass);
    for (let m = 0; m < tuftN; m++) {
      const ang = rng() * Math.PI * 2;
      const rad = rng() * 1.05;
      const tx = clx + Math.cos(ang) * rad;
      const tz = clz + Math.sin(ang) * rad;
      if (tx < 0 || tz < 0 || tx >= CHUNK_SIZE || tz >= CHUNK_SIZE) {
        continue;
      }
      // Scale is free — a tussock is 144 vertices at any size — so it is the cheapest
      // lever on the meadow's read. 1.45x tops out just under a terrain step.
      addTuft(
        false,
        tx,
        tz,
        rng() * Math.PI * 2,
        1.0 + rng() * 0.45,
        cj * (isForest ? 0.94 : 1),
        nearRoad,
      );
    }
    terrain.columnInfo(wcx, wcz, ci); // addTuft clobbers ci; restore the cluster's
    for (let m = 0; m < members; m++) {
      const ang = rng() * Math.PI * 2;
      const rad = 0.3 + rng() * 1.4;
      const mx = clx + Math.cos(ang) * rad;
      const mz = clz + Math.sin(ang) * rad;
      if (mx < 0 || mz < 0 || mx >= CHUNK_SIZE || mz >= CHUNK_SIZE) {
        continue;
      }
      if (nearRoad && onRoad(ox + mx, oz + mz)) {
        continue;
      }
      terrain.columnInfo(ox + Math.floor(mx), oz + Math.floor(mz), ci);
      if (ci.h < WATER_LEVEL + 1) {
        continue;
      }
      if (ci.biome !== "plains" && ci.biome !== "forest") {
        continue;
      }
      const t = cj * (0.96 + rng() * 0.08);
      soft.add(
        grass,
        mx,
        softSeat(mx, mz, ci.h, nearRoad) - 0.03,
        mz,
        rng() * Math.PI * 2,
        0.65 + rng() * 0.5,
        isForest ? t * 0.9 : t * 0.97,
        t,
        isForest ? t * 0.86 : t * 0.9,
      );
    }
    // Non-green drift. The hue, and whether there is one, come from a hash of the
    // 32-unit REGION rather than this clump's rng: a per-clump roll scatters five
    // colours into confetti, a per-region one banks heather on one hillside.
    const reg = hashCell(terrain.seed, wcx >> 5, 401, wcz >> 5);
    if (reg < 0.42 && rng() < 0.24 * nm.flowers) {
      const bl =
        blooms[Math.floor(hashCell(terrain.seed, (wcx >> 5) + 77, 907, (wcz >> 5) - 31) * 4.999)];
      const mats = natureCount(1 + Math.floor(rng() * 2), nm.flowers);
      for (let m = 0; m < mats; m++) {
        const ang = rng() * Math.PI * 2;
        const rad = m === 0 ? 0 : 0.6 + rng() * 1.6;
        const mx = clx + Math.cos(ang) * rad;
        const mz = clz + Math.sin(ang) * rad;
        if (mx < 0 || mz < 0 || mx >= CHUNK_SIZE || mz >= CHUNK_SIZE) {
          continue;
        }
        if (nearRoad && onRoad(ox + mx, oz + mz)) {
          continue;
        }
        const mh = terrain.columnHeight(ox + Math.floor(mx), oz + Math.floor(mz));
        if (mh < WATER_LEVEL + 1) {
          continue;
        }
        const bt = cj * (0.94 + rng() * 0.12);
        soft.add(
          bl,
          mx,
          softSeat(mx, mz, mh, nearRoad) - 0.06,
          mz,
          rng() * Math.PI * 2,
          1.0 + rng() * 0.5,
          bt,
          bt,
          bt,
        );
      }
    }
    // A grace note only — the drift above carries the meadow's non-green colour at a
    // scale a vista can resolve, which a single blossom never did.
    if (rng() < 0.38 * nm.flowers) {
      // a flower in about a third of the clumps
      const fx = clx + (rng() - 0.5) * 1.4;
      const fz = clz + (rng() - 0.5) * 1.4;
      terrain.columnInfo(ox + Math.floor(fx), oz + Math.floor(fz), ci);
      if (ci.h >= WATER_LEVEL + 1 && !(nearRoad && onRoad(ox + fx, oz + fz))) {
        const ft = cj * (0.94 + rng() * 0.12);
        soft.add(
          flowers[Math.floor(rng() * 4.999)],
          fx,
          softSeat(fx, fz, ci.h, nearRoad) - 0.04,
          fz,
          rng() * Math.PI * 2,
          0.8 + rng() * 0.4,
          ft,
          ft,
          ft,
        );
      }
    }
    // The bush is the only thing in a clump that reads as a MASS rather than detail,
    // and the only ground cover here that lands in the shadow-casting bucket.
    if (rng() < 0.28 * nm.bushes) {
      // bush anchoring the clump
      const bx = clx + (rng() - 0.5) * 2;
      const bz = clz + (rng() - 0.5) * 2;
      terrain.columnInfo(ox + Math.floor(bx), oz + Math.floor(bz), ci);
      // The BUSH's own position, not its column's centre: it strays a full unit.
      if (ci.h >= WATER_LEVEL + 1 && !exSolid(ox + bx, oz + bz)) {
        solid.add(
          lib.bushT,
          bx,
          ci.h - 0.05,
          bz,
          rng() * Math.PI * 2,
          0.8 + rng() * 0.5,
          cj,
          cj,
          cj,
        );
      }
    }
  }

  // Sparse scatter pass: lone props between the clumps.
  for (let i = 0; i < 320; i++) {
    if (i > 0 && i % 16 === 0) {
      yield;
    }
    const lx = Math.floor(rng() * CHUNK_SIZE);
    const lz = Math.floor(rng() * CHUNK_SIZE);
    const roll = rng();
    const yaw = rng() * Math.PI * 2;
    const scl = 0.8 + rng() * 0.5;
    const pick = rng();
    const jx = (rng() - 0.5) * 0.8;
    const jz = (rng() - 0.5) * 0.8;
    const wx = ox + lx;
    const wz = oz + lz;
    // The JITTERED position, resolved BEFORE the exclusion tests: the jitter carries a
    // stamp up to 0.57 units off centre, i.e. possibly inside the ribbon.
    const x = lx + 0.5 + jx;
    const z = lz + 0.5 + jz;
    terrain.columnInfo(wx, wz, ci);
    const h = ci.h;
    if (h < WATER_LEVEL + 1) {
      continue;
    }
    if (exSoft(ox + x, oz + z)) {
      // THE SAME NUMBER READ THE OTHER WAY (issue #142): a candidate refused for being
      // on a shedding path is exactly where a stone or stick belongs, at no extra
      // query. A DISC IS NOT A PATH — `softHitRoad` is the difference.
      if (softHitRoad) {
        litter(x, z, wx, wz, h, yaw, scl, pick);
      }
      continue;
    }
    // `exSoft` has just left the measured road distance in `roadDist`.
    const nearRoad = roadDist < ROAD_SOFT_CLEAR + 1;
    if (ci.trample > 0 && trodden(wx, wz, ci.trample)) {
      continue;
    }
    // Mixed pass: soft singles ignore the den discs, solid ones don't.
    const noSolid = exSolid(ox + x, oz + z);

    const t = 0.9 + pick * 0.2;
    const grass = grasses[Math.floor(pick * 2.999)];
    // Every branch below is a band on one shared `roll` ladder, so a density THINS a
    // band by hash rather than moving it. The bodies are BRACED for the same reason:
    // an extra condition on the `else if` would fall through and plant deadwood.
    const ns = nature.for(ci.biome);
    switch (ci.biome) {
      case "plains":
        if (roll < 0.22) {
          if (!thin(wx, wz, 701, ns.grass)) {
            soft.add(grass, x, h - 0.03, z, yaw, 0.6 + scl * 0.45, t * 0.96, t, t * 0.9);
          }
        }
        // The lone boulder must stay FIRST: on a shared ladder a band placed after a
        // wider one is unreachable, which is how plains lost their boulders once.
        else if (roll < 0.225 && !noSolid) {
          if (!thin(wx, wz, 617, ns.rocks)) {
            solid.add(lib.rockAMoss, x, h - 0.1, z, yaw, scl, t, t, t);
          }
        } else if (roll < 0.267) {
          if (!thin(wx, wz, 701, ns.grass)) {
            addTuft(false, x, z, yaw, 0.72 + scl * 0.4, t, nearRoad);
          }
        } else if (roll < 0.276) {
          if (!thin(wx, wz, 701, ns.grass)) {
            soft.add(lib.grassTall, x, h - 0.03, z, yaw, 0.8 + scl * 0.3, t, t, t * 0.94);
          }
        } else if (roll < 0.286) {
          soft.add(lib.deadwoodT, x, h - 0.02, z, yaw, scl, t, t, t);
        }
        // Carpet BETWEEN the clumps — ~70 sprigs a chunk on top of the clumps' ~500,
        // and this loop has already paid for the `columnInfo` they need.
        else if (roll < 0.5) {
          if (!thin(wx, wz, 701, ns.grass)) {
            addSprig(false, x, z, yaw, 0.8 + scl * 0.4, t * 0.98, t, t * 0.94, nearRoad);
          }
        }
        break;
      case "forest":
        if (roll < 0.1) {
          if (!thin(wx, wz, 701, ns.grass)) {
            soft.add(grass, x, h - 0.03, z, yaw, 0.5 + scl * 0.45, t * 0.86, t, t * 0.84);
          }
        } else if (roll < 0.127 && !noSolid) {
          solid.add(mushroomT, x, h - 0.04, z, yaw, scl, t, t, t);
        } else if (roll < 0.151 && !noSolid) {
          if (!thin(wx, wz, 617, ns.rocks)) {
            solid.add(pick < 0.5 ? lib.rockAMoss : lib.rockBMoss, x, h - 0.1, z, yaw, scl, t, t, t);
          }
        } else if (roll < 0.211) {
          if (!thin(wx, wz, 701, ns.grass)) {
            addTuft(false, x, z, yaw, 0.8 + scl * 0.5, t * 0.95, nearRoad);
          }
        }
        // Undergrowth, or the wood reads as a lawn with trunks standing on it.
        else if (roll < 0.3) {
          if (!thin(wx, wz, 701, ns.grass)) {
            soft.add(
              lib.ferns[Math.floor(pick * 2.999)],
              x,
              h - 0.04,
              z,
              yaw,
              0.85 + scl * 0.35,
              t * 0.9,
              t,
              t * 0.88,
            );
          }
        } else if (roll < 0.325) {
          soft.add(lib.deadwoodT, x, h - 0.02, z, yaw, scl, t, t, t);
        }
        // Same carpet as plains, a shade darker and cooler under the canopy shadow.
        else if (roll < 0.5) {
          if (!thin(wx, wz, 701, ns.grass)) {
            addSprig(false, x, z, yaw, 0.75 + scl * 0.4, t * 0.88, t, t * 0.86, nearRoad);
          }
        }
        break;
      case "beach":
        if (roll < 0.064) {
          if (!thin(wx, wz, 701, ns.grass)) {
            addTuft(true, x, z, yaw, scl, t, nearRoad);
          }
        } else if (roll < 0.086 && !noSolid) {
          if (!thin(wx, wz, 617, ns.rocks)) {
            solid.add(lib.rockA, x, h - 0.1, z, yaw, scl, t, t, t);
          }
        }
        break;
      case "desert":
        if (roll < 0.031 && !noSolid) {
          if (!thin(wx, wz, 617, ns.rocks)) {
            solid.add(lib.rockA, x, h - 0.1, z, yaw, scl, t * 1.05, t, t * 0.9);
          }
        } else if (roll < 0.082) {
          if (!thin(wx, wz, 701, ns.grass)) {
            addTuft(true, x, z, yaw, scl, t, nearRoad);
          }
        } else if (roll < 0.095 && !noSolid) {
          solid.add(lib.cactusSmall, x, h - 0.04, z, yaw, scl, t, t, t);
        }
        break;
      case "snow":
        if (roll < 0.031 && !noSolid) {
          if (!thin(wx, wz, 617, ns.rocks)) {
            solid.add(lib.rockSnow, x, h - 0.1, z, yaw, scl, t, t, t);
          }
        }
        break;
      case "underwater":
      case "deepwater":
        // Lake beds grow nothing here; the shallows are the waterline pass below.
        break;
      case "trampled":
        // A camp yard grows nothing — this empty case is the whole enforcement.
        break;
    }
  }

  // Waterline pass. Its own loop, not a biome case: every other pass rejects columns
  // below WATER_LEVEL + 1, which is exactly where reeds belong.
  for (let i = 0; i < 90; i++) {
    if (i > 0 && i % 12 === 0) {
      yield;
    }
    const lx = Math.floor(rng() * CHUNK_SIZE);
    const lz = Math.floor(rng() * CHUNK_SIZE);
    const roll = rng();
    const wx = ox + lx;
    const wz = oz + lz;
    terrain.columnInfo(wx, wz, ci);
    // A TIGHT band STRADDLING the waterline. Further out on dry sand they read as
    // green spikes; deeper, the opaque water hides the stem and only the seed head
    // shows, which reads as floating debris.
    if (ci.hc < WATER_LEVEL - 0.35 || ci.hc > WATER_LEVEL + 0.6) {
      continue;
    }
    if (ci.biome === "desert" || ci.biome === "snow") {
      continue;
    }
    // Few candidates, each planting a whole STAND: one stem per candidate rings a lake
    // in stubble. Resolved BEFORE the stand loop, which re-samples `ci` per stem.
    const nr = nature.for(ci.biome).reeds;
    if (roll > 0.055 * nr) {
      continue;
    }
    if (exSoft(wx + 0.5, wz + 0.5)) {
      continue;
    }
    // A STAND strays up to 3 units, further than any other clump here, and a road
    // crosses exactly this ground wherever it bridges.
    const nearRoad = roadDist < ROAD_SOFT_CLEAR + 3;
    const stand = natureCount(3 + Math.floor(rng() * 4), nr);
    for (let s = 0; s < stand; s++) {
      const ang = rng() * Math.PI * 2;
      const rad = s === 0 ? 0 : 0.8 + rng() * 2.2;
      const sx = lx + 0.5 + Math.cos(ang) * rad;
      const sz = lz + 0.5 + Math.sin(ang) * rad;
      if (sx < 0 || sz < 0 || sx >= CHUNK_SIZE || sz >= CHUNK_SIZE) {
        continue;
      }
      if (nearRoad && onRoad(ox + sx, oz + sz)) {
        continue;
      }
      terrain.columnInfo(ox + Math.floor(sx), oz + Math.floor(sz), ci);
      if (ci.hc < WATER_LEVEL - 0.5 || ci.hc > WATER_LEVEL + 0.9) {
        continue;
      }
      const t = 0.9 + rng() * 0.2;
      soft.add(
        lib.reedsT,
        sx,
        ci.h - 0.05,
        sz,
        rng() * Math.PI * 2,
        0.75 + rng() * 0.55,
        t * 0.96,
        t,
        t * 0.88,
      );
    }
  }

  // Sand dressing pass: the whole dry beach from the tide line up (hc 8.6..13.0) plus
  // desert sand, off one roll table.
  for (let i = 0; i < 200; i++) {
    if (i > 0 && i % 16 === 0) {
      yield;
    }
    const lx = Math.floor(rng() * CHUNK_SIZE);
    const lz = Math.floor(rng() * CHUNK_SIZE);
    const roll = rng();
    const wx = ox + lx;
    const wz = oz + lz;
    terrain.columnInfo(wx, wz, ci);
    if (ci.h < WATER_LEVEL + 1) {
      continue;
    }
    const sandy = ci.biome === "beach" || ci.biome === "desert";
    if (!sandy) {
      continue;
    }
    if (ci.biome === "beach" && (ci.hc < 8.6 || ci.hc > 13.0)) {
      continue;
    }
    if (exSoft(wx + 0.5, wz + 0.5)) {
      continue;
    }
    // Same off-by-a-footprint as the scatter pass. The draws stay where they are —
    // moving them above the rejections would re-roll every beach in the world — so the
    // stamp is re-tested instead, only where a road is in reach.
    const nearRoad = roadDist < ROAD_SOFT_CLEAR + 1;
    const x = lx + 0.5 + (rng() - 0.5) * 0.8;
    const z = lz + 0.5 + (rng() - 0.5) * 0.8;
    if (nearRoad && onRoad(ox + x, oz + z)) {
      continue;
    }
    const yaw = rng() * Math.PI * 2;
    const t = 0.92 + rng() * 0.16;
    // Same ladder rule as the scatter pass: bands stay put, a density thins what lands
    // in one. Only the three vegetation bands are governed — shells, sticks and
    // driftwood are mineral debris. These `continue` instead of wrapping their body
    // because each band draws inside itself, so a thinned candidate also skips its own
    // draws; that is already true of any density below 1, and `thin` is inert at 1.
    const nd = nature.for(ci.biome);
    if (roll < 0.14) {
      if (thin(wx, wz, 701, nd.grass)) {
        continue;
      }
      // Kept rare: an up-normal card takes full sun on both sides, so on bright sand a
      // blade reads as paper stuck in the beach. The dry tussock carries the dune cover.
      const dune = rng() < 0.5 ? lib.grassDuneA : lib.grassDuneB;
      soft.add(dune, x, ci.h - 0.03, z, yaw, 0.7 + rng() * 0.4, t, t, t * 0.95);
    } else if (roll < 0.32) {
      if (thin(wx, wz, 701, nd.grass)) {
        continue;
      }
      addTuft(true, x, z, yaw, 0.75 + rng() * 0.45, t, nearRoad);
    } else if (roll < 0.6) {
      if (thin(wx, wz, 701, nd.grass)) {
        continue;
      }
      addSprig(true, x, z, yaw, 0.8 + rng() * 0.5, t, t, t * 0.96, nearRoad);
    } else if (roll < 0.74) {
      // Squashed to 45% height so the flake is almost all lit top face: at full height
      // a one-voxel cube prints as a black dash with a cream cap on bright sand.
      const ss = 0.5 + rng() * 0.32;
      soft.add(lib.shellT, x, ci.h - 0.02, z, yaw, ss, t, t, t, ss * 0.45);
    } else if (roll < 0.81) {
      // Bleached sticks: the cheapest thing that puts a shadow on an empty dune.
      const ds = 0.9 + rng() * 0.5;
      soft.add(lib.deadwoodT, x, ci.h - 0.02, z, yaw, ds, t, t, t * 0.94, ds * 0.7);
    } else if (roll < 0.87 && !exSolid(ox + x, oz + z) && flatEnough(wx, wz, ci.h, 1)) {
      solid.add(lib.driftwoodT, x, ci.h - 0.02, z, yaw, 0.9 + rng() * 0.4, t, t, t);
    }
  }

  // Typed-array conversion touches every vertex, so keep the two meshes in separate
  // slices — their costs must not land on one rendered frame.
  yield;
  const solidGeo = solid.toGeometry();
  yield;
  const softGeo = soft.toGeometry();
  let solidMesh: THREE.Mesh | null = null;
  let softMesh: THREE.Mesh | null = null;
  if (solidGeo) {
    solidMesh = new THREE.Mesh(solidGeo, lib.solidMat);
    solidMesh.position.set(ox, 0, oz);
    solidMesh.castShadow = true;
    solidMesh.receiveShadow = true;
    solidMesh.matrixAutoUpdate = false;
    solidMesh.updateMatrix();
  }
  if (softGeo) {
    softMesh = new THREE.Mesh(softGeo, lib.softMat);
    softMesh.position.set(ox, 0, oz);
    softMesh.castShadow = false;
    softMesh.receiveShadow = true;
    softMesh.matrixAutoUpdate = false;
    softMesh.updateMatrix();
  }
  return { solid: solidMesh, soft: softMesh, trunks };
}

/** Complete-now wrapper for boot and headless model guards. */
export function buildChunkProps(
  cx: number,
  cz: number,
  terrain: Terrain,
  lib: PropLib,
  exclusions: readonly Exclusion[],
  roads: RoadClearance | null = null,
  site: SiteClearance | null = null,
): ChunkProps {
  const steps = buildChunkPropsSteps(cx, cz, terrain, lib, exclusions, roads, site);
  let result = steps.next();
  while (!result.done) {
    result = steps.next();
  }
  return result.value;
}
