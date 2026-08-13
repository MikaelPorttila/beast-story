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

/** Voxel scale: the town's coarse 0.28 — this is masonry, not a face. */
const S = 0.28;

const STONE = 0x6f6a63;
const STONE_D = 0x53504b;
const STONE_L = 0x8b857c;
const GOLD = 0xc9a24f;
/** Dark until it is lit, and the lit colour is the gateway's own cyan. */
const CRYSTAL_DARK = 0x2f4450;
const CRYSTAL_LIT = 0x8be3ff;

/**
 * SAFETY SPACING — how much bare, level, unbuilt ground a stone needs.
 *
 * It is a DAIS you walk onto, so the clearance is the platform plus room to
 * stand on it: a stone squeezed against a palisade is one you cannot reach, and
 * one hard against a hut is inside the hut as far as a player can tell.
 */
const CLEAR_R = 6;
/** How far past a town's built perimeter a gate stone stands. Outside the wall, always. */
const TOWN_MARGIN = 4;
/** Steeper than this and the dais would stand on air at one edge. */
const MAX_SLOPE = 0.5;
/** Height over the water line a site needs, so a stone is never in the shallows. */
const DRY_BY = 1.2;

/** A filled disc of cells — the shape every round piece here is made of. */
function disc(v: VoxelModel, y: number, r: number, color: number): void {
  const r2 = r * r;
  for (let x = -r; x <= r; x++) {
    for (let z = -r; z <= r; z++) {
      if (x * x + z * z <= r2) {
        v.set(x, y, z, color);
      }
    }
  }
}

/** A ring of cells one cell thick, for an inlay that must not fill the middle. */
function ring(v: VoxelModel, y: number, r: number, color: number): void {
  const outer = r * r;
  const inner = (r - 1) * (r - 1);
  for (let x = -r; x <= r; x++) {
    for (let z = -r; z <= r; z++) {
      const d = x * x + z * z;
      if (d <= outer && d > inner) {
        v.set(x, y, z, color);
      }
    }
  }
}

/**
 * The dais: two round steps, drawn and NOT solid.
 *
 * It is 0.4 high at the rim — under `MAX_STEP_UP` — because a waypoint is a
 * thing you stand ON, and a solid platform in the middle of a valley is a wall
 * with a view. The pillars around it carry the collider instead.
 */
function buildDais(): VoxelModel {
  const v = new VoxelModel();
  disc(v, 0, 11, STONE_D);
  disc(v, 1, 9, STONE);
  // An inlaid ring, so the platform reads as MADE rather than as a flat rock.
  disc(v, 2, 7, STONE);
  ring(v, 2, 7, STONE_L);
  ring(v, 2, 4, GOLD);
  return v;
}

/**
 * The ring: six pillars and the lintels between them, in the shape every player
 * of this kind of game already knows — a circle of standing masonry with the
 * way out lit in the middle of it.
 *
 * SOLID, and the only solid part: `measureFootprint` reads this model, so the
 * pillars are what stops you and the gaps between them are the way in.
 */
function buildRing(): VoxelModel {
  const v = new VoxelModel();
  const R = 8.5;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const px = Math.round(Math.sin(a) * R);
    const pz = Math.round(Math.cos(a) * R);
    v.box(px - 1, 2, pz - 1, px + 1, 12, pz + 1, STONE);
    v.box(px - 1, 2, pz - 1, px - 1, 12, pz + 1, STONE_D);
    // A capstone, and a gold band under it: the one warm colour on the thing.
    v.box(px - 2, 13, pz - 2, px + 2, 14, pz + 2, STONE_L);
    v.box(px - 1, 12, pz - 1, px + 1, 12, pz + 1, GOLD);
  }
  return v;
}

/** The column of light in the middle — the part that is dark until you find it. */
function buildColumn(): VoxelModel {
  const v = new VoxelModel();
  for (let y = 0; y < 12; y++) {
    disc(v, y, 3, CRYSTAL_DARK);
  }
  // Tapering to a point, so a lit one reads as light leaving rather than as a post.
  disc(v, 12, 2, CRYSTAL_DARK);
  disc(v, 13, 1, CRYSTAL_DARK);
  return v;
}

/**
 * One waypoint's mesh tree: the dais and the ring on one material, and the
 * column of light on its own — it changes colour when the stone is found and
 * the masonry must not.
 */
