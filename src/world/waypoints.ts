/**
 * WAYPOINTS — the standing stones you wake up beside.
 *
 * A player who faints is put back at the nearest one he has LIT, so the cost of
 * dying is the walk back and not the whole valley. That is the only thing they
 * do today; a stone you can travel between is the obvious next thing and is
 * deliberately not here.
 *
 * WHERE THEY ARE IS DERIVED, NEVER AUTHORED. An id is `type:name` and never a
 * position (game-story.md §1), and a waypoint is a fact about the ROAD rather
 * than about a settlement: one at every town's gate, one at the fork, and one
 * every `SPACING` units of carriageway in between — so the long spur that reads
 * as "far from anywhere" is exactly where they turn up. The road network is
 * seeded, so the same world always grows the same stones with the same ids, and
 * a save that says a stone is lit still means it next session.
 *
 * They are SOLID by the same primitive a hut is: `measureFootprint` reads the
 * voxel model this file painted, so the collider is the stone and cannot drift.
 */
import * as THREE from "three";
import { VoxelModel } from "../core/voxel";
import { relight, type SolidBox } from "./props";
import { measureFootprint, StructureField } from "./structures";
import type { Road } from "./roads";

/** World units of road between two stones. A minute's walk at a hero's 6/s. */
const SPACING = 220;
/** No second stone inside this of another — the gates and the fork win ties. */
const MIN_APART = 110;
/** How near a stone the hero must be to light it. Generous: this is not a puzzle. */
export const WAYPOINT_TOUCH = 6;
/**
 * How far clear of the carriageway's RIM a stone stands, world units.
 *
 * A stone is SOLID, and a solid thing in the middle of a road is a wall across
 * the way into a town — the gate stones sit exactly where the road enters. So
 * every site is pushed sideways off the deck: measured from the rim (the road's
 * own `deckEdge`), never from its centreline, which is the rule every clearance
 * question in this project answers (`RoadClearance`, world/roads.ts).
 */
const OFF_ROAD = 3.5;

/** Voxel scale: the town's coarse 0.28 — a standing stone has no face to lose. */
const S = 0.28;

const STONE = 0x6f6a63;
const STONE_D = 0x53504b;
const STONE_L = 0x8b857c;
/** Dark until it is lit, and the lit colour is the gateway's own cyan. */
const CRYSTAL_DARK = 0x2f4450;
const CRYSTAL_LIT = 0x8be3ff;

export interface WaypointInfo {
  /** `waypoint:<name>` — stable across sessions, because the roads are seeded. */
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * A stone's place and its meshes, kept APART: `info` is what leaves this file,
 * and it is a plain object on purpose — a caller that got the live record would
 * be handed two `THREE.Object3D`s, which is a scene graph rather than a
 * position, and neither a probe nor a save can carry one.
 */
interface Stone {
  readonly info: WaypointInfo;
  crystal: THREE.Mesh;
  light: THREE.PointLight;
  lit: boolean;
}

/** The pillar: a tapered stone with a socket at the top for the crystal. */
function buildStone(): VoxelModel {
  const v = new VoxelModel();
  v.box(-3, 0, -3, 2, 0, 2, STONE_D);
  v.box(-2, 1, -2, 1, 7, 1, STONE);
  v.box(-2, 1, -2, -2, 7, 1, STONE_D);
  v.box(-2, 8, -2, 1, 9, 1, STONE_L);
  // A notch on the sunward face, so the silhouette is not a plain post.
  v.box(-1, 4, 2, 0, 6, 2, STONE_D);
  return v;
}

/**
 * One waypoint's mesh tree: the stone (solid), and the crystal above it, which
 * is a SECOND model on its own material because it changes colour when lit and
 * the stone must not.
 */
function buildRig(): { group: THREE.Group; crystal: THREE.Mesh; solid: readonly SolidBox[] } {
  const group = new THREE.Group();

  const stoneModel = buildStone();
  const stone = stoneModel.build(S, true);
  const g = stone.geometry;
  relight(
    (g.getAttribute("normal") as THREE.BufferAttribute).array as Float32Array,
    (g.getAttribute("color") as THREE.BufferAttribute).array as Float32Array,
  );
  stone.position.y = stoneModel.bounds(true).minY * S;
  stone.castShadow = true;
  stone.receiveShadow = false;
  group.add(stone);

  const cm = new VoxelModel();
  cm.ellipsoid(-0.5, 0, -0.5, 1.6, 2.2, 1.6, CRYSTAL_DARK);
  const crystal = cm.build(S, true);
  crystal.position.y = 9.6 * S;
  crystal.castShadow = false;
  group.add(crystal);

  return { group, crystal, solid: measureFootprint(stoneModel, S) };
}

/**
 * Every stone in one world.
 *
 * `sites()` is a pure function of the road network so the layout can be asked
 * for before anything is built — the collider field wants the boxes at stamp
 * time and the compass wants the positions at boot.
 */
export function waypointSites(
  roads: readonly Road[],
  towns: readonly { id: string; gateX: number; gateZ: number }[],
  junction: { x: number; z: number } | null,
  heightAt: (x: number, z: number) => number,
): WaypointInfo[] {
  const out: WaypointInfo[] = [];
  const far = (x: number, z: number): boolean =>
    out.every((w) => (w.x - x) ** 2 + (w.z - z) ** 2 > MIN_APART * MIN_APART);

  /**
   * Step off the road before standing the stone up.
   *
   * `beside` is the perpendicular of the segment the point belongs to and the
   * side is fixed (always the same hand), so a row of stones along one road
   * reads as a row rather than as litter on both verges.
   */
  const add = (id: string, x: number, z: number, dirX: number, dirZ: number, off: number): void => {
    const len = Math.hypot(dirX, dirZ) || 1;
    const px = (-dirZ / len) * off;
    const pz = (dirX / len) * off;
    const sx = x + px;
    const sz = z + pz;
    if (far(sx, sz)) {
      out.push({ id: `waypoint:${id}`, x: sx, y: heightAt(sx, sz), z: sz });
    }
  };

  /** Which way the road runs where it passes closest to this point. */
  const bearingNear = (x: number, z: number): { dx: number; dz: number; off: number } => {
    let best = { dx: 0, dz: 1, off: OFF_ROAD };
    let bd = Infinity;
    for (const road of roads) {
      for (let i = 1; i < road.pts.length; i++) {
        const a = road.pts[i - 1];
        const b = road.pts[i];
        const d = (b.x - x) ** 2 + (b.z - z) ** 2;
        if (d < bd) {
          bd = d;
          best = { dx: b.x - a.x, dz: b.z - a.z, off: road.profile.deckEdge + OFF_ROAD };
        }
      }
    }
    return best;
  };

  // THE GATES FIRST, so a town always has one and the spacing below yields to it.
  for (const town of towns) {
    const b = bearingNear(town.gateX, town.gateZ);
    add(`town-${town.id}`, town.gateX, town.gateZ, b.dx, b.dz, b.off);
  }
  if (junction) {
    const b = bearingNear(junction.x, junction.z);
    // A fork is three roads meeting, so its rim is further out than one road's.
    add("junction", junction.x, junction.z, b.dx, b.dz, b.off + OFF_ROAD);
  }

  // Then the road itself, walked in world units rather than in samples: a road's
  // points are not evenly spaced, so counting them would put stones close
  // together on a bend and far apart on a straight.
  for (const road of roads) {
    let since = SPACING * 0.5;
    let n = 0;
    for (let i = 1; i < road.pts.length; i++) {
      const a = road.pts[i - 1];
      const b = road.pts[i];
      const step = Math.hypot(b.x - a.x, b.z - a.z);
      since += step;
      if (since < SPACING) {
        continue;
      }
      since = 0;
      // Not on a bridge: a stone in the middle of a span has nothing to stand on.
      if (a.bridge || b.bridge) {
        continue;
      }
      add(`${road.id}-${n}`, b.x, b.z, b.x - a.x, b.z - a.z, road.profile.deckEdge + OFF_ROAD);
      n++;
    }
  }
  return out;
}

export class Waypoints {
  readonly group = new THREE.Group();
  readonly all: WaypointInfo[] = [];
  /** The same field a hut stamps into, so a stone is solid and nothing grows through it. */
  readonly solids = new StructureField();

