/**
 * SKY SHARDS — the floating rocks scattered over the whole world. A cluster is ONE
 * carrier: one to four shards with real gaps between them, joined by plank bridges,
 * hovering up and down together and never roaming. Nothing lives on one, so it is
 * OPEN WORLD rather than a settlement: the meadow's own trees and bushes, a worn
 * track from bridge to bridge, and the same stone Skyhaven is cut from
 * (world/sky-rock.ts). Placement is seeded and avoids the town islands' roam discs.
 */
import * as THREE from "three";
import { VoxelModel } from "../core/voxel";
import { CarrierBody } from "./carriers";
import { flags } from "../core/flags";
import { mulberry32 } from "./noise";
import type { PropLib, Template } from "./props";
import { RoadNetwork, type Road } from "./roads";
import { trackProfile } from "./path-profile";
import { SolidStamp, StructureField } from "./structures";
import { CELL, LEDGE, LIP_COURSES, hash2, lipAt, paintShellColumn } from "./sky-rock";
import { Waypoints, WAYPOINT_PLATE_R, type WaypointSite } from "./waypoints";
import type { RingBand } from "./distant-terrain";

/** One rock of a cluster, in the cluster's frame. */
export interface ShardSpec {
  readonly x: number;
  readonly z: number;
  /** Envelope radius, world units. The outline staggers inside it. */
  readonly r: number;
  readonly phase: number;
}

export interface ClusterSpec {
  /** Stable per seed: `carrier:shard:<n>` is what a save stores. */
  readonly n: number;
  readonly x: number;
  readonly z: number;
  /** Rest altitude of the deck; the hover swings about it. */
  readonly y: number;
  readonly shards: readonly ShardSpec[];
  /** Pairs of shard indices a bridge joins. A tree: every shard is reachable. */
  readonly bridges: ReadonlyArray<readonly [number, number]>;
  readonly seed: number;
}

/** Sheer courses before the taper, and the taper's depth per unit of shard radius. */
const SHARD_CLIFF = 4;
const SHARD_TAPER = 0.85;
/** Rim-stone collar, cells. Narrower than the island's: a shard is small. */
const SHARD_RIM = 2;
const BRIDGE_HALF = 1.3;
const TRACK_HALF = 1.1;
/** The hover: amplitude in world units, and the swing's period in seconds. */
const HOVER_AMP = 1.2;
const HOVER_PERIOD = 9;
/** Beyond this the whole cluster is hidden — past the fog, and never streamed. */
const CULL_DIST = 900;

const WOOD = 0x8a6a45;
const WOOD_D = 0x6d4f31;
const ROPE = 0x5a4632;

/** A shard's outline at a bearing, world units: the envelope with a slow stagger inside it. */
function shardOutline(theta: number, r: number, phase: number): number {
  return (
    r *
    (0.93 +
      0.045 * Math.sin(3 * theta + phase * 1.7) +
      0.03 * Math.sin(5 * theta - phase) +
      0.015 * Math.sin(8 * theta + phase * 0.6))
  );
}

/** Distance from (x, z) to the segment ab, and where along it (0..1). */
function segmentDistance(
  x: number,
  z: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}

/**
 * WHERE THE CLUSTERS GO — seeded, ringed around the spawn, spaced from each other
 * and from every disc in `avoid` (the town islands' roam discs, so a shard is never
 * inside a passing town's keel). A cluster that finds nowhere is simply not placed.
 */
