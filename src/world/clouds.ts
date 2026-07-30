/**
 * Sky ambience: drifting chunky voxel cumulus and a field of gently floating
 * light motes near the ground.
 *
 * The cumulus deck deliberately casts NO shadows. It used to, and a voxel cloud
 * is a hard-edged convex slab the size of a small hill: dropped onto flat sand
 * from a 4096 shadow map it printed a huge black quadrilateral with razor edges
 * (nothing else in frame had a shadow remotely like it), and a single cloud
 * drifting over the camera dumped the whole visible hillside — trees, props,
 * pals — into hemisphere-only light, i.e. near-black. Cube World's ground read
 * comes from object shadows on a fully sunlit landscape; the sky does not touch
 * it. Dropping the cast also halves what the shadow pass has to draw.
 */
import * as THREE from 'three';
import { VoxelModel } from '../core/voxel';
import { mulberry32 } from './noise';

/**
 * Half-extent of the wrapping cloud field, per altitude band.
 *
 * The deck used to stop at 190 units, and at ~100 units up that puts its lowest
 * edge about 28 degrees above the horizon — so every sky shot had a bare band of
 * gradient between the ridgeline and the nearest cloud, which is the "they stop
 * dead at y=600 leaving an empty band above the horizon" finding. Carrying the
 * field out to 330 drops that edge to 17 degrees and closes the gap; past ~360
 * the scene's linear fog (150..420) has faded a cloud to pure haze colour, so
 * there is nothing to gain by going further.
 */
const BAND_WRAP = [165, 235, 305];
/** Base altitude of each band, and its random span. */
const BAND_Y = [80, 104, 120];
const BAND_SPAN = [16, 20, 22];
/**
 * Instance scale per band. The far band is scaled up hard: at 300 units the
 * scene's linear fog has already blended it ~55% into the haze colour, so a
 * small shape there is a faint smudge, while a big one reads as a proper hazy
 * distant cloud — which is what closes the empty band above the horizon.
 */
const BAND_SCALE = [1.05, 1.5, 2.4];

/** Condensation level: every boll is clipped flat at this voxel row. */
const BASE_Y = 4;

/**
 * One cumulus geometry, in five passes.
 *
 *   1. body bolls along a gently curved long axis, fattest in the middle, plus
 *      crown turrets boiling off the tallest bolls (the cauliflower read);
 *   2. a morphological cull — see below — that removes the spiky rind;
 *   3. a concavity fill that closes the 1-voxel pits the cull opens;
 *   4. a domed underside so the cloud is not a pancake;
 *   5. a top/bottom repaint, because most of a cloud's screen area is side
 *      faces and face shading alone cannot tell a crown from a belly.
 *
 * Passes 2-4 need to DELETE and QUERY voxels, and VoxelModel is append-only, so
 * the volume is rasterised into a flat Uint8Array first and only painted into a
 * VoxelModel once its shape is final.
 */