  private readonly stones: Stone[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(sites: readonly WaypointInfo[]) {
    for (const site of sites) {
      const rig = buildRig();
      rig.group.position.set(site.x, site.y, site.z);
      this.group.add(rig.group);

      // One light per stone would be one light per stone in every shader
      // program's permutation — see the note in world/dungeon.ts. It is created
      // dark and OFF, and only a lit one costs anything.
      const light = new THREE.PointLight(CRYSTAL_LIT, 0, 14, 2);
      light.position.set(site.x, site.y + 3, site.z);
      light.castShadow = false;
      light.visible = false;
      this.group.add(light);

      this.all.push(site);
      this.stones.push({ info: site, crystal: rig.crystal, light, lit: false });
      this.solids.add({ solid: rig.solid }, site.x, site.y, site.z, 0, 1, 1);
      this.disposables.push(rig.crystal.geometry, rig.crystal.material as THREE.Material);
    }
  }

  /** Light the ones this character has found. Idempotent — a load calls it too. */
  setLit(isLit: (id: string) => boolean): void {
    for (const stone of this.stones) {
      const want = isLit(stone.info.id);
      if (want === stone.lit) {
        continue;
      }
      stone.lit = want;
      const mat = stone.crystal.material as THREE.MeshStandardMaterial;
      mat.color.setHex(want ? CRYSTAL_LIT : CRYSTAL_DARK);
      mat.emissive.setHex(want ? CRYSTAL_LIT : 0x000000);
      mat.emissiveIntensity = want ? 0.9 : 0;
      mat.needsUpdate = true;
      stone.light.visible = want;
      stone.light.intensity = want ? 6 : 0;
    }
  }

  /** The stone whose touch radius holds this point, or null. */
  touching(x: number, z: number): WaypointInfo | null {
    for (const stone of this.stones) {
      const d = (stone.info.x - x) ** 2 + (stone.info.z - z) ** 2;
      if (d <= WAYPOINT_TOUCH * WAYPOINT_TOUCH) {
        return stone.info;
      }
    }
    return null;
  }

  /** The nearest stone this character has lit, or null if none is. */
  nearestLit(x: number, z: number, isLit: (id: string) => boolean): WaypointInfo | null {
    let best: WaypointInfo | null = null;
    let bd = Infinity;
    for (const stone of this.stones) {
      if (!isLit(stone.info.id)) {
        continue;
      }
      const d = (stone.info.x - x) ** 2 + (stone.info.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = stone.info;
      }
    }
    return best;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.group.clear();
  }
}