export function planShardClusters(
  seed: number,
  spawn: { x: number; z: number },
  avoid: ReadonlyArray<{ x: number; z: number; r: number }>,
  count: number,
): ClusterSpec[] {
  const rng = mulberry32(seed ^ 0x5a7d);
  const out: ClusterSpec[] = [];
  const MIN_R = 180;
  const MAX_R = 1300;
  const SPACING = 260;
  for (let attempt = 0; attempt < count * 40 && out.length < count; attempt++) {
    const dist = MIN_R + rng() * (MAX_R - MIN_R);
    const bearing = rng() * Math.PI * 2;
    const x = spawn.x + Math.sin(bearing) * dist;
    const z = spawn.z + Math.cos(bearing) * dist;
    // The shards first, so the cluster's own reach is known before it is sited.
    const shards: ShardSpec[] = [];
    const bridges: Array<readonly [number, number]> = [];
    const pick = rng();
    const n = pick < 0.3 ? 1 : pick < 0.65 ? 2 : pick < 0.9 ? 3 : 4;
    shards.push({ x: 0, z: 0, r: 14 + rng() * 14, phase: rng() * Math.PI * 2 });
    for (let k = 1; k < n; k++) {
      const r = 10 + rng() * 12;
      let placed = false;
      for (let tries = 0; tries < 12 && !placed; tries++) {
        const from = shards[Math.floor(rng() * shards.length)];
        const fi = shards.indexOf(from);
        const a = rng() * Math.PI * 2;
        const gap = 7 + rng() * 8;
        const d = from.r + gap + r;
        const sx = from.x + Math.sin(a) * d;
        const sz = from.z + Math.cos(a) * d;
        // Clear of every other shard by at least a gap, so two bridges never cross a rock.
        if (shards.every((s) => Math.hypot(s.x - sx, s.z - sz) >= s.r + r + 6)) {
          shards.push({ x: sx, z: sz, r, phase: rng() * Math.PI * 2 });
          bridges.push([fi, shards.length - 1]);
          placed = true;
        }
      }
    }
    let reach = 0;
    for (const s of shards) {
      reach = Math.max(reach, Math.hypot(s.x, s.z) + s.r);
    }
    const clear =
      avoid.every((a) => Math.hypot(a.x - x, a.z - z) > a.r + reach + 20) &&
      out.every((c) => Math.hypot(c.x - x, c.z - z) > SPACING);
    if (!clear) {
      continue;
    }
    out.push({ n: out.length, x, z, y: 95 + rng() * 55, shards, bridges, seed: Math.floor(rng() * 1e9) });
  }
  return out;
}

interface Bridge {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

export class ShardCluster extends CarrierBody {
  readonly spec: ClusterSpec;
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly solids = new StructureField();
  private readonly bridges: Bridge[] = [];
  private tracks!: RoadNetwork;
  private t: number;
  private trees = 0;
  /** The waystone, on a cluster big enough to earn one; its `all` is the world's to merge. */
  readonly waypoints: Waypoints | null;

  constructor(spec: ClusterSpec, props: PropLib, ringBand: RingBand) {
    let reach = 0;
    for (const s of spec.shards) {
      reach = Math.max(reach, Math.hypot(s.x, s.z) + s.r);
    }
    super(`carrier:shard:${spec.n}`, reach + 2);
    this.spec = spec;
    this.x = spec.x;
    this.z = spec.z;
    this.y = spec.y;
    // Every cluster on its own beat, or the whole sky breathes in step.
    this.t = spec.seed % 1000;
    this.steer(0);

    for (const [i, j] of spec.bridges) {
      const a = spec.shards[i];
      const b = spec.shards[j];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      const ux = dx / d;
      const uz = dz / d;
      // From rim to rim along the centre line, a step inboard so the plank ends on turf.
      const ea = shardOutline(Math.atan2(ux, uz), a.r, a.phase) - 0.8;
      const eb = shardOutline(Math.atan2(-ux, -uz), b.r, b.phase) - 0.8;
      this.bridges.push({
        ax: a.x + ux * ea,
        az: a.z + uz * ea,
        bx: b.x - ux * eb,
        bz: b.z - uz * eb,
      });
    }
    this.buildTracks();
    this.buildRock();
    this.buildBridges();
    const stone = this.siteWaystone();
    this.waypoints = stone ? new Waypoints([stone], ringBand, this) : null;
    if (this.waypoints) {
      this.root.add(this.waypoints.group);
    }
    this.plantWoods(props, stone);
    this.root.name = this.id;
  }

  /**
   * A stone for a cluster worth crossing to: the biggest shard, off the track, well
   * inside the rim. `waypoint:shard-<n>` — stable per seed, since a save lights it.
   */
  private siteWaystone(): WaypointSite | null {
    const s = this.spec.shards.reduce((a, b) => (b.r > a.r ? b : a));
    if (s.r < 22) {
      return null;
    }
    const rng = mulberry32(this.spec.seed ^ 0x3a5);
    for (let k = 0; k < 24; k++) {
      const a = rng() * Math.PI * 2;
      const d = 3 + rng() * s.r * 0.45;
      const x = s.x + Math.sin(a) * d;
      const z = s.z + Math.cos(a) * d;
      const hit = this.shardAt(x, z);
      if (!hit || hit.inside < WAYPOINT_PLATE_R + 2 || this.tracks.edgeDistanceTo(x, z) < WAYPOINT_PLATE_R + 1) {
        continue;
      }
      return { id: `waypoint:shard-${this.spec.n}`, x, y: 0, z, from: null };
    }
    return null;
  }

