/**
 * Sky ambience: drifting chunky voxel cumulus. The deck casts NO shadows — one
 * hill-sized hard-edged slab overhead dumped the whole hillside into near-black.
 */
import * as THREE from "three";
import type { CelestialState } from "../core/types";
import { VoxelModel } from "../core/voxel";
import { mulberry32 } from "./noise";

/** Wrap half-extent per band; past ~360 the scene fog (150..420) is pure haze. */
const BAND_WRAP = [165, 235, 305, 360];
/**
 * Band base altitude and random span. Band 3 is the HORIZON band: far and low,
 * seen in profile. y = 0 is a model's lowest voxel, so these are undersides.
 */
const BAND_Y = [80, 104, 120, 96];
const BAND_SPAN = [14, 18, 20, 12];
/** Instance scale per band; far bands go big or fog reduces them to smudges. */
const BAND_SCALE = [1.05, 1.5, 2.4, 1.7];

/**
 * Horizon band's altitude and scale AT THE WRAP EDGE, lerped by distance from the
 * focus. Flat and low fails: the field wraps cartesianly, so a 3x instance 58
 * units up becomes a white slab overhead.
 */
const HORIZON_Y_FAR = 54;
const HORIZON_SCALE_FAR = 2.6;
/** Vertical squash as the horizon band recedes; un-squashed it reads as a cliff. */
const HORIZON_FLATTEN = 0.78;

/** Headroom above a keep-out's deck that still counts as intersecting — generous,
 *  so the whole middle band clears the island's cylinder. */
const KEEP_OUT_GAP = 48;

/** A cumulus's height at scale 1 (R = 4..6 voxels at ~1.9 units each). */
const CLOUD_H = 15;

/** Condensation level: every boll is clipped flat at this voxel row. */
const BASE_Y = 4;

/**
 * One cumulus geometry in five passes: bolls and turrets, a morphological open, a
 * concavity fill, a domed underside, a repaint. Rasterised into a flat Uint8Array
 * first — passes 2-4 delete and query, VoxelModel is append-only.
 */
