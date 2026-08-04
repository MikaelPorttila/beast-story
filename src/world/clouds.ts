/**
 * Sky ambience: drifting chunky voxel cumulus.
 *
 * There USED to be a second element here — `Motes`, a field of 90 additive
 * warm-gold points that hugged the ground and followed the camera focus. It was
 * removed: a mote field that travels with you is not scenery, it is something
 * stuck to the lens, and at 0.4-1.5 units off the ground it read as flying
 * specks in front of the frame rather than as air in the world. The cumulus
 * deck is the whole of this file now, and `flags.clouds` / the F3 row switch
 * exactly that.
 *
 * The cumulus deck deliberately casts NO shadows. It used to, and a voxel cloud
 * is a hard-edged convex slab the size of a small hill: dropped onto flat sand
 * from a 4096 shadow map it printed a huge black quadrilateral with razor edges
 * (nothing else in frame had a shadow remotely like it), and a single cloud
 * drifting over the camera dumped the whole visible hillside — trees, props,
 * beasts — into hemisphere-only light, i.e. near-black. Cube World's ground read
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
const BAND_WRAP = [165, 235, 305, 360];
/**
 * Base altitude of each band, and its random span.
 *
 * Band 3 is the HORIZON band, and it is the one that makes a sky read as
 * weather rather than as decoration. Bands 0-2 sit 80-142 units up inside a
 * field that wraps at 305, so from a camera at eye level the lowest cloud in the
 * sky is 19 degrees above the horizon — and _veg-a-forest.png (camera 16 units
 * up, looking level) is the result: a vast empty blue field with two cloud
 * fragments clipped by the top of the frame. Everything a player actually looks
 * at while walking around is below that 19-degree line.
 *
 * Band 3 is far (360) and LOW (58-70), which puts it 6-10 degrees up: a row of
 * cumulus sitting on the ridgeline, seen in PROFILE rather than from underneath,
 * which is also the only angle from which the towers built by `cloudGeo` are
 * visible at all. The scene's linear fog (150..420) has blended it ~78% into the
 * sky by then, and that is correct rather than a loss — a distant cumulus is a
 * low-contrast pale shape against a pale horizon, and the aerial-perspective
 * patch makes it take the sky's own colour in that direction.
 *
 * `VoxelModel.build` puts y = 0 at the model's LOWEST voxel, so these are the
 * altitude of a puff's underside and `sy` only ever grows it upward. `BAND_SPAN`
 * is now the spread between one CLUSTER and the next rather than between one
 * puff and its neighbour — see the condensation-level note in the placement
 * loop — so it is trimmed ~12% to keep the same overall band thickness once the
 * clusters no longer scatter internally as well.
 */
const BAND_Y = [80, 104, 120, 96];
const BAND_SPAN = [14, 18, 20, 12];
/**
 * Instance scale per band. The far bands are scaled up hard: at 300 units the
 * scene's linear fog has already blended it ~55% into the haze colour, so a
 * small shape there is a faint smudge, while a big one reads as a proper hazy
 * distant cloud — which is what closes the empty band above the horizon.
 */
const BAND_SCALE = [1.05, 1.5, 2.4, 1.7];

/**
 * The horizon band's altitude and scale AT THE WRAP EDGE. Between the focus and
 * the edge an instance is linearly interpolated from `BAND_Y[3]`/`BAND_SCALE[3]`
 * to these, by its current distance from the focus.
 *
 * Why interpolate at all: a real cumulus deck is one altitude, and distant
 * clouds appear near the horizon purely through perspective — at 100 units up
 * you need 570 units of ground distance to reach 10 degrees of elevation, and
 * the scene's linear fog (150..420) has erased anything that far. So the deck
 * has to be faked low. Faking it low as a FLAT band does not work: the field
 * wraps cartesianly around the focus, so roughly a tenth of the band is inside
 * 120 units at any moment, and a 3.1x instance at 58 units up is a 90-unit white
 * slab hanging directly over the player — captured in _veg-b-forest.png, where
 * it read as a floating island, not as weather.
 *
 * Grading by distance gives both: far instances sit 54 units up at 3.2x, i.e. 6
 * degrees above the horizon and big enough to survive 80% haze, while anything
 * that drifts near rises and shrinks to ordinary near-band proportions. The
 * drift is ~0.5 units/s over a 360-unit half-extent, so an instance takes about
 * twelve minutes to cross the field and the altitude change is invisible.
 */