function cloudGeo(variant: number, seed: number, high = false): THREE.BufferGeometry {
  const rng = mulberry32((seed ^ 0xc10d) + variant * 977 + (high ? 40503 : 0));
  // R is in VOXELS, and it is deliberately small. The volume used to be
  // rasterised at R = 6.5..9 and then drawn at 0.72 units per voxel, which put
  // roughly 15 voxels across a cloud — fine enough that the ellipsoid
  // rasterisation staircase became visible as 1-voxel terraces all over the
  // surface, i.e. the "crumpled tinfoil" read, and finer-grained than the terrain
  // it floats over. Rasterising the same world-space volume at 4-6 voxels and
  // drawing each voxel at ~2 units gives a cloud built of blocks BIGGER than a
  // terrain block: chunky, few terraces, unmistakably the same art language as
  // the ground.
  const R = high ? 4.0 + rng() * 1.2 : 4.2 + rng() * 1.5;
  const crowns: Array<[number, number, number, number]> = [];

  // Grid extents: the outermost base lobe centre reaches ~0.6R and its radius
  // ~0.7R, so 2R + slack covers every variant at R <= 9. HGT has to hold a full
  // vertical stack, which is roughly 3R tall.
  const LIM = 26;
  const HGT = 40;
  const W = LIM * 2 + 1;
  const vol = new Uint8Array(W * W * HGT);
  const inb = (x: number, y: number, z: number): boolean =>
    x >= -LIM && x <= LIM && z >= -LIM && z <= LIM && y >= 0 && y < HGT;
  const at = (x: number, y: number, z: number): number => (y * W + (x + LIM)) * W + (z + LIM);
  const get = (x: number, y: number, z: number): number => (inb(x, y, z) ? vol[at(x, y, z)] : 0);
  const put = (x: number, y: number, z: number): void => { if (inb(x, y, z)) vol[at(x, y, z)] = 1; };

  /**
   * Ellipsoid painter that CLIPS below `yMin`. Clipping (rather than letting the
   * dome close underneath) gives a cumulus its defined condensation level; pass
   * 4 then bulges the result back into a dome, which is what a real cloud base
   * does — flat-ish at the rim, sagging in the middle.
   */
  const lobe = (
    cx: number, cy: number, cz: number,
    rx: number, ry: number, rz: number,
  ): void => {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++)
      for (let y = Math.max(BASE_Y, Math.floor(cy - ry)); y <= Math.ceil(cy + ry); y++)
        for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++) {
          const dx = (x - cx) / rx, dy = (y - cy) / ry, dz = (z - cz) / rz;
          if (dx * dx + dy * dy + dz * dz <= 1.0) put(x, y, z);
        }
  };

  // ---- pass 1: a STACK, not a row ------------------------------------------
  // The lobes used to be laid out along a horizontal long axis (`cx` swept over
  // 1.75R) with nothing above them, and that is a pancake by construction: every
  // puff came out flat-bottomed, wider than tall and with no vertical
  // development at all. A cumulus is the opposite — a broad condensation
  // footprint with a tower of progressively smaller bolls piled on top of it,
  // and it is that tower that gives a real cloud its lit crown, its shaded
  // flank, and a silhouette you can read as a volume from the ground.
  //
  // So: 2-3 wide, shallow lobes make the footprint, then a vertical stack of
  // shrinking lobes rises out of the fattest one, then turrets boil off the top.
  const baseN = 3;
  const rBase = R * (0.62 + rng() * 0.14);
  let fatX = 0;
  let fatZ = 0;
  let fatR = 0;
  let fatTop = BASE_Y;
  for (let b = 0; b < baseN; b++) {
    const a = (b / baseN) * Math.PI * 2 + rng() * 0.9;
    const rad = b === 0 ? 0 : rBase * (0.40 + rng() * 0.35);
    const cx = Math.cos(a) * rad;
    const cz = Math.sin(a) * rad;
    const rx = rBase * (0.82 + rng() * 0.26);
    // Every lobe stays inside 1.6:1 in plan so nothing reads as a contrail.
    const rz = Math.max(rx / 1.6, rx * (0.82 + rng() * 0.28));
    // Base lobes ARE wider than tall — that is correct for the condensation
    // shelf. The vertical read comes from the stack above, not from here.
    const ry = rx * (0.58 + rng() * 0.16);
    // Centre sits above the clip so ~30% of each boll is cut away flat.
    const cy = BASE_Y + ry * 0.70;
    lobe(cx, cy, cz, rx, ry, rz);
    if (rx > fatR) { fatR = rx; fatX = cx; fatZ = cz; fatTop = cy + ry; }
  }
  // The tower, kept DELIBERATELY SHORT and fat. The first attempt at this shrank
  // each storey to 70% and overlapped it by only a third of its height, and the
  // result was a field of stalagmites: three or four narrow storeys stacked into a
  // spire, with the smallest lobes too few voxels across to voxelise into anything
  // but prongs. One or two storeys at 84%, sunk so they overlap by 60% of their
  // own height, gives a mass that bulges upward — a cumulus, not a spike.
  const stackN = high ? 1 : 1 + (variant % 2);
  let sr = fatR * 0.84;
  let sy = fatTop;
  for (let k = 0; k < stackN; k++) {
    const ry = sr * (0.74 + rng() * 0.18);
    const cy = sy - ry * 0.60 + ry;
    const cx = fatX + (rng() - 0.5) * sr * 0.45;
    const cz = fatZ + (rng() - 0.5) * sr * 0.45;
    lobe(cx, cy, cz, sr, ry, sr * (0.88 + rng() * 0.2));
    crowns.push([cx, cy + ry * 0.35, cz, sr]);
    sy = cy + ry;
    sr *= 0.84;
  }

  // One turret, and a FAT one (55-80% of the boll it grows from, not 44-70%):
  // a small turret on a small crown is a prong, and prongs are what the whole
  // rebuild was trying to get rid of.
  {
    const [bx, by, bz, br] = crowns[Math.floor(rng() * crowns.length)];
    const tr = br * (0.55 + rng() * 0.25);
    lobe(
      bx + (rng() - 0.5) * br * 0.5, by + tr * 0.2, bz + (rng() - 0.5) * br * 0.4,
      tr, tr * (0.75 + rng() * 0.25), tr * (0.88 + rng() * 0.22),
    );
  }

  // ---- passes 2 & 3: morphological open, twice ------------------------------
  // Rasterising an ellipsoid leaves a shell of voxels hanging off the surface by
  // one or two faces, and stacking seven overlapping lobes multiplies them. From
  // the ground that rind read as a chaotic forest of one-voxel vertical fins and
  // prongs — the cloud tops looked like eroded coral, and detached fragments
  // floated beside the mass like glass shards.
  //
  // ERODE: anything with fewer than four of its six face-neighbours solid is a
  // fin, a prong or a shard by definition. DILATE: any empty cell with four or
  // more solid neighbours is a notch or a pit, and filling it cannot grow the
  // silhouette (a cell outside a convex corner has at most three).
  //
  // The pair runs TWICE because one pass is not a fixed point: removing a fin
  // exposes the ridge it stood on, and a single open still left visible 1-voxel
  // scratches and dark 1-voxel dents scattered over the cloud faces at close
  // range. Two iterations converge to a smooth mass. Each sweep reads a snapshot
  // so it is order-independent; an in-place erosion would cascade and eat the
  // whole cloud.
  // THREE iterations, not two. At the coarser voxel resolution the volume now uses,
  // each surviving prong is a bigger fraction of the silhouette, so it is worth one
  // more sweep; the pair converges by the third pass and further passes are no-ops.
  const snap = new Uint8Array(vol.length);
  for (let it = 0; it < 3; it++) {
    snap.set(vol);
    const snapGet = (x: number, y: number, z: number): number =>
      (inb(x, y, z) ? snap[at(x, y, z)] : 0);
    for (let y = 0; y < HGT; y++)
      for (let x = -LIM; x <= LIM; x++)
        for (let z = -LIM; z <= LIM; z++) {
          if (!snap[at(x, y, z)]) continue;
          const n =
            snapGet(x + 1, y, z) + snapGet(x - 1, y, z) +
            snapGet(x, y, z + 1) + snapGet(x, y, z - 1) +
            snapGet(x, y + 1, z) + (y <= BASE_Y ? 1 : snapGet(x, y - 1, z));
          if (n < 4) vol[at(x, y, z)] = 0;
        }
    snap.set(vol);
    for (let y = BASE_Y; y < HGT; y++)
      for (let x = -LIM; x <= LIM; x++)
        for (let z = -LIM; z <= LIM; z++) {
          if (snap[at(x, y, z)]) continue;
          const n =
            snapGet(x + 1, y, z) + snapGet(x - 1, y, z) +
            snapGet(x, y, z + 1) + snapGet(x, y, z - 1) +
            snapGet(x, y + 1, z) + (y <= BASE_Y ? 1 : snapGet(x, y - 1, z));
          if (n >= 4) vol[at(x, y, z)] = 1;
        }
  }

  // ---- pass 4: dome the underside ------------------------------------------
  // A cloud clipped flat at one row is a spiky-topped pancake from below, which
  // is the only angle a player ever sees it from. Hanging each column down by an
  // amount proportional to how thick the cloud is above it turns the base into a
  // sagging dome: deep in the middle of the mass, feathering to nothing at the
  // rim, exactly the way convection stacks water vapour.
  let topMax = BASE_Y;
  const colTop = new Int8Array(W * W);
  for (let x = -LIM; x <= LIM; x++)
    for (let z = -LIM; z <= LIM; z++) {
      let hi = -1;
      for (let y = HGT - 1; y >= BASE_Y; y--) if (vol[at(x, y, z)]) { hi = y; break; }
      colTop[(x + LIM) * W + (z + LIM)] = hi;
      if (hi > topMax) topMax = hi;
    }
  const span = Math.max(1, topMax - BASE_Y);
  // Continuous drop depth per column, sqrt so the dome is round not conical.
  const dropF = new Float32Array(W * W);
  for (let x = -LIM; x <= LIM; x++)
    for (let z = -LIM; z <= LIM; z++) {
      const hi = colTop[(x + LIM) * W + (z + LIM)];
      // Shallow on purpose. Each extra voxel of drop is another 1-voxel terrace on
      // the base, and a terrace's SIDE face (0.88 in VoxelModel's face table) is
      // 40% brighter than the BOTTOM faces either side of it (0.62) — so from
      // below, every step shows as a bright vertical sliver. Two or three steps
      // read as a sagging base; five read as a corrugated one.
      dropF[(x + LIM) * W + (z + LIM)] =
        hi < BASE_Y ? 0 : 1 + 2.1 * Math.sqrt((hi - BASE_Y) / span);
    }
  // Smooth the depth field before rounding it to voxels. The cloud's TOP is a
  // rough surface (the morphological open above leaves neighbouring columns
  // differing by a voxel or two), so a drop derived straight from it inherits that
  // roughness — and the underside is the one surface a player always looks at.
  // Unsmoothed, adjacent columns dropped by different amounts and the base grew a
  // corrugation of vertical fins that read, from below, exactly like the spikes
  // this whole rebuild set out to remove.
  const sm = new Float32Array(W * W);
  for (let pass = 0; pass < 3; pass++) {
    for (let ax = 1; ax < W - 1; ax++)
      for (let az = 1; az < W - 1; az++) {
        const i = ax * W + az;
        sm[i] = (dropF[i - W] + dropF[i - 1] + dropF[i] * 2 + dropF[i + 1] + dropF[i + W]) / 6;
      }
    dropF.set(sm);
  }
  for (let x = -LIM; x <= LIM; x++)
    for (let z = -LIM; z <= LIM; z++) {
      if (colTop[(x + LIM) * W + (z + LIM)] < BASE_Y) continue;
      const drop = Math.max(1, Math.round(dropF[(x + LIM) * W + (z + LIM)]));
      for (let d = 1; d <= drop; d++) put(x, BASE_Y - d, z);
    }

  // ---- pass 5: paint ---------------------------------------------------------
  // Near-white body, a cool blue-grey belly that darkens with every row down,
  // and a brighter cap on the top two rows of each column. The horizontal
  // sun/shade split is deliberately NOT baked: instances are randomly yawed, so
  // a baked flank would rotate away from the sun. MeshStandardMaterial's own
  // N.L does it correctly for every instance instead (see the emissive note on
  // the material — it is kept low so that flank gradient survives).
  const v = new VoxelModel();
  // The lit/shaded split is MUCH wider than it was. At 0xf4f7fb over
  // 0xd6e0ec..0x9aadc4 the sunlit body and the belly were within about 20% of
  // each other in value, and the sky read as a field of uniform grey popcorn
  // because nothing said which way the light came from. Cube World's cumulus are
  // near-white on top and a clearly cool blue-grey underneath — roughly a 2:1
  // value ratio — and the body is warmed slightly so the top reads as SUNLIGHT
  // rather than as paper.
  const BODY = 0xfdfbf2;
  const BELLY = [0xc9d6e8, 0xaebfd6, 0x9aadc8, 0x8aa0be, 0x7d94b4];
  for (let y = 0; y < HGT; y++)
    for (let x = -LIM; x <= LIM; x++)
      for (let z = -LIM; z <= LIM; z++) {
        if (!vol[at(x, y, z)]) continue;
        if (y < BASE_Y) v.set(x, y, z, BELLY[Math.min(BASE_Y - 1 - y, BELLY.length - 1)]);
        else v.set(x, y, z, BODY);
      }
  // The bright cap goes on the topmost voxel of each column, but ONLY where that
  // column is part of a roughly horizontal shelf.
  //
  // Ungated, "topmost voxel of the column" also picks out one voxel on every
  // near-vertical FLANK, and since consecutive flank columns step up by one, the
  // caps line up into thin bright vertical streaks running down the side of the
  // cloud — they read as scratches, not as sunlight. Requiring three of the four
  // lateral neighbours to have their own top within one voxel excludes flanks
  // (where neighbouring tops differ by two or more) and keeps the crowns.
  const top = new Int8Array(W * W).fill(-1);
  for (let x = -LIM; x <= LIM; x++)
    for (let z = -LIM; z <= LIM; z++)
      for (let y = HGT - 1; y >= BASE_Y; y--)
        if (vol[at(x, y, z)]) { top[(x + LIM) * W + (z + LIM)] = y; break; }
  const topAt = (x: number, z: number): number =>
    (x >= -LIM && x <= LIM && z >= -LIM && z <= LIM ? top[(x + LIM) * W + (z + LIM)] : -1);
  for (let x = -LIM; x <= LIM; x++)
    for (let z = -LIM; z <= LIM; z++) {
      const hi = topAt(x, z);
      if (hi < BASE_Y + 2) continue;
      let level = 0;
      if (Math.abs(topAt(x + 1, z) - hi) <= 1) level++;
      if (Math.abs(topAt(x - 1, z) - hi) <= 1) level++;
      if (Math.abs(topAt(x, z + 1) - hi) <= 1) level++;
      if (Math.abs(topAt(x, z - 1) - hi) <= 1) level++;
      if (level < 3) continue;
      v.set(x, hi, z, 0xfffdf6);
      v.set(x, hi - 1, z, 0xfefaee);
    }

  // ~2 world units per cloud voxel — twice a terrain block. One art rule for the
  // whole world: nothing in the sky is finer-grained than the ground.
  const mesh = v.build(high ? 1.9 : 2.05, true);
  const g = mesh.geometry;
  (mesh.material as THREE.Material).dispose();
  return g;
}

