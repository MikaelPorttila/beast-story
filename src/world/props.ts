/**
 * Vegetation & decoration props. Voxel templates are baked once, then
 * stamped (rotated/scaled/tinted) into two merged meshes per chunk:
 * a shadow-casting "solid" mesh (trees, rocks, cacti, mushrooms) and a
 * "soft" mesh (grass tufts, flowers) that only receives shadows.
 */
import * as THREE from 'three';
import { VoxelModel, shade } from '../core/voxel';
import { hashCell, mulberry32 } from './noise';
import { CHUNK_SIZE, Terrain, WATER_LEVEL, makeScratch, type ColumnScratch } from './terrain';

interface Template {
  pos: Float32Array;
  nrm: Float32Array;
  col: Float32Array;
  idx: ArrayLike<number>;
}

/**
 * Undo VoxelModel's baked fake-sun face shading, and give shaded faces a warm
 * skylight/bounce term instead.
 *
 * `VoxelModel.build` multiplies every face by a fixed table — top 1.0, +/-X 0.88,
 * +/-Z 0.80, bottom 0.62 — which is a BAKED sun. This scene has a real
 * directional sun plus a deliberately cool HemisphereLight (sky 0xb8daff over
 * ground 0x8fa4bd), so the baked term stacks on top of N.L and darkens exactly
 * the faces that were already worst off: a face the sun cannot reach receives
 * nothing but the cool fill, and then gets multiplied by 0.8 or 0.62 on top. That
 * is the whole of "props float and are unlit", "almost pure black-grey with no
 * colour" and "an unlit slate monolith" — a boulder's shaded flank had roughly a
 * fifth of the light its top had and no hue left in it.
 *
 * The terrain mesher solved the same problem for terraces by inverting its own
 * side-shade table (see SIDE_SHADE in chunk.ts), but a prop cannot do that: every
 * instance is randomly yawed, so a direction-dependent bake would rotate away
 * from the sun. What a prop CAN have is an isotropic correction — lift the
 * non-top faces close to neutral so the real lighting is the only thing shading
 * them, and warm them slightly, because the bounce light arriving at a shaded
 * face has come off sunlit ground and because a shaded face that keeps a hue
 * reads as shade while a neutral-blue one reads as a hole.
 *
 * Bottom faces keep the most darkening (0.86/0.62): they are genuinely the least
 * lit surface on any prop, they are rarely visible, and a fully-lifted underside
 * makes a boulder look like it is glowing from below.
 */
export function relight(nrm: Float32Array, col: Float32Array): void {
  for (let i = 0; i < nrm.length; i += 3) {
    const ny = nrm[i + 1];
    let lift: number;
    if (ny > 0.5) lift = 1;                    // top: already 1.0, leave alone
    else if (ny < -0.5) lift = 0.86 / 0.62;    // bottom
    else if (Math.abs(nrm[i]) > 0.5) lift = 0.96 / 0.88; // +/-X
    else lift = 0.96 / 0.80;                   // +/-Z
    // Warm bounce, strongest on the faces with the least sky above them.
    const warm = ny > 0.5 ? 0 : 0.055;
    col[i] *= lift * (1 + warm);
    col[i + 1] *= lift;
    col[i + 2] *= lift * (1 - warm);
  }
}

function bake(model: VoxelModel, scale: number): Template {
  const mesh = model.build(scale, true);
  const g = mesh.geometry;
  const t: Template = {
    pos: (g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array,
    nrm: (g.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array,
    col: (g.getAttribute('color') as THREE.BufferAttribute).array as Float32Array,
    idx: g.getIndex()!.array,
  };
  relight(t.nrm, t.col);
  (mesh.material as THREE.Material).dispose();
  return t;
}

class Accum {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  idx: number[] = [];

  /**
   * Stamp one template. `sy` scales height independently of `s` (girth), which
   * is the cheapest possible silhouette variety: a uniform scale just makes a
   * bigger copy of the same tree, while a squat-vs-lanky pair of the same
   * template read as two different trees at gameplay distance. Normals are NOT
   * rescaled — the anisotropy here stays inside about 0.8..1.25, where the
   * shading error is far below the per-voxel jitter and not worth a per-vertex
   * normalise on the chunk build path.
   */
  add(
    t: Template,
    x: number, y: number, z: number,
    yaw: number, s: number,
    tr: number, tg: number, tb: number,
    sy: number = s,
  ): void {
    const base = this.pos.length / 3;
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const p = t.pos;
    const n = t.nrm;
    const cl = t.col;
    for (let i = 0; i < p.length; i += 3) {
      const px = p[i] * s;
      const py = p[i + 1] * sy;
      const pz = p[i + 2] * s;
      this.pos.push(x + px * c + pz * sn, y + py, z - px * sn + pz * c);
      const nx = n[i];
      const nz = n[i + 2];
      this.nrm.push(nx * c + nz * sn, n[i + 1], -nx * sn + nz * c);
      this.col.push(cl[i] * tr, cl[i + 1] * tg, cl[i + 2] * tb);
    }
    const ix = t.idx;
    for (let i = 0; i < ix.length; i++) this.idx.push(base + ix[i]);
  }

  toGeometry(): THREE.BufferGeometry | null {
    if (this.idx.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    return geo;
  }
}

// ---------------------------------------------------------------------------
// Foliage / trunk helpers
// ---------------------------------------------------------------------------

/**
 * Canopy painter that keeps a private copy of what it painted so a second pass
 * can re-shade the volume from top to bottom.
 *
 * VoxelModel is write-only, and that is the whole reason the trees read as flat
 * green blobs: an ellipsoid canopy has no light gradient anywhere in it, while
 * real foliage is bleached where the sky hits it and nearly black underneath.
 * `bake` adds that gradient, plus per-voxel leaf jitter, which together turn a
 * silhouette-only blob into something with a lit side and a shaded belly.
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

  constructor(private readonly v: VoxelModel, seed: number) {
    this.n = (seed | 0) >>> 0;
  }

  private rnd(): number {
    this.n = (this.n * 1664525 + 1013904223) >>> 0;
    return ((this.n >>> 9) & 0xffff) / 0x10000;
  }

  private put(x: number, y: number, z: number, color: number): void {
    this.cells.set(`${x},${y},${z}`, color);
    this.v.set(x, y, z, color);
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (z < this.minZ) this.minZ = z;
    if (z > this.maxZ) this.maxZ = z;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
  }

  /**
   * A leaf clump. `ragged` erodes the rim probabilistically so the outline is
   * broken foliage rather than a machined sphere — the other half of why the old
   * canopies read as toy balls.
   */
  clump(
    cx: number, cy: number, cz: number,
    rx: number, ry: number, rz: number,
    color: number, ragged = 0.2,
  ): void {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++)
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
        for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++) {
          const dx = (x - cx) / rx, dy = (y - cy) / ry, dz = (z - cz) / rz;
          const d = dx * dx + dy * dy + dz * dz;
          if (d > 1.0) continue;
          // Only the outermost shell erodes, and only sometimes. Chewing deeper
          // than this (or above ~25%) does not read as ragged foliage — it
          // detaches single voxels and the canopy becomes floating confetti.
          if (d > 0.84 && this.rnd() < ragged) continue;
          // ±10% per-voxel leaf value so a clump has texture inside its outline
          this.put(x, y, z, shade(color, 0.9 + this.rnd() * 0.2));
        }
  }

  /**
   * Vertical light gradient: sunlit crown, dark shaded underside.
   *
   * `k` scales the whole effect toward neutral. Anything only three or four
   * voxels tall (a bush, a fern) is ALL crown and ALL underside at once, so the
   * full-strength gradient turns it into a two-tone stack instead of a volume.
   */
  bake(k = 1): void {
    const scaled = (v: number): number => 1 + (v - 1) * k;
    for (let x = this.minX; x <= this.maxX; x++) {
      for (let z = this.minZ; z <= this.maxZ; z++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let y = this.minY; y <= this.maxY; y++) {
          if (!this.cells.has(`${x},${y},${z}`)) continue;
          if (y < lo) lo = y;
          hi = y;
        }
        if (lo === Infinity) continue;
        const at = (y: number, m: number): void => {
          const c = this.cells.get(`${x},${y},${z}`);
          if (c !== undefined) this.v.set(x, y, z, shade(c, m));
        };
        at(hi, scaled(1.18));
        if (hi - 1 > lo) at(hi - 1, scaled(1.07));
        at(lo, scaled(0.62));
        if (lo + 1 < hi) at(lo + 1, scaled(0.78));
        if (lo + 2 < hi) at(lo + 2, scaled(0.9));
      }
    }
  }
}

/**
 * Tapered, bark-varied trunk. `r0` is the half-width at the root (a 2r0-wide
 * flare), narrowing to a single voxel column at the top. Real trunks flare where
 * they meet the ground and every one of them has value variation up the bark;
 * the old straight 2x2 prism with two darker voxels read as a fence post.
 */
function trunk(
  v: VoxelModel, h: number, base: number, seed: number, r0 = 1,
): void {
  let n = seed >>> 0;
  const rnd = (): number => {
    n = (n * 1664525 + 1013904223) >>> 0;
    return ((n >>> 9) & 0xffff) / 0x10000;
  };
  for (let y = 0; y <= h; y++) {
    // flare only in the bottom ~18% of the trunk
    const w = y < Math.max(1, h * 0.18) ? r0 : 0;
    const m = 0.84 + rnd() * 0.3;
    v.box(-w - 1, y, -w - 1, w, y, w, shade(base, m));
  }
  // A couple of root buttresses so the trunk grips the ground.
  v.set(-2, 0, 0, shade(base, 0.78));
  v.set(1, 0, -1, shade(base, 0.86));
  v.set(0, 0, 1, shade(base, 0.8));
}

// ---------------------------------------------------------------------------
// Template builders
// ---------------------------------------------------------------------------