const HORIZON_Y_FAR = 54;
const HORIZON_SCALE_FAR = 2.6;
/**
 * Extra vertical squash applied to the horizon band as it recedes.
 *
 * A cumulus row on a distant skyline reads WIDE, and the reason is not the
 * cloud's own shape: you are looking at it from level, so its width subtends its
 * full extent while its height is foreshortened by nothing and simply loses to
 * the width of a deck ten kilometres across. At 2.6x an un-squashed shape stood
 * 125 units tall on the horizon and read as a white cliff. 0.78 restores the
 * proportion without touching the geometry the near bands share.
 */
const HORIZON_FLATTEN = 0.78;

/**
 * How far above or below a keep-out's centre a puff has to be to be left alone.
 *
 * The island's own vertical extent is a 27-unit keel under a 5-unit dome, and a
 * cumulus is 10-25 units tall, so anything whose base is inside ~30 of the deck
 * can genuinely intersect it. Past that the two simply pass each other.
 */
const KEEP_OUT_RISE = 30;

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
  // One or two storeys, and NOT always two. Forcing two (plus a gentler 0.86
  // taper) was tried and reverted: _veg-c-sky.png came out as a field of chunky
  // white cliffs taller than they were wide, and at the horizon band's 3.2x that
  // became 150-unit vertical columns hanging in the haze. Fair-weather cumulus
  // are broader than they are tall; the vertical read has to come from the
  // turrets and the domed base, not from stacking storeys.
  const stackN = high ? 1 : 1 + (variant % 2);
  let sr = fatR * 0.85;
  let sy = fatTop;
  for (let k = 0; k < stackN; k++) {
    const ry = sr * (0.74 + rng() * 0.18);
    const cy = sy - ry * 0.60 + ry;
    const cx = fatX + (rng() - 0.5) * sr * 0.45;
    const cz = fatZ + (rng() - 0.5) * sr * 0.45;
    lobe(cx, cy, cz, sr, ry, sr * (0.88 + rng() * 0.2));
    crowns.push([cx, cy + ry * 0.35, cz, sr]);
    sy = cy + ry;
    sr *= 0.85;
  }

  // One or two turrets, and FAT ones (55-80% of the boll they grow from, not
  // 44-70%): a small turret on a small crown is a prong, and prongs are what the
  // whole rebuild was trying to get rid of. The second turret exists because one
  // bump on one crown is a bump — two boiling off the same mass at different
  // heights is the cauliflower read a cumulus needs, and it only shows in
  // profile, which is exactly the view the horizon band added.
  const turrets = 1 + (variant % 2);
  for (let t = 0; t < turrets; t++) {
    const [bx, by, bz, br] = crowns[Math.floor(rng() * crowns.length)];
    const tr = br * (0.55 + rng() * 0.25);
    lobe(
      bx + (rng() - 0.5) * br * 0.6, by + tr * (0.2 + t * 0.26),
      bz + (rng() - 0.5) * br * 0.5,
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
  /**
   * Altitude of this puff's underside. `VoxelModel.build` datums the geometry at
   * its lowest voxel, so this is both the instance origin and the height a
   * cluster's members have to agree on — see the placement loop.
   */
  base: number;
  z: number;
  rot: number;
  sx: number;
  sy: number;
  vx: number;
  vz: number;
  /** Per-INSTANCE wrap half-extent: bands wrap at different radii. */
  wrap: number;
  /** Horizon band only: altitude and scale reached at the wrap edge. */
  graded: boolean;
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
    // 46 clusters x 3-5 puffs ~= 180 instances over four bands, still over the
    // same six instanced batches, so the whole sky costs six draw calls
    // regardless. Up from 34 over three bands because the fourth band is the
    // horizon one, and a horizon band with only a dozen clusters spread over a
    // 360-unit wrap leaves most bearings with a bare skyline.
    const CLUSTERS = 46;
    for (let c = 0; c < CLUSTERS; c++) {
      // Bands are weighted toward the outer ones: they cover far more solid
      // angle, and the near band is what fills the frame when the camera tilts up.
      const band = c % 4;
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
      // 0.10 -> 0.16 of the band's wrap radius. At 0.10 a band-0 cluster packed
      // three to five puffs, each ~20 units across, into a 16-unit disc, and
      // once the shared condensation level below welded their undersides into
      // one plane the group stopped reading as a cluster of clouds and started
      // reading as a single 45-unit raft — a floating island, which is the exact
      // failure the horizon band was already re-tuned once to avoid. Widening it
      // leaves the members overlapping at their skirts, which is what a cumulus
      // FIELD looks like: distinct heaps all sitting on the same shelf.
      const spread = BAND_WRAP[band] * 0.16;
      // One drift velocity per cluster: a cluster whose members separate over a
      // minute is not a cluster.
      // Drift slows with distance so the whole deck reads as one wind at one
      // speed seen from four ranges, rather than four decks racing each other.
      const vFall = [1, 0.75, 0.5, 0.42][band];
      const vx = (1.3 + rng() * 1.0) * vFall;
      const vz = (0.3 + rng() * 0.5) * (band === 0 ? 1 : 0.6);
      // ONE condensation level per cluster.
      //
      // This is the single thing that separates a cumulus field from a heap of
      // rubble, and it was the loudest defect in _veg2a-sky.png: every puff drew
      // its own altitude out of a 16-22 unit span, so the three to five members
      // of a cluster interpenetrated at staggered heights and the composite
      // silhouette came out as a jagged mass with square notches bitten out of
      // its underside and single-puff prongs hanging below it. Photographs of
      // fair-weather cumulus all share one feature — the bases are all at the
      // SAME height, because that height is where rising air reaches saturation,
      // and it is a property of the air mass, not of the cloud. Sharing it
      // within a cluster turns those five puffs into one mass with a flat
      // underside and a lumpy top, which is the read the whole `cloudGeo`
      // rebuild was after and could not reach from the shape alone.
      //
      // +-1.2 units of per-member slack, because a perfectly ruled plane looks
      // machined, and that is under half a cloud voxel (2.05 units) so it cannot
      // reopen the notches.
      const clusterBase = BAND_Y[band] + (rng() - 0.5) * BAND_SPAN[band];
      for (let m = 0; m < members; m++) {
        const ang = rng() * Math.PI * 2;
        const rad = m === 0 ? 0 : spread * (0.4 + rng());
        const sx = BAND_SCALE[band] * (0.78 + rng() * 0.62);
        // Band 2 (the high far deck) uses the two "high" geometries — fewer
        // turrets, calmer profile, which is what a cloud almost overhead and
        // mostly seen as a base should be. The horizon band gets the FULL
        // shapes: it is the only band seen in profile, so it is the one that
        // needs the towers. Same generator either way so there is exactly one
        // voxel scale in the sky.
        const gi = band === 2
          ? 4 + Math.floor(rng() * 1.999)
          : Math.floor(rng() * 3.999);
        const it: CloudItem = {
          x: cxp + Math.cos(ang) * rad,
          base: clusterBase + (rng() - 0.5) * 2.4,
          z: czp + Math.sin(ang) * rad,
          rot: rng() * Math.PI * 2,
          sx,
          // Vertical scale varies independently — the shape already carries its
          // own vertical development, so this only needs to keep two neighbouring
          // puffs from being the same proportion. The spread is NARROWER than the
          // 0.82-1.10 it was: with the bases now locked to a plane, any vertical
          // stretch shows entirely in the tops, and at 1.10 the tallest member of
          // a cluster stood a third higher than the shortest and the group read
          // as a skyline rather than as one cloud.
          sy: sx * (0.86 + rng() * 0.2),
          vx,
          vz,
          wrap,
          graded: band === 3,
        };
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

  /** Focus the last `update` used, so `writeMatrices` can grade by distance. */
  private fx = 0;
  private fz = 0;

  /**
   * A disc the deck keeps out of — the flying island's footprint (issue #68).
   *
   * A CUMULUS THAT GROWS THROUGH A TOWN SQUARE is what this is for, and it is
   * worth saying why the obvious answers are worse. HIDING an instance inside
   * the disc punches a hole in the sky that opens and closes as the island
   * travels, which reads as clouds blinking out; RAISING the band over the
   * island puts a lid on it. Pushing each puff radially OUT to the rim keeps
   * every instance in the sky, keeps the deck's density constant, and reads as
   * the island having cleared its own weather — which is what a mountain does
   * to a cloud layer anyway.
   *
   * It is applied in `writeMatrices` and NOT in `update`, so the puff's own
   * drift and wrap are untouched: an instance shoved aside is still at its true
   * position in the field and slides back across as the island passes, rather
   * than being permanently deflected and leaving a wake of thin sky behind.
   *
   * One disc rather than a list, because the island is the only thing in the
   * sky with a footprint. `radius` of 0 switches it off.
   */
  private koX = 0;
  private koY = 0;
  private koZ = 0;
  private koR = 0;

  setKeepOut(x: number, y: number, z: number, radius: number): void {
    this.koX = x;
    this.koY = y;
    this.koZ = z;
    this.koR = radius;
  }

  private writeMatrices(): void {
    for (const deck of this.decks) {
      for (let i = 0; i < deck.items.length; i++) {
        const it = deck.items[i];
        let y = it.base;
        let sx = it.sx;
        let sy = it.sy;
        if (it.graded) {
          // Linear in distance, not in its square: the eye reads the band as a
          // receding row, and a squared falloff kept every instance at nearly
          // full altitude until it was most of the way out, which put the
          // "horizon" clouds back up at 20 degrees where they started.
          const dx = it.x - this.fx;
          const dz = it.z - this.fz;
          const k = Math.min(1, Math.sqrt(dx * dx + dz * dz) / it.wrap);
          y += (HORIZON_Y_FAR - BAND_Y[3]) * k;
          const g = 1 + (HORIZON_SCALE_FAR / BAND_SCALE[3] - 1) * k;
          sx *= g;
          sy *= g * (1 + (HORIZON_FLATTEN - 1) * k);
        }
        let px = it.x;
        let pz = it.z;
        // ONLY THE PUFFS AT ITS ALTITUDE. A cumulus forty units over the deck
        // is not in the island's way and shoving it aside is a hole in the sky
        // for nothing — worse, it is a WALL: a radial push piles everything it
        // touches onto one circle, and the first pass, which tested no height
        // at all, ringed the island with a canyon of cloud (captured in
        // _sky-a.png). Gated on the vertical overlap, the two or three puffs
        // actually sharing the island's band step aside and the deck above and
        // below it is untouched.
        if (this.koR > 0 && Math.abs(y - this.koY) < KEEP_OUT_RISE) {
          // The puff's own reach, so a big far-band instance is pushed clear by
          // its own half-width rather than by its centre. `sx` is the instance
          // scale and the geometry is roughly 18 units across at scale 1.
          const reach = this.koR + sx * 9;
          const dx = px - this.koX;
          const dz = pz - this.koZ;
          const d2 = dx * dx + dz * dz;
          if (d2 < reach * reach) {
            // Straight out along its own bearing from the island. A puff exactly
            // on the axis has no bearing to be pushed along, so it takes +X —
            // an arbitrary direction, chosen once, for a case of measure zero.
            const d = Math.sqrt(d2);
            const ux = d > 1e-3 ? dx / d : 1;
            const uz = d > 1e-3 ? dz / d : 0;
            px = this.koX + ux * reach;
            pz = this.koZ + uz * reach;
          }
        }
        tmpPos.set(px, y, pz);
        tmpQuat.setFromAxisAngle(yAxis, it.rot);
        tmpScale.set(sx, sy, sx);
        deck.mesh.setMatrixAt(i, tmpMat.compose(tmpPos, tmpQuat, tmpScale));
      }
      deck.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  update(focus: THREE.Vector3, dt: number): void {
    this.fx = focus.x;
    this.fz = focus.z;
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