  // ---- the frame ------------------------------------------------------------

  protected steer(dt: number): void {
    // A staged capture holds it still: two runs must produce the same pictures.
    if (flags.photo) {
      return;
    }
    this.t += dt;
    this.y = this.spec.y + Math.sin((this.t / HOVER_PERIOD) * Math.PI * 2) * HOVER_AMP;
  }

  /** The shard under a LOCAL point, and how far inside its outline the point is (>= 0). Cell-quantised like the rock. */
  private shardAt(lx: number, lz: number): { shard: ShardSpec; inside: number } | null {
    const wx = (Math.floor(lx / CELL) + 0.5) * CELL;
    const wz = (Math.floor(lz / CELL) + 0.5) * CELL;
    for (const s of this.spec.shards) {
      const dx = wx - s.x;
      const dz = wz - s.z;
      const d = Math.hypot(dx, dz);
      if (d > s.r) {
        continue;
      }
      const edge = shardOutline(Math.atan2(dx, dz), s.r, s.phase);
      if (d <= edge) {
        return { shard: s, inside: edge - d };
      }
    }
    return null;
  }

  private onBridge(lx: number, lz: number): boolean {
    for (const b of this.bridges) {
      if (segmentDistance(lx, lz, b.ax, b.az, b.bx, b.bz) <= BRIDGE_HALF) {
        return true;
      }
    }
    return false;
  }

  localDeck(lx: number, lz: number): number {
    return this.shardAt(lx, lz) !== null || this.onBridge(lx, lz) ? 0 : -Infinity;
  }

  localTop(lx: number, lz: number): number {
    const deck = this.localDeck(lx, lz);
    if (deck === -Infinity) {
      return -Infinity;
    }
    let top = deck;
    const built = this.solids.topAt(lx, lz);
    if (built > top) {
      top = built;
    }
    const stone = this.waypoints?.solids.topAt(lx, lz) ?? -Infinity;
    return stone > top ? stone : top;
  }

  localBottom(lx: number, lz: number): number {
    const hit = this.shardAt(lx, lz);
    if (hit) {
      const depth = this.columnDepth(Math.floor(lx / CELL), Math.floor(lz / CELL));
      return -(depth > 0 ? depth : LIP_COURSES) * CELL;
    }
    return this.onBridge(lx, lz) ? -0.3 : Infinity;
  }

  /** How many courses of stone stand under a cell, 0 off the rock or under the turf lip. */
  private columnDepth(gx: number, gz: number): number {
    const wx = (gx + 0.5) * CELL;
    const wz = (gz + 0.5) * CELL;
    for (const s of this.spec.shards) {
      const dx = wx - s.x;
      const dz = wz - s.z;
      const d = Math.hypot(dx, dz);
      if (d > s.r) {
        continue;
      }
      const edge = shardOutline(Math.atan2(dx, dz), s.r, s.phase);
      if (d > edge - lipAt(gx, gz) * CELL) {
        return 0;
      }
      const d01 = Math.min(1, d / edge);
      // A cone to a root, cut in whole ledges like the island's, at the shard's own scale.
      const taper = (s.r * SHARD_TAPER) / CELL;
      const stepped = Math.round((taper * Math.pow(1 - d01, 1.4)) / LEDGE) * LEDGE;
      return Math.max(2, SHARD_CLIFF + stepped);
    }
    return 0;
  }

  // ---- building ---------------------------------------------------------------

  private buildTracks(): void {
    const net = new RoadNetwork();
    const profile = trackProfile(TRACK_HALF);
    let i = 0;
    for (const b of this.bridges) {
      // Each bridge end walks in to its shard's middle: the tracks meet where the shard is widest.
      const ends: Array<[number, number, number, number]> = [];
      const near = (x: number, z: number): ShardSpec =>
        this.spec.shards.reduce((best, s) =>
          Math.hypot(s.x - x, s.z - z) - s.r < Math.hypot(best.x - x, best.z - z) - best.r ? s : best,
        );
      const sa = near(b.ax, b.az);
      const sb = near(b.bx, b.bz);
      ends.push([b.ax, b.az, sa.x, sa.z], [b.bx, b.bz, sb.x, sb.z]);
      for (const [x0, z0, x1, z1] of ends) {
        const road: Road = {
          id: `track:${this.id}-${i++}`,
          fromId: this.id,
          toId: this.id,
          profile,
          pts: [
            { x: x0, z: z0, y: 0, bridge: false },
            { x: x1, z: z1, y: 0, bridge: false },
          ],
          trim: new Float32Array(8),
        };
        net.add(road);
      }
    }
    net.build();
    this.tracks = net;
  }