/**
 * Broadleaf canopy palette.
 *
 * These used to be 0x3d9531..0x72cc55 — the same yellow-greens as the meadow
 * (0x54c832) at nearly the same value, so a tree standing in front of a grassy
 * hillside had no edge at all and simply dissolved into it. Foliage in life is a
 * clear step DARKER and COOLER than open grass (it is a canopy shading itself,
 * seen against a surface in full sun), and pushing it that way is what makes the
 * forest read as a separate layer of the landscape.
 *
 * The spread from CANOPY_DEEP to CANOPY_CROWN is deliberately wide: Canopy.bake
 * lays a further top-to-bottom gradient over whichever of these a clump uses, so
 * a finished canopy carries four or five distinguishable tones — sunlit crown,
 * two mids, shaded flank, dark belly — instead of one flat green.
 */
const CANOPY_DEEP = 0x22662f;
const CANOPY_MID = 0x2d7c36;
const CANOPY_SIDE = 0x35893a;
const CANOPY_LIT = 0x459a43;
const CANOPY_CROWN = 0x5cb251;
const BIRCH_DEEP = 0x3a8c3a;
const BIRCH_MID = 0x4aa044;
const BIRCH_CROWN = 0x6cbe55;

/** Tall, narrow oak with an offset lobe — breaks up the round-oak silhouette. */
function oakTreeTall(): Template {
  const v = new VoxelModel();
  trunk(v, 10, 0x7a5233, 0x51f7);
  const c = new Canopy(v, 0x2731);
  c.clump(-0.5, 12, -0.5, 3.8, 5.0, 3.8, CANOPY_MID);
  c.clump(-0.5, 15.5, -0.5, 2.6, 2.8, 2.6, CANOPY_CROWN);
  c.clump(2.0, 10.5, 1.2, 2.6, 2.2, 2.6, CANOPY_SIDE);
  c.clump(-2.8, 13.5, 0.8, 2.2, 1.9, 2.2, CANOPY_LIT);
  c.bake();
  return bake(v, 0.23);
}

function oakTree(big: boolean): Template {
  const v = new VoxelModel();
  const h = big ? 9 : 7;
  trunk(v, h, 0x7a5233, big ? 0x91c3 : 0x4b12);
  const c = new Canopy(v, big ? 0x77ab : 0x1d0e);
  // Clumped, not one shell: a big shaded mass low and inboard, two mid clumps
  // pushed out to opposite sides, and a bright crown catching the sky.
  c.clump(-0.5, h + 2.2, -0.5, big ? 5.8 : 4.8, big ? 4.2 : 3.5, big ? 5.8 : 4.8, CANOPY_DEEP);
  c.clump(2.2, h + 4.0, 1.0, big ? 3.6 : 3.0, 2.8, big ? 3.6 : 3.0, CANOPY_LIT);
  c.clump(-3.0, h + 3.4, -2.0, big ? 3.3 : 2.8, 2.5, big ? 3.3 : 2.8, CANOPY_MID);
  c.clump(0.5, h + 3.0, 2.6, 2.4, 2.0, 2.4, CANOPY_SIDE);
  c.clump(-0.5, h + 5.4, -0.5, big ? 2.8 : 2.4, 1.9, big ? 2.8 : 2.4, CANOPY_CROWN);
  c.bake();
  return bake(v, big ? 0.27 : 0.22);
}

/**
 * A third broadleaf silhouette: a low, broad, spreading crown on a short trunk.
 * The other three oaks are all taller than they are wide, so every plains tree
 * repeated the same vertical proportion; this one is the opposite shape and
 * changes the horizon wherever it lands.
 */
function oakTreeBroad(): Template {
  const v = new VoxelModel();
  trunk(v, 5, 0x744d31, 0x3ac1, 1);
  const c = new Canopy(v, 0x6f22);
  c.clump(0, 7.0, 0, 6.4, 2.9, 6.0, CANOPY_DEEP);
  c.clump(-2.6, 8.2, 1.4, 3.4, 2.3, 3.2, CANOPY_MID);
  c.clump(3.0, 7.8, -1.6, 3.2, 2.1, 3.0, CANOPY_SIDE);
  c.clump(0.4, 9.4, 0.2, 3.0, 1.9, 2.8, CANOPY_LIT);
  c.clump(-0.8, 10.6, -0.6, 1.8, 1.2, 1.8, CANOPY_CROWN);
  c.bake();
  return bake(v, 0.26);
}

function birchTree(): Template {
  const v = new VoxelModel();
  // low-contrast tan bands (~15%) so the trunk doesn't read as a survey pole
  for (let y = 0; y <= 9; y++) {
    v.set(0, y, 0, y === 2 || y === 5 ? 0x8f7752 : y === 7 ? 0xb59d78 : 0xc9b184);
  }
  v.set(-1, 0, 0, 0xb59d78);
  v.set(0, 0, 1, 0xa89066);
  const c = new Canopy(v, 0xbb31);
  // Birch keeps the lightest, yellowest foliage of the broadleaves — it is the
  // one tree that is SUPPOSED to read as a pale accent in a dark wood — but even
  // it now sits below the meadow so its outline holds against a hillside.
  c.clump(0, 11.3, 0, 3.6, 3.0, 3.6, BIRCH_MID);
  c.clump(1.2, 12.9, 0.6, 2.2, 1.7, 2.2, BIRCH_CROWN);
  c.clump(-1.6, 10.6, -0.8, 2.0, 1.6, 2.0, BIRCH_DEEP);
  c.bake();
  return bake(v, 0.2);
}

function pineTree(tall: boolean): Template {
  const v = new VoxelModel();
  v.box(0, 0, 0, 0, 3, 0, 0x6b4a2e);
  v.set(-1, 0, 0, 0x5a3d26);
  v.set(0, 0, 1, 0x5a3d26);
  const g1 = 0x2f8442;
  const g2 = 0x3f9c50;
  const snow = 0xdcecf2;
  const layers: Array<[number, number, number]> = tall
    ? [[4, 3, 4], [3, 5, 6], [3, 7, 8], [2, 9, 10], [1, 11, 12], [0, 13, 14]]
    : [[4, 3, 4], [3, 5, 6], [2, 7, 8], [1, 9, 10], [0, 11, 12]];
  let n = 0x9e11;
  for (let li = 0; li < layers.length; li++) {
    const [r, y0, y1] = layers[li];
    const base = li % 2 === 0 ? g1 : g2;
    // Each tier is brighter than the one under it, and each voxel is jittered:
    // a conifer's tiers self-shade heavily, and flat-coloured tiers were reading
    // as a stack of green plates.
    const tierM = 0.78 + (li / Math.max(1, layers.length - 1)) * 0.44;
    for (let x = -r; x <= r; x++)
      for (let z = -r; z <= r; z++)
        for (let y = y0; y <= y1; y++) {
          n = (n * 1664525 + 1013904223) >>> 0;
          const j = 0.9 + ((n >>> 12) & 0xff) / 255 * 0.2;
          // underside of each tier is the shaded one
          v.set(x, y, z, shade(base, tierM * j * (y === y0 ? 0.74 : 1)));
        }
    v.box(-r, y1, -r, r, y1, r, snow); // snow dusting on every tier top
  }
  return bake(v, tall ? 0.26 : 0.22);
}

/** Asymmetric pine — tier offsets wobble so the cone silhouette isn't a stamp. */
function pineIrregular(): Template {
  const v = new VoxelModel();
  v.box(0, 0, 0, 0, 3, 0, 0x6b4a2e);
  const g1 = 0x2f8244;
  const g2 = 0x3a9349;
  const snow = 0xdcecf2;
  // [radius, y0, y1, xOffset, zOffset]
  const layers: Array<[number, number, number, number, number]> = [
    [4, 3, 4, 1, 0], [3, 5, 6, -1, 1], [3, 7, 8, 0, -1], [2, 9, 10, 1, 0], [1, 11, 12, 0, 1], [0, 13, 13, 0, 0],
  ];
  for (let li = 0; li < layers.length; li++) {
    const [r, y0, y1, dx, dz] = layers[li];
    v.box(-r + dx, y0, -r + dz, r + dx, y1, r + dz, li % 2 === 0 ? g1 : g2);
    v.box(-r + dx, y1, -r + dz, r + dx, y1, r + dz, snow);
  }
  return bake(v, 0.24);
}

/**
 * Parameterized palm: frond count, trunk lean slope and height multiplier
 * give visually distinct variants so beach lines don't read as a production run.
 */
function palmTree(fronds: number, lean: number, heightMul: number): Template {
  const v = new VoxelModel();
  const trunk = 0x8a6238;
  const H = Math.max(8, Math.round(11 * heightMul));
  let topX = 0;
  for (let y = 0; y <= H; y++) {
    const xo = Math.round(y * lean);
    v.set(xo, y, 0, y % 3 === 0 ? 0x7a5530 : trunk);
    topX = xo;
  }
  const topY = H + 1;
  const leaf = 0x3f9e45;
  const leafL = 0x55b858;
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + fronds * 0.73;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    for (let k = 1; k <= 5; k++) {
      const y = topY + (k <= 1 ? 1 : k <= 3 ? 0 : -(k - 3));
      v.set(topX + Math.round(dx * k), y, Math.round(dz * k), k >= 4 ? leafL : leaf);
    }
  }
  v.set(topX, topY, 0, leaf);
  v.set(topX, topY + 1, 0, leafL);
  v.set(topX - 1, topY - 1, 0, 0x5c3d24);
  v.set(topX + 1, topY - 1, 1, 0x5c3d24);
  return bake(v, 0.2);
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
    // Bloom chroma down ~30% into a dusty rose — the old 0xf47fb0 was a pure
    // magenta chip on an otherwise tan/green desert.
    v.set(0, (small ? 6 : 10), 0, 0xd08b9e);
  }
  return bake(v, small ? 0.16 : 0.18);
}