function cloudGeo(variant: number, seed: number, high = false): THREE.BufferGeometry {
  const rng = mulberry32((seed ^ 0xc10d) + variant * 977 + (high ? 40503 : 0));
  // R is in VOXELS, small on purpose: a fine grid shows its own staircase.
  const R = high ? 4.0 + rng() * 1.2 : 4.2 + rng() * 1.5;
  const crowns: Array<[number, number, number, number]> = [];

  // 2R + slack covers every variant; HGT holds a full ~3R stack.
  const LIM = 26;
  const HGT = 40;
  const W = LIM * 2 + 1;
  const vol = new Uint8Array(W * W * HGT);
  const inb = (x: number, y: number, z: number): boolean =>
    x >= -LIM && x <= LIM && z >= -LIM && z <= LIM && y >= 0 && y < HGT;
  const at = (x: number, y: number, z: number): number => (y * W + (x + LIM)) * W + (z + LIM);
  const get = (x: number, y: number, z: number): number => (inb(x, y, z) ? vol[at(x, y, z)] : 0);
  const put = (x: number, y: number, z: number): void => {
    if (inb(x, y, z)) {
      vol[at(x, y, z)] = 1;
    }
  };

  /** Ellipsoid painter that clips below BASE_Y, giving the flat condensation
   *  level; pass 4 bulges it back into a dome. */
  const lobe = (cx: number, cy: number, cz: number, rx: number, ry: number, rz: number): void => {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      for (let y = Math.max(BASE_Y, Math.floor(cy - ry)); y <= Math.ceil(cy + ry); y++)
        for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++) {
          const dx = (x - cx) / rx,
            dy = (y - cy) / ry,
            dz = (z - cz) / rz;
          if (dx * dx + dy * dy + dz * dz <= 1.0) put(x, y, z);
        }
    }
  };

  // Pass 1: wide footprint lobes, then a short vertical stack, then turrets.
  const baseN = 3;
  const rBase = R * (0.62 + rng() * 0.14);
  let fatX = 0;
  let fatZ = 0;
  let fatR = 0;
  let fatTop = BASE_Y;
  for (let b = 0; b < baseN; b++) {
    const a = (b / baseN) * Math.PI * 2 + rng() * 0.9;
    const rad = b === 0 ? 0 : rBase * (0.4 + rng() * 0.35);
    const cx = Math.cos(a) * rad;
    const cz = Math.sin(a) * rad;
    const rx = rBase * (0.82 + rng() * 0.26);
    // Every lobe stays inside 1.6:1 in plan so nothing reads as a contrail.
    const rz = Math.max(rx / 1.6, rx * (0.82 + rng() * 0.28));
    const ry = rx * (0.58 + rng() * 0.16);
    // Centre sits above the clip so ~30% of each boll is cut away flat.
    const cy = BASE_Y + ry * 0.7;
    lobe(cx, cy, cz, rx, ry, rz);
    if (rx > fatR) {
      fatR = rx;
      fatX = cx;
      fatZ = cz;
      fatTop = cy + ry;
    }
  }
  // Tower kept short and fat: 1-2 storeys at 85%, sunk 60% into each other. More
  // or narrower storeys gave spires, and 150-unit columns at horizon scale.
  const stackN = high ? 1 : 1 + (variant % 2);
  let sr = fatR * 0.85;
  let sy = fatTop;
  for (let k = 0; k < stackN; k++) {
    const ry = sr * (0.74 + rng() * 0.18);
    const cy = sy - ry * 0.6 + ry;
    const cx = fatX + (rng() - 0.5) * sr * 0.45;
    const cz = fatZ + (rng() - 0.5) * sr * 0.45;
    lobe(cx, cy, cz, sr, ry, sr * (0.88 + rng() * 0.2));
    crowns.push([cx, cy + ry * 0.35, cz, sr]);
    sy = cy + ry;
    sr *= 0.85;
  }

  // Fat turrets: thin ones read as prongs. Two at different heights = cauliflower.
  const turrets = 1 + (variant % 2);
  for (let t = 0; t < turrets; t++) {
    const [bx, by, bz, br] = crowns[Math.floor(rng() * crowns.length)];
    const tr = br * (0.55 + rng() * 0.25);
    lobe(
      bx + (rng() - 0.5) * br * 0.6,
      by + tr * (0.2 + t * 0.26),
      bz + (rng() - 0.5) * br * 0.5,
      tr,
      tr * (0.75 + rng() * 0.25),
      tr * (0.88 + rng() * 0.22),
    );
  }

  // Passes 2 & 3: erode anything with fewer than four solid face-neighbours (fin,
  // prong, shard), then dilate empty cells with four or more (pits, which cannot
  // grow the silhouette). Snapshot per sweep; in-place erosion cascades.
  const snap = new Uint8Array(vol.length);
  for (let it = 0; it < 3; it++) {
    snap.set(vol);
    const snapGet = (x: number, y: number, z: number): number =>
      inb(x, y, z) ? snap[at(x, y, z)] : 0;
    for (let y = 0; y < HGT; y++) {
      for (let x = -LIM; x <= LIM; x++)
        for (let z = -LIM; z <= LIM; z++) {
          if (!snap[at(x, y, z)]) continue;
          const n =
            snapGet(x + 1, y, z) +
            snapGet(x - 1, y, z) +
            snapGet(x, y, z + 1) +
            snapGet(x, y, z - 1) +
            snapGet(x, y + 1, z) +
            (y <= BASE_Y ? 1 : snapGet(x, y - 1, z));
          if (n < 4) vol[at(x, y, z)] = 0;
        }
    }
    snap.set(vol);
    for (let y = BASE_Y; y < HGT; y++) {
      for (let x = -LIM; x <= LIM; x++)
        for (let z = -LIM; z <= LIM; z++) {
          if (snap[at(x, y, z)]) continue;
          const n =
            snapGet(x + 1, y, z) +
            snapGet(x - 1, y, z) +
            snapGet(x, y, z + 1) +
            snapGet(x, y, z - 1) +
            snapGet(x, y + 1, z) +
            (y <= BASE_Y ? 1 : snapGet(x, y - 1, z));
          if (n >= 4) vol[at(x, y, z)] = 1;
        }
    }
  }

  // Pass 4: dome the underside by the thickness above each column.
  let topMax = BASE_Y;
  const colTop = new Int8Array(W * W);
  for (let x = -LIM; x <= LIM; x++) {
    for (let z = -LIM; z <= LIM; z++) {
      let hi = -1;
      for (let y = HGT - 1; y >= BASE_Y; y--)
        if (vol[at(x, y, z)]) {
          hi = y;
          break;
        }
      colTop[(x + LIM) * W + (z + LIM)] = hi;
      if (hi > topMax) topMax = hi;
    }
  }
  const span = Math.max(1, topMax - BASE_Y);
  // Continuous drop depth per column, sqrt so the dome is round not conical.
  const dropF = new Float32Array(W * W);
  for (let x = -LIM; x <= LIM; x++) {
    for (let z = -LIM; z <= LIM; z++) {
      const hi = colTop[(x + LIM) * W + (z + LIM)];
      // Shallow: each extra step shows from below as a bright vertical sliver
      // (side face 0.88 vs bottom 0.62 in VoxelModel's table).
      dropF[(x + LIM) * W + (z + LIM)] =
        hi < BASE_Y ? 0 : 1 + 2.1 * Math.sqrt((hi - BASE_Y) / span);
    }
  }
  // Smooth before rounding, or the rough top corrugates the base with fins.
  const sm = new Float32Array(W * W);
  for (let pass = 0; pass < 3; pass++) {
    for (let ax = 1; ax < W - 1; ax++) {
      for (let az = 1; az < W - 1; az++) {
        const i = ax * W + az;
        sm[i] = (dropF[i - W] + dropF[i - 1] + dropF[i] * 2 + dropF[i + 1] + dropF[i + W]) / 6;
      }
    }
    dropF.set(sm);
  }
  for (let x = -LIM; x <= LIM; x++) {
    for (let z = -LIM; z <= LIM; z++) {
      if (colTop[(x + LIM) * W + (z + LIM)] < BASE_Y) continue;
      const drop = Math.max(1, Math.round(dropF[(x + LIM) * W + (z + LIM)]));
      for (let d = 1; d <= drop; d++) put(x, BASE_Y - d, z);
    }
  }

  // Pass 5: paint. The sun/shade split is NOT baked — instances are randomly yawed.
  const v = new VoxelModel();
  // Roughly 2:1 top-to-belly value, or the sky reads as uniform grey popcorn.
  const BODY = 0xfdfbf2;
  const BELLY = [0xc9d6e8, 0xaebfd6, 0x9aadc8, 0x8aa0be, 0x7d94b4];
  for (let y = 0; y < HGT; y++) {
    for (let x = -LIM; x <= LIM; x++)
      for (let z = -LIM; z <= LIM; z++) {
        if (!vol[at(x, y, z)]) continue;
        if (y < BASE_Y) v.set(x, y, z, BELLY[Math.min(BASE_Y - 1 - y, BELLY.length - 1)]);
        else v.set(x, y, z, BODY);
      }
  }
  // Cap only columns on a horizontal shelf (3 of 4 neighbours within a voxel):
  // ungated, flank caps line up into bright vertical scratches.
  const top = new Int8Array(W * W).fill(-1);
  for (let x = -LIM; x <= LIM; x++) {
    for (let z = -LIM; z <= LIM; z++)
      for (let y = HGT - 1; y >= BASE_Y; y--)
        if (vol[at(x, y, z)]) {
          top[(x + LIM) * W + (z + LIM)] = y;
          break;
        }
  }
  const topAt = (x: number, z: number): number =>
    x >= -LIM && x <= LIM && z >= -LIM && z <= LIM ? top[(x + LIM) * W + (z + LIM)] : -1;
  for (let x = -LIM; x <= LIM; x++) {
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
  }

  // ~2 units per cloud voxel — nothing in the sky is finer-grained than ground.
  const mesh = v.build(high ? 1.9 : 2.05, true);
  const g = mesh.geometry;
  (mesh.material as THREE.Material).dispose();
  return g;
}