interface CloudItem {
  x: number;
  y: number;
  z: number;
  rot: number;
  sx: number;
  sy: number;
  vx: number;
  vz: number;
  /** Per-INSTANCE wrap half-extent: bands wrap at different radii. */
  wrap: number;
}

interface Deck {
  mesh: THREE.InstancedMesh;
  items: CloudItem[];
}

const tmpMat = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const yAxis = new THREE.Vector3(0, 1, 0);

export class Clouds {
  readonly group = new THREE.Group();
  private readonly decks: Deck[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mat: THREE.MeshStandardMaterial;

  constructor(seed: number) {
    // ONE material for both decks. The high deck used to be translucent at
    // opacity 0.5, and squashed to half height on top of that: the result was a
    // scatter of flat semi-transparent slabs that read as glass shards floating
    // between the real clouds, and no two blobs in the sky shared an alpha.
    // Opaque everywhere, with distance fog doing the fading, is both cheaper and
    // the only way the deck reads as one weather system.
    this.mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      // Ambient floor for the flank that faces away from the sun. The sun is
      // steep (0.34, 0.91, 0.23), so an away-facing vertical cloud face gets
      // nothing but the hemisphere fill and lands near mid-grey without this.
      // The value is chosen to bring that flank to roughly #c2ccd8 — a cool
      // blue-grey, clearly darker than the sunward side — and no higher,
      // because emissive floods every face equally and each point of it eats
      // into the sun/shade split that gives the puffs their volume.
      emissive: 0xdfeaf7,
      emissiveIntensity: 0.17,
      fog: true, // distance haze fades the deck into the sky
    });
    for (let i = 0; i < 4; i++) this.geos.push(cloudGeo(i, seed));
    for (let i = 0; i < 2; i++) this.geos.push(cloudGeo(i, seed, true));
    const rng = mulberry32(seed ^ 0x5eed);