function rock(kind: 0 | 1 | 2): Template {
  const v = new VoxelModel();
  // A wider warm mineral range than before. Three near-identical greys spanning
  // only 0x7d..0x9a gave a boulder about 12% of internal contrast, which after
  // the tone curve is nothing: the clusters read as flat concrete lumps. This
  // spans 0x5c..0xb4, and the vertical shading pass below adds the lit-crown /
  // shaded-base read that terrain gets from its baked corner AO and that props
  // previously got from nowhere at all.
  // The dark end is UP and warmer. warmD used to be 0x5c554c, and once the
  // Canopy shading pass had taken another 23% off it and a shaded face received
  // only the cool hemisphere fill, the result measured as a near-black chip with
  // no hue in it at all — filed as "a cluster of near-black rock cubes" and "an
  // unlit slate monolith". A stylised boulder's darkest tone still has to be
  // recognisably STONE-coloured; the shading comes from the light, not from
  // painting the albedo black.
  const warmA = 0xbdb2a0;
  const warmB = 0x9c917f;
  const warmC = 0x847a6b;
  const warmD = 0x6f6558;
  // Canopy is misnamed for a boulder but it is precisely the right tool: it
  // records every voxel it paints (jittering each by ±10% on the way in), then
  // re-shades each column from its topmost voxel downward. Painting the whole
  // rock through it — rather than straight into the VoxelModel, which is
  // write-only and so invisible to the second pass — is what lets the crown
  // catch sky while the base sits in contact shade.
  const g = new Canopy(v, 0x51a3 + kind * 71);
  if (kind === 0) {
    g.clump(0, 0.8, 0, 3, 2, 2.4, warmB, 0.12);
    g.clump(0.8, 1.8, 0.2, 1.5, 1, 1.2, warmA, 0);
    // A darker shelf bedded low on one flank: real boulders sit in the ground.
    g.clump(-1.6, 0.2, -0.9, 1.9, 0.9, 1.6, warmD, 0.2);
    // satellite pebbles break the lone-boulder silhouette
    v.set(4, -1, 1, shade(warmC, 0.96));
    v.box(-4, -1, -1, -4, 0, -1, shade(warmA, 0.9));
  } else if (kind === 1) {
    g.clump(0, 1, 0, 3.6, 2.6, 3, warmC, 0.12);
    g.clump(-1.4, 1.2, 0.8, 2, 1.6, 1.6, warmB, 0);
    g.clump(1.6, 2.4, -0.6, 1.4, 1, 1.2, warmA, 0);
    g.clump(1.2, 0.1, 1.8, 2.2, 1.0, 1.8, warmD, 0.2);
    v.box(5, -1, 2, 5, 0, 2, shade(warmB, 0.92));
    v.set(-4, -1, -3, shade(warmA, 0.88));
  } else {
    g.clump(0, 0.8, 0, 3, 2, 2.4, warmC, 0.12);
    g.clump(-1.4, 0.2, 1.0, 1.8, 0.9, 1.5, warmD, 0.2);
    v.set(4, -1, 0, shade(warmB, 0.94));
  }
  // 0.6 strength: a boulder is only four or five voxels tall, so the full ramp
  // (tuned for a tree canopy) would turn it into a two-tone stack.
  g.bake(0.6);
  // The snow cap goes on AFTER the shading pass, which rewrites every voxel the
  // Canopy recorded — painted before, the cap would be overwritten with shaded
  // rock wherever the two volumes overlap.
  if (kind === 2) v.ellipsoid(0, 2.1, 0, 2.4, 0.9, 1.9, 0xe9f2f7);
  return bake(v, kind === 1 ? 0.28 : 0.2);
}

/**
 * Chunky voxel tussock: a knot of 1-voxel stems of staggered height with pale
 * tips. This is the AO-safe half of the meadow — a solid volume, so a
 * screen-space occlusion pass reads it correctly, where a 2-pixel billboard
 * quad gets crushed. It is also the more Cube-World read of the two: actual
 * cubes of grass standing up out of the sward.
 */
/**
 * Four distinct tussock silhouettes, `variant` 0-3.
 *
 * There used to be ONE footprint, and it was a symmetric plus — which meant the
 * random yaw every instance already got did nothing at all to its outline, and a
 * meadow read as "the identical pale-green claw shape at the identical yaw"
 * repeated a hundred times. Rotational symmetry is the trap: a tuft has to be
 * ASYMMETRIC before yawing it buys any variety. Each of these leans, sprawls or
 * clusters differently, so four templates times a full circle of yaw times +/-20%
 * scale is enough that no two tufts in a frame match.
 */
function grassTuft(dry: boolean, variant = 0): Template {
  const v = new VoxelModel();
  // Anchored just off the ground's own value, same rule as the blade billboards:
  // the wet set sits a shade over the meadow green, the dry set a shade over the
  // sand. `0x4d9c34` used to be the mid tone and read as a dark knot on lit
  // grass; everything here is a step brighter and yellower now.
  // Pitched WELL above the ground colour, unlike the billboards, and for a
  // concrete reason: a tuft is a knot of 2x2 voxel columns, so most of its screen
  // area is vertical side faces, and the sun (170,160,113) leaves two of the four
  // side directions with no direct light at all. At the sward's own value that
  // made every tuft a dark olive smudge on lit grass. Overshooting the albedo is
  // what lands the *rendered* result inside the meadow's band.
  // Pulled DOWN toward the ground's own value, and the base is darker still.
  //
  // The old set (0x74c94d over 0x63b53f, tips 0x9ade67) sat clearly LIGHTER than
  // the meadow, and a light tuft on darker grass reads as something lying on top
  // of the surface rather than growing out of it — at gameplay distance a field of
  // them reads as fuzz or mould. The mid tone now sits just under the sward, only
  // the very tips are brighter than it, and `root` plants the bottom voxel in
  // contact shade so each tuft has a base instead of hovering. Note this is
  // authored against `relight` above, which lifts the vertical faces the sun
  // misses — the old palette was overshooting the albedo to compensate for
  // exactly that darkening, and no longer needs to.
  const a = dry ? 0xc4b473 : 0x58a83c;
  const b = dry ? 0xb2a066 : 0x4b9634;
  const c = dry ? 0xd8c88c : 0x86c95a;
  const root = dry ? 0x8b7d50 : 0x33682a;
  // A SOLID clump, not a knot of separated stems.
  //
  // This used to be eight 2x2 columns with 2-voxel gaps between them, and viewed
  // from anywhere near overhead those gaps read as a black core inside a bright
  // rim: a lattice of thin geometry with air behind it is the worst possible input
  // to a screen-space occlusion pass, which fills every gap and then blurs the
  // result into one dark mass. A contiguous mound has no gaps to fill, and a
  // chunky solid tussock is the more Cube-World read anyway.
  //
  // Heights are also cut by ~60% from the original: the old 5-voxel stems came to
  // 0.72 units after scale, three quarters of a terrain step, which is a reed bed.
  // The tallest cell here is 3 voxels ≈ 0.33 units, i.e. ground cover.
  //
  // [x, z, height] over face-connected 2x2 cells. Every set is asymmetric.
  const SHAPES: Array<Array<[number, number, number]>> = [
    // 0 — a knot leaning hard to +x, tallest on the lee side
    [[0, 0, 2], [2, 0, 3], [2, 2, 1], [0, -2, 1], [-2, 0, 0], [4, 0, 0]],
    // 1 — a low ridge running along z with one tall end
    [[0, -2, 0], [0, 0, 1], [0, 2, 3], [2, 2, 2], [0, 4, 1], [-2, 0, 0]],
    // 2 — two separate humps sharing a thin bridge
    [[0, 0, 3], [2, 0, 1], [4, 0, 2], [4, 2, 1], [0, 2, 0]],
    // 3 — a broad low mat with a single spike off-centre
    [[0, 0, 1], [2, 0, 1], [0, 2, 0], [2, 2, 4], [-2, 0, 0], [-2, 2, 0], [2, 4, 0]],
  ];
  const cells = SHAPES[variant % SHAPES.length];
  for (let s = 0; s < cells.length; s++) {
    const [x, z, h] = cells[s];
    for (let y = 0; y <= h; y++) {
      v.box(x, y, z, x + 1, y, z + 1, y === 0 ? root : (s % 3 === 0 ? a : b));
    }
    // Only the tallest cells get bright tips — capping every cell with the light
    // tone is what turned the old tuft into a pale claw.
    if (h >= 2) v.box(x, h, z, x + 1, h, z + 1, c);
  }
  // 0.09 units per voxel, down from 0.12. At the old size a broad variant stamped
  // at 1.2x came out nearly a full block wide and half a block tall, and a smooth
  // rounded mass that size reads as a pillow or a small bush, not as a tussock.
  // Ground cover has to stay clearly under half a terrain step in every dimension.
  return bake(v, 0.09);
}

/**
 * Crossed-quad grass billboard: two intersecting quads with a vertex-color
 * gradient (dark at the root, bright at the tip), slight tilt and taper baked
 * per variant. No textures — pure vertex color, rendered double-sided in the
 * soft (non-shadow-casting) mesh, so meadows read as actual grass carpets.
 */
/**
 * sRGB hex -> linear triple, for vertex colours written straight into a
 * BufferAttribute (three.js reads those as linear). Same conversion
 * THREE.Color.setHex performs, and the same one terrain.ts uses — without it
 * these blades sat on a different colour convention from the ground they grow
 * out of, which is why they read as pale paper slivers.
 */
const lin = (hex: number): [number, number, number] => {
  const f = (c: number): number =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return [f(((hex >> 16) & 255) / 255), f(((hex >> 8) & 255) / 255), f((hex & 255) / 255)];
};

