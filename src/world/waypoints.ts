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
import { inRise } from "../core/types";
import { relight, type SolidBox } from "./props";
import { measureFootprint, StructureField } from "./structures";
import { nearRoadFurniture, roadIntrusion } from "./placement";
import { installRingFade, type RingBand } from "./distant-terrain";
import type { Road } from "./roads";

/** World units of road between two stones. A minute's walk at a hero's 6/s. */
const SPACING = 220;
/** No second stone inside this of another — the gates and the fork win ties. */
const MIN_APART = 110;
/**
 * The plate's radius in world units — eleven cells of disc at `S`.
 *
 * Exported because the trail has to STOP at it: a carriageway that runs under
 * the plate meets the plate's own top and reports a five-unit step in the
 * walking surface (`test-road`). The last pace onto a waystone is the stone.
 */
export const WAYPOINT_PLATE_R = 11 * 0.28;

/** How near a stone counts as standing AT it — the plate and a pace around it. */
export const WAYPOINT_TOUCH = 6;
/**
 * How near a stone's approach — the line from where its trail leaves the road
 * to the plate — a hero must pass to NOTICE it (issue #250). Twelve covers the
 * carriageway a spur leaves from (`from` is on the deck's rim, and a cart road
 * is ~7 across) so running past on the road lights it; a stone you cannot see
 * from the road is one you should not be credited with.
 */
export const WAYPOINT_SENSE = 12;
/** The height band of `sensing`: a bridge or a flyer well above the plate is not passing it. */
const SENSE_RISE = 6;
/**
 * How far clear of the carriageway's RIM a stone stands, world units.
 *
 * SIX, so the plate is a few paces off the road rather than up against it: the
 * trail is meant to be a walk to something standing beside the way, and at 3.5
 * the plate read as part of the verge. Measured from the rim — the road's own
 * `deckEdge` — never from the centreline, which is the rule every clearance
 * question in this project answers (`RoadClearance`, world/roads.ts).
 */
const OFF_ROAD = 6;

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
/** How clear of any carriageway's rim a plate must stand. See `clear`. */
const ROAD_MARGIN = 1.5;
/** How clear of a fingerpost or a lamp, so a trail never leaves the road at one. */
const FURNITURE_CLEAR = 12;
/** The plate's own footprint, sampled on a cross — see `highestUnder`. */
const PLATE_SAMPLES: readonly (readonly [number, number])[] = [
  [WAYPOINT_PLATE_R, 0],
  [-WAYPOINT_PLATE_R, 0],
  [0, WAYPOINT_PLATE_R],
  [0, -WAYPOINT_PLATE_R],
];
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
 * The plate: two round steps over a skirt that reaches the ground.
 *
 * IT IS THE COLLIDER, and the only one. Its top is 0.84 up at this scale, and
 * the step onto it is the 0.4 rim — under `MAX_STEP_UP`, so a hero walks ONTO
 * it rather than into it. The first cut put the collider on a ring of pillars
 * and left the plate as scenery, and you fell straight through the thing you
 * were standing on; measuring it off THIS model is what makes that impossible.
 *
 * THE SKIRT IS WHY IT DOES NOT FLOAT. A disc eleven cells across sits on ground
 * that is never perfectly level, so a plate drawn at one height hangs in the air
 * on the downhill side. The skirt runs straight down and is buried on the high
 * side; the flatten under the site (`createWorld`) levels the rest, exactly as
 * it does for a skill den.
 */
