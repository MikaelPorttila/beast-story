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

function bake(model: VoxelModel, scale: number): Template {
  const mesh = model.build(scale, true);
  const g = mesh.geometry;
  const t: Template = {
    pos: (g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array,
    nrm: (g.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array,
    col: (g.getAttribute('color') as THREE.BufferAttribute).array as Float32Array,
    idx: g.getIndex()!.array,
  };
  (mesh.material as THREE.Material).dispose();
  return t;
}

class Accum {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  idx: number[] = [];

  add(
    t: Template,
    x: number, y: number, z: number,
    yaw: number, s: number,
    tr: number, tg: number, tb: number,
  ): void {
    const base = this.pos.length / 3;
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const p = t.pos;
    const n = t.nrm;
    const cl = t.col;
    for (let i = 0; i < p.length; i += 3) {
      const px = p[i] * s;
      const py = p[i + 1] * s;
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
// Template builders
// ---------------------------------------------------------------------------

/** Tall, narrow oak with an offset lobe — breaks up the round-oak silhouette. */
function oakTreeTall(): Template {
  const v = new VoxelModel();
  const trunk = 0x7a5233;
  v.box(-1, 0, -1, 0, 10, 0, trunk);
  v.set(0, 3, -1, 0x6a4429);
  v.ellipsoid(-0.5, 12, -0.5, 3.6, 5.2, 3.6, 0x4ea63f);
  v.ellipsoid(-0.5, 15.5, -0.5, 2.4, 2.6, 2.4, 0x63bf50);
  v.ellipsoid(1.8, 10.5, 1.2, 2.4, 2.2, 2.4, 0x4fae43);
  v.ellipsoid(-2.6, 13.5, 0.8, 2, 1.8, 2, 0x74cc5c);
  return bake(v, 0.23);
}

function oakTree(big: boolean): Template {
  const v = new VoxelModel();
  const trunk = 0x7a5233;
  const h = big ? 9 : 7;
  v.box(-1, 0, -1, 0, h, 0, trunk);
  v.set(-1, 2, -1, 0x6a4429);
  const c1 = big ? 0x4fae43 : 0x4ea63f;
  const c2 = big ? 0x58b449 : 0x63bf50;
  v.ellipsoid(-0.5, h + 2.5, -0.5, big ? 6 : 5, big ? 4.5 : 3.8, big ? 6 : 5, c1);
  v.ellipsoid(2, h + 4, 1, 3.2, 2.6, 3.2, c2);
  v.ellipsoid(-3, h + 3.5, -2, 3, 2.4, 3, c2);
  v.ellipsoid(-0.5, h + 5.5, -0.5, 2.5, 1.8, 2.5, 0x74cc5c);
  return bake(v, big ? 0.27 : 0.22);
}

function birchTree(): Template {
  const v = new VoxelModel();
  // low-contrast tan bands (~15%) so the trunk doesn't read as a survey pole
  v.box(0, 0, 0, 0, 9, 0, 0xc9b184);
  v.set(0, 2, 0, 0x8f7752);
  v.set(0, 5, 0, 0x8f7752);
  v.set(0, 7, 0, 0xb59d78);
  v.ellipsoid(0, 11.5, 0, 3.5, 3, 3.5, 0x77c452);
  v.ellipsoid(1, 13, 0.5, 2, 1.6, 2, 0x93d968);
  return bake(v, 0.2);
}

function pineTree(tall: boolean): Template {
  const v = new VoxelModel();
  v.box(0, 0, 0, 0, 3, 0, 0x6b4a2e);
  const g1 = 0x3e9a52;
  const g2 = 0x4fae5f;
  const snow = 0xdcecf2;
  const layers: Array<[number, number, number]> = tall
    ? [[4, 3, 4], [3, 5, 6], [3, 7, 8], [2, 9, 10], [1, 11, 12], [0, 13, 14]]
    : [[4, 3, 4], [3, 5, 6], [2, 7, 8], [1, 9, 10], [0, 11, 12]];
  for (let li = 0; li < layers.length; li++) {
    const [r, y0, y1] = layers[li];
    v.box(-r, y0, -r, r, y1, r, li % 2 === 0 ? g1 : g2);
    v.box(-r, y1, -r, r, y1, r, snow); // snow dusting on every tier top
  }
  return bake(v, tall ? 0.26 : 0.22);
}

/** Asymmetric pine — tier offsets wobble so the cone silhouette isn't a stamp. */
function pineIrregular(): Template {
  const v = new VoxelModel();
  v.box(0, 0, 0, 0, 3, 0, 0x6b4a2e);
  const g1 = 0x3e9a52;
  const g2 = 0x4aab58;
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
    v.set(0, (small ? 6 : 10), 0, 0xf47fb0); // cheerful bloom
  }
  return bake(v, small ? 0.16 : 0.18);
}

/**
 * Ellipsoid painter with per-voxel value jitter (+-14%) so baked rock faces
 * vary voxel-to-voxel instead of reading as one flat grey blob.
 */
function jitterEllipsoid(
  v: VoxelModel,
  cx: number, cy: number, cz: number,
  rx: number, ry: number, rz: number,
  color: number, seed: number,
): void {
  let n = seed >>> 0;
  for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++)
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
      for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry, dz = (z - cz) / rz;
        if (dx * dx + dy * dy + dz * dz > 1.0) continue;
        n = (n * 1664525 + 1013904223) >>> 0;
        const m = 0.86 + ((n >>> 8) & 0xff) / 255 * 0.28;
        v.set(x, y, z, shade(color, m));
      }
}

function rock(kind: 0 | 1 | 2): Template {
  const v = new VoxelModel();
  // warm mineral greys (was cool blue-grey)
  const warmA = 0x9a9184;
  const warmB = 0x8a8276;
  const warmC = 0x7d766b;
  if (kind === 0) {
    jitterEllipsoid(v, 0, 0.8, 0, 3, 2, 2.4, warmB, 11);
    jitterEllipsoid(v, 0.8, 1.8, 0.2, 1.5, 1, 1.2, warmA, 29);
    // satellite pebbles break the lone-boulder silhouette
    v.set(4, -1, 1, shade(warmC, 0.96));
    v.box(-4, -1, -1, -4, 0, -1, shade(warmA, 0.9));
  } else if (kind === 1) {
    jitterEllipsoid(v, 0, 1, 0, 3.6, 2.6, 3, warmC, 47);
    jitterEllipsoid(v, -1.4, 1.2, 0.8, 2, 1.6, 1.6, warmB, 61);
    jitterEllipsoid(v, 1.6, 2.4, -0.6, 1.4, 1, 1.2, warmA, 83);
    v.box(5, -1, 2, 5, 0, 2, shade(warmB, 0.92));
    v.set(-4, -1, -3, shade(warmA, 0.88));
  } else {
    jitterEllipsoid(v, 0, 0.8, 0, 3, 2, 2.4, warmC, 97);
    v.ellipsoid(0, 2.1, 0, 2.4, 0.9, 1.9, 0xe9f2f7); // snow cap
    v.set(4, -1, 0, shade(warmB, 0.94));
  }
  return bake(v, kind === 1 ? 0.28 : 0.2);
}

function grassTuft(dry: boolean): Template {
  const v = new VoxelModel();
  const a = dry ? 0xc4b060 : 0x63c24d;
  const b = dry ? 0xb09a4e : 0x4fae3f;
  const c = dry ? 0xd2c078 : 0x78d05c;
  v.box(0, 0, 0, 0, 2, 0, b);
  v.box(-1, 0, 1, -1, 1, 1, a);
  v.box(1, 0, -1, 1, 1, -1, c);
  v.box(1, 0, 1, 1, 0, 1, a);
  v.box(-1, 0, -1, -1, 0, -1, c);
  return bake(v, 0.12);
}

/**
 * Crossed-quad grass billboard: two intersecting quads with a vertex-color
 * gradient (dark at the root, bright at the tip), slight tilt and taper baked
 * per variant. No textures — pure vertex color, rendered double-sided in the
 * soft (non-shadow-casting) mesh, so meadows read as actual grass carpets.
 */
function grassBillboard(
  tiltX: number, tiltZ: number, height: number, width: number,
  // Blades sit AT or slightly BELOW the ground value. Brighter-than-ground
  // blades turned every foreground into near-white paper ribbons; grass is a
  // shadowing, self-occluding mass and must read darker than the lit meadow.
  rootC: [number, number, number] = [0.24, 0.50, 0.16],
  tipC: [number, number, number] = [0.42, 0.74, 0.26],
): Template {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const quad = (ax: number, az: number, ox: number, oz: number, s: number): void => {
    const base = pos.length / 3;
    const w = width * s;
    const h = height * s;
    const taper = 0.55; // much narrower at the tip
    pos.push(
      -ax * w + ox, 0, -az * w + oz,
      ax * w + ox, 0, az * w + oz,
      ax * w * taper + tiltX + ox, h, az * w * taper + tiltZ + oz,
      -ax * w * taper + tiltX + ox, h, -az * w * taper + tiltZ + oz,
    );
    // Half face normal, half +Y. Pure up-normals made every blade take full
    // noon sun and blow out; the pure face normal makes them flicker black as
    // the camera orbits. The 50/50 blend keeps them planted in the meadow's
    // value range from every angle.
    const bx = -az * 0.5;
    const by = 0.5;
    const bz = ax * 0.5;
    const bl = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
    for (let i = 0; i < 4; i++) nrm.push(bx / bl, by / bl, bz / bl);
    col.push(...rootC, ...rootC, ...tipC, ...tipC);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  // three crossed blade pairs per cluster, offset for a natural clump
  quad(1, 0, 0, 0, 1);
  quad(0, 1, 0, 0, 1);
  quad(1, 0, 0.16, -0.12, 0.72);
  quad(0, 1, 0.16, -0.12, 0.72);
  quad(1, 0, -0.14, 0.15, 0.6);
  quad(0, 1, -0.14, 0.15, 0.6);
  return {
    pos: new Float32Array(pos),
    nrm: new Float32Array(nrm),
    col: new Float32Array(col),
    idx,
  };
}

function flower(petal: number): Template {
  const v = new VoxelModel();
  v.box(0, 0, 0, 0, 2, 0, 0x4a9a3c);
  v.set(1, 1, 0, 0x5cb44a);
  v.set(1, 3, 0, petal);
  v.set(-1, 3, 0, petal);
  v.set(0, 3, 1, petal);
  v.set(0, 3, -1, petal);
  v.set(0, 4, 0, petal);
  v.set(0, 3, 0, 0xfff0b0);
  return bake(v, 0.11);
}

/** Low rounded leaf bush — the anchor prop for meadow clumps. */
function bush(): Template {
  const v = new VoxelModel();
  v.ellipsoid(0, 1.1, 0, 2.6, 1.4, 2.4, 0x55b23f);
  v.ellipsoid(1.3, 1.6, 0.7, 1.5, 1.1, 1.4, 0x6cc84f);
  v.ellipsoid(-1.4, 1.4, -0.6, 1.4, 1, 1.3, 0x4aa63a);
  v.set(1, 3, 0, 0x86d868); // highlight sprig
  return bake(v, 0.13);
}

/** Weathered driftwood log for the beach transition band. */
function driftwood(): Template {
  const v = new VoxelModel();
  const wood = 0x9b8468;
  const woodL = 0xb09a7c;
  v.box(-3, 0, 0, 3, 0, 0, wood);
  v.box(-2, 1, 0, 1, 1, 0, woodL);
  v.set(4, 0, 0, shade(wood, 0.85)); // broken tip
  v.set(-4, 1, 0, woodL); // upturned root end
  v.set(1, 1, 1, shade(woodL, 0.92)); // branch stub
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
  v.ellipsoid(0, 2.2, 0, 3.4, 2.4, 2.8, 0x47962f);
  v.ellipsoid(2.6, 2.6, -1, 2.2, 1.9, 2, 0x53a838);
  v.ellipsoid(-2.4, 2, 1.2, 2, 1.7, 1.9, 0x3d8a2b);
  v.ellipsoid(0.4, 4.2, 0.2, 1.6, 1.1, 1.5, 0x63bd46);
  v.set(-1, 5, 1, 0x7ad155); // stray sprig breaks the dome
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
  v.ellipsoid(0, 1.3, 0, 1.8, 1.2, 1.6, 0x4d9c33);
  v.ellipsoid(1.2, 1.1, 0.6, 1.1, 0.9, 1, 0x5cae3d);
  v.ellipsoid(-1.1, 1, -0.5, 1, 0.8, 0.9, 0x43892c);
  v.set(0, 3, 0, 0x6fc44b); // sprig off the crown
  v.set(-1, 2, 1, 0x66bb44);
  return bake(v, 0.24);
}

/** Tiny shell/pebble dots scattered on the sand. */
function shells(): Template {
  const v = new VoxelModel();
  v.set(0, 0, 0, 0xf4ecd9);
  v.set(2, 0, 1, 0xe8d9be);
  v.set(-1, 0, 2, 0xfdf6e8);
  return bake(v, 0.09);
}

function mushroom(): Template {
  const v = new VoxelModel();
  v.box(0, 0, 0, 0, 2, 0, 0xe9e2d2);
  v.box(-1, 3, -1, 1, 3, 1, 0xd5483e);
  v.set(0, 4, 0, 0xe25a50);
  v.set(-1, 3, 0, 0xf2ece4);
  v.set(1, 3, -1, 0xf2ece4);
  return bake(v, 0.14);
}

// ---------------------------------------------------------------------------

export class PropLib {
  readonly solidMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  // Double-sided so crossed-quad grass billboards read from every angle.
  readonly softMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1.0, metalness: 0, side: THREE.DoubleSide });

  readonly oakA = oakTree(false);
  readonly oakB = oakTree(true);
  readonly oakC = oakTreeTall();
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
  readonly tuft = grassTuft(false);
  readonly tuftDry = grassTuft(true);
  // narrow blades — width is the HALF-width of a quad, so keep it small or
  // clusters render as pale slabs instead of grass
  readonly grassA = grassBillboard(0.05, 0.03, 0.46, 0.055);
  readonly grassB = grassBillboard(-0.08, 0.04, 0.58, 0.065);
  readonly grassC = grassBillboard(0.02, -0.06, 0.36, 0.045);
  // Dune grass for the grass/sand transition band — dropped to sit at/below
  // the sand's value instead of glowing off it.
  readonly grassDuneA = grassBillboard(0.06, 0.02, 0.5, 0.055, [0.52, 0.56, 0.28], [0.66, 0.70, 0.40]);
  readonly grassDuneB = grassBillboard(-0.05, -0.04, 0.4, 0.05, [0.52, 0.56, 0.28], [0.66, 0.70, 0.40]);
  readonly bushT = bush();
  readonly driftwoodT = driftwood();
  readonly logT = fallenLog();
  readonly hedgeT = hedgeClump();
  readonly hedgeSmallT = hedgeSmall();
  readonly shellT = shells();
  readonly flowerR = flower(0xef5d5d);
  readonly flowerY = flower(0xffd23f);
  readonly flowerP = flower(0xf08ac2);
  readonly flowerW = flower(0xf6f3ea);
  readonly flowerO = flower(0xff9a3d);

  dispose(): void {
    this.solidMat.dispose();
    this.softMat.dispose();
  }
}

const mushroomT = mushroom();

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

  // ---- tree pass: jittered grid keeps organic spacing ----------------------
  for (let gx = 0; gx < 6; gx++) {
    for (let gz = 0; gz < 6; gz++) {
      const lx = gx * 5 + Math.floor(rng() * 5);
      const lz = gz * 5 + Math.floor(rng() * 5);
      const roll = rng();
      const yaw = rng() * Math.PI * 2;
      const scl = 0.85 + rng() * 0.4;
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
        tpl = vroll < 0.28 ? lib.oakA : vroll < 0.5 ? lib.oakB : vroll < 0.7 ? lib.oakC : lib.birch;
      } else if (ci.biome === 'plains' && roll < 0.34) {
        tpl = vroll < 0.42 ? lib.oakA : vroll < 0.68 ? lib.oakC : lib.birch;
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

      const t = 0.92 + tintRoll * 0.16;
      solid.add(tpl, lx + 0.5 + jx * jitterMul, h - 0.05, lz + 0.5 + jz * jitterMul, yaw, scl, t, t * (0.97 + tintRoll * 0.05), t);
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
      solid.add(tpl, bx, ci.h + yOff, bz, rng() * Math.PI * 2,
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
        const rs = 1.8 + rng() * 0.8;
        solid.add(rk, mlx, h - 0.3, mlz, yaw, rs, t, t, t);
        const lang = yaw + 1.1 + rng() * 1.2;
        const lx2 = mlx + Math.cos(lang) * (1.4 + rng() * 0.9);
        const lz2 = mlz + Math.sin(lang) * (1.4 + rng() * 0.9);
        if (lx2 >= 0 && lz2 >= 0 && lx2 < CHUNK_SIZE && lz2 < CHUNK_SIZE) {
          terrain.columnInfo(ox + Math.floor(lx2), oz + Math.floor(lz2), ci);
          if (ci.h >= WATER_LEVEL + 1) {
            const lt = t * (0.95 + rng() * 0.1);
            solid.add(lib.logT, lx2, ci.h - 0.05, lz2, lang + Math.PI * 0.5,
              1.4 + rng() * 0.5, lt, lt * 0.98, lt * 0.92);
          }
        }
      } else if (kind < 0.64) {
        solid.add(lib.logT, mlx, h - 0.05, mlz, yaw, 0.9 + rng() * 0.5,
          t, t * 0.98, t * 0.94);
      } else if (kind < 0.84) {
        // knee-high hedges: the rung between grass and the tall clump
        stampKnot(lib.hedgeSmallT, mlx, mlz, 2 + Math.floor(rng() * 3), 1.5,
          0.85 + rng() * 0.2, 0.35, -0.06, t);
      } else {
        stampKnot(lib.hedgeT, mlx, mlz, 1 + Math.floor(rng() * 3), 1.5,
          0.95, 0.45, -0.08, t);
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
        solid.add(tpl, bx, ci.h - 0.3, bz, rng() * Math.PI * 2,
          1.4 + rng() * 0.8, bt, bt, bt);
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
  for (let k = 0; k < 90; k++) {
    const clx = 1 + rng() * (CHUNK_SIZE - 2);
    const clz = 1 + rng() * (CHUNK_SIZE - 2);
    const accept = rng();
    const wcx = ox + Math.floor(clx);
    const wcz = oz + Math.floor(clz);
    terrain.columnInfo(wcx, wcz, ci);
    const cb = ci.biome;
    if (cb !== 'plains' && cb !== 'forest') continue;
    if (accept > (cb === 'plains' ? 0.8 : 0.42)) continue;
    if (ci.h < WATER_LEVEL + 1) continue;
    // Grass and flowers are welcome on the doorstep — only the bush below,
    // which casts shadows and blocks the path, respects the den discs.
    if (exSoft(wcx + 0.5, wcz + 0.5)) continue;
    const isForest = cb === 'forest';
    // +-8% per-cluster value jitter so whole clumps read lighter or darker.
    const cj = 0.92 + rng() * 0.16;
    const members = 5 + Math.floor(rng() * 5); // 5-9 blades
    const grass = grasses[Math.floor(rng() * 2.999)];
    for (let m = 0; m < members; m++) {
      const ang = rng() * Math.PI * 2;
      const rad = 0.4 + rng() * 2.3;
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
        else if (roll < 0.245) soft.add(lib.tuft, x, h - 0.04, z, yaw, scl, t, t, t);
        else if (roll < 0.257 && !noSolid) solid.add(lib.rockA, x, h - 0.1, z, yaw, scl, t, t, t);
        break;
      case 'forest':
        if (roll < 0.1) soft.add(grass, x, h - 0.03, z, yaw, 0.5 + scl * 0.45, t * 0.86, t, t * 0.84);
        else if (roll < 0.127 && !noSolid) solid.add(mushroomT, x, h - 0.04, z, yaw, scl, t, t, t);
        else if (roll < 0.151 && !noSolid) solid.add(pick < 0.5 ? lib.rockA : lib.rockB, x, h - 0.1, z, yaw, scl, t, t, t);
        else if (roll < 0.24) soft.add(lib.tuft, x, h - 0.04, z, yaw, scl, t * 0.92, t, t * 0.92);
        break;
      case 'beach':
        if (roll < 0.064) soft.add(lib.tuftDry, x, h - 0.04, z, yaw, scl, t, t, t);
        else if (roll < 0.086 && !noSolid) solid.add(lib.rockA, x, h - 0.1, z, yaw, scl, t, t, t);
        break;
      case 'desert':
        if (roll < 0.031 && !noSolid) solid.add(lib.rockA, x, h - 0.1, z, yaw, scl, t * 1.05, t, t * 0.9);
        else if (roll < 0.082) soft.add(lib.tuftDry, x, h - 0.04, z, yaw, scl, t, t, t);
        else if (roll < 0.095 && !noSolid) solid.add(lib.cactusSmall, x, h - 0.04, z, yaw, scl, t, t, t);
        break;
      case 'snow':
        if (roll < 0.031 && !noSolid) solid.add(lib.rockSnow, x, h - 0.1, z, yaw, scl, t, t, t);
        break;
      case 'underwater':
        break;
    }
  }

  // ---- beach transition band -------------------------------------------------
  // Dresses the ~3-unit strip around the grass/sand boundary (hc 9.8..11.6):
  // pale dune grass creeping onto the sand, the odd driftwood log, and tiny
  // shell dots so the shoreline reads as a place instead of a hard color seam.
  for (let i = 0; i < 120; i++) {
    const lx = Math.floor(rng() * CHUNK_SIZE);
    const lz = Math.floor(rng() * CHUNK_SIZE);
    const roll = rng();
    const wx = ox + lx;
    const wz = oz + lz;
    terrain.columnInfo(wx, wz, ci);
    if (ci.h < WATER_LEVEL + 1) continue;
    if (ci.hc < 9.8 || ci.hc > 11.6) continue;
    if (ci.biome !== 'beach' && ci.biome !== 'plains') continue;
    if (exSoft(wx + 0.5, wz + 0.5)) continue;
    const x = lx + 0.5 + (rng() - 0.5) * 0.8;
    const z = lz + 0.5 + (rng() - 0.5) * 0.8;
    const yaw = rng() * Math.PI * 2;
    const t = 0.92 + rng() * 0.16;
    // Pale dune grass belongs on sand only — on the meadow it reads as bleached
    // debris scattered across the lawn.
    if (roll < 0.5 && ci.biome === 'beach') {
      const dune = rng() < 0.5 ? lib.grassDuneA : lib.grassDuneB;
      soft.add(dune, x, ci.h - 0.03, z, yaw, 0.7 + rng() * 0.5, t, t, t * 0.95);
    } else if (roll < 0.56 && ci.biome === 'beach' && !exSolid(wx + 0.5, wz + 0.5)
      && flatEnough(wx, wz, ci.h, 1)) {
      solid.add(lib.driftwoodT, x, ci.h - 0.02, z, yaw, 0.9 + rng() * 0.4, t, t, t);
    } else if (roll < 0.72 && ci.biome === 'beach') {
      soft.add(lib.shellT, x, ci.h - 0.02, z, yaw, 0.8 + rng() * 0.5, t, t, t);
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