/**
 * A tuft of crossed grass planes.
 *
 * Three things were wrong with this and each of them was individually enough to
 * make it the ugliest thing in the frame:
 *
 *  1. HEIGHT. Blades ran 0.42-0.95 world units against a 1-unit terrain step, so
 *     grass stood as tall as the ground it grew out of and every meadow read as
 *     a dead reed swamp. Ground cover has to be ground cover: the tallest blade
 *     here is now about a third of a step, the shortest a fifth.
 *  2. VALUE. The root was `0x3d7f28` — far darker than the `0x54c832` meadow —
 *     so a tussock printed as near-black spikes on lit grass and as acid olive
 *     on pale sand. The band is now anchored just off the ground colour: the
 *     root a shade darker and cooler than the sward, the tip a shade brighter
 *     and yellower. Both defects (black-on-grass and clashing-on-sand) come from
 *     the same uncontrolled band, and clamping it fixes both at once.
 *  3. NORMALS. A 50/50 face/up normal blend meant blades took only half the sun
 *     the surrounding ground did, dragging them below the meadow's value however
 *     the colours were authored. 0.78 up / 0.22 face keeps them inside the
 *     meadow's range from every bearing while still giving each plane a little
 *     of its own facing.
 *
 * Three planes at 0/60/120 degrees rather than two at 0/90: with two, there are
 * bearings where one plane is edge-on and the other is at 45 degrees, and a
 * short wide tuft then reads as a single leaning card. At 60-degree spacing the
 * worst case is 30 degrees off face-on for the best plane, so the tuft holds a
 * volume from every angle. The extra plane is free — the height cut more than
 * pays for it in fill.
 */
function grassBillboard(
  tiltX: number, tiltZ: number, height: number, width: number,
  // Both ends pulled DOWN toward the sward. A blade card carries an up normal so
  // it takes exactly the same sun as the ground from every bearing (see the note
  // below) — which means an albedo brighter than the ground renders brighter than
  // the ground, and a field of pale lime cards on saturated grass reads as paper
  // scraps. Anchoring the root just under the meadow and the tip only just over it
  // is what makes a blade look like it grew there.
  rootC: [number, number, number] = lin(0x479526),
  tipC: [number, number, number] = lin(0x7cc043),
): Template {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  /**
   * One blade quad, emitted with BOTH windings over the same four vertices.
   *
   * These used to be single-winding quads on a DoubleSide material, and that is
   * why half of every meadow rendered as black spikes: three.js negates the
   * shading normal on back faces, so the reverse side of an up-facing blade got
   * a normal pointing at the ground and received nothing but bounce light.
   * Two windings sharing one upward normal costs two extra triangles and no
   * extra vertices, and both sides of the blade then take the sun.
   */
  const quad = (ax: number, az: number, ox: number, oz: number, s: number): void => {
    const base = pos.length / 3;
    const w = width * s;
    const h = height * s;
    const taper = 0.62; // narrower at the tip, but not a needle
    pos.push(
      -ax * w + ox, 0, -az * w + oz,
      ax * w + ox, 0, az * w + oz,
      ax * w * taper + tiltX + ox, h, az * w * taper + tiltZ + oz,
      -ax * w * taper + tiltX + ox, h, -az * w * taper + tiltZ + oz,
    );
    // Straight UP, with none of the blade's own facing mixed in.
    //
    // Every variant that tilted the normal toward the quad's face put a black
    // blade in the frame somewhere. A pure face normal flickers black as the
    // camera orbits past the plane (the sun goes behind it). A part-face blend
    // still leaves the normal pointing AWAY from the camera on roughly half the
    // blades in any tuft, and while Lambert diffuse survives that, nothing else in
    // the pipeline does: measured in the real game, the away-facing quads rendered
    // near-black in full sun with shadows proven not to be the cause, while the
    // edge-on ones beside them were correctly lit.
    //
    // An up normal is what stylised grass cards want anyway: the blade takes the
    // same light as the ground it grows out of, from every bearing, so a tuft can
    // never fall outside the meadow's value band. The root-to-tip vertex gradient
    // carries the form instead of the normal.
    for (let i = 0; i < 4; i++) nrm.push(0, 1, 0);
    col.push(...rootC, ...rootC, ...tipC, ...tipC);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  const C60 = 0.5, S60 = 0.866;
  quad(1, 0, 0, 0, 1);
  quad(-C60, S60, 0, 0, 0.92);
  quad(-C60, -S60, 0, 0, 0.86);
  // One short offset blade breaks the perfect rosette so a clump of tufts does
  // not read as a stamped pattern.
  quad(C60, S60, 0.11, -0.08, 0.66);
  return {
    pos: new Float32Array(pos),
    nrm: new Float32Array(nrm),
    col: new Float32Array(col),
    idx,
  };
}

/**
 * A blossom on a stem. `petal` is the lit face tone; `rim` the shaded outer
 * petals.
 *
 * Two tones, not one. A single-colour blossom is one flat chip of pure hue, and
 * at these saturations that is precisely what "neon and sit outside the palette
 * ... they punch out of an otherwise coherent green/tan world as pure hue chips"
 * describes. Giving the outer ring a darker, slightly desaturated version of the
 * same hue turns the chip into a small form with a lit centre and a shaded edge,
 * which is all it takes for the eye to accept it as an object in the scene.
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
 * Low rounded leaf bush — the anchor prop for meadow clumps.
 *
 * Shrub greens follow the same rule as the tree canopies: a clear step darker
 * and cooler than the meadow they sit in, or they dissolve into it. These are
 * lighter than a tree canopy (a knee-high bush really is closer to grass in
 * value than a canopy is) but no longer the same yellow-greens as the sward.
 */
function bush(): Template {
  const v = new VoxelModel();
  const c = new Canopy(v, 0x4a17);
  // No erosion at this size: the bush is barely three voxels tall, so its
  // "outer shell" is nearly the whole prop and any nibbling detaches voxels.
  c.clump(0, 1.1, 0, 2.7, 1.5, 2.5, 0x35872c, 0);
  c.clump(1.3, 1.6, 0.7, 1.6, 1.1, 1.5, 0x4aa338, 0);
  c.clump(-1.4, 1.4, -0.6, 1.5, 1.0, 1.4, 0x2c7526, 0);
  c.bake(0.45);
  v.set(1, 3, 0, 0x69c04e); // highlight sprig
  return bake(v, 0.13);
}

/**
 * Fern: a low rosette of arched fronds. The forest floor and every damp hollow
 * needs something wider than a grass blade and shorter than a bush, and a fern's
 * splayed silhouette reads instantly as undergrowth at gameplay distance.
 */
function fern(): Template {
  const v = new VoxelModel();
  const dark = 0x2f7a2a;
  const mid = 0x3f9634;
  const light = 0x59b348;
  // Solid crown, then six arched fronds. Every frond is a CONTIGUOUS run (each
  // cell face- or edge-adjacent to the last) and carries a second cell of width
  // at its shoulder. Marching `round(cos(a) * k)` outward instead — the obvious
  // way to write this — drops cells wherever the rounding repeats, and the prop
  // renders as a handful of unconnected floating voxels.
  v.box(0, 0, 0, 0, 3, 0, dark);
  v.set(0, 4, 0, light);
  const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]];
  for (let f = 0; f < dirs.length; f++) {
    const [dx, dz] = dirs[f];
    v.set(dx, 3, dz, mid);
    v.set(dx * 2, 3, dz * 2, light);
    v.set(dx * 2, 2, dz * 2, light); // the tip droops back down
  }
  // Roughly as tall as it is wide. An earlier version splayed to radius 4 at a
  // height of 3 and read as a flat green ring stamped on the ground.
  return bake(v, 0.19);
}

/**
 * Reeds: a tight stand of tall thin stems with pale seed heads, for the very
 * edge of the water. Shorelines are the one place a stylised world cannot get
 * away with a bare colour seam — reeds break the waterline silhouette and read
 * as "this lake is alive" from right across the bay.
 */
function reeds(): Template {
  const v = new VoxelModel();
  // Stems are 2x1 voxels and a good deal shorter than they were. As 1x1 columns
  // eight voxels tall they were 1.4 units of hard-edged acid green — the tallest
  // thing for metres around, and the actual source of the "tall thin blades" and
  // "stepped cyan spikes in the bay" complaints, which read as grass but are not.
  // Widening them and dropping the height turns a picket fence into a bed.
  //
  // The colour comes down out of the acid range too: a 2-wide stem is thick
  // enough on screen that it no longer needs to be over-bright to survive
  // aliasing, so it can sit in a believable water-plant green.
  const stem = 0x5f9c46;
  const stemD = 0x4d843c;
  const head = 0xbda868;
  const offs: Array<[number, number, number]> = [
    [0, 0, 4], [2, 0, 3], [-2, 1, 4], [0, -2, 5], [2, 2, 2], [-2, -2, 3], [4, 0, 3],
  ];
  for (const [x, z, h] of offs) {
    for (let y = 0; y <= h; y++) v.box(x, y, z, x + 1, y, z, y % 3 === 0 ? stemD : stem);
    v.box(x, h + 1, z, x + 1, h + 1, z, head);
  }
  return bake(v, 0.17);
}

/**
 * Dead branch / broken stick — dry litter for forest floors and dune lines.
 * Deliberately tiny and desaturated: its job is to break up an empty patch of
 * ground, not to be looked at.
 */
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
 * Weathered driftwood log for the beach transition band.
 *
 * Deliberately knobbly. The previous version was a smooth two-row prism, and a
 * bevelled box of one tone on flat sand reads as a bar of soap — which is what it
 * was filed as. Alternating bark values along the length, a split running down
 * one flank, and stubs sticking out at both ends give it the silhouette breaks and
 * the second tone it needs to read as wood.
 */
function driftwood(): Template {
  const v = new VoxelModel();
  const wood = 0x9b8468;
  const woodL = 0xb5a084;
  const woodD = 0x776350;
  for (let x = -3; x <= 3; x++) v.set(x, 0, 0, x % 2 === 0 ? wood : woodD);
  v.box(-2, 1, 0, 1, 1, 0, woodL);
  v.set(-1, 1, 1, woodD); // split down the flank
  v.set(2, 0, 1, wood);
  v.set(4, 0, 0, woodD); // broken tip
  v.set(-4, 1, 0, woodL); // upturned root end
  v.set(-4, 0, -1, woodD);
  v.set(1, 1, 1, shade(woodL, 0.9)); // branch stub
  return bake(v, 0.16);
}

/**
 * Fallen log — the driftwood silhouette scaled up into a real mid-scale
 * occluder: a 2-wide mossy trunk lying on its side, ~3m long, waist high.
 */
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