interface CloudItem {
  x: number;
  /** Underside altitude; `VoxelModel.build` datums y = 0 at the lowest voxel. */
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

  applyCelestial(state: Readonly<CelestialState>): void {
    // Light scattered through the body only; the moon is still the highlight.
    this.mat.emissive.copy(state.keyColor).lerp(state.ambientSky, 0.28);
    this.mat.emissiveIntensity = 0.17 + state.night * 0.16;
  }

  constructor(seed: number) {
    // ONE opaque material: translucent high clouds read as glass shards.
    this.mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      // Ambient floor for the away-from-sun flank. Low: emissive eats the split.
      emissive: 0xdfeaf7,
      emissiveIntensity: 0.17,
      fog: true,
    });
    this.mat.userData.bsNightRole = "cloud-moon-fill";
    for (let i = 0; i < 4; i++) {
      this.geos.push(cloudGeo(i, seed));
    }
    for (let i = 0; i < 2; i++) {
      this.geos.push(cloudGeo(i, seed, true));
    }
    const rng = mulberry32(seed ^ 0x5eed);

    // Placement is CLUSTER-first: dart-thrown centres per band, 3-5 puffs around
    // each, variant picked last. Uniform per-instance sampling is a polka-dot field.
    const slots: CloudItem[][] = this.geos.map(() => []);
    const centres: Array<[number, number, number]> = []; // x, z, band
    // ~180 instances over six instanced batches; fewer left most bearings bare.
    const CLUSTERS = 46;
    for (let c = 0; c < CLUSTERS; c++) {
      const band = c % 4;
      const wrap = BAND_WRAP[band];
      let cxp = 0;
      let czp = 0;
      // Separation is under the mean spacing so most darts land first try.
      const sep2 = wrap * 0.42 * (wrap * 0.42);
      for (let attempt = 0; attempt < 8; attempt++) {
        cxp = (rng() - 0.5) * 2 * wrap;
        czp = (rng() - 0.5) * 2 * wrap;
        let ok = true;
        for (const [ox2, oz2, ob] of centres) {
          if (ob !== band) {
            continue;
          }
          const dx = ox2 - cxp;
          const dz = oz2 - czp;
          if (dx * dx + dz * dz < sep2) {
            ok = false;
            break;
          }
        }
        if (ok) {
          break;
        }
      }
      centres.push([cxp, czp, band]);

      const members = 3 + Math.floor(rng() * 3);
      // Tighter and the shared base welds members into one raft (floating island).
      const spread = BAND_WRAP[band] * 0.16;
      // One drift per cluster, slowing with distance: one wind seen from four ranges.
      const vFall = [1, 0.75, 0.5, 0.42][band];
      const vx = (1.3 + rng() * 1.0) * vFall;
      const vz = (0.3 + rng() * 0.5) * (band === 0 ? 1 : 0.6);
      // ONE condensation level per cluster — real cumulus bases share a height.
      // +-1.2 units of slack, under half a cloud voxel, so notches cannot reopen.
      const clusterBase = BAND_Y[band] + (rng() - 0.5) * BAND_SPAN[band];
      for (let m = 0; m < members; m++) {
        const ang = rng() * Math.PI * 2;
        const rad = m === 0 ? 0 : spread * (0.4 + rng());
        const sx = BAND_SCALE[band] * (0.78 + rng() * 0.62);
        // Band 2 gets the calmer "high" shapes; the horizon band needs the towers.
        const gi = band === 2 ? 4 + Math.floor(rng() * 1.999) : Math.floor(rng() * 3.999);
        const it: CloudItem = {
          x: cxp + Math.cos(ang) * rad,
          base: clusterBase + (rng() - 0.5) * 2.4,
          z: czp + Math.sin(ang) * rad,
          rot: rng() * Math.PI * 2,
          sx,
          // Narrow spread: with bases on a plane, stretch shows only in the tops.
          sy: sx * (0.86 + rng() * 0.2),
          vx,
          vz,
          wrap,
          graded: band === 3,
        };
        slots[gi].push(it);
      }
    }

    // One InstancedMesh per variant: six batches, not 104 draw calls.
    for (let g = 0; g < this.geos.length; g++) {
      const items = slots[g];
      if (items.length === 0) {
        continue;
      }
      const mesh = new THREE.InstancedMesh(this.geos[g], this.mat, items.length);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // The deck wraps around the camera, so a stale bounding sphere would pop it.
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
   * Intersecting puffs are simply NOT DRAWN; moving them piles them into a canyon
   * wall or a ceiling between island and sun. Applied in `writeMatrices` and not
   * `update`, so a dropped puff keeps its true position. `radius` of 0 = off.
   */
  private koX = 0;
  private koY = 0;
  private koZ = 0;
  private koR = 0;
  private koDeep = 0;

  /** `y` is the DECK and `depth` how far the island hangs below it: a puff sent
   *  underneath must clear the keel, not just the deck. */
  setKeepOut(x: number, y: number, z: number, radius: number, depth: number): void {
    this.koX = x;
    this.koY = y;
    this.koZ = z;
    this.koR = radius;
    this.koDeep = depth;
  }

  private writeMatrices(): void {
    for (const deck of this.decks) {
      for (let i = 0; i < deck.items.length; i++) {
        const it = deck.items[i];
        let y = it.base;
        let sx = it.sx;
        let sy = it.sy;
        if (it.graded) {
          // Linear in distance: squared held instances near full altitude too long.
          const dx = it.x - this.fx;
          const dz = it.z - this.fz;
          const k = Math.min(1, Math.sqrt(dx * dx + dz * dz) / it.wrap);
          y += (HORIZON_Y_FAR - BAND_Y[3]) * k;
          const g = 1 + (HORIZON_SCALE_FAR / BAND_SCALE[3] - 1) * k;
          sx *= g;
          sy *= g * (1 + (HORIZON_FLATTEN - 1) * k);
        }
        if (this.koR > 0) {
          // A BUBBLE, not a footprint — 2.4 radii buys the open sky the art wants.
          // Only the island's own band is cleared, so decks above still cover it.
          const reach = this.koR * 2.4 + sx * 8;
          const dx = it.x - this.koX;
          const dz = it.z - this.koZ;
          // `y` is the puff's UNDERSIDE, so its box is [y, y + its own height].
          const tall = sy * CLOUD_H;
          if (
            dx * dx + dz * dz < reach * reach &&
            y < this.koY + KEEP_OUT_GAP &&
            y + tall > this.koY - this.koDeep
          ) {
            // InstancedMesh: every slot is written every frame, so removal is zero scale.
            deck.mesh.setMatrixAt(
              i,
              tmpMat.compose(tmpPos.set(0, 0, 0), tmpQuat.identity(), tmpScale.set(0, 0, 0)),
            );
            continue;
          }
        }
        tmpPos.set(it.x, y, it.z);
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
        if (it.x - focus.x > w) {
          it.x -= w * 2;
        } else if (it.x - focus.x < -w) {
          it.x += w * 2;
        }
        if (it.z - focus.z > w) {
          it.z -= w * 2;
        } else if (it.z - focus.z < -w) {
          it.z += w * 2;
        }
      }
    }
    this.writeMatrices();
  }

  dispose(): void {
    for (const deck of this.decks) {
      deck.mesh.dispose();
    }
    for (const g of this.geos) {
      g.dispose();
    }
    this.mat.dispose();
  }
}