    // ---- placement: clusters in three bands, not a polka-dot field ----------
    //
    // Every instance used to be an independent uniform sample inside one square,
    // and a uniform sample of ~18 similar shapes at ONE altitude is a polka-dot
    // field: evenly spaced, no grouping, no depth. Real cumulus arrive in
    // clusters with wide clear sky between them, and the clusters sit at
    // different heights — which is where a sky gets its depth from.
    //
    // So the field is generated CLUSTER-first: 22 cluster centres are drawn with
    // a Poisson-ish dart throw (reject anything too close to an accepted centre,
    // give up after a few tries rather than loop forever), each is assigned a
    // band, and 3-5 puffs are scattered tightly around it. Which silhouette each
    // puff uses is chosen last, so one cluster mixes variants — a cluster of four
    // copies of one shape reads as a stamp.
    const slots: CloudItem[][] = this.geos.map(() => []);
    const centres: Array<[number, number, number]> = []; // x, z, band
    // 34 clusters x 3-5 puffs ~= 130 instances, still over the same six instanced
    // batches, so the whole sky costs six draw calls regardless. 22 clusters left
    // roughly seven per band, which is few enough that a given view direction
    // could legitimately contain none and the sky read as empty.
    const CLUSTERS = 34;
    for (let c = 0; c < CLUSTERS; c++) {
      // Bands are weighted toward the two outer ones: they cover far more solid
      // angle, and the near band is what fills the frame when the camera tilts up.
      const band = c % 3;
      const wrap = BAND_WRAP[band];
      let cxp = 0;
      let czp = 0;
      // Dart throw. The separation is a bit under the mean spacing so most darts
      // land first try; the loop is bounded so worst case it just accepts one.
      const sep2 = (wrap * 0.42) * (wrap * 0.42);
      for (let attempt = 0; attempt < 8; attempt++) {
        cxp = (rng() - 0.5) * 2 * wrap;
        czp = (rng() - 0.5) * 2 * wrap;
        let ok = true;
        for (const [ox2, oz2, ob] of centres) {
          if (ob !== band) continue;
          const dx = ox2 - cxp;
          const dz = oz2 - czp;
          if (dx * dx + dz * dz < sep2) { ok = false; break; }
        }
        if (ok) break;
      }
      centres.push([cxp, czp, band]);

      const members = 3 + Math.floor(rng() * 3);
      const spread = BAND_WRAP[band] * 0.10;
      // One drift velocity per cluster: a cluster whose members separate over a
      // minute is not a cluster.
      const vx = (1.3 + rng() * 1.0) * (band === 0 ? 1 : band === 1 ? 0.75 : 0.5);
      const vz = (0.3 + rng() * 0.5) * (band === 0 ? 1 : 0.6);
      for (let m = 0; m < members; m++) {
        const ang = rng() * Math.PI * 2;
        const rad = m === 0 ? 0 : spread * (0.4 + rng());
        const sx = BAND_SCALE[band] * (0.78 + rng() * 0.62);
        const it: CloudItem = {
          x: cxp + Math.cos(ang) * rad,
          y: BAND_Y[band] + rng() * BAND_SPAN[band],
          z: czp + Math.sin(ang) * rad,
          rot: rng() * Math.PI * 2,
          sx,
          // Vertical scale varies independently — the shape already carries its
          // own vertical development, so this only needs to keep two neighbouring
          // puffs from being the same proportion.
          sy: sx * (0.82 + rng() * 0.28),
          vx,
          vz,
          wrap,
        };
        // Far bands use the two "high" geometries (fewer turrets, calmer
        // profile); near bands use the four full ones. Same generator either way
        // so there is exactly one voxel scale in the sky.
        const gi = band === 2
          ? 4 + Math.floor(rng() * 1.999)
          : Math.floor(rng() * 3.999);
        slots[gi].push(it);
      }
    }