  private readonly columnDepthFn = (gx: number, gz: number): number => this.columnDepth(gx, gz);

  private buildRock(): void {
    const v = new VoxelModel();
    const R = Math.ceil(this.radius / CELL) + 2;
    let maxDepth = SHARD_CLIFF;
    for (const s of this.spec.shards) {
      maxDepth = Math.max(maxDepth, SHARD_CLIFF + (s.r * SHARD_TAPER) / CELL);
    }
    for (let gx = -R; gx <= R; gx++) {
      for (let gz = -R; gz <= R; gz++) {
        const wx = (gx + 0.5) * CELL;
        const wz = (gz + 0.5) * CELL;
        const hit = this.shardAt(wx, wz);
        if (!hit) {
          continue;
        }
        const depth = this.columnDepth(gx, gz);
        const stone = hit.inside > lipAt(gx, gz) * CELL;
        const rim =
          hit.inside <
          (SHARD_RIM + (hash2(Math.floor(gx / 2), Math.floor(gz / 2), 89) < 0.35 ? 1 : 0)) * CELL;
        paintShellColumn(
          v,
          gx,
          gz,
          depth,
          stone,
          rim ? "rimstone" : this.tracks.edgeDistanceTo(wx, wz) < 0 ? "track" : "turf",
          maxDepth,
          this.columnDepthFn,
        );
      }
    }
    const mesh = v.build(CELL, false);
    // `build` re-bases the model so its lowest voxel sits at y = 0; adding `minY` back
    // puts a cell at `gy` at `gy * CELL` — the island's own identity (tools/test-waterfall.mjs).
    mesh.position.y = v.bounds(false).minY * CELL;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.name = "shard:rock";
    this.root.add(mesh);
    this.geos.push(mesh.geometry);
    this.mats.push(mesh.material as THREE.Material);
  }