/** Waist-high hedge/bush clump — the missing size class between grass and tree. */
function hedgeClump(): Template {
  const v = new VoxelModel();
  v.box(0, 0, 0, 0, 1, 0, 0x6a5233);
  v.ellipsoid(0, 2.2, 0, 3.4, 2.4, 2.8, 0x347f2a);
  v.ellipsoid(2.6, 2.6, -1, 2.2, 1.9, 2, 0x3f9331);
  v.ellipsoid(-2.4, 2, 1.2, 2, 1.7, 1.9, 0x2a7024);
  v.ellipsoid(0.4, 4.2, 0.2, 1.6, 1.1, 1.5, 0x50aa3c);
  v.set(-1, 5, 1, 0x66c148); // stray sprig breaks the dome
  return bake(v, 0.24);
}

/**
 * Knee-high hedge — the fourth rung on the size ladder. The world previously
 * jumped grass (~0.4) -> hedgeClump (~1.7) -> tree (~5) with nothing between
 * the first two, so every mid-ground bush repeated at one height. This one is
 * deliberately ~60% of hedgeClump and rounder, and it reads as a different
 * plant rather than a shrunk copy.
 */
function hedgeSmall(): Template {
  const v = new VoxelModel();
  v.ellipsoid(0, 1.3, 0, 1.8, 1.2, 1.6, 0x3a8a2c);
  v.ellipsoid(1.2, 1.1, 0.6, 1.1, 0.9, 1, 0x489c36);
  v.ellipsoid(-1.1, 1, -0.5, 1, 0.8, 0.9, 0x317826);
  v.set(0, 3, 0, 0x5cb340); // sprig off the crown
  v.set(-1, 2, 1, 0x55aa3c);
  return bake(v, 0.24);
}

/**
 * Tiny shell/pebble dots scattered on the sand.
 *
 * These were three isolated 1x1x1 cubes of near-white, which is the worst
 * possible shape for a sunlit beach prop: a lone cube shows one lit top and
 * three or four vertical faces that catch almost no sun, so on bright sand they
 * read as cream-topped BLACK dice at maximum contrast. Two changes fix it
 * without losing the scatter — each dot is now 2x1 in plan and only one voxel
 * tall (so the lit top dominates its own silhouette), and the palette drops to a
 * shell tone that is barely off the sand's own value instead of near-white, so
 * even a badly-lit face cannot open a hole in the beach.
 */
function shells(): Template {
  const v = new VoxelModel();
  // Each dot is a 2x1 pale top with a DARKER cell butted against it, so the prop
  // is a two-tone flake rather than a single-value slab. Flat, uniform, rounded
  // 2x1 blocks with one bright top and one dark side were filed — accurately — as
  // "bars of soap on the beach"; the second tone plus the deliberately uneven
  // outline is what turns each one into a shell chip or a pebble.
  // Barely off the sand. Squashing these to 45% height (see the stamp) made their
  // lit tops the whole prop, and at the old near-white values that turned each dot
  // into a bright plate lying on the beach — dominoes rather than shell grit. A
  // scatter prop whose only job is to break up an empty surface must stay inside
  // that surface's own value band.
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
  // Cap chroma is down ~30% and pushed toward brick/terracotta: 0xd5483e was a
  // pure hue chip that punched a hole in the forest palette. The crown is the
  // lit tone, the skirt a step darker, so the cap has two tones like a real one.
  v.box(-1, 3, -1, 1, 3, 1, 0xa8564a);
  v.set(0, 4, 0, 0xc26a58);
  v.set(-1, 3, 0, 0xe0d8c8);
  v.set(1, 3, -1, 0xe0d8c8);
  return bake(v, 0.14);
}

// ---------------------------------------------------------------------------

export class PropLib {
  readonly solidMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  // Front-side: the grass billboards carry both windings themselves (see
  // grassBillboard), and every other soft prop is a closed voxel volume. Using
  // DoubleSide here instead inverted the shading normal on every blade's reverse
  // face and turned half the meadow black.
  readonly softMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1.0, metalness: 0 });

  readonly oakA = oakTree(false);
  readonly oakB = oakTree(true);
  readonly oakC = oakTreeTall();
  readonly oakD = oakTreeBroad();
  readonly birch = birchTree();
  readonly pine = pineTree(false);
  readonly pineTall = pineTree(true);
  readonly pineIrr = pineIrregular();
  readonly palm = palmTree(6, 0.25, 1.0);
  readonly palmB = palmTree(5, 0.1, 0.82);
  readonly palmC = palmTree(7, 0.34, 1.2);
  readonly cactusBig = cactus(false);
  readonly cactusSmall = cactus(true);
  readonly rockA = rock(0);
  readonly rockB = rock(1);
  readonly rockSnow = rock(2);
  /** Four asymmetric wet-meadow tussocks, and four dune ones. */
  readonly tufts = [0, 1, 2, 3].map((k) => grassTuft(false, k));
  readonly tuftsDry = [0, 1, 2, 3].map((k) => grassTuft(true, k));
  // Width is the HALF-width of a quad. Heights are all a fraction of the 1-unit
  // terrain step (see grassBillboard) and the tufts are correspondingly WIDER
  // relative to their height than before: short and broad reads as ground cover,
  // tall and thin reads as reeds.
  readonly grassA = grassBillboard(0.03, 0.02, 0.30, 0.10);
  readonly grassB = grassBillboard(-0.05, 0.03, 0.36, 0.115);
  readonly grassC = grassBillboard(0.02, -0.04, 0.22, 0.085);
  // A slightly taller, yellower tussock for the odd anchor in a meadow — still
  // barely half a step, so it adds a second height without adding reeds.
  readonly grassTall = grassBillboard(-0.03, 0.05, 0.50, 0.105, lin(0x4a8f26), lin(0x8ebb45));
  // Dune grass for the grass/sand transition band. Sits just off the sand's own
  // value the way the meadow blades sit just off the sward's — the old pair were
  // a fixed khaki that clashed wherever the sand ran light.
  // Narrower and darker than they were: a dune blade's whole failure mode is
  // reading as a broad pale sheet, and both halves of that are fixed by taking
  // width out and pulling the tip down toward the sand's own value.
  readonly grassDuneA = grassBillboard(0.04, 0.02, 0.30, 0.062, lin(0x8a8049), lin(0xb0a468));
  readonly grassDuneB = grassBillboard(-0.04, -0.03, 0.23, 0.055, lin(0x8a8049), lin(0xb0a468));
  readonly bushT = bush();
  readonly fernT = fern();
  readonly reedsT = reeds();
  readonly deadwoodT = deadwood();
  readonly driftwoodT = driftwood();
  readonly logT = fallenLog();
  readonly hedgeT = hedgeClump();
  readonly hedgeSmallT = hedgeSmall();
  readonly shellT = shells();
  // Chroma pulled down roughly 30% and every hue shifted into the world's light:
  // the red is now a warm coral rather than a fire-engine chip, the magenta a
  // dusty rose, the yellow a butter rather than a highlighter. Each has a
  // darker, slightly greyer rim tone (see `flower`).
  readonly flowerR = flower(0xdd7a68, 0xb85a4e);
  readonly flowerY = flower(0xe8c765, 0xc6a34a);
  readonly flowerP = flower(0xd292b0, 0xb0708f);
  readonly flowerW = flower(0xefe9dc, 0xcdc5b6);
  readonly flowerO = flower(0xe09b5e, 0xbc7a44);

  dispose(): void {
    this.solidMat.dispose();
    this.softMat.dispose();
  }
}

const mushroomT = mushroom();

/**
 * The linear colours the two tussock palettes are authored around.
 *
 * Used to blend each stamped tuft toward the ground under it: `Accum.add`
 * MULTIPLIES the template's colours by the tint, so dividing the sampled ground
 * colour by the template's own reference colour yields the factor that would turn
 * the tuft exactly into that ground colour, and lerping the tint from 1 toward
 * that factor is a partial blend. A tuft that shares its host's hue plants into
 * the sward; one authored at a fixed green sits on top of it as a pale claw,
 * which is what "reads as mould" describes.
 */
const TUFT_REF = lin(0x58a83c);
const TUFT_REF_DRY = lin(0xc4b473);
/** Clamp a ground-blend tint so a snow or lake-bed sample cannot blow one out. */
const clampTint = (v: number): number => (v < 0.5 ? 0.5 : v > 1.7 ? 1.7 : v);

export interface ChunkProps {
  solid: THREE.Mesh | null;
  soft: THREE.Mesh | null;
}

/**
 * World-space points props must keep clear of (spawn + shop dens).
 *
 * `kind` splits the exclusion by prop class, which matters enormously:
 *  - 'solid' (default) only holds back shadow-casting occluders — trees,
 *    boulders, hedges, logs, cacti, mushrooms, driftwood. Grass billboards,
 *    flowers, tufts and shells still grow right up to the pagoda deck.
 *  - 'all' clears every class (use sparingly — a bare disc reads as a bug).
 *
 * The old code applied ONE 7.5m radius to every class around spawn AND each
 * of the four dens, which merged into a single ~20m bald plane exactly where
 * the camera lives. Soft props are the cheapest thing in the world and the
 * only thing that makes the near ground read as ground, so they get no disc.
 */
export type Exclusion = { x: number; z: number; kind?: 'solid' | 'all' };

/** Squared clearance radius for solid occluders (~4.5m). */
const SOLID_CLEAR_R2 = 20;