    // One InstancedMesh per silhouette variant. This used to be 104 separate
    // Meshes = 104 draw calls; six instanced batches draw the same sky and leave
    // the budget for ground detail, which is where a player actually looks.
    for (let g = 0; g < this.geos.length; g++) {
      const items = slots[g];
      if (items.length === 0) continue;
      const mesh = new THREE.InstancedMesh(this.geos[g], this.mat, items.length);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // Clouds surround the camera and wrap around it, so they are effectively
      // always on screen; culling a whole deck by its (stale, instance-space)
      // bounding sphere would pop the sky in and out.
      mesh.frustumCulled = false;
      this.decks.push({ mesh, items });
      this.group.add(mesh);
    }

    this.writeMatrices();
  }

  private writeMatrices(): void {
    for (const deck of this.decks) {
      for (let i = 0; i < deck.items.length; i++) {
        const it = deck.items[i];
        tmpPos.set(it.x, it.y, it.z);
        tmpQuat.setFromAxisAngle(yAxis, it.rot);
        tmpScale.set(it.sx, it.sy, it.sx);
        deck.mesh.setMatrixAt(i, tmpMat.compose(tmpPos, tmpQuat, tmpScale));
      }
      deck.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  update(focus: THREE.Vector3, dt: number): void {
    for (const deck of this.decks) {
      for (const it of deck.items) {
        const w = it.wrap;
        it.x += it.vx * dt;
        it.z += it.vz * dt;
        if (it.x - focus.x > w) it.x -= w * 2;
        else if (it.x - focus.x < -w) it.x += w * 2;
        if (it.z - focus.z > w) it.z -= w * 2;
        else if (it.z - focus.z < -w) it.z += w * 2;
      }
    }
    this.writeMatrices();
  }

  dispose(): void {
    for (const deck of this.decks) deck.mesh.dispose();
    for (const g of this.geos) g.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------------------
// Floating light motes
// ---------------------------------------------------------------------------

const MOTE_VERT = /* glsl */ `
uniform float uTime;
attribute float aPhase;
attribute float aSize;
varying float vA;
void main() {
  vec3 p = position;
  p.x += sin(uTime * 0.35 + aPhase) * 1.6;
  p.y += sin(uTime * 0.5 + aPhase * 1.7) * 0.9;
  p.z += cos(uTime * 0.28 + aPhase * 0.6) * 1.6;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = max(1.0, -mv.z);
  // Perspective size, CAPPED. Uncapped, 90/dist grows without limit: a mote that
  // drifted within 3 units of the camera became a 240-pixel additive disc, and
  // those showed up in gameplay frames as soft pale washes floating over the near
  // ground that read as lens smudges or fog blobs, not as motes.
  gl_PointSize = min(aSize * (90.0 / dist), 26.0);
  // Fully faded beyond 20 units so motes never read as lens dirt at range, and
  // faded out again inside 2.5 units so one drifting through the camera plane
  // cannot wash out a quarter of the frame.
  vA = (0.55 + 0.45 * sin(uTime * 1.4 + aPhase * 2.3))
     * smoothstep(20.0, 8.0, dist) * smoothstep(1.6, 3.2, dist);
  gl_Position = projectionMatrix * mv;
}
`;

const MOTE_FRAG = /* glsl */ `
varying float vA;
void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  float a = smoothstep(0.5, 0.08, d) * vA * 0.14;
  gl_FragColor = vec4(1.0, 0.86, 0.55, a); // warm gold only
}
`;

const tmpFocus = new THREE.Vector3();

export class Motes {
  readonly points: THREE.Points;
  private readonly mat: THREE.ShaderMaterial;
  private readonly geo: THREE.BufferGeometry;

  constructor(seed: number) {
    const rng = mulberry32(seed ^ 0x307e5);
    const N = 90;
    const pos = new Float32Array(N * 3);
    const phase = new Float32Array(N);
    const size = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      // Tight, low field: motes hug the ground (max y ~2.4 incl. bob).
      pos[i * 3] = (rng() - 0.5) * 44;
      pos[i * 3 + 1] = 0.4 + rng() * 1.1;
      pos[i * 3 + 2] = (rng() - 0.5) * 44;
      phase[i] = rng() * Math.PI * 2;
      size[i] = 3 + rng() * 5;
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
  }

  update(focus: THREE.Vector3, time: number, dt: number): void {
    this.mat.uniforms['uTime'].value = time;
    tmpFocus.set(focus.x, focus.y - 2, focus.z);
    const k = 1 - Math.exp(-dt * 1.5);
    this.points.position.lerp(tmpFocus, k);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