export function buildWaypointRig(): {
  group: THREE.Group;
  column: THREE.Mesh;
  solid: readonly SolidBox[];
} {
  const group = new THREE.Group();

  const bake = (model: VoxelModel, castShadow: boolean): THREE.Mesh => {
    const mesh = model.build(S, true);
    const g = mesh.geometry;
    relight(
      (g.getAttribute("normal") as THREE.BufferAttribute).array as Float32Array,
      (g.getAttribute("color") as THREE.BufferAttribute).array as Float32Array,
    );
    // `build` re-bases a model so its lowest voxel sits at y = 0; read the
    // overhang back off the model rather than writing it down beside the part.
    mesh.position.y = model.bounds(true).minY * S;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = false;
    return mesh;
  };

  group.add(bake(buildDais(), false));
  const ringModel = buildRing();
  group.add(bake(ringModel, true));

  const column = bake(buildColumn(), false);
  column.position.y = 0.6;
  group.add(column);

  return { group, column, solid: measureFootprint(ringModel, S) };
}

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
  column: THREE.Mesh;
  light: THREE.PointLight;
  lit: boolean;
}

/** What a site needs to know about the ground and what is already on it. */
export interface WaypointGround {
  heightAt(x: number, z: number): number;
  steepnessAt(x: number, z: number): number;
  waterLevel: number;
  /** True where something BUILT stands — a hut, a palisade, a den. */
  built(x: number, z: number, r: number): boolean;
}

/** A sited stone, plus the point on the road its trail leaves from. */
export interface WaypointSite extends WaypointInfo {
  /** Where the spur meets the carriageway. Null for one that needs no trail. */
  readonly from: { x: number; z: number } | null;
}

/**
 * WHERE THE STONES GO, and the whole of the "smart" in smart placement.
 *
 * A candidate is a point on the road pushed sideways off the deck, and it is
 * REFUSED unless it has `CLEAR_R` of bare, level, dry, unbuilt ground around it
 * and stands outside every town's built perimeter. Refused, the search widens:
 * further out, then the other hand, then further along the road. A stone that
 * finds nowhere is not placed at all, because a waypoint you cannot walk onto is
 * worse than no waypoint — the first cut of this put one inside Redbriar's wall.
 */