  private buildBridges(): void {
    // ONE MESH PER BRIDGE, voxelled: planks, two ropes and their posts baked into a
    // single geometry — a plank per box was thirty draw calls a bridge.
    const SV = 0.3;
    for (const b of this.bridges) {
      const dx = b.bx - b.ax;
      const dz = b.bz - b.az;
      const len = Math.hypot(dx, dz);
      const v = new VoxelModel();
      const half = Math.round(BRIDGE_HALF / SV);
      const n = Math.max(2, Math.round(len / SV));
      const z0 = -Math.floor(n / 2);
      for (let k = 0; k < n; k++) {
        // Boards three voxels long with a hairline between, alternating shade.
        const board = Math.floor(k / 3);
        if (k % 3 === 2 && k !== n - 1) {
          continue;
        }
        v.box(-half, 0, z0 + k, half - 1, 0, z0 + k, board % 2 ? WOOD_D : WOOD);
      }
      for (const side of [-half, half - 1]) {
        v.box(side, 3, z0, side, 3, z0 + n - 1, ROPE);
        v.box(side, 1, z0, side, 3, z0 + 1, WOOD_D);
        v.box(side, 1, z0 + n - 2, side, 3, z0 + n - 1, WOOD_D);
      }
      const mesh = v.build(SV, true);
      // `build` puts the lowest voxel at y = 0: sink one plank so the deck top is the walking surface.
      mesh.position.set((b.ax + b.bx) / 2, -SV, (b.az + b.bz) / 2);
      mesh.rotation.y = Math.atan2(dx, dz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.root.add(mesh);
      this.geos.push(mesh.geometry);
      this.mats.push(mesh.material as THREE.Material);
    }
  }

  private plantWoods(lib: PropLib, stone: WaypointSite | null): void {
    const rng = mulberry32(this.spec.seed ^ 0x77d5);
    const stamp = new SolidStamp(this.solids);
    const taken: Array<{ x: number; z: number; r: number }> = [];
    if (stone) {
      taken.push({ x: stone.x, z: stone.z, r: WAYPOINT_PLATE_R + 1.5 });
    }
    const free = (x: number, z: number, r: number): boolean =>
      !taken.some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < (t.r + r) ** 2) &&
      this.tracks.edgeDistanceTo(x, z) >= r &&
      !this.bridges.some((b) => segmentDistance(x, z, b.ax, b.az, b.bx, b.bz) < r + BRIDGE_HALF);
    const trees: Template[] = [lib.oakA, lib.oakB, lib.oakC, lib.oakD, lib.birch, lib.pine, lib.pineIrr];
    const rocks: Template[] = [lib.rockA, lib.rockB, lib.rockAMoss, lib.rockBMoss];
    for (const s of this.spec.shards) {
      // Roughly one tree per 90 square units, thinning on the small shards.
      const want = Math.round((Math.PI * s.r * s.r) / 90);
      for (let k = 0; k < want * 4 && this.trees < 60; k++) {
        const a = rng() * Math.PI * 2;
        const d = Math.sqrt(rng()) * s.r * 0.78;
        const x = s.x + Math.sin(a) * d;
        const z = s.z + Math.cos(a) * d;
        if (this.shardAt(x, z) === null || !free(x, z, 3.2)) {
          continue;
        }
        stamp.add(trees[Math.floor(rng() * trees.length)], x, 0, z, rng() * Math.PI * 2, 0.8 + rng() * 0.4);
        taken.push({ x, z, r: 3.2 });
        this.trees++;
        if (taken.length >= want) {
          break;
        }
      }
      // Undergrowth and a boulder or two, wherever the trees left room.
      const bits = Math.round(s.r / 4);
      for (let k = 0; k < bits * 3; k++) {
        const a = rng() * Math.PI * 2;
        const d = Math.sqrt(rng()) * s.r * 0.82;
        const x = s.x + Math.sin(a) * d;
        const z = s.z + Math.cos(a) * d;
        if (this.shardAt(x, z) === null || !free(x, z, 1.4)) {
          continue;
        }
        const boulder = rng() < 0.3;
        stamp.add(
          boulder ? rocks[Math.floor(rng() * rocks.length)] : lib.bushT,
          x,
          0,
          z,
          rng() * Math.PI * 2,
          boulder ? 0.5 + rng() * 0.4 : 0.8 + rng() * 0.5,
        );
        taken.push({ x, z, r: 1.4 });
      }
    }
    this.solids.build();
    const geo = stamp.acc.toGeometry();
    if (geo) {
      const mesh = new THREE.Mesh(geo, lib.solidMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.root.add(mesh);
      this.geos.push(geo);
    }
  }

  // ---- per frame, and the probes ------------------------------------------------

  /** Hide the whole cluster past the fog: never streamed, so this is its only cull. */
  update(focus: THREE.Vector3): void {
    const dx = this.x - focus.x;
    const dz = this.z - focus.z;
    this.root.visible = dx * dx + dz * dz < (CULL_DIST + this.radius) ** 2;
    this.waypoints?.update(focus);
  }

  /** Every collider on the deck, world coordinates, for the collider overlay. */
  debugStructures(out: number[]): void {
    const local: number[] = [];
    this.solids.debugBoxes(local);
    for (let i = 0; i < local.length; i += 6) {
      // No yaw: a cluster never turns, so local x/z are world x/z less the origin.
      out.push(local[i] + this.x, local[i + 1] + this.z, local[i + 2], local[i + 3], local[i + 4], local[i + 5] + this.y);
    }
  }

  debug(): unknown {
    return {
      id: this.id,
      x: +this.x.toFixed(1),
      y: +this.y.toFixed(2),
      z: +this.z.toFixed(1),
      rest: this.spec.y,
      radius: +this.radius.toFixed(1),
      shards: this.spec.shards.length,
      bridges: this.bridges.map((b) => ({
        ax: +(b.ax + this.x).toFixed(1),
        az: +(b.az + this.z).toFixed(1),
        bx: +(b.bx + this.x).toFixed(1),
        bz: +(b.bz + this.z).toFixed(1),
      })),
      trees: this.trees,
      waypoint: this.waypoints?.all[0]?.id ?? null,
      visible: this.root.visible,
    };
  }

  dispose(): void {
    this.waypoints?.dispose();
    for (const g of this.geos) {
      g.dispose();
    }
    for (const m of this.mats) {
      m.dispose();
    }
  }
}