function buildPlate(): VoxelModel {
  const v = new VoxelModel();
  for (let y = -12; y < 0; y++) {
    disc(v, y, 10, STONE_D);
  }
  // ONE COURSE PROUD OF THE GROUND, and that is a collision decision rather than
  // a drawing one: the collider is measured off this model as a single box at
  // its tallest face, so a second course would make the step onto the plate 0.56
  // — over `MAX_STEP_UP` — and the thing you are meant to walk onto becomes a
  // wall. The pattern is painted INTO the same course instead of stacked on it.
  disc(v, 0, 11, STONE);
  ring(v, 0, 11, STONE_D);
  ring(v, 0, 7, STONE_L);
  ring(v, 0, 6, STONE_L);
  ring(v, 0, 4, GOLD);
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
 * One waypoint's mesh tree: the plate, and the column of light standing on it.
 *
 * TWO MODELS, because the column changes colour when the stone is found and the
 * masonry must not — a material is per mesh.
 */
export function buildWaypointRig(): {
  group: THREE.Group;
  column: THREE.Mesh;
  solid: readonly SolidBox[];
  /** How far BELOW the site the plate's own base sits — the skirt's depth. */
  baseY: number;
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

  const plate = buildPlate();
  group.add(bake(plate, true));
  // The skirt hangs below the site, so the collider's base does too: a
  // `SolidBox`'s `top` is measured up from the MODEL's own base, and stamping it
  // at the site would put the plate's surface four units in the air.
  const baseY = plate.bounds(true).minY * S;

  const column = bake(buildColumn(), false);
  // ON the plate, which is one course proud of the ground: a column sunk into
  // the stone reads as a crack rather than as a door.
  column.position.y = S;
  group.add(column);

  return { group, column, solid: measureFootprint(plate, S), baseY };
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
  /** The SITE, `from` and all — `sensing` walks the approach line (issue #250). */
  readonly info: WaypointSite;
  group: THREE.Group;
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
  /** Lamps, fingerposts and posts the road pass stood up. Absent where there are none. */
  furniture?: readonly { x: number; z: number }[];
}

/** A sited stone, plus the point on the road its trail leaves from. */
export interface WaypointSite extends WaypointInfo {
  /**
   * Where the spur meets the carriageway, and the DECK's own height there —
   * not the terrain's. A cart road's surface is carved and raised, so a spur
   * anchored to natural ground leaves the road with a step in it.
   */
  readonly from: { x: number; y: number; z: number } | null;
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
  /** The tallest ground the plate would cover — its own footprint, on a cross. */
  const highestUnder = (x: number, z: number): number => {
    let top = ground.heightAt(x, z);
    for (const [dx, dz] of PLATE_SAMPLES) {
      top = Math.max(top, ground.heightAt(x + dx, z + dz));
    }
    return top;
  };

  /**
   * Can the trail actually GET there?
   *
   * A stone can stand on a flat shelf with a cliff between it and the road, and
   * the spur then runs up the cliff — `test-road` measured 6.4 units of step in
   * a carriageway, which is a path a player cannot walk. The site test looks at
   * the plate's own footprint; this looks at the LINE, which is the other half
   * of the same question and the one that was missing.
   */
  const walkableRun = (ax: number, az: number, bx: number, bz: number): boolean => {
    const span = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(2, Math.round(span / 2));
    let prev = ground.heightAt(ax, az);
    for (let i = 1; i <= steps; i++) {
      const u = i / steps;
      const h = ground.heightAt(ax + (bx - ax) * u, az + (bz - az) * u);
      // A step a hero can take, per sample. `MAX_STEP_UP` is 0.5 and the samples
      // are two units apart, so this is a slope bound and not a stair test.
      if (Math.abs(h - prev) > 1.1) {
        return false;
      }
      prev = h;
    }
    return true;
  };

  const clear = (x: number, z: number): boolean => {
    if (!farFromStones(x, z) || !outsideTowns(x, z) || ground.built(x, z, CLEAR_R)) {
      return false;
    }
    // Clear of every carriageway by a margin, so a plate never stands in a road.
    // 1.5 and not the full offset: near the fork the arms run close together and
    // asking for a stone's whole approach to be clear of BOTH leaves a town with
    // no site at all.
    if (roadIntrusion(roads, x, z) > -ROAD_MARGIN) {
      return false;
    }
    // AND CLEAR OF WHAT THE ROAD ALREADY STOOD THERE. A fingerpost is as much in
    // the way as a hut, and a trail that leaves the road at one starts under it.
    if (ground.furniture && nearRoadFurniture(ground.furniture, x, z, FURNITURE_CLEAR)) {
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
      // A metre across the whole platform. The skirt can bury that much and the
      // plate still reads as sitting ON the ground; asked for less, half the
      // valley is refused and the stones bunch up where it happens to be flat.
      if (Math.abs(h - centre) > 1 || ground.steepnessAt(x + dx, z + dz) > MAX_SLOPE) {
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
    y: number,
    z: number,
    dirX: number,
    dirZ: number,
    rim: number,
  ): boolean => {
    const len = Math.hypot(dirX, dirZ) || 1;
    const nx = -dirZ / len;
    const nz = dirX / len;
    // The band a stone may stand in: six paces off the rim, out to twenty-six.
    // Wide, because every refusal below is a real one — built, wet, steep, a
    // signpost, another stone, or a slope the trail could not climb — and a
    // narrow band means a road with no stones on it at all.
    for (let off = rim + OFF_ROAD; off <= rim + OFF_ROAD + 20; off += 2.5) {
      for (const hand of [1, -1]) {
        const sx = x + nx * off * hand;
        const sz = z + nz * off * hand;
        const fx = x + nx * rim * hand;
        const fz = z + nz * rim * hand;
        // THE START IS CHECKED TOO, not just the site: a spur leaving the rim
        // beside a fingerpost lays its gravel under it, and the road probe reads
        // that as furniture standing in a carriageway (issue #15).
        if (
          !clear(sx, sz) ||
          !walkableRun(fx, fz, sx, sz) ||
          (ground.furniture && nearRoadFurniture(ground.furniture, fx, fz, FURNITURE_CLEAR))
        ) {
          continue;
        }
        out.push({
          id: `waypoint:${id}`,
          x: sx,
          // THE HIGHEST GROUND UNDER THE PLATE, never the middle's: a plate set
          // at the centre height is BURIED wherever the ground rises inside its
          // own footprint, which is what "partially under ground" looks like.
          // Set at the highest, it can only stand proud, and the skirt fills in
          // what is under the proud side.
          y: highestUnder(sx, sz),
          z: sz,
          // THE SPUR LEAVES THE ROAD AT ITS RIM, on the stone's own side. Not the
          // centreline: a spur drawn from the middle of a carriageway lays its
          // own gravel down the inside of the road it is leaving, which is a
          // trail running INSIDE a road. `y` stays the DECK's height — the
          // shoulder is graded to it, and anchoring to the natural column under
          // the verge is what puts a step at the join.
          from: { x: fx, y, z: fz },
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
        if (place(`town-${town.id}`, b.x, b.y, b.z, b.x - a.x, b.z - a.z, road.profile.deckEdge)) {
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
    place(
      "junction",
      junction.x,
      ground.heightAt(junction.x, junction.z),
      junction.z,
      b.dx,
      b.dz,
      b.rim + OFF_ROAD,
    );
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
      if (place(`${road.id}-${n}`, b.x, b.y, b.z, b.x - a.x, b.z - a.z, road.profile.deckEdge)) {
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
  private readonly ring: RingBand;

  constructor(
    sites: readonly WaypointSite[],
    /** The detailed ring: a stone dies on it like the trees beside it. */
    ringBand: RingBand,
  ) {
    this.ring = ringBand;
    for (const site of sites) {
      const rig = buildWaypointRig();
      // Plate, column and any glow children alike — `build` mints per-mesh
      // materials, so this cannot leak onto another model's.
      rig.group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          installRingFade(o.material as THREE.Material, ringBand);
        }
      });
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
      this.stones.push({ info: site, group: rig.group, column: rig.column, light, lit: false });
      this.solids.add({ solid: rig.solid }, site.x, site.y + rig.baseY, site.z, 0, 1, 1);
      this.disposables.push(rig.column.geometry, rig.column.material as THREE.Material);
    }
    // Freeze and index, once, after the last stamp — a field that is never built
    // answers -Infinity everywhere and the plate is scenery you fall through.
    this.solids.build();
  }

  /** Hard cull past the ring, where the alpha fade has already zeroed a stone:
   *  it removes the far stones from the AO G-buffer too, whose override pass
   *  knows nothing of the fade and would stamp them onto the fog (issue #39). */
  update(focus: Readonly<THREE.Vector3>): void {
    const cut = this.ring.end.value + 8;
    for (const stone of this.stones) {
      stone.group.visible = Math.hypot(stone.info.x - focus.x, stone.info.z - focus.z) < cut;
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

  /** See `WaypointField.sensing`: distance to the approach SEGMENT, in a height band. */
  sensing(x: number, y: number, z: number): WaypointInfo | null {
    const r2 = WAYPOINT_SENSE * WAYPOINT_SENSE;
    for (const stone of this.stones) {
      const s = stone.info;
      if (!inRise(s.y, y, SENSE_RISE)) {
        continue;
      }
      // Point-to-segment from the road junction to the plate; a stone that
      // needed no trail is a point.
      const ax = s.from?.x ?? s.x;
      const az = s.from?.z ?? s.z;
      const dx = s.x - ax;
      const dz = s.z - az;
      const l2 = dx * dx + dz * dz;
      let u = l2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const px = ax + dx * u - x;
      const pz = az + dz * u - z;
      if (px * px + pz * pz <= r2) {
        return s;
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