export function waypointSites(
  roads: readonly Road[],
  towns: readonly {
    id: string;
    gateX: number;
    gateZ: number;
    x: number;
    z: number;
    outerRadius: number;
  }[],
  junction: { x: number; z: number } | null,
  ground: WaypointGround,
): WaypointSite[] {
  const out: WaypointSite[] = [];

  const farFromStones = (x: number, z: number): boolean =>
    out.every((w) => (w.x - x) ** 2 + (w.z - z) ** 2 > MIN_APART * MIN_APART);

  /** Outside every settlement's wall, by a margin — a gate stone stands beside the gate, never in it. */
  const outsideTowns = (x: number, z: number): boolean =>
    towns.every((t) => Math.hypot(t.x - x, t.z - z) > t.outerRadius + TOWN_MARGIN + CLEAR_R);

  /**
   * Is this a place a dais can stand? Sampled on a cross rather than at one
   * point: the middle of a candidate can be flat and dry with a hut's corner or
   * a lake inside the platform's own footprint.
   */
  const clear = (x: number, z: number): boolean => {
    if (!farFromStones(x, z) || !outsideTowns(x, z) || ground.built(x, z, CLEAR_R)) {
      return false;
    }
    const centre = ground.heightAt(x, z);
    for (const [dx, dz] of [
      [0, 0],
      [CLEAR_R, 0],
      [-CLEAR_R, 0],
      [0, CLEAR_R],
      [0, -CLEAR_R],
    ] as const) {
      const h = ground.heightAt(x + dx, z + dz);
      if (h < ground.waterLevel + DRY_BY) {
        return false;
      }
      // Flat ENOUGH: the dais is 0.4 tall and a rim standing on air reads as broken.
      if (Math.abs(h - centre) > 1.2 || ground.steepnessAt(x + dx, z + dz) > MAX_SLOPE) {
        return false;
      }
    }
    return true;
  };

  /**
   * Try to stand a stone beside this point on the road: both hands, widening.
   *
   * The offsets START at the carriageway's own rim — measured from the deck's
   * edge, never from its centreline, which is the rule every clearance question
   * in this project answers.
   */
  const place = (
    id: string,
    x: number,
    z: number,
    dirX: number,
    dirZ: number,
    rim: number,
  ): boolean => {
    const len = Math.hypot(dirX, dirZ) || 1;
    const nx = -dirZ / len;
    const nz = dirX / len;
    for (let off = rim + OFF_ROAD; off <= rim + OFF_ROAD + 14; off += 3.5) {
      for (const hand of [1, -1]) {
        const sx = x + nx * off * hand;
        const sz = z + nz * off * hand;
        if (!clear(sx, sz)) {
          continue;
        }
        out.push({
          id: `waypoint:${id}`,
          x: sx,
          y: ground.heightAt(sx, sz),
          z: sz,
          // The trail leaves the road at the rim, on the stone's own side.
          from: { x: x + nx * rim * hand, z: z + nz * rim * hand },
        });
        return true;
      }
    }
    return false;
  };

  /** Which way the road runs where it passes closest to a point, and how wide it is there. */
  const bearingNear = (x: number, z: number): { dx: number; dz: number; rim: number } => {
    let best = { dx: 0, dz: 1, rim: 3 };
    let bd = Infinity;
    for (const road of roads) {
      for (let i = 1; i < road.pts.length; i++) {
        const a = road.pts[i - 1];
        const b = road.pts[i];
        const d = (b.x - x) ** 2 + (b.z - z) ** 2;
        if (d < bd) {
          bd = d;
          best = { dx: b.x - a.x, dz: b.z - a.z, rim: road.profile.deckEdge };
        }
      }
    }
    return best;
  };

  /**
   * A town's own stone: the first place on the road OUT that is clear of the
   * wall.
   *
   * Not the gate itself, which is what the first cut tried — the gate is a hole
   * in the perimeter and everything within `outerRadius` of the middle is the
   * settlement. So this walks the road away from the town centre until the
   * distance is growing and the wall is behind it, and stands the stone beside
   * the carriageway there: outside the gate, on the way in, where a player
   * arriving sees it before he sees the town.
   */
  const placeByTown = (town: (typeof towns)[number]): boolean => {
    const want = town.outerRadius + TOWN_MARGIN + CLEAR_R;
    for (const road of roads) {
      for (let i = 1; i < road.pts.length; i++) {
        const a = road.pts[i - 1];
        const b = road.pts[i];
        if (b.bridge) {
          continue;
        }
        const d = Math.hypot(b.x - town.x, b.z - town.z);
        // The first sample past the wall, and only on the arm LEAVING it: a road
        // running past a town at a distance is somebody else's road.
        if (d < want || d > want + SPACING * 0.5) {
          continue;
        }
        if (place(`town-${town.id}`, b.x, b.z, b.x - a.x, b.z - a.z, road.profile.deckEdge)) {
          return true;
        }
      }
    }
    return false;
  };

  // THE TOWNS FIRST, so each has one and the spacing below yields to it.
  for (const town of towns) {
    placeByTown(town);
  }
  if (junction) {
    const b = bearingNear(junction.x, junction.z);
    place("junction", junction.x, junction.z, b.dx, b.dz, b.rim + OFF_ROAD);
  }

  // Then the road itself, walked in WORLD UNITS rather than in samples: a road's
  // points are not evenly spaced, so counting them would bunch stones on a bend
  // and strand them on a straight.
  for (const road of roads) {
    let since = SPACING * 0.5;
    let n = 0;
    for (let i = 1; i < road.pts.length; i++) {
      const a = road.pts[i - 1];
      const b = road.pts[i];
      since += Math.hypot(b.x - a.x, b.z - a.z);
      if (since < SPACING) {
        continue;
      }
      // A bridge has nothing beside it to stand on; try again further along.
      if (a.bridge || b.bridge) {
        continue;
      }
      if (place(`${road.id}-${n}`, b.x, b.z, b.x - a.x, b.z - a.z, road.profile.deckEdge)) {
        since = 0;
        n++;
      }
    }
  }
  return out;
}

export class Waypoints {
  readonly group = new THREE.Group();
  /** The sited stones, `from` and all: the trail cutter reads it after construction. */
  readonly all: WaypointSite[] = [];
  /** The same field a hut stamps into, so a stone is solid and nothing grows through it. */
  readonly solids = new StructureField();

  private readonly stones: Stone[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(sites: readonly WaypointSite[]) {
    for (const site of sites) {
      const rig = buildWaypointRig();
      rig.group.position.set(site.x, site.y, site.z);
      this.group.add(rig.group);

      // One light per stone would be one light per stone in every shader
      // program's permutation — see the note in world/dungeon.ts. It is created
      // dark and OFF, and only a lit one costs anything.
      const light = new THREE.PointLight(CRYSTAL_LIT, 0, 14, 2);
      light.position.set(site.x, site.y + 2.4, site.z);
      light.castShadow = false;
      light.visible = false;
      this.group.add(light);

      this.all.push(site);
      this.stones.push({ info: site, column: rig.column, light, lit: false });
      this.solids.add({ solid: rig.solid }, site.x, site.y, site.z, 0, 1, 1);
      this.disposables.push(rig.column.geometry, rig.column.material as THREE.Material);
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
      const mat = stone.column.material as THREE.MeshStandardMaterial;
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