export function buildChunkProps(
  cx: number,
  cz: number,
  terrain: Terrain,
  lib: PropLib,
  exclusions: readonly Exclusion[],
): ChunkProps {
  const rng = mulberry32(Math.floor(hashCell(terrain.seed, cx, 91, cz) * 0xffffffff));
  const solid = new Accum();
  const soft = new Accum();
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  const ci: ColumnScratch = makeScratch();

  /** Occluders (trees/rocks/hedges/logs/cacti) keep a small disc clear. */
  const exSolid = (wx: number, wz: number): boolean => {
    for (let i = 0; i < exclusions.length; i++) {
      const dx = wx - exclusions[i].x;
      const dz = wz - exclusions[i].z;
      if (dx * dx + dz * dz < SOLID_CLEAR_R2) return true;
    }
    return false;
  };

  /** Grass/flowers/shells: only 'all' discs stop them. */
  const exSoft = (wx: number, wz: number): boolean => {
    for (let i = 0; i < exclusions.length; i++) {
      if (exclusions[i].kind !== 'all') continue;
      const dx = wx - exclusions[i].x;
      const dz = wz - exclusions[i].z;
      if (dx * dx + dz * dz < SOLID_CLEAR_R2) return true;
    }
    return false;
  };

  const flatEnough = (wx: number, wz: number, h: number, tol: number): boolean =>
    Math.abs(terrain.getHeight(wx + 1, wz) - h) <= tol &&
    Math.abs(terrain.getHeight(wx - 1, wz) - h) <= tol &&
    Math.abs(terrain.getHeight(wx, wz + 1) - h) <= tol &&
    Math.abs(terrain.getHeight(wx, wz - 1) - h) <= tol;

  /**
   * Stamp one tussock: a random one of the four silhouettes, a full circle of
   * yaw, and a tint blended 45% toward the ground colour sampled beneath it.
   * Sunk 0.07 so the dark root row is half buried and the tuft has a contact
   * shadow of its own rather than resting on the surface.
   *
   * NOTE: clobbers `ci`. Every caller reads what it needs from `ci` first.
   */
  const addTuft = (
    dry: boolean, x: number, z: number, yaw: number, scl: number, vmul: number,
  ): void => {
    terrain.columnInfo(ox + Math.floor(x), oz + Math.floor(z), ci);
    if (ci.h < WATER_LEVEL + 1) return;
    const ref = dry ? TUFT_REF_DRY : TUFT_REF;
    const tpl = (dry ? lib.tuftsDry : lib.tufts)[Math.floor(rng() * 3.999)];
    const B = 0.45;
    soft.add(
      tpl, x, ci.h - 0.07, z, yaw, scl,
      clampTint(1 - B + B * (ci.topR / ref[0])) * vmul,
      clampTint(1 - B + B * (ci.topG / ref[1])) * vmul,
      clampTint(1 - B + B * (ci.topB / ref[2])) * vmul,
    );
  };

  /**
   * Lowest rendered column height anywhere under a footprint of radius `r`.
   *
   * Every solid prop used to be seated on the height of the ONE column at its
   * centre, and any prop wider than a voxel therefore hovered as soon as the
   * ground stepped down under its skirt: "a cluster of near-black rock cubes
   * hovers with visible air gaps beneath", "flat grey discs hovering above the
   * grass", "a brown dirt slab overhanging nothing". Seating on the MINIMUM of the
   * footprint instead means the prop can only ever be buried, never floating —
   * and buried is invisible while floating is a bug the eye finds instantly.
   * Callers additionally sink the base (see the `-` offsets at each stamp).
   *
   * Now that the terrain carries fine relief (see heightCont), the ground steps
   * far more often than it used to, so this matters much more than it did.
   */
  const groundMin = (wx: number, wz: number, r: number): number => {
    const k = Math.max(1, Math.round(r));
    let m = terrain.getHeight(wx, wz);
    let v = terrain.getHeight(wx + k, wz); if (v < m) m = v;
    v = terrain.getHeight(wx - k, wz); if (v < m) m = v;
    v = terrain.getHeight(wx, wz + k); if (v < m) m = v;
    v = terrain.getHeight(wx, wz - k); if (v < m) m = v;
    v = terrain.getHeight(wx + k, wz + k); if (v < m) m = v;
    v = terrain.getHeight(wx - k, wz - k); if (v < m) m = v;
    v = terrain.getHeight(wx + k, wz - k); if (v < m) m = v;
    v = terrain.getHeight(wx - k, wz + k); if (v < m) m = v;
    return m;
  };

  // ---- tree pass: jittered grid keeps organic spacing ----------------------
  for (let gx = 0; gx < 6; gx++) {
    for (let gz = 0; gz < 6; gz++) {
      const lx = gx * 5 + Math.floor(rng() * 5);
      const lz = gz * 5 + Math.floor(rng() * 5);
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
      const vroll = rng(); // variant pick, decoupled from density roll
      const jx = (rng() - 0.5) * 1.3;
      const jz = (rng() - 0.5) * 1.3;
      const wx = ox + lx;
      const wz = oz + lz;
      terrain.columnInfo(wx, wz, ci);
      const h = ci.h;
      if (exSolid(wx + 0.5, wz + 0.5)) continue;

      let tpl: Template | null = null;
      let jitterMul = 1;
      if (ci.biome === 'forest' && roll < 0.82) {
        tpl = vroll < 0.24 ? lib.oakA : vroll < 0.44 ? lib.oakB
          : vroll < 0.62 ? lib.oakC : vroll < 0.8 ? lib.oakD : lib.birch;
      } else if (ci.biome === 'plains' && roll < 0.34) {
        tpl = vroll < 0.32 ? lib.oakA : vroll < 0.54 ? lib.oakC
          : vroll < 0.78 ? lib.oakD : lib.birch;
      } else if (ci.biome === 'snow' && roll < 0.5) {
        tpl = vroll < 0.36 ? lib.pine : vroll < 0.68 ? lib.pineTall : lib.pineIrr;
      } else if (ci.biome === 'beach' && roll < 0.3 && ci.hc >= 8.6 && ci.hc <= 11.5) {
        // three distinct palms + extra scatter so beach lines feel organic
        tpl = vroll < 0.34 ? lib.palm : vroll < 0.67 ? lib.palmB : lib.palmC;
        jitterMul = 2.2;
      } else if (ci.biome === 'desert' && roll < 0.14) {
        tpl = lib.cactusBig;
      }
      if (!tpl) continue;
      if (h < WATER_LEVEL + (ci.biome === 'beach' ? 0 : 1)) continue;
      if (!flatEnough(wx, wz, h, 2)) continue;

      // Per-instance tint spread widened from ±8% to ±13%, with the green channel
      // sliding independently: a treeline of one green crushes to a single black
      // hedge at distance, where a treeline of a dozen greens keeps some internal
      // structure even once each canopy is only a few pixels across.
      const t = 0.87 + tintRoll * 0.26;
      // Trunk footprints are ~1.5 voxels wide; sink 0.3 so the root flare and the
      // buttress voxels bed into the ground instead of resting on it.
      solid.add(tpl, lx + 0.5 + jx * jitterMul, groundMin(wx, wz, 1) - 0.3,
        lz + 0.5 + jz * jitterMul,
        yaw, scl, t, t * (0.95 + tintRoll * 0.11), t * 0.97, sclY);
    }
  }

  // ---- mid-scale silhouette pass -------------------------------------------
  // The size class between "grass blade" and "tree" was missing entirely,
  // which is why the plains read as a bald lawn: nothing broke the horizon
  // between ankle height and 8m. 4-6 stamps per chunk — boulder clusters,
  // fallen logs, waist-high hedge clumps. Cheap (all reuse baked templates
  // merged into the existing two per-chunk meshes, no new draw calls).
  // Stamps `n` copies of one template in a loose knot around (mlx, mlz),
  // re-grounding each on its own column. Defined once per chunk build.
  const stampKnot = (
    tpl: Template,
    mlx: number, mlz: number,
    n: number, spread: number,
    sMin: number, sSpan: number, yOff: number,
    t: number,
  ): void => {
    for (let b = 0; b < n; b++) {
      const ang = rng() * Math.PI * 2;
      const rad = b === 0 ? 0 : spread * (0.45 + rng());
      const bx = mlx + Math.cos(ang) * rad;
      const bz = mlz + Math.sin(ang) * rad;
      if (bx < 0 || bz < 0 || bx >= CHUNK_SIZE || bz >= CHUNK_SIZE) continue;
      terrain.columnInfo(ox + Math.floor(bx), oz + Math.floor(bz), ci);
      if (ci.h < WATER_LEVEL + 1) continue;
      const bt = t * (0.93 + rng() * 0.14);
      const gy = groundMin(ox + Math.floor(bx), oz + Math.floor(bz), 2);
      solid.add(tpl, bx, gy + yOff, bz, rng() * Math.PI * 2,
        sMin + rng() * sSpan, bt, bt * 1.02, bt * 0.95);
    }
  };

  const midCount = 5 + Math.floor(rng() * 4);
  for (let m = 0; m < midCount; m++) {
    const mlx = 2 + rng() * (CHUNK_SIZE - 4);
    const mlz = 2 + rng() * (CHUNK_SIZE - 4);
    const kind = rng();
    const yaw = rng() * Math.PI * 2;
    const wx = ox + Math.floor(mlx);
    const wz = oz + Math.floor(mlz);
    terrain.columnInfo(wx, wz, ci);
    const h = ci.h;
    const biome = ci.biome;
    if (h < WATER_LEVEL + 1) continue;
    if (biome === 'underwater') continue;
    if (exSolid(wx + 0.5, wz + 0.5)) continue;
    if (!flatEnough(wx, wz, h, 2)) continue;
    const t = 0.92 + rng() * 0.16;
    const green = biome === 'plains' || biome === 'forest';

    // Size ladder for the mid ground, shortest to tallest: knee-high hedge
    // knot (~1) -> lone log (~0.8 but long and low) -> tall hedge clump (~1.7)
    // -> rock+log pair (~2) -> boulder outcrop (~2.5-3.5) -> tree (~4-6).
    // Before this there was exactly ONE hedge size, so every bush-shaped
    // silhouette in the mid ground repeated at the same height.
    if (!green) {
      // Desert/snow/beach: boulders only, at the old rate.
      if (kind >= 0.42) continue;
    } else if (kind >= 0.36) {
      if (kind < 0.5) {
        // Rock + log pair: a boulder with a trunk fetched up against it —
        // one readable ~2m mass rather than two lone pebbles.
        const rk = rng() < 0.5 ? lib.rockA : lib.rockB;
        // Capped at 1.95 (was 2.6). rock(1) bakes at 0.28 units/voxel with a
        // 3.6-voxel radius, so 2.6x produced a boulder over 5 units across, and one
        // of those a few units from a photo-mode camera filled a third of the frame
        // as a single unlit slab — the "slate monolith". A mid-ground silhouette
        // prop must stay smaller than the hero is tall by a clear margin.
        const rs = 1.45 + rng() * 0.5;
        const rw = 0.94 + rng() * 0.13;
        solid.add(rk, mlx, groundMin(wx, wz, 2) - 0.45, mlz, yaw, rs,
          t * rw, t, t * (1.94 - rw));
        const lang = yaw + 1.1 + rng() * 1.2;
        const lx2 = mlx + Math.cos(lang) * (1.4 + rng() * 0.9);
        const lz2 = mlz + Math.sin(lang) * (1.4 + rng() * 0.9);
        if (lx2 >= 0 && lz2 >= 0 && lx2 < CHUNK_SIZE && lz2 < CHUNK_SIZE) {
          terrain.columnInfo(ox + Math.floor(lx2), oz + Math.floor(lz2), ci);
          if (ci.h >= WATER_LEVEL + 1) {
            const lt = t * (0.95 + rng() * 0.1);
            solid.add(lib.logT, lx2,
              groundMin(ox + Math.floor(lx2), oz + Math.floor(lz2), 2) - 0.2,
              lz2, lang + Math.PI * 0.5,
              1.4 + rng() * 0.5, lt, lt * 0.98, lt * 0.92);
          }
        }
      } else if (kind < 0.64) {
        solid.add(lib.logT, mlx, groundMin(wx, wz, 2) - 0.2, mlz, yaw,
          0.9 + rng() * 0.5, t, t * 0.98, t * 0.94);
      } else if (kind < 0.84) {
        // knee-high hedges: the rung between grass and the tall clump
        stampKnot(lib.hedgeSmallT, mlx, mlz, 2 + Math.floor(rng() * 3), 1.5,
          0.85 + rng() * 0.2, 0.35, -0.25, t);
      } else {
        stampKnot(lib.hedgeT, mlx, mlz, 1 + Math.floor(rng() * 3), 1.5,
          0.95, 0.45, -0.3, t);
      }
      continue;
    }

    {
      // Boulder cluster: 2-3 existing rock templates at 1.4-2.2x, stamped
      // around a shared center so they read as one outcrop, not lone pebbles.
      const n = 2 + Math.floor(rng() * 2);
      for (let b = 0; b < n; b++) {
        const ang = rng() * Math.PI * 2;
        const rad = b === 0 ? 0 : 0.9 + rng() * 2;
        const bx = mlx + Math.cos(ang) * rad;
        const bz = mlz + Math.sin(ang) * rad;
        if (bx < 0 || bz < 0 || bx >= CHUNK_SIZE || bz >= CHUNK_SIZE) continue;
        terrain.columnInfo(ox + Math.floor(bx), oz + Math.floor(bz), ci);
        if (ci.h < WATER_LEVEL + 1) continue;
        const tpl = biome === 'snow' ? lib.rockSnow : rng() < 0.5 ? lib.rockA : lib.rockB;
        const bt = t * (0.94 + rng() * 0.12);
        const gy = groundMin(ox + Math.floor(bx), oz + Math.floor(bz), 2);
        // Per-boulder warm/cool tint. Stamped with a flat neutral tint (bt,bt,bt)
        // an outcrop of two or three rocks was three copies of the same grey, and
        // grey with no hue in it is the colour the eye reads as "untextured
        // placeholder". Real rock in one outcrop still varies in mineral warmth.
        const bw = 0.94 + rng() * 0.13;
        // Same cap and same sink as the rock+log pair above.
        solid.add(tpl, bx, gy - 0.45, bz, rng() * Math.PI * 2,
          1.25 + rng() * 0.6, bt * bw, bt, bt * (1.94 - bw));
      }
    }
  }

  // ---- meadow cluster pass -------------------------------------------------
  // Poisson-ish clumps instead of a uniform sprinkle: ~90 candidate centers,
  // each accepted one stamps 5-9 grass billboards in a tight disc, usually a
  // flower, occasionally a bush. Total instance counts stay close to the old
  // even scatter, but meadows gain rhythm — dense pockets with breathing room.
  const flowers = [lib.flowerR, lib.flowerY, lib.flowerP, lib.flowerW, lib.flowerO];
  const grasses = [lib.grassA, lib.grassB, lib.grassC];
  for (let k = 0; k < 115; k++) {
    const clx = 1 + rng() * (CHUNK_SIZE - 2);
    const clz = 1 + rng() * (CHUNK_SIZE - 2);
    const accept = rng();
    const wcx = ox + Math.floor(clx);
    const wcz = oz + Math.floor(clz);
    terrain.columnInfo(wcx, wcz, ci);
    const cb = ci.biome;
    if (cb !== 'plains' && cb !== 'forest') continue;
    // Acceptance is DOWN (0.80/0.42 -> 0.56/0.30). 115 candidates at 0.80 accepted
    // a clump every ~11 cells with a 1.7-unit radius, i.e. a continuous carpet with
    // no gaps — and a continuous carpet of anything reads as texture, not as
    // vegetation. Bare ground between clumps is what makes the clumps read.
    if (accept > (cb === 'plains' ? 0.56 : 0.30)) continue;
    if (ci.h < WATER_LEVEL + 1) continue;
    // Grass and flowers are welcome on the doorstep — only the bush below,
    // which casts shadows and blocks the path, respects the den discs.
    if (exSoft(wcx + 0.5, wcz + 0.5)) continue;
    const isForest = cb === 'forest';
    // +-8% per-cluster value jitter so whole clumps read lighter or darker.
    const cj = 0.92 + rng() * 0.16;
    // 8-14 blades in a TIGHT disc (see the radius below). Screen coverage, not
    // instance count, is what makes a meadow read: the same blades spread over a
    // 2.7-unit disc vanished into the ground, gathered into a 1.7-unit tussock
    // they occlude each other and register as grass.
    const members = 9 + Math.floor(rng() * 8);
    const grass = grasses[Math.floor(rng() * 2.999)];
    // One knee-high tussock anchors roughly a fifth of the clumps, so the
    // meadow has a second height in it instead of one uniform nap.
    if (rng() < 0.22) {
      soft.add(lib.grassTall, clx, ci.h - 0.03, clz, rng() * Math.PI * 2,
        0.8 + rng() * 0.4, cj * 0.98, cj, cj * 0.92);
    }
    // 0-2 solid tussocks INSIDE the clump. Moving the tufts here from the even
    // sparse sprinkle is the clustering half of the "reads as mould" fix: the same
    // total count, gathered into the same pockets as the blades, so a tufted patch
    // is genuinely a patch with clear ground around it. Scale spans +/-20% and yaw
    // the full circle, which now changes the outline because the four silhouettes
    // are asymmetric.
    const tuftN = rng() < 0.55 ? 1 + Math.floor(rng() * 2) : 0;
    for (let m = 0; m < tuftN; m++) {
      const ang = rng() * Math.PI * 2;
      const rad = rng() * 1.3;
      const tx = clx + Math.cos(ang) * rad;
      const tz = clz + Math.sin(ang) * rad;
      if (tx < 0 || tz < 0 || tx >= CHUNK_SIZE || tz >= CHUNK_SIZE) continue;
      addTuft(false, tx, tz, rng() * Math.PI * 2, 0.85 + rng() * 0.35,
        cj * (isForest ? 0.94 : 1));
    }
    terrain.columnInfo(wcx, wcz, ci); // addTuft clobbers ci; restore the cluster's
    for (let m = 0; m < members; m++) {
      const ang = rng() * Math.PI * 2;
      const rad = 0.3 + rng() * 1.4;
      const mx = clx + Math.cos(ang) * rad;
      const mz = clz + Math.sin(ang) * rad;
      if (mx < 0 || mz < 0 || mx >= CHUNK_SIZE || mz >= CHUNK_SIZE) continue;
      terrain.columnInfo(ox + Math.floor(mx), oz + Math.floor(mz), ci);
      if (ci.h < WATER_LEVEL + 1) continue;
      if (ci.biome !== 'plains' && ci.biome !== 'forest') continue;
      const t = cj * (0.96 + rng() * 0.08);
      soft.add(grass, mx, ci.h - 0.03, mz, rng() * Math.PI * 2, 0.65 + rng() * 0.5,
        isForest ? t * 0.9 : t * 0.97, t, isForest ? t * 0.86 : t * 0.9);
    }
    if (rng() < 0.7) { // usually one flower per clump
      const fx = clx + (rng() - 0.5) * 1.4;
      const fz = clz + (rng() - 0.5) * 1.4;
      terrain.columnInfo(ox + Math.floor(fx), oz + Math.floor(fz), ci);
      if (ci.h >= WATER_LEVEL + 1) {
        const ft = cj * (0.94 + rng() * 0.12);
        soft.add(flowers[Math.floor(rng() * 4.999)], fx, ci.h - 0.04, fz,
          rng() * Math.PI * 2, 0.8 + rng() * 0.4, ft, ft, ft);
      }
    }
    if (rng() < 0.16) { // occasional bush anchoring the clump
      const bx = clx + (rng() - 0.5) * 2;
      const bz = clz + (rng() - 0.5) * 2;
      terrain.columnInfo(ox + Math.floor(bx), oz + Math.floor(bz), ci);
      if (ci.h >= WATER_LEVEL + 1 && !exSolid(ox + Math.floor(bx) + 0.5, oz + Math.floor(bz) + 0.5)) {
        solid.add(lib.bushT, bx, ci.h - 0.05, bz, rng() * Math.PI * 2,
          0.8 + rng() * 0.5, cj, cj, cj);
      }
    }
  }

  // ---- sparse scatter pass --------------------------------------------------
  // Lone props between the clumps: singles of grass, rocks, mushrooms, tufts,
  // cacti. 320 rolls with thresholds scaled ~3x vs the old 950-roll loop so
  // per-chunk solid-prop counts stay roughly unchanged.
  for (let i = 0; i < 320; i++) {
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
    terrain.columnInfo(wx, wz, ci);
    const h = ci.h;
    if (h < WATER_LEVEL + 1) continue;
    if (exSoft(wx + 0.5, wz + 0.5)) continue;
    // Mixed pass: soft singles ignore the den discs, solid ones don't.
    const noSolid = exSolid(wx + 0.5, wz + 0.5);

    const t = 0.9 + pick * 0.2;
    const ft = 0.9 + pick * 0.18; // subtle per-instance flower tint variety
    const x = lx + 0.5 + jx;
    const z = lz + 0.5 + jz;
    const grass = grasses[Math.floor(pick * 2.999)];
    switch (ci.biome) {
      case 'plains':
        if (roll < 0.22) soft.add(grass, x, h - 0.03, z, yaw, 0.6 + scl * 0.45, t * 0.96, t, t * 0.9);
        // Solid tussocks at ~7% of rolls: enough that the meadow still reads as
        // grazed grass even where the billboard blades wash out.
        // Lone tussocks are DOWN from 7% of rolls to 4%: the meadow pass below now
        // plants them in clumps, and an even sprinkle on top of that is what made
        // the field read as uniform fuzz with no bare ground anywhere.
        else if (roll < 0.262) addTuft(false, x, z, yaw, 0.8 + scl * 0.5, t);
        else if (roll < 0.257 && !noSolid) solid.add(lib.rockA, x, h - 0.1, z, yaw, scl, t, t, t);
        else if (roll < 0.271) soft.add(lib.grassTall, x, h - 0.03, z, yaw, 0.8 + scl * 0.3, t, t, t * 0.94);
        else if (roll < 0.281) soft.add(lib.deadwoodT, x, h - 0.02, z, yaw, scl, t, t, t);
        break;
      case 'forest':
        if (roll < 0.1) soft.add(grass, x, h - 0.03, z, yaw, 0.5 + scl * 0.45, t * 0.86, t, t * 0.84);
        else if (roll < 0.127 && !noSolid) solid.add(mushroomT, x, h - 0.04, z, yaw, scl, t, t, t);
        else if (roll < 0.151 && !noSolid) solid.add(pick < 0.5 ? lib.rockA : lib.rockB, x, h - 0.1, z, yaw, scl, t, t, t);
        else if (roll < 0.211) addTuft(false, x, z, yaw, 0.8 + scl * 0.5, t * 0.95);
        // Undergrowth: ferns and fallen sticks are what makes a wood read as a
        // wood floor rather than a lawn with trunks standing on it.
        else if (roll < 0.30) soft.add(lib.fernT, x, h - 0.04, z, yaw, 0.85 + scl * 0.35, t * 0.9, t, t * 0.88);
        else if (roll < 0.325) soft.add(lib.deadwoodT, x, h - 0.02, z, yaw, scl, t, t, t);
        break;
      case 'beach':
        if (roll < 0.064) addTuft(true, x, z, yaw, scl, t);
        else if (roll < 0.086 && !noSolid) solid.add(lib.rockA, x, h - 0.1, z, yaw, scl, t, t, t);
        break;
      case 'desert':
        if (roll < 0.031 && !noSolid) solid.add(lib.rockA, x, h - 0.1, z, yaw, scl, t * 1.05, t, t * 0.9);
        else if (roll < 0.082) addTuft(true, x, z, yaw, scl, t);
        else if (roll < 0.095 && !noSolid) solid.add(lib.cactusSmall, x, h - 0.04, z, yaw, scl, t, t, t);
        break;
      case 'snow':
        if (roll < 0.031 && !noSolid) solid.add(lib.rockSnow, x, h - 0.1, z, yaw, scl, t, t, t);
        break;
      case 'underwater':
        break;
    }
  }

  // ---- waterline pass -------------------------------------------------------
  // Reed stands in the shallows and right at the tide line. This is the one
  // scatter that has to straddle the water surface, so it gets its own loop
  // instead of a biome case: every other pass rejects columns below
  // WATER_LEVEL + 1 outright, which is exactly where reeds belong.
  for (let i = 0; i < 90; i++) {
    const lx = Math.floor(rng() * CHUNK_SIZE);
    const lz = Math.floor(rng() * CHUNK_SIZE);
    const roll = rng();
    const wx = ox + lx;
    const wz = oz + lz;
    terrain.columnInfo(wx, wz, ci);
    // A TIGHT band around the surface: reeds must have their feet wet. The old
    // window ran to WATER_LEVEL + 0.5, which put whole stands on dry beach where
    // they read as bright green spikes stuck in the sand, and reached 1.3 units
    // down, where they stood in open water like posts. -0.9 .. +0.1 is the strip
    // that is genuinely shoreline.
    // The window is pulled UP to straddle the waterline instead of reaching a
    // metre below it. Now that the water surface is opaque past the tide line
    // (see water.ts), a reed rooted well under it has its whole stem hidden and
    // only its pale seed head showing — which reads as a scrap of debris floating
    // in the bay, not as a plant. Rooted within ~35cm of the line, the stem clears
    // the surface and the stand reads as reeds.
    if (ci.hc < WATER_LEVEL - 0.35 || ci.hc > WATER_LEVEL + 0.6) continue;
    if (ci.biome === 'desert' || ci.biome === 'snow') continue;
    // Few candidates, but each accepted one plants a whole STAND. Reeds grow in
    // beds with long clear beaches between them; one stem per candidate ringed
    // every lake in an even sprinkle that read as stubble, not vegetation.
    if (roll > 0.055) continue;
    if (exSoft(wx + 0.5, wz + 0.5)) continue;
    const stand = 3 + Math.floor(rng() * 4);
    for (let s = 0; s < stand; s++) {
      const ang = rng() * Math.PI * 2;
      const rad = s === 0 ? 0 : 0.8 + rng() * 2.2;
      const sx = lx + 0.5 + Math.cos(ang) * rad;
      const sz = lz + 0.5 + Math.sin(ang) * rad;
      if (sx < 0 || sz < 0 || sx >= CHUNK_SIZE || sz >= CHUNK_SIZE) continue;
      terrain.columnInfo(ox + Math.floor(sx), oz + Math.floor(sz), ci);
      if (ci.hc < WATER_LEVEL - 0.5 || ci.hc > WATER_LEVEL + 0.9) continue;
      const t = 0.9 + rng() * 0.2;
      soft.add(lib.reedsT, sx, ci.h - 0.05, sz, rng() * Math.PI * 2,
        0.75 + rng() * 0.55, t * 0.96, t, t * 0.88);
    }
  }

  // ---- sand dressing pass ----------------------------------------------------
  // The beaches were the emptiest surfaces in the world by a wide margin — a
  // shoreline could fill a third of a frame with nothing on it at all — because
  // this pass only reached a ~2-unit strip (hc 9.8..11.6) around the grass/sand
  // boundary and skipped the desert entirely. It now covers the whole dry beach
  // from the tide line up (8.6..13.0) and dresses desert sand from the same
  // roll table, at 200 candidates instead of 120. Everything here merges into the
  // chunk's two existing meshes, so the extra scatter costs triangles, not draw
  // calls.
  for (let i = 0; i < 200; i++) {
    const lx = Math.floor(rng() * CHUNK_SIZE);
    const lz = Math.floor(rng() * CHUNK_SIZE);
    const roll = rng();
    const wx = ox + lx;
    const wz = oz + lz;
    terrain.columnInfo(wx, wz, ci);
    if (ci.h < WATER_LEVEL + 1) continue;
    const sandy = ci.biome === 'beach' || ci.biome === 'desert';
    if (!sandy) continue;
    if (ci.biome === 'beach' && (ci.hc < 8.6 || ci.hc > 13.0)) continue;
    if (exSoft(wx + 0.5, wz + 0.5)) continue;
    const x = lx + 0.5 + (rng() - 0.5) * 0.8;
    const z = lz + 0.5 + (rng() - 0.5) * 0.8;
    const yaw = rng() * Math.PI * 2;
    const t = 0.92 + rng() * 0.16;
    if (roll < 0.17) {
      // Dune blades are HALVED in rate. An upright card with an up-facing normal
      // takes full sun on both sides, so on bright sand a khaki blade renders as a
      // pale flat sheet — at close range they read as scraps of paper stuck in the
      // beach, which is the one place billboards lose to solid voxels outright.
      // The dry tussock below now carries most of the dune cover.
      const dune = rng() < 0.5 ? lib.grassDuneA : lib.grassDuneB;
      soft.add(dune, x, ci.h - 0.03, z, yaw, 0.7 + rng() * 0.4, t, t, t * 0.95);
    } else if (roll < 0.42) {
      addTuft(true, x, z, yaw, 0.75 + rng() * 0.45, t);
    } else if (roll < 0.60) {
      // Squashed to 45% height. A shell dot is one voxel tall, and a CUBE that
      // small still shows four vertical faces as tall as it is wide — faces the
      // sun barely reaches, which on bright sand print as black dashes with a
      // cream cap. Independent height scaling is the cheap fix: half-height
      // flakes are almost all lit top face, which is what a shell chip lying on a
      // beach actually looks like.
      const ss = 0.5 + rng() * 0.32;
      soft.add(lib.shellT, x, ci.h - 0.02, z, yaw, ss, t, t, t, ss * 0.45);
    } else if (roll < 0.68) {
      // Bleached sticks: the dry-land equivalent of shell grit, and the cheapest
      // thing that puts a shadow on an empty dune.
      const ds = 0.9 + rng() * 0.5;
      soft.add(lib.deadwoodT, x, ci.h - 0.02, z, yaw, ds, t, t, t * 0.94, ds * 0.7);
    } else if (roll < 0.74 && !exSolid(wx + 0.5, wz + 0.5)
      && flatEnough(wx, wz, ci.h, 1)) {
      solid.add(lib.driftwoodT, x, ci.h - 0.02, z, yaw, 0.9 + rng() * 0.4, t, t, t);
    }
  }

  const solidGeo = solid.toGeometry();
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
  return { solid: solidMesh, soft: softMesh };
}
